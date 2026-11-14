import type { Address } from 'viem';
import type { ChainClient } from '../chain/types.js';
import { readFeedDecimals, readLatestRoundData } from '../chain/reads.js';
import { monotonicMs, nowSeconds, type Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';
import { formatFixed, parseFixed } from '../util/bigint.js';

export type PriceSourceKind = 'chainlink';

/** A POL/USD price as a fixed-point integer with `decimals` decimals. */
export interface PriceReading {
    readonly value: bigint;
    readonly decimals: number;
    readonly source: PriceSourceKind;
    /** Feed round timestamp (unix seconds). */
    readonly updatedAt: number | null;
    /** Reserved diagnostic field; valid oracle readings have no rejection reason. */
    readonly reason: string | null;
}

export interface PriceSource {
    /** Resolves to a validated oracle price; rejects when no usable reading is available. */
    get(): Promise<PriceReading>;
    /** Last reading, for readiness and metrics. */
    last(): PriceReading | undefined;
    readonly feed: Address | null;
}

/** §6.4: a price older than 3600 s or outside [0.01, 10] USD is rejected. */
const PRICE_MAX_AGE_SECONDS = 3600;
/**
 * A round's `updatedAt` is the timestamp of the block that carried the update, and Polygon block timestamps run up to
 * a few seconds ahead of the wall clock: a read just after an update would otherwise be rejected as
 * `future_timestamp`. A round at most this far ahead is accepted (it is then at most this much longer usable than
 * PRICE_MAX_AGE_SECONDS); anything further ahead is still rejected.
 */
export const PRICE_MAX_FUTURE_SKEW_SECONDS = 15;
const PRICE_MIN_USD = '0.01';
const PRICE_MAX_USD = '10';
const BOUND_DECIMALS = 8;
/**
 * Feeds with more decimals are rejected (`bad_decimals`). Chainlink uses 8 or 18; the bound also keeps
 * the quoted `polUsd` within the wire format's 20 fractional digits.
 */
const MAX_FEED_DECIMALS = 18;
/**
 * The feed is read through every configured RPC. Readings agree when the highest is at most this many
 * percent above the lowest; the relay then uses the highest (the lower spend cap and the higher break-even).
 * Otherwise it rejects the price and raises an alert (reason `rpc_disagreement`). A reading is taken only when
 * every RPC answers; see ChainlinkPriceSource.
 */
const PRICE_AGREEMENT_PERCENT = 10;
/**
 * A rejected refresh is answered again without a new read for this long (or for the cache period, if that is
 * shorter). Quotes are public and unlimited: without it, every quote during an outage would read the feed on every
 * RPC again, at the callers' rate. Shorter than the transaction manager's default poll interval, so each pass asks.
 */
export const PRICE_RETRY_MS = 1000;

/** The highest of `readings` if it is at most `percent` % above the lowest, else undefined (also for none). */
function agreeingPrice(readings: readonly PriceReading[], percent = PRICE_AGREEMENT_PERCENT): PriceReading | undefined {
    if (readings.length === 0) return undefined;
    // a / 10^da compared with b / 10^db, exactly.
    const compare = (a: PriceReading, b: PriceReading): bigint => a.value * 10n ** BigInt(b.decimals) - b.value * 10n ** BigInt(a.decimals);
    let low = readings[0]!;
    let high = readings[0]!;
    for (const r of readings) {
        if (compare(r, low) < 0n) low = r;
        if (compare(r, high) > 0n) high = r;
    }
    const agree = high.value * 10n ** BigInt(low.decimals) * 100n <= low.value * 10n ** BigInt(high.decimals) * BigInt(100 + percent);
    return agree ? high : undefined;
}

function setSourceGauge(metrics: RelayMetrics | undefined, reading: PriceReading): void {
    if (!metrics) return;
    metrics.priceSource.set({ source: 'chainlink' }, 1);
    metrics.polUsd.set(Number(formatFixed(reading.value, reading.decimals)));
}

export class PriceUnavailableError extends Error {
    constructor(readonly reason: string) {
        super(`Chainlink POL/USD unavailable: ${reason}`);
        this.name = 'PriceUnavailableError';
    }
}

export interface ChainlinkPriceSourceOptions {
    readonly chain: ChainClient;
    readonly feed: Address;
    /**
     * The wall clock judges the §6.4 staleness of a round (its `updatedAt` is a wall-clock time). The age of the cached
     * reading and the intervals between repeated log lines are measured on its monotonic clock (monotonicMs).
     */
    readonly clock: Clock;
    /** How long a reading is reused (RELAY_PRICE_CACHE_SECONDS), on the monotonic clock. */
    readonly cacheMs: number;
    readonly logger?: Logger;
    readonly metrics?: RelayMetrics;
    /** Minimum interval between repeated oracle alerts in the log (monotonic clock). */
    readonly alertIntervalMs?: number;
}

/** What one RPC answered for the feed: a usable reading, or the §6.4 reason it was rejected. */
type FeedAnswer = { readonly reading: PriceReading } | { readonly rejected: string };

/**
 * Chainlink POL/USD ("MATIC / USD") with the §6.4 checks, read through every configured RPC: a single
 * RPC must not be able to set the price, because the price sets the spend cap and break-even.
 * - A reading is taken only when every RPC answers. Each must give a usable
 *   reading, and the readings must agree within PRICE_AGREEMENT_PERCENT; the relay then uses the highest.
 * - When an RPC does not answer, the refresh fails. Answers from the other RPCs are not used alone.
 * - Any rejection (stale round, price out of bounds, non-positive answer, bad decimals, readings that disagree, or an
 *   RPC that does not answer) rejects pricing and raises an alert: an
 *   error log (rate limited) and `relay_price_unavailable_total{reason}`. No static price is used.
 * With a single RPC, that RPC decides alone: a wrong but plausible price cannot be detected
 * (relay/docs/transaction-lifecycle.md, "Several RPCs").
 *
 * Clocks: the staleness of a round is judged against the wall clock, because the feed's `updatedAt` is a wall-clock
 * time. The age of the cached reading (RELAY_PRICE_CACHE_SECONDS) and the intervals between repeated alerts and
 * warnings run on the monotonic clock, so that a backward step of the system clock neither keeps an old reading in the
 * cache nor silences the alerts for about the size of the step (as the fee engine's cache).
 */
export class ChainlinkPriceSource implements PriceSource {
    readonly feed: Address;
    /**
     * `decimals()` of the feed as each RPC (by position) answered it; only valid answers are kept, and only until a
     * refresh is rejected: one wrong but in-range answer would otherwise skew that RPC's price, and so fail every refresh
     * (`rpc_disagreement`, `out_of_bounds`), until a restart. After a rejection every RPC is asked again.
     */
    private readonly feedDecimals = new Map<number, number>();
    /** The last reading and when it was taken, on the monotonic clock. */
    private cached: { reading: PriceReading; atMonoMs: number } | undefined;
    /** The last rejection and until when it stands without a new read (PRICE_RETRY_MS), on the monotonic clock. */
    private rejected: { error: PriceUnavailableError; untilMonoMs: number } | undefined;
    private inflight: Promise<PriceReading> | undefined;
    /** Monotonic time of the last alert. */
    private lastAlertMonoMs = Number.NEGATIVE_INFINITY;

    constructor(private readonly options: ChainlinkPriceSourceOptions) {
        this.feed = options.feed;
    }

    last(): PriceReading | undefined {
        return this.cached?.reading;
    }

    get(): Promise<PriceReading> {
        const now = monotonicMs(this.options.clock);
        if (this.cached && now - this.cached.atMonoMs < this.options.cacheMs && this.fresh(this.cached.reading)) return Promise.resolve(this.cached.reading);
        if (this.rejected && now < this.rejected.untilMonoMs) return Promise.reject(this.rejected.error);
        this.inflight ??= this.fetch().finally(() => {
            this.inflight = undefined;
        });
        return this.inflight;
    }

    private async fetch(): Promise<PriceReading> {
        let reading: PriceReading;
        try {
            reading = await this.readFeed();
        } catch (err) {
            if (err instanceof PriceUnavailableError) throw err;
            return this.reject('rpc_error', err);
        }
        this.cached = { reading, atMonoMs: monotonicMs(this.options.clock) };
        this.rejected = undefined;
        setSourceGauge(this.options.metrics, reading);
        return reading;
    }

    private async readFeed(): Promise<PriceReading> {
        const rpcs = this.options.chain.rpcClients?.() ?? [this.options.chain];
        const results = await Promise.allSettled(rpcs.map((rpc, index) => this.readOne(rpc, index)));
        const answers: Array<{ rpc: number; answer: FeedAnswer }> = [];
        const silent: number[] = [];
        let firstError: unknown;
        results.forEach((r, index) => {
            if (r.status === 'fulfilled') answers.push({ rpc: index + 1, answer: r.value });
            else {
                silent.push(index + 1);
                firstError ??= r.reason;
            }
        });
        const rejected = answers.find((a): a is { rpc: number; answer: { rejected: string } } => 'rejected' in a.answer);
        if (rejected) return this.reject(rejected.answer.rejected, undefined, rpcs.length > 1 ? { rpc: rejected.rpc } : undefined);
        if (silent.length > 0) return this.reject('rpc_error', firstError, { rpcs: silent });
        const readings = answers.map((a) => (a.answer as { reading: PriceReading }).reading);
        const agreed = agreeingPrice(readings);
        if (agreed) {
            return agreed;
        }
        return this.reject('rpc_disagreement', undefined, {
            readings: answers.map((a, i) => ({ rpc: a.rpc, polUsd: formatFixed(readings[i]!.value, readings[i]!.decimals) })),
        });
    }

    /**
     * The window readOne accepts: a cached round is not reused past its expiry, nor once the wall clock is more than
     * PRICE_MAX_FUTURE_SKEW_SECONDS behind it (a backward step of the clock).
     */
    private fresh(reading: PriceReading): boolean {
        if (reading.updatedAt === null) return false;
        const age = nowSeconds(this.options.clock) - reading.updatedAt;
        return age >= -PRICE_MAX_FUTURE_SKEW_SECONDS && age <= PRICE_MAX_AGE_SECONDS;
    }

    /** The feed as one RPC reports it; throws when the RPC does not answer. */
    private async readOne(rpc: ChainClient, index: number): Promise<FeedAnswer> {
        let decimals = this.feedDecimals.get(index);
        if (decimals === undefined) {
            decimals = await readFeedDecimals(rpc, this.feed);
            if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_FEED_DECIMALS) return { rejected: 'bad_decimals' };
            this.feedDecimals.set(index, decimals);
        }
        const [, answer, , updatedAt] = await readLatestRoundData(rpc, this.feed);
        if (answer <= 0n) return { rejected: 'non_positive' };
        // Validate the uint256 before converting it: a future (or enormous) RPC-supplied
        // timestamp must not turn the last agreed price into an indefinitely reusable round. Only the few seconds
        // a block timestamp can run ahead of the wall clock are tolerated (PRICE_MAX_FUTURE_SKEW_SECONDS).
        const now = BigInt(nowSeconds(this.options.clock));
        if (updatedAt <= 0n) return { rejected: 'stale' };
        if (updatedAt > now + BigInt(PRICE_MAX_FUTURE_SKEW_SECONDS)) return { rejected: 'future_timestamp' };
        if (now - updatedAt > BigInt(PRICE_MAX_AGE_SECONDS)) return { rejected: 'stale' };
        // answer / 10^decimals vs bound / 10^8, compared exactly for any feed precision.
        const scaled = answer * 10n ** BigInt(BOUND_DECIMALS);
        const unit = 10n ** BigInt(decimals);
        const min = parseFixed(PRICE_MIN_USD, BOUND_DECIMALS)! * unit;
        const max = parseFixed(PRICE_MAX_USD, BOUND_DECIMALS)! * unit;
        if (scaled < min || scaled > max) return { rejected: 'out_of_bounds' };
        return { reading: { value: answer, decimals, source: 'chainlink', updatedAt: Number(updatedAt), reason: null } };
    }

    private reject(reason: string, err?: unknown, detail?: Record<string, unknown>): never {
        this.cached = undefined;
        this.feedDecimals.clear();
        this.options.metrics?.priceUnavailable.inc({ reason });
        this.options.metrics?.priceSource.set({ source: 'chainlink' }, 0);
        this.options.metrics?.polUsd.set(Number.NaN);
        const now = monotonicMs(this.options.clock);
        if (now - this.lastAlertMonoMs >= (this.options.alertIntervalMs ?? 300_000)) {
            this.lastAlertMonoMs = now;
            this.options.logger?.error(
                { alert: 'price_unavailable', reason, err, ...detail },
                reason === 'rpc_disagreement'
                    ? 'ALERT: the RPCs report different Chainlink POL/USD prices; pricing unavailable'
                    : 'ALERT: Chainlink POL/USD rejected; pricing unavailable',
            );
        }
        const error = new PriceUnavailableError(reason);
        this.rejected = { error, untilMonoMs: now + Math.min(this.options.cacheMs, PRICE_RETRY_MS) };
        throw error;
    }
}
