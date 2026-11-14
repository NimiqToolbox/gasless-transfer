// What used a request's intent nonce while no RPC shows the receipt of the request's call (relay/docs/transaction-
// lifecycle.md, "Nonces"): every configured RPC locates the block that used the nonce from its own state
// (quorum.findNonceUse) and shows what in it did. The relay's call there on every RPC makes the request mined; it ends
// failed with nonce_used only with positive evidence on every RPC that something else used the nonce (another request
// of the sender at it, or the sender's NonceInvalidated); anything else holds the decision back, with the ALERT. The
// same evidence settles these outcomes. Against the fake chain, with a second RPC that disagrees, hides receipts or
// logs, or serves no state of older blocks, and with RPCs that cap the logs of one response under a flood of logs that
// anyone can emit. txQuorum.test.ts covers findNonceUse itself.
import { afterEach, describe, expect, it } from 'vitest';
import { RpcRequestError, TimeoutError, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseTransaction, toHex, type Address, type Hex } from 'viem';
import { AUTH_MODE_ID, gaslessTransferAbi, usdcAbi } from '@nimiq/gasless-sdk/core';
import { createLocalSigner } from '../../src/chain/signer.js';
import type { BlockWithTransactions, ChainClient, ChainLog, LogFilter, ReadContractCall } from '../../src/chain/types.js';
import { toRequestState } from '../../src/http/app.js';
import { transferOperation } from '../../src/operations/transfer.js';
import {
    CONTRACT,
    START_TIME,
    TEST_TX_SETTINGS,
    USDC,
    buildTransfer,
    createHarness,
    restartHarness,
    sendThroughOtherRelay,
    toHighS,
    type BuiltTransfer,
    type Harness,
    type HarnessOptions,
} from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, RECIPIENT_ADDRESS, RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS } from '../helpers/keys.js';
import { blocks, queue, secondRpc, tick } from '../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const withStuckAfter10: HarnessOptions = { settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } };

async function setup(options: HarnessOptions = withStuckAfter10): Promise<Harness> {
    h = await createHarness(options);
    await h.relay.txManager.recover();
    return h;
}

const state = (x: Harness, id: Hex) => toRequestState(x.store.getRequest(id)!, x.store.listAttempts(id));
const record = (x: Harness, id: Hex) => x.store.getRequest(id)!;
const metrics = (x: Harness) => x.metrics.registry.metrics();

/** `view`'s contract reads, refused below the head while `pruned()`: an RPC without the state of older blocks. */
function withoutHistory(x: Harness, view: ChainClient, pruned: () => boolean): Pick<ChainClient, 'readContract'> {
    return {
        readContract: <T,>(call: ReadContractCall): Promise<T> =>
            pruned() && call.blockNumber !== undefined && call.blockNumber < x.chain.head.number ? Promise.reject(new Error('missing trie node')) : view.readContract<T>(call),
    };
}

/**
 * The request's call executes in the next block, and from then on no RPC answers eth_getTransactionReceipt for it
 * (eth_getBlockReceipts of its block still lists its receipt).
 */
function executedWithoutReceipt(x: Harness, t: BuiltTransfer): Hex {
    const [call] = x.store.listAttempts(t.id);
    x.chain.mine();
    x.chain.unservedReceipts.add(call!.hash);
    return call!.hash;
}

