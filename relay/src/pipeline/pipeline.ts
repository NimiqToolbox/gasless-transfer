import { performance } from 'node:perf_hooks';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import type { ErrorCode, SubmitResponse } from '@nimiq/gasless-sdk/relay';
import { decodeRevert } from '../chain/revert.js';
import type { ChainClient, ReadContractCall } from '../chain/types.js';
import { nowSeconds, type Clock } from '../clock.js';
import { admissionSettings, DEFAULT_MAX_CONCURRENT_VALIDATIONS, DEFAULT_VALIDATION_TIMEOUT_MS, type AdmissionSettings } from '../config.js';
import { hashSdkTypedData, recoverCanonical, splitSignature65 } from '../eip712.js';
import { RelayError } from '../errors.js';
import type { FeeEngine } from '../fees/feeEngine.js';
import type { FixedWindowLimiter } from '../limiter.js';
import type { Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';
import { formatZodError } from '../operations/schemas.js';
import type { OperationDefinition, RelayContext, Submission, TokenDomainStatus } from '../operations/types.js';
import type { TokenImplementationMonitor } from '../ops/tokenImplementationMonitor.js';
import type { EvictionCandidate, FinalFailure, SenderBusyReason, Store, TokenUsage } from '../store/types.js';
import { maxBig } from '../util/bigint.js';
import { sameAddress } from '../util/validation.js';
import type { SenderAdmission } from './senderAdmission.js';

export interface PipelineDeps {
    readonly ctx: RelayContext;
    readonly store: Store;
    readonly fees: FeeEngine;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly metrics: RelayMetrics;
    /**
     * Per-signer rate limit. Checked once the signature is verified, and charged only once step 4 has
     * shown that the submission can become a new request, so nobody can spend another signer's quota.
     */
    readonly signerLimiter?: FixedWindowLimiter | undefined;
    /**
     * Relay-wide limit of the submissions that go on to read the chain (RELAY_RATE_LIMIT_SUBMIT_MAX per
     * RELAY_RATE_LIMIT_SUBMIT_WINDOW_SECONDS), under the key SUBMIT_LIMIT_KEY. Charged once the signature and the
     * per-signer limit have passed, right before the first RPC read.
     */
    readonly submitLimiter?: FixedWindowLimiter | undefined;
    /** RELAY_MAX_CONCURRENT_VALIDATIONS: submissions reading the chain at the same time (default 4). */
    readonly maxConcurrentValidations?: number | undefined;
    /** Token domain state: token signatures for a token whose domain changed are refused. */
    readonly tokenDomains?: TokenDomainStatus | undefined;
    readonly tokenImplementations?: TokenImplementationMonitor | undefined;
    /** Admission bounds (fields left out take their defaults, config.ts admissionSettings: 100 queued). */
    readonly admission?: Partial<AdmissionSettings> | undefined;
    /**
     * The sender's cool-down after a failure it caused (while one of its requests is queued or in flight, a further
     * submission is refused before any RPC read), and whether it may make a held request give way.
     */
    readonly senderAdmission?: SenderAdmission | undefined;
    /**
     * `TxManager.heldInQueue()`, the queued requests held at their spend cap. In a full queue one
     * of them gives way to a request that passed every check (Store.insertRequest), if its sender may make one
     * give way now; otherwise, and without it, a full queue answers 503.
     */
    readonly heldQueued?: (() => readonly EvictionCandidate[]) | undefined;
    /**
     * `TxManager.cannotSend()`: why the transaction manager would not send a request accepted now (no POL, the gas
     * budget reached, no recent pass, an old head, a stalled queue), if so. A new request is refused then, before any
     * RPC read: it would only wait in the queue until its deadline.
     */
    readonly cannotSend?: (() => string | undefined) | undefined;
    /**
     * Overall bound of the RPC reads of one submission, in real milliseconds.
     * It must end before the idle timeout closes the quiet connection (config.ts maxValidationTimeoutMs).
     */
    readonly validationTimeoutMs?: number | undefined;
    /**
     * `TxManager.viewHead()`: the head block of the transaction manager's last completed pass (undefined
     * before the first one). Steps 6 to 8 read at a block at least as new; without it (or
     * before the first pass) the chain's latest block is the only bound.
     */
    readonly viewHead?: (() => bigint | undefined) | undefined;
    /**
     * `TxManager.wake(priority)`: called with the operation's priority once a new request is stored as queued, so that
     * the transaction manager's next pass starts now instead of at the next poll. Only a submission that passed every
     * check and limit gets here.
     */
    readonly onQueued?: ((priority: number) => void) | undefined;
}

export interface SubmitOptions {
    /**
     * Aborted when the client's connection is gone: the answer can no longer be delivered, so nothing may be
     * stored any more.
     */
    readonly signal?: AbortSignal | undefined;
}

/** The one key of the relay-wide submit limiter. */
const SUBMIT_LIMIT_KEY = 'relay';
/** Submissions that may wait for a validation slot, per slot (RELAY_MAX_CONCURRENT_VALIDATIONS). */
export const VALIDATION_WAITERS_PER_SLOT = 4;

export interface SubmitResult {
    readonly statusCode: 200 | 202;
    readonly body: SubmitResponse;
}

const NO_USAGE: TokenUsage = { debits: 0n, noneDebits: 0n, busy: false, nonePending: false };
/** Refusals that a request stored concurrently at the same nonce can cause (see `run`): reported as `conflict`. */
const RACE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['sender_busy', 'insufficient_balance', 'insufficient_allowance']);

