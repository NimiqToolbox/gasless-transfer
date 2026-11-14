// The life of a request in the transaction manager, against the fake chain: the relay's tx nonces, provisional
// outcomes until finality, the checks before a call leaves the relay, the per-request spend cap, success by the
// relay's own receipt, retention, health() and the queue. relay/docs/transaction-lifecycle.md describes the rules.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeErrorResult, keccak256, parseTransaction, toHex, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { createLocalSigner } from '../../src/chain/signer.js';
import type { ReadContractCall } from '../../src/chain/types.js';
import { toRequestState } from '../../src/http/app.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { GWEI, type FakeChain } from '../helpers/fakeChain.js';
import {
    CONTRACT,
    TEST_TX_SETTINGS,
    USDC,
    NO_AUTH,
    USDT0,
    autoSender,
    buildTransfer,
    createHarness,
    type BuiltTransfer,
    type Harness,
    type TransferOptions,
} from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS } from '../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
    await h.relay.txManager.recover();
});

afterEach(async () => {
    await h.close();
});

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

async function mineAndTick(blocks: number, options?: Parameters<FakeChain['mine']>[0]): Promise<void> {
    for (let i = 0; i < blocks; i++) {
        h.chain.mine(options);
        await tick();
    }
}

/** RELAY_MIN_FINALITY_DEPTH (16) blocks on top, and the node's finalized tag at head. */
async function finalizeAndTick(): Promise<void> {
    h.chain.mineBlocks(16);
    h.chain.finalized = h.chain.head.number;
    await tick();
}

const state = (id: Hex) => toRequestState(h.store.getRequest(id)!, h.store.listAttempts(id));
const record = (id: Hex) => h.store.getRequest(id)!;
const metrics = () => h.metrics.registry.metrics();
const poolKey = (nonce: number) => `${RELAY_ADDRESS.toLowerCase()}:${nonce}`;

const revertWith = (errorName: 'InsufficientAllowance' | 'InvalidSignature', args: readonly unknown[]) => () => ({
    ok: false as const,
    revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName, args } as never),
    message: 'execution reverted',
});

/** A transaction of the relay key that the relay does not track (e.g. sent by an operator). */
async function sendUntracked(nonce: number): Promise<Hex> {
    const raw = await createLocalSigner(RELAY_KEY).signTransaction({
        type: 'eip1559',
        chainId: 137,
        nonce,
        to: OTHER_ADDRESS,
        value: 1n,
        gas: 21_000n,
        maxFeePerGas: 100n * GWEI,
        maxPriorityFeePerGas: 30n * GWEI,
    });
    await h.chain.sendRawTransaction(raw);
    return keccak256(raw);
}

/** 0-value self-transfers of the relay (cancels and nonce fillers) among the broadcasts. */
function selfTransfers(): Array<{ nonce: number; hash: Hex }> {
    return h.chain.broadcasts
        .map((raw) => ({ tx: parseTransaction(raw), hash: keccak256(raw) }))
        .filter(({ tx }) => tx.to?.toLowerCase() === RELAY_ADDRESS.toLowerCase() && (tx.data ?? '0x') === '0x')
        .map(({ tx, hash }) => ({ nonce: tx.nonce ?? 0, hash }));
}

/** The spend cap of a 0.01 USD fee at POL/USD 0.2 and 200 %: 0.1 POL for the whole call. */
const SPEND_CAP_WEI = 10n ** 17n;
/** Gas limit of the fake's calls: estimate 150000 × 1.3 (below the gas table). */
const GAS_LIMIT = 195_000n;

