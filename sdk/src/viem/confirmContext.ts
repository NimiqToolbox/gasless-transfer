// What the modules of the on-chain check (confirm.ts) share: its public types, the context of one check and the
// answers without a use. It imports none of them.

import type { Client } from 'viem';
import type { ChainPins } from '../core/pins.js';
import type { Address, Hex, TransferRequest, TransferVersion } from '../core/types.js';

/**
 * The state of a payment at the block read (`ConfirmOnChainOptions.blockTag`, default the latest block). Every
 * version of a payment is signed with one intent nonce (a correction keeps it, `prepareTransfer`'s `corrects`), and
 * the contract executes at most one request per `(from, nonce)`. So the answer is about the nonce, not only about
 * this version; pass the payment's latest version (the one with the latest deadline):
 * - `executed`: this version executed: a successful relayTransfer call of the pinned contract with exactly its
 *   fields (and, with `authHash`, its token authorization) and the sender's signature at its nonce.
 * - `other_version_executed`: another request of the sender executed at this nonce, in a block not after this
 *   version's deadline, and it is a version of the same payment: one of `ConfirmTarget.versions`, or, without that
 *   list, a request with the same token and recipient (`OnChainConfirmation.executedTransfer` holds it). The payment
 *   went through; never sign again.
 * - `other_payment_executed`: another request of the sender executed at this nonce, in a block not after this
 *   version's deadline, and it is not a version of this payment: a request with another token or recipient (the
 *   correction rules keep both), or, with `ConfirmTarget.versions`, a request not in that list. Two payments got the
 *   same nonce (an RPC node behind the chain, two wallet instances of one key). This payment did not execute and never
 *   can; a new payment is safe.
 * - `pending`: `nonces(from)` is not above the nonce and the deadline has not passed; the request may still execute.
 * - `expired`: the nonce was unused at the last block at or before the deadline (or at the block read, past the
 *   deadline); this version can never execute. If it is the payment's latest version, no version can.
 * - `nonce_consumed`: the sender's `invalidateNonces` covered the nonce (its NonceInvalidated event was found); no
 *   version executed, and none can.
 * - `unresolved`: the nonce is used, but neither its execution nor its invalidation was found (`reason` says why). Not
 *   an answer: never sign again on it.
 *
 * Read at the latest block, a reorg can still change the answer. Read at the finalized block, it is final.
 */
export type OnChainStatus =
    | 'executed'
    | 'other_version_executed'
    | 'other_payment_executed'
    | 'pending'
    | 'expired'
    | 'nonce_consumed'
    | 'unresolved';

/**
 * Why a check answers `unresolved`:
 * - `no_history`: the RPC refused a read of older state (it is not an archive node), and the log search that replaces
 *   it did not show the use: not in the blocks searched (see `fromBlock`), or not yet within the requests of the check
 *   (`waitForTransferOutcome` goes on from there on its next poll). An RPC with the state of older blocks answers.
 * - `not_found`: the block that used the nonce shows neither a direct relayTransfer call that executed it nor the
 *   sender's invalidation covering it: a relayTransfer call through code (a contract, or an EOA with an EIP-7702
 *   delegation; the transaction's `to` is not the pinned contract), or evidence the RPC did not serve (a receipt, more
 *   than MAX_RECEIPT_READS candidate calls where it refuses eth_getBlockReceipts, a block replaced during the check).
 */
export type UnresolvedReason = 'no_history' | 'not_found';

export interface OnChainConfirmation {
    readonly status: OnChainStatus;
    /**
     * Transaction and block that used the intent nonce: the relayTransfer call (`executed`, `other_version_executed`,
     * `other_payment_executed`) or the invalidateNonces call (`nonce_consumed`). Null for the other statuses.
     */
    readonly txHash: Hex | null;
    readonly blockNumber: bigint | null;
    /** The request that executed at the nonce (the three executed statuses), from its call data; null otherwise. */
    readonly executedTransfer: TransferVersion | null;
    /** Set for `unresolved` only. */
    readonly reason?: UnresolvedReason;
}

/** The blocks `confirmOnChain` can read at. */
export type ConfirmBlockTag = 'latest' | 'safe' | 'finalized';

/**
 * The version to check: its request and, optionally, `tokenAuthHash` of its token authorization (a
 * `TransferVersion`, or the `SignedTransfer`). Without `authHash`, a version that differs from this one only in its
 * token authorization counts as this one (`executed`).
 */