describe("the relay's call in the block that used the nonce: mined by its receipt there, never failed (no RPC answers eth_getTransactionReceipt for it)", () => {
    it('an RPC without the state of older blocks cannot show it: the request waits (ALERT receipt), and is mined once that RPC shows it too; nothing is re-sent', async () => {
        const x = await setup();
        let pruned = true;
        secondRpc(x, withoutHistory(x, x.chain.rpcView(), () => pruned));
        const t = await queue(x);
        await tick(x);
        const call = executedWithoutReceipt(x, t);
        const seen = new Set<string>();
        for (let i = 0; i < 40; i++) {
            await blocks(x, 1, 64n);
            seen.add(record(x, t.id).status);
        }
        expect([...seen]).toEqual(['submitted']);
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="receipt"} 1');
        expect(x.logs.text()).toContain("an RPC shows the relay's call in the block that used the request nonce, but not every RPC serves its successful receipt there");
        // The search at block 1014 (the grace period after the first observation, block 1002) reads block 1013 first.
        expect(x.logs.text()).toContain('RPC #2 cannot tell how the request nonce was used: the RPC does not serve the state of block 1013');
        pruned = false;
        for (let i = 0; i < 90; i++) {
            await blocks(x, 1, 64n);
            seen.add(record(x, t.id).status);
        }
        expect([...seen]).toEqual(['submitted', 'mined', 'confirmed']);
        expect(state(x, t.id)).toMatchObject({ status: 'confirmed', txHash: call, error: null });
        expect(record(x, t.id).blockNumber).toBe(1001n);
        expect(x.chain.broadcasts).toHaveLength(1);
    });

    it('a mined request whose receipt every RPC stops answering on its own before it is final confirms by its receipt in the block that used its nonce', async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        x.chain.mine();
        await tick(x);
        const [call] = x.store.listAttempts(t.id);
        expect(state(x, t.id)).toMatchObject({ status: 'mined', txHash: call!.hash });
        x.chain.unservedReceipts.add(call!.hash); // the receipt nodes' transaction index lags, on every RPC
        await blocks(x, 15, 0n);
        expect(record(x, t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        await blocks(x, 1, 0n); // block 1001 is final (16 deep) on both RPCs
        expect(record(x, t.id)).toMatchObject({ status: 'confirmed', signature: null });
    });

    // Without a receipt of the call anywhere (neither on its own nor in eth_getBlockReceipts of its block) there is no
    // evidence of the execution: the mined outcome is not settled, and its secrets stay, until a receipt shows again.
    it('a mined request whose receipt no RPC serves at all stays mined and unsettled (ALERT settle) until a receipt shows again', async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        x.chain.mine();
        await tick(x);
        const [call] = x.store.listAttempts(t.id);
        const receipt = x.chain.receipts.get(call!.hash)!;
        x.chain.receipts.delete(call!.hash);
        for (let i = 0; i < 60; i++) {
            await blocks(x, 1, 0n);
            expect(record(x, t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        }
        expect(record(x, t.id).signature).not.toBeNull();
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="settle"} 1');
        x.chain.receipts.set(call!.hash, receipt);
        x.chain.unservedReceipts.add(call!.hash); // in eth_getBlockReceipts only
        await blocks(x, 1, 0n);
        expect(record(x, t.id)).toMatchObject({ status: 'confirmed', signature: null });
        expect(x.chain.broadcasts).toHaveLength(1);
    });

    // An answer of an earlier pass is re-used only while the RPC still shows the call's successful receipt in that block
    // (TxManager.stillShows); a receipt gone from every RPC after the block was located is no evidence either.
    it('the receipt in the block that used the nonce disappears after the RPCs located that block: not settled from their earlier answers; confirmed once it shows again', async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        x.chain.mine();
        await tick(x);
        const [call] = x.store.listAttempts(t.id);
        expect(state(x, t.id)).toMatchObject({ status: 'mined', txHash: call!.hash });
        x.chain.unservedReceipts.add(call!.hash); // each RPC locates the block and finds the receipt in it
        await blocks(x, 5, 0n);
        expect(x.logs.text()).not.toContain('cannot tell');
        const receipt = x.chain.receipts.get(call!.hash)!;
        x.chain.receipts.delete(call!.hash); // now no RPC shows a receipt of it at all
        for (let i = 0; i < 60; i++) {
            await blocks(x, 1, 0n);
            expect(record(x, t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        }
        expect(record(x, t.id).signature).not.toBeNull();
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="settle"} 1');
        x.chain.receipts.set(call!.hash, receipt);
        await blocks(x, 1, 0n);
        expect(record(x, t.id)).toMatchObject({ status: 'confirmed', signature: null });
    });

    // In the blocks before the contract's creation eth_call answers no data: the nonce is unused there. The search must
    // not take that for missing state of older blocks, or the first requests after a deployment would wait for good on
    // RPCs that serve every block.
    it('the call right after the deployment (the record names the block before it): mined, then confirmed; no state below the deploy block is read', async () => {
        // The first search runs at block 1018 (a grace period of 16 blocks after the first observation, block 1002): the
        // steps of 1, 2, 4 and 8 blocks reach block 1003, and the next one, 16, would read block 987, below deployBlock.
        const x = await setup({
            settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10, unknownNonceGraceBlocks: 16 } },
            deployment: (json) => {
                json.deployBlock = '990';
            },
        });
        x.chain.contractCreatedAt = 1000n;
        const view = x.chain.rpcView();
        const readAt: bigint[] = [];
        secondRpc(x, {
            readContract: <T,>(call: ReadContractCall): Promise<T> => {
                if (call.blockNumber !== undefined) readAt.push(call.blockNumber);
                return view.readContract<T>(call);
            },
        });
        const t = await queue(x);
        await tick(x);
        const call = executedWithoutReceipt(x, t); // block 1001
        const seen = new Set<string>();
        for (let i = 0; i < 120 && record(x, t.id).status !== 'confirmed'; i++) {
            await blocks(x, 1, 64n);
            seen.add(record(x, t.id).status);
        }
        expect([...seen]).toEqual(['submitted', 'mined', 'confirmed']);
        expect(state(x, t.id)).toMatchObject({ status: 'confirmed', txHash: call, error: null });
        // The search read the blocks before the creation (no code: the nonce is unused there), never below the floor.
        expect(readAt).toContain(1003n);
        expect(readAt.some((n) => n < 1000n)).toBe(true);
        expect(readAt.every((n) => n >= 990n)).toBe(true);
        expect(x.logs.text()).not.toContain('does not serve the state');
    });

    it("a NonceInvalidated that only one RPC shows in that block does not fail the request; it waits until the RPCs agree (here: the forged log is dropped)", async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        const call = executedWithoutReceipt(x, t);
        const topics = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer: t.request.from } }) as Hex[];
        const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(t.request.nonce), BigInt(t.request.nonce) + 1n]);
        const real = x.chain.getLogs.bind(x.chain);
        let forging = true;
        x.chain.getLogs = async (filter): Promise<readonly ChainLog[]> =>
            forging ? [{ address: CONTRACT, topics, data, blockNumber: filter.toBlock, blockHash: toHex(filter.toBlock, { size: 32 }), transactionHash: keccak256(toHex('forged')) }] : real(filter);
        // While it forges, that RPC also lists no receipt of the call (a successful one would decide on its own).
        const listed = x.chain.getBlockReceipts.bind(x.chain);
        x.chain.getBlockReceipts = async (n) => ((await listed(n)) ?? []).filter((r) => !(forging && r.transactionHash === call));
        await blocks(x, 40);
        expect(record(x, t.id).status).toBe('submitted');
        expect(x.logs.text()).toContain('the RPCs disagree how the request nonce was used (#1: invalidated, #2: executed)');
        forging = false;
        await blocks(x, 16); // the next search (block 1050), then the settlement
        expect(state(x, t.id)).toMatchObject({ status: 'confirmed', txHash: call });
        expect(await metrics(x)).not.toContain('event="nonce_invalidated"');
    });
});

