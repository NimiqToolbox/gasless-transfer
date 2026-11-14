// Concurrent submissions over HTTP against the real relay while the transaction manager runs: 20 PERMIT requests of
// one sender (one pending request per sender; at its next nonce conflict, above it nonce_too_high),
// NONE requests of one sender in sequence against one allowance or one balance, 18 senders at once (contiguous relay
// nonces, one call each), and identical and conflicting re-posts racing the broadcast pass.
import { afterEach, describe, expect, it } from 'vitest';
import { maxUint256 } from 'viem';
import {
    RECIPIENT,
    anvilAccount,
    callsPerRequest,
    intentNonce,
    keyOf,
    mockTokenAbi,
    postRaw,
    relayNonces,
    relayTxsOnChain,
    signTransfer,
    startFaultEnv,
    tick,
    type FaultEnv,
    type SignedTransfer,
} from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

// Up to 18 requests in flight at once (18 senders).
const ENV = { RELAY_MAX_IN_FLIGHT: '32', RELAY_RESERVED_PRIORITY_SLOTS: '1' };

function codeOf(r: { status: number; json: unknown }): string {
    if (r.status === 202) return 'accepted';
    if (r.status === 200) return 'duplicate';
    return (r.json as { error?: { code?: string } }).error?.code ?? `http_${r.status}`;
}

function tally(codes: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of codes) out[c] = (out[c] ?? 0) + 1;
    return out;
}

async function settle(e: FaultEnv): Promise<void> {
    await tick(e.relay);
    await e.stack.mine();
    await tick(e.relay);
}

async function expectOneCallEach(e: FaultEnv, fromBlock: bigint, accepted: readonly SignedTransfer[]): Promise<void> {
    const txs = await relayTxsOnChain(e.stack, e.relay.address, fromBlock);
    const perRequest = callsPerRequest(txs);
    expect(txs).toHaveLength(accepted.length);
    for (const t of accepted) {
        expect(perRequest.get(keyOf(t))).toEqual(['success']);
        expect((await e.relay.state(t.id)).status).toBe('mined');
    }
    const nonces = await relayNonces(e.stack, e.relay.address);
    const first = txs[0]?.nonce ?? nonces.latest;
    expect(txs.map((t) => t.nonce)).toEqual(Array.from({ length: txs.length }, (_, i) => first + i));
    expect(nonces.pending).toBe(nonces.latest);
}

