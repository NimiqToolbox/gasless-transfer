// Fee policy (docs/STEP-1-GAS-ABSTRACTION.md §6.4): break-even and quotes checked against an independent
// computation, the acceptance boundary through the full pipeline, and the rules that keep a fee from falling below
// what a request costs the relay: the MIN_FEE floor at acceptance, the spend cap at broadcast (the fee is not
// checked again there) and the refusal of a minimum tip of 0.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTransaction } from 'viem';
import type { ChainClient } from '../../../src/chain/types.js';
import { loadConfig } from '../../../src/config.js';
import { FeeEngine } from '../../../src/fees/feeEngine.js';
import type { PriceReading } from '../../../src/fees/priceSource.js';
import { GWEI } from '../../helpers/fakeChain.js';
import { buildTransfer, CONTRACT, createHarness, TEST_GAS_TABLE, TestClock, USDC, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';

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

// `chainlink` is the only kind of price source the relay knows.
const price = (value: bigint, decimals: number): PriceReading => ({ value, decimals, source: 'chainlink', updatedAt: null, reason: null });

function engine(units: number, marginBps: number): FeeEngine {
    return new FeeEngine({
        chain: {} as ChainClient,
        priceSource: { get: async () => price(1n, 0), last: () => undefined, feed: null },
        gasTable: { source: 't', margin: 0.1, operations: { transfer: { permit: units, metaTxApprove: units, none: units } } },
        clock: new TestClock(0),
        minTip: 30n * GWEI,
        marginBps,
        cacheMs: 0,
    });
}

/** ceil(a / b) for positive b, written independently of the relay's helpers. */
const ceil = (a: bigint, b: bigint) => (a % b === 0n ? a / b : a / b + 1n);

describe('fee engine vs. an independent computation', () => {
    it('break-even, quote and rounding on 5000 random contexts (price decimals 0..18); no cap above', () => {
        const random = prng(7);
        const big = (max: number) => BigInt(Math.floor(random() * max));
        for (let i = 0; i < 5000; i++) {
            const units = 21_000 + Number(big(500_000));
            const marginBps = Number(big(10_001));
            const e = engine(units, marginBps);
            const decimals = Number(big(19));
            const value = 1n + big(10 ** Math.min(decimals + 1, 15)) * 10n ** BigInt(Math.max(0, decimals - 14));
            const baseFee = big(5000) * GWEI + big(1_000_000_000);
            const priority = big(300) * GWEI;
            const c = FeeEngine.buildContext(baseFee, priority, 30n * GWEI, price(value, decimals));
            const tip = priority > 30n * GWEI ? priority : 30n * GWEI;
            expect(c.priceGas).toBe(ceil(baseFee * 3n, 2n) + tip);

            // breakEven = ceil(units × (baseFee + tip) wei × value / 10^decimals USD/POL / 10^18 × 10^6)
            const exact = BigInt(units) * (baseFee + tip) * value;
            const scale = 10n ** BigInt(decimals + 12);
            const breakEven = ceil(exact, scale);
            expect(e.breakEven('transfer', 'permit', c)).toBe(breakEven);
            // Never below the true cost (rounding up):
            expect(breakEven * scale).toBeGreaterThanOrEqual(exact);

            const raw = ceil(BigInt(units) * c.priceGas * value * BigInt(10_000 + marginBps), scale * 10_000n);
            const floor = raw > 10_000n ? raw : 10_000n;
            const expectedQuote = ceil(floor, 10_000n) * 10_000n;
            const quote = e.quote('transfer', 'permit', c).fee;
            expect(quote).toBe(expectedQuote);
            expect(quote % 10_000n).toBe(0n);
            expect(quote).toBeGreaterThanOrEqual(breakEven);
        }
    });
});

describe('acceptance through the pipeline', () => {
    let h: Harness;
    beforeEach(async () => {
        h = await createHarness();
    });
    afterEach(async () => {
        await h.close();
    });
    const post = (payload: unknown) => h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object });

    it('fee = breakEven(now) is accepted, breakEven - 1 is fee_too_low (402)', async () => {
        h.chain.head = { ...h.chain.head, baseFeePerGas: 700n * GWEI };
        const c = await h.relay.fees.context();
        const breakEven = h.relay.fees.breakEven('transfer', 'none', c);
        expect(breakEven).toBe(ceil(BigInt(TEST_GAS_TABLE.operations.transfer!.none!) * (700n + 30n) * GWEI * 20_000_000n, 10n ** 20n));
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const low = await buildTransfer(h, { mode: 'none', fee: breakEven - 1n });
        const res = await post(low.body);
        expect(res.statusCode).toBe(402);
        expect((res.json() as { error: { code: string } }).error.code).toBe('fee_too_low');
        const exact = await buildTransfer(h, { mode: 'none', fee: breakEven });
        expect((await post(exact.body)).statusCode).toBe(202);
    });

    // Acceptance requires fee ≥ max(MIN_FEE, breakEven(now)), as quotes do. If break-even alone decided, a sender
    // could fill the queue at the bare gas cost while gas is cheap.
    it('a fee below MIN_FEE (0.01) is fee_too_low (402) although it covers break-even; MIN_FEE is accepted', async () => {
        const c = await h.relay.fees.context();
        const breakEven = h.relay.fees.breakEven('transfer', 'permit', c);
        expect(breakEven).toBeLessThan(10_000n);
        const low = await post((await buildTransfer(h, { mode: 'permit', fee: breakEven })).body);
        expect(low.statusCode).toBe(402);
        expect((low.json() as { error: { code: string } }).error.code).toBe('fee_too_low');
        expect((await post((await buildTransfer(h, { mode: 'permit', fee: 10_000n })).body)).statusCode).toBe(202);
    });

    // The fee is checked at acceptance only, and gas can rise before the broadcast. The spend cap bounds what the
    // relay then pays: gas limit × maxFeePerGas stays within RELAY_MAX_COST_PERCENT_OF_FEE (default 200 %) of the
    // fee. Without the cap, this 0.01 USD request would be broadcast at the market's 2 × 1450 + 30 = 2930 gwei, about
    // 100 times the gas price it was accepted at.
    it('a request accepted at 30 gwei is held while the market exceeds its spend cap, then sent within the cap', async () => {
        const t = await buildTransfer(h, { mode: 'permit', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7200) });
        expect((await post(t.body)).statusCode).toBe(202);
        const acceptedCost = h.relay.fees.breakEven('transfer', 'permit', await h.relay.fees.context());
        // Gas spikes before the queue reaches the request (e.g. a full queue, or just the next block).
        h.chain.head = { ...h.chain.head, baseFeePerGas: 1_450n * GWEI };
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        // Held: gas limit (min(estimate 150000 × 1.3, gas table)) × (1450 gwei + tip) is far above 200 % of the fee.
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(h.store.getRequest(t.id)?.status).toBe('queued');
        expect(await h.metrics.registry.metrics()).toContain('relay_spend_cap_holds_total{kind="initial"} 1');
        // The price falls to where the cap covers base fee + tip, but not the market's 2 × base + tip: sent at the cap.
        h.chain.head = { ...h.chain.head, baseFeePerGas: 400n * GWEI };
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(1);
        const tx = parseTransaction(h.chain.broadcasts[0]!);
        expect(tx.maxFeePerGas!).toBeLessThan(830n * GWEI);
        expect(tx.maxFeePerGas!).toBeGreaterThanOrEqual(430n * GWEI);
        const worstCaseCostUnits = (tx.gas! * tx.maxFeePerGas! * 20_000_000n) / 10n ** 20n; // POL/USD 0.2
        expect(worstCaseCostUnits).toBeLessThanOrEqual(2n * 10_000n);
        expect(acceptedCost).toBeLessThan(10_000n);
    });
});

