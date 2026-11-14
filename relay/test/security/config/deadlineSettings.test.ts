// RELAY_DEADLINE_SAFETY_SECONDS must be smaller than RELAY_MIN_SECONDS_TO_BROADCAST.
//
// The transaction manager broadcasts a queued request only while
// head.timestamp + RELAY_MIN_SECONDS_TO_BROADCAST < deadline (TxManager.expireQueued expires it otherwise), and
// cancels an in-flight request once head.timestamp + RELAY_DEADLINE_SAFETY_SECONDS >= deadline
// (TxManager.processSubmitted). With the safety value above the broadcast window, a request whose deadline lies
// between the two would get a call and, at the next pass, a cancel: the relay would pay for the cancel (or the call)
// of a request it can expire in the queue at no cost, and the sender, who chooses the deadline, could make it do so
// for every request.
//
// loadConfig refuses such a configuration. The transaction manager, given such settings anyway, broadcasts only
// requests whose deadline is more than RELAY_DEADLINE_SAFETY_SECONDS ahead: it applies at least safety + 1 s as the
// minimum time to broadcast.
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { TEST_TX_SETTINGS, createHarness, type Harness } from '../../helpers/harness.js';
import { BASE_ENV, queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('the deadline settings are consistent', () => {
    it('RELAY_DEADLINE_SAFETY_SECONDS=120 with the default RELAY_MIN_SECONDS_TO_BROADCAST=10 is refused; given anyway, a 100 s deadline expires in the queue without a transaction', async () => {
        expect(() => loadConfig({ ...BASE_ENV, RELAY_DEADLINE_SAFETY_SECONDS: '120' })).toThrow(
            /RELAY_DEADLINE_SAFETY_SECONDS must be smaller than RELAY_MIN_SECONDS_TO_BROADCAST/,
        );
        // The same settings handed to the transaction manager without loadConfig.
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, deadlineSafetySeconds: 120, minSecondsToBroadcast: 10 } } });
        await h.relay.txManager.recover();
        const t = await queue(h, { deadline: BigInt(h.clock.seconds() + 100) });
        await tick(h);
        await tick(h);
        h.chain.mine();
        await tick(h);
        const kinds = h.store.listAttempts(t.id).map((a) => a.kind);
        // No transaction for a request the relay's own rules would cancel right away: it expires in the queue.
        expect({ kinds, status: stateOf(h, t.id).status }).toEqual({ kinds: [], status: 'expired' });
    });
});
