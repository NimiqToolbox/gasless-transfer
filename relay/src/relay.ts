import type { FastifyInstance } from 'fastify';
import type { Address } from 'viem';
import { AMOY_CHAIN_ID, CHAINLINK_POL_USD_POLYGON, POLYGON_CHAIN_ID } from '@nimiq/gasless-sdk/core';
import type { TxSigner } from './chain/signer.js';
import type { ChainClient } from './chain/types.js';
import { systemClock, type Clock } from './clock.js';
import {
    admissionSettings,
    DEFAULT_HTTP_LIMITS,
    DEFAULT_READINESS_CACHE_MS,
    DEFAULT_VALIDATION_TIMEOUT_MS,
    maxValidationTimeoutMs,
    type AdmissionSettings,
    type Deployment,
    type GasTable,
    type HttpServerLimits,
    type TxManagerSettings,
} from './config.js';
import { FeeEngine } from './fees/feeEngine.js';
import { ChainlinkPriceSource, type PriceSource } from './fees/priceSource.js';
import { createApp, createOpsApp } from './http/app.js';
import { cachedReadiness, checkReadiness, type ReadinessReport } from './http/readiness.js';
import { FixedWindowLimiter } from './limiter.js';
import type { Logger } from './logger.js';
import { createMetrics, type RelayMetrics } from './metrics.js';
import { transferOperation } from './operations/transfer.js';
import { OperationRegistry, type RelayContext } from './operations/types.js';
import { RpcHistoryMonitor, historyWindowOf, type RpcHistory } from './ops/rpcHistory.js';
import { TokenImplementationMonitor, type TokenImplementationPins } from './ops/tokenImplementationMonitor.js';
import { TokenDomainMonitor, type TokenDomainReading } from './ops/tokenDomainMonitor.js';
import { SubmitPipeline } from './pipeline/pipeline.js';
import { SenderAdmission } from './pipeline/senderAdmission.js';
import { buildInfo, buildRelayContext } from './startup.js';
import type { Store } from './store/types.js';
import type { TxPolicySettings } from './tx/settings.js';
import { TxManager } from './tx/txManager.js';

export interface RelaySettings {
    /**
     * Per-signer limit, and the relay-wide limit of submissions that read the chain (without submitMax: none). No
     * limit keys on network addresses.
     */
    readonly rateLimit: { signerMax: number; signerWindowMs: number; submitMax?: number; submitWindowMs?: number };
    /** RELAY_MAX_CONCURRENT_VALIDATIONS (default DEFAULT_MAX_CONCURRENT_VALIDATIONS). */
    readonly maxConcurrentValidations?: number;
    /**
     * Admission bounds; fields left out take their defaults (config.ts admissionSettings: 100 queued, a 600 s cool-down
     * per sender). A sender has at most one request queued or in flight.
     */
    readonly admission?: Partial<AdmissionSettings>;
    /**
     * Overall bound of the RPC reads of one submission (default 10 s). It is lowered to
     * maxValidationTimeoutMs(idle timeout) when the listeners' idle timeout is shorter (tests).
     */
    readonly validationTimeoutMs?: number;
    readonly feeMarginBps: number;
    readonly feeCacheMs: number;
    readonly minPolBalanceWei: bigint;
    readonly recipientDenylist: readonly Address[];
    /** Transaction-manager settings; the policy fields (src/tx/settings.ts) take their defaults when absent. */
    readonly tx: TxManagerSettings & Partial<TxPolicySettings>;
    /** Include the transaction manager's liveness in /readyz (default true). */
    readonly readinessIncludesTxManager?: boolean;
    /** How long a readiness report is reused, in ms of the relay clock (default 5000). */
    readonly readinessCacheMs?: number;
    /** Timeouts and connection cap of both listeners (default DEFAULT_HTTP_LIMITS). */
    readonly httpLimits?: HttpServerLimits;
    readonly tokenImplementationPins?: TokenImplementationPins;
    /** Waits between the attempts on one RPC within a token implementation check (default DEFAULT_RETRY_DELAYS_MS). */
    readonly tokenImplementationRetryDelaysMs?: readonly number[];
}

