// During a gas spike, a full queue of requests held at their spend cap must not shut out a request that pays the
// current price. This file runs the scenario through the HTTP API with the admission defaults.
//
// At most RELAY_MAX_QUEUED (100) requests may be queued; beyond that a submission gets 503 `unavailable`, before any
// RPC read and again at the insert. The count is `status = 'queued'` (src/store/sqliteStore.ts admissionCounts),
// whatever the transaction manager does with those requests.
//
// A queued request whose spend cap (RELAY_MAX_COST_PERCENT_OF_FEE, 200 % of its fee) is below the cheapest includable
// fee is held (src/tx/txManager.ts broadcastQueued, holdQueued): it stays queued, is not broadcast, is not cancelled,
// is not simulated again, and leaves the queue only when gas falls below its cap or its deadline comes within
// RELAY_MIN_SECONDS_TO_BROADCAST, up to 2 hours after acceptance. A request accepted at break-even is held as soon as
// the base fee roughly doubles; one accepted at MIN_FEE (0.01) once the base fee passes about 480 gwei in this test,
// at 0.2 USD/POL. Polygon's base fee rises by up to 12.5 % per full block, so a doubling takes 6 full blocks.
//
// If held requests simply kept their places, every wallet would be hurt: while 100 of them fill the queue, the relay
// would answer 503 to every new transfer, including transfers whose fee covers the current gas price and that it could
// broadcast at once, for up to 2 hours. Quotes still work and /readyz stays 200 (degraded: held_at_cap), so a load
// balancer would keep sending wallets to a relay that refuses them all. One party with 100 funded addresses could
// arrange that for a few cents; ordinary traffic that piles up during a spike does the same.
//
// So when the queue is full and a new request passes admission (its fee covers the current break-even, so it can be
// sent now), it takes the place of a queued request held at its spend cap: the one with the lowest cap, and among equal
// caps the oldest. That request ends `failed` with `fee_too_low`; nothing of it was broadcast, so the outcome is final
// at once. The eviction and the insert are one store transaction (src/store/sqliteStore.ts insertRequest). Without a
// held request, a full queue answers 503 (the control test: no gas rise, the queue drains and every request pays its
// fee).
//
// The scenario: 100 requests of 100 senders accepted at break-even at a base fee of 300 gwei, then the base fee is 700
// gwei (a 2.3x rise) and the party moves its USDC away. A wallet then asks for a quote and submits a transfer with that
// fee (it covers 700 gwei with room to spare), every 10 minutes for up to 2 hours; it must be admitted at the first
// attempt. The client addresses of the submissions only tell the test's parties apart: the relay does not use them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { FeeResponse } from '@nimiq/gasless-sdk/relay';
import { maxBig } from '../../../src/util/bigint.js';
import { GWEI } from '../../helpers/fakeChain.js';
import { buildTransfer, CONTRACT, createHarness, TEST_TX_SETTINGS, USDC, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';

/** 100 senders x 1 pending request each = RELAY_MAX_QUEUED (a sender has one pending request at a time). */
const SENDERS: readonly Hex[] = Array.from({ length: 100 }, (_, i) => keccak256(stringToHex(`sender ${i}`)));
const QUEUE = 100;
/** The client address of the party's i-th sender. */
const partyClient = (sender: number): string => `198.51.100.${sender + 1}`;
/** The wallet's client address. */
const WALLET_CLIENT = '203.0.113.9';

let h: Harness;

beforeEach(async () => {
    // The admission defaults of production. The gas budget is raised to 100 POL so that it does not stop the 100
    // requests of this scenario (that a smaller budget stops the queue has its own tests).
    h = await createHarness({ settings: { readinessIncludesTxManager: true, readinessCacheMs: 0, tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: 100n * 10n ** 18n } } });
    for (const key of SENDERS) {
        const address = privateKeyToAccount(key).address;
        h.chain.setBalance(USDC, address, 1_000_000n); // 1 USDC each
        h.chain.setAllowance(USDC, address, CONTRACT, 10n ** 12n); // mode none
    }
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    await h.relay.txManager.recover();
    await pass();
});

afterEach(async () => {
    await h.close();
});

async function pass(): Promise<void> {
    await h.relay.txManager.tick();
    expect(h.relay.txManager.lastTickError).toBeUndefined();
}

/** One block of `seconds` (chain and wall clock), then one pass of the transaction manager. */
async function block(options: { baseFee?: bigint; seconds?: number } = {}): Promise<void> {
    const seconds = options.seconds ?? 2;
    h.chain.mine({ timestampDelta: seconds, ...(options.baseFee !== undefined ? { baseFee: options.baseFee } : {}) });
    h.clock.advance(seconds);
    await pass();
}

/** The party's 100 requests: amount 1 unit, fee = max(MIN_FEE, break-even now), the longest deadline. */
async function fillQueue(): Promise<{ ids: Hex[]; fee: bigint }> {
    const fees = h.relay.fees;
    const fee = maxBig(fees.minFee, fees.breakEven('transfer', 'none', await fees.context()));
    const deadline = BigInt(h.clock.seconds() + 7200);
    const ids: Hex[] = [];
    for (let i = 0; i < QUEUE; i++) {
        const sender = i % SENDERS.length;
        const t = await buildTransfer(h, { mode: 'none', key: SENDERS[sender]!, amount: 1n, fee, deadline });
        const response = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body, remoteAddress: partyClient(sender) });
        expect(response.statusCode, response.body).toBe(202);
        ids.push(t.id);
    }
    return { ids, fee };
}

