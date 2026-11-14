// SDK client-side defenses against a malicious relay or calling application: the signing app builds every typed
// data from its own pins and never signs relay-supplied typed data (§7, README rules 1-3). These tests try to
// make the SDK produce a signature that would move funds in a way the user did not intend.
import { describe, expect, it } from 'vitest';
import { createTransferIntent, tokenAuthSigningPayload, transferSigningPayload } from '../../../src/core/intent.js';
import { encodeApproveCalldata, type MetaTxApproveTypedData, type PermitTypedData } from '../../../src/core/typedData.js';
import { validateTransferRequest } from '../../../src/core/validate.js';
import { GaslessValidationError } from '../../../src/core/errors.js';
import { ADDR, NOW, polygonPins, TRANSFER_CONTRACT, USDC, USDT0, sampleRequest } from '../../helpers/fixtures.js';

const pins = polygonPins();
const EVIL = '0x000000000000000000000000000000000000dEaD' as const;

describe('the token authorization is built from pins, never from the relay or calling application', () => {
    it('permit always names the pinned contract and value = amount + fee, whatever the caller wants', () => {
        const intent = createTransferIntent(
            pins,
            { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 10_000_000n, fee: 50_000n, relay: ADDR.relay, authMode: 'permit', deadline: NOW + 600, nonce: 0n, tokenNonce: 0n },
            NOW,
        );
        expect(intent.tokenAuth?.primaryType).toBe('Permit');
        const permit = intent.tokenAuth as PermitTypedData | null;
        // spender is the pinned contract; value is exactly amount + fee, regardless of caller input.
        expect(permit?.message.spender).toBe(TRANSFER_CONTRACT);
        expect(permit?.message.value).toBe('10050000');
        expect(permit?.message.deadline).toBe(String(NOW + 600)); // permit deadline == intent deadline
    });

    it('USDT0 meta-tx approve encodes approve(pinnedContract, amount+fee) as calldata, not an attacker call', () => {
        const intent = createTransferIntent(
            pins,
            { token: USDT0, from: ADDR.user, to: ADDR.recipient, amount: 1_000_000n, fee: 20_000n, relay: ADDR.relay, authMode: 'metaTxApprove', deadline: NOW + 600, nonce: 0n, tokenNonce: 5n },
            NOW,
            { allowMetaTxApprove: true },
        );
        expect(intent.tokenAuth?.primaryType).toBe('MetaTransaction');
        const metaTx = intent.tokenAuth as MetaTxApproveTypedData | null;
        expect(metaTx?.message.functionSignature).toBe(encodeApproveCalldata(TRANSFER_CONTRACT, 1_020_000n));
    });
});

describe('validateTransferRequest rejects an intent paired with a mismatched TokenAuth (§7)', () => {
    // A malicious caller could supply a real intent but a token authorization that approves an
    // attacker or a larger value. Validation before signing must catch every such mismatch.
    const base = {
        chainId: 137,
        contract: TRANSFER_CONTRACT,
        request: sampleRequest(),
        authMode: 'permit' as const,
    };
    const goodPermit = {
        domain: { name: 'USD Coin', version: '2', chainId: 137, verifyingContract: USDC },
        types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } as const,
        primaryType: 'Permit' as const,
        message: { owner: ADDR.user, spender: TRANSFER_CONTRACT, value: '10050000', nonce: '0', deadline: String(NOW + 600) },
    };

    it('accepts the correct permit', () => {
        expect(validateTransferRequest({ ...base, tokenAuth: goodPermit }, pins, NOW).ok).toBe(true);
    });

    it('rejects a permit whose spender is the attacker', () => {
        const r = validateTransferRequest({ ...base, tokenAuth: { ...goodPermit, message: { ...goodPermit.message, spender: EVIL } } }, pins, NOW);
        expect(r).toMatchObject({ ok: false, code: 'auth_spender_mismatch' });
    });

    it('rejects a permit whose value exceeds amount + fee', () => {
        const r = validateTransferRequest({ ...base, tokenAuth: { ...goodPermit, message: { ...goodPermit.message, value: '1000000000000' } } }, pins, NOW);
        expect(r).toMatchObject({ ok: false, code: 'auth_value_mismatch' });
    });

    it('rejects a permit whose owner is not the sender', () => {
        const r = validateTransferRequest({ ...base, tokenAuth: { ...goodPermit, message: { ...goodPermit.message, owner: ADDR.other } } }, pins, NOW);
        expect(r).toMatchObject({ ok: false, code: 'auth_owner_mismatch' });
    });

    it('rejects a permit deadline that is not the intent deadline (e.g. infinite approval window)', () => {
        const r = validateTransferRequest(
            { ...base, tokenAuth: { ...goodPermit, message: { ...goodPermit.message, deadline: String(2n ** 256n - 1n) } } },
            pins,
            NOW,
        );
        expect(r).toMatchObject({ ok: false, code: 'auth_deadline_mismatch' });
    });
});

