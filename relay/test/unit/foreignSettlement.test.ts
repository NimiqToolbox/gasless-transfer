// The three backup checks in the settlement of an outcome decided by a foreign transaction (TxManager.settleForeign,
// foreignFinalOn, agreedUse). Settling purges the request's signature and authorization, so each check must hold it back
// on its own:
// - the block that used the request's intent nonce must be final by each RPC's own view (foreignFinalOn: a use in a
//   block above the RPC's finalized block votes no);
// - an RPC that shows a receipt of one of the request's transactions votes no (foreignFinalOn), also when it shows
//   it only after the earlier check in the same pass (receiptElsewhere) found none;
// - every RPC must show the same transaction executing the request before the provisional failure becomes mined
//   (agreedUse): two RPCs that each show a call of the relay executing it, with different transaction hashes, decide
//   nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import type { ChainClient, ReceiptInfo } from '../../src/chain/types.js';
import { transferOperation } from '../../src/operations/transfer.js';
import type { FakeChain } from '../helpers/fakeChain.js';
import { buildTransfer, createHarness, TEST_TX_SETTINGS, type Harness } from '../helpers/harness.js';
import { RELAY_ADDRESS } from '../helpers/keys.js';
import { tick } from '../helpers/txManagerDriver.js';

let h: Harness | undefined;
afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** One block (finalized 64 behind), 2 s, one pass; `beforePass` runs right before the pass. */
async function drive(x: Harness, blocks: number, beforePass: () => void = () => {}) {
    for (let i = 0; i < blocks; i++) {
        x.chain.mine({ include: false });
        x.chain.finalized = x.chain.head.number - 64n;
        x.clock.advance(2);
        beforePass();
        await tick(x);
    }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A request whose transaction's nonce another transaction of the relay key used: requeued, then expired in the queue
 * (deadline 60 s), never executed. Decided by a foreign transaction, without a tx nonce; not settled yet.
 */
async function expiredAfterRequeue(rpcs: (chain: FakeChain) => readonly ChainClient[]) {
    h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } });
    const chain = h.chain;
    chain.rpcClients = () => rpcs(chain);
    await h.relay.txManager.recover();
    const t = await buildTransfer(h, { deadline: BigInt(h.clock.seconds() + 60) });
    await h.relay.pipeline.submit(transferOperation, t.body);
    await tick(h);
    chain.consumeNonce(RELAY_ADDRESS, 0);
    for (let i = 0; i < 100 && h.store.getRequest(t.id)!.status === 'submitted'; i++) await drive(h, 1);
    expect(h.store.getRequest(t.id)).toMatchObject({ status: 'expired', txNonce: null, resolvedTxHash: null, settledAtMs: null });
    expect(chain.head.timestamp).toBeGreaterThan(BigInt(t.request.deadline));
    return t;
}

describe('foreignFinalOn needs the block that used the nonce final', () => {
    it('the signer invalidates the nonce after the deadline: unsettled, the signature kept, until that block is final on every RPC; then settled', async () => {
        const t = await expiredAfterRequeue((c) => [c.rpcView(), c.rpcView()]);
        const chain = h!.chain;
        chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        const used = chain.head.number; // the block that used the nonce: after the deadline (late)
        let passes = 0;
        while (chain.head.number - 64n < used) {
            await drive(h!, 1);
            passes += 1;
            const now = h!.store.getRequest(t.id)!;
            if (chain.head.number - 64n < used) {
                expect(now.settledAtMs, `block ${chain.head.number}: the use in block ${used} is not final (finalized ${chain.finalized})`).toBeNull();
                expect(now.signature).not.toBeNull();
            }
        }
        expect(passes).toBeGreaterThan(60);
        await drive(h!, 2);
        expect(h!.store.getRequest(t.id)).toMatchObject({ status: 'expired', signature: null });
        expect(h!.store.getRequest(t.id)!.settledAtMs).not.toBeNull();
    });
});

