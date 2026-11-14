// A receipt counts for a request only if it is the receipt of one of the request's own transactions.
//
// Scenario: the first RPC answers eth_getTransactionReceipt for the relay's pending call with the receipt of an
// unrelated transaction that is real, successful and final, and reports the intent nonce as used. A relay that took the
// receipt without comparing its transaction hash would confirm a payment that never executed and purge its secrets.
//
// Expected: quorum.findReceiptOn refuses a receipt whose hash differs from the one it asked for (compared without
// regard to case), the request stays unsettled with its secrets, and it is confirmed once the real receipt shows.
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import type { ChainClient, ReceiptInfo } from '../../../src/chain/types.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { findReceiptOn } from '../../../src/tx/quorum.js';
import { buildTransfer, createHarness, USDC, type Harness } from '../../helpers/harness.js';
import { RECIPIENT_ADDRESS } from '../../helpers/keys.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const unrelatedHash = keccak256(toHex('unrelated successful transaction'));
function receipt(hash: Hex, block: bigint): ReceiptInfo {
    return { transactionHash: hash, blockNumber: block, blockHash: toHex(block, { size: 32 }),
        status: 'success', gasUsed: 21_000n, effectiveGasPrice: 30_000_000_000n, logs: [] };
}

describe('RPC receipt identity', () => {
    it.each(['initial observation', 'later reconciliation'] as const)('does not confirm an unrelated receipt during %s, and recovers with the real receipt', async (phase) => {
        h = await createHarness();
        const x = h;
        const honest = x.chain.rpcView();
        x.chain.rpcClients = () => [x.chain, honest];
        await x.relay.txManager.recover();
        const transfer = await buildTransfer(x);
        await x.relay.pipeline.submit(transferOperation, transfer.body);
        await x.relay.txManager.tick();
        const attempt = x.store.listAttempts(transfer.id)[0]!;
        expect(x.store.getRequest(transfer.id)?.status).toBe('submitted');
        const originalRead = x.chain.readContract.bind(x.chain);
        const originalReceipt = x.chain.getTransactionReceipt.bind(x.chain);
        const foreign = receipt(unrelatedHash, x.chain.head.number - 100n);
        // The unrelated transaction is real in the fixture's canonical history: the honest RPC
        // will confirm its receipt. It says nothing about our pending payment.
        x.chain.receipts.set(unrelatedHash, foreign);
        x.chain.finalized = x.chain.head.number;
        let substitute = phase === 'initial observation';
        x.chain.getTransactionReceipt = async (hash) => hash === attempt.hash
            ? substitute ? foreign : receipt(attempt.hash, x.chain.head.number)
            : originalReceipt(hash);
        // The intent nonce reads as used (nonces(from) past it).
        x.chain.readContract = async <T>(call: Parameters<ChainClient['readContract']>[0]): Promise<T> =>
            call.functionName === 'nonces' ? (BigInt(transfer.request.nonce) + 1n) as T : originalRead<T>(call);
        if (!substitute) {
            await x.relay.txManager.tick();
            expect(x.store.getRequest(transfer.id)?.status).toBe('mined');
            substitute = true;
        }
        await x.relay.txManager.tick();
        const record = x.store.getRequest(transfer.id)!;
        expect(record.status, 'an unrelated real receipt cannot confirm a pending payment').not.toBe('confirmed');
        expect(record.settledAtMs).toBeNull();
        expect(record.signature).not.toBeNull();
        expect(x.store.listAttempts(transfer.id)[0]!.raw).not.toBeNull();
        expect(x.chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase()) ?? 0n).toBe(0n);

        // Legitimate success control: restore correct reads and actually execute the original tx.
        x.chain.getTransactionReceipt = originalReceipt;
        x.chain.readContract = originalRead;
        for (let i = 0; i < 18; i++) {
            x.chain.mine();
            x.chain.finalized = x.chain.head.number;
            x.clock.advance(2);
            await x.relay.txManager.tick();
            expect(x.relay.txManager.lastTickError).toBeUndefined();
        }
        expect(x.store.getRequest(transfer.id)?.status).toBe('confirmed');
        expect(x.chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(BigInt(transfer.request.amount));
        expect(x.store.listAttempts(transfer.id)).toHaveLength(1);
    });

    it('rejects substituted receipts from injected clients and accepts case-insensitive matching hashes', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const transfer = await buildTransfer(h);
        await h.relay.pipeline.submit(transferOperation, transfer.body);
        await h.relay.txManager.tick();
        const attempts = h.store.listAttempts(transfer.id);
        const mismatch = { getTransactionReceipt: async () => receipt(unrelatedHash, 900n) } as unknown as ChainClient;
        await expect(findReceiptOn(mismatch, attempts)).rejects.toThrow(/receipt.*hash/i);
        const matching = { getTransactionReceipt: async (hash: Hex) => receipt(`0x${hash.slice(2).toUpperCase()}`, 900n) } as unknown as ChainClient;
        await expect(findReceiptOn(matching, attempts)).resolves.toMatchObject({ attempt: attempts[0] });
    });
});