describe('configuration', () => {
    // With a minimum tip of 0, a chain (or RPC) that reports base fee 0 would make break-even 0, and with it a fee
    // of 0 acceptable. The configuration and the fee engine refuse MIN_TIP 0, so break-even stays above 0.
    it('RELAY_MIN_TIP_GWEI=0 is rejected, so break-even (and an acceptable fee) cannot be 0', () => {
        const env = {
            RELAY_RPC_URLS: 'http://127.0.0.1:8545',
            RELAY_DEPLOYMENT_FILE: '/x.json',
            RELAY_PRIVATE_KEY_FILE: '/k',
            // No RELAY_POLUSD_FALLBACK: loadConfig refuses a static price, the Chainlink feed is required.
        };
        expect(() => loadConfig({ ...env, RELAY_MIN_TIP_GWEI: '0' })).toThrow(/RELAY_MIN_TIP_GWEI must be greater than 0/);
        const engine = (minTip: bigint) =>
            new FeeEngine({
                chain: {} as ChainClient,
                priceSource: { get: async () => price(1n, 0), last: () => undefined, feed: null },
                gasTable: TEST_GAS_TABLE,
                clock: new TestClock(0),
                minTip,
                marginBps: 1000,
                cacheMs: 0,
            });
        expect(() => engine(0n)).toThrow(/MIN_TIP/);
        // A chain (or RPC) reporting base fee 0 and priority fee 0: even the smallest accepted MIN_TIP
        // (1 wei) keeps break-even at 1 token unit or more, so a fee of 0 fails step 5.
        const config = loadConfig({ ...env, RELAY_MIN_TIP_GWEI: '0.000000001' });
        expect(config.tx.minTip).toBe(1n);
        expect(engine(config.tx.minTip).breakEven('transfer', 'none', FeeEngine.buildContext(0n, 0n, config.tx.minTip, price(20_000_000n, 8)))).toBeGreaterThan(0n);
    });
});