describe('nonces', () => {
    it('"nonce too low" for a nonce the chain has not used keeps the nonce; the transaction is re-sent at it', async () => {
        const t = await queue();
        h.chain.forcedBroadcasts.push({ kind: 'nonce_too_low' }); // the node lies (or lags); it did not take the transaction
        await tick();
        expect(record(t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        expect(h.store.getNextNonce()).toBe(1);
        expect(await metrics()).toContain('relay_nonce_events_total{event="nonce_too_low"} 1');
        await tick(); // missing from the mempool: re-sent at the same nonce
        expect(h.chain.mempool.has(poolKey(0))).toBe(true);
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        const next = await queue();
        await tick();
        expect(record(next.id).txNonce).toBe(1); // no gap
        h.chain.mine();
        await tick();
        expect(state(next.id).status).toBe('mined');
        expect(h.chain.broadcasts.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 0, 1]);
    });

    it('a broadcast the node took but answered with "nonce too low" is not sent again at another nonce', async () => {
        const t = await queue();
        h.chain.forcedBroadcasts.push({ kind: 'nonce_too_low' });
        await tick();
        // A gateway retried the broadcast: the node does have the transaction.
        await h.chain.sendRawTransaction(h.store.listAttempts(t.id)[0]!.raw!);
        await tick();
        h.chain.mine();
        await tick();
        await tick();
        expect(state(t.id).status).toBe('mined');
        expect(new Set(h.chain.broadcasts.map((raw) => parseTransaction(raw).nonce))).toEqual(new Set([0]));
        expect(h.store.getNextNonce()).toBe(1);
    });

    // The relay locates the use of the intent nonce from state, so the call's receipt in the block that used the nonce
    // (eth_getBlockReceipts) is its execution: the request does not depend on the node answering the receipt by hash.
    it('an executed request whose receipt a lagging node does not answer on its own is never failed or re-sent; mined by its receipt in the block that used its nonce', async () => {
        const reads: Array<{ fn: string; blockNumber: bigint | undefined }> = [];
        const readContract = h.chain.readContract.bind(h.chain);
        h.chain.readContract = <T,>(call: ReadContractCall): Promise<T> => {
            reads.push({ fn: call.functionName, blockNumber: call.blockNumber });
            return readContract<T>(call);
        };
        const t = await queue();
        await tick();
        const [call] = h.store.listAttempts(t.id);
        h.chain.mine();
        h.chain.unservedReceipts.add(call!.hash);
        reads.length = 0;
        await mineAndTick(30);
        expect(state(t.id)).toMatchObject({ status: 'mined', txHash: call!.hash, error: null });
        expect(record(t.id)).toMatchObject({ txNonce: 0, blockNumber: 1001n });
        expect(h.chain.broadcasts).toHaveLength(1); // nothing re-sent, no second nonce
        expect(h.store.getNextNonce()).toBe(1);
        const text = await metrics();
        expect(text).toContain('relay_nonce_events_total{event="receipt_hidden"} 1');
        expect(text).toContain('relay_nonce_events_total{event="mined_by_nonce_search"} 1');
        // The request's own intent nonce decided, read at block numbers only (the head of the pass, and below it).
        const nonceReads = reads.filter((r) => r.fn === 'nonces');
        expect(nonceReads.length).toBeGreaterThan(0);
        expect(nonceReads.every((r) => r.blockNumber !== undefined)).toBe(true);
        h.chain.unservedReceipts.delete(call!.hash);
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'mined', txHash: call!.hash });
    });

    it('nonces at the top of the range that no transaction uses any more are re-used', async () => {
        await h.close();
        h = await createHarness();
        // Recovery adopts two pending transactions of the key that this database does not track ...
        await sendUntracked(0);
        await sendUntracked(1);
        await h.relay.txManager.recover();
        expect(h.store.getNextNonce()).toBe(2);
        // ... and the node drops them before they are mined.
        h.chain.dropMempool();
        const t = await queue();
        await tick();
        expect(record(t.id).txNonce).toBe(0);
        expect(await metrics()).toContain('relay_nonce_events_total{event="next_nonce_lowered"} 1');
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        expect(h.store.getNextNonce()).toBe(1);
    });

    it('unused nonces below an in-flight relay transaction are filled with 0-value self-transfers after RELAY_NONCE_GAP_BLOCKS', async () => {
        await h.close();
        h = await createHarness();
        await sendUntracked(0);
        await sendUntracked(1);
        await h.relay.txManager.recover();
        const t = await queue();
        await tick();
        expect(record(t.id).txNonce).toBe(2); // behind the two untracked transactions
        // The node evicts the untracked transactions: nonces 0 and 1 hold the relay's transaction back.
        h.chain.mempool.delete(poolKey(0));
        h.chain.mempool.delete(poolKey(1));
        await mineAndTick(20); // the gap is seen from the first of these blocks
        expect(selfTransfers()).toEqual([]);
        expect(state(t.id).status).toBe('submitted');
        expect(await metrics()).toContain('relay_nonce_gap 1');
        await mineAndTick(1);
        expect(selfTransfers().map((x) => x.nonce)).toEqual([0, 1]);
        expect(await metrics()).toContain('relay_nonce_events_total{event="gap_filled"} 2');
        expect(h.relay.txManager.health().reasons).toEqual([expect.stringMatching(/^nonce_gap: /)]);
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        expect(await h.chain.getTransactionCount(RELAY_ADDRESS, 'latest')).toBe(3);
        await tick();
        expect(await metrics()).toContain('relay_nonce_gap 0');
        expect(h.relay.txManager.health()).toEqual({ ok: true, reasons: [], degraded: [] });
    });
});

describe('provisional outcomes until finality', () => {
    it('a cancel that a reorg removes, with the original call included instead, turns expired into mined', async () => {
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 120) });
        await tick();
        const [call] = h.store.listAttempts(t.id);
        // Priced out until 1 s before the deadline: the relay cancels.
        h.chain.mine({ baseFee: 100n * GWEI, timestampDelta: 119 });
        await tick();
        const cancel = h.store.listAttempts(t.id).at(-1)!;
        expect(cancel.kind).toBe('cancel');
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('expired');
        expect(record(t.id).signature).not.toBeNull(); // provisional: kept for a reorg
        // Reorg: the cancel's block is gone; the original call (still in some node's pool) is included instead.
        h.chain.reorg(cancel.hash);
        h.chain.mempool.delete(poolKey(0));
        await h.chain.sendRawTransaction(call!.raw!);
        h.chain.mine({ baseFee: 30n * GWEI });
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'mined', txHash: call!.hash, error: null });
        await finalizeAndTick();
        expect(state(t.id).status).toBe('confirmed');
    });

    it('a reverted call removed by a reorg puts the request back in flight at its nonce; mined when included again', async () => {
        const t = await queue();
        await tick();
        const [call] = h.store.listAttempts(t.id);
        h.chain.executor = () => 'reverted';
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('failed');
        h.chain.executor = () => 'success';
        h.chain.reorg(call!.hash);
        h.chain.dropMempool(); // and the node forgot the transaction
        await tick();
        expect(record(t.id)).toMatchObject({ status: 'submitted', txNonce: 0 });
        expect(record(t.id).reopenedAtMs).not.toBeNull();
        expect(h.chain.mempool.has(poolKey(0))).toBe(true); // re-sent from the stored raw transaction
        h.chain.mine();
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'mined', txHash: call!.hash });
    });

    it('a node that answers "finalized" with its head block does not confirm before RELAY_MIN_FINALITY_DEPTH blocks', async () => {
        const t = await queue();
        await tick();
        h.chain.mine();
        const included = h.chain.head.number;
        for (let i = 0; i < 16; i++) {
            h.chain.finalized = h.chain.head.number;
            await tick();
            expect(state(t.id).status).toBe('mined');
            h.chain.mine();
        }
        h.chain.finalized = h.chain.head.number; // head - 16 = the inclusion block
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'confirmed', blockNumber: included.toString() });
    });

    it('an inclusion whose block is not the canonical block at its height does not settle', async () => {
        const t = await queue();
        await tick();
        h.chain.mine();
        const included = h.chain.head.number;
        h.chain.nonCanonical.add(included);
        await finalizeAndTick();
        expect(state(t.id).status).toBe('mined');
        expect(record(t.id).signature).not.toBeNull();
        expect(h.logs.text()).toContain('not the canonical block at its height');
        h.chain.nonCanonical.delete(included);
        await tick();
        expect(state(t.id).status).toBe('confirmed');
        expect(record(t.id).signature).toBeNull();
    });
});

