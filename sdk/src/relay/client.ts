// Relay API client (§6.2, §7). Only depends on `fetch`.
//
// Trust model: the relay is checked against the client's pins before it gets anything signed.
// `info()` refuses any mismatch; `fee()` and `submitTransfer()` verify /v1/info first (once per
// client) and send nothing to a relay whose identity differs from the signed `request.relay`.
// Returned ids are recomputed locally from the request and its token authorization (EIP-712 digest),
// so a relay cannot report the state of a different request.

import { sameAddress } from '../core/address.js';
import { deepFreeze } from '../core/bytes.js';
import { FEE_GRANULARITY } from '../core/constants.js';
import { transferDigest, transferDigestFromAuthHash } from '../core/eip712.js';
import { GaslessValidationError } from '../core/errors.js';
import { findPinnedToken, sameDomain, type ChainPins } from '../core/pins.js';
import type { Address, AuthModeName, DecimalString, Hex } from '../core/types.js';
import { assertUnixSeconds, checkAcceptableFee, parseMaxAcceptableFee, validateSubmitTransferBody } from '../core/validate.js';
import { RelayApiError, RelayClientError, RelayPinMismatchError, RelayRequestFailedError } from './errors.js';
import { parseErrorBody, parseFee, parseInfo, parseRequestState, parseSubmit } from './parse.js';
import type { FeeResponse, InfoResponse, RequestState, RequestStatus, SubmitResponse, SubmitTransferBody } from './types.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RelayClientOptions {
    readonly pins: ChainPins;
    /** Defaults to `globalThis.fetch`. */
    readonly fetch?: FetchLike;
    /** Timeout of a single HTTP request in ms (default 15 000). */
    readonly requestTimeoutMs?: number;
    /**
     * Clock in unix seconds (default: system clock). Used for the deadline checks before submitting and for
     * the settle margin of `waitForRequest`.
     */
    readonly now?: () => number;
    /**
     * Allows a plain `http://` base URL for hosts other than localhost, 127.0.0.1 and [::1] (default false).
     * Only for a relay on a private test network, such as the compose stack. Never set it in a wallet: every
     * signed body, including never-expiring META_TX approvals, would cross the network unencrypted.
     */
    readonly allowInsecureHttp?: boolean;
}

export interface CallOptions {
    readonly signal?: AbortSignal;
}

export interface SubmitTransferOptions extends CallOptions {
    /**
     * This body was posted before and the answer was unclear (a timeout, a network error, an invalid response, or
     * the relay's `internal_error`): post it again without the client-side deadline window. A relay
     * answers an identical body it stored with 200 and the current state before any policy check, also after the
     * deadline, so a late re-post still finds out whether the first post was stored. The pins, the body's shape and
     * its signature format are checked as for any post, and the body must be signed for the verified relay.
     */
    readonly repost?: boolean;
}