/**
 * The outcome of a queued request that gave way to a new request in a full queue. It was held at
 * its spend cap (gas prices rose above what its fee covers) and never broadcast, so the outcome is final at once and
 * its intent nonce is unused. The relay keeps the record (an identical re-post gets its state), and the nonce is free
 * again: a correction of the payment at the same nonce, with a fee that pays the current price, can be submitted at
 * once. At most one request per nonce executes (sdk/README.md, "Failures, retries and replacements").
 */
const GAVE_WAY_IN_FULL_QUEUE: FinalFailure = {
    status: 'failed',
    error: {
        code: 'fee_too_low',
        message:
            'Gas prices rose above what the fee of this request covers, and the queue was full: it gave way to a request that pays ' +
            'the current price. Nothing was sent. Its signed intent stays valid until its deadline; a correction of this payment ' +
            '(the same nonce) with a higher fee can be submitted now, and at most one of them executes.',
    },
};
const SENDER_BUSY_MESSAGES: Readonly<Record<SenderBusyReason, string>> = {
    token_signature: 'a request with a token signature from this sender is still pending, or was just mined; retry when it is mined, or in a few seconds',
    allowance_in_use:
        'a request of this sender for this token that uses its existing allowance (mode "none") is still pending, and a permit or ' +
        'meta-transaction now would replace that allowance; retry when it is mined, or use mode "none"',
    pending: 'another request of this sender is queued or in flight, and the relay takes one request per sender at a time; retry when it is mined',
    nonce_unsettled:
        'the request of this sender at this nonce ended (failed or expired), but its outcome is not final yet; retry in a minute',
    just_mined: "this sender's previous request was just mined and the relay's chain reads do not show it yet; retry in a few seconds",
};

/**
 * Payload fingerprint for idempotency: the request id (EIP-712 digest over all signed fields, the nonce and the token
 * authorization) plus the intent signature. An identical re-post has the same fingerprint.
 */
export function fingerprintOf(id: Hex, sub: Submission): Hex {
    return keccak256(stringToBytes(JSON.stringify([id, sub.signature])));
}

/**
 * The chain as the operation's step-6 and step-7 checks see it: every contract read at `blockNumber`.
 * A node that does not have that block answers with an error instead of older state, and
 * the submission gets `unavailable`. Everything else is the chain client itself.
 */
