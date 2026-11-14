// During a gas spike the relay does not cancel in-flight requests held at their spend cap for requests that could not
// be sent either, because their own caps hold them as well.
//
// A request whose next speed-up would exceed its spend cap is held. It is cancelled with fee_too_low only to unblock
// work that can actually proceed, so that one underpriced request does not hold the queue back until its deadline
// (relay/docs/transaction-lifecycle.md, "Gas limit and spend cap" and "Queue displacement and cancellation"). Most
// requests pay the same fee (quotes are MIN_FEE, 0.01 USD, unless gas is expensive), so a spike above their common cap
// holds all of them at once. Cancelling them for each other would help nobody: each cancelled user gets `failed` /
// fee_too_low and must sign again at spike prices, where the held call would have been included once the spike passed
// (spikes last minutes; deadlines allow up to 2 hours), and the relay pays one cancel per request at spike prices.
//
// So "others wait" (TxManager.othersWaiting) counts only requests that could be sent if the held request's tx nonce
// were free: an in-flight request whose call pays the cheapest includable fee (base fee + RELAY_MIN_TIP_GWEI) or whose
// cap allows a speed-up to it, and a queued request that passes its full check and fits its spend cap. The spend-cap
// pre-check (TxManager.precheckQueued) runs for every queued request at the start of every pass, also beyond the free
// in-flight slots and without any RPC call, so a request that arrived while every slot was taken is known to be held
// too. A spike that holds every request holds all of them, and nobody is cancelled. In the control the request behind
// pays enough to be included: there the cancel is right.
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { GWEI } from '../../helpers/fakeChain.js';
import { CONTRACT, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { counter } from '../helpers/relayObservations.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/**
 * Requests with the given fees (USD × 10^6), sent at a 30 gwei base fee (three slots: RELAY_MAX_IN_FLIGHT 4, one
 * reserved), optionally one more accepted while the slots are full; then 80 blocks at a 600 gwei base fee, above the
 * spend cap of a 0.01 USD fee (0.1 POL over 195000 gas, about 513 gwei per gas).
 */
async function spike(fees: bigint[], extraQueued: boolean) {
    h = await createHarness();
    await h.relay.txManager.recover();
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    const deadline = BigInt(h.clock.seconds() + 7000);
    const inFlight: Hex[] = [];
    for (const fee of fees) inFlight.push((await queue(h, { token: USDC, mode: 'none', amount: 1n, fee, deadline })).id);
    await tick(h);
    expect(inFlight.map((id) => stateOf(h!, id).status).every((s) => s === 'submitted')).toBe(true);
    const queued = extraQueued ? (await queue(h, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id : undefined;
    await tick(h);
    for (let i = 0; i < 80; i++) {
        h.chain.mine({ baseFee: 600n * GWEI });
        h.chain.finalized = h.chain.head.number - 64n;
        h.clock.advance(2);
        await tick(h);
    }
    const label = (id: Hex) => {
        const s = stateOf(h!, id);
        return s.error ? `${s.status}/${s.error.code}` : s.status;
    };
    return {
        inFlight: inFlight.map(label),
        queued: queued ? label(queued) : null,
        cancelledAtCap: await counter(h, 'relay_spend_cap_holds_total', 'kind="cancel"'),
    };
}

describe('held requests are not cancelled for requests that are held as well', () => {
    it('control: a 0.01 USD request held at its cap in front of a 0.50 USD request that fits the market is cancelled, and the other one is mined', async () => {
        const facts = await spike([10_000n, 500_000n], false);
        expect(facts).toEqual({ inFlight: ['failed/fee_too_low', 'mined'], queued: null, cancelledAtCap: 1 });
    });

    it('three in-flight 0.01 USD requests held at their caps are not cancelled for each other', async () => {
        const facts = await spike([10_000n, 10_000n, 10_000n], false);
        console.log('three held in flight:', facts);
        expect(facts).toEqual({ inFlight: ['submitted', 'submitted', 'submitted'], queued: null, cancelledAtCap: 0 });
    });

    it('a queued 0.01 USD request that its own cap holds (the slots were full when it arrived) does not make the relay cancel the held ones', async () => {
        const facts = await spike([10_000n, 10_000n, 10_000n], true);
        console.log('three held in flight and one queued:', facts);
        expect(facts).toEqual({ inFlight: ['submitted', 'submitted', 'submitted'], queued: 'queued', cancelledAtCap: 0 });
    });
});
