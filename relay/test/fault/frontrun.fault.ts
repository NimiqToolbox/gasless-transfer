// The sender acts against its own accepted request (funds moved, nonce invalidated, allowance revoked, token nonce
// consumed, EIP-7702 delegation), before and after the relay's broadcast. Each test records the final status and
// what the relay paid. Before the broadcast the pre-broadcast checks catch it and the relay pays nothing. After the
// broadcast the relay cannot stop it: a call front-run after its broadcast reverts on-chain, costs the relay at most
// its spend cap (gas limit × maxFeePerGas ≤ RELAY_MAX_COST_PERCENT_OF_FEE, default 200 %, of the fee; gas limit =
// min(estimate × 1.3, gas table)), and is counted in relay_requests_reverted_onchain_total
// (relay/docs/transaction-lifecycle.md).
import { afterEach, describe, expect, it } from 'vitest';
import { createWalletClient, encodeFunctionData, formatEther, http, parseGwei, type Address, type Hash, type Hex, type PrivateKeyAccount } from 'viem';
import { foundry } from 'viem/chains';
import { gaslessTransferAbi, usdcAbi } from '@nimiq/gasless-sdk/core';
import {
    RECIPIENT,
    anvilAccount,
    artifactBytecode,
    lastBlockOrder,
    mockTokenAbi,
    sendFrom,
    signTransfer,
    startFaultEnv,
    status,
    submit,
    tick,
    type FaultEnv,
    type SignedTransfer,
} from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

const HIGH_TIP = { maxFeePerGas: parseGwei('2000'), maxPriorityFeePerGas: parseGwei('500') };
/** relay/config/gasTable.json, transfer/permit. */
const GAS_TABLE_PERMIT = 280_000n;

interface Outcome {
    readonly case: string;
    readonly status: string;
    readonly code: string | null;
    readonly relayGasUsed: bigint;
    readonly relayCostWei: bigint;
    readonly relayCostPol: string;
    readonly attackerGasUsed: bigint;
    readonly feeEarned: bigint;
}

/** 200 % (RELAY_MAX_COST_PERCENT_OF_FEE default) of the request's fee in wei, at the fixture's POL/USD 0.2. */
function spendCapWei(t: SignedTransfer): bigint {
    return BigInt(t.body.request.fee) * 5n * 10n ** 12n * 2n;
}

/**
 * The bound on a call that reverts after its broadcast (the relay cannot stop the sender then):
 * the reverted call cost at most the request's spend cap, both as sent (gas limit × maxFeePerGas) and as paid, and
 * it was counted as a reverted call.
 */
async function expectBoundedRevertedCall(e: FaultEnv, t: SignedTransfer, o: Outcome): Promise<void> {
    const [call] = e.relay.server.store.listAttempts(t.id);
    expect(call!.gasLimit * call!.maxFeePerGas).toBeLessThanOrEqual(spendCapWei(t));
    expect(o.relayCostWei).toBeLessThanOrEqual(spendCapWei(t));
    const metrics = await e.relay.server.relay.metrics.registry.metrics();
    expect(metrics).toContain('relay_requests_reverted_onchain_total{operation="transfer"} 1');
}

const outcomes: Outcome[] = [];

/** The relay's call is in the mempool; `attack` sends the sender's own transaction(s) with a higher tip. */
async function frontRunAfterBroadcast(
    e: FaultEnv,
    label: string,
    t: SignedTransfer,
    attack: () => Promise<Hash[]>,
): Promise<Outcome> {
    const { stack, relay } = e;
    await submit(relay, t);
    await tick(relay);
    const [call] = relay.server.store.listAttempts(t.id);
    expect(call?.kind).toBe('call');
    const relayTokenBefore = await stack.balanceOf(t.body.request.token, relay.address);
    const hashes = await attack();
    await stack.mine();
    console.log(`${label}: block order`, (await lastBlockOrder(stack)).map((x) => ({ from: x.from.slice(0, 8), nonce: x.nonce, tip: x.tip })));
    await tick(relay);
    const receipt = await stack.publicClient.getTransactionReceipt({ hash: call!.hash });
    let attackerGasUsed = 0n;
    for (const h of hashes) attackerGasUsed += (await stack.publicClient.getTransactionReceipt({ hash: h })).gasUsed;
    const state = await relay.state(t.id);
    const outcome: Outcome = {
        case: label,
        status: state.status,
        code: state.error?.code ?? null,
        relayGasUsed: receipt.gasUsed,
        relayCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
        relayCostPol: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
        attackerGasUsed,
        feeEarned: (await stack.balanceOf(t.body.request.token, relay.address)) - relayTokenBefore,
    };
    outcomes.push(outcome);
    console.log('front-run after broadcast', outcome);
    return outcome;
}

