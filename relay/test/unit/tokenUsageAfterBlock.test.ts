// A PERMIT or META_TX_APPROVE request that the relay recorded as included after block B (the block of a submission's
// reads) set and used the allowance and advanced the token nonce; the reads at B show none of it. Steps 6/7 and the
// atomic step-9 re-check answer the retryable sender_busy for (token, from) until a submission reads past it.
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { fingerprintOf } from '../../src/pipeline/pipeline.js';
import { transferOperation } from '../../src/operations/transfer.js';
import type { InsertGuards, NewRequest } from '../../src/store/types.js';
import { buildTransfer, CONTRACT, createHarness, USDC, USDT0, type BuiltTransfer, type Harness } from '../helpers/harness.js';
import { USER_ADDRESS } from '../helpers/keys.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

function newRequest(h: Harness, t: BuiltTransfer): NewRequest {
    const submission = transferOperation.schema.parse(t.body);
    return {
        id: t.id, operation: 'transfer', contract: CONTRACT, signer: t.request.from, nonce: t.request.nonce,
        fingerprint: fingerprintOf(t.id, submission), request: t.request, authHash: transferOperation.authHash(submission), signature: submission.signature,
        authorization: submission.authorization, fee: BigInt(t.request.fee), deadline: BigInt(t.request.deadline),
        priority: 0, createdAtMs: h.clock.nowMs(),
        reservation: { token: t.request.token, spender: CONTRACT, debit: BigInt(t.request.amount) + BigInt(t.request.fee) },
    };
}

describe('token signatures included after the block of the reads', () => {
    it('step 9: sender_busy for (token, from) while a PERMIT/META_TX request is included above the observed block', async () => {
        h = await createHarness();
        const now = h.clock.nowMs();
        const guards = (observedBlock: bigint): InsertGuards => ({ observedBalance: 10n ** 12n, observedAllowance: 10n ** 12n, observedBlock });
        h.store.setNextNonce(0);
        for (const [mode, block, nonce] of [['permit', 1005n, 0n], ['metaTxApprove', 1105n, 2n]] as const) {
            const signed = await buildTransfer(h, { token: USDT0, mode, nonce });
            expect(h.store.insertRequest(newRequest(h, signed), {}).kind).toBe('inserted');
            const hash = keccak256(toHex(`call:${mode}`));
            h.store.recordFirstAttempt(signed.id, h.store.getNextNonce()!, { hash, raw: '0x02', kind: 'call', maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 1n, sentBlock: block - 5n }, now);
            h.store.markMined(signed.id, { hash, blockNumber: block, gasUsed: 1n, effectiveGasPrice: 1n }, now);

            expect(h.store.tokenUsage(USDT0, USER_ADDRESS, CONTRACT, { minedAfterBlock: block - 1n }).busy).toBe(true);
            expect(h.store.tokenUsage(USDT0, USER_ADDRESS, CONTRACT, { minedAfterBlock: block }).busy).toBe(false);
            expect(h.store.tokenUsage(USDT0, USER_ADDRESS, CONTRACT).busy).toBe(false);
            expect(h.store.tokenUsage(USDC, USER_ADDRESS, CONTRACT, { minedAfterBlock: block - 1n }).busy).toBe(false);

            // Read at the block before: the allowance there is stale (a NONE request would rely on it), and so is the
            // token nonce (a token signature for the next one would fail its check there).
            // The sender's next intent nonce is the one after the inclusion.
            const none = await buildTransfer(h, { token: USDT0, mode: 'none', nonce: nonce + 1n });
            const next = await buildTransfer(h, { token: USDT0, mode, authNonce: 1n, nonce: nonce + 1n });
            for (const t of [none, next]) {
                expect(h.store.insertRequest(newRequest(h, t), guards(block - 1n))).toEqual({ kind: 'sender_busy', reason: 'token_signature' });
                expect(h.store.getRequest(t.id)).toBeUndefined();
            }
            const failed = { status: 'failed', error: { code: 'internal_error', message: 'test' } } as const;
            // Another token of the sender is not affected; reads at the inclusion's block show it. (One pending request
            // per sender: each ends before the next is stored.)
            const usdc = await buildTransfer(h, { token: USDC, mode: 'none', nonce: nonce + 1n });
            expect(h.store.insertRequest(newRequest(h, usdc), guards(block - 1n)).kind).toBe('inserted');
            h.store.finalize(usdc.id, failed, undefined, now);
            expect(h.store.insertRequest(newRequest(h, none), guards(block)).kind).toBe('inserted');
            // Leave no NONE request of USDT0 pending for the next mode.
            h.store.finalize(none.id, failed, undefined, now);
        }
    });

    it('steps 6 and 7: a NONE request, or a token signature for the next token nonce, right after an included permit', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const permit = await buildTransfer(h, { token: USDT0, mode: 'permit' });
        await h.relay.pipeline.submit(transferOperation, permit.body);
        await h.relay.txManager.tick();

        // The permit is included in the next block. The relay's client still reports the block before as its head while
        // the receipt is visible (another RPC answered it): the relay records the inclusion in a block after its view
        // head, and a submission reads at that head (block B).
        const stale = h.chain.head;
        h.chain.mine();
        const getBlock = h.chain.getBlock;
        h.chain.getBlock = async (tag) => (tag === 'latest' ? stale : getBlock.call(h!.chain, tag));
        await h.relay.txManager.tick();
        expect(h.store.getRequest(permit.id)).toMatchObject({ status: 'mined', blockNumber: stale.number + 1n });
        expect(h.relay.txManager.viewHead()).toBe(stale.number);
        // At B the sender's allowance is still the one it approved before; the permit replaced it and the transfer used
        // it. The token nonce at B is still the one the permit used.
        h.chain.setAllowance(USDT0, USER_ADDRESS, CONTRACT, 10n ** 12n);

        // A token signature for the token nonce after the permit's: the retryable sender_busy, not a permanent
        // invalid_token_authorization from the stale nonce at B.
        const next = await buildTransfer(h, { token: USDT0, mode: 'permit', authNonce: 1n });
        await expect(h.relay.pipeline.submit(transferOperation, next.body)).rejects.toMatchObject({ code: 'sender_busy' });
        // A NONE request (the SDK's next step after sender_busy): not accepted on the stale allowance.
        const none = await buildTransfer(h, { token: USDT0, mode: 'none' });
        await expect(h.relay.pipeline.submit(transferOperation, none.body)).rejects.toMatchObject({ code: 'sender_busy' });
        expect(h.store.getRequest(none.id)).toBeUndefined();

        // Once the relay's view reaches the inclusion, the same body is accepted.
        h.chain.getBlock = getBlock;
        await h.relay.txManager.tick();
        await expect(h.relay.pipeline.submit(transferOperation, none.body)).resolves.toMatchObject({ statusCode: 202 });
    });
});
