// The reads of the on-chain check (confirm.ts): every JSON-RPC request it makes, counted against the requests of one
// check, and what counts as an answer of the RPC.

import {
    BaseError,
    ContractFunctionZeroDataError,
    formatTransactionReceipt,
    numberToHex,
    TransactionReceiptNotFoundError,
    type Client,
    type TransactionReceipt,
} from 'viem';
import { getBlock, getCode, getTransactionReceipt, readContract } from 'viem/actions';
import { gaslessTransferAbi } from '../core/abi.js';
import { GaslessError } from '../core/errors.js';
import type { ChainPins } from '../core/pins.js';
import type { Address, Hex } from '../core/types.js';
import { withoutCcipRead } from './ccipRead.js';
import type { Block, LogFilter, RawLog, Search } from './confirmContext.js';

/** JSON-RPC requests one check makes at most; once they are used up, the answer is `unresolved`. */
export const MAX_CHECK_REQUESTS = 500;

/** Thrown once a check has made MAX_CHECK_REQUESTS requests; the check then answers `unresolved`. */
export class RequestsUsedUp extends Error {}

/**
 * The client with every JSON-RPC request counted against `budget`, as the view of `withoutCcipRead`: CCIP-Read is
 * off, and the actions of an extended client (a PublicClient's `call`, which readContract would take) are hidden, so
 * that every read goes through `request`.
 */
export function counted(client: Client, budget: { left: number }): Client {
    return new Proxy(withoutCcipRead(client), {
        get(target, property, receiver) {
            if (property !== 'request') return Reflect.get(target, property, receiver);
            return async (...args: unknown[]) => {
                if (budget.left <= 0) throw new RequestsUsedUp(`a check makes at most ${MAX_CHECK_REQUESTS} requests`);
                budget.left -= 1;
                return Reflect.apply(target.request, target, args) as Promise<unknown>;
            };
        },
    });
}

/**
 * The error that ends a check, if `error` is one or wraps one (viem wraps it as the cause of its own error): used-up
 * requests, or a timeout or an abort of waitForTransferOutcome.
 */
export function stopping(error: unknown): Error | undefined {
    for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 8; cause = cause.cause, depth++) {
        if (cause instanceof GaslessError || cause instanceof RequestsUsedUp) return cause;
    }
    return undefined;
}

/**
 * `nonces(from)` at a block. eth_call answers no data where the pinned contract has no code: at a block between
 * `pins.deployBlock` (a lower bound: the deploy scripts record the block before the broadcast) and its creation. The
 * nonce is 0 there, so no data is read as 0 once eth_getCode shows no code at that block. Where the contract has code,
 * no data is a wrong answer of the RPC and the read fails with its error, as it does when the code cannot be read:
 * taken for 0, it would make a used nonce look unused, and past the deadline `expired`.
 */
export async function readNonce(client: Client, pins: ChainPins, from: Address, blockNumber: bigint): Promise<bigint> {
    try {
        return await readContract(client, { address: pins.transfer.address, abi: gaslessTransferAbi, functionName: 'nonces', args: [from], blockNumber });
    } catch (error) {
        if (!(error instanceof BaseError) || error.walk((e) => e instanceof ContractFunctionZeroDataError) === null) throw error;
        const code = await getCode(client, { address: pins.transfer.address, blockNumber });
        if (code === undefined || code === '0x') return 0n;
        throw error;
    }
}

/** The header of the block with this number, read once per check. */
export async function headerAt(search: Search, blockNumber: bigint): Promise<Block> {
    const known = search.headers.get(blockNumber);
    if (known !== undefined) return known;
    const { hash, timestamp } = await getBlock(search.client, { blockNumber });
    const header = { number: blockNumber, hash, timestamp };
    search.headers.set(blockNumber, header);
    return header;
}

/** Whether the block with this number is the canonical one with this hash. */
export async function isCanonical(search: Search, blockNumber: bigint, blockHash: string): Promise<Block | undefined> {
    const block = await headerAt(search, blockNumber);
    return block.hash !== null && block.hash.toLowerCase() === blockHash.toLowerCase() ? block : undefined;
}

/** The block with this number and its transactions; undefined if it is not the block of that number the check read before. */
export async function blockWithTransactions(search: Search, blockNumber: bigint) {
    const block = await getBlock(search.client, { blockNumber, includeTransactions: true });
    const hash: Hex | null = block.hash;
    const known = search.headers.get(blockNumber);
    if (hash === null || (known !== undefined && known.hash?.toLowerCase() !== hash.toLowerCase())) return undefined;
    search.headers.set(blockNumber, { number: blockNumber, hash, timestamp: block.timestamp });
    return block;
}

export async function receiptOf(search: Search, txHash: Hex) {
    try {
        return await getTransactionReceipt(search.client, { hash: txHash });
    } catch (error) {
        // A replaced (sped-up) transaction has no receipt.
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
    }
}

/**
 * The receipts of a block by transaction hash, from one eth_getBlockReceipts: only those that name this block. Empty
 * if the RPC does not answer it; after an error the check asks no more and reads receipts one by one.
 */
export async function blockReceipts(search: Search, block: { readonly number: bigint; readonly hash: Hex }): Promise<ReadonlyMap<string, TransactionReceipt>> {
    const receipts = new Map<string, TransactionReceipt>();
    if (!search.seen.blockReceipts) return receipts;
    let answer: unknown;
    try {
        answer = await search.client.request({ method: 'eth_getBlockReceipts', params: [numberToHex(block.number)] });
    } catch (error) {
        const stop = stopping(error);
        if (stop !== undefined) throw stop;
        search.seen.blockReceipts = false;
        return receipts;
    }
    if (!Array.isArray(answer)) return receipts;
    const format = (search.client.chain?.formatters?.transactionReceipt?.format as ((raw: never) => TransactionReceipt) | undefined) ?? formatTransactionReceipt;
    for (const raw of answer as unknown[]) {
        let receipt: TransactionReceipt;
        try {
            receipt = format(raw as never);
        } catch {
            continue;
        }
        if (typeof receipt.transactionHash !== 'string' || typeof receipt.blockHash !== 'string') continue;
        if (receipt.blockHash.toLowerCase() === block.hash.toLowerCase()) receipts.set(receipt.transactionHash.toLowerCase(), receipt);
    }
    return receipts;
}

/** The logs of `filter` in [lo, hi], or the RPC's error if it refuses the query. */
export async function logsIn(search: Search, filter: LogFilter, lo: bigint, hi: bigint): Promise<readonly RawLog[] | { readonly refused: unknown }> {
    try {
        return (await search.client.request({
            method: 'eth_getLogs',
            params: [{ address: filter.address as Address | Address[], topics: [...filter.topics], fromBlock: numberToHex(lo), toBlock: numberToHex(hi) }],
        })) as readonly RawLog[];
    } catch (error) {
        const stop = stopping(error);
        if (stop !== undefined) throw stop;
        return { refused: error };
    }
}

/**
 * Whether the nonce was still unused at `blockNumber` (`nonces(from)` not above it), or undefined if the node cannot
 * tell: a node without the state of older blocks refuses the read, and no data where the contract has code is no
 * answer either (`readNonce`).
 */
export async function unusedAt(search: Search, blockNumber: bigint): Promise<boolean | undefined> {
    try {
        return (await readNonce(search.client, search.pins, search.request.from, blockNumber)) <= search.nonce;
    } catch (error) {
        const stop = stopping(error);
        if (stop !== undefined) throw stop;
        return undefined;
    }
}
