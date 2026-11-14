// RPC models for the outcome check tests: the anvil of a ProductionChain behind a transport that counts every
// request, caps the logs of an eth_getLogs answer as public RPC providers do (the answer is refused, or cut off),
// and, without history, refuses eth_call below the finalized block, as a node without the state of older blocks does.

import { createPublicClient, custom, http, type Chain, type PublicClient, type Transport } from 'viem';
import type { ProductionChain } from './productionChain.js';

export interface RpcModel {
    /** An eth_getLogs answer with more logs is refused (`overCap: 'refuse'`, the default) or cut off to this many. */
    readonly maxLogs?: number;
    readonly overCap?: 'refuse' | 'truncate';
    /** False: eth_call below the finalized block is refused (default true). */
    readonly history?: boolean;
    /** False: eth_getBlockReceipts is refused, as by a node without it (default true). */
    readonly blockReceipts?: boolean;
    /** Replaces an answer, as a cache or a node on another fork would. */
    readonly rewrite?: (method: string, params: readonly unknown[], result: unknown) => unknown;
}

export interface RpcSeen {
    /** Every JSON-RPC request the client made. */
    requests: number;
    readonly byMethod: Record<string, number>;
    /** The block numbers of the eth_call reads. */
    readonly callBlocks: bigint[];
    /** Logs in the eth_getLogs answers, before the cap. */
    logs: number;
    refused: number;
    truncated: number;
    /** The requests of each check (a check starts with eth_chainId). */
    readonly perCheck: number[];
    /** The blocks read with their transactions, in order. */
    readonly blocksRead: bigint[];
    /** The eth_getLogs queries that were answered (filter and range), in order. */
    readonly logQueries: string[];
}

export function modelClient(ctx: ProductionChain, model: RpcModel = {}): { readonly client: PublicClient<Transport, Chain>; readonly seen: RpcSeen } {
    const seen: RpcSeen = { requests: 0, byMethod: {}, callBlocks: [], logs: 0, refused: 0, truncated: 0, perCheck: [], blocksRead: [], logQueries: [] };
    const upstream = http(ctx.anvil.url)({ chain: ctx.chain, retryCount: 0 });
    const transport = custom(
        {
            async request({ method, params }: { method: string; params?: unknown }) {
                const args = (params ?? []) as readonly unknown[];
                seen.requests += 1;
                seen.byMethod[method] = (seen.byMethod[method] ?? 0) + 1;
                if (method === 'eth_chainId') seen.perCheck.push(0);
                const check = seen.perCheck.length - 1;
                if (check >= 0) seen.perCheck[check] = (seen.perCheck[check] ?? 0) + 1;
                if (method === 'eth_call' && typeof args[1] === 'string' && args[1].startsWith('0x')) {
                    const at = BigInt(args[1]);
                    seen.callBlocks.push(at);
                    if (model.history === false && at < (await ctx.publicClient.getBlock({ blockTag: 'finalized' })).number) {
                        throw Object.assign(new Error('missing trie node'), { code: -32000 });
                    }
                }
                if (method === 'eth_getBlockReceipts' && model.blockReceipts === false) {
                    throw Object.assign(new Error('the method eth_getBlockReceipts does not exist/is not available'), { code: -32601 });
                }
                if (method === 'eth_getBlockByNumber' && args[1] === true && typeof args[0] === 'string' && args[0].startsWith('0x')) {
                    seen.blocksRead.push(BigInt(args[0]));
                }
                let result = await upstream.request({ method, params } as never);
                if (method === 'eth_getLogs') {
                    const logs = result as readonly unknown[];
                    seen.logs += logs.length;
                    if (model.maxLogs !== undefined && logs.length > model.maxLogs) {
                        if (model.overCap === 'truncate') {
                            seen.truncated += 1;
                            result = logs.slice(0, model.maxLogs);
                        } else {
                            seen.refused += 1;
                            throw Object.assign(new Error(`query returned more than ${model.maxLogs} results`), { code: -32005 });
                        }
                    }
                    seen.logQueries.push(JSON.stringify(args[0]));
                }
                return model.rewrite === undefined ? result : model.rewrite(method, args, result);
            },
        },
        { retryCount: 0 },
    );
    return { client: createPublicClient({ chain: ctx.chain, transport, pollingInterval: 25 }), seen };
}
