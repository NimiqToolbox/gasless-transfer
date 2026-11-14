import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeErrorResult, keccak256, parseTransaction, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { OperationName } from '@nimiq/gasless-sdk/relay';
import { createLocalSigner } from '../../src/chain/signer.js';
import { FeeEngine } from '../../src/fees/feeEngine.js';
import { toRequestState } from '../../src/http/app.js';
import { fingerprintOf } from '../../src/pipeline/pipeline.js';
import { transferOperation, zSubmitTransferBody } from '../../src/operations/transfer.js';
import { OperationRegistry, PRIORITY_EXIT, PRIORITY_NORMAL } from '../../src/operations/types.js';
import { HEAD_WATCH_MS, HEAD_WATCH_WINDOW_MS, TxManager, WAKE_MIN_GAP_MS } from '../../src/tx/txManager.js';
import { GWEI } from '../helpers/fakeChain.js';
import {
    CONTRACT,
    TEST_GAS_TABLE,
    TEST_TX_SETTINGS,
    USDC,
    autoSender,
    buildTransfer,
    createHarness,
    restartHarness,
    type BuiltTransfer,
    type Harness,
    type TransferOptions,
} from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS } from '../helpers/keys.js';
import { TestPriceSource } from '../helpers/priceSource.js';

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

function state(id: Hex) {
    return toRequestState(h.store.getRequest(id)!, h.store.listAttempts(id));
}

function expectPurged(id: Hex): void {
    const record = h.store.getRequest(id)!;
    expect(record.signature).toBeNull();
    expect(record.authorization).toBeNull();
    expect(h.store.listAttempts(id).every((a) => a.raw === null)).toBe(true);
}

/**
 * An outcome decided by an inclusion (a reverted call, a mined cancel) is provisional until that block is
 * final; the secrets and raw transactions are kept until then. This checks both, then makes the block final
 * (the `finalized` tag at head, RELAY_MIN_FINALITY_DEPTH = 16 blocks on top) and runs a pass.
 */
async function expectKeptThenPurgedAtFinality(id: Hex): Promise<void> {
    const record = h.store.getRequest(id)!;
    expect(record.signature).not.toBeNull();
    expect(record.authorization).not.toBeNull();
    expect(record.settledAtMs).toBeNull();
    h.chain.mineBlocks(16);
    h.chain.finalized = h.chain.head.number;
    await tick();
    expect(h.store.getRequest(id)!.status).toBe(record.status);
    expect(h.store.getRequest(id)!.settledAtMs).not.toBeNull();
    expectPurged(id);
}

const revertWith = (errorName: 'InsufficientAllowance' | 'InvalidSignature', args: readonly unknown[]) => () => ({
    ok: false as const,
    revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName, args } as never),
    message: 'execution reverted',
});