describe('checks before a call leaves the relay', () => {
    it('the simulation and the gas estimate are pinned to the head block', async () => {
        const pinned: Record<'call' | 'estimateGas', Array<bigint | undefined>> = { call: [], estimateGas: [] };
        const call = h.chain.call.bind(h.chain);
        const estimateGas = h.chain.estimateGas.bind(h.chain);
        h.chain.call = async (p) => {
            pinned.call.push((p as { blockNumber?: bigint }).blockNumber);
            return call(p);
        };
        h.chain.estimateGas = async (p) => {
            pinned.estimateGas.push((p as { blockNumber?: bigint }).blockNumber);
            return estimateGas(p);
        };
        await queue();
        pinned.call.length = 0;
        pinned.estimateGas.length = 0;
        await tick();
        expect(pinned).toEqual({ call: [h.chain.head.number], estimateGas: [h.chain.head.number] });
    });

    it('a revert simulated on a head older than the acceptance does not fail the request; it is sent once the node caught up', async () => {
        const t = await queue();
        // The read node lags: its head predates the acceptance, and its stale state makes the call revert.
        h.chain.head = { ...h.chain.head, timestamp: BigInt(h.clock.seconds() - 30) };
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(t.id).status).toBe('queued');
        expect(h.logs.text()).toContain('simulation reverted on a block older than the acceptance');
        h.chain.mine({ timestampDelta: 60 });
        h.chain.simulate = () => ({ ok: true, data: '0x' });
        await tick();
        expect(state(t.id).status).toBe('submitted');
    });

    it('a revert on an old head that is still there two blocks later fails the request', async () => {
        const t = await queue();
        h.chain.head = { ...h.chain.head, timestamp: BigInt(h.clock.seconds() - 30) };
        // The sender invalidated the nonce: the simulation reverts with InvalidSignature.
        h.chain.invalidateNonces(t.request.from);
        await tick();
        h.chain.mine({ timestampDelta: 0 });
        await tick();
        expect(state(t.id).status).toBe('queued');
        h.chain.mine({ timestampDelta: 0 });
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(h.chain.broadcasts).toHaveLength(0);
    });

    it('a USDC permit whose sender has code by the time of the broadcast fails before any transaction', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        h.chain.codes.set(USER_ADDRESS.toLowerCase(), `0xef0100${'ab'.repeat(20)}`); // an EIP-7702 delegation
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'invalid_token_authorization' } });
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(h.store.getNextNonce()).toBe(0);
    });

    it('a USDC permit in flight whose sender gets code is cancelled at the next check', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        await tick();
        h.chain.includeFilter = () => false;
        h.chain.codes.set(USER_ADDRESS.toLowerCase(), `0xef0100${'ab'.repeat(20)}`);
        await mineAndTick(10); // speed-up due: re-checked first
        expect(h.store.listAttempts(t.id).at(-1)).toMatchObject({ kind: 'cancel', gasLimit: 21_000n });
        h.chain.includeFilter = () => true;
        h.chain.mine();
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'invalid_token_authorization' } });
    });

    it('a USDT0 permit is not affected by code at its sender (USDT0 verifies with ecrecover only)', async () => {
        const t = await queue({ token: USDT0, mode: 'permit' });
        h.chain.codes.set(USER_ADDRESS.toLowerCase(), `0xef0100${'ab'.repeat(20)}`);
        await tick();
        expect(state(t.id).status).toBe('submitted');
    });

    it('the gas limit of a call is min(estimate × 1.3, gas table), not a multiple of the table', async () => {
        const t = await queue();
        await tick();
        expect(parseTransaction(h.chain.broadcasts[0]!).gas).toBe(GAS_LIMIT);
        expect(h.store.listAttempts(t.id)[0]!.gasLimit).toBe(GAS_LIMIT);
    });

    it('USDC paused after acceptance is reported as token_paused (the permit would fail as an allowance error)', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        h.chain.token(USDC).paused = true;
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'token_paused' } });
        expect(state(t.id).error!.message).toContain('InsufficientAllowance');
    });

    it('a sender blacklisted after acceptance is reported as blocked_address', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        h.chain.token(USDC).blacklisted.add(USER_ADDRESS.toLowerCase());
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'blocked_address' } });
    });

    it('a token whose EIP-712 domain changed after acceptance is reported as invalid_token_authorization', async () => {
        const t = await queue({ token: USDT0, mode: 'metaTxApprove' });
        h.chain.token(USDT0).domainSeparator = keccak256(toHex('renamed USDT0'));
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'invalid_token_authorization' } });
        expect(state(t.id).error!.message).toContain('EIP-712 domain changed');
    });

    it('a call that reverts on-chain after a pause is token_paused and counted as a reverted call', async () => {
        const t = await queue({ token: USDC, mode: 'permit' });
        await tick();
        h.chain.token(USDC).paused = true;
        h.chain.executor = () => 'reverted';
        h.chain.mine();
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'token_paused' } });
        expect(state(t.id).error!.message).toContain('reverted on-chain');
        const text = await metrics();
        expect(text).toContain('relay_requests_reverted_onchain_total{operation="transfer"} 1');
        expect(text).toMatch(/relay_reverted_call_gas_pol_total\{operation="transfer"\} 0\.00/);
    });
});

