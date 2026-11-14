// The on-chain check of a payment: its entry points and the search by state. Its reads are in confirmRpc.ts, the
// evidence of an execution or an invalidation in confirmEvidence.ts, the log search for an RPC without the state of
// older blocks in confirmLogs.ts, and the types they share in confirmContext.ts.

import type { Client } from 'viem';
import { getBlock, getChainId } from 'viem/actions';
import { sameAddress } from '../core/address.js';
import { transferDigestFromAuthHash } from '../core/eip712.js';
import { GaslessValidationError, InvalidPinsError } from '../core/errors.js';
import type { ChainPins } from '../core/pins.js';
import { normalizeTransferRequest } from '../core/submit.js';
import type { Hex, TransferRequest, TransferVersion } from '../core/types.js';
import {
    BYTES32_RE,
    notUsed,
    unresolved,
    type Block,
    type Bracket,
    type ConfirmBlockTag,
    type ConfirmOnChainOptions,
    type ConfirmTarget,
    type OnChainConfirmation,
    type Search,
    type Seen,
} from './confirmContext.js';
import { executionIn, executionInBlock, invalidationFilter, invalidationIn } from './confirmEvidence.js';
import { newSearchProgress, searchLogs, type SearchProgress } from './confirmLogs.js';
import { blockWithTransactions, counted, logsIn, MAX_CHECK_REQUESTS, readNonce, RequestsUsedUp, stopping, unusedAt } from './confirmRpc.js';

export type { ConfirmBlockTag, ConfirmOnChainOptions, ConfirmTarget, OnChainConfirmation, OnChainStatus, UnresolvedReason } from './confirmContext.js';
export { MAX_RECEIPT_READS } from './confirmEvidence.js';
export { LOG_INDEX_LAG_BLOCKS, newSearchProgress, type SearchProgress } from './confirmLogs.js';
export { MAX_CHECK_REQUESTS } from './confirmRpc.js';

export const BLOCK_TAGS: readonly ConfirmBlockTag[] = ['latest', 'safe', 'finalized'];

/**
 * The intent nonce is used at a block below `pins.deployBlock`, where the pin says the contract did not exist: the pin
 * is above the contract's creation block. Nothing the check skipped below the pin can be trusted then, so this is an
 * error and never an answer (a use below the pin, read from the pin upwards, would look like `expired`).
 */
function deployBlockTooHigh(pins: ChainPins, blockNumber: bigint): InvalidPinsError {
    return new InvalidPinsError('deployBlock', `the intent nonce is already used at block ${blockNumber}, below pins.deployBlock (${pins.deployBlock}): it must be at or below the contract's creation block`);
}

/**
 * The first block at whose state `nonces(from)` is above the nonce, B: the block of the transaction that used it.
 * `nonces(from)` never decreases and is above the nonce at the block read, so B is found from historical state
 * (eth_call at a block number) without any log: the search steps down from the block read by 1, 2, 4, … blocks until
 * the nonce is unused there, then bisects. Below `floor` (the deploy block) the contract did not exist; from there to
 * its creation it has no code, and the nonce reads 0 (`readNonce`). A use d blocks below the block read costs at most
 * 2·floor(log2(d + 1)) + 1 reads. If the node refuses a read (no state of that block), the bracket found so far is
 * returned instead.
 *
 * The search takes the nonce for unused below the floor without a read. So when it ends at the floor itself, the block
 * below is read once: a nonce already used there shows that `pins.deployBlock` is above the contract's creation, and
 * the use can then be in any earlier block (`deployBlockTooHigh`).
 */
async function firstUse(search: Search, floor: bigint): Promise<bigint | Bracket> {
    let used = search.block.number;
    let unused = floor - 1n;
    for (let step = 1n; used - step >= floor; step *= 2n) {
        const probe = used - step;
        const state = await unusedAt(search, probe);
        if (state === undefined) return { used, unused: undefined };
        if (state) {
            unused = probe;
            break;
        }
        used = probe;
    }
    while (used - unused > 1n) {
        const mid: bigint = unused + (used - unused) / 2n;
        const state = await unusedAt(search, mid);
        if (state === undefined) return { used, unused };
        if (state) unused = mid;
        else used = mid;
    }
    if (used === floor && floor > 0n) {
        const state = await unusedAt(search, floor - 1n);
        if (state === undefined) return { used, unused: undefined };
        if (!state) throw deployBlockTooHigh(search.pins, floor - 1n);
    }
    return used;
}

