import type { AuthModeName } from '@nimiq/gasless-sdk/core';
import { FEE_GRANULARITY, MIN_FEE } from '@nimiq/gasless-sdk/core';
import type { ChainClient } from '../chain/types.js';
import { monotonicMs, type Clock } from '../clock.js';
import type { GasTable } from '../config.js';
import { RelayError } from '../errors.js';
import { ceilDiv, maxBig, roundUpTo } from '../util/bigint.js';
import type { PriceReading, PriceSource } from './priceSource.js';

/** Stablecoins have 6 decimals and count as $1 (§6.4). */
const TOKEN_DECIMALS = 6;
const WEI_DECIMALS = 18;

/** The chain's gas prices as quotes and break-even use them. */
interface GasData {
    readonly baseFee: bigint;
    /** max(eth_maxPriorityFeePerGas, MIN_TIP). */
    readonly tip: bigint;
    /** baseFee × 1.5 + tip: the gas price used for quotes. */
    readonly priceGas: bigint;
}

export interface FeeContext extends GasData {
    readonly price: PriceReading;
}

/**
 * A failed load of the gas data is answered again without a new read for this long (or for the cache period, if
 * that is shorter): quotes are public and unlimited, and an RPC that fails fast would otherwise be read at their rate.
 */
export const GAS_RETRY_MS = 1000;

export interface FeeEngineOptions {
    readonly chain: ChainClient;
    readonly priceSource: PriceSource;
    readonly gasTable: GasTable;
    /**
     * Only its monotonic clock is read (monotonicMs): the age of the cached gas and price data. A step of the wall
     * clock therefore neither keeps an old context nor drops a fresh one.
     */
    readonly clock: Clock;
    /** MIN_TIP in wei (default 30 gwei). */
    readonly minTip: bigint;
    /** MARGIN in basis points (default 1000 = 10%). */
    readonly marginBps: number;
    /** How long gas data is reused (ms, RELAY_FEE_CACHE_MS); oracle caching belongs to PriceSource. */
    readonly cacheMs: number;
}

/**
 * §6.4 fee engine (no Uniswap):
 *   priceGas  = baseFee × 1.5 + tip,                 tip = max(eth_maxPriorityFeePerGas, MIN_TIP)
 *   breakEven = gasUnits × (baseFee + tip) × POLUSD                  (rounded up to token units)
 *   quote     = roundUp_0.01(max(MIN_FEE, gasUnits × priceGas × POLUSD × (1 + MARGIN)))
 * Submissions are accepted when `fee ≥ max(MIN_FEE, breakEven(now))` (pipeline step 5). Nothing caps the fee from
 * above, neither here nor in the contract: quotes are hints, and clients must check a quote before they sign it.
 */
export class FeeEngine {
    readonly minFee = BigInt(MIN_FEE);
    readonly granularity = BigInt(FEE_GRANULARITY);
    /** The cached gas data and when it was loaded, on the monotonic clock. */
    private cached: { gas: GasData; atMonoMs: number } | undefined;
    /** The last failed load and until when it stands without a new read (GAS_RETRY_MS), on the monotonic clock. */
    private failed: { error: unknown; untilMonoMs: number } | undefined;
    private inflight: Promise<GasData> | undefined;

    constructor(private readonly options: FeeEngineOptions) {
        // With MIN_TIP 0, a chain (or RPC) reporting base fee 0 would make break-even, and with it an
        // acceptable fee, 0. A positive tip keeps break-even at 1 token unit or more.
        if (options.minTip <= 0n) throw new RangeError('MIN_TIP must be greater than 0');
    }

    /**
     * Cached gas data with a currently usable oracle price. Rejects on RPC or oracle errors. The price is asked every
     * time (its source caches it): a gas cache must not keep an oracle price usable after the oracle rejected it. The
     * gas data is cached whatever the price answers, so quotes during a price outage do not read the chain again.
     */
    async context(): Promise<FeeContext> {
        const [gas, price] = await Promise.all([this.gas(), this.options.priceSource.get()]);
        return { ...gas, price };
    }

    private gas(): Promise<GasData> {
        const now = monotonicMs(this.options.clock);
        if (this.cached && now - this.cached.atMonoMs < this.options.cacheMs) return Promise.resolve(this.cached.gas);
        if (this.failed && now < this.failed.untilMonoMs) return Promise.reject(this.failed.error);
        this.inflight ??= this.load().finally(() => {
            this.inflight = undefined;
        });
        return this.inflight;
    }

    private async load(): Promise<GasData> {
        const { chain, clock, cacheMs, minTip } = this.options;
        try {
            const [block, priority] = await Promise.all([chain.getBlock('latest'), chain.getMaxPriorityFeePerGas()]);
            const gas = FeeEngine.gasData(block.baseFeePerGas ?? 0n, priority, minTip);
            this.cached = { gas, atMonoMs: monotonicMs(clock) };
            this.failed = undefined;
            return gas;
        } catch (error) {
            this.failed = { error, untilMonoMs: monotonicMs(clock) + Math.min(cacheMs, GAS_RETRY_MS) };
            throw error;
        }
    }

    private static gasData(baseFee: bigint, maxPriorityFee: bigint, minTip: bigint): GasData {
        const tip = maxBig(maxPriorityFee, minTip);
        return { baseFee, tip, priceGas: ceilDiv(baseFee * 3n, 2n) + tip };
    }

    static buildContext(baseFee: bigint, maxPriorityFee: bigint, minTip: bigint, price: PriceReading): FeeContext {
        return { ...FeeEngine.gasData(baseFee, maxPriorityFee, minTip), price };
    }

    gasUnits(operation: string, mode: AuthModeName): bigint {
        const units = this.options.gasTable.operations[operation]?.[mode];
        if (units === undefined) throw new RelayError('unsupported_auth_mode', `no gas data for ${operation} with ${mode}`);
        return BigInt(units);
    }

    /** Cost in token units (6 decimals) of `gasUnits × gasPrice` at `price`, rounded up. */
    private tokenCost(gasUnits: bigint, gasPrice: bigint, price: PriceReading, multiplierBps: bigint): bigint {
        const scale = 10n ** BigInt(price.decimals + WEI_DECIMALS - TOKEN_DECIMALS);
        return ceilDiv(gasUnits * gasPrice * price.value * multiplierBps, scale * 10_000n);
    }

    breakEven(operation: string, mode: AuthModeName, context: FeeContext): bigint {
        return this.tokenCost(this.gasUnits(operation, mode), context.baseFee + context.tip, context.price, 10_000n);
    }

    /** The fee to sign, in token units: at least MIN_FEE, a multiple of 0.01, and never below break-even. */
    quote(operation: string, mode: AuthModeName, context: FeeContext): { fee: bigint; gasUnits: bigint } {
        const gasUnits = this.gasUnits(operation, mode);
        const raw = this.tokenCost(gasUnits, context.priceGas, context.price, 10_000n + BigInt(this.options.marginBps));
        return { fee: roundUpTo(maxBig(this.minFee, raw), this.granularity), gasUnits };
    }
}
