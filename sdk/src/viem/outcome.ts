import type { Client } from 'viem';
import { MAX_DEADLINE_SECONDS } from '../core/constants.js';
import { transferDigestFromAuthHash } from '../core/eip712.js';
import { GaslessError, GaslessValidationError } from '../core/errors.js';
import type { ChainPins } from '../core/pins.js';
import { normalizeTransferRequest } from '../core/submit.js';
import type { Hex, TransferVersion } from '../core/types.js';
import { assertUnixSeconds } from '../core/validate.js';
import type { RequestState, RequestStatus } from '../relay/types.js';
import {
    BLOCK_TAGS,
    confirmWithProgress,
    newSearchProgress,
    paymentVersionIds,
    type ConfirmBlockTag,
    type OnChainConfirmation,
    type OnChainStatus,
    type UnresolvedReason,
} from './confirm.js';
import { BYTES32_RE } from './confirmContext.js';

/** What `waitForTransferOutcome` reads from the relay. `RelayClient` has it. */
export interface RelayStatusSource {
    getRequest(id: Hex, options?: { readonly signal?: AbortSignal }): Promise<RequestState>;
}

export interface WaitForTransferOutcomeOptions {
    /**
     * The relay the request was submitted to (optional). Its status says when the chain is worth reading,
     * and its `txHash` makes the on-chain check cheaper. The outcome itself is always read on-chain.
     */
    readonly relay?: RelayStatusSource;
    /**
     * The block the outcome is read at (default "finalized"): the answer is then final. "latest" answers
     * sooner, but a reorg can still change it; do not use that answer to sign a new payment.
     */
    readonly blockTag?: ConfirmBlockTag;
    /** Delay between polls in ms (default 4000). */
    readonly pollIntervalMs?: number;
    /**
     * Give up after this many ms with a `timeout` error (default: until 30 minutes after the request's
     * deadline by the client clock, at least 60 s).
     */
    readonly timeoutMs?: number;
    /**
     * Lower bound of the log search on an RPC without the state of older blocks (default: the first block at or after
     * the earliest deadline of the versions − 7800 s, never below `pins.deployBlock`; see
     * `ConfirmOnChainOptions.fromBlock`).
     */
    readonly fromBlock?: bigint;
    readonly signal?: AbortSignal;
    /** Clock in unix seconds (default: system clock). */
    readonly now?: () => number;
}

/** A final on-chain outcome of a payment. */
export interface TransferOutcome extends OnChainConfirmation {
    /**
     * `executed` or `other_version_executed`: the payment went through (this version, or another version with the
     * same intent nonce: `executedTransfer`); never sign again for it. `expired`, `nonce_consumed` or
     * `other_payment_executed` (another payment of the sender used the nonce: `executedTransfer`): this version can
     * never execute, and if it is the payment's latest version, no version can.
     */
    readonly status: Exclude<OnChainStatus, 'pending' | 'unresolved'>;
    /** The relay's last answer, or null without a relay or if it never answered. */
    readonly relayState: RequestState | null;
}

const DEFAULT_POLL_INTERVAL_MS = 4_000;
/** The default wait ends this long after the deadline: the finalized block trails the head by a few minutes at most. */
const FINALITY_SLACK_SECONDS = 1_800;
const MIN_DEFAULT_WAIT_SECONDS = 60;
/** The longest delay setTimeout takes (2^31 − 1 ms); a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Relay statuses after which the chain is worth reading before the deadline. */
const DECIDED: readonly RequestStatus[] = ['mined', 'confirmed', 'failed', 'expired'];
/** On-chain answers that end the wait; `pending` and `unresolved` do not. */
const FINAL: readonly OnChainStatus[] = ['executed', 'other_version_executed', 'other_payment_executed', 'expired', 'nonce_consumed'];

function isFinal(confirmation: OnChainConfirmation): confirmation is OnChainConfirmation & { readonly status: TransferOutcome['status'] } {
    return FINAL.includes(confirmation.status);
}