describe('broadcast, mined, confirmed', () => {
    it('persists the signed transaction before broadcasting, then tracks it to finality and purges secrets', async () => {
        const t = await queue();
        let persistedFirst = false;
        h.chain.broadcastHook = (raw) => {
            persistedFirst = h.store.listAttempts(t.id).some((a) => a.raw === raw);
        };
        await tick();
        expect(persistedFirst).toBe(true);
        expect(state(t.id).status).toBe('submitted');
        expect(h.store.getNextNonce()).toBe(1);

        const raw = h.chain.broadcasts[0]!;
        const tx = parseTransaction(raw);
        expect(tx.type).toBe('eip1559');
        expect(tx.chainId).toBe(137);
        expect(tx.nonce).toBe(0);
        expect(tx.to?.toLowerCase()).toBe(CONTRACT.toLowerCase());
        expect(tx.value ?? 0n).toBe(0n);
        expect(tx.maxPriorityFeePerGas).toBe(30n * GWEI);
        expect(tx.maxFeePerGas).toBe(90n * GWEI); // 2 × baseFee + tip
        expect(tx.gas).toBe(195_000n); // a tight gas limit: min(estimate 150000 × 1.3, gas table 250000)
        const decoded = decodeFunctionData({ abi: gaslessTransferAbi, data: tx.data! });
        expect(decoded.functionName).toBe('relayTransfer');
        // The intent nonce is signed but not in the call data (the contract reads nonces(from)); the token authorization is.
        expect(decoded.args[0]).not.toHaveProperty('nonce');
        expect(decoded.args[2]).toEqual({ mode: 1, v: t.authorization.v, r: t.authorization.r, s: t.authorization.s });
        expect(state(t.id).txHash).toBe(keccak256(raw));

        h.chain.mine();
        await tick();
        let s = state(t.id);
        expect(s.status).toBe('mined');
        expect(s.txHash).toBe(keccak256(raw));
        expect(s.blockNumber).toBe(h.chain.head.number.toString());
        expect(s.transactions).toEqual([{ hash: keccak256(raw), txNonce: 0, maxFeePerGas: (90n * GWEI).toString(), status: 'mined' }]);

        await tick(); // finalized (990) is still below the block
        expect(state(t.id).status).toBe('mined');
        // A `finalized` tag at head is not trusted on its own; the block also needs RELAY_MIN_FINALITY_DEPTH (16)
        // blocks on top.
        h.chain.finalized = h.chain.head.number;
        await tick();
        expect(state(t.id).status).toBe('mined');
        h.chain.mineBlocks(16);
        h.chain.finalized = h.chain.head.number;
        await tick();
        s = state(t.id);
        expect(s.status).toBe('confirmed');
        expect(s.txHash).toBe(keccak256(raw));
        expectPurged(t.id);
        const metrics = await h.metrics.registry.metrics();
        expect(metrics).toContain('relay_fee_revenue_usd_total{token="USDC"} 0.01');
        expect(metrics).toMatch(/relay_gas_cost_pol_total\{kind="call"\} [0-9.e-]+/);
        expect(metrics).toContain('relay_request_status_total{operation="transfer",status="confirmed"} 1');
    });

    it('a fee far above 2^53 and 2^128 is sent exactly, mined, served exactly and counted as a finite revenue', async () => {
        const fee = 2n ** 200n + 10_000n;
        h.chain.setBalance(USDC, USER_ADDRESS, 1_000_000n + fee);
        const t = await queue({ fee });
        await tick();
        const tx = parseTransaction(h.chain.broadcasts[0]!);
        // The spend cap scales with the fee; RELAY_MAX_FEE_PER_GAS_GWEI and the market price still bound the gas price.
        expect(tx.maxFeePerGas).toBe(90n * GWEI);
        const decoded = decodeFunctionData({ abi: gaslessTransferAbi, data: tx.data! });
        expect((decoded.args[0] as { fee: bigint; amount: bigint }).fee).toBe(fee);
        h.chain.mine();
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('mined');
        expect(s.request.fee).toBe(fee.toString());
        expect(JSON.parse(JSON.stringify(s)).request.fee).toBe(fee.toString());
        expect(h.chain.token(USDC).balances.get(RELAY_ADDRESS.toLowerCase())).toBe(fee);
        const metrics = await h.metrics.registry.metrics();
        const revenue = Number(/relay_fee_revenue_usd_total\{token="USDC"\} (\S+)/.exec(metrics)?.[1]);
        expect(Number.isFinite(revenue)).toBe(true);
        expect(revenue).toBe(Number(fee) / 1e6);
    });

    it('confirms by depth when the node does not support the finalized tag', async () => {
        h.chain.finalized = 'unsupported';
        const t = await queue();
        await tick();
        h.chain.mine();
        await tick();
        h.chain.mineBlocks(255);
        await tick();
        expect(state(t.id).status).toBe('mined');
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('confirmed');
    });

    it('uses consecutive nonces for consecutive requests', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const a = await queue({ mode: 'none' });
        const b = await queue({ mode: 'none' });
        await tick();
        expect(h.store.getRequest(a.id)!.txNonce).toBe(0);
        expect(h.store.getRequest(b.id)!.txNonce).toBe(1);
        h.chain.mine();
        await tick();
        expect(state(a.id).status).toBe('mined');
        expect(state(b.id).status).toBe('mined');
    });

    it('runs one pass at a time: concurrent ticks share it', async () => {
        await queue();
        const first = h.relay.txManager.tick();
        const second = h.relay.txManager.tick();
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(h.chain.broadcasts).toHaveLength(1);
    });
});