export function readsAt(chain: ChainClient, blockNumber: bigint): ChainClient {
    return new Proxy(chain, {
        get(target, property) {
            if (property === 'readContract') {
                return <T>(call: ReadContractCall): Promise<T> => target.readContract<T>({ ...call, blockNumber });
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
}

/**
 * The time budget of one submission. It runs on the real monotonic clock: the injected `Clock`
 * serves the wall-clock policy (deadlines, quotas), while this bounds how long the client waits.
 */
class ValidationBudget {
    private readonly endsAt: number;

    constructor(
        private readonly timeoutMs: number,
        private readonly signal: AbortSignal | undefined,
        private readonly logger: Logger,
    ) {
        this.endsAt = performance.now() + timeoutMs;
    }

    private expired(step: string): RelayError {
        this.logger.warn({ step, timeoutMs: this.timeoutMs }, 'validation deadline passed; nothing stored');
        return new RelayError(
            'unavailable',
            'The chain answered too slowly to validate this request in time; nothing was stored. Retry the same request.',
        );
    }

    private gone(step: string): RelayError {
        this.logger.info({ step }, 'client disconnected during validation; nothing stored');
        return new RelayError('unavailable', 'The connection was closed before the request was validated; nothing was stored.');
    }

    /** Throws if the budget is used up or the client is gone. Synchronous, so nothing can interleave before what follows. */
    check(step: string): void {
        if (this.signal?.aborted) throw this.gone(step);
        if (performance.now() >= this.endsAt) throw this.expired(step);
    }

    /** `work`, bounded by the rest of the budget and by the client's connection. */
    race<T>(step: string, work: Promise<T>): Promise<T> {
        this.check(step);
        let timer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;
        const stop = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(this.expired(step)), Math.max(0, this.endsAt - performance.now()));
            onAbort = () => reject(this.gone(step));
            this.signal?.addEventListener('abort', onAbort, { once: true });
        });
        return Promise.race([work, stop]).finally(() => {
            clearTimeout(timer);
            if (onAbort) this.signal?.removeEventListener('abort', onAbort);
        });
    }
}

/**
 * The §6.3 validation pipeline. Checks run in order and the first failing one returns its code:
 *   1 schema · 2 policy (including the token domain state) · 3 signature · per-signer limit · the sender's
 *   cool-down · queue bound · relay-wide validation bounds · 4 nonce (chain: nonce_used / nonce_too_high, then DB:
 *   conflict) · 5 fee (≥ max(MIN_FEE, break-even)) · 6 balance/token state · 7 sender_busy (one pending request per
 *   sender), then the token authorization · 8 simulation · 9 persist (atomic re-check; in a full queue a request held
 *   at its spend cap gives way, one at a time per sender) and enqueue.
 * Before step 2, an exact duplicate of a stored submission is answered with 200 and its current state.
 * Steps 4 and 6 to 8 read at one block B, at least the transaction manager's newest head; steps 4 and 9 count the
 * sender's requests included in blocks after B. All RPC reads share one deadline, and nothing is stored once
 * it passed or the client is gone.
 */
export class SubmitPipeline {
    private readonly admission: AdmissionSettings;
    private readonly validationTimeoutMs: number;
    private readonly maxConcurrentValidations: number;
    /** Slots in use: submissions reading the chain right now (between the relay-wide bounds and their answer). */
    private validating = 0;
    /** Submissions waiting for a slot, oldest first: each entry hands a slot over. */
    private readonly slotWaiters: Array<() => void> = [];

    constructor(private readonly deps: PipelineDeps) {
        this.admission = admissionSettings(deps.admission);
        this.validationTimeoutMs = deps.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
        this.maxConcurrentValidations = deps.maxConcurrentValidations ?? DEFAULT_MAX_CONCURRENT_VALIDATIONS;
    }

    private rateLimited(limiter: FixedWindowLimiter, signer: string): RelayError {
        return new RelayError('rate_limited', `Too many requests for this signer; retry in ${limiter.retryAfterSeconds(signer)} s`);
    }

    /**
     * Throws rate_limited (429) if `sender` cools down after a failure it caused and has a request queued or in
     * flight already. Synchronous and without any read of the chain.
     */
    private checkSender(sender: Address): void {
        const cooldown = this.deps.senderAdmission?.cooldownSeconds(sender) ?? 0;
        if (cooldown === 0 || this.deps.store.admissionCounts(sender).pendingOfSigner === 0) return;
        this.deps.metrics.admissionEvents.inc({ event: 'sender_cooldown' });
        throw new RelayError(
            'rate_limited',
            'A request of this sender failed before it was sent, because the sender moved the funds or changed the allowance, ' +
                `a signature or its nonce. For ${cooldown} s more, a further request of this sender is refused at once while one ` +
                'is queued or in flight; retry when it is mined',
        );
    }

    /**
     * Whether a submission of `sender` may take the place of a queued request held at its spend cap in a full queue:
     * at most one request per sender may have done so and still wait for its first broadcast, and none while the
     * sender cools down.
     */
    private mayEvict(sender: Address): boolean {
        return this.deps.senderAdmission?.mayEvict(sender) ?? true;
    }

    /**
     * A full queue (RELAY_MAX_QUEUED): 503. With requests held at their spend cap that this sender may not make
     * give way now, `relay_admission_events_total{event="sender_eviction"}` counts it.
     */
    private queueFullFor(evictionWithheld: boolean): RelayError {
        if (evictionWithheld) this.deps.metrics.admissionEvents.inc({ event: 'sender_eviction' });
        return this.queueFull();
    }

    /**
     * The relay-wide bounds of the submissions that read the chain: RELAY_RATE_LIMIT_SUBMIT_MAX per window, and at most
     * RELAY_MAX_CONCURRENT_VALIDATIONS at a time. A submission beyond the second waits for a slot, in arrival order, for
     * at most half its validation deadline (the rest is left for its reads), with at most VALIDATION_WAITERS_PER_SLOT
     * times as many waiting; otherwise it gets 503. The relay does not tell clients apart by network address, so these
     * bound what submissions cost in RPC reads, which the transaction manager needs from the same providers; they
     * do not share that capacity out between clients. Returns the function that ends this submission's slot.
     */
    private async enterValidation(budget: ValidationBudget): Promise<() => void> {
        const { metrics, submitLimiter } = this.deps;
        if (submitLimiter && !submitLimiter.hit(SUBMIT_LIMIT_KEY)) {
            metrics.admissionEvents.inc({ event: 'validation_rate' });
            throw new RelayError(
                'unavailable',
                `The relay has checked too many requests recently; nothing was stored. Retry in ${submitLimiter.retryAfterSeconds(SUBMIT_LIMIT_KEY)} s.`,
            );
        }
        if (this.validating < this.maxConcurrentValidations) {
            this.validating += 1;
        } else {
            if (this.slotWaiters.length >= this.maxConcurrentValidations * VALIDATION_WAITERS_PER_SLOT) throw this.validationBusy();
            await this.waitForSlot(budget);
        }
        let ended = false;
        return () => {
            if (ended) return;
            ended = true;
            this.releaseSlot();
        };
    }

    private validationBusy(): RelayError {
        this.deps.metrics.admissionEvents.inc({ event: 'validation_busy' });
        return new RelayError('unavailable', 'The relay is checking too many requests right now; nothing was stored. Retry in a few seconds.');
    }

    /** Hands a free slot to the longest waiting submission, or frees it. */
    private releaseSlot(): void {
        const next = this.slotWaiters.shift();
        if (next) next();
        else this.validating -= 1;
    }

    /**
     * Resolves once a slot was handed over (the count of slots in use stays). Rejects when half the validation deadline
     * has passed, the whole deadline has, or the client is gone; a slot handed over at that moment is passed on.
     */
    private waitForSlot(budget: ValidationBudget): Promise<void> {
        // Synchronous: nothing is queued yet if the budget is already used up.
        budget.check('validation slot');
        let granted = false;
        let grant!: () => void;
        const slot = new Promise<void>((resolve) => {
            grant = () => {
                granted = true;
                resolve();
            };
        });
        this.slotWaiters.push(grant);
        let timer: NodeJS.Timeout | undefined;
        const waited = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(this.validationBusy()), Math.floor(this.validationTimeoutMs / 2));
        });
        return budget.race('validation slot', Promise.race([slot, waited])).then(
            () => clearTimeout(timer),
            (err: unknown) => {
                clearTimeout(timer);
                if (granted) this.releaseSlot();
                else this.slotWaiters.splice(this.slotWaiters.indexOf(grant), 1);
                throw err;
            },
        );
    }

    private senderBusy(reason: SenderBusyReason = 'token_signature'): RelayError {
        return new RelayError('sender_busy', SENDER_BUSY_MESSAGES[reason]);
    }

    /** The retained rows are at their limit and none can give way (Store.hasRetainedRoom, Store.insertRequest). */
    private retentionFull(): RelayError {
        this.deps.metrics.admissionEvents.inc({ event: 'retention_full' });
        return new RelayError(
            'unavailable',
            'The relay has reached its retained request capacity. Nothing was stored; retry the same body later. Existing requests and their history are preserved.',
        );
    }

    private queueFull(): RelayError {
        return new RelayError('unavailable', 'The relay has too many requests queued right now; nothing was stored. Retry in a minute.');
    }

    async submit(op: OperationDefinition, body: unknown, options: SubmitOptions = {}): Promise<SubmitResult> {
        try {
            const budget = new ValidationBudget(this.validationTimeoutMs, options.signal, this.deps.logger);
            const result = await this.run(op, body, budget);
            this.deps.metrics.submissions.inc({ operation: op.name, outcome: result.statusCode === 202 ? 'accepted' : 'duplicate' });
            return result;
        } catch (err) {
            const code = err instanceof RelayError ? err.code : 'internal_error';
            this.deps.metrics.submissions.inc({ operation: op.name, outcome: code });
            throw err;
        }
    }

    /** An RPC step: bounded by the validation budget; transport errors become `unavailable`. */
    private async onchain<T>(step: string, budget: ValidationBudget, fn: () => Promise<T>): Promise<T> {
        budget.check(step);
        try {
            return await budget.race(step, fn());
        } catch (err) {
            if (err instanceof RelayError) throw err;
            this.deps.logger.warn({ err, step }, 'RPC error during validation');
            throw new RelayError('unavailable', 'The relay cannot reach the chain right now; try again later');
        }
    }

    private async run(op: OperationDefinition, body: unknown, budget: ValidationBudget): Promise<SubmitResult> {
        const { ctx, store } = this.deps;

        // 1. Strict schema (the 16 KB body limit is enforced by the HTTP layer).
        const parsed = op.schema.safeParse(body);
        if (!parsed.success) throw new RelayError('invalid_request', formatZodError(parsed.error));
        const sub = parsed.data;
        const id = hashSdkTypedData(op.typedData(ctx, sub));
        const fingerprint = fingerprintOf(id, sub);
        const key = op.nonceKey(ctx, sub);

        // Idempotency: an identical re-post returns the current state (a lookup, not a validation step), also once a
        // later request holds its nonce.
        const twin = (): SubmitResult | undefined => {
            const existing = store.getRequest(id);
            return existing && existing.fingerprint === fingerprint ? { statusCode: 200, body: { id: existing.id, status: existing.status } } : undefined;
        };
        const stored = twin();
        if (stored) return stored;
        try {
            return await this.validate(op, sub, { id, fingerprint, key }, budget);
        } catch (err) {
            // An identical submission may have been stored while this one was validated (concurrent re-posts):
            // this copy then ran into its own twin (sender_busy, the twin's debit, the queue bound). It is the stored
            // request, so it gets the stored state, as a later re-post would.
            const answer = err instanceof RelayError ? twin() : undefined;
            if (answer) return answer;
            // A different request at this nonce may have been stored meanwhile (concurrent versions of one payment): its
            // debit or the one pending request per sender refused this one, but the cause is the conflict, which step 4
            // would report to the same body submitted now.
            if (err instanceof RelayError && RACE_CODES.has(err.code)) {
                const holder = store.nonceHolder(key.contract, key.signer, key.nonce);
                if (holder && holder.id !== id && holder.status !== 'failed' && holder.status !== 'expired') {
                    throw new RelayError('conflict', `a different request with this nonce exists (${holder.id})`);
                }
            }
            throw err;
        }
    }

    /** Steps 2 to 9 of a submission that is not stored yet. */
    private async validate(
        op: OperationDefinition,
        sub: Submission,
        submission: { id: Hex; fingerprint: Hex; key: ReturnType<OperationDefinition['nonceKey']> },
        budget: ValidationBudget,
    ): Promise<SubmitResult> {
        const { ctx, store, clock } = this.deps;
        const { id, key } = submission;

        // 2. Policy, then the token domain state: token signatures for a token whose on-chain EIP-712
        //    domain no longer matches the configuration cannot succeed.
        op.policy(ctx, sub, nowSeconds(clock));
        const reservation = op.reservation(ctx, sub);
        const implementationUnavailable = reservation && this.deps.tokenImplementations?.tokenUnavailable(reservation.token);
        if (implementationUnavailable) throw new RelayError('unavailable', implementationUnavailable);
        if (reservation && sub.authorization.mode !== 'none') {
            const unavailable = this.deps.tokenDomains?.tokenSignaturesUnavailable(reservation.token);
            if (unavailable) throw new RelayError('unsupported_auth_mode', unavailable);
        }

        // 3. Intent signature: exactly 65 bytes, v ∈ {27, 28}, low-s, recovers to the signer.
        const parts = splitSignature65(sub.signature);
        const recovered = parts ? await recoverCanonical(id, parts) : undefined;
        if (!recovered || !sameAddress(recovered, op.signer(sub))) {
            throw new RelayError('invalid_signature', 'signature must be a 65-byte low-s EIP-712 signature by request.from');
        }

        // Access control: per-signer rate limit. Only verified signers get here. A signer that used up
        // its window is refused before any RPC call, but a submission is only charged after step 4:
        // re-posts of an intent the relay already knows (answered conflict or nonce_used) must not
        // consume the signer's quota, because anyone can copy a broadcast intent and post it.
        const limiter = this.deps.signerLimiter;
        if (limiter?.isLimited(key.signer)) throw this.rateLimited(limiter, key.signer);

        // Admission per sender, before any RPC read; step 9 checks it again. While a sender cools down after one of
        // its requests failed before the broadcast for a reason it controls, a further submission is refused here
        // while it has a request queued or in flight (otherwise step 7 refuses it, after the reads).
        this.checkSender(key.signer);

        // Admission: while the transaction manager cannot send, a new request would only wait in the queue until its
        // deadline, after its sender signed it. Refused before any RPC read; the answer is retryable, and quotes,
        // status queries and re-posts of a stored request keep working.
        if (this.deps.cannotSend?.() !== undefined) {
            this.deps.metrics.admissionEvents.inc({ event: 'cannot_send' });
            throw new RelayError('unavailable', 'The relay cannot send transactions right now; nothing was stored. Retry later.');
        }

        // Admission: a full queue is refused before any RPC read, unless a queued request
        // held at its spend cap can give way and this sender may make one give way now;
        // step 9 checks both again atomically. The answer is retryable, and quotes and status queries
        // keep working.
        const heldQueued = this.deps.heldQueued;
        if (store.admissionCounts(key.signer).queued >= this.admission.maxQueued) {
            const held = heldQueued !== undefined && heldQueued().length > 0;
            if (!held || !this.mayEvict(key.signer)) throw this.queueFullFor(held);
        }

        // Admission: retained rows at their limit, and none that can give way, are refused before any RPC read too;
        // step 9 checks again, and makes the room, atomically with the insert.
        if (!store.hasRetainedRoom(this.admission.maxRetainedRequests, clock.nowMs())) throw this.retentionFull();

        // Relay-wide bounds, right before the first RPC read: only submissions with a valid signature of a signer
        // within its limit count against them.
        const endValidation = await this.enterValidation(budget);
        try {
            return await this.validateOnchain(op, sub, submission, budget, reservation);
        } finally {
            endValidation();
        }
    }

    /** Steps 4 to 9: the RPC reads of a submission, and its insert. */
    private async validateOnchain(
        op: OperationDefinition,
        sub: Submission,
        { id, fingerprint, key }: { id: Hex; fingerprint: Hex; key: ReturnType<OperationDefinition['nonceKey']> },
        budget: ValidationBudget,
        reservation: ReturnType<OperationDefinition['reservation']>,
    ): Promise<SubmitResult> {
        const { ctx, store, fees, clock } = this.deps;
        const limiter = this.deps.signerLimiter;

        // 4. Nonce, read at block B: at least the head of the transaction manager's last pass (every inclusion it
        //    recorded is in that state) and the chain's latest block; steps 6 to 8 read at the same block. A read node
        //    without block B answers with an error: `unavailable`. The request's nonce must be the sender's next one:
        //    nonces(from) at B, raised past the sender's requests the relay recorded as included in a block after B.
        //    Below it, the nonce is used (executed or invalidated) and the request can never execute; above it, the
        //    request could execute only after requests at the nonces in between. On-chain first, then the database:
        //    another request that holds this nonce.
        const latest = await this.onchain('head', budget, () => ctx.chain.getBlock('latest'));
        const viewHead = this.deps.viewHead?.();
        const block = viewHead !== undefined ? maxBig(viewHead, latest.number) : latest.number;
        const pinned: RelayContext = { ...ctx, chain: readsAt(ctx.chain, block) };
        const onchainNonce = await this.onchain('nonce', budget, () => op.onchainChecks.nextNonce(pinned, sub));
        const next = maxBig(onchainNonce, store.nextNonceAfter(key.contract, key.signer, block) ?? 0n);
        const nonce = BigInt(key.nonce);
        if (nonce < next) throw new RelayError('nonce_used', `this nonce was already used or invalidated on-chain; the sender's next nonce is ${next}`);
        if (nonce > next) {
            throw new RelayError(
                'nonce_too_high',
                `the sender's next nonce is ${next}: this request could execute only after requests at the nonces below it; retry once they are mined`,
            );
        }
        // The sender's previous request was included after block B: the next nonce is right, but the reads at B (balance,
        // token state, the simulation) do not show that inclusion, and the simulation would revert at the nonce of B.
        if (nonce > onchainNonce) throw this.senderBusy('just_mined');
        // Looked up again: an identical submission may have been stored while this one was validated.
        const stored = store.getRequest(id);
        if (stored) {
            if (stored.fingerprint === fingerprint) return { statusCode: 200, body: { id: stored.id, status: stored.status } };
            throw new RelayError('conflict', `a different request with this nonce exists (${stored.id})`);
        }
        const holder = store.nonceHolder(key.contract, key.signer, key.nonce);
        if (holder) {
            // A failed or expired request holds its nonce until its outcome settles; a reorg could still put it back in flight.
            if (holder.status === 'failed' || holder.status === 'expired') throw this.senderBusy('nonce_unsettled');
            throw new RelayError('conflict', `a different request with this nonce exists (${holder.id})`);
        }
        if (limiter && !limiter.hit(key.signer)) throw this.rateLimited(limiter, key.signer);

        // 5. Fee acceptance: at least MIN_FEE, the smallest quote, and at least the current break-even
        //    (the quote is only a hint). Below MIN_FEE a sender could fill the queue at the bare gas cost.
        const { fee, mode } = op.fee(sub);
        const feeContext = await this.onchain('fee', budget, () => fees.context());
        const minimum = maxBig(fees.minFee, fees.breakEven(op.name, mode, feeContext));
        if (fee < minimum) {
            throw new RelayError(
                'fee_too_low',
                `fee ${fee} is below ${minimum}, the larger of the minimum fee ${fees.minFee} and the current break-even fee; request a new quote`,
            );
        }

        // 6. Balance and token state, read at block B (step 4). The pending debits of the sender are counted, and so are
        //    its requests the relay recorded as included in a block after B (by block number).
        const usage = reservation
            ? store.tokenUsage(reservation.token, key.signer, reservation.spender, { minedAfterBlock: block })
            : NO_USAGE;
        const state = await this.onchain('state', budget, () => op.onchainChecks.state(pinned, sub, usage));

        // 7. sender_busy first, then the token authorization at block B:
        //    - a pending PERMIT/META_TX request of (token, from) is about to move the token's sequential
        //      nonce, so a token signature for the next nonce gets the retryable 409, not a permanent
        //      invalid_token_authorization. The same for one the relay recorded as included after B: it
        //      moved the token nonce and set and used the allowance, which the reads at B do not show (a
        //      NONE request would pass on a stale allowance). A later submission reads past it;
        //    - a token signature while a NONE request of (token, from) to the same contract is pending
        //      would overwrite the allowance that request relies on;
        //    - one queued or in-flight request per sender: its requests execute in nonce order, and the next one could
        //      only be signed for a nonce the pending one has not used yet.
        if (usage.busy) throw this.senderBusy('token_signature');
        if (usage.nonePending && sub.authorization.mode !== 'none') throw this.senderBusy('allowance_in_use');
        if (store.admissionCounts(key.signer).pendingOfSigner > 0) throw this.senderBusy('pending');
        const auth = await this.onchain('authorization', budget, () => op.onchainChecks.authorization(pinned, sub, usage));

        // 8. Simulation from the relay account at block B; the relay encodes the call itself.
        const call = op.encodeCall(ctx, sub);
        const simulation = await this.onchain('simulation', budget, () =>
            ctx.chain.call({ from: ctx.relay, to: call.to, data: call.data, blockNumber: block }),
        );
        if (!simulation.ok) {
            throw new RelayError('simulation_failed', `simulation reverted: ${decodeRevert(simulation.revertData).description}`);
        }

        // 9. Persist (unique on (contract, from, nonce) among the requests that hold the nonce); the balance and allowance
        //    against the requests stored now, sender_busy and the admission bounds are re-checked atomically. Only while the
        //    client can still receive the answer: the check and the synchronous insert cannot interleave with
        //    a timer or a closing connection. The sender's cool-down is checked again first (other
        //    submissions of it may have been stored meanwhile); nothing interleaves up to the insert either.
        //    In a full queue, the queued request held at its spend cap with the lowest cap (then the oldest)
        //    gives way in the same database transaction: it ends failed with fee_too_low. Only if this
        //    sender may make one give way now; it is recorded right after the insert, so a
        //    concurrent submission of the same sender sees it here.
        budget.check('insert');
        this.checkSender(key.signer);
        const held = this.deps.heldQueued;
        const mayEvict = this.mayEvict(key.signer);
        const outcome = store.insertRequest(
            {
                id,
                operation: op.name,
                contract: key.contract,
                signer: key.signer,
                nonce: key.nonce,
                fingerprint,
                request: op.publicRequest(sub),
                authHash: op.authHash(sub),
                signature: sub.signature,
                authorization: sub.authorization,
                fee,
                deadline: op.deadline(sub),
                priority: op.priority,
                reservation,
                createdAtMs: clock.nowMs(),
            },
            {
                observedBalance: state.balance,
                observedAllowance: auth.allowance,
                observedBlock: block,
                maxQueued: this.admission.maxQueued,
                maxRetainedRequests: this.admission.maxRetainedRequests,
                ...(held && mayEvict ? { evict: { candidates: held(), final: GAVE_WAY_IN_FULL_QUEUE } } : {}),
            },
        );
        switch (outcome.kind) {
            case 'inserted': {
                const { metrics, logger } = this.deps;
                const evicted = outcome.evicted;
                if (evicted) this.deps.senderAdmission?.evicted(key.signer, id);
                metrics.requestStatus.inc({ operation: op.name, status: 'queued' });
                if (outcome.dropped) {
                    metrics.admissionEvents.inc({ event: 'unsent_history_dropped' });
                    logger.info({ requestId: outcome.dropped, takenBy: id }, 'retained rows at their limit: the history of a request that was never sent gave way');
                }
                if (evicted) {
                    metrics.admissionEvents.inc({ event: 'evicted' });
                    metrics.requestStatus.inc({ operation: evicted.operation, status: evicted.status });
                    logger.warn(
                        { requestId: evicted.id, takenBy: id },
                        'queue full: a request held at its spend cap gave way to a new request (fee_too_low, nothing was sent)',
                    );
                }
                logger.info({ requestId: id, operation: op.name, signer: key.signer }, 'request queued');
                try {
                    this.deps.onQueued?.(op.priority);
                } catch (err) {
                    // The request is stored: the answer stays 202, and the poll sends it.
                    logger.warn({ err, requestId: id }, 'could not start the next pass at once; the request waits for the poll');
                }
                return { statusCode: 202, body: { id, status: 'queued' } };
            }
            case 'duplicate':
                return { statusCode: 200, body: { id: outcome.record.id, status: outcome.record.status } };
            case 'conflict':
                throw new RelayError('conflict', `a different request with this nonce exists (${outcome.record.id})`);
            case 'sender_busy':
                throw this.senderBusy(outcome.reason);
            case 'queue_full':
                throw this.queueFullFor(!mayEvict && held !== undefined && held().length > 0);
            case 'retention_full':
                throw this.retentionFull();
            case 'insufficient_balance':
                throw new RelayError('insufficient_balance', 'balance does not cover amount + fee (including pending requests)');
            case 'insufficient_allowance':
                throw new RelayError('insufficient_allowance', 'allowance to the contract does not cover amount + fee (including pending requests)');
        }
    }
}
