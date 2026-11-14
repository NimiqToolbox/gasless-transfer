// An RPC that answers every read correctly but slowly, within its timeout (RELAY_RPC_TIMEOUT_MS, 5 s by default),
// cannot stretch a pass beyond the 60 s liveness limit.
//
// Settling a provisional outcome needs every configured RPC. A pass checks at most SETTLE_CHECKS_PER_PASS (32)
// outcomes, but a bound on their number is no bound on time: with 2 s per read, 32 checks that each wait for the slow
// RPC take more than a minute, whether that RPC never shows the receipts (one read per check) or is honest and 32
// outcomes become final together (two reads per check). The pass would exceed the liveness limit, /readyz would
// report pass_stale (unready), and it would stay so: while a pass is long, more outcomes become final. A settlement
// backlog is a metric and a degraded state, never unreadiness.
//
// Expected: the reads on the configured RPCs for the decisions that need every RPC start only within
// RPC_READ_BUDGET_MS (20 s) of a pass (quorum.withReadBudget). After that every RPC counts as not answering for the
// rest of the pass, and the decisions it holds wait for a later pass (the settlement checks go in turn, least recently
// checked first). A read under way ends within RELAY_RPC_TIMEOUT_MS. So a slow RPC delays settlements but cannot
// stretch a pass, and every outcome still settles, in turn, over the following passes.
//
// The test models latency on the relay's clock, and concurrency correctly: reads that are in flight together finish
// together (each read ends `latency` after it started), so reads that run in parallel cost one latency, not the sum.
// health() is sampled at every read of the slow RPC.
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockInfo, ChainClient, ReadContractCall, ReceiptInfo } from '../../../src/chain/types.js';
import { SETTLE_CHECKS_PER_PASS } from '../../../src/tx/txManager.js';
import { CONTRACT, TEST_TX_SETTINGS, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const N = SETTLE_CHECKS_PER_PASS + 8;

/**
 * RELAY_RPC_URLS=<first>,<second>: `N` relayed requests are mined and final on the first RPC (the relay's own
 * client). Then every read of the second RPC takes `latencyMs` of the relay's clock (below the 5 s RPC timeout), and
 * `passes` more passes run, a block before each. `showsReceipts`: the second RPC is honest; otherwise it never shows
 * a receipt, nor the state of an older block, so it cannot show the calls' execution in the blocks that used
 * their nonces either. `passSeconds` is the longest of these passes; `settled` counts the requests settled after them.
 */
async function slowPasses(latencyMs: number, showsReceipts: boolean, passes = 1) {
    h = await createHarness({
        settings: {
            readinessIncludesTxManager: true,
            admission: { maxQueued: N },
            tx: { ...TEST_TX_SETTINGS, maxInFlight: N + 1, reservedPrioritySlots: 1 },
        },
    });
    await h.relay.txManager.recover();
    const x = h;
    const { chain, clock } = x;
    const view = chain.rpcView();
    let fast = true;
    let hide = true; // until the pass that is measured, no outcome settles
    const unhealthy = new Set<string>();
    /** A read that ends `latencyMs` after it started (reads in flight together end together). */
    const slow =
        <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
            if (fast) return fn(...args);
            const done = clock.ms + latencyMs;
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (clock.ms < done) clock.ms = done;
            for (const r of x.relay.txManager.health().reasons) unhealthy.add(r.split(':')[0]!);
            return fn(...args);
        };
    const second: ChainClient = {
        ...view,
        getBlock: slow((tag: 'latest' | 'finalized'): Promise<BlockInfo> => view.getBlock(tag)),
        getBlockByNumber: slow((n: bigint): Promise<BlockInfo | null> => view.getBlockByNumber!(n)),
        getTransactionCount: slow(view.getTransactionCount),
        getTransactionReceipt: slow((hash: `0x${string}`): Promise<ReceiptInfo | null> => (hide ? Promise.resolve(null) : view.getTransactionReceipt(hash))),
        readContract: <T,>(call: ReadContractCall): Promise<T> =>
            slow(async (): Promise<T> => {
                if (hide && call.blockNumber !== undefined && call.blockNumber < chain.head.number) throw new Error('missing trie node');
                return view.readContract<T>(call);
            })(),
    };
    chain.rpcClients = () => [chain, second];
    chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 15n);
    for (let i = 0; i < N; i++) await queue(x, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline: BigInt(clock.seconds() + 7000) });
    await tick(x);
    chain.mine();
    for (let i = 0; i < 20; i++) {
        chain.mine();
        chain.finalized = chain.head.number;
        await tick(x);
    }
    expect(x.store.countByStatus('mined')).toBe(N); // all mined and final on the first RPC; none settled yet
    fast = false;
    hide = !showsReceipts;
    let passSeconds = 0;
    for (let i = 0; i < passes; i++) {
        // The chain's time runs with the clock, which the slow reads move: a head that stood still while the clock
        // ran on would be reported for itself (head_stale).
        chain.mine({ timestampDelta: Math.max(2, clock.seconds() - Number(chain.head.timestamp)) });
        chain.finalized = chain.head.number;
        const start = clock.ms;
        await tick(x);
        passSeconds = Math.max(passSeconds, (clock.ms - start) / 1000);
    }
    return { passSeconds, healthDuringPass: [...unhealthy], settled: N - x.store.listUnsettled().length };
}

describe('a second RPC that answers slowly (within its timeout) cannot stretch a pass beyond the 60 s liveness limit', () => {
    it('a second RPC that never shows the receipts and answers every read after 2 s: the pass stays below 60 s, no pass_stale', async () => {
        const facts = await slowPasses(2_000, false);
        // Without a time budget: 2 reads for its view and 1 per check, 32 checks at 2 s each, more than 60 s.
        expect({ ...facts, below60: facts.passSeconds < 60 }).toMatchObject(LIVE);
        expect(facts.settled).toBe(0); // it holds every settlement back, as it should
    });

    it('an honest second RPC that answers every read after 2 s, while 32 outcomes become final together: the pass stays below 60 s, no pass_stale', async () => {
        const facts = await slowPasses(2_000, true);
        // Without a time budget: 2 reads for its view and 2 per check, 32 checks at 2 s each, more than two minutes.
        expect({ ...facts, below60: facts.passSeconds < 60 }).toMatchObject(LIVE);
    });

    it('with that honest but slow second RPC, every outcome still settles, in turn, over the following passes (each below 60 s)', async () => {
        const facts = await slowPasses(2_000, true, 12);
        expect({ ...facts, below60: facts.passSeconds < 60 }).toMatchObject({ ...LIVE, settled: N });
        expect(h!.logs.text()).toContain('took longer than their budget in this pass; the rest wait for the next pass');
    });
});

const LIVE = { healthDuringPass: [], below60: true };

describe('control: the same pass with 100 ms per read', () => {
    it('control: the pass stays below 60 s and pass_stale is not reported; the first 32 outcomes settle in it', async () => {
        const facts = await slowPasses(100, true);
        expect({ ...facts, below60: facts.passSeconds < 60 }).toMatchObject({ ...LIVE, settled: SETTLE_CHECKS_PER_PASS });
    });
});
