// A backward step of the system clock must not freeze the fee context.
//
// The fee engine caches the gas data it reads from the chain (src/fees/feeEngine.ts, RELAY_FEE_CACHE_MS, default
// 2 s), and the price source caches its reading (src/fees/priceSource.ts, RELAY_PRICE_CACHE_SECONDS). Measured on the
// wall clock, the age of a cached value would turn negative when the clock steps back by D, and the value would be
// served until the clock has caught up: for about D, quotes and the fee check of admission (pipeline step 5) would
// use the base fee read before the step, whatever the chain does meanwhile. During a gas rise the relay would then
// accept requests that do not cover the current price. Admission relies on that check: a request that passes it can
// be sent now, and only such a request may make a request held at its spend cap give way in a full queue. With a
// frozen fee context, a request that is held itself would take a held request's place (fee_too_low, final).
//
// So both cache ages are measured on the monotonic clock (monotonicMs in src/clock.ts), as the readiness cache is.
// The feed's staleness is still judged on the wall clock, against the feed's own timestamp.
//
// The tests read the fee context at a 30 gwei base fee, step the wall clock back one hour and raise the base fee to
// 600 gwei: a 0.01 USD request (MIN_FEE) covers break-even at 30 gwei, not at 600 gwei (0.0252 USD). Funds are not at
// risk either way: the spend cap bounds the relay's cost per request. The controls run the same sequences without a
// clock step. The harness's price source returns a fixed POL/USD price.
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { FeeResponse } from '@nimiq/gasless-sdk/relay';
import { RelayError } from '../../../src/errors.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { CONTRACT, USDC, buildTransfer, createHarness, type Harness } from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';
import { SPIKE, blocksAt, label } from '../helpers/gasSpike.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** The production fee cache (RELAY_FEE_CACHE_MS default 2000). */
async function harness(admission?: { maxQueued: number }): Promise<Harness> {
    h = await createHarness({ settings: { feeCacheMs: 2000, ...(admission ? { admission } : {}) } });
    await h.relay.txManager.recover();
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    h.chain.setAllowance(USDC, OTHER_ADDRESS, CONTRACT, 10n ** 12n);
    h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
    return h;
}

async function quote(): Promise<bigint> {
    const response = await h!.relay.app.inject({ method: 'GET', url: `/v1/fee?operation=transfer&token=${USDC}&authMode=none` });
    expect(response.statusCode, response.body).toBe(200);
    return BigInt((response.json() as FeeResponse).fee);
}

/**
 * A 0.01 USD transfer (MIN_FEE) of another sender: covers break-even at 30 gwei, not at 600 gwei (0.0252 USD). The
 * wallet's clock is right: its deadline is 10 minutes after the chain's time (the relay's wall clock is behind).
 */
async function minFeeTransfer(): Promise<{ answer: string; id: Hex }> {
    const deadline = h!.chain.head.timestamp + 600n;
    const t = await buildTransfer(h!, { key: OTHER_KEY, token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline });
    try {
        return { answer: String((await h!.relay.pipeline.submit(transferOperation, t.body)).statusCode), id: t.id };
    } catch (err) {
        if (!(err instanceof RelayError)) throw err;
        return { answer: err.code, id: t.id };
    }
}

/** The fee engine has read the chain at 30 gwei; then the wall clock steps back one hour (if `step`), and gas rises to 600 gwei. */
async function rise(step: boolean): Promise<{ before: bigint }> {
    const before = await quote();
    if (step) h!.clock.advance(-3600);
    await blocksAt(h!, 10, SPIKE); // 20 s pass: ten times the fee cache period
    return { before };
}

describe('the fee context and a backward clock step', () => {
    it('control: without a clock step, the quote follows the base fee within the cache period, and a 0.01 USD request is refused at 600 gwei', async () => {
        await harness();
        const { before } = await rise(false);
        expect(before).toBe(10_000n); // MIN_FEE at 30 gwei
        expect(await quote()).toBeGreaterThan(40_000n);
        expect((await minFeeTransfer()).answer).toBe('fee_too_low');
    });

    it('after the wall clock stepped back one hour, the quote and the fee check follow the base fee within the cache period', async () => {
        await harness();
        await rise(true);
        const facts = { quote: await quote(), transfer: (await minFeeTransfer()).answer };
        console.log('20 s after a one-hour backward step, at 600 gwei:', facts);
        // A fee context frozen at 30 gwei would quote MIN_FEE (10000) and accept the request, for about an hour.
        expect(facts.quote).toBeGreaterThan(40_000n);
        expect(facts.transfer).toBe('fee_too_low');
    });

    it('after a backward clock step, a request that cannot be sent does not take the place of a held request in a full queue', async () => {
        await harness({ maxQueued: 10 });
        const deadline = BigInt(h!.clock.seconds() + 7000);
        const held: Hex[] = [];
        for (let i = 0; i < 10; i++) held.push((await queue(h!, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id);
        // The ten are sent... unless gas rises first: it does, before the next pass.
        await rise(true);
        expect(h!.relay.txManager.heldInQueue()).toHaveLength(10);
        const newcomer = await minFeeTransfer();
        await blocksAt(h!, 1, SPIKE);
        const facts = {
            answer: newcomer.answer,
            newcomer: newcomer.answer === '202' ? label(h!, newcomer.id) : null,
            newcomerHeld: h!.relay.txManager.heldInQueue().some((r) => r.id.toLowerCase() === newcomer.id.toLowerCase()),
            gaveWay: held.filter((id) => label(h!, id) === 'failed/fee_too_low').length,
        };
        console.log('a full queue of held requests after the step:', facts);
        // With a stale fee check the new request would be accepted, a held request would give way to it, and it
        // would be held at its own cap.
        expect(facts.answer).toBe('fee_too_low');
        expect(facts.gaveWay).toBe(0);
    });
});

describe('control: a full queue of held requests without a clock step', () => {
    it('a 0.01 USD request is refused at 600 gwei and no held request gives way', async () => {
        await harness({ maxQueued: 10 });
        const deadline = BigInt(h!.clock.seconds() + 7000);
        const held: Hex[] = [];
        for (let i = 0; i < 10; i++) held.push((await queue(h!, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id);
        await rise(false);
        expect(h!.relay.txManager.heldInQueue()).toHaveLength(10);
        expect((await minFeeTransfer()).answer).toBe('fee_too_low');
        await tick(h!);
        expect(held.every((id) => label(h!, id) === 'queued')).toBe(true);
    });
});
