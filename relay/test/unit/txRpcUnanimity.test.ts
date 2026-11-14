// The transaction manager's decisions that need a positive answer from every configured RPC, against the fake chain:
// a new tx nonce for a request, a nonce_used failure, settling and undoing an outcome; with them the relay's nonce
// range, the search for what used a request's intent nonce, and the bound on the settlement work of a pass. An RPC
// that does not answer, lags or reports a wrong head must hold such a decision back, but never for good: the undo bar
// is the relay's clock, and a stored block number is re-based on the RPC's real head. Each rule comes with its
// control. The security tests run the same rules end to end; relay/docs/transaction-lifecycle.md ("Several RPCs")
// describes the rules.
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction, toHex, type Address, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { BlockInfo, ChainClient, ChainLog, LogFilter, ReadContractCall, ReceiptInfo } from '../../src/chain/types.js';
import { toRequestState } from '../../src/http/app.js';
import { SETTLE_CHECKS_PER_PASS } from '../../src/tx/txManager.js';
import { GWEI } from '../helpers/fakeChain.js';
import { CONTRACT, TEST_TX_SETTINGS, USDC, createHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';
import { RELAY_ADDRESS, USER_ADDRESS } from '../helpers/keys.js';
import { blocks, queue, secondRpc, tick } from '../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

async function setup(options: HarnessOptions = {}): Promise<Harness> {
    h = await createHarness(options);
    await h.relay.txManager.recover();
    return h;
}

const state = (x: Harness, id: Hex) => toRequestState(x.store.getRequest(id)!, x.store.listAttempts(id));
const record = (x: Harness, id: Hex) => x.store.getRequest(id)!;
const metrics = (x: Harness) => x.metrics.registry.metrics();
const withStuckAfter10 = { settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } };
const isRelay = (address: string) => address.toLowerCase() === RELAY_ADDRESS.toLowerCase();

/**
 * `view`'s contract reads, refused below the head while `pruned()`: an RPC without the state of older blocks, which
 * cannot show the block that used an intent nonce (so a receipt it hides is not replaced by that block's evidence).
 */
function withoutHistory(x: Harness, view: ChainClient, pruned: () => boolean = () => true): Pick<ChainClient, 'readContract'> {
    return {
        readContract: <T,>(call: ReadContractCall): Promise<T> =>
            pruned() && call.blockNumber !== undefined && call.blockNumber < x.chain.head.number ? Promise.reject(new Error('missing trie node')) : view.readContract<T>(call),
    };
}

/** Nonces of the 0-value self-transfers (gap fillers) the relay broadcast, sorted. */
function fillerNonces(x: Harness): number[] {
    const nonces = new Set<number>();
    for (const raw of x.chain.broadcasts) {
        const tx = parseTransaction(raw);
        if (tx.to && isRelay(tx.to) && (tx.value ?? 0n) === 0n) nonces.add(tx.nonce ?? -1);
    }
    return [...nonces].sort((a, b) => a - b);
}

describe('requeue at a new tx nonce: every RPC must confirm, each on its own view', () => {
    it("each RPC's own observation block must be final by its own finalized tag: a second RPC whose tag lags holds the new nonce back until it passes", async () => {
        const x = await setup();
        let lag = 1000n;
        const view = x.chain.rpcView();
        secondRpc(x, {
            getBlock: async (tag): Promise<BlockInfo> => {
                const block = await view.getBlock(tag);
                return tag === 'finalized' ? { ...block, number: block.number - lag } : block;
            },
        });
        const t = await queue(x);
        await tick(x);
        x.chain.dropMempool();
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        await blocks(x, 40); // the first RPC (the relay's own client) shows the observation final long ago
        expect(record(x, t.id).txNonce).toBe(0);
        expect(await metrics(x)).not.toContain('event="requeued"');
        lag = 16n; // the second RPC's tag passes its own observation block
        await tick(x);
        expect(record(x, t.id).txNonce).toBe(1);
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="requeued"} 1');
    });

    it('evidence against it counts from any RPC whatever its head: an RPC that still shows the tx nonce unused holds it back (ALERT); its own observation starts when it shows the state', async () => {
        const x = await setup(withStuckAfter10);
        let behind = true;
        const view = x.chain.rpcView();
        secondRpc(x, { getTransactionCount: (address, tag) => (behind ? Promise.resolve(0) : view.getTransactionCount(address, tag)) });
        const t = await queue(x);
        await tick(x);
        x.chain.dropMempool();
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        await blocks(x, 40);
        expect(record(x, t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="requeue"} 1');
        expect(x.logs.text()).toContain('an RPC still shows a transaction of the request, or its tx nonce unused');
        behind = false;
        await blocks(x, 16); // the second RPC's observation block (its head now) is not final before 16 blocks
        expect(record(x, t.id).txNonce).toBe(0);
        await blocks(x, 1);
        expect(record(x, t.id).txNonce).toBe(1);
    });

    it('with one configured RPC, that RPC decides alone (here: a new tx nonce once its own observation is final)', async () => {
        const x = await setup(); // rpcClients unset: one RPC
        const t = await queue(x);
        await tick(x);
        x.chain.dropMempool();
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        await blocks(x, 30);
        expect(record(x, t.id).txNonce).toBe(1);
    });
});

