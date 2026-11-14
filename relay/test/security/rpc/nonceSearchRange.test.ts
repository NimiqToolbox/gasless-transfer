// The search for how an intent nonce was used is bounded on every RPC, whatever head and block timestamps that RPC
// reports.
//
// Scenario: another transaction takes the tx nonce of a relayed request and the sender invalidates the intent nonce.
// After the grace period (RELAY_UNKNOWN_NONCE_GRACE_BLOCKS) the relay asks every configured RPC how the nonce was
// used. The second RPC reports its head 10^7 blocks ahead, with every block at the head's timestamp, and each of its
// state reads and eth_getLogs takes 50 ms. Its state and logs are otherwise true.
//
// The relay locates the use from state (quorum.findNonceUse): it reads nonces(signer) at block numbers, stepping down
// from the RPC's head by 1, 2, 4, … blocks and then bisecting, and then inspects that one block (its candidate receipts
// and one eth_getLogs of it). A head 10^7 blocks ahead costs about 2·log2(10^7) reads; no log range that the RPC could
// stretch is walked. This matters because a pass waits for every RPC's search: an unbounded one would hold the pass
// beyond the 60 s liveness limit (pass_stale, unready), and no request would be broadcast, sped up or cancelled
// meanwhile. The RPC shows the invalidation, so the request fails with nonce_used.
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockInfo, ChainClient, ChainLog, LogFilter, ReadContractCall } from '../../../src/chain/types.js';
import { createHarness, type Harness } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const QUERY_MS = 50;

/**
 * RELAY_RPC_URLS=<honest>,<second>. The second RPC reports its head `lead` blocks ahead, and every block at the head's
 * timestamp; each of its eth_getLogs and state reads takes 50 ms of the relay's clock. The request's tx nonce is taken
 * by another transaction and its sender invalidates the intent nonce: after the grace period the relay asks every RPC
 * how the nonce was used.
 */
async function searchPass(lead: bigint) {
    h = await createHarness();
    await h.relay.txManager.recover();
    const x = h;
    const { chain, clock } = x;
    const view = chain.rpcView();
    const unhealthy = new Set<string>();
    let queries = 0;
    let stateReads = 0;
    const slow = async (): Promise<void> => {
        const done = clock.ms + QUERY_MS;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (clock.ms < done) clock.ms = done;
        for (const r of x.relay.txManager.health().reasons) unhealthy.add(r.split(':')[0]!);
    };
    const second: ChainClient = {
        ...view,
        getBlock: async (tag): Promise<BlockInfo> => {
            const block = await view.getBlock(tag);
            return tag === 'latest' ? { ...block, number: block.number + lead } : block;
        },
        getBlockByNumber: async (n: bigint): Promise<BlockInfo | null> =>
            lead === 0n ? view.getBlockByNumber!(n) : { number: n, timestamp: chain.head.timestamp, baseFeePerGas: null, hash: `0x${n.toString(16).padStart(64, '0')}` },
        getLogs: async (filter: LogFilter): Promise<readonly ChainLog[]> => {
            queries += 1;
            await slow();
            return view.getLogs!(filter);
        },
        readContract: async <T>(call: ReadContractCall): Promise<T> => {
            if (call.blockNumber !== undefined && call.blockNumber < chain.head.number + lead) {
                stateReads += 1;
                await slow();
            }
            return view.readContract<T>(call);
        },
    };
    chain.rpcClients = () => [chain, second];
    const t = await queue(x);
    await tick(x);
    chain.consumeNonce(RELAY_ADDRESS, 0);
    chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
    let longestPass = 0;
    for (let i = 0; i < 14; i++) {
        chain.mine();
        chain.finalized = chain.head.number;
        const start = clock.ms;
        await tick(x);
        longestPass = Math.max(longestPass, (clock.ms - start) / 1000);
    }
    return { longestPassBelow60: longestPass < 60, healthDuringPasses: [...unhealthy], longestPass, queries, stateReads, code: x.store.getRequest(t.id)!.error?.code ?? null };
}

describe('the search for the use of an intent nonce on one RPC is bounded, whatever head and timestamps the RPC reports', () => {
    it('an RPC that reports its head 10^7 blocks ahead (block timestamps at the acceptance) does not make a pass exceed 60 s', async () => {
        const facts = await searchPass(10_000_000n);
        // Every pass stays below the liveness limit, and health() reports nothing during any of them.
        expect({ longestPassBelow60: facts.longestPassBelow60, healthDuringPasses: facts.healthDuringPasses }, JSON.stringify(facts)).toEqual({
            longestPassBelow60: true,
            healthDuringPasses: [],
        });
        // About 2·log2(10^7) state reads for the search, and one eth_getLogs of the block that used the nonce per check.
        expect(facts.stateReads, JSON.stringify(facts)).toBeLessThanOrEqual(2 * 24 + 2);
        expect(facts.queries, JSON.stringify(facts)).toBeLessThanOrEqual(4);
        // Its state and logs show the invalidation: every RPC shows it.
        expect(facts.code).toBe('nonce_used');
    });
});

describe('control: an honest second RPC', () => {
    it('control: the search takes a few reads and the pass stays short', async () => {
        const facts = await searchPass(0n);
        expect({ longestPassBelow60: facts.longestPassBelow60, healthDuringPasses: facts.healthDuringPasses }).toEqual({
            longestPassBelow60: true,
            healthDuringPasses: [],
        });
        expect(facts.stateReads).toBeLessThanOrEqual(10);
        // Settlement checks re-read the evidence of the use (its log), rather than trusting the cached answer.
        expect(facts.queries).toBeLessThanOrEqual(4);
        expect(facts.code).toBe('nonce_used');
    });
});
