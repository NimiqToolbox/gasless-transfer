import { afterEach, describe, expect, it } from 'vitest';
import { encodeErrorResult, parseTransaction } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { SqliteStore } from '../../src/store/sqliteStore.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { buildTransfer, createHarness, restartHarness, TEST_TX_SETTINGS, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const exposure = (raw: `0x${string}`): bigint => {
    const tx = parseTransaction(raw);
    return tx.gas! * tx.maxFeePerGas!;
};

describe('durable aggregate gas budget', () => {
    it('reserves the maximum per nonce, refusing increases atomically without refunding cheaper replacements', () => {
        const store = SqliteStore.open(':memory:');
        try {
            expect(store.reserveGasExposure(0, 70n, 100n)).toBe(true);
            expect(store.reserveGasExposure(0, 80n, 100n)).toBe(true);
            expect(store.reserveGasExposure(0, 10n, 100n)).toBe(true);
            expect(store.gasExposureWei()).toBe(80n);
            expect(store.reserveGasExposure(1, 21n, 100n)).toBe(false);
            expect(store.gasExposureWei()).toBe(80n);
            expect(store.reserveGasExposure(1, 20n, 100n)).toBe(true);
            expect(store.reserveGasExposure(0, 81n, 100n)).toBe(false);
            expect(store.gasExposureWei()).toBe(100n);
            expect(store.reserveGasExposure(0, 80n, 1n)).toBe(true);
            expect(store.reserveGasExposure(2, 1n, 1n)).toBe(false);
        } finally { store.close(); }
    });

    it('keeps full precision above SQLite signed integer range and rejects invalid reservations', () => {
        const store = SqliteStore.open(':memory:');
        try {
            const huge = 10n ** 30n;
            expect(store.reserveGasExposure(0, huge, huge + 1n)).toBe(true);
            expect(store.reserveGasExposure(1, 2n, huge + 1n)).toBe(false);
            expect(store.gasExposureWei()).toBe(huge);
            expect(() => store.reserveGasExposure(-1, 1n, 100n)).toThrow();
            expect(() => store.reserveGasExposure(1, 0n, 100n)).toThrow();
        } finally { store.close(); }
    });

    it('refuses the first signing/broadcast when its worst-case cost exceeds the ceiling', async () => {
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: 1n } } });
        await h.relay.txManager.recover();
        const t = await buildTransfer(h);
        await h.relay.pipeline.submit(transferOperation, t.body);
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(h.store.listAttempts(t.id)).toHaveLength(0);
        expect(h.store.getRequest(t.id)!.status).toBe('queued');
        expect(h.relay.txManager.health().reasons.some((r) => r.startsWith('gas_budget:'))).toBe(true);
    });

    it('persists before the broadcast, survives restart and successful mining, and counts new nonces', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const t = await buildTransfer(h);
        await h.relay.pipeline.submit(transferOperation, t.body);
        let reserved = false;
        h.chain.broadcastHook = (raw) => { reserved = h!.store.gasExposureWei() === exposure(raw); };
        await h.relay.txManager.tick();
        expect(reserved).toBe(true);
        const cost = exposure(h.chain.broadcasts[0]!);
        h.chain.broadcastHook = undefined;
        h.chain.mine();
        h.chain.mineBlocks(16);
        h.chain.finalized = h.chain.head.number;
        await h.relay.txManager.tick();
        expect(h.store.gasExposureWei()).toBe(cost);
        h = await restartHarness(h, { settings: { tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: cost } } });
        await h.relay.txManager.recover();
        const second = await buildTransfer(h);
        await h.relay.pipeline.submit(transferOperation, second.body);
        await h.relay.txManager.tick();
        expect(h.store.gasExposureWei()).toBe(cost);
        expect(h.store.listAttempts(second.id)).toHaveLength(0);
        expect(h.chain.broadcasts).toHaveLength(1);
    });

    it('keeps ambiguous broadcasts reserved across restart and permits a cheaper cancellation within the same ceiling', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const t = await buildTransfer(h);
        await h.relay.pipeline.submit(transferOperation, t.body);
        h.chain.forcedBroadcasts.push({ kind: 'error', message: 'ambiguous timeout' });
        await h.relay.txManager.tick();
        const cost = exposure(h.chain.broadcasts[0]!);
        expect(h.store.gasExposureWei()).toBe(cost);
        h = await restartHarness(h, { settings: { tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: cost } } });
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        expect(h.chain.mempool.size).toBe(1);
        expect(h.store.gasExposureWei()).toBe(cost);
        h.chain.simulate = () => ({ ok: false, revertData: encodeErrorResult({ abi: gaslessTransferAbi,
            errorName: 'InsufficientAllowance', args: [0n, 1_010_000n] }), message: 'execution reverted' });
        h.chain.mineBlocks(TEST_TX_SETTINGS.speedUpAfterBlocks, { include: false });
        await h.relay.txManager.tick();
        expect(h.store.listAttempts(t.id).at(-1)?.kind).toBe('cancel');
        expect(h.store.gasExposureWei()).toBe(cost);
    });

    it('charges only increased replacement exposure and prevents speed-up increases after restart at the ceiling', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const t = await buildTransfer(h);
        await h.relay.pipeline.submit(transferOperation, t.body);
        await h.relay.txManager.tick();
        const first = exposure(h.chain.broadcasts[0]!);
        h.chain.mineBlocks(TEST_TX_SETTINGS.speedUpAfterBlocks, { include: false });
        await h.relay.txManager.tick();
        const max = h.chain.broadcasts.reduce((n, raw) => exposure(raw) > n ? exposure(raw) : n, 0n);
        expect(max).toBeGreaterThan(first);
        expect(h.store.gasExposureWei()).toBe(max);
        h = await restartHarness(h, { settings: { tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: max } } });
        await h.relay.txManager.recover();
        const attempts = h.store.listAttempts(t.id).length;
        h.chain.mineBlocks(TEST_TX_SETTINGS.speedUpAfterBlocks, { include: false });
        await h.relay.txManager.tick();
        expect(h.store.gasExposureWei()).toBe(max);
        expect(h.store.listAttempts(t.id)).toHaveLength(attempts);
    });
});
