// The pure rules of the transaction manager (src/tx/policy.ts) and its policy settings (src/tx/settings.ts).
// relay/docs/transaction-lifecycle.md describes them.
import { describe, expect, it } from 'vitest';
import type { PriceReading } from '../../src/fees/priceSource.js';
import { analyzeNonces, callGasLimit, combineNonces, effectiveFinalized, fairOrder, fallbackFinalized, feeInWei, spendCapPerGas } from '../../src/tx/policy.js';
import { DEFAULT_TX_POLICY, POLYGON_MIN_FINALITY_DEPTH, finalityDepthFloor, parseTxPolicyEnv, txPolicy } from '../../src/tx/settings.js';

// `chainlink` is the only kind of price source the relay has.
const price = (value: bigint, decimals: number): PriceReading => ({ value, decimals, source: 'chainlink', updatedAt: null, reason: null });
const DAY_MS = 24 * 3600 * 1000;

describe('effectiveFinalized', () => {
    it('is the finalized tag, but never less than RELAY_MIN_FINALITY_DEPTH blocks below head', () => {
        expect(effectiveFinalized(1000n, 900n, 16)).toBe(900n);
        expect(effectiveFinalized(1000n, 1000n, 16)).toBe(984n); // a node that answers "finalized" with its head
        expect(effectiveFinalized(1000n, 990n, 0)).toBe(990n);
        expect(effectiveFinalized(10n, 10n, 16)).toBe(-1n); // nothing final yet
    });
});

describe('fallbackFinalized and the finality floor', () => {
    it('without the finalized tag: head − max(RELAY_FINALITY_FALLBACK_DEPTH, RELAY_MIN_FINALITY_DEPTH)', () => {
        expect(fallbackFinalized(1000n, 256, 16)).toBe(744n);
        expect(fallbackFinalized(1000n, 1, 16)).toBe(984n); // a shallow fallback depth does not undercut the minimum depth
        expect(fallbackFinalized(1000n, 1, 0)).toBe(999n);
        expect(fallbackFinalized(10n, 256, 16)).toBe(-1n); // nothing final yet
    });

    it('is 16 blocks on Polygon PoS (137) and Amoy (80002), none on other chains', () => {
        expect(POLYGON_MIN_FINALITY_DEPTH).toBe(16);
        expect(finalityDepthFloor(137)).toBe(16);
        expect(finalityDepthFloor(80002)).toBe(16);
        expect(finalityDepthFloor(31337)).toBe(0);
    });
});

describe('fairOrder', () => {
    const r = (signer: string, n: number, priority = 0) => ({ signer, priority, id: `${signer}${n}` });
    const ids = (list: ReadonlyArray<{ id: string }>) => list.map((x) => x.id);

    it('serves one request of every sender per round, senders in the order of their oldest request', () => {
        const queued = [r('a', 1), r('a', 2), r('a', 3), r('b', 1), r('a', 4), r('c', 1), r('b', 2)];
        expect(ids(fairOrder(queued))).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'a4']);
    });

    it('keeps priority first: a higher priority is served before any lower one, round-robin within it', () => {
        const queued = [r('x', 1, 1), r('y', 1, 1), r('x', 2, 1), r('a', 1), r('b', 1), r('a', 2)];
        expect(ids(fairOrder(queued))).toEqual(['x1', 'y1', 'x2', 'a1', 'b1', 'a2']);
    });

    it('within a round, senders with fewer requests in flight come first; addresses compare case-insensitively', () => {
        const queued = [r('0xAA', 1), r('0xbb', 1), r('0xaa', 2), r('0xcc', 1)];
        const inFlight = new Map([
            ['0xaa', 2],
            ['0xbb', 1],
        ]);
        expect(ids(fairOrder(queued, inFlight))).toEqual(['0xcc1', '0xbb1', '0xAA1', '0xaa2']);
    });

    it('is the input order when every request has its own sender, and empty for an empty queue', () => {
        const queued = [r('a', 1), r('b', 1), r('c', 1)];
        expect(ids(fairOrder(queued))).toEqual(['a1', 'b1', 'c1']);
        expect(fairOrder([])).toEqual([]);
    });
});

