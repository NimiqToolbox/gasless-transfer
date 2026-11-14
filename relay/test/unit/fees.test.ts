import { describe, expect, it } from 'vitest';
import type { AuthModeName } from '@nimiq/gasless-sdk/core';
import type { ChainClient } from '../../src/chain/types.js';
import { RelayError } from '../../src/errors.js';
import { FeeEngine, GAS_RETRY_MS, type FeeContext } from '../../src/fees/feeEngine.js';
import type { PriceReading, PriceSource } from '../../src/fees/priceSource.js';
import { TestClock } from '../helpers/harness.js';

const GWEI = 1_000_000_000n;

function price(value: bigint, decimals = 8): PriceReading {
    return { value, decimals, source: 'chainlink', updatedAt: null, reason: null };
}

function engine(options: { units?: number; marginBps?: number; chain?: Partial<ChainClient>; priceSource?: PriceSource; cacheMs?: number } = {}) {
    const units = options.units ?? 250_000;
    return new FeeEngine({
        chain: (options.chain ?? {}) as ChainClient,
        priceSource: options.priceSource ?? { get: async () => price(20_000_000n), last: () => undefined, feed: null },
        gasTable: { source: 'test', margin: 0.1, operations: { transfer: { permit: units, metaTxApprove: units, none: units } } },
        clock: new TestClock(0),
        minTip: 30n * GWEI,
        marginBps: options.marginBps ?? 1000,
        cacheMs: options.cacheMs ?? 0,
    });
}

const ctx = (baseFee: bigint, priority: bigint, p: PriceReading): FeeContext => FeeEngine.buildContext(baseFee, priority, 30n * GWEI, p);

describe('fee context', () => {
    it('tip = max(eth_maxPriorityFeePerGas, MIN_TIP); priceGas = baseFee × 1.5 + tip', () => {
        expect(ctx(30n * GWEI, 1n * GWEI, price(1n))).toMatchObject({ baseFee: 30n * GWEI, tip: 30n * GWEI, priceGas: 75n * GWEI });
        expect(ctx(30n * GWEI, 50n * GWEI, price(1n))).toMatchObject({ tip: 50n * GWEI, priceGas: 95n * GWEI });
        expect(ctx(3n, 0n, price(1n)).priceGas).toBe(5n + 30n * GWEI); // 1.5 × 3 wei rounds up
    });

    it('loads block and tip once per cache window (single flight)', async () => {
        let blocks = 0;
        const chain = {
            getBlock: async () => {
                blocks += 1;
                return { number: 1n, timestamp: 1n, baseFeePerGas: 30n * GWEI, hash: '0x' as const };
            },
            getMaxPriorityFeePerGas: async () => 1n,
        };
        const e = engine({ chain, cacheMs: 5000 });
        const [a, b] = await Promise.all([e.context(), e.context()]);
        expect(a).toEqual(b);
        await e.context();
        expect(blocks).toBe(1);
    });

    it('keeps the gas data while the price is rejected: quotes during a price outage do not read the chain again', async () => {
        let blocks = 0;
        let priceDown = true;
        const chain = {
            getBlock: async () => {
                blocks += 1;
                return { number: 1n, timestamp: 1n, baseFeePerGas: 30n * GWEI, hash: '0x' as const };
            },
            getMaxPriorityFeePerGas: async () => 1n,
        };
        const priceSource: PriceSource = {
            get: async () => {
                if (priceDown) throw new Error('price unavailable');
                return price(20_000_000n);
            },
            last: () => undefined,
            feed: null,
        };
        const e = engine({ chain, priceSource, cacheMs: 5000 });
        for (let i = 0; i < 5; i++) await expect(e.context()).rejects.toThrow('price unavailable');
        expect(blocks).toBe(1);
        priceDown = false;
        expect((await e.context()).baseFee).toBe(30n * GWEI);
        expect(blocks).toBe(1);
    });

    it('answers a failed load of the gas data for GAS_RETRY_MS without reading again, then reads again', async () => {
        const clock = new TestClock(1_000_000);
        let blocks = 0;
        let down = true;
        const chain = {
            getBlock: async () => {
                blocks += 1;
                if (down) throw new Error('rate limited');
                return { number: 1n, timestamp: 1n, baseFeePerGas: 30n * GWEI, hash: '0x' as const };
            },
            getMaxPriorityFeePerGas: async () => 1n,
        } as unknown as ChainClient;
        const e = new FeeEngine({
            chain,
            priceSource: { get: async () => price(20_000_000n), last: () => undefined, feed: null },
            gasTable: { source: 'test', margin: 0.1, operations: { transfer: { permit: 250_000 } } },
            clock,
            minTip: 30n * GWEI,
            marginBps: 1000,
            cacheMs: 2_000,
        });
        for (let i = 0; i < 5; i++) await expect(e.context()).rejects.toThrow('rate limited');
        expect(blocks).toBe(1);
        clock.ms += GAS_RETRY_MS;
        await expect(e.context()).rejects.toThrow('rate limited');
        expect(blocks).toBe(2);
        down = false;
        clock.ms += GAS_RETRY_MS;
        expect((await e.context()).baseFee).toBe(30n * GWEI);
        expect(blocks).toBe(3);
    });

    it('measures the age of its cache on the monotonic clock: after a backward step of the wall clock it loads again once cacheMs has passed (control: not before)', async () => {
        const clock = new TestClock(1_000_000);
        let baseFee = 30n * GWEI;
        let loads = 0;
        const chain = {
            getBlock: async () => {
                loads += 1;
                return { number: 1n, timestamp: 1n, baseFeePerGas: baseFee, hash: '0x' as const };
            },
            getMaxPriorityFeePerGas: async () => 1n,
        } as unknown as ChainClient;
        const e = new FeeEngine({
            chain,
            priceSource: { get: async () => price(20_000_000n), last: () => undefined, feed: null },
            gasTable: { source: 'test', margin: 0.1, operations: { transfer: { permit: 250_000 } } },
            clock,
            minTip: 30n * GWEI,
            marginBps: 1000,
            cacheMs: 2_000,
        });
        expect((await e.context()).baseFee).toBe(30n * GWEI);
        baseFee = 600n * GWEI; // the gas price rises
        clock.advance(-3600); // and the system clock steps back one hour
        clock.advance(1);
        expect((await e.context()).baseFee).toBe(30n * GWEI); // 1 s later: still cached
        clock.advance(1);
        expect((await e.context()).baseFee).toBe(600n * GWEI); // 2 s later: loaded again, not an hour later
        expect(loads).toBe(2);
    });
});

