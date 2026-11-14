// A backward step of the system clock must not freeze what /readyz answers.
//
// Readiness depends on two intervals: the age of the cached report (src/http/readiness.ts cachedReadiness, 5 s by
// default) and the time since the transaction manager's last successful pass (checkReadiness `fresh`, and health()
// `no_pass` / `pass_stale` in src/tx/txManager.ts: at most max(60 s, 10 x poll interval)). Measured on the wall
// clock, both would turn negative when the clock steps back by D, and stay so until the clock has caught up: for
// about D a relay that is not ready would stay out of rotation although it works again, and a relay whose
// transaction manager stopped making passes would keep answering "ready". So both are measured on the monotonic
// clock (src/clock.ts monotonicMs: performance.now in production); the wall-clock time of the last pass is only
// displayed.
//
// The clock steps back when it was ahead and is corrected by stepping: the first NTP synchronization after boot (a
// container with a restart policy starts with the Docker daemon, which need not wait for time synchronization), a
// hardware clock kept in local time instead of UTC, or a manual correction.
//
// The test clock (TestClock in the test harness) models the step: `advance(-3600)` moves the wall clock back one
// hour while the monotonic clock stays where it is; a positive advance moves both. The control tests run the same
// sequences without a clock step.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../helpers/harness.js';

let h: Harness;

beforeEach(async () => {
    // Production readiness: the transaction manager is included, reports are cached 5 s (the default).
    h = await createHarness({ settings: { readinessIncludesTxManager: true, readinessCacheMs: 5000 } });
});

afterEach(async () => {
    await h.close();
});

const readyz = async (): Promise<number> => (await h.relay.app.inject({ method: 'GET', url: '/readyz' })).statusCode;

/** Startup recovery and one successful pass. */
async function pass(): Promise<void> {
    await h.relay.txManager.recover();
    await h.relay.txManager.tick();
    expect(h.relay.txManager.lastTickError).toBeUndefined();
}

describe('control: the same sequences without a clock step', () => {
    it('a cached "not ready" is replaced by "ready" once the cache period (5 s) has passed', async () => {
        expect(await readyz()).toBe(503); // no pass yet
        await pass();
        expect(await readyz()).toBe(503); // cached
        h.clock.advance(6);
        expect(await readyz()).toBe(200);
    });

    it('a transaction manager without a pass for 2 minutes makes /readyz answer 503', async () => {
        await pass();
        expect(await readyz()).toBe(200);
        h.clock.advance(120); // no pass
        expect(await readyz()).toBe(503);
    });

    it('control: a step of the wall clock alone, with no time passing, does not age the last pass', async () => {
        await pass();
        h.clock.advance(-3600); // the wall clock steps back one hour; no time passes
        expect(h.relay.txManager.status().lastPassAgeMs).toBe(0);
        expect(h.relay.txManager.health().ok).toBe(true);
        expect(await readyz()).toBe(200);
    });
});

describe('readiness and a clock step', () => {
    it('after the clock steps back one hour, /readyz answers 200 within the cache period once the relay has recovered', async () => {
        expect(await readyz()).toBe(503); // no pass yet: cached
        h.clock.advance(-3600); // the system clock steps back one hour
        await pass();
        h.clock.advance(6);
        const served = await readyz();
        const health = h.relay.txManager.health();
        console.log(`recovered: /readyz ${served} 6 s after a successful pass; transaction manager health ok=${health.ok}`);
        expect(health.ok).toBe(true);
        expect(served, '/readyz 6 s after the relay became ready, the clock having stepped back 3600 s').toBe(200);
    });

    it('after the clock steps back one hour, /readyz answers 503 when the transaction manager has made no pass for 2 minutes', async () => {
        await pass();
        expect(await readyz()).toBe(200);
        h.clock.advance(-3600); // the system clock steps back one hour
        h.clock.advance(120); // no pass
        const served = await readyz();
        const health = h.relay.txManager.health();
        console.log(`stalled: /readyz ${served} after 2 minutes without a pass; transaction manager health reasons=${JSON.stringify(health.reasons)}`);
        expect(served, '/readyz 2 minutes after the last pass, the clock having stepped back 3600 s').toBe(503);
        expect(health.reasons).toEqual([expect.stringMatching(/^pass_stale: the last successful pass was 120 s ago/)]);
    });
});
