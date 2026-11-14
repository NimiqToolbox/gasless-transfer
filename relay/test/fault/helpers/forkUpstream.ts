// The fork's way to the fork RPC (POLYGON_RPC_URL). anvil reads every state it has not cached from that RPC
// while it serves a request, and fails the request when one of those reads gets no answer within its fork timeout
// (it does not retry a timeout, whatever --retries says) or a rate-limit answer it does not recognise (a JSON-RPC
// error with a provider-specific code such as 29); only HTTP 429 and a few provider codes it retries itself. Without a
// retry, one stalled read of a public RPC costs the test anvil's whole fork timeout and then fails the request
// that needed it: in the setup (forge script, the relay's startup checks) the whole file. So anvil forks this local
// proxy, which retries such reads within a budget below anvil's fork timeout. It forwards anvil's requests and the
// answers unchanged (only state reads; nothing is ever sent to the chain) and counts every retry.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface ForkUpstreamOptions {
    /** One attempt's timeout (the public RPC answers within about a second). */
    readonly attemptTimeoutMs?: number;
    /** All attempts of one request: below anvil's fork timeout (ANVIL_FORK_OPTIONS), which ends the request. */
    readonly budgetMs?: number;
    /** Wait before the first retry; doubles per retry up to maxBackoffMs (a Retry-After header within it is honoured). */
    readonly backoffMs?: number;
    readonly maxBackoffMs?: number;
    /** Requests to the fork RPC at a time (anvil sends up to about 80 at once). */
    readonly maxInFlight?: number;
    /** Called before every retry. */
    readonly onRetry?: (retry: ForkUpstreamRetry) => void;
}

export interface ForkUpstreamRetry {
    readonly method: string;
    readonly attempt: number;
    readonly reason: string;
    readonly elapsedMs: number;
}

export interface ForkUpstreamStats {
    /** Requests anvil sent. */
    requests: number;
    /** Requests that needed a retry. */
    retried: number;
    /** Requests that ran out of the budget (anvil got the last answer, or none). */
    gaveUp: number;
    /** Failed attempts by reason. */
    reasons: Record<string, number>;
    /** Longest time to an answer, retries included. */
    maxMs: number;
}

export const FORK_UPSTREAM_DEFAULTS = {
    attemptTimeoutMs: 20_000,
    budgetMs: 90_000,
    backoffMs: 500,
    maxBackoffMs: 8_000,
    maxInFlight: 32,
} as const;

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// Rate limits as the relay classifies them (src/chain/viemChainClient.ts), plus code 29 and "try again later".
const RATE_LIMIT_CODES = new Set([29, 429, -32005, -32007, -32029]);
const TRANSIENT_TEXT = /too many request|rate.?limit|request limit|limit exceeded|throttl|try again|temporar|timed? ?out|unavailable|overload|busy|header not found|missing trie node/i;

interface Answer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
    readonly retryAfterMs: number | undefined;
}

/**
 * Why an answer of the fork RPC is worth another attempt, or undefined when it is final: an HTTP status of a
 * passing failure, a body that is not JSON, or a JSON-RPC error of a rate limit or a passing failure (in any element
 * of a batch). Other errors (such as -32601 for a method the RPC does not offer) are final.
 */
export function transientReason(status: number, body: string): string | undefined {
    if (RETRY_STATUS.has(status)) return `HTTP ${status}`;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return `HTTP ${status} without JSON`;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const error = (item as { error?: { code?: unknown; message?: unknown } } | null)?.error;
        if (!error) continue;
        const code = typeof error.code === 'number' ? error.code : undefined;
        const message = typeof error.message === 'string' ? error.message : '';
        if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || TRANSIENT_TEXT.test(message)) return `rpc ${code ?? '?'} ${message.slice(0, 60)}`;
    }
    return undefined;
}

function methodOf(body: string): string {
    try {
        const parsed = JSON.parse(body) as { method?: unknown } | Array<{ method?: unknown }>;
        return Array.isArray(parsed) ? `batch of ${parsed.length}` : String(parsed.method);
    } catch {
        return '?';
    }
}

