import type { Address, Hex } from 'viem';
import type { AuthModeName, DecimalString, TokenAuthorization } from '@nimiq/gasless-sdk/core';
import type { ErrorCode, OperationName, RequestStatus } from '@nimiq/gasless-sdk/relay';

export interface StoredError {
    readonly code: ErrorCode;
    readonly message: string;
}

/**
 * The signed token authorization `{mode, v, r, s}` as stored while a request may need it (purged at the end); mode
 * "none" has v = 0 and r = s = 0.
 */
export type StoredAuthorization = TokenAuthorization;

export type FinalFailure = { readonly status: 'failed' | 'expired'; readonly error: StoredError };

export interface RequestRecord {
    readonly id: Hex;
    readonly operation: OperationName;
    readonly contract: Address;
    readonly signer: Address;
    /** The intent nonce, a canonical uint256 decimal string. */
    readonly nonce: DecimalString;
    readonly fingerprint: Hex;
    /** The operation's public request fields (for transfers: the 8 signed fields). */
    readonly request: unknown;
    /** hashStruct(TokenAuth) of the signed token authorization; kept when the authorization is purged. */
    readonly authHash: Hex;
    /** Null once purged (terminal state). */
    readonly signature: Hex | null;
    readonly authorization: StoredAuthorization | null;
    readonly authMode: AuthModeName;
    readonly token: Address | null;
    readonly spender: Address | null;
    readonly debit: bigint | null;
    readonly fee: bigint;
    readonly deadline: bigint;
    readonly priority: number;
    readonly status: RequestStatus;
    readonly txNonce: number | null;
    readonly finalTxHash: Hex | null;
    readonly blockNumber: bigint | null;
    readonly error: StoredError | null;
    /** Set while a cancel/replacement is in flight: the terminal state once the tx nonce resolves. */
    readonly pendingFinal: FinalFailure | null;
    /**
     * The transaction whose inclusion decided the current `mined`, `failed` or `expired` state (a call or a
     * cancel), or null (never broadcast, or a foreign transaction consumed the tx nonce).
     */
    readonly resolvedTxHash: Hex | null;
    /** The block of that decision (for a foreign transaction: the block at which the relay saw the nonce used). */
    readonly resolvedBlock: bigint | null;
    /** When the outcome became final (its block is finalized, or nothing was ever broadcast); secrets are purged then. */
    readonly settledAtMs: number | null;
    /** When a reorg last put this request back in flight after its outcome had been decided (null: never). */
    readonly reopenedAtMs: number | null;
    readonly createdAtMs: number;
    readonly updatedAtMs: number;
    readonly submittedAtMs: number | null;
    /** When the request was first seen mined; kept across reorgs (fee revenue and time-to-mine count once). */
    readonly minedAtMs: number | null;
    readonly confirmedAtMs: number | null;
}

export interface TokenReservation {
    readonly token: Address;
    readonly spender: Address;
    /** amount + fee pulled from the signer. */
    readonly debit: bigint;
}

export interface NewRequest {
    readonly id: Hex;
    readonly operation: OperationName;
    readonly contract: Address;
    readonly signer: Address;
    readonly nonce: DecimalString;
    readonly fingerprint: Hex;
    readonly request: unknown;
    readonly authHash: Hex;
    readonly signature: Hex;
    readonly authorization: StoredAuthorization;
    readonly fee: bigint;
    readonly deadline: bigint;
    readonly priority: number;
    readonly reservation: TokenReservation | undefined;
    readonly createdAtMs: number;
}

/**
 * Values observed on-chain during validation and the admission bounds, re-checked atomically against the
 * stored requests when the request is inserted (§6.3 step 9).
 */
