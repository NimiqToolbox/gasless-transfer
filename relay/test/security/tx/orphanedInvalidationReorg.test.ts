// A provisional nonce_used failure must not settle while the chain shows that the relay's own call executed the request,
// even when no RPC answers eth_getTransactionReceipt for the call and an RPC still shows the old NonceInvalidated.
// Settling purges the request's secrets and makes the failure final, which would tell the sender that a payment that
// did execute was never made. GaslessTransfer emits no event of its own: the relay locates the use of the intent
// nonce from state, and the call's successful receipt in the block that used the nonce (eth_getBlockReceipts) shows
// the execution. Every RPC showing it turns the provisional failure into mined, confirmed once that block is final.
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { ChainClient, LogFilter, ReadContractCall } from '../../../src/chain/types.js';
import { buildTransfer, CONTRACT, createHarness, restartHarness, TEST_TX_SETTINGS, USDC, type Harness } from '../../helpers/harness.js';
import { RELAY_ADDRESS, RECIPIENT_ADDRESS } from '../../helpers/keys.js';
import { transferOperation } from '../../../src/operations/transfer.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function tick(x: Harness) {
    await x.relay.txManager.tick();
    expect(x.relay.txManager.lastTickError).toBeUndefined();
}

async function drive(x: Harness, blocks: number) {
    for (let i = 0; i < blocks; i++) {
        x.chain.mine({ include: false });
        x.chain.finalized = x.chain.head.number - 64n;
        x.clock.advance(2);
        await tick(x);
    }
}