describe('spend cap per request', () => {
    it('a speed-up stops at the spend cap; the transaction is held there and mined when the price falls', async () => {
        const t = await queue();
        await tick();
        h.chain.mine({ baseFee: 600n * GWEI }); // market: 2 × 600 + 30 gwei, above the cap of 0.1 POL / 195000 gas
        await tick();
        await mineAndTick(19);
        const capPerGas = SPEND_CAP_WEI / GAS_LIMIT;
        expect(h.store.listAttempts(t.id).map((a) => a.maxFeePerGas)).toEqual([90n * GWEI, capPerGas]);
        expect(await metrics()).toContain('relay_spend_cap_holds_total{kind="speedup"} 1');
        expect(state(t.id).status).toBe('submitted');
        h.chain.mine({ baseFee: 400n * GWEI });
        await tick();
        expect(state(t.id).status).toBe('mined');
        for (const a of h.store.listAttempts(t.id)) expect(a.gasLimit * a.maxFeePerGas).toBeLessThanOrEqual(SPEND_CAP_WEI);
    });

    it('a request priced out at its spend cap is cancelled with fee_too_low when other requests wait behind it', async () => {
        h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
        const a = await queue();
        await tick();
        h.chain.mine({ baseFee: 600n * GWEI });
        await tick();
        await mineAndTick(9); // speed-up to the cap
        expect(h.store.listAttempts(a.id)).toHaveLength(2);
        const b = await queue({ key: OTHER_KEY, fee: 1_000_000n }); // covers the current price
        await tick();
        expect(record(b.id)).toMatchObject({ status: 'submitted', txNonce: 1 });
        await mineAndTick(10); // a is due again, capped, and b waits for its nonce
        expect(h.store.listAttempts(a.id).at(-1)).toMatchObject({ kind: 'cancel', gasLimit: 21_000n });
        expect(await metrics()).toContain('relay_spend_cap_holds_total{kind="cancel"} 1');
        h.chain.mine();
        await tick();
        expect(state(a.id)).toMatchObject({ status: 'failed', error: { code: 'fee_too_low' } });
        expect(state(b.id).status).toBe('mined');
        for (const x of h.store.listAttempts(a.id).filter((y) => y.kind === 'call')) {
            expect(x.gasLimit * x.maxFeePerGas).toBeLessThanOrEqual(SPEND_CAP_WEI);
        }
    });

    it('cancels are exempt from the spend cap (RELAY_MAX_FEE_PER_GAS_GWEI still applies)', async () => {
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 120) });
        await tick();
        h.chain.mine({ baseFee: 1000n * GWEI, timestampDelta: 119 }); // 1 s before the deadline, far above the cap
        await tick();
        const cancel = h.store.listAttempts(t.id).at(-1)!;
        expect(cancel).toMatchObject({ kind: 'cancel', gasLimit: 21_000n });
        expect(cancel.maxFeePerGas).toBeGreaterThan(SPEND_CAP_WEI / GAS_LIMIT);
        expect(cancel.maxFeePerGas).toBeLessThanOrEqual(3000n * GWEI);
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('expired');
    });
});

// GaslessTransfer emits no event for a transfer. The relay's own successful receipt of a call (which encodes the
// request) is its success.
describe('success is the relay\'s own successful receipt (GaslessTransfer emits no transfer event)', () => {
    it('a successful receipt is mined and confirmed with fee revenue, whatever logs it carries, without reading the intent nonce', async () => {
        const t = await queue();
        await tick();
        h.chain.mine();
        const [call] = h.store.listAttempts(t.id);
        expect(h.chain.receipts.get(call!.hash)!.logs.map((l) => l.address)).toEqual([USDC, USDC]); // the token's Transfer events
        h.chain.receipts.set(call!.hash, { ...h.chain.receipts.get(call!.hash)!, logs: [] });
        h.chain.failing.add('read:nonces');
        await tick();
        expect(state(t.id).status).toBe('mined');
        h.chain.failing.delete('read:nonces');
        await finalizeAndTick();
        expect(state(t.id).status).toBe('confirmed');
        expect(await metrics()).toContain('relay_fee_revenue_usd_total{token="USDC"} 0.01');
    });

    it('a reverted receipt is never success, also when the intent nonce is used meanwhile (another version executed elsewhere): failed nonce_used', async () => {
        const t = await queue();
        await tick();
        h.chain.executor = () => 'reverted';
        h.chain.mine();
        h.chain.setIntentNonce(t.request.from, 1n);
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(state(t.id).error!.message).toContain('reverted on-chain');
        expect(await metrics()).toContain('relay_requests_reverted_onchain_total{operation="transfer"} 1');
        await finalizeAndTick();
        expect(record(t.id)).toMatchObject({ status: 'failed', signature: null });
        expect(record(t.id).settledAtMs).not.toBeNull();
    });
});

