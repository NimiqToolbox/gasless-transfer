// The log search's progress from one check of a payment to the next (waitForTransferOutcome's polls), on an RPC
// without the state of older blocks: what an earlier check found holds only while the block it read is still the block
// of its number; a log range with a read that gave no evidence is searched again, and so is one within
// LOG_INDEX_LAG_BLOCKS of the block read (a log index can lag the block an RPC serves); blocks above the block an
// earlier check read are not searched (the nonce was already used there). The checks run through confirmWithProgress,
// which waitForTransferOutcome calls with one SearchProgress for all its polls.
//
// Production GaslessTransfer on anvil with the token doubles (test/helpers/productionChain.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../../src/core/abi.js';
import { POLYGON_TOKENS } from '../../../src/core/constants.js';
import { definePins, type ChainPins } from '../../../src/core/pins.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { TransferVersion } from '../../../src/core/types.js';
import { confirmOnChain, confirmWithProgress, LOG_INDEX_LAG_BLOCKS, MAX_CHECK_REQUESTS, newSearchProgress } from '../../../src/viem/confirm.js';
import { prepareTransfer, signPrepared, waitForTransferOutcome, type PrepareTransferParams, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC, USDT0 } from '../../helpers/fixtures.js';
import { chainToolsAvailable, relayTransferArgs, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';
import { modelClient } from '../../helpers/rpcModel.js';

const finalized = { blockTag: 'finalized' } as const;
const TRANSFER = encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer' })[0] as Hex;
/** Blocks to mine after a use so that it is LOG_INDEX_LAG_BLOCKS below the finalized block (anvil: 64 behind the head). */
const PAST_LAG = 70 + Number(LOG_INDEX_LAG_BLOCKS);
/** An RPC's answer that it has no state of that block. */
const missingTrieNode = () => Object.assign(new Error('missing trie node'), { code: -32000 });

function version(signed: SignedTransfer): TransferVersion {
    return { request: signed.request, authHash: signed.authHash };
}

describe.skipIf(!chainToolsAvailable())("the log search's progress from one check of a payment to the next", () => {
    let ctx: ProductionChain;
    let forwarder: Address;
    let flooder: Address;
    let snapshot: Hex;

    const wallet = (key: Hex) => createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url), account: privateKeyToAccount(key) });

    beforeAll(async () => {
        ctx = await startProductionChain();
        const deploy = async (bytecode: Hex) => {
            const hash = await wallet(KEYS.other).deployContract({ abi: [], bytecode } as never);
            return getAddress((await ctx.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address);
        };
        forwarder = await deploy(ctx.fixtures.CallForwarder.bytecode);
        flooder = await deploy(ctx.fixtures.LogFlooder.bytecode);
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

    async function signedTransfer(overrides: Partial<PrepareTransferParams> = {}, pins: ChainPins = ctx.pins): Promise<SignedTransfer> {
        const now = await ctx.now();
        const prepared = await prepareTransfer(ctx.publicClient, pins, { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 1_000_000n, fee: 10_000n, relay: ADDR.relay, now, ...overrides });
        return signPrepared(privateKeyToAccount(KEYS.user), prepared, pins, { now });
    }

    const finalize = (blocks = 70) => ctx.testClient.mine({ blocks });
    const finalizedNumber = async () => (await ctx.publicClient.getBlock({ blockTag: 'finalized' })).number;

    /** `blocks` blocks, each with 12 zero-amount Transfer logs of the sender (above the cap of 10). */
    async function flood(blocks: number): Promise<void> {
        for (let i = 0; i < blocks; i++) {
            const hash = await wallet(KEYS.other).writeContract({
                address: flooder,
                abi: ctx.fixtures.LogFlooder.abi,
                functionName: 'flood',
                args: [[USDC, USDT0], ADDR.user, ADDR.recipient, 6n],
                gas: 300_000n,
            } as never);
            await ctx.publicClient.waitForTransactionReceipt({ hash });
        }
    }

    it('a reorg below the block an earlier check read: its progress is dropped, and the use in a block it searched is found', async () => {
        const pins = definePins({ chainId: 137, transfer: ctx.transfer, relays: [ADDR.relay, forwarder], tokens: POLYGON_TOKENS, deployBlock: Number(ctx.deployBlock) });
        const ours = await signedTransfer({}, pins);
        // Another payment at the nonce, for a relay that calls through code: its use shows neither execution nor invalidation.
        const other = await signedTransfer({ to: ADDR.other, relay: forwarder }, pins);
        expect(other.request.nonce).toBe(ours.request.nonce);
        const fork = await ctx.testClient.snapshot();
        const call = encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'relayTransfer', args: relayTransferArgs(buildSubmitTransferBody(other)) });
        const throughCode = await ctx.send(KEYS.other, forwarder, ctx.fixtures.CallForwarder.abi, 'forward', [ctx.transfer, call]);
        await finalize(PAST_LAG);
        const progress = newSearchProgress();
        const first = await confirmWithProgress(modelClient(ctx, { history: false }).client, pins, version(ours), finalized, progress);
        expect(first).toMatchObject({ status: 'unresolved', reason: 'no_history' });
        expect(progress.executions.some((span) => span.lo <= throughCode.blockNumber && throughCode.blockNumber <= span.hi)).toBe(true);

        // The other branch: the relay's direct call of this payment uses the nonce in the same block.
        await ctx.testClient.revert({ id: fork });
        const executed = await ctx.relayExecute(buildSubmitTransferBody(ours));
        expect(executed.blockNumber).toBe(throughCode.blockNumber);
        await finalize(PAST_LAG + 10);
        const second = await confirmWithProgress(modelClient(ctx, { history: false }).client, pins, version(ours), finalized, progress);
        expect(second).toMatchObject({ status: 'executed', txHash: executed.transactionHash });
    });

    it('a log range with a receipt the RPC did not serve is searched again by the next check', async () => {
        const ours = await signedTransfer();
        const executed = await ctx.relayExecute(buildSubmitTransferBody(ours));
        await finalize(PAST_LAG);
        let hidden = true;
        const rpc = modelClient(ctx, {
            history: false,
            rewrite: (method, params, result) =>
                hidden && method === 'eth_getTransactionReceipt' && String(params[0]).toLowerCase() === executed.transactionHash.toLowerCase() ? null : result,
        });
        const progress = newSearchProgress();
        expect(await confirmWithProgress(rpc.client, ctx.pins, version(ours), finalized, progress)).toMatchObject({ status: 'unresolved', reason: 'no_history' });
        expect(progress.executions.some((span) => span.lo <= executed.blockNumber && executed.blockNumber <= span.hi)).toBe(false);
        hidden = false;
        expect(await confirmWithProgress(rpc.client, ctx.pins, version(ours), finalized, progress)).toMatchObject({ status: 'executed', txHash: executed.transactionHash });
    });

    it('a later check reads no block above the block the previous check read, and goes on where that check stopped', async () => {
        const ours = await signedTransfer();
        const executed = await ctx.relayExecute(buildSubmitTransferBody(ours));
        await flood(100);
        await finalize();
        const progress = newSearchProgress();
        const first = modelClient(ctx, { history: false, maxLogs: 10 });
        expect(await confirmWithProgress(first.client, ctx.pins, version(ours), finalized, progress)).toMatchObject({ status: 'unresolved', reason: 'no_history' });
        expect(first.seen.requests).toBe(MAX_CHECK_REQUESTS);
        const readFirst = await finalizedNumber();
        // More flooded blocks after the use, then they are final too.
        await flood(30);
        await finalize();
        const second = modelClient(ctx, { history: false, maxLogs: 10 });
        const answer = await confirmWithProgress(second.client, ctx.pins, version(ours), finalized, progress);
        expect(answer).toMatchObject({ status: 'executed', txHash: executed.transactionHash });
        expect(second.seen.blocksRead.every((block) => block <= readFirst)).toBe(true);
        // At most the block the first check stopped in is read again.
        const again = second.seen.blocksRead.filter((block) => first.seen.blocksRead.includes(block));
        expect(again.length).toBeLessThanOrEqual(1);
    });

    // A load-balanced RPC whose eth_getLogs backend lags the block it serves answers [] once for the range that holds
    // the execution. Were that range taken as searched, no later poll would search it again while the block read stays
    // the same: the wait would end with its timeout although a fresh check answers executed. So an empty log answer
    // counts only LOG_INDEX_LAG_BLOCKS below the block read.
    describe('a log index that lags the block read answers no Transfer log for the execution once', () => {
        async function executedPayment() {
            const ours = await signedTransfer();
            const receipt = await ctx.relayExecute(buildSubmitTransferBody(ours));
            await finalize();
            return { ours, receipt };
        }

        it('the next check (the same block read, the index caught up) answers executed', async () => {
            const { ours, receipt } = await executedPayment();
            let lagging = true;
            const rpc = modelClient(ctx, {
                history: false,
                rewrite: (method, params, result) => (lagging && method === 'eth_getLogs' && (params[0] as { topics: Hex[] }).topics[0] === TRANSFER ? [] : result),
            });
            const progress = newSearchProgress();
            expect(await confirmWithProgress(rpc.client, ctx.pins, version(ours), finalized, progress)).toMatchObject({ status: 'unresolved', reason: 'no_history' });
            lagging = false;
            expect(await confirmOnChain(rpc.client, ctx.pins, version(ours), finalized)).toMatchObject({ status: 'executed', txHash: receipt.transactionHash });
            expect(await confirmWithProgress(rpc.client, ctx.pins, version(ours), finalized, progress)).toMatchObject({ status: 'executed', txHash: receipt.transactionHash });
        });

        it('waitForTransferOutcome: the first poll meets the lagging index, a later one answers executed', async () => {
            const { ours, receipt } = await executedPayment();
            // The Transfer query of the first range searched is answered [], until that range's NonceInvalidated query.
            let hidden = 0;
            let caughtUp = false;
            const rpc = modelClient(ctx, {
                history: false,
                rewrite: (method, params, result) => {
                    if (method !== 'eth_getLogs') return result;
                    const topic = (params[0] as { topics: Hex[] }).topics[0];
                    if (topic === TRANSFER && !caughtUp) {
                        hidden += 1;
                        return [];
                    }
                    if (topic !== TRANSFER && hidden > 0) caughtUp = true;
                    return result;
                },
            });
            const outcome = await waitForTransferOutcome(rpc.client, ctx.pins, ours, { pollIntervalMs: 20, timeoutMs: 4_000 });
            expect(outcome).toMatchObject({ status: 'executed', txHash: receipt.transactionHash });
            expect(rpc.seen.perCheck).toHaveLength(2);
        });
    });

    // Progress from an earlier check is only as good as the chain it was read from: the next two tests give the check
    // an RPC that contradicts what the earlier check saw.
    it("an RPC whose block read moves back below the block an earlier check read: the check drops that check's progress and does not read above the head", async () => {
        const ours = await signedTransfer();
        const executed = await ctx.relayExecute(buildSubmitTransferBody(ours));
        await finalize(66); // the finalized block is 2 blocks above the use
        const behind = await ctx.testClient.snapshot();
        await finalize(200);
        const rpc = modelClient(ctx, { history: false });
        const progress = newSearchProgress();
        expect(await confirmWithProgress(rpc.client, ctx.pins, version(ours), finalized, progress)).toMatchObject({ status: 'executed', txHash: executed.transactionHash });
        const anchor = progress.anchor?.number ?? 0n;
        // The RPC now serves a chain whose head is below that block (a node behind the one it asked before).
        await ctx.testClient.revert({ id: behind });
        expect(await ctx.publicClient.getBlockNumber()).toBeLessThan(anchor);
        expect(await confirmWithProgress(rpc.client, ctx.pins, version(ours), finalized, progress)).toMatchObject({ status: 'executed', txHash: executed.transactionHash });
        expect(progress.anchor?.number).toBe(await finalizedNumber());
    });

    it('crossed brackets (an inconsistent RPC showed the nonce unused above a block where the next check sees it used): the check starts again from its own reads', async () => {
        const ours = await signedTransfer();
        const executed = await ctx.relayExecute(buildSubmitTransferBody(ours));
        await finalize(80);
        const read = await finalizedNumber(); // 16 blocks above the use
        const at = (params: readonly unknown[]): bigint | undefined => (typeof params[1] === 'string' && params[1].startsWith('0x') ? BigInt(params[1]) : undefined);
        /** nonces(from) as the RPC holds it at and above `lowest`; below it no state; `lie`: the nonce unused there. */
        const stateFrom = (lowest: bigint, lie?: bigint) =>
            modelClient(ctx, {
                rewrite: (method, params, result) => {
                    const block = at(params);
                    if (method !== 'eth_call' || block === undefined || block >= lowest) return result;
                    if (block === lie) return encodeAbiParameters([{ type: 'uint256' }], [0n]);
                    throw missingTrieNode();
                },
            });
        const progress = newSearchProgress();
        // The first check steps down to read - 1 (used) and read - 3 (unused, wrongly), and the bisection is refused.
        expect(await confirmWithProgress(stateFrom(read - 1n, read - 3n).client, ctx.pins, version(ours), finalized, progress)).toMatchObject({
            status: 'unresolved',
            reason: 'no_history',
        });
        expect({ used: progress.used, unused: progress.unused }).toEqual({ used: read - 1n, unused: read - 3n });
        // The next check, at the same block read, sees the nonce used at read - 7.
        expect(await confirmWithProgress(stateFrom(read - 7n).client, ctx.pins, version(ours), finalized, progress)).toMatchObject({
            status: 'executed',
            txHash: executed.transactionHash,
        });
    });

    // Every poll after the first reads the chain id, the block, nonces(from) there, the refused read of older state, and
    // the logs of the blocks within LOG_INDEX_LAG_BLOCKS of the block read again: the sender's Transfer logs (with the
    // receipt of the one transaction they name) and NonceInvalidated events. The start of the search, found by the first
    // poll, is not searched again.
    it('a wait without fromBlock whose use the search cannot find: every poll after the first makes the same 7 requests', async () => {
        const pins = definePins({ chainId: 137, transfer: ctx.transfer, relays: [ADDR.relay, forwarder], tokens: POLYGON_TOKENS, deployBlock: Number(ctx.deployBlock) });
        const ours = await signedTransfer({}, pins);
        const other = await signedTransfer({ to: ADDR.other, relay: forwarder }, pins);
        const call = encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'relayTransfer', args: relayTransferArgs(buildSubmitTransferBody(other)) });
        await ctx.send(KEYS.other, forwarder, ctx.fixtures.CallForwarder.abi, 'forward', [ctx.transfer, call]);
        await finalize();
        const rpc = modelClient(ctx, { history: false });
        const waited = await waitForTransferOutcome(rpc.client, pins, ours, { pollIntervalMs: 20, timeoutMs: 2_000 }).catch((error: unknown) => error as { code?: string });
        expect(waited).toMatchObject({ code: 'timeout' });
        const later = rpc.seen.perCheck.slice(1, -1);
        expect(later.length, JSON.stringify(rpc.seen.perCheck)).toBeGreaterThan(5);
        expect(later, JSON.stringify(rpc.seen.perCheck)).toEqual(later.map(() => 7));
    });
});
