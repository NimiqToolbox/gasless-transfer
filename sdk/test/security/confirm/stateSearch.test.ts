// The state search of the outcome check, which asks for no log another account can emit (see logFlood.test.ts).
// nonces(from) never decreases, so the first block at whose state it is above the intent nonce n, B, holds what
// used n. The check steps down from the block read and bisects (eth_call at block numbers), then reads only B: its
// direct relayTransfer calls and the sender's NonceInvalidated events. These are its edges: n used in the first or
// the last block of the range, later nonces used after n, B at the deadline and one second after it, copies of the
// relay's call from another account in B, an RPC without the state of older blocks, non-canonical evidence and a
// reorg, invalidations around n, another payment at n, and a relayTransfer call from another contract.
//
// Production GaslessTransfer on anvil with the token doubles (test/helpers/productionChain.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, encodeFunctionData, getAddress, http, toHex, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '../../../src/core/abi.js';
import { POLYGON_TOKENS } from '../../../src/core/constants.js';
import { createTransferIntent } from '../../../src/core/intent.js';
import { definePins, type ChainPins } from '../../../src/core/pins.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { TransferVersion } from '../../../src/core/types.js';
import { confirmOnChain, prepareTransfer, signPrepared, type PrepareTransferParams, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC } from '../../helpers/fixtures.js';
import { chainToolsAvailable, relayTransferArgs, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';
import { modelClient } from '../../helpers/rpcModel.js';

const user = privateKeyToAccount(KEYS.user);
/** The block that used the nonce does not show what used it. */
const NOT_FOUND = { status: 'unresolved', txHash: null, blockNumber: null, executedTransfer: null, reason: 'not_found' } as const;
/** The RPC has no state of older blocks, and its logs do not show the use. */
const NO_HISTORY = { ...NOT_FOUND, reason: 'no_history' } as const;

function version(signed: SignedTransfer): TransferVersion {
    return { request: signed.request, authHash: signed.authHash };
}

function executed(signed: SignedTransfer, receipt: TransactionReceipt, status = 'executed') {
    return { status, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, executedTransfer: version(signed) };
}

function consumed(receipt: TransactionReceipt) {
    return { status: 'nonce_consumed', txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, executedTransfer: null };
}

describe.skipIf(!chainToolsAvailable())('the state search: the block that used the intent nonce, found from nonces(from)', () => {
    let ctx: ProductionChain;
    let forwarder: Address;
    let snapshot: Hex;

    beforeAll(async () => {
        ctx = await startProductionChain();
        const wallet = createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url), account: privateKeyToAccount(KEYS.other) });
        const hash = await wallet.deployContract({ abi: ctx.fixtures.CallForwarder.abi, bytecode: ctx.fixtures.CallForwarder.bytecode } as never);
        forwarder = getAddress((await ctx.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address);
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
        return signPrepared(user, prepared, pins, { now });
    }

    const execute = (signed: SignedTransfer) => ctx.relayExecute(buildSubmitTransferBody(signed));
    const invalidate = (newNonce: bigint) => ctx.send(KEYS.user, ctx.transfer, gaslessTransferAbi, 'invalidateNonces', [newNonce]);
    const nonce = () => ctx.publicClient.readContract({ address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [ADDR.user] });
    const finalized = { blockTag: 'finalized' } as const;
    /** Makes the blocks so far final: anvil finalizes 64 blocks behind the head. */
    const finalize = () => ctx.testClient.mine({ blocks: 70 });

    it('n used in the first block of the range (the deploy block): found; below it only the next block is read, once, to check the pin', async () => {
        const signed = await signedTransfer();
        const receipt = await execute(signed);
        await finalize();
        const pins = definePins({ chainId: 137, transfer: ctx.transfer, relays: [ADDR.relay], tokens: POLYGON_TOKENS, deployBlock: Number(receipt.blockNumber) });
        const rpc = modelClient(ctx);
        expect(await confirmOnChain(rpc.client, pins, version(signed), finalized)).toEqual(executed(signed, receipt));
        expect(rpc.seen.callBlocks.filter((block) => block < receipt.blockNumber)).toEqual([receipt.blockNumber - 1n]);
    });

    it('n used in the last block of the range (the block read): one read of older state', async () => {
        const signed = await signedTransfer();
        const receipt = await execute(signed);
        const rpc = modelClient(ctx);
        expect(await confirmOnChain(rpc.client, ctx.pins, version(signed))).toEqual(executed(signed, receipt));
        expect(rpc.seen.callBlocks).toEqual([receipt.blockNumber, receipt.blockNumber - 1n]);
    });

    it('later nonces used after n: each payment is found in its own block; an invalidation of later nonces covers only those', async () => {
        const payments: Array<{ signed: SignedTransfer; receipt: TransactionReceipt }> = [];
        for (let i = 0; i < 3; i++) {
            const signed = await signedTransfer();
            payments.push({ signed, receipt: await execute(signed) });
            await ctx.testClient.mine({ blocks: 5 });
        }
        const next = await nonce();
        const invalidation = await invalidate(next + 3n);
        await finalize();
        for (const { signed, receipt } of payments) {
            expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(signed), finalized)).toEqual(executed(signed, receipt));
        }
        const at = (n: bigint) => ({ request: { ...(payments[0] as { signed: SignedTransfer }).signed.request, nonce: n.toString() } });
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, at(next), finalized)).toEqual(consumed(invalidation));
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, at(next + 2n), finalized)).toEqual(consumed(invalidation));
        expect((await confirmOnChain(ctx.publicClient, ctx.pins, at(next + 3n), finalized)).status).toBe('pending');
    });

    // The contract accepts a request while block.timestamp <= deadline (D3): an `expired` answer for an execution in the
    // block whose timestamp is the deadline would let the wallet pay again.
    it('n used in the block whose timestamp is the deadline: executed on every path of the check; a first use one second later is expired', async () => {
        const signed = await signedTransfer();
        const deadline = BigInt(signed.request.deadline);
        await ctx.testClient.setNextBlockTimestamp({ timestamp: deadline });
        const receipt = await execute(signed);
        expect((await ctx.publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp).toBe(deadline);
        await finalize();
        const answer = executed(signed, receipt);
        // The state search: B's timestamp (useIn) and its relayTransfer call (executionInBlock).
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(signed), finalized)).toEqual(answer);
        // Without the state of older blocks: the relay's txHash and the Transfer logs' transactions (executionIn), and with
        // every Transfer log refused, B's transactions (executionInBlock).
        const pruned = { history: false } as const;
        expect(await confirmOnChain(modelClient(ctx, pruned).client, ctx.pins, version(signed), { ...finalized, txHash: receipt.transactionHash })).toEqual(answer);
        expect(await confirmOnChain(modelClient(ctx, pruned).client, ctx.pins, version(signed), finalized)).toEqual(answer);
        const refused = modelClient(ctx, { ...pruned, maxLogs: 0 });
        expect(await confirmOnChain(refused.client, ctx.pins, version(signed), finalized)).toEqual(answer);
        expect(refused.seen.refused).toBeGreaterThan(0);

        const next = await signedTransfer();
        await ctx.testClient.setNextBlockTimestamp({ timestamp: BigInt(next.request.deadline) + 1n });
        await invalidate(BigInt(next.request.nonce) + 1n);
        await finalize();
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(next), finalized)).toEqual({ status: 'expired', txHash: null, blockNumber: null, executedTransfer: null });
    });

    // executionInBlock takes only a call sent by the relay its request names. Anyone who sees the relay's call in the
    // mempool can put copies of its calldata before it in the same block (each reverts with NotRelay). The block's
    // receipts come with one eth_getBlockReceipts; where the RPC refuses it, they are read one by one, at most
    // MAX_RECEIPT_READS: were the copies' receipts read, the cap would leave the execution unread (unresolved).
    it("600 copies of the relay's call from another account before it in its block: executed, with the block's receipts, or one receipt read without eth_getBlockReceipts", async () => {
        const copies = 600;
        const signed = await signedTransfer();
        const args = relayTransferArgs(buildSubmitTransferBody(signed));
        const other = createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url), account: privateKeyToAccount(KEYS.other) });
        const relay = createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url), account: privateKeyToAccount(KEYS.relay) });
        const base = await ctx.publicClient.getTransactionCount({ address: other.account.address, blockTag: 'pending' });
        const call = { address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'relayTransfer', args, maxFeePerGas: 10n ** 12n } as const;
        let hash: Hex;
        await ctx.testClient.setAutomine(false);
        try {
            // A higher tip orders the copies first.
            for (let i = 0; i < copies; i++) await other.writeContract({ ...call, gas: 100_000n, maxPriorityFeePerGas: 10n ** 11n, nonce: base + i } as never);
            hash = await relay.writeContract({ ...call, gas: 500_000n, maxPriorityFeePerGas: 10n ** 9n } as never);
            await ctx.testClient.mine({ blocks: 1 });
        } finally {
            await ctx.testClient.setAutomine(true);
        }
        const receipt = await ctx.publicClient.getTransactionReceipt({ hash });
        expect(receipt).toMatchObject({ status: 'success', transactionIndex: copies });
        await finalize();
        const rpc = modelClient(ctx);
        expect(await confirmOnChain(rpc.client, ctx.pins, version(signed), finalized)).toEqual(executed(signed, receipt));
        expect({ block: rpc.seen.byMethod.eth_getBlockReceipts, one: rpc.seen.byMethod.eth_getTransactionReceipt }).toEqual({ block: 1, one: undefined });
        expect(rpc.seen.requests).toBeLessThan(40);
        const refused = modelClient(ctx, { blockReceipts: false });
        expect(await confirmOnChain(refused.client, ctx.pins, version(signed), finalized)).toEqual(executed(signed, receipt));
        expect({ block: refused.seen.byMethod.eth_getBlockReceipts, one: refused.seen.byMethod.eth_getTransactionReceipt }).toEqual({ block: 1, one: 1 });
        expect(refused.seen.requests).toBeLessThan(40);
    }, 120_000);

    it('an RPC without the state of older blocks: the log search finds the execution and the invalidation', async () => {
        const signed = await signedTransfer();
        const receipt = await execute(signed);
        const ended = await signedTransfer();
        const invalidation = await invalidate(BigInt(ended.request.nonce) + 1n);
        await finalize();
        const rpc = modelClient(ctx, { history: false });
        expect(await confirmOnChain(rpc.client, ctx.pins, version(signed), finalized)).toEqual(executed(signed, receipt));
        expect(await confirmOnChain(rpc.client, ctx.pins, version(ended), finalized)).toEqual(consumed(invalidation));
        expect(rpc.seen.byMethod.eth_getLogs).toBeGreaterThan(2);
    });

    it('a receipt that names another block than the block listing the transaction: unresolved, from eth_getBlockReceipts or from a single receipt', async () => {
        const signed = await signedTransfer();
        const receipt = await execute(signed);
        await finalize();
        const other = `0x${'ab'.repeat(32)}`;
        const ofExecution = (raw: unknown) => String((raw as { transactionHash: string }).transactionHash).toLowerCase() === receipt.transactionHash.toLowerCase();
        const rewrite = (method: string, params: readonly unknown[], result: unknown) => {
            if (method === 'eth_getTransactionReceipt' && String(params[0]).toLowerCase() === receipt.transactionHash.toLowerCase()) return { ...(result as object), blockHash: other };
            if (method === 'eth_getBlockReceipts') return (result as unknown[]).map((raw) => (ofExecution(raw) ? { ...(raw as object), blockHash: other } : raw));
            return result;
        };
        for (const blockReceipts of [true, false]) {
            const rpc = modelClient(ctx, { rewrite, blockReceipts });
            expect(await confirmOnChain(rpc.client, ctx.pins, version(signed), finalized), `eth_getBlockReceipts ${blockReceipts}`).toEqual(NOT_FOUND);
            expect(rpc.seen.byMethod.eth_getTransactionReceipt).toBe(1);
        }
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(signed), finalized)).toEqual(executed(signed, receipt));
    });

    it("a reorg between the block read and the block that used n: unresolved, not the replacement branch's answer", async () => {
        const signed = await signedTransfer();
        const fork = await ctx.testClient.snapshot();
        const orphan = await execute(signed);
        const orphanBlock = await ctx.publicClient.request({ method: 'eth_getBlockByNumber', params: [toHex(orphan.blockNumber), false] });
        await ctx.testClient.revert({ id: fork });
        const replacement = await invalidate(BigInt(signed.request.nonce) + 1n);
        expect(replacement.blockNumber).toBe(orphan.blockNumber);
        // The block read is still the orphaned one; every later read sees the replacement branch.
        const rpc = modelClient(ctx, { rewrite: (method, params, result) => (method === 'eth_getBlockByNumber' && params[0] === 'latest' ? orphanBlock : result) });
        expect(await confirmOnChain(rpc.client, ctx.pins, version(signed))).toEqual(NOT_FOUND);
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(signed))).toEqual(consumed(replacement));
    });

    it('invalidations around n: one that ends at n leaves it pending; one from below n past it is nonce_consumed', async () => {
        const current = await nonce();
        const now = await ctx.now();
        // A request two nonces ahead (the core takes a nonce as given).
        const intent = createTransferIntent(
            ctx.pins,
            { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 1_000_000n, fee: 10_000n, relay: ADDR.relay, authMode: 'none', deadline: now + 600, nonce: current + 2n },
            now,
        );
        const signed = await signPrepared(user, intent, ctx.pins, { now });
        await invalidate(current + 2n); // [current, current + 2)
        expect((await confirmOnChain(ctx.publicClient, ctx.pins, version(signed))).status).toBe('pending');
        const covering = await invalidate(current + 5n); // [current + 2, current + 5)
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(signed))).toEqual(consumed(covering));
        const below = await signedTransfer({ authMode: 'none' });
        expect(BigInt(below.request.nonce)).toBe(current + 5n);
        // [current + 5, current + 9): previousNonce below the nonce checked, current + 6.
        const past = await invalidate(current + 9n);
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, { request: { ...below.request, nonce: (current + 6n).toString() } })).toEqual(consumed(past));
    });

    it('another payment at n executed: other_payment_executed, also with versions; that payment itself is executed', async () => {
        const ours = await signedTransfer();
        const other = await signedTransfer({ to: ADDR.other, amount: 2_000_000n });
        expect(other.request.nonce).toBe(ours.request.nonce);
        const receipt = await execute(other);
        await finalize();
        const answer = executed(other, receipt, 'other_payment_executed');
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(ours), finalized)).toEqual(answer);
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, { ...version(ours), versions: [version(ours)] }, finalized)).toEqual(answer);
        expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(other), finalized)).toEqual(executed(other, receipt));
    });

    it('relayTransfer called by another contract (the transaction is not to GaslessTransfer): unresolved, with and without the state of older blocks', async () => {
        // The relay is a contract (as a smart account or a bundler would be): the request names it, and it calls.
        const pins = definePins({ chainId: 137, transfer: ctx.transfer, relays: [ADDR.relay, forwarder], tokens: POLYGON_TOKENS, deployBlock: Number(ctx.deployBlock) });
        const signed = await signedTransfer({ relay: forwarder }, pins);
        const call = encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'relayTransfer', args: relayTransferArgs(buildSubmitTransferBody(signed)) });
        const before = await ctx.balanceOf(USDC, ADDR.recipient);
        await ctx.send(KEYS.other, forwarder, ctx.fixtures.CallForwarder.abi, 'forward', [ctx.transfer, call]);
        expect(await ctx.balanceOf(USDC, ADDR.recipient)).toBe(before + 1_000_000n);
        await finalize();
        // The nonce is used, and neither a direct call nor an invalidation shows what used it: no answer.
        expect(await confirmOnChain(ctx.publicClient, pins, version(signed), finalized)).toEqual(NOT_FOUND);
        expect(await confirmOnChain(modelClient(ctx, { history: false }).client, pins, version(signed), finalized)).toEqual(NO_HISTORY);
    });
});