function retryAfterMs(value: string | null): number | undefined {
    const seconds = value === null ? NaN : Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class ForkUpstream {
    readonly stats: ForkUpstreamStats = { requests: 0, retried: 0, gaveUp: 0, reasons: {}, maxMs: 0 };
    url = '';
    private readonly options: Required<Omit<ForkUpstreamOptions, 'onRetry'>> & Pick<ForkUpstreamOptions, 'onRetry'>;
    private server: Server | undefined;
    private readonly sockets = new Set<Socket>();
    private readonly closing = new AbortController();
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(
        private readonly target: string,
        options: ForkUpstreamOptions = {},
    ) {
        this.options = { ...FORK_UPSTREAM_DEFAULTS, ...options };
    }

    async start(): Promise<this> {
        this.server = createServer((req, res) => void this.handle(req, res));
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        this.server.listen(0, '127.0.0.1');
        await once(this.server, 'listening');
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        return this;
    }

    async stop(): Promise<void> {
        this.closing.abort();
        for (const socket of this.sockets) socket.destroy();
        if (this.server) {
            this.server.close();
            await once(this.server, 'close').catch(() => undefined);
        }
    }

    /** One slot of maxInFlight; a finished request hands its slot to the next waiting one. */
    private async slot<T>(work: () => Promise<T>): Promise<T> {
        if (this.active < this.options.maxInFlight) this.active++;
        else await new Promise<void>((resolve) => this.waiting.push(resolve));
        try {
            return await work();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        }
    }

    private async attempt(body: string, timeoutMs: number): Promise<Answer | { failure: string }> {
        try {
            const res = await fetch(this.target, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: AbortSignal.any([this.closing.signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
            });
            const text = await res.text();
            return { status: res.status, body: text, contentType: res.headers.get('content-type') ?? 'application/json', retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
        } catch (err) {
            const e = err as { name?: string; cause?: { code?: string } };
            // (The last attempt before the deadline may have had less time; the reason names the configured timeout.)
            return { failure: e.name === 'TimeoutError' ? `no answer within ${this.options.attemptTimeoutMs / 1000} s` : `transport ${e.cause?.code ?? e.name ?? 'error'}` };
        }
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString('utf8');
        const method = methodOf(body);
        const started = Date.now();
        const deadline = started + this.options.budgetMs;
        this.stats.requests++;
        let last: Answer | undefined;
        for (let attempt = 1; ; attempt++) {
            const answer = await this.slot(() => this.attempt(body, Math.min(this.options.attemptTimeoutMs, deadline - Date.now())));
            if (this.closing.signal.aborted) {
                res.destroy();
                return;
            }
            let reason: string;
            if ('failure' in answer) {
                reason = answer.failure;
            } else {
                last = answer;
                const transient = transientReason(answer.status, answer.body);
                if (transient === undefined) {
                    this.stats.maxMs = Math.max(this.stats.maxMs, Date.now() - started);
                    res.writeHead(answer.status, { 'content-type': answer.contentType }).end(answer.body);
                    return;
                }
                reason = transient;
            }
            this.stats.reasons[reason] = (this.stats.reasons[reason] ?? 0) + 1;
            const backoff = Math.min(this.options.maxBackoffMs, this.options.backoffMs * 2 ** (attempt - 1));
            const retryAfter = 'failure' in answer ? undefined : answer.retryAfterMs;
            const wait = Math.min(this.options.maxBackoffMs, Math.max(backoff, retryAfter ?? 0));
            if (Date.now() + wait >= deadline) {
                this.stats.gaveUp++;
                this.stats.maxMs = Math.max(this.stats.maxMs, Date.now() - started);
                if (last) res.writeHead(last.status, { 'content-type': last.contentType }).end(last.body);
                else res.writeHead(504, { 'content-type': 'text/plain' }).end(`fork upstream: ${reason}`);
                return;
            }
            if (attempt === 1) this.stats.retried++;
            this.options.onRetry?.({ method, attempt, reason, elapsedMs: Date.now() - started });
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }
}