describe('front-running after the broadcast (the call is in the mempool)', () => {
    it('funds moved away after the broadcast → the call reverts on-chain (failed, no fee); its cost stays within the spend cap and is counted', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const user = anvilAccount(1);
        const t = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 10_000_000n });
        const o = await frontRunAfterBroadcast(env, 'USDC permit, balance moved', t, async () => {
            const balance = await stack.balanceOf(stack.usdc, user.address);
            // Leaves exactly the fee: the permit and the fee transfer succeed, the principal transfer reverts last.
            return [
                await sendFrom(stack, user, { address: stack.usdc, abi: mockTokenAbi, functionName: 'transfer', args: [anvilAccount(12).address, balance - BigInt(t.body.request.fee)] }, HIGH_TIP),
            ];
        });
        expect(o.status).toBe('failed');
        expect(o.feeEarned).toBe(0n);
        await expectBoundedRevertedCall(env, t, o);
    });

    it('nonce invalidated after the broadcast → the call reverts on-chain (failed); its cost stays within the spend cap and is counted', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const user = anvilAccount(2);
        const t = await signTransfer(stack, relay, { from: 2, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 10_000_000n });
        const o = await frontRunAfterBroadcast(env, 'USDT0 meta-tx, nonce invalidated', t, async () => [
            await sendFrom(stack, user, { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(t.body.request.nonce) + 1n] }, HIGH_TIP),
        ]);
        expect(o.status).toBe('failed');
        await expectBoundedRevertedCall(env, t, o);
    });

    it('allowance revoked (NONE) after the broadcast → the call reverts on-chain (failed); its cost stays within the spend cap and is counted', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const user = anvilAccount(3);
        const t = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'none', to: RECIPIENT, amount: 10_000_000n });
        await stack.send(user, { address: stack.usdc, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 10_000_000n + BigInt(t.body.request.fee)] });
        const o = await frontRunAfterBroadcast(env, 'USDC none, allowance revoked', t, async () => [
            await sendFrom(stack, user, { address: stack.usdc, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 0n] }, HIGH_TIP),
        ]);
        expect(o.status).toBe('failed');
        await expectBoundedRevertedCall(env, t, o);
    });

    it('an EIP-7702 delegation to a gas burner after the broadcast burns the whole gas limit of the USDC permit call, which the gas table and the spend cap bound', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const user = anvilAccount(4);
        // The griefing delegate from contracts/test/fork-verify/Eip7702.t.sol (compiled by globalSetup).
        const burner = await deploy(env, anvilAccount(0), artifactBytecode('Eip7702.t.sol', 'VfGasBurnerDelegate'));
        const t = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 10_000_000n });
        const o = await frontRunAfterBroadcast(env, 'USDC permit, 7702 delegation to a gas burner', t, async () => [await delegate(env!, user, burner)]);
        const [call] = relay.server.store.listAttempts(t.id);
        console.log('gas burner delegation', { gasLimit: call!.gasLimit, relayGasUsed: o.relayGasUsed, attackerGasUsed: o.attackerGasUsed, ratio: Number(o.relayGasUsed) / Number(o.attackerGasUsed) });
        expect(o.status).toBe('failed');
        expect(await stack.publicClient.getCode({ address: user.address })).toMatch(/^0xef0100/);
        expect(o.relayGasUsed).toBeGreaterThan((call!.gasLimit * 95n) / 100n); // the whole gas limit is burned
        // After the broadcast the relay cannot stop the delegation; what it burns is bounded: the gas limit is
        // min(estimate × 1.3, gas table) and gas limit × maxFeePerGas stays within the spend cap.
        expect(call!.gasLimit).toBeLessThanOrEqual(GAS_TABLE_PERMIT);
        expect(o.relayGasUsed).toBeLessThanOrEqual(call!.gasLimit);
        await expectBoundedRevertedCall(env, t, o);
    });
});

