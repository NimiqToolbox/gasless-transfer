// The reads of src/tx/quorum.ts that the decisions needing every RPC use: the read budget of a pass (withReadBudget),
// an RPC's finality, and findNonceUse: the block that used a request's intent nonce, located from historical
// nonces(signer) (steps down from the block read, then a binary search), and what in it used the nonce (the relay's
// call, another request of the signer, the signer's NonceInvalidated, a use after the deadline), with no query whose
// answer other accounts can fill. The search reads only that block, never a range of logs over the request's life. The
// transaction manager's use of it is covered in nonceUse.test.ts, txMultiRpc.test.ts and txRpcUnanimity.test.ts.
import { describe, expect, it } from 'vitest';
import {
    ContractFunctionExecutionError,
    ContractFunctionZeroDataError,
    HttpRequestError,
    RpcRequestError,
    TimeoutError,
    encodeAbiParameters,
    encodeEventTopics,
    keccak256,
    pad,
    toHex,
    type Address,
    type Hex,
} from 'viem';
import { gaslessTransferAbi, usdcAbi } from '@nimiq/gasless-sdk/core';
import type { BlockInfo, BlockTransaction, BlockWithTransactions, ChainClient, ChainLog, LogFilter, ReadContractCall, ReceiptInfo } from '../../src/chain/types.js';
import {
    MAX_RECEIPT_READS,
    NONCE_INVALIDATED_TOPIC,
    ReadBudgetExceeded,
    findNonceUse,
    finalityOf,
    invalidatedRange,
    nonceEventFilter,
    withReadBudget,
    type UseQuery,
} from '../../src/tx/quorum.js';

const CONTRACT: Address = '0x00000000000000000000000000000000000000c0';
const SIGNER: Address = '0x00000000000000000000000000000000000000a1';
const RELAY: Address = '0x00000000000000000000000000000000000000b1';
const OTHER_RELAY: Address = '0x00000000000000000000000000000000000000b2';
/** The request's intent nonce. */
const NONCE = 5n;
const T0 = 1_790_000_000n;
const SIGNER_TOPIC = pad(SIGNER, { size: 32 });
const HASH: Hex = `0x${'11'.repeat(32)}`;
const ID: Hex = `0x${'1d'.repeat(32)}`;
const OTHER_ID: Hex = `0x${'2d'.repeat(32)}`;

/** NonceInvalidated(signer, from, to): the signer cancelled its nonces [from, to). By default [NONCE, NONCE + 1). */
const invalidation = (blockNumber: bigint, signer: Address = SIGNER, from: bigint = NONCE, to: bigint = from + 1n): ChainLog => ({
    address: CONTRACT,
    topics: encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [from, to]),
    blockNumber,
    blockHash: toHex(blockNumber, { size: 32 }),
    transactionHash: pad(toHex(blockNumber), { size: 32 }),
});

/** A zero-amount Transfer(SIGNER, to, 0) of a token: anyone can emit it (transferFrom of 0 needs no allowance). */
const zeroTransfer = (blockNumber: bigint, i: number): ChainLog => ({
    address: '0x00000000000000000000000000000000000000d0',
    topics: encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer', args: { from: SIGNER, to: `0x${(0xe000 + i).toString(16).padStart(40, '0')}` } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [0n]),
    blockNumber,
    blockHash: toHex(blockNumber, { size: 32 }),
    transactionHash: keccak256(toHex(`flood ${blockNumber} ${i}`)),
});

/** A transaction of block `n` whose input names the execution the query's executionOf returns for it. */
const tx = (n: bigint, input: Hex, o: { from?: Address; to?: Address | null; hash?: Hex; blockHash?: Hex | null } = {}): BlockTransaction => ({
    hash: o.hash ?? keccak256(toHex(`${n} ${input} ${o.from ?? RELAY}`)),
    from: o.from ?? RELAY,
    to: o.to === undefined ? CONTRACT : o.to,
    input,
    blockHash: o.blockHash === undefined ? toHex(n, { size: 32 }) : o.blockHash,
    gas: 300_000n,
    maxFeePerGas: 200n,
    maxPriorityFeePerGas: 30n,
});

/** The calls the query recognizes: this request (ID) and another request of the signer (OTHER_ID), each from its relay. */
const OWN_CALL: Hex = '0x0001';
const OTHER_CALL: Hex = '0x0002';
const STRANGER_CALL: Hex = '0x0003'; // signed by another account
const EXECUTIONS: Readonly<Record<string, { id: Hex; signer: Address; relay: Address }>> = {
    [OWN_CALL]: { id: ID, signer: SIGNER, relay: RELAY },
    [OTHER_CALL]: { id: OTHER_ID, signer: SIGNER, relay: OTHER_RELAY },
    [STRANGER_CALL]: { id: OTHER_ID, signer: '0x00000000000000000000000000000000000000a2', relay: RELAY },
};

const query = (o: Partial<UseQuery> = {}): UseQuery => ({
    contract: CONTRACT,
    floor: 0n,
    signer: SIGNER,
    nonce: NONCE,
    deadline: T0 + 10n ** 12n,
    id: ID,
    executionOf: async (call) => EXECUTIONS[call.data],
    ...o,
});