describe('failure because the sender invalidated the nonce (nonce_used): every RPC must show it', () => {
    it('an RPC that does not answer the search for the use holds the failure back (ALERT); once it answers, the request fails with nonce_used', async () => {
        const x = await setup(withStuckAfter10);
        let down = true;
        const view = x.chain.rpcView();
        secondRpc(x, { getLogs: (filter) => (down ? Promise.reject(new Error('HTTP 429')) : view.getLogs!(filter)) });
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        await blocks(x, 30);
        expect(state(x, t.id).status).toBe('submitted');
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="nonce_evidence"} 1');
        expect(x.logs.text()).toContain('(nonce_evidence): not every RPC answered (RPC #2 in RELAY_RPC_URLS)');
        down = false;
        await blocks(x, 12); // the next search (at most one per RELAY_UNKNOWN_NONCE_GRACE_BLOCKS)
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
    });

    /**
     * Both RPCs cap the logs of one eth_getLogs response at 5, as some providers do. In the block after the acceptance, 40
     * other accounts emit NonceInvalidated for themselves (invalidateNonces raises the caller's own nonce), with ranges
     * that cover the request's intent nonce.
     */
    function cappedRpcsWithForeignEvents(x: Harness, intentNonce: bigint): void {
        const cap = (getLogs: (f: LogFilter) => Promise<readonly ChainLog[]>) => async (filter: LogFilter): Promise<readonly ChainLog[]> => {
            const logs = await getLogs(filter);
            if (logs.length > 5) throw new Error('query returned more than 5 results');
            return logs;
        };
        const view = x.chain.rpcView();
        x.chain.getLogs = cap(x.chain.getLogs.bind(x.chain));
        secondRpc(x, { getLogs: cap((f) => view.getLogs!(f)) });
        x.chain.mine();
        for (let i = 0; i < 40; i++) {
            const other = `0x${(0xb000 + i).toString(16).padStart(40, '0')}` as Address;
            x.chain.invalidateNonces(other, intentNonce + 1n);
        }
    }

    it("other accounts' NonceInvalidated events do not hold the failure back on RPCs that cap the logs of one response (the exact signer filter)", async () => {
        const x = await setup(withStuckAfter10);
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0); // a transaction outside the relay takes its tx nonce
        cappedRpcsWithForeignEvents(x, BigInt(t.request.nonce));
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n); // and the sender burns the intent nonce, in the same block
        await blocks(x, 30);
        // The search asks for the signer's own NonceInvalidated only. A filter that the foreign events match as well would
        // be refused by both capped RPCs for every range with their block: both would count as not answering the search,
        // and the request would stay submitted (ALERT).
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        const text = await metrics(x);
        expect(text).not.toContain('decision="nonce_evidence"');
        expect(text).toContain('relay_nonce_events_total{event="nonce_invalidated"} 1');
        expect(x.logs.text()).not.toContain('query returned more than 5 results');
    });

    // A used nonce without the signer's NonceInvalidated is no evidence that another request used it (nonce_used); it
    // is no evidence of anything: the request waits.
    it("control: the same foreign events are no evidence of an invalidation: without the signer's own NonceInvalidated (and nothing else in the block that shows the use) the request waits", async () => {
        const x = await setup(withStuckAfter10);
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        cappedRpcsWithForeignEvents(x, BigInt(t.request.nonce));
        x.chain.setIntentNonce(t.request.from, BigInt(t.request.nonce) + 1n); // used, without an event of the signer
        await blocks(x, 30);
        expect(state(x, t.id).status).toBe('submitted');
        const text = await metrics(x);
        expect(text).toContain('relay_decision_waits_total{decision="nonce_evidence"} 1');
        expect(text).not.toContain('event="nonce_used_elsewhere"');
        expect(text).not.toContain('event="nonce_invalidated"');
        expect(x.logs.text()).not.toContain('query returned more than 5 results');
    });

    it("the relay's call in the block that used the nonce on one RPC holds the failure back, even when the other RPC shows NonceInvalidated there", async () => {
        const x = await setup(withStuckAfter10);
        secondRpc(x); // honest: the chain's true logs
        x.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
        const t = await queue(x, { token: USDC, mode: 'none' });
        await tick(x);
        x.chain.mine(); // the transfer executes
        const [call] = x.store.listAttempts(t.id);
        x.chain.unservedReceipts.add(call!.hash); // no RPC answers the receipt on its own; eth_getBlockReceipts lists it
        // The first RPC lists no receipt of the call either, and forges NonceInvalidated(signer, nonce, nonce + 1) in
        // every block it is asked about.
        const listed = x.chain.getBlockReceipts.bind(x.chain);
        x.chain.getBlockReceipts = async (n) => ((await listed(n)) ?? []).filter((r) => r.transactionHash !== call!.hash);
        const topics = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer: t.request.from } }) as Hex[];
        const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(t.request.nonce), BigInt(t.request.nonce) + 1n]);
        x.chain.getLogs = async (filter): Promise<readonly ChainLog[]> => [
            { address: CONTRACT, topics, data, blockNumber: filter.toBlock, blockHash: toHex(filter.toBlock, { size: 32 }), transactionHash: keccak256(toHex('forged')) },
        ];
        await blocks(x, 40);
        expect(state(x, t.id).status).toBe('submitted');
        const text = await metrics(x);
        expect(text).not.toContain('event="nonce_invalidated"');
        expect(text).not.toContain('event="mined_by_nonce_search"');
        expect(text).toContain('relay_decision_waits_total{decision="receipt"} 1');
        expect(x.logs.text()).toContain("an RPC shows the relay's call in the block that used the request nonce, but not every RPC serves its successful receipt there");
        expect(x.logs.text()).toContain('the RPCs disagree how the request nonce was used (#1: invalidated, #2: executed)');
    });

    it("control: with both RPCs honest, the relay's call's receipt in the block that used the nonce on every RPC makes the request mined, although no RPC answers it on its own", async () => {
        const x = await setup(withStuckAfter10);
        secondRpc(x);
        x.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
        const t = await queue(x, { token: USDC, mode: 'none' });
        await tick(x);
        x.chain.mine();
        const [call] = x.store.listAttempts(t.id);
        x.chain.unservedReceipts.add(call!.hash);
        await blocks(x, 30);
        expect(state(x, t.id)).toMatchObject({ status: 'confirmed', txHash: call!.hash, error: null });
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="mined_by_nonce_search"} 1');
    });

    it("the request's receipt on any RPC holds the failure back, even when the relay's own client forges a NonceInvalidated", async () => {
        const x = await setup(withStuckAfter10);
        secondRpc(x); // honest: the chain's true receipts and logs
        x.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
        const t = await queue(x, { token: USDC, mode: 'none' });
        await tick(x);
        x.chain.mine(); // the transfer executes
        const [call] = x.store.listAttempts(t.id);
        // The first RPC hides the receipt and forges NonceInvalidated(signer, nonce, nonce + 1).
        const receipt = x.chain.getTransactionReceipt.bind(x.chain);
        x.chain.getTransactionReceipt = (hash) => (hash === call!.hash ? Promise.resolve(null) : receipt(hash));
        const topics = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer: t.request.from } }) as Hex[];
        const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(t.request.nonce), BigInt(t.request.nonce) + 1n]);
        x.chain.getLogs = async (filter): Promise<readonly ChainLog[]> => [
            { address: CONTRACT, topics, data, blockNumber: filter.toBlock, blockHash: toHex(filter.toBlock, { size: 32 }), transactionHash: keccak256(toHex('forged')) },
        ];
        await blocks(x, 40, 64n);
        expect(state(x, t.id).status).toBe('submitted');
        const text = await metrics(x);
        expect(text).not.toContain('event="nonce_invalidated"');
        expect(text).toContain('relay_decision_waits_total{decision="requeue"} 1');
        // Control: the relay's own client shows the receipt again: mined.
        x.chain.getTransactionReceipt = receipt;
        await tick(x);
        expect(state(x, t.id)).toMatchObject({ status: 'mined', txHash: call!.hash });
    });
});