export interface InsertGuards {
    /**
     * Total retained request capacity. At the limit, the history of a request that was never sent and whose deadline is
     * an hour past gives way to the new row; without one the new row is refused (`retention_full`), and no held request
     * is evicted.
     */
    readonly maxRetainedRequests?: number | undefined;
    readonly observedBalance?: bigint | undefined;
    readonly observedAllowance?: bigint | undefined;
    /**
     * The block the balance and the allowance were read at (steps 6 and 7). Requests of the same
     * (token, signer) that are mined or confirmed in a later block are no longer pending, while the observed
     * values still include their funds: the re-check counts their debits too. A PERMIT or META_TX_APPROVE request
     * among them also set and used the allowance and advanced the token nonce after the reads: sender_busy.
     * Requests included at or below this block are in the observed values.
     */
    readonly observedBlock?: bigint | undefined;
    /**
     * RELAY_MAX_QUEUED: refuse (queue_full) if this many requests are queued already, unless one of `evict.candidates`
     * gives way.
     */
    readonly maxQueued?: number | undefined;
    /**
     * Queued requests held at their spend cap (as the transaction manager knows them) that give way
     * to this request when the queue is full: the one with the lowest cap per gas, and among equal caps the oldest, ends
     * with `final` in the same database transaction as the insert. Only a request that is still queued, was never
     * broadcast, and has no higher priority than the new request can give way.
     */
    readonly evict?: { readonly candidates: readonly EvictionCandidate[]; readonly final: FinalFailure } | undefined;
}

/** A queued request that may give way to a new one in a full queue, with the spend cap per gas it is held at. */
export interface EvictionCandidate {
    readonly id: Hex;
    readonly capPerGas: bigint;
}

/**
 * Why a request is refused with sender_busy:
 * - `token_signature`: a PERMIT or META_TX_APPROVE request of the (token, signer) is pending; the token nonce is sequential.
 *   Also when one was included after the block that the submission's reads saw (`InsertGuards.observedBlock`): its token
 *   nonce and the allowance it set and used are not in those reads yet.
 * - `allowance_in_use`: a NONE request of the (token, signer) to the same spender is pending, and this one carries a token
 *   signature, which would overwrite the allowance that request relies on.
 * - `pending`: the signer has a queued or in-flight request; the relay keeps one per signer.
 * - `nonce_unsettled`: the signer's request at this nonce ended (failed or expired), but its outcome is not settled yet;
 *   until then a reorg could still put it back in flight.
 * - `just_mined` (pipeline step 4 only): the signer's previous request was included after the block of the submission's
 *   reads, so its nonce is the next one only once the reads show that inclusion.
 */
export type SenderBusyReason = 'token_signature' | 'allowance_in_use' | 'pending' | 'nonce_unsettled' | 'just_mined';

export type InsertOutcome =
    /** `evicted`: the held request that gave way in a full queue (its outcome is final: `evict.final`). */
    /**
     * `dropped`: the request that was never sent whose history gave way at the retained-row limit (deleted with the
     * insert).
     */
    | { readonly kind: 'inserted'; readonly record: RequestRecord; readonly evicted?: RequestRecord | undefined; readonly dropped?: Hex | undefined }
    | { readonly kind: 'duplicate'; readonly record: RequestRecord }
    | { readonly kind: 'conflict'; readonly record: RequestRecord }
    | { readonly kind: 'sender_busy'; readonly reason?: SenderBusyReason | undefined }
    | { readonly kind: 'queue_full' }
    | { readonly kind: 'retention_full' }
    | { readonly kind: 'insufficient_balance'; readonly pending: bigint }
    | { readonly kind: 'insufficient_allowance'; readonly pending: bigint };

/**
 * Sums over the requests of one (token, owner) that are queued or submitted, plus, when asked, those mined
 * or confirmed after a given block (their debits are not in a balance read at that block).
 */
export interface TokenUsage {
    /** amount + fee of those requests. */
    readonly debits: bigint;
    /** amount + fee of those requests in NONE mode to the same spender (they share the allowance). */
    readonly noneDebits: bigint;
    /**
     * A PERMIT or META_TX_APPROVE request is pending, or was included after the given block (sequential token nonce, and
     * an allowance that a read at that block does not show → sender_busy).
     */
    readonly busy: boolean;
    /** A NONE request to the same spender is pending (a new token signature would overwrite its allowance → sender_busy). */
    readonly nonePending?: boolean | undefined;
}

/** Counts behind the admission bounds (one pending request per signer, RELAY_MAX_QUEUED). */
export interface AdmissionCounts {
    /** Queued or in-flight requests of the signer (every token and operation). */
    readonly pendingOfSigner: number;
    /** Queued requests in total. */
    readonly queued: number;
}

