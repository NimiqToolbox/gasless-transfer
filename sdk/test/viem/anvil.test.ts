// The viem adapter against anvil (chain id 137) with Solidity test doubles: MockUSDC / MockUSDT0
// installed at the real token addresses (so the frozen, mainnet-read domain separators must match)
// and TransferHarness implementing the IGaslessTransfer interface (not the production contract).
// The relay is simulated by anvil account #9 calling relayTransfer with the submit body.

import { Wallet as Ethers5Wallet } from 'ethers5';
import { Wallet as Ethers6Wallet } from 'ethers6';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    createPublicClient,
    createTestClient,
    createWalletClient,
    custom,
    defineChain,
    getAddress,
    http,
    keccak256,
    toBytes,
    type Abi,
    type Address,
    type Chain,
    type Hex,
    type PublicClient,
    type TestClient,
    type TransactionReceipt,
    type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../src/core/abi.js';
import { POLYGON_TOKENS, POLYGON_USDC, POLYGON_USDT0 } from '../../src/core/constants.js';
import { hashDomain, tokenAuthHash, transferDigest, transferDigestFromAuthHash } from '../../src/core/eip712.js';
import { GaslessValidationError } from '../../src/core/errors.js';
import { createTransferIntent, tokenAuthSigningPayload, transferSigningPayload } from '../../src/core/intent.js';
import { definePins, type ChainPins } from '../../src/core/pins.js';
import { toTokenAuthorization } from '../../src/core/signature.js';
import { buildSubmitTransferBody } from '../../src/core/submit.js';
import { TOKEN_AUTH_TYPE, TRANSFER_TYPE } from '../../src/core/typedData.js';
import { AUTH_MODE_ID, type AuthModeName, type TokenAuthorization, type TransferRequest, type TransferVersion } from '../../src/core/types.js';
import { validateSubmitTransferBody } from '../../src/core/validate.js';
import type { RequestState, SubmitTransferBody } from '../../src/relay/types.js';
import {
    assertTokenDomain,
    checkTokenDomain,
    confirmOnChain,
    hashTransfer,
    prepareTransfer,
    readTokenNonce,
    signPrepared,
    TokenDomainMismatchError,
    waitForTransferOutcome,
    type PrepareTransferParams,
    type SignedTransfer,
} from '../../src/viem/index.js';
import {
    type Anvil,
    type Artifact,
    chainToolsAvailable,
    compileFixtures,
    type FixtureName,
    relayTransferArgs,
    startAnvil,
    transferConstructorArgs,
} from '../helpers/anvil.js';
import { ADDR, KEYS, NONE_AUTH, USDC, USDT0, ZERO32 } from '../helpers/fixtures.js';

const AMOUNT = 10_000_000n;
const FEE = 50_000n;
/** viem polls receipts every 4 s by default; anvil mines instantly. */
const POLL_MS = 25;
const user = privateKeyToAccount(KEYS.user);

async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        return (error as { code?: string }).code ?? `threw ${String(error)}`;
    }
    return 'resolved';
}

/** confirmOnChain's answer for an unused nonce (`pending`, `expired`). */
function unusedAnswer(status: 'pending' | 'expired') {
    return { status, txHash: null, blockNumber: null, executedTransfer: null };
}

/** confirmOnChain's answer for a use it did not find, and why. */
function unresolvedAnswer(reason: 'no_history' | 'not_found') {
    return { status: 'unresolved', txHash: null, blockNumber: null, executedTransfer: null, reason };
}

/** The version a wallet stores for a signed transfer: its request and authHash, no signature. */
function versionOf(signed: SignedTransfer): TransferVersion {
    return { request: signed.request, authHash: signed.authHash };
}

/** confirmOnChain's answer for an execution of `version` in `receipt` (`executed`, or `other_version_executed` of a sibling). */
function executedAnswer(
    version: TransferVersion,
    receipt: Pick<TransactionReceipt, 'transactionHash' | 'blockNumber'>,
    status: 'executed' | 'other_version_executed' | 'other_payment_executed' = 'executed',
) {
    return { status, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, executedTransfer: { request: version.request, authHash: version.authHash } };
}

