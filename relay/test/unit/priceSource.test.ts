import { describe, expect, it } from 'vitest';
import { CHAINLINK_POL_USD_POLYGON } from '@nimiq/gasless-sdk/core';
import type { ChainClient } from '../../src/chain/types.js';
import { loadConfig } from '../../src/config.js';
import { ChainlinkPriceSource, PRICE_MAX_FUTURE_SKEW_SECONDS, PRICE_RETRY_MS } from '../../src/fees/priceSource.js';
import { createPriceSource } from '../../src/relay.js';
import { createMetrics } from '../../src/metrics.js';
import { START_TIME, TestClock } from '../helpers/harness.js';

function rpc() {
    const state = { answer: 20_000_000n, updatedAt: BigInt(START_TIME), decimals: 8, down: false, decimalsReads: 0, roundReads: 0 };
    const chain = {
        async readContract({ functionName }: { functionName: string }) {
            if (state.down) throw new Error('unavailable');
            if (functionName === 'decimals') {
                state.decimalsReads += 1;
                return state.decimals;
            }
            state.roundReads += 1;
            return [1n, state.answer, state.updatedAt, state.updatedAt, 1n];
        },
    } as unknown as ChainClient;
    return { state, chain };
}

function fixture(cacheMs = 0) {
    const a = rpc();
    const b = rpc();
    const clock = new TestClock(START_TIME * 1000);
    const metrics = createMetrics();
    const chain = { rpcClients: () => [a.chain, b.chain] } as unknown as ChainClient;
    const source = new ChainlinkPriceSource({ chain, feed: CHAINLINK_POL_USD_POLYGON, clock, cacheMs, metrics });
    return { a, b, clock, metrics, source, chain };
}

