// The boundaries of the outcome check against a mocked RPC: confirmOnChain answers only from evidence in the
// canonical chain (an orphaned receipt, a stale or removed log, or a call with another signature decide nothing), and
// waitForTransferOutcome bounds every read and status request it has in flight by its timeout and AbortSignal.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, encodeFunctionData, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../src/core/abi.js';
import { tokenAuthHash } from '../../src/core/eip712.js';
import { buildTransferTypedData } from '../../src/core/typedData.js';
import { AUTH_MODE_ID } from '../../src/core/types.js';
import { confirmOnChain } from '../../src/viem/confirm.js';
import { waitForTransferOutcome } from '../../src/viem/outcome.js';
import { toViemTypedData } from '../../src/viem/typedData.js';
import { ADDR, KEYS, NONE_AUTH, NOW, polygonPins, sampleRequest, TRANSFER_CONTRACT } from '../helpers/fixtures.js';

const hash = (digit: string): Hex => `0x${digit.repeat(64)}`;
// Nonce 7, deadline NOW + 600; block n has timestamp NOW + n, so every block below 600 is before the deadline.
const request = sampleRequest();
const pins = polygonPins();
const target = { request, authHash: tokenAuthHash(NONE_AUTH) };
const invalidationTx = hash('a');
const obsoleteTx = hash('b');
const actualTx = hash('c');
const obsoleteBlock = hash('d');
const canonicalBlock = hash('e');
const BLOCK = 0x5a;
const HEAD = 0x64;