describe('retention and health()', () => {
    it('settled requests are deleted after RELAY_REQUEST_RETENTION_DAYS (default 30); the row count is exported', async () => {
        const t = await queue();
        await tick();
        h.chain.mine();
        await tick();
        await finalizeAndTick();
        expect(state(t.id).status).toBe('confirmed');
        const u = await queue();
        await tick();
        expect(await metrics()).toContain('relay_request_rows 2');
        h.clock.advance(29 * 24 * 3600);
        await tick();
        expect(h.store.getRequest(t.id)).toBeDefined();
        h.clock.advance(2 * 24 * 3600);
        await tick();
        expect(h.store.getRequest(t.id)).toBeUndefined();
        expect(h.store.listAttempts(t.id)).toEqual([]);
        expect(record(u.id).status).toBe('submitted'); // unsettled requests are never pruned
        const text = await metrics();
        expect(text).toContain('relay_requests_pruned_total 1');
        expect(text).toContain('relay_request_rows 1');
    });

    it('health(): recovery, the last pass, low funds and stalled finality; viewHead() is the head of the last pass', async () => {
        await h.close();
        h = await createHarness();
        const m = h.relay.txManager;
        expect(m.health().ok).toBe(false);
        expect(m.health().reasons.map((r) => r.split(':')[0])).toEqual(['not_recovered', 'no_pass']);
        expect(m.viewHead()).toBeUndefined();
        await m.recover();
        await tick();
        expect(m.health()).toEqual({ ok: true, reasons: [], degraded: [] });
        expect(m.viewHead()).toBe(h.chain.head.number);
        h.chain.mine();
        expect(m.viewHead()).toBe(h.chain.head.number - 1n); // until the next pass completes
        await tick();
        expect(m.viewHead()).toBe(h.chain.head.number);

        h.clock.advance(61);
        expect(m.health().reasons).toEqual([expect.stringMatching(/^pass_stale: /)]);
        await tick();
        expect(m.health().ok).toBe(true);

        h.chain.finalized = h.chain.head.number - 601n;
        await tick();
        expect(m.health().reasons).toEqual([expect.stringMatching(/^finality_lag: /)]);
        h.chain.finalized = h.chain.head.number - 64n;
        await tick();
        expect(m.health().ok).toBe(true);

        await queue();
        h.chain.forcedBroadcasts.push({ kind: 'insufficient_funds' });
        await tick();
        expect(m.health().reasons).toEqual([expect.stringMatching(/^insufficient_funds: /)]);
        await tick(); // re-sent, accepted
        expect(m.health().ok).toBe(true);
    });

    // The relay is unready only when it stalls, i.e. requests wait but no relay transaction was broadcast, sped up or
    // included for RELAY_STUCK_AFTER_BLOCKS. A request that is in flight for that long is no reason on its own.
    it('health(): stalled when a request in flight can be sped up no further (RELAY_MAX_FEE_PER_GAS_GWEI) and nothing is included for RELAY_STUCK_AFTER_BLOCKS', async () => {
        await h.close();
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, maxFeePerGas: 90n * GWEI } } });
        const m = h.relay.txManager;
        await m.recover();
        const t = await queue(); // sent at 2 × 30 + 30 = 90 gwei: RELAY_MAX_FEE_PER_GAS_GWEI, no speed-up possible
        h.chain.includeFilter = () => false;
        await tick();
        expect(state(t.id).status).toBe('submitted');
        for (let i = 0; i < 149; i++) {
            h.chain.mine();
            h.chain.finalized = h.chain.head.number - 64n;
            await tick();
        }
        expect(m.health()).toEqual({ ok: true, reasons: [], degraded: [] });
        h.chain.mine();
        h.chain.finalized = h.chain.head.number - 64n;
        await tick();
        expect(m.health()).toEqual({
            ok: false,
            reasons: ['stalled: 0 queued and 1 in-flight requests wait, but no relay transaction was broadcast, sped up or included for 150 blocks'],
            degraded: [],
        });
        h.chain.includeFilter = () => true;
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        expect(m.health()).toEqual({ ok: true, reasons: [], degraded: [] });
    });

    it('health(): stalled when queued requests cannot be sent (the simulation RPC keeps failing)', async () => {
        await h.close();
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } });
        const m = h.relay.txManager;
        await m.recover();
        const t = await queue();
        h.chain.failing.add('call');
        for (let i = 0; i < 10; i++) {
            await tick();
            h.chain.mine();
        }
        await tick();
        expect(state(t.id).status).toBe('queued');
        expect(m.health().reasons).toEqual(['stalled: 1 queued and 0 in-flight requests wait, but no relay transaction was broadcast, sped up or included for 10 blocks']);
        h.chain.failing.delete('call');
        await tick();
        expect(state(t.id).status).toBe('submitted');
        expect(m.health().ok).toBe(true);
    });

    it('health(): a request in flight held at its spend cap is degraded (held_at_cap), not unready', async () => {
        const t = await queue(); // 0.01 USD: sent at 90 gwei; spend cap 0.1 POL / 195000 gas ≈ 513 gwei
        await tick();
        for (let i = 0; i < 200; i++) {
            h.chain.mine({ baseFee: 600n * GWEI });
            h.chain.finalized = h.chain.head.number - 64n;
            await tick();
        }
        expect(state(t.id).status).toBe('submitted');
        expect(h.store.listAttempts(t.id).every((a) => a.kind === 'call')).toBe(true); // held, not cancelled
        expect(h.relay.txManager.health()).toEqual({
            ok: true,
            reasons: [],
            degraded: ['held_at_cap: 1 request(s) wait because gas prices are above what their fees cover (spend cap)'],
        });
        expect(await metrics()).toContain('relay_spend_cap_held 1');
        h.chain.mine({ baseFee: 400n * GWEI }); // the price falls below the cap: included
        await tick();
        expect(state(t.id).status).toBe('mined');
        expect(h.relay.txManager.health()).toEqual({ ok: true, reasons: [], degraded: [] });
    });

    it('health(): a queued request held by its spend cap is degraded (held_at_cap), not unready', async () => {
        const t = await queue();
        h.chain.mine({ baseFee: 2000n * GWEI }); // above what 0.01 USD covers before the first broadcast
        for (let i = 0; i < 200; i++) {
            h.chain.mine({ baseFee: 2000n * GWEI });
            h.chain.finalized = h.chain.head.number - 64n;
            await tick();
        }
        expect(state(t.id).status).toBe('queued');
        expect(h.relay.txManager.health()).toEqual({
            ok: true,
            reasons: [],
            degraded: ['held_at_cap: 1 request(s) wait because gas prices are above what their fees cover (spend cap)'],
        });
    });

    it('health(): a backlog that waits longer than RELAY_STUCK_AFTER_BLOCKS while the relay works is degraded, not unready', async () => {
        await h.close();
        // Fourteen senders build the backlog (one pending request each).
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, maxInFlight: 2, reservedPrioritySlots: 1, stuckAfterBlocks: 10 } } });
        await h.relay.txManager.recover();
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const ids: Hex[] = [];
        for (let i = 0; i < 14; i++) ids.push((await queue({ mode: 'none' })).id);
        const seen: string[][] = [];
        await tick();
        for (let i = 0; i < 14; i++) {
            h.chain.mine(); // one slot: one request per block
            await tick();
            seen.push(h.relay.txManager.health().degraded.map((d) => d.split(':')[0]!));
            expect(h.relay.txManager.health().reasons).toEqual([]);
        }
        expect(ids.every((id) => state(id).status === 'mined')).toBe(true);
        expect(seen.some((d) => d.includes('backlog'))).toBe(true);
        expect(seen.at(-1)).toEqual([]);
        expect(await metrics()).toContain('relay_queue_backlog_blocks 0');
    });
});

