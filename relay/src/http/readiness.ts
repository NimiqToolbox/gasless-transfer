import type { Address } from 'viem';
import { monotonicMs, type Clock } from '../clock.js';
import type { PriceSource, PriceSourceKind } from '../fees/priceSource.js';
import { serializeError } from '../logger.js';
import type { RelayContext } from '../operations/types.js';
import type { RpcHistoryReport } from '../ops/rpcHistory.js';
import type { TokenDomainReport } from '../ops/tokenDomainMonitor.js';
import type { TokenImplementationReport } from '../ops/tokenImplementationMonitor.js';
import { formatFixed } from '../util/bigint.js';

export interface ReadinessReport {
    readonly ready: boolean;
    /**
     * Part of the service is switched off or slowed down, although the relay works: a token whose EIP-712
     * domain changed (its permit and meta-tx are refused), the transaction manager's `degraded`
     * conditions (a backlog, requests held at their spend cap), or an RPC that failed the last check of the state of
     * older blocks (`rpcHistory`). A degraded relay stays ready (200).
     */
    readonly degraded: boolean;
    readonly checks: {
        readonly rpc: { ok: boolean; chainId?: number; blockNumber?: string; error?: string };
        readonly balance: { ok: boolean; wei?: string; minimumWei: string; error?: string };
        readonly priceSource: { ok: boolean; source?: PriceSourceKind; polUsd?: string; reason?: string | null; feed: Address | null };
        readonly txManager?: {
            ok: boolean;
            recovered: boolean;
            /** Wall-clock time of the last successful pass, for display; liveness uses its monotonic age. */
            lastTickAtMs: number | null;
            lastTickError: string | null;
            /** Conditions that make the relay unready (`TxManager.health().reasons`). */
            reasons?: readonly string[];
            /** Conditions that make it degraded but keep it ready (`TxManager.health().degraded`). */
            degraded?: readonly string[];
        };
        readonly tokenDomains?: TokenDomainReport;
        readonly tokenImplementations?: TokenImplementationReport;
        readonly rpcHistory?: RpcHistoryReport;
    };
}

/**
 * What readiness needs from the transaction manager. `health()` reports conditions that stop relaying
 * (`reasons`: not_recovered, no_pass, pass_stale, head_stale, insufficient_funds, gas_budget, nonce_gap, finality_lag, stalled)
 * and conditions that only slow it down (`degraded`: backlog, held_at_cap, settle_backlog). A manager (or a test
 * fake) without `health()` or without `degraded` counts as healthy or not degraded in that respect.
 *
 * `lastPassAgeMs` is the age of the last successful pass on the monotonic clock: a step of the
 * wall clock must not make a stopped transaction manager look live, or a live one stale. `lastTickAtMs` (wall
 * clock) is only displayed.
 */
export interface TxManagerProbe {
    status(): { recovered: boolean; lastTickAtMs: number | null; lastTickError: string | null; lastPassAgeMs: number | null };
    health?(): { ok: boolean; reasons: readonly string[]; degraded?: readonly string[] | undefined };
}

export interface ReadinessDeps {
    readonly ctx: RelayContext;
    readonly minBalanceWei: bigint;
    readonly priceSource: PriceSource;
    readonly clock: Clock;
    readonly txManager?: TxManagerProbe | undefined;
    /** A last pass older than this (monotonic clock) marks the transaction manager as stalled. */
    readonly txManagerStaleMs?: number;
    readonly tokenDomains?: { status(): TokenDomainReport } | undefined;
    readonly tokenImplementations?: { status(): TokenImplementationReport } | undefined;
    readonly rpcHistory?: { status(): RpcHistoryReport } | undefined;
}

function short(err: unknown): string {
    return String(serializeError(err).message ?? 'error').slice(0, 200);
}

/**
 * §6.2 readiness: RPC reachable (right chain), relay POL balance above the threshold, price source
 * usable, and a transaction manager that has recovered, ticks, and reports itself healthy
 * (`health().ok`). A backlog or a request held at its spend cap makes the relay `degraded`, as
 * does a token whose on-chain domain changed. A degraded relay stays ready: taking it out of
 * rotation would stop quotes, status queries and everything that still works.
 */