export type AttemptKind = 'call' | 'cancel';
export type AttemptStatus = 'pending' | 'mined' | 'replaced' | 'failed';

export interface TxAttemptRecord {
    readonly hash: Hex;
    readonly requestId: Hex;
    readonly seq: number;
    readonly txNonce: number;
    readonly kind: AttemptKind;
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
    readonly gasLimit: bigint;
    /** Signed raw transaction, written before broadcast; null once purged. */
    readonly raw: Hex | null;
    readonly status: AttemptStatus;
    readonly sentBlock: bigint;
    readonly createdAtMs: number;
    readonly minedBlock: bigint | null;
    readonly gasUsed: bigint | null;
    readonly effectiveGasPrice: bigint | null;
}

export interface NewAttempt {
    readonly hash: Hex;
    readonly raw: Hex;
    readonly kind: AttemptKind;
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
    readonly gasLimit: bigint;
    readonly sentBlock: bigint;
}

export interface MinedInfo {
    readonly hash: Hex;
    readonly blockNumber: bigint;
    readonly gasUsed: bigint;
    readonly effectiveGasPrice: bigint;
}

/**
 * What decided a terminal failure that happened on-chain: one of the request's own transactions (a mined
 * cancel, or a call that reverted), or a foreign transaction that consumed its tx nonce (seen at `block`).
 */
export type OnChainResolution =
    | { readonly kind: 'receipt'; readonly mined: MinedInfo; readonly attemptKind: AttemptKind; readonly callReverted: boolean }
    | { readonly kind: 'foreign'; readonly block: bigint };

/**
 * Persistence (§6.6). All methods are synchronous and each one is a single SQLite transaction, so
 * concurrent HTTP handlers and the transaction manager (all in one process) cannot interleave inside
 * a method. `(contract, signer, nonce)` is unique among the requests that hold the nonce (every request but a failed or
 * expired one whose outcome is settled), and a signer has at most one queued or in-flight request: in the database, not
 * only in memory.
 *
 * Secrets (intent signature, token authorization, raw transactions) are kept while the outcome can still
 * change and purged when it is final (`settle`, `markConfirmed`, `finalize`). A purge is followed by a
 * `wal_checkpoint(TRUNCATE)` and the database runs with `secure_delete`, so purged bytes are neither left
 * in the -wal file nor in freed space of the main file (relay/docs/storage.md).
 */
export interface Store {
    close(): void;
    journalMode(): string;
    schemaVersion(): number;
    /** Binds the database to one chain and relay key; throws if it belongs to another. */
    bindIdentity(identity: { chainId: number; relay: Address; gaslessTransfer: Address }): void;

    getRequest(id: Hex): RequestRecord | undefined;
    /** The request that holds this intent nonce: any request of the key but a failed or expired one that is settled. */
    nonceHolder(contract: Address, signer: Address, nonce: DecimalString): RequestRecord | undefined;
    /**
     * One above the highest intent nonce of the signer's requests that are mined or confirmed in a block after `block`
     * (the next nonce once those inclusions are counted), or undefined if there is none.
     */
    nextNonceAfter(contract: Address, signer: Address, block: bigint): bigint | undefined;
    /** Pending usage of (token, owner); with `minedAfterBlock`, also the requests mined or confirmed after that block. */
    tokenUsage(token: Address, owner: Address, spender: Address, options?: { readonly minedAfterBlock?: bigint | undefined }): TokenUsage;
    admissionCounts(signer: Address): AdmissionCounts;
    /**
     * §6.3 step 9: one transaction re-checks the admission bounds, the balance, the allowance and sender_busy, and
     * inserts the request as `queued`. When the queue is full, a held request of `guards.evict` gives way to it (and
     * ends failed, final at once, secrets purged) in the same transaction; without one the answer is `queue_full`.
     */
    insertRequest(request: NewRequest, guards: InsertGuards): InsertOutcome;
    listByStatus(status: RequestStatus): RequestRecord[];
    countByStatus(status: RequestStatus): number;
    /** All requests (every status), for the row-count metric. */
    countRequests(): number;
    /**
     * Whether a new row fits under `maxRetainedRequests`: there are fewer rows, or the history of a request that was
     * never sent can give way to it (see InsertGuards.maxRetainedRequests). insertRequest decides; this is the same
     * answer before the RPC reads of a submission.
     */
    hasRetainedRoom(maxRetainedRequests: number, nowMs: number): boolean;

