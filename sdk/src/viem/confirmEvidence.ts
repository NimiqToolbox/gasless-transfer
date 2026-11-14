// The evidence of the on-chain check (confirm.ts) for what used a nonce: a relayTransfer call that executed a request
// of the sender at it, or the sender's NonceInvalidated event covering it.

import { decodeEventLog, decodeFunctionData, encodeEventTopics, pad, recoverAddress, TransactionNotFoundError, type TransactionReceipt } from 'viem';
import { getTransaction } from 'viem/actions';
import { gaslessTransferAbi } from '../core/abi.js';
import { sameAddress } from '../core/address.js';
import { tokenAuthHash, transferDigest } from '../core/eip712.js';
import { normalizeTransferRequest } from '../core/submit.js';
import type { Address, AuthModeName, Hex, TokenAuthorization, TransferRequest } from '../core/types.js';
import { BYTES32_RE, missing, type Execution, type LogFilter, type OnChainConfirmation, type RawLog, type Search } from './confirmContext.js';
import { blockReceipts, isCanonical, receiptOf, type blockWithTransactions } from './confirmRpc.js';

const AUTH_MODE_NAMES: readonly AuthModeName[] = ['none', 'permit', 'metaTxApprove'];
/**
 * Receipts the check reads one by one in a block, where the RPC refuses eth_getBlockReceipts; a block with more
 * candidate calls gives no execution (`unresolved`, unless it holds the sender's invalidation).
 */
export const MAX_RECEIPT_READS = 16;
const NONCE_INVALIDATED_TOPIC = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated' })[0] as Hex;

function sameRequest(a: TransferRequest, b: TransferRequest): boolean {
    return (
        sameAddress(a.token, b.token) &&
        sameAddress(a.from, b.from) &&
        sameAddress(a.to, b.to) &&
        a.amount === b.amount &&
        a.fee === b.fee &&
        sameAddress(a.relay, b.relay) &&
        a.nonce === b.nonce &&
        a.deadline === b.deadline
    );
}

/** The request, token authorization and signature of a relayTransfer call of `from`, at the nonce checked. */
function decodeRelayTransfer(input: Hex, search: Search): { request: TransferRequest; authorization: TokenAuthorization; signature: Hex } | undefined {
    let call;
    try {
        call = decodeFunctionData({ abi: gaslessTransferAbi, data: input });
    } catch {
        return undefined;
    }
    if (call.functionName !== 'relayTransfer') return undefined;
    const [r, signature, auth] = call.args;
    const mode = AUTH_MODE_NAMES[auth.mode];
    if (!sameAddress(r.from, search.request.from) || mode === undefined) return undefined;
    return {
        request: normalizeTransferRequest({
            token: r.token,
            from: r.from,
            to: r.to,
            amount: r.amount,
            fee: r.fee,
            relay: r.relay,
            nonce: search.request.nonce,
            deadline: r.deadline,
        }),
        authorization: { mode, v: auth.v, r: auth.r.toLowerCase() as Hex, s: auth.s.toLowerCase() as Hex },
        signature,
    };
}

/**
 * The decoded call as an execution at the nonce checked, if its signature recovers to the sender for its request at
 * this nonce. The contract accepted the signature at the nonce it read, and an ECDSA signature recovers to the same
 * key for one digest only, so a successful call used exactly this nonce.
 */
async function signedAtNonce(search: Search, call: NonNullable<ReturnType<typeof decodeRelayTransfer>>): Promise<Execution | undefined> {
    const id = transferDigest(search.pins.chainId, search.pins.transfer.address, call.request, call.authorization);
    let signer: Address;
    try {
        signer = await recoverAddress({ hash: id, signature: call.signature });
    } catch {
        return undefined;
    }
    if (!sameAddress(signer, search.request.from)) return undefined;
    return { version: Object.freeze({ request: Object.freeze(call.request), authHash: tokenAuthHash(call.authorization) }), id };
}

/**
 * Whether an executed request at the nonce is a version of the checked payment: listed in `versions`, or, without the
 * list, of the same token and recipient (a correction keeps both; another token or recipient is another payment).
 */