// A request counts as executed only with a successful receipt of the relay's call on every RPC (on its own or from
// eth_getBlockReceipts of the block that used the nonce). The call listed in that block without a receipt shows
// nothing: a relayTransfer of another version called through code before it (a contract, or an EOA with an EIP-7702
// delegation calling itself) makes it revert, and nothing direct in the block shows that. Such an RPC cannot tell: the
// request waits with the ALERT; it is never failed, and never mined on the call's inclusion alone.
describe("no receipt of the relay's call on any RPC: never mined on its inclusion, never failed", () => {
    it('the call executed and every receipt of it is hidden everywhere: the request waits with the ALERT for 200 blocks; once eth_getBlockReceipts lists it again, mined, then confirmed', async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        const [call] = x.store.listAttempts(t.id);
        x.chain.mine(); // block 1001: the call executes
        const receipt = x.chain.receipts.get(call!.hash)!;
        expect(receipt.status).toBe('success');
        x.chain.receipts.delete(call!.hash);
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) {
            await blocks(x, 1, 64n);
            seen.add(record(x, t.id).status);
        }
        expect([...seen]).toEqual(['submitted']);
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="receipt"} 1');
        expect(x.logs.text()).toContain("RPC #1 cannot tell how the request nonce was used: the RPC shows the relay's call in block 1001 but serves no receipt of it");
        expect(await metrics(x)).not.toContain('event="mined_by_nonce_search"');
        // The receipt shows again, in eth_getBlockReceipts only: the next search finds it on every RPC.
        x.chain.receipts.set(call!.hash, receipt);
        x.chain.unservedReceipts.add(call!.hash);
        for (let i = 0; i < 90 && record(x, t.id).status !== 'confirmed'; i++) {
            await blocks(x, 1, 64n);
            seen.add(record(x, t.id).status);
        }
        // Mined at the next search, and, its block long final, confirmed in the same pass.
        expect([...seen]).toEqual(['submitted', 'confirmed']);
        expect(state(x, t.id)).toMatchObject({ status: 'confirmed', txHash: call!.hash, error: null });
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="mined_by_nonce_search"} 1');
        expect(x.chain.broadcasts).toHaveLength(1);
    });

    // The EIP-7702 scenario (relay/test/integration/otherVersionVia7702.test.ts runs it on anvil): another version of the
    // payment executes through code in the block, before the relay's call, which reverts; nothing direct in the block
    // shows the use.
    it.each([
        ['every receipt of the reverted call hidden everywhere', 'all'],
        ['its receipt only in eth_getBlockReceipts (reverted)', 'per-tx'],
    ] as const)("the relay's call reverted behind another version executed through code, %s: never mined, never failed; the request waits with the ALERT", async (_name, hidden) => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        const [call] = x.store.listAttempts(t.id);
        x.chain.executor = (tx) => (tx.hash === call!.hash ? 'reverted' : x.chain.defaultExecute(tx));
        x.chain.mine(); // block 1001: the relay's call reverts
        x.chain.setIntentNonce(t.request.from, BigInt(t.request.nonce) + 1n); // the other version, through code, in block 1001
        if (hidden === 'all') x.chain.receipts.delete(call!.hash);
        else x.chain.unservedReceipts.add(call!.hash);
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) {
            await blocks(x, 1, 64n);
            seen.add(record(x, t.id).status);
        }
        expect([...seen]).toEqual(['submitted']);
        expect(record(x, t.id).signature).not.toBeNull();
        const text = await metrics(x);
        expect(text).not.toContain('event="mined_by_nonce_search"');
        expect(text).toContain(hidden === 'all' ? 'relay_decision_waits_total{decision="receipt"} 1' : 'relay_decision_waits_total{decision="nonce_evidence"} 1');
        expect(x.logs.text()).toContain(
            hidden === 'all' ? "the RPC shows the relay's call in block 1001 but serves no receipt of it" : 'nothing in block 1001 shows how the nonce was used',
        );
        expect(x.chain.broadcasts).toHaveLength(1);
    });
});