// A new request brings the loop's next pass forward (TxManager.wake) instead of waiting for the poll; passes stay one
// at a time and at least WAKE_MIN_GAP_MS apart, and there is no wake-up while every slot the request may use is taken.
describe('wake-up on a new request', () => {
    // The poll alone runs no pass during these tests.
    const SLOW_POLL = { ...TEST_TX_SETTINGS, pollIntervalMs: 60_000 };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // Node may fire a timer up to a millisecond before its delay.
    const TIMER_SLACK_MS = 5;

    beforeEach(async () => {
        await h.close();
        h = await createHarness({ settings: { tx: SLOW_POLL } });
        await h.relay.txManager.recover();
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    });

    /** Records when each of the loop's passes starts and ends (performance.now), with hooks during and after a pass. */
    function recordPasses(hooks: { during?: (pass: number) => void; after?: (pass: number) => void } = {}) {
        const tm = h.relay.txManager;
        const tick = tm.tick.bind(tm);
        const passes = { starts: [] as number[], ends: [] as number[] };
        vi.spyOn(tm, 'tick').mockImplementation(async () => {
            const pass = passes.starts.length;
            passes.starts.push(performance.now());
            const running = tick();
            hooks.during?.(pass);
            await running;
            passes.ends.push(performance.now());
            hooks.after?.(pass);
        });
        return passes;
    }

    function expectGaps(passes: { starts: number[]; ends: number[] }): void {
        for (let i = 1; i < passes.starts.length; i++) {
            expect(passes.starts[i]! - passes.ends[i - 1]!).toBeGreaterThanOrEqual(WAKE_MIN_GAP_MS - TIMER_SLACK_MS);
        }
    }

    it('sends a new request at once instead of at the next poll, and only while the loop runs', async () => {
        const passes = recordPasses();
        const early = await queue({ mode: 'none' });
        await sleep(100);
        expect(passes.starts).toHaveLength(0);
        h.relay.txManager.start();
        const t = await queue({ mode: 'none' });
        await vi.waitFor(() => expect(h.chain.broadcasts).toHaveLength(2), { timeout: 1000, interval: 10 });
        expect(passes.starts).toHaveLength(1);
        expect(state(early.id).status).toBe('submitted');
        expect(state(t.id).status).toBe('submitted');
        await h.relay.txManager.stop();
        await queue({ mode: 'none' });
        await sleep(WAKE_MIN_GAP_MS + 100);
        expect(passes.starts).toHaveLength(1);
    });

    it('only a newly queued request wakes it: not a duplicate, not a refused submission', async () => {
        const wake = vi.spyOn(h.relay.txManager, 'wake');
        const t = await queue({ mode: 'none' });
        expect(wake).toHaveBeenCalledTimes(1);
        expect(wake).toHaveBeenCalledWith(PRIORITY_NORMAL);
        expect((await h.relay.pipeline.submit(transferOperation, t.body)).statusCode).toBe(200);
        const forged = await buildTransfer(h, { mode: 'none', signWith: OTHER_KEY });
        await expect(h.relay.pipeline.submit(transferOperation, forged.body)).rejects.toMatchObject({ code: 'invalid_signature' });
        expect(wake).toHaveBeenCalledTimes(1);
    });

    it('answers 202 for a stored request even if the wake-up throws', async () => {
        vi.spyOn(h.relay.txManager, 'wake').mockImplementation(() => {
            throw new Error('wake-up failed');
        });
        const t = await queue({ mode: 'none' });
        expect(state(t.id).status).toBe('queued');
        expect(h.logs.text()).toContain('the request waits for the poll');
    });

    it('runs the passes of many wake-ups one at a time, at least WAKE_MIN_GAP_MS apart', async () => {
        const passes = recordPasses();
        h.relay.txManager.start();
        const until = performance.now() + 4 * WAKE_MIN_GAP_MS;
        while (performance.now() < until) {
            h.relay.txManager.wake();
            await sleep(10);
        }
        await h.relay.txManager.stop();
        // One pass at once, then at most one per WAKE_MIN_GAP_MS.
        expect(passes.starts.length).toBeGreaterThanOrEqual(2);
        expect(passes.starts.length).toBeLessThanOrEqual(5);
        expect(passes.ends).toHaveLength(passes.starts.length);
        expectGaps(passes);
    });

    it('answers a wake-up during a pass that has not yet listed the queue with that pass', async () => {
        const tm = h.relay.txManager;
        const passes = recordPasses({
            during: (pass) => {
                if (pass === 0) tm.wake();
            },
        });
        tm.start();
        tm.wake();
        await vi.waitFor(() => expect(passes.ends).toHaveLength(1), { timeout: 1000, interval: 10 });
        await sleep(WAKE_MIN_GAP_MS + 200);
        expect(passes.starts).toHaveLength(1);
    });

    it('follows a pass that had listed the queue when a request came with another pass after WAKE_MIN_GAP_MS', async () => {
        const tm = h.relay.txManager;
        const passes = recordPasses();
        await queue({ mode: 'none' });
        // Broadcasting comes after the pass listed the queue.
        let woken = false;
        h.chain.broadcastHook = () => {
            if (woken) return;
            woken = true;
            tm.wake();
        };
        tm.start();
        tm.wake();
        await vi.waitFor(() => expect(passes.ends).toHaveLength(2), { timeout: WAKE_MIN_GAP_MS + 1000, interval: 10 });
        expect(woken).toBe(true);
        expectGaps(passes);
    });

    it('does not start a pass while every slot the new request may use is taken', async () => {
        // Normal requests may use every slot but the reserved one (RELAY_RESERVED_PRIORITY_SLOTS).
        const normalSlots = SLOW_POLL.maxInFlight - SLOW_POLL.reservedPrioritySlots;
        expect(SLOW_POLL.reservedPrioritySlots).toBeGreaterThan(0);
        for (let i = 0; i < normalSlots; i++) await queue({ mode: 'none' });
        await tick();
        expect(h.chain.broadcasts).toHaveLength(normalSlots);
        const passes = recordPasses();
        h.relay.txManager.start();
        const waiting = await queue({ mode: 'none' });
        await sleep(WAKE_MIN_GAP_MS + 200);
        expect(passes.starts).toHaveLength(0);
        expect(state(waiting.id).status).toBe('queued');
        // A higher priority may still use the reserved slot: it starts a pass.
        h.relay.txManager.wake(PRIORITY_EXIT);
        await vi.waitFor(() => expect(passes.ends).toHaveLength(1), { timeout: 1000, interval: 10 });
    });

    // watchHead: while a transaction is in flight, a new block starts the next pass (HEAD_WATCH_MS).
    describe('head watch while a transaction is in flight', () => {
        async function sendOne(): Promise<{ passes: { starts: number[]; ends: number[] }; t: BuiltTransfer }> {
            const passes = recordPasses();
            h.relay.txManager.start();
            const t = await queue({ mode: 'none' });
            await vi.waitFor(() => expect(state(t.id).status).toBe('submitted'), { timeout: 1000, interval: 10 });
            await vi.waitFor(() => expect(passes.ends).toHaveLength(1), { timeout: 1000, interval: 10 });
            return { passes, t };
        }

        it('notices an inclusion within HEAD_WATCH_MS of its block, not at the poll; no reads once nothing is in flight', async () => {
            expect(h.relay.ctx.chain).toBe(h.chain);
            const reads = vi.spyOn(h.chain, 'getBlockNumber');
            h.relay.txManager.start();
            await sleep(3 * HEAD_WATCH_MS);
            expect(reads).not.toHaveBeenCalled();
            await h.relay.txManager.stop();
            const { t } = await sendOne();
            h.chain.mine();
            await vi.waitFor(() => expect(state(t.id).status).toBe('mined'), { timeout: HEAD_WATCH_MS + WAKE_MIN_GAP_MS + 1000, interval: 10 });
            const after = reads.mock.calls.length;
            await sleep(3 * HEAD_WATCH_MS);
            expect(reads.mock.calls.length).toBe(after);
        });

        it('starts a pass only for a new head, at least WAKE_MIN_GAP_MS after the previous one', async () => {
            const { passes } = await sendOne();
            await sleep(3 * HEAD_WATCH_MS);
            expect(passes.starts).toHaveLength(1);
            h.chain.mine({ include: false });
            await vi.waitFor(() => expect(passes.ends).toHaveLength(2), { timeout: HEAD_WATCH_MS + WAKE_MIN_GAP_MS + 1000, interval: 10 });
            h.chain.mine({ include: false });
            await vi.waitFor(() => expect(passes.ends).toHaveLength(3), { timeout: HEAD_WATCH_MS + WAKE_MIN_GAP_MS + 1000, interval: 10 });
            expectGaps(passes);
        });

        it('backs off to the poll when a head read fails', async () => {
            await sendOne();
            const reads = vi.spyOn(h.chain, 'getBlockNumber').mockRejectedValue(new Error('rate limited'));
            await sleep(4 * HEAD_WATCH_MS);
            expect(reads).toHaveBeenCalledTimes(1);
        });

        it('forgets an inflated head, so that one lying answer cannot stop the watch', async () => {
            const { passes } = await sendOne();
            vi.spyOn(h.chain, 'getBlockNumber').mockResolvedValueOnce(h.chain.head.number + 1000n);
            await vi.waitFor(() => expect(passes.ends).toHaveLength(2), { timeout: HEAD_WATCH_MS + WAKE_MIN_GAP_MS + 1000, interval: 10 });
            h.chain.mine({ include: false });
            await vi.waitFor(() => expect(passes.ends).toHaveLength(3), { timeout: 2 * HEAD_WATCH_MS + WAKE_MIN_GAP_MS + 1000, interval: 10 });
        });

        it('stops reading the head HEAD_WATCH_WINDOW_MS after the last broadcast', async () => {
            await sendOne();
            const reads = vi.spyOn(h.chain, 'getBlockNumber');
            await vi.waitFor(() => expect(reads).toHaveBeenCalled(), { timeout: 2 * HEAD_WATCH_MS, interval: 10 });
            const realNow = performance.now.bind(performance);
            const later = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + HEAD_WATCH_WINDOW_MS);
            try {
                // At most the read that was due when the window ended.
                await sleep(2 * HEAD_WATCH_MS);
                const count = reads.mock.calls.length;
                await sleep(3 * HEAD_WATCH_MS);
                expect(reads.mock.calls.length).toBe(count);
            } finally {
                later.mockRestore();
            }
        });

        it('does not count a transaction as missing from the mempool sooner than the poll after its broadcast', async () => {
            await h.close();
            h = await createHarness({ settings: { tx: { ...SLOW_POLL, pollIntervalMs: 1500 } } });
            await h.relay.txManager.recover();
            h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
            const { passes } = await sendOne();
            h.chain.dropMempool();
            h.chain.mine({ include: false });
            // The new block starts a pass within a second of the broadcast: too soon to call the transaction missing.
            await vi.waitFor(() => expect(passes.ends).toHaveLength(2), { timeout: HEAD_WATCH_MS + WAKE_MIN_GAP_MS + 500, interval: 10 });
            expect(passes.starts[1]! - passes.starts[0]!).toBeLessThan(1500);
            expect(h.logs.text()).not.toContain('transaction missing from the mempool');
            expect(h.chain.broadcasts).toHaveLength(1);
            // The pass at the poll does, and re-sends the stored transaction.
            await vi.waitFor(() => expect(h.chain.broadcasts).toHaveLength(2), { timeout: 3000, interval: 20 });
            expect(h.logs.text()).toContain('transaction missing from the mempool');
            expect(h.chain.broadcasts[1]).toBe(h.chain.broadcasts[0]);
        });
    });

    it('keeps a wake-up that comes between the end of a pass and the timer of the next one', async () => {
        const tm = h.relay.txManager;
        const passes = recordPasses({
            after: (pass) => {
                if (pass === 0) tm.wake();
            },
        });
        tm.start();
        tm.wake();
        await vi.waitFor(() => expect(passes.ends).toHaveLength(2), { timeout: WAKE_MIN_GAP_MS + 1000, interval: 10 });
        expectGaps(passes);
    });
});

