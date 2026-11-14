// A queued request whose gas limit the relay does not know yet (after a restart, or the first request of a kind of
// call) counts neither as waiting nor as sendable during a gas spike, and the relay finds out soon whether it is held.
//
// The spend-cap pre-check knows an estimated gas limit only from memory (src/tx/txManager.ts): the request's own last
// full check (`checkedGas`) or the smallest estimate of its kind of call (`minGasByKind`: operation, authorization
// mode, token). After a restart both are empty, and the first request of another token or mode has none either. Only
// a full check (simulation and estimate) learns the gas limit. If such a request simply counted as "not held":
// - the relay would cancel the in-flight requests held at their spend cap (fee_too_low) "because others wait", for a
//   request that its own cap holds as well (0.01 USD at a 600 gwei base fee cannot be sent at any gas limit near the
//   estimate). Each cancelled user must sign again at spike prices, and the relay pays one cancel per request;
// - after a restart a full queue of held requests would contain no request the relay knows to be held, so a request
//   that pays the current price would get 503 until such cancels had freed a slot and a full check had run.
// Any restart during a spike (a deploy, a crash) would trigger it, and so would the first request of another token.
//
// So:
// - the pre-check uses the gas table's entry when no estimated gas limit is known; a request never checked that its cap
//   may hold there is `unknown`: not known to be held, and not waiting;
// - a queued request counts as waiting behind a held in-flight request only once its full check at the pass's head
//   shows that it could be sent (TxManager.queuedCanGo);
// - with the rest of each pass's budget of full checks, requests never checked are checked also while no slot is free
//   (TxManager.learnQueued). After a restart the first pass checks one request of each kind of call, and the pre-check
//   then knows the others.
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { RelayError } from '../../../src/errors.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { CONTRACT, USDC, USDT0, buildTransfer, createHarness, restartHarness, type Harness } from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';
import { counter } from '../helpers/relayObservations.js';
import { SPIKE, blocksAt, label } from '../helpers/gasSpike.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/**
 * Three 0.01 USD USDC transfers (mode none) sent at a 30 gwei base fee (three slots: RELAY_MAX_IN_FLIGHT 4, one
 * reserved), then `queued` more 0.01 USD transfers of `queuedToken` accepted while the slots are full; then 20 blocks
 * at 600 gwei, above the spend cap of every one of them: all are held.
 */
