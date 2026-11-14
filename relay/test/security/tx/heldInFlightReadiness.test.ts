// One request held in flight at its own spend cap does not take the relay out of readiness.
//
// A call whose next speed-up would exceed its spend cap is held: the same transaction stays in flight. It is cancelled
// with fee_too_low only when it holds up a request that could go (TxManager.othersWaiting). If such a hold counted as
// work that does not move, then after RELAY_STUCK_AFTER_BLOCKS (150 blocks by default, a few minutes on Polygon) with
// one priced-out request and no other traffic, /readyz would report the relay not ready. Behind a load balancer that
// routes on /readyz no new request would reach the relay any more, so nothing would ever wait behind the held request,
// it would never be cancelled, and the relay would stay out of rotation until that request's deadline (up to 2 hours).
//
// So health() reports `stalled` (unready) only when requests wait to be sent (queued and not held by their cap, or in
// flight and not held at it) and no relay transaction was broadcast, sped up or included for
// RELAY_STUCK_AFTER_BLOCKS. Requests held by their spend cap, queued or in flight, are reported as `held_at_cap` in
// health().degraded, which does not make the relay unready.
import { afterEach, describe, expect, it } from 'vitest';
import { GWEI } from '../../helpers/fakeChain.js';
import { createHarness, type Harness } from '../../helpers/harness.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('an in-flight request held at its spend cap keeps the relay ready', () => {
    it('a single priced-out request (no other traffic) is held at its cap while /readyz stays ready; held_at_cap is reported as degraded', async () => {
        h = await createHarness({ settings: { readinessIncludesTxManager: true } });
        await h.relay.txManager.recover();
        // A 0.01 USD fee (break-even at 30 gwei), deadline 2 hours ahead: accepted and broadcast at 90 gwei.
        const t = await queue(h, { fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        await tick(h);
        expect(stateOf(h, t.id).status).toBe('submitted');
        // Gas prices rise: base fee 600 gwei. The request's spend cap (0.1 POL / 195000 gas ≈ 513 gwei) is below
        // the market; the relay speeds up to the cap and then holds the transaction there.
        const readyBefore = (await h.relay.readiness()).ready;
        for (let i = 0; i < 200; i++) {
            h.chain.mine({ baseFee: 600n * GWEI });
            h.chain.finalized = h.chain.head.number - 64n;
            h.clock.advance(2);
            await tick(h);
        }
        const attempts = h.store.listAttempts(t.id);
        const facts = {
            status: stateOf(h, t.id).status,
            cancelled: attempts.some((a) => a.kind === 'cancel'),
            health: h.relay.txManager.health().reasons.map((r) => r.split(':')[0]),
        };
        h.clock.advance(10); // past the readiness cache
        const readyAfter = (await h.relay.readiness()).ready;
        // The hold is deliberate (it waits for the price to fall or for its deadline, like a queued request held
        // by its cap): readiness does not fail because of it.
        expect({ readyBefore, ...facts, readyAfter }).toEqual({ readyBefore: true, status: 'submitted', cancelled: false, health: [], readyAfter: true });
        expect(h.relay.txManager.health().degraded.map((d) => d.split(':')[0])).toEqual(['held_at_cap']);
    });
});