/** A wallet: quote (mode none), then a transfer with exactly that fee. Returns the status code and error code. */
async function walletTransfer(): Promise<{ status: number; code?: string; quote: bigint; id: Hex }> {
    const quote = await h.relay.app.inject({ method: 'GET', url: `/v1/fee?operation=transfer&token=${USDC}&authMode=none` });
    expect(quote.statusCode, quote.body).toBe(200);
    const fee = BigInt((quote.json() as FeeResponse).fee);
    const t = await buildTransfer(h, { mode: 'none', fee });
    const response = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body, remoteAddress: WALLET_CLIENT });
    const code = response.statusCode >= 400 ? (response.json() as { error: { code: string } }).error.code : undefined;
    return { status: response.statusCode, quote: fee, id: t.id, ...(code !== undefined ? { code } : {}) };
}

const statuses = (ids: readonly Hex[]) => {
    const count: Record<string, number> = {};
    for (const id of ids) {
        const s = h.store.getRequest(id)!.status;
        count[s] = (count[s] ?? 0) + 1;
    }
    return count;
};

describe('control: the same queue without a gas rise', () => {
    it('the relay sends the 100 requests (3 per block), every one pays its fee, and the wallet gets in once there is room', async () => {
        await block({ baseFee: 300n * GWEI });
        const { ids } = await fillQueue();
        // Full right now, and nothing is held: 503, and no queued request gave way.
        expect((await walletTransfer()).code).toBe('unavailable');
        expect(h.store.countByStatus('queued')).toBe(QUEUE);
        for (let b = 0; b < 40; b++) await block();
        expect(statuses(ids)).toEqual({ mined: QUEUE });
        expect((await walletTransfer()).status).toBe(202);
    });
});

describe('held requests and RELAY_MAX_QUEUED', () => {
    it('a wallet paying the current price is admitted at once while the queue holds only requests the relay cannot send; the held request with the lowest cap (the oldest) gives way with fee_too_low', async () => {
        await block({ baseFee: 300n * GWEI });
        const { ids, fee } = await fillQueue();
        // The base fee reaches 700 gwei before the relay has sent them (a 2.3x rise): all 100 are held at their cap.
        await block({ baseFee: 700n * GWEI });
        const held = h.relay.txManager.health().degraded;
        const readyz = (await h.relay.app.inject({ method: 'GET', url: '/readyz' })).json() as unknown;
        // The party takes its USDC back: held requests are not simulated again, so nothing notices.
        for (const key of SENDERS) h.chain.setBalance(USDC, privateKeyToAccount(key).address, 0n);

        // A wallet every 10 minutes for 2 hours (chain and wall clock advance together, one block per minute).
        const attempts: Array<{ minute: number; status: number; code?: string; quote: string; id: Hex }> = [];
        for (let minute = 0; minute <= 120; minute += 10) {
            const r = await walletTransfer();
            attempts.push({ minute, status: r.status, ...(r.code !== undefined ? { code: r.code } : {}), quote: r.quote.toString(), id: r.id });
            if (r.status === 202) break;
            for (let m = 0; m < 10; m++) await block({ seconds: 60 });
        }
        const summary = {
            partyFee: fee.toString(),
            held,
            readyz,
            attempts: attempts.map((a) => `${a.minute}min:${a.status}${a.code ? `/${a.code}` : ''}`).join(' '),
            partyRequests: statuses(ids),
            relayTransactions: h.chain.broadcasts.length,
        };
        console.log('held queue full:', JSON.stringify(summary, null, 1));
        const firstAdmitted = attempts.findIndex((a) => a.status === 202);
        expect(
            firstAdmitted,
            `a wallet paying ${attempts[0]!.quote} (the quote at 700 gwei) was refused ${attempts.length} times over ${attempts.at(-1)!.minute} minutes: ${summary.attempts}`,
        ).toBe(0);

        // The request that gave way: the oldest of the equal caps, failed with fee_too_low, final at once, never sent.
        const gaveWay = h.store.getRequest(ids[0]!)!;
        expect(gaveWay).toMatchObject({ status: 'failed', error: { code: 'fee_too_low' } });
        expect(gaveWay.settledAtMs).not.toBeNull();
        expect(h.store.listAttempts(ids[0]!)).toEqual([]);
        expect(statuses(ids)).toEqual({ queued: QUEUE - 1, failed: 1 });
        expect(h.store.countByStatus('queued')).toBe(QUEUE);
        expect(await h.metrics.registry.metrics()).toMatch(/relay_admission_events_total\{event="evicted"\} 1\b/);

        // The wallet's request is sent in the next pass; the held requests are not.
        await block({ seconds: 2 });
        expect(h.store.getRequest(attempts[0]!.id)!.status).toBe('submitted');
        expect(h.chain.broadcasts).toHaveLength(1);
    });
});
