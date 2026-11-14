import type { Abi, Address, Hex } from 'viem';

export interface BlockInfo {
    readonly number: bigint;
    readonly timestamp: bigint;
    readonly baseFeePerGas: bigint | null;
    readonly hash: Hex;
}

/** A transaction of a block, as `eth_getBlockByNumber` with transactions lists it. */
export interface BlockTransaction {
    readonly hash: Hex;
    readonly from: Address;
    readonly to: Address | null;
    readonly input: Hex;
    /** The block the node lists it in (null for a pending one). */
    readonly blockHash: Hex | null;
    readonly gas: bigint;
    /** The fee caps; both are the gas price of a legacy transaction. */
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
}

export interface BlockWithTransactions extends BlockInfo {
    readonly transactions: readonly BlockTransaction[];
}

export interface ReadContractCall {
    readonly address: Address;
    readonly abi: Abi;
    readonly functionName: string;
    readonly args?: readonly unknown[];
    /**
     * Read the state of exactly this block. A node that does not have the block answers with an error
     * instead of older state, so a lagging node cannot make the relay decide on stale data.
     */
    readonly blockNumber?: bigint | undefined;
}

/** `eth_call` result: success with return data, or a revert with the raw revert data if the node gave it. */
export type CallOutcome = { ok: true; data: Hex } | { ok: false; revertData: Hex | undefined; message: string };

export interface LogInfo {
    readonly address: Address;
    readonly topics: readonly Hex[];
    readonly data: Hex;
}

/** An `eth_getLogs` result: a log of a block the node considers canonical. */
export interface ChainLog extends LogInfo {
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly transactionHash: Hex;
}

/**
 * `eth_getLogs` filter for one contract. `topics` are matched by position: `null` matches anything, a list matches
 * any of its values (standard JSON-RPC semantics).
 */
export interface LogFilter {
    readonly address: Address;
    readonly topics: readonly (Hex | readonly Hex[] | null)[];
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
}

export interface ReceiptInfo {
    readonly transactionHash: Hex;
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly status: 'success' | 'reverted';
    readonly gasUsed: bigint;
    readonly effectiveGasPrice: bigint;
    readonly logs: readonly LogInfo[];
}

/** Aggregated result of `eth_sendRawTransaction` over all configured RPCs. */
export type BroadcastOutcome =
    | { kind: 'accepted' }
    | { kind: 'known' }
    | { kind: 'nonce_too_low' }
    | { kind: 'underpriced' }
    | { kind: 'insufficient_funds' }
    | { kind: 'error'; message: string };

/** A call the relay simulates or estimates; `blockNumber` pins it to that block (see `ReadContractCall`). */
export interface CallParams {
    readonly from: Address;
    readonly to: Address;
    readonly data: Hex;
    readonly blockNumber?: bigint | undefined;
}

/** `eth_chainId` of one configured RPC (by position in RELAY_RPC_URLS; URLs are never reported). */
export interface RpcChainId {
    readonly index: number;
    readonly chainId?: number | undefined;
    readonly error?: string | undefined;
}

/**
 * Everything the relay needs from the chain. Implemented with viem (`viemChainClient.ts`) and by a
 * fake in the tests. Methods throw on transport/RPC failures; `call` reports reverts as values.
 * The optional methods degrade gracefully when an implementation does not provide them.
 *
 * Reads through the client itself fail over from one configured RPC to the next and trust whichever answers
 * (ordinary reads, readiness and health follow it). Decisions that cannot be undone or that cost a transaction need
 * a positive answer from every RPC, asked separately through `rpcClients()` (relay/docs/transaction-lifecycle.md,
 * "Several RPCs"). The client itself is not one of those voters.
 */
export interface ChainClient {
    getChainId(): Promise<number>;
    /** eth_chainId of every configured RPC separately (startup refuses any mismatch). */
    rpcChainIds?(): Promise<readonly RpcChainId[]>;
    /**
     * One read client per configured RPC, in RELAY_RPC_URLS order; each reads from its RPC only. Implementations
     * with a single RPC return `[this]`; callers treat a missing method the same way.
     */
    rpcClients?(): readonly ChainClient[];
    /** eth_getLogs. Missing: the implementation cannot read logs (callers treat that as "no answer"). */
    getLogs?(filter: LogFilter): Promise<readonly ChainLog[]>;
    getBlock(tag: 'latest' | 'finalized'): Promise<BlockInfo>;
    /** eth_blockNumber, uncached: the cheapest read of the head. Missing: callers read getBlock('latest'). */
    getBlockNumber?(): Promise<bigint>;
    /** The canonical block at this height, or null if the node does not have it (yet). */
    getBlockByNumber?(number: bigint): Promise<BlockInfo | null>;
    /** The canonical block at this height with its transactions, or null if the node does not have it (yet). */
    getBlockWithTransactions?(number: bigint): Promise<BlockWithTransactions | null>;
    /**
     * eth_getBlockReceipts of the block at this height: every receipt of the block, or null if the node does not have
     * it. A node that does not serve the method answers with an error. Missing: the implementation cannot ask.
     */
    getBlockReceipts?(number: bigint): Promise<readonly ReceiptInfo[] | null>;
    getMaxPriorityFeePerGas(): Promise<bigint>;
    getBalance(address: Address): Promise<bigint>;
    getCode(address: Address, blockNumber?: bigint): Promise<Hex | undefined>;
    getStorageAt?(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex | undefined>;
    getTransactionCount(address: Address, blockTag: 'latest' | 'pending'): Promise<number>;
    /** The caller asserts the decoded return type `T` (see `reads.ts`). */
    readContract<T>(call: ReadContractCall): Promise<T>;
    call(params: CallParams): Promise<CallOutcome>;
    estimateGas(params: CallParams): Promise<bigint>;
    /** Broadcasts to every configured RPC; never throws. */
    sendRawTransaction(serialized: Hex): Promise<BroadcastOutcome>;
    getTransactionReceipt(hash: Hex): Promise<ReceiptInfo | null>;
}