describe('T34: gas', () => {
    // The gas limit is tight: the estimate plus margin, capped by the gas table, which is the measured worst case
    // and what the fee was priced with. A call that burns all its gas therefore costs at most what the fee covers.
    it('gas limit = min(estimate × 1.3, gas table), the gas table without an estimate; an estimate above the table fails the request', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        h.chain.estimate = () => 100_000n;
        const a = await queue({ mode: 'none' });
        await tick();
        expect(h.store.listAttempts(a.id)[0]!.gasLimit).toBe(130_000n);
        h.chain.estimate = () => 180_000n;
        const b = await queue({ mode: 'none' });
        await tick();
        expect(h.store.listAttempts(b.id)[0]!.gasLimit).toBe(200_000n); // 234000 capped by the table (none: 200000)
        h.chain.failing.add('estimateGas');
        const c = await queue({ mode: 'none' });
        await tick();
        expect(h.store.listAttempts(c.id)[0]!.gasLimit).toBe(200_000n);
        h.chain.failing.delete('estimateGas');
        h.chain.mine(); // frees the in-flight slots
        await tick();
        h.chain.estimate = () => 300_000n;
        const d = await queue({ mode: 'none' });
        const sent = h.chain.broadcasts.length;
        const nextNonce = h.store.getNextNonce();
        await tick();
        expect(state(d.id)).toMatchObject({ status: 'failed', error: { code: 'simulation_failed' } });
        expect(state(d.id).error?.message).toContain('300000 gas');
        expect(h.chain.broadcasts.length).toBe(sent);
        expect(h.store.getNextNonce()).toBe(nextNonce);
        expectPurged(d.id);
    });

    it('RELAY_MAX_GAS_LIMIT caps the gas table as well', async () => {
        await h.close();
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, maxGasLimit: 150_000n } } });
        await h.relay.txManager.recover();
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        h.chain.estimate = () => 110_000n;
        const a = await queue({ mode: 'none' });
        await tick();
        expect(h.store.listAttempts(a.id)[0]!.gasLimit).toBe(143_000n);
        h.chain.failing.add('estimateGas');
        const b = await queue({ mode: 'none' });
        await tick();
        expect(h.store.listAttempts(b.id)[0]!.gasLimit).toBe(150_000n);
    });

    it('holds queued requests while the base fee is above MAX_FEE_PER_GAS', async () => {
        const t = await queue();
        h.chain.mine({ baseFee: 5000n * GWEI });
        await tick();
        expect(state(t.id).status).toBe('queued');
        h.chain.mine({ baseFee: 30n * GWEI });
        await tick();
        expect(state(t.id).status).toBe('submitted');
    });

    it('speeds up by 20% after 10 blocks; txHash is the final hash', async () => {
        const t = await queue();
        h.chain.includeFilter = () => false;
        await tick();
        h.chain.mineBlocks(9);
        await tick();
        expect(h.store.listAttempts(t.id)).toHaveLength(1);
        h.chain.mine();
        await tick();
        const attempts = h.store.listAttempts(t.id);
        expect(attempts).toHaveLength(2);
        expect(attempts[1]!.maxFeePerGas).toBe(108n * GWEI);
        expect(attempts[1]!.maxPriorityFeePerGas).toBe(36n * GWEI);
        expect(attempts[1]!.txNonce).toBe(attempts[0]!.txNonce);
        expect(attempts[1]!.gasLimit).toBe(attempts[0]!.gasLimit);
        expect(attempts[0]!.status).toBe('replaced');
        expect(state(t.id).txHash).toBe(attempts[1]!.hash);

        h.chain.includeFilter = () => true;
        h.chain.mine();
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('mined');
        expect(s.txHash).toBe(attempts[1]!.hash);
        expect(s.transactions.map((x) => x.status)).toEqual(['replaced', 'mined']);
    });

    it('caps speed-ups at MAX_FEE_PER_GAS and then re-sends the same transaction', async () => {
        await h.close();
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, maxFeePerGas: 100n * GWEI } } });
        await h.relay.txManager.recover();
        const t = await queue();
        h.chain.includeFilter = () => false;
        await tick();
        h.chain.mineBlocks(10);
        await tick();
        let attempts = h.store.listAttempts(t.id);
        expect(attempts).toHaveLength(2);
        expect(attempts[1]!.maxFeePerGas).toBe(100n * GWEI);
        const sent = h.chain.broadcasts.length;
        h.chain.mineBlocks(10);
        await tick();
        attempts = h.store.listAttempts(t.id);
        expect(attempts).toHaveLength(2);
        expect(h.chain.broadcasts.length).toBe(sent + 1);
        expect(h.chain.broadcasts.at(-1)).toBe(attempts[1]!.raw);
    });
});

