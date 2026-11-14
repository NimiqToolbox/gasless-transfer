// createTransferIntent, buildTokenAuthTypedData, tokenAuthSigningPayload, transferSigningPayload,
// normalizeTransferRequest, buildSubmitTransferBody and validateSubmitTransferBody.

import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { POLYGON_USDC, POLYGON_USDT0 } from '../../src/core/constants.js';
import { transferDigest } from '../../src/core/eip712.js';
import { GaslessValidationError } from '../../src/core/errors.js';
import {
    buildTokenAuthTypedData,
    createTransferIntent,
    tokenAuthSigningPayload,
    transferSigningPayload,
    type TransferIntentParams,
} from '../../src/core/intent.js';
import { splitSignature, toTokenAuthorization } from '../../src/core/signature.js';
import { buildSubmitTransferBody, normalizeTransferRequest } from '../../src/core/submit.js';
import { buildPermitTypedData, buildTransferTypedData, encodeApproveCalldata } from '../../src/core/typedData.js';
import type { Hex, TokenAuthorization } from '../../src/core/types.js';
import { checkCorrection, validateSubmitTransferBody, validateTransferRequest } from '../../src/core/validate.js';
import { ADDR, KEYS, NONE_AUTH, NOW, polygonPins, SAMPLE_PERMIT_AUTH, sampleRequest, TRANSFER_CONTRACT, USDC, USDT0, ZERO32 } from '../helpers/fixtures.js';

const pins = polygonPins();

function params(overrides: Partial<TransferIntentParams> = {}): TransferIntentParams {
    return {
        token: USDC,
        from: ADDR.user,
        to: ADDR.recipient,
        amount: 10_000_000n,
        fee: '50000',
        relay: ADDR.relay,
        authMode: 'permit',
        deadline: NOW + 600,
        nonce: 5n,
        tokenNonce: 4n,
        ...overrides,
    };
}

function errorOf(fn: () => unknown): GaslessValidationError {
    try {
        fn();
    } catch (error) {
        if (error instanceof GaslessValidationError) return error;
        throw error;
    }
    throw new Error('expected a GaslessValidationError');
}

const asViem = (payload: unknown) => payload as TypedDataDefinition;

/** Signs an intent the way a client does: the token authorization first, then the transfer over it. */
async function signIntent(intent: ReturnType<typeof createTransferIntent>, now = NOW) {
    const account = privateKeyToAccount(KEYS.user);
    const tokenAuth = tokenAuthSigningPayload(pins, intent, now);
    const authorization = toTokenAuthorization(intent.authMode, tokenAuth === null ? null : await account.signTypedData(asViem(tokenAuth)));
    const transfer = transferSigningPayload(pins, intent, authorization, now);
    return { authorization, transfer, signature: await account.signTypedData(asViem(transfer)) };
}

