// One missed read of the honest RPC does not let a lying RPC decide alone, with the RPC clients arranged as in
// production.
//
// In production the relay's own client is viem's fail-over client (reads go to the first RPC in RELAY_RPC_URLS that
// answers) and `rpcClients()` returns one separate client per URL. So every per-RPC client differs from the relay's
// own client, and the lying first RPC is one of the voters. silentRpc.test.ts uses the relay's own client as RPC #1;
// this file uses a separate per-RPC client for it, and lets the honest RPC miss a receipt read (not a head read), to
// show that the protection does not depend on those details.
//
// Expected: only the per-URL clients vote, each counts once, and every one must confirm in the same pass; an RPC that
// fails a read counts as "not yet" and the relay waits. So the liar gets no second call for an executed transfer, no
// `mined` request back in flight, and no reverted call settled as `confirmed`. Each scenario has a control in which
// the honest RPC answers every read.
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { usdcAbi } from '@nimiq/gasless-sdk/core';
import type { CallOutcome, ChainClient, ReadContractCall, ReceiptInfo } from '../../../src/chain/types.js';
import type { FakeChain } from '../../helpers/fakeChain.js';
import { CONTRACT, TEST_TX_SETTINGS, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { RECIPIENT_ADDRESS, USER_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { counter, intentNonceUsed, isRelayTransferFor, relayCallNonces } from '../helpers/relayObservations.js';
import { drive } from '../helpers/finalizedChain.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** RPC #1 as its own client (like viem's per-URL client): it answers what the relay's own client answers. */
function perUrlClient(chain: FakeChain): ChainClient {
    return {
        getChainId: () => chain.getChainId(),
        getLogs: (f) => chain.getLogs(f),
        getBlock: (t) => chain.getBlock(t),
        getBlockByNumber: (n) => chain.getBlockByNumber(n),
        getMaxPriorityFeePerGas: () => chain.getMaxPriorityFeePerGas(),
        getBalance: (a) => chain.getBalance(a),
        getCode: (a) => chain.getCode(a),
        getTransactionCount: (a, t) => chain.getTransactionCount(a, t),
        readContract: <T>(c: ReadContractCall) => chain.readContract<T>(c),
        call: (p) => chain.call(p),
        estimateGas: (p) => chain.estimateGas(p),
        sendRawTransaction: (r) => chain.sendRawTransaction(r),
        getTransactionReceipt: (x) => chain.getTransactionReceipt(x),
    };
}

/** RPC #2: honest (the chain's true state); its receipt reads fail while `miss.receipts` > 0 (one per failed read). */
function honestRpc(chain: FakeChain): { rpc: ChainClient; miss: { receipts: number }; receiptReads: () => number } {
    const view = chain.rpcView();
    const miss = { receipts: 0 };
    let reads = 0;
    const rpc: ChainClient = {
        ...view,
        getTransactionReceipt: (hash) => {
            reads += 1;
            if (miss.receipts > 0) {
                miss.receipts -= 1;
                return Promise.reject(new Error('HTTP 429 Too Many Requests'));
            }
            return view.getTransactionReceipt(hash);
        },
    };
    return { rpc, miss, receiptReads: () => reads };
}

describe('one separate client per RPC URL, as in production: one missed read of the honest RPC does not let the liar decide', () => {
    async function requeue(missOnce: boolean) {
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } });
        await h.relay.txManager.recover();
        const { chain } = h;
        chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
        const t = await queue(h, { token: USDC, mode: 'none', amount: 1_000_000n, fee: 10_000n });
        await tick(h);
        const [call1] = h.store.listAttempts(t.id);
        chain.mine(); // call1 executes: the transfer went through
        expect(chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(1_000_000n);

        // RELAY_RPC_URLS=<liar>,<honest>: the relay's own client reads the liar (first); one client per URL.
        const liar = perUrlClient(chain);
        const honest = honestRpc(chain);
        chain.rpcClients = () => [liar, honest.rpc];
        // The liar hides call1's receipt, reports the intent nonce unused, and simulates a second call as fine.
        const realReceipt = chain.getTransactionReceipt.bind(chain);
        chain.getTransactionReceipt = async (x: Hex): Promise<ReceiptInfo | null> => (x.toLowerCase() === call1!.hash.toLowerCase() ? null : realReceipt(x));
        const realRead = chain.readContract.bind(chain);
        chain.readContract = (async <T>(c: ReadContractCall): Promise<T> =>
            c.functionName === 'nonces' && String(c.args?.[0]).toLowerCase() === USER_ADDRESS.toLowerCase() ? (BigInt(t.request.nonce) as T) : realRead<T>(c)) as typeof chain.readContract;
        const realSimulate = chain.simulate;
        chain.simulate = (c): CallOutcome => (isRelayTransferFor(c.data, t.body.signature) ? { ok: true, data: '0x' } : realSimulate(c));
        // On the real chain, a second call of the executed request reverts (InvalidSignature: its nonce is used).
        chain.executor = (tx) => (isRelayTransferFor(tx.data, t.body.signature) && intentNonceUsed(h!, USER_ADDRESS, t.request.nonce) ? 'reverted' : 'success');

        // 40 passes: past the grace period and the finality of the observation. The honest RPC shows the receipt in
        // every pass; the relay waits and raises the ALERT (RELAY_STUCK_AFTER_BLOCKS=10).
        await drive(h, 40);
        const before = {
            calls: relayCallNonces(h, t.body.signature),
            alert: h.logs.text().includes('an RPC still shows a transaction of the request'),
            honestReceiptReads: honest.receiptReads(),
        };
        expect(before.calls).toEqual([0]);
        expect(before.alert).toBe(true);
        expect(before.honestReceiptReads).toBeGreaterThan(20);

        // One receipt read of the honest RPC fails (after viem's own retry), in one pass.
        if (missOnce) honest.miss.receipts = 1;
        await drive(h, 1);
        await drive(h, 40);
        const record = h.store.getRequest(t.id)!;
        return {
            relayCallTxNonces: relayCallNonces(h, t.body.signature),
            requeued: await counter(h, 'relay_nonce_events_total', 'event="requeued"'),
            status: stateOf(h, t.id).status,
            settled: record.settledAtMs !== null,
        };
    }

    const SAFE = { relayCallTxNonces: [0], requeued: 0, status: 'submitted', settled: false };

    it('one failed receipt read of the honest RPC (RPC #2) does not let the lying RPC #1 requeue an executed transfer', async () => {
        const facts = await requeue(true);
        expect(facts).toEqual(SAFE);
    });

    it('control: the honest RPC answers every read: no second call', async () => {
        expect(await requeue(false)).toEqual(SAFE);
    });

    async function undo(missOnce: boolean) {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { chain } = h;
        chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
        const t = await queue(h, { token: USDC, mode: 'none', amount: 1_000_000n, fee: 10_000n });
        await tick(h);
        const [call1] = h.store.listAttempts(t.id);
        chain.mine();
        await tick(h);
        expect(stateOf(h, t.id).status).toBe('mined');

        const liar = perUrlClient(chain);
        const honest = honestRpc(chain);
        chain.rpcClients = () => [liar, honest.rpc];
        const realReceipt = chain.getTransactionReceipt.bind(chain);
        chain.getTransactionReceipt = async (x: Hex): Promise<ReceiptInfo | null> => (x.toLowerCase() === call1!.hash.toLowerCase() ? null : realReceipt(x));
        chain.getTransactionCount = () => Promise.resolve(0);
        for (let i = 0; i < 5; i++) {
            chain.mine();
            await tick(h);
        }
        expect(h.store.getRequest(t.id)!).toMatchObject({ status: 'mined', reopenedAtMs: null });
        if (missOnce) honest.miss.receipts = 1;
        chain.mine();
        await tick(h);
        const record = h.store.getRequest(t.id)!;
        return {
            status: record.status,
            reopened: record.reopenedAtMs !== null,
            transferExecutedOnChain: intentNonceUsed(h!, USER_ADDRESS, t.request.nonce),
        };
    }

    it('one failed receipt read of the honest RPC does not let the lying RPC #1 put a mined request back in flight', async () => {
        const facts = await undo(true);
        expect(facts).toMatchObject({ status: 'mined', reopened: false });
    });

    it('control: the honest RPC answers every read: the outcome holds', async () => {
        expect(await undo(false)).toMatchObject({ status: 'mined', reopened: false });
    });

    // Settling an outcome purges the request's secrets, so it needs every per-URL client as well, the liar's among
    // them: a pass in which the honest RPC is silent must not settle on the liar's word alone. The call reverted on
    // the real chain; the liar shows it successful (a forged successful receipt, with the token transfers of an
    // execution in its logs).
    async function settle(missOnePass: boolean) {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { chain } = h;
        chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
        const t = await queue(h, { token: USDC, mode: 'none', amount: 1_000_000n, fee: 10_000n });
        await tick(h);
        const [call1] = h.store.listAttempts(t.id);
        chain.executor = () => 'reverted'; // e.g. the sender front-ran it; the transfer did not execute
        const liar = perUrlClient(chain);
        const view = chain.rpcView();
        const down = { head: false };
        const honest: ChainClient = { ...view, getBlock: (tag) => (down.head ? Promise.reject(new Error('timeout')) : view.getBlock(tag)) };
        chain.rpcClients = () => [liar, honest];
        const realReceipt = chain.getTransactionReceipt.bind(chain);
        const r = t.request;
        const forgedLog = {
            address: r.token,
            topics: encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer', args: { from: r.from, to: r.to } }) as Hex[],
            data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(r.amount)]),
        };
        chain.getTransactionReceipt = async (x: Hex): Promise<ReceiptInfo | null> => {
            const real = await realReceipt(x);
            return real && x.toLowerCase() === call1!.hash.toLowerCase() ? { ...real, status: 'success', logs: [forgedLog] } : real;
        };
        await drive(h, 30); // mined on the liar's word (provisional), final by now; the honest RPC shows a revert
        const before = { status: stateOf(h, t.id).status, settled: h.store.getRequest(t.id)!.settledAtMs !== null };
        if (missOnePass) down.head = true;
        await drive(h, 1);
        down.head = false;
        const record = h.store.getRequest(t.id)!;
        return {
            before,
            status: stateOf(h, t.id).status,
            settled: record.settledAtMs !== null,
            secretsPurged: record.signature === null,
            transferExecutedOnChain: intentNonceUsed(h!, USER_ADDRESS, r.nonce),
        };
    }

    it('one silent pass of the honest RPC does not let the lying RPC #1 settle a reverted call as confirmed', async () => {
        const facts = await settle(true);
        expect(facts.before).toEqual({ status: 'mined', settled: false });
        expect(facts).toMatchObject({ status: 'mined', settled: false, secretsPurged: false });
    });

    it('control: the honest RPC answers every read: the forged outcome never settles', async () => {
        const facts = await settle(false);
        expect(facts).toMatchObject({ before: { status: 'mined', settled: false }, status: 'mined', settled: false, transferExecutedOnChain: false });
    });
});