describe('an RPC that shows a receipt of one of the request’s transactions holds the settlement back', () => {
    it('shown only after the check for receipts elsewhere in the same pass: never settled (ALERT settle); settled once no RPC shows it', async () => {
        // RPC #2 answers a receipt of the request's transaction from the second time it is asked for it in a pass (after
        // receiptElsewhere asked once): a node that catches up in the middle of a pass.
        const asked = new Map<string, number>();
        let lying = false;
        const attempt: { hash?: Hex } = {};
        const t = await expiredAfterRequeue((c) => {
            const view = c.rpcView();
            return [
                c.rpcView(),
                {
                    ...view,
                    getTransactionReceipt: async (hash: Hex): Promise<ReceiptInfo | null> => {
                        if (!lying || attempt.hash === undefined || !same(hash, attempt.hash)) return view.getTransactionReceipt(hash);
                        const n = (asked.get(hash.toLowerCase()) ?? 0) + 1;
                        asked.set(hash.toLowerCase(), n);
                        if (n < 2) return null;
                        const block = c.finalized === 'unsupported' ? c.head.number : c.finalized;
                        return { transactionHash: hash, blockNumber: block, blockHash: toHex(block, { size: 32 }), status: 'reverted', gasUsed: 21_000n, effectiveGasPrice: 1n, logs: [] };
                    },
                },
            ];
        });
        attempt.hash = h!.store.listAttempts(t.id)[0]!.hash;
        lying = true;
        for (let i = 0; i < 120; i++) {
            await drive(h!, 1, () => asked.clear());
            expect(h!.store.getRequest(t.id)).toMatchObject({ status: 'expired', settledAtMs: null });
        }
        expect(h!.store.getRequest(t.id)!.signature).not.toBeNull();
        // Every pass reached the settlement (no RPC showed the receipt to receiptElsewhere) and asked RPC #2 twice.
        const metrics = await h!.metrics.registry.metrics();
        expect(metrics).toContain('relay_decision_waits_total{decision="settle"} 1');
        expect(metrics).not.toContain('decision="outcome"');
        expect(h!.logs.text()).toContain('(settle): not every RPC shows the outcome final and canonical');

        lying = false;
        await drive(h!, 2);
        expect(h!.store.getRequest(t.id)).toMatchObject({ status: 'expired', signature: null });
        expect(h!.store.getRequest(t.id)!.settledAtMs).not.toBeNull();
    });
});

/**
 * A request that failed in the queue after a requeue (no tx nonce), and then a reorg in which the relay's original
 * call executes it after all. No RPC answers that call's receipt on its own; the block's receipts show it.
 */
async function executedAfterItFailedInTheQueue() {
    h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } });
    const x = h;
    const chain = x.chain;
    chain.rpcClients = () => [chain, chain.rpcView()];
    await x.relay.txManager.recover();
    const t = await buildTransfer(x, { deadline: BigInt(x.clock.seconds() + 7000) });
    await x.relay.pipeline.submit(transferOperation, t.body);
    await tick(x);
    const original = x.store.listAttempts(t.id)[0]!;

    // Another transaction of the relay key uses the tx nonce: the request is requeued (no tx nonce any more). The
    // sender invalidates the intent nonce before the check of the requeued request: it fails in the queue.
    chain.consumeNonce(RELAY_ADDRESS, 0);
    let invalidationTx: Hex | undefined;
    const simulate = chain.simulate;
    chain.simulate = (call) => {
        if (invalidationTx === undefined && x.store.getRequest(t.id)!.status === 'queued') {
            invalidationTx = chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        }
        return simulate(call);
    };
    for (let i = 0; i < 100 && x.store.getRequest(t.id)!.status !== 'failed'; i++) await drive(x, 1);
    chain.simulate = simulate;
    expect(x.store.getRequest(t.id)).toMatchObject({ status: 'failed', txNonce: null, resolvedTxHash: null, settledAtMs: null });

    // A reorg: the invalidation is gone and the relay's original call executes the request.
    chain.logs.length = 0;
    chain.undoNonceChanges(invalidationTx!);
    chain.accountNonces.set(RELAY_ADDRESS.toLowerCase(), 0);
    chain.dropMempool();
    await chain.sendRawTransaction(original.raw!);
    chain.mine();
    x.clock.advance(2);
    const executedIn = chain.receipts.get(original.hash)!;
    expect(executedIn.status).toBe('success');
    for (const hash of chain.receipts.keys()) chain.unservedReceipts.add(hash);
    return { x, chain, t, original, executedIn };
}