describe('createTransferIntent', () => {
    it('builds a USDC permit intent from the pins: spender = contract, value = amount + fee, deadline = intent deadline', () => {
        const intent = createTransferIntent(pins, params({ from: ADDR.user.toLowerCase() }), NOW);
        expect(intent.chainId).toBe(137);
        expect(intent.contract).toBe(TRANSFER_CONTRACT);
        expect(intent.request).toEqual({
            token: USDC,
            from: ADDR.user,
            to: ADDR.recipient,
            amount: '10000000',
            fee: '50000',
            relay: ADDR.relay,
            nonce: '5',
            deadline: String(NOW + 600),
        });
        expect(intent.tokenAuth).toEqual(
            buildPermitTypedData({ tokenDomain: POLYGON_USDC.domain, owner: ADDR.user, spender: TRANSFER_CONTRACT, value: 10_050_000n, nonce: 4n, deadline: String(NOW + 600) }),
        );
        // The id needs the signed token authorization: the intent has none yet.
        expect(intent).not.toHaveProperty('id');
        expect(Object.isFrozen(intent.tokenAuth?.message)).toBe(true);
    });

    it('takes the intent nonce as given (bigint, number or decimal string); without one and without corrects it refuses', () => {
        for (const nonce of [0n, 0, '0', '000']) expect(createTransferIntent(pins, params({ nonce }), NOW).request.nonce).toBe('0');
        expect(createTransferIntent(pins, params({ nonce: (1n << 256n) - 1n }), NOW).request.nonce).toBe(((1n << 256n) - 1n).toString());
        const missing = errorOf(() => createTransferIntent(pins, params({ nonce: undefined }), NOW));
        expect({ code: missing.code, field: missing.field }).toEqual({ code: 'invalid_request', field: 'nonce' });
        expect(missing.message).toMatch(/nonces\(from\)/);
        for (const bad of [`0x${'ab'.repeat(32)}`, '-1', '1.5', 1.5, -1n, 1n << 256n]) {
            expect(errorOf(() => createTransferIntent(pins, params({ nonce: bad as never }), NOW)).field, String(bad)).toBe('request.nonce');
        }
    });

    it('builds a USDT0 meta-tx approve for the pinned contract and amount + fee (with allowMetaTxApprove)', () => {
        const intent = createTransferIntent(pins, params({ token: USDT0, authMode: 'metaTxApprove', tokenNonce: '9' }), NOW, { allowMetaTxApprove: true });
        expect(intent.tokenAuth?.domain).toEqual(POLYGON_USDT0.domain);
        expect(intent.tokenAuth?.message).toEqual({ nonce: '9', from: ADDR.user, functionSignature: encodeApproveCalldata(TRANSFER_CONTRACT, 10_050_000n) });
    });

    it('refuses a META_TX approval for a token that has permit unless the caller sets allowMetaTxApprove', () => {
        const metaTx = params({ token: USDT0, authMode: 'metaTxApprove', tokenNonce: '9' });
        for (const options of [undefined, {}, { allowMetaTxApprove: false }, { allowMetaTxApprove: 'yes' as never }]) {
            const error = errorOf(() => createTransferIntent(pins, metaTx, NOW, options));
            expect(error.code).toBe('meta_tx_approve_not_allowed');
            expect(error.field).toBe('authMode');
            expect(error.message).toMatch(/permit/);
        }
        // Fields from the client cannot carry the opt-in: only the options argument counts.
        expect(errorOf(() => createTransferIntent(pins, { ...metaTx, allowMetaTxApprove: true } as never, NOW)).code).toBe('meta_tx_approve_not_allowed');
        // Permit and none need no opt-in.
        expect(createTransferIntent(pins, params({ token: USDT0 }), NOW).authMode).toBe('permit');
        expect(createTransferIntent(pins, params({ token: USDT0, authMode: 'none', tokenNonce: undefined }), NOW).authMode).toBe('none');
        // Earlier failures keep their own code: an unpinned relay is wrong_relay, not the META_TX refusal.
        expect(errorOf(() => createTransferIntent(pins, { ...metaTx, relay: ADDR.other }, NOW)).code).toBe('wrong_relay');
    });

    it('a token without permit gets its META_TX approval without the opt-in', () => {
        const noPermit = polygonPins({
            chainId: 31337,
            tokens: [
                {
                    symbol: 'USDT0',
                    address: USDT0,
                    decimals: 6,
                    authModes: ['metaTxApprove', 'none'],
                    domain: { ...POLYGON_USDT0.domain, salt: `0x${(31337).toString(16).padStart(64, '0')}` },
                },
            ],
        });
        const intent = createTransferIntent(noPermit, params({ token: USDT0, authMode: 'metaTxApprove', tokenNonce: '2' }), NOW);
        expect(intent.tokenAuth?.primaryType).toBe('MetaTransaction');
    });

    it("refuses a fee above the caller's maxAcceptableFee, after the pins' own checks", () => {
        expect(createTransferIntent(pins, params(), NOW, { maxAcceptableFee: 50_000n }).request.fee).toBe('50000');
        expect(createTransferIntent(pins, params(), NOW, { maxAcceptableFee: '50000' }).request.fee).toBe('50000');
        for (const maxAcceptableFee of [49_999n, '49999', 49_999]) {
            const error = errorOf(() => createTransferIntent(pins, params(), NOW, { maxAcceptableFee }));
            expect({ code: error.code, field: error.field }).toEqual({ code: 'fee_above_limit', field: 'request.fee' });
        }
        for (const bad of [-1n, '1.5', 'abc', '', 1.5]) {
            const error = errorOf(() => createTransferIntent(pins, params(), NOW, { maxAcceptableFee: bad as never }));
            expect({ code: error.code, field: error.field }).toEqual({ code: 'invalid_request', field: 'maxAcceptableFee' });
        }
        // The pins' own checks still decide first.
        expect(errorOf(() => createTransferIntent(pins, params({ fee: 5_000_001n, relay: ADDR.other }), NOW, { maxAcceptableFee: 1n })).code).toBe('wrong_relay');
        expect(errorOf(() => createTransferIntent(pins, params({ amount: 1n, fee: (1n << 256n) - 1n }), NOW, { maxAcceptableFee: 1n })).code).toBe('invalid_amount');
        // The ceiling cannot come in with the fields.
        expect(createTransferIntent(pins, { ...params(), maxAcceptableFee: 1n } as never, NOW).request.fee).toBe('50000');
    });

    // No fee cap: only the caller's maxAcceptableFee bounds the fee it signs.
    it('takes a fee of 50.00 without maxAcceptableFee, and refuses it with a lower one', () => {
        for (const token of [USDC, USDT0]) {
            const intent = createTransferIntent(pins, params({ token, fee: 50_000_000n }), NOW);
            expect(intent.request.fee).toBe('50000000');
            expect(intent.tokenAuth?.message).toMatchObject({ value: '60000000' });
            expect(createTransferIntent(pins, params({ token, fee: 50_000_000n }), NOW, { maxAcceptableFee: 50_000_000n }).request.fee).toBe('50000000');
            const error = errorOf(() => createTransferIntent(pins, params({ token, fee: 50_000_000n }), NOW, { maxAcceptableFee: 5_000_000n }));
            expect({ code: error.code, field: error.field }).toEqual({ code: 'fee_above_limit', field: 'request.fee' });
        }
        const largest = createTransferIntent(pins, params({ amount: 1n, fee: (1n << 256n) - 2n }), NOW);
        expect(largest.tokenAuth?.message).toMatchObject({ value: ((1n << 256n) - 1n).toString() });
    });

    it('has no token authorization in mode "none"', () => {
        const intent = createTransferIntent(pins, params({ authMode: 'none', tokenNonce: undefined }), NOW);
        expect(intent.tokenAuth).toBeNull();
    });

    it.each([
        ['invalid_request', 'request.to', { to: 'bob' }],
        ['invalid_request', 'request.amount', { amount: -1n }],
        ['invalid_request', 'request.nonce', { nonce: '0x12' }],
        ['invalid_request', 'authMode', { authMode: 'approve' }],
        ['wrong_relay', 'request.relay', { relay: ADDR.other }],
        ['unsupported_token', 'request.token', { token: ADDR.other }],
        ['unsupported_auth_mode', 'authMode', { authMode: 'metaTxApprove' }],
        ['invalid_amount', 'request.amount', { amount: 0 }],
        ['invalid_recipient', 'request.to', { to: TRANSFER_CONTRACT }],
        ['deadline_out_of_range', 'request.deadline', { deadline: 0 }],
        ['invalid_amount', 'request.amount', { amount: 1n, fee: (1n << 256n) - 1n }],
        ['invalid_amount', 'request.amount', { amount: (1n << 256n) - 1n, fee: 1n }],
        ['auth_missing', 'tokenNonce', { tokenNonce: undefined }],
        ['invalid_request', 'tokenNonce', { tokenNonce: 'x' }],
    ])('rejects with %s at %s', (code, field, overrides) => {
        const error = errorOf(() => createTransferIntent(pins, params(overrides as Partial<TransferIntentParams>), NOW));
        expect(error.code).toBe(code);
        expect(error.field).toBe(field);
    });
});

