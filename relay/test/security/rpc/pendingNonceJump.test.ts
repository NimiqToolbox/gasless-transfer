// One wrong answer of the first RPC to eth_getTransactionCount(relay, "pending") does not move the relay's nonce range.
//
// Scenario: the RPC listed first in RELAY_RPC_URLS answers pending = latest + 30 in one pass and is honest again
// afterwards. A relay that took this answer alone would skip 30 tx nonces (untracked transactions of its key seem to
// be pending), sign its next call at latest + 30, and after RELAY_NONCE_GAP_BLOCKS pay a 0-value self-transfer for
// every skipped nonce. The liar chooses the number; the relay pays 21000 gas for each.
//
// Expected: the stored next nonce is raised from chain state only when every configured RPC answers, and only to the
// lowest pending count among them (TxManager.nonces, recover), so one RPC's answer is never stored. Gap fillers need
// every RPC to answer as well, go only to nonces at or above the highest latest count, and at most
// RELAY_MAX_IN_FLIGHT of them are signed per pass. Here the honest RPC decides: the call goes out at tx nonce 0 and no
// filler is sent or paid for. The unit tests cover each rule with its control.
import { afterEach, describe, expect, it } from 'vitest';
import { parseTransaction } from 'viem';
import { createHarness, type Harness } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { counter } from '../helpers/relayObservations.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const K = 30;

describe('one high pending-nonce answer of the first RPC does not move the relay nonce range', () => {
    it('the relay does not skip tx nonces and pays no fillers when the first RPC once answers pending = latest + 30 (the honest RPC decides the raise)', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { chain } = h;
        const honest = chain.rpcView();
        chain.rpcClients = () => [chain, honest]; // RELAY_RPC_URLS=<liar>,<honest>
        const t = await queue(h);
        // One pass in which the first RPC answers the relay's pending nonce with latest + 30.
        const realCount = chain.getTransactionCount.bind(chain);
        chain.getTransactionCount = async (address, tag) =>
            tag === 'pending' && address.toLowerCase() === RELAY_ADDRESS.toLowerCase() ? (await realCount(address, 'latest')) + K : realCount(address, tag);
        await tick(h);
        chain.getTransactionCount = realCount; // honest again from now on
        const callNonce = h.store.getRequest(t.id)!.txNonce;

        for (let i = 0; i < 40; i++) {
            chain.mine();
            chain.finalized = chain.head.number - 64n;
            await tick(h);
        }
        const relay = RELAY_ADDRESS.toLowerCase();
        const fillersMined = [...chain.mined.values()].filter((tx) => tx.sender === relay && tx.to?.toLowerCase() === relay && tx.value === 0n).length;
        const facts = {
            callNonce,
            fillersMined,
            gapFilledEvents: await counter(h, 'relay_nonce_events_total', 'event="gap_filled"'),
            fillerGasPol: await counter(h, 'relay_gas_cost_pol_total', 'kind="filler"'),
            status: stateOf(h, t.id).status,
            broadcastNonces: chain.broadcasts.map((raw) => parseTransaction(raw).nonce).filter((n) => n !== undefined).length,
        };
        // The call is signed at tx nonce 0, and no filler is mined or counted.
        expect({ callNonce: facts.callNonce, fillersMined: facts.fillersMined, gapFilledEvents: facts.gapFilledEvents }).toEqual({
            callNonce: 0,
            fillersMined: 0,
            gapFilledEvents: 0,
        });
        expect(facts.fillerGasPol).toBe(0);
        expect(h.store.getNextNonce()).toBe(1);
    });
});
