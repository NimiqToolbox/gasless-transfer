// A block number that one RPC gives for its NonceInvalidated log decides for that RPC only.
//
// Scenario: a transaction outside the relay takes the relay's tx nonce (the relay key used elsewhere) and the sender
// invalidates the intent nonce, so the request fails with nonce_used once every RPC shows the invalidation. The second
// RPC answers from the chain's true state, but for a while it gives every log a block a million blocks ahead; then it
// answers honestly.
//
// Expected: finality is measured on each RPC against its own head and its own finalized tag. A log outside the block
// that used the nonce is no evidence, so while the RPC lies the failure is not even provisional. Each RPC settles the
// outcome on its own numbers only (TxManager.foreignFinalOn: its observation of the used tx nonce and its own log
// block, the block that used the nonce on that RPC, see quorum.findNonceUse), so the failure settles and the secrets
// are purged once every RPC shows it final by its own view. A number that an RPC once gave must not keep a final
// outcome unsettled for good: its secrets would never be purged, and nothing would alert.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChainClient, ChainLog, LogFilter } from '../../../src/chain/types.js';
import { createHarness, type Harness } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { drive } from '../helpers/finalizedChain.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/**
 * RELAY_RPC_URLS=<honest>,<second>. The second RPC answers from the chain's true state, but while `forging` it gives
 * every log `lead` blocks later than it is.
 */
async function invalidatedWithLogShift(lead: bigint) {
    h = await createHarness();
    await h.relay.txManager.recover();
    const x = h;
    const view = x.chain.rpcView();
    const liar = { forging: true };
    const second: ChainClient = {
        ...view,
        getLogs: async (filter: LogFilter): Promise<readonly ChainLog[]> => {
            const logs = await view.getLogs!(filter);
            return liar.forging ? logs.map((l) => ({ ...l, blockNumber: l.blockNumber + lead })) : logs;
        },
    };
    x.chain.rpcClients = () => [x.chain, second];
    const t = await queue(x);
    await tick(x);
    x.chain.consumeNonce(RELAY_ADDRESS, 0); // a transaction outside the relay takes its tx nonce
    x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n); // and the sender burns the intent nonce
    await drive(x, 14); // the grace period, then the search on every RPC
    // An out-of-range/noncanonical log is no evidence of invalidation. It cannot decide even a provisional failure.
    if (lead === 0n) expect(stateOf(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
    else expect(stateOf(x, t.id)).toMatchObject({ status: 'submitted' });
    liar.forging = false; // every RPC answers honestly from now on
    await drive(x, 60); // far beyond the finality of the invalidation and of every observation
    const record = x.store.getRequest(t.id)!;
    return { status: record.status, settled: record.settledAtMs !== null, secretsPurged: record.signature === null };
}

describe('a block number one RPC gave for its NonceInvalidated log does not gate the settlement (each RPC settles on its own numbers)', () => {
    it('the nonce_used failure settles (secrets purged) once every RPC shows it final, although the second RPC once gave its log a block far ahead', async () => {
        const facts = await invalidatedWithLogShift(1_000_000n);
        expect(facts).toEqual({ status: 'failed', settled: true, secretsPurged: true });
    });
});

describe('control: the second RPC gives the real block', () => {
    it('control: the nonce_used failure settles and the secrets are purged', async () => {
        expect(await invalidatedWithLogShift(0n)).toEqual({ status: 'failed', settled: true, secretsPurged: true });
    });
});
