import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type { Hex } from 'viem';
import { z } from 'zod';
import { QUOTE_TTL_SECONDS, type TransferRequest } from '@nimiq/gasless-sdk/core';
import {
    ERROR_HTTP_STATUS,
    type ErrorCode,
    type FeeResponse,
    type InfoResponse,
    type OperationName,
    type RequestState,
    type RequestTransaction,
} from '@nimiq/gasless-sdk/relay';
import { nowSeconds, type Clock } from '../clock.js';
import { DEFAULT_HTTP_LIMITS, type HttpServerLimits } from '../config.js';
import { RelayError, errorResponse } from '../errors.js';
import type { FeeContext, FeeEngine } from '../fees/feeEngine.js';
import type { Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';
import { formatZodError, zAddress } from '../operations/schemas.js';
import type { OperationRegistry, RelayContext, TokenDomainStatus } from '../operations/types.js';
import type { TokenImplementationMonitor } from '../ops/tokenImplementationMonitor.js';
import type { SubmitPipeline } from '../pipeline/pipeline.js';
import type { RequestRecord, Store, TxAttemptRecord } from '../store/types.js';
import { formatFixed } from '../util/bigint.js';
import { BYTES32_RE } from '../util/validation.js';
import type { ReadinessReport } from './readiness.js';

/** §6.3 step 1: bodies above 16 KB are rejected with `invalid_request`. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * The listeners do not tell clients apart by network address: no limit keys on it, no proxy header is read, and no
 * address is logged. Submissions are bounded per signer and relay-wide in the pipeline; the other routes are cheap
 * (static, cached or one database read).
 */
export interface HttpSettings {
    /** Timeouts and connection cap of the server (default DEFAULT_HTTP_LIMITS). */
    readonly limits?: HttpServerLimits | undefined;
}

export interface AppDeps {
    readonly ctx: RelayContext;
    readonly registry: OperationRegistry;
    readonly pipeline: SubmitPipeline;
    readonly store: Store;
    readonly fees: FeeEngine;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly metrics: RelayMetrics;
    readonly info: InfoResponse;
    /** Cached readiness (readiness.ts `cachedReadiness`): /readyz is public, so it must be cheap. */
    readonly readiness: () => Promise<ReadinessReport>;
    readonly http: HttpSettings;
    /** Token domain state: quotes for token signatures of an affected token are refused. */
    readonly tokenDomains?: TokenDomainStatus | undefined;
    readonly tokenImplementations?: TokenImplementationMonitor | undefined;
}

/** The internal listener: /healthz, /readyz and /metrics only (see relay/README.md, "Listeners"). */
export interface OpsAppDeps {
    readonly logger: Logger;
    readonly metrics: RelayMetrics;
    readonly readiness: () => Promise<ReadinessReport>;
    readonly http: Pick<HttpSettings, 'limits'>;
}

const zFeeQuery = z.strictObject({
    operation: z.string().min(1).max(64),
    token: zAddress,
    authMode: z.enum(['none', 'permit', 'metaTxApprove']),
});

const zRequestParams = z.strictObject({ id: z.string().regex(BYTES32_RE) });

/** Probe routes: not logged per request, and their answers (a 503 from /readyz) are not counted as HTTP errors in alerts. */
export const QUIET_ROUTES: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Node enforces requestTimeout and headersTimeout only when it sweeps its connections, every
 * `connectionsCheckingInterval` (default 30 s). A 1 s sweep makes the configured timeouts the real bound
 * on how long a slow client can hold a connection.
 */
const CONNECTIONS_CHECK_INTERVAL_MS = 1000;

/** Maps any error to the wire error shape and the frozen status mapping. */
export function toWireError(error: unknown): { code: ErrorCode; message: string } {
    if (error instanceof RelayError) return { code: error.code, message: error.message };
    const e = error as { code?: unknown; statusCode?: unknown };
    switch (e.code) {
        case 'FST_ERR_CTP_BODY_TOO_LARGE':
            return { code: 'invalid_request', message: `request body exceeds ${MAX_BODY_BYTES} bytes` };
        case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
            return { code: 'invalid_request', message: 'content-type must be application/json' };
        case 'FST_ERR_CTP_EMPTY_JSON_BODY':
            return { code: 'invalid_request', message: 'request body must not be empty' };
        default:
            break;
    }
    if (e.statusCode === 429) return { code: 'rate_limited', message: 'rate limit exceeded' };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
        return { code: 'invalid_request', message: error instanceof SyntaxError ? 'request body is not valid JSON' : 'malformed request' };
    }
    return { code: 'internal_error', message: 'internal error' };
}