export interface WaitForRequestOptions extends CallOptions {
    /** Give up after this many ms (default 600 000, the default intent lifetime). */
    readonly timeoutMs?: number;
    /**
     * Delay between polls in ms (default 1000). A poll is one database read on the relay; the relay notices an inclusion
     * within about half a second of its block, so a shorter delay shows `mined` sooner. After failed polls (network
     * errors, timeouts, 429, 5xx) the delay doubles each time, up to 16 s, until a poll succeeds.
     */
    readonly pollIntervalMs?: number;
    /** Resolve once the request reached this status or a later one (default "mined"). */
    readonly until?: 'submitted' | 'mined' | 'confirmed';
    /**
     * How long after `request.deadline` (client clock, seconds) a `failed` or `expired` status of a request that
     * was broadcast still counts as provisional (default 180). Until then a reorg or a lagging node can still turn
     * it into `mined`, so `waitForRequest` keeps polling. After it, `RelayRequestFailedError.final` is true, which is
     * only a hint (see DEFAULT_SETTLE_MARGIN_SECONDS); `waitForTransferOutcome` with the payment's latest version
     * decides.
     */
    readonly settleMarginSeconds?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** After failed polls, `waitForRequest` waits twice as long each time, up to this (or `pollIntervalMs` if longer). */
const MAX_ERROR_BACKOFF_MS = 16_000;
/**
 * 180 s after the deadline (client clock). This covers the relay's usual finality rule (min(finalized, head − 16),
 * at least 16 blocks, about 24 s on Polygon PoS), not every case: on an RPC without the `finalized` tag the relay
 * settles only at head − 256 (RELAY_FINALITY_FALLBACK_DEPTH, about 6.4 minutes), a `finalized` tag up to 600 blocks
 * behind the head (RELAY_MAX_FINALITY_LAG_BLOCKS) is normal for it, and a client clock that is ahead shortens the
 * margin. So `final: true` after the margin is a hint derived from the relay's transaction list and the client
 * clock, not a decision: only `waitForTransferOutcome` (or `confirmOnChain` at the finalized block), with the
 * payment's latest version, decides whether a version of the payment can still execute.
 */
const DEFAULT_SETTLE_MARGIN_SECONDS = 180;
/** Plain http:// is accepted only for these hosts (WHATWG URL normalizes 127.1, 0x7f000001 or [0:…:1] to them). */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
/** Upper bound for a response body. Real relay responses are a few KB. */
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TIMER_MS = 2_147_483_647;
const CONTENT_LENGTH_RE = /^[0-9]+$/;
const REACHED: Readonly<Record<'submitted' | 'mined' | 'confirmed', readonly RequestStatus[]>> = {
    submitted: ['submitted', 'mined', 'confirmed'],
    mined: ['mined', 'confirmed'],
    confirmed: ['confirmed'],
};
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

class Timeout {}

function abortedError(signal: AbortSignal): RelayClientError {
    return new RelayClientError('aborted', 'relay call aborted', { cause: signal.reason });
}

/** Resolves after `ms`, or rejects with an `aborted` error as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortedError(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortedError(signal as AbortSignal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, Math.min(ms, MAX_TIMER_MS));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * A WHATWG ReadableStream: the body of fetch in browsers, Node 18+ and Deno. node-fetch v2/v3 and
 * cross-fetch on Node return a Node.js stream (no getReader), and React Native has no body at all.
 */
function isReadableStream(body: unknown): body is ReadableStream<Uint8Array> {
    return typeof body === 'object' && body !== null && typeof (body as { getReader?: unknown }).getReader === 'function';
}

/** Stops the download of a body that will not be read: a WHATWG stream is cancelled, a Node.js stream destroyed. */
function discardBody(body: unknown): void {
    try {
        if (isReadableStream(body)) {
            void body.cancel().catch(() => undefined);
        } else if (typeof body === 'object' && body !== null && typeof (body as { destroy?: unknown }).destroy === 'function') {
            (body as { destroy(): void }).destroy();
        }
    } catch {
        // The response is refused either way; a failing cleanup must not replace that answer.
    }
}

/**
 * The response body as text, or null if it is larger than MAX_RESPONSE_BYTES. A larger Content-Length
 * is refused before the body is read. A WHATWG stream body is read chunk by chunk and cancelled as soon
 * as it passes the limit, so a hostile relay URL cannot make the client buffer more than that. Any other
 * body (React Native: none; node-fetch and cross-fetch on Node: a Node.js stream) is read in full with
 * `text()` and its size checked afterwards; the request timeout bounds that read.
 */
async function readBodyText(response: Response, signal: AbortSignal): Promise<string | null> {
    const body: unknown = response.body;
    const declared = response.headers.get('content-length')?.trim();
    if (declared !== undefined && CONTENT_LENGTH_RE.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
        discardBody(body);
        return null;
    }
    if (!isReadableStream(body)) {
        const text = await response.text();
        return new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES ? null : text;
    }
    const reader = body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder();
    let text = '';
    let received = 0;
    try {
        for (;;) {
            if (signal.aborted) throw signal.reason;
            const { done, value } = await reader.read();
            if (signal.aborted) throw signal.reason;
            if (done) return text + decoder.decode();
            received += value.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
                // Cleanup must not be able to hold up the size error.
                cancel();
                return null;
            }
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}

function mismatch(field: string, expected: unknown, actual: unknown): never {
    throw new RelayPinMismatchError(field, expected, actual);
}

function compareDomain(field: string, expected: InfoResponse['contracts']['transfer']['domain'], actual: typeof expected): void {
    if (!sameDomain(expected, actual)) mismatch(field, expected, actual);
}

/** Throws `RelayPinMismatchError` unless /v1/info describes exactly the pinned deployment. */
export function verifyInfoAgainstPins(info: InfoResponse, pins: ChainPins): void {
    if (info.chainId !== pins.chainId) mismatch('chainId', pins.chainId, info.chainId);
    if (!pins.relays.some((relay) => sameAddress(relay, info.relay))) mismatch('relay', pins.relays, info.relay);
    if (!sameAddress(info.contracts.transfer.address, pins.transfer.address)) {
        mismatch('contracts.transfer.address', pins.transfer.address, info.contracts.transfer.address);
    }
    compareDomain('contracts.transfer.domain', pins.transfer.domain, info.contracts.transfer.domain);
    if (info.tokens.length !== pins.tokens.length) {
        mismatch('tokens', pins.tokens.map((t) => t.address), info.tokens.map((t) => t.address));
    }
    for (const [i, token] of info.tokens.entries()) {
        const field = `tokens[${i}]`;
        const pinned = findPinnedToken(pins, token.address);
        if (pinned === undefined) mismatch(`${field}.address`, 'a pinned token', token.address);
        if (info.tokens.findIndex((t) => sameAddress(t.address, token.address)) !== i) mismatch(`${field}.address`, 'unique tokens', token.address);
        if (token.symbol !== pinned.symbol) mismatch(`${field}.symbol`, pinned.symbol, token.symbol);
        if (token.decimals !== pinned.decimals) mismatch(`${field}.decimals`, pinned.decimals, token.decimals);
        const modes = token.authModes;
        if (modes.length !== pinned.authModes.length || !pinned.authModes.every((mode) => modes.includes(mode))) {
            mismatch(`${field}.authModes`, pinned.authModes, modes);
        }
        compareDomain(`${field}.tokenDomain`, pinned.domain, token.tokenDomain);
    }
}

export class RelayClient {
    readonly baseUrl: string;
    readonly pins: ChainPins;
    readonly #fetch: FetchLike;
    readonly #requestTimeoutMs: number;
    readonly #now: () => number;
    #verifiedInfo: InfoResponse | null = null;
    #pendingInfo: Promise<InfoResponse> | null = null;

    /**
     * `baseUrl` is the relay origin (optionally with a path prefix), without `/v1`. It must be `https://`;
     * plain `http://` is accepted only for localhost, 127.0.0.1 and [::1] (a relay on the same machine), unless
     * `options.allowInsecureHttp` is set.
     */
    constructor(baseUrl: string, options: RelayClientOptions) {
        let url: URL;
        try {
            url = new URL(baseUrl);
        } catch {
            throw new TypeError('baseUrl: expected an absolute http(s) URL');
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('baseUrl: expected an http(s) URL');
        if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
            throw new TypeError('baseUrl: must not contain credentials, a query or a fragment');
        }
        // Signed bodies must not cross a network in the clear: a network observer could read, and submit
        // first, a META_TX approval that never expires.
        if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname) && options?.allowInsecureHttp !== true) {
            throw new TypeError('baseUrl: use https://; plain http:// is only accepted for localhost, 127.0.0.1 and [::1]');
        }
        if (options === undefined || options.pins === undefined) throw new TypeError('options.pins is required');
        const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined)?.bind(globalThis);
        if (fetchImpl === undefined) throw new TypeError('no fetch implementation available; pass options.fetch');
        const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('requestTimeoutMs: expected a positive integer');
        this.baseUrl = url.href.replace(/\/+$/, '');
        this.pins = options.pins;
        this.#fetch = fetchImpl;
        this.#requestTimeoutMs = timeout;
        this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    }

    /** GET /v1/info, verified against the pins (any mismatch throws `RelayPinMismatchError`). */
    async info(options: CallOptions = {}): Promise<InfoResponse> {
        try {
            const { status, json } = await this.#call('GET', '/v1/info', options);
            if (status !== 200) throw new RelayClientError('invalid_response', `unexpected HTTP status ${status}`, { status });
            const info = parseInfo(json);
            verifyInfoAgainstPins(info, this.pins);
            this.#verifiedInfo = deepFreeze(info);
            return this.#verifiedInfo;
        } catch (error) {
            // A relay that stops matching the pins is not trusted from an older successful check either.
            this.#verifiedInfo = null;
            throw error;
        }
    }

    /** The verified /v1/info, fetched once per client (concurrent callers share one request). */
    async #ensureInfo(options: CallOptions): Promise<InfoResponse> {
        if (this.#verifiedInfo !== null) return this.#verifiedInfo;
        const { signal } = options;
        if (signal?.aborted) throw abortedError(signal);
        if (this.#pendingInfo === null) {
            // Without the caller's signal: the request is shared, and its first caller's cancellation must not end
            // it for the others. It has its own timeout, and every caller leaves on its own signal below.
            this.#pendingInfo = this.info().finally(() => {
                this.#pendingInfo = null;
            });
        }
        const pending = this.#pendingInfo;
        if (signal === undefined) return pending;
        // Each caller can leave a shared discovery request independently. In particular, a
        // second caller's cancellation must not wait for the first caller's HTTP timeout.
        return new Promise<InfoResponse>((resolve, reject) => {
            const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(abortedError(signal)); };
            signal.addEventListener('abort', onAbort, { once: true });
            pending.then(
                (info) => { signal.removeEventListener('abort', onAbort); resolve(info); },
                (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
            );
        });
    }

    /**
     * The verified /v1/info if it names `relay`, else null. A cached check that names another relay is
     * repeated once: the relay may have rotated its key (D5), and the new key must be pinned too.
     */
    async #infoForRelay(relay: string, options: CallOptions): Promise<InfoResponse | null> {
        const cached = this.#verifiedInfo;
        let info = await this.#ensureInfo(options);
        if (!sameAddress(info.relay, relay) && cached !== null) info = await this.info(options);
        return sameAddress(info.relay, relay) ? info : null;
    }

    /**
     * GET /v1/fee for a transfer. The quote must name the verified relay, the token and the auth mode, and be a multiple
     * of FEE_GRANULARITY. It is a hint: nothing caps it, neither the pins nor the contract. Show the fee to the user
     * for confirmation, and pass `maxAcceptableFee` to refuse (with `fee_above_limit`) any quote above what the user
     * accepts to pay.
     */
    async fee(
        query: {
            readonly token: Address;
            readonly authMode: AuthModeName;
            /** The most the caller accepts to pay, in token units; a higher quote throws `fee_above_limit`. */
            readonly maxAcceptableFee?: bigint | DecimalString;
        },
        options: CallOptions = {},
    ): Promise<FeeResponse> {
        const token = findPinnedToken(this.pins, query.token);
        if (token === undefined) throw new GaslessValidationError('unsupported_token', 'token', 'not a pinned token');
        if (!token.authModes.includes(query.authMode)) {
            throw new GaslessValidationError('unsupported_auth_mode', 'authMode', `${token.symbol} does not support auth mode "${query.authMode}"`);
        }
        const maxAcceptableFee = parseMaxAcceptableFee(query.maxAcceptableFee);
        const info = await this.#ensureInfo(options);
        const params = new URLSearchParams({ operation: 'transfer', token: token.address, authMode: query.authMode });
        const { status, json } = await this.#call('GET', `/v1/fee?${params.toString()}`, options);
        if (status !== 200) throw new RelayClientError('invalid_response', `unexpected HTTP status ${status}`, { status });
        const quote = parseFee(json);
        if (!sameAddress(quote.token, token.address)) mismatch('fee.token', token.address, quote.token);
        if (quote.authMode !== query.authMode) mismatch('fee.authMode', query.authMode, quote.authMode);
        if (!sameAddress(quote.relay, info.relay) && (await this.#infoForRelay(quote.relay, options)) === null) {
            mismatch('fee.relay', info.relay, quote.relay);
        }
        if (BigInt(quote.fee) % BigInt(FEE_GRANULARITY) !== 0n) mismatch('fee.fee', `a multiple of ${FEE_GRANULARITY}`, quote.fee);
        const acceptable = checkAcceptableFee(BigInt(quote.fee), maxAcceptableFee, 'fee.fee');
        if (!acceptable.ok) throw GaslessValidationError.fromResult(acceptable);
        return deepFreeze(quote);
    }

    /**
     * POST /v1/transfer. The body is validated against the pins and must be signed for the verified
     * relay; the returned id must equal the locally computed EIP-712 digest of the request at its nonce with
     * its authorization. Resolves for 202 (queued) and 200 (identical re-submit).
     *
     * After an error that leaves open whether the relay stored the request (`timeout`, `network_error`,
     * `http_error`, `invalid_response`, `aborted`, or a relay `internal_error`), post the same body again with
     * `{ repost: true }`: the relay answers an identical body it stored with 200 and the current state, also after
     * the deadline, so this cannot create a second request, and `repost` skips the client-side deadline window for
     * it. (A `not_found` from `getRequest` does not settle it: the first post may still be on its way.)
     *
     * An error thrown before sending (`GaslessValidationError`, `RelayPinMismatchError`) means that this call sent
     * nothing, not that the relay stored nothing. If an earlier post of the body got no clear answer (this is a
     * re-post; also after a key rotation, when the URL now serves another relay), treat the request as possibly
     * stored: sign nothing else for the payment before `waitForTransferOutcome` with the payment's latest version
     * answered (sdk/README.md, "Failures, retries and replacements").
     */
    async submitTransfer(body: SubmitTransferBody, options: SubmitTransferOptions = {}): Promise<SubmitResponse> {
        const check = validateSubmitTransferBody(body, this.pins, this.#now(), { repost: options?.repost === true });
        if (!check.ok) throw GaslessValidationError.fromResult(check);
        // Plain JSON envelopes can be mutable; preserve precisely the validated signed body
        // across asynchronous relay discovery and response verification, without changing its wire form.
        body = { request: { ...body.request }, signature: body.signature, authorization: { ...body.authorization },
            ...(body.quoteId === undefined ? {} : { quoteId: body.quoteId }) };
        if ((await this.#infoForRelay(body.request.relay, options)) === null) {
            throw new GaslessValidationError('wrong_relay', 'request.relay', 'signed for a different relay than this one');
        }
        // Before the post: nothing that can throw locally may come between the relay storing the request and its answer.
        const expectedId = transferDigest(this.pins.chainId, this.pins.transfer.address, body.request, body.authorization);
        const { status, json } = await this.#call('POST', '/v1/transfer', options, body);
        if (status !== 200 && status !== 202) throw new RelayClientError('invalid_response', `unexpected HTTP status ${status}`, { status });
        const result = parseSubmit(json);
        if (result.id !== expectedId) throw new RelayClientError('invalid_response', 'relay returned an id that is not the request digest');
        return deepFreeze(result);
    }

    /** GET /v1/requests/:id. The returned request with its `authHash` must hash to `id`. */
    async getRequest(id: Hex, options: CallOptions & { readonly timeoutMs?: number } = {}): Promise<RequestState> {
        if (typeof id !== 'string' || !BYTES32_RE.test(id)) throw new GaslessValidationError('invalid_request', 'id', 'expected bytes32');
        const normalizedId = id.toLowerCase();
        const { status, json } = await this.#call('GET', `/v1/requests/${normalizedId}`, options);
        if (status !== 200) throw new RelayClientError('invalid_response', `unexpected HTTP status ${status}`, { status });
        const state = parseRequestState(json);
        if (state.id !== normalizedId) throw new RelayClientError('invalid_response', 'relay returned a different request id');
        if (transferDigestFromAuthHash(this.pins.chainId, this.pins.transfer.address, state.request, state.authHash) !== normalizedId) {
            throw new RelayClientError('invalid_response', 'the returned request does not hash to its id');
        }
        return deepFreeze(state);
    }

    /**
     * Polls `getRequest` until the request reaches `until` (default "mined").
     *
     * A `failed` or `expired` status ends the wait with `RelayRequestFailedError`:
     * - at once, with `final: true`, if the request lists no transactions: nothing was broadcast, so no
     *   inclusion can change the outcome;
     * - otherwise only once the client clock is past `request.deadline` plus `settleMarginSeconds`
     *   (`final: true`). Until then the relay's outcome is provisional (a reverted call or a mined cancel
     *   decided it, and a reorg or a lagging node can still turn it into `mined`), so polling continues, and
     *   a later `mined` or `confirmed` is returned. If `timeoutMs` ends first, the provisional failure is
     *   thrown with `final: false`.
     *
     * Throws a `timeout` error after `timeoutMs` in every other case, and an `aborted` error when `signal`
     * aborts. Transient errors (network, timeouts, 429, 5xx) are retried until the timeout; other relay
     * errors are thrown at once. A `not_found` means unknown, not "never stored": the relay behind the URL may
     * have another key and database (a key rotation), or it deleted a settled request (retention). Run
     * `waitForTransferOutcome` with the payment's latest version before signing anything new for the payment.
     *
     * `RelayRequestFailedError.final` is a hint from the relay's transaction list and the client clock; only
     * `waitForTransferOutcome` (or `confirmOnChain` with blockTag "finalized"), with the payment's latest version,
     * decides whether a version of the payment can still execute.
     */
    async waitForRequest(id: Hex, options: WaitForRequestOptions = {}): Promise<RequestState> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const settleMarginSeconds = options.settleMarginSeconds ?? DEFAULT_SETTLE_MARGIN_SECONDS;
        const targets = REACHED[options.until ?? 'mined'];
        if (targets === undefined) throw new TypeError('until: expected "submitted", "mined" or "confirmed"');
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs: expected a positive integer');
        if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new TypeError('pollIntervalMs: expected a positive integer');
        if (!Number.isSafeInteger(settleMarginSeconds) || settleMarginSeconds < 0) {
            throw new TypeError('settleMarginSeconds: expected a non-negative integer');
        }
        const { signal } = options;
        const giveUpAt = performance.now() + timeoutMs;
        let lastError: unknown;
        /** Failed polls in a row (network errors, timeouts, 429, 5xx). */
        let failures = 0;
        /** The last failed/expired state that can still change; cleared when the relay reports anything else. */
        let provisional: RequestState | null = null;
        for (;;) {
            if (signal?.aborted) throw abortedError(signal);
            const remaining = giveUpAt - performance.now();
            if (remaining <= 0) {
                if (provisional !== null) throw new RelayRequestFailedError(provisional, { final: false });
                throw new RelayClientError('timeout', `request ${id} did not reach "${options.until ?? 'mined'}" in time`, { cause: lastError });
            }
            let state: RequestState | undefined;
            try {
                state = await this.getRequest(id, {
                    ...(signal !== undefined ? { signal } : {}),
                    timeoutMs: Math.min(this.#requestTimeoutMs, Math.ceil(remaining)),
                });
                failures = 0;
            } catch (error) {
                const transient =
                    (error instanceof RelayClientError && error.code !== 'aborted' && error.retryable) ||
                    (error instanceof RelayApiError && error.retryable);
                if (!transient) throw error;
                lastError = error;
                failures += 1;
            }
            if (state !== undefined) {
                if (targets.includes(state.status)) return state;
                if (state.status === 'failed' || state.status === 'expired') {
                    if (this.#failureIsFinal(state, settleMarginSeconds)) throw new RelayRequestFailedError(state, { final: true });
                    provisional = state;
                } else {
                    provisional = null;
                }
            }
            // A relay that is overloaded or unreachable is asked less often the longer that lasts.
            const delay = failures === 0 ? pollIntervalMs : Math.max(pollIntervalMs, Math.min(pollIntervalMs * 2 ** failures, MAX_ERROR_BACKOFF_MS));
            await sleep(Math.max(0, Math.min(delay, giveUpAt - performance.now())), signal);
        }
    }

    /**
     * A failed or expired status is final when nothing was broadcast (the relay lists call transactions only,
     * and never removes one), or once the client clock is past the deadline plus the settle margin. Both come from
     * the relay's answer and the client clock: a hint, not an on-chain decision (DEFAULT_SETTLE_MARGIN_SECONDS).
     */
    #failureIsFinal(state: RequestState, settleMarginSeconds: number): boolean {
        if (state.transactions.length === 0) return true;
        const now = this.#now();
        assertUnixSeconds(now);
        return BigInt(now) > BigInt(state.request.deadline) + BigInt(settleMarginSeconds);
    }

    async #call(
        method: 'GET' | 'POST',
        path: string,
        options: CallOptions & { readonly timeoutMs?: number },
        body?: unknown,
    ): Promise<{ status: number; json: unknown }> {
        const { signal } = options;
        if (signal?.aborted) throw abortedError(signal);
        const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs: expected a positive integer');
        const controller = new AbortController();
        const giveUpAt = performance.now() + timeoutMs;
        let timer: ReturnType<typeof setTimeout>;
        const scheduleTimeout = () => {
            const remaining = giveUpAt - performance.now();
            if (remaining <= 0) controller.abort(new Timeout());
            else timer = setTimeout(scheduleTimeout, Math.min(remaining, MAX_TIMER_MS));
        };
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        let rejectAborted: () => void = () => undefined;
        const interrupted = new Promise<never>((_resolve, reject) => {
            rejectAborted = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', rejectAborted, { once: true });
        });
        scheduleTimeout();
        let response: Response | undefined;
        let status: number;
        let text: string | null;
        try {
            const work = async () => {
                response = await this.#fetch(`${this.baseUrl}${path}`, {
                    method,
                    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: controller.signal,
                    // The signed body must only ever reach the configured relay URL.
                    redirect: 'error',
                    credentials: 'omit',
                    cache: 'no-store',
                });
                // An injected transport may ignore AbortSignal and answer after the caller has left.
                if (controller.signal.aborted) {
                    discardBody(response.body);
                    throw controller.signal.reason;
                }
                const result = { status: response.status, text: await readBodyText(response, controller.signal) };
                if (controller.signal.aborted) throw controller.signal.reason;
                return result;
            };
            // Bound the promise itself, including text() polyfills that ignore abort. Promise.race
            // observes late rejections; they cannot become an unhandled rejection or a late success.
            ({ status, text } = await Promise.race([work(), interrupted]));
        } catch (error) {
            if (controller.signal.aborted && response !== undefined) discardBody(response.body);
            if (signal?.aborted) throw abortedError(signal);
            if (controller.signal.aborted && controller.signal.reason instanceof Timeout) {
                throw new RelayClientError('timeout', `relay did not answer ${method} ${path.split('?')[0]} in time`);
            }
            throw new RelayClientError('network_error', `relay request ${method} ${path.split('?')[0]} failed`, { cause: error });
        } finally {
            clearTimeout(timer!);
            signal?.removeEventListener('abort', onAbort);
            controller.signal.removeEventListener('abort', rejectAborted);
        }
        if (text === null) throw new RelayClientError('invalid_response', `response too large (over ${MAX_RESPONSE_BYTES} bytes)`, { status });
        let json: unknown;
        try {
            json = text.length === 0 ? undefined : JSON.parse(text);
        } catch {
            json = undefined;
            if (status < 400) throw new RelayClientError('invalid_response', 'response is not JSON', { status });
        }
        if (status >= 400) {
            const apiError = parseErrorBody(json);
            if (apiError !== null) throw new RelayApiError(apiError.code, apiError.message, status);
            throw new RelayClientError('http_error', `relay answered HTTP ${status}`, { status });
        }
        return { status, json };
    }
}