describe('20 concurrent submits', () => {
    it('20 PERMIT requests of one sender: at its next nonce (10 amounts) one accepted and 9 conflict, above it (10 nonces) nonce_too_high; one call', async () => {
        env = await startFaultEnv({ env: ENV });
        const { stack, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const next = await intentNonce(stack, anvilAccount(1).address);
        const ts = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                signTransfer(stack, relay, {
                    from: 1,
                    token: stack.usdc,
                    authMode: 'permit',
                    to: RECIPIENT,
                    ...(i < 10 ? { amount: 1_000_000n + BigInt(i), nonce: next } : { amount: 1_000_000n, nonce: next + BigInt(i - 9) }),
                }),
            ),
        );
        const results = await Promise.all(ts.map((t) => postRaw(relay, t.body)));
        const codes = results.map(codeOf);
        console.log('20 PERMIT, one sender', tally(codes));
        expect(tally(codes.slice(0, 10))).toEqual({ accepted: 1, conflict: 9 });
        expect(tally(codes.slice(10))).toEqual({ nonce_too_high: 10 });
        await settle(env);
        await expectOneCallEach(env, block0 + 1n, ts.filter((_, i) => codes[i] === 'accepted'));
    });

    it('NONE requests of one sender in sequence against an allowance that covers 5: 5 mined (each after the previous), the sixth insufficient_allowance', async () => {
        env = await startFaultEnv({ env: ENV });
        const { stack, relay } = env;
        const first = await signTransfer(stack, relay, { from: 2, token: stack.usdt0, authMode: 'none', to: RECIPIENT, amount: 1_000_000n });
        const each = 1_000_000n + BigInt(first.body.request.fee);
        await stack.send(anvilAccount(2), { address: stack.usdt0, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, each * 5n] });
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const accepted: SignedTransfer[] = [];
        const codes: string[] = [];
        for (let i = 0; i < 6; i++) {
            const t = await signTransfer(stack, relay, { from: 2, token: stack.usdt0, authMode: 'none', to: RECIPIENT, amount: 1_000_000n, fee: BigInt(first.body.request.fee) });
            const code = codeOf(await postRaw(relay, t.body));
            codes.push(code);
            if (code === 'accepted') accepted.push(t);
            await settle(env);
        }
        console.log('NONE in sequence, allowance for 5', codes);
        expect(codes).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'accepted', 'insufficient_allowance']);
        await expectOneCallEach(env, block0 + 1n, accepted);
        expect(await stack.allowance(stack.usdt0, anvilAccount(2).address, stack.transfer)).toBe(0n);
    });

    it('NONE requests of one sender in sequence whose balance covers 3 (unlimited allowance): 3 mined, the fourth insufficient_balance', async () => {
        env = await startFaultEnv({ env: ENV });
        const { stack, relay } = env;
        const user = anvilAccount(3);
        const first = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'none', to: RECIPIENT, amount: 1_000_000n });
        const fee = BigInt(first.body.request.fee);
        const each = 1_000_000n + fee;
        await stack.send(user, { address: stack.usdc, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, maxUint256] });
        const balance = await stack.balanceOf(stack.usdc, user.address);
        await stack.send(user, { address: stack.usdc, abi: mockTokenAbi, functionName: 'transfer', args: [anvilAccount(12).address, balance - each * 3n] });
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const accepted: SignedTransfer[] = [];
        const codes: string[] = [];
        for (let i = 0; i < 4; i++) {
            const t = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'none', to: RECIPIENT, amount: 1_000_000n, fee });
            const code = codeOf(await postRaw(relay, t.body));
            codes.push(code);
            if (code === 'accepted') accepted.push(t);
            await settle(env);
        }
        console.log('NONE in sequence, balance for 3', codes);
        expect(codes).toEqual(['accepted', 'accepted', 'accepted', 'insufficient_balance']);
        await expectOneCallEach(env, block0 + 1n, accepted);
        expect(await stack.balanceOf(stack.usdc, user.address)).toBe(0n);
    });

    it('18 senders at once (9 with USDC permit, 9 with USDT0 meta-tx): all accepted, contiguous relay nonces, one call each, all mined', async () => {
        env = await startFaultEnv({ env: ENV });
        const { stack, relay } = env;
        // Senders: anvil accounts 1-9 (funded by DeployLocalStack) and 0, 12-19 (USDT0 from the admin, account 0).
        const usdt0Senders = [0, 12, 13, 14, 15, 16, 17, 18, 19];
        for (const index of usdt0Senders.slice(1)) {
            await stack.send(anvilAccount(0), { address: stack.usdt0, abi: mockTokenAbi, functionName: 'transfer', args: [anvilAccount(index).address, 10_000_000n] });
        }
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const ts = await Promise.all(
            Array.from({ length: 18 }, (_, i) =>
                signTransfer(stack, relay, {
                    from: i < 9 ? 1 + i : usdt0Senders[i - 9]!,
                    token: i < 9 ? stack.usdc : stack.usdt0,
                    authMode: i < 9 ? 'permit' : 'metaTxApprove',
                    to: RECIPIENT,
                    amount: 1_000_000n + BigInt(i),
                }),
            ),
        );
        const results = await Promise.all(ts.map((t) => postRaw(relay, t.body)));
        const codes = results.map(codeOf);
        console.log('18 senders', tally(codes));
        expect(tally(codes)).toEqual({ accepted: 18 });
        await settle(env);
        await expectOneCallEach(env, block0 + 1n, ts);
    });

    it('identical and conflicting re-posts racing the broadcast pass: every accepted request is sent once', async () => {
        env = await startFaultEnv({ env: ENV });
        const { stack, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const accepted: SignedTransfer[] = [];
        const allCodes: string[] = [];
        for (let round = 0; round < 4; round++) {
            const froms = [1, 2, 3, 4].map((f) => f + round);
            const token = round % 2 === 0 ? stack.usdc : stack.usdt0;
            const originals = await Promise.all(froms.map((from) => signTransfer(stack, relay, { from, token, authMode: 'permit', to: RECIPIENT, amount: 2_000_000n })));
            // Same (from, nonce), another amount: a different request id for the same nonce (built with the core:
            // prepareTransfer refuses a nonce without corrects).
            const conflicting = await Promise.all(
                originals.map((o, i) =>
                    signTransfer(stack, relay, { from: froms[i]!, token, authMode: 'permit', to: RECIPIENT, amount: 2_000_001n, nonce: o.body.request.nonce }),
                ),
            );
            const posts = [...originals.flatMap((o) => Array.from({ length: 4 }, () => o)), ...conflicting].sort(() => Math.random() - 0.5);
            const [, ...results] = await Promise.all([tick(relay), ...posts.map((t) => postRaw(relay, t.body))]);
            const codes = results.map(codeOf);
            allCodes.push(...codes);
            for (const t of [...originals, ...conflicting]) {
                const stored = relay.server.store.getRequest(t.id);
                if (stored && !accepted.some((a) => a.id === t.id)) accepted.push(t);
            }
            // Mined in the relay's view before the next round: a sender of this round may send again in the next one
            // (one pending request per sender).
            await settle(env);
        }
        console.log('re-posts racing the pass', { codes: tally(allCodes), accepted: accepted.length });
        expect(accepted).toHaveLength(16); // one per (from, nonce)
        await expectOneCallEach(env, block0 + 1n, accepted);
    });
});