// The receipts of the block that used the nonce come from one eth_getBlockReceipts per RPC. A relay named in another
// version of the payment can put hundreds of reverted copies of its call before the one that executes; one read
// decides, within a pass's read budget (RPC_READ_BUDGET_MS), however many there are. Where an RPC refuses the method,
// at most MAX_RECEIPT_READS receipts are read one by one; past that the RPC cannot tell and the request waits with the
// ALERT. Each read here costs 40 ms of the relay's clock: reading 511 receipts one by one would take 20.4 s, more than
// the 20 s budget of a pass.
describe("511 out-of-gas copies of another relay's call before the one that executes", () => {
    const READ_MS = 40;
    const METHOD_NOT_FOUND = () => new RpcRequestError({ url: 'https://rpc.invalid', body: {}, error: { code: -32601, message: 'the method eth_getBlockReceipts does not exist' } });

    /**
     * `client` whose every read costs READ_MS of the relay's clock, counted by method (receipts read on their own also by
     * hash, in `asked`); eth_getBlockReceipts refused while `refuse()`.
     */
    function slow(x: Harness, client: ChainClient, counts: Map<string, number>, asked: Hex[], refuse: () => boolean): ChainClient {
        const out: Record<string, unknown> = {};
        for (const [name, fn] of Object.entries(client)) {
            if (typeof fn !== 'function') continue;
            out[name] = async (...args: unknown[]) => {
                counts.set(name, (counts.get(name) ?? 0) + 1);
                if (name === 'getTransactionReceipt') asked.push(args[0] as Hex);
                x.clock.ms += READ_MS;
                if (name === 'getBlockReceipts' && refuse()) throw METHOD_NOT_FOUND();
                return (fn as (...a: unknown[]) => unknown)(...args);
            };
        }
        return out as unknown as ChainClient;
    }

    async function run(refused: boolean) {
        const x = await setup();
        let refuse = refused;
        const counts = [new Map<string, number>(), new Map<string, number>()];
        const asked: Hex[][] = [[], []];
        const rpcs = counts.map((c, i) => slow(x, x.chain.rpcView(), c, asked[i]!, () => refuse));
        x.chain.rpcClients = () => rpcs;
        const t = await queue(x);
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0); // a transaction outside the relay takes its tx nonce
        const other = await sendThroughOtherRelay(x, { nonce: BigInt(t.request.nonce) }, 511); // in block 1001
        const passes: string[] = [];
        let searched = 0;
        for (let i = 0; i < 40 && record(x, t.id).status === 'submitted'; i++) {
            const before = counts[0]!.get('getBlockWithTransactions') ?? 0;
            await blocks(x, 1);
            if ((counts[0]!.get('getBlockWithTransactions') ?? 0) > before) searched += 1;
            passes.push(record(x, t.id).status);
        }
        return { x, t, other, counts, asked, searched, setRefuse: (r: boolean) => (refuse = r) };
    }

    it('eth_getBlockReceipts on every RPC: failed with nonce_used at the first search, with one eth_getBlockReceipts and no receipt read on its own per RPC', async () => {
        const { x, t, other, counts, asked, searched } = await run(false);
        expect(x.chain.blockTransactions.get(1001n)).toHaveLength(512);
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used', message: expect.stringMatching(/^Another request of the sender at this nonce/) } });
        expect(searched).toBe(1);
        const copies = new Set([...other.copies, other.hash]);
        for (let i = 0; i < 2; i++) {
            // One search per RPC; the settlement check of the same pass re-uses its answer.
            expect(counts[i]!.get('getBlockWithTransactions')).toBe(1);
            expect(counts[i]!.get('getBlockReceipts')).toBe(1);
            expect(asked[i]!.filter((hash) => copies.has(hash))).toEqual([]);
        }
        expect(x.logs.text()).not.toContain('took longer than their budget');
    });

    it('an RPC that refuses eth_getBlockReceipts reads at most 16 receipts per search and cannot tell (ALERT); once it serves the method, failed with nonce_used; never failed before', async () => {
        const { x, t, other, counts, asked, setRefuse } = await run(true);
        expect(record(x, t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="nonce_evidence"} 1');
        expect(x.logs.text()).toContain('the RPC refuses eth_getBlockReceipts, and block 1001 holds more than 16 relayTransfer calls of the sender at the nonce');
        const copies = new Set([...other.copies, other.hash]);
        for (let i = 0; i < 2; i++) {
            const searches = counts[i]!.get('getBlockWithTransactions')!;
            expect(searches).toBeGreaterThanOrEqual(2);
            // One refused eth_getBlockReceipts and at most 16 receipts of the other relay's calls per search.
            expect(counts[i]!.get('getBlockReceipts')).toBe(searches);
            expect(asked[i]!.filter((hash) => copies.has(hash))).toHaveLength(16 * searches);
        }
        expect(x.logs.text()).not.toContain('took longer than their budget');
        setRefuse(false);
        await blocks(x, 12); // the next search
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
    });

    // Past MAX_RECEIPT_READS the block's NonceInvalidated events still decide. A covering invalidation proves that no
    // call used the nonce, so the request fails instead of waiting with the ALERT for good.
    it("an RPC that refuses eth_getBlockReceipts, 17 reverted copies of another relay's call and the sender's invalidation in the block that used the nonce: failed with nonce_used (invalidated)", async () => {
        const x = await setup();
        const refused = { getBlockReceipts: () => Promise.reject(METHOD_NOT_FOUND()) };
        const asked: Hex[] = [];
        const rpcs = [0, 1].map((): ChainClient => {
            const view = x.chain.rpcView();
            return { ...view, ...refused, getTransactionReceipt: (hash) => (asked.push(hash), view.getTransactionReceipt(hash)) };
        });
        x.chain.rpcClients = () => rpcs;
        const t = await queue(x);
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0); // a transaction outside the relay takes its tx nonce
        const other = await sendThroughOtherRelay(x, { nonce: BigInt(t.request.nonce) }, 17);
        const execute = x.chain.executor;
        x.chain.executor = (tx) => (tx.hash === other.hash ? 'reverted' : execute(tx)); // the call reverts as well
        x.chain.mine(); // block 1001: 18 reverted calls
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n); // and the sender's invalidation, in block 1001
        expect(x.chain.blockTransactions.get(1001n)).toHaveLength(18);
        await blocks(x, 40);
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used', message: expect.stringContaining('invalidated') } });
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="nonce_invalidated"} 1');
        // Each RPC read 16 receipts of the calls one by one, then the block's NonceInvalidated events.
        const copies = new Set([...other.copies, other.hash]);
        expect(asked.filter((hash) => copies.has(hash)).length).toBeGreaterThanOrEqual(2 * 16);
        expect(x.logs.text()).not.toContain('cannot tell how the request nonce was used');
    });
});

