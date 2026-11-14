import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics (§6.6). One registry per relay instance so tests stay isolated. */
export interface RelayMetrics {
    readonly registry: Registry;
    /** HTTP requests by route, status and error code. */
    readonly httpRequests: Counter<'method' | 'route' | 'status_code' | 'error_code'>;
    /** Connections closed on accept because the listener already held RELAY_HTTP_MAX_CONNECTIONS. */
    readonly httpConnectionsRefused: Counter<'listener'>;
    /** Submissions by operation and outcome (`accepted`, `duplicate` or the error code). */
    readonly submissions: Counter<'operation' | 'outcome'>;
    /** Request status transitions (`queued`, `submitted`, `mined`, `confirmed`, `failed`, `expired`). */
    readonly requestStatus: Counter<'operation' | 'status'>;
    /**
     * Admission events: `sender_cooldown`, a submission refused (429) because its sender cools down and has a request
     * queued or in flight; `cooldown_started`, a sender's request failed its check before the broadcast for a reason
     * the sender controls; `evicted`, a queued request held at its spend cap gave way to a new request in a full queue;
     * `sender_eviction`, a submission refused (503) in a full queue with held requests because its sender may not make
     * one give way now (its request that took a held place was not sent yet, or it cools down); `validation_busy` and
     * `validation_rate`, submissions refused (503) by the relay-wide bounds of RELAY_MAX_CONCURRENT_VALIDATIONS and
     * RELAY_RATE_LIMIT_SUBMIT_MAX; `retention_full`, retained-row capacity reached; `cannot_send`, a submission refused
     * (503) because the transaction manager cannot send (TxManager.cannotSend); `unsent_history_dropped`, the history
     * of a request that was never sent gave way to a new request at the retained-row capacity.
     */
    readonly admissionEvents: Counter<'event'>;
    readonly timeToMine: Histogram<'operation'>;
    readonly timeToConfirm: Histogram<'operation'>;
    readonly polBalance: Gauge;
    /** Fees earned by mined requests, in USD (USDC and USDT0 count as $1). */
    readonly feeRevenueUsd: Counter<'token'>;
    /** Gas paid for every mined relay transaction (calls, reverted calls, cancels), in POL and USD. */
    readonly gasCostPol: Counter<'kind'>;
    readonly gasCostUsd: Counter<'kind'>;
    /** 1 when a validated Chainlink price is available, 0 otherwise. */
    readonly priceSource: Gauge<'source'>;
    readonly polUsd: Gauge;
    /** Alert: no usable Chainlink price is available. */
    readonly priceUnavailable: Counter<'reason'>;
    readonly queueDepth: Gauge;
    readonly txInFlight: Gauge;
    readonly txBroadcasts: Counter<'kind' | 'outcome'>;
    readonly txManagerErrors: Counter;
    /** ALERT when 1: the token's on-chain DOMAIN_SEPARATOR() differs from the configured domain. */
    readonly tokenDomainMismatch: Gauge<'token'>;
    readonly tokenImplementationUnavailable: Gauge<'token'>;
    watchTokenImplementations(probe: () => readonly { token: string; unavailable: boolean }[]): void;
    /** Failed attempts of the token implementation verification by RPC position (1-based), stage and reason. */
    readonly tokenImplementationCheckFailures: Counter<'rpc' | 'stage' | 'reason'>;
    /** Failed reads of the periodic checks (`token_domain`). */
    readonly monitorErrors: Counter<'monitor'>;
    /** JSON-RPC requests by RPC position (1-based), method and outcome (`ok` or RpcFailureReason). */
    readonly rpcRequests: Counter<'rpc' | 'method' | 'outcome'>;
    readonly rpcRequestSeconds: Histogram<'rpc'>;
    /** Blocks between an RPC's latest reported head and the highest latest head of any configured RPC. */
    readonly rpcHeadLag: Gauge<'rpc'>;
    /** ALERT when 1: the RPC (position, 1-based) failed the last check of the state of older blocks (ops/rpcHistory.ts). */
    readonly rpcHistoryUnavailable: Gauge<'rpc'>;
}

const RPC_SECONDS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20];

const SECONDS_BUCKETS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1800, 3600];