/**
 * The answer from B, the first block at whose state the nonce is used: what used it is in B. If B is after the
 * deadline, the nonce was unused at the last block at or before it: `expired`, whatever used it later. Otherwise a
 * direct relayTransfer call in B (`executionInBlock`) or the sender's NonceInvalidated event in B whose range covers
 * the nonce (one eth_getLogs for that block, with a filter only the sender's events match); else no answer (a call of
 * relayTransfer from another contract, or a block that is not B on this RPC any more).
 */
async function useIn(search: Search, blockNumber: bigint): Promise<OnChainConfirmation | undefined> {
    const block = await blockWithTransactions(search, blockNumber);
    if (block === undefined) return undefined;
    if (block.timestamp > search.deadline) return notUsed('expired');
    const execution = await executionInBlock(search, block);
    if (execution !== undefined) return execution;
    const logs = await logsIn(search, invalidationFilter(search), blockNumber, blockNumber);
    if ('refused' in logs) throw logs.refused;
    return invalidationIn(search, logs, blockNumber, blockNumber);
}

/**
 * The ids of a payment's versions (`ConfirmTarget.versions`) plus the checked version's own, which needs its
 * `authHash`. Every version of a payment keeps `from`, the nonce, `token` and `to` (`checkCorrection`); a list that
 * breaks this is not one payment's.
 * No listed version may have a later deadline than the checked one: it could execute after the checked version's
 * deadline, where the check answers `expired` whatever used the nonce later, and a new payment would then pay twice.
 */
export function paymentVersionIds(pins: ChainPins, request: TransferRequest, authHash: Hex | undefined, versions: readonly TransferVersion[]): ReadonlySet<string> {
    if (!Array.isArray(versions)) throw new GaslessValidationError('invalid_request', 'versions', 'expected an array of TransferVersion');
    const list: readonly TransferVersion[] = authHash === undefined ? versions : [...versions, { request, authHash }];
    const ids = new Set<string>();
    list.forEach((version, i) => {
        const field = `versions[${i}]`;
        if (typeof version !== 'object' || version === null) throw new GaslessValidationError('invalid_request', field, 'expected a TransferVersion');
        const other = normalizeTransferRequest(version.request);
        if (typeof version.authHash !== 'string' || !BYTES32_RE.test(version.authHash)) {
            throw new GaslessValidationError('invalid_request', `${field}.authHash`, 'expected bytes32');
        }
        if (
            !sameAddress(other.from, request.from) ||
            other.nonce !== request.nonce ||
            !sameAddress(other.token, request.token) ||
            !sameAddress(other.to, request.to)
        ) {
            throw new GaslessValidationError('invalid_request', field, 'every version of a payment has the same from, nonce, token and to');
        }
        if (BigInt(other.deadline) > BigInt(request.deadline)) {
            throw new GaslessValidationError('invalid_request', `${field}.request.deadline`, 'is later than the checked version\'s deadline: check the payment\'s latest version');
        }
        ids.add(transferDigestFromAuthHash(pins.chainId, pins.transfer.address, other, version.authHash.toLowerCase() as Hex).toLowerCase());
    });
    return ids;
}

/**
 * Independent on-chain check of a payment, without trusting the relay: reads `nonces(from)` and, if it is above the
 * version's nonce, finds what used the nonce: the execution of a version of the payment or of another payment of the
 * sender, or the sender's invalidation. All reads are pinned to one block (`options.blockTag`, default the latest
 * block). With the relay's `txHash` (`options.txHash`) the receipt and the transaction usually answer at once.
 *
 * Otherwise the state locates the use (`firstUse`): `nonces(from)` never decreases, so the first block at whose state
 * it is above the nonce holds the transaction that used it, and at most 2·floor(log2(d + 1)) + 1 eth_calls at block
 * numbers find that block, d blocks below the block read. Only that block is inspected: its direct relayTransfer
 * calls (from the request's relay, signed by the sender at this nonce), with their receipts from one
 * eth_getBlockReceipts (one by one, at most MAX_RECEIPT_READS, where the RPC refuses it), and the sender's
 * NonceInvalidated events in it. GaslessTransfer emits no event for a transfer, and no query asks for logs that other
 * accounts can emit, so what they emit changes neither the answer nor the number of requests.
 *
 * An RPC without the state of older blocks refuses those reads; the check then searches logs (`searchLogs`): the
 * pinned tokens' Transfer logs from the sender, whose transactions are checked, and the sender's NonceInvalidated
 * events, in ranges of at most 1000 blocks that halve when the RPC refuses one. Anyone can add zero-amount Transfer
 * logs of the sender; a block whose Transfer logs the RPC refuses even alone, or answers with 1000 or more, is
 * searched through its transactions instead. A check makes at most MAX_CHECK_REQUESTS (500) requests; with them used
 * up, the answer is `unresolved` (`no_history`). A refused NonceInvalidated query of one block, and every other RPC
 * error, is thrown.
 *
 * Neither search goes below `pins.deployBlock`: the contract did not exist there. When the search by state ends at the
 * pin, the nonce is read once in the block under it; a nonce used there, or at a block read that is itself below the
 * pin, means the pin is above the contract's creation block: `InvalidPinsError`, never an answer. The log search
 * cannot make that read: when the last block at or before the deadline lies below the pin, it gives no answer
 * (`unresolved`), never `expired`.
 */
