// The first RPC alone can end a queued request before its first broadcast, and nothing is sent when it does.
//
// The end of a queued request (queue expiry and the checks before the broadcast) is an ordinary read: it follows the
// relay's fail-over client, the first RPC in RELAY_RPC_URLS that answers (relay/docs/transaction-lifecycle.md,
// "Ordinary reads"). TxManager.expireQueued compares the deadline with the head timestamp of that client. A first RPC
// that reports a head in the future therefore ends every queued request as `expired` long before its deadline, final
// at once (TxManager.endInQueue: settled, secrets purged), while the honest RPC shows the deadline ahead.
//
// The test pins that limit of the trust model and what keeps it harmless: the outcomes that need every RPC are the ones
// decided on-chain, and here nothing is broadcast. No funds move, the intent nonce stays unused and the sender may sign
// again. Only the status and its reason are the first RPC's word, which is why the most reliable provider is listed
// first.
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockInfo } from '../../../src/chain/types.js';
import { createHarness, type Harness } from '../../helpers/harness.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { intentNonceUsed } from '../helpers/relayObservations.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** RELAY_RPC_URLS=<first>,<honest>; the first RPC reports its head `aheadSeconds` in the future (0: honest). */
async function queuedWithFirstRpcAhead(aheadSeconds: bigint) {
    h = await createHarness();
    await h.relay.txManager.recover();
    const { chain } = h;
    const honest = chain.rpcView();
    chain.rpcClients = () => [chain, honest];
    const t = await queue(h, { deadline: BigInt(h.clock.seconds() + 600) });
    const realGetBlock = chain.getBlock.bind(chain);
    chain.getBlock = async (tag): Promise<BlockInfo> => {
        const block = await realGetBlock(tag);
        return tag === 'latest' ? { ...block, timestamp: block.timestamp + aheadSeconds } : block;
    };
    await tick(h);
    const record = h.store.getRequest(t.id)!;
    return {
        status: stateOf(h, t.id).status,
        final: record.settledAtMs !== null,
        honestChainBeforeDeadline: (await honest.getBlock('latest')).timestamp < BigInt(t.request.deadline),
        broadcasts: h.chain.broadcasts.length,
        intentNonceUsed: intentNonceUsed(h, t.request.from, t.request.nonce),
    };
}

describe('the first RPC alone can end a queued request before its broadcast, final at once, but nothing is sent', () => {
    it('a first RPC that reports its head 3600 s in the future ends the queued request as expired, final at once, while the honest RPC shows the deadline ahead; nothing was broadcast and the intent nonce stays unused', async () => {
        const facts = await queuedWithFirstRpcAhead(3600n);
        // The status is the first RPC's word (relay/docs/transaction-lifecycle.md, "Ordinary reads"), but no funds
        // move and the sender may sign again.
        expect(facts).toEqual({ status: 'expired', final: true, honestChainBeforeDeadline: true, broadcasts: 0, intentNonceUsed: false });
    });
});

describe('control: an honest first RPC', () => {
    it('control: the request is broadcast', async () => {
        expect(await queuedWithFirstRpcAhead(0n)).toEqual({ status: 'submitted', final: false, honestChainBeforeDeadline: true, broadcasts: 1, intentNonceUsed: false });
    });
});