/** relayTransfer call data of `request` with mode "none", signed by `key`. */
async function relayTransferInput(key: Hex): Promise<Hex> {
    const signature = await privateKeyToAccount(key).signTypedData(toViemTypedData(buildTransferTypedData(137, TRANSFER_CONTRACT, request, NONE_AUTH)));
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

let senderInput: Hex;
let foreignInput: Hex;
beforeAll(async () => {
    senderInput = await relayTransferInput(KEYS.user);
    foreignInput = await relayTransferInput(KEYS.other);
});

interface Scenario {
    /** The sender's NonceInvalidated log in the search: none, in the canonical block, in a fork's block, without block hash, or removed. */
    readonly invalidation?: 'none' | 'canonical' | 'stale' | 'missingHash' | 'removed';
    /** The relayTransfer call in the canonical block (with its token Transfer log), and its transaction. */
    readonly execution?: 'none' | 'canonical' | 'txBlockMismatch' | 'foreignSignature';
    /** Holds the first read of older state, or the first eth_getLogs, until `releaseSearch`. */
    readonly stallSearch?: 'state' | 'logs';
    /** previousNonce and newNonce of the NonceInvalidated log (default: 0 and the request's nonce + 1). */
    readonly invalidationRange?: readonly [bigint, bigint];
    /** The block that created the contract: at an earlier block eth_call answers no data and eth_getCode no code (default: it always existed). */
    readonly createdAt?: number;
}

/**
 * A mocked RPC: obsoleteTx is a relayTransfer mined in a fork's block 0x5a; actualTx the same call in the canonical
 * block 0x5a, where nonces(from) moves past the request's nonce.
 */
function chain(scenario: Scenario = {}) {
    const invalidationKind = scenario.invalidation ?? 'none';
    const execution = scenario.execution ?? 'canonical';
    const calls: Array<{ method: string; params: unknown }> = [];
    let releaseSearch: () => void = () => {};
    let stalled = false;
    const stall = async (kind: 'state' | 'logs'): Promise<void> => {
        if (scenario.stallSearch !== kind || stalled) return;
        stalled = true;
        await new Promise<void>((resolve) => { releaseSearch = resolve; });
    };
    const log = { blockNumber: toHex(BLOCK), transactionIndex: '0x0', logIndex: '0x0', removed: false };
    const invalidation = {
        ...log,
        address: TRANSFER_CONTRACT,
        blockHash: { none: undefined, canonical: canonicalBlock, stale: obsoleteBlock, missingHash: undefined, removed: canonicalBlock }[invalidationKind],
        transactionHash: invalidationTx,
        removed: invalidationKind === 'removed',
        topics: encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer: request.from } }),
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [...(scenario.invalidationRange ?? [0n, BigInt(request.nonce) + 1n])]),
    };
    const transfer = {
        ...log,
        address: request.token,
        blockHash: canonicalBlock,
        transactionHash: actualTx,
        topics: encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer', args: { from: request.from, to: request.to } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(request.amount)]),
    };
    const blockHashOf = (tx: Hex): Hex => (tx === obsoleteTx ? obsoleteBlock : canonicalBlock);
    const inputOf = (tx: Hex): Hex => {
        if (tx === invalidationTx) return encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(request.nonce) + 1n] });
        return execution === 'foreignSignature' ? foreignInput : senderInput;
    };
    const known = [invalidationTx, obsoleteTx, actualTx];
    const transaction = (tx: Hex) => ({
        hash: tx, blockHash: execution === 'txBlockMismatch' && tx === actualTx ? obsoleteBlock : blockHashOf(tx), blockNumber: toHex(BLOCK),
        from: ADDR.relay, to: TRANSFER_CONTRACT, input: inputOf(tx), gas: '0x30000', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1',
        nonce: '0x0', value: '0x0', transactionIndex: '0x0', type: '0x2', chainId: '0x89', v: '0x0', r: hash('1'), s: hash('2'), accessList: [],
    });
    // The canonical block 0x5a holds the execution and the invalidation of the scenario.
    const canonicalTxs = [...(execution === 'none' ? [] : [actualTx]), ...(invalidationKind === 'none' ? [] : [invalidationTx])];
    const client = createPublicClient({
        transport: custom(
            {
                async request({ method, params }) {
                    calls.push({ method, params });
                    if (method === 'eth_chainId') return '0x89';
                    if (method === 'eth_getBlockByNumber') {
                        const number = params[0] === 'finalized' || params[0] === 'latest' ? HEAD : Number(BigInt(params[0]));
                        const transactions = number === BLOCK ? canonicalTxs.map((tx) => (params[1] === true ? transaction(tx) : tx)) : [];
                        return { number: toHex(number), timestamp: toHex(NOW + number), hash: number === BLOCK ? canonicalBlock : toHex(number, { size: 32 }), parentHash: hash('f'), transactions };
                    }
                    // nonces(from): the nonce is used from block 0x5a on.
                    if (method === 'eth_call') {
                        const at = typeof params[1] === 'string' && params[1].startsWith('0x') ? Number(BigInt(params[1])) : HEAD;
                        if (at !== HEAD) await stall('state');
                        if (scenario.createdAt !== undefined && at < scenario.createdAt) return '0x';
                        return encodeAbiParameters([{ type: 'uint256' }], [BigInt(request.nonce) + (at >= BLOCK ? 1n : 0n)]);
                    }
                    // The contract has code from the block that created it.
                    if (method === 'eth_getCode') return scenario.createdAt !== undefined && Number(BigInt(params[1])) < scenario.createdAt ? '0x' : '0x60806040';
                    if (method === 'eth_getTransactionReceipt') {
                        const tx = params[0] as Hex;
                        if (!known.includes(tx)) return null;
                        return {
                            transactionHash: tx, blockHash: blockHashOf(tx), blockNumber: toHex(BLOCK), status: '0x1', transactionIndex: '0x0',
                            cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
                            type: '0x2', from: ADDR.relay, to: TRANSFER_CONTRACT, contractAddress: null,
                        };
                    }
                    if (method === 'eth_getTransactionByHash') {
                        const tx = params[0] as Hex;
                        return known.includes(tx) ? transaction(tx) : null;
                    }
                    if (method === 'eth_getLogs') {
                        await stall('logs');
                        const filter = (params as Array<{ address: string | string[] }>)[0] as { address: string | string[] };
                        if (filter.address === TRANSFER_CONTRACT) return invalidationKind === 'none' ? [] : [invalidation];
                        return execution === 'none' ? [] : [transfer];
                    }
                    throw new Error(`unexpected RPC ${method}`);
                },
            },
            { retryCount: 0 },
        ),
    });
    return { client, calls, releaseSearch: () => releaseSearch() };
}