describe('buildTokenAuthTypedData', () => {
    it('returns null for "none" and refuses unpinned tokens or unsupported modes', () => {
        const request = sampleRequest();
        expect(buildTokenAuthTypedData(pins, request, 'none', undefined)).toBeNull();
        expect(errorOf(() => buildTokenAuthTypedData(pins, sampleRequest({ token: ADDR.other }), 'permit', 0n)).code).toBe('unsupported_token');
        expect(errorOf(() => buildTokenAuthTypedData(pins, request, 'metaTxApprove', 0n)).code).toBe('unsupported_auth_mode');
    });
});

describe('tokenAuthSigningPayload and transferSigningPayload', () => {
    it('rebuild the payloads from validated fields: the token authorization first, then the transfer over it', () => {
        const intent = createTransferIntent(pins, params(), NOW);
        expect(tokenAuthSigningPayload(pins, intent, NOW + 30)).toEqual(intent.tokenAuth);
        const transfer = transferSigningPayload(pins, intent, SAMPLE_PERMIT_AUTH, NOW + 30);
        expect(transfer).toEqual(buildTransferTypedData(137, TRANSFER_CONTRACT, intent.request, SAMPLE_PERMIT_AUTH));
        expect(transfer.message.auth).toEqual({ mode: 1, v: 27, r: SAMPLE_PERMIT_AUTH.r, s: SAMPLE_PERMIT_AUTH.s });
        expect(transfer.domain).toEqual(pins.transfer.domain);
        expect(Object.isFrozen(transfer.message.auth)).toBe(true);
    });

    it('accept a mode "none" intent without tokenAuth (plain JS); the transfer signs zeros for it', () => {
        const intent = createTransferIntent(pins, params({ authMode: 'none', tokenNonce: undefined }), NOW);
        const { tokenAuth: _none, ...withoutTokenAuth } = intent;
        expect(tokenAuthSigningPayload(pins, withoutTokenAuth as never, NOW)).toBeNull();
        expect(transferSigningPayload(pins, withoutTokenAuth as never, toTokenAuthorization('none'), NOW).message.auth).toEqual({ mode: 0, v: 0, r: ZERO32, s: ZERO32 });
    });

    it('the transfer refuses an authorization of another mode, or not in the form the relay submits', () => {
        const permit = createTransferIntent(pins, params(), NOW);
        const none = createTransferIntent(pins, params({ authMode: 'none', tokenNonce: undefined }), NOW);
        const cases: Array<[typeof permit, unknown, string, string]> = [
            [permit, NONE_AUTH, 'auth_type_mismatch', 'authorization.mode'],
            [permit, { ...SAMPLE_PERMIT_AUTH, mode: 'metaTxApprove' }, 'auth_type_mismatch', 'authorization.mode'],
            [none, SAMPLE_PERMIT_AUTH, 'auth_type_mismatch', 'authorization.mode'],
            [none, { ...NONE_AUTH, v: 27 }, 'auth_unexpected', 'authorization'],
            [none, { mode: 'none' }, 'invalid_request', 'authorization'],
            [permit, { ...SAMPLE_PERMIT_AUTH, v: 0 }, 'invalid_signature', 'authorization.v'],
            [permit, { ...SAMPLE_PERMIT_AUTH, s: ZERO32 }, 'invalid_signature', 'authorization'],
            [permit, undefined, 'invalid_request', 'authorization'],
        ];
        for (const [intent, authorization, code, field] of cases) {
            const error = errorOf(() => transferSigningPayload(pins, intent, authorization as TokenAuthorization, NOW));
            expect({ code: error.code, field: error.field }, JSON.stringify(authorization)).toEqual({ code, field });
        }
    });

    it('re-check the deadline window at signing time', () => {
        const intent = createTransferIntent(pins, params(), NOW);
        expect(errorOf(() => tokenAuthSigningPayload(pins, intent, NOW + 541)).code).toBe('deadline_out_of_range');
        expect(errorOf(() => transferSigningPayload(pins, intent, SAMPLE_PERMIT_AUTH, NOW + 541)).code).toBe('deadline_out_of_range');
    });

    it('refuse a tampered intent: spender, value, domain, contract, relay, nonce', () => {
        const intent = createTransferIntent(pins, params(), NOW);
        const tokenAuth = intent.tokenAuth as NonNullable<typeof intent.tokenAuth>;
        const cases: Array<[string, object]> = [
            ['auth_spender_mismatch', { tokenAuth: { ...tokenAuth, message: { ...tokenAuth.message, spender: ADDR.other } } }],
            ['auth_value_mismatch', { tokenAuth: { ...tokenAuth, message: { ...tokenAuth.message, value: '1' } } }],
            ['auth_domain_mismatch', { tokenAuth: { ...tokenAuth, domain: POLYGON_USDT0.domain } }],
            ['wrong_contract', { contract: ADDR.other }],
            ['wrong_relay', { request: { ...intent.request, relay: ADDR.other } }],
            ['invalid_request', { request: { ...intent.request, nonce: `0x${'00'.repeat(32)}` } }],
        ];
        for (const [code, change] of cases) {
            expect(errorOf(() => tokenAuthSigningPayload(pins, { ...intent, ...change }, NOW)).code, code).toBe(code);
            expect(errorOf(() => transferSigningPayload(pins, { ...intent, ...change }, SAMPLE_PERMIT_AUTH, NOW)).code, code).toBe(code);
        }
        expect(errorOf(() => tokenAuthSigningPayload(pins, null as never, NOW)).code).toBe('invalid_request');
    });

    it("refuse a fee above the caller's maxAcceptableFee at signing time", () => {
        const intent = createTransferIntent(pins, params(), NOW);
        expect(transferSigningPayload(pins, intent, SAMPLE_PERMIT_AUTH, NOW, { maxAcceptableFee: 50_000n }).message.fee).toBe('50000');
        for (const run of [
            () => tokenAuthSigningPayload(pins, intent, NOW, { maxAcceptableFee: 40_000n }),
            () => transferSigningPayload(pins, intent, SAMPLE_PERMIT_AUTH, NOW, { maxAcceptableFee: 40_000n }),
        ]) {
            const error = errorOf(run);
            expect({ code: error.code, field: error.field }).toEqual({ code: 'fee_above_limit', field: 'request.fee' });
        }
        expect(errorOf(() => tokenAuthSigningPayload(pins, intent, NOW, { maxAcceptableFee: 'x' as never })).code).toBe('invalid_request');
    });

    it('sign the auth mode the intent was built with: a META_TX intent built with the opt-in stays signable', () => {
        const intent = createTransferIntent(pins, params({ token: USDT0, authMode: 'metaTxApprove' }), NOW, { allowMetaTxApprove: true });
        expect(tokenAuthSigningPayload(pins, intent, NOW)?.primaryType).toBe('MetaTransaction');
    });

    it('produce payloads whose signatures recover to the owner; the transfer digest covers the authorization', async () => {
        const intent = createTransferIntent(pins, params({ token: USDT0, authMode: 'metaTxApprove' }), NOW, { allowMetaTxApprove: true });
        const { authorization, transfer, signature } = await signIntent(intent);
        expect(await recoverTypedDataAddress({ ...asViem(transfer), signature })).toBe(ADDR.user);
        const body = buildSubmitTransferBody({ request: intent.request, signature, authorization });
        expect(validateSubmitTransferBody(body, pins, NOW)).toEqual({ ok: true });
        // Another authorization is another digest: a relay cannot swap it.
        const swapped = { ...authorization, s: `0x${'01'.repeat(32)}` as Hex };
        expect(transferDigest(137, TRANSFER_CONTRACT, intent.request, swapped)).not.toBe(transferDigest(137, TRANSFER_CONTRACT, intent.request, authorization));
        expect(await recoverTypedDataAddress({ ...asViem(buildTransferTypedData(137, TRANSFER_CONTRACT, intent.request, swapped)), signature })).not.toBe(ADDR.user);
    });

    it('validateTransferRequest checks a given authorization against the auth mode', () => {
        const intent = createTransferIntent(pins, params(), NOW);
        expect(validateTransferRequest({ ...intent, authorization: SAMPLE_PERMIT_AUTH }, pins, NOW)).toEqual({ ok: true });
        expect(validateTransferRequest({ ...intent, authorization: NONE_AUTH }, pins, NOW)).toMatchObject({ ok: false, code: 'auth_type_mismatch' });
    });
});

