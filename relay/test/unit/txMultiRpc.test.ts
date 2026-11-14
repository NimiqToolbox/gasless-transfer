// The transaction manager with several RPCs and with receipts an RPC does not serve, against the fake chain:
// decisions that need every RPC, used intent nonces without a receipt, the bound on pre-broadcast checks per pass,
// the attribution of token-signature failures, and the startup warning for a single RPC. The security tests run
// the same rules end to end; relay/docs/transaction-lifecycle.md describes the rules.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeErrorResult, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { ChainClient, ReadContractCall } from '../../src/chain/types.js';
import { toRequestState } from '../../src/http/app.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { GWEI } from '../helpers/fakeChain.js';
import {
    CONTRACT,
    TEST_TX_SETTINGS,
    USDC,
    USDT0,
    autoSender,
    buildTransfer,
    createHarness,
    restartHarness,
    sendThroughOtherRelay,
    type BuiltTransfer,
    type Harness,
    type HarnessOptions,
    type TransferOptions,
} from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, RELAY_ADDRESS, USER_ADDRESS } from '../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
    await h.relay.txManager.recover();
});

afterEach(async () => {
    await h.close();
});

async function fresh(options: HarnessOptions): Promise<void> {
    await h.close();
    h = await createHarness(options);
    await h.relay.txManager.recover();
}

/** Queues a transfer of USER, or of another sender while USER has one pending (one per sender). */
async function queue(o: TransferOptions = {}): Promise<BuiltTransfer> {
    const built = await buildTransfer(h, autoSender(h, o));
    const result = await h.relay.pipeline.submit(transferOperation, built.body);
    expect(result.statusCode).toBe(202);
    return built;
}

async function tick(): Promise<void> {
    await h.relay.txManager.tick();
    expect(h.relay.txManager.lastTickError).toBeUndefined();
}

/** `blocks` blocks with a pass after each; `finalizedLag` blocks below head is the node's finalized tag. */
async function blocks(n: number, finalizedLag = 0n): Promise<void> {
    for (let i = 0; i < n; i++) {
        h.chain.mine();
        h.chain.finalized = h.chain.head.number - finalizedLag;
        await tick();
    }
}

const state = (id: Hex) => toRequestState(h.store.getRequest(id)!, h.store.listAttempts(id));
const record = (id: Hex) => h.store.getRequest(id)!;
const metrics = () => h.metrics.registry.metrics();
const withStuckAfter10 = { settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } };

/** A second RPC in front of the same chain whose answers the test can change. */
function secondRpc(overrides: Partial<ChainClient> = {}): ChainClient {
    const view = h.chain.rpcView();
    const rpc = { ...view, ...overrides };
    h.chain.rpcClients = () => [h.chain, rpc];
    return rpc;
}

