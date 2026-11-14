// The receipts of the block that used the nonce. The relay a request names can put hundreds of reverted copies of
// its call (out of gas) before the executing one in that block: each copy is a direct relayTransfer call of the
// request, signed by the sender at the nonce and sent by its relay, so the check cannot drop it before its receipt.
// Read one by one, 510 copies would use up the requests of a check (unresolved). So the check reads the block's
// receipts with one eth_getBlockReceipts, in the state search and in the log search's block scans; where the RPC
// refuses it, it reads them one by one, at most MAX_RECEIPT_READS, and past that the answer is unresolved.
//
// Production GaslessTransfer on anvil with the token doubles (test/helpers/productionChain.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, http, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '../../../src/core/abi.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { TransferVersion } from '../../../src/core/types.js';
import { MAX_CHECK_REQUESTS, MAX_RECEIPT_READS } from '../../../src/viem/confirm.js';
import { confirmOnChain, prepareTransfer, signPrepared, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC } from '../../helpers/fixtures.js';
import { chainToolsAvailable, relayTransferArgs, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';
import { modelClient, type RpcModel } from '../../helpers/rpcModel.js';

const finalized = { blockTag: 'finalized' } as const;

function version(signed: SignedTransfer): TransferVersion {
    return { request: signed.request, authHash: signed.authHash };
}

describe.skipIf(!chainToolsAvailable())("the receipts of the block that used the nonce: one eth_getBlockReceipts, or at most MAX_RECEIPT_READS one by one", () => {
    let ctx: ProductionChain;
    let snapshot: Hex;

    beforeAll(async () => {
        ctx = await startProductionChain();
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

    /**
     * `copies` calls of a request by its relay with 35 000 gas (each runs out of gas), then the relay's executing call,
     * all in one block; then the blocks are made final (anvil finalizes 64 blocks behind the head).
     */
    async function copiesThenExecution(copies: number): Promise<{ signed: SignedTransfer; receipt: TransactionReceipt; depth: bigint }> {
        const now = await ctx.now();
        const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 1_000_000n, fee: 10_000n, relay: ADDR.relay, now });
        const signed = await signPrepared(privateKeyToAccount(KEYS.user), prepared, ctx.pins, { now });
        const relay = createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url), account: privateKeyToAccount(KEYS.relay) });
        const base = await ctx.publicClient.getTransactionCount({ address: ADDR.relay, blockTag: 'pending' });
        const call = {
            address: ctx.transfer,
            abi: gaslessTransferAbi,
            functionName: 'relayTransfer',
            args: relayTransferArgs(buildSubmitTransferBody(signed)),
            maxFeePerGas: 10n ** 12n,
            maxPriorityFeePerGas: 10n ** 9n,
        } as const;
        const hashes: Hex[] = [];
        await ctx.testClient.setAutomine(false);
        try {
            for (let i = 0; i <= copies; i++) hashes.push(await relay.writeContract({ ...call, gas: i < copies ? 35_000n : 500_000n, nonce: base + i } as never));
            await ctx.testClient.mine({ blocks: 1 });
        } finally {
            await ctx.testClient.setAutomine(true);
        }
        const receipt = await ctx.publicClient.getTransactionReceipt({ hash: hashes[copies] as Hex });
        expect(receipt).toMatchObject({ status: 'success', transactionIndex: copies });
        if (copies > 0) expect((await ctx.publicClient.getTransactionReceipt({ hash: hashes[0] as Hex })).status).toBe('reverted');
        await ctx.testClient.mine({ blocks: 70 });
        const depth = (await ctx.publicClient.getBlock({ blockTag: 'finalized' })).number - receipt.blockNumber;
        return { signed, receipt, depth };
    }

    const executed = (signed: SignedTransfer, receipt: TransactionReceipt) => ({
        status: 'executed',
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        executedTransfer: version(signed),
    });
    const unresolved = (reason: string) => ({ status: 'unresolved', txHash: null, blockNumber: null, executedTransfer: null, reason });
    /** eth_chainId, the block read, nonces(from) there, 2·floor(log2(d + 1)) + 1 reads of older state, the block of the use. */
    const stateSearch = (depth: bigint) => 5 + 2 * Math.floor(Math.log2(Number(depth) + 1));

    it("510 reverted copies of the relay's call before the executing one: executed, with one eth_getBlockReceipts, in 6 + 2·floor(log2(d + 1)) requests", async () => {
        const { signed, receipt, depth } = await copiesThenExecution(510);
        const rpc = modelClient(ctx);
        expect(await confirmOnChain(rpc.client, ctx.pins, version(signed), finalized)).toEqual(executed(signed, receipt));
        expect({ block: rpc.seen.byMethod.eth_getBlockReceipts, one: rpc.seen.byMethod.eth_getTransactionReceipt, logs: rpc.seen.byMethod.eth_getLogs }).toEqual({ block: 1, one: undefined, logs: undefined });
        expect(rpc.seen.requests).toBe(stateSearch(depth) + 1);

        // Without eth_getBlockReceipts: MAX_RECEIPT_READS receipts of copies, then no answer.
        const refused = modelClient(ctx, { blockReceipts: false });
        expect(await confirmOnChain(refused.client, ctx.pins, version(signed), finalized)).toEqual(unresolved('not_found'));
        expect(refused.seen.byMethod.eth_getTransactionReceipt).toBe(MAX_RECEIPT_READS);
        // The refused eth_getBlockReceipts and the sender's NonceInvalidated events of the block.
        expect(refused.seen.requests).toBe(stateSearch(depth) + 2 + MAX_RECEIPT_READS);

        // Without the state of older blocks: the log search reads that block through its transactions (its Transfer
        // logs are over the cap), with the same receipts.
        const model: RpcModel = { history: false, maxLogs: 1 };
        const pruned = modelClient(ctx, model);
        expect(await confirmOnChain(pruned.client, ctx.pins, version(signed), finalized)).toEqual(executed(signed, receipt));
        expect({ block: pruned.seen.byMethod.eth_getBlockReceipts, one: pruned.seen.byMethod.eth_getTransactionReceipt }).toEqual({ block: 1, one: undefined });
        expect(pruned.seen.blocksRead).toEqual([receipt.blockNumber]);
        expect(pruned.seen.requests).toBeLessThan(MAX_CHECK_REQUESTS / 5);
        const prunedRefused = modelClient(ctx, { ...model, blockReceipts: false });
        expect(await confirmOnChain(prunedRefused.client, ctx.pins, version(signed), finalized)).toEqual(unresolved('no_history'));
        expect(prunedRefused.seen.byMethod.eth_getTransactionReceipt).toBe(MAX_RECEIPT_READS);
        expect(prunedRefused.seen.requests).toBeLessThan(MAX_CHECK_REQUESTS / 5);
    }, 180_000);

    it('without eth_getBlockReceipts, a few reverted copies before the executing call: executed, with one receipt read for each', async () => {
        const { signed, receipt, depth } = await copiesThenExecution(3);
        for (const model of [{ blockReceipts: false }, { blockReceipts: false, history: false, maxLogs: 1 }] as const) {
            const rpc = modelClient(ctx, model);
            expect(await confirmOnChain(rpc.client, ctx.pins, version(signed), finalized), JSON.stringify(model)).toEqual(executed(signed, receipt));
            expect({ block: rpc.seen.byMethod.eth_getBlockReceipts, one: rpc.seen.byMethod.eth_getTransactionReceipt }).toEqual({ block: 1, one: 4 });
            if (model.history !== false) expect(rpc.seen.requests).toBe(stateSearch(depth) + 1 + 4);
        }
    }, 60_000);
});
