// Idempotency, conflicts, pending-debit reservations and sender_busy under concurrent submissions.
//
// The first suite posts a randomized storm of concurrent submissions (three signers, two tokens, all modes, duplicates
// and conflicting payloads) against a chain with per-call latency, then checks the database invariants the pipeline
// promises: what the relay holds pending for a sender never exceeds that sender's balance and allowance, and a
// (contract, signer, nonce) is stored once.
//
// The second suite covers the atomic re-check at the insert (docs/STEP-1-GAS-ABSTRACTION.md §6.3, step 9) around the
// mining of a pending request. A balance read before the mining still contains that request's funds, while the request
// itself has left the pending set: if its debit were counted in neither, the relay would accept more than the balance
// covers, broadcast both requests in one pass (the simulation before the broadcast evaluates each queued request
// against `latest` on its own) and pay for a call that reverts on-chain. With sequential intent nonces a sender has one
// pending request, so the second one is refused.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { CallOutcome } from '../../../src/chain/types.js';
import { buildTransfer, CONTRACT, createHarness, USDC, USDT0, type BuiltTransfer, type Harness } from '../../helpers/harness.js';
import { OTHER_KEY, USER3_KEY, USER_KEY } from '../../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
});

afterEach(async () => {
    await h.close();
});

const post = (payload: unknown) => h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object });

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('concurrency invariants (randomized)', () => {
    for (const seed of [1, 2, 3]) {
        it(`seed ${seed}: reservations, sender_busy and uniqueness hold under a concurrent storm`, async () => {
            const random = prng(seed);
            h.chain.latency = true;
            const keys: Hex[] = [USER_KEY, OTHER_KEY, USER3_KEY];
            const balances = new Map<string, bigint>();
            const allowances = new Map<string, bigint>();
            for (const key of keys) {
                const a = privateKeyToAccount(key).address;
                for (const token of [USDC, USDT0]) {
                    const balance = BigInt(Math.floor(random() * 6)) * 1_010_000n + 5_000n;
                    const allowance = BigInt(Math.floor(random() * 6)) * 1_010_000n;
                    h.chain.setBalance(token, a, balance);
                    h.chain.setAllowance(token, a, CONTRACT, allowance);
                    balances.set(`${token}:${a}`, balance);
                    allowances.set(`${token}:${a}`, allowance);
                }
            }
            const bodies: BuiltTransfer[] = [];
            for (let i = 0; i < 60; i++) {
                const key = keys[Math.floor(random() * keys.length)]!;
                const token = random() < 0.5 ? USDC : USDT0;
                const modes = token === USDC ? (['permit', 'none'] as const) : (['permit', 'metaTxApprove', 'none'] as const);
                const mode = modes[Math.floor(random() * modes.length)]!;
                // The sender's next nonce, or (one in five) the one after it, which is not valid yet.
                const nonce = h.chain.intentNonce(privateKeyToAccount(key).address) + (random() < 0.2 ? 1n : 0n);
                const t = await buildTransfer(h, { key, token, mode, nonce, amount: 1_000_000n + BigInt(i) });
                bodies.push(t);
                if (random() < 0.15) bodies.push(t); // identical re-post
                if (random() < 0.1) bodies.push(await buildTransfer(h, { key, token, mode, nonce, amount: 2_000_000n + BigInt(i) })); // conflict
            }
            const results = await Promise.all(bodies.map(async (b) => ({ b, res: await post(b.body) })));

            // Responses are consistent with the stored state.
            for (const { b, res } of results) {
                if (res.statusCode === 202 || res.statusCode === 200) {
                    expect(res.json()).toMatchObject({ id: b.id });
                    expect(h.store.getRequest(b.id)).toBeDefined();
                }
            }
            const accepted = new Set(results.filter((r) => r.res.statusCode === 202).map((r) => r.b.id));
            expect(accepted.size).toBe(h.store.countByStatus('queued'));

            const queued = h.store.listByStatus('queued');
            const byKey = new Map<string, typeof queued>();
            for (const r of queued) {
                const k = `${r.token}:${r.signer}`;
                byKey.set(k, [...(byKey.get(k) ?? []), r]);
            }
            for (const [k, rows] of byKey) {
                const debits = rows.reduce((s, r) => s + (r.debit ?? 0n), 0n);
                const noneDebits = rows.filter((r) => r.authMode === 'none').reduce((s, r) => s + (r.debit ?? 0n), 0n);
                expect(debits, `pending debits ${k}`).toBeLessThanOrEqual(balances.get(k)!);
                expect(noneDebits, `pending NONE debits ${k}`).toBeLessThanOrEqual(allowances.get(k)!);
                const tokenAuth = rows.filter((r) => r.authMode !== 'none');
                expect(tokenAuth.length, `pending permit/meta-tx ${k}`).toBeLessThanOrEqual(1);
                // No NONE request was accepted after (rowid order) a pending permit / meta-tx.
                const firstAuth = rows.findIndex((r) => r.authMode !== 'none');
                if (firstAuth >= 0) expect(rows.slice(firstAuth + 1).filter((r) => r.authMode === 'none'), k).toEqual([]);
            }
            // (contract, signer, nonce) is unique, a signer has one pending request, at its next nonce.
            const nonces = queued.map((r) => `${r.signer}:${r.nonce}`);
            expect(new Set(nonces).size).toBe(nonces.length);
            expect(new Set(queued.map((r) => r.signer)).size).toBe(queued.length);
            for (const r of queued) expect(BigInt(r.nonce)).toBe(h.chain.intentNonce(r.signer));
        });
    }
});