/**
 * A chain of blocks 0 to `head`, 2 s apart from T0, whose `nonces(SIGNER)` becomes `nonce` + 1 in block `use` (and is
 * `nonce`, by default NONCE, before), with `transactions` per block, `receipts` by hash (absent: not served) and `logs`.
 * It refuses state reads below `historyFrom` and responses of more than `maxLogs` logs. Below `createdAt` the contract
 * has no code: eth_call answers no data, which viem's readContract throws. `fail` makes a state read throw instead.
 * `blockReceipts` (default: the client has no eth_getBlockReceipts): `served` answers the receipts of a block's
 * transactions (`receipts`, except those in `unlisted`), else it fails with that error. Every request is counted in
 * `reads`.
 */
function chainOf(o: {
    head: bigint;
    use: bigint;
    nonce?: bigint;
    transactions?: Record<string, BlockTransaction[]>;
    receipts?: Record<string, 'success' | 'reverted' | { status: 'success' | 'reverted'; block: bigint }>;
    logs?: ChainLog[];
    historyFrom?: bigint;
    maxLogs?: number;
    createdAt?: bigint;
    fail?: (at: bigint) => Error | undefined;
    blockReceipts?: 'served' | Error;
    unlisted?: readonly Hex[];
    /** eth_getTransactionReceipt answers none for these (eth_getBlockReceipts still lists them). */
    unserved?: readonly Hex[];
}) {
    const reads: string[] = [];
    const block = (n: bigint): BlockInfo => ({ number: n, timestamp: T0 + 2n * n, baseFeePerGas: 100n, hash: toHex(n, { size: 32 }) });
    const all = (o.transactions ?? {}) as Record<string, BlockTransaction[]>;
    const receiptOf = (hash: Hex): ReceiptInfo | null => {
        const known = o.receipts?.[hash];
        if (known === undefined) return null;
        const { status, block: n } = typeof known === 'string' ? { status: known, block: o.use } : known;
        return { transactionHash: hash, blockNumber: n, blockHash: toHex(n, { size: 32 }), status, gasUsed: 100_000n, effectiveGasPrice: 130n, logs: [] };
    };
    const blockReceipts = o.blockReceipts;
    const client = {
        ...(blockReceipts === undefined
            ? {}
            : {
                getBlockReceipts: async (n: bigint): Promise<readonly ReceiptInfo[] | null> => {
                    reads.push(`blockReceipts@${n}`);
                    if (blockReceipts !== 'served') throw blockReceipts;
                    if (n < 0n || n > o.head) return null;
                    return (all[`${n}`] ?? []).flatMap((t) => {
                        const receipt = o.unlisted?.includes(t.hash) ? null : receiptOf(t.hash);
                        return receipt ? [receipt] : [];
                    });
                },
            }),
        readContract: async <T>(call: ReadContractCall): Promise<T> => {
            const at = call.blockNumber ?? o.head;
            reads.push(`nonces@${at}`);
            if (call.functionName !== 'nonces' || (call.args?.[0] as string).toLowerCase() !== SIGNER.toLowerCase()) throw new Error('unexpected read');
            const failure = o.fail?.(at);
            if (failure) throw failure;
            if (o.createdAt !== undefined && at < o.createdAt) {
                throw new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: 'nonces' }), {
                    abi: gaslessTransferAbi,
                    functionName: 'nonces',
                    args: [SIGNER],
                    contractAddress: CONTRACT,
                });
            }
            if (o.historyFrom !== undefined && at < o.historyFrom) throw new Error('missing trie node');
            const nonce = o.nonce ?? NONCE;
            return (at >= o.use ? nonce + 1n : nonce) as T;
        },
        getBlockByNumber: async (n: bigint) => {
            reads.push(`block@${n}`);
            return n >= 0n && n <= o.head ? block(n) : null;
        },
        getBlockWithTransactions: async (n: bigint): Promise<BlockWithTransactions | null> => {
            reads.push(`transactions@${n}`);
            return n >= 0n && n <= o.head ? { ...block(n), transactions: all[`${n}`] ?? [] } : null;
        },
        getTransactionReceipt: async (hash: Hex): Promise<ReceiptInfo | null> => {
            reads.push(`receipt ${hash.slice(0, 10)}`);
            return o.unserved?.includes(hash) ? null : receiptOf(hash);
        },
        getLogs: async (filter: LogFilter): Promise<readonly ChainLog[]> => {
            reads.push(`logs@${filter.fromBlock}-${filter.toBlock}`);
            const match = (want: Hex | readonly Hex[] | null | undefined, have: Hex | undefined) =>
                want === null || want === undefined || (have !== undefined && (typeof want === 'string' ? [want] : want).some((w) => w.toLowerCase() === have.toLowerCase()));
            const found = (o.logs ?? []).filter(
                (l) =>
                    l.address.toLowerCase() === filter.address.toLowerCase() &&
                    l.blockNumber >= filter.fromBlock &&
                    l.blockNumber <= filter.toBlock &&
                    filter.topics.every((want, i) => match(want, l.topics[i])),
            );
            if (found.length > (o.maxLogs ?? Infinity)) throw new Error(`query returned more than ${o.maxLogs} results`);
            return found;
        },
    } as unknown as ChainClient;
    return { client, reads };
}

