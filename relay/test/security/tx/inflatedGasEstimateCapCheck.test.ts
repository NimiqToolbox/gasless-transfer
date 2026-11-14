// One failed gas estimate does not make the spend-cap pre-check hold requests that fit their spend cap.
//
// The relay checks the spend cap of a queued request without any RPC call, at a gas limit it already knows: the
// request's own last full check (`checkedGas` in src/tx/txManager.ts), or else the smallest gas limit estimated for
// its kind of call (`minGasByKind`: operation, authorization mode, token). Only a request that may fit is simulated
// and estimated again. Without an estimate, the gas limit of a call is the gas table entry (policy.callGasLimit), the
// largest value the relay would ever use. If that fallback became the known gas limit when eth_estimateGas fails once
// (a timeout, a 429) in the full check of a request that gas prices hold at that moment:
// - the request would be pre-checked at the table entry (250000 gas for a USDC permit here) instead of estimate + 30 %
//   (195000), held, and never checked in full again. It would stay queued while the base fee lies between the two
//   caps, up to its deadline (2 hours at most), although with its real gas limit it fits its cap and would be sent;
// - if that was the first full check of its kind since the relay started, the smallest gas limit of the kind would be
//   the table entry too: every other request of that kind not checked yet would be held by the pre-check in the same
//   way, for as long as none of them gets a full check.
//
// So only a successful estimate becomes the known gas limit of a request or of its kind. A request checked without an
// estimate is held by that check if its cap requires it at the table entry, but it has no known gas limit: it gets the
// full check again on its next turn, which estimates again. The control is the same request whose estimate works.
//
// Numbers: fee 0.01 USD at 0.20 USD/POL, spend cap 200 % = 0.1 POL: 400 gwei per gas at 250000 gas, 513 gwei at
// 195000 gas. Base fee 420 gwei + minimum tip 30 gwei = 450 gwei: held at 250000, sendable at 195000.
import { afterEach, describe, expect, it } from 'vitest';
import { GWEI } from '../../helpers/fakeChain.js';
import { USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const BASE_FEE = 420n * GWEI;
/** A request that was sent: in flight, or already included. */
const SENT = ['submitted', 'mined', 'confirmed'];

async function blocks(harness: Harness, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
        harness.chain.mine({ baseFee: BASE_FEE });
        await tick(harness);
    }
}

describe('one failed gas estimate does not make the spend-cap pre-check hold requests that fit their cap', () => {
    it('control: with a working estimate, a 0.01 USD USDC permit is sent at a 420 gwei base fee (it fits its cap)', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const t = await queue(h, { token: USDC, mode: 'permit', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        await blocks(h, 1);
        expect(h.store.getRequest(t.id)!.status).toBe('submitted');
        expect(h.store.listAttempts(t.id)[0]!.gasLimit).toBe(195_000n);
    });

    it('after one failed eth_estimateGas, the request is checked in full again and sent once estimates work (it fits its cap)', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        // Accepted while gas is cheap (0.01 USD is above break-even at 30 gwei).
        const t = await queue(h, { token: USDC, mode: 'permit', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        // The first full check happens at a 420 gwei base fee, and its eth_estimateGas times out.
        h.chain.failing.add('estimateGas');
        await blocks(h, 1);
        h.chain.failing.delete('estimateGas');
        expect(h.store.getRequest(t.id)!.status).toBe('queued'); // held at the gas table's 250000 gas
        let simulations = 0;
        const call = h.chain.call.bind(h.chain);
        h.chain.call = async (p) => {
            simulations += 1;
            return call(p);
        };
        // 100 blocks (200 s) at the same base fee, estimates working.
        await blocks(h, 100);
        const facts = { status: h.store.getRequest(t.id)!.status, simulations, degraded: h.relay.txManager.health().degraded.map((d) => d.split(':')[0]) };
        console.log('own request:', facts);
        // Checked again and sent at its estimated gas limit. Its call pays 513 gwei, above base fee + tip, so the fake
        // chain includes it in the next block: it is `mined` by the end.
        expect(SENT).toContain(facts.status);
        expect(facts.simulations).toBeGreaterThanOrEqual(1);
        expect(h.store.listAttempts(t.id)[0]!.gasLimit).toBe(195_000n);
    });

    it('a later request of the same kind that fits its cap is sent (the kind minimum is not the gas table entry)', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const first = await queue(h, { token: USDC, mode: 'permit', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        h.chain.failing.add('estimateGas');
        await blocks(h, 1);
        h.chain.failing.delete('estimateGas');
        expect(h.store.getRequest(first.id)!.status).toBe('queued');
        // Another sender's USDC permit with the same fee, accepted during a short dip of the base fee (like the first
        // one, it is above break-even at 30 gwei), and first seen by the transaction manager at 420 gwei. It has no
        // check of its own yet, and the first request's check without an estimate left no gas limit for the kind (the
        // gas table entry would hold it): it gets a full check of its own.
        h.chain.mine({ baseFee: 30n * GWEI });
        h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
        const second = await queue(h, { key: OTHER_KEY, token: USDC, mode: 'permit', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        await blocks(h, 50);
        const facts = { first: h.store.getRequest(first.id)!.status, second: h.store.getRequest(second.id)!.status };
        console.log('same kind:', facts);
        // Both are simulated, estimated and sent at the estimated gas limit (and mined in the fake chain's next block,
        // see above).
        expect(SENT).toContain(facts.first);
        expect(SENT).toContain(facts.second);
        expect(h.store.listAttempts(first.id)[0]!.gasLimit).toBe(195_000n);
        expect(h.store.listAttempts(second.id)[0]!.gasLimit).toBe(195_000n);
    });

    it('a check without an estimate still holds a request that its cap holds at the gas table entry, and its next check estimates again', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        // 600 gwei: above the cap at either gas limit (400 and 513 gwei per gas).
        const t = await queue(h, { token: USDC, mode: 'permit', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        h.chain.failing.add('estimateGas');
        h.chain.mine({ baseFee: 600n * GWEI });
        await tick(h);
        h.chain.failing.delete('estimateGas');
        expect(h.store.getRequest(t.id)!.status).toBe('queued');
        expect(h.relay.txManager.heldInQueue().map((r) => r.id)).toEqual([t.id]);
        let estimates = 0;
        const estimate = h.chain.estimateGas.bind(h.chain);
        h.chain.estimateGas = async (p) => {
            estimates += 1;
            return estimate(p);
        };
        // The next pass checks it in full (with an estimate), and it stays held; after that the pre-check holds it.
        h.chain.mine({ baseFee: 600n * GWEI });
        await tick(h);
        expect(estimates).toBe(1);
        for (let i = 0; i < 5; i++) {
            h.chain.mine({ baseFee: 600n * GWEI });
            await tick(h);
        }
        expect(estimates).toBe(1);
        expect(h.store.getRequest(t.id)!.status).toBe('queued');
        expect(h.chain.broadcasts).toHaveLength(0);
    });
});
