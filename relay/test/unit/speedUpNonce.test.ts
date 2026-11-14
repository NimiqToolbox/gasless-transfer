// Speed-ups only at the next nonce the chain can include (the relay account's `latest` count): a transaction behind a
// lower nonce that is not included keeps its fees (calls, cancels and gap fillers alike), and a held request is
// cancelled for a cancel that waits behind it.
import { afterEach, describe, expect, it } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { transferOperation } from '../../src/operations/transfer.js';
import { DEFAULT_TX_POLICY } from '../../src/tx/settings.js';
import { GWEI } from '../helpers/fakeChain.js';
import { autoSender, buildTransfer, CONTRACT, createHarness, TEST_TX_SETTINGS, USDC, type BuiltTransfer, type Harness, type TransferOptions } from '../helpers/harness.js';
import { RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS } from '../helpers/keys.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const INTERVAL = TEST_TX_SETTINGS.speedUpAfterBlocks;
/** replacementFees without a cap, when the market floor is below the raise: +RELAY_SPEEDUP_PERCENT (20), rounded up. */
const raised = (fee: bigint): bigint => (fee * 120n + 99n) / 100n;

async function setup(): Promise<Harness> {
    h = await createHarness();
    // Mode NONE (autoSender gives further senders the same allowance: one pending request per sender).
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    return h;
}

async function submit(h: Harness, o: TransferOptions = {}): Promise<BuiltTransfer> {
    const t = await buildTransfer(h, autoSender(h, { mode: 'none', ...o }));
    await h.relay.pipeline.submit(transferOperation, t.body);
    return t;
}

/** `times` speed-up intervals, each with a pass at its end. */
async function intervals(h: Harness, times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
        h.chain.mineBlocks(INTERVAL);
        await h.relay.txManager.tick();
    }
}

/** Broadcasts (raw transactions, in order) at relay nonce `nonce`, from index `from` of the fake chain's list. */
function broadcastsAt(h: Harness, nonce: number, from = 0): Hex[] {
    return h.chain.broadcasts.slice(from).filter((raw) => parseTransaction(raw).nonce === nonce);
}

