// Validation pipeline order and error codes (docs/STEP-1-GAS-ABSTRACTION.md §6.3): which check answers when a
// submission fails several of them. A wallet acts on the code it gets, so a condition that passes with time must get a
// retryable code, not a permanent one, and the local checks must refuse a submission before the relay spends RPC reads
// on it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTransfer, CONTRACT, createHarness, USDC, USDT0, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
});

afterEach(async () => {
    await h.close();
});

const post = async (payload: unknown) => {
    const res = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object });
    return { status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code ?? 'ok' };
};

describe('pipeline order', () => {
    // The pipeline answers a retryable code before it checks a token signature against the live token nonce: a wallet
    // that signs for the next token nonce while a request is pending must not be told that its authorization is invalid
    // (a permanent invalid_token_authorization). A second request of the sender is at its next intent nonce:
    // nonce_too_high (step 4).
    it('a second permit signed for the next token nonce gets the retryable nonce_too_high', async () => {
        expect((await post((await buildTransfer(h, { token: USDT0, mode: 'permit', authNonce: 0n })).body)).status).toBe(202);
        // The wallet anticipates the pending permit and signs the next one with nonce 1: it is told to retry.
        expect(await post((await buildTransfer(h, { token: USDT0, mode: 'permit', authNonce: 1n, nonce: 1n })).body)).toEqual({
            status: 409,
            code: 'nonce_too_high',
        });
        // With the live token nonce the answer is the same.
        expect(await post((await buildTransfer(h, { token: USDT0, mode: 'permit', authNonce: 0n, nonce: 1n })).body)).toEqual({ status: 409, code: 'nonce_too_high' });
    });

    it('policy runs before the signature check, the signature check before any RPC, and the nonce step before the fee step', async () => {
        const reads = () => h.chain.reads.length + h.chain.calls.length;
        const unsigned = await buildTransfer(h, { signWith: `0x${'22'.repeat(32)}` });
        const before = reads();
        expect(await post(unsigned.body)).toEqual({ status: 400, code: 'invalid_signature' });
        expect(reads()).toBe(before);
        // Wrong relay AND bad signature: the policy code wins.
        const both = await buildTransfer(h, { signWith: `0x${'22'.repeat(32)}`, relay: USER_ADDRESS });
        expect(await post(both.body)).toEqual({ status: 400, code: 'wrong_relay' });
        // A used nonce with a fee below break-even: nonce_used (step 4) before fee_too_low (step 5).
        const used = await buildTransfer(h, { fee: 1n });
        h.chain.invalidateNonces(USER_ADDRESS, BigInt(used.request.nonce) + 1n);
        expect(await post(used.body)).toEqual({ status: 409, code: 'nonce_used' });
    });

    it('insufficient_balance (step 6) is reported before insufficient_allowance and sender_busy (step 7)', async () => {
        h.chain.setBalance(USDC, USER_ADDRESS, 0n);
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 0n);
        expect(await post((await buildTransfer(h, { mode: 'none' })).body)).toEqual({ status: 422, code: 'insufficient_balance' });
    });
});