describe('settling an outcome: every RPC must confirm', () => {
    it('an RPC that does not answer holds the settlement back (not yet, with an ALERT naming it); the request confirms once it answers', async () => {
        const x = await setup(withStuckAfter10);
        let down = false;
        const view = x.chain.rpcView();
        secondRpc(x, { getTransactionReceipt: (hash) => (down ? Promise.reject(new Error('timeout')) : view.getTransactionReceipt(hash)) });
        const t = await queue(x);
        await tick(x);
        x.chain.mine();
        await tick(x);
        expect(state(x, t.id).status).toBe('mined');
        down = true;
        await blocks(x, 30);
        expect(record(x, t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        expect(record(x, t.id).signature).not.toBeNull();
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="settle"} 1');
        const text = x.logs.text();
        expect(text).toContain('(settle): not every RPC answered (RPC #2 in RELAY_RPC_URLS)');
        expect(text).toContain('an RPC does not answer; the decisions that need every RPC in RELAY_RPC_URLS wait until it answers again');
        down = false;
        await tick(x);
        expect(state(x, t.id).status).toBe('confirmed');
        expect(record(x, t.id).signature).toBeNull();
        expect(x.logs.text()).toContain('RPC answers again');
    });

    it('a failed or expired outcome settles only once no RPC shows a successful call of the request (here the second RPC shows one)', async () => {
        const x = await setup(withStuckAfter10);
        let lie = true;
        let callHash: Hex | undefined;
        const view = x.chain.rpcView();
        secondRpc(x, {
            getTransactionReceipt: async (hash): Promise<ReceiptInfo | null> => {
                if (lie && callHash !== undefined && hash.toLowerCase() === callHash.toLowerCase()) {
                    return { transactionHash: hash, blockNumber: 1001n, blockHash: toHex(1001n, { size: 32 }), status: 'success', gasUsed: 100_000n, effectiveGasPrice: GWEI, logs: [] };
                }
                return view.getTransactionReceipt(hash);
            },
        });
        const t = await queue(x, { deadline: BigInt(x.clock.seconds() + 120) });
        await tick(x);
        callHash = x.store.listAttempts(t.id)[0]!.hash;
        x.chain.mine({ baseFee: 1000n * GWEI, timestampDelta: 119 }); // the call is priced out; 1 s before the deadline
        await tick(x); // the relay cancels it
        x.chain.mine();
        await tick(x);
        expect(state(x, t.id).status).toBe('expired');
        await blocks(x, 30);
        expect(record(x, t.id)).toMatchObject({ status: 'expired', settledAtMs: null });
        expect(x.logs.text()).toContain('(settle): not every RPC shows the outcome final and canonical');
        lie = false; // control: the second RPC shows the truth (the cancel took the nonce; the call never ran)
        await tick(x);
        expect(record(x, t.id).settledAtMs).not.toBeNull();
        expect(record(x, t.id).signature).toBeNull();
    });
});

describe('undoing a mined outcome: every RPC must confirm', () => {
    // The freshness bar of an undo is the relay's clock when it recorded the outcome: each RPC's head must be made after
    // it, by its timestamp. The block number of the receipt is no such bar, because a single RPC reported it. The lagging
    // RPC here lags in time, as a real one does.
    it("after a reorg on every RPC the request goes back in flight, but not while an RPC's head was not made after the moment the relay recorded the outcome (it may not have seen the inclusion yet)", async () => {
        const x = await setup(withStuckAfter10);
        let lagging: BlockInfo | undefined;
        const view = x.chain.rpcView();
        secondRpc(x, { getBlock: async (tag): Promise<BlockInfo> => (lagging && tag === 'latest' ? lagging : view.getBlock(tag)) });
        const t = await queue(x);
        await tick(x);
        const before = await view.getBlock('latest'); // block 1000, at START_TIME
        x.chain.mine(); // block 1001, 2 s later: the call is included
        x.clock.advance(2); // the relay's clock follows the chain
        await tick(x);
        expect(state(x, t.id).status).toBe('mined'); // recorded at START_TIME + 2 s
        const inclusion = await view.getBlock('latest'); // block 1001, of the same second as the recording
        const [call] = x.store.listAttempts(t.id);
        lagging = before; // RPC #2 lags behind the inclusion: its head is block 1000
        x.chain.reorg(call!.hash); // gone on every RPC; back in the mempool
        x.chain.includeFilter = () => false; // and not included again
        await blocks(x, 3);
        expect(record(x, t.id)).toMatchObject({ status: 'mined', reopenedAtMs: null });
        lagging = { ...before, number: before.number + 1_000_000n }; // a higher block number does not make it newer
        await blocks(x, 1);
        expect(record(x, t.id)).toMatchObject({ status: 'mined', reopenedAtMs: null });
        lagging = inclusion; // a head of the very second of the recording is not made after it (timestamps are seconds)
        await blocks(x, 1);
        expect(record(x, t.id)).toMatchObject({ status: 'mined', reopenedAtMs: null });
        lagging = undefined; // control: RPC #2 catches up
        await tick(x);
        expect(record(x, t.id).status).toBe('submitted');
        expect(record(x, t.id).reopenedAtMs).not.toBeNull();
    });
});

describe("the relay's nonce range: a single RPC's answer is never stored", () => {
    /** RPC #2's relay-account nonces: `latest`/`pending` offsets over the chain's, or 'down'. */
    function secondNonces(x: Harness, answer: () => 'down' | { latest?: number; pending?: number }): void {
        const view = x.chain.rpcView();
        secondRpc(x, {
            getTransactionCount: async (address, tag) => {
                const a = answer();
                if (a === 'down') throw new Error('timeout');
                const set = tag === 'latest' ? a.latest : a.pending;
                return isRelay(address) && set !== undefined ? set : view.getTransactionCount(address, tag);
            },
        });
    }

    /** The first RPC (the relay's own client) reports `extra` pending transactions of the relay key above its latest nonce. */
    function firstPendingExtra(x: Harness, extra: number): void {
        const count = x.chain.getTransactionCount.bind(x.chain);
        x.chain.getTransactionCount = async (address, tag) => (tag === 'pending' && isRelay(address) ? (await count(address, 'latest')) + extra : count(address, tag));
    }

    it('recover: a fresh database needs the nonce from every RPC (startup fails otherwise) and starts at the lowest pending count; a stored one is raised only when every RPC answers', async () => {
        h = await createHarness();
        const x = h;
        let second: 'down' | { pending: number } = 'down';
        secondNonces(x, () => second);
        firstPendingExtra(x, 5);
        await expect(x.relay.txManager.recover()).rejects.toThrow('the relay account nonce could not be read from every RPC in RELAY_RPC_URLS');
        expect(x.store.getNextNonce()).toBeUndefined();
        second = { pending: 2 };
        await x.relay.txManager.recover();
        expect(x.store.getNextNonce()).toBe(2); // not 5: the second RPC holds only two
        second = 'down';
        await x.relay.txManager.recover();
        expect(x.store.getNextNonce()).toBe(2);
        expect(x.logs.text()).toContain('not every RPC answered the relay account nonce; the stored next nonce is kept');
        second = { pending: 5 }; // control: every RPC holds five
        await x.relay.txManager.recover();
        expect(x.store.getNextNonce()).toBe(5);
    });

    it('broadcast: pending transactions of the key are skipped only up to the lowest pending count of every RPC, and not while one does not answer', async () => {
        for (const [second, expected] of [
            ['down', 0],
            [{ pending: 3 }, 3],
            [{ pending: 5 }, 5], // control: every RPC holds five
        ] as const) {
            const x = await setup();
            secondNonces(x, () => second);
            firstPendingExtra(x, 5);
            const t = await queue(x);
            await tick(x);
            expect(record(x, t.id).txNonce, JSON.stringify(second)).toBe(expected);
            await h!.close();
            h = undefined;
        }
    });

    it('the next nonce is lowered (nonces re-used) only when no RPC still holds transactions there', async () => {
        const x = await setup();
        x.store.setNextNonce(3); // e.g. untracked pending transactions adopted at startup, evicted on the first RPC since
        let holds = true;
        secondNonces(x, () => (holds ? { pending: 3 } : {}));
        await tick(x);
        await tick(x);
        expect(x.store.getNextNonce()).toBe(3);
        holds = false; // control
        await tick(x);
        expect(x.store.getNextNonce()).toBe(0);
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="next_nonce_lowered"} 1');
    });

    it('gap fillers: none while an RPC does not answer; only at or above the highest latest count; at most RELAY_MAX_IN_FLIGHT per pass', async () => {
        const x = await setup();
        let second: 'down' | { latest: number } = 'down';
        secondNonces(x, () => second);
        x.store.setNextNonce(10);
        const t = await queue(x);
        await tick(x);
        expect(record(x, t.id).txNonce).toBe(10); // nonces 0 to 9 are unused: a gap below it
        await blocks(x, 25); // past RELAY_NONCE_GAP_BLOCKS (20)
        expect(fillerNonces(x)).toEqual([]);
        expect(x.relay.txManager.health().reasons).toContainEqual(expect.stringMatching(/^nonce_gap: /));
        second = { latest: 2 }; // the second RPC shows nonces 0 and 1 used already
        await blocks(x, 1);
        expect(fillerNonces(x)).toEqual([2, 3, 4, 5]); // RELAY_MAX_IN_FLIGHT is 4 here
        await blocks(x, 1);
        expect(fillerNonces(x)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="gap_filled"} 8');
        // Gap fillers are paid exposure too, even though their raw transactions are kept in memory.
        const exposureByNonce = new Map<number, bigint>();
        for (const raw of x.chain.broadcasts) {
            const tx = parseTransaction(raw);
            const cost = tx.gas! * tx.maxFeePerGas!;
            if (cost > (exposureByNonce.get(tx.nonce!) ?? 0n)) exposureByNonce.set(tx.nonce!, cost);
        }
        expect(exposureByNonce.size).toBe(9); // one call and eight distinct fillers
        expect(x.store.gasExposureWei()).toBe([...exposureByNonce.values()].reduce((a, b) => a + b, 0n));

    });
});

