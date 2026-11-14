// While eth_estimateGas fails (an RPC that refuses or rate-limits it), a gas spike that holds every queued request
// does not make the relay unready.
//
// Only a successful estimate becomes the known gas limit of a request or of its kind of call (`checkedGas`,
// `minGasByKind` in src/tx/txManager.ts), so while estimates fail the relay learns none. If a request checked without
// an estimate counted as unknown, every pass would spend its budget of full checks (PREFLIGHTS_PER_SLOT ×
// RELAY_MAX_IN_FLIGHT = 8) on the same first requests and never reach the others. Those would count as work the relay
// should be moving, and after RELAY_STUCK_AFTER_BLOCKS (here its minimum, 10) without a broadcast health() would
// report `stalled` and /readyz would answer 503: a load balancer would take the relay out of rotation during the spike
// although it holds every queued request correctly at its spend cap.
//
// So a request whose last full check had no estimate is held at the gas table's entry, the gas limit the relay would
// send it with (TxManager.precheck: held, not estimated): it is neither sendable work nor waiting, and it can give way
// in a full queue. It gets its full check again in turn: TxManager.learnQueued checks such requests the longest since
// their last check first, with the rest of the pass's budget, so the budget reaches every request (here the twenty
// are known held after three passes).
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { CONTRACT, TEST_TX_SETTINGS, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { queue } from '../../helpers/txManagerDriver.js';
import { SPIKE, blocksAt, label } from '../helpers/gasSpike.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** Twenty 0.01 USD transfers (mode none) accepted at 30 gwei, then 30 blocks at 600 gwei: all of them are held at their caps. */
async function spike(estimates: boolean) {
    h = await createHarness({
        settings: {
            readinessIncludesTxManager: true,
            readinessCacheMs: 0,
            tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 },
            admission: { maxQueued: 100 },
        },
    });
    await h.relay.txManager.recover();
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    if (!estimates) h.chain.failing.add('estimateGas');
    const deadline = BigInt(h.clock.seconds() + 7000);
    const ids: Hex[] = [];
    for (let i = 0; i < 20; i++) ids.push((await queue(h, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id);
    await blocksAt(h, 30, SPIKE);
    const held = new Set(h.relay.txManager.heldInQueue().map((r) => r.id.toLowerCase()));
    return {
        statuses: [...new Set(ids.map((id) => label(h!, id)))],
        broadcasts: h.chain.broadcasts.length,
        knownHeld: ids.filter((id) => held.has(id.toLowerCase())).length,
        reasons: h.relay.txManager.health().reasons.map((r) => r.split(':')[0]),
        readyz: (await h.relay.app.inject({ method: 'GET', url: '/readyz' })).statusCode,
    };
}

describe('held requests while eth_estimateGas fails', () => {
    it('control: with working estimates, a spike holds all twenty queued requests, and the relay stays ready (degraded)', async () => {
        const facts = await spike(true);
        expect(facts).toEqual({ statuses: ['queued'], broadcasts: 0, knownHeld: 20, reasons: [], readyz: 200 });
    });

    it('while estimates fail, a spike that holds every queued request does not make the relay stalled', async () => {
        const facts = await spike(false);
        console.log('estimates failing during the spike:', facts);
        // All twenty are known held, not only the 8 that one pass's budget of full checks reaches.
        expect(facts).toEqual({ statuses: ['queued'], broadcasts: 0, knownHeld: 20, reasons: [], readyz: 200 });
    });
});