const stateReads = (reads: readonly string[]) => reads.filter((r) => r.startsWith('nonces@')).length;

describe('withReadBudget', () => {
    const HEAD: BlockInfo = { number: 1_000n, timestamp: T0, baseFeePerGas: null, hash: toHex(1_000n, { size: 32 }) };

    it('reads go through until the budget is spent; then none starts (ReadBudgetExceeded) while broadcasts still go out', async () => {
        let spent = false;
        const calls: string[] = [];
        const inner = {
            getBlock: async (tag: string) => {
                calls.push(`getBlock:${tag}`);
                return HEAD;
            },
            getBlockByNumber: async (n: bigint) => {
                calls.push(`getBlockByNumber:${n}`);
                return HEAD;
            },
            getBlockWithTransactions: async (n: bigint) => {
                calls.push(`getBlockWithTransactions:${n}`);
                return { ...HEAD, transactions: [] };
            },
            getLogs: async () => {
                calls.push('getLogs');
                return [];
            },
            getTransactionCount: async () => {
                calls.push('getTransactionCount');
                return 7;
            },
            getTransactionReceipt: async () => {
                calls.push('getTransactionReceipt');
                return null;
            },
            readContract: async () => {
                calls.push('readContract');
                return true;
            },
            sendRawTransaction: async () => {
                calls.push('sendRawTransaction');
                return { kind: 'accepted' };
            },
        } as unknown as ChainClient;
        const budgeted = withReadBudget(inner, () => spent);
        expect(await budgeted.getBlock('latest')).toBe(HEAD);
        expect(await budgeted.getTransactionCount(SIGNER, 'latest')).toBe(7);
        spent = true;
        await expect(budgeted.getBlock('finalized')).rejects.toBeInstanceOf(ReadBudgetExceeded);
        await expect(budgeted.getBlockByNumber!(5n)).rejects.toBeInstanceOf(ReadBudgetExceeded);
        await expect(budgeted.getBlockWithTransactions!(5n)).rejects.toBeInstanceOf(ReadBudgetExceeded);
        await expect(budgeted.getLogs!({ address: CONTRACT, topics: [], fromBlock: 0n, toBlock: 1n })).rejects.toBeInstanceOf(ReadBudgetExceeded);
        await expect(budgeted.getTransactionCount(SIGNER, 'pending')).rejects.toBeInstanceOf(ReadBudgetExceeded);
        await expect(budgeted.getTransactionReceipt(HASH)).rejects.toBeInstanceOf(ReadBudgetExceeded);
        await expect(budgeted.readContract({ address: CONTRACT, abi: gaslessTransferAbi, functionName: 'nonces', args: [SIGNER] })).rejects.toBeInstanceOf(
            ReadBudgetExceeded,
        );
        expect(await budgeted.sendRawTransaction('0x01')).toEqual({ kind: 'accepted' });
        expect(calls).toEqual(['getBlock:latest', 'getTransactionCount', 'sendRawTransaction']);
    });

    it('keeps the optional reads only where the client has them (a client without eth_getLogs still has none)', () => {
        const bare = withReadBudget({} as ChainClient, () => false);
        expect(bare.getLogs).toBeUndefined();
        expect(bare.getBlockByNumber).toBeUndefined();
        expect(bare.getBlockWithTransactions).toBeUndefined();
    });

    it('a state read the pass ran out of time for goes up: it is no missing state of an older block', async () => {
        const { client, reads } = chainOf({ head: 10_000n, use: 9_000n });
        let left = 3;
        await expect(findNonceUse(withReadBudget(client, () => left-- <= 0), query(), 10_000n)).rejects.toBeInstanceOf(ReadBudgetExceeded);
        expect(reads).toEqual(['nonces@10000', 'nonces@9999', 'nonces@9997']);
    });

    it('finalityOf: a tag read the pass ran out of time for goes up (it says nothing about the tag); control: a node without the tag falls back to the depth', async () => {
        const spent = withReadBudget({ getBlock: async () => HEAD } as unknown as ChainClient, () => true);
        await expect(finalityOf(spent, HEAD, 16, 256)).rejects.toBeInstanceOf(ReadBudgetExceeded);
        const noTag = {
            getBlock: async () => {
                throw new Error('unsupported block tag');
            },
        } as unknown as ChainClient;
        expect(await finalityOf(noTag, HEAD, 16, 256)).toEqual({ finalized: 744n, finalizedTag: undefined });
    });
});

