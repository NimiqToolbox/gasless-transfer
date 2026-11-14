// RELAY_MIN_SECONDS_TO_BROADCAST must leave room for the time between the acceptance of a request and the relay's
// first pass after it.
//
// Acceptance compares the deadline with the relay's clock (now + 60 <= deadline: 60 s is the shortest deadline the
// relay accepts). The transaction manager compares it with the chain's time at its next pass (TxManager.expireQueued:
// a queued request expires once head.timestamp + RELAY_MIN_SECONDS_TO_BROADCAST >= deadline). Between the two lie the
// wait for that pass (RELAY_POLL_INTERVAL_MS, 2 s by default) and at least one new block. A window that merely stays
// below 60 s lets a request with the shortest deadline expire unsent as soon as the head of the next pass is a
// second newer than the acceptance: the wallet gets 202, then `expired` with deadline_out_of_range, and must wait
// out the deadline before it may sign again.
//
// So loadConfig requires the window, the poll interval (in seconds, rounded up) and a 10 s margin to fit into the
// 60 s (config.ts, maxMinSecondsToBroadcast: at most 48 with the default poll interval), and refuses larger values
// at startup, naming the variable. With the largest accepted value a request with a 60 s deadline is broadcast at
// the first pass after its acceptance, a block later and also 11 s later.
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { TEST_TX_SETTINGS, createHarness, type Harness } from '../../helpers/harness.js';
import { BASE_ENV, queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/**
 * A request with the shortest deadline the relay accepts (60 s); the relay's next pass comes `later` seconds after the
 * acceptance, on a block made at that time (by default one block, 2 s, later).
 */
async function shortestDeadline(minSecondsToBroadcast: number, later = 2) {
    // The value passes the configuration check (with the default 2 s poll interval).
    expect(loadConfig({ ...BASE_ENV, RELAY_MIN_SECONDS_TO_BROADCAST: String(minSecondsToBroadcast) }).tx.minSecondsToBroadcast).toBe(minSecondsToBroadcast);
    h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, minSecondsToBroadcast } } });
    await h.relay.txManager.recover();
    const t = await queue(h, { deadline: BigInt(h.clock.seconds() + 60) }); // 202: accepted
    h.clock.advance(later);
    h.chain.mine({ timestampDelta: later }); // the next block, before the next pass
    await tick(h);
    const state = stateOf(h, t.id);
    return { accepted: true, status: state.status, code: state.error?.code ?? null, broadcasts: h.chain.broadcasts.length };
}

describe('every RELAY_MIN_SECONDS_TO_BROADCAST the relay accepts still broadcasts a request with the shortest deadline at the next pass', () => {
    it('RELAY_MIN_SECONDS_TO_BROADCAST=59 is refused at startup, naming the variable (it leaves no room for the poll interval and a block)', () => {
        // With 59, a request with a 60 s deadline would have one second: it would expire unsent at the next pass.
        expect(() => loadConfig({ ...BASE_ENV, RELAY_MIN_SECONDS_TO_BROADCAST: '59' })).toThrow(
            /^RELAY_MIN_SECONDS_TO_BROADCAST must be at most 48 with RELAY_POLL_INTERVAL_MS=2000: the relay accepts deadlines from 60 s ahead/,
        );
        expect(() => loadConfig({ ...BASE_ENV, RELAY_MIN_SECONDS_TO_BROADCAST: '49' })).toThrow(/^RELAY_MIN_SECONDS_TO_BROADCAST must be at most 48/);
    });

    it('with the largest accepted value (48 with 2 s passes), a request with a 60 s deadline is broadcast at the next pass, a block after its acceptance', async () => {
        expect(await shortestDeadline(48)).toEqual({ accepted: true, status: 'submitted', code: null, broadcasts: 1 });
    });

    it('with 48, the request is still broadcast when the next pass comes 11 s after the acceptance (the poll interval and the 10 s margin)', async () => {
        expect(await shortestDeadline(48, 11)).toEqual({ accepted: true, status: 'submitted', code: null, broadcasts: 1 });
    });
});

describe('control: the default RELAY_MIN_SECONDS_TO_BROADCAST', () => {
    it('control: with 10 s (the default), the same request is broadcast at the next pass', async () => {
        expect(await shortestDeadline(10)).toEqual({ accepted: true, status: 'submitted', code: null, broadcasts: 1 });
    });
});