describe('re-simulation', () => {
    it('fails a queued request whose simulation fails before the first broadcast, without using a nonce', async () => {
        const t = await queue();
        h.chain.invalidateNonces(t.request.from, 3n);
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('failed');
        expect(s.error?.code).toBe('nonce_used');
        // The contract checks the signature over the current nonce first: InvalidSignature, told apart by nonces().
        expect(s.error?.message).toBe('The intent nonce was used or invalidated before this request executed (simulation before broadcast failed: InvalidSignature())');
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(h.store.getNextNonce()).toBe(0);
        expectPurged(t.id);
    });

    it('a request whose nonce is above the next one (a reorg removed its predecessor) waits: InvalidSignature with nonces() below its nonce', async () => {
        const first = await queue();
        await tick();
        h.chain.mine();
        await tick();
        expect(state(first.id).status).toBe('mined');
        // The sender's next request, at nonce 1.
        const next = await queue({ amount: 2_000_000n });
        expect(next.request.from).toBe(first.request.from);
        expect(next.request.nonce).toBe('1');
        // A reorg removes the first request's inclusion: nonces(from) is 0 again.
        h.chain.reorg(state(first.id).txHash!);
        expect(h.chain.intentNonce(first.request.from)).toBe(0n);
        await tick();
        expect(state(first.id).status).toBe('submitted');
        expect(state(next.id).status).toBe('queued'); // it waits for its predecessor
        expect(h.store.listAttempts(next.id)).toHaveLength(0);
        // The first is included again: the next one is sent and executes after it.
        h.chain.mine();
        await tick();
        expect(state(first.id).status).toBe('mined');
        expect(state(next.id).status).toBe('submitted');
        h.chain.mine();
        await tick();
        expect(state(next.id).status).toBe('mined');
        expect(h.chain.intentNonce(first.request.from)).toBe(2n);
    });

    it('re-simulates before a speed-up and cancels a request that can no longer succeed', async () => {
        const t = await queue();
        h.chain.includeFilter = () => false;
        await tick();
        h.chain.simulate = revertWith('InsufficientAllowance', [0n, 1_010_000n]);
        h.chain.mineBlocks(10);
        await tick();
        const attempts = h.store.listAttempts(t.id);
        expect(attempts).toHaveLength(2);
        const cancel = parseTransaction(attempts[1]!.raw!);
        expect(attempts[1]!.kind).toBe('cancel');
        expect(cancel.to?.toLowerCase()).toBe(RELAY_ADDRESS.toLowerCase());
        expect(cancel.value ?? 0n).toBe(0n);
        expect(cancel.data ?? '0x').toBe('0x');
        expect(cancel.gas).toBe(21_000n);
        expect(cancel.nonce).toBe(0);
        expect(state(t.id).status).toBe('submitted'); // until a transaction takes the nonce

        h.chain.includeFilter = () => true;
        h.chain.mine();
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('failed');
        expect(s.error?.code).toBe('insufficient_allowance');
        expect(s.error?.message).toContain('InsufficientAllowance(0, 1010000)');
        expect(s.txHash).toBeNull();
        // The cancel is internal; the call attempt shows as replaced.
        expect(s.transactions).toEqual([{ hash: attempts[0]!.hash, txNonce: 0, maxFeePerGas: attempts[0]!.maxFeePerGas.toString(), status: 'replaced' }]);
        // The outcome is provisional until the block is final: the secrets are kept until then.
        await expectKeptThenPurgedAtFinality(t.id);
    });

    it('re-simulates before a re-broadcast', async () => {
        const t = await queue();
        h.chain.forcedBroadcasts.push({ kind: 'error', message: 'timeout' });
        await tick();
        expect(state(t.id).status).toBe('submitted');
        expect(h.chain.mempool.size).toBe(0);
        const calls = h.chain.calls.length;
        await tick();
        expect(h.chain.calls.length).toBe(calls + 1);
        expect(h.chain.mempool.size).toBe(1);
        expect(h.store.listAttempts(t.id)).toHaveLength(1);
    });

    it('marks a request failed when its transaction reverts on-chain', async () => {
        const t = await queue();
        await tick();
        h.chain.executor = () => 'reverted';
        h.chain.mine();
        await tick();
        const s = state(t.id);
        const hash = h.store.listAttempts(t.id)[0]!.hash;
        expect(s.status).toBe('failed');
        expect(s.error?.code).toBe('simulation_failed');
        expect(s.txHash).toBe(hash);
        expect(s.blockNumber).toBe(h.chain.head.number.toString());
        expect(s.transactions[0]!.status).toBe('failed');
        // The outcome is provisional until the block is final: the secrets are kept until then.
        await expectKeptThenPurgedAtFinality(t.id);
    });
});