describe('decisions that need every RPC', () => {
    // The relay locates the use of an intent nonce from state, so an RPC that does not answer eth_getTransactionReceipt
    // for the call can still show its execution (its successful receipt in eth_getBlockReceipts of the block that used the
    // nonce); the second RPC here serves no state of older blocks either, so it shows neither. The control below shows the
    // execution that way.
    it('a mined request settles (confirmed, secrets purged) only once every RPC shows it final; a second RPC that shows neither its receipt nor its call in the block that used its nonce holds the purge back, with an ALERT', async () => {
        await fresh(withStuckAfter10);
        let hide = true;
        const view = h.chain.rpcView();
        secondRpc({
            getTransactionReceipt: (hash) => (hide ? Promise.resolve(null) : view.getTransactionReceipt(hash)),
            readContract: <T,>(call: ReadContractCall): Promise<T> =>
                hide && call.blockNumber !== undefined && call.blockNumber < h.chain.head.number ? Promise.reject(new Error('missing trie node')) : view.readContract<T>(call),
        });
        const t = await queue();
        await tick();
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        await blocks(16);
        expect(record(t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        expect(record(t.id).signature).not.toBeNull();
        await blocks(10);
        expect(state(t.id).status).toBe('mined');
        expect(await metrics()).toContain('relay_decision_waits_total{decision="settle"} 1');
        expect(h.logs.text()).toContain('(settle): not every RPC shows the outcome final and canonical');
        hide = false;
        await tick();
        expect(state(t.id).status).toBe('confirmed');
        expect(record(t.id).signature).toBeNull();
    });

    it('control: a second RPC that does not answer the receipt of the call for its hash shows it in the receipts of the block that used the request nonce: the request confirms when that block is final', async () => {
        secondRpc({ getTransactionReceipt: () => Promise.resolve(null) });
        const t = await queue();
        await tick();
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        await blocks(15);
        expect(record(t.id)).toMatchObject({ status: 'mined', settledAtMs: null });
        await blocks(1); // block 1001 is final (16 deep) on both RPCs
        expect(record(t.id)).toMatchObject({ status: 'confirmed', signature: null });
    });

    it('a second RPC whose finalized block is behind the inclusion delays the settlement until it catches up', async () => {
        let lagging = true;
        const view = h.chain.rpcView();
        secondRpc({
            getBlock: async (tag) => {
                const block = await view.getBlock(tag);
                return tag === 'finalized' && lagging ? { ...block, number: block.number - 100n } : block;
            },
        });
        const t = await queue();
        await tick();
        h.chain.mine();
        await tick();
        await blocks(16);
        expect(state(t.id).status).toBe('mined');
        lagging = false;
        await tick();
        expect(state(t.id).status).toBe('confirmed');
    });

    it('an outcome is not undone while another RPC still shows its transaction; the tx nonce of that outcome is not re-used', async () => {
        const t = await queue();
        await tick();
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        const [call] = h.store.listAttempts(t.id);
        secondRpc();
        // The relay's own client loses the receipt and reports the relay account's nonce unused again (a node on a
        // short fork, or a lying one); the second RPC still shows the inclusion.
        const receipt = h.chain.getTransactionReceipt.bind(h.chain);
        h.chain.getTransactionReceipt = (hash) => (hash === call!.hash ? Promise.resolve(null) : receipt(hash));
        h.chain.getTransactionCount = () => Promise.resolve(0);
        await tick();
        expect(record(t.id)).toMatchObject({ status: 'mined', reopenedAtMs: null });
        // A new request, held by its spend cap for two passes that read the relay client's nonces: the tx nonce of
        // the unsettled outcome is not re-used (the store's unique tx nonce index would make every later pass fail).
        h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
        const next = await queue({ key: OTHER_KEY });
        h.chain.mine({ baseFee: 2000n * GWEI });
        await tick();
        await tick();
        expect(record(next.id).status).toBe('queued');
        expect(h.store.getNextNonce()).toBe(1);
        h.chain.mine({ baseFee: 30n * GWEI });
        await tick();
        expect(record(next.id)).toMatchObject({ status: 'submitted', txNonce: 1 });
    });

    // An RPC that does not answer is not left out of the decision: it counts as "not yet", and the decision waits for
    // it. Otherwise taking one RPC offline would be enough to let the others decide alone.
    it('an RPC that does not answer holds the new nonce back (not yet, with an ALERT); once it answers, the request gets one when that RPC shows its observation final', async () => {
        await fresh(withStuckAfter10);
        let down = true;
        const view = h.chain.rpcView();
        secondRpc({ getBlock: (tag) => (down ? Promise.reject(new Error('down')) : view.getBlock(tag)) });
        const t = await queue();
        await tick();
        h.chain.dropMempool();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        await blocks(40);
        expect(record(t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        expect(await metrics()).not.toContain('event="requeued"');
        expect(await metrics()).toContain('relay_decision_waits_total{decision="requeue"} 1');
        expect(h.logs.text()).toContain('(requeue): not every RPC answered (RPC #2 in RELAY_RPC_URLS)');
        down = false;
        await blocks(16); // the second RPC's own observation (its head now) becomes final 16 blocks later
        expect(record(t.id).txNonce).toBe(0);
        await blocks(1);
        expect(record(t.id).txNonce).toBe(1);
        expect(await metrics()).toContain('relay_nonce_events_total{event="requeued"} 1');
    });

    it('RPCs that disagree whether the request executed hold the requeue back, with an ALERT after RELAY_STUCK_AFTER_BLOCKS', async () => {
        await fresh(withStuckAfter10);
        const view = h.chain.rpcView();
        // The second RPC shows the intent nonce used (GaslessTransfer nonces(signer) above it).
        secondRpc({
            readContract: <T,>(call: ReadContractCall): Promise<T> =>
                call.address === CONTRACT && call.functionName === 'nonces' ? Promise.resolve(10n as T) : view.readContract<T>(call),
        });
        const t = await queue();
        await tick();
        h.chain.dropMempool();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        await blocks(40);
        expect(record(t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        const text = await metrics();
        expect(text).not.toContain('event="requeued"');
        expect(text).toContain('relay_decision_waits_total{decision="requeue"} 1');
        expect(h.logs.text()).toContain('the RPCs disagree whether the request executed');
    });

    it('a request gets a new nonce only once the observation block is final (no reorg can include its first transaction)', async () => {
        const t = await queue();
        await tick();
        h.chain.dropMempool();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        await blocks(40, 1000n); // the finalized tag far behind: nothing recent is final
        expect(record(t.id).txNonce).toBe(0);
        await blocks(1);
        expect(record(t.id).txNonce).toBe(1);
    });
});

describe('used intent nonces without a receipt', () => {
    it('invalidated by the signer: failed with nonce_used, provisional until final, and the outcome holds on later passes', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        await tick();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        // A range from the request's nonce on: NonceInvalidated(signer, 0, 3).
        h.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 3n);
        await blocks(20, 64n);
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(record(t.id)).toMatchObject({ settledAtMs: null, reopenedAtMs: null });
        expect(record(t.id).signature).not.toBeNull();
        expect(await metrics()).toContain('relay_nonce_events_total{event="nonce_invalidated"} 1');
        await blocks(64, 64n);
        expect(record(t.id)).toMatchObject({ status: 'failed', reopenedAtMs: null, signature: null });
        expect(record(t.id).settledAtMs).not.toBeNull();
    });

    // "Used without a NonceInvalidated" is no evidence on its own: another version of the payment must be shown executing
    // in the block that used the nonce (here through another relay).
    it('used by another version of the payment through another relay: failed with nonce_used, provisional until final', async () => {
        await fresh({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10, maxInFlight: 2, reservedPrioritySlots: 1 } } });
        const t = await queue();
        await tick();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        await sendThroughOtherRelay(h, { nonce: BigInt(t.request.nonce) }); // GaslessTransfer emits no event for it
        await blocks(20, 64n);
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(state(t.id).error!.message).toMatch(/^Another request of the sender at this nonce executed first/);
        expect(record(t.id).settledAtMs).toBeNull();
        expect(await metrics()).toContain('relay_nonce_events_total{event="nonce_used_elsewhere"} 1');
        expect(await metrics()).not.toContain('relay_decision_waits_total{decision="nonce_evidence"}');
        // Its tx nonce is used: it holds none of the relay's in-flight slots (one here).
        h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
        const next = await queue({ key: OTHER_KEY });
        await tick();
        expect(record(next.id).status).toBe('submitted');
        await blocks(64, 64n);
        expect(record(t.id)).toMatchObject({ status: 'failed', signature: null });
        expect(record(t.id).settledAtMs).not.toBeNull();
    });

    // A used nonce that nothing in its block explains (here nonces(from) set without a transaction, as a relayTransfer
    // called by another contract would leave it) is no evidence that another request used it: a missing NonceInvalidated
    // and an empty log are not enough to fail the request with nonce_used.
    it('used without anything in its block that shows how: the request waits, with an ALERT, and never fails', async () => {
        await fresh(withStuckAfter10);
        const t = await queue();
        await tick();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        h.chain.setIntentNonce(t.request.from, BigInt(t.request.nonce) + 1n); // in block 1000, by no transaction it lists
        await blocks(80, 64n);
        expect(record(t.id)).toMatchObject({ status: 'submitted', txNonce: 0, settledAtMs: null });
        const text = await metrics();
        expect(text).toContain('relay_decision_waits_total{decision="nonce_evidence"} 1');
        expect(text).not.toContain('event="nonce_used_elsewhere"');
        expect(h.logs.text()).toContain('RPC #1 cannot tell how the request nonce was used: nothing in block 1000 shows how the nonce was used');
    });

    // The relay locates the use from state, so the call's receipt in the block that used the nonce (eth_getBlockReceipts)
    // is the execution. A receipt that no RPC answers by hash must neither keep the request waiting nor, with the logs
    // hidden as well (next test), make it fail with nonce_used.
    it("executed while no RPC answers eth_getTransactionReceipt for it: the relay's call's receipt in the block that used the nonce makes the request mined, confirmed once that block is final; nothing is re-sent", async () => {
        await fresh(withStuckAfter10);
        const t = await queue();
        await tick();
        h.chain.mine();
        const [call] = h.store.listAttempts(t.id);
        h.chain.unservedReceipts.add(call!.hash); // no RPC answers the receipt on its own; eth_getBlockReceipts lists it
        await blocks(12, 64n); // the grace period after the first observation (block 1002)
        expect(state(t.id)).toMatchObject({ status: 'submitted' });
        await blocks(1, 64n);
        expect(state(t.id)).toMatchObject({ status: 'mined', txHash: call!.hash, error: null });
        expect(record(t.id)).toMatchObject({ blockNumber: 1001n, settledAtMs: null });
        expect(await metrics()).toContain('relay_nonce_events_total{event="mined_by_nonce_search"} 1');
        expect(h.chain.broadcasts).toHaveLength(1);
        await blocks(64, 64n);
        expect(record(t.id)).toMatchObject({ status: 'confirmed', signature: null });
        // The receipt shows later: nothing changes.
        h.chain.unservedReceipts.delete(call!.hash);
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'confirmed', txHash: call!.hash });
    });

    it('executed while eth_getTransactionReceipt and the logs of the call stay hidden on every RPC, before and after finality: never failed; mined, then confirmed', async () => {
        await fresh(withStuckAfter10);
        secondRpc();
        const t = await queue();
        await tick();
        h.chain.mine();
        const [call] = h.store.listAttempts(t.id);
        h.chain.unservedReceipts.add(call!.hash);
        h.chain.logs.splice(0); // the RPCs' log index lags too
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
            await blocks(1, 64n);
            seen.add(record(t.id).status);
        }
        expect([...seen]).toEqual(['submitted', 'mined', 'confirmed']);
        expect(state(t.id)).toMatchObject({ status: 'confirmed', txHash: call!.hash, error: null });
        expect(await metrics()).not.toContain('event="nonce_used_elsewhere"');
    });

    it('the search runs at most once per RELAY_UNKNOWN_NONCE_GRACE_BLOCKS; an RPC without the state of older blocks cannot answer it, and the decision waits until it can', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        await tick();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        h.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n); // in block 1000
        const refusedAt: bigint[] = [];
        const readContract = h.chain.readContract.bind(h.chain);
        h.chain.readContract = <T,>(call: ReadContractCall): Promise<T> => {
            // The RPC serves no state below its head until block 1049.
            if (call.blockNumber !== undefined && call.blockNumber < h.chain.head.number && h.chain.head.number < 1049n) {
                refusedAt.push(h.chain.head.number);
                return Promise.reject(new Error('missing trie node'));
            }
            return readContract<T>(call);
        };
        await blocks(12 + 36); // the first search 12 blocks after the observation (block 1001), then one every 12 blocks
        expect(refusedAt).toEqual([1013n, 1025n, 1037n]);
        expect(state(t.id).status).toBe('submitted');
        await blocks(1); // block 1049: the search finds the use in block 1000
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(await metrics()).toContain('relay_nonce_events_total{event="nonce_invalidated"} 1');
    });
});