async function setup(o: { queued: number; queuedToken: Hex; admission?: { maxQueued: number } }) {
    h = await createHarness(o.admission ? { settings: { admission: o.admission } } : {});
    await h.relay.txManager.recover();
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    h.chain.setAllowance(USDT0, USER_ADDRESS, CONTRACT, 10n ** 12n);
    const deadline = BigInt(h.clock.seconds() + 7000);
    const inFlight: Hex[] = [];
    for (let i = 0; i < 3; i++) inFlight.push((await queue(h, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id);
    await tick(h);
    expect(inFlight.map((id) => label(h!, id))).toEqual(['submitted', 'submitted', 'submitted']);
    const queued: Hex[] = [];
    for (let i = 0; i < o.queued; i++) queued.push((await queue(h, { token: o.queuedToken, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id);
    await tick(h);
    await blocksAt(h, 20, SPIKE);
    return { inFlight, queued };
}

async function facts(inFlight: readonly Hex[], queued: readonly Hex[]) {
    return {
        inFlight: inFlight.map((id) => label(h!, id)),
        queued: [...new Set(queued.map((id) => label(h!, id)))],
        cancelledAtCap: await counter(h!, 'relay_spend_cap_holds_total', 'kind="cancel"'),
    };
}

/** A payer on another sender: 0.20 USD covers break-even at 600 gwei by far; the relay could send it at once. */
async function payer(): Promise<string> {
    h!.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
    const t = await buildTransfer(h!, { key: OTHER_KEY, token: USDC, mode: 'permit', fee: 200_000n });
    try {
        return String((await h!.relay.pipeline.submit(transferOperation, t.body)).statusCode);
    } catch (err) {
        if (!(err instanceof RelayError)) throw err;
        return err.code;
    }
}

describe('a queued request whose gas limit is not known yet during a spike', () => {
    it('control: without a restart, a queued request of a kind whose gas limit is known (it arrived while the slots were full) is held, and nobody is cancelled', async () => {
        const { inFlight, queued } = await setup({ queued: 1, queuedToken: USDC });
        await blocksAt(h!, 80, SPIKE);
        expect(h!.relay.txManager.heldInQueue().map((r) => r.id.toLowerCase())).toEqual(queued.map((id) => id.toLowerCase()));
        expect(await facts(inFlight, queued)).toEqual({ inFlight: ['submitted', 'submitted', 'submitted'], queued: ['queued'], cancelledAtCap: 0 });
    });

    it('control: without a restart, a full queue of held requests lets a request that pays the current price in at once', async () => {
        await setup({ queued: 10, queuedToken: USDC, admission: { maxQueued: 10 } });
        expect(h!.relay.txManager.heldInQueue()).toHaveLength(10);
        expect(await payer()).toBe('202');
    });

    it('a restart during the spike does not make the relay cancel the held in-flight requests for a queued request that is held too', async () => {
        const { inFlight, queued } = await setup({ queued: 1, queuedToken: USDC });
        expect(await facts(inFlight, queued)).toEqual({ inFlight: ['submitted', 'submitted', 'submitted'], queued: ['queued'], cancelledAtCap: 0 });
        h = await restartHarness(h!);
        await h.relay.txManager.recover();
        await blocksAt(h, 80, SPIKE);
        const after = await facts(inFlight, queued);
        console.log('after a restart during the spike:', after);
        // The queued request has no known gas limit after the restart. It does not count as waiting for that, also
        // while the slots are full and it cannot be sent.
        expect(after).toEqual({ inFlight: ['submitted', 'submitted', 'submitted'], queued: ['queued'], cancelledAtCap: 0 });
    });

    it('the first request of another kind (USDT0, never estimated), accepted while the slots were full, does not make the relay cancel the held in-flight requests', async () => {
        const { inFlight, queued } = await setup({ queued: 1, queuedToken: USDT0 });
        await blocksAt(h!, 80, SPIKE);
        const after = await facts(inFlight, queued);
        console.log('a queued request of a kind never estimated:', after);
        // The 0.01 USD USDT0 request is held by its own cap at any gas limit near its estimate (it stays queued): the
        // three held USDC requests are not cancelled for it.
        expect(after).toEqual({ inFlight: ['submitted', 'submitted', 'submitted'], queued: ['queued'], cancelledAtCap: 0 });
    });

    it('after a restart during the spike, a full queue of held requests lets a request that pays the current price in within two passes, and nobody in flight is cancelled', async () => {
        const { inFlight, queued } = await setup({ queued: 10, queuedToken: USDC, admission: { maxQueued: 10 } });
        // Before the restart the relay knows that all ten are held: a payer would take the place of one of them.
        expect(h!.relay.txManager.heldInQueue()).toHaveLength(10);
        h = await restartHarness(h!, { settings: { admission: { maxQueued: 10 } } });
        await h.relay.txManager.recover();
        const answers: string[] = [];
        for (let pass = 0; pass < 20; pass++) {
            await blocksAt(h, 1, SPIKE);
            const answer = await payer();
            answers.push(answer);
            if (answer === '202') break;
        }
        const after = { answers, ...(await facts(inFlight, queued)) };
        console.log('a full queue of held requests after a restart:', after);
        // The first passes after the restart find the queued requests held without a free slot, so the payer takes the
        // place of one of them within two passes: it does not wait (503 `unavailable`) for a slot that only cancelling
        // the held in-flight requests would free.
        expect(answers.length, answers.join(',')).toBeLessThanOrEqual(2);
        expect(answers.at(-1)).toBe('202');
        expect(after.inFlight).toEqual(['submitted', 'submitted', 'submitted']);
        expect(after.cancelledAtCap).toBe(0);
    });
});
