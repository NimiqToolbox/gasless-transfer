// The spend cap applies at the POL/USD price at which a call is signed.
//
// `gas limit × maxFeePerGas` of a call stays within RELAY_MAX_COST_PERCENT_OF_FEE (default 200 %) of the request's
// fee, converted at the POL/USD price of the moment the call is signed: at its first broadcast and at every speed-up.
// A held call and a pending call are re-sent unchanged, since re-sending a signed transaction does not change what
// it may cost. So when POL/USD rises by a factor k between the signature and the inclusion, the call may cost
// k × 200 % of the fee at the new price.
//
// This limit is deliberate. Cancelling held calls whenever the price rises would end every call held exactly at its
// cap at the next update of the feed (a rise of 0.5 % is enough), although it may still be included when the base
// fee falls. The exposure is bounded: a call lives at most until its deadline (at most 2 h ahead), so the relay pays
// at most 200 % of a fee of a few cents × the rise of POL/USD in that time (relay/docs/transaction-lifecycle.md, "Gas
// limit and spend cap").
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { feeInWei } from '../../../src/tx/policy.js';
import { GWEI } from '../../helpers/fakeChain.js';
import { CONTRACT, createHarness, type Harness } from '../../helpers/harness.js';
import { MutablePrice, queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('the spend cap applies at the POL/USD price when a call is signed', () => {
    it('every call is signed within 200 % of the fee; after POL/USD doubles the held call is re-sent unchanged, at most 400 % of the fee at the new price', async () => {
        const price = new MutablePrice(20_000_000n); // 0.20 USD per POL (8 decimals)
        h = await createHarness({ priceSource: () => price });
        await h.relay.txManager.recover();
        const fee = 10_000n; // 0.01 USD
        const t = await queue(h, { fee, deadline: BigInt(h.clock.seconds() + 3600) });
        // `chainlink` is the only kind of price source the relay knows.
        const capAt = (value: bigint) => (feeInWei(fee, { value, decimals: 8, source: 'chainlink', updatedAt: null, reason: null }) * 200n) / 100n;

        // Every call the relay sends (first broadcast, speed-up, re-broadcast), with the price when that transaction
        // was signed (its first broadcast) and the price at this broadcast.
        const signedAt = new Map<Hex, bigint>();
        const sent: Array<{ hash: Hex; first: boolean; costWei: bigint; capNow: bigint; capAtSigning: bigint; priceRatio: number }> = [];
        h.chain.broadcastHook = (raw) => {
            const tx = parseTransaction(raw);
            if (tx.to?.toLowerCase() !== CONTRACT.toLowerCase()) return;
            const hash = keccak256(raw);
            const first = !signedAt.has(hash);
            if (first) signedAt.set(hash, price.value);
            const signingPrice = signedAt.get(hash)!;
            sent.push({
                hash,
                first,
                costWei: tx.gas! * tx.maxFeePerGas!,
                capNow: capAt(price.value),
                capAtSigning: capAt(signingPrice),
                priceRatio: Number(price.value) / Number(signingPrice),
            });
        };

        await tick(h); // broadcast at 90 gwei
        // Gas rises (base fee 600 gwei): the call is sped up to its cap (≈ 513 gwei at 0.20 USD/POL) and held there.
        for (let i = 0; i < 12; i++) {
            h.chain.mine({ baseFee: 600n * GWEI });
            await tick(h);
        }
        // POL/USD doubles: the cap at the current price is half of what the pending call may cost.
        price.value = 40_000_000n;
        for (let i = 0; i < 12; i++) {
            h.chain.mine({ baseFee: 600n * GWEI });
            await tick(h);
        }
        expect(stateOf(h, t.id).status).toBe('submitted');
        // 1. Every transaction is signed within the cap at the price of that moment ...
        expect(sent.filter((s) => s.first && s.costWei > s.capNow)).toEqual([]);
        // 2. ... and never costs more than the cap at the price when it was signed.
        expect(sent.filter((s) => s.costWei > s.capAtSigning)).toEqual([]);
        // 3. A broadcast above the cap at the current price is a re-send of a transaction signed earlier, and its
        //    cost at the current price is at most 200 % of the fee × the rise of the price since its signature.
        const over = sent.filter((s) => s.costWei > s.capNow);
        expect(over.length).toBeGreaterThan(0); // the held call is re-sent after the rise
        expect(over.every((s) => !s.first)).toBe(true);
        for (const s of over) expect(Number((s.costWei * 200n) / s.capNow)).toBeLessThanOrEqual(200 * s.priceRatio);
    });
});