describe('deadlines', () => {
    it('cancels with a 0-value self-transfer at the same nonce when the deadline passes while pending → expired', async () => {
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 120) });
        h.chain.includeFilter = () => false;
        await tick();
        const original = h.store.listAttempts(t.id)[0]!;
        h.chain.mine({ timestampDelta: 117 });
        await tick();
        expect(h.store.listAttempts(t.id)).toHaveLength(1); // head + 2 s safety < deadline
        h.chain.mine({ timestampDelta: 1 });
        await tick();
        const attempts = h.store.listAttempts(t.id);
        expect(attempts).toHaveLength(2);
        const cancel = attempts[1]!;
        expect(cancel.kind).toBe('cancel');
        expect(cancel.txNonce).toBe(original.txNonce);
        expect(cancel.maxFeePerGas * 100n).toBeGreaterThanOrEqual(original.maxFeePerGas * 110n);
        expect(cancel.maxPriorityFeePerGas * 100n).toBeGreaterThanOrEqual(original.maxPriorityFeePerGas * 110n);
        const tx = parseTransaction(cancel.raw!);
        expect(tx.to?.toLowerCase()).toBe(RELAY_ADDRESS.toLowerCase());
        expect(tx.value ?? 0n).toBe(0n);

        h.chain.includeFilter = () => true;
        h.chain.mine();
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('expired');
        expect(s.error?.code).toBe('deadline_out_of_range');
        expect(s.txHash).toBeNull();
        // The outcome is provisional until the block is final: the secrets are kept until then.
        await expectKeptThenPurgedAtFinality(t.id);
    });

    it('if the original transaction takes the nonce first, the request is mined, not expired', async () => {
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 120) });
        h.chain.includeFilter = () => false;
        await tick();
        h.chain.forcedBroadcasts.push({ kind: 'underpriced' }); // the cancel does not reach the node
        h.chain.mine({ timestampDelta: 118 });
        await tick();
        expect(h.store.listAttempts(t.id).at(-1)!.kind).toBe('cancel');
        h.chain.includeFilter = () => true;
        h.chain.mine({ timestampDelta: 0 });
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('mined');
        expect(s.error).toBeNull();
        expect(s.txHash).toBe(h.store.listAttempts(t.id)[0]!.hash);
    });

    it('when a cancel cannot be priced within the cap, the final state still applies once the nonce resolves', async () => {
        await h.close();
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, maxFeePerGas: 90n * GWEI } } });
        await h.relay.txManager.recover();
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 120) });
        h.chain.includeFilter = () => false;
        await tick();
        h.chain.mine({ timestampDelta: 118 });
        await tick();
        expect(h.store.listAttempts(t.id)).toHaveLength(1);
        expect(h.store.getRequest(t.id)!.pendingFinal?.status).toBe('expired');
        h.chain.includeFilter = () => true;
        h.chain.executor = () => 'reverted';
        h.chain.mine();
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('expired');
        expect(s.error?.code).toBe('deadline_out_of_range');
    });

    it('speeds up a stuck cancel', async () => {
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 120) });
        h.chain.includeFilter = () => false;
        await tick();
        h.chain.mine({ timestampDelta: 118 });
        await tick();
        const cancel = h.store.listAttempts(t.id)[1]!;
        h.chain.mineBlocks(10);
        await tick();
        const attempts = h.store.listAttempts(t.id);
        expect(attempts).toHaveLength(3);
        expect(attempts[2]!.kind).toBe('cancel');
        expect(attempts[2]!.maxFeePerGas).toBe((cancel.maxFeePerGas * 120n + 99n) / 100n);
    });

    it('expires a queued request whose deadline is too close, without a transaction', async () => {
        const t = await queue({ deadline: BigInt(h.clock.seconds() + 60) });
        h.chain.mine({ timestampDelta: 49, baseFee: 5000n * GWEI }); // held: gas above the cap
        await tick();
        expect(state(t.id).status).toBe('queued');
        h.chain.mine({ timestampDelta: 1 }); // now + 10 s ≥ deadline
        await tick();
        const s = state(t.id);
        expect(s.status).toBe('expired');
        expect(h.chain.broadcasts).toHaveLength(0);
        expectPurged(t.id);
    });
});