    /** Lifetime maximum exposure; independent of request retention and receipt finality. */
    gasExposureWei(): bigint;
    /** Atomically increase the maximum for one relay nonce, refusing to exceed limitWei. Never releases exposure. */
    reserveGasExposure(txNonce: number, maximumWei: bigint, limitWei: bigint): boolean;

    getNextNonce(): number | undefined;
    setNextNonce(nonce: number): void;
    listAttempts(requestId: Hex): TxAttemptRecord[];
    /** queued → submitted: assigns `txNonce` (must equal the stored next nonce) and stores the signed tx. */
    recordFirstAttempt(requestId: Hex, txNonce: number, attempt: NewAttempt, nowMs: number): void;
    /**
     * Submitted → queued, for a request whose tx nonce a foreign transaction consumed while none of its own
     * transactions executed: the attempts stay (as `failed`, they can never be mined), the tx nonce is
     * released and the request gets a new one.
     */
    requeue(requestId: Hex, nowMs: number): void;
    /** A speed-up or cancel at the same tx nonce; earlier attempts become `replaced`. */
    recordReplacement(requestId: Hex, attempt: NewAttempt, pendingFinal: FinalFailure | undefined, nowMs: number): void;
    setPendingFinal(requestId: Hex, pendingFinal: FinalFailure, nowMs: number): void;
    touchAttempt(hash: Hex, sentBlock: bigint): void;
    /**
     * A successful call was included (also from a provisional failed/expired state after a reorg). Secrets and
     * the pending final state (an intended cancel) stay until `settle`.
     */
    markMined(requestId: Hex, mined: MinedInfo, nowMs: number): void;
    /** The deciding transaction of a provisional state was re-included in another block. */
    updateMinedBlock(requestId: Hex, blockNumber: bigint, nowMs: number): void;
    /**
     * Provisional terminal failure decided on-chain. Secrets and raw transactions stay until `settle`, so a
     * reorg can still be resolved by whichever transaction takes the nonce in the end.
     */
    resolveFailed(requestId: Hex, final: FinalFailure, resolution: OnChainResolution, nowMs: number): void;
    /**
     * Reorg: the transaction that decided a provisional mined/failed/expired state is gone; in flight again at
     * the same tx nonce (the newest attempt at it is pending again). Sets `reopenedAtMs`. No-op for settled
     * requests and requests without a tx nonce.
     */
    reopen(requestId: Hex, nowMs: number): void;
    /**
     * Reorg: the call that executed a request without a tx nonce is gone (the request had ended in the queue after
     * a requeue, and was found executed after all). Mined → queued, where it is sent with a new tx nonce or ends at
     * its deadline; its attempts stay, as `failed`. Sets `reopenedAtMs`. Throws for any other request.
     */
    requeueUnexecuted(requestId: Hex, nowMs: number): void;
    /** Mined requests, and failed/expired requests decided on-chain, whose outcome is not final yet. */
    listUnsettled(): RequestRecord[];
    /**
     * The outcome is final: mined → confirmed; failed/expired keep their status. Purges secrets. A no-op (nothing
     * is purged) unless the request is unsettled and mined, failed or expired.
     */
    settle(requestId: Hex, nowMs: number): void;
    /** mined → confirmed (same as `settle` for a mined request; a no-op for any other request). */
    markConfirmed(requestId: Hex, nowMs: number): void;
    /**
     * Terminal failure that is final at once (decided before anything was broadcast, or with an inclusion
     * that is already final). `mined` describes the transaction that resolved the tx nonce, if any
     * (`callReverted` for a mined-but-reverted call). Purges signature, authorization and raw txs.
     */
    finalize(
        requestId: Hex,
        final: FinalFailure,
        mined: (MinedInfo & { kind: AttemptKind; callReverted: boolean }) | undefined,
        nowMs: number,
    ): void;
    /** Deletes settled terminal requests (and their transactions) that settled before `beforeMs`. */
    pruneSettled(beforeMs: number): number;
}