describe('findNonceUse: the block that used the nonce, from state', () => {
    it('B is the first block whose state shows nonces(signer) above the nonce: at most 2·floor(log2(d + 1)) + 2 state reads for B d blocks below the block read', async () => {
        const head = 80_000_000n;
        for (const d of [0n, 1n, 2n, 3n, 7n, 8n, 100n, 4_095n, 50_000n, 1_000_000n]) {
            const use = head - d;
            const { client, reads } = chainOf({ head, use, transactions: { [`${use}`]: [tx(use, OWN_CALL, { hash: HASH })] }, receipts: { [HASH]: 'success' } });
            const found = await findNonceUse(client, query(), head);
            expect(found, `d = ${d}`).toMatchObject({ kind: 'executed', block: { number: use }, tx: { hash: HASH }, receipt: { status: 'success' } });
            const log2 = BigInt((d + 1n).toString(2).length - 1); // floor(log2(d + 1))
            expect(BigInt(stateReads(reads)), `d = ${d}: ${reads.join(' ')}`).toBeLessThanOrEqual(2n * log2 + 2n);
            // Then B alone: its transactions, the receipt of the call that executes the request.
            expect(reads.filter((r) => !r.startsWith('nonces@'))).toEqual([`transactions@${use}`, `receipt ${HASH.slice(0, 10)}`]);
        }
    });

    it('the nonce used in block 0 and in the block read itself', async () => {
        for (const use of [0n, 1_000n]) {
            const { client } = chainOf({ head: 1_000n, use, logs: [invalidation(use)] });
            expect(await findNonceUse(client, query(), 1_000n)).toMatchObject({ kind: 'invalidated', block: { number: use } });
        }
    });

    it('unknown when the nonce is unused at the block read, or the RPC has no state of an older block (it needs the state of older blocks)', async () => {
        const unused = chainOf({ head: 1_000n, use: 1_001n });
        expect(await findNonceUse(unused.client, query(), 1_000n)).toEqual({ kind: 'unknown', why: 'the nonce is unused at block 1000' });
        const pruned = chainOf({ head: 10_000n, use: 9_000n, historyFrom: 9_900n });
        expect(await findNonceUse(pruned.client, query(), 10_000n)).toEqual({
            kind: 'unknown',
            why: 'the RPC does not serve the state of block 9873 (it needs the state of older blocks; eth_call answered an error)',
        });
        expect(pruned.reads.every((r) => r.startsWith('nonces@'))).toBe(true);
    });
});

// The search has a lower bound, the query's floor. Below the block that created the contract eth_call answers no data,
// which viem throws; that is not missing state of older blocks. Without the bound the first requests after a
// deployment, and any search for an old use, would wait on an RPC that serves every block's state.
describe('findNonceUse: not below the deploy block; no code there means the nonce is unused', () => {
    const CREATED = 9_000n;

    it('the nonce used right after the creation, read from every head up to 600 blocks later: found from state, with no read below the floor', async () => {
        for (const floor of [CREATED, CREATED - 3n, 0n]) {
            for (const use of [CREATED, CREATED + 1n, CREATED + 2n]) {
                for (let head = use; head <= use + 600n; head++) {
                    const { client, reads } = chainOf({ head, use, createdAt: CREATED, logs: [invalidation(use)] });
                    const found = await findNonceUse(client, query({ floor }), head);
                    expect(found, `floor ${floor}, use ${use}, head ${head}`).toMatchObject({ kind: 'invalidated', block: { number: use } });
                    expect(reads.filter((r) => r.startsWith('nonces@') && BigInt(r.slice('nonces@'.length)) < floor)).toEqual([]);
                    const log2 = BigInt((head - use + 1n).toString(2).length - 1);
                    expect(BigInt(stateReads(reads))).toBeLessThanOrEqual(2n * log2 + 2n);
                }
            }
        }
    });

    it('a block read below the floor: the contract did not exist yet, so the nonce is unused there (nothing is read)', async () => {
        const { client, reads } = chainOf({ head: 8_000n, use: 7_000n });
        expect(await findNonceUse(client, query({ floor: CREATED }), 8_000n)).toEqual({ kind: 'unknown', why: 'the nonce is unused at block 8000' });
        expect(reads).toEqual([]);
    });

    it('control: without the floor and with an RPC that refuses older state, the refusal still says so', async () => {
        const { client } = chainOf({ head: 10_000n, use: CREATED + 1n, createdAt: CREATED, historyFrom: 9_990n });
        expect(await findNonceUse(client, query({ floor: CREATED - 3n }), 10_000n)).toMatchObject({
            kind: 'unknown',
            why: expect.stringContaining('the RPC does not serve the state of block 9985'),
        });
    });
});

