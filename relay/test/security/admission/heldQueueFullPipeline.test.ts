// Requests held by their spend cap must not take every place of RELAY_MAX_QUEUED while gas prices stay high. This file
// drives the pipeline and the transaction manager directly; heldQueueFullHttp.test.ts runs the scenario through the
// HTTP API with the defaults.
//
// While RELAY_MAX_QUEUED (default 100) requests are queued, a submission gets 503 unavailable
// (docs/STEP-1-GAS-ABSTRACTION.md §6.3, "Queue bound"). Requests held at their own spend cap are not work the relay
// should be moving: they make the relay `degraded` (held_at_cap), never unready. A held request stays queued until the
// base fee falls below its cap or its deadline passes (up to 2 hours), and it counts toward RELAY_MAX_QUEUED all that
// time. If the two rules were all there is:
// - a gas spike that prices out the queued requests would keep the queue full: every new submission, including one
//   whose fee covers the market and that the relay would broadcast in the same pass, would get 503 until the spike ends;
// - /readyz stays ready (degraded), so a load balancer would keep sending all traffic to a relay that refuses all of it;
// - one party with enough funded addresses could fill the places at MIN_FEE (0.01 USD each) when the base fee starts
//   to rise; held requests cost it nothing, and it chooses the deadline.
//
// So in a full queue, a new request that passed admission takes the place of the queued request held at its spend cap
// with the lowest cap (then the oldest). That request ends failed with fee_too_low, final at once (nothing of it was
// broadcast), in the same store transaction as the insert. Without a held request, a full queue answers 503 (the
// control test).
//
// The test uses RELAY_MAX_QUEUED = 10, ten senders with one request each, so that it stays short; the default 100
// behaves the same.
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { RelayError } from '../../../src/errors.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { GWEI } from '../../helpers/fakeChain.js';
import { CONTRACT, USDC, buildTransfer, createHarness, type Harness } from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** Ten requests at MIN_FEE, accepted while gas is cheap (30 gwei), deadline almost 2 hours ahead. */
async function fill(): Promise<Hex[]> {
    h = await createHarness({ settings: { readinessIncludesTxManager: true, admission: { maxQueued: 10 } } });
    await h.relay.txManager.recover();
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    const ids: Hex[] = [];
    for (let i = 0; i < 10; i++) ids.push((await queue(h, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) })).id);
    return ids;
}

/** Another sender pays for the spike: 0.20 USD covers break-even at 2000 gwei; its cap is far above the market. */
async function payerAnswer(): Promise<{ answer: string; id: Hex }> {
    h!.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
    const payer = await buildTransfer(h!, { key: OTHER_KEY, token: USDC, mode: 'permit', fee: 200_000n });
    try {
        return { answer: String((await h!.relay.pipeline.submit(transferOperation, payer.body)).statusCode), id: payer.id };
    } catch (err) {
        if (!(err instanceof RelayError)) throw err;
        return { answer: err.code, id: payer.id };
    }
}

describe('requests held by their spend cap take every place of RELAY_MAX_QUEUED', () => {
    it('control: a full queue that holds no request at its cap (no pass has checked it yet) answers 503 and ends nothing', async () => {
        const ids = await fill();
        const { answer } = await payerAnswer();
        expect(answer).toBe('unavailable');
        expect(ids.every((id) => h!.store.getRequest(id)!.status === 'queued')).toBe(true);
    });

    it('during a gas spike, a request that the relay could send at once is admitted in a queue full of held requests; the oldest held one gives way', async () => {
        const ids = await fill();
        // The base fee rises to 2000 gwei before they are sent: all ten are held (their cap is about 513 gwei per gas).
        for (let i = 0; i < 5; i++) {
            h!.chain.mine({ baseFee: 2000n * GWEI });
            h!.chain.finalized = h!.chain.head.number - 64n;
            h!.clock.advance(2);
            await tick(h!);
        }
        expect(h!.store.countByStatus('queued')).toBe(10);
        expect(h!.chain.broadcasts).toHaveLength(0);
        expect(h!.relay.txManager.heldInQueue()).toHaveLength(10);

        // Another sender pays for the spike: 0.20 USD covers break-even at 2000 gwei (0.10 USD for a USDC permit), and
        // its cap (2 POL over 250000 gas, about 8000 gwei per gas) is far above the market. The relay could send it now.
        const { answer, id } = await payerAnswer();
        h!.clock.advance(10); // past the readiness cache
        const readiness = await h!.relay.readiness();
        const facts = { answer, ready: readiness.ready, degraded: readiness.degraded };
        console.log('queue full of held requests:', facts, h!.relay.txManager.health());
        // An `unavailable` here would be a relay that reports ready and refuses all new work until the base fee falls
        // below the held requests' caps or they expire.
        expect(facts.answer).toBe('202');
        // All ten have the same cap: the oldest gave way, failed with fee_too_low; the queue is still at its bound.
        expect(h!.store.getRequest(ids[0]!)).toMatchObject({ status: 'failed', error: { code: 'fee_too_low' } });
        expect(ids.slice(1).every((other) => h!.store.getRequest(other)!.status === 'queued')).toBe(true);
        expect(h!.store.countByStatus('queued')).toBe(10);
        // The next pass sends the new request; the held ones stay queued.
        h!.chain.mine({ baseFee: 2000n * GWEI });
        h!.clock.advance(2);
        await tick(h!);
        expect(h!.store.getRequest(id)!.status).toBe('submitted');
        expect(h!.chain.broadcasts).toHaveLength(1);
    });
});