/** `GET /v1/requests/:id` view. Cancel transactions are internal and not listed. */
export function toRequestState(record: RequestRecord, attempts: readonly TxAttemptRecord[]): RequestState {
    const calls = attempts.filter((a) => a.kind === 'call');
    const transactions: RequestTransaction[] = calls.map((a) => ({
        hash: a.hash,
        txNonce: a.txNonce,
        maxFeePerGas: a.maxFeePerGas.toString(),
        status: a.status,
    }));
    let txHash: Hex | null;
    switch (record.status) {
        case 'queued':
            txHash = null;
            break;
        case 'submitted':
            txHash = calls.at(-1)?.hash ?? null;
            break;
        default:
            // mined/confirmed: the included transaction (also after a speed-up); failed/expired: a reverted one, if any.
            txHash = record.finalTxHash;
    }
    return {
        id: record.id,
        operation: record.operation,
        status: record.status,
        request: record.request as TransferRequest,
        // Identifies the token authorization (with `request` it hashes to `id`) without revealing its signature.
        authHash: record.authHash,
        transactions,
        txHash,
        blockNumber: record.blockNumber !== null ? record.blockNumber.toString() : null,
        error: record.error ? { code: record.error.code, message: record.error.message } : null,
    };
}

interface BaseOptions {
    /** Label of the connection metric: `public` or `internal`. */
    readonly listener: 'public' | 'internal';
    readonly logger: Logger;
    readonly metrics: RelayMetrics;
    readonly limits: HttpServerLimits;
    /** Answer cross-origin requests from any origin (public listener only; no CORS on the internal listener). */
    readonly cors?: boolean;
    readonly readiness: () => Promise<ReadinessReport>;
    /**
     * The body of /readyz besides its status code: the whole report on the internal listener, only
     * `{ready, degraded}` on the public one (the report holds the relay's POL balance, error messages and
     * the transaction manager's state, which are operator information).
     */
    readonly readinessBody: 'report' | 'summary';
}

/**
 * Shared by both listeners: Fastify with the server limits, JSON only, the wire
 * error mapping, one metric and one log line per request (without bodies or network addresses), and the routes
 * /healthz and /readyz.
 */
async function createBase(o: BaseOptions): Promise<FastifyInstance> {
    const errorCodes = new WeakMap<FastifyRequest, ErrorCode>();
    const app = Fastify({
        loggerInstance: o.logger,
        bodyLimit: MAX_BODY_BYTES,
        // No proxy header is trusted or read: nothing uses the client's address.
        trustProxy: false,
        // Fastify's own request logs are off; one concise line per request is logged in onResponse (no bodies).
        logController: new LogController({ disableRequestLogging: true }),
        return503OnClosing: true,
        // Slow clients: a request must arrive completely within requestTimeout (408 otherwise), and
        // silent or idle connections are closed.
        requestTimeout: o.limits.requestTimeoutMs,
        keepAliveTimeout: o.limits.keepAliveTimeoutMs,
        connectionTimeout: o.limits.idleTimeoutMs,
        http: { connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS },
    }) as unknown as FastifyInstance;
    app.server.headersTimeout = o.limits.headersTimeoutMs;
    // One cap shared by all connections; Node closes connections beyond it as soon as they are accepted. A TLS proxy
    // in front holds the client connections.
    app.server.maxConnections = o.limits.maxConnections;
    app.server.on('drop', () => o.metrics.httpConnectionsRefused.inc({ listener: o.listener }));

    // JSON only (no text/plain "simple request" bodies).
    app.removeContentTypeParser('text/plain');

    app.setErrorHandler((error, request, reply) => {
        const wire = toWireError(error);
        errorCodes.set(request, wire.code);
        if (wire.code === 'internal_error') request.log.error({ err: error }, 'unhandled error');
        void reply.code(ERROR_HTTP_STATUS[wire.code]).send(errorResponse(wire.code, wire.message));
    });

    app.addHook('onResponse', async (request, reply) => {
        const route = request.routeOptions.url ?? 'unmatched';
        const code = errorCodes.get(request) ?? '';
        o.metrics.httpRequests.inc({ method: request.method, route, status_code: String(reply.statusCode), error_code: code });
        if (!QUIET_ROUTES.has(route)) {
            request.log.info(
                { method: request.method, route, statusCode: reply.statusCode, errorCode: code || undefined, ms: Math.round(reply.elapsedTime) },
                'http request',
            );
        }
    });

    // Every origin: self-hosted Wallet, Hub and Keyguard instances call the relay from their own origins. Requests carry
    // no credentials, and the signed intent, not the origin, authorizes a transfer.
    if (o.cors) {
        await app.register(cors, {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['content-type'],
            maxAge: 600,
        });
    }

    app.setNotFoundHandler((request, reply) => {
        errorCodes.set(request, 'not_found');
        void reply.code(404).send(errorResponse('not_found', 'not found'));
    });

    // Liveness: no I/O at all.
    app.get('/healthz', async () => ({ status: 'ok' }));

    // Readiness is served from the readiness cache: however often it is requested, the relay makes at most one set of
    // reads per cache period.
    app.get('/readyz', async (_request, reply) => {
        const report = await o.readiness();
        void reply.code(report.ready ? 200 : 503);
        return o.readinessBody === 'report' ? report : { ready: report.ready, degraded: report.degraded };
    });

    return app;
}