// Not every error of a state read means "no state of older blocks". A read that times out, is rate limited or gets an
// HTTP error is no answer of the RPC: it goes up, and TxManager.ask holds the RPC silent for the rest of the pass. Only
// an error the RPC answers with (a JSON-RPC error) means it has no state of that block.
describe('findNonceUse: errors of the state reads', () => {
    const URL = 'https://rpc.invalid';
    const failingBelow = (error: Error) => chainOf({ head: 10_000n, use: 9_000n, fail: (at) => (at < 10_000n ? error : undefined) });

    it.each([
        ['a timeout', new TimeoutError({ body: {}, url: URL })],
        ['a rate limit (HTTP 429)', new HttpRequestError({ url: URL, status: 429, body: {} })],
        ['an HTTP error', new HttpRequestError({ url: URL, status: 502, body: {} })],
        ['no connection', new HttpRequestError({ url: URL, body: {} })],
        ['a JSON-RPC rate limit (-32005)', new RpcRequestError({ url: URL, body: {}, error: { code: -32005, message: 'limit exceeded' } })],
    ])('%s goes up: the RPC does not answer', async (_name, error) => {
        const { client, reads } = failingBelow(error);
        await expect(findNonceUse(client, query(), 10_000n)).rejects.toBe(error);
        expect(reads).toEqual(['nonces@10000', 'nonces@9999']);
    });

    it('a JSON-RPC error answer (a missing trie node) means no state of that block; the ALERT names its code, never the message', async () => {
        const { client } = failingBelow(new RpcRequestError({ url: URL, body: {}, error: { code: -32000, message: 'missing trie node abc' } }));
        expect(await findNonceUse(client, query(), 10_000n)).toEqual({
            kind: 'unknown',
            why: 'the RPC does not serve the state of block 9999 (it needs the state of older blocks; eth_call answered error -32000)',
        });
    });
});

describe('findNonceUse: what in B used the nonce', () => {
    const B = 9_000n;
    const at = (o: Omit<Parameters<typeof chainOf>[0], 'head' | 'use'>) => chainOf({ head: 10_000n, use: B, ...o });

    it("executed: the relay's call of this request with its successful receipt", async () => {
        const call = tx(B, OWN_CALL);
        const { client } = at({ transactions: { [`${B}`]: [call] }, receipts: { [call.hash]: 'success' } });
        expect(await findNonceUse(client, query(), 10_000n)).toMatchObject({ kind: 'executed', tx: call, receipt: { transactionHash: call.hash } });
    });

    // The call in B without its receipt is not taken for the execution, even when nothing else in B shows the use. A
    // relayTransfer of another request called through code before it (a contract, or an EOA with an EIP-7702 delegation
    // calling itself) makes it revert, and B shows nothing of that call: only the receipt tells.
    it("the relay's call in B without a receipt is no execution: unknown (listed), also when nothing else in B can have used the nonce", async () => {
        const own = tx(B, OWN_CALL);
        const other = tx(B, OTHER_CALL, { from: OTHER_RELAY });
        const listed = { kind: 'unknown', why: `the RPC shows the relay's call in block ${B} but serves no receipt of it`, listed: true };
        expect(await findNonceUse(at({ transactions: { [`${B}`]: [own] } }).client, query(), 10_000n)).toEqual(listed);
        const withReverted = at({ transactions: { [`${B}`]: [other, own] }, receipts: { [other.hash]: 'reverted' } });
        expect(await findNonceUse(withReverted.client, query(), 10_000n)).toEqual(listed);
        // Nor from eth_getBlockReceipts, which does not list it.
        const listedOnly = at({ transactions: { [`${B}`]: [own] }, blockReceipts: 'served' });
        expect(await findNonceUse(listedOnly.client, query(), 10_000n)).toEqual(listed);
        expect(listedOnly.reads.filter((r) => !r.startsWith('nonces@'))).toEqual([`transactions@${B}`, `blockReceipts@${B}`, `receipt ${own.hash.slice(0, 10)}`, `logs@${B}-${B}`]);
    });

    it('control: another call of the signer at the nonce whose receipt is not served, or an invalidation covering the nonce, leaves no execution', async () => {
        const own = tx(B, OWN_CALL);
        const other = tx(B, OTHER_CALL, { from: OTHER_RELAY });
        expect(await findNonceUse(at({ transactions: { [`${B}`]: [other] } }).client, query(), 10_000n)).toEqual({
            kind: 'unknown',
            why: `the RPC does not serve the receipts of the relayTransfer calls in block ${B}`,
        });
        expect(await findNonceUse(at({ transactions: { [`${B}`]: [own, other] } }).client, query(), 10_000n)).toMatchObject({ kind: 'unknown', listed: true });
        const invalidated = at({ transactions: { [`${B}`]: [own] }, logs: [invalidation(B)] });
        expect(await findNonceUse(invalidated.client, query(), 10_000n)).toMatchObject({ kind: 'invalidated', tx: invalidation(B).transactionHash });
    });

    it('other: a successful call of another request of the signer at the nonce, sent by the relay it names; its success means our call in B reverted', async () => {
        const own = tx(B, OWN_CALL);
        const other = tx(B, OTHER_CALL, { from: OTHER_RELAY });
        const { client } = at({ transactions: { [`${B}`]: [own, other] }, receipts: { [other.hash]: 'success' } });
        expect(await findNonceUse(client, query(), 10_000n)).toEqual({ kind: 'other', block: expect.objectContaining({ number: B }), tx: other.hash });
    });

    it('only direct calls of the contract that the signer signed at the nonce, sent by their relay, in B: no other transaction is a candidate, nor are their receipts read', async () => {
        const decoys = [
            tx(B, OTHER_CALL, { from: RELAY }), // not sent by the relay it names
            tx(B, STRANGER_CALL), // signed by another account
            tx(B, OTHER_CALL, { from: OTHER_RELAY, to: '0x00000000000000000000000000000000000000c9' }), // another contract
            tx(B, OTHER_CALL, { from: OTHER_RELAY, to: null }),
            tx(B, OTHER_CALL, { from: OTHER_RELAY, blockHash: toHex(B + 1n, { size: 32 }) }), // listed in another block
            tx(B, '0xdeadbeef', { from: OTHER_RELAY }), // no relayTransfer
        ];
        const receipts = Object.fromEntries(decoys.map((d) => [d.hash, 'success' as const]));
        const { client, reads } = at({ transactions: { [`${B}`]: decoys }, receipts });
        expect(await findNonceUse(client, query(), 10_000n)).toEqual({
            kind: 'unknown',
            why: `nothing in block ${B} shows how the nonce was used (a relayTransfer called by another contract?)`,
        });
        expect(reads.filter((r) => r.startsWith('receipt'))).toEqual([]);
    });

    it('late: B after the deadline (the contract refuses the request there); nothing in B is read', async () => {
        const own = tx(B, OWN_CALL);
        const { client, reads } = at({ transactions: { [`${B}`]: [own] }, receipts: { [own.hash]: 'success' } });
        expect(await findNonceUse(client, query({ deadline: T0 + 2n * B - 1n }), 10_000n)).toMatchObject({ kind: 'late', block: { number: B } });
        expect(reads.filter((r) => !r.startsWith('nonces@'))).toEqual([`transactions@${B}`]);
        // At the deadline itself the request could still execute.
        expect((await findNonceUse(client, query({ deadline: T0 + 2n * B }), 10_000n)).kind).toBe('executed');
    });

    it('a receipt of another block than the one that lists the transaction: an inconsistent view, no answer', async () => {
        const own = tx(B, OWN_CALL);
        const { client } = at({ transactions: { [`${B}`]: [own] }, receipts: { [own.hash]: { status: 'success', block: B + 3n } } });
        expect(await findNonceUse(client, query(), 10_000n)).toMatchObject({ kind: 'unknown', why: expect.stringContaining('receipt of another block') });
    });
});