describe('confirmOnChain: only canonical evidence decides', () => {
    it('ignores an orphaned execution receipt and finds the canonical execution instead', async () => {
        const { client, calls } = chain();
        const result = await confirmOnChain(client, pins, target, { blockTag: 'finalized', txHash: obsoleteTx, fromBlock: 90n });
        expect(result).toMatchObject({ status: 'executed', txHash: actualTx, blockNumber: BigInt(BLOCK), executedTransfer: target });
        expect(calls).toContainEqual({ method: 'eth_getBlockByNumber', params: ['0x5a', false] });
    });

    it('answers from a canonical relay txHash without a search', async () => {
        const { client, calls } = chain();
        expect(await confirmOnChain(client, pins, target, { blockTag: 'finalized', txHash: actualTx })).toMatchObject({ status: 'executed', txHash: actualTx });
        expect(calls.some((c) => c.method === 'eth_getLogs')).toBe(false);
    });

    it('an invalidation transaction is no execution: the canonical NonceInvalidated log of the search decides', async () => {
        const { client, calls } = chain({ execution: 'none', invalidation: 'canonical' });
        const result = await confirmOnChain(client, pins, target, { blockTag: 'finalized', txHash: invalidationTx, fromBlock: 90n });
        expect(result).toEqual({ status: 'nonce_consumed', txHash: invalidationTx, blockNumber: BigInt(BLOCK), executedTransfer: null });
        expect(calls.some((c) => c.method === 'eth_getLogs')).toBe(true);
    });

    // NonceInvalidated(signer, previousNonce, newNonce) cancels [previousNonce, newNonce); newNonce itself stays
    // usable. The nonce n is used, no execution of it is recognized (for example an internal relayTransfer call), and
    // only an invalidation that ends at n is found: that is no answer. nonce_consumed would make a new payment look safe.
    const n = BigInt(request.nonce);
    it.each([
        ['[0, n)', 'unresolved', [0n, n]],
        ['[n + 1, n + 5)', 'unresolved', [n + 1n, n + 5n]],
        ['[0, n + 1)', 'nonce_consumed', [0n, n + 1n]],
        ['[n, n + 1)', 'nonce_consumed', [n, n + 1n]],
    ] as const)('an invalidation %s without a recognized execution: %s', async (_range, status, invalidationRange) => {
        const { client } = chain({ execution: 'none', invalidation: 'canonical', invalidationRange });
        expect((await confirmOnChain(client, pins, target, { blockTag: 'finalized', fromBlock: 90n })).status).toBe(status);
    });

    it.each(['stale', 'missingHash', 'removed'] as const)('does not authorize repayment from a %s invalidation log', async (invalidation) => {
        const { client } = chain({ execution: 'none', invalidation });
        const result = await confirmOnChain(client, pins, target, { blockTag: 'finalized', fromBlock: 90n });
        expect(result.status).toBe('unresolved');
    });

    it('ignores an execution whose transaction is not in the block of its receipt', async () => {
        const { client } = chain({ execution: 'txBlockMismatch' });
        expect((await confirmOnChain(client, pins, target, { blockTag: 'finalized', fromBlock: 90n })).status).toBe('unresolved');
    });

    // From pins.deployBlock (a lower bound: the block before the deployment's broadcast) to the creation the
    // contract has no code, and eth_call answers no data. That is nonce 0, not a node without the state of older blocks:
    // the use is found from state, and no log search runs.
    it('a read before the contract existed (no data) is the nonce unused: the execution is found from state, without eth_getLogs', async () => {
        const { client, calls } = chain({ createdAt: 0x58 });
        expect(await confirmOnChain(client, pins, target, { blockTag: 'finalized' })).toMatchObject({ status: 'executed', txHash: actualTx, blockNumber: BigInt(BLOCK) });
        const readAt = calls.filter((c) => c.method === 'eth_call').map((c) => Number(BigInt((c.params as string[])[1]!)));
        expect(readAt.some((n) => n < 0x58)).toBe(true);
        expect(calls.some((c) => c.method === 'eth_getLogs')).toBe(false);
    });

    it('ignores a relayTransfer of the request whose signature is not the sender’s', async () => {
        const { client } = chain({ execution: 'foreignSignature' });
        expect((await confirmOnChain(client, pins, target, { blockTag: 'finalized', txHash: actualTx, fromBlock: 90n })).status).toBe('unresolved');
    });
});