export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessReport> {
    const { ctx } = deps;
    const [rpc, balance, price] = await Promise.all([
        (async () => {
            try {
                const [chainId, block] = await Promise.all([ctx.chain.getChainId(), ctx.chain.getBlock('latest')]);
                return { ok: chainId === ctx.chainId, chainId, blockNumber: block.number.toString() };
            } catch (err) {
                return { ok: false, error: short(err) };
            }
        })(),
        (async () => {
            try {
                const wei = await ctx.chain.getBalance(ctx.relay);
                return { ok: wei >= deps.minBalanceWei, wei: wei.toString(), minimumWei: deps.minBalanceWei.toString() };
            } catch (err) {
                return { ok: false, minimumWei: deps.minBalanceWei.toString(), error: short(err) };
            }
        })(),
        (async () => {
            try {
                const reading = await deps.priceSource.get();
                return {
                    ok: true,
                    source: reading.source,
                    polUsd: formatFixed(reading.value, reading.decimals),
                    reason: reading.reason,
                    feed: deps.priceSource.feed,
                };
            } catch (err) {
                return { ok: false, reason: short(err), feed: deps.priceSource.feed };
            }
        })(),
    ]);

    let txManager: ReadinessReport['checks']['txManager'];
    let txDegraded: readonly string[] = [];
    if (deps.txManager) {
        const s = deps.txManager.status();
        const staleMs = deps.txManagerStaleMs ?? 60_000;
        // Monotonic age: a backward step of the wall clock does not keep a stopped manager "fresh".
        const fresh = s.lastPassAgeMs !== null && s.lastPassAgeMs <= staleMs;
        // Optional: transaction managers without health() are judged by recovery and tick liveness only.
        const health = deps.txManager.health?.();
        txDegraded = health?.degraded ?? [];
        txManager = {
            ok: s.recovered && fresh && (health?.ok ?? true),
            recovered: s.recovered,
            lastTickAtMs: s.lastTickAtMs,
            lastTickError: s.lastTickError,
            ...(health ? { reasons: health.reasons, degraded: txDegraded } : {}),
        };
    }
    const tokenDomains = deps.tokenDomains?.status();
    const tokenImplementations = deps.tokenImplementations?.status();
    const rpcHistory = deps.rpcHistory?.status();

    const ready = (tokenImplementations?.ok ?? true) && rpc.ok && balance.ok && price.ok && (txManager?.ok ?? true);
    return {
        ready,
        degraded: (tokenDomains !== undefined && !tokenDomains.ok) || txDegraded.length > 0 || (rpcHistory !== undefined && !rpcHistory.ok),
        checks: {
            ...(tokenImplementations ? { tokenImplementations } : {}),
            rpc,
            balance,
            priceSource: price,
            ...(txManager ? { txManager } : {}),
            ...(tokenDomains ? { tokenDomains } : {}),
            ...(rpcHistory ? { rpcHistory } : {}),
        },
    };
}

/**
 * Serves readiness from a cache: a report is reused for `ttlMs`, and
 * concurrent probes share one check, so however often /readyz is requested the relay makes at most one
 * set of RPC reads per `ttlMs`. `ttlMs = 0` still shares concurrent checks. The age of a report is measured on
 * the monotonic clock: after a backward step of the wall clock a report is still replaced after
 * `ttlMs`, not only once the wall clock has caught up.
 */
export function cachedReadiness(check: () => Promise<ReadinessReport>, clock: Clock, ttlMs: number): () => Promise<ReadinessReport> {
    let cached: { report: ReadinessReport; atMonoMs: number } | undefined;
    let inflight: Promise<ReadinessReport> | undefined;
    return () => {
        if (cached && monotonicMs(clock) - cached.atMonoMs < ttlMs) return Promise.resolve(cached.report);
        inflight ??= check()
            .then((report) => {
                cached = { report, atMonoMs: monotonicMs(clock) };
                return report;
            })
            .finally(() => {
                inflight = undefined;
            });
        return inflight;
    };
}