describe('normalizeTransferRequest', () => {
    it('checksums addresses and canonicalizes integers, also the intent nonce', () => {
        const request = normalizeTransferRequest({
            token: USDC.toLowerCase(),
            from: ADDR.user.toLowerCase(),
            to: ADDR.recipient,
            amount: 10n,
            fee: '0050',
            relay: ADDR.relay.toLowerCase(),
            nonce: '007',
            deadline: NOW + 600,
        });
        expect(request).toEqual(sampleRequest({ amount: '10', fee: '50' }));
        expect(Object.keys(request)).toEqual(['token', 'from', 'to', 'amount', 'fee', 'relay', 'nonce', 'deadline']);
        expect(normalizeTransferRequest({ ...sampleRequest(), nonce: 7n }).nonce).toBe('7');
    });

    it('rejects unknown fields, bad checksums, unsafe numbers, a bytes32 nonce', () => {
        expect(errorOf(() => normalizeTransferRequest({ ...sampleRequest(), data: '0x' } as never)).field).toBe('request.data');
        expect(errorOf(() => normalizeTransferRequest({ ...sampleRequest(), to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293Bc' })).field).toBe('request.to');
        expect(errorOf(() => normalizeTransferRequest({ ...sampleRequest(), amount: 2 ** 60 })).field).toBe('request.amount');
        expect(errorOf(() => normalizeTransferRequest({ ...sampleRequest(), nonce: `0x${'ab'.repeat(32)}` })).field).toBe('request.nonce');
        expect(errorOf(() => normalizeTransferRequest({ ...sampleRequest(), nonce: undefined as never })).field).toBe('request.nonce');
        expect(errorOf(() => normalizeTransferRequest(null as never)).field).toBe('request');
    });
});

describe('buildSubmitTransferBody', () => {
    it('assembles the wire body: canonical request, normalized low-s signature with v 27/28, the signed authorization', async () => {
        const intent = createTransferIntent(pins, params(), NOW);
        const { authorization, signature } = await signIntent(intent);
        const vZero = `${signature.slice(0, 130)}${splitSignature(signature).v === 27 ? '00' : '01'}`;
        const body = buildSubmitTransferBody({
            request: { ...intent.request, to: intent.request.to.toLowerCase(), nonce: 5n },
            signature: vZero.toUpperCase().replace('0X', '0x'),
            authorization: { ...authorization, r: authorization.r.toUpperCase().replace('0X', '0x') as Hex },
            quoteId: 'q-1',
        });
        expect(body).toStrictEqual({ request: intent.request, signature: signature.toLowerCase(), authorization, quoteId: 'q-1' });
        expect(body.request.nonce).toBe('5');
        expect(JSON.parse(JSON.stringify(body))).toEqual(body);
        expect(validateSubmitTransferBody(body, pins, NOW)).toEqual({ ok: true });
    });

    it('rejects a bad signature, authorization or quoteId', async () => {
        const intent = createTransferIntent(pins, params({ authMode: 'none', tokenNonce: undefined }), NOW);
        const { signature } = await signIntent(intent);
        const base = { request: intent.request, signature, authorization: NONE_AUTH };
        expect(buildSubmitTransferBody(base)).toEqual({ ...base, signature: signature.toLowerCase() });
        expect(errorOf(() => buildSubmitTransferBody({ ...base, signature: signature.slice(0, 130) })).code).toBe('invalid_signature');
        expect(errorOf(() => buildSubmitTransferBody({ ...base, authorization: { mode: 'none' } as never })).code).toBe('invalid_request');
        expect(errorOf(() => buildSubmitTransferBody({ ...base, authorization: { ...NONE_AUTH, v: 27 } })).code).toBe('auth_unexpected');
        expect(errorOf(() => buildSubmitTransferBody({ ...base, authorization: { ...SAMPLE_PERMIT_AUTH, v: 1 } })).code).toBe('invalid_signature');
        expect(errorOf(() => buildSubmitTransferBody({ ...base, quoteId: '' })).field).toBe('quoteId');
        expect(errorOf(() => buildSubmitTransferBody({ ...base, quoteId: 'x'.repeat(257) })).field).toBe('quoteId');
    });
});

describe('validateSubmitTransferBody', () => {
    it('checks structure, signature format, authorization format and policy', async () => {
        const intent = createTransferIntent(pins, params({ authMode: 'none', tokenNonce: undefined }), NOW);
        const { signature } = await signIntent(intent);
        const body = buildSubmitTransferBody({ request: intent.request, signature, authorization: NONE_AUTH });
        const { r, s } = splitSignature(signature);
        const expectCode = (value: unknown, code: string) => {
            const result = validateSubmitTransferBody(value as typeof body, pins, NOW);
            expect(result.ok ? 'ok' : result.code, JSON.stringify(value)).toBe(code);
        };
        expectCode(body, 'ok');
        expectCode(null, 'invalid_request');
        expectCode({ ...body, to: ADDR.other }, 'invalid_request');
        expectCode({ ...body, request: { ...body.request, nonce: `0x${'00'.repeat(32)}` } }, 'invalid_request');
        expectCode({ ...body, request: { ...body.request, nonce: 5 } }, 'invalid_request');
        expectCode({ ...body, signature: '0x' }, 'invalid_signature');
        expectCode({ ...body, authorization: { mode: 'none' } }, 'invalid_request');
        expectCode({ ...body, authorization: { mode: 'permit', v: 27, r } }, 'invalid_request');
        expectCode({ ...body, authorization: { ...NONE_AUTH, r } }, 'auth_unexpected');
        expectCode({ ...body, authorization: { mode: 'permit', ...splitSignature(signature) } }, 'invalid_request');
        expectCode({ ...body, authorization: { mode: 'permit', v: 27, r, s } }, 'ok');
        expectCode({ ...body, authorization: { mode: 'permit', v: 0, r, s } }, 'invalid_signature');
        expectCode({ ...body, authorization: { mode: 'metaTxApprove', v: 27, r, s } }, 'unsupported_auth_mode');
        expectCode({ ...body, quoteId: 5 }, 'invalid_request');
        expectCode({ ...body, request: { ...body.request, relay: ADDR.other } }, 'wrong_relay');
        expectCode({ ...body, request: { ...body.request, to: USDC } }, 'invalid_recipient');
        // No fee cap: a body with a raised fee is well-formed (its signature no longer matches; the relay checks that);
        // amount + fee above uint256 is not.
        expectCode({ ...body, request: { ...body.request, fee: '5000001' } }, 'ok');
        expectCode({ ...body, request: { ...body.request, fee: (2n ** 256n - 1n).toString() } }, 'invalid_amount');
        expect(validateSubmitTransferBody(body, pins, NOW + 541).ok).toBe(false);
    });

    it('accepts only the wire form the relay accepts: checksummed addresses and a signature with v 27 or 28', async () => {
        const intent = createTransferIntent(pins, params({ authMode: 'none', tokenNonce: undefined }), NOW);
        const { signature } = await signIntent(intent);
        const body = buildSubmitTransferBody({ request: intent.request, signature, authorization: NONE_AUTH });
        const result = (value: unknown) => validateSubmitTransferBody(value as typeof body, pins, NOW);
        for (const key of ['token', 'from', 'to', 'relay'] as const) {
            const lower = { ...body, request: { ...body.request, [key]: body.request[key].toLowerCase() } };
            expect(result(lower), key).toMatchObject({ ok: false, code: 'invalid_request', field: `request.${key}` });
            const upper = { ...body, request: { ...body.request, [key]: `0x${body.request[key].slice(2).toUpperCase()}` } };
            expect(result(upper), key).toMatchObject({ ok: false, code: 'invalid_request', field: `request.${key}` });
        }
        // v as 0 or 1 (a hardware wallet): `splitSignature` reads it, the relay and the contract do not.
        const yParity = (Number.parseInt(body.signature.slice(130), 16) - 27).toString(16).padStart(2, '0');
        const rawV = `${body.signature.slice(0, 130)}${yParity}`;
        expect(result({ ...body, signature: rawV })).toMatchObject({ ok: false, code: 'invalid_signature', field: 'signature' });
        expect(result(buildSubmitTransferBody({ request: intent.request, signature: rawV, authorization: NONE_AUTH }))).toEqual({ ok: true });
        // Hex case is not part of the wire form: the relay lowercases the signature.
        expect(result({ ...body, signature: `0x${body.signature.slice(2).toUpperCase()}` })).toEqual({ ok: true });
    });

    it('with { repost: true } only the deadline window is skipped; every other check stays', async () => {
        const intent = createTransferIntent(pins, params({ authMode: 'none', tokenNonce: undefined }), NOW);
        const { signature } = await signIntent(intent);
        const body = buildSubmitTransferBody({ request: intent.request, signature, authorization: NONE_AUTH });
        const code = (value: unknown, now: number, options?: { repost?: boolean }) => {
            const result = validateSubmitTransferBody(value as typeof body, pins, now, options);
            return result.ok ? 'ok' : result.code;
        };
        // Too late, past the deadline, and too far ahead: a first post is refused, a re-post is not.
        for (const now of [NOW + 541, NOW + 600, NOW + 86_400, NOW - 7_000]) {
            expect(code(body, now), String(now)).toBe('deadline_out_of_range');
            expect(code(body, now, { repost: true }), String(now)).toBe('ok');
            expect(code(body, now, { repost: false }), String(now)).toBe('deadline_out_of_range');
        }
        const late = NOW + 3_600;
        expect(code({ ...body, request: { ...body.request, relay: ADDR.other } }, late, { repost: true })).toBe('wrong_relay');
        expect(code({ ...body, request: { ...body.request, to: USDC } }, late, { repost: true })).toBe('invalid_recipient');
        expect(code({ ...body, request: { ...body.request, fee: (2n ** 256n - 1n).toString() } }, late, { repost: true })).toBe('invalid_amount');
        expect(code({ ...body, request: { ...body.request, amount: '0' } }, late, { repost: true })).toBe('invalid_amount');
        expect(code({ ...body, signature: '0x' }, late, { repost: true })).toBe('invalid_signature');
        expect(code({ ...body, extra: 1 }, late, { repost: true })).toBe('invalid_request');
        expect(() => validateSubmitTransferBody(body, pins, Date.now(), { repost: true })).toThrow(TypeError);
    });
});

describe('corrections: createTransferIntent with corrects, checkCorrection', () => {
    const first = () => createTransferIntent(pins, params({ deadline: NOW + 1_200 }), NOW);

    it('keeps the intent nonce of the corrected version when no nonce is given; the correction is otherwise an ordinary intent', () => {
        const a = first();
        const b = createTransferIntent(pins, params({ nonce: undefined, fee: '60000', deadline: NOW + 1_200, corrects: a.request }), NOW);
        expect(b.request.nonce).toBe(a.request.nonce);
        expect(b.tokenAuth?.message).toMatchObject({ value: '10060000', deadline: String(NOW + 1_200) });
        // The same nonce given explicitly, in any form, is fine.
        expect(createTransferIntent(pins, params({ nonce: '0005', deadline: NOW + 1_200, corrects: a.request }), NOW).request.nonce).toBe(a.request.nonce);
    });

    it('may change amount, fee, relay, auth mode and token nonce, and move the deadline later', () => {
        const a = first();
        const twoRelays = polygonPins({ relays: [ADDR.relay, ADDR.other] });
        const b = createTransferIntent(
            twoRelays,
            params({ nonce: undefined, amount: 9_000_000n, fee: '1000000', relay: ADDR.other, authMode: 'none', tokenNonce: undefined, deadline: NOW + 7_200, corrects: a.request }),
            NOW,
        );
        expect({ nonce: b.request.nonce, relay: b.request.relay, amount: b.request.amount, authMode: b.authMode }).toEqual({
            nonce: a.request.nonce,
            relay: ADDR.other,
            amount: '9000000',
            authMode: 'none',
        });
    });

    it('refuses to change from, nonce, token or to, or to move the deadline earlier: correction_mismatch with the field', () => {
        const a = first();
        const cases: Array<[Partial<TransferIntentParams>, string]> = [
            [{ deadline: NOW + 1_199 }, 'request.deadline'],
            [{ deadline: NOW + 600 }, 'request.deadline'],
            [{ token: USDT0 }, 'request.token'],
            [{ to: ADDR.other }, 'request.to'],
            [{ from: ADDR.other }, 'request.from'],
            [{ nonce: 6n }, 'request.nonce'],
            [{ nonce: 4n }, 'request.nonce'],
        ];
        for (const [change, field] of cases) {
            const error = errorOf(() => createTransferIntent(pins, params({ deadline: NOW + 1_200, ...change, corrects: a.request }), NOW));
            expect({ code: error.code, field: error.field }, JSON.stringify(change, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).toEqual({
                code: 'correction_mismatch',
                field,
            });
        }
    });

    it('checks the corrected request itself: malformed fields fail as corrects.<name>; the policy of the new intent comes first', () => {
        const a = first();
        const bad: Array<[Record<string, unknown>, string]> = [
            [{ ...a.request, nonce: '0x12' }, 'corrects.nonce'],
            [{ ...a.request, deadline: '-1' }, 'corrects.deadline'],
            [{ ...a.request, to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293Bc' }, 'corrects.to'],
            [{ ...a.request, data: '0x' }, 'corrects.data'],
        ];
        for (const [corrects, field] of bad) {
            const error = errorOf(() => createTransferIntent(pins, params({ deadline: NOW + 1_200, corrects: corrects as never }), NOW));
            expect({ code: error.code, field: error.field }).toEqual({ code: 'invalid_request', field });
        }
        expect(errorOf(() => createTransferIntent(pins, params({ deadline: NOW + 1_200, corrects: null as never }), NOW)).field).toBe('corrects');
        // A correction whose own deadline is outside the window reports the window.
        expect(errorOf(() => createTransferIntent(pins, params({ deadline: NOW + 7_201, corrects: a.request }), NOW)).code).toBe('deadline_out_of_range');
    });

    it('checkCorrection compares two requests; it is exported for callers that check before building', () => {
        const a = sampleRequest();
        expect(checkCorrection(a, { ...a, fee: '60000', deadline: String(NOW + 601) })).toEqual({ ok: true });
        expect(checkCorrection(a, a)).toEqual({ ok: true });
        expect(checkCorrection(a, { ...a, deadline: String(NOW + 599) })).toMatchObject({ ok: false, code: 'correction_mismatch', field: 'request.deadline' });
        expect(checkCorrection(a, { ...a, token: USDT0 })).toMatchObject({ ok: false, code: 'correction_mismatch', field: 'request.token' });
        expect(checkCorrection(a, { ...a, nonce: '8' })).toMatchObject({ ok: false, code: 'correction_mismatch', field: 'request.nonce' });
        expect(checkCorrection(a, { ...a, nonce: '07' })).toMatchObject({ ok: false, code: 'invalid_request', field: 'request.nonce' });
        expect(checkCorrection({ ...a, amount: '1.0' }, a)).toMatchObject({ ok: false, code: 'invalid_request', field: 'corrects.amount' });
        expect(checkCorrection(a, null as never)).toMatchObject({ ok: false, code: 'invalid_request', field: 'request' });
    });
});
