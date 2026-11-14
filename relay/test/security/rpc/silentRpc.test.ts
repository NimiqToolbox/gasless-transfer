// One missed read of the honest RPC does not let a lying RPC decide alone.
//
// The decisions that cannot be undone, or that cost a second transaction, ask every configured RPC (spec §6.5,
// "Several RPCs"; relay/docs/transaction-lifecycle.md). If an RPC that does not answer were simply left out, the liar
// would decide alone whenever the honest RPC misses a read, and public RPC endpoints time out and rate-limit (429)
// often enough for a liar that waits for it. So each of these decisions needs a positive answer from every configured
// RPC in the same pass: an RPC that does not answer, answers with an error, or has not seen the state yet counts as
// "not yet", and the relay waits (and alerts after RELAY_STUCK_AFTER_BLOCKS).
//
// Three decisions, each with the liar first in RELAY_RPC_URLS and an honest, up-to-date second RPC that misses one
// read:
// - requeue (TxManager.nonceUsedWithoutReceipt): the liar hides the receipt of an executed call and shows the request's
//   intent nonce unused; the honest RPC's head read times out in one pass after the grace period. A second call would
//   revert on-chain, and the executed request would settle as `failed`;
// - undo (TxManager.receiptElsewhere, resolvedWithoutReceipt): the liar hides the receipt of a `mined` request and
//   shows the relay's tx nonce unused; the honest RPC's receipt read fails once. Back in flight, the request would be
//   re-simulated on the liar and a cancel signed for a transfer that executed;
// - POL/USD (ChainlinkPriceSource): the liar answers a wrong price inside the accepted band; the honest RPC's feed
//   read fails once. The liar's price would be the spend cap and break-even for the price cache period
//   (RELAY_PRICE_CACHE_SECONDS). A refresh without an answer from every RPC, or with readings that disagree, rejects
//   pricing instead (PriceUnavailableError) until a reading every RPC agrees on is available.
//
// Each scenario has a control in which the honest RPC answers every read.
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { CallOutcome, ChainClient, ReadContractCall, ReceiptInfo } from '../../../src/chain/types.js';
import { ChainlinkPriceSource, PriceUnavailableError, type PriceReading } from '../../../src/fees/priceSource.js';
import { CONTRACT, START_TIME, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { RECIPIENT_ADDRESS, USER_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { counter, intentNonceUsed, isRelayTransferFor, relayCallNonces } from '../helpers/relayObservations.js';
import { drive } from '../helpers/finalizedChain.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** An honest RPC in front of the fake chain whose reads fail while `down` names them (a timeout, a 429). */
function flakyHonest(harness: Harness): { rpc: ChainClient; down: Set<string> } {
    const view = harness.chain.rpcView({ feedAnswer: HONEST_ANSWER });
    const down = new Set<string>();
    const fail = (method: string) => Promise.reject(new Error(`timeout (${method})`));
    const rpc: ChainClient = {
        ...view,
        getBlock: (tag) => (down.has('getBlock') ? fail('getBlock') : view.getBlock(tag)),
        getTransactionReceipt: (hash) => (down.has('getTransactionReceipt') ? fail('getTransactionReceipt') : view.getTransactionReceipt(hash)),
        readContract: <T>(c: ReadContractCall): Promise<T> => (down.has(`read:${c.functionName}`) ? fail(c.functionName) : view.readContract<T>(c)),
    };
    return { rpc, down };
}

/** A NONE transfer the honest chain executes at tx nonce 0; the relay has it mined only if `resolve`. */
async function executed(harness: Harness, resolve: boolean): Promise<{ id: Hex; intentNonce: string; signature: Hex; call1: Hex }> {
    harness.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
    const t = await queue(harness, { token: USDC, mode: 'none', amount: 1_000_000n, fee: 10_000n });
    await tick(harness);
    const [call1] = harness.store.listAttempts(t.id);
    harness.chain.mine();
    if (resolve) {
        await tick(harness);
        expect(stateOf(harness, t.id).status).toBe('mined');
    }
    expect(harness.chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(1_000_000n);
    return { id: t.id, intentNonce: t.request.nonce, signature: t.body.signature, call1: call1!.hash };
}

/** The relay's own client (the chain object, first RPC) hides the call's receipt. */
function liarHidesReceipt(harness: Harness, call1: Hex): void {
    const realReceipt = harness.chain.getTransactionReceipt.bind(harness.chain);
    harness.chain.getTransactionReceipt = async (hash: Hex): Promise<ReceiptInfo | null> =>
        hash.toLowerCase() === call1.toLowerCase() ? null : realReceipt(hash);
}

const FEED = '0x0000000000000000000000000000000000000FEE0' as const;
const LIAR_ANSWER = 1_000_000n; // 0.01 USD/POL, the lowest price the relay accepts
const HONEST_ANSWER = 11_210_000n; // 0.1121 USD/POL

describe('one missed read of the honest RPC does not let a lying first RPC decide alone', () => {
    async function requeueScenario(missOneRead: boolean) {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { id, intentNonce, signature, call1 } = await executed(h, false);
        const { rpc: honest, down } = flakyHonest(h);
        const { chain } = h;
        chain.rpcClients = () => [chain, honest]; // RELAY_RPC_URLS=<liar>,<honest>
        liarHidesReceipt(h, call1);
        // The liar: nonces(sender) still at the intent nonce (unused), and the call would still succeed.
        const realRead = chain.readContract.bind(chain);
        chain.readContract = (async <T>(c: ReadContractCall): Promise<T> =>
            c.functionName === 'nonces' && String(c.args?.[0]).toLowerCase() === USER_ADDRESS.toLowerCase() ? (BigInt(intentNonce) as T) : realRead<T>(c)) as typeof chain.readContract;
        const realSimulate = chain.simulate;
        chain.simulate = (c): CallOutcome => (isRelayTransferFor(c.data, signature) ? { ok: true, data: '0x' } : realSimulate(c));
        chain.executor = (tx) => (isRelayTransferFor(tx.data, signature) && intentNonceUsed(h!, USER_ADDRESS, intentNonce) ? 'reverted' : 'success');
        // Past the grace period (12 blocks) and the finality of the first observation (16 blocks): the honest RPC shows
        // the receipt, so the requeue waits.
        await drive(h, 24);
        expect(relayCallNonces(h, signature)).toEqual([0]);
        // One pass in which the honest RPC's head read times out.
        if (missOneRead) down.add('getBlock');
        await drive(h, 1);
        down.clear();
        await drive(h, 40);
        const record = h.store.getRequest(id)!;
        return {
            relayCallTxNonces: relayCallNonces(h, signature),
            requeued: await counter(h, 'relay_nonce_events_total', 'event="requeued"'),
            status: stateOf(h, id).status,
            settled: record.settledAtMs !== null,
        };
    }

    const WAITS = { relayCallTxNonces: [0], requeued: 0, status: 'submitted', settled: false };

    it('an executed transfer gets no second call when the honest RPC misses one head read (requeue)', async () => {
        const facts = await requeueScenario(true);
        // No second call and nothing requeued: the request waits, unsettled.
        expect(facts).toEqual(WAITS);
    });

    it('control: while the honest RPC answers every read, the same lies get no second call', async () => {
        expect(await requeueScenario(false)).toEqual(WAITS);
    });

    async function undoScenario(missOneRead: boolean) {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { id, call1 } = await executed(h, true);
        const { rpc: honest, down } = flakyHonest(h);
        const { chain } = h;
        chain.rpcClients = () => [chain, honest];
        // The liar hides the receipt and reports the relay account's nonce unused again (a node on a short fork, or a lie).
        liarHidesReceipt(h, call1);
        chain.getTransactionCount = () => Promise.resolve(0);
        await tick(h); // the honest RPC shows the receipt: the outcome holds
        expect(h.store.getRequest(id)!).toMatchObject({ status: 'mined', reopenedAtMs: null });
        if (missOneRead) down.add('getTransactionReceipt');
        chain.mine();
        await tick(h);
        down.clear();
        const record = h.store.getRequest(id)!;
        return {
            status: record.status,
            reopened: record.reopenedAtMs !== null,
            cancelSigned: h.store.listAttempts(id).some((a) => a.kind === 'cancel'),
        };
    }

    it('a mined request is not put back in flight when the honest RPC misses one receipt read (undo)', async () => {
        const facts = await undoScenario(true);
        // The outcome holds: the request is not reopened, and no cancel is signed for a transfer that executed.
        expect(facts).toEqual({ status: 'mined', reopened: false, cancelSigned: false });
    });

    it('control: while the honest RPC answers every read, the same lies do not undo the outcome', async () => {
        expect(await undoScenario(false)).toEqual({ status: 'mined', reopened: false, cancelSigned: false });
    });

    async function priceScenario(missOneRead: boolean) {
        h = await createHarness();
        const { chain, clock } = h;
        chain.feed = { address: FEED, decimals: 8, answer: LIAR_ANSWER, updatedAt: BigInt(START_TIME), description: 'MATIC / USD' };
        const { rpc: honest, down } = flakyHonest(h);
        chain.rpcClients = () => [chain, honest];
        const source = new ChainlinkPriceSource({ chain, feed: FEED, clock, cacheMs: 30_000, metrics: h.metrics });
        const outcome = (p: Promise<PriceReading>) =>
            p.then(
                (reading) => ({ value: reading.value }),
                (err: unknown) => ({ rejected: err instanceof PriceUnavailableError ? err.reason : String(err) }),
            );
        if (missOneRead) down.add('read:latestRoundData');
        const first = await outcome(source.get());
        down.clear();
        clock.advance(10); // within the cache period
        const later = await outcome(source.get());
        return { first, later };
    }

    it("the liar's in-bounds POL/USD price is not used when the honest RPC misses one feed read (price)", async () => {
        const facts = await priceScenario(true);
        // Not every RPC answered, so pricing is unavailable; once the honest RPC answers again the readings disagree,
        // and pricing stays unavailable. The liar's price is never used.
        expect(facts).toEqual({ first: { rejected: 'rpc_error' }, later: { rejected: 'rpc_disagreement' } });
    });

    it('control: while the honest RPC answers, the readings disagree and pricing is unavailable', async () => {
        const facts = await priceScenario(false);
        expect(facts).toEqual({ first: { rejected: 'rpc_disagreement' }, later: { rejected: 'rpc_disagreement' } });
    });
});
