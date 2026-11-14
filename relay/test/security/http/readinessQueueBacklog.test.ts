// A relay that works normally but is busy, or one request priced out by rising gas, must not take the whole relay
// out of rotation.
//
// /readyz includes the transaction manager's health() (src/http/readiness.ts). A load balancer that uses /readyz
// sends nothing to a relay that answers 503: no new transfers, no quotes, and no status queries for transfers it
// already accepted. So the relay may turn unready only when it really stopped moving, not in these two cases:
//
// 1. A backlog. The relay clears about 3 normal requests per Polygon block, so many valid requests at once take
//    several blocks. Admission bounds what a backlog costs and how large it gets: a sender has one request pending,
//    at its next intent nonce (another version at that nonce is a conflict, the next nonce is nonce_too_high), at
//    most RELAY_MAX_QUEUED requests are queued in total, and the fee must reach max(MIN_FEE, break-even).
// 2. One request in flight whose speed-ups reached its spend cap while no other request waits behind it.
//
// Readiness: the relay is ready iff the checks pass and health().ok. A backlog and requests held at their spend cap
// are reported in health().degraded, which sets the public `degraded` flag but keeps the relay ready. health()
// reports `stalled` only when work is pending and nothing was broadcast, sped up or included for
// RELAY_STUCK_AFTER_BLOCKS; requests held at their own cap are not pending work.
//
// The tests use RELAY_STUCK_AFTER_BLOCKS = 10 (its minimum), so a backlog of 60 requests is enough, and
// speed-ups every 2 blocks, so that the priced-out request reaches its spend cap long before it would count
// as stuck, as with the defaults (a speed-up every 10 blocks, stuck after 150). The backlog comes from one sender per
// request. Each sender submits from its own client address, which the relay ignores.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GWEI } from '../../helpers/fakeChain.js';
import { RelayError } from '../../../src/errors.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { buildTransfer, CONTRACT, createHarness, TEST_TX_SETTINGS, USDC, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';

const STUCK_AFTER_BLOCKS = 10;
/** Sixty funded senders (deterministic keys). */
const SENDERS: readonly Hex[] = Array.from({ length: 60 }, (_, i) => keccak256(stringToHex(`sender ${i}`)));

let h: Harness;

beforeEach(async () => {
    h = await createHarness({
        settings: {
            // As in production (the harness leaves the transaction manager out of /readyz by default).
            readinessIncludesTxManager: true,
            readinessCacheMs: 0,
            // A gas budget large enough for every request of the backlog.
                tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: 100n * 10n ** 18n, speedUpAfterBlocks: 2, stuckAfterBlocks: STUCK_AFTER_BLOCKS },
        },
    });
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n); // mode none
    for (const key of SENDERS) {
        const address = privateKeyToAccount(key).address;
        h.chain.setBalance(USDC, address, 100_000_000n);
        h.chain.setAllowance(USDC, address, CONTRACT, 10n ** 12n);
    }
    await h.relay.txManager.recover();
    await pass();
});

afterEach(async () => {
    await h.close();
});

/** One pass of the transaction manager; fails the test if the pass itself failed. */
async function pass(): Promise<void> {
    await h.relay.txManager.tick();
    expect(h.relay.txManager.lastTickError).toBeUndefined();
}

/** One block (2 s) and one pass of the transaction manager. */
async function block(options: { baseFee?: bigint } = {}): Promise<void> {
    h.chain.mine(options);
    h.clock.advance(2);
    await pass();
}

const readyz = async (): Promise<number> => (await h.relay.app.inject({ method: 'GET', url: '/readyz' })).statusCode;
const publicReadyz = async (): Promise<unknown> => (await h.relay.app.inject({ method: 'GET', url: '/readyz' })).json();

async function reasons(): Promise<string[]> {
    const report = (await h.relay.opsApp.inject({ method: 'GET', url: '/readyz' })).json() as { checks: { txManager: { reasons: string[] } } };
    return report.checks.txManager.reasons;
}

async function submit(options: { fee?: bigint; key?: Hex } = {}, remoteAddress = '127.0.0.1'): Promise<Hex> {
    const t = await buildTransfer(h, { mode: 'none', ...options });
    const response = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body, remoteAddress });
    expect(response.statusCode, response.body).toBe(202);
    return t.id;
}

const status = (id: Hex) => h.store.getRequest(id)!.status;
const minedCount = (ids: readonly Hex[]) => ids.filter((id) => ['mined', 'confirmed'].includes(status(id))).length;

/**
 * Submits `n` requests at once, spread over the senders, then runs one pass per block until all are mined;
 * /readyz after each block.
 */
async function drain(n: number): Promise<{ readyz: number[]; minedPerBlock: number[]; firstReason?: string }> {
    const ids: Hex[] = [];
    for (let i = 0; i < n; i++) {
        const sender = i % SENDERS.length;
        ids.push(await submit({ key: SENDERS[sender]! }, `198.51.100.${sender + 1}`)); // each wallet on its own address
        expect(sender, 'one request per sender').toBe(i);
    }
    const result: { readyz: number[]; minedPerBlock: number[]; firstReason?: string } = { readyz: [], minedPerBlock: [] };
    await pass(); // the first 3 are broadcast
    let mined = 0;
    for (let b = 0; b < 40 && mined < n; b++) {
        await block();
        const now = minedCount(ids);
        result.minedPerBlock.push(now - mined);
        mined = now;
        const code = await readyz();
        result.readyz.push(code);
        if (code !== 200 && result.firstReason === undefined) result.firstReason = (await reasons())[0];
    }
    expect(mined, 'every request of the backlog is mined').toBe(n);
    return result;
}

