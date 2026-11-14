// Reads for decisions that need every configured RPC. Ordinary reads use the relay's failover client,
// which trusts the first provider that responds. Decisions that change a request's outcome on-chain or the
// relay's nonce range (a new tx nonce, a nonce_used failure, settling, undoing a mined outcome, raising, lowering or
// filling the nonce range) ask every RPC in RELAY_RPC_URLS on its own through these helpers and need a positive answer
// from each of them in the same pass. An RPC that does not answer, answers with an error or too slowly, or has not
// seen the state yet holds such a decision back; so does evidence against it from any RPC. No block number that one
// RPC reported decides for another RPC. A lying, lagging or silent RPC can therefore delay these decisions, but it
// cannot make one while another configured RPC is honest. What the first RPC decides alone (readiness, the ordinary
// reads, and the end of a queued request before its first broadcast) is listed in relay/docs/transaction-lifecycle.md,
// "Several RPCs", with the rules and the trust model.
import { BaseError, ContractFunctionZeroDataError, decodeEventLog, encodeEventTopics, pad, type Address, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { readIntentNonce } from '../chain/reads.js';
import type { BlockInfo, BlockTransaction, CallParams, ChainClient, LogFilter, ReadContractCall, ReceiptInfo } from '../chain/types.js';
import { classifyRpcFailure } from '../chain/viemChainClient.js';
import type { TxAttemptRecord } from '../store/types.js';
import { effectiveFinalized, fallbackFinalized } from './policy.js';

/** One read client per configured RPC (the client itself when it does not provide them). */
export function rpcClientsOf(chain: ChainClient): readonly ChainClient[] {
    const clients = chain.rpcClients?.();
    return clients && clients.length > 0 ? clients : [chain];
}

/** A read on an RPC was not started because the pass has used up the time for such reads (see withReadBudget). */
export class ReadBudgetExceeded extends Error {
    constructor() {
        super('the reads of this pass for the decisions that need every RPC ran out of time');
        this.name = 'ReadBudgetExceeded';
    }
}

/**
 * `chain`, whose reads throw ReadBudgetExceeded instead of starting once `expired()` is true.
 * The transaction manager asks every RPC through such a client, so however slowly one RPC answers (within its
 * timeout), and however many reads a decision would need on it, it cannot stretch a pass: reads already under way end
 * within RELAY_RPC_TIMEOUT_MS, and no new one starts. Broadcasts are not reads and are passed through.
 */
export function withReadBudget(chain: ChainClient, expired: () => boolean): ChainClient {
    const guard = <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
        (...args: A): Promise<R> => (expired() ? Promise.reject(new ReadBudgetExceeded()) : read(...args));
    const byNumber = chain.getBlockByNumber?.bind(chain);
    const withTransactions = chain.getBlockWithTransactions?.bind(chain);
    const blockReceipts = chain.getBlockReceipts?.bind(chain);
    const getLogs = chain.getLogs?.bind(chain);
    return {
        getChainId: guard(() => chain.getChainId()),
        getBlock: guard((tag: 'latest' | 'finalized') => chain.getBlock(tag)),
        ...(byNumber ? { getBlockByNumber: guard((n: bigint) => byNumber(n)) } : {}),
        ...(withTransactions ? { getBlockWithTransactions: guard((n: bigint) => withTransactions(n)) } : {}),
        ...(blockReceipts ? { getBlockReceipts: guard((n: bigint) => blockReceipts(n)) } : {}),
        ...(getLogs ? { getLogs: guard((filter: LogFilter) => getLogs(filter)) } : {}),
        getMaxPriorityFeePerGas: guard(() => chain.getMaxPriorityFeePerGas()),
        getBalance: guard((address: Address) => chain.getBalance(address)),
        getCode: guard((address: Address, blockNumber?: bigint) => chain.getCode(address, blockNumber)),
        ...(chain.getStorageAt ? { getStorageAt: guard((address: Address, slot: Hex, blockNumber: bigint) => chain.getStorageAt!(address, slot, blockNumber)) } : {}),
        getTransactionCount: guard((address: Address, tag: 'latest' | 'pending') => chain.getTransactionCount(address, tag)),
        readContract: <T>(call: ReadContractCall): Promise<T> => (expired() ? Promise.reject(new ReadBudgetExceeded()) : chain.readContract<T>(call)),
        call: guard((params: CallParams) => chain.call(params)),
        estimateGas: guard((params: CallParams) => chain.estimateGas(params)),
        sendRawTransaction: (serialized: Hex) => chain.sendRawTransaction(serialized),
        getTransactionReceipt: guard((hash: Hex) => chain.getTransactionReceipt(hash)),
    };
}

/** What one RPC treats as final. */
export interface Finality {
    /** Inclusions at or below this block are final (-1: nothing yet). */
    readonly finalized: bigint;
    /** The node's `finalized` tag, undefined if unsupported (or the read failed). */
    readonly finalizedTag: bigint | undefined;
}

/**
 * The finalized block by `chain`'s own view: min(finalized tag, head − minDepth), or without the tag
 * head − max(fallbackDepth, minDepth).
 */
export async function finalityOf(chain: ChainClient, head: BlockInfo, minDepth: number, fallbackDepth: number): Promise<Finality> {
    try {
        const tag = (await chain.getBlock('finalized')).number;
        return { finalized: effectiveFinalized(head.number, tag, minDepth), finalizedTag: tag };
    } catch (err) {
        // A read that was not started (the pass is out of time) says nothing about the tag.
        if (err instanceof ReadBudgetExceeded) throw err;
        return { finalized: fallbackFinalized(head.number, fallbackDepth, minDepth), finalizedTag: undefined };
    }
}

/** A receipt must identify the requested transaction, including on injected/non-viem clients.
 * A different genuine receipt can otherwise carry unrelated finality evidence into settlement. */
export async function receiptFor(chain: ChainClient, hash: Hex): Promise<ReceiptInfo | null> {
    const receipt = await chain.getTransactionReceipt(hash);
    if (receipt && receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
        throw new Error('RPC receipt transaction hash does not match the requested hash');
    }
    return receipt;
}

/** The receipt of one of `attempts` on `chain` (newest first); a successful call is preferred over a revert or a cancel. */
export async function findReceiptOn(
    chain: ChainClient,
    attempts: readonly TxAttemptRecord[],
): Promise<{ attempt: TxAttemptRecord; receipt: ReceiptInfo } | undefined> {
    let found: { attempt: TxAttemptRecord; receipt: ReceiptInfo } | undefined;
    for (const attempt of [...attempts].reverse()) {
        const receipt = await receiptFor(chain, attempt.hash);
        if (!receipt) continue;
        if (attempt.kind === 'call' && receipt.status === 'success') return { attempt, receipt };
        found ??= { attempt, receipt };
    }
    return found;
}

/**
 * GaslessBase: NonceInvalidated(address indexed signer, uint256 previousNonce, uint256 newNonce). It cancels every nonce
 * of the signer in [previousNonce, newNonce). Only the signer can emit it (invalidateNonces raises the caller's own nonce).
 */
export const NONCE_INVALIDATED_TOPIC = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated' })[0] as Hex;

/**
 * The eth_getLogs filter of the signer's invalidations: NonceInvalidated with the signer as its indexed topic. Only the
 * signer can emit such an event, so other accounts cannot add logs to the answer. The nonces it covers are in the log
 * data, which the caller compares.
 */
export function nonceEventFilter(signer: Address): readonly Hex[] {
    return [NONCE_INVALIDATED_TOPIC, pad(signer.toLowerCase() as Hex, { size: 32 })];
}

/** The nonces a NonceInvalidated log cancels, [previousNonce, newNonce), or undefined if the log does not decode. */
export function invalidatedRange(log: { readonly topics: readonly Hex[]; readonly data: Hex }): { readonly from: bigint; readonly to: bigint } | undefined {
    try {
        const event = decodeEventLog({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', topics: [...log.topics] as [Hex, ...Hex[]], data: log.data });
        return { from: event.args.previousNonce, to: event.args.newNonce };
    } catch {
        return undefined;
    }
}

/** The block that used an intent nonce, as one RPC shows it. */
export interface UseBlock {
    readonly number: bigint;
    readonly hash: Hex;
    readonly timestamp: bigint;
    readonly baseFeePerGas: bigint | null;
}

/**
 * How one RPC shows the use of a request's intent nonce. B, the first block at whose state `nonces(signer)` is above
 * the nonce, holds the transaction that used it (findNonceUse):
 * - `executed`: a direct call of the relay that executes exactly this request (its id) in B, with its successful
 *   receipt of B (`receipt`). Only a successful receipt shows an execution: a relayTransfer of another request called
 *   through code before the relay's call (by a contract, or by an EOA with an EIP-7702 delegation calling itself) makes
 *   that call revert, and the call's inclusion in B shows nothing;
 * - `other`: a successful direct relayTransfer of another request of the signer at the nonce in B (another version of
 *   the payment, or another payment);
 * - `invalidated`: the signer's NonceInvalidated in B, whose range covers the nonce;
 * - `late`: B is after the request's deadline. The contract refuses the request there, so something else used the
 *   nonce;
 * - `unknown`: no answer from this RPC: it has no state of an older block, or nothing it shows in B identifies the use
 *   (a relayTransfer called through code, receipts it does not serve, an inconsistent view). `listed`: the relay's call
 *   of the request is in B, and the RPC serves no receipt of it.
 */
export type NonceUse =
    | { readonly kind: 'executed'; readonly block: UseBlock; readonly tx: BlockTransaction; readonly receipt: ReceiptInfo }
    | { readonly kind: 'other'; readonly block: UseBlock; readonly tx: Hex }
    | { readonly kind: 'invalidated'; readonly block: UseBlock; readonly tx: Hex }
    | { readonly kind: 'late'; readonly block: UseBlock }
    | { readonly kind: 'unknown'; readonly why: string; readonly listed?: boolean };

/**
 * Receipts findNonceUse reads one by one in B where the RPC refuses eth_getBlockReceipts. Past that B shows no
 * execution on that RPC (`unknown`): a relay named in a signed request can put any number of reverted copies of its
 * call into B, and a search must stay within the pass's read budget.
 */
export const MAX_RECEIPT_READS = 16;

/**
 * Whether a failed eth_getBlockReceipts is the RPC's refusal of the method (an answer: a JSON-RPC error, an HTTP error
 * status, an answer that is no list), after which receipts are read one by one, rather than no answer (a timeout, a
 * rate limit, a lost connection), which is thrown as every other read of the search.
 */
export function refusedBlockReceipts(err: unknown): boolean {
    const { reason } = classifyRpcFailure(err);
    return reason === 'rpc_error' || reason === 'http_status' || reason === 'other';
}

/**
 * The receipts of `block` by lower-case transaction hash, from one eth_getBlockReceipts: only those that name this
 * block (its hash), so a reorg or a node's stale cache cannot add receipts of another block. undefined if the RPC
 * refuses the method or does not have the block. A read that the pass's budget does not start, or one without an
 * answer, is thrown.
 */
export async function blockReceipts(chain: ChainClient, block: { readonly number: bigint; readonly hash: Hex }): Promise<ReadonlyMap<string, ReceiptInfo> | undefined> {
    if (!chain.getBlockReceipts) return undefined;
    let receipts: readonly ReceiptInfo[] | null;
    try {
        receipts = await chain.getBlockReceipts(block.number);
    } catch (err) {
        if (err instanceof ReadBudgetExceeded || !refusedBlockReceipts(err)) throw err;
        return undefined;
    }
    if (receipts === null) return undefined;
    const byHash = new Map<string, ReceiptInfo>();
    for (const receipt of receipts) {
        if (receipt.blockNumber === block.number && same(receipt.blockHash, block.hash)) byHash.set(receipt.transactionHash.toLowerCase(), receipt);
    }
    return byHash;
}

/**
 * The receipt of transaction `hash` in `block` as `chain` serves it: eth_getTransactionReceipt, else from
 * eth_getBlockReceipts of the block. undefined if neither shows it in that block (its hash).
 */
export async function receiptInBlock(chain: ChainClient, block: { readonly number: bigint; readonly hash: Hex }, hash: Hex): Promise<ReceiptInfo | undefined> {
    const receipt = await receiptFor(chain, hash);
    if (receipt) return receipt.blockNumber === block.number && same(receipt.blockHash, block.hash) ? receipt : undefined;
    return (await blockReceipts(chain, block))?.get(hash.toLowerCase());
}

/** What findNonceUse looks for: the request's intent nonce and how a call that executes a request is recognized. */
export interface UseQuery {
    readonly contract: Address;
    /**
     * The deployment record's `deployBlock`: at or below the block that created the contract (the deploy scripts record
     * the block before the broadcast). No state below it is read.
     */
    readonly floor: bigint;
    readonly signer: Address;
    readonly nonce: bigint;
    readonly deadline: bigint;
    /** The request id: a call that executes exactly this request has it. */
    readonly id: Hex;
    /** The request a call of the contract executes at `nonce` (OperationDefinition.executionOf). */
    readonly executionOf: (call: { readonly to: Address; readonly data: Hex }, nonce: bigint) => Promise<{ id: Hex; signer: Address; relay: Address } | undefined>;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A state read the RPC refused: the block, and what it answered (for the ALERT; never the node's message). */
interface Refused {
    readonly refused: bigint;
    readonly answer: string;
}

/** eth_call answered no data ("0x"): the address had no code at that block. */
export const answeredNoData = (err: unknown): boolean => err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null;

/**
 * B: the first block at whose state `nonces(signer)` is above the nonce, at or below `used` and not below `q.floor`,
 * or the block whose state the RPC refuses (it has no state of older blocks). nonces only rise, so B holds the
 * transaction that used the nonce. The state at `used` is read first; then steps of 1, 2, 4, … blocks down, not below
 * the floor, until the nonce is unused there, and a binary search: 2·floor(log2(d + 1)) + 2 eth_calls at most for B d
 * blocks below `used`. No log is read, so nothing that other accounts emit changes the answer or the number of reads.
 *
 * Between the floor and the contract's creation eth_call answers no data: nonces is 0 there, so the nonce is unused.
 * Any other error that is an answer of the RPC (a JSON-RPC error such as a missing trie node) means it has no state of
 * that block. A timeout, a rate limit, an HTTP error or no connection is no answer and is thrown, as is a read that the
 * pass's budget does not start: the RPC does not answer in this pass (TxManager.ask).
 */
async function firstUse(chain: ChainClient, q: UseQuery, used: bigint): Promise<bigint | Refused | 'unused'> {
    const usedAt = async (block: bigint): Promise<boolean | Refused> => {
        try {
            return (await readIntentNonce(chain, q.contract, q.signer, block)) > q.nonce;
        } catch (err) {
            // A read that was not started (the pass is out of time) says nothing about the state.
            if (err instanceof ReadBudgetExceeded) throw err;
            if (answeredNoData(err)) return false;
            const failure = classifyRpcFailure(err);
            if (failure.reason !== 'rpc_error' && failure.reason !== 'other') throw err;
            return { refused: block, answer: failure.rpcCode === undefined ? 'an error' : `error ${failure.rpcCode}` };
        }
    };
    // The contract did not exist yet at `used`.
    if (used < q.floor) return 'unused';
    const top = await usedAt(used);
    if (typeof top !== 'boolean') return top;
    if (!top) return 'unused';
    // nonces(signer) is above the nonce at `high` and not above it at `low` (floor − 1: before the contract existed).
    let high = used;
    let low = q.floor - 1n;
    for (let step = 1n; high - step >= q.floor; step *= 2n) {
        const probe = high - step;
        const state = await usedAt(probe);
        if (typeof state !== 'boolean') return state;
        if (!state) {
            low = probe;
            break;
        }
        high = probe;
    }
    while (high - low > 1n) {
        const mid = low + (high - low) / 2n;
        const state = await usedAt(mid);
        if (typeof state !== 'boolean') return state;
        if (state) high = mid;
        else low = mid;
    }
    return high;
}

/**
 * How `chain` shows the use of the request's intent nonce, read from state at block `used` (usually the RPC's head)
 * and below (see NonceUse). Only B is inspected:
 * - its transactions to the contract that call a request of the signer signed at the nonce, sent by the relay that
 *   request names (the contract requires `msg.sender == relay`). No other account can add such a transaction: it needs
 *   the signer's signature and that relay's key. Their receipts come from one eth_getBlockReceipts of B, whatever their
 *   number, and a listed reverted one is skipped before its signature is recovered; where the RPC refuses the method,
 *   they are read one by one, at most MAX_RECEIPT_READS (past that B shows no execution on this RPC);
 * - the signer's NonceInvalidated events of B: one eth_getLogs of B with a filter that only the signer's events match.
 * The relay's call counts only with its successful receipt: listed in B without one, the RPC cannot tell (`unknown`,
 * `listed`). The reads: 2·floor(log2(d + 1)) + 2 eth_calls for B d blocks below `used`, one block with its
 * transactions, one eth_getBlockReceipts (or at most MAX_RECEIPT_READS receipts) and one eth_getLogs. An RPC error
 * (other than an answer that it has no state of an older block, see firstUse, or a refused eth_getBlockReceipts) and a
 * read that the pass's budget does not start are thrown.
 */
export async function findNonceUse(chain: ChainClient, q: UseQuery, used: bigint): Promise<NonceUse> {
    const b = await firstUse(chain, q, used);
    if (b === 'unused') return { kind: 'unknown', why: `the nonce is unused at block ${used}` };
    if (typeof b !== 'bigint') {
        return { kind: 'unknown', why: `the RPC does not serve the state of block ${b.refused} (it needs the state of older blocks; eth_call answered ${b.answer})` };
    }
    if (!chain.getBlockWithTransactions || !chain.getLogs) return { kind: 'unknown', why: 'the RPC client cannot read the transactions and logs of a block' };
    const block = await chain.getBlockWithTransactions(b);
    if (!block || block.number !== b) return { kind: 'unknown', why: `the RPC does not have block ${b}` };
    const at: UseBlock = { number: b, hash: block.hash, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas };
    if (block.timestamp > q.deadline) return { kind: 'late', block: at };
    // Asked once, at the first call of the contract; undefined: the RPC refuses eth_getBlockReceipts (one by one).
    let listedReceipts: ReadonlyMap<string, ReceiptInfo> | undefined;
    let asked = false;
    let reads = 0;
    let capped = false;
    let listed = false;
    let hidden = false;
    for (const tx of block.transactions) {
        if (tx.to === null || !same(tx.to, q.contract) || (tx.blockHash !== null && !same(tx.blockHash, block.hash))) continue;
        if (!asked) {
            asked = true;
            listedReceipts = await blockReceipts(chain, block);
        }
        let receipt = listedReceipts?.get(tx.hash.toLowerCase());
        // A reverted call did not use the nonce; a listed one costs no signature recovery.
        if (receipt && receipt.status !== 'success') continue;
        const execution = await q.executionOf({ to: tx.to, data: tx.input }, q.nonce);
        if (!execution || !same(execution.signer, q.signer) || !same(execution.relay, tx.from)) continue;
        const mine = same(execution.id, q.id);
        if (!receipt) {
            if (reads === MAX_RECEIPT_READS) {
                capped = true;
                break;
            }
            reads += 1;
            const served = await receiptFor(chain, tx.hash);
            if (!served) {
                if (mine) listed = true;
                else hidden = true;
                continue;
            }
            if (served.blockNumber !== b || !same(served.blockHash, block.hash)) return { kind: 'unknown', why: `the RPC shows a transaction of block ${b} with a receipt of another block` };
            if (served.status !== 'success') continue;
            receipt = served;
        }
        return mine ? { kind: 'executed', block: at, tx, receipt } : { kind: 'other', block: at, tx: tx.hash };
    }
    const signerTopic = nonceEventFilter(q.signer)[1];
    const logs = await chain.getLogs({ address: q.contract, topics: nonceEventFilter(q.signer), fromBlock: b, toBlock: b });
    for (const log of logs) {
        if (log.blockNumber !== b || !same(log.blockHash, block.hash) || !same(log.address, q.contract)) continue;
        if (log.topics[0]?.toLowerCase() !== NONCE_INVALIDATED_TOPIC || log.topics[1]?.toLowerCase() !== signerTopic) continue;
        // previousNonce ≤ nonce < newNonce: the nonce was unused right before this invalidation and used after it.
        const covered = invalidatedRange(log);
        if (covered && covered.from <= q.nonce && q.nonce < covered.to) return { kind: 'invalidated', block: at, tx: log.transactionHash };
    }
    if (capped) {
        return {
            kind: 'unknown',
            why: `the RPC refuses eth_getBlockReceipts, and block ${b} holds more than ${MAX_RECEIPT_READS} relayTransfer calls of the sender at the nonce whose receipts it would have to read one by one`,
            ...(listed ? { listed } : {}),
        };
    }
    if (listed) return { kind: 'unknown', why: `the RPC shows the relay's call in block ${b} but serves no receipt of it`, listed };
    if (hidden) return { kind: 'unknown', why: `the RPC does not serve the receipts of the relayTransfer calls in block ${b}` };
    return { kind: 'unknown', why: `nothing in block ${b} shows how the nonce was used (a relayTransfer called by another contract?)` };
}