// A provisional invalidation is replaced by the original successful transfer. The transaction index is unavailable on
// both providers (eth_getTransactionReceipt answers none), but canonical blocks, their receipts (eth_getBlockReceipts),
// logs and contract state remain available. No extra payment may be sent and no failed outcome may become irreversible:
// the request ends confirmed, by its receipt in the block that used its nonce.
async function reorg(restart: boolean, stale: 'none' | 'orphan' | 'fabricated' = 'none', shortLife = false) {
    h = await createHarness();
    const chain = h.chain;
    chain.rpcClients = () => [chain, chain.rpcView()];
    await h.relay.txManager.recover();
    const t = await buildTransfer(h, shortLife ? { deadline: BigInt(h.clock.seconds() + 60) } : {});
    await h.relay.pipeline.submit(transferOperation, t.body);
    await tick(h);
    const original = h.store.listAttempts(t.id)[0]!;
    chain.consumeNonce(RELAY_ADDRESS, 0);
    const invalidationTx = chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
    const invalidation = { ...chain.logs[0]! };
    await drive(h, 14);
    expect(h.store.getRequest(t.id)).toMatchObject({ status: 'failed', settledAtMs: null });

    // Replace the old branch with actual execution of the saved, originally signed transaction.
    chain.logs.length = 0;
    chain.undoNonceChanges(invalidationTx);
    chain.accountNonces.set(RELAY_ADDRESS.toLowerCase(), 0);
    chain.dropMempool();
    await chain.sendRawTransaction(original.raw!);
    chain.mine();
    h.clock.advance(2);
    const receipt = chain.receipts.get(original.hash)!;
    expect(receipt.status).toBe('success');
    expect(chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(BigInt(t.request.amount));
    for (const hash of chain.receipts.keys()) chain.unservedReceipts.add(hash);
    if (stale !== 'none') {
        const actualLogs = chain.getLogs.bind(chain);
        const log = stale === 'orphan' ? { ...invalidation, blockHash: `0x${'ff'.repeat(32)}` as Hex } : invalidation;
        chain.getLogs = async (filter) => (filter.topics?.[0] === log.topics[0] ? [log] : actualLogs(filter));
    }
    if (restart) h = await restartHarness(h);
    const statuses = new Set<string>();
    for (let i = 0; i < 90; i++) {
        await drive(h, 1);
        const now = h.store.getRequest(t.id)!;
        if (now.status === 'failed') expect(now.settledAtMs, 'canonical execution must prevent failed settlement and secret purge').toBeNull();
        statuses.add(now.status);
    }
    // The first pass after the reorg finds the call in the block that used the nonce on both RPCs.
    expect([...statuses]).toEqual(['mined', 'confirmed']);
    const settled = h.store.getRequest(t.id)!;
    expect(settled).toMatchObject({ status: 'confirmed', finalTxHash: original.hash.toLowerCase(), signature: null });
    expect(settled.settledAtMs).not.toBeNull();

    // The real receipt shows on its own afterwards: the final success stays, without another debit.
    expect(chain.receipts.get(original.hash)).toBe(receipt);
    chain.unservedReceipts.clear();
    await drive(h, 3);
    expect(h.store.getRequest(t.id)!.status).toBe('confirmed');
    expect(chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(BigInt(t.request.amount));
    expect(h.store.listAttempts(t.id)).toHaveLength(1);
}

describe('orphan invalidation cannot settle a canonical execution as failed', () => {
    it('rechecks a cached provisional invalidation without restarting', async () => reorg(false));
    it('rejects an orphan log after restart with an honest second RPC', async () => reorg(true, 'orphan'));
    it('requires each RPC to confirm the intent outcome even if the ordinary RPC fabricates an invalidation', async () => reorg(true, 'fabricated'));
    it('control: independent restart with two truthful RPCs confirms the success', async () => reorg(true));
    it('a short-lived request: the fabricated invalidation cannot override the canonical success evidence', async () => reorg(true, 'fabricated', true));
});

// One honest RPC holds the settlement back. After the reorg the first RPC shows the relay's call executing the request in
// the block that used the nonce (its receipt in eth_getBlockReceipts only), while the second, stale or lying, still shows
// the old branch: the nonce used from the invalidation's block and its NonceInvalidated there, final by its own view. The
// provisional failure must not settle (which purges the request's secrets) on the second RPC's word: foreignFinalOn votes
// no on the first RPC.
describe('an RPC that shows the execution holds back the settlement of a failure that another RPC still shows', () => {
    it('the failure stays provisional, the secrets are kept, and the relay waits (ALERT settle)', async () => {
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
        const invalidation = { ...chain.logs[0]! };
        await drive(h, 14);
        expect(h.store.getRequest(t.id)).toMatchObject({ status: 'failed', settledAtMs: null });

        // The reorg: the relay's original call executes the request instead of the invalidation; no RPC answers its
        // receipt on its own.
        chain.logs.length = 0;
        chain.undoNonceChanges(invalidationTx);
        chain.accountNonces.set(RELAY_ADDRESS.toLowerCase(), 0);
        chain.dropMempool();
        await chain.sendRawTransaction(original.raw!);
        chain.mine();
        h.clock.advance(2);
        expect(chain.receipts.get(original.hash)!.status).toBe('success');
        for (const hash of chain.receipts.keys()) chain.unservedReceipts.add(hash);

        const view = chain.rpcView();
        const used = BigInt(t.request.nonce) + 1n;
        const stale: ChainClient = {
            ...view,
            readContract: <T,>(call: ReadContractCall): Promise<T> => {
                const nonceOfSigner =
                    call.functionName === 'nonces' && call.address.toLowerCase() === CONTRACT.toLowerCase() && String(call.args?.[0]).toLowerCase() === t.request.from.toLowerCase();
                if (nonceOfSigner && (call.blockNumber === undefined || call.blockNumber >= invalidation.blockNumber)) return Promise.resolve(used as T);
                return view.readContract<T>(call);
            },
            getLogs: (filter: LogFilter) =>
                filter.fromBlock <= invalidation.blockNumber && invalidation.blockNumber <= filter.toBlock && filter.topics?.[0] === invalidation.topics[0]
                    ? Promise.resolve([invalidation])
                    : view.getLogs!(filter),
        };
        chain.rpcClients = () => [chain, stale];

        for (let i = 0; i < 120; i++) {
            await drive(h, 1);
            expect(h.store.getRequest(t.id)).toMatchObject({ status: 'failed', settledAtMs: null });
        }
        expect(h.store.getRequest(t.id)!.signature).not.toBeNull();
        expect(await h.metrics.registry.metrics()).toContain('relay_decision_waits_total{decision="settle"} 1');
        expect(h.logs.text()).toContain('(settle): not every RPC shows the outcome final and canonical');
    });
});

// The relay locates the use of the intent nonce from state: the invalidation's block is after the request's deadline,
// positive evidence that the request did not execute there, and the expired outcome settles once that block is final.
describe('late invalidation after an expired request was requeued', () => {
    it('settles as expired: the block that used the nonce is after the deadline', async () => {
        h = await createHarness();
        const chain = h.chain;
        chain.rpcClients = () => [chain.rpcView(), chain.rpcView()];
        await h.relay.txManager.recover();
        const t = await buildTransfer(h, { deadline: BigInt(h.clock.seconds() + 60) });
        await h.relay.pipeline.submit(transferOperation, t.body);
        await tick(h);
        chain.consumeNonce(RELAY_ADDRESS, 0);
        for (let i = 0; i < 100 && h.store.getRequest(t.id)!.status === 'submitted'; i++) await drive(h, 1);
        expect(h.store.getRequest(t.id)).toMatchObject({ status: 'expired', txNonce: null, settledAtMs: null });
        expect(chain.head.timestamp).toBeGreaterThan(BigInt(t.request.deadline));
        chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        await drive(h, 70);
        expect(h.store.getRequest(t.id)).toMatchObject({ status: 'expired', signature: null });
        expect(h.store.getRequest(t.id)!.settledAtMs).not.toBeNull();
        expect(h.store.listAttempts(t.id)).toHaveLength(1);
    });
});