describe('T33: recovery and nonce reconciliation', () => {
    it('re-broadcasts the persisted signed transaction after a restart', async () => {
        const t = await queue();
        await tick();
        const raw = h.store.listAttempts(t.id)[0]!.raw!;
        h.chain.dropMempool(); // e.g. the node restarted too
        h = await restartHarness(h);
        await h.relay.txManager.recover();
        expect(h.store.getNextNonce()).toBe(1);
        await tick();
        expect(h.chain.broadcasts.at(-1)).toBe(raw);
        expect(h.store.listAttempts(t.id)).toHaveLength(1);
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
    });

    it('re-sends a transaction the node dropped from its mempool at the next tick, after a re-simulation', async () => {
        const t = await queue();
        await tick();
        const raw = h.store.listAttempts(t.id)[0]!.raw!;
        await tick(); // still in the mempool: nothing is re-sent
        expect(h.chain.broadcasts).toEqual([raw]);

        h.chain.dropMempool(); // evicted, or the node restarted
        const calls = h.chain.calls.length;
        await tick();
        expect(h.chain.broadcasts).toEqual([raw, raw]); // the stored transaction, not a speed-up
        expect(h.chain.calls.length).toBe(calls + 1);
        expect(h.store.listAttempts(t.id)).toHaveLength(1);
        expect(h.chain.mempool.size).toBe(1);
        expect(h.logs.text()).toContain('transaction missing from the mempool');

        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        expect(state(t.id).txHash).toBe(keccak256(raw));
    });

    it('cancels a dropped transaction whose request can no longer succeed', async () => {
        const t = await queue();
        await tick();
        h.chain.dropMempool();
        // The sender invalidated the nonce: the re-simulation reverts with InvalidSignature.
        h.chain.invalidateNonces(t.request.from);
        await tick();
        const attempts = h.store.listAttempts(t.id);
        expect(attempts.map((a) => a.kind)).toEqual(['call', 'cancel']);
        h.chain.mine();
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
    });

    it('recovers a request that was mined while the relay was down', async () => {
        const t = await queue();
        await tick();
        h.chain.mine(); // happens while the relay is down
        h = await restartHarness(h);
        await h.relay.txManager.recover();
        await tick();
        expect(state(t.id).status).toBe('mined');
    });

    it('skips a nonce that another writer used after recovery (the pending nonce is above the stored next nonce)', async () => {
        const t = await queue();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        await tick();
        expect(h.store.getRequest(t.id)!.txNonce).toBe(1);
        expect(parseTransaction(h.chain.broadcasts.at(-1)!).nonce).toBe(1);
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
    });

    it('skips nonces used by transactions the database does not know (chain ahead)', async () => {
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        h = await restartHarness(h);
        await h.relay.txManager.recover();
        expect(h.store.getNextNonce()).toBe(1);
        const t = await queue();
        await tick();
        expect(h.store.getRequest(t.id)!.txNonce).toBe(1);
    });

    it('initialises the nonce from the chain for a fresh database', async () => {
        await h.close();
        h = await createHarness();
        h.chain.consumeNonce(RELAY_ADDRESS, 4);
        expect(h.store.getNextNonce()).toBeUndefined();
        await h.relay.txManager.recover();
        expect(h.store.getNextNonce()).toBe(5);
    });

    // "nonce too low" is not proof that the nonce is used, and the node may have taken the transaction, so the
    // attempt stays. The request gets a new nonce only once the chain's latest nonce has passed its nonce for the
    // grace period and the request's own nonce shows it did not execute (its first attempt can still resolve it).
    // The block of that observation must also be final (RELAY_MIN_FINALITY_DEPTH), so that no reorg can include
    // the first attempt.
    it('keeps the attempt when its first broadcast hits nonce too low; a new nonce only once the chain shows it did not execute', async () => {
        const t = await queue();
        // Another writer's transaction takes nonce 0 just before the relay's broadcast reaches the node.
        h.chain.broadcastHook = () => {
            h.chain.broadcastHook = undefined;
            h.chain.consumeNonce(RELAY_ADDRESS, 0);
        };
        await tick();
        expect(state(t.id).status).toBe('submitted');
        expect(h.store.listAttempts(t.id)).toHaveLength(1);
        expect(h.store.getNextNonce()).toBe(1);
        const observedAt = h.chain.head.number + 1n; // the next pass sees nonce 0 used
        let blocks = 0;
        while (h.store.getRequest(t.id)!.txNonce === 0 && blocks < 30) {
            h.chain.mine();
            h.chain.finalized = h.chain.head.number; // the finalized tag at head: final 16 blocks deep
            await tick();
            blocks += 1;
        }
        expect(blocks).toBeGreaterThanOrEqual(12); // RELAY_UNKNOWN_NONCE_GRACE_BLOCKS
        expect(h.chain.head.number - 16n).toBeGreaterThanOrEqual(observedAt); // the observation block is final
        expect(state(t.id).status).toBe('submitted');
        expect(h.store.getRequest(t.id)!.txNonce).toBe(1);
        expect(h.store.listAttempts(t.id).map((a) => [a.txNonce, a.status])).toEqual([
            [0, 'failed'],
            [1, 'pending'],
        ]);
        expect(parseTransaction(h.chain.broadcasts.at(-1)!).nonce).toBe(1);
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
    });

    // A request is not failed because an unknown transaction used its tx nonce. Its own intent nonce decides:
    // not executed → it is sent again at a new tx nonce; executed → it is never re-sent and resolves by its receipt.
    it('re-sends a request at a new nonce when an unknown transaction took its nonce and it did not execute (once that is final)', async () => {
        const t = await queue();
        await tick();
        h.chain.dropMempool();
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        let blocks = 0;
        while (h.store.getRequest(t.id)!.txNonce === 0 && blocks < 30) {
            h.chain.mine();
            h.chain.finalized = h.chain.head.number;
            await tick();
            blocks += 1;
        }
        expect(blocks).toBeGreaterThanOrEqual(12);
        expect(state(t.id).status).toBe('submitted');
        expect(h.store.getRequest(t.id)!.txNonce).toBe(1);
        h.chain.mine();
        await tick();
        expect(state(t.id)).toMatchObject({ status: 'mined', error: null });
        expect(await h.metrics.registry.metrics()).toContain('relay_nonce_events_total{event="requeued"} 1');
    });

    it('moves a mined request back to submitted on a reorg and re-broadcasts it', async () => {
        const t = await queue();
        await tick();
        h.chain.mine();
        await tick();
        const hash = state(t.id).txHash!;
        expect(state(t.id).status).toBe('mined');
        h.chain.reorg(hash);
        h.chain.dropMempool();
        await tick();
        expect(state(t.id).status).toBe('submitted');
        expect(h.chain.mempool.size).toBe(1);
        h.chain.mine();
        await tick();
        expect(state(t.id).status).toBe('mined');
        expect(state(t.id).txHash).toBe(hash);
    });
});