// Consistency checks of the evidence for the use of an intent nonce: what an RPC shows must fit the block that used
// the nonce and the call the relay stored, or it decides nothing.
describe('the evidence of a use must be of the block that used the nonce, and of the stored call', () => {
    it("an RPC that serves the receipt of another request's call in another block than the one that used the nonce (an inconsistent backend): its earlier answer is not re-used, and the failure does not settle", async () => {
        const x = await setup();
        let skewed = false;
        let other: Hex | undefined;
        const view = x.chain.rpcView();
        secondRpc(x, {
            getTransactionReceipt: async (hash) => {
                const receipt = await view.getTransactionReceipt(hash);
                const next = receipt ? receipt.blockNumber + 1n : 0n;
                return skewed && receipt && hash === other ? { ...receipt, blockNumber: next, blockHash: toHex(next, { size: 32 }) } : receipt;
            },
            getBlockReceipts: async (n) => (await view.getBlockReceipts!(n))?.filter((r) => !(skewed && r.transactionHash === other)) ?? null,
        });
        const t = await queue(x);
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        other = (await sendThroughOtherRelay(x, { nonce: BigInt(t.request.nonce) })).hash; // in block 1001
        await blocks(x, 13, 1000n); // decided; nothing is final yet
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        skewed = true;
        for (let i = 0; i < 40; i++) await blocks(x, 1);
        expect(record(x, t.id)).toMatchObject({ status: 'failed', settledAtMs: null });
        expect(record(x, t.id).signature).not.toBeNull();
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="settle"} 1');
        skewed = false;
        await blocks(x, 2);
        expect(record(x, t.id).settledAtMs).not.toBeNull();
    });

    it("an RPC that shows another call of the relay key executing the request in that block holds the settlement of the stored call back", async () => {
        const x = await setup();
        let swapped = true;
        let call: Hex | undefined;
        const another = keccak256(toHex('another call of the relay key'));
        const view = x.chain.rpcView();
        secondRpc(x, {
            getTransactionReceipt: (hash) => (swapped && hash === call ? Promise.resolve(null) : view.getTransactionReceipt(hash)),
            getBlockWithTransactions: async (n) => {
                const block = await view.getBlockWithTransactions!(n);
                return block && swapped ? { ...block, transactions: block.transactions.map((tx) => (tx.hash === call ? { ...tx, hash: another } : tx)) } : block;
            },
            getBlockReceipts: async (n) => (await view.getBlockReceipts!(n))?.map((r) => (swapped && r.transactionHash === call ? { ...r, transactionHash: another } : r)) ?? null,
        });
        const t = await queue(x);
        await tick(x);
        call = x.store.listAttempts(t.id)[0]!.hash;
        x.chain.mine(); // block 1001
        await tick(x);
        expect(state(x, t.id)).toMatchObject({ status: 'mined', txHash: call });
        for (let i = 0; i < 40; i++) {
            await blocks(x, 1, 0n);
            expect(record(x, t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        }
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="settle"} 1');
        swapped = false;
        await blocks(x, 1, 0n);
        expect(state(x, t.id)).toMatchObject({ status: 'confirmed', txHash: call });
    });

    // A reorg puts another transaction of the relay key with the request's call (a speed-up) in place of the stored one,
    // while no RPC answers eth_getTransactionReceipt for either. Every RPC shows the other call executing the request, so
    // the request is mined by it instead of waiting with the ALERT for good under the stored call's hash.
    it('a reorg replaces the stored call by another call of the relay key, no RPC answers either on its own: mined by that call, then confirmed', async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        const [call] = x.store.listAttempts(t.id);
        x.chain.mine(); // block 1001
        await tick(x);
        expect(state(x, t.id)).toMatchObject({ status: 'mined', txHash: call!.hash });
        const sent = parseTransaction(x.chain.broadcasts[0]!);
        x.chain.reorg(call!.hash);
        const raw = await createLocalSigner(RELAY_KEY).signTransaction({
            type: 'eip1559',
            chainId: x.chain.chainId,
            nonce: 0,
            to: sent.to!,
            data: sent.data!,
            value: 0n,
            gas: sent.gas!,
            maxFeePerGas: sent.maxFeePerGas! * 2n,
            maxPriorityFeePerGas: sent.maxPriorityFeePerGas! * 2n,
        });
        expect((await x.chain.sendRawTransaction(raw)).kind).toBe('accepted');
        const speedUp = keccak256(raw);
        x.chain.unservedReceipts.add(call!.hash);
        x.chain.unservedReceipts.add(speedUp);
        x.chain.mine(); // block 1002: the other call executes the request
        for (let i = 0; i < 60 && record(x, t.id).status !== 'confirmed'; i++) await blocks(x, 1, 0n);
        expect(state(x, t.id)).toMatchObject({ status: 'confirmed', txHash: speedUp });
        expect(record(x, t.id).blockNumber).toBe(1002n);
        expect(x.logs.text()).toContain("every RPC shows another of the relay's calls of the request executing it: the request is mined by that call");
    });
});

