// A block number the first RPC once chose for a receipt cannot hold the undo of a mined outcome back for good.
//
// A request becomes `mined` on an ordinary read: the receipt of its call from the relay's fail-over client, the first
// RPC that answers. A lying first RPC can answer a successful receipt in any block, for example a million blocks ahead,
// and the relay stores that block number (`resolvedBlock`). If undoing the outcome waited for the RPCs' heads to reach
// the stored number, no head would ever get there, also after the liar answers honestly again or the operator has
// taken it out of RELAY_RPC_URLS. Nothing else leaves `mined`, so:
// - a call that reverted on the honest chain (the sender front-ran it) would stay `mined`: a wrong status that never
//   settles, with its secrets never purged;
// - a call the honest chain never included (dropped from the mempools) would keep its tx nonce unused: no later relay
//   transaction could be mined, and the relay would stall.
//
// The bar of an undo is therefore the relay's own clock (TxManager.undoConfirmed): every RPC's head must be made after
// the moment the relay recorded the outcome (`updatedAtMs`), by its timestamp; a head of the same second does not
// count. No RPC chooses that bar, and a lagging RPC, whose head is older than the recording, still cannot let an undo
// through. A lying RPC can only delay these decisions until it answers honestly again or is removed
// (relay/docs/transaction-lifecycle.md, "Several RPCs"): once every configured RPC answers honestly, the relay
// converges to the chain's truth. The reverted call ends `failed` and settles; the dropped call goes back in flight and
// is sent again.
//
// The controls tell the same lie with the real block number (the next block).
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { ReceiptInfo } from '../../../src/chain/types.js';
import { CONTRACT, TEST_TX_SETTINGS, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { counter, isRelayTransferFor, relayCallNonces } from '../helpers/relayObservations.js';
import { drive, forgedSuccessReceipt } from '../helpers/finalizedChain.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const FAR_AHEAD = 1_000_000n;
/** The dropped call is sent again at its tx nonce and mined; the later request after it; the relay stays ready. */
const RECOVERED = { first: 'confirmed', firstCalls: [0], later: 'confirmed', unready: false };

/**
 * RELAY_RPC_URLS=<liar>,<honest>. The liar is the relay's own (fail-over) client and RPC #1; the honest RPC reads the
 * fake chain's true state. The liar answers the request's call with a successful receipt in block head + `lead`,
 * while `lying`.
 */
async function minedByLie(lead: bigint) {
    h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } });
    await h.relay.txManager.recover();
    const { chain } = h;
    const honest = chain.rpcView();
    chain.rpcClients = () => [chain, honest];
    chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
    const t = await queue(h, { token: USDC, mode: 'none', amount: 1_000_000n, fee: 10_000n });
    await tick(h);
    const call = h.store.listAttempts(t.id)[0]!.hash;
    const liar = { lying: true };
    const forged = forgedSuccessReceipt(call, chain.head.number + lead);
    const realReceipt = chain.getTransactionReceipt.bind(chain);
    chain.getTransactionReceipt = async (hash: Hex): Promise<ReceiptInfo | null> =>
        liar.lying && hash.toLowerCase() === call.toLowerCase() ? forged : realReceipt(hash);
    await tick(h);
    expect(stateOf(h, t.id).status).toBe('mined');
    expect(h.store.getRequest(t.id)!.resolvedBlock).toBe(forged.blockNumber);
    return { t, call, liar };
}

describe('a receipt block number chosen by the first RPC does not hold the undo of a mined outcome back (the bar is the relay clock)', () => {
    it('a call that reverted on the honest chain ends failed (and settles) once every RPC answers honestly, although the liar once answered it mined a million blocks ahead', async () => {
        const { t, liar } = await minedByLie(FAR_AHEAD);
        const x = h!;
        // The sender front-runs the call: it reverts on the honest chain in the next block.
        x.chain.executor = (tx) => (isRelayTransferFor(tx.data, t.body.signature) ? 'reverted' : 'success');
        x.chain.mine();
        liar.lying = false; // from now on every RPC answers honestly (or the operator removed the liar)
        await drive(x, 60);
        const record = x.store.getRequest(t.id)!;
        const facts = {
            status: record.status,
            settled: record.settledAtMs !== null,
            outcomeAlerts: await counter(x, 'relay_decision_waits_total', 'decision="outcome"'),
        };
        // Held back by the forged block number, the request would stay `mined` and unsettled, with an `outcome` ALERT.
        expect(facts).toEqual({ status: 'failed', settled: true, outcomeAlerts: 0 });
    });

    it('a call the honest chain never included is sent again once every RPC answers honestly, so later requests are mined (no permanent stall)', async () => {
        const { t, liar } = await minedByLie(FAR_AHEAD);
        const x = h!;
        x.chain.dropMempool(); // e.g. evicted from the honest mempools during a gas spike; the relay thinks it is mined
        liar.lying = false;
        const later = await queue(x, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n });
        await drive(x, STALL_BLOCKS);
        const facts = stallFacts(x, t.body.signature, t.id, later.id);
        // Held back, tx nonce 0 would never be used again (the first request counts as mined), so nothing at a higher tx
        // nonce could be mined: the later request's call would wait in the mempool and /readyz would report `stalled`.
        expect(facts).toEqual(RECOVERED);
    });
});

/** 400 blocks (800 s): past the later request's deadline (600 s), its cancel and the `stalled` limit (10 blocks here). */
const STALL_BLOCKS = 400;

function stallFacts(x: Harness, firstSignature: Hex, first: Hex, later: Hex) {
    return {
        first: x.store.getRequest(first)!.status,
        firstCalls: relayCallNonces(x, firstSignature),
        later: stateOf(x, later).status,
        unready: !x.relay.txManager.health().ok,
    };
}

describe('controls: the same lie with the real block number is undone once the liar answers honestly', () => {
    it('control: a call that reverted on the honest chain ends failed and settles', async () => {
        const { t, liar } = await minedByLie(1n);
        const x = h!;
        x.chain.executor = (tx) => (isRelayTransferFor(tx.data, t.body.signature) ? 'reverted' : 'success');
        x.chain.mine();
        liar.lying = false;
        await drive(x, 60);
        const record = x.store.getRequest(t.id)!;
        expect({ status: record.status, settled: record.settledAtMs !== null }).toEqual({ status: 'failed', settled: true });
    });

    it('control: a call the honest chain never included goes back in flight and later requests are mined', async () => {
        const { t, liar } = await minedByLie(1n);
        const x = h!;
        x.chain.dropMempool();
        liar.lying = false;
        const later = await queue(x, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n });
        await drive(x, STALL_BLOCKS);
        expect(stallFacts(x, t.body.signature, t.id, later.id)).toEqual(RECOVERED);
    });
});