function samePayment(search: Search, executed: TransferRequest, id: Hex): boolean {
    if (search.versionIds !== undefined) return search.versionIds.has(id.toLowerCase());
    return sameAddress(executed.token, search.request.token) && sameAddress(executed.to, search.request.to);
}

function executionAnswer(search: Search, execution: Execution, txHash: Hex, blockNumber: bigint): OnChainConfirmation {
    const { version, id } = execution;
    const exact = sameRequest(version.request, search.request) && (search.authHash === undefined || search.authHash === version.authHash);
    const status = exact ? 'executed' : samePayment(search, version.request, id) ? 'other_version_executed' : 'other_payment_executed';
    return { status, txHash, blockNumber, executedTransfer: version };
}

/** Whether a receipt shows a successful call of the pinned contract. */
function succeeded(search: Search, receipt: TransactionReceipt): boolean {
    return receipt.status === 'success' && receipt.to !== null && sameAddress(receipt.to, search.pins.transfer.address);
}

/**
 * The answer from a transaction, if it executed a request of the sender at the nonce checked: a successful call of
 * relayTransfer on the pinned contract (the transaction's `to` and its receipt's), in a canonical block at or below the
 * block read and not after this version's deadline (no version of the payment executes later; a request that does is
 * not the payment's), whose signature recovers to the sender for the decoded request at this nonce (`signedAtNonce`).
 * A reverted call is no execution: the relay reports the hash of its call also when it reverted. A receipt or a
 * transaction that is not served, is of another block, or that reverted although logs name it, is `missing`.
 */
