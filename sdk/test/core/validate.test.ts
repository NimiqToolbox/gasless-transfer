// validateTransferRequest (§7): every accepted case and every rejection path with its code and field.

import { describe, expect, it } from 'vitest';
import { ZERO_ADDRESS } from '../../src/core/address.js';
import { MAX_UINT256 } from '../../src/core/amounts.js';
import { LEGACY_NIMIQ_CONTRACTS_POLYGON, POLYGON_USDC, POLYGON_USDT0 } from '../../src/core/constants.js';
import { GaslessValidationError, type ValidationResult } from '../../src/core/errors.js';
import {
    APPROVE_SELECTOR,
    buildMetaTxApproveTypedData,
    buildPermitTypedData,
    encodeApproveCalldata,
    type MetaTxApproveTypedData,
    type PermitTypedData,
} from '../../src/core/typedData.js';
import type { TransferRequest } from '../../src/core/types.js';
import { assertValidTransferRequest, validateTransferRequest, type TransferValidationInput } from '../../src/core/validate.js';
import { ADDR, NONE_AUTH, NOW, polygonPins, sampleRequest, TRANSFER_CONTRACT, USDC, USDT0 } from '../helpers/fixtures.js';

const pins = polygonPins({ extraDeniedRecipients: [ADDR.other] });
const VALUE = 10_050_000n; // amount + fee of sampleRequest()

function permit(request: TransferRequest = sampleRequest(), overrides: Partial<PermitTypedData['message']> = {}): PermitTypedData {
    const typed = buildPermitTypedData({
        tokenDomain: request.token === USDT0 ? POLYGON_USDT0.domain : POLYGON_USDC.domain,
        owner: request.from,
        spender: TRANSFER_CONTRACT,
        value: BigInt(request.amount) + BigInt(request.fee),
        nonce: 7n,
        deadline: request.deadline,
    });
    return { ...typed, message: { ...typed.message, ...overrides } };
}

function metaTx(request: TransferRequest = sampleRequest({ token: USDT0 }), overrides: Partial<MetaTxApproveTypedData['message']> = {}): MetaTxApproveTypedData {
    const typed = buildMetaTxApproveTypedData({
        tokenDomain: POLYGON_USDT0.domain,
        from: request.from,
        spender: TRANSFER_CONTRACT,
        value: BigInt(request.amount) + BigInt(request.fee),
        nonce: 3n,
    });
    return { ...typed, message: { ...typed.message, ...overrides } };
}

function permitInput(overrides: Partial<TransferValidationInput> = {}): TransferValidationInput {
    const request = overrides.request ?? sampleRequest();
    return { chainId: 137, contract: TRANSFER_CONTRACT, request, authMode: 'permit', tokenAuth: permit(request), ...overrides };
}

function withRequest(changes: Partial<TransferRequest>, authMode: TransferValidationInput['authMode'] = 'none'): TransferValidationInput {
    return { chainId: 137, contract: TRANSFER_CONTRACT, request: sampleRequest(changes), authMode };
}

function expectFailure(result: ValidationResult, code: string, field: string): void {
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.field).toBe(field);
        expect(result.message.length).toBeGreaterThan(0);
    }
}

describe('validateTransferRequest: accepted', () => {
    it.each([
        ['USDC permit', permitInput()],
        ['USDT0 permit', permitInput({ request: sampleRequest({ token: USDT0 }) })],
        ['USDT0 meta-tx approve', { ...permitInput({ request: sampleRequest({ token: USDT0 }) }), authMode: 'metaTxApprove' as const, tokenAuth: metaTx() }],
        ['USDC none', withRequest({})],
        ['USDT0 none', withRequest({ token: USDT0 })],
        ['fee 0', withRequest({ fee: '0' })],
        // No cap on the fee: every fee amount + fee allows.
        ['fee 50.00, USDT0', withRequest({ token: USDT0, fee: '50000000' })],
        ['fee above 2^128', withRequest({ amount: '1', fee: (1n << 128n).toString() })],
        ['largest fee without overflow', withRequest({ amount: '1', fee: (MAX_UINT256 - 1n).toString() })],
        ['deadline = now + 60', withRequest({ deadline: String(NOW + 60) })],
        ['deadline = now + 7200', withRequest({ deadline: String(NOW + 7200) })],
        ['lowercase addresses', withRequest({ to: ADDR.recipient.toLowerCase() as `0x${string}`, from: ADDR.user.toLowerCase() as `0x${string}` })],
        ['self transfer', withRequest({ to: ADDR.user })],
        ['recipient = relay', withRequest({ to: ADDR.relay })],
        ['largest amount without overflow', withRequest({ amount: (MAX_UINT256 - 50_000n).toString() })],
        ['null tokenAuth for none', { ...withRequest({}), tokenAuth: null }],
    ])('%s', (_name, input) => {
        expect(validateTransferRequest(input, pins, NOW)).toEqual({ ok: true });
    });
});

