// The cost of a pass does not grow with the number of queued requests that their spend cap holds back, a number
// that senders can inflate cheaply.
//
// Held requests stay queued until the price falls or their deadline (up to 2 hours), and they use no in-flight slot.
// Senders who submit many break-even requests while gas is cheap get all of them held once gas prices rise (the cap
// is 2 × the break-even price per gas). If every pass gave each held request the full check (eth_call pinned to the
// head, eth_getCode for USDC permits, eth_estimateGas pinned to the head), it would make two or three sequential RPC
// round trips per held request: a few hundred of them would make a pass longer than the 60 s liveness limit (health
// `pass_stale`, /readyz fails), and every in-flight request's speed-up, re-broadcast and deadline cancel would wait
// that long.
//
// So the spend cap is checked first, without any RPC call, at a gas limit the relay already knows (the request's own
// last check, or the smallest gas limit it estimated for the same kind of call); only a request that may fit its cap
// is simulated, and at most PREFLIGHTS_PER_SLOT × RELAY_MAX_IN_FLIGHT requests get the full check per pass.
import { afterEach, describe, expect, it } from 'vitest';
import { GWEI } from '../../helpers/fakeChain.js';
import { CONTRACT, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('the cost of a pass does not grow with the requests held by their spend cap', () => {
    it('40 NONE requests at MIN_FEE, held after gas rises, are not re-simulated on every pass', async () => {
        // Admission allows one pending request per sender (sequential intent nonces) and 100 queued in
        // total: 40 senders here (queue picks further senders with USER's allowance).
        h = await createHarness();
        await h.relay.txManager.recover();
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        // Every request pays MIN_FEE (0.01 USD), the lowest fee admission accepts.
        const N = 40;
        for (let i = 0; i < N; i++) await queue(h, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        // Gas rises before the first broadcast: base fee 2000 gwei, far above what 0.01 covers (the spend cap, 200 % of the
        // fee at 0.20 USD/POL, is 0.1 POL: at most 500 gwei per gas at the table's gas limit of 200000).
        h.chain.mine({ baseFee: 2000n * GWEI });
        let simulations = 0;
        let estimates = 0;
        const call = h.chain.call.bind(h.chain);
        const estimateGas = h.chain.estimateGas.bind(h.chain);
        h.chain.call = async (p) => {
            simulations += 1;
            return call(p);
        };
        h.chain.estimateGas = async (p) => {
            estimates += 1;
            return estimateGas(p);
        };
        const perPass: Array<{ simulations: number; estimates: number }> = [];
        for (let pass = 0; pass < 3; pass++) {
            simulations = 0;
            estimates = 0;
            h.chain.mine({ baseFee: 2000n * GWEI });
            await tick(h);
            perPass.push({ simulations, estimates });
        }
        expect(h.store.countByStatus('queued')).toBe(N); // all held, none broadcast
        expect(h.chain.broadcasts).toHaveLength(0);
        // A held request is not re-simulated on every pass: the cost of a pass does not grow with the number of
        // held requests. A full check of each would be N eth_call and N eth_estimateGas per pass (80 for N = 40).
        const worstPass = Math.max(...perPass.map((p) => p.simulations + p.estimates));
        expect(worstPass).toBeLessThanOrEqual(4);
        expect(perPass.at(-1)).toEqual({ simulations: 0, estimates: 0 });
    });
});
