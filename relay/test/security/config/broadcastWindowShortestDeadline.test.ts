// RELAY_MIN_SECONDS_TO_BROADCAST must fit below the shortest deadline the relay accepts.
//
// A transfer is accepted while `now + 60 ≤ deadline ≤ now + 7200` (spec §6.3 step 2, MIN_DEADLINE_SECONDS). A queued
// request whose deadline is closer than RELAY_MIN_SECONDS_TO_BROADCAST is not sent: it expires at the transaction
// manager's next pass (TxManager.expireQueued), `expired` with deadline_out_of_range. With a window of 60 s or more
// the relay would answer 202 to requests that it then lets expire in the queue without a broadcast, and the sender
// would have to wait out the deadline before signing again.
//
// loadConfig refuses a value that does not fit, and the error names the variable, so the relay does not start with
// such a window. The bound is the one broadcastWindowPollMargin.test.ts explains: the window, RELAY_POLL_INTERVAL_MS
// and 10 s fit into the 60 s (48 with the default 2 s poll interval). The test also hands the refused value to the
// transaction manager directly, to show what it would do.
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { TEST_TX_SETTINGS, createHarness, type Harness } from '../../helpers/harness.js';
import { BASE_ENV, queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('RELAY_MIN_SECONDS_TO_BROADCAST is checked against the shortest accepted deadline', () => {
    it('a value that does not fit below the 60 s minimum deadline (with the poll interval and 10 s) is refused at startup, naming the variable (what it would do: accepted requests expire unsent)', async () => {
        let configError: string | undefined;
        try {
            loadConfig({ ...BASE_ENV, RELAY_MIN_SECONDS_TO_BROADCAST: '600' });
        } catch (err) {
            configError = err instanceof Error ? err.message : String(err);
        }
        // What that setting does: a request with a 300 s deadline is accepted and expires without being sent.
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, minSecondsToBroadcast: 600 } } });
        await h.relay.txManager.recover();
        const t = await queue(h, { deadline: BigInt(h.clock.seconds() + 300) });
        await tick(h);
        const state = stateOf(h, t.id);
        const facts = { configRefused: configError !== undefined, accepted: true, status: state.status, code: state.error?.code ?? null, broadcasts: h.chain.broadcasts.length };
        // The setting must not let an accepted request expire unsent: the configuration refuses it.
        expect(facts.configRefused || facts.status !== 'expired').toBe(true);
        expect(configError).toMatch(/^RELAY_MIN_SECONDS_TO_BROADCAST must be at most 48 with RELAY_POLL_INTERVAL_MS=2000/);
        // The boundary with the default 2 s poll interval: 48 s is accepted, 49 s is not.
        expect(loadConfig({ ...BASE_ENV, RELAY_MIN_SECONDS_TO_BROADCAST: '48' }).tx.minSecondsToBroadcast).toBe(48);
        expect(() => loadConfig({ ...BASE_ENV, RELAY_MIN_SECONDS_TO_BROADCAST: '49' })).toThrow(/^RELAY_MIN_SECONDS_TO_BROADCAST must be at most 48/);
    });
});