describe.skipIf(!chainToolsAvailable())('viem adapter on anvil', () => {
    let anvil: Anvil;
    let artifacts: Record<FixtureName, Artifact>;
    let chain: Chain;
    let publicClient: PublicClient<Transport, Chain>;
    let testClient: TestClient<'anvil', Transport, Chain>;
    let harness: Address;
    let pins: ChainPins;
    let snapshot: Hex;

    const wallet = (key: Hex) => createWalletClient({ chain, transport: http(anvil.url), account: privateKeyToAccount(key) });

    async function send(key: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
        const hash = await wallet(key).writeContract({ address, abi, functionName, args } as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe('success');
        return receipt;
    }

    async function blockNow(): Promise<number> {
        return Number((await publicClient.getBlock()).timestamp);
    }

    function params(overrides: Partial<PrepareTransferParams> & { now: number }): PrepareTransferParams {
        return { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: FEE, relay: ADDR.relay, authMode: 'permit', ...overrides };
    }

    /** prepareTransfer and signPrepared with the user's key. */
    async function signedTransfer(overrides: Partial<PrepareTransferParams> & { now: number }): Promise<SignedTransfer> {
        return signPrepared(user, await prepareTransfer(publicClient, pins, params(overrides)), pins, { now: overrides.now });
    }

    /** What the relay does with a submit body: call relayTransfer from its own account. */
    async function relayExecute(body: SubmitTransferBody): Promise<TransactionReceipt> {
        return send(KEYS.relay, harness, gaslessTransferAbi, 'relayTransfer', relayTransferArgs(body));
    }

    /** relayTransfer with these arguments, simulated from the relay account. */
    function simulateRelayTransfer(args: ReturnType<typeof relayTransferArgs>) {
        return publicClient.simulateContract({ account: ADDR.relay, address: harness, abi: gaslessTransferAbi, functionName: 'relayTransfer', args });
    }

    function nonceOf(account: Address): Promise<bigint> {
        return publicClient.readContract({ address: harness, abi: gaslessTransferAbi, functionName: 'nonces', args: [account] });
    }

    async function balances(token: Address) {
        const of = (account: Address) => publicClient.readContract({ address: token, abi: usdcAbi, functionName: 'balanceOf', args: [account] });
        return { user: await of(ADDR.user), recipient: await of(ADDR.recipient), relay: await of(ADDR.relay), harness: await of(harness) };
    }

    async function allowanceToHarness(token: Address): Promise<bigint> {
        return publicClient.readContract({ address: token, abi: usdcAbi, functionName: 'allowance', args: [ADDR.user, harness] });
    }

    async function expectExactTransfer(token: Address, run: () => Promise<TransactionReceipt>): Promise<TransactionReceipt> {
        const before = await balances(token);
        const receipt = await run();
        const after = await balances(token);
        expect(after.user).toBe(before.user - AMOUNT - FEE);
        expect(after.recipient).toBe(before.recipient + AMOUNT);
        expect(after.relay).toBe(before.relay + FEE);
        expect(after.harness).toBe(0n);
        expect(await allowanceToHarness(token)).toBe(0n);
        return receipt;
    }

    /**
     * A client of the same anvil that refuses eth_call below the head, like a node without the state of older blocks
     * (without viem's retries of that error).
     */
    function withoutHistoricalState(): PublicClient<Transport, Chain> {
        const inner = http(anvil.url)({ chain });
        return createPublicClient({
            chain,
            transport: custom(
                {
                    async request({ method, params: rpcParams }: { method: string; params?: unknown }) {
                        if (method === 'eth_call') {
                            const head = BigInt((await inner.request({ method: 'eth_blockNumber' })) as Hex);
                            const tag = (rpcParams as unknown[])[1];
                            if (typeof tag === 'string' && tag.startsWith('0x') && BigInt(tag) !== head) throw new Error('missing trie node');
                        }
                        return inner.request({ method, params: rpcParams } as never);
                    },
                },
                { retryCount: 0 },
            ),
            pollingInterval: POLL_MS,
        });
    }

    beforeAll(async () => {
        artifacts = compileFixtures();
        anvil = await startAnvil(137);
        chain = defineChain({ id: 137, name: 'anvil-137', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
        publicClient = createPublicClient({ chain, transport: http(anvil.url), pollingInterval: POLL_MS });
        testClient = createTestClient({ chain, mode: 'anvil', transport: http(anvil.url), pollingInterval: POLL_MS });

        await testClient.setCode({ address: USDC, bytecode: artifacts.MockUSDC.deployedBytecode });
        await testClient.setCode({ address: USDT0, bytecode: artifacts.MockUSDT0.deployedBytecode });
        await send(KEYS.deployer, USDC, artifacts.MockUSDC.abi, 'initialize', ['USD Coin']);
        await send(KEYS.deployer, USDT0, artifacts.MockUSDT0.abi, 'initialize', ['USDT0']);
        const hash = await wallet(KEYS.deployer).deployContract({
            abi: artifacts.TransferHarness.abi,
            bytecode: artifacts.TransferHarness.bytecode,
            args: transferConstructorArgs(),
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        harness = getAddress(receipt.contractAddress as Address);
        for (const token of [USDC, USDT0]) {
            for (const holder of [ADDR.user, ADDR.other]) await send(KEYS.deployer, token, artifacts.MockUSDC.abi, 'mint', [holder, 1_000_000_000n]);
        }
        pins = definePins({ chainId: 137, transfer: harness, relays: [ADDR.relay], tokens: POLYGON_TOKENS, deployBlock: Number(receipt.blockNumber) });
    }, 180_000);

    afterAll(async () => {
        await anvil?.stop();
    });

    beforeEach(async () => {
        snapshot = await testClient.snapshot();
    });

    afterEach(async () => {
        await testClient.revert({ id: snapshot });
    });

    describe('digests against Solidity (OpenZeppelin EIP712 in the test double)', () => {
        it('hashTransfer (viem) = transferDigest (core) = the contract hashTransfer(r, nonce, auth), for several requests, nonces and authorizations', async () => {
            const now = await blockNow();
            const authorizations: TokenAuthorization[] = [
                NONE_AUTH,
                { mode: 'permit', v: 27, r: keccak256(toBytes('r-1')), s: keccak256(toBytes('s-1')) },
                { mode: 'metaTxApprove', v: 28, r: keccak256(toBytes('r-2')), s: keccak256(toBytes('s-2')) },
                // The contract hashes whatever it is given; the relay refuses "none" with other values.
                { mode: 'none', v: 1, r: keccak256(toBytes('r-3')), s: ZERO32 },
            ];
            const nonces = [0n, 1n, 7n, 2n ** 32n, 2n ** 256n - 1n];
            for (let i = 0; i < nonces.length; i++) {
                const authorization = authorizations[i % authorizations.length] as TokenAuthorization;
                const request: TransferRequest = {
                    token: i % 2 === 0 ? USDC : USDT0,
                    from: ADDR.user,
                    to: ADDR.recipient,
                    amount: String(AMOUNT * BigInt(i + 1)),
                    fee: String(FEE * BigInt(i)),
                    relay: ADDR.relay,
                    nonce: String(nonces[i]),
                    deadline: String(now + 600 + i),
                };
                const onChain = await publicClient.readContract({
                    address: harness,
                    abi: gaslessTransferAbi,
                    functionName: 'hashTransfer',
                    args: [
                        { token: request.token, from: request.from, to: request.to, amount: BigInt(request.amount), fee: BigInt(request.fee), relay: request.relay, deadline: BigInt(request.deadline) },
                        BigInt(request.nonce),
                        { mode: AUTH_MODE_ID[authorization.mode], v: authorization.v, r: authorization.r, s: authorization.s },
                    ],
                });
                expect(hashTransfer(137, harness, request, authorization)).toBe(onChain);
                expect(transferDigest(137, harness, request, authorization)).toBe(onChain);
                expect(transferDigestFromAuthHash(137, harness, request, tokenAuthHash(authorization))).toBe(onChain);
            }
        });

        it('the type strings and hashes, domain separator, EIP-5267 domain and token configuration match the pins', async () => {
            const read = (functionName: 'TRANSFER_TYPEHASH' | 'TOKEN_AUTH_TYPEHASH' | 'DOMAIN_SEPARATOR') =>
                publicClient.readContract({ address: harness, abi: gaslessTransferAbi, functionName });
            expect(await read('TRANSFER_TYPEHASH')).toBe(keccak256(toBytes(TRANSFER_TYPE)));
            expect(await read('TOKEN_AUTH_TYPEHASH')).toBe(keccak256(toBytes(TOKEN_AUTH_TYPE)));
            const readType = (functionName: 'TRANSFER_TYPE' | 'TOKEN_AUTH_TYPE') => publicClient.readContract({ address: harness, abi: gaslessTransferAbi, functionName });
            expect(await readType('TRANSFER_TYPE')).toBe(TRANSFER_TYPE);
            expect(await readType('TOKEN_AUTH_TYPE')).toBe(TOKEN_AUTH_TYPE);
            expect(await read('DOMAIN_SEPARATOR')).toBe(hashDomain(pins.transfer.domain));
            const [, name, version, chainId, verifyingContract] = await publicClient.readContract({ address: harness, abi: gaslessTransferAbi, functionName: 'eip712Domain' });
            expect({ name, version, chainId: Number(chainId), verifyingContract }).toEqual(pins.transfer.domain);
            for (const token of pins.tokens) {
                const config = await publicClient.readContract({ address: harness, abi: gaslessTransferAbi, functionName: 'tokenConfig', args: [token.address] });
                // Exactly the three modes.
                expect(config, token.symbol).toEqual({
                    permit: token.authModes.includes('permit'),
                    metaTxApprove: token.authModes.includes('metaTxApprove'),
                    allowance: token.authModes.includes('none'),
                });
            }
        });
    });

    describe('token reads', () => {
        it('the token doubles at the real addresses have the frozen mainnet domain separators', async () => {
            expect(await checkTokenDomain(publicClient, pins, USDC)).toEqual({ ok: true, token: USDC, expected: POLYGON_USDC.domainSeparator, actual: POLYGON_USDC.domainSeparator });
            expect(await checkTokenDomain(publicClient, pins, USDT0)).toEqual({ ok: true, token: USDT0, expected: POLYGON_USDT0.domainSeparator, actual: POLYGON_USDT0.domainSeparator });
            await expect(assertTokenDomain(publicClient, pins, USDT0)).resolves.toBeUndefined();
        });

        it('detects a USDT0 rename (admin changeName replaces the stored separator) and refuses token signatures', async () => {
            await send(KEYS.deployer, USDT0, artifacts.MockUSDT0.abi, 'changeName', ['USDT0 (renamed)']);
            const check = await checkTokenDomain(publicClient, pins, USDT0);
            expect(check.ok).toBe(false);
            expect(check.expected).toBe(POLYGON_USDT0.domainSeparator);
            expect(check.actual).not.toBe(POLYGON_USDT0.domainSeparator);
            await expect(assertTokenDomain(publicClient, pins, USDT0)).rejects.toBeInstanceOf(TokenDomainMismatchError);
            const now = await blockNow();
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ token: USDT0, now })))).toBe('token_domain_mismatch');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ token: USDT0, authMode: 'metaTxApprove', now })))).toBe('token_domain_mismatch');
            // Mode "none" signs nothing for the token and still works.
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ token: USDT0, authMode: 'none', now })))).toBe('resolved');
        });

        it('readTokenNonce reads nonces() for permit and getNonce() for the meta-tx', async () => {
            expect(await readTokenNonce(publicClient, pins, { token: USDC, owner: ADDR.user, authMode: 'permit' })).toBe(0n);
            expect(await readTokenNonce(publicClient, pins, { token: USDT0, owner: ADDR.user, authMode: 'metaTxApprove' })).toBe(0n);
            expect(await codeOf(readTokenNonce(publicClient, pins, { token: USDC, owner: ADDR.user, authMode: 'metaTxApprove' }))).toBe('unsupported_auth_mode');
            expect(await codeOf(readTokenNonce(publicClient, pins, { token: USDC, owner: ADDR.user, authMode: 'none' as never }))).toBe('unsupported_auth_mode');
            expect(await codeOf(readTokenNonce(publicClient, pins, { token: ADDR.other, owner: ADDR.user, authMode: 'permit' }))).toBe('unsupported_token');
        });
    });

    describe('prepare → sign → relay executes', () => {
        it('USDC permit with a viem LocalAccount: the nonce is nonces(from), exact amounts, allowance 0, nonce advanced, confirmOnChain', async () => {
            const now = await blockNow();
            const prepared = await prepareTransfer(publicClient, pins, params({ now }));
            expect(prepared.request.nonce).toBe('0');
            expect(prepared.request.deadline).toBe(String(now + 600));
            expect(prepared.tokenAuth?.message).toEqual({ owner: ADDR.user, spender: harness, value: String(AMOUNT + FEE), nonce: '0', deadline: prepared.request.deadline });
            expect(Object.isFrozen(prepared.request)).toBe(true);

            const signed = await signPrepared(user, prepared, pins, { now });
            expect(signed.request).toEqual(prepared.request);
            expect(signed.authorization.mode).toBe('permit');
            expect(signed.authHash).toBe(tokenAuthHash(signed.authorization));
            const body = buildSubmitTransferBody({ ...signed, quoteId: 'quote-1' });
            const [r, , auth] = relayTransferArgs(body);
            expect(signed.id).toBe(await publicClient.readContract({ address: harness, abi: gaslessTransferAbi, functionName: 'hashTransfer', args: [r, 0n, auth] }));
            expect(validateSubmitTransferBody(body, pins, now)).toEqual({ ok: true });
            const version = versionOf(signed);
            expect(await confirmOnChain(publicClient, pins, version)).toEqual(unusedAnswer('pending'));

            const receipt = await expectExactTransfer(USDC, () => relayExecute(body));
            expect(await nonceOf(ADDR.user)).toBe(1n);
            expect(await readTokenNonce(publicClient, pins, { token: USDC, owner: ADDR.user, authMode: 'permit' })).toBe(1n);
            const executed = executedAnswer(version, receipt);
            expect(await confirmOnChain(publicClient, pins, version, { txHash: receipt.transactionHash })).toEqual(executed);
            expect(await confirmOnChain(publicClient, pins, version)).toEqual(executed);
            expect(await confirmOnChain(publicClient, pins, signed)).toEqual(executed);
            // Without authHash the request alone decides.
            expect(await confirmOnChain(publicClient, pins, { request: signed.request })).toEqual(executed);
            // An unknown (e.g. replaced) transaction hash falls back to the search.
            expect(await confirmOnChain(publicClient, pins, version, { txHash: `0x${'12'.repeat(32)}` })).toEqual(executed);
            // The same request with another token authorization is another version.
            expect(await confirmOnChain(publicClient, pins, { request: signed.request, authHash: tokenAuthHash(NONE_AUTH) })).toEqual(
                executedAnswer(version, receipt, 'other_version_executed'),
            );
            // The next payment takes the next nonce.
            expect((await prepareTransfer(publicClient, pins, params({ now }))).request.nonce).toBe('1');
        });

        it('USDT0 meta-tx approve with a WalletClient (local account)', async () => {
            const now = await blockNow();
            const prepared = await prepareTransfer(publicClient, pins, params({ token: USDT0, authMode: 'metaTxApprove', now }));
            const signed = await signPrepared(wallet(KEYS.user), prepared, pins, { now });
            expect(signed.authorization.mode).toBe('metaTxApprove');
            await expectExactTransfer(USDT0, () => relayExecute(buildSubmitTransferBody(signed)));
            expect(await readTokenNonce(publicClient, pins, { token: USDT0, owner: ADDR.user, authMode: 'permit' })).toBe(1n);
        });

        it('USDT0 permit with a JSON-RPC wallet (eth_signTypedData_v4 signed by anvil)', async () => {
            const now = await blockNow();
            const rpcWallet = createWalletClient({ chain, transport: http(anvil.url), account: ADDR.user });
            const prepared = await prepareTransfer(publicClient, pins, params({ token: USDT0, now }));
            const signed = await signPrepared(rpcWallet, prepared, pins, { now });
            await expectExactTransfer(USDT0, () => relayExecute(buildSubmitTransferBody(signed)));
            // A WalletClient without a hoisted account needs options.account.
            const bare = createWalletClient({ chain, transport: http(anvil.url) });
            const again = await prepareTransfer(publicClient, pins, params({ token: USDT0, now }));
            expect(again.request.nonce).toBe('1');
            await expect(signPrepared(bare, again, pins, { now })).rejects.toThrow(TypeError);
            await expect(signPrepared(bare, again, pins, { now, account: ADDR.user })).resolves.toMatchObject({ request: again.request });
        });

        it('mode "none" after a direct approve', async () => {
            await send(KEYS.user, USDC, usdcAbi, 'approve', [harness, AMOUNT + FEE]);
            const now = await blockNow();
            const prepared = await prepareTransfer(publicClient, pins, params({ authMode: 'none', now }));
            expect(prepared.tokenAuth).toBeNull();
            const signed = await signPrepared(user, prepared, pins, { now });
            expect(signed.authorization).toEqual(NONE_AUTH);
            await expectExactTransfer(USDC, () => relayExecute(buildSubmitTransferBody(signed)));
        });

        it.each<[string, AuthModeName, Address]>([
            ['ethers v5 signs a USDT0 meta-tx transfer', 'metaTxApprove', USDT0],
            ['ethers v6 signs a USDC permit transfer', 'permit', USDC],
        ])('%s: the token authorization first, then the transfer over it', async (name, authMode, token) => {
            const now = await blockNow();
            const prepared = await prepareTransfer(publicClient, pins, params({ token, authMode, now }));
            const sign = async (payload: { domain: object; types: object; message: object }) =>
                name.startsWith('ethers v5')
                    ? new Ethers5Wallet(KEYS.user)._signTypedData(payload.domain as never, payload.types as never, payload.message as never)
                    : new Ethers6Wallet(KEYS.user).signTypedData(payload.domain as never, payload.types as never, payload.message as never);
            const tokenAuth = tokenAuthSigningPayload(pins, prepared, now);
            const authorization = toTokenAuthorization(authMode, await sign(tokenAuth as NonNullable<typeof tokenAuth>));
            const body = buildSubmitTransferBody({ request: prepared.request, signature: await sign(transferSigningPayload(pins, prepared, authorization, now)), authorization });
            await expectExactTransfer(token, () => relayExecute(body));
        });
    });

    describe('the contract checks the signature first', () => {
        it('a relay that changes the token authorization, or replays the request, is refused with InvalidSignature', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ token: USDT0, now });
            const body = buildSubmitTransferBody(signed);
            const [request, signature, auth] = relayTransferArgs(body);
            for (const changed of [
                { ...auth, mode: AUTH_MODE_ID.none },
                { ...auth, mode: AUTH_MODE_ID.metaTxApprove },
                { ...auth, v: auth.v === 27 ? 28 : 27 },
                { ...auth, s: ZERO32 },
            ]) {
                await expect(simulateRelayTransfer([request, signature, changed])).rejects.toThrow(/InvalidSignature/);
            }
            // Another deadline, fee or recipient is another request.
            await expect(simulateRelayTransfer([{ ...request, fee: request.fee + 10_000n }, signature, auth])).rejects.toThrow(/InvalidSignature/);
            await expectExactTransfer(USDT0, () => relayExecute(body));
            // Replayed: the nonce moved on, so the signature is not for the current nonce.
            await expect(simulateRelayTransfer([request, signature, auth])).rejects.toThrow(/InvalidSignature/);
        });

        it('a request signed at a higher nonce cannot execute before the nonces below it are used', async () => {
            const now = await blockNow();
            const tokenNonce = await readTokenNonce(publicClient, pins, { token: USDC, owner: ADDR.user, authMode: 'permit' });
            const ahead = createTransferIntent(
                pins,
                { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: FEE, relay: ADDR.relay, authMode: 'permit', deadline: now + 600, nonce: 1n, tokenNonce },
                now,
            );
            const body = buildSubmitTransferBody(await signPrepared(user, ahead, pins, { now }));
            await expect(simulateRelayTransfer(relayTransferArgs(body))).rejects.toThrow(/InvalidSignature/);
            await send(KEYS.user, harness, gaslessTransferAbi, 'invalidateNonces', [1n]);
            await expectExactTransfer(USDC, () => relayExecute(body));
        });
    });

    describe('token authorization mode chosen by prepareTransfer (no authMode given)', () => {
        const auto = (overrides: Partial<PrepareTransferParams> & { now: number }) => params({ ...overrides, authMode: undefined });
        const allowance = (token: Address) => allowanceToHarness(token);

        it('without a covering allowance: permit, for USDT0 too (never the META_TX)', async () => {
            const now = await blockNow();
            for (const token of [USDC, USDT0]) {
                const prepared = await prepareTransfer(publicClient, pins, auto({ token, now }));
                expect(prepared.authMode, token).toBe('permit');
                expect(prepared.tokenAuth?.primaryType, token).toBe('Permit');
                const signed = await signPrepared(user, prepared, pins, { now });
                expect(signed.authorization.mode).toBe('permit');
                await expectExactTransfer(token, () => relayExecute(buildSubmitTransferBody(signed)));
            }
        });

        it('with allowance(from, contract) >= amount + fee: none, which spends the standing allowance instead of overwriting it', async () => {
            const standing = 3n * (AMOUNT + FEE);
            for (const token of [USDC, USDT0]) {
                await send(KEYS.user, token, usdcAbi, 'approve', [harness, standing]);
                const now = await blockNow();
                const prepared = await prepareTransfer(publicClient, pins, auto({ token, now }));
                expect(prepared.authMode, token).toBe('none');
                expect(prepared.tokenAuth).toBeNull();
                const signed = await signPrepared(user, prepared, pins, { now });
                expect(signed.authorization).toEqual(NONE_AUTH);
                const before = await balances(token);
                await relayExecute(buildSubmitTransferBody(signed));
                const after = await balances(token);
                expect(after.recipient - before.recipient).toBe(AMOUNT);
                expect(after.relay - before.relay).toBe(FEE);
                expect(await allowance(token)).toBe(standing - AMOUNT - FEE);

                // A forced permit sets the allowance to amount + fee: the rest of the standing allowance is gone.
                const forced = await prepareTransfer(publicClient, pins, params({ token, authMode: 'permit', now }));
                expect(forced.authMode).toBe('permit');
                await relayExecute(buildSubmitTransferBody(await signPrepared(user, forced, pins, { now })));
                expect(await allowance(token)).toBe(0n);
            }
        });

        it('the boundary is amount + fee, and a forced mode is used as given', async () => {
            const now = await blockNow();
            await send(KEYS.user, USDT0, usdcAbi, 'approve', [harness, AMOUNT + FEE - 1n]);
            expect((await prepareTransfer(publicClient, pins, auto({ token: USDT0, now }))).authMode).toBe('permit');
            await send(KEYS.user, USDT0, usdcAbi, 'approve', [harness, AMOUNT + FEE]);
            expect((await prepareTransfer(publicClient, pins, auto({ token: USDT0, now }))).authMode).toBe('none');
            // The fee is part of the comparison: the same allowance does not cover a higher fee.
            expect((await prepareTransfer(publicClient, pins, auto({ token: USDT0, fee: FEE + 10_000n, now }))).authMode).toBe('permit');
            for (const authMode of ['permit', 'metaTxApprove', 'none'] as const) {
                expect((await prepareTransfer(publicClient, pins, params({ token: USDT0, authMode, now }))).authMode).toBe(authMode);
            }
        });

        it('an EIP-7702 account: none with a covering allowance, else the USDC permit refusal', async () => {
            const now = await blockNow();
            const delegated = `0xef0100${harness.slice(2)}` as Hex;
            await testClient.setCode({ address: ADDR.other, bytecode: delegated });
            expect(await codeOf(prepareTransfer(publicClient, pins, auto({ from: ADDR.other, now })))).toBe('eip7702_permit_unsupported');
            // The account approves the contract once (sent here before the delegation is installed).
            await testClient.setCode({ address: ADDR.other, bytecode: '0x' });
            await send(KEYS.other, USDC, usdcAbi, 'approve', [harness, AMOUNT + FEE]);
            await testClient.setCode({ address: ADDR.other, bytecode: delegated });
            expect((await prepareTransfer(publicClient, pins, auto({ from: ADDR.other, now }))).authMode).toBe('none');
        });
    });

    describe('prepareTransfer refusals', () => {
        it('refuses a client on another chain than the pins', async () => {
            const amoyPins = definePins({
                chainId: 80002,
                transfer: harness,
                relays: [ADDR.relay],
                tokens: [
                    {
                        symbol: 'USDC',
                        address: USDC,
                        decimals: 6,
                        authModes: ['permit', 'none'],
                        domain: { name: 'USD Coin', version: '2', chainId: 80002, verifyingContract: USDC },
                    },
                ],
            });
            expect(await codeOf(prepareTransfer(publicClient, amoyPins, params({ now: await blockNow() })))).toBe('wrong_chain');
        });

        it('refuses contract senders and USDC permits from EIP-7702 accounts (suggesting mode "none")', async () => {
            const now = await blockNow();
            await testClient.setCode({ address: ADDR.other, bytecode: `0xef0100${harness.slice(2)}` as Hex });
            const from7702 = { from: ADDR.other, now };
            const error = await prepareTransfer(publicClient, pins, params(from7702)).catch((e: unknown) => e);
            expect((error as GaslessValidationError).code).toBe('eip7702_permit_unsupported');
            expect((error as GaslessValidationError).message).toMatch(/"none"/);
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ ...from7702, authMode: 'none' })))).toBe('resolved');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ ...from7702, token: USDT0 })))).toBe('resolved');

            await testClient.setCode({ address: ADDR.other, bytecode: '0x6080604052' });
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ ...from7702, authMode: 'none' })))).toBe('sender_is_contract');
        });

        it('USDC permit of an EIP-7702 account with allowEip7702Permit: the delegate decides via ERC-1271', async () => {
            const now = await blockNow();
            const deployed = await wallet(KEYS.deployer).deployContract({ abi: artifacts.EcdsaDelegate.abi, bytecode: artifacts.EcdsaDelegate.bytecode });
            const ecdsaDelegate = getAddress((await publicClient.waitForTransactionReceipt({ hash: deployed })).contractAddress as Address);
            const withoutErc1271 = `0xef0100${harness.slice(2)}` as Hex;
            await testClient.setCode({ address: ADDR.other, bytecode: withoutErc1271 });

            const from7702 = params({ from: ADDR.other, now });
            const refused = (await prepareTransfer(publicClient, pins, from7702).catch((e: unknown) => e)) as GaslessValidationError;
            expect(refused.code).toBe('eip7702_permit_unsupported');
            expect(refused.message).toMatch(/ERC-1271/);
            expect(refused.message).toMatch(/allowEip7702Permit/);
            expect(await codeOf(prepareTransfer(publicClient, pins, { ...from7702, allowEip7702Permit: false }))).toBe('eip7702_permit_unsupported');

            const prepared = await prepareTransfer(publicClient, pins, { ...from7702, allowEip7702Permit: true });
            expect(prepared.authMode).toBe('permit');
            const body = buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.other), prepared, pins, { now }));
            // A delegate without isValidSignature: the token rejects the permit, so the transfer reverts.
            await expect(simulateRelayTransfer(relayTransferArgs(body))).rejects.toThrow(/InsufficientAllowance/);
            // A delegate that checks the account's own ECDSA key through ERC-1271: the same permit works.
            await testClient.setCode({ address: ADDR.other, bytecode: `0xef0100${ecdsaDelegate.slice(2)}` as Hex });
            const before = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [ADDR.recipient] });
            await relayExecute(body);
            expect(await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [ADDR.recipient] })).toBe(before + AMOUNT);
        });

        it("refuses a fee above the caller's maxAcceptableFee before any chain access", async () => {
            const now = await blockNow();
            const rpcCalls: string[] = [];
            const offline = createPublicClient({
                chain,
                transport: custom({
                    async request({ method }: { method: string }) {
                        rpcCalls.push(method);
                        throw new Error(`unexpected RPC call ${method}`);
                    },
                }),
            });
            // A greedy relay may quote anything (nothing caps the fee on-chain); the caller accepts at most 0.10.
            const error = (await prepareTransfer(offline, pins, params({ fee: 50_000_000n, maxAcceptableFee: 100_000n, now })).catch((e: unknown) => e)) as GaslessValidationError;
            expect(error).toBeInstanceOf(GaslessValidationError);
            expect(error.code).toBe('fee_above_limit');
            expect(error.field).toBe('request.fee');
            for (const bad of [-1n, '1.5', 'abc', '']) {
                expect(await codeOf(prepareTransfer(offline, pins, params({ maxAcceptableFee: bad as never, now })))).toBe('invalid_request');
            }
            expect(rpcCalls).toEqual([]);
            // At or below the limit the transfer is prepared as usual.
            expect((await prepareTransfer(publicClient, pins, params({ maxAcceptableFee: FEE, now }))).request.fee).toBe(String(FEE));
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ maxAcceptableFee: String(FEE - 1n), now })))).toBe('fee_above_limit');
        });

        it('checks the request against the pins, takes any fee amount + fee allows, and rejects conflicting deadline options', async () => {
            const now = await blockNow();
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ to: harness, now })))).toBe('invalid_recipient');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ fee: (1n << 256n) - AMOUNT, now })))).toBe('invalid_amount');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ relay: ADDR.other, now })))).toBe('wrong_relay');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ deadlineSeconds: 30, now })))).toBe('deadline_out_of_range');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ deadline: now + 600, deadlineSeconds: 600, now })))).toBe('invalid_request');
            const longest = await prepareTransfer(publicClient, pins, params({ deadlineSeconds: 7200, now }));
            expect(longest.request.deadline).toBe(String(now + 7200));
            // No fee cap: a fee of any size is prepared for either token.
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ fee: 5_000_001n, now })))).toBe('resolved');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ token: USDT0, fee: 50_000_000n, now })))).toBe('resolved');
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ amount: 1n, fee: (1n << 256n) - 2n, now })))).toBe('resolved');
        });
    });

    describe('corrections: prepareTransfer with corrects', () => {
        /** A client that fails every RPC call: the correction rules are checked before any chain access. */
        function offlineClient(calls: string[]) {
            return createPublicClient({
                chain,
                transport: custom({
                    async request({ method }: { method: string }) {
                        calls.push(method);
                        throw new Error(`unexpected RPC call ${method}`);
                    },
                }),
            });
        }

        it('keeps the intent nonce, and by default a deadline no earlier than the corrected one', async () => {
            const now = await blockNow();
            const long = await prepareTransfer(publicClient, pins, params({ deadlineSeconds: 3_600, now }));
            const corrected = await prepareTransfer(publicClient, pins, params({ fee: FEE + 10_000n, corrects: long.request, now }));
            expect(corrected.request.nonce).toBe(long.request.nonce);
            expect(corrected.request.deadline).toBe(long.request.deadline);
            // A corrected version that expires sooner than the default gets the default lifetime.
            const short = await prepareTransfer(publicClient, pins, params({ deadlineSeconds: 120, now }));
            const later = await prepareTransfer(publicClient, pins, params({ corrects: short.request, now: now + 60 }));
            expect(later.request.nonce).toBe(short.request.nonce);
            expect(later.request.deadline).toBe(String(now + 60 + 600));
            // An explicit later deadline, amount, fee, relay and auth mode may change.
            const twoRelays = definePins({ chainId: 137, transfer: harness, relays: [ADDR.relay, ADDR.other], tokens: POLYGON_TOKENS, deployBlock: pins.deployBlock });
            const moved = await prepareTransfer(publicClient, twoRelays, {
                ...params({ now }),
                amount: AMOUNT - 10_000n,
                fee: FEE + 10_000n,
                relay: ADDR.other,
                authMode: 'none',
                deadline: now + 7_000,
                corrects: long.request,
            });
            expect({ nonce: moved.request.nonce, relay: moved.request.relay, authMode: moved.authMode }).toEqual({
                nonce: long.request.nonce,
                relay: ADDR.other,
                authMode: 'none',
            });
        });

        it('refuses to change from, nonce, token or to, or to move the deadline earlier (correction_mismatch), before any RPC call', async () => {
            const now = await blockNow();
            const first = await prepareTransfer(publicClient, pins, params({ deadlineSeconds: 1_200, now }));
            const calls: string[] = [];
            const offline = offlineClient(calls);
            const cases: Array<[Partial<PrepareTransferParams>, string]> = [
                [{ deadlineSeconds: 600 }, 'request.deadline'],
                [{ deadline: now + 1_199 }, 'request.deadline'],
                [{ token: USDT0 }, 'request.token'],
                [{ to: ADDR.other }, 'request.to'],
                [{ from: ADDR.other }, 'request.from'],
                [{ nonce: 1n }, 'request.nonce'],
            ];
            for (const [change, field] of cases) {
                const error = (await prepareTransfer(offline, pins, { ...params({ now }), corrects: first.request, ...change }).catch((e: unknown) => e)) as GaslessValidationError;
                expect({ code: error.code, field: error.field }, JSON.stringify(change, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).toEqual({
                    code: 'correction_mismatch',
                    field,
                });
            }
            // A malformed corrected request names its own field.
            const malformed = (await prepareTransfer(offline, pins, { ...params({ now }), corrects: { ...first.request, nonce: '0x12' } }).catch((e: unknown) => e)) as GaslessValidationError;
            expect({ code: malformed.code, field: malformed.field }).toEqual({ code: 'invalid_request', field: 'corrects.nonce' });
            expect(calls).toEqual([]);
        });

        it('refuses a nonce without corrects (invalid_request, field nonce) before any RPC call; a new payment takes nonces(from), and a correction may name the payment nonce', async () => {
            const now = await blockNow();
            const calls: string[] = [];
            const offline = offlineClient(calls);
            const error = (await prepareTransfer(offline, pins, params({ nonce: 0n, now })).catch((e: unknown) => e)) as GaslessValidationError;
            expect(error).toBeInstanceOf(GaslessValidationError);
            expect({ code: error.code, field: error.field }).toEqual({ code: 'invalid_request', field: 'nonce' });
            expect(error.message).toMatch(/corrects/);
            expect(error.message).toMatch(/on-chain nonce/);
            // Whatever the nonce and the other options: the current nonce, a higher one, a malformed one, no mode.
            for (const nonce of [0n, '1', 5, '0x12']) {
                const refused = (await prepareTransfer(offline, pins, params({ nonce: nonce as never, authMode: undefined, now })).catch((e: unknown) => e)) as GaslessValidationError;
                expect({ code: refused.code, field: refused.field }, String(nonce)).toEqual({ code: 'invalid_request', field: 'nonce' });
            }
            expect(calls).toEqual([]);

            // Controls. Without a nonce, a new payment takes nonces(from); until that nonce is used, every new payment
            // gets it, so a wallet starts a new payment only once the open one is decided.
            const first = await prepareTransfer(publicClient, pins, params({ now }));
            expect(first.request.nonce).toBe('0');
            expect((await prepareTransfer(publicClient, pins, params({ to: ADDR.other, now }))).request.nonce).toBe('0');
            // With corrects, the nonce may be named; it is the corrected version's (another one is correction_mismatch).
            const corrected = await prepareTransfer(publicClient, pins, params({ fee: FEE + 10_000n, nonce: first.request.nonce, corrects: first.request, now }));
            expect(corrected.request.nonce).toBe(first.request.nonce);
            expect(corrected.request.deadline).toBe(first.request.deadline);
        });

        it('refuses a correction once the intent nonce is used on-chain (nonce_used): the outcome is decided', async () => {
            const now = await blockNow();
            const first = await prepareTransfer(publicClient, pins, params({ now }));
            // Unused: the correction is prepared (and the first version is still signable).
            await expect(prepareTransfer(publicClient, pins, params({ corrects: first.request, now }))).resolves.toMatchObject({ request: { nonce: first.request.nonce } });
            await relayExecute(buildSubmitTransferBody(await signPrepared(user, first, pins, { now })));
            const error = (await prepareTransfer(publicClient, pins, params({ fee: FEE + 10_000n, corrects: first.request, now })).catch((e: unknown) => e)) as GaslessValidationError;
            expect({ code: error.code, field: error.field }).toEqual({ code: 'nonce_used', field: 'corrects' });
            expect(error.message).toMatch(/waitForTransferOutcome/);

            const other = await prepareTransfer(publicClient, pins, params({ authMode: 'none', now }));
            expect(other.request.nonce).toBe('1');
            await send(KEYS.user, harness, gaslessTransferAbi, 'invalidateNonces', [2n]);
            expect(await codeOf(prepareTransfer(publicClient, pins, params({ authMode: 'none', corrects: other.request, now })))).toBe('nonce_used');
        });
    });

    describe('signPrepared refusals', () => {
        it('refuses another signer, a wallet signing with another key, a tampered or expired intent', async () => {
            const now = await blockNow();
            const prepared = await prepareTransfer(publicClient, pins, params({ now }));
            expect(await codeOf(signPrepared(privateKeyToAccount(KEYS.other), prepared, pins, { now }))).toBe('signer_mismatch');
            const lying = { ...privateKeyToAccount(KEYS.other), address: ADDR.user as Address };
            expect(await codeOf(signPrepared(lying, prepared, pins, { now }))).toBe('invalid_signature');
            const tokenAuth = prepared.tokenAuth as NonNullable<typeof prepared.tokenAuth>;
            const tampered = { ...prepared, tokenAuth: { ...tokenAuth, message: { ...tokenAuth.message, spender: ADDR.other } } } as unknown as typeof prepared;
            expect(await codeOf(signPrepared(user, tampered, pins, { now }))).toBe('auth_spender_mismatch');
            expect(await codeOf(signPrepared(user, prepared, pins, { now: now + 541 }))).toBe('deadline_out_of_range');
        });
    });

    describe('confirmOnChain', () => {
        it('reports expired once the latest block is past the deadline', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ deadlineSeconds: 120, now });
            expect((await confirmOnChain(publicClient, pins, signed)).status).toBe('pending');
            await testClient.increaseTime({ seconds: 200 });
            await testClient.mine({ blocks: 1 });
            expect(await confirmOnChain(publicClient, pins, signed)).toEqual(unusedAnswer('expired'));
        });

        it('reports nonce_consumed when invalidateNonces covered the nonce, with its transaction; the new nonce itself stays pending', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ authMode: 'none', now });
            const invalidation = await send(KEYS.user, harness, gaslessTransferAbi, 'invalidateNonces', [3n]);
            const consumed = { status: 'nonce_consumed', txHash: invalidation.transactionHash, blockNumber: invalidation.blockNumber, executedTransfer: null };
            expect(await confirmOnChain(publicClient, pins, signed)).toEqual(consumed);
            // NonceInvalidated(signer, 0, 3) covers [0, 3).
            const at = (nonce: number) => ({ request: { ...signed.request, nonce: String(nonce) } });
            expect(await confirmOnChain(publicClient, pins, at(2))).toEqual(consumed);
            expect(await confirmOnChain(publicClient, pins, at(3))).toEqual(unusedAnswer('pending'));
            // The next payment takes nonce 3; the signature at nonce 0 no longer executes.
            expect((await prepareTransfer(publicClient, pins, params({ authMode: 'none', now }))).request.nonce).toBe('3');
            await expect(simulateRelayTransfer(relayTransferArgs(buildSubmitTransferBody(signed)))).rejects.toThrow(/InvalidSignature/);
            // Invalidation only moves forward, by at most 2^32 − 1.
            await expect(
                publicClient.simulateContract({ account: ADDR.user, address: harness, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [3n] }),
            ).rejects.toThrow(/InvalidNonceIncrease/);
        });

        // nonce_consumed would be wrong here: the wallet rules read it as "a new payment is safe".
        it('another version of the payment (same from and nonce, other fields) executed: other_version_executed with its version, from the receipt or the search', async () => {
            const now = await blockNow();
            const first = await signedTransfer({ now });
            const second = await signedTransfer({ fee: FEE + 10_000n, corrects: first.request, now });
            expect(second.request.nonce).toBe(first.request.nonce);
            const receipt = await relayExecute(buildSubmitTransferBody(second));
            const sibling = executedAnswer(versionOf(second), receipt, 'other_version_executed');
            expect(await confirmOnChain(publicClient, pins, first, { txHash: receipt.transactionHash })).toEqual(sibling);
            expect(await confirmOnChain(publicClient, pins, first)).toEqual(sibling);
            expect(await confirmOnChain(publicClient, pins, second)).toEqual(executedAnswer(versionOf(second), receipt));
            // A relay txHash of another transaction does not hide it: the search finds the execution.
            const unrelated = await send(KEYS.user, USDC, usdcAbi, 'approve', [harness, 1n]);
            expect(await confirmOnChain(publicClient, pins, first, { txHash: unrelated.transactionHash })).toEqual(sibling);
            // Past both deadlines the answer stays: the nonce was used at the first version's deadline.
            await testClient.increaseTime({ seconds: 700 });
            await testClient.mine({ blocks: 1 });
            expect(await confirmOnChain(publicClient, pins, first)).toEqual(sibling);
        });

        it('two payments at one nonce (the core takes a nonce without corrects): the check of the one that did not execute is other_payment_executed, never expired', async () => {
            const now = await blockNow();
            const first = await signedTransfer({ now });
            // prepareTransfer gives a second payment the same nonce while the first is open; the wallet rules forbid
            // starting it before the first is decided (sdk/README.md, "One payment, one nonce").
            const tokenNonce = await readTokenNonce(publicClient, pins, { token: USDT0, owner: ADDR.user, authMode: 'permit' });
            const other = createTransferIntent(
                pins,
                { token: USDT0, from: ADDR.user, to: ADDR.other, amount: AMOUNT, fee: FEE, relay: ADDR.relay, authMode: 'permit', deadline: now + 600, nonce: first.request.nonce, tokenNonce },
                now,
            );
            const otherSigned = await signPrepared(user, other, pins, { now });
            const receipt = await relayExecute(buildSubmitTransferBody(otherSigned));
            // The search finds every transfer of a pinned token from the sender. Another token and another
            // recipient: not a version of the first payment, which did not execute and never can.
            const answer = await confirmOnChain(publicClient, pins, first);
            expect(answer).toEqual(executedAnswer(versionOf(otherSigned), receipt, 'other_payment_executed'));
            expect(answer.executedTransfer?.request).toMatchObject({ token: USDT0, to: ADDR.other, nonce: first.request.nonce });
            expect(await confirmOnChain(publicClient, pins, first, { txHash: receipt.transactionHash })).toEqual(answer);
            expect((await confirmOnChain(publicClient, pins, otherSigned)).status).toBe('executed');
            // Past the deadline it stays so, never expired: the nonce was used before it.
            await testClient.increaseTime({ seconds: 700 });
            await testClient.mine({ blocks: 1 });
            expect(await confirmOnChain(publicClient, pins, first)).toEqual(answer);
            expect(await confirmOnChain(publicClient, pins, otherSigned)).toEqual(executedAnswer(versionOf(otherSigned), receipt));
        });

        it('a nonce reused after expiry: the expired payment stays expired, the new payment at that nonce executed', async () => {
            const now = await blockNow();
            const first = await signedTransfer({ deadlineSeconds: 120, now });
            await testClient.increaseTime({ seconds: 200 });
            await testClient.mine({ blocks: 1 });
            expect(await confirmOnChain(publicClient, pins, first)).toEqual(unusedAnswer('expired'));
            // Only now may the wallet start a new payment; it gets the same nonce.
            const later = await blockNow();
            const second = await signedTransfer({ to: ADDR.other, now: later });
            expect(second.request.nonce).toBe(first.request.nonce);
            const receipt = await relayExecute(buildSubmitTransferBody(second));
            // The execution came after the first payment's deadline: it is not the first payment's.
            expect(await confirmOnChain(publicClient, pins, first)).toEqual(unusedAnswer('expired'));
            expect(await confirmOnChain(publicClient, pins, first, { txHash: receipt.transactionHash })).toEqual(unusedAnswer('expired'));
            expect(await confirmOnChain(publicClient, pins, second)).toEqual(executedAnswer(versionOf(second), receipt));
            // The first payment's signature can never execute: the nonce moved on.
            await expect(simulateRelayTransfer(relayTransferArgs(buildSubmitTransferBody(first)))).rejects.toThrow(/InvalidSignature/);
        });

        it('pass the latest version: a correction that executed after the first version deadline leaves the first version expired', async () => {
            const now = await blockNow();
            const first = await signedTransfer({ deadlineSeconds: 120, now });
            const latest = await signedTransfer({ deadlineSeconds: 1_200, corrects: first.request, now });
            await testClient.increaseTime({ seconds: 200 });
            await testClient.mine({ blocks: 1 });
            const receipt = await relayExecute(buildSubmitTransferBody(latest));
            // The first version can never execute; the payment went through, which its latest version tells.
            expect(await confirmOnChain(publicClient, pins, first)).toEqual(unusedAnswer('expired'));
            expect(await confirmOnChain(publicClient, pins, latest)).toEqual(executedAnswer(versionOf(latest), receipt));
        });

        it('an invalidation after the deadline: expired from the state at the deadline; a node without that state finds the invalidation', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ authMode: 'none', deadlineSeconds: 120, now });
            await testClient.increaseTime({ seconds: 200 });
            await testClient.mine({ blocks: 1 });
            const invalidation = await send(KEYS.user, harness, gaslessTransferAbi, 'invalidateNonces', [1n]);
            expect(await confirmOnChain(publicClient, pins, signed)).toEqual(unusedAnswer('expired'));
            expect(await confirmOnChain(withoutHistoricalState(), pins, signed)).toEqual({
                status: 'nonce_consumed',
                txHash: invalidation.transactionHash,
                blockNumber: invalidation.blockNumber,
                executedTransfer: null,
            });
        });

        it('a node without the state at the deadline: an execution is still found by the search', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ deadlineSeconds: 120, now });
            const receipt = await relayExecute(buildSubmitTransferBody(signed));
            await testClient.increaseTime({ seconds: 200 });
            await testClient.mine({ blocks: 3 });
            expect(await confirmOnChain(withoutHistoricalState(), pins, signed)).toEqual(executedAnswer(versionOf(signed), receipt));
        });

        it('a used nonce whose use is not in the blocks searched is unresolved, never nonce_consumed', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ now });
            const receipt = await relayExecute(buildSubmitTransferBody(signed));
            await testClient.mine({ blocks: 3 });
            // The caller's lower bound lies after the execution. fromBlock bounds only the log search of a node without
            // the state of older blocks: there nothing is found, so no answer. The state finds the execution anyway.
            const after = receipt.blockNumber + 1n;
            expect(await confirmOnChain(withoutHistoricalState(), pins, signed, { fromBlock: after })).toEqual(unresolvedAnswer('no_history'));
            expect(await confirmOnChain(withoutHistoricalState(), pins, signed, { fromBlock: receipt.blockNumber })).toEqual(executedAnswer(versionOf(signed), receipt));
            expect(await confirmOnChain(publicClient, pins, signed, { fromBlock: after })).toEqual(executedAnswer(versionOf(signed), receipt));
            await expect(confirmOnChain(publicClient, pins, signed, { fromBlock: -1n })).rejects.toThrow(TypeError);
            await expect(confirmOnChain(publicClient, pins, signed, { fromBlock: 5 as never })).rejects.toThrow(TypeError);
            // waitForTransferOutcome keeps waiting on it and names the missing state in its timeout.
            const waited = await waitForTransferOutcome(withoutHistoricalState(), pins, signed, { blockTag: 'latest', fromBlock: after, pollIntervalMs: 20, timeoutMs: 150 }).catch(
                (error: unknown) => error as { code?: string; message?: string },
            );
            expect(waited).toMatchObject({ code: 'timeout' });
            expect((waited as { message: string }).message).toMatch(/its intent nonce is used, and the RPC serves no state of older blocks \(it is not an archive node\)/);
        });

        it('refuses a client on another chain and a malformed authHash', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ now });
            const otherChainPins = { ...pins, chainId: 80002 };
            expect(await codeOf(confirmOnChain(publicClient, otherChainPins, signed))).toBe('wrong_chain');
            expect(await codeOf(confirmOnChain(publicClient, pins, { request: signed.request, authHash: '0x12' }))).toBe('invalid_request');
        });

        // anvil's "finalized" tag is 64 blocks behind the head, its "safe" tag 32.
        it('blockTag "finalized": an execution counts only once its block is final', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ now });
            const receipt = await relayExecute(buildSubmitTransferBody(signed));
            const executed = executedAnswer(versionOf(signed), receipt);
            expect(await confirmOnChain(publicClient, pins, signed, { txHash: receipt.transactionHash })).toEqual(executed);
            expect(await confirmOnChain(publicClient, pins, signed, { txHash: receipt.transactionHash, blockTag: 'finalized' })).toEqual(unusedAnswer('pending'));
            expect((await confirmOnChain(publicClient, pins, signed, { blockTag: 'safe' })).status).toBe('pending');
            await testClient.mine({ blocks: 64 });
            expect(await confirmOnChain(publicClient, pins, signed, { txHash: receipt.transactionHash, blockTag: 'finalized' })).toEqual(executed);
            expect(await confirmOnChain(publicClient, pins, signed, { blockTag: 'finalized' })).toEqual(executed);
            await expect(confirmOnChain(publicClient, pins, signed, { blockTag: 'pending' as never })).rejects.toThrow(TypeError);
        });

        it('blockTag "finalized": expired only once a finalized block is past the deadline', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ deadlineSeconds: 120, now });
            await testClient.increaseTime({ seconds: 200 });
            await testClient.mine({ blocks: 1 });
            expect((await confirmOnChain(publicClient, pins, signed)).status).toBe('expired');
            expect((await confirmOnChain(publicClient, pins, signed, { blockTag: 'finalized' })).status).toBe('pending');
            await testClient.mine({ blocks: 64 });
            expect((await confirmOnChain(publicClient, pins, signed, { blockTag: 'finalized' })).status).toBe('expired');
        });
    });

    describe('waitForTransferOutcome', () => {
        /** A relay answer for `signed`, as RelayClient.getRequest returns it. */
        function relayState(signed: SignedTransfer, status: RequestState['status']): RequestState {
            const broadcast = status !== 'queued';
            return {
                id: signed.id,
                operation: 'transfer',
                status,
                request: signed.request,
                authHash: signed.authHash,
                transactions: broadcast ? [{ hash: `0x${'11'.repeat(32)}`, txNonce: 1, maxFeePerGas: '1000000000', status: 'mined' }] : [],
                txHash: null,
                blockNumber: null,
                error: status === 'failed' ? { code: 'simulation_failed', message: 'the call reverted on-chain' } : null,
            };
        }

        /** A relay that always answers `answer` (or throws it) and counts the calls. */
        function fakeRelay(answer: () => RequestState) {
            const relay = {
                calls: 0,
                async getRequest(): Promise<RequestState> {
                    relay.calls += 1;
                    return answer();
                },
            };
            return relay;
        }

        async function executedTransfer() {
            const now = await blockNow();
            const signed = await signedTransfer({ now });
            const receipt = await relayExecute(buildSubmitTransferBody(signed));
            return { signed, version: versionOf(signed), receipt };
        }

        it('returns executed once the execution is in a finalized block, not before', async () => {
            const { version, receipt } = await executedTransfer();
            expect(await codeOf(waitForTransferOutcome(publicClient, pins, version, { pollIntervalMs: 20, timeoutMs: 150 }))).toBe('timeout');
            // "latest" answers at once, but a reorg could still change that answer.
            expect((await waitForTransferOutcome(publicClient, pins, version, { blockTag: 'latest', timeoutMs: 1_000 })).status).toBe('executed');
            await testClient.mine({ blocks: 64 });
            expect(await waitForTransferOutcome(publicClient, pins, version, { pollIntervalMs: 20, timeoutMs: 5_000 })).toEqual({
                ...executedAnswer(version, receipt),
                relayState: null,
            });
        });

        it('returns expired once a finalized block is past the deadline, and nonce_consumed once the invalidation is final', async () => {
            const now = await blockNow();
            const lapsed = versionOf(await signedTransfer({ deadlineSeconds: 120, now }));
            await testClient.increaseTime({ seconds: 200 });
            await testClient.mine({ blocks: 1 });
            expect(await codeOf(waitForTransferOutcome(publicClient, pins, lapsed, { pollIntervalMs: 20, timeoutMs: 150 }))).toBe('timeout');
            await testClient.mine({ blocks: 64 });
            expect((await waitForTransferOutcome(publicClient, pins, lapsed, { pollIntervalMs: 20, timeoutMs: 5_000 })).status).toBe('expired');

            const later = await blockNow();
            const invalidated = versionOf(await signedTransfer({ authMode: 'none', now: later }));
            expect(invalidated.request.nonce).toBe(lapsed.request.nonce);
            const invalidation = await send(KEYS.user, harness, gaslessTransferAbi, 'invalidateNonces', [BigInt(invalidated.request.nonce) + 1n]);
            await testClient.mine({ blocks: 64 });
            expect(await waitForTransferOutcome(publicClient, pins, invalidated, { pollIntervalMs: 20, timeoutMs: 5_000 })).toEqual({
                status: 'nonce_consumed',
                txHash: invalidation.transactionHash,
                blockNumber: invalidation.blockNumber,
                executedTransfer: null,
                relayState: null,
            });
        });

        it('a relay "failed" makes it read the chain, which decides: executed, although the relay reported a failure', async () => {
            const { signed, version, receipt } = await executedTransfer();
            await testClient.mine({ blocks: 64 });
            const relay = fakeRelay(() => relayState(signed, 'failed'));
            const outcome = await waitForTransferOutcome(publicClient, pins, version, { relay, pollIntervalMs: 20, timeoutMs: 5_000 });
            expect({ status: outcome.status, txHash: outcome.txHash, relayStatus: outcome.relayState?.status }).toEqual({
                status: 'executed',
                txHash: receipt.transactionHash,
                relayStatus: 'failed',
            });
            expect(relay.calls).toBe(1);
        });

        it('while the relay reports queued or submitted, the chain is read only after the deadline (client clock) or when the relay does not answer', async () => {
            const { signed, version } = await executedTransfer();
            await testClient.mine({ blocks: 64 });
            const deadline = Number(signed.request.deadline);
            const submitted = fakeRelay(() => relayState(signed, 'submitted'));
            // The chain says executed, but a relay that says "submitted" before the deadline is believed for now.
            const early = await codeOf(waitForTransferOutcome(publicClient, pins, version, { relay: submitted, now: () => deadline - 10, pollIntervalMs: 20, timeoutMs: 150 }));
            expect(early).toBe('timeout');
            expect(submitted.calls).toBeGreaterThan(1);
            const late = await waitForTransferOutcome(publicClient, pins, version, { relay: submitted, now: () => deadline + 1, pollIntervalMs: 20, timeoutMs: 5_000 });
            expect({ status: late.status, relayStatus: late.relayState?.status }).toEqual({ status: 'executed', relayStatus: 'submitted' });
            const unreachable = fakeRelay(() => {
                throw new Error('network error');
            });
            const outcome = await waitForTransferOutcome(publicClient, pins, version, { relay: unreachable, now: () => deadline - 10, pollIntervalMs: 20, timeoutMs: 5_000 });
            expect({ status: outcome.status, relayState: outcome.relayState }).toEqual({ status: 'executed', relayState: null });
        });

        it('checks its input and stops when aborted', async () => {
            const now = await blockNow();
            const signed = await signedTransfer({ now });
            const version = versionOf(signed);
            expect(await codeOf(waitForTransferOutcome(publicClient, pins, { ...version, id: `0x${'00'.repeat(32)}` }))).toBe('invalid_request');
            await expect(waitForTransferOutcome(publicClient, pins, { ...version, id: signed.id }, { blockTag: 'latest', timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
            for (const authHash of [undefined, '0x12', tokenAuthHash(NONE_AUTH).slice(0, 65)]) {
                expect(await codeOf(waitForTransferOutcome(publicClient, pins, { request: signed.request, authHash } as never)), String(authHash)).toBe('invalid_request');
            }
            await expect(waitForTransferOutcome(publicClient, pins, version, { pollIntervalMs: 0 })).rejects.toThrow(TypeError);
            await expect(waitForTransferOutcome(publicClient, pins, version, { timeoutMs: 1.5 })).rejects.toThrow(TypeError);
            await expect(waitForTransferOutcome(publicClient, pins, version, { relay: {} as never })).rejects.toThrow(TypeError);
            await expect(waitForTransferOutcome(publicClient, pins, version, { blockTag: 'earliest' as never })).rejects.toThrow(TypeError);
            expect(await codeOf(waitForTransferOutcome(publicClient, pins, version, { signal: AbortSignal.abort() }))).toBe('aborted');
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 50);
            expect(await codeOf(waitForTransferOutcome(publicClient, pins, version, { signal: controller.signal, pollIntervalMs: 10_000 }))).toBe('aborted');
        });
    });
});
