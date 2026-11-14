import { performance } from 'node:perf_hooks';
import {
    BaseError,
    BlockNotFoundError,
    ExecutionRevertedError,
    HttpRequestError,
    ResponseBodyTooLargeError,
    RpcError,
    RpcRequestError,
    TimeoutError,
    TransactionReceiptNotFoundError,
    createPublicClient,
    fallback,
    formatTransactionReceipt,
    hexToBigInt,
    http,
    isHex,
    toHex,
    type Hex,
    type TransactionReceipt,
    type Transport,
} from 'viem';
import type { BlockInfo, BroadcastOutcome, CallOutcome, ChainClient, ChainLog, LogFilter, ReceiptInfo, RpcChainId } from './types.js';
import { scrubString } from '../util/redact.js';

/**
 * Why a JSON-RPC request failed, in a closed set of values that are safe for logs and metric labels. The node's
 * message, the URL and the request never leave classifyRpcFailure; only this reason and the numeric HTTP status or
 * JSON-RPC error code do.
 */
export type RpcFailureReason = 'timeout' | 'rate_limited' | 'http_status' | 'network' | 'rpc_error' | 'other';

export interface RpcFailure {
    readonly reason: RpcFailureReason;
    /** The HTTP status of an answer that was not 2xx. */
    readonly httpStatus?: number;
    /** The JSON-RPC error code of an answer with an error. */
    readonly rpcCode?: number;
}

/** One JSON-RPC request to one configured RPC (`rpc`: its 1-based position in RELAY_RPC_URLS; URLs are never reported). */
export interface RpcRequestEvent {
    readonly rpc: number;
    readonly method: string;
    readonly durationMs: number;
    /** `ok`, or why the request failed (after viem's own retry). */
    readonly outcome: 'ok' | RpcFailureReason;
    /** The block number of an answer to eth_blockNumber or eth_getBlockByNumber("latest"). */
    readonly head?: bigint;
}

export interface ViemChainClientOptions {
    /**
     * One or more JSON-RPC URLs. Reads use viem's `fallback` transport; broadcasts go to all of them; `rpcClients()`
     * gives one client per URL for the decisions that need every RPC.
     */
    readonly rpcUrls: readonly string[];
    readonly timeoutMs: number;
    /** Called after every request of every client (the failover reads, the per-RPC reads and the broadcasts). */
    readonly onRequest?: ((event: RpcRequestEvent) => void) | undefined;
}

// Rate limits: HTTP 429, EIP-1474's "limit exceeded" (-32005), 429 as a JSON-RPC code, the provider-specific codes
// -32007 and -32029, and wording some providers put in a generic error. The text is matched, never reported.
const RATE_LIMIT_CODES = new Set([429, -32005, -32007, -32029]);
const RATE_LIMIT_TEXT = /too many requests|rate.?limit|request limit|limit exceeded|throttl/i;