describe('EIP-7702 delegation after acceptance, before the broadcast', () => {
    it('the checks before the broadcast refuse the USDC permit of a sender that has code now; the relay pays nothing', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const user = anvilAccount(4);
        const burner = await deploy(env, anvilAccount(0), artifactBytecode('Eip7702.t.sol', 'VfGasBurnerDelegate'));
        const t = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 10_000_000n });
        await submit(relay, t);
        const relayEthBefore = await stack.publicClient.getBalance({ address: relay.address });
        await delegate(env, user, burner);
        await stack.mine();
        expect(await stack.publicClient.getCode({ address: user.address })).toMatch(/^0xef0100/);
        const passErrors = await passesUntilDecided({ stack, relay }, t);
        const state = await relay.state(t.id);
        console.log('gas burner delegation before the broadcast', { status: state.status, code: state.error?.code, message: state.error?.message, passErrors });
        expect(state.status).toBe('failed');
        expect(relay.server.store.listAttempts(t.id)).toHaveLength(0);
        expect(await stack.publicClient.getBalance({ address: relay.address })).toBe(relayEthBefore);
    });
});

describe('front-running before the broadcast (the request is still queued)', () => {
    it('the pre-broadcast simulation catches it: failed with the decoded code, the relay pays nothing', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const cases: Array<{ from: number; label: string; token: 'usdc' | 'usdt0'; mode: 'permit' | 'metaTxApprove' | 'none'; attack: (t: SignedTransfer, user: PrivateKeyAccount) => Promise<void>; code: string }> = [
            {
                from: 5,
                label: 'funds moved',
                token: 'usdc',
                mode: 'permit',
                code: 'simulation_failed',
                attack: async (_t, user) => {
                    const balance = await stack.balanceOf(stack.usdc, user.address);
                    await stack.send(user, { address: stack.usdc, abi: mockTokenAbi, functionName: 'transfer', args: [anvilAccount(12).address, balance] });
                },
            },
            {
                from: 6,
                label: 'nonce invalidated',
                token: 'usdt0',
                mode: 'permit',
                code: 'nonce_used',
                attack: async (t, user) => {
                    await stack.send(user, { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(t.body.request.nonce) + 1n] });
                },
            },
            {
                from: 7,
                label: 'USDT0 nonce consumed by another permit',
                token: 'usdt0',
                mode: 'metaTxApprove',
                // Not insufficient_allowance (the revert the failed meta-transaction surfaces as): the failure is
                // attributed like step 7 of the pipeline, because the signature does not match the token's current
                // nonce.
                code: 'invalid_token_authorization',
                attack: async (_t, user) => {
                    // Any USDT0 meta-tx or permit of the user moves the shared nonce.
                    await consumeUsdt0Nonce(env!, user);
                },
            },
        ];
        const relayEthBefore = await stack.publicClient.getBalance({ address: relay.address });
        for (const c of cases) {
            const token = c.token === 'usdc' ? stack.usdc : stack.usdt0;
            const t = await signTransfer(stack, relay, { from: c.from, token, authMode: c.mode, to: RECIPIENT, amount: 1_000_000n });
            await submit(relay, t);
            await stack.setAutomine(true);
            await c.attack(t, anvilAccount(c.from));
            await stack.setAutomine(false);
            const passErrors = await passesUntilDecided({ stack, relay }, t);
            const state = await relay.state(t.id);
            console.log('front-run before broadcast', { case: c.label, status: state.status, code: state.error?.code, message: state.error?.message, passErrors });
            expect(state.status).toBe('failed');
            expect(state.error?.code).toBe(c.code);
            expect(relay.server.store.listAttempts(t.id)).toHaveLength(0);
        }
        expect(await stack.publicClient.getBalance({ address: relay.address })).toBe(relayEthBefore);
    });
});