function aborted(signal: AbortSignal): GaslessError {
    return new GaslessError('aborted', 'waitForTransferOutcome aborted', { cause: signal.reason });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(aborted(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(aborted(signal as AbortSignal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Waits until a payment's outcome is final on-chain, combining the relay's status with `confirmOnChain`. Pass the
 * payment's latest version (every version shares one intent nonce, and the latest has the latest deadline), as its
 * request and `authHash` (a `TransferVersion`, or the `SignedTransfer`), and in `versions` every version signed for
 * the payment (`ConfirmTarget.versions`):
 * - `executed`: this version executed (its relayTransfer call is in a finalized block);
 * - `other_version_executed`: another version of the payment (same `from` and intent nonce) executed; it is in
 *   `executedTransfer`. The payment went through: never sign again for it;
 * - `other_payment_executed`: a request of another payment of the sender (another token or recipient, or one not in
 *   `versions`) used the intent nonce; it is in `executedTransfer`. This payment did not execute;
 * - `expired`: the intent nonce was unused at the last block at or before the deadline, and a finalized block is past
 *   the deadline;
 * - `nonce_consumed`: the sender invalidated the intent nonce (its NonceInvalidated event was found).
 *
 * Only after `expired`, `nonce_consumed` or `other_payment_executed` of the latest version is it safe to sign a new
 * payment: no version can then execute, so the user cannot pay twice. The new payment takes `nonces(from)` again,
 * which after `expired` can be this payment's nonce. A relay's `failed` or `expired` alone is not enough (spec §6.5: such an outcome is
 * provisional until its block is final, and a relay can be wrong). An intent nonce that is used although neither its
 * execution nor its invalidation is found (`unresolved`, see `OnChainStatus`) is not an outcome: the wait goes on.
 *
 * The chain is read while the relay reports `mined`, `confirmed`, `failed` or `expired`, while the relay
 * does not answer (or none is given), and in any case once the client clock is past the deadline. The
 * outcome is read at `options.blockTag` (default "finalized"). RPC errors are thrown.
 *
 * On an RPC without the state of older blocks each poll goes on with the log search where the previous one stopped
 * (`confirmOnChain`, `SearchProgress`): the blocks it searched without an answer are not searched again while the block
 * it read is unchanged, except the log queries of the blocks within LOG_INDEX_LAG_BLOCKS (128) of the block a poll
 * read (an RPC's log index can lag the block it serves). So a flood of logs costs at most one search of the blocks
 * above the use over the whole wait, plus a few requests per poll, and the answer comes once the search has reached
 * the use.
 */
export async function waitForTransferOutcome(
    client: Client,
    pins: ChainPins,
    target: TransferVersion & { readonly id?: Hex; readonly versions?: readonly TransferVersion[] },
    options: WaitForTransferOutcomeOptions = {},
): Promise<TransferOutcome> {
    const request = normalizeTransferRequest(target.request);
    if (typeof target.authHash !== 'string' || !BYTES32_RE.test(target.authHash)) {
        throw new GaslessValidationError('invalid_request', 'authHash', 'expected bytes32: tokenAuthHash of the version\'s token authorization');
    }
    const authHash = target.authHash.toLowerCase() as Hex;
    const id = transferDigestFromAuthHash(pins.chainId, pins.transfer.address, request, authHash);
    if (target.id !== undefined && (typeof target.id !== 'string' || target.id.toLowerCase() !== id)) {
        throw new GaslessValidationError('invalid_request', 'id', 'does not match the request digest');
    }
    // Checked once here, before any wait; confirmOnChain checks it again on every read.
    if (target.versions !== undefined) paymentVersionIds(pins, request, authHash, target.versions);
    const blockTag = options.blockTag ?? 'finalized';
    if (!BLOCK_TAGS.includes(blockTag)) throw new TypeError('blockTag: expected "latest", "safe" or "finalized"');
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new TypeError('pollIntervalMs: expected a positive integer');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
        throw new TypeError('timeoutMs: expected a positive integer');
    }
    if (options.fromBlock !== undefined && (typeof options.fromBlock !== 'bigint' || options.fromBlock < 0n)) {
        throw new TypeError('fromBlock: expected a non-negative bigint');
    }
    const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
    const now = (): bigint => {
        const seconds = clock();
        assertUnixSeconds(seconds);
        return BigInt(seconds);
    };
    const deadline = BigInt(request.deadline);
    const start = now();
    // The relay accepts deadlines up to now + MAX_DEADLINE_SECONDS; a later one only bounds the default wait.
    const lastDeadline = deadline < start + BigInt(MAX_DEADLINE_SECONDS) ? deadline : start + BigInt(MAX_DEADLINE_SECONDS);
    const defaultWaitSeconds = lastDeadline + BigInt(FINALITY_SLACK_SECONDS) - start;
    const giveUpAt =
        performance.now() + (options.timeoutMs ?? Math.max(MIN_DEFAULT_WAIT_SECONDS, Number(defaultWaitSeconds)) * 1000);
    const { relay, signal } = options;
    if (relay !== undefined && typeof relay?.getRequest !== 'function') {
        throw new TypeError('relay: expected an object with getRequest(id), such as a RelayClient');
    }

    let relayState: RequestState | null = null;
    let unresolved: UnresolvedReason | undefined;
    const why: Record<UnresolvedReason, string> = {
        no_history:
            ': its intent nonce is used, and the RPC serves no state of older blocks (it is not an archive node), so the use is searched in its logs, which have not shown it yet; an RPC with that state answers at once (see confirmOnChain)',
        not_found:
            ': its intent nonce is used, but the block that used it shows neither its execution nor its invalidation (a relayTransfer call through code, or evidence the RPC does not serve: see confirmOnChain)',
    };
    const timeout = (): GaslessError => new GaslessError(
        'timeout',
        `the outcome of transfer ${id} is not final yet (read at the ${blockTag} block)${unresolved === undefined ? '' : why[unresolved]}; do not sign again for this payment`,
    );
    const checkBudget = (): void => {
        if (signal?.aborted) throw aborted(signal);
        if (performance.now() >= giveUpAt) throw timeout();
    };
    // Bound in-flight work as well as the delay between polls. A custom provider may ignore AbortSignal;
    // its late rejection is still observed by Promise.race, and all our timers/listeners are removed.
    const withinBudget = async <T>(work: () => Promise<T>): Promise<T> => {
        checkBudget();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
            // Node/browser timers clamp large delays; recheck long waits instead of expiring them early.
            const schedule = (): void => {
                const left = giveUpAt - performance.now();
                if (left <= 0) reject(timeout());
                else timer = setTimeout(schedule, Math.min(Math.ceil(left), MAX_TIMER_DELAY_MS));
            };
            schedule();
            onAbort = () => reject(aborted(signal as AbortSignal));
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        try {
            const result = await Promise.race([work(), stopped]);
            checkBudget();
            return result;
        } finally {
            clearTimeout(timer);
            if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
    };
    // Guard each RPC too: if a transport finishes after cancellation, the confirmation helper must not
    // continue its multi-call event search in the background. No transport internals are changed.
    const boundedClient = new Proxy(client, {
        get(target, property, receiver) {
            if (property === 'request') {
                return (...args: unknown[]) => withinBudget(() => Reflect.apply(target.request, target, args) as Promise<unknown>);
            }
            return Reflect.get(target, property, receiver);
        },
    });
    // The log search's progress, from poll to poll.
    const progress = newSearchProgress();
    for (;;) {
        checkBudget();
        let answered = false;
        if (relay !== undefined) {
            try {
                const state: unknown = await withinBudget(() => relay.getRequest(id, signal !== undefined ? { signal } : {}));
                // No state object is a wrong answer, as below; the last state stays.
                if (typeof state === 'object' && state !== null) {
                    relayState = state as RequestState;
                    answered = true;
                }
            } catch {
                // A relay that does not answer, does not know the id or answers wrongly changes nothing: the
                // chain decides. The chain is read on this poll instead.
                checkBudget();
            }
        }
        if (!answered || (relayState !== null && DECIDED.includes(relayState.status)) || now() > deadline) {
            // Only a hint: a status source's value that is no transaction hash is left out, and the search finds the use.
            const hint = relayState?.txHash;
            const txHash = typeof hint === 'string' && BYTES32_RE.test(hint) ? hint : null;
            const versions = target.versions;
            const onChain = await withinBudget(() =>
                confirmWithProgress(
                    boundedClient,
                    pins,
                    { request, authHash, ...(versions !== undefined ? { versions } : {}) },
                    {
                        blockTag,
                        ...(txHash !== null ? { txHash } : {}),
                        ...(options.fromBlock !== undefined ? { fromBlock: options.fromBlock } : {}),
                    },
                    progress,
                ),
            );
            if (isFinal(onChain)) return { ...onChain, relayState };
            unresolved = onChain.status === 'unresolved' ? (onChain.reason ?? 'not_found') : undefined;
        }
        checkBudget();
        await withinBudget(() => sleep(Math.min(pollIntervalMs, giveUpAt - performance.now(), MAX_TIMER_DELAY_MS), signal));
    }
}
