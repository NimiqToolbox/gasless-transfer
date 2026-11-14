// A price reading whose timestamp lies in the future must never be used or cached.
//
// The price source reads the Chainlink feed through every RPC and reuses an agreed reading while it is fresh. A lying
// RPC could report a round with a far-future updatedAt: such a reading would never look stale, so the price source
// would keep reusing it after the liar stopped answering. The price source rejects it instead, and a rejected reading
// makes pricing unavailable (PriceUnavailableError with the rejection reason) until every RPC reports a usable round.
import { describe, expect, it } from 'vitest';
import { CHAINLINK_POL_USD_POLYGON } from '@nimiq/gasless-sdk/core';
import type { ChainClient, ReadContractCall } from '../../../src/chain/types.js';
import { ChainlinkPriceSource, PRICE_MAX_FUTURE_SKEW_SECONDS, PriceUnavailableError, type PriceReading } from '../../../src/fees/priceSource.js';
import { FakeChain } from '../../helpers/fakeChain.js';
import { START_TIME, TestClock, testDeployment } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';

function setup() {
    const clock = new TestClock(START_TIME * 1000);
    const chain = new FakeChain({ deployment: testDeployment(), timestamp: START_TIME, relay: RELAY_ADDRESS });
    chain.feed = { address: CHAINLINK_POL_USD_POLYGON, decimals: 8, answer: 20_000_000n, updatedAt: BigInt(START_TIME - 60), description: 'POL / USD' };
    const source = new ChainlinkPriceSource({ chain, feed: CHAINLINK_POL_USD_POLYGON, clock, cacheMs: 0 });
    return { clock, chain, source };
}

/** Why the price source refused to price (PriceUnavailableError.reason); fails the test on a reading. */
async function rejection(reading: Promise<PriceReading>): Promise<string> {
    const outcome = await reading.then(
        (r) => r,
        (err: unknown) => err,
    );
    expect(outcome, 'a price was used').toBeInstanceOf(PriceUnavailableError);
    return (outcome as PriceUnavailableError).reason;
}

describe('future oracle timestamp cannot poison an agreed price', () => {
    // A round up to PRICE_MAX_FUTURE_SKEW_SECONDS (15 s) ahead of the wall clock is accepted (Polygon block timestamps
    // run ahead); the first value past that window is rejected.
    it.each([BigInt(START_TIME + PRICE_MAX_FUTURE_SKEW_SECONDS + 1), (1n << 256n) - 1n])('rejects future updatedAt=%s while accepting the exact present boundary', async (updatedAt) => {
        const { chain, source } = setup();
        chain.feed!.updatedAt = updatedAt;
        expect(await rejection(source.get())).toBe('future_timestamp');
        chain.feed!.updatedAt = BigInt(START_TIME);
        expect(await source.get()).toMatchObject({ source: 'chainlink', value: 20_000_000n });
    });

    it('one liar cannot inject an immortal timestamp into the highest agreeing price then silence itself', async () => {
        const { chain, clock, source } = setup();
        let down = false;
        const honestView = chain.rpcView();
        const liar: ChainClient = {
            ...honestView,
            readContract: <T,>(call: ReadContractCall): Promise<T> => {
                if (call.functionName !== 'latestRoundData') return honestView.readContract<T>(call);
                if (down) return Promise.reject(new Error('selectively silent price RPC'));
                // The price is 5 % higher (inside the agreement tolerance), and of agreeing readings the relay
                // uses the highest: without the timestamp check this reading, with its attacker-chosen timestamp,
                // would be the one kept.
                return Promise.resolve([1n, 21_000_000n, 0n, (1n << 256n) - 1n, 1n] as T);
            },
        };
        chain.rpcClients = () => [chain, liar];
        expect(await rejection(source.get())).toBe('future_timestamp');
        down = true;
        clock.advance(7200);
        chain.feed!.updatedAt = BigInt(clock.seconds());
        chain.feed!.answer = 40_000_000n;
        // Neither the liar's reading nor any earlier one is reused: the silent RPC makes pricing unavailable.
        expect(await rejection(source.get())).toBe('rpc_error');
        expect(source.last()).toBeUndefined();
    });

    it('does not reuse a previously valid agreed round after the wall clock moves before its timestamp', async () => {
        const { chain, clock, source } = setup();
        expect((await source.get()).source).toBe('chainlink');
        clock.advance(-120);
        chain.failing.add('read:latestRoundData');
        expect(await rejection(source.get())).toBe('rpc_error');
    });
});