function httpStatusOf(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function rpcCodeOf(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** Classifies a failed read (see RpcFailure). */
export function classifyRpcFailure(err: unknown): RpcFailure {
    if (!(err instanceof BaseError)) return { reason: 'other' };
    let failure: RpcFailure | undefined;
    err.walk((e) => {
        if (failure) return false;
        if (e instanceof TimeoutError) {
            failure = { reason: 'timeout' };
        } else if (e instanceof HttpRequestError) {
            const httpStatus = httpStatusOf(e.status);
            failure = httpStatus === undefined ? { reason: 'network' } : { reason: httpStatus === 429 ? 'rate_limited' : 'http_status', httpStatus };
        } else if (e instanceof RpcRequestError || e instanceof RpcError) {
            const rpcCode = rpcCodeOf(e.code);
            const limited = (rpcCode !== undefined && RATE_LIMIT_CODES.has(rpcCode)) || RATE_LIMIT_TEXT.test(`${e.shortMessage} ${e.details}`);
            failure = { reason: limited ? 'rate_limited' : 'rpc_error', ...(rpcCode !== undefined ? { rpcCode } : {}) };
        }
        return false;
    });
    return failure ?? { reason: 'other' };
}

function headOf(method: string, params: unknown, result: unknown): bigint | undefined {
    const quantity = method === 'eth_blockNumber' ? result
        : method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'latest' ? (result as { number?: unknown } | null)?.number
        : undefined;
    return typeof quantity === 'string' && isHex(quantity) ? hexToBigInt(quantity) : undefined;
}

/** `transport`, reporting each of its requests (after viem's retries) to `onRequest` as RPC number `rpc`. */
function observed(transport: Transport, rpc: number, onRequest: ((event: RpcRequestEvent) => void) | undefined): Transport {
    if (!onRequest) return transport;
    return (config) => {
        const inner = transport(config);
        const request: typeof inner.request = async (args, options) => {
            const start = performance.now();
            let result: unknown;
            try {
                result = await inner.request(args, options);
            } catch (err) {
                onRequest({ rpc, method: args.method, durationMs: performance.now() - start, outcome: classifyRpcFailure(err).reason });
                throw err;
            }
            const head = headOf(args.method, args.params, result);
            onRequest({ rpc, method: args.method, durationMs: performance.now() - start, outcome: 'ok', ...(head !== undefined ? { head } : {}) });
            return result as never;
        };
        return { ...inner, request };
    };
}

/** The `eth_getLogs` answer of one RPC (quantities as hex strings). */
interface RpcLogEntry {
    readonly address: Hex;
    readonly topics: readonly Hex[];
    readonly data: Hex;
    readonly blockNumber: Hex | null;
    readonly blockHash: Hex | null;
    readonly transactionHash: Hex | null;
    readonly removed?: boolean;
}

/** A viem receipt as the relay keeps it. */
function receiptInfo(r: TransactionReceipt): ReceiptInfo {
    // gasUsed too: viem passes a missing one through as null, and the store's gas accounting needs the number.
    if (typeof r.transactionHash !== 'string' || typeof r.blockHash !== 'string' || typeof r.blockNumber !== 'bigint' || typeof r.gasUsed !== 'bigint') {
        throw new Error('incomplete receipt');
    }
    if (r.status !== 'success' && r.status !== 'reverted') throw new Error('receipt without a status');
    return {
        transactionHash: r.transactionHash,
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        status: r.status,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice ?? 0n,
        logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    };
}

/** Finds revert data in a viem error chain. Returns undefined if the error is not a revert. */
export function extractRevert(err: unknown): { revertData: Hex | undefined; message: string } | undefined {
    if (!(err instanceof BaseError)) return undefined;
    let data: Hex | undefined;
    let reverted = false;
    err.walk((e) => {
        const d = (e as { data?: unknown }).data;
        if (data === undefined) {
            if (typeof d === 'string' && isHex(d)) data = d;
            else if (d && typeof d === 'object') {
                const inner = (d as { data?: unknown }).data;
                if (typeof inner === 'string' && isHex(inner)) data = inner;
            }
        }
        if (e instanceof ExecutionRevertedError) reverted = true;
        if (e instanceof RpcRequestError && (e.code === 3 || /revert/i.test(e.details))) reverted = true;
        return false;
    });
    if (data !== undefined && data !== '0x') reverted = true;
    if (!reverted) return undefined;
    return { revertData: data, message: 'execution reverted' };
}

function errorText(err: unknown): string {
    const parts: string[] = [];
    if (err instanceof BaseError) {
        err.walk((e) => {
            if (e instanceof BaseError) parts.push(e.shortMessage, e.details ?? '');
            else if (e instanceof Error) parts.push(e.message);
            return false;
        });
    } else if (err instanceof Error) {
        parts.push(err.message);
    } else {
        parts.push(String(err));
    }
    return parts.join(' ').toLowerCase();
}

/** Classifies a single RPC's `eth_sendRawTransaction` error (geth/Bor/anvil wording). */
export function classifyBroadcastError(err: unknown): BroadcastOutcome {
    const text = errorText(err);
    if (/already known|known transaction|alreadyknown|already imported|already exists/.test(text)) return { kind: 'known' };
    if (/nonce too low|nonce is too low|oldnonce|nonce has already been used|invalid nonce/.test(text)) {
        return { kind: 'nonce_too_low' };
    }
    if (/insufficient funds/.test(text)) return { kind: 'insufficient_funds' };
    if (/underpriced|replacement fee too low|fee too low/.test(text)) return { kind: 'underpriced' };
    const short = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
    return { kind: 'error', message: scrubString(short).slice(0, 300) };
}

/** Combines the per-RPC broadcast results: any acceptance wins; nonce_too_low only if all agree. */
export function aggregateBroadcast(outcomes: readonly BroadcastOutcome[]): BroadcastOutcome {
    if (outcomes.some((o) => o.kind === 'accepted')) return { kind: 'accepted' };
    if (outcomes.some((o) => o.kind === 'known')) return { kind: 'known' };
    if (outcomes.length > 0 && outcomes.every((o) => o.kind === 'nonce_too_low')) return { kind: 'nonce_too_low' };
    if (outcomes.some((o) => o.kind === 'insufficient_funds')) return { kind: 'insufficient_funds' };
    if (outcomes.some((o) => o.kind === 'underpriced')) return { kind: 'underpriced' };
    const firstError = outcomes.find((o): o is { kind: 'error'; message: string } => o.kind === 'error');
    return firstError ?? { kind: 'error', message: 'broadcast failed' };
}

/** The largest RPC answer the relay reads: viem's own limit for a response body. */
const MAX_RESPONSE_BYTES = 10_485_760;

/** The whole body of `response` (null if it has none); an answer above MAX_RESPONSE_BYTES is refused, not buffered. */
async function readBody(response: Response): Promise<Uint8Array | null> {
    if (response.body === null) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ResponseBodyTooLargeError({ maxSize: MAX_RESPONSE_BYTES, size });
        }
        chunks.push(value);
    }
}