/** The code of the GaslessValidationError `run` throws. */
function codeOf(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(GaslessValidationError);
        return (error as GaslessValidationError).code;
    }
    return 'no error';
}

describe('the intent itself is bound to the pinned deployment', () => {
    it('refuses to build an intent for a relay the client did not pin (wrong_relay)', () => {
        expect(
            codeOf(() =>
                createTransferIntent(
                    pins,
                    { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 1_000_000n, fee: 50_000n, relay: EVIL, authMode: 'permit', deadline: NOW + 600, nonce: 0n, tokenNonce: 0n },
                    NOW,
                ),
            ),
        ).toBe('wrong_relay');
    });

    it('refuses a recipient on the D11 denylist', () => {
        expect(
            codeOf(() =>
                createTransferIntent(
                    pins,
                    { token: USDC, from: ADDR.user, to: '0x98E69a6927747339d5E543586FC0262112eBe4BD', amount: 1_000_000n, fee: 50_000n, relay: ADDR.relay, authMode: 'permit', deadline: NOW + 600, nonce: 0n, tokenNonce: 0n },
                    NOW,
                ),
            ),
        ).toBe('invalid_recipient');
    });

    it('re-validates and rebuilds typed data at signing time, so a stored intent tampered against the pins cannot be signed', () => {
        const intent = createTransferIntent(
            pins,
            { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 1_000_000n, fee: 50_000n, relay: ADDR.relay, authMode: 'permit', deadline: NOW + 600, nonce: 0n, tokenNonce: 0n },
            NOW,
        );
        const authorization = { mode: 'permit' as const, v: 27, r: `0x${'11'.repeat(32)}` as const, s: `0x${'22'.repeat(32)}` as const };
        const permit = intent.tokenAuth as PermitTypedData;
        // Attacker mutates the stored intent after validation but before signing.
        const cases: Array<[string, typeof intent]> = [
            ['wrong_relay', { ...intent, request: { ...intent.request, relay: EVIL } }],
            ['invalid_recipient', { ...intent, request: { ...intent.request, to: USDC } }],
            ['invalid_amount', { ...intent, request: { ...intent.request, fee: (2n ** 256n - 1n).toString() } }],
            // No cap catches a raised fee; the stored permit's value does.
            ['auth_value_mismatch', { ...intent, request: { ...intent.request, fee: '5000001' } }],
            ['auth_value_mismatch', { ...intent, request: { ...intent.request, amount: '2000000' } }],
            ['auth_spender_mismatch', { ...intent, tokenAuth: { ...permit, message: { ...permit.message, spender: EVIL } } }],
        ];
        for (const [code, tampered] of cases) {
            expect(codeOf(() => tokenAuthSigningPayload(pins, tampered, NOW)), code).toBe(code);
            expect(codeOf(() => transferSigningPayload(pins, tampered, authorization, NOW)), code).toBe(code);
        }
    });

    it('the intent signature covers the token authorization: a relay cannot pair the signature with another authorization', () => {
        const intent = createTransferIntent(
            pins,
            { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 1_000_000n, fee: 50_000n, relay: ADDR.relay, authMode: 'permit', deadline: NOW + 600, nonce: 0n, tokenNonce: 0n },
            NOW,
        );
        const authorization = { mode: 'permit' as const, v: 27, r: `0x${'11'.repeat(32)}` as const, s: `0x${'22'.repeat(32)}` as const };
        const signed = transferSigningPayload(pins, intent, authorization, NOW);
        expect(signed.message.auth).toEqual({ mode: 1, v: 27, r: authorization.r, s: authorization.s });
        // An authorization of another mode than the intent's is refused before signing.
        expect(codeOf(() => transferSigningPayload(pins, intent, { ...authorization, mode: 'metaTxApprove' }, NOW))).toBe('auth_type_mismatch');
        expect(codeOf(() => transferSigningPayload(pins, intent, { mode: 'none', v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` }, NOW))).toBe('auth_type_mismatch');
    });
});