export interface ConfirmTarget {
    readonly request: TransferRequest;
    readonly authHash?: Hex;
    /**
     * Every version the wallet signed for this payment (this one is added when `authHash` is given), each with the same
     * `from`, nonce, `token` and `to`, and none with a later deadline than this one (the checked version is the
     * payment's latest; else `invalid_request`). With the list, an execution at the nonce of a request that is not in
     * it is `other_payment_executed`, also for the same token and recipient; so never leave a signed version out.
     * Without it, such an execution is taken for another version of the payment (`other_version_executed`).
     */
    readonly versions?: readonly TransferVersion[];
}

export interface ConfirmOnChainOptions {
    /** A transaction to check first (its 32-byte hash), e.g. `RequestState.txHash`; falls back to the search. */
    readonly txHash?: Hex;
    /**
     * Lower bound of the log search, which runs only on an RPC that refuses reads of older state (see
     * `confirmOnChain`). Default: the first block whose timestamp is at least `d − 7800 s`, where d is the earliest
     * deadline of this version and `ConfirmTarget.versions` (the SDK and the relay accept a deadline at most 7200 s
     * after the signing, plus 600 s for clocks and lagging nodes), and never below `pins.deployBlock`. Pass an
     * earlier block if a version of the payment was signed before that (an `unresolved` answer can mean this).
     */
    readonly fromBlock?: bigint;
    /**
     * The block every read is pinned to (default "latest"). With "finalized", no reorg can change the answer,
     * as far as the node's finalized tag is right: use it before signing a new payment.
     */
    readonly blockTag?: ConfirmBlockTag;
}

export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export interface RawLog {
    readonly address: string;
    readonly topics: readonly Hex[];
    readonly data: Hex;
    readonly blockNumber: bigint | Hex | null;
    readonly blockHash: Hex | null;
    readonly transactionHash: Hex | null;
    readonly removed?: boolean;
}

export interface Block {
    readonly number: bigint;
    readonly hash: Hex | null;
    readonly timestamp: bigint;
}

export interface LogFilter {
    readonly address: Address | readonly Address[];
    readonly topics: readonly Hex[];
}

/**
 * What a check knows when the RPC refused a read of older state: the nonce was used at `used`, and unused at `unused`
 * (read there, or the block under `pins.deployBlock`, which `firstUse` takes for unused without a read).
 */
export interface Bracket {
    readonly used: bigint;
    readonly unused: bigint | undefined;
}

/** What every step of the search shares. */
export interface Search {
    /** The caller's client, with every request counted (`counted`). */
    readonly client: Client;
    readonly pins: ChainPins;
    readonly request: TransferRequest;
    readonly authHash: Hex | undefined;
    /** The ids of `ConfirmTarget.versions` (lowercase), if given. */
    readonly versionIds: ReadonlySet<string> | undefined;
    /** The block read. */
    readonly block: Block;
    readonly nonce: bigint;
    readonly deadline: bigint;
    /** The earliest deadline of this version and `ConfirmTarget.versions`: the log search starts 7800 s before it. */
    readonly earliestDeadline: bigint;
    /** The header of each block number read so far: the first answer for a number is that number's block for the check. */
    readonly headers: Map<bigint, Block>;
    readonly seen: Seen;
}

/** What a check found out about the RPC as it read. */
export interface Seen {
    /** False once the RPC refused a read of older state. */
    history: boolean;
    /** False once the RPC refused eth_getBlockReceipts. */
    blockReceipts: boolean;
    /**
     * Reads that gave no evidence where the chain must hold some, or evidence another read contradicts (a receipt or
     * transaction not served or of another block, a block replaced, more candidate calls than MAX_RECEIPT_READS): a log
     * range with such a read is not taken as searched (`scan`).
     */
    missing: number;
}

/** A recognized execution: the request of a relayTransfer call that the sender signed at the nonce checked, and its id. */
export interface Execution {
    readonly version: TransferVersion;
    readonly id: Hex;
}

export function notUsed(status: 'pending' | 'expired'): OnChainConfirmation {
    return { status, txHash: null, blockNumber: null, executedTransfer: null };
}

export function unresolved(seen: Seen): OnChainConfirmation {
    return { status: 'unresolved', txHash: null, blockNumber: null, executedTransfer: null, reason: seen.history ? 'not_found' : 'no_history' };
}

/** No evidence from a read where the chain must hold some (`Seen.missing`). */
export function missing(search: Search): undefined {
    search.seen.missing += 1;
    return undefined;
}
