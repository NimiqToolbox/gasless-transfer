// A scripted JSON-RPC node for the confirmation tests that need no chain. Block n has the timestamp NOW + n and the
// hash blockHash(n); every block tag names `head`; nonces(from) is above the nonce checked from `usedFrom` on; the
// pinned contract has code from `createdAt` on.

import { createPublicClient, custom, encodeAbiParameters, encodeFunctionData, toHex, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '../../src/core/abi.js';
import { tokenAuthHash } from '../../src/core/eip712.js';
import { buildTransferTypedData } from '../../src/core/typedData.js';
import { AUTH_MODE_ID, type TransferRequest, type TransferVersion } from '../../src/core/types.js';
import { toViemTypedData } from '../../src/viem/typedData.js';
import { ADDR, KEYS, NONE_AUTH, NOW, TRANSFER_CONTRACT } from '../helpers/fixtures.js';

const BYTES32_RE = /^0x[0-9a-f]{64}$/i;
/** What eth_getCode answers where the pinned contract exists: any code. */
const CONTRACT_CODE: Hex = '0x60806040';

export const blockHash = (number: number): Hex => toHex(0xb10c_0000_0000 + number, { size: 32 });

/** The version of `request` with the token authorization "none". */
export function versionOf(request: TransferRequest): TransferVersion {
    return { request, authHash: tokenAuthHash(NONE_AUTH) };
}

/** relayTransfer call data of `request` with the token authorization "none", signed by the sender (KEYS.user). */
export async function relayTransferInput(request: TransferRequest): Promise<Hex> {
    const signature = await privateKeyToAccount(KEYS.user).signTypedData(toViemTypedData(buildTransferTypedData(137, TRANSFER_CONTRACT, request, NONE_AUTH)));
    return encodeFunctionData({
        abi: gaslessTransferAbi,
        functionName: 'relayTransfer',
        args: [
            { token: request.token, from: request.from, to: request.to, amount: BigInt(request.amount), fee: BigInt(request.fee), relay: request.relay, deadline: BigInt(request.deadline) },
            signature,
            { mode: AUTH_MODE_ID.none, v: NONE_AUTH.v, r: NONE_AUTH.r, s: NONE_AUTH.s },
        ],
    });
}

export interface Script {
    /** The block every block tag names. */
    readonly head: number;
    /** The intent nonce checked. */
    readonly nonce: bigint;
    /** nonces(from) is above `nonce` from this block on (default: at no block). */
    readonly usedFrom?: number;
    /** eth_call and eth_getCode below this block are refused, as by a node without the state of older blocks (default: every block is served). */
    readonly stateFrom?: number;
    /** The block that created the pinned contract: below it eth_call answers no data and eth_getCode no code (default: it always existed). */
    readonly createdAt?: number;
    /** A successful relayTransfer call of the pinned contract, sent by ADDR.relay. */
    readonly call?: { readonly block: number; readonly txHash: Hex; readonly input: Hex };
}

export interface RpcRequest {
    readonly method: string;
    readonly params: readonly unknown[];
}

const invalidParams = (message: string) => Object.assign(new Error(message), { code: -32602 });

export function scriptedRpc(script: Script): { readonly client: PublicClient; readonly requests: RpcRequest[] } {
    const requests: RpcRequest[] = [];
    const { call } = script;
    const transaction = (tx: NonNullable<Script['call']>) => ({
        hash: tx.txHash, blockHash: blockHash(tx.block), blockNumber: toHex(tx.block), from: ADDR.relay, to: TRANSFER_CONTRACT, input: tx.input,
        gas: '0x30000', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', nonce: '0x0', value: '0x0', transactionIndex: '0x0', type: '0x2',
        chainId: '0x89', v: '0x0', r: toHex(1, { size: 32 }), s: toHex(2, { size: 32 }), accessList: [],
    });
    const receipt = (tx: NonNullable<Script['call']>) => ({
        transactionHash: tx.txHash, blockHash: blockHash(tx.block), blockNumber: toHex(tx.block), status: '0x1', transactionIndex: '0x0',
        cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
        type: '0x2', from: ADDR.relay, to: TRANSFER_CONTRACT, contractAddress: null,
    });
    // A node refuses a transaction hash that is not 32 bytes.
    const byHash = (hash: unknown) => {
        if (typeof hash !== 'string' || !BYTES32_RE.test(hash)) throw invalidParams('invalid argument 0: hex string has the wrong length for a hash');
        return call !== undefined && call.txHash.toLowerCase() === hash.toLowerCase() ? call : undefined;
    };
    const client = createPublicClient({
        transport: custom(
            {
                async request({ method, params }: { method: string; params?: readonly unknown[] }) {
                    const args = params ?? [];
                    requests.push({ method, params: args });
                    if (method === 'eth_chainId') return '0x89';
                    if (method === 'eth_getBlockByNumber') {
                        const number = typeof args[0] === 'string' && args[0].startsWith('0x') ? Number(BigInt(args[0])) : script.head;
                        const transactions = call?.block === number ? [args[1] === true ? transaction(call) : call.txHash] : [];
                        return { number: toHex(number), timestamp: toHex(NOW + number), hash: blockHash(number), parentHash: blockHash(number - 1), transactions };
                    }
                    if (method === 'eth_call' || method === 'eth_getCode') {
                        const at = Number(BigInt(args[1] as Hex));
                        if (script.stateFrom !== undefined && at < script.stateFrom) throw Object.assign(new Error('missing trie node'), { code: -32000 });
                        if (script.createdAt !== undefined && at < script.createdAt) return '0x';
                        if (method === 'eth_getCode') return CONTRACT_CODE;
                        return encodeAbiParameters([{ type: 'uint256' }], [script.nonce + (script.usedFrom !== undefined && at >= script.usedFrom ? 1n : 0n)]);
                    }
                    if (method === 'eth_getBlockReceipts') return call?.block === Number(BigInt(args[0] as Hex)) ? [receipt(call)] : [];
                    if (method === 'eth_getTransactionReceipt') {
                        const tx = byHash(args[0]);
                        return tx === undefined ? null : receipt(tx);
                    }
                    if (method === 'eth_getTransactionByHash') {
                        const tx = byHash(args[0]);
                        return tx === undefined ? null : transaction(tx);
                    }
                    if (method === 'eth_getLogs') return [];
                    throw new Error(`unexpected RPC ${method}`);
                },
            },
            { retryCount: 0 },
        ),
    });
    return { client, requests };
}