// --- helpers ---------------------------------------------------------------------------------------------

/**
 * Passes until the queued request is decided, at most five, a block between them; returns each pass's error. One pass
 * decides on an idle machine. A pass that a slow read ends (RELAY_RPC_TIMEOUT_MS is 1 s in the fault env) leaves the
 * request queued for the next pass, as does a revert simulated on a block older than the acceptance (decided two
 * blocks later); neither broadcasts, which the callers assert (no attempt, the relay's balance unchanged).
 */
async function passesUntilDecided(e: Pick<FaultEnv, 'stack' | 'relay'>, t: SignedTransfer): Promise<Array<string | undefined>> {
    const errors: Array<string | undefined> = [];
    for (let pass = 0; pass < 5; pass++) {
        errors.push(await tick(e.relay));
        if ((await status(e.relay, t.id)) !== 'queued') break;
        await e.stack.mine();
    }
    return errors;
}

async function deploy(e: FaultEnv, from: PrivateKeyAccount, bytecode: Hex): Promise<Address> {
    const wallet = createWalletClient({ account: from, chain: foundry, transport: http(e.stack.rpcUrl) });
    const hash = await wallet.deployContract({ abi: [], bytecode });
    await e.stack.mine();
    const receipt = await e.stack.publicClient.getTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('no contract deployed');
    return receipt.contractAddress;
}

/** A self-sponsored EIP-7702 (type 4) transaction delegating `user` to `target`, with a high tip. */
async function delegate(e: FaultEnv, user: PrivateKeyAccount, target: Address): Promise<Hash> {
    const wallet = createWalletClient({ account: user, chain: foundry, transport: http(e.stack.rpcUrl) });
    const authorization = await wallet.signAuthorization({ account: user, contractAddress: target, executor: 'self' });
    return wallet.sendTransaction({ account: user, authorizationList: [authorization], to: anvilAccount(15).address, value: 0n, ...HIGH_TIP });
}

/** Consumes the user's USDT0 nonce with a meta-transaction of its own (self-relayed). */
async function consumeUsdt0Nonce(e: FaultEnv, user: PrivateKeyAccount): Promise<void> {
    const { stack } = e;
    const nonce = await stack.publicClient.readContract({ address: stack.usdt0, abi: [{ type: 'function', name: 'getNonce', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'getNonce', args: [user.address] });
    const functionSignature = encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [anvilAccount(14).address, 1n] });
    const signature = await user.signTypedData({
        domain: { name: 'USDT0', version: '1', verifyingContract: stack.usdt0, salt: `0x${foundry.id.toString(16).padStart(64, '0')}` },
        types: { MetaTransaction: [{ name: 'nonce', type: 'uint256' }, { name: 'from', type: 'address' }, { name: 'functionSignature', type: 'bytes' }] },
        primaryType: 'MetaTransaction',
        message: { nonce, from: user.address, functionSignature },
    });
    const r = `0x${signature.slice(2, 66)}` as Hex;
    const s = `0x${signature.slice(66, 130)}` as Hex;
    const v = Number.parseInt(signature.slice(130, 132), 16);
    await stack.send(user, {
        address: stack.usdt0,
        abi: [{ type: 'function', name: 'executeMetaTransaction', stateMutability: 'payable', inputs: [{ name: 'userAddress', type: 'address' }, { name: 'functionSignature', type: 'bytes' }, { name: 'sigR', type: 'bytes32' }, { name: 'sigS', type: 'bytes32' }, { name: 'sigV', type: 'uint8' }], outputs: [{ type: 'bytes' }] }],
        functionName: 'executeMetaTransaction',
        args: [user.address, functionSignature, r, s, v],
    });
}
