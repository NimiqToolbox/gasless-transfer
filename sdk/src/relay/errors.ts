import { GaslessError } from '../core/errors.js';
import type { ErrorCode, RequestState } from './types.js';

/** Client-side failures talking to a relay (no relay ErrorCode involved). */
export type RelayClientErrorCode =
    | 'network_error'
    | 'timeout'
    | 'aborted'
    /** A non-2xx response without a well-formed `{"error": {...}}` body (e.g. from a proxy). */
    | 'http_error'
    /** A response that violates the wire format or does not match what was requested. */
    | 'invalid_response'
    /** /v1/info (or a quote) contradicts the client's pins; nothing is sent to such a relay. */
    | 'pin_mismatch';

const MAX_RELAY_MESSAGE_LENGTH = 300;

/**
 * Relay-provided text is shown to developers, not trusted: cap the length and strip what could start a new line in
 * a log or reorder the text around it: the C0 and C1 control characters (with DEL and NEL), the line and paragraph
 * separators (U+2028, U+2029) and the bidi controls (U+200E, U+200F, U+202A–202E, U+2066–2069).
 */
export function sanitizeRelayMessage(message: unknown): string {
    if (typeof message !== 'string') return '';
    const clean = message.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
    return clean.length > MAX_RELAY_MESSAGE_LENGTH ? `${clean.slice(0, MAX_RELAY_MESSAGE_LENGTH)}…` : clean;
}

/** An error response of the relay, `{"error": {"code", "message"}}`, with its HTTP status. */
export class RelayApiError extends GaslessError {
    declare readonly code: ErrorCode;
    readonly status: number;

    constructor(code: ErrorCode, message: string, status: number) {
        super(code, message);
        this.name = 'RelayApiError';
        this.status = status;
    }

    /**
     * Worth retrying later: rate limits and server-side unavailability (with the same body), `sender_busy` (the
     * relay cannot take this sender's request yet: its previous one was just mined, a failed one at this nonce has not
     * settled, or a request of the sender with a token signature is pending; spec §6.3 steps 4 and 7) and
     * `nonce_too_high` (the request's intent nonce is above the sender's next nonce: a request at a lower nonce must
     * execute first). After `sender_busy`, wait until the sender's pending request is mined. A body in mode
     * "none" can then be posted again as it is. A permit or meta-tx body may not work any more: its token signature
     * is for the token nonce that the pending request may use up, so after `invalid_token_authorization` prepare and
     * sign it again with the same intent nonce (a correction, `corrects`). Every other code is a final answer for
     * this body.
     */
    get retryable(): boolean {
        return (
            this.code === 'rate_limited' ||
            this.code === 'unavailable' ||
            this.code === 'internal_error' ||
            this.code === 'sender_busy' ||
            this.code === 'nonce_too_high'
        );
    }
}

export class RelayClientError extends GaslessError {
    declare readonly code: RelayClientErrorCode;
    /** HTTP status, if a response was received. */
    readonly status: number | undefined;

    constructor(code: RelayClientErrorCode, message: string, options?: { cause?: unknown; status?: number }) {
        super(code, message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'RelayClientError';
        this.status = options?.status;
    }

    get retryable(): boolean {
        return (
            this.code === 'network_error' ||
            this.code === 'timeout' ||
            (this.code === 'http_error' && this.status !== undefined && (this.status === 429 || this.status >= 500))
        );
    }
}

/** /v1/info or a fee quote contradicts the pins. `expected` and `actual` hold public values only. */
export class RelayPinMismatchError extends RelayClientError {
    readonly field: string;
    readonly expected: string;
    readonly actual: string;

    constructor(field: string, expected: unknown, actual: unknown) {
        const show = (value: unknown) => sanitizeRelayMessage(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));
        super('pin_mismatch', `relay does not match the pins at ${field}: expected ${show(expected)}, got ${show(actual)}`);
        this.name = 'RelayPinMismatchError';
        this.field = field;
        this.expected = show(expected);
        this.actual = show(actual);
    }
}

/**
 * `waitForRequest` saw the relay report the request as `failed` or `expired`.
 *
 * `final` is a hint, derived from the relay's transaction list and the client clock:
 * - true: nothing was broadcast (`state.transactions` is empty; the relay decided without any inclusion),
 *   or the client clock is past `request.deadline` plus the settle margin of `waitForRequest`;
 * - false: something was broadcast and the wait ended earlier (`timeoutMs`). The relay decides failed and
 *   expired provisionally when an inclusion decided them (a reverted call, a mined cancel): until that
 *   block is final, a reorg or a lagging node can still turn the request into `mined`.
 *
 * Either way, do not sign again on the relay's word alone: the intent, or another version of the payment
 * with the same intent nonce, could still execute, and the user would pay twice. Only the chain decides:
 * `waitForTransferOutcome` (viem adapter), or `confirmOnChain` with blockTag "finalized", with the payment's
 * latest version, which need not be this request. Sign a new payment only once it reports `expired` or
 * `nonce_consumed`. The message says so in both cases.
 */
export class RelayRequestFailedError extends GaslessError {
    declare readonly code: 'request_failed' | 'request_expired';
    readonly state: RequestState;
    /** The relay's reason, e.g. `simulation_failed`; null if the relay gave none. */
    readonly relayCode: ErrorCode | null;
    /** False while the outcome can still change; true is only a hint (see the class comment). */
    readonly final: boolean;

    /** `final` defaults to true only for a request that lists no transactions (nothing was broadcast). */
    constructor(state: RequestState, options?: { readonly final?: boolean }) {
        const expired = state.status === 'expired';
        const final = options?.final ?? state.transactions.length === 0;
        const advice =
            'before signing again, check the chain with waitForTransferOutcome, or confirmOnChain with blockTag "finalized", ' +
            "with the payment's latest version";
        super(
            expired ? 'request_expired' : 'request_failed',
            `relay request ${state.id} ${expired ? 'expired' : 'failed'}${state.error ? `: ${state.error.code}` : ''}` +
                (final ? ` (${advice})` : ` (not final: the relay may still report it mined; ${advice})`),
        );
        this.name = 'RelayRequestFailedError';
        this.state = state;
        this.relayCode = state.error?.code ?? null;
        this.final = final;
    }
}