describe('another request of the sender used the nonce (nonce_used): every RPC must show it executing', () => {
    it("an RPC that does not serve the receipt of that request's call cannot tell: the request waits (ALERT); once it serves it, failed with nonce_used, settled once final", async () => {
        const x = await setup();
        let hide = true;
        let other: Hex | undefined;
        const view = x.chain.rpcView();
        secondRpc(x, {
            getTransactionReceipt: (hash) => (hide && hash === other ? Promise.resolve(null) : view.getTransactionReceipt(hash)),
            getBlockReceipts: async (n) => (await view.getBlockReceipts!(n))?.filter((r) => !(hide && r.transactionHash === other)) ?? null,
        });
        const t = await queue(x);
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0); // a transaction outside the relay takes its tx nonce
        other = (await sendThroughOtherRelay(x, { nonce: BigInt(t.request.nonce) })).hash; // in block 1001
        await blocks(x, 40);
        expect(record(x, t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="nonce_evidence"} 1');
        expect(x.logs.text()).toContain('RPC #2 cannot tell how the request nonce was used: the RPC does not serve the receipts of the relayTransfer calls in block 1001');
        hide = false;
        await blocks(x, 12); // the next search
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used', message: expect.stringMatching(/^Another request of the sender at this nonce/) } });
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="nonce_used_elsewhere"} 1');
        await blocks(x, 40);
        expect(record(x, t.id)).toMatchObject({ status: 'failed', signature: null });
        expect(record(x, t.id).settledAtMs).not.toBeNull();
    });

    it('an RPC that shows another use (here the block after the deadline) holds the failure back; control: once it agrees, failed', async () => {
        const x = await setup();
        let lie = true;
        const view = x.chain.rpcView();
        secondRpc(x, {
            getBlockWithTransactions: async (n): Promise<BlockWithTransactions | null> => {
                const block = await view.getBlockWithTransactions!(n);
                return block && lie ? { ...block, timestamp: block.timestamp + 100_000n } : block;
            },
        });
        const t = await queue(x);
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        await sendThroughOtherRelay(x, { nonce: BigInt(t.request.nonce) });
        await blocks(x, 40);
        expect(record(x, t.id).status).toBe('submitted');
        expect(x.logs.text()).toContain('the RPCs disagree how the request nonce was used (#1: other, #2: late)');
        lie = false;
        await blocks(x, 12);
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
    });

    // The use after the deadline that every RPC shows, through the transaction manager to its end and settlement.
    it('the nonce used by another version only after the deadline (a foreign transaction took the tx nonce): expired, then settled', async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x, { deadline: BigInt(START_TIME + 600) });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0); // a transaction outside the relay takes its tx nonce (block 1000)
        x.chain.mine({ timestampDelta: 700 }); // block 1001: past the deadline
        await tick(x);
        await sendThroughOtherRelay(x, { nonce: BigInt(t.request.nonce), deadline: BigInt(START_TIME + 5000) }); // in block 1002
        const seen: string[] = [];
        for (let i = 0; i < 60; i++) {
            await blocks(x, 1, 16n);
            const status = record(x, t.id).status;
            if (seen.at(-1) !== status) seen.push(status);
        }
        expect(seen).toEqual(['submitted', 'expired']);
        expect(state(x, t.id)).toMatchObject({
            status: 'expired',
            error: { code: 'deadline_out_of_range', message: 'The deadline passed before the request executed (its nonce was used after the deadline)' },
        });
        expect(record(x, t.id)).toMatchObject({ signature: null });
        expect(record(x, t.id).settledAtMs).not.toBeNull();
        expect(x.logs.text()).toContain('the request nonce was used after its deadline and another transaction took its tx nonce');
    });

    it('a call of another request that reverted did not use the nonce: no evidence (the request waits)', async () => {
        const x = await setup();
        secondRpc(x);
        const t = await queue(x);
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        const { hash } = await sendThroughOtherRelay(x, { nonce: BigInt(t.request.nonce) });
        x.chain.executor = (tx) => (tx.hash === hash ? 'reverted' : x.chain.defaultExecute(tx));
        x.chain.mine(); // block 1001: the other relay's call reverts
        x.chain.setIntentNonce(t.request.from, BigInt(t.request.nonce) + 1n); // and something nothing in the block shows uses the nonce
        await blocks(x, 40);
        expect(record(x, t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        expect(x.logs.text()).toContain('nothing in block 1001 shows how the nonce was used');
        expect(await metrics(x)).not.toContain('event="nonce_used_elsewhere"');
    });
});

describe('the sender invalidated the nonce (nonce_used): every RPC must show its NonceInvalidated in the block that used it', () => {
    it('an RPC without the state of older blocks cannot tell (ALERT); once it serves it, failed with nonce_used', async () => {
        const x = await setup();
        let pruned = true;
        secondRpc(x, withoutHistory(x, x.chain.rpcView(), () => pruned));
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 3n); // in block 1000
        await blocks(x, 40);
        expect(record(x, t.id).status).toBe('submitted');
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="nonce_evidence"} 1');
        expect(x.logs.text()).toContain('RPC #2 cannot tell how the request nonce was used: the RPC does not serve the state of block 1012');
        pruned = false;
        await blocks(x, 12);
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used', message: expect.stringContaining('invalidated') } });
        expect(await metrics(x)).toContain('relay_nonce_events_total{event="nonce_invalidated"} 1');
    });

    it('an RPC whose logs do not show the NonceInvalidated in that block cannot tell (nothing in the block shows the use): the request waits', async () => {
        const x = await setup();
        let lost = true;
        const view = x.chain.rpcView();
        secondRpc(x, { getLogs: (filter) => (lost ? Promise.resolve([]) : view.getLogs!(filter)) });
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        await blocks(x, 40);
        expect(record(x, t.id).status).toBe('submitted');
        expect(x.logs.text()).toContain('RPC #2 cannot tell how the request nonce was used: nothing in block 1000 shows how the nonce was used');
        lost = false;
        await blocks(x, 12);
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
    });

    it('a failure settles only with that evidence on every RPC: after a restart (nothing cached) an RPC that serves no state of older blocks holds it back (ALERT settle)', async () => {
        let x = await setup();
        let pruned = false;
        secondRpc(x, withoutHistory(x, x.chain.rpcView(), () => pruned));
        const t = await queue(x, { token: USDC, mode: 'permit' });
        await tick(x);
        x.chain.consumeNonce(RELAY_ADDRESS, 0);
        x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        await blocks(x, 13, 1000n); // decided; nothing is final yet
        expect(state(x, t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        pruned = true;
        x = h = await restartHarness(x, withStuckAfter10);
        await x.relay.txManager.recover();
        await blocks(x, 40);
        expect(record(x, t.id)).toMatchObject({ status: 'failed', settledAtMs: null });
        expect(record(x, t.id).signature).not.toBeNull();
        expect(await metrics(x)).toContain('relay_decision_waits_total{decision="settle"} 1');
        pruned = false;
        for (let i = 0; i < 20 && record(x, t.id).settledAtMs === null; i++) await blocks(x, 1);
        expect(record(x, t.id)).toMatchObject({ status: 'failed', signature: null, error: { code: 'nonce_used' } });
        expect(record(x, t.id).settledAtMs).not.toBeNull();
    });
});

