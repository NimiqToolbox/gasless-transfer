import { describe, expect, it } from 'vitest';
import { CHAINLINK_POL_USD_POLYGON } from '@nimiq/gasless-sdk/core';
import { ChainlinkPriceSource } from '../../src/fees/priceSource.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { buildTransfer, createHarness, TEST_TX_SETTINGS, USDC } from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER3_ADDRESS, USER3_KEY } from '../helpers/keys.js';

describe('HTTP health with mandatory oracle pricing', () => {
    it.each([false, true])('continues pending cancellations during an outage (queued work: %s)', async (withQueued) => {
        const h = await createHarness({
            priceSource: ({ chain, clock, metrics }) => new ChainlinkPriceSource({ chain, clock, metrics, feed: CHAINLINK_POL_USD_POLYGON, cacheMs: 0 }),
        });
        try {
            const fresh = BigInt(h.clock.seconds());
            h.chain.feed = { address: CHAINLINK_POL_USD_POLYGON, decimals: 8, answer: 20_000_000n, updatedAt: fresh, description: 'POL / USD' };
            h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
            h.chain.setBalance(USDC, USER3_ADDRESS, 100_000_000n);
            await h.relay.txManager.recover();
            const waiting = await buildTransfer(h);
            const expiring = await buildTransfer(h, { key: OTHER_KEY, deadline: fresh + 60n });
            for (const intent of [waiting, expiring]) await h.relay.pipeline.submit(transferOperation, intent.body);
            await h.relay.txManager.tick();
            expect(h.store.getRequest(waiting.id)?.status).toBe('submitted');
            expect(h.store.getRequest(expiring.id)?.status).toBe('submitted');
            const queued = withQueued ? await buildTransfer(h, { key: USER3_KEY }) : undefined;
            if (queued) await h.relay.pipeline.submit(transferOperation, queued.body);
            const exposure = h.store.gasExposureWei();

            h.chain.feed.updatedAt = fresh - 3601n;
            h.chain.mineBlocks(TEST_TX_SETTINGS.speedUpAfterBlocks, { timestampDelta: 6, include: false });
            await h.relay.txManager.tick();
            expect(h.store.listAttempts(waiting.id)).toHaveLength(1);
            expect(h.store.listAttempts(expiring.id).at(-1)?.kind).toBe('cancel');
            expect(h.chain.broadcasts).toHaveLength(3);
            expect(h.store.gasExposureWei()).toBe(exposure);
            if (queued) {
                expect(h.store.getRequest(queued.id)?.status).toBe('queued');
                expect(h.store.listAttempts(queued.id)).toHaveLength(0);
            }
        } finally { await h.close(); }
    });

    it('holds queued work during an outage but still reconciles mined transfers', async () => {
        const h = await createHarness({
            priceSource: ({ chain, clock, metrics }) => new ChainlinkPriceSource({ chain, clock, metrics, feed: CHAINLINK_POL_USD_POLYGON, cacheMs: 0 }),
        });
        try {
            const fresh = BigInt(h.clock.seconds());
            h.chain.feed = { address: CHAINLINK_POL_USD_POLYGON, decimals: 8, answer: 20_000_000n, updatedAt: fresh, description: 'POL / USD' };
            await h.relay.txManager.recover();
            const intent = await buildTransfer(h);
            await h.relay.pipeline.submit(transferOperation, intent.body);
            h.chain.feed.updatedAt = fresh - 3601n;
            await h.relay.txManager.tick();
            expect(h.chain.broadcasts).toHaveLength(0);
            expect(h.store.getRequest(intent.id)?.status).toBe('queued');
            h.chain.feed.updatedAt = fresh;
            await h.relay.txManager.tick();
            expect(h.chain.broadcasts).toHaveLength(1);
            expect(h.store.getRequest(intent.id)?.status).toBe('submitted');
            h.chain.mine();
            h.chain.mineBlocks(16);
            h.chain.finalized = h.chain.head.number;
            h.chain.feed.updatedAt = fresh - 3601n;
            await h.relay.txManager.tick();
            expect(h.store.getRequest(intent.id)?.status).toBe('confirmed');
            expect(h.chain.broadcasts).toHaveLength(1);
        } finally { await h.close(); }
    });

    it('serves liveness, rejects unpriced work, and recovers readiness and quotes', async () => {
        const h = await createHarness({
            settings: { readinessCacheMs: 0, feeCacheMs: 2000 },
            priceSource: ({ chain, clock, metrics }) => new ChainlinkPriceSource({ chain, clock, metrics, feed: CHAINLINK_POL_USD_POLYGON, cacheMs: 0 }),
        });
        try {
            h.chain.feed = { address: CHAINLINK_POL_USD_POLYGON, decimals: 8, answer: 20_000_000n, updatedAt: BigInt(h.clock.seconds()), description: 'POL / USD' };
            const base = await h.relay.app.listen({ host: '0.0.0.0', port: 0 });
            const url = base.replace('0.0.0.0', '127.0.0.1');
            const fee = `${url}/v1/fee?operation=transfer&token=${USDC}&authMode=permit`;
            expect((await fetch(`${url}/healthz`)).status).toBe(200);
            expect((await fetch(`${url}/readyz`)).status).toBe(200);
            expect((await fetch(fee)).status).toBe(200);

            h.chain.feed.updatedAt = BigInt(h.clock.seconds() - 3601);
            const live = await fetch(`${url}/healthz`);
            expect(live.status).toBe(200);
            expect(await live.json()).toEqual({ status: 'ok' });
            expect((await fetch(`${url}/readyz`)).status).toBe(503);
            const quote = await fetch(fee);
            expect(quote.status).toBe(503);
            const intent = await buildTransfer(h);
            const submitted = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: intent.body });
            expect(submitted.statusCode).toBe(503);
            expect(h.store.getRequest(intent.id)).toBeUndefined();
            expect(h.chain.broadcasts).toHaveLength(0);

            h.chain.feed.updatedAt = BigInt(h.clock.seconds());
            expect((await fetch(`${url}/readyz`)).status).toBe(200);
            const recovered = await fetch(fee);
            expect(recovered.status).toBe(200);
            expect(await recovered.json()).toMatchObject({ polUsd: '0.2' });
            expect((await fetch(`${url}/metrics`)).status).toBe(404);
        } finally { await h.close(); }
    });
});
