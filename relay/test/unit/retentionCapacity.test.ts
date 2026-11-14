import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { admissionSettings, DEFAULT_ADMISSION, loadConfig } from '../../src/config.js';
import { fingerprintOf } from '../../src/pipeline/pipeline.js';
import { transferOperation } from '../../src/operations/transfer.js';
import type { NewRequest } from '../../src/store/types.js';
import { DEFAULT_TX_POLICY } from '../../src/tx/settings.js';
import { buildTransfer, CONTRACT, createHarness, NO_AUTH, restartHarness, USDC, USDT0 } from '../helpers/harness.js';

describe('retained request capacity', () => {
    it('bounds unpaid failure cycling, preserving stored replies and public reads', async () => {
        const h = await createHarness({ settings: { admission: { maxRetainedRequests: 3 } } });
        try {
            h.chain.estimateGas = async () => 250_275n; // Above the gas table's value for a permit: the call is never sent.
            await h.relay.txManager.recover();
            const bodies = [];
            for (let i = 0; i < 3; i++) {
                // Versions of one payment at the sender's nonce 0: each fails before the broadcast and settles at once.
                const built = await buildTransfer(h, { amount: BigInt(i + 1) * 1_000_000n });
                bodies.push(built);
                expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: built.body })).statusCode).toBe(202);
                await h.relay.txManager.tick();
                expect(h.store.getRequest(built.id)).toMatchObject({ status: 'failed', txNonce: null, signature: null });
                expect(h.store.countByStatus('queued')).toBe(0);
            }
            const next = await buildTransfer(h, { amount: 4_000_000n });
            const rejected = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: next.body });
            expect(rejected.statusCode).toBe(503);
            expect(rejected.json().error.code).toBe('unavailable');
            expect(h.store.getRequest(next.id)).toBeUndefined();
            expect(h.store.countRequests()).toBe(3);
            expect(h.chain.broadcasts).toHaveLength(0);
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: bodies[0]!.body })).statusCode).toBe(200);
            // The settled failures no longer hold their nonce: a correction is a new request, refused while retention is full.
            const correction = await buildTransfer(h, { nonce: BigInt(bodies[0]!.request.nonce), fee: 20_000n });
            const refused = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: correction.body });
            expect(refused.statusCode).toBe(503);
            expect(refused.json().error.code).toBe('unavailable');
            expect((await h.relay.app.inject(`/v1/requests/${bodies[0]!.id}`)).statusCode).toBe(200);
            expect((await h.relay.app.inject(`/v1/fee?operation=transfer&token=${USDC}&authMode=permit`)).statusCode).toBe(200);
            const invalid = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: { ...next.body, signature: '0x00' } });
            expect(invalid.json().error.code).toBe('invalid_signature');
            expect(await h.metrics.registry.metrics()).toContain('relay_admission_events_total{event="retention_full"} 2'); // `next` and the correction
        } finally { await h.close(); }
    });

    it('allows only one of two concurrent new requests into the final retained slot', async () => {
        const h = await createHarness({ settings: { admission: { maxRetainedRequests: 1 } } });
        try {
            const a = await buildTransfer(h, { token: USDC });
            const b = await buildTransfer(h, { token: USDT0, sender: 1 });
            const responses = await Promise.all([a, b].map(built => h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: built.body })));
            expect(responses.map(r => r.statusCode).sort()).toEqual([202, 503]);
            expect(h.store.countRequests()).toBe(1);
            const accepted = [a, b][responses.findIndex(r => r.statusCode === 202)]!;
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: accepted.body })).statusCode).toBe(200);
        } finally { await h.close(); }
    });

    it('normal retention frees capacity while unsettled rows are never removed', async () => {
        const h = await createHarness({ settings: { admission: { maxRetainedRequests: 2 } } });
        try {
            h.chain.estimateGas = async () => 250_275n;
            await h.relay.txManager.recover();
            const failed = await buildTransfer(h, { token: USDC });
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: failed.body })).statusCode).toBe(202);
            await h.relay.txManager.tick();
            const pending = await buildTransfer(h, { token: USDT0 });
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: pending.body })).statusCode).toBe(202);
            expect(h.store.pruneSettled(h.clock.nowMs() - DEFAULT_TX_POLICY.requestRetentionMs)).toBe(0);
            h.clock.advance(DEFAULT_TX_POLICY.requestRetentionMs / 1000 + 1);
            expect(h.store.pruneSettled(h.clock.nowMs() - DEFAULT_TX_POLICY.requestRetentionMs)).toBe(1);
            expect(h.store.getRequest(pending.id)?.status).toBe('queued');
            // The relay kept running meanwhile: a pass on a current head (without one for that long, it would refuse
            // every new request). The pending request ends at its deadline; its row stays.
            h.chain.mine({ timestampDelta: DEFAULT_TX_POLICY.requestRetentionMs / 1000 + 1 });
            await h.relay.txManager.tick();
            const next = await buildTransfer(h, { token: USDC, sender: 1 });
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: next.body })).statusCode).toBe(202);
            expect(h.store.countRequests()).toBe(2);
        } finally { await h.close(); }
    });

    it('at the limit, the history of a request that was never sent gives way once its deadline is an hour past', async () => {
        const h = await createHarness({ settings: { admission: { maxRetainedRequests: 2 } } });
        try {
            const post = (body: unknown) => h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: body as object });
            const elapse = async (seconds: number) => {
                h.clock.advance(seconds);
                h.chain.mine({ timestampDelta: seconds });
                await h.relay.txManager.tick();
            };
            h.chain.estimateGas = async () => 250_275n;
            await h.relay.txManager.recover();
            // Two versions of one payment, each failing before the broadcast: nothing was paid for either row.
            const unsent = [];
            for (let i = 0; i < 2; i++) {
                const built = await buildTransfer(h, { amount: BigInt(i + 1) * 1_000_000n });
                unsent.push(built);
                expect((await post(built.body)).statusCode).toBe(202);
                await elapse(10);
                expect(h.store.getRequest(built.id)).toMatchObject({ status: 'failed', txNonce: null });
            }
            // While a client may still ask for their outcome (up to an hour after the deadline), they hold their rows.
            await elapse(600 + 3600 - 20);
            expect((await post((await buildTransfer(h, { amount: 3_000_000n })).body)).statusCode).toBe(503);
            expect(h.store.countRequests()).toBe(2);

            await elapse(1);
            const next = await buildTransfer(h, { amount: 3_000_000n });
            expect((await post(next.body)).statusCode).toBe(202);
            // The older of the two gave way; the other one's deadline is not an hour past yet.
            expect(h.store.getRequest(unsent[0]!.id)).toBeUndefined();
            expect(h.store.getRequest(unsent[1]!.id)?.status).toBe('failed');
            expect(h.store.countRequests()).toBe(2);
            expect((await h.relay.app.inject(`/v1/requests/${unsent[0]!.id}`)).statusCode).toBe(404);
            // Its intent cannot come back as a new request: its deadline has passed.
            const again = await post(unsent[0]!.body);
            expect(again.statusCode).toBe(400);
            expect(again.json().error.code).toBe('deadline_out_of_range');
            expect(await h.metrics.registry.metrics()).toContain('relay_admission_events_total{event="unsent_history_dropped"} 1');
        } finally { await h.close(); }
    });

    it('at the limit, the history of a request that had a transaction never gives way', async () => {
        const h = await createHarness();
        try {
            const sent = await buildTransfer(h, { token: USDC });
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: sent.body })).statusCode).toBe(202);
            // Its call was included and reverted: a failed request with a transaction on record, settled.
            const hash = keccak256(sent.id);
            const block = h.chain.head.number;
            h.store.setNextNonce(0);
            h.store.recordFirstAttempt(sent.id, 0, { hash, raw: '0x02', kind: 'call', maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 200_000n, sentBlock: block }, h.clock.nowMs());
            const final = { status: 'failed', error: { code: 'fee_too_low', message: 'reverted' } } as const;
            h.store.resolveFailed(sent.id, final, { kind: 'receipt', mined: { hash, blockNumber: block, gasUsed: 1n, effectiveGasPrice: 1n }, attemptKind: 'call', callReverted: true }, h.clock.nowMs());
            h.store.settle(sent.id, h.clock.nowMs());
            expect(h.store.getRequest(sent.id)).toMatchObject({ status: 'failed', settledAtMs: h.clock.nowMs() });

            // Long after its deadline, a new request still finds no room.
            h.clock.advance(24 * 3600);
            const next = await buildTransfer(h, { token: USDT0, sender: 1 });
            const submission = transferOperation.schema.parse(next.body);
            const request: NewRequest = {
                id: next.id, operation: 'transfer', contract: CONTRACT, signer: next.request.from,
                nonce: next.request.nonce, fingerprint: fingerprintOf(next.id, submission), request: next.request,
                authHash: transferOperation.authHash(submission),
                signature: submission.signature, authorization: submission.authorization, fee: BigInt(next.request.fee),
                deadline: BigInt(next.request.deadline), priority: 0, createdAtMs: h.clock.nowMs(),
                reservation: { token: USDT0, spender: CONTRACT, debit: BigInt(next.request.amount) + BigInt(next.request.fee) },
            };
            expect(h.store.insertRequest(request, { maxRetainedRequests: 1 })).toEqual({ kind: 'retention_full' });
            expect(h.store.getRequest(sent.id)?.status).toBe('failed');
            expect(h.store.listAttempts(sent.id)).toHaveLength(1);
        } finally { await h.close(); }
    });

    it('reopens above a lowered limit without deleting history or breaking identical reposts', async () => {
        let h = await createHarness({ settings: { admission: { maxRetainedRequests: 3 } } });
        try {
            h.chain.estimateGas = async () => 300_001n;
            await h.relay.txManager.recover();
            const first = await buildTransfer(h);
            for (const built of [first, await buildTransfer(h, { token: USDT0 })]) {
                expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: built.body })).statusCode).toBe(202);
                await h.relay.txManager.tick();
            }
            h = await restartHarness(h, { settings: { admission: { maxRetainedRequests: 1 } } });
            expect(h.store.countRequests()).toBe(2);
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: first.body })).statusCode).toBe(200);
            const next = await buildTransfer(h, { amount: 2_000_000n });
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: next.body })).statusCode).toBe(503);
            expect(h.store.countRequests()).toBe(2);
        } finally { await h.close(); }
    });

    it('does not evict a held request when its retained row cannot make room', async () => {
        const h = await createHarness();
        try {
            const held = await buildTransfer(h, { token: USDC });
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: held.body })).statusCode).toBe(202);
            const next = await buildTransfer(h, { token: USDT0, sender: 1 });
            const submission = transferOperation.schema.parse(next.body);
            const request: NewRequest = {
                id: next.id, operation: 'transfer', contract: CONTRACT, signer: next.request.from,
                nonce: next.request.nonce, fingerprint: fingerprintOf(next.id, submission), request: next.request,
                authHash: transferOperation.authHash(submission),
                signature: submission.signature, authorization: submission.authorization, fee: BigInt(next.request.fee),
                deadline: BigInt(next.request.deadline), priority: 0, createdAtMs: h.clock.nowMs(),
                reservation: { token: USDT0, spender: CONTRACT, debit: BigInt(next.request.amount) + BigInt(next.request.fee) },
            };
            expect(h.store.insertRequest(request, { maxRetainedRequests: 1, observedBalance: 0n }).kind).toBe('insufficient_balance');
            expect(h.store.insertRequest({ ...request, authorization: NO_AUTH }, { maxRetainedRequests: 1, observedAllowance: 0n }).kind).toBe('insufficient_allowance');
            // The held request's sender has a pending request.
            expect(h.store.insertRequest({ ...request, signer: held.request.from, nonce: '1' }, { maxRetainedRequests: 1 }).kind).toBe('sender_busy');
            const outcome = h.store.insertRequest(request, { maxRetainedRequests: 1, maxQueued: 1, evict: { candidates: [{ id: held.id, capPerGas: 1n }], final: { status: 'failed', error: { code: 'fee_too_low', message: 'held' } } } });
            expect(outcome).toEqual({ kind: 'retention_full' });
            expect(h.store.getRequest(held.id)).toMatchObject({ status: 'queued', signature: held.body.signature });
            expect(h.store.getRequest(next.id)).toBeUndefined();
        } finally { await h.close(); }
    });

    it('applies a finite default and validates explicit environment bounds', () => {
        const env = { RELAY_RPC_URLS: 'http://anvil:8545', RELAY_DEPLOYMENT_FILE: '/test/deployment.json', RELAY_PRIVATE_KEY_FILE: '/test/key' };
        expect(DEFAULT_ADMISSION.maxRetainedRequests).toBe(100_000);
        expect(admissionSettings().maxRetainedRequests).toBe(100_000);
        expect(loadConfig(env).admission.maxRetainedRequests).toBe(100_000);
        expect(loadConfig({ ...env, RELAY_MAX_RETAINED_REQUESTS: '7' }).admission.maxRetainedRequests).toBe(7);
        for (const value of ['0', '-1', 'Infinity', '1.5', '10000001']) {
            expect(() => loadConfig({ ...env, RELAY_MAX_RETAINED_REQUESTS: value })).toThrow('RELAY_MAX_RETAINED_REQUESTS');
        }
    });
});