// A state read that times out is no answer of the RPC, not missing state of an older block: the RPC counts as not
// answering for the rest of the pass. Otherwise each request's search in the pass would wait for its own timeout.
describe('a state read of the search that times out', () => {
    it('makes the RPC silent for the rest of the pass: one timeout per pass, not one per request; once it answers, every request is mined', async () => {
        const x = await setup();
        const view = x.chain.rpcView();
        let armed = false;
        let timeouts = 0;
        x.chain.rpcClients = () => [
            x.chain,
            {
                ...view,
                readContract: <T,>(call: ReadContractCall): Promise<T> => {
                    if (!armed || call.blockNumber === undefined || call.blockNumber >= x.chain.head.number) return view.readContract<T>(call);
                    timeouts++;
                    x.clock.ms += 5_000; // RELAY_RPC_TIMEOUT_MS on the relay's clock
                    return Promise.reject(new TimeoutError({ body: {}, url: 'https://rpc.invalid' }));
                },
            },
        ];
        const ts: BuiltTransfer[] = [];
        for (let i = 0; i < 3; i++) ts.push(await queue(x));
        for (let i = 0; i < 6 && ts.some((t) => x.store.listAttempts(t.id).length === 0); i++) await tick(x);
        expect(ts.map((t) => record(x, t.id).status)).toEqual(['submitted', 'submitted', 'submitted']);
        x.chain.mine(); // block 1001: the calls execute
        for (const t of ts) for (const a of x.store.listAttempts(t.id)) x.chain.unservedReceipts.add(a.hash);
        armed = true;
        const perPass: number[] = [];
        for (let i = 0; i < 16; i++) {
            const before = timeouts;
            await blocks(x, 1, 64n);
            if (timeouts > before) perPass.push(timeouts - before);
        }
        expect(perPass.length).toBeGreaterThan(0);
        expect(perPass.every((n) => n === 1)).toBe(true);
        expect(x.logs.text()).toContain('an RPC does not answer');
        expect(ts.map((t) => record(x, t.id).status)).toEqual(['submitted', 'submitted', 'submitted']);
        armed = false;
        for (let i = 0; i < 30 && ts.some((t) => record(x, t.id).status === 'submitted'); i++) await blocks(x, 1, 64n);
        expect(ts.map((t) => record(x, t.id).status)).toEqual(['mined', 'mined', 'mined']);
    });
});