describe('pre-broadcast checks per pass', () => {
    it('at most 2 × RELAY_MAX_IN_FLIGHT queued requests are simulated in one pass', async () => {
        // Six senders queue one request each.
        await fresh({ settings: { tx: { ...TEST_TX_SETTINGS, maxInFlight: 2, reservedPrioritySlots: 1 } } });
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const ids: Hex[] = [];
        for (let i = 0; i < 6; i++) ids.push((await queue({ mode: 'none' })).id);
        h.chain.simulate = () => ({
            ok: false,
            revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, 1_010_000n] }),
            message: 'execution reverted',
        });
        const calls = h.chain.calls.length;
        await tick();
        expect(h.chain.calls.length - calls).toBe(4);
        expect(ids.map((id) => record(id).status)).toEqual(['failed', 'failed', 'failed', 'failed', 'queued', 'queued']);
        await tick();
        expect(ids.every((id) => record(id).status === 'failed')).toBe(true);
    });
});

describe('failure attribution of token signatures', () => {
    const allowanceRevert = () => ({
        ok: false as const,
        revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, 1_010_000n] }),
        message: 'execution reverted',
    });

    it('a USDC permit whose token nonce moved after acceptance (used elsewhere) is reported as invalid_token_authorization', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        h.chain.setTokenNonce(USDC, USER_ADDRESS, 1n);
        h.chain.simulate = allowanceRevert;
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'invalid_token_authorization' } });
        expect(state(t.id).error!.message).toContain('The token authorization is no longer valid on-chain');
    });

    it('a USDT0 meta-transaction approve whose token nonce moved on is reported the same way; an unchanged nonce is not attributed', async () => {
        const t = await queue({ token: USDT0, mode: 'metaTxApprove' });
        const u = await queue({ token: USDC, mode: 'permit' });
        h.chain.setTokenNonce(USDT0, USER_ADDRESS, 1n);
        h.chain.simulate = allowanceRevert;
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'invalid_token_authorization' } });
        expect(state(u.id).status).toBe('failed');
        expect(state(u.id).error?.code).not.toBe('invalid_token_authorization');
    });
});

describe('startup wiring', () => {
    it('warns when a single RPC is configured on Polygon PoS; not with two', async () => {
        h.chain.rpcClients = () => [h.chain];
        h = await restartHarness(h);
        expect(h.logs.text()).toContain('only one RPC is configured (RELAY_RPC_URLS)');
        h.chain.rpcClients = () => [h.chain, h.chain.rpcView()];
        h = await restartHarness(h);
        expect(h.logs.text()).not.toContain('only one RPC is configured');
    });
});
