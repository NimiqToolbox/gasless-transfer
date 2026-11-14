import { describe, expect, it, vi } from 'vitest';
import { TransactionReceiptNotFoundError, type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { receiptOf } from '../fault/helpers/forkStack.js';

const hash: Hash = `0x${'ab'.repeat(32)}`;
describe('fork receipt polling', () => {
    it('finds a receipt after an initial miss without waiting for another block', async () => {
        const receipt = { transactionHash: hash, status: 'success' } as TransactionReceipt;
        const getTransactionReceipt = vi.fn().mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash })).mockResolvedValue(receipt);
        expect(await receiptOf({ getTransactionReceipt } as unknown as PublicClient, hash, 1000)).toBe(receipt);
        expect(getTransactionReceipt).toHaveBeenCalledTimes(2);
    });
    it('bounds a missing receipt and propagates RPC errors', async () => {
        const getTransactionReceipt = vi.fn().mockRejectedValue(new TransactionReceiptNotFoundError({ hash }));
        const client = { getTransactionReceipt } as unknown as PublicClient;
        await expect(receiptOf(client, hash, 0)).rejects.toThrow('no receipt');
        getTransactionReceipt.mockRejectedValue(new Error('RPC failed'));
        await expect(receiptOf(client, hash, 1000)).rejects.toThrow('RPC failed');
    });
});