describe('the queue: progress, the sender cool-down and requests that give way', () => {
    // The cool-down keys on the sender (the signed `from`): the requests below come from one sender (USER), one at a
    // time, as its cool-down allows.
    const cooldowns = async (): Promise<number> => {
        const line = (await metrics()).split('\n').find((l) => l.startsWith('relay_admission_events_total{event="cooldown_started"}'));
        return line ? Number(line.split(' ').at(-1)) : 0;
    };
    /** Its sender burnt the request's intent nonce (invalidateNonces). */
    const useNonce = (t: BuiltTransfer): void => void h.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
    const ERROR_STRING = [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }] as const;
    const FINAL = { status: 'failed', error: { code: 'fee_too_low', message: 'gave way' } } as const;
    /** A request that takes the place of `id` in a full queue (Store.insertRequest with an eviction candidate). */
    const takePlaceOf = (id: Hex) =>
        h.store.insertRequest(
            {
                id: `0x${'ab'.repeat(32)}`,
                operation: 'transfer',
                contract: CONTRACT,
                signer: OTHER_ADDRESS,
                nonce: '1',
                fingerprint: `0x${'cd'.repeat(32)}`,
                request: {},
                authHash: `0x${'ef'.repeat(32)}`,
                signature: `0x${'11'.repeat(65)}`,
                authorization: NO_AUTH,
                fee: 10_000n,
                deadline: 2_000_000_000n,
                priority: 0,
                reservation: undefined,
                createdAtMs: h.clock.nowMs(),
            },
            { maxQueued: 1, evict: { candidates: [{ id, capPerGas: 1n }], final: FINAL } },
        );

    it('queued requests that end in their check before the broadcast count as progress: a queue of failing requests is not `stalled`', async () => {
        await h.close();
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 }, admission: { maxQueued: 200 } } });
        await h.relay.txManager.recover();
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        h.chain.setBalance(USDC, USER_ADDRESS, 10n ** 12n);
        const ids: Hex[] = [];
        for (let i = 0; i < 100; i++) {
            const t = await queue({ mode: 'none' });
            useNonce(t); // its sender burnt the nonce: every check before the broadcast fails
            ids.push(t.id);
        }
        // 8 checks per pass (2 x RELAY_MAX_IN_FLIGHT): 13 passes for 100 requests, more than RELAY_STUCK_AFTER_BLOCKS.
        const reasons: string[] = [];
        for (let b = 0; b < 14; b++) {
            await tick();
            reasons.push(...h.relay.txManager.health().reasons);
            h.chain.mine();
        }
        expect(ids.every((id) => record(id).status === 'failed' && record(id).error?.code === 'nonce_used')).toBe(true);
        expect(reasons).toEqual([]);
        expect(h.chain.broadcasts).toHaveLength(0);
    });

    it('a failure its sender caused puts the sender on the cool-down (nonce used, allowance, token signature, funds)', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        // The intent nonce: burnt by its sender.
        const burnt = await queue({ mode: 'none' });
        useNonce(burnt);
        await tick();
        expect(state(burnt.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(await cooldowns()).toBe(1);
        // The allowance: lowered by its sender (the contract reports InsufficientAllowance).
        const lowered = await queue({ mode: 'none' });
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(lowered.id)).toMatchObject({ status: 'failed', error: { code: 'insufficient_allowance' } });
        expect(await cooldowns()).toBe(2);
        // The token signature: its sender used the USDC permit nonce elsewhere.
        h.chain.simulate = (call) => h.chain.defaultSimulate(call);
        const permit = await queue({ token: USDC, mode: 'permit' });
        h.chain.token(USDC).nonces.set(USER_ADDRESS.toLowerCase(), 1n);
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(permit.id)).toMatchObject({ status: 'failed', error: { code: 'invalid_token_authorization' } });
        expect(await cooldowns()).toBe(3);
        // The funds: moved away (the token transfer reverts with an Error string).
        h.chain.simulate = (call) => h.chain.defaultSimulate(call);
        // (At the intent nonce of `lowered`, which never executed: another amount, or it would be its identical re-post.)
        const funds = await queue({ mode: 'none', amount: 999_999n });
        h.chain.setBalance(USDC, USER_ADDRESS, 0n);
        h.chain.simulate = () => ({
            ok: false,
            revertData: encodeErrorResult({ abi: ERROR_STRING, errorName: 'Error', args: ['ERC20: transfer amount exceeds balance'] }),
            message: 'execution reverted',
        });
        await tick();
        expect(state(funds.id)).toMatchObject({ status: 'failed', error: { code: 'simulation_failed' } });
        expect(await cooldowns()).toBe(4);
        // Each failure restarted the sender's cool-down.
        expect(h.relay.senderAdmission.cooldownSeconds(USER_ADDRESS)).toBe(600);
    });

    it('the balance read that blames the sender is pinned to the block the failed simulation saw, not the latest block', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const funds = await queue({ mode: 'none' });
        h.chain.setBalance(USDC, USER_ADDRESS, 0n);
        h.chain.simulate = () => ({
            ok: false,
            revertData: encodeErrorResult({ abi: ERROR_STRING, errorName: 'Error', args: ['ERC20: transfer amount exceeds balance'] }),
            message: 'execution reverted',
        });
        const read = h.chain.readContract.bind(h.chain);
        const balanceReads: Array<bigint | undefined> = [];
        h.chain.readContract = async <T>(call: ReadContractCall): Promise<T> => {
            if (call.functionName === 'balanceOf') balanceReads.push(call.blockNumber);
            return read<T>(call);
        };
        await tick();
        expect(state(funds.id)).toMatchObject({ status: 'failed', error: { code: 'simulation_failed' } });
        // The last balance read is the attribution (after the failure's own checks): pinned to the pass's head.
        expect(balanceReads.at(-1)).toBe(h.chain.head.number);
        expect(await cooldowns()).toBe(1);
    });

    // Only a failure the sender caused starts its cool-down: one that the token's admin caused, or that cannot be
    // attributed, must not keep an honest sender out.
    it('a failure its sender did not cause starts no cool-down (a pause, a changed token domain, a revert with the funds in place)', async () => {
        // A pause of the token (its admin).
        const paused = await queue({ token: USDC, mode: 'permit' });
        h.chain.token(USDC).paused = true;
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(paused.id)).toMatchObject({ status: 'failed', error: { code: 'token_paused' } });
        h.chain.token(USDC).paused = false;
        // A rename of the token's EIP-712 domain (its admin).
        h.chain.simulate = (call) => h.chain.defaultSimulate(call);
        const renamed = await queue({ token: USDT0, mode: 'metaTxApprove' });
        h.chain.token(USDT0).domainSeparator = keccak256(toHex('renamed USDT0'));
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        await tick();
        expect(state(renamed.id)).toMatchObject({ status: 'failed', error: { code: 'invalid_token_authorization' } });
        // A revert that is not about the sender: its funds are still there.
        h.chain.simulate = (call) => h.chain.defaultSimulate(call);
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const other = await queue({ mode: 'none' });
        h.chain.simulate = () => ({ ok: false, revertData: '0x', message: 'execution reverted' });
        await tick();
        expect(state(other.id)).toMatchObject({ status: 'failed', error: { code: 'simulation_failed' } });
        expect(await cooldowns()).toBe(0);
        expect(h.relay.senderAdmission.cooldownSeconds(USER_ADDRESS)).toBe(0);
    });

    it('a request that gave way while the pass waited for the chain is never sent, and its final outcome stays', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const t = await queue({ mode: 'none' });
        // While the pass simulates it, a new request takes its place in a full queue.
        const simulate = h.chain.simulate;
        h.chain.simulate = (call) => {
            h.chain.simulate = simulate;
            const outcome = takePlaceOf(t.id);
            expect(outcome.kind === 'inserted' ? outcome.evicted?.id : undefined).toBe(t.id);
            return simulate(call);
        };
        await tick();
        expect(record(t.id)).toMatchObject({ status: 'failed', error: FINAL.error });
        expect(h.store.listAttempts(t.id)).toEqual([]);
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(h.store.getNextNonce()).toBe(0);
    });

    it('a request that gave way while its failed check was being attributed keeps the outcome it gave way with', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const t = await queue({ mode: 'none' });
        useNonce(t);
        const simulate = h.chain.simulate;
        h.chain.simulate = (call) => {
            h.chain.simulate = simulate;
            const outcome = simulate(call); // reverts: InvalidSignature (the nonce moved on)
            takePlaceOf(t.id);
            return outcome;
        };
        await tick();
        expect(record(t.id)).toMatchObject({ status: 'failed', error: FINAL.error });
        // Not a failure of the relay's check: no cool-down for the sender.
        expect(await cooldowns()).toBe(0);
    });

    // The tests below cover the full checks of queued requests while no slot is free, and the full check of a waiting
    // request before a held request is cancelled for it.
    const capCancels = async (): Promise<number> => {
        const line = (await metrics()).split('\n').find((l) => l.startsWith('relay_spend_cap_holds_total{kind="cancel"}'));
        return line ? Number(line.split(' ').at(-1)) : 0;
    };
    /** Three requests (of USER and two more senders) in flight that the chain does not include (every normal slot taken). */
    async function fillSlots(o: TransferOptions = {}): Promise<Hex[]> {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        h.chain.includeFilter = () => false;
        const ids: Hex[] = [];
        for (let i = 0; i < 3; i++) ids.push((await queue({ mode: 'none', ...o })).id);
        await tick();
        expect(ids.map((id) => record(id).status)).toEqual(['submitted', 'submitted', 'submitted']);
        h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
        h.chain.setAllowance(USDC, OTHER_ADDRESS, CONTRACT, 10n ** 12n);
        return ids;
    }

    it('while no slot is free, a request never checked gets its full check: one that fails ends there (and its sender cools down), one that passes waits for a slot without a check in every pass', async () => {
        await fillSlots();
        const burnt = await queue({ mode: 'none' });
        useNonce(burnt);
        const waiting = await queue({ key: OTHER_KEY, mode: 'none' });
        const before = h.chain.calls.length;
        await tick();
        expect(state(burnt.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
        expect(await cooldowns()).toBe(1);
        expect(record(waiting.id).status).toBe('queued');
        expect(h.chain.calls.length - before).toBe(2); // one simulation each
        // Control: a request whose check passed waits for a slot; the passes do not check it again.
        const checked = h.chain.calls.length;
        await mineAndTick(3);
        expect(h.chain.calls.length).toBe(checked);
        expect(record(waiting.id).status).toBe('queued');
        // Once a slot is free it gets a fresh check before its broadcast, and is sent.
        h.chain.includeFilter = () => true;
        await mineAndTick(2);
        expect(h.chain.calls.length).toBeGreaterThan(checked);
        expect(['submitted', 'mined']).toContain(record(waiting.id).status);
    });

    it('the full checks while no slot is free stay within the budget of a pass (2 × RELAY_MAX_IN_FLIGHT), and each request is checked once', async () => {
        await h.close();
        h = await createHarness({ settings: { admission: { maxQueued: 100 } } });
        await h.relay.txManager.recover();
        await fillSlots();
        for (let i = 0; i < 20; i++) await queue({ mode: 'none' });
        const perPass: number[] = [];
        for (let pass = 0; pass < 4; pass++) {
            const before = h.chain.calls.length;
            await tick(); // the same head: the requests in flight are not due for a speed-up
            perPass.push(h.chain.calls.length - before);
        }
        expect(perPass).toEqual([8, 8, 4, 0]);
        expect(h.store.countByStatus('queued')).toBe(20);
        expect(h.chain.broadcasts).toHaveLength(3);
    });

    it('a held request is not cancelled for a waiting request whose check cannot be made (an RPC error); once it can be made, the cancel goes out', async () => {
        const deadline = BigInt(h.clock.seconds() + 7000);
        const held = await fillSlots({ amount: 1n, fee: 10_000n, deadline });
        h.chain.includeFilter = () => true;
        await mineAndTick(20, { baseFee: 600n * GWEI }); // above the cap of a 0.01 USD fee: held in flight
        expect(held.map((id) => record(id).status)).toEqual(['submitted', 'submitted', 'submitted']);
        // 0.20 USD covers the spike by far; its simulation fails with an RPC error.
        const waiting = await queue({ key: OTHER_KEY, mode: 'none', fee: 200_000n });
        const call = h.chain.call.bind(h.chain);
        const other = OTHER_ADDRESS.slice(2).toLowerCase();
        h.chain.call = async (p) => {
            if (p.data.toLowerCase().includes(other)) throw new Error('RPC unavailable');
            return call(p);
        };
        await mineAndTick(30, { baseFee: 600n * GWEI });
        expect(held.map((id) => record(id).status)).toEqual(['submitted', 'submitted', 'submitted']);
        expect(await capCancels()).toBe(0);
        expect(record(waiting.id).status).toBe('queued');
        // Control: the RPC answers again; the waiting request passes its check, and the held requests give way.
        h.chain.call = call;
        // A held call behind a lower nonce keeps its fees until its nonce is next, then gets one speed-up at once and is
        // cancelled only at the next speed-up interval: the three give way one after the other, which takes more than
        // 30 blocks.
        await mineAndTick(50, { baseFee: 600n * GWEI });
        expect(await capCancels()).toBe(3);
        expect(held.map((id) => state(id).error?.code)).toEqual(['fee_too_low', 'fee_too_low', 'fee_too_low']);
        expect(['submitted', 'mined', 'confirmed']).toContain(record(waiting.id).status);
    });
});