const summary = (codes: readonly number[]) => codes.map((c, i) => `${i + 1}:${c}`).join(' ');

describe('control: a backlog the relay clears within RELAY_STUCK_AFTER_BLOCKS', () => {
    it('24 requests of 24 senders: 3 mined per block, /readyz 200 throughout', async () => {
        const r = await drain(24);
        expect(r.minedPerBlock.every((m) => m === 3)).toBe(true);
        expect(r.readyz.every((c) => c === 200), summary(r.readyz)).toBe(true);
    });
});

describe('admission bounds the backlog one sender can build', () => {
    it('a second pending request of one sender is refused (409: nonce_too_high at its next nonce, conflict at the pending one) and is not stored', async () => {
        await submit();
        const answers: string[] = [];
        for (const t of [await buildTransfer(h, { mode: 'none', nonce: 1n }), await buildTransfer(h, { mode: 'none', amount: 999_999n })]) {
            const response = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body });
            expect(response.statusCode).toBe(409);
            answers.push((response.json() as { error: { code: string } }).error.code);
            expect(h.store.getRequest(t.id)).toBeUndefined();
        }
        expect(answers).toEqual(['nonce_too_high', 'conflict']);
        // The same through the pipeline directly (no HTTP layer).
        const third = await buildTransfer(h, { mode: 'none', nonce: 2n });
        await expect(h.relay.pipeline.submit(transferOperation, third.body)).rejects.toBeInstanceOf(RelayError);
        // Another sender is not affected.
        await submit({ key: SENDERS[0]! });
    });

    it('a fee below MIN_FEE is refused although it covers break-even, so a backlog costs at least 0.01 per request', async () => {
        const t = await buildTransfer(h, { mode: 'none', fee: 9_999n });
        const response = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body });
        expect(response.statusCode).toBe(402);
        expect((response.json() as { error: { code: string } }).error.code).toBe('fee_too_low');
        expect(h.store.getRequest(t.id)).toBeUndefined();
    });
});

describe('readiness while the relay works', () => {
    it('60 valid requests (a backlog of 20 blocks): /readyz stays 200 while the relay mines 3 in every block', async () => {
        const r = await drain(60);
        console.log(`backlog: /readyz per block ${summary(r.readyz)}; first reason: ${r.firstReason ?? 'none'}`);
        // The transaction manager is not stuck: it mines 3 requests in every block until the backlog is gone.
        expect(r.minedPerBlock.every((m) => m === 3)).toBe(true);
        expect(r.readyz.every((c) => c === 200), `/readyz per block: ${summary(r.readyz)}`).toBe(true);
    });

    it('one request priced out at its spend cap, with nothing waiting behind it, does not make the relay unready', async () => {
        const id = await submit(); // fee 0.01 USDC; broadcast at 2 x 30 + 30 gwei
        await pass();
        expect(status(id)).toBe('submitted');
        const codes: number[] = [];
        // Gas rises to 2000 gwei, far above what 0.01 USDC covers (spend cap 200 % of the fee, at 0.2 USD/POL).
        for (let b = 0; b < 30; b++) {
            await block({ baseFee: 2000n * GWEI });
            codes.push(await readyz());
        }
        console.log(
            `priced out: status ${status(id)}; /readyz per block ${summary(codes)}; reasons: ${(await reasons()).join('; ') || 'none'}`,
        );
        // Whether the relay keeps holding the request or cancels it, it can serve other requests all along.
        expect(codes.every((c) => c === 200), `/readyz per block: ${summary(codes)}`).toBe(true);
        // A request that stays held at its cap is reported as degraded, publicly as a flag only.
        if (status(id) === 'submitted') expect(await publicReadyz()).toEqual({ ready: true, degraded: true });
    });
});

describe('a priced-out request keeps the relay ready, and a second request unblocks it', () => {
    // A request held at its spend cap is reported as degraded (held_at_cap) and keeps the relay ready. It is cancelled
    // only once another request waits behind it.
    it('with one priced-out request in flight, /readyz stays 200 (degraded: held_at_cap); a second request makes the relay cancel it (fee_too_low) and is mined', async () => {
        const id = await submit();
        await pass();
        for (let b = 0; b < 30; b++) await block({ baseFee: 2000n * GWEI });
        expect(status(id)).toBe('submitted'); // held at its spend cap; nothing waits behind it, so it is not cancelled
        expect(await h.metrics.registry.metrics()).toMatch(/relay_spend_cap_holds_total\{kind="speedup"\} [1-9]/);
        expect(await readyz()).toBe(200);
        expect(await reasons()).toEqual([]);
        expect(h.relay.txManager.health().degraded).toEqual([expect.stringMatching(/^held_at_cap: 1 request/)]);

        // The second request (another sender) pays the new price.
        const second = await submit({ fee: 1_000_000n, key: SENDERS[0]! });
        for (let b = 0; b < 40 && (status(second) !== 'mined' || (await readyz()) !== 200); b++) await block();
        expect(status(id)).toBe('failed');
        expect(h.store.getRequest(id)!.error?.code).toBe('fee_too_low');
        expect(status(second)).toBe('mined');
        expect(await readyz()).toBe(200);
    });
});