/**
 * `fetch` that returns once the whole answer is read, and without the answer's `Retry-After` header.
 *
 * viem's request timeout covers this function only: it ends when the response headers arrive, and viem reads the
 * body after it. A provider that sends headers and then stops sending the body would hold a read (and with it a pass
 * or a validation) until Node's own five minutes between two chunks, on every try. Read here, the body is under the
 * request timeout, whose abort signal (`init.signal`) ends the read.
 *
 * viem waits as long as `Retry-After` says before its retry, without any upper bound and outside the request
 * timeout, so a provider could hold a read for hours. Without the header the retry follows viem's own short back-off.
 */
const fetchWholeAnswer: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const body = await readBody(response);
    const headers = new Headers(response.headers);
    headers.delete('retry-after');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
};

export function createViemChainClient(options: ViemChainClientOptions): ChainClient {
    if (options.rpcUrls.length === 0) throw new Error('at least one RPC URL is required');
    const { onRequest } = options;
    const rpc = (url: string, i: number, retryCount: number): Transport =>
        observed(http(url, { timeout: options.timeoutMs, retryCount, fetchFn: fetchWholeAnswer }), i + 1, onRequest);
    // Ordinary reads try each RPC twice, then the next one; the sweep over all of them is not repeated
    // (relay/docs/transaction-lifecycle.md, "Ordinary reads"): the next pass or submission reads again.
    const transports = options.rpcUrls.map((url, i) => rpc(url, i, 1));
    // No CCIP-Read on any client: with it, an RPC that answers an eth_call with an OffchainLookup revert makes viem
    // fetch the URLs in that answer, so a provider could direct HTTP requests from inside the relay's network.
    const client = createPublicClient({
        transport: transports.length === 1 ? transports[0]! : fallback(transports, { retryCount: 0 }),
        ccipRead: false,
    });
    const broadcastClients = options.rpcUrls.map((url, i) => createPublicClient({ transport: rpc(url, i, 0), ccipRead: false }));

    const blockInfo = (block: { number: bigint | null; timestamp: bigint; baseFeePerGas?: bigint | null; hash: Hex | null }): BlockInfo => {
        if (block.number === null || block.hash === null) throw new Error('the node returned a pending block');
        return { number: block.number, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas ?? null, hash: block.hash };
    };
    // Pins a read to one block when asked (a node without that block errors instead of answering stale).
    const at = (blockNumber: bigint | undefined) => (blockNumber !== undefined ? { blockNumber } : {});
    // One client per URL, created on first use.
    let perRpc: readonly ChainClient[] | undefined;

    const self: ChainClient = {
        getChainId: () => client.getChainId(),

        rpcClients(): readonly ChainClient[] {
            if (options.rpcUrls.length === 1) return [self];
            // Each reports its requests under its position in RELAY_RPC_URLS.
            perRpc ??= options.rpcUrls.map((url, i) => createViemChainClient({
                rpcUrls: [url],
                timeoutMs: options.timeoutMs,
                onRequest: onRequest && ((event) => onRequest({ ...event, rpc: i + 1 })),
            }));
            return perRpc;
        },

        async getLogs(filter: LogFilter): Promise<ChainLog[]> {
            const logs = (await client.request({
                method: 'eth_getLogs',
                params: [
                    {
                        address: filter.address,
                        topics: filter.topics.map((t) => (Array.isArray(t) ? [...(t as readonly Hex[])] : t)) as never,
                        fromBlock: toHex(filter.fromBlock),
                        toBlock: toHex(filter.toBlock),
                    },
                ],
            })) as unknown as readonly RpcLogEntry[];
            const out: ChainLog[] = [];
            for (const log of logs) {
                // Pending or removed logs are not evidence of anything on the canonical chain.
                if (log.removed === true || log.blockNumber === null || log.blockHash === null || log.transactionHash === null) continue;
                out.push({
                    address: log.address,
                    topics: log.topics,
                    data: log.data,
                    blockNumber: hexToBigInt(log.blockNumber),
                    blockHash: log.blockHash,
                    transactionHash: log.transactionHash,
                });
            }
            return out;
        },

        async rpcChainIds(): Promise<RpcChainId[]> {
            // Every configured URL on its own: the fallback transport would only ever ask the first one.
            const results = await Promise.allSettled(broadcastClients.map((c) => c.getChainId()));
            return results.map((r, index) =>
                r.status === 'fulfilled'
                    ? { index, chainId: r.value }
                    : { index, error: scrubString(r.reason instanceof BaseError ? r.reason.shortMessage : String(r.reason)).slice(0, 200) },
            );
        },

        async getBlock(tag) {
            return blockInfo(await client.getBlock({ blockTag: tag }));
        },

        // viem caches the block number for the client's polling interval by default.
        getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),

        async getBlockByNumber(number) {
            try {
                return blockInfo(await client.getBlock({ blockNumber: number }));
            } catch (err) {
                if (err instanceof BlockNotFoundError) return null;
                throw err;
            }
        },

        async getBlockWithTransactions(number) {
            let block;
            try {
                block = await client.getBlock({ blockNumber: number, includeTransactions: true });
            } catch (err) {
                if (err instanceof BlockNotFoundError) return null;
                throw err;
            }
            return {
                ...blockInfo(block),
                transactions: block.transactions.map((tx) => ({
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to ?? null,
                    input: tx.input,
                    blockHash: tx.blockHash,
                    gas: tx.gas,
                    maxFeePerGas: tx.maxFeePerGas ?? tx.gasPrice ?? 0n,
                    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n,
                })),
            };
        },

        async getBlockReceipts(number) {
            const answer: unknown = await client.request({ method: 'eth_getBlockReceipts', params: [toHex(number)] } as never);
            if (answer === null) return null;
            if (!Array.isArray(answer)) throw new Error('eth_getBlockReceipts did not answer a list');
            const receipts: ReceiptInfo[] = [];
            for (const raw of answer as unknown[]) {
                // An entry that does not parse (a provider's own kind of receipt) is no evidence of anything.
                try {
                    receipts.push(receiptInfo(formatTransactionReceipt(raw as never)));
                } catch {
                    continue;
                }
            }
            return receipts;
        },

        getMaxPriorityFeePerGas: () => client.estimateMaxPriorityFeePerGas(),

        getBalance: (address) => client.getBalance({ address }),

        getCode: (address, blockNumber) => client.getCode({ address, ...at(blockNumber) }),

        getStorageAt: (address, slot, blockNumber) => client.getStorageAt({ address, slot, blockNumber }),

        getTransactionCount: (address, blockTag) => client.getTransactionCount({ address, blockTag }),

        readContract: <T>(call: Parameters<ChainClient['readContract']>[0]) => {
            const { blockNumber, ...rest } = call;
            return client.readContract({ ...rest, ...at(blockNumber) } as never) as Promise<T>;
        },

        async call({ from, to, data, blockNumber }): Promise<CallOutcome> {
            try {
                const result = await client.call({ account: from, to, data, ...at(blockNumber) });
                return { ok: true, data: result.data ?? '0x' };
            } catch (err) {
                const revert = extractRevert(err);
                if (revert) return { ok: false, ...revert };
                throw err;
            }
        },

        estimateGas: ({ from, to, data, blockNumber }) => client.estimateGas({ account: from, to, data, ...at(blockNumber) }),

        async sendRawTransaction(serialized): Promise<BroadcastOutcome> {
            const results = await Promise.allSettled(
                broadcastClients.map((c) => c.request({ method: 'eth_sendRawTransaction', params: [serialized] })),
            );
            return aggregateBroadcast(
                results.map((r) => (r.status === 'fulfilled' ? { kind: 'accepted' } : classifyBroadcastError(r.reason))),
            );
        },

        async getTransactionReceipt(hash): Promise<ReceiptInfo | null> {
            try {
                return receiptInfo(await client.getTransactionReceipt({ hash }));
            } catch (err) {
                if (err instanceof TransactionReceiptNotFoundError) return null;
                throw err;
            }
        },
    };
    return self;
}