describe('waitForTransferOutcome bounds its in-flight work', () => {
    it('times out a status source that never resolves and ignores AbortSignal', async () => {
        const { client } = chain();
        await expect(waitForTransferOutcome(client, pins, target, {
            relay: { getRequest: () => new Promise(() => {}) }, timeoutMs: 25, now: () => NOW,
        })).rejects.toMatchObject({ code: 'timeout' });
    }, 1000);

    it('aborts a status source that ignores AbortSignal', async () => {
        const { client } = chain();
        const controller = new AbortController();
        const waiting = waitForTransferOutcome(client, pins, target, {
            relay: { getRequest: () => new Promise(() => {}) }, timeoutMs: 500, signal: controller.signal, now: () => NOW,
        });
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    }, 1000);

    it('times out an RPC and prevents its late response from starting further reads', async () => {
        let finish: (value: string) => void = () => {};
        const read = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
        const client = createPublicClient({ transport: custom({ request: read }, { retryCount: 0 }) });
        await expect(waitForTransferOutcome(client, pins, target, {
            timeoutMs: 25, now: () => NOW,
        })).rejects.toMatchObject({ code: 'timeout' });
        finish('0x89');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(read).toHaveBeenCalledTimes(1);
    }, 1000);

    // The timeout can stop a contract read of a check (here nonces(from)), and viem wraps the read's error twice
    // (ContractFunctionExecutionError, CallExecutionError). The wait rejects with the timeout itself.
    it('a timeout that stops a contract read rejects with the timeout, not with the wrapped read', async () => {
        const client = createPublicClient({
            transport: custom(
                {
                    async request({ method }) {
                        if (method === 'eth_chainId') return '0x89';
                        if (method === 'eth_getBlockByNumber') {
                            return { number: toHex(HEAD), timestamp: toHex(NOW + HEAD), hash: toHex(HEAD, { size: 32 }), parentHash: hash('f'), transactions: [] };
                        }
                        if (method === 'eth_call') {
                            // Holds the thread past the timeout, so that the read's own budget check stops it before
                            // any timer of the wait runs.
                            const until = performance.now() + 60;
                            while (performance.now() < until);
                            return encodeAbiParameters([{ type: 'uint256' }], [BigInt(request.nonce) + 1n]);
                        }
                        throw new Error(`unexpected RPC ${method}`);
                    },
                },
                { retryCount: 0 },
            ),
        });
        await expect(waitForTransferOutcome(client, pins, target, { timeoutMs: 25, now: () => NOW })).rejects.toMatchObject({ name: 'GaslessError', code: 'timeout' });
    }, 1000);

    it('aborts an RPC and observes a late provider rejection', async () => {
        let fail: (error: Error) => void = () => {};
        const read = vi.fn(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
        const client = createPublicClient({ transport: custom({ request: read }, { retryCount: 0 }) });
        const controller = new AbortController();
        const waiting = waitForTransferOutcome(client, pins, target, {
            timeoutMs: 500, signal: controller.signal, now: () => NOW,
        });
        await Promise.resolve();
        expect(read).toHaveBeenCalledTimes(1);
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
        fail(new Error('provider completed after cancellation'));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(read).toHaveBeenCalledTimes(1);
    }, 1000);

    // The search reads older state first; only an invalidation needs eth_getLogs.
    it.each([
        ['read of older state', 'state', 'eth_call', {}],
        ['log request', 'logs', 'eth_getLogs', { execution: 'none', invalidation: 'canonical' }],
    ] as const)('does not continue the search after a timed-out %s eventually answers', async (_name, stallSearch, method, scenario) => {
        const { client, calls, releaseSearch } = chain({ ...scenario, stallSearch });
        await expect(waitForTransferOutcome(client, pins, target, {
            timeoutMs: 50, now: () => NOW, fromBlock: 90n,
        })).rejects.toMatchObject({ code: 'timeout' });
        const stalledCalls = calls.filter((c) => c.method === method && (method !== 'eth_call' || (c.params as unknown[])[1] !== toHex(HEAD)));
        expect(stalledCalls).toHaveLength(1);
        const count = calls.length;
        releaseSearch();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(calls).toHaveLength(count);
    }, 1000);
});
