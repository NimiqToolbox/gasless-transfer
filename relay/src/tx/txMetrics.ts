// Transaction-manager metrics are registered on the relay's registry
// (RelayMetrics.registry) and re-used if a second manager is built on the same registry.
import { Counter, Gauge, type Registry } from 'prom-client';

export interface TxMetrics {
    readonly gasExposurePol: Gauge;
    readonly gasBudgetPol: Gauge;
    /** Accepted requests whose call was included and reverted (the relay paid, no fee). */
    readonly revertedOnChain: Counter<'operation'>;
    /** Gas of those reverted calls, in POL. */
    readonly revertedGasPol: Counter<'operation'>;
    /**
     * Nonce anomalies: nonce_too_low, receipt_hidden, mined_by_nonce_search, nonce_invalidated, nonce_used_elsewhere,
     * requeued, next_nonce_lowered, gap_filled.
     */
    readonly nonceEvents: Counter<'event'>;
    /** 1 while the chain's latest nonce is below the lowest in-flight relay nonce with unused nonces between. */
    readonly nonceGap: Gauge;
    /** Held back by the per-request spend cap: `initial` broadcasts, `speedup`s, and `cancel` (priced out while others wait). */
    readonly spendCapHolds: Counter<'kind'>;
    /** Requests held back by their spend cap right now (queued, and in flight at their cap). */
    readonly spendCapHeld: Gauge;
    /** Blocks the oldest queued request that can be sent has waited (0: none waits). */
    readonly backlogBlocks: Gauge;
    /**
     * ALERT: a decision waited longer than RELAY_STUCK_AFTER_BLOCKS for the RPCs to agree or for on-chain evidence
     * (requeue, nonce_evidence, receipt, outcome, settle).
     */
    readonly decisionWaits: Counter<'decision'>;
    /**
     * Provisional outcomes (mined, failed, expired) that wait to settle. A pass checks at most
     * SETTLE_CHECKS_PER_PASS of them; more is reported as `settle_backlog` (degraded).
     */
    readonly unsettled: Gauge;
    /** head − finalized tag (blocks); -1 while the node does not support the tag. */
    readonly finalityLag: Gauge;
    readonly requestRows: Gauge;
    readonly requestsPruned: Counter<never>;
}

function counter<T extends string>(registry: Registry, name: string, help: string, labelNames: readonly T[]): Counter<T> {
    const existing = registry.getSingleMetric(name);
    if (existing) return existing as Counter<T>;
    return new Counter({ name, help, labelNames, registers: [registry] });
}

function gauge(registry: Registry, name: string, help: string): Gauge {
    const existing = registry.getSingleMetric(name);
    if (existing) return existing as Gauge;
    return new Gauge({ name, help, registers: [registry] });
}

export function txMetrics(registry: Registry): TxMetrics {
    return {
        gasExposurePol: gauge(registry, 'relay_gas_exposure_pol', 'Durable lifetime maximum native gas exposure (conservative, never refunded)'),
        gasBudgetPol: gauge(registry, 'relay_gas_budget_pol', 'Operator ceiling for lifetime native gas exposure'),
        revertedOnChain: counter(
            registry,
            'relay_requests_reverted_onchain_total',
            'ALERT on growth: accepted requests whose relay call was included and reverted (the relay paid gas, earned no fee)',
            ['operation'],
        ),
        revertedGasPol: counter(registry, 'relay_reverted_call_gas_pol_total', 'Gas paid for reverted relay calls, in POL', ['operation']),
        nonceEvents: counter(
            registry,
            'relay_nonce_events_total',
            'Nonce anomalies: nonce_too_low, receipt_hidden, mined_by_nonce_search, nonce_invalidated, nonce_used_elsewhere, requeued, next_nonce_lowered, gap_filled',
            ['event'],
        ),
        nonceGap: gauge(registry, 'relay_nonce_gap', '1 while unused nonces below an in-flight relay transaction hold it back'),
        spendCapHolds: counter(
            registry,
            'relay_spend_cap_holds_total',
            'Requests held back by their spend cap: initial broadcasts and speed-ups held, and in-flight requests cancelled (cancel) because they held others back',
            ['kind'],
        ),
        spendCapHeld: gauge(registry, 'relay_spend_cap_held', 'Requests held back by their spend cap right now (queued, and in flight at their cap)'),
        backlogBlocks: gauge(registry, 'relay_queue_backlog_blocks', 'Blocks the oldest queued request that can be sent has waited (0: none)'),
        decisionWaits: counter(
            registry,
            'relay_decision_waits_total',
            'ALERT: a decision waited longer than RELAY_STUCK_AFTER_BLOCKS for the RPCs to agree or for on-chain evidence',
            ['decision'],
        ),
        unsettled: gauge(
            registry,
            'relay_unsettled_requests',
            'Provisional outcomes (mined, failed, expired) waiting to settle; more than a pass checks is reported as settle_backlog',
        ),
        finalityLag: gauge(registry, 'relay_finality_lag_blocks', 'Blocks between head and the finalized tag (-1: tag unsupported)'),
        requestRows: gauge(registry, 'relay_request_rows', 'Requests stored in the database (all states)'),
        requestsPruned: counter(registry, 'relay_requests_pruned_total', 'Settled requests deleted after the retention period', []),
    };
}
