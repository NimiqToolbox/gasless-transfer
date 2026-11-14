// Serves a FakeChain over HTTP JSON-RPC (127.0.0.1, random port) so the real viem client and the
// production entrypoint can run against it. Only the methods the relay uses are implemented.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ContractFunctionZeroDataError, RpcRequestError, decodeFunctionData, encodeFunctionResult, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { gaslessTransferAbi, usdcAbi, usdt0Abi } from '@nimiq/gasless-sdk/core';
import { chainlinkAggregatorAbi } from '../../src/chain/reads.js';
import type { ReceiptInfo } from '../../src/chain/types.js';
import type { FakeChain } from './fakeChain.js';

const ABIS: readonly Abi[] = [gaslessTransferAbi as Abi, usdt0Abi as Abi, usdcAbi as Abi, chainlinkAggregatorAbi as Abi];

type JsonRpcRequest = { id: number | string; method: string; params?: unknown[] };
type JsonRpcReply = { result: unknown } | { error: { code: number; message: string; data?: Hex } };

const q = (n: bigint | number) => toHex(n);

function decodeCall(data: Hex): { abi: Abi; functionName: string; args: readonly unknown[] } | undefined {
    for (const abi of ABIS) {
        try {
            const { functionName, args } = decodeFunctionData({ abi, data }) as { functionName: string; args?: readonly unknown[] };
            return { abi, functionName, args: args ?? [] };
        } catch {
            // try the next ABI
        }
    }
    return undefined;
}

/** A receipt as a node answers it. */
function rpcReceipt(r: ReceiptInfo): Record<string, unknown> {
    return {
        transactionHash: r.transactionHash,
        transactionIndex: '0x0',
        blockHash: r.blockHash,
        blockNumber: q(r.blockNumber),
        from: `0x${'00'.repeat(20)}`,
        to: null,
        cumulativeGasUsed: q(r.gasUsed),
        gasUsed: q(r.gasUsed),
        effectiveGasPrice: q(r.effectiveGasPrice),
        contractAddress: null,
        logs: r.logs.map((l, i) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: q(r.blockNumber),
            blockHash: r.blockHash,
            transactionHash: r.transactionHash,
            transactionIndex: '0x0',
            logIndex: q(i),
            removed: false,
        })),
        logsBloom: `0x${'00'.repeat(256)}`,
        status: r.status === 'success' ? '0x1' : '0x0',
        type: '0x2',
    };
}