describe("findNonceUse: the signer's NonceInvalidated in B", () => {
    const B = 9_000n;

    it('a NonceInvalidated covers [previousNonce, newNonce): only a range with the nonce is evidence', async () => {
        const use = async (logs: ChainLog[], nonce = NONCE) => (await findNonceUse(chainOf({ head: 10_000n, use: B, nonce, logs }).client, query({ nonce }), 10_000n)).kind;
        expect(await use([invalidation(B, SIGNER, 2n, NONCE + 1n)])).toBe('invalidated');
        expect(await use([invalidation(B, SIGNER, NONCE, NONCE + 1n)])).toBe('invalidated');
        expect(await use([invalidation(B, SIGNER, 0n, NONCE)])).toBe('unknown'); // [0, 5): not 5
        expect(await use([invalidation(B, SIGNER, NONCE + 1n, NONCE + 10n)])).toBe('unknown');
        expect(await use([invalidation(B, SIGNER, 0n, 2n ** 32n - 1n)], 2n ** 32n - 2n)).toBe('invalidated'); // MAX_NONCE_INCREASE
    });

    it('one exact query of B: [NonceInvalidated, pad(signer)]; logs of other signers, other contracts, other blocks, orphans or that do not decode are no evidence', async () => {
        expect(nonceEventFilter(SIGNER)).toEqual([NONCE_INVALIDATED_TOPIC, SIGNER_TOPIC]);
        expect(nonceEventFilter(SIGNER.toUpperCase().replace('0X', '0x') as Address)).toEqual([NONCE_INVALIDATED_TOPIC, SIGNER_TOPIC]);
        const garbled = { ...invalidation(B), data: '0x1234' as Hex };
        expect(invalidatedRange(garbled)).toBeUndefined();
        expect(invalidatedRange(invalidation(1n, SIGNER, 3n, 9n))).toEqual({ from: 3n, to: 9n });
        const decoys: ChainLog[] = [
            invalidation(B, '0x00000000000000000000000000000000000000a2'),
            { ...invalidation(B), address: '0x00000000000000000000000000000000000000c1' },
            invalidation(B - 1n),
            invalidation(B + 1n),
            { ...invalidation(B), blockHash: toHex(999n, { size: 32 }) },
            garbled,
        ];
        // The RPC answers every log it has, whatever the filter (a lying or broken node): each is compared.
        const { client, reads } = chainOf({ head: 10_000n, use: B });
        const lying = { ...client, getLogs: async (filter: LogFilter) => (reads.push(`logs@${filter.fromBlock}-${filter.toBlock}`), decoys) } as ChainClient;
        expect((await findNonceUse(lying, query(), 10_000n)).kind).toBe('unknown');
        expect(reads.filter((r) => r.startsWith('logs@'))).toEqual([`logs@${B}-${B}`]);
    });

    it('an RPC error of that query goes up (the RPC does not answer)', async () => {
        const { client } = chainOf({ head: 10_000n, use: B });
        const failing = { ...client, getLogs: async () => Promise.reject(new Error('HTTP 429')) } as ChainClient;
        await expect(findNonceUse(failing, query(), 10_000n)).rejects.toThrow('HTTP 429');
    });
});