describe('callGasLimit', () => {
    const table = 250_000n;
    it('is the estimate plus the margin, capped by the gas table and RELAY_MAX_GAS_LIMIT', () => {
        expect(callGasLimit({ estimate: 150_000n, table, maxGasLimit: 1_000_000n, marginPercent: 30 })).toEqual({ ok: true, gas: 195_000n });
        expect(callGasLimit({ estimate: 200_000n, table, maxGasLimit: 1_000_000n, marginPercent: 30 })).toEqual({ ok: true, gas: table });
        expect(callGasLimit({ estimate: 200_000n, table, maxGasLimit: 210_000n, marginPercent: 30 })).toEqual({ ok: true, gas: 210_000n });
        expect(callGasLimit({ estimate: 100_001n, table, maxGasLimit: 1_000_000n, marginPercent: 30 })).toEqual({ ok: true, gas: 130_002n }); // rounded up
    });

    it('without an estimate it is the cap itself; an estimate above the cap is refused', () => {
        expect(callGasLimit({ estimate: undefined, table, maxGasLimit: 1_000_000n, marginPercent: 30 })).toEqual({ ok: true, gas: table });
        expect(callGasLimit({ estimate: undefined, table: undefined, maxGasLimit: 400_000n, marginPercent: 30 })).toEqual({ ok: true, gas: 400_000n });
        expect(callGasLimit({ estimate: 250_001n, table, maxGasLimit: 1_000_000n, marginPercent: 30 })).toEqual({ ok: false, needed: 250_001n, cap: table });
        expect(callGasLimit({ estimate: 250_000n, table, maxGasLimit: 1_000_000n, marginPercent: 30 })).toEqual({ ok: true, gas: table });
    });
});

describe('spend cap', () => {
    it('feeInWei converts a 6-decimal fee at the POL/USD price, rounded down', () => {
        expect(feeInWei(10_000n, price(2n, 1))).toBe(5n * 10n ** 16n); // 0.01 USD at 0.2 USD/POL = 0.05 POL
        expect(feeInWei(10_000n, price(20_000_000n, 8))).toBe(5n * 10n ** 16n); // the same price as a Chainlink answer
        expect(feeInWei(1n, price(3n, 0))).toBe(333_333_333_333n);
        expect(feeInWei(10_000n, price(0n, 8))).toBe(0n);
        expect(feeInWei(0n, price(2n, 1))).toBe(0n);
    });

    it('spendCapPerGas keeps gas limit × maxFeePerGas within the percentage of the fee', () => {
        const cap = spendCapPerGas(10_000n, price(2n, 1), 195_000n, 200);
        expect(cap).toBe(10n ** 17n / 195_000n);
        expect(cap * 195_000n).toBeLessThanOrEqual(10n ** 17n);
        expect((cap + 1n) * 195_000n).toBeGreaterThan(10n ** 17n);
        expect(spendCapPerGas(10_000n, price(2n, 1), 0n, 200)).toBe(0n);
        expect(spendCapPerGas(10_000n, price(2n, 1), 100_000n, 100)).toBe(5n * 10n ** 11n);
    });
});

describe('analyzeNonces', () => {
    it('lowers the next nonce to the top of what is used when the node holds nothing above it', () => {
        expect(analyzeNonces({ latest: 0, pending: 0, next: 2, tracked: new Set() })).toEqual({ lowerNextTo: 0, missing: [], lowestInFlight: undefined });
        expect(analyzeNonces({ latest: 3, pending: 3, next: 7, tracked: new Set([3, 4]) })).toEqual({ lowerNextTo: 5, missing: [], lowestInFlight: 3 });
    });

    it('does not lower it while the node holds transactions there, or when nothing is above the used range', () => {
        expect(analyzeNonces({ latest: 0, pending: 2, next: 2, tracked: new Set() }).lowerNextTo).toBeUndefined();
        expect(analyzeNonces({ latest: 5, pending: 5, next: 5, tracked: new Set() }).lowerNextTo).toBeUndefined();
        expect(analyzeNonces({ latest: 3, pending: 5, next: 5, tracked: new Set([3, 4]) }).lowerNextTo).toBeUndefined();
    });

    it('reports unused nonces below the lowest in-flight relay transaction', () => {
        expect(analyzeNonces({ latest: 0, pending: 0, next: 3, tracked: new Set([2]) })).toEqual({ lowerNextTo: undefined, missing: [0, 1], lowestInFlight: 2 });
        expect(analyzeNonces({ latest: 4, pending: 4, next: 8, tracked: new Set([4, 6, 7]) })).toEqual({ lowerNextTo: undefined, missing: [], lowestInFlight: 4 });
        // Tracked nonces below the latest nonce are used on-chain already: not in flight.
        expect(analyzeNonces({ latest: 5, pending: 5, next: 6, tracked: new Set([3, 5]) })).toEqual({ lowerNextTo: undefined, missing: [], lowestInFlight: 5 });
    });

    it('lists at most `limit` missing nonces, lowest first, whatever size of gap the view reports', () => {
        expect(analyzeNonces({ latest: 0, pending: 0, next: 1_000_001, tracked: new Set([1_000_000]) }, 4)).toEqual({
            lowerNextTo: undefined,
            missing: [0, 1, 2, 3],
            lowestInFlight: 1_000_000,
        });
        expect(analyzeNonces({ latest: 0, pending: 0, next: 3, tracked: new Set([2]) }, 4).missing).toEqual([0, 1]);
    });

    it('gap fillers fill a gap but hold nothing back: the lowest in-flight nonce is that of a transaction that waits', () => {
        // Fillers at 2 and 3 (not mined yet), a request at 6: nonces 0, 1, 4 and 5 are still missing below it.
        const v = { latest: 0, pending: 0, next: 7, tracked: new Set([2, 3, 6]), fillers: new Set([2, 3]) };
        expect(analyzeNonces(v)).toEqual({ lowerNextTo: undefined, missing: [0, 1, 4, 5], lowestInFlight: 6 });
        // Only fillers in flight: nothing waits, so there is no gap to fill.
        expect(analyzeNonces({ latest: 0, pending: 0, next: 4, tracked: new Set([2, 3]), fillers: new Set([2, 3]) })).toEqual({
            lowerNextTo: undefined,
            missing: [],
            lowestInFlight: undefined,
        });
    });
});

