import { formatEther, type Address } from 'viem';
import { AMOY_CHAIN_ID, POLYGON_CHAIN_ID } from '@nimiq/gasless-sdk/core';
import { monotonicMs, type Clock } from '../clock.js';
import { QUIET_ROUTES } from '../http/app.js';
import type { ReadinessReport } from '../http/readiness.js';
import { serializeError, type Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';

/** Interval between checks; the first check runs one interval after start. */
export const ALERT_CHECK_MS = 60_000;
/** A condition fires after this many consecutive checks that see it, and resolves after as many that do not. */
const ALERT_CONFIRM_CHECKS = 2;
/** A condition that is still firing is posted again after this long (monotonic clock). */
export const ALERT_REMIND_MS = 6 * 3_600_000;
/** `transfers_failing`: at least this many on-chain reverts and expiries within the window. */
const TRANSFER_FAILURE_THRESHOLD = 3;
const TRANSFER_FAILURE_WINDOW_MS = 15 * 60_000;
/** `http_5xx`: at least this many 5xx answers (outside QUIET_ROUTES) within the window. */
const HTTP_5XX_THRESHOLD = 10;
const HTTP_5XX_WINDOW_MS = 5 * 60_000;
/** Undelivered messages kept for the next check; beyond this the oldest is dropped. */
export const ALERT_OUTBOX_MAX = 20;
const ALERT_SEND_TIMEOUT_MS = 10_000;

/** The counter of relay calls that were included and reverted (tx/txMetrics.ts). */
const REVERTED_ONCHAIN_METRIC = 'relay_requests_reverted_onchain_total';
const BALANCE_KEYS: ReadonlySet<string> = new Set(['pol_low', 'pol_empty']);
const COUNTER_KEYS: ReadonlySet<string> = new Set(['transfers_failing', 'http_5xx']);

type AlertSeverity = 'critical' | 'warning';

/** Posts one message; rejects when it was not delivered. */
export type AlertSend = (text: string) => Promise<void>;

export interface AlertMonitorOptions {
    readonly readiness: () => Promise<ReadinessReport>;
    readonly metrics: RelayMetrics;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly chainId: number;
    readonly relay: Address;
    readonly minBalanceWei: bigint;
    /** Below it (and at or above the minimum) `pol_low` fires. */
    readonly warnBalanceWei: bigint;
    /** Without it, transitions are only logged. */
    readonly send?: AlertSend | undefined;
}

interface Observation {
    readonly key: string;
    readonly severity: AlertSeverity;
    readonly text: string;
}

interface ConditionState {
    severity: AlertSeverity;
    text: string;
    seen: number;
    clear: number;
    firing: boolean;
    lastPostedMonoMs: number;
}

type Transition = { readonly kind: 'firing' | 'reminder' | 'resolved'; readonly key: string; readonly severity: AlertSeverity; readonly text: string };

/** Cumulative counter totals at one check. */
interface CounterSnapshot {
    readonly monoMs: number;
    readonly transferFailures: number;
    readonly http5xx: ReadonlyMap<string, number>;
}

/**
 * Turns the relay's own view of itself into alerts that reach an operator: every check reads the cached readiness
 * report (the same as /readyz) and the request and HTTP counters, derives the conditions below, and posts one
 * message per check that holds all transitions (a condition firing, still firing after ALERT_REMIND_MS, or resolved).
 * Every transition is also logged, with `condition` and `alertState`.
 *
 * - `pol_empty` (critical): the POL balance is below the readiness minimum, or the transaction manager could not pay
 *   for gas (`insufficient_funds`). `pol_low` (warning): below the warning level.
 * - `not_ready:<part>` (critical): a readiness check fails (`rpc`, `price`, `token_implementation`, `tx:<reason>`).
 * - `degraded:<part>` (warning): `tx:<reason>`, `token_domain`, `rpc_history`.
 * - `transfers_failing` (critical): included-and-reverted relay calls and expired requests within a window. Failed
 *   requests do not count: most of them are refusals that the sender caused.
 * - `http_5xx` (warning): 5xx answers within a window.
 *
 * Alerts never carry client addresses, senders or request bodies: only the relay's own address and aggregates.
 */
export class AlertMonitor {
    private readonly states = new Map<string, ConditionState>();
    private readonly snapshots: CounterSnapshot[] = [];
    private readonly outbox: string[] = [];
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    /** Set by stop(): a check that is still delivering stops after the message in flight, so shutdown is not held up. */
    private stopped = false;
    private checking: Promise<void> | undefined;

    constructor(private readonly options: AlertMonitorOptions) {}

    /**
     * Checks every ALERT_CHECK_MS; a check never overlaps the previous one. The first check comes after one interval:
     * at startup the transaction manager has not completed a pass yet, and a report of that moment would also be
     * the cached answer of /readyz for a while.
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        const loop = (): void => {
            if (!this.running) return;
            this.timer = setTimeout(() => {
                void this.check().finally(loop);
            }, ALERT_CHECK_MS);
        };
        loop();
    }

    /** Waits at most for the message being posted (ALERT_SEND_TIMEOUT_MS); the rest of the outbox is not sent. */
    async stop(): Promise<void> {
        this.running = false;
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        await this.checking;
    }

    /** One check; never rejects. Concurrent calls share the running check. */
    check(): Promise<void> {
        this.checking ??= this.run()
            .catch((err: unknown) => {
                this.options.logger.error({ err }, 'alert check failed');
            })
            .finally(() => {
                this.checking = undefined;
            });
        return this.checking;
    }

    private async run(): Promise<void> {
        const now = monotonicMs(this.options.clock);
        const readiness = await this.fromReadiness();
        const observations = [...readiness.observations, ...(await this.fromCounters(now))];
        const transitions = this.apply(observations, readiness.unknown, now);
        for (const t of transitions) this.log(t);
        if (!this.options.send) return;
        if (transitions.length > 0) this.enqueue(this.message(transitions));
        await this.flush(this.options.send);
    }

    /**
     * The conditions in the readiness report, and `unknown`: conditions this check cannot judge (the balance when it
     * could not be read, and `pol_low` while the worse `pol_empty` holds). A firing one stays firing, so an RPC outage
     * does not resolve a low balance and a falling balance does not report `pol_low` as resolved.
     */
    private async fromReadiness(): Promise<{ observations: Observation[]; unknown: (key: string) => boolean }> {
        let report: ReadinessReport;
        try {
            report = await this.options.readiness();
        } catch (err) {
            return {
                observations: [{ key: 'not_ready:readiness', severity: 'critical', text: `the readiness check failed: ${short(err)}` }],
                unknown: (key) => !COUNTER_KEYS.has(key),
            };
        }
        const { checks } = report;
        const out: Observation[] = [];
        const tx = checks.txManager;
        const txReasons = tx?.reasons ?? [];
        const cannotPay = txReasons.some((r) => reasonKey(r) === 'insufficient_funds');

        const { minBalanceWei, warnBalanceWei } = this.options;
        const wei = checks.balance.wei === undefined ? undefined : BigInt(checks.balance.wei);
        if (wei !== undefined && wei < minBalanceWei) {
            out.push({ key: 'pol_empty', severity: 'critical', text: `balance ${pol(wei)} is below the readiness minimum ${pol(minBalanceWei)}; top up now` });
        } else if (cannotPay) {
            const balance = wei === undefined ? 'unknown' : pol(wei);
            out.push({ key: 'pol_empty', severity: 'critical', text: `the relay cannot pay for gas (balance ${balance}); transfers are held until it is topped up` });
        } else if (wei !== undefined && wei < warnBalanceWei) {
            out.push({ key: 'pol_low', severity: 'warning', text: `balance ${pol(wei)} is below the warning level ${pol(warnBalanceWei)}; top up soon` });
        }
        const balanceUnknown = wei === undefined;
        const polEmpty = out.some((o) => o.key === 'pol_empty');

        const rpcProblem = !checks.rpc.ok
            ? (checks.rpc.error ?? `the RPC reports chain ${checks.rpc.chainId ?? 'unknown'}, not ${this.options.chainId}`)
            : checks.balance.error !== undefined
              ? `the balance read failed: ${checks.balance.error}`
              : undefined;
        if (rpcProblem !== undefined) out.push({ key: 'not_ready:rpc', severity: 'critical', text: `RPC unavailable: ${rpcProblem}` });
        if (!checks.priceSource.ok) {
            out.push({ key: 'not_ready:price', severity: 'critical', text: `no usable POL/USD price: ${checks.priceSource.reason ?? 'unknown reason'}` });
        }
        if (checks.tokenImplementations && !checks.tokenImplementations.ok) {
            out.push({
                key: 'not_ready:token_implementation',
                severity: 'critical',
                text: `token implementation verification failed for ${checks.tokenImplementations.unavailable.join(', ')}; all authorization modes are held`,
            });
        }
        if (tx && !tx.ok) {
            const own = txReasons.filter((r) => reasonKey(r) !== 'insufficient_funds');
            for (const reason of own) out.push({ key: `not_ready:tx:${reasonKey(reason)}`, severity: 'critical', text: reasonText(reason) });
            // Not live without a reason of its own: not recovered or no recent pass (readiness judges liveness itself).
            if (own.length === 0 && !cannotPay) {
                const lastError = tx.lastTickError === null ? '' : `; last error: ${tx.lastTickError}`;
                out.push({ key: 'not_ready:tx', severity: 'critical', text: `the transaction manager is not live${lastError}` });
            }
        }

        for (const reason of tx?.degraded ?? []) out.push({ key: `degraded:tx:${reasonKey(reason)}`, severity: 'warning', text: reasonText(reason) });
        if (checks.tokenDomains && !checks.tokenDomains.ok) {
            out.push({
                key: 'degraded:token_domain',
                severity: 'warning',
                text: `the EIP-712 domain of ${checks.tokenDomains.mismatched.join(', ')} changed on-chain; its permit and meta-tx requests are refused`,
            });
        }
        if (checks.rpcHistory && !checks.rpcHistory.ok) {
            const rpcs = checks.rpcHistory.failures.map((f) => `#${f.rpc}`).join(', ');
            out.push({ key: 'degraded:rpc_history', severity: 'warning', text: `RPC ${rpcs} does not serve the state of older blocks; decisions that need it wait` });
        }
        return { observations: out, unknown: (key) => (balanceUnknown && BALANCE_KEYS.has(key)) || (polEmpty && key === 'pol_low') };
    }

    private async fromCounters(now: number): Promise<Observation[]> {
        const snapshot = await this.snapshot(now);
        this.snapshots.push(snapshot);
        // Keep the newest snapshot at or before the start of the longest window as its baseline.
        const longest = Math.max(TRANSFER_FAILURE_WINDOW_MS, HTTP_5XX_WINDOW_MS);
        while (this.snapshots.length >= 2 && this.snapshots[1]!.monoMs <= now - longest) this.snapshots.shift();

        const out: Observation[] = [];
        const failures = snapshot.transferFailures - this.baseline(now - TRANSFER_FAILURE_WINDOW_MS).transferFailures;
        if (failures >= TRANSFER_FAILURE_THRESHOLD) {
            out.push({
                key: 'transfers_failing',
                severity: 'critical',
                // Events, not requests: a request whose call reverts after its deadline counts as both.
                text: `${failures} on-chain reverts of relay calls or request expiries in the last ${TRANSFER_FAILURE_WINDOW_MS / 60_000} min`,
            });
        }
        const before = this.baseline(now - HTTP_5XX_WINDOW_MS).http5xx;
        const byCode: string[] = [];
        let total = 0;
        for (const [code, count] of snapshot.http5xx) {
            const delta = count - (before.get(code) ?? 0);
            if (delta <= 0) continue;
            total += delta;
            byCode.push(`${code} ${delta}`);
        }
        if (total >= HTTP_5XX_THRESHOLD) {
            out.push({ key: 'http_5xx', severity: 'warning', text: `${total} HTTP 5xx answers in the last ${HTTP_5XX_WINDOW_MS / 60_000} min (${byCode.join(', ')})` });
        }
        return out;
    }

    /** The newest snapshot taken at or before `monoMs`, else the oldest: events before the first check are not counted. */
    private baseline(monoMs: number): CounterSnapshot {
        let found = this.snapshots[0]!;
        for (const s of this.snapshots) if (s.monoMs <= monoMs) found = s;
        return found;
    }

    private async snapshot(monoMs: number): Promise<CounterSnapshot> {
        const { metrics } = this.options;
        let transferFailures = 0;
        for (const v of (await metrics.requestStatus.get()).values) if (v.labels.status === 'expired') transferFailures += v.value;
        const reverted = metrics.registry.getSingleMetric(REVERTED_ONCHAIN_METRIC);
        if (reverted) for (const v of (await reverted.get()).values) transferFailures += v.value;

        const http5xx = new Map<string, number>();
        for (const v of (await metrics.httpRequests.get()).values) {
            const status = String(v.labels.status_code ?? '');
            if (!status.startsWith('5') || QUIET_ROUTES.has(String(v.labels.route ?? ''))) continue;
            const code = String(v.labels.error_code ?? '') || 'no_code';
            http5xx.set(code, (http5xx.get(code) ?? 0) + v.value);
        }
        return { monoMs, transferFailures, http5xx };
    }

    private apply(observations: readonly Observation[], unknown: (key: string) => boolean, now: number): Transition[] {
        const transitions: Transition[] = [];
        const seen = new Set<string>();
        for (const o of observations) {
            seen.add(o.key);
            const state = this.states.get(o.key) ?? { severity: o.severity, text: o.text, seen: 0, clear: 0, firing: false, lastPostedMonoMs: now };
            this.states.set(o.key, state);
            state.severity = o.severity;
            state.text = o.text;
            state.seen += 1;
            state.clear = 0;
            if (!state.firing && state.seen >= ALERT_CONFIRM_CHECKS) {
                state.firing = true;
                state.lastPostedMonoMs = now;
                transitions.push({ kind: 'firing', key: o.key, severity: o.severity, text: o.text });
            } else if (state.firing && now - state.lastPostedMonoMs >= ALERT_REMIND_MS) {
                state.lastPostedMonoMs = now;
                transitions.push({ kind: 'reminder', key: o.key, severity: o.severity, text: o.text });
            }
        }
        for (const [key, state] of this.states) {
            if (seen.has(key)) continue;
            // Not judged by this check: a firing condition stays firing; one that has not fired yet starts over, so
            // that it fires only after ALERT_CONFIRM_CHECKS checks in a row that see it.
            if (unknown(key)) {
                if (state.firing) state.clear = 0;
                else this.states.delete(key);
                continue;
            }
            state.seen = 0;
            state.clear += 1;
            // A condition that never fired is forgotten at once; a firing one resolves after ALERT_CONFIRM_CHECKS.
            if (!state.firing) this.states.delete(key);
            else if (state.clear >= ALERT_CONFIRM_CHECKS) {
                this.states.delete(key);
                transitions.push({ kind: 'resolved', key, severity: state.severity, text: state.text });
            }
        }
        return transitions;
    }

    private log(t: Transition): void {
        const fields = { condition: t.key, alertState: t.kind, severity: t.severity };
        if (t.kind === 'resolved') this.options.logger.warn(fields, `alert resolved: ${t.text}`);
        else if (t.severity === 'critical') this.options.logger.error(fields, `ALERT: ${t.text}`);
        else this.options.logger.warn(fields, `ALERT: ${t.text}`);
    }

    private message(transitions: readonly Transition[]): string {
        const { chainId, relay } = this.options;
        const lines = transitions.map((t) => {
            const label = t.kind === 'resolved' ? 'RESOLVED' : t.kind === 'reminder' ? `STILL ${t.severity.toUpperCase()}` : t.severity.toUpperCase();
            return `${label} ${t.key}: ${t.text}`;
        });
        return [`${chainName(chainId)} relay ${relay.slice(0, 6)}…${relay.slice(-4)}`, ...lines].join('\n');
    }

    private enqueue(text: string): void {
        this.outbox.push(text);
        if (this.outbox.length > ALERT_OUTBOX_MAX) {
            this.outbox.shift();
            this.options.logger.warn({ kept: ALERT_OUTBOX_MAX }, 'alert outbox full; dropped the oldest undelivered message');
        }
    }

    /** Posts the outbox in order; stops at the first failure, or once stopped, and keeps the rest for the next check. */
    private async flush(send: AlertSend): Promise<void> {
        while (this.outbox.length > 0 && !this.stopped) {
            try {
                await send(this.outbox[0]!);
            } catch (err) {
                this.options.logger.warn({ err, pending: this.outbox.length }, 'alert delivery failed; retrying at the next check');
                return;
            }
            this.outbox.shift();
        }
    }
}

/**
 * Posts `{"text": …}` as JSON, the body incoming chat webhooks accept. The URL is a credential: it is never logged,
 * and a failure reports the HTTP status only.
 */
export function webhookSender(url: string, fetchImpl: typeof fetch = fetch): AlertSend {
    return async (text) => {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
            redirect: 'error',
            signal: AbortSignal.timeout(ALERT_SEND_TIMEOUT_MS),
        });
        await res.body?.cancel();
        if (!res.ok) throw new Error(`the alert webhook answered HTTP ${res.status}`);
    };
}

function reasonKey(reason: string): string {
    return reason.split(':', 1)[0]!.trim();
}

/** The reason without its key prefix ("nonce_gap: the chain nonce …" → "the chain nonce …"); the condition names the key. */
function reasonText(reason: string): string {
    const colon = reason.indexOf(':');
    return colon < 0 ? reason : reason.slice(colon + 1).trim();
}

function pol(wei: bigint): string {
    return `${formatEther(wei)} POL`;
}

function short(err: unknown): string {
    return String(serializeError(err).message ?? 'error').slice(0, 200);
}

function chainName(chainId: number): string {
    if (chainId === POLYGON_CHAIN_ID) return 'Polygon';
    if (chainId === AMOY_CHAIN_ID) return 'Amoy';
    return `Chain ${chainId}`;
}