describe('breakEven', () => {
    it('= gasUnits × (baseFee + tip) × POLUSD in 6-decimal token units', () => {
        // 250000 × 60 gwei = 0.015 POL; × 0.2 USD = 0.003 USD = 3000 units
        expect(engine().breakEven('transfer', 'permit', ctx(30n * GWEI, 0n, price(20_000_000n)))).toBe(3000n);
        // 0.1121 USD/POL: 0.015 × 0.1121 = 0.0016815 USD → 1681.5 → 1682 (rounded up)
        expect(engine().breakEven('transfer', 'permit', ctx(30n * GWEI, 0n, price(11_210_000n)))).toBe(1682n);
    });

    it('does not include the 1.5 × baseFee headroom or the margin', () => {
        const e = engine();
        const c = ctx(100n * GWEI, 0n, price(100_000_000n)); // 1 USD/POL
        expect(e.breakEven('transfer', 'none', c)).toBe(250_000n * 130n * GWEI / 10n ** 12n);
    });

    it('handles feeds with other decimals', () => {
        expect(engine().breakEven('transfer', 'permit', ctx(30n * GWEI, 0n, price(2n * 10n ** 17n, 18)))).toBe(3000n);
    });
});

describe('T35: quote', () => {
    it('floors at MIN_FEE (0.01)', () => {
        expect(engine().quote('transfer', 'permit', ctx(30n * GWEI, 0n, price(20_000_000n)))).toEqual({ fee: 10_000n, gasUnits: 250_000n });
    });

    it('= roundUp_0.01(gasUnits × priceGas × POLUSD × 1.1)', () => {
        // 250000 × (1.5 × 1000 + 30) gwei = 0.3825 POL; × 1 USD × 1.1 = 0.42075 USD → 0.43
        expect(engine().quote('transfer', 'permit', ctx(1000n * GWEI, 0n, price(100_000_000n))).fee).toBe(430_000n);
        // Exact multiples are not rounded further: 200000 × 50 gwei (base 0 + tip 50) × 1 USD × 1.1 = 0.011 → 0.02
        expect(engine({ units: 200_000 }).quote('transfer', 'none', ctx(0n, 50n * GWEI, price(100_000_000n))).fee).toBe(20_000n);
        // Margin 0: 200000 × 50 gwei × 1 USD = 0.01 exactly → 0.01
        expect(engine({ units: 200_000, marginBps: 0 }).quote('transfer', 'none', ctx(0n, 50n * GWEI, price(100_000_000n))).fee).toBe(10_000n);
    });

    it('always returns a multiple of 10000 that is at least MIN_FEE and at least breakEven', () => {
        const e = engine();
        let seed = 42;
        const rand = (max: number) => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return BigInt(seed % max);
        };
        for (let i = 0; i < 500; i++) {
            const c = ctx(rand(3000) * GWEI, rand(200) * GWEI, price(1_000_000n + rand(999_000_000)));
            const fee = e.quote('transfer', 'permit', c).fee;
            expect(fee % 10_000n).toBe(0n);
            expect(fee).toBeGreaterThanOrEqual(10_000n);
            expect(fee).toBeGreaterThanOrEqual(e.breakEven('transfer', 'permit', c));
        }
    });

    it('has no upper cap: high gas prices are quoted as the formula gives them, never refused', () => {
        const e = engine();
        // priceGas = 1.5 × 12000 + 30 = 18030 gwei → 250000 × 18030 gwei × 1 USD × 1.1 = 4.958 USD → 4.96
        expect(e.quote('transfer', 'permit', ctx(12_000n * GWEI, 0n, price(100_000_000n))).fee).toBe(4_960_000n);
        // Above 5.00: 250000 × 19530 gwei × 1 USD × 1.1 = 5.37075 USD → 5.38
        expect(e.quote('transfer', 'permit', ctx(13_000n * GWEI, 0n, price(100_000_000n))).fee).toBe(5_380_000n);
        // Break-even above 5.00: 250000 × 30030 gwei × 1 USD × 1.1 = 8.25825 USD → 8.26
        expect(e.quote('transfer', 'permit', ctx(20_000n * GWEI, 0n, price(100_000_000n))).fee).toBe(8_260_000n);
        // Exact in bigint far above 2^53 and 2^128 token units: 250000 × (1.5 × 10^46 + 30 gwei) wei × 1 USD × 1.1.
        const extreme = ctx(10n ** 46n, 0n, price(100_000_000n));
        const fee = e.quote('transfer', 'permit', extreme).fee;
        expect(fee).toBe(((250_000n * (15n * 10n ** 45n + 30n * GWEI) * 11n) / 10n ** 13n / 10_000n + 1n) * 10_000n);
        expect(fee > 2n ** 128n).toBe(true);
        expect(fee).toBeGreaterThanOrEqual(e.breakEven('transfer', 'permit', extreme));
        // With no gas price at all (break-even 0), the quote is still MIN_FEE.
        const free = FeeEngine.buildContext(0n, 0n, 0n, price(1n));
        expect(e.breakEven('transfer', 'permit', free)).toBe(0n);
        expect(e.quote('transfer', 'permit', free).fee).toBe(10_000n);
    });

    it('rejects unknown operations or modes', () => {
        const e = new FeeEngine({
            chain: {} as ChainClient,
            priceSource: { get: async () => price(1n), last: () => undefined, feed: null },
            gasTable: { source: 't', margin: 0, operations: { transfer: { permit: 100_000 } } },
            clock: new TestClock(0),
            minTip: 1n,
            marginBps: 0,
            cacheMs: 0,
        });
        expect(() => e.gasUnits('transfer', 'none' as AuthModeName)).toThrow(RelayError);
        expect(() => e.gasUnits('example.open', 'permit')).toThrow(RelayError);
        expect(e.gasUnits('transfer', 'permit')).toBe(100_000n);
    });
});