async function handle(chain: FakeChain, method: string, params: unknown[]): Promise<JsonRpcReply> {
    try {
        switch (method) {
            case 'eth_chainId':
                return { result: q(await chain.getChainId()) };
            case 'eth_blockNumber':
                return { result: q((await chain.getBlock('latest')).number) };
            case 'eth_getBlockByNumber': {
                const tag = params[0];
                const byNumber = typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag);
                const full = byNumber && params[1] === true ? await chain.getBlockWithTransactions(BigInt(tag)) : undefined;
                const block = full !== undefined ? full : byNumber
                    ? await chain.getBlockByNumber(BigInt(tag))
                    : await chain.getBlock(tag === 'finalized' ? 'finalized' : 'latest');
                if (!block) return { result: null };
                const chainId = full ? q(await chain.getChainId()) : undefined;
                return {
                    result: {
                        number: q(block.number),
                        hash: block.hash,
                        parentHash: `0x${'00'.repeat(32)}`,
                        timestamp: q(block.timestamp),
                        baseFeePerGas: block.baseFeePerGas !== null ? q(block.baseFeePerGas) : null,
                        gasLimit: q(30_000_000n),
                        gasUsed: '0x0',
                        transactions: (full?.transactions ?? []).map((tx, i) => ({
                            hash: tx.hash,
                            from: tx.from,
                            to: tx.to,
                            input: tx.input,
                            blockHash: tx.blockHash,
                            blockNumber: q(block.number),
                            transactionIndex: q(i),
                            gas: q(tx.gas),
                            maxFeePerGas: q(tx.maxFeePerGas),
                            maxPriorityFeePerGas: q(tx.maxPriorityFeePerGas),
                            nonce: '0x0',
                            value: '0x0',
                            type: '0x2',
                            chainId,
                            v: '0x0',
                            yParity: '0x0',
                            r: `0x${'00'.repeat(32)}`,
                            s: `0x${'00'.repeat(32)}`,
                            accessList: [],
                        })),
                    },
                };
            }
            case 'eth_maxPriorityFeePerGas':
                return { result: q(await chain.getMaxPriorityFeePerGas()) };
            case 'eth_getBalance':
                return { result: q(await chain.getBalance(params[0] as Address)) };
            case 'eth_getCode':
                return { result: (await chain.getCode(params[0] as Address)) ?? '0x' };
            case 'eth_getStorageAt':
                return { result: (await chain.getStorageAt(params[0] as Address, params[1] as Hex)) ?? `0x${'00'.repeat(32)}` };
            case 'eth_getTransactionCount':
                return { result: q(await chain.getTransactionCount(params[0] as Address, params[1] === 'pending' ? 'pending' : 'latest')) };
            case 'eth_estimateGas': {
                const tx = params[0] as { from: Address; to: Address; data: Hex };
                return { result: q(await chain.estimateGas({ from: tx.from, to: tx.to, data: tx.data })) };
            }
            case 'eth_call': {
                const tx = params[0] as { from?: Address; to: Address; data?: Hex; input?: Hex };
                const data = tx.data ?? tx.input ?? '0x';
                const decoded = decodeCall(data);
                if (!decoded || decoded.functionName === 'relayTransfer') {
                    const outcome = await chain.call({ from: tx.from ?? `0x${'00'.repeat(20)}`, to: tx.to, data });
                    if (outcome.ok) return { result: outcome.data };
                    return { error: { code: 3, message: 'execution reverted', ...(outcome.revertData ? { data: outcome.revertData } : {}) } };
                }
                // A read pinned to a block number (the relay's reads at block B) is answered at that block.
                const tag = params[1];
                const blockNumber = typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag) ? BigInt(tag) : undefined;
                let value: unknown;
                try {
                    value = await chain.readContract({
                        address: tx.to,
                        abi: decoded.abi,
                        functionName: decoded.functionName,
                        args: decoded.args,
                        ...(blockNumber !== undefined ? { blockNumber } : {}),
                    });
                } catch (err) {
                    // No code at that block: a node answers "0x".
                    if (err instanceof ContractFunctionZeroDataError) return { result: '0x' };
                    if (err instanceof RpcRequestError) return { error: { code: err.code, message: err.details } };
                    throw err;
                }
                return { result: encodeFunctionResult({ abi: decoded.abi, functionName: decoded.functionName, result: value } as never) };
            }
            case 'eth_sendRawTransaction': {
                const raw = params[0] as Hex;
                const outcome = await chain.sendRawTransaction(raw);
                switch (outcome.kind) {
                    case 'accepted':
                        return { result: keccak256(raw) };
                    case 'known':
                        return { error: { code: -32000, message: 'already known' } };
                    case 'nonce_too_low':
                        return { error: { code: -32000, message: 'nonce too low' } };
                    case 'underpriced':
                        return { error: { code: -32000, message: 'replacement transaction underpriced' } };
                    case 'insufficient_funds':
                        return { error: { code: -32000, message: 'insufficient funds for gas * price + value' } };
                    default:
                        return { error: { code: -32603, message: outcome.message } };
                }
            }
            case 'eth_getTransactionReceipt': {
                const r = await chain.getTransactionReceipt(params[0] as Hex);
                return { result: r ? rpcReceipt(r) : null };
            }
            case 'eth_getBlockReceipts': {
                const receipts = await chain.getBlockReceipts(BigInt(params[0] as string));
                return { result: receipts ? receipts.map(rpcReceipt) : null };
            }
            default:
                return { error: { code: -32601, message: `method ${method} not supported by the fake` } };
        }
    } catch (err) {
        return { error: { code: -32000, message: err instanceof Error ? err.message : String(err) } };
    }
}

export interface RpcAdapter {
    readonly url: string;
    close(): Promise<void>;
}

export async function serveFakeChain(chain: FakeChain): Promise<RpcAdapter> {
    const server: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
            void (async () => {
                const message = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
                const one = async (m: JsonRpcRequest) => ({ jsonrpc: '2.0', id: m.id, ...(await handle(chain, m.method, m.params ?? [])) });
                const reply = Array.isArray(message) ? await Promise.all(message.map(one)) : await one(message);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(reply));
            })();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
