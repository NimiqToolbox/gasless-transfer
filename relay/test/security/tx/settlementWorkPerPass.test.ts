// The settlement work of a pass is bounded, however many requests wait to settle.
//
// Settling (confirmed, purge of the secrets) needs every RPC to show the outcome final and canonical. An RPC that
// never agrees keeps every relayed request unsettled: that is the intended delay, not an outage. But if every pass
// (RELAY_POLL_INTERVAL_MS, 2 s by default) re-checked every unsettled request, one after another on every RPC, each
// relayed request would make every later pass several round trips longer: at about 100 ms per round trip, 200
// unsettled requests would make one pass longer than the 60 s liveness limit, and the relay would be reported unready
// (pass_stale) because of one RPC listed second.
//
// So a pass checks at most SETTLE_CHECKS_PER_PASS (32) unsettled requests, the ones checked least recently first, and
// asks the RPCs in parallel. More unsettled requests than that are a settle backlog: the gauge
// relay_unsettled_requests and a `settle_backlog` entry under `degraded` (the relay stays ready). Retention never
// deletes an unsettled request.
//
// The test simulates 100 ms per RPC round trip by advancing the relay's clock in the fake RPCs, relays 210 requests,
// and records health() while the next pass runs. The relay locates the use of an intent nonce from state, so an RPC
// that does not answer eth_getTransactionReceipt could still show an execution (the call's receipt in
// eth_getBlockReceipts of the block that used the nonce); the second RPC here serves no state of older blocks either,
// so it holds every settlement back, and each check also costs the reads of that search.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChainClient, ReadContractCall } from '../../../src/chain/types.js';
import { TEST_TX_SETTINGS, USDC, CONTRACT, createHarness, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const N = 210;
const LATENCY_MS = 100;

describe('the settlement work of a pass is bounded', () => {
    it('with a second RPC that never shows receipts, 210 unsettled requests keep a pass below the 60 s liveness limit; the backlog is a metric and degraded, not unready', async () => {
        h = await createHarness({
            settings: {
                readinessIncludesTxManager: true,
                // Many requests of one sender, sent quickly: admission and slots are not what this test checks.
                admission: { maxQueued: N },
                // The total gas budget is raised so that it does not limit the 210 calls.
                tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: 100n * 10n ** 18n, maxInFlight: 60, reservedPrioritySlots: 1 },
            },
        });
        await h.relay.txManager.recover();
        const { chain, clock } = h;
        const view = chain.rpcView();
        // RELAY_RPC_URLS=<honest>,<second>: the second RPC answers everything but never shows a receipt or the state of
        // an older block.
        const second: ChainClient = {
            ...view,
            getTransactionReceipt: () => Promise.resolve(null),
            readContract: <T,>(call: ReadContractCall): Promise<T> =>
                call.blockNumber !== undefined && call.blockNumber < chain.head.number ? Promise.reject(new Error('missing trie node')) : view.readContract<T>(call),
        };
        chain.rpcClients = () => [chain, second];
        chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 15n);
        for (let i = 0; i < N; i++) await queue(h, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline: BigInt(clock.seconds() + 7000) });
        for (let i = 0; i < 10; i++) {
            await tick(h);
            chain.mine();
            chain.finalized = chain.head.number;
        }
        for (let i = 0; i < 20; i++) {
            chain.mine();
            chain.finalized = chain.head.number;
            await tick(h);
        }
        expect(h.store.countByStatus('mined')).toBe(N); // all mined, final on the first RPC, never settled

        // From now on every RPC round trip takes 100 ms of the relay's clock; health() is sampled during the pass.
        const unhealthy = new Set<string>();
        const slow = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
            async (...args: A): Promise<R> => {
                clock.ms += LATENCY_MS;
                for (const r of h!.relay.txManager.health().reasons) unhealthy.add(r.split(':')[0]!);
                return fn(...args);
            };
        chain.getTransactionReceipt = slow(chain.getTransactionReceipt.bind(chain));
        chain.getBlockByNumber = slow(chain.getBlockByNumber.bind(chain));
        second.getTransactionReceipt = slow(second.getTransactionReceipt);
        second.readContract = slow(second.readContract) as ChainClient['readContract'];
        chain.mine();
        chain.finalized = chain.head.number;
        const start = clock.ms;
        await tick(h);
        const passSeconds = (clock.ms - start) / 1000;
        const facts = { unsettled: h.store.listUnsettled().length, passSeconds, healthDuringPass: [...unhealthy] };
        // The pass checks 32 of the 210: checking all of them, one after another, would exceed the liveness limit.
        expect(facts.passSeconds).toBeLessThan(60);
        expect(facts.healthDuringPass).toEqual([]);
        // The backlog is visible, and the relay stays ready.
        expect(facts.unsettled).toBe(N);
        const health = h.relay.txManager.health();
        expect(health.ok).toBe(true);
        expect(health.degraded).toContainEqual(expect.stringMatching(/^settle_backlog: 210 provisional outcomes wait to settle; a pass checks 32 of them/));
        expect(await h.metrics.registry.metrics()).toContain('relay_unsettled_requests 210');
    });
});