export interface RelayDeps {
    readonly deployment: Deployment;
    readonly gasTable: GasTable;
    readonly chain: ChainClient;
    readonly signer: TxSigner;
    readonly store: Store;
    readonly priceSource: PriceSource;
    readonly logger: Logger;
    readonly settings: RelaySettings;
    readonly clock?: Clock;
    readonly metrics?: RelayMetrics;
    /**
     * Every token's `DOMAIN_SEPARATOR()` as startup verification read it (`verifyDeployment`). The token
     * domain monitor starts from them, so a token renamed before a restart starts with its permit and
     * meta-tx refused.
     */
    readonly tokenDomainReadings?: readonly TokenDomainReading[];
    /** Startup's check of the state of older blocks (`verifyRpcHistory`); the RPC history monitor starts from it. */
    readonly rpcHistory?: readonly RpcHistory[];
}

export interface Relay {
    /** Public listener: the /v1 API, /healthz and /readyz. */
    readonly app: FastifyInstance;
    /** Internal listener: /healthz, /readyz and /metrics. */
    readonly opsApp: FastifyInstance;
    readonly ctx: RelayContext;
    readonly registry: OperationRegistry;
    readonly pipeline: SubmitPipeline;
    readonly fees: FeeEngine;
    readonly txManager: TxManager;
    /** The senders' cool-downs and held-request displacement. */
    readonly senderAdmission: SenderAdmission;
    readonly metrics: RelayMetrics;
    /** Token DOMAIN_SEPARATOR() monitor; started by startServer. */
    readonly tokenDomains: TokenDomainMonitor;
    readonly tokenImplementations?: TokenImplementationMonitor | undefined;
    /** Checks that every RPC serves the state of older blocks; started by startServer. */
    readonly rpcHistory: RpcHistoryMonitor;
    /** Cached readiness, as served by /readyz on both listeners. */
    readiness(): Promise<ReadinessReport>;
    close(): Promise<void>;
}

/** Chainlink on Polygon by default; every other chain needs an explicit oracle. */
export function createPriceSource(options: {
    feed: Address | 'default';
    chainId: number;
    chain: ChainClient;
    clock: Clock;
    cacheMs: number;
    logger?: Logger;
    metrics?: RelayMetrics;
}): PriceSource {
    const feed = options.feed === 'default' ? (options.chainId === POLYGON_CHAIN_ID ? CHAINLINK_POL_USD_POLYGON : null) : options.feed;
    if (!feed) throw new Error('RELAY_POLUSD_FEED is required on this chain');
    return new ChainlinkPriceSource({
        chain: options.chain,
        feed,
        clock: options.clock,
        cacheMs: options.cacheMs,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
    });
}