describe('findNonceUse: a log flood changes neither the answer nor the reads', () => {
    const B = 9_000n;
    /** 2000 zero-amount Transfer logs of the signer and 200 foreign NonceInvalidated events covering the nonce, in B and around it. */
    const flood = (): ChainLog[] =>
        [B - 1n, B, B + 1n].flatMap((n) => [
            ...Array.from({ length: 700 }, (_, i) => zeroTransfer(n, i)),
            ...Array.from({ length: 70 }, (_, i) => invalidation(n, `0x${(0xb000 + i).toString(16).padStart(40, '0')}` as Address, 0n, NONCE + 1n)),
        ]);

    it('an RPC that refuses answers of more than 5 logs answers every query, with the same reads as without the flood', async () => {
        const call = tx(B, OWN_CALL);
        for (const receipts of [{}, { [call.hash]: 'success' as const }]) {
            const plain = chainOf({ head: 10_000n, use: B, transactions: { [`${B}`]: [call] }, receipts, maxLogs: 5 });
            const flooded = chainOf({ head: 10_000n, use: B, transactions: { [`${B}`]: [call] }, receipts, logs: flood(), maxLogs: 5 });
            const a = await findNonceUse(plain.client, query(), 10_000n);
            const b = await findNonceUse(flooded.client, query(), 10_000n);
            expect(b).toEqual(a);
            expect(b).toMatchObject(call.hash in receipts ? { kind: 'executed', tx: call } : { kind: 'unknown', listed: true });
            expect(flooded.reads).toEqual(plain.reads);
        }
        // The signer's own invalidation in the same flood is found.
        const invalidated = chainOf({ head: 10_000n, use: B, transactions: { [`${B}`]: [call] }, logs: [...flood(), invalidation(B)], maxLogs: 5 });
        expect(await findNonceUse(invalidated.client, query(), 10_000n)).toMatchObject({ kind: 'invalidated' });
    });
});

