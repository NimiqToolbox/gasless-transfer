// Log flood. Anyone can emit Transfer(from, to, 0) logs of USDC and USDT0 for any sender: transferFrom of 0 needs no
// allowance. A check that looked for an execution through the pinned tokens' Transfer logs from the sender would have
// its eth_getLogs answers filled by such logs: an RPC that caps the logs per answer refuses even the block of the
// execution, and every poll would throw. So the check finds the block that used the nonce from the state
// (nonces(from) at block numbers) and reads that block's transactions; it asks for no log another account can emit, so
// the flood changes neither the answer nor the number of requests. On an RPC without the state of older blocks the log
// search remains: a block whose Transfer logs are refused (or cut off) even alone is read through its transactions, and
// a check ends after MAX_CHECK_REQUESTS requests with `unresolved` (`no_history`), never with a wrong status or an
// error. waitForTransferOutcome's next poll goes on where that check stopped, so the flood is searched once.
//
// Production GaslessTransfer on anvil with the token doubles (test/helpers/productionChain.ts); LogFlooder emits the
// flood.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, encodeEventTopics, getAddress, http, numberToHex, pad, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../../src/core/abi.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { TransferVersion } from '../../../src/core/types.js';
import { MAX_CHECK_REQUESTS } from '../../../src/viem/confirm.js';
import { confirmOnChain, prepareTransfer, signPrepared, waitForTransferOutcome, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC, USDT0 } from '../../helpers/fixtures.js';
import { chainToolsAvailable, relayTransferArgs, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';
import { modelClient, type RpcModel } from '../../helpers/rpcModel.js';

const TRANSFER = encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer' })[0] as Hex;
const USER_TOPIC = pad(ADDR.user.toLowerCase() as Hex, { size: 32 });
/** The logs per answer of the capped RPCs: fewer than one flooded block holds. */
const CAP = 50;
const WAIT = { pollIntervalMs: 20, timeoutMs: 20_000 } as const;

function version(signed: SignedTransfer): TransferVersion {
    return { request: signed.request, authHash: signed.authHash };
}

/** An eth_getLogs query of the sender's Transfer logs of the pinned tokens in one block, as a search through logs asks. */
function transferLogsOf(client: PublicClient, blockNumber: bigint): Promise<unknown> {
    return client.request({
        method: 'eth_getLogs',
        params: [{ address: [USDC, USDT0], topics: [TRANSFER, USER_TOPIC], fromBlock: numberToHex(blockNumber), toBlock: numberToHex(blockNumber) }],
    });
}

describe.skipIf(!chainToolsAvailable())("log flood: zero-amount Transfer logs of the sender change neither the outcome check's answer nor its requests", () => {
    let ctx: ProductionChain;
    let flooder: Address;
    let snapshot: Hex;

    const wallet = (key: Hex) => createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url), account: privateKeyToAccount(key) });

    beforeAll(async () => {
        ctx = await startProductionChain();
        const hash = await wallet(KEYS.other).deployContract({ abi: ctx.fixtures.LogFlooder.abi, bytecode: ctx.fixtures.LogFlooder.bytecode } as never);
        flooder = getAddress((await ctx.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address);
    }, 240_000);

    afterAll(async () => {
        await ctx?.stop();
    });

    beforeEach(async () => {
        snapshot = await ctx.testClient.snapshot();
    });

    afterEach(async () => {
        await ctx.testClient.revert({ id: snapshot });
    });

    /** Another account's flood transaction: `perBlock` zero-amount Transfer(user → recipient) logs, half USDC, half USDT0. */
    function floodCall(perBlock: number) {
        return {
            address: flooder,
            abi: ctx.fixtures.LogFlooder.abi,
            functionName: 'flood',
            args: [[USDC, USDT0], ADDR.user, ADDR.recipient, BigInt(perBlock / 2)],
            gas: 100_000n + BigInt(perBlock) * 10_000n,
        } as const;
    }

    async function signedTransfer(): Promise<SignedTransfer> {
        const now = await ctx.now();
        const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 10_000_000n, fee: 50_000n, relay: ADDR.relay, now });
        return signPrepared(privateKeyToAccount(KEYS.user), prepared, ctx.pins, { now });
    }

    /**
     * `before` flooded blocks, a block with a flood transaction and the use of the payment's nonce (`use`), `after`
     * flooded blocks; then the blocks are made final (anvil finalizes 64 blocks behind the head). Returns the receipt
     * of the use.
     */
    async function floodAround(signed: SignedTransfer, use: 'execute' | 'invalidate', perBlock: number, around = { before: 8, after: 8 }): Promise<TransactionReceipt> {
        const flood = async (blocks: number) => {
            for (let i = 0; i < blocks; i++) {
                const hash = await wallet(KEYS.other).writeContract(floodCall(perBlock) as never);
                await ctx.publicClient.waitForTransactionReceipt({ hash });
            }
        };
        await flood(around.before);
        await ctx.testClient.setAutomine(false);
        let hash: Hex;
        try {
            await wallet(KEYS.other).writeContract(floodCall(perBlock) as never);
            hash =
                use === 'execute'
                    ? await wallet(KEYS.relay).writeContract({ address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'relayTransfer', args: relayTransferArgs(buildSubmitTransferBody(signed)), gas: 500_000n })
                    : await wallet(KEYS.user).writeContract({ address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(signed.request.nonce) + 1n], gas: 200_000n });
            await ctx.testClient.mine({ blocks: 1 });
        } finally {
            await ctx.testClient.setAutomine(true);
        }
        const receipt = await ctx.publicClient.getTransactionReceipt({ hash });
        expect(receipt.status).toBe('success');
        await flood(around.after);
        await ctx.testClient.mine({ blocks: 70 });
        return receipt;
    }

    /** The answer of waitForTransferOutcome on `model` at each flood size, from the same chain state each time. */
    async function atFloodSizes(use: 'execute' | 'invalidate', sizes: readonly number[], model: RpcModel) {
        const runs = [];
        for (const perBlock of sizes) {
            const start = await ctx.testClient.snapshot();
            const signed = await signedTransfer();
            const receipt = await floodAround(signed, use, perBlock);
            const rpc = modelClient(ctx, model);
            const outcome = await waitForTransferOutcome(rpc.client, ctx.pins, { ...version(signed), versions: [version(signed)] }, WAIT);
            const requests = rpc.seen.requests;
            const depth = (await ctx.publicClient.getBlock({ blockTag: 'finalized' })).number - receipt.blockNumber;
            // Whether the capped RPC refuses the sender's Transfer logs of the use's block alone, as a search through logs asks.
            const refusedAlone = await transferLogsOf(rpc.client, receipt.blockNumber).then(
                () => false,
                () => true,
            );
            runs.push({ perBlock, status: outcome.status, sameTx: outcome.txHash === receipt.transactionHash, requests, depth, refusedAlone });
            await ctx.testClient.revert({ id: start });
        }
        return runs;
    }

    it('executed at every flood size, with the same requests, at most 6 + 2·floor(log2(d + 1)) for a use d blocks below the block read', async () => {
        const runs = await atFloodSizes('execute', [0, 60, 600], { maxLogs: CAP });
        expect(runs.map(({ status, sameTx, refusedAlone }) => ({ status, sameTx, refusedAlone }))).toEqual([
            { status: 'executed', sameTx: true, refusedAlone: false },
            // The flood is real: this RPC refuses the sender's Transfer logs even of the execution's block alone.
            { status: 'executed', sameTx: true, refusedAlone: true },
            { status: 'executed', sameTx: true, refusedAlone: true },
        ]);
        const [first] = runs;
        expect(runs.every((run) => run.requests === first?.requests && run.depth === first.depth)).toBe(true);
        // eth_chainId, the block read, nonces(from) there; 2·floor(log2(d + 1)) + 1 reads of older state; the block of
        // the use with its transactions and the execution's receipt.
        expect(first?.requests).toBeLessThanOrEqual(6 + 2 * Math.floor(Math.log2(Number(first?.depth) + 1)));
    }, 120_000);

    it('nonce_consumed at every flood size, with the same requests, at most 7 + 2·floor(log2(d + 1))', async () => {
        const runs = await atFloodSizes('invalidate', [0, 600], { maxLogs: CAP });
        expect(runs.map(({ status, sameTx }) => ({ status, sameTx }))).toEqual([
            { status: 'nonce_consumed', sameTx: true },
            { status: 'nonce_consumed', sameTx: true },
        ]);
        const [first, second] = runs;
        expect(second?.requests).toBe(first?.requests);
        // As above, plus the sender's NonceInvalidated events of the use's block.
        expect(first?.requests).toBeLessThanOrEqual(7 + 2 * Math.floor(Math.log2(Number(first?.depth) + 1)));
    }, 120_000);

    it('without the state of older blocks: blocks whose Transfer logs the RPC refuses or cuts off even alone are read through their transactions', async () => {
        for (const [model, perBlock, around] of [
            [{ history: false, maxLogs: CAP }, 60, { before: 8, after: 8 }],
            // A provider that returns the first 1000 logs of a longer answer: an answer of 1000 logs counts as cut off.
            [{ history: false, maxLogs: 1_000, overCap: 'truncate' }, 1_200, { before: 2, after: 2 }],
        ] as const) {
            const start = await ctx.testClient.snapshot();
            const signed = await signedTransfer();
            const receipt = await floodAround(signed, 'execute', perBlock, around);
            const rpc = modelClient(ctx, model);
            const answer = await confirmOnChain(rpc.client, ctx.pins, version(signed), { blockTag: 'finalized' });
            expect({ status: answer.status, txHash: answer.txHash }, JSON.stringify(model)).toEqual({ status: 'executed', txHash: receipt.transactionHash });
            expect(rpc.seen.refused + rpc.seen.truncated).toBeGreaterThan(0);
            expect(rpc.seen.requests).toBeLessThan(MAX_CHECK_REQUESTS);
            await ctx.testClient.revert({ id: start });
        }
    }, 120_000);

    /** Blocks read with their transactions more than once. */
    const readAgain = (blocks: readonly bigint[]) => blocks.length - new Set(blocks).size;

    // 100 flooded blocks above the execution; each is refused down to a single block, then read through its
    // transactions: more requests than one check makes.
    it('without the state of older blocks, a flood beyond the requests of one check: that check is unresolved (no_history) after MAX_CHECK_REQUESTS requests; waitForTransferOutcome goes on where each poll stopped and answers executed', async () => {
        const model = { history: false, maxLogs: 10 } as const;
        const signed = await signedTransfer();
        const receipt = await floodAround(signed, 'execute', 12, { before: 0, after: 100 });
        const rpc = modelClient(ctx, model);
        expect(await confirmOnChain(rpc.client, ctx.pins, version(signed), { blockTag: 'finalized' })).toEqual({
            status: 'unresolved',
            txHash: null,
            blockNumber: null,
            executedTransfer: null,
            reason: 'no_history',
        });
        expect(rpc.seen.requests).toBe(MAX_CHECK_REQUESTS);
        // Each poll of the wait goes on with the log search where the previous one stopped, until it reaches the use.
        const polled = modelClient(ctx, model);
        const outcome = await waitForTransferOutcome(polled.client, ctx.pins, { ...version(signed), versions: [version(signed)] }, { pollIntervalMs: 20, timeoutMs: 60_000 });
        expect({ status: outcome.status, txHash: outcome.txHash }).toEqual({ status: 'executed', txHash: receipt.transactionHash });
        const polls = polled.seen.perCheck;
        expect(polls.length, JSON.stringify(polls)).toBeGreaterThanOrEqual(2);
        expect(polls.slice(0, -1).every((requests) => requests === MAX_CHECK_REQUESTS), JSON.stringify(polls)).toBe(true);
        // Every flooded block's transactions are read once over all polls, except a block that a check stopped in.
        expect(polled.seen.blocksRead.length).toBeGreaterThanOrEqual(101);
        expect(readAgain(polled.seen.blocksRead)).toBeLessThanOrEqual(polls.length - 1);
        // The same chain on an RPC with that state: executed.
        const archive = modelClient(ctx, { maxLogs: 10 });
        expect(await confirmOnChain(archive.client, ctx.pins, version(signed), { blockTag: 'finalized' })).toMatchObject({ status: 'executed', txHash: receipt.transactionHash });
        expect(archive.seen.requests).toBeLessThan(20);
    }, 120_000);

    // The use lies below the blocks searched (fromBlock after it), so no poll can find it. Once the search covered every
    // block from fromBlock up, a poll reads the chain id, the block read, nonces(from) there and the refused read of older
    // state (and past the deadline the refused read at the deadline), and the logs of the blocks within
    // LOG_INDEX_LAG_BLOCKS of the block read again (a log index can lag the block an RPC serves): the Transfer logs and
    // NonceInvalidated events of the 6 blocks above the flood, and the NonceInvalidated events of the flooded blocks,
    // whose transactions are not read again. At most 8 requests.
    it('without the state of older blocks, a use the search cannot find: once the flooded blocks are searched, each poll makes at most 8 requests; the timeout names the missing state', async () => {
        const model = { history: false, maxLogs: 10 } as const;
        const signed = await signedTransfer();
        const receipt = await floodAround(signed, 'execute', 12, { before: 0, after: 100 });
        const polled = modelClient(ctx, model);
        const waited = await waitForTransferOutcome(polled.client, ctx.pins, signed, { fromBlock: receipt.blockNumber + 1n, pollIntervalMs: 20, timeoutMs: 8_000 }).catch(
            (error: unknown) => error as { code?: string; message?: string },
        );
        expect(waited).toMatchObject({ code: 'timeout' });
        expect((waited as { message: string }).message).toMatch(/the RPC serves no state of older blocks \(it is not an archive node\)/);
        const polls = polled.seen.perCheck;
        const searching = polls.findIndex((requests) => requests < MAX_CHECK_REQUESTS);
        // The search of the 100 flooded blocks takes more than one poll, then every later poll is cheap.
        expect(searching, JSON.stringify(polls)).toBeGreaterThanOrEqual(1);
        expect(searching, JSON.stringify(polls)).toBeLessThanOrEqual(3);
        expect(polls.length).toBeGreaterThan(searching + 10);
        expect(Math.max(...polls.slice(searching + 1)), JSON.stringify(polls)).toBeLessThanOrEqual(8);
        expect(polled.seen.requests).toBeLessThanOrEqual((searching + 1) * MAX_CHECK_REQUESTS + 8 * (polls.length - searching - 1));
        expect(readAgain(polled.seen.blocksRead)).toBeLessThanOrEqual(searching);
        expect(await confirmOnChain(modelClient(ctx, model).client, ctx.pins, version(signed), { blockTag: 'finalized', fromBlock: receipt.blockNumber + 1n })).toMatchObject({
            status: 'unresolved',
            reason: 'no_history',
        });
    }, 120_000);
});
