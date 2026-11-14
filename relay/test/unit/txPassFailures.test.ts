// A pass of the transaction manager while the price or a chain read fails: the pass itself completes, and a read that
// failed for one request is not repeated for the next ones of the same pass.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriceUnavailableError, type PriceReading, type PriceSource } from '../../src/fees/priceSource.js';
import { createHarness, TEST_TX_SETTINGS, USDC, USDT0, type BuiltTransfer, type Harness } from '../helpers/harness.js';
import { installTokenPins, testTokenPins } from '../helpers/tokenPins.js';
import { queue } from '../helpers/txManagerDriver.js';

let h: Harness | undefined;
afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('a pass while the price is unavailable', () => {
    it('completes with requests queued and sends none of them; they are sent once the price is back', async () => {
        let down = false;
        const reading: PriceReading = { value: 20_000_000n, decimals: 8, source: 'chainlink', updatedAt: null, reason: null };
        const priceSource: PriceSource = {
            feed: null,
            last: () => reading,
            get: async () => {
                if (down) throw new PriceUnavailableError('rpc_error');
                return reading;
            },
        };
        h = await createHarness({ priceSource: () => priceSource });
        const manager = h.relay.txManager;
        await manager.recover();
        const t = await queue(h);

        down = true;
        h.chain.mine();
        await manager.tick();
        expect(manager.lastTickError).toBeUndefined();
        expect(manager.viewHead()).toBe(h.chain.head.number);
        expect(h.store.getRequest(t.id)!.status).toBe('queued');

        down = false;
        await manager.tick();
        expect(manager.lastTickError).toBeUndefined();
        expect(h.store.getRequest(t.id)!.status).toBe('submitted');
    });
});

describe('a pass while the simulation RPC fails', () => {
    it('asks once for the first in-flight request that is due, not again for the next; both are checked again once it answers', async () => {
        h = await createHarness();
        const { chain, store } = h;
        const manager = h.relay.txManager;
        await manager.recover();
        const first = await queue(h);
        const second = await queue(h);
        await manager.tick();
        expect([first, second].map((t) => store.getRequest(t.id)!.status)).toEqual(['submitted', 'submitted']);

        // Both are due for their re-simulation: the first before its speed-up, the second (its tx nonce is not next
        // yet) while it waits behind the first.
        for (let i = 0; i < 10; i++) chain.mine({ include: false });
        let simulations = 0;
        const call = chain.call.bind(chain);
        chain.call = (params) => {
            simulations += 1;
            return call(params);
        };
        chain.failing.add('call');
        await manager.tick();
        expect(manager.lastTickError).toBeUndefined();
        expect(simulations).toBe(1);
        expect([first, second].map((t) => store.listAttempts(t.id).length)).toEqual([1, 1]);

        chain.failing.delete('call');
        chain.mine({ include: false });
        await manager.tick();
        expect(manager.lastTickError).toBeUndefined();
        expect(simulations).toBe(3);
        // Only the request whose tx nonce is next is sped up.
        expect([first, second].map((t) => store.listAttempts(t.id).length)).toEqual([2, 1]);
    });
});

describe('a pass while the implementation check of one token fails', () => {
    /** A relay with the token implementation monitor (as in production), its pins installed on the chain. */
    async function withMonitor(tx: Partial<typeof TEST_TX_SETTINGS> = {}): Promise<Harness> {
        h = await createHarness({ settings: { tokenImplementationPins: testTokenPins(), tx: { ...TEST_TX_SETTINGS, ...tx } } });
        installTokenPins(h.chain);
        await h.relay.tokenImplementations!.check();
        expect(h.relay.tokenImplementations!.status().ok).toBe(true);
        await h.relay.txManager.recover();
        return h;
    }
    const unverified = (x: Harness, token: string) =>
        vi.spyOn(x.relay.tokenImplementations!, 'checkToken').mockImplementation(async (checked) => checked.toLowerCase() !== token.toLowerCase());
    const statuses = (x: Harness, requests: readonly BuiltTransfer[]) => requests.map((t) => x.store.getRequest(t.id)!.status);

    it('holds the requests of that token and sends those of the other tokens', async () => {
        h = await withMonitor();
        const manager = h.relay.txManager;
        const usdc = await queue(h, { token: USDC });
        const usdt0 = await queue(h, { token: USDT0 });
        const check = unverified(h, USDC);

        await manager.tick();
        expect(manager.lastTickError).toBeUndefined();
        expect(statuses(h, [usdc, usdt0])).toEqual(['queued', 'submitted']);

        check.mockRestore();
        await manager.tick();
        expect(statuses(h, [usdc, usdt0])).toEqual(['submitted', 'submitted']);
    });

    it('is asked once per pass, and the waiting requests of that token do not use up the checks of the pass', async () => {
        h = await withMonitor({ maxInFlight: 2 });
        const manager = h.relay.txManager;
        // More requests of the token than a pass checks in full (two per slot), ahead of one of another token.
        const usdc = [];
        for (let i = 0; i < 6; i++) usdc.push(await queue(h, { token: USDC }));
        const usdt0 = await queue(h, { token: USDT0 });
        const check = unverified(h, USDC);

        await manager.tick();
        expect(check.mock.calls.filter(([token]) => token.toLowerCase() === USDC.toLowerCase())).toHaveLength(1);
        expect(statuses(h, usdc)).toEqual(usdc.map(() => 'queued'));
        expect(statuses(h, [usdt0])).toEqual(['submitted']);
    });
});