describe('funds and priority', () => {
    it('stops broadcasting new transactions while the relay has insufficient POL', async () => {
        const a = await queue();
        h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
        const b = await queue({ key: OTHER_KEY });
        h.chain.forcedBroadcasts.push({ kind: 'insufficient_funds' });
        await tick();
        expect(state(a.id).status).toBe('submitted');
        expect(state(b.id).status).toBe('queued');
        expect(h.relay.txManager.status().lowFunds).toBe(true);
        await tick();
        expect(h.relay.txManager.status().lowFunds).toBe(false);
        expect(state(b.id).status).toBe('submitted');
        expect(h.chain.mempool.size).toBe(2);
    });

    it('limits in-flight transactions and keeps a slot for priority operations', async () => {
        const exitOperation = { ...transferOperation, name: 'exit' as OperationName, priority: PRIORITY_EXIT };
        const registry = new OperationRegistry().register(transferOperation).register(exitOperation);
        const fees = new FeeEngine({
            chain: h.chain,
            priceSource: new TestPriceSource('0.2'),
            gasTable: { ...TEST_GAS_TABLE, operations: { ...TEST_GAS_TABLE.operations, exit: { none: 200_000 } } },
            clock: h.clock,
            minTip: 30n * GWEI,
            marginBps: 1000,
            cacheMs: 0,
        });
        const manager = new TxManager({
            ctx: h.relay.ctx,
            registry,
            store: h.store,
            signer: createLocalSigner(RELAY_KEY),
            fees,
            clock: h.clock,
            logger: h.logs.logger,
            metrics: h.metrics,
            settings: { ...TEST_TX_SETTINGS, maxInFlight: 2, reservedPrioritySlots: 1 },
        });
        await manager.recover();
        h.chain.includeFilter = () => false;
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const a = await queue({ mode: 'none' });
        const b = await queue({ mode: 'none' });
        await manager.tick();
        expect(h.store.getRequest(a.id)!.status).toBe('submitted');
        expect(h.store.getRequest(b.id)!.status).toBe('queued'); // one slot is reserved

        const exit = await buildTransfer(h, { mode: 'none', key: OTHER_KEY });
        h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
        h.chain.setAllowance(USDC, OTHER_ADDRESS, CONTRACT, 10n ** 12n);
        const sub = zSubmitTransferBody.parse(exit.body);
        h.store.insertRequest(
            {
                id: exit.id,
                operation: 'exit' as OperationName,
                contract: CONTRACT,
                signer: OTHER_ADDRESS,
                nonce: sub.request.nonce,
                fingerprint: fingerprintOf(exit.id, sub),
                request: sub.request,
                authHash: transferOperation.authHash(sub),
                signature: sub.signature,
                authorization: sub.authorization,
                fee: 10_000n,
                deadline: BigInt(sub.request.deadline),
                priority: PRIORITY_EXIT,
                reservation: undefined,
                createdAtMs: h.clock.nowMs() + 1,
            },
            {},
        );
        await manager.tick();
        expect(h.store.getRequest(exit.id)!.status).toBe('submitted');
        expect(h.store.getRequest(b.id)!.status).toBe('queued');
        await manager.stop();
    });
});
