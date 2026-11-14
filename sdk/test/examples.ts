// The TypeScript examples of sdk/README.md, compiled by `pnpm typecheck` (not executed) so that the
// documented usage cannot drift from the API. The executed equivalents are in viem/anvil.test.ts and
// dist.test.ts.

import { Contract, JsonRpcProvider, Wallet, type TypedDataField } from 'ethers6';
import {
    createPublicClient,
    createWalletClient,
    custom,
    http,
    type Address,
    type EIP1193Provider,
    type LocalAccount,
    type PublicClient,
} from 'viem';
import { polygon } from 'viem/chains';
import {
    buildSubmitTransferBody,
    createTransferIntent,
    definePins,
    findPinnedToken,
    gaslessTransferAbi,
    pinsFromDeployment,
    POLYGON_TOKENS,
    POLYGON_USDC,
    POLYGON_USDT0,
    toTokenAuthorization,
    tokenAuthSigningPayload,
    transferSigningPayload,
    usdt0Abi,
    type ChainPins,
    type TransferVersion,
} from '../src/core/index.js';
import { RelayClient } from '../src/relay/index.js';
import { confirmOnChain, prepareTransfer, signPrepared, waitForTransferOutcome } from '../src/viem/index.js';

export function pinsExample(deploymentJson: unknown) {
    const pins = definePins({
        chainId: 137,
        transfer: '0x0000000000000000000000000000000000000001',
        relays: ['0x0000000000000000000000000000000000000002'],
        tokens: POLYGON_TOKENS,
        deployBlock: 94_500_000,
    });
    const pinsFromFile = pinsFromDeployment(deploymentJson, { relays: ['0x0000000000000000000000000000000000000002'] });
    return [pins, pinsFromFile];
}

export async function viemExample(ethereum: EIP1193Provider, account: LocalAccount, recipient: Address) {
    const [pins] = pinsExample({});
    if (pins === undefined) return;
    const publicClient = createPublicClient({ chain: polygon, transport: http() });
    const walletClient = createWalletClient({ chain: polygon, transport: custom(ethereum), account });
    const relay = new RelayClient('https://relay.example.com', { pins });

    const maxAcceptableFee = 100_000n;
    const quote = await relay.fee({ token: POLYGON_USDC.address, authMode: 'permit', maxAcceptableFee });
    const prepared = await prepareTransfer(publicClient, pins, {
        token: POLYGON_USDC.address,
        from: account.address,
        to: recipient,
        amount: 10_000_000n,
        fee: quote.fee,
        maxAcceptableFee,
        relay: quote.relay,
    });
    const signed = await signPrepared(walletClient, prepared, pins);
    const latest: TransferVersion = { request: signed.request, authHash: signed.authHash };
    const { id } = await relay.submitTransfer(buildSubmitTransferBody({ ...signed, quoteId: quote.quoteId }));
    const state = await relay.waitForRequest(id, { until: 'mined', timeoutMs: 120_000 });
    return [latest, await confirmOnChain(publicClient, pins, { ...latest, versions: [latest] }, { txHash: state.txHash ?? undefined })];
}

export async function ethers6Example(rpcUrl: string, privateKey: string, recipient: Address) {
    const [pins] = pinsExample({});
    if (pins === undefined) return;
    const provider = new JsonRpcProvider(rpcUrl, 137);
    const wallet = new Wallet(privateKey, provider);
    const relay = new RelayClient('https://relay.example.com', { pins });
    const usdt0 = new Contract(POLYGON_USDT0.address, usdt0Abi, provider);
    const gasless = new Contract(pins.transfer.address, gaslessTransferAbi, provider);

    if ((await usdt0.getFunction('DOMAIN_SEPARATOR')()) !== findPinnedToken(pins, POLYGON_USDT0.address)?.domainSeparator) {
        throw new Error('USDT0 domain changed');
    }

    const quote = await relay.fee({ token: POLYGON_USDT0.address, authMode: 'permit', maxAcceptableFee: 100_000n });
    const now = Math.floor(Date.now() / 1000);
    const intent = createTransferIntent(
        pins,
        {
            token: POLYGON_USDT0.address,
            from: wallet.address,
            to: recipient,
            amount: 10_000_000n,
            fee: quote.fee,
            relay: quote.relay,
            authMode: 'permit',
            deadline: now + 600,
            nonce: (await gasless.getFunction('nonces')(wallet.address)) as bigint,
            tokenNonce: (await usdt0.getFunction('nonces')(wallet.address)) as bigint,
        },
        now,
    );
    // ethers' types want mutable arrays; the SDK payloads are deep-frozen `as const` data.
    const types = (payload: { types: object }) => payload.types as Record<string, TypedDataField[]>;
    const tokenAuth = tokenAuthSigningPayload(pins, intent, now);
    if (tokenAuth === null) throw new Error('unreachable: permit mode has a token authorization');
    const permitSignature = await wallet.signTypedData(tokenAuth.domain, types(tokenAuth), tokenAuth.message);
    const authorization = toTokenAuthorization('permit', permitSignature);
    const transfer = transferSigningPayload(pins, intent, authorization, now);
    const signature = await wallet.signTypedData(transfer.domain, types(transfer), transfer.message);

    const { id } = await relay.submitTransfer(buildSubmitTransferBody({ request: intent.request, signature, authorization, quoteId: quote.quoteId }));
    return relay.waitForRequest(id);
}

export async function outcomeExample(
    publicClient: PublicClient,
    pins: ChainPins,
    relay: RelayClient,
    latest: TransferVersion,
    versions: readonly TransferVersion[],
) {
    const outcome = await waitForTransferOutcome(publicClient, pins, { ...latest, versions }, { relay });
    if (outcome.status === 'executed' || outcome.status === 'other_version_executed') {
        return { txHash: outcome.txHash, executed: outcome.executedTransfer };
    } else {
        return null;
    }
}

export async function correctionExample(publicClient: PublicClient, pins: ChainPins, relay: RelayClient, latest: TransferVersion, maxAcceptableFee: bigint) {
    const quote = await relay.fee({ token: latest.request.token, authMode: 'permit', maxAcceptableFee });
    const corrected = await prepareTransfer(publicClient, pins, {
        token: latest.request.token,
        from: latest.request.from,
        to: latest.request.to,
        amount: BigInt(latest.request.amount),
        fee: quote.fee,
        maxAcceptableFee,
        relay: quote.relay,
        corrects: latest.request,
    });
    return corrected;
}

export async function repostExample(relay: RelayClient, body: Parameters<RelayClient['submitTransfer']>[0]) {
    return relay.submitTransfer(body, { repost: true });
}