describe('a failure that ended in the queue after a requeue and turns out executed', () => {
    it('becomes mined when every RPC shows the relay’s call, and settles only once that call’s block is final', async () => {
        const { x, chain, t, original, executedIn } = await executedAfterItFailedInTheQueue();

        // While the block of the call is not final (the finalized block is 64 behind the head), nothing settles.
        const statuses = new Set<string>();
        for (let i = 0; i < 40; i++) {
            await drive(x, 1);
            expect(chain.finalized).toBeLessThan(executedIn.blockNumber);
            const request = x.store.getRequest(t.id)!;
            statuses.add(request.status);
            expect(request).toMatchObject({ settledAtMs: null });
            expect(request.signature).not.toBeNull();
        }
        expect(x.store.getRequest(t.id)).toMatchObject({ status: 'mined', finalTxHash: original.hash.toLowerCase() });
        expect(statuses.has('confirmed')).toBe(false);

        // Final on every RPC: confirmed.
        await drive(x, 40);
        expect(chain.finalized).toBeGreaterThanOrEqual(executedIn.blockNumber);
        expect(x.store.getRequest(t.id)).toMatchObject({ status: 'confirmed', finalTxHash: original.hash.toLowerCase(), signature: null });
    });

    it('and a second reorg removes that execution: once every RPC shows it gone, the request is queued and sent again', async () => {
        const { x, chain, t, original } = await executedAfterItFailedInTheQueue();
        await drive(x, 3);
        expect(x.store.getRequest(t.id)).toMatchObject({ status: 'mined', txNonce: null, finalTxHash: original.hash.toLowerCase(), settledAtMs: null });

        // The block with the call is replaced by one in which the other transaction of the relay key has the tx nonce
        // again: the call is in no block and in no pool, and the request's intent nonce is unused.
        chain.reorg(original.hash);
        chain.dropMempool();
        chain.consumeNonce(RELAY_ADDRESS, 0);
        expect(chain.intentNonce(t.request.from)).toBe(BigInt(t.request.nonce));

        await drive(x, 3);
        // Not mined any more: sent again at a new tx nonce, with a new transaction.
        const resent = x.store.getRequest(t.id)!;
        expect(resent).toMatchObject({ status: 'submitted', txNonce: 1, settledAtMs: null });
        expect(x.logs.text()).toContain('reorg: the execution of the request is gone');
        const attempts = x.store.listAttempts(t.id);
        expect(attempts.at(-1)!.hash).not.toBe(original.hash);

        // That transaction executes it, for good this time.
        chain.mine();
        x.clock.advance(2);
        await drive(x, 80);
        expect(x.store.getRequest(t.id)).toMatchObject({ status: 'confirmed', finalTxHash: attempts.at(-1)!.hash.toLowerCase(), signature: null });
        expect(chain.intentNonce(t.request.from)).toBe(BigInt(t.request.nonce) + 1n);
    });
});

describe('agreedUse needs the same executing transaction on every RPC', () => {
    it('a provisional failure, then a reorg in which the relay’s call executes; RPC #2 shows another hash for it: never mined, never settled (ALERT settle); mined once both agree', async () => {
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } });
        const chain = h.chain;
        chain.rpcClients = () => [chain, chain.rpcView()];
        await h.relay.txManager.recover();
        const t = await buildTransfer(h, {});
        await h.relay.pipeline.submit(transferOperation, t.body);
        await tick(h);
        const original = h.store.listAttempts(t.id)[0]!;
        chain.consumeNonce(RELAY_ADDRESS, 0);
        const invalidationTx = chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        await drive(h, 14);
        expect(h.store.getRequest(t.id)).toMatchObject({ status: 'failed', resolvedTxHash: null, settledAtMs: null });

        // The reorg: the relay's original call executes the request; no RPC answers its receipt on its own.
        chain.logs.length = 0;
        chain.undoNonceChanges(invalidationTx);
        chain.accountNonces.set(RELAY_ADDRESS.toLowerCase(), 0);
        chain.dropMempool();
        await chain.sendRawTransaction(original.raw!);
        chain.mine();
        h.clock.advance(2);
        expect(chain.receipts.get(original.hash)!.status).toBe('success');
        for (const hash of chain.receipts.keys()) chain.unservedReceipts.add(hash);

        // RPC #2 lists the same call of the relay in that block, and its successful receipt, under another hash.
        const other = keccak256(toHex('another transaction of the relay'));
        const swap = (hash: Hex): Hex => (same(hash, original.hash) ? other : hash);
        const view = chain.rpcView();
        const liar: ChainClient = {
            ...view,
            getBlockWithTransactions: async (n) => {
                const block = await view.getBlockWithTransactions!(n);
                return block && { ...block, transactions: block.transactions.map((tx) => ({ ...tx, hash: swap(tx.hash) })) };
            },
            getBlockReceipts: async (n) => {
                const receipts = await view.getBlockReceipts!(n);
                return receipts && receipts.map((r) => ({ ...r, transactionHash: swap(r.transactionHash) }));
            },
        };
        chain.rpcClients = () => [chain, liar];
        for (let i = 0; i < 120; i++) {
            await drive(h, 1);
            expect(h.store.getRequest(t.id)).toMatchObject({ status: 'failed', settledAtMs: null });
        }
        expect(h.store.getRequest(t.id)!.signature).not.toBeNull();
        expect(await h.metrics.registry.metrics()).toContain('relay_decision_waits_total{decision="settle"} 1');
        expect(await h.metrics.registry.metrics()).not.toContain('event="mined_by_nonce_search"');

        // Both RPCs show the same transaction: mined, then confirmed.
        chain.rpcClients = () => [chain, chain.rpcView()];
        const statuses = new Set<string>();
        for (let i = 0; i < 10; i++) {
            await drive(h, 1);
            statuses.add(h.store.getRequest(t.id)!.status);
        }
        expect(h.store.getRequest(t.id)).toMatchObject({ status: 'confirmed', finalTxHash: original.hash.toLowerCase(), signature: null });
        expect(statuses.has('failed')).toBe(false);
    });
});