export async function executionIn(search: Search, txHash: Hex): Promise<OnChainConfirmation | undefined> {
    const contract = search.pins.transfer.address;
    const receipt = await receiptOf(search, txHash);
    if (receipt === undefined || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) return missing(search);
    // A call of another contract, also one that passes the request's call data on, is not recognized.
    if (receipt.to === null || !sameAddress(receipt.to, contract)) return undefined;
    if (receipt.status !== 'success' || receipt.blockNumber > search.block.number) return missing(search);
    // A cached receipt can outlive its fork: only a canonical execution counts.
    const block = await isCanonical(search, receipt.blockNumber, receipt.blockHash);
    if (block === undefined) return missing(search);
    if (block.timestamp > search.deadline) return undefined;
    let tx;
    try {
        tx = await getTransaction(search.client, { hash: txHash });
    } catch (error) {
        if (error instanceof TransactionNotFoundError) return missing(search);
        throw error;
    }
    if (tx.hash.toLowerCase() !== txHash.toLowerCase() || tx.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return missing(search);
    if (tx.to === null || !sameAddress(tx.to, contract)) return undefined;
    const call = decodeRelayTransfer(tx.input, search);
    const execution = call === undefined ? undefined : await signedAtNonce(search, call);
    return execution === undefined ? undefined : executionAnswer(search, execution, receipt.transactionHash, receipt.blockNumber);
}

/**
 * The answer from the transactions of a block that call relayTransfer of the pinned contract directly, if one of them
 * executed a request of the sender at the nonce checked: sent by that request's relay (the contract requires
 * `msg.sender == relay`), signed by the sender at this nonce (`signedAtNonce`) and successful. No other account can
 * add such a transaction: it needs the sender's signature and the relay's key; that relay can add reverted copies of
 * its call. Their receipts come from one eth_getBlockReceipts, whatever their number; where the RPC refuses it, they
 * are read one by one, at most MAX_RECEIPT_READS (beyond that the block gives no execution: `missing`). A call of
 * relayTransfer from another contract is not recognized.
 */
export async function executionInBlock(search: Search, block: NonNullable<Awaited<ReturnType<typeof blockWithTransactions>>>): Promise<OnChainConfirmation | undefined> {
    if (block.timestamp > search.deadline) return undefined;
    const contract = search.pins.transfer.address;
    const blockHash = block.hash.toLowerCase();
    let receipts: ReadonlyMap<string, TransactionReceipt> | undefined;
    let reads = 0;
    for (const tx of block.transactions) {
        if (tx.to === null || !sameAddress(tx.to, contract)) continue;
        if (tx.blockHash?.toLowerCase() !== blockHash) {
            missing(search);
            continue;
        }
        const call = decodeRelayTransfer(tx.input, search);
        if (call === undefined || !sameAddress(tx.from, call.request.relay)) continue;
        receipts ??= await blockReceipts(search, block);
        let receipt = receipts.get(tx.hash.toLowerCase());
        // A listed receipt decides before the signature is recovered: a reverted copy costs nothing more.
        if (receipt !== undefined && !succeeded(search, receipt)) continue;
        const execution = await signedAtNonce(search, call);
        if (execution === undefined) continue;
        if (receipt === undefined) {
            if (reads === MAX_RECEIPT_READS) {
                missing(search);
                break;
            }
            reads += 1;
            receipt = await receiptOf(search, tx.hash);
            if (receipt === undefined || receipt.blockHash.toLowerCase() !== blockHash || receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) {
                missing(search);
                continue;
            }
            if (!succeeded(search, receipt)) continue;
        }
        return executionAnswer(search, execution, tx.hash, block.number);
    }
    return undefined;
}

/** The answer from the first NonceInvalidated log in [lo, hi] whose range covers the nonce, if any. */
export async function invalidationIn(search: Search, logs: readonly RawLog[], lo: bigint, hi: bigint): Promise<OnChainConfirmation | undefined> {
    for (const log of logs) {
        if (log.removed === true || log.transactionHash === null || log.blockNumber === null || typeof log.blockHash !== 'string') continue;
        if (!sameAddress(log.address, search.pins.transfer.address)) continue;
        // Only the range asked for, so that nothing above the block read counts.
        const blockNumber = BigInt(log.blockNumber);
        if (blockNumber < lo || blockNumber > hi) continue;
        let event;
        try {
            event = decodeEventLog({ abi: gaslessTransferAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
        } catch {
            continue;
        }
        if (event.eventName !== 'NonceInvalidated' || !sameAddress(event.args.signer, search.request.from)) continue;
        if (event.args.previousNonce > search.nonce || search.nonce >= event.args.newNonce) continue;
        // Log responses can also be cached across reorgs. Only canonical evidence may decide that
        // an invalidation (rather than a payment) used the nonce and make a fresh payment safe.
        if ((await isCanonical(search, blockNumber, log.blockHash)) !== undefined) {
            return { status: 'nonce_consumed', txHash: log.transactionHash, blockNumber, executedTransfer: null };
        }
        missing(search);
    }
    return undefined;
}

/**
 * Whether a Transfer log moved a positive amount. Anyone can emit Transfer(from, to, 0) of USDC or USDT0 for any
 * `from` (transferFrom of 0 needs no allowance), and the contract never moves 0 (it refuses amount 0), so such logs
 * are dropped before their transactions are read.
 */
function movesTokens(log: RawLog): boolean {
    return BYTES32_RE.test(log.data) && BigInt(log.data) > 0n;
}

/** The answer from the transactions of the sender's transfers of pinned tokens in [lo, hi], if one executed the nonce. */
export async function executionAmong(search: Search, logs: readonly RawLog[], lo: bigint, hi: bigint): Promise<OnChainConfirmation | undefined> {
    const seen = new Set<string>();
    for (const log of logs) {
        if (log.removed === true || log.transactionHash === null || log.blockNumber === null || !movesTokens(log)) continue;
        const blockNumber = BigInt(log.blockNumber);
        if (blockNumber < lo || blockNumber > hi || !search.pins.tokens.some((token) => sameAddress(log.address, token.address))) continue;
        const hash = log.transactionHash.toLowerCase();
        if (seen.has(hash)) continue;
        seen.add(hash);
        const answer = await executionIn(search, log.transactionHash);
        if (answer !== undefined) return answer;
    }
    return undefined;
}

/** The sender's NonceInvalidated events of the pinned contract: only the sender emits them. */
export function invalidationFilter(search: Search): LogFilter {
    return { address: search.pins.transfer.address, topics: [NONCE_INVALIDATED_TOPIC, pad(search.request.from.toLowerCase() as Hex, { size: 32 })] };
}