// The relay locates the use of an intent nonce from state, not from a window of logs around the request's life, so the
// age of the use does not limit the search. nonceUse.test.ts and txQuorum.test.ts cover the search itself; this test
// covers a long outage of the relay.
describe('the search for the use of the intent nonce reaches back as far as the use', () => {
    it('a relay outage of 20 000 blocks does not push the NonceInvalidated event out of the search', async () => {
        const x = await setup();
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n); // in block 1000
        x.chain.mineBlocks(20_000); // the relay is down meanwhile
        x.clock.advance(40_000);
        await blocks(x, 13);
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="nonce_invalidated"} 1');
    });
});

describe('the settlement work of a pass is bounded', () => {
    it('a pass checks at most SETTLE_CHECKS_PER_PASS unsettled requests, the least recently checked first; more is a settle backlog (metric and degraded, still ready)', async () => {
        const n = SETTLE_CHECKS_PER_PASS + 8;
        const x = await setup({
            settings: { admission: { maxQueued: n }, tx: { ...TEST_TX_SETTINGS, maxInFlight: n + 1, reservedPrioritySlots: 1 } },
        });
        let hide = true;
        let asked: Hex[] = [];
        const view = x.chain.rpcView();
        // While it hides the receipts, it serves no state of older blocks either: it cannot show the executions.
        secondRpc(x, {
            getTransactionReceipt: (hash) => {
                asked.push(hash);
                return hide ? Promise.resolve(null) : view.getTransactionReceipt(hash);
            },
            ...withoutHistory(x, view, () => hide),
        });
        x.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 15n);
        for (let i = 0; i < n; i++) await queue(x, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline: BigInt(x.clock.seconds() + 7000) });
        await tick(x);
        x.chain.mine();
        await tick(x);
        expect(x.store.countByStatus('mined')).toBe(n);
        await blocks(x, 17); // final through the relay's own client; the second RPC shows no receipt
        asked = [];
        await blocks(x, 1);
        const first = new Set(asked);
        asked = [];
        await blocks(x, 1);
        const second = new Set(asked);
        expect(first.size).toBe(SETTLE_CHECKS_PER_PASS);
        expect(second.size).toBe(SETTLE_CHECKS_PER_PASS);
        expect(new Set([...first, ...second]).size).toBe(n); // in turn: the ones left out come first in the next pass
        const health = x.relay.txManager.health();
        expect(health.ok).toBe(true);
        expect(health.degraded).toContain(`settle_backlog: ${n} provisional outcomes wait to settle; a pass checks ${SETTLE_CHECKS_PER_PASS} of them`);
        expect(await metrics(x)).toContain(`relay_unsettled_requests ${n}`);
        hide = false; // control: once the second RPC shows the receipts, all settle within two passes
        await blocks(x, 2);
        expect(x.store.listUnsettled()).toHaveLength(0);
        expect(x.store.countByStatus('confirmed')).toBe(n);
        expect(x.relay.txManager.health().degraded.some((d) => d.startsWith('settle_backlog'))).toBe(false);
        expect(await metrics(x)).toContain('relay_unsettled_requests 0');
    });

    /**
     * SETTLE_CHECKS_PER_PASS + 8 requests are mined and final on the first RPC; the second RPC never shows their receipts
     * (it holds every settlement back) and each of its reads ends 2 s of the relay's clock after it started. In the
     * measured pass the wall clock steps back one hour at the second RPC's first read, when `step` is set. Returns that
     * pass's length on the monotonic clock and the health reasons seen during it.
     */
    async function slowPassWithClockStep(step: boolean): Promise<{ passSeconds: number; healthDuringPass: string[] }> {
        const n = SETTLE_CHECKS_PER_PASS + 8;
        const x = await setup({
            settings: { admission: { maxQueued: n }, tx: { ...TEST_TX_SETTINGS, maxInFlight: n + 1, reservedPrioritySlots: 1 } },
        });
        const { clock } = x;
        const view = x.chain.rpcView();
        let slow = false;
        let stepped = !step;
        const unhealthy = new Set<string>();
        const delayed =
            <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
            async (...args: A): Promise<R> => {
                if (!slow) return fn(...args);
                if (!stepped) {
                    stepped = true;
                    clock.advance(-3600); // an NTP correction during the pass
                }
                const done = clock.monotonicMs() + 2_000;
                await new Promise<void>((resolve) => setImmediate(resolve));
                if (clock.monotonicMs() < done) clock.advance((done - clock.monotonicMs()) / 1000);
                for (const r of x.relay.txManager.health().reasons) unhealthy.add(r.split(':')[0]!);
                return fn(...args);
            };
        secondRpc(x, {
            getBlock: delayed((tag: 'latest' | 'finalized') => view.getBlock(tag)),
            getBlockByNumber: delayed((n: bigint) => view.getBlockByNumber!(n)),
            getTransactionCount: delayed(view.getTransactionCount),
            getTransactionReceipt: delayed((): Promise<ReceiptInfo | null> => Promise.resolve(null)),
            ...withoutHistory(x, view),
        });
        x.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 15n);
        for (let i = 0; i < n; i++) await queue(x, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline: BigInt(clock.seconds() + 7000) });
        await tick(x);
        x.chain.mine();
        await tick(x);
        await blocks(x, 17); // final through the relay's own client; the second RPC shows no receipt
        slow = true;
        x.chain.mine();
        x.chain.finalized = x.chain.head.number;
        const start = clock.monotonicMs();
        await tick(x);
        return { passSeconds: (clock.monotonicMs() - start) / 1000, healthDuringPass: [...unhealthy] };
    }

    it('the read budget of a pass (RPC_READ_BUDGET_MS) runs on the monotonic clock: a backward step of the wall clock during a slow pass does not stretch it beyond the 60 s liveness limit', async () => {
        const facts = await slowPassWithClockStep(true);
        // Measured on the wall clock, the budget would end only once the wall clock had caught up: every settlement
        // read of the slow RPC would start, and the pass would take about 70 s (pass_stale).
        expect(facts.passSeconds, JSON.stringify(facts)).toBeLessThan(30);
        expect(facts.healthDuringPass).toEqual([]);
    });

    it('control: the same slow pass without a step of the clock stays within the budget as well', async () => {
        const facts = await slowPassWithClockStep(false);
        expect(facts.passSeconds, JSON.stringify(facts)).toBeLessThan(30);
        expect(facts.healthDuringPass).toEqual([]);
    });

    it('retention never deletes an unsettled request, however old', async () => {
        const x = await setup();
        secondRpc(x, { getTransactionReceipt: () => Promise.resolve(null), ...withoutHistory(x, x.chain.rpcView()) });
        const t = await queue(x);
        await tick(x);
        x.chain.mine();
        await tick(x);
        await blocks(x, 17);
        x.clock.advance(400 * 24 * 3600); // far beyond RELAY_REQUEST_RETENTION_DAYS
        await blocks(x, 1);
        expect(record(x, t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        expect(await metrics(x)).not.toMatch(/^relay_requests_pruned_total [1-9]/m);
    });
});