describe('a call is not blamed on its fee, or sent, when the pass itself is the reason', () => {
    it('speed-ups reach the spend cap while the transaction already pays the market price: no fee_too_low cancel when others wait', async () => {
        h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
        const a = await queue({ deadline: BigInt(h.clock.seconds() + 7000) });
        await tick();
        // No block takes its transaction although the base fee never rises: every ten blocks a speed-up, until the next
        // one would be above the request's spend cap.
        const held = async () => (await metrics()).includes('relay_spend_cap_holds_total{kind="speedup"}');
        for (let i = 0; i < 400 && !(await held()); i++) await mineAndTick(1, { include: false });
        expect(await held()).toBe(true);
        const paid = h.store.listAttempts(a.id).at(-1)!;
        expect(paid.maxFeePerGas).toBeGreaterThan((h.chain.head.baseFeePerGas ?? 0n) + TEST_TX_SETTINGS.minTip);

        const b = await queue({ key: OTHER_KEY, fee: 1_000_000n, deadline: BigInt(h.clock.seconds() + 7000) });
        await tick();
        expect(record(b.id)).toMatchObject({ status: 'submitted', txNonce: 1 });
        await mineAndTick(12, { include: false }); // a is due again, at its cap, and b waits for its nonce
        expect(h.store.listAttempts(a.id).every((attempt) => attempt.kind === 'call')).toBe(true);
        expect(state(a.id).status).toBe('submitted');
        expect(await metrics()).not.toContain('relay_spend_cap_holds_total{kind="cancel"}');
    });

    it('a pass that lasts longer than the margin to a deadline does not send that call', async () => {
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 70) });
        // The check of the request takes 61 s on the relay's clock: its deadline is then nearer than
        // RELAY_MIN_SECONDS_TO_BROADCAST (10 s), while the head of the pass still shows 70 s.
        const simulate = h.chain.simulate;
        h.chain.simulate = (call) => {
            h.chain.simulate = simulate;
            h.clock.advance(61);
            return simulate(call);
        };
        await tick();
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(state(t.id).status).toBe('queued');

        h.chain.mine({ timestampDelta: 61 });
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'expired' });
        expect(h.chain.broadcasts).toHaveLength(0);
    });
});