describe('combineNonces', () => {
    it("combines every RPC's latest and pending counts: the lowest pending (raising), the highest latest (fillers), the highest pending (lowering)", () => {
        expect(
            combineNonces([
                { latest: 5, pending: 35 }, // a liar's pending count
                { latest: 7, pending: 8 },
            ]),
        ).toEqual({ lowestPending: 8, highestLatest: 7, highestPending: 35 });
        expect(combineNonces([{ latest: 2, pending: 2 }])).toEqual({ lowestPending: 2, highestLatest: 2, highestPending: 2 });
        expect(() => combineNonces([])).toThrow('no RPC answered');
    });
});

describe('policy settings', () => {
    it('defaults: 200 % spend cap, 16 blocks finality depth, 20 blocks nonce gap, 30 days retention', () => {
        expect(parseTxPolicyEnv({})).toEqual(DEFAULT_TX_POLICY);
        expect(DEFAULT_TX_POLICY).toEqual({
            maxCostPercentOfFee: 200,
            minFinalityDepth: 16,
            nonceGapBlocks: 20,
            requestRetentionMs: 30 * DAY_MS,
            stuckAfterBlocks: 150,
            maxFinalityLagBlocks: 600,
        });
    });

    it('reads RELAY_* variables within their bounds', () => {
        expect(
            parseTxPolicyEnv({
                RELAY_MAX_COST_PERCENT_OF_FEE: '150',
                RELAY_MIN_FINALITY_DEPTH: '32',
                RELAY_NONCE_GAP_BLOCKS: '5',
                RELAY_REQUEST_RETENTION_DAYS: '7',
                RELAY_STUCK_AFTER_BLOCKS: '300',
                RELAY_MAX_FINALITY_LAG_BLOCKS: '1000',
                RELAY_UNRELATED: 'x',
            }),
        ).toEqual({
            maxCostPercentOfFee: 150,
            minFinalityDepth: 32,
            nonceGapBlocks: 5,
            requestRetentionMs: 7 * DAY_MS,
            stuckAfterBlocks: 300,
            maxFinalityLagBlocks: 1000,
        });
        expect(parseTxPolicyEnv({ RELAY_MIN_FINALITY_DEPTH: ' ' })).toEqual(DEFAULT_TX_POLICY);
    });

    it('refuses values that are not integers or out of range, with the caller’s error type', () => {
        class TestConfigError extends Error {}
        const fail = (message: string) => new TestConfigError(message);
        expect(() => parseTxPolicyEnv({ RELAY_MAX_COST_PERCENT_OF_FEE: '99' }, fail)).toThrow(TestConfigError);
        expect(() => parseTxPolicyEnv({ RELAY_MAX_COST_PERCENT_OF_FEE: '99' }, fail)).toThrow('RELAY_MAX_COST_PERCENT_OF_FEE must be between 100 and 10000');
        expect(() => parseTxPolicyEnv({ RELAY_REQUEST_RETENTION_DAYS: '0' })).toThrow(/between 1 and 3650/);
        expect(() => parseTxPolicyEnv({ RELAY_NONCE_GAP_BLOCKS: '1.5' })).toThrow('RELAY_NONCE_GAP_BLOCKS must be an integer');
        expect(() => parseTxPolicyEnv({ RELAY_STUCK_AFTER_BLOCKS: '-5' })).toThrow(/must be an integer/);
        expect(() => parseTxPolicyEnv({ RELAY_MAX_FINALITY_LAG_BLOCKS: '15' })).toThrow(/between 16 and 1000000/);
    });

    it('txPolicy fills the fields that are not set with the defaults', () => {
        expect(txPolicy({ maxCostPercentOfFee: 300, minFinalityDepth: 0 })).toEqual({ ...DEFAULT_TX_POLICY, maxCostPercentOfFee: 300, minFinalityDepth: 0 });
        expect(txPolicy({})).toEqual(DEFAULT_TX_POLICY);
    });
});