// A sender has one request pending, at its next intent nonce, so two requests of one sender are never validated against
// one balance read: while R1 is pending, R2 at R1's nonce conflicts and R2 at the next nonce is not valid yet
// (nonce_too_high); once R1 is mined, versions at the next nonce race, and the atomic insert keeps one.
describe('step-9 re-check vs. a request mined in between', () => {
    it('does not accept requests whose combined debit exceeds the balance around the mining of a pending request', async () => {
        const user: Address = privateKeyToAccount(USER_KEY).address;
        const debit = 1_010_000n; // 1.00 + fee 0.01
        h.chain.setBalance(USDC, user, 2n * debit); // exactly two transfers
        h.chain.setAllowance(USDC, user, CONTRACT, 10n ** 12n);
        // Realistic chain behaviour: eth_call and execution check the balance (the fake only checks nonce and deadline).
        const balanceOk = (data: Hex): boolean => {
            const { args } = decodeFunctionData({ abi: gaslessTransferAbi, data });
            const r = args[0] as { from: Address; amount: bigint; fee: bigint };
            return (h.chain.token(USDC).balances.get(r.from.toLowerCase()) ?? 0n) >= r.amount + r.fee;
        };
        const revert: CallOutcome = {
            ok: false,
            revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, debit] }),
            message: 'execution reverted',
        };
        const baseSimulate = h.chain.simulate;
        h.chain.simulate = (call) => (call.to.toLowerCase() === CONTRACT.toLowerCase() && !balanceOk(call.data) ? revert : baseSimulate(call));
        h.chain.executor = (tx) => (tx.to?.toLowerCase() === CONTRACT.toLowerCase() && !balanceOk(tx.data) ? 'reverted' : 'success');
        const code = (res: Awaited<ReturnType<typeof post>>): number | string => (res.statusCode === 202 ? 202 : (res.json() as { error: { code: string } }).error.code);

        // R1 is accepted and broadcast.
        const r1 = await buildTransfer(h, { mode: 'none' });
        expect((await post(r1.body)).statusCode).toBe(202);
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(r1.id)?.status).toBe('submitted');

        // While R1 is pending: another version at its nonce, and a request at the next nonce, concurrently.
        h.chain.latency = true;
        const atR1 = await buildTransfer(h, { mode: 'none', amount: 1_000_001n });
        const next = await buildTransfer(h, { mode: 'none', nonce: 1n });
        expect((await Promise.all([post(atR1.body), post(next.body)])).map(code)).toEqual(['conflict', 'nonce_too_high']);

        // R1 is mined and the transaction manager records it: one transfer's worth of balance is left. Two versions at
        // the next nonce race: one is accepted.
        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(r1.id)?.status).toBe('mined');
        expect(h.chain.token(USDC).balances.get(user.toLowerCase())).toBe(debit);
        const r2 = await buildTransfer(h, { mode: 'none', nonce: 1n });
        const r3 = await buildTransfer(h, { mode: 'none', nonce: 1n, amount: 999_999n });
        const codes = (await Promise.all([post(r2.body), post(r3.body)])).map(code);
        expect([...codes].sort()).toEqual([202, 'conflict'].sort());
        const pendingDebits = h.store.listByStatus('queued').reduce((s, r) => s + (r.debit ?? 0n), 0n);
        expect(pendingDebits, 'queued debits exceed the balance').toBeLessThanOrEqual(debit);

        // Nothing reverts on-chain at the relay's expense.
        await h.relay.txManager.tick();
        h.chain.mine();
        await h.relay.txManager.tick();
        const reverted = [...h.chain.receipts.values()].filter((r) => r.status === 'reverted');
        expect(reverted, 'relay-paid reverted transactions').toEqual([]);
    });
});