/**
 * The internal listener (RELAY_OPS_HOST:RELAY_OPS_PORT): /healthz, the full /readyz report and
 * /metrics. /metrics (revenue, balances, error counters) is only served here, never on the public
 * listener. No CORS.
 */
export async function createOpsApp(deps: OpsAppDeps): Promise<FastifyInstance> {
    const app = await createBase({
        listener: 'internal',
        logger: deps.logger,
        metrics: deps.metrics,
        limits: deps.http.limits ?? DEFAULT_HTTP_LIMITS,
        readiness: deps.readiness,
        readinessBody: 'report',
    });
    app.get('/metrics', async (_request, reply) => {
        void reply.header('content-type', deps.metrics.registry.contentType);
        return deps.metrics.registry.metrics();
    });
    await app.ready();
    return app;
}

/** The public listener (RELAY_HOST:RELAY_PORT): the /v1 API, /healthz and /readyz (status only). */
export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
    const app = await createBase({
        listener: 'public',
        logger: deps.logger,
        metrics: deps.metrics,
        limits: deps.http.limits ?? DEFAULT_HTTP_LIMITS,
        cors: true,
        readiness: deps.readiness,
        readinessBody: 'summary',
    });

    app.get('/v1/info', async () => deps.info);

    app.get('/v1/fee', async (request): Promise<FeeResponse> => {
        const parsed = zFeeQuery.safeParse(request.query);
        if (!parsed.success) throw new RelayError('invalid_request', formatZodError(parsed.error));
        const query = parsed.data;
        if (!deps.registry.get(query.operation)) {
            throw new RelayError('unsupported_operation', `operation ${query.operation.slice(0, 64)} is not supported`);
        }
        const token = deps.ctx.tokens.get(query.token.toLowerCase());
        if (!token) throw new RelayError('unsupported_token', `token ${query.token} is not supported`);
        if (!token.authModes.includes(query.authMode)) {
            throw new RelayError('unsupported_auth_mode', `${token.symbol} does not support authorization mode ${query.authMode}`);
        }
        const implementationUnavailable = deps.tokenImplementations?.tokenUnavailable(token.address);
        if (implementationUnavailable) throw new RelayError('unavailable', implementationUnavailable);
        if (query.authMode !== 'none') {
            const unavailable = deps.tokenDomains?.tokenSignaturesUnavailable(token.address);
            if (unavailable) throw new RelayError('unsupported_auth_mode', unavailable);
        }
        let context: FeeContext;
        try {
            context = await deps.fees.context();
        } catch (err) {
            request.log.warn({ err }, 'fee context unavailable');
            throw new RelayError('unavailable', 'The relay cannot reach the chain right now; try again later');
        }
        const quote = deps.fees.quote(query.operation, query.authMode, context);
        const issuedAt = nowSeconds(deps.clock);
        return {
            operation: query.operation as OperationName,
            token: token.address,
            authMode: query.authMode,
            fee: quote.fee.toString(),
            relay: deps.ctx.relay,
            gasUnits: quote.gasUnits.toString(),
            gasPrice: context.priceGas.toString(),
            polUsd: formatFixed(context.price.value, context.price.decimals),
            issuedAt,
            expiresAt: issuedAt + QUOTE_TTL_SECONDS,
            quoteId: randomUUID(),
        };
    });

    app.post('/v1/transfer', async (request, reply) => {
        const op = deps.registry.get('transfer');
        if (!op) throw new RelayError('unsupported_operation', 'transfer is not enabled');
        // once the connection is gone, nobody can receive the answer, so the pipeline must not
        // store the request any more (a wallet that saw only a network error may sign it again).
        const gone = new AbortController();
        const onClose = (): void => {
            if (!reply.raw.writableEnded) gone.abort();
        };
        reply.raw.once('close', onClose);
        try {
            const result = await deps.pipeline.submit(op, request.body, { signal: gone.signal });
            void reply.code(result.statusCode);
            return result.body;
        } finally {
            reply.raw.off('close', onClose);
        }
    });

    app.get('/v1/requests/:id', async (request): Promise<RequestState> => {
        const parsed = zRequestParams.safeParse(request.params);
        if (!parsed.success) throw new RelayError('invalid_request', 'id must be 0x + 64 hex characters');
        const record = deps.store.getRequest(parsed.data.id.toLowerCase() as Hex);
        if (!record) throw new RelayError('not_found', 'unknown request id');
        return toRequestState(record, deps.store.listAttempts(record.id));
    });

    await app.ready();
    return app;
}