/** Wires context, operation registry, fee engine, pipeline, transaction manager and HTTP app. */
export async function createRelay(deps: RelayDeps): Promise<Relay> {
    const { deployment, gasTable, chain, signer, store, priceSource, logger, settings } = deps;
    const clock = deps.clock ?? systemClock;
    const metrics = deps.metrics ?? createMetrics();
    const ctx = buildRelayContext(deployment, signer.address, chain, settings.recipientDenylist);
    const registry = new OperationRegistry().register(transferOperation);
    const fees = new FeeEngine({
        chain,
        priceSource,
        gasTable,
        // the fee engine measures the age of its cached gas and price data (RELAY_FEE_CACHE_MS) on the
        // monotonic clock, as the readiness cache does: after a backward step of the wall clock, quotes and
        // the fee check of admission (step 5) still follow the chain.
        clock,
        minTip: settings.tx.minTip,
        marginBps: settings.feeMarginBps,
        cacheMs: settings.feeCacheMs,
    });
    const signerLimiter = new FixedWindowLimiter(settings.rateLimit.signerMax, settings.rateLimit.signerWindowMs, clock);
    const tokenDomains = new TokenDomainMonitor({ chain, tokens: deployment.tokens, clock, logger, metrics });
    if (deps.tokenDomainReadings) tokenDomains.record(deps.tokenDomainReadings);
    const tokenImplementations = settings.tokenImplementationPins
        ? new TokenImplementationMonitor({
            chain, pins: settings.tokenImplementationPins, clock, logger, metrics, retryDelaysMs: settings.tokenImplementationRetryDelaysMs,
        }) : undefined;
    await tokenImplementations?.check();
    const rpcHistory = new RpcHistoryMonitor({
        chain,
        contract: deployment.gaslessTransfer,
        deployBlock: deployment.deployBlock,
        window: historyWindowOf(deployment.chainId, settings.tx),
        clock,
        logger,
        metrics,
    });
    if (deps.rpcHistory) rpcHistory.record(deps.rpcHistory);
    const admission = admissionSettings(settings.admission);
    // in memory only; queued requests are at most RELAY_MAX_QUEUED, so twice that bounds what it
    // tracks between sweeps. A request "was sent" once it has a stored transaction (the store keeps them also when it
    // is requeued).
    const senderAdmission = new SenderAdmission(
        admission,
        clock,
        { awaitsFirstBroadcast: (id) => store.getRequest(id)?.status === 'queued' && store.listAttempts(id).length === 0 },
        2 * admission.maxQueued,
    );
    const submitLimiter = settings.rateLimit.submitMax !== undefined
        ? new FixedWindowLimiter(settings.rateLimit.submitMax, settings.rateLimit.submitWindowMs ?? 60_000, clock, 1)
        : undefined;
    const txManager = new TxManager({
        ctx,
        registry,
        store,
        signer,
        fees,
        priceSource,
        clock,
        logger,
        metrics,
        settings: settings.tx,
        tokenImplementations,
        onSenderFailure: (requestId) => {
            const sender = store.getRequest(requestId)?.signer;
            if (sender !== undefined && senderAdmission.senderFailed(sender)) metrics.admissionEvents.inc({ event: 'cooldown_started' });
        },
    });
    if (chain.rpcClients?.().length === 1 && (deployment.chainId === POLYGON_CHAIN_ID || deployment.chainId === AMOY_CHAIN_ID)) {
        // Requeues, nonce_used failures, settlement, undoing a mined outcome, changes of
        // the relay's nonce range and the POL/USD price need every configured RPC to confirm. That protects against
        // one lying or lagging RPC only if there is another one to compare with: with one RPC, it decides alone.
        logger.warn(
            { chainId: deployment.chainId },
            'only one RPC is configured (RELAY_RPC_URLS): a lying or lagging RPC cannot be detected; use at least two independent providers in production',
        );
    }
    const limits = settings.httpLimits ?? DEFAULT_HTTP_LIMITS;
    const pipeline = new SubmitPipeline({
        ctx,
        store,
        fees,
        clock,
        logger,
        metrics,
        signerLimiter,
        submitLimiter,
        maxConcurrentValidations: settings.maxConcurrentValidations,
        tokenDomains,
        tokenImplementations,
        admission,
        senderAdmission,
        // in a full queue, a request held at its spend cap gives way to a new one.
        heldQueued: () => txManager.heldInQueue(),
        // No new request while the transaction manager cannot send one.
        cannotSend: () => txManager.cannotSend(),
        // The answer must go out before the idle timeout closes the quiet connection.
        validationTimeoutMs: Math.min(settings.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS, maxValidationTimeoutMs(limits.idleTimeoutMs)),
        // Validation reads at a block at least as new as the transaction manager's last pass.
        viewHead: () => txManager.viewHead(),
        // A new request is sent at the next pass, which a wake-up brings forward (at most every WAKE_MIN_GAP_MS).
        onQueued: (priority) => txManager.wake(priority),
    });
    const includeTx = settings.readinessIncludesTxManager ?? true;
    const readiness = cachedReadiness(
        () =>
            checkReadiness({
                ctx,
                minBalanceWei: settings.minPolBalanceWei,
                priceSource,
                clock,
                txManager: includeTx ? txManager : undefined,
                txManagerStaleMs: Math.max(60_000, settings.tx.pollIntervalMs * 10),
                tokenDomains,
                tokenImplementations,
                rpcHistory,
            }),
        clock,
        settings.readinessCacheMs ?? DEFAULT_READINESS_CACHE_MS,
    );
    const app = await createApp({
        ctx,
        registry,
        pipeline,
        store,
        fees,
        clock,
        logger,
        metrics,
        info: buildInfo(ctx, deployment),
        readiness,
        http: { limits: settings.httpLimits },
        tokenDomains,
        tokenImplementations,
    });
    const opsApp = await createOpsApp({ logger, metrics, readiness, http: { limits: settings.httpLimits } });
    return {
        app,
        opsApp,
        ctx,
        registry,
        pipeline,
        fees,
        txManager,
        senderAdmission,
        metrics,
        tokenDomains,
        tokenImplementations,
        rpcHistory,
        readiness,
        async close() {
            await Promise.all([app.close(), opsApp.close()]);
            await tokenDomains.stop();
            await rpcHistory.stop();
            await tokenImplementations?.stop();
            await txManager.stop();
        },
    };
}