export function createMetrics(options: { defaultMetrics?: boolean } = {}): RelayMetrics {
    const registry = new Registry();
    if (options.defaultMetrics) collectDefaultMetrics({ register: registry, prefix: 'relay_' });
    const registers = [registry];
    let implementationProbe: (() => readonly { token: string; unavailable: boolean }[]) | undefined;
    return {
        registry,
        watchTokenImplementations(probe) { implementationProbe = probe; },
        httpRequests: new Counter({
            name: 'relay_http_requests_total',
            help: 'HTTP requests by method, route, status code and error code',
            labelNames: ['method', 'route', 'status_code', 'error_code'] as const,
            registers,
        }),
        httpConnectionsRefused: new Counter({
            name: 'relay_http_connections_refused_total',
            help: 'Connections closed on accept because the listener already holds RELAY_HTTP_MAX_CONNECTIONS',
            labelNames: ['listener'] as const,
            registers,
        }),
        submissions: new Counter({
            name: 'relay_submissions_total',
            help: 'Submitted requests by operation and outcome (accepted, duplicate or error code)',
            labelNames: ['operation', 'outcome'] as const,
            registers,
        }),
        requestStatus: new Counter({
            name: 'relay_request_status_total',
            help: 'Request status transitions',
            labelNames: ['operation', 'status'] as const,
            registers,
        }),
        admissionEvents: new Counter({
            name: 'relay_admission_events_total',
            help: 'Admission events: sender_cooldown (429 refusal), cooldown_started, evicted (a held request gave way in a full queue), sender_eviction (503: the sender may not make a held request give way now), validation_busy and validation_rate (503: relay-wide submission bounds), retention_full, cannot_send (503: the transaction manager cannot send; see /readyz), unsent_history_dropped (the history of a request that was never sent gave way at the retained-row capacity)',
            labelNames: ['event'] as const,
            registers,
        }),
        timeToMine: new Histogram({
            name: 'relay_time_to_mine_seconds',
            help: 'Seconds from acceptance to inclusion',
            labelNames: ['operation'] as const,
            buckets: SECONDS_BUCKETS,
            registers,
        }),
        timeToConfirm: new Histogram({
            name: 'relay_time_to_confirm_seconds',
            help: 'Seconds from acceptance to finality (confirmed)',
            labelNames: ['operation'] as const,
            buckets: SECONDS_BUCKETS,
            registers,
        }),
        polBalance: new Gauge({ name: 'relay_pol_balance', help: 'Relay account POL balance', registers }),
        feeRevenueUsd: new Counter({
            name: 'relay_fee_revenue_usd_total',
            help: 'Fees of mined requests in USD (stablecoins at $1)',
            labelNames: ['token'] as const,
            registers,
        }),
        gasCostPol: new Counter({
            name: 'relay_gas_cost_pol_total',
            help: 'Gas paid by the relay for mined transactions, in POL',
            labelNames: ['kind'] as const,
            registers,
        }),
        gasCostUsd: new Counter({
            name: 'relay_gas_cost_usd_total',
            help: 'Gas paid by the relay for mined transactions, in USD at the price used at the time',
            labelNames: ['kind'] as const,
            registers,
        }),
        priceSource: new Gauge({
            name: 'relay_price_source',
            help: 'Active POL/USD price source (1 = active)',
            labelNames: ['source'] as const,
            registers,
        }),
        polUsd: new Gauge({ name: 'relay_pol_usd', help: 'POL/USD price in use', registers }),
        priceUnavailable: new Counter({
            name: 'relay_price_unavailable_total',
            help: 'ALERT: no usable Chainlink POL/USD price; pricing unavailable',
            labelNames: ['reason'] as const,
            registers,
        }),
        queueDepth: new Gauge({ name: 'relay_queue_depth', help: 'Queued requests', registers }),
        txInFlight: new Gauge({ name: 'relay_tx_in_flight', help: 'Submitted, not yet mined requests', registers }),
        txBroadcasts: new Counter({
            name: 'relay_tx_broadcasts_total',
            help: 'Transaction broadcasts by kind (initial, speedup, cancel, rebroadcast, filler, filler_rebroadcast, filler_speedup) and outcome',
            labelNames: ['kind', 'outcome'] as const,
            registers,
        }),
        txManagerErrors: new Counter({
            name: 'relay_tx_manager_errors_total',
            help: 'Transaction manager ticks that failed (usually RPC errors)',
            registers,
        }),
        tokenImplementationUnavailable: new Gauge({
            name: 'relay_token_implementation_unavailable',
            help: 'Token implementation verification unavailable, mismatched or stale (1 = all modes held)',
            labelNames: ['token'] as const,
            registers,
            collect() {
                for (const entry of implementationProbe?.() ?? []) this.set({ token: entry.token }, entry.unavailable ? 1 : 0);
            },
        }),
        tokenDomainMismatch: new Gauge({
            name: 'relay_token_domain_mismatch',
            help: 'ALERT when 1: the token DOMAIN_SEPARATOR() no longer matches the configured domain; permit and meta-tx requests are refused',
            labelNames: ['token'] as const,
            registers,
        }),
        tokenImplementationCheckFailures: new Counter({
            name: 'relay_token_implementation_check_failures_total',
            help: 'Failed attempts of the token implementation verification by RPC position (1-based), stage and reason',
            labelNames: ['rpc', 'stage', 'reason'] as const,
            registers,
        }),
        monitorErrors: new Counter({
            name: 'relay_monitor_errors_total',
            help: 'Failed reads of the periodic token domain checks',
            labelNames: ['monitor'] as const,
            registers,
        }),
        rpcRequests: new Counter({
            name: 'relay_rpc_requests_total',
            help: 'JSON-RPC requests by RPC position in RELAY_RPC_URLS (1-based), method and outcome (ok or the failure reason)',
            labelNames: ['rpc', 'method', 'outcome'] as const,
            registers,
        }),
        rpcRequestSeconds: new Histogram({
            name: 'relay_rpc_request_duration_seconds',
            help: 'JSON-RPC request duration by RPC position in RELAY_RPC_URLS (1-based), including viem retries',
            labelNames: ['rpc'] as const,
            buckets: RPC_SECONDS_BUCKETS,
            registers,
        }),
        rpcHeadLag: new Gauge({
            name: 'relay_rpc_head_lag_blocks',
            help: 'Blocks the RPC\'s head was behind the highest head another configured RPC reported in the 5 s before, when it last reported one',
            labelNames: ['rpc'] as const,
            registers,
        }),
        rpcHistoryUnavailable: new Gauge({
            name: 'relay_rpc_history_unavailable',
            help: 'ALERT when 1: the RPC (position in RELAY_RPC_URLS, 1-based) does not serve the state of older blocks that the search for the use of an intent nonce reads',
            labelNames: ['rpc'] as const,
            registers,
        }),
    };
}