// Only the relays named in requests of the signer at the nonce can add candidate calls to B, but such a relay can put
// any number of reverted copies of its call (out of gas, say) before the one that executes. Their receipts come from
// one eth_getBlockReceipts of B; where the RPC refuses the method, at most MAX_RECEIPT_READS are read one by one, and
// past that B shows nothing on that RPC.
describe('findNonceUse: the receipts of B from eth_getBlockReceipts, else at most MAX_RECEIPT_READS one by one', () => {
    const B = 9_000n;
    const URL = 'https://rpc.invalid';
    const METHOD_NOT_FOUND = new RpcRequestError({ url: URL, body: {}, error: { code: -32601, message: 'the method eth_getBlockReceipts does not exist' } });
    /** `n` reverted copies of the other relay's call (out of gas), then its call that executes. */
    const copies = (n: number) => {
        const reverted = Array.from({ length: n }, (_, i) => tx(B, OTHER_CALL, { from: OTHER_RELAY, hash: keccak256(toHex(`copy ${i}`)) }));
        const executes = tx(B, OTHER_CALL, { from: OTHER_RELAY, hash: keccak256(toHex('executes')) });
        const receipts: Record<string, 'success' | 'reverted'> = Object.fromEntries(reverted.map((t) => [t.hash, 'reverted']));
        receipts[executes.hash] = 'success';
        return { transactions: { [`${B}`]: [...reverted, executes] }, receipts, executes };
    };
    /** The query, counting the signatures it recovers (executionOf). */
    const counting = () => {
        let recovered = 0;
        const q = query({
            executionOf: async (call) => {
                recovered += 1;
                return EXECUTIONS[call.data];
            },
        });
        return { q, recovered: () => recovered };
    };
    const receiptReads = (reads: readonly string[]) => reads.filter((r) => r.startsWith('receipt ')).length;

    it('511 out-of-gas copies before the call that executes: decided from one eth_getBlockReceipts, no receipt read on its own, one signature recovered', async () => {
        const { transactions, receipts, executes } = copies(511);
        const { client, reads } = chainOf({ head: 10_000n, use: B, transactions, receipts, blockReceipts: 'served' });
        const c = counting();
        expect(await findNonceUse(client, c.q, 10_000n)).toEqual({ kind: 'other', block: expect.objectContaining({ number: B }), tx: executes.hash });
        expect(reads.filter((r) => !r.startsWith('nonces@'))).toEqual([`transactions@${B}`, `blockReceipts@${B}`]);
        expect(c.recovered()).toBe(1);
    });

    it("the relay's call executes behind them: executed by its receipt in eth_getBlockReceipts, which eth_getTransactionReceipt does not serve", async () => {
        const { transactions, receipts } = copies(511);
        const own = tx(B, OWN_CALL);
        const block = [...transactions[`${B}`]!.slice(0, 511), own];
        const { client, reads } = chainOf({ head: 10_000n, use: B, transactions: { [`${B}`]: block }, receipts: { ...receipts, [own.hash]: 'success' }, blockReceipts: 'served', unserved: [own.hash] });
        expect(await findNonceUse(client, query(), 10_000n)).toMatchObject({ kind: 'executed', tx: own, receipt: { transactionHash: own.hash, status: 'success', blockNumber: B } });
        expect(receiptReads(reads)).toBe(0);
    });

    it('refused (a JSON-RPC error, an HTTP error status): 15 copies and the call that executes are decided with 16 receipts read one by one', async () => {
        for (const refusal of [METHOD_NOT_FOUND, new HttpRequestError({ url: URL, status: 405, body: {} })]) {
            const { transactions, receipts, executes } = copies(MAX_RECEIPT_READS - 1);
            const { client, reads } = chainOf({ head: 10_000n, use: B, transactions, receipts, blockReceipts: refusal });
            expect(await findNonceUse(client, query(), 10_000n)).toMatchObject({ kind: 'other', tx: executes.hash });
            expect(receiptReads(reads)).toBe(MAX_RECEIPT_READS);
        }
    });

    it('refused: 16 or 511 copies before it leave B without an answer after 16 receipt reads (the request waits); never another kind', async () => {
        for (const n of [MAX_RECEIPT_READS, 511]) {
            const { transactions, receipts } = copies(n);
            const { client, reads } = chainOf({ head: 10_000n, use: B, transactions, receipts, blockReceipts: METHOD_NOT_FOUND });
            expect(await findNonceUse(client, query(), 10_000n)).toEqual({
                kind: 'unknown',
                why: `the RPC refuses eth_getBlockReceipts, and block ${B} holds more than ${MAX_RECEIPT_READS} relayTransfer calls of the sender at the nonce whose receipts it would have to read one by one`,
            });
            expect(receiptReads(reads), `n = ${n}`).toBe(MAX_RECEIPT_READS);
            // The refusal is taken once: eth_getBlockReceipts is not asked again for every call.
            expect(reads.filter((r) => r.startsWith('blockReceipts@'))).toEqual([`blockReceipts@${B}`]);
        }
    });

    it('a client without eth_getBlockReceipts, or a node without the block (null), reads receipts one by one too', async () => {
        const { transactions, receipts, executes } = copies(3);
        const bare = chainOf({ head: 10_000n, use: B, transactions, receipts });
        expect(await findNonceUse(bare.client, query(), 10_000n)).toMatchObject({ kind: 'other', tx: executes.hash });
        expect(receiptReads(bare.reads)).toBe(4);
        const missing = chainOf({ head: 10_000n, use: B, transactions, receipts, blockReceipts: 'served' });
        const withoutBlock = { ...missing.client, getBlockReceipts: async () => null } as ChainClient;
        expect(await findNonceUse(withoutBlock, query(), 10_000n)).toMatchObject({ kind: 'other', tx: executes.hash });
        expect(receiptReads(missing.reads)).toBe(4);
    });

    it('only receipts that name B count: a receipt of another block in the answer (a reorg, a stale cache) is none', async () => {
        const own = tx(B, OWN_CALL);
        const { client, reads } = chainOf({ head: 10_000n, use: B, transactions: { [`${B}`]: [own] }, blockReceipts: 'served' });
        const stale: ReceiptInfo = { transactionHash: own.hash, blockNumber: B, blockHash: keccak256(toHex('another block 9000')), status: 'success', gasUsed: 1n, effectiveGasPrice: 1n, logs: [] };
        const lying = { ...client, getBlockReceipts: async (n: bigint) => (reads.push(`blockReceipts@${n}`), [stale, { ...stale, blockNumber: B + 1n, blockHash: toHex(B + 1n, { size: 32 }) }]) } as ChainClient;
        expect(await findNonceUse(lying, query(), 10_000n)).toMatchObject({ kind: 'unknown', listed: true });
    });

    it('no answer to eth_getBlockReceipts (a timeout, a rate limit, no connection) goes up, as every other read of the search', async () => {
        for (const error of [new TimeoutError({ body: {}, url: URL }), new HttpRequestError({ url: URL, status: 429, body: {} }), new HttpRequestError({ url: URL, body: {} })]) {
            const { transactions, receipts } = copies(2);
            const { client } = chainOf({ head: 10_000n, use: B, transactions, receipts, blockReceipts: error });
            await expect(findNonceUse(client, query(), 10_000n)).rejects.toBe(error);
        }
    });

    it('withReadBudget guards eth_getBlockReceipts too', async () => {
        const { client } = chainOf({ head: 10_000n, use: B, blockReceipts: 'served' });
        await expect(withReadBudget(client, () => true).getBlockReceipts!(B)).rejects.toBeInstanceOf(ReadBudgetExceeded);
        expect(withReadBudget({} as ChainClient, () => false).getBlockReceipts).toBeUndefined();
    });
});