describe('no block number that an RPC once reported holds a decision back for good', () => {
    /** `n` blocks with a pass after each; the relay's clock follows the chain (2 s per block), the tag at the head. */
    async function timedBlocks(x: Harness, n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
            x.chain.mine();
            x.clock.advance(2);
            x.chain.finalized = x.chain.head.number;
            await tick(x);
        }
    }

    it('a second RPC that reported a far higher head when it first showed the tx nonce used: once it reports its real head, its observation starts again there, and the new tx nonce follows once that block is final', async () => {
        const x = await setup();
        let lead = 1_000_000n;
        const view = x.chain.rpcView();
        secondRpc(x, {
            getBlock: async (tag): Promise<BlockInfo> => {
                const block = await view.getBlock(tag);
                return tag === 'latest' ? { ...block, number: block.number + lead } : block;
            },
        });
        const t = await queue(x);
        await tick(x);
        x.chain.dropMempool();
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        await blocks(x, 40); // RPC #2's observation is its inflated head, which its own (true) tag never reaches
        expect(record(x, t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        lead = 0n; // it reports its real head from now on (made after the observation, by the relay's clock)
        await blocks(x, 16); // its observation starts again at the first real head, final only 16 blocks later
        expect(record(x, t.id).txNonce).toBe(0);
        await blocks(x, 1);
        expect(record(x, t.id).txNonce).toBe(1);
    });

    it('control: a stale head (older than the observation by the relay clock) does not move an observation back; the new tx nonce still waits until the observed block itself is final', async () => {
        const x = await setup();
        let behind = true;
        let stale: BlockInfo | undefined;
        const view = x.chain.rpcView();
        secondRpc(x, {
            getBlock: async (tag): Promise<BlockInfo> => (stale && tag === 'latest' ? stale : view.getBlock(tag)),
            getTransactionCount: (address, tag) => (behind ? Promise.resolve(0) : view.getTransactionCount(address, tag)),
        });
        const t = await queue(x);
        await tick(x);
        x.chain.dropMempool();
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        await timedBlocks(x, 20); // the relay's client observes the used tx nonce at block 1013; RPC #2 still shows it unused
        behind = false;
        await timedBlocks(x, 1); // RPC #2's observation: block 1021
        stale = (await view.getBlockByNumber!(1_011n))!; // one answer from a backend 10 blocks (20 s) behind
        await timedBlocks(x, 1);
        stale = undefined;
        await timedBlocks(x, 14); // head 1036: block 1013 is final, block 1021 is not (a re-base on 1011 would have let it through)
        expect(record(x, t.id).txNonce).toBe(0);
        await timedBlocks(x, 1); // head 1037: block 1021 is final on RPC #2
        expect(record(x, t.id).txNonce).toBe(1);
    });

    it("the relay client's head once reported far higher does not stop the search for the use of the intent nonce for good: the next search comes a grace period after the real head, and the nonce_used failure then settles", async () => {
        const x = await setup(withStuckAfter10);
        let down = true;
        const view = x.chain.rpcView();
        secondRpc(x, { getLogs: (filter) => (down ? Promise.reject(new Error('HTTP 429')) : view.getLogs!(filter)) });
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        await blocks(x, 12); // the grace period
        const realGetBlock = x.chain.getBlock.bind(x.chain);
        x.chain.getBlock = async (tag): Promise<BlockInfo> => {
            const block = await realGetBlock(tag);
            return tag === 'latest' ? { ...block, number: block.number + 1_000_000n } : block;
        };
        await blocks(x, 1); // the first search, at a head the relay's client reports a million blocks ahead: no RPC answers it
        x.chain.getBlock = realGetBlock;
        expect(state(x, t.id).status).toBe('submitted');
        down = false;
        await blocks(x, 13); // the next search, a grace period after the first real head
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        await blocks(x, 20); // final on every RPC, each by its own view
        expect(record(x, t.id).settledAtMs).not.toBeNull();
        expect(record(x, t.id).signature).toBeNull();
    });

    it('a request that ends in the queue after a requeue settles at its next check, without waiting for a stored block: its requeue already waited until every RPC showed its earlier tx nonce taken for good', async () => {
        const x = await setup();
        const t = await queue(x, { deadline: BigInt(x.clock.seconds() + 60) });
        await tick(x);
        x.chain.dropMempool();
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        for (let i = 0; i < 40 && record(x, t.id).status === 'submitted'; i++) await blocks(x, 1);
        // Requeued once its observation was final (block 1029), and in the same pass ended in the queue: its deadline is
        // closer than RELAY_MIN_SECONDS_TO_BROADCAST. Provisional: no RPC was asked yet.
        expect(x.chain.head.number).toBe(1_029n);
        expect(state(x, t.id)).toMatchObject({ status: 'expired', error: { code: 'deadline_out_of_range', message: expect.stringContaining('could be sent again') } });
        expect(record(x, t.id).settledAtMs).toBeNull();
        await blocks(x, 1);
        expect(record(x, t.id).settledAtMs).not.toBeNull();
        expect(record(x, t.id).signature).toBeNull();
    });
});
