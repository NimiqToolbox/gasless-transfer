import type { RpcRequestEvent } from '../chain/viemChainClient.js';
import type { Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';

/** Latency samples one RPC keeps per interval; a busier interval's percentiles use its first samples. */
const MAX_SAMPLES = 10_000;

/**
 * Two RPCs' heads are compared when they were read at most this far apart: about two Polygon blocks, well under the
 * 5 blocks of the rule RelayRpcHeadLagging.
 */
const HEAD_COMPARE_WINDOW_MS = 5_000;

interface Interval {
    requests: number;
    readonly failures: Map<string, number>;
    readonly durationsMs: number[];
    maxLagBlocks: number | undefined;
}

export interface RpcUsageOptions {
    readonly logger: Logger;
    /** How many RPCs RELAY_RPC_URLS configures (every one is reported, also without requests). */
    readonly rpcCount: number;
    readonly metrics?: RelayMetrics | undefined;
}

function percentile(sorted: readonly number[], p: number): number | null {
    if (sorted.length === 0) return null;
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
}

/**
 * The load on each configured RPC and how it answers: request volume, failures by reason, latency and how far its
 * head is behind the heads the other configured RPCs reported at that time. Every request updates the metrics;
 * `start()` also logs one "rpc usage" line per interval, so capacity can be judged from the logs as well as from
 * the metrics. RPCs are named by their position in RELAY_RPC_URLS; URLs are never reported.
 */
export class RpcUsage {
    private intervals = new Map<number, Interval>();
    /** The latest head each RPC reported (eth_blockNumber or eth_getBlockByNumber("latest")), and when. */
    private readonly heads = new Map<number, { readonly head: bigint; readonly atMs: number }>();
    private intervalStartMs = Date.now();
    private timer: NodeJS.Timeout | undefined;

    constructor(private readonly options: RpcUsageOptions) {}

    private interval(rpc: number): Interval {
        let interval = this.intervals.get(rpc);
        if (!interval) {
            interval = { requests: 0, failures: new Map(), durationsMs: [], maxLagBlocks: undefined };
            this.intervals.set(rpc, interval);
        }
        return interval;
    }

    record(event: RpcRequestEvent): void {
        const { metrics } = this.options;
        const rpc = String(event.rpc);
        const interval = this.interval(event.rpc);
        interval.requests += 1;
        if (event.outcome !== 'ok') interval.failures.set(event.outcome, (interval.failures.get(event.outcome) ?? 0) + 1);
        if (interval.durationsMs.length < MAX_SAMPLES) interval.durationsMs.push(event.durationMs);
        metrics?.rpcRequests.inc({ rpc, method: event.method, outcome: event.outcome });
        metrics?.rpcRequestSeconds.observe({ rpc }, event.durationMs / 1000);
        if (event.head !== undefined) this.recordHead(event.rpc, event.head, interval);
    }

    /**
     * An RPC's lag is measured when it reports a head, against the heads the other RPCs reported just before. Ordinary
     * reads ask only the first RPC that answers, so the others report a head far less often: compared with a head read
     * later, each of them would show the blocks the chain added in between as its lag. Without a recent head of
     * another RPC there is nothing to compare with, and the last measured lag stands.
     */
    private recordHead(rpc: number, head: bigint, interval: Interval): void {
        const now = Date.now();
        this.heads.set(rpc, { head, atMs: now });
        let highest: bigint | undefined;
        for (const [other, sample] of this.heads) {
            if (other === rpc || Math.abs(now - sample.atMs) > HEAD_COMPARE_WINDOW_MS) continue;
            if (highest === undefined || sample.head > highest) highest = sample.head;
        }
        if (highest === undefined) return;
        const lag = highest > head ? Number(highest - head) : 0;
        interval.maxLagBlocks = Math.max(interval.maxLagBlocks ?? 0, lag);
        this.options.metrics?.rpcHeadLag.set({ rpc: String(rpc) }, lag);
    }

    /** Logs the interval's statistics of every configured RPC and starts a new interval. */
    flush(): void {
        const now = Date.now();
        const rpcs = Array.from({ length: this.options.rpcCount }, (_, i) => {
            const interval = this.intervals.get(i + 1);
            const sorted = [...(interval?.durationsMs ?? [])].sort((a, b) => a - b);
            const head = this.heads.get(i + 1)?.head;
            return {
                rpc: i + 1,
                requests: interval?.requests ?? 0,
                failed: [...(interval?.failures.values() ?? [])].reduce((a, b) => a + b, 0),
                failures: Object.fromEntries(interval?.failures ?? []),
                p50Ms: percentile(sorted, 0.5),
                p95Ms: percentile(sorted, 0.95),
                maxMs: percentile(sorted, 1),
                head: head?.toString() ?? null,
                maxLagBlocks: interval?.maxLagBlocks ?? null,
            };
        });
        this.options.logger.info({ intervalSeconds: Math.round((now - this.intervalStartMs) / 1000), rpcs }, 'rpc usage');
        this.intervals = new Map();
        this.intervalStartMs = now;
    }

    /** Logs every `intervalMs` (0: never). */
    start(intervalMs: number): void {
        if (this.timer || intervalMs <= 0) return;
        this.intervalStartMs = Date.now();
        this.intervals = new Map();
        this.timer = setInterval(() => this.flush(), intervalMs);
        this.timer.unref();
    }

    /** Stops logging; the last (partial) interval is logged once more. */
    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = undefined;
        this.flush();
    }
}