export async function confirmOnChain(
    client: Client,
    pins: ChainPins,
    target: ConfirmTarget,
    options: ConfirmOnChainOptions = {},
): Promise<OnChainConfirmation> {
    return confirmWithProgress(client, pins, target, options, newSearchProgress());
}

/**
 * `confirmOnChain`, resuming the log search of the earlier checks of the same target with the same options
 * (`waitForTransferOutcome` keeps one `progress` for its polls).
 */
export async function confirmWithProgress(
    client: Client,
    pins: ChainPins,
    target: ConfirmTarget,
    options: ConfirmOnChainOptions,
    progress: SearchProgress,
): Promise<OnChainConfirmation> {
    const request = normalizeTransferRequest(target.request);
    const authHash = target.authHash;
    if (authHash !== undefined && (typeof authHash !== 'string' || !BYTES32_RE.test(authHash))) {
        throw new GaslessValidationError('invalid_request', 'authHash', 'expected bytes32');
    }
    const versionIds = target.versions === undefined ? undefined : paymentVersionIds(pins, request, authHash, target.versions);
    const blockTag = options.blockTag ?? 'latest';
    if (!BLOCK_TAGS.includes(blockTag)) throw new TypeError('blockTag: expected "latest", "safe" or "finalized"');
    if (options.fromBlock !== undefined && (typeof options.fromBlock !== 'bigint' || options.fromBlock < 0n)) {
        throw new TypeError('fromBlock: expected a non-negative bigint');
    }
    if (options.txHash !== undefined && (typeof options.txHash !== 'string' || !BYTES32_RE.test(options.txHash))) {
        throw new TypeError('txHash: expected bytes32');
    }
    const deadline = BigInt(request.deadline);
    let earliestDeadline = deadline;
    for (const version of target.versions ?? []) {
        const other = BigInt(normalizeTransferRequest(version.request).deadline);
        if (other < earliestDeadline) earliestDeadline = other;
    }
    const rpc = counted(client, { left: MAX_CHECK_REQUESTS });
    const seen: Seen = { history: true, blockReceipts: true, missing: 0 };
    try {
        const chainId = await getChainId(rpc);
        if (chainId !== pins.chainId) throw new GaslessValidationError('wrong_chain', 'client', `client is on chain ${chainId}, pins are for ${pins.chainId}`);

        // One block for every read: the nonce, the deadline comparison and the search agree with each other.
        const read = await getBlock(rpc, { blockTag });
        const block: Block = { number: read.number, hash: read.hash, timestamp: read.timestamp };
        const nonce = BigInt(request.nonce);
        const floor = BigInt(pins.deployBlock ?? 0);
        if ((await readNonce(rpc, pins, request.from, block.number)) <= nonce) return notUsed(block.timestamp > deadline ? 'expired' : 'pending');
        // The finalized block of a young deployment can precede it: the contract has no code there and the nonce reads 0.
        if (block.number < floor) throw deployBlockTooHigh(pins, block.number);

        const search: Search = {
            client: rpc,
            pins,
            request,
            authHash: authHash?.toLowerCase() as Hex | undefined,
            versionIds,
            block,
            nonce,
            deadline,
            earliestDeadline,
            headers: new Map([[block.number, block]]),
            seen,
        };
        if (options.txHash !== undefined) {
            const answer = await executionIn(search, options.txHash);
            if (answer !== undefined) return answer;
        }
        const use = await firstUse(search, floor);
        if (typeof use !== 'bigint') seen.history = false;
        const answer = typeof use === 'bigint' ? await useIn(search, use) : await searchLogs(search, options.fromBlock, floor, use, progress);
        return answer ?? unresolved(seen);
    } catch (error) {
        const stop = stopping(error);
        if (stop instanceof RequestsUsedUp) return unresolved(seen);
        // A timeout or an abort of waitForTransferOutcome, without viem's errors around the read it stopped.
        throw stop ?? error;
    }
}