describe('mandatory Chainlink pricing', () => {
    it('uses the highest validated price when all providers agree', async () => {
        const h = fixture();
        h.b.state.answer = 21_000_000n;
        expect(await h.source.get()).toMatchObject({ source: 'chainlink', value: 21_000_000n, updatedAt: START_TIME });
    });

    it.each([
        ['stale', { updatedAt: BigInt(START_TIME - 3601) }],
        ['stale', { updatedAt: 0n }],
        ['future_timestamp', { updatedAt: BigInt(START_TIME + PRICE_MAX_FUTURE_SKEW_SECONDS + 1) }],
        ['future_timestamp', { updatedAt: 2n ** 255n }],
        ['non_positive', { answer: 0n }],
        ['non_positive', { answer: -1n }],
        ['out_of_bounds', { answer: 999_999n }],
        ['out_of_bounds', { answer: 1_000_000_001n }],
        ['bad_decimals', { decimals: 19 }],
        ['rpc_error', { down: true }],
    ])('rejects %s without substituting a price', async (reason, change) => {
        const h = fixture();
        Object.assign(h.a.state, change);
        await expect(h.source.get()).rejects.toMatchObject({ name: 'PriceUnavailableError', reason });
        expect(h.source.last()).toBeUndefined();
        expect(await h.metrics.registry.metrics()).toContain(`relay_price_unavailable_total{reason="${reason}"} 1`);
    });

    it('rejects disagreement and recovers when the providers agree again', async () => {
        const h = fixture();
        await h.source.get();
        h.b.state.answer = 23_000_000n;
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'rpc_disagreement' });
        expect(h.source.last()).toBeUndefined();
        h.b.state.answer = 20_000_000n;
        expect((await h.source.get()).value).toBe(20_000_000n);
    });

    it('does not reuse a previous price when a refresh loses one provider', async () => {
        const h = fixture();
        await h.source.get();
        h.b.state.down = true;
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'rpc_error' });
        expect(h.source.last()).toBeUndefined();
    });

    it.each([1, 2, PRICE_MAX_FUTURE_SKEW_SECONDS])('accepts a round %i s ahead of the wall clock (block timestamps run ahead)', async (ahead) => {
        const h = fixture();
        h.a.state.updatedAt = BigInt(START_TIME + ahead);
        expect(await h.source.get()).toMatchObject({ source: 'chainlink', value: 20_000_000n, updatedAt: START_TIME + ahead });
    });

    it('reuses a cached round that is slightly ahead, but not past its expiry or after the clock went back before the skew', async () => {
        const h = fixture(60_000);
        h.a.state.updatedAt = h.b.state.updatedAt = BigInt(START_TIME + PRICE_MAX_FUTURE_SKEW_SECONDS);
        await h.source.get();
        await h.source.get();
        expect(h.a.state.roundReads).toBe(1);
        // A backward step of the wall clock beyond the tolerated skew: the round is no longer reused, and is rejected.
        h.clock.ms = (START_TIME - 1) * 1000;
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'future_timestamp' });
        h.clock.ms = (START_TIME + PRICE_MAX_FUTURE_SKEW_SECONDS + 3600) * 1000;
        await h.source.get();
        h.clock.advance(1);
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'stale' });
    });

    it('reads decimals() again after a rejected refresh, so one wrong answer does not keep pricing down', async () => {
        const h = fixture();
        // A wrong but in-range answer: RPC 2's price is then ten times RPC 1's.
        h.b.state.decimals = 7;
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'rpc_disagreement' });
        h.b.state.decimals = 8;
        expect((await h.source.get()).value).toBe(20_000_000n);
        expect([h.a.state.decimalsReads, h.b.state.decimalsReads]).toEqual([2, 2]);
        // Kept while refreshes succeed.
        await h.source.get();
        expect([h.a.state.decimalsReads, h.b.state.decimalsReads]).toEqual([2, 2]);
    });

    it('answers a rejected refresh for PRICE_RETRY_MS without reading the feed again, then reads again', async () => {
        const h = fixture(30_000);
        h.a.state.down = true;
        for (let i = 0; i < 5; i++) await expect(h.source.get()).rejects.toMatchObject({ reason: 'rpc_error' });
        // One refresh: decimals() on each RPC (the failing one answers nothing), the round on the other.
        expect([h.a.state.decimalsReads, h.b.state.decimalsReads, h.b.state.roundReads]).toEqual([0, 1, 1]);
        expect(await h.metrics.registry.metrics()).toContain('relay_price_unavailable_total{reason="rpc_error"} 1');
        h.a.state.down = false;
        h.clock.ms += PRICE_RETRY_MS - 1;
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'rpc_error' });
        h.clock.ms += 1;
        expect((await h.source.get()).value).toBe(20_000_000n);
    });

    it('with the cache off (cacheMs 0) every call reads, also after a rejection', async () => {
        const h = fixture(0);
        h.a.state.down = true;
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'rpc_error' });
        h.a.state.down = false;
        expect((await h.source.get()).value).toBe(20_000_000n);
    });

    it('cannot cache a price past its oracle expiry', async () => {
        const h = fixture(60_000);
        h.a.state.updatedAt = h.b.state.updatedAt = BigInt(START_TIME - 3600);
        await h.source.get();
        h.clock.advance(1);
        await expect(h.source.get()).rejects.toMatchObject({ reason: 'stale' });
    });

    it('starts configuration without a static price and refuses disabled or static pricing', () => {
        const env = { RELAY_RPC_URLS: 'http://rpc.invalid', RELAY_DEPLOYMENT_FILE: '/deployment.json', RELAY_PRIVATE_KEY_FILE: '/key' };
        expect(loadConfig(env).priceFeed).toBe('default');
        expect(() => loadConfig({ ...env, RELAY_POLUSD_FEED: 'none' })).toThrow('a price feed is required');
        expect(() => loadConfig({ ...env, RELAY_POLUSD_FALLBACK: '0.2' })).toThrow('Static price fallbacks are unsupported');
        const h = fixture();
        expect(() => createPriceSource({ feed: 'default', chainId: 31337, chain: h.chain, clock: h.clock, cacheMs: 0 })).toThrow('RELAY_POLUSD_FEED is required');
    });
});