describe('speed-ups behind a stuck nonce', () => {
    it('speeds up only the transaction at the next includable nonce; a call or cancel behind it keeps its fees', async () => {
        const h = await setup();
        await h.relay.txManager.recover();
        // A's spend cap stays above every fee of this test; B is an ordinary request.
        const a = await submit(h, { fee: 1_000_000n });
        const b = await submit(h);
        await h.relay.txManager.tick();
        expect(h.store.getRequest(a.id)!.txNonce).toBe(0);
        expect(h.store.getRequest(b.id)!.txNonce).toBe(1);

        // The chain does not include nonce 0, and so nothing above it.
        h.chain.includeFilter = (tx) => tx.nonce !== 0;
        await intervals(h, 3);
        expect(h.store.listAttempts(a.id)).toHaveLength(4);
        const [call] = h.store.listAttempts(b.id);
        expect(h.store.listAttempts(b.id)).toHaveLength(1);
        expect(broadcastsAt(h, 1)).toEqual([call!.raw]);

        // B's call is still re-simulated at the speed-up interval: its sender burns its intent nonce, and it is
        // cancelled at its next check without waiting for nonce 0.
        h.chain.invalidateNonces(b.request.from, BigInt(b.request.nonce) + 1n);
        await intervals(h, 1);
        const cancel = h.store.listAttempts(b.id).at(-1)!;
        expect(cancel).toMatchObject({ kind: 'cancel', txNonce: 1, maxFeePerGas: raised(call!.maxFeePerGas) });
        expect(h.store.getRequest(b.id)!.pendingFinal?.error.code).toBe('nonce_used');

        // The cancel waits behind nonce 0 without climbing towards RELAY_MAX_FEE_PER_GAS_GWEI (a speed-up at every
        // interval would raise it by 20 % each time, 1.2^10 in these 100 blocks), while A at nonce 0 keeps being sped up.
        await intervals(h, 10);
        expect(h.store.listAttempts(b.id)).toHaveLength(2);
        expect(broadcastsAt(h, 1)).toEqual([call!.raw, cancel.raw]);
        expect(h.store.listAttempts(a.id)).toHaveLength(15);

        // Nonce 0 is included (and nothing above it): the cancel is next now and not included, so it gets one normal
        // speed-up at once, and no second one in the same interval.
        h.chain.includeFilter = (tx) => tx.nonce === 0;
        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(a.id)!.status).toBe('mined');
        expect(h.store.listAttempts(b.id)).toHaveLength(3);
        expect(h.store.listAttempts(b.id).at(-1)).toMatchObject({ kind: 'cancel', maxFeePerGas: raised(cancel.maxFeePerGas) });
        await h.relay.txManager.tick();
        expect(h.store.listAttempts(b.id)).toHaveLength(3);

        h.chain.includeFilter = () => true;
        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(b.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
    });

    it('speeds up a nonce gap filler only at the next includable nonce', async () => {
        const h = await setup();
        // Two transactions of the relay key that this database does not track are pending at nonces 0 and 1: recovery
        // starts the relay's range above them.
        const account = privateKeyToAccount(RELAY_KEY);
        for (const nonce of [0, 1]) {
            await h.chain.sendRawTransaction(
                await account.signTransaction({ type: 'eip1559', chainId: 137, nonce, to: RELAY_ADDRESS, value: 0n, gas: 21_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI }),
            );
        }
        await h.relay.txManager.recover();
        const r = await submit(h);
        await h.relay.txManager.tick();
        expect(h.store.getRequest(r.id)!.txNonce).toBe(2);

        // The node drops both: nonces 0 and 1 are a gap below the request, filled after RELAY_NONCE_GAP_BLOCKS. The
        // chain does not include nonce 0.
        for (const nonce of [0, 1]) h.chain.mempool.delete(`${RELAY_ADDRESS.toLowerCase()}:${nonce}`);
        h.chain.includeFilter = (tx) => tx.nonce !== 0;
        await h.relay.txManager.tick();
        h.chain.mineBlocks(DEFAULT_TX_POLICY.nonceGapBlocks);
        await h.relay.txManager.tick();
        expect(h.chain.mempool.has(`${RELAY_ADDRESS.toLowerCase()}:0`) && h.chain.mempool.has(`${RELAY_ADDRESS.toLowerCase()}:1`)).toBe(true);
        const filled = h.chain.broadcasts.length;
        const filler1 = h.chain.mempool.get(`${RELAY_ADDRESS.toLowerCase()}:1`)!;

        await intervals(h, 3);
        // The filler at nonce 0 is next: sped up every interval. The filler at nonce 1 and the request at nonce 2 wait
        // with their fees (and are not re-sent while the node holds them).
        expect(new Set(broadcastsAt(h, 0, filled)).size).toBe(3);
        expect(broadcastsAt(h, 1, filled)).toEqual([]);
        expect(h.chain.mempool.get(`${RELAY_ADDRESS.toLowerCase()}:1`)!.hash).toBe(filler1.hash);
        expect(h.store.listAttempts(r.id)).toHaveLength(1);

        h.chain.includeFilter = () => true;
        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(r.id)!.status).toBe('mined');
    });

    it('cancels a request held at its spend cap for a cancel waiting behind it', async () => {
        const h = await setup();
        await h.relay.txManager.recover();
        const a = await submit(h);
        // B's deadline comes first: it is cancelled behind A.
        const b = await submit(h, { deadline: BigInt(h.clock.seconds() + 61) });
        await h.relay.txManager.tick();
        expect(h.store.getRequest(a.id)!.txNonce).toBe(0);
        expect(h.store.getRequest(b.id)!.txNonce).toBe(1);

        // Gas spikes above what A's fee covers: base fee 520 gwei + 30 gwei tip is above A's spend cap (about 513 gwei at
        // its gas limit), and neither call can be included. B's deadline passes: it is cancelled, behind A.
        h.chain.mine({ baseFee: 520n * GWEI, timestampDelta: 60 });
        await h.relay.txManager.tick();
        const bCancel = h.store.listAttempts(b.id).at(-1)!;
        expect(bCancel.kind).toBe('cancel');
        expect(h.store.getRequest(b.id)!.pendingFinal?.status).toBe('expired');

        // A is sped up to its cap once, and then held there. Nothing but B's cancel waits behind A (no queued request,
        // no other call): that cancel counts as waiting, so A is cancelled with fee_too_low instead of holding the
        // relay's nonce (and B's cancel) until A's deadline.
        await intervals(h, 1);
        expect(h.store.listAttempts(a.id).at(-1)!.kind).toBe('call');
        await intervals(h, 1);
        expect(h.store.listAttempts(a.id).at(-1)!.kind).toBe('cancel');
        expect(h.store.getRequest(a.id)!.pendingFinal?.error.code).toBe('fee_too_low');
        expect(await h.metrics.registry.metrics()).toContain('relay_spend_cap_holds_total{kind="cancel"} 1');
        // B's cancel was not raised while it waited behind A.
        expect(h.store.listAttempts(b.id)).toHaveLength(2);

        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(a.id)).toMatchObject({ status: 'failed', error: { code: 'fee_too_low' } });
        expect(h.store.getRequest(b.id)).toMatchObject({ status: 'expired', error: { code: 'deadline_out_of_range' } });
        expect(h.store.listAttempts(b.id).at(-1)!.hash).toBe(bCancel.hash);
    });
});