describe("a flood of logs that anyone can emit changes neither the transaction manager's reads nor the outcome", () => {
    /** Every request of a client counted by method. */
    function counting(client: ChainClient, counts: Map<string, number>): ChainClient {
        const out: Record<string, unknown> = {};
        for (const [name, fn] of Object.entries(client)) {
            if (typeof fn !== 'function') continue;
            out[name] = (...args: unknown[]) => {
                counts.set(name, (counts.get(name) ?? 0) + 1);
                return (fn as (...a: unknown[]) => unknown)(...args);
            };
        }
        return out as unknown as ChainClient;
    }

    /** Refuses an eth_getLogs answer of more than 5 logs, as providers that cap the logs of a response do. */
    function cap(getLogs: (filter: LogFilter) => Promise<readonly ChainLog[]>): (filter: LogFilter) => Promise<readonly ChainLog[]> {
        return async (filter) => {
            const logs = await getLogs(filter);
            if (logs.length > 5) throw new Error('query returned more than 5 results');
            return logs;
        };
    }

    /**
     * Zero-amount Transfer(sender → someone) logs of USDC (transferFrom of 0 needs no allowance) and other accounts'
     * NonceInvalidated events whose ranges cover the nonce, 500 and 50 per block, in blocks 995 to 1005.
     */
    function flood(x: Harness, sender: Address, nonce: bigint): void {
        for (let n = 995n; n <= 1005n; n++) {
            for (let i = 0; i < 500; i++) {
                x.chain.logs.push({
                    address: USDC,
                    topics: encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer', args: { from: sender, to: `0x${(0xe000 + i).toString(16).padStart(40, '0')}` } }) as Hex[],
                    data: encodeAbiParameters([{ type: 'uint256' }], [0n]),
                    blockNumber: n,
                    blockHash: toHex(n, { size: 32 }),
                    transactionHash: keccak256(toHex(`flood ${n} ${i}`)),
                });
            }
            for (let i = 0; i < 50; i++) {
                const signer = `0x${(0xb000 + i).toString(16).padStart(40, '0')}` as Address;
                x.chain.logs.push({
                    address: CONTRACT,
                    topics: encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer } }) as Hex[],
                    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, nonce + 1n]),
                    blockNumber: n,
                    blockHash: toHex(n, { size: 32 }),
                    transactionHash: keccak256(toHex(`foreign ${n} ${i}`)),
                });
            }
        }
    }

    /**
     * RELAY_RPC_URLS=<two RPCs in front of the chain>, with or without the flood; these RPCs and the relay's own client
     * cap the logs of a response at 5. The request's call executes while no RPC shows its receipt (`executed`), or the
     * sender invalidates the nonce after a transaction outside the relay took the tx nonce. Returns the outcome, the
     * requests of each RPC by method, and whether a read was refused for its size.
     */
    async function run(kind: 'executed' | 'invalidated', withFlood: boolean) {
        const x = await setup();
        x.chain.getLogs = cap(x.chain.getLogs.bind(x.chain));
        const counts = [new Map<string, number>(), new Map<string, number>()];
        const rpcs = counts.map((c) => {
            const view = x.chain.rpcView();
            return counting({ ...view, getLogs: cap(view.getLogs!) }, c);
        });
        x.chain.rpcClients = () => rpcs;
        const t = await queue(x);
        await tick(x);
        if (withFlood) flood(x, t.request.from, BigInt(t.request.nonce));
        if (kind === 'executed') executedWithoutReceipt(x, t);
        else {
            x.chain.consumeNonce(RELAY_ADDRESS, 0);
            x.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        }
        await blocks(x, 40);
        const outcome = state(x, t.id);
        const result = {
            status: outcome.status,
            code: outcome.error?.code ?? null,
            requests: counts.map((c) => Object.fromEntries([...c].sort(([a], [b]) => a.localeCompare(b)))),
            refused: x.logs.text().includes('more than 5 results'),
        };
        await x.close();
        h = undefined;
        return result;
    }

    it("the relay's call executed while no RPC shows its receipt: confirmed, with the same requests as without the flood", async () => {
        const flooded = await run('executed', true);
        const plain = await run('executed', false);
        expect(flooded).toMatchObject({ status: 'confirmed', code: null, refused: false });
        expect(flooded).toEqual(plain);
        // One eth_getLogs of the block that used the nonce per RPC for the search, and one per settlement check.
        expect(flooded.requests.every((r) => (r.getLogs ?? 0) <= 2)).toBe(true);
    });

    it('the sender invalidated the nonce: failed with nonce_used and settled, with the same requests as without the flood', async () => {
        const flooded = await run('invalidated', true);
        const plain = await run('invalidated', false);
        expect(flooded).toMatchObject({ status: 'failed', code: 'nonce_used', refused: false });
        expect(flooded).toEqual(plain);
    });
});

describe('OperationDefinition.executionOf (transfer): the request a relayTransfer call executes at a nonce', () => {
    /** The calldata of relayTransfer for `t` (as the relay encodes it), with `signature` instead of its own. */
    function callOf(t: BuiltTransfer, signature: Hex = t.body.signature): Hex {
        const r = t.request;
        const a = t.authorization;
        return encodeFunctionData({
            abi: gaslessTransferAbi,
            functionName: 'relayTransfer',
            args: [
                { token: r.token, from: r.from, to: r.to, amount: BigInt(r.amount), fee: BigInt(r.fee), relay: r.relay, deadline: BigInt(r.deadline) },
                signature,
                { mode: AUTH_MODE_ID[a.mode], v: a.v, r: a.r, s: a.s },
            ],
        });
    }

    it("recognizes the relay's call of a request (its id) and another version of the payment for another relay; nothing else", async () => {
        const x = await setup();
        const { ctx } = x.relay;
        const t = await buildTransfer(x, { nonce: 4n });
        const encoded = transferOperation.encodeCall(ctx, transferOperation.restore({ request: t.body.request, signature: t.body.signature, authorization: t.body.authorization }));
        expect(await transferOperation.executionOf(ctx, encoded, 4n)).toEqual({ id: t.id, signer: USER_ADDRESS, relay: RELAY_ADDRESS });
        const other = await buildTransfer(x, { nonce: 4n, relay: OTHER_ADDRESS, fee: 30_000n, mode: 'none' });
        expect(await transferOperation.executionOf(ctx, { to: CONTRACT, data: callOf(other) }, 4n)).toEqual({ id: other.id, signer: USER_ADDRESS, relay: OTHER_ADDRESS });
        // At another nonce the signature recovers to another account: that call did not use nonce 5.
        expect((await transferOperation.executionOf(ctx, encoded, 5n))?.signer).not.toBe(USER_ADDRESS);
        // Signed by another key; a high-s signature (the contract refuses it); another contract; another function.
        const stranger = await buildTransfer(x, { nonce: 4n, signWith: OTHER_KEY });
        expect((await transferOperation.executionOf(ctx, { to: CONTRACT, data: callOf(stranger) }, 4n))?.signer).toBe(OTHER_ADDRESS);
        expect(await transferOperation.executionOf(ctx, { to: CONTRACT, data: callOf(t, toHighS(t.body.signature)) }, 4n)).toBeUndefined();
        expect(await transferOperation.executionOf(ctx, { to: RECIPIENT_ADDRESS, data: encoded.data }, 4n)).toBeUndefined();
        const invalidate = encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [9n] });
        expect(await transferOperation.executionOf(ctx, { to: CONTRACT, data: invalidate }, 4n)).toBeUndefined();
    });
});