describe('validateTransferRequest: `now`', () => {
    it.each([Date.now(), -1, 1.5, Number.NaN, 2 ** 32])('throws TypeError for now = %s (seconds expected)', (now) => {
        expect(() => validateTransferRequest(permitInput(), pins, now)).toThrow(TypeError);
    });
});

describe('validateTransferRequest: malformed input → invalid_request', () => {
    it.each([
        ['chainId', { chainId: 0 }],
        ['chainId', { chainId: '137' }],
        ['contract', { contract: '0x1234' }],
        ['authMode', { authMode: 'approve' }],
        ['request', { request: null }],
        ['request.data', { request: { ...sampleRequest(), data: '0x' } }],
        ['request.token', { request: sampleRequest({ token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c335' as never }) }],
        ['request.from', { request: sampleRequest({ from: 'alice' as never }) }],
        // One flipped letter in a checksummed recipient (a typo) is rejected, not "fixed".
        ['request.to', { request: sampleRequest({ to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293Bc' }) }],
        ['request.relay', { request: sampleRequest({ relay: undefined as never }) }],
        ['request.amount', { request: sampleRequest({ amount: '010' }) }],
        ['request.amount', { request: sampleRequest({ amount: '1.5' }) }],
        ['request.amount', { request: sampleRequest({ amount: 5 as never }) }],
        ['request.fee', { request: sampleRequest({ fee: '-1' }) }],
        ['request.deadline', { request: sampleRequest({ deadline: 'soon' }) }],
        ['request.nonce', { request: sampleRequest({ nonce: '0x1234' }) }],
        ['request.nonce', { request: sampleRequest({ nonce: 42 as never }) }],
        // A bytes32 nonce, and a non-canonical decimal string.
        ['request.nonce', { request: sampleRequest({ nonce: `0x${'ab'.repeat(32)}` }) }],
        ['request.nonce', { request: sampleRequest({ nonce: '07' }) }],
        ['request.nonce', { request: sampleRequest({ nonce: (MAX_UINT256 + 1n).toString() }) }],
    ])('%s', (field, overrides) => {
        expectFailure(validateTransferRequest({ ...withRequest({}), ...(overrides as object) } as TransferValidationInput, pins, NOW), 'invalid_request', field);
    });
});

describe('validateTransferRequest: pins and policy', () => {
    it('wrong_chain', () => expectFailure(validateTransferRequest({ ...permitInput(), chainId: 80002 }, pins, NOW), 'wrong_chain', 'chainId'));
    it('wrong_contract', () => {
        expectFailure(validateTransferRequest({ ...permitInput(), contract: LEGACY_NIMIQ_CONTRACTS_POLYGON[2] as string }, pins, NOW), 'wrong_contract', 'contract');
    });
    it('wrong_relay', () => expectFailure(validateTransferRequest(withRequest({ relay: ADDR.other }), pins, NOW), 'wrong_relay', 'request.relay'));
    it('unsupported_token (USDC.e and an arbitrary token)', () => {
        expectFailure(validateTransferRequest(withRequest({ token: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' }), pins, NOW), 'unsupported_token', 'request.token');
        expectFailure(validateTransferRequest(withRequest({ token: ADDR.other }), pins, NOW), 'unsupported_token', 'request.token');
    });
    it('unsupported_auth_mode (USDC has no meta-tx)', () => {
        expectFailure(validateTransferRequest({ ...permitInput(), authMode: 'metaTxApprove', tokenAuth: metaTx(sampleRequest()) }, pins, NOW), 'unsupported_auth_mode', 'authMode');
    });
    it('invalid_sender (from = 0)', () => expectFailure(validateTransferRequest(withRequest({ from: ZERO_ADDRESS }), pins, NOW), 'invalid_sender', 'request.from'));
    it('invalid_amount (zero, and amount + fee above uint256)', () => {
        expectFailure(validateTransferRequest(withRequest({ amount: '0' }), pins, NOW), 'invalid_amount', 'request.amount');
        expectFailure(validateTransferRequest(withRequest({ amount: MAX_UINT256.toString(), fee: '1' }), pins, NOW), 'invalid_amount', 'request.amount');
        expectFailure(validateTransferRequest(withRequest({ amount: '1', fee: MAX_UINT256.toString() }), pins, NOW), 'invalid_amount', 'request.amount');
        expectFailure(validateTransferRequest(withRequest({ amount: MAX_UINT256.toString(), fee: MAX_UINT256.toString() }), pins, NOW), 'invalid_amount', 'request.amount');
        expectFailure(validateTransferRequest({ ...permitInput(), request: sampleRequest({ amount: '2', fee: (MAX_UINT256 - 1n).toString() }) }, pins, NOW), 'invalid_amount', 'request.amount');
    });
    it.each([
        ['zero address', ZERO_ADDRESS],
        ['USDC', USDC],
        ['USDT0 (lowercase)', USDT0.toLowerCase()],
        ['the transfer contract', TRANSFER_CONTRACT],
        ...LEGACY_NIMIQ_CONTRACTS_POLYGON.map((a, i) => [`legacy handler ${i}`, a] as [string, string]),
        // Superseded GaslessTransfer deployments: tokens sent to them are locked.
        ['a superseded GaslessTransfer', '0xbfbE31E6c57B09A8130d427B9E3E23ed5aB6cd1D'],
        ['another superseded GaslessTransfer (lowercase)', '0xa0df3cdf124d7101a67ebe5b1b97d222505de9d6'],
        ['an extra denied address', ADDR.other],
    ])('invalid_recipient: %s', (_name, to) => {
        expectFailure(validateTransferRequest(withRequest({ to: to as `0x${string}` }), pins, NOW), 'invalid_recipient', 'request.to');
    });
    it.each([
        ['now + 59', NOW + 59],
        ['now + 7201', NOW + 7201],
        ['now', NOW],
        ['the past', NOW - 1000],
        ['0', 0],
    ])('deadline_out_of_range: %s', (_name, deadline) => {
        expectFailure(validateTransferRequest(withRequest({ deadline: String(deadline) }), pins, NOW), 'deadline_out_of_range', 'request.deadline');
    });
    it('deadline_out_of_range: max uint256', () => {
        expectFailure(validateTransferRequest(withRequest({ deadline: MAX_UINT256.toString() }), pins, NOW), 'deadline_out_of_range', 'request.deadline');
    });
    // Neither the pins nor the contract cap the fee.
    it('no fee cap: any fee passes, for every token and mode, with its token authorization', () => {
        for (const fee of ['5000001', '50000000', (10n ** 30n).toString()]) {
            expect(validateTransferRequest(withRequest({ fee }), pins, NOW), fee).toEqual({ ok: true });
            expect(validateTransferRequest(permitInput({ request: sampleRequest({ fee }) }), pins, NOW), fee).toEqual({ ok: true });
            const usdt0 = sampleRequest({ token: USDT0, fee });
            expect(validateTransferRequest(permitInput({ request: usdt0 }), pins, NOW), fee).toEqual({ ok: true });
            expect(validateTransferRequest({ ...permitInput({ request: usdt0 }), authMode: 'metaTxApprove', tokenAuth: metaTx(usdt0) }, pins, NOW), fee).toEqual({ ok: true });
        }
    });
    it('reports the first failing check in relay order', () => {
        expectFailure(validateTransferRequest(withRequest({ relay: ADDR.other, amount: '0', to: ZERO_ADDRESS }), pins, NOW), 'wrong_relay', 'request.relay');
        expectFailure(validateTransferRequest(withRequest({ amount: '0', to: ZERO_ADDRESS, fee: '9999999999' }), pins, NOW), 'invalid_amount', 'request.amount');
        expectFailure(validateTransferRequest(withRequest({ to: ZERO_ADDRESS, deadline: '0' }), pins, NOW), 'invalid_recipient', 'request.to');
    });
});

describe("validateTransferRequest: the caller's fee ceiling (options.maxAcceptableFee)", () => {
    it('fee_above_limit above the ceiling; at the ceiling and without one the request is valid', () => {
        expect(validateTransferRequest(permitInput(), pins, NOW, { maxAcceptableFee: 50_000n })).toEqual({ ok: true });
        expect(validateTransferRequest(permitInput(), pins, NOW, { maxAcceptableFee: '50000' })).toEqual({ ok: true });
        expect(validateTransferRequest(permitInput(), pins, NOW, {})).toEqual({ ok: true });
        for (const ceiling of [49_999n, '49999', 49_999, 0n]) {
            expectFailure(validateTransferRequest(permitInput(), pins, NOW, { maxAcceptableFee: ceiling }), 'fee_above_limit', 'request.fee');
        }
    });

    it('is the only fee bound: a fee of 50.00 passes without it and fails with a lower ceiling', () => {
        const high = permitInput({ request: sampleRequest({ token: USDT0, fee: '50000000' }) });
        expect(validateTransferRequest(high, pins, NOW)).toEqual({ ok: true });
        expect(validateTransferRequest(high, pins, NOW, { maxAcceptableFee: '50000000' })).toEqual({ ok: true });
        for (const ceiling of [49_999_999n, '5000000', 5_000_000]) {
            expectFailure(validateTransferRequest(high, pins, NOW, { maxAcceptableFee: ceiling }), 'fee_above_limit', 'request.fee');
        }
        const huge = withRequest({ amount: '1', fee: (MAX_UINT256 - 1n).toString() });
        expect(validateTransferRequest(huge, pins, NOW)).toEqual({ ok: true });
        expectFailure(validateTransferRequest(huge, pins, NOW, { maxAcceptableFee: MAX_UINT256 - 2n }), 'fee_above_limit', 'request.fee');
    });

    it('runs after the pins and policy checks and before the token authorization checks', () => {
        expectFailure(validateTransferRequest(withRequest({ amount: '0', fee: '5000001' }), pins, NOW, { maxAcceptableFee: 1n }), 'invalid_amount', 'request.amount');
        expectFailure(validateTransferRequest(withRequest({ relay: ADDR.other }), pins, NOW, { maxAcceptableFee: 1n }), 'wrong_relay', 'request.relay');
        expectFailure(validateTransferRequest({ ...permitInput(), tokenAuth: undefined }, pins, NOW, { maxAcceptableFee: 1n }), 'fee_above_limit', 'request.fee');
    });

    it('a malformed ceiling is an invalid_request result, not an exception; assertValidTransferRequest throws it', () => {
        for (const bad of [-1n, '1.5', 'abc', '', 1.5, null]) {
            expectFailure(validateTransferRequest(permitInput(), pins, NOW, { maxAcceptableFee: bad as never }), 'invalid_request', 'maxAcceptableFee');
        }
        expect(() => assertValidTransferRequest(permitInput(), pins, NOW, { maxAcceptableFee: 1n })).toThrow(GaslessValidationError);
    });
});

describe('validateTransferRequest: token authorization (§5)', () => {
    it('auth_unexpected / auth_missing', () => {
        expectFailure(validateTransferRequest({ ...withRequest({}), tokenAuth: permit() }, pins, NOW), 'auth_unexpected', 'tokenAuth');
        expectFailure(validateTransferRequest({ ...permitInput(), tokenAuth: undefined }, pins, NOW), 'auth_missing', 'tokenAuth');
        expectFailure(
            validateTransferRequest({ ...permitInput({ request: sampleRequest({ token: USDT0 }) }), authMode: 'metaTxApprove', tokenAuth: null }, pins, NOW),
            'auth_missing',
            'tokenAuth',
        );
    });

    it('auth_type_mismatch: wrong primary type, extra types, extra or renamed fields', () => {
        const typed = permit();
        const cases: unknown[] = [
            metaTx(sampleRequest()),
            { ...typed, primaryType: 'MetaTransaction' },
            { ...typed, types: { ...typed.types, EIP712Domain: [{ name: 'name', type: 'string' }] } },
            { ...typed, types: { Permit: [...typed.types.Permit, { name: 'extra', type: 'uint256' }] } },
            { ...typed, types: { Permit: typed.types.Permit.map((f) => (f.name === 'value' ? { ...f, type: 'uint128' } : f)) } },
            { ...typed, types: { Permit: [...typed.types.Permit].reverse() } },
            'not typed data',
        ];
        for (const tokenAuth of cases) {
            expectFailure(validateTransferRequest({ ...permitInput(), tokenAuth: tokenAuth as PermitTypedData }, pins, NOW), 'auth_type_mismatch', 'tokenAuth.types');
        }
        expectFailure(
            validateTransferRequest({ ...permitInput(), tokenAuth: { ...typed, message: { ...typed.message, extra: '1' } as never } }, pins, NOW),
            'auth_type_mismatch',
            'tokenAuth.message',
        );
    });

    it('auth_domain_mismatch: another token, the standard USDT0 domain (T17), a renamed token, extra fields', () => {
        const usdt0Request = sampleRequest({ token: USDT0 });
        const typed = permit(usdt0Request);
        const cases = [
            { ...typed, domain: POLYGON_USDC.domain },
            { ...typed, domain: { name: 'USDT0', version: '1', chainId: 137, verifyingContract: USDT0 } },
            { ...typed, domain: { ...POLYGON_USDT0.domain, name: 'Tether USD' } },
            { ...typed, domain: { ...POLYGON_USDT0.domain, salt: `0x${'0'.repeat(63)}1` } },
            { ...typed, domain: { ...POLYGON_USDT0.domain, chainId: 137 } },
            { ...typed, domain: { ...POLYGON_USDT0.domain, extra: 'x' } },
            { ...typed, domain: { ...POLYGON_USDT0.domain, salt: 137 } },
            { ...typed, domain: { ...POLYGON_USDT0.domain, verifyingContract: 42 } },
        ];
        for (const tokenAuth of cases) {
            expectFailure(validateTransferRequest(permitInput({ request: usdt0Request, tokenAuth: tokenAuth as PermitTypedData }), pins, NOW), 'auth_domain_mismatch', 'tokenAuth.domain');
        }
        expectFailure(validateTransferRequest(permitInput({ tokenAuth: { ...permit(), domain: { ...POLYGON_USDC.domain, version: '1' } } }), pins, NOW), 'auth_domain_mismatch', 'tokenAuth.domain');
    });

    it('permit: owner, spender, value, nonce and deadline must match', () => {
        const request = sampleRequest();
        const check = (overrides: Partial<PermitTypedData['message']>) => validateTransferRequest(permitInput({ tokenAuth: permit(request, overrides) }), pins, NOW);
        expectFailure(check({ owner: ADDR.other }), 'auth_owner_mismatch', 'tokenAuth.message.owner');
        expectFailure(check({ spender: ADDR.relay }), 'auth_spender_mismatch', 'tokenAuth.message.spender');
        expectFailure(check({ spender: LEGACY_NIMIQ_CONTRACTS_POLYGON[2] as `0x${string}` }), 'auth_spender_mismatch', 'tokenAuth.message.spender');
        expectFailure(check({ value: request.amount }), 'auth_value_mismatch', 'tokenAuth.message.value');
        expectFailure(check({ value: String(VALUE + 1n) }), 'auth_value_mismatch', 'tokenAuth.message.value');
        expectFailure(check({ value: MAX_UINT256.toString() }), 'auth_value_mismatch', 'tokenAuth.message.value');
        expectFailure(check({ nonce: '-1' }), 'invalid_request', 'tokenAuth.message.nonce');
        expectFailure(check({ deadline: '0' }), 'auth_deadline_mismatch', 'tokenAuth.message.deadline');
        expectFailure(check({ deadline: MAX_UINT256.toString() }), 'auth_deadline_mismatch', 'tokenAuth.message.deadline');
        expectFailure(check({ deadline: String(NOW + 601) }), 'auth_deadline_mismatch', 'tokenAuth.message.deadline');
        expect(check({ owner: ADDR.user.toLowerCase() as `0x${string}` })).toEqual({ ok: true });
    });

    it('meta-tx: from and the approve(spender, amount + fee) calldata must match', () => {
        const request = sampleRequest({ token: USDT0 });
        const check = (overrides: Partial<MetaTxApproveTypedData['message']>) =>
            validateTransferRequest(
                { chainId: 137, contract: TRANSFER_CONTRACT, request, authMode: 'metaTxApprove', tokenAuth: metaTx(request, overrides) },
                pins,
                NOW,
            );
        const field = 'tokenAuth.message.functionSignature';
        const spenderWord = TRANSFER_CONTRACT.slice(2).toLowerCase().padStart(64, '0');
        const valueWord = VALUE.toString(16).padStart(64, '0');
        expect(check({})).toEqual({ ok: true });
        expect(check({ functionSignature: encodeApproveCalldata(TRANSFER_CONTRACT, VALUE).toUpperCase().replace('0X', '0x') as `0x${string}` })).toEqual({ ok: true });
        expectFailure(check({ from: ADDR.other }), 'auth_owner_mismatch', 'tokenAuth.message.from');
        expectFailure(check({ nonce: 'x' }), 'invalid_request', 'tokenAuth.message.nonce');
        expectFailure(check({ functionSignature: `0xa9059cbb${spenderWord}${valueWord}` }), 'auth_type_mismatch', field); // transfer(address,uint256)
        expectFailure(check({ functionSignature: `${APPROVE_SELECTOR}${spenderWord}` }), 'auth_type_mismatch', field);
        expectFailure(check({ functionSignature: `${APPROVE_SELECTOR}${spenderWord}${valueWord}00` }), 'auth_type_mismatch', field);
        expectFailure(check({ functionSignature: encodeApproveCalldata(ADDR.relay, VALUE) }), 'auth_spender_mismatch', field);
        expectFailure(check({ functionSignature: `${APPROVE_SELECTOR}${'ff'.repeat(12)}${spenderWord.slice(24)}${valueWord}` }), 'auth_spender_mismatch', field);
        expectFailure(check({ functionSignature: encodeApproveCalldata(TRANSFER_CONTRACT, BigInt(request.amount)) }), 'auth_value_mismatch', field);
        expectFailure(check({ functionSignature: encodeApproveCalldata(TRANSFER_CONTRACT, MAX_UINT256) }), 'auth_value_mismatch', field);
    });
});

describe('validateTransferRequest: the signed authorization (checkSignedAuthorization)', () => {
    it('if given, must be of the auth mode and in the form the relay submits; checked after the token authorization', () => {
        const permitAuth = { mode: 'permit', v: 28, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}` } as const;
        expect(validateTransferRequest({ ...permitInput(), authorization: permitAuth }, pins, NOW)).toEqual({ ok: true });
        expect(validateTransferRequest({ ...withRequest({}), authorization: NONE_AUTH }, pins, NOW)).toEqual({ ok: true });
        expectFailure(validateTransferRequest({ ...permitInput(), authorization: NONE_AUTH }, pins, NOW), 'auth_type_mismatch', 'authorization.mode');
        expectFailure(validateTransferRequest({ ...withRequest({}), authorization: permitAuth }, pins, NOW), 'auth_type_mismatch', 'authorization.mode');
        expectFailure(validateTransferRequest({ ...withRequest({}), authorization: { ...NONE_AUTH, s: permitAuth.s } }, pins, NOW), 'auth_unexpected', 'authorization');
        expectFailure(validateTransferRequest({ ...permitInput(), authorization: { ...permitAuth, v: 1 } }, pins, NOW), 'invalid_signature', 'authorization.v');
        expectFailure(validateTransferRequest({ ...permitInput(), authorization: null as never }, pins, NOW), 'invalid_request', 'authorization');
        // The token authorization typed data is checked first.
        expectFailure(validateTransferRequest({ ...permitInput(), tokenAuth: undefined, authorization: NONE_AUTH }, pins, NOW), 'auth_missing', 'tokenAuth');
    });
});

describe('assertValidTransferRequest', () => {
    it('throws GaslessValidationError with code and field', () => {
        expect(() => assertValidTransferRequest(permitInput(), pins, NOW)).not.toThrow();
        try {
            assertValidTransferRequest(withRequest({ amount: MAX_UINT256.toString() }), pins, NOW);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(GaslessValidationError);
            expect((error as GaslessValidationError).code).toBe('invalid_amount');
            expect((error as GaslessValidationError).field).toBe('request.amount');
            expect((error as GaslessValidationError).name).toBe('GaslessValidationError');
        }
    });
});
