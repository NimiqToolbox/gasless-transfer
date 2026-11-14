// splitSignature, toTokenAuthorization, maxSendable and uint helpers.

import { describe, expect, it } from 'vitest';
import { parseSignature, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isCanonicalUint256, MAX_UINT256, maxSendable, toUint256 } from '../../src/core/amounts.js';
import { GaslessValidationError } from '../../src/core/errors.js';
import {
    NO_TOKEN_AUTHORIZATION,
    normalizeSignature,
    normalizeTokenAuthorization,
    SECP256K1_HALF_N,
    SECP256K1_N,
    splitSignature,
    toTokenAuthorization,
} from '../../src/core/signature.js';
import { buildTransferTypedData } from '../../src/core/typedData.js';
import type { Hex, TokenAuthorization } from '../../src/core/types.js';
import { KEYS, NONE_AUTH, sampleRequest, TRANSFER_CONTRACT, ZERO32 } from '../helpers/fixtures.js';

function word(n: bigint): string {
    return n.toString(16).padStart(64, '0');
}

async function realSignature(): Promise<Hex> {
    const account = privateKeyToAccount(KEYS.user);
    return account.signTypedData(buildTransferTypedData(137, TRANSFER_CONTRACT, sampleRequest(), NONE_AUTH) as unknown as TypedDataDefinition);
}

function codeOf(fn: () => unknown): string | undefined {
    try {
        fn();
    } catch (error) {
        return error instanceof GaslessValidationError ? error.code : `threw ${String(error)}`;
    }
    return undefined;
}

describe('splitSignature', () => {
    it('splits a real signature like viem, with v in {27, 28}', async () => {
        const signature = await realSignature();
        const parts = splitSignature(signature);
        const viemParts = parseSignature(signature);
        expect(parts.r).toBe(viemParts.r);
        expect(parts.s).toBe(viemParts.s);
        expect(BigInt(parts.v)).toBe(viemParts.v);
        expect(parts.yParity).toBe(viemParts.yParity);
        expect(normalizeSignature(signature)).toBe(signature.toLowerCase());
    });

    it('normalizes v = 0/1 to 27/28', async () => {
        const signature = await realSignature();
        const { v } = splitSignature(signature);
        const raw = `${signature.slice(0, 130)}${v === 27 ? '00' : '01'}`;
        expect(splitSignature(raw).v).toBe(v);
        expect(normalizeSignature(raw)).toBe(signature.toLowerCase());
    });

    it('rejects a high-s signature (the malleable twin of a valid one)', async () => {
        const signature = await realSignature();
        const { r, s, v } = splitSignature(signature);
        const highS = SECP256K1_N - BigInt(s);
        const twin = `${r}${word(highS)}${v === 27 ? '1c' : '1b'}`;
        expect(codeOf(() => splitSignature(twin))).toBe('invalid_signature');
        expect(() => splitSignature(twin)).toThrow(/high-s/);
        // s = n/2 is still accepted, n/2 + 1 is not.
        expect(splitSignature(`${r}${word(SECP256K1_HALF_N)}1b`).s).toBe(`0x${word(SECP256K1_HALF_N)}`);
        expect(codeOf(() => splitSignature(`${r}${word(SECP256K1_HALF_N + 1n)}1b`))).toBe('invalid_signature');
    });

    it('rejects every other v', async () => {
        const body = (await realSignature()).slice(0, 130);
        for (const v of ['02', '1a', '1d', '25', '26', 'ff']) {
            expect(codeOf(() => splitSignature(`${body}${v}`)), `v = 0x${v}`).toBe('invalid_signature');
        }
    });

    it('rejects r or s out of range', async () => {
        const signature = await realSignature();
        const { r, s } = splitSignature(signature);
        expect(codeOf(() => splitSignature(`0x${word(0n)}${s.slice(2)}1b`))).toBe('invalid_signature');
        expect(codeOf(() => splitSignature(`0x${word(SECP256K1_N)}${s.slice(2)}1b`))).toBe('invalid_signature');
        expect(codeOf(() => splitSignature(`${r}${word(0n)}1b`))).toBe('invalid_signature');
    });

    it('rejects malformed input: 64-byte (EIP-2098), 66-byte, odd length, no 0x, non-hex, non-string', async () => {
        const signature = await realSignature();
        for (const bad of [signature.slice(0, 130), `${signature}00`, signature.slice(0, 131), signature.slice(2), `${signature.slice(0, 131)}g`, '', null, 42]) {
            expect(codeOf(() => splitSignature(bad as string))).toBe('invalid_signature');
        }
    });
});

describe('toTokenAuthorization / normalizeTokenAuthorization', () => {
    it('builds the signed authorization for each mode: zeros for "none", v normalized to 27/28 otherwise', async () => {
        const signature = await realSignature();
        const { r, s, v } = splitSignature(signature);
        expect(toTokenAuthorization('none')).toEqual({ mode: 'none', v: 0, r: ZERO32, s: ZERO32 });
        expect(NO_TOKEN_AUTHORIZATION).toEqual(NONE_AUTH);
        expect(Object.isFrozen(NO_TOKEN_AUTHORIZATION)).toBe(true);
        expect(toTokenAuthorization('permit', signature)).toEqual({ mode: 'permit', v, r, s });
        expect(toTokenAuthorization('metaTxApprove', signature)).toEqual({ mode: 'metaTxApprove', v, r, s });
        // A hardware wallet's v = 0/1 is normalized before the intent signs the authorization.
        expect(toTokenAuthorization('permit', `${signature.slice(0, 130)}${v === 27 ? '00' : '01'}`)).toEqual({ mode: 'permit', v, r, s });
    });

    it('rejects a signature for "none", a missing one otherwise, unknown modes and bad signatures', async () => {
        const signature = await realSignature();
        expect(codeOf(() => toTokenAuthorization('none', signature))).toBe('auth_unexpected');
        expect(codeOf(() => toTokenAuthorization('permit'))).toBe('auth_missing');
        expect(codeOf(() => toTokenAuthorization('metaTxApprove', null))).toBe('auth_missing');
        expect(codeOf(() => toTokenAuthorization('approve' as never, signature))).toBe('invalid_request');
        expect(codeOf(() => toTokenAuthorization('permit', signature.slice(0, 130)))).toBe('invalid_signature');
    });

    it('checks a wire authorization without changing what the intent signed (only r and s are lowercased)', async () => {
        const { r, s, v } = splitSignature(await realSignature());
        const upper = { mode: 'permit', v, r: r.toUpperCase().replace('0X', '0x'), s } as TokenAuthorization;
        expect(normalizeTokenAuthorization(upper)).toEqual({ mode: 'permit', v, r, s });
        expect(normalizeTokenAuthorization(NONE_AUTH)).toEqual(NONE_AUTH);
        // v is signed as it is: 0/1 is not normalized here (toTokenAuthorization does that before signing).
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v: v - 27, r, s }))).toBe('invalid_signature');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v: 29, r, s }))).toBe('invalid_signature');
    });

    it('mode "none" must carry v = 0 and r = s = 0, and every authorization exactly mode, v, r and s', async () => {
        const { r, s, v } = splitSignature(await realSignature());
        expect(codeOf(() => normalizeTokenAuthorization({ ...NONE_AUTH, v: 27 }))).toBe('auth_unexpected');
        expect(codeOf(() => normalizeTokenAuthorization({ ...NONE_AUTH, r }))).toBe('auth_unexpected');
        expect(codeOf(() => normalizeTokenAuthorization({ ...NONE_AUTH, s }))).toBe('auth_unexpected');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'none' } as never))).toBe('invalid_request');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v, r } as never))).toBe('invalid_request');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v, r, s, extra: 1 } as never))).toBe('invalid_request');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v: String(v) as never, r, s }))).toBe('invalid_request');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v, r, s: '0x1234' as Hex }))).toBe('invalid_request');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v, r, s: `0x${word(SECP256K1_N - BigInt(s))}` }))).toBe('invalid_signature');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'permit', v: 27, r: ZERO32, s: ZERO32 }))).toBe('invalid_signature');
        expect(codeOf(() => normalizeTokenAuthorization({ mode: 'bogus', v: 0, r: ZERO32, s: ZERO32 } as never))).toBe('invalid_request');
        expect(codeOf(() => normalizeTokenAuthorization(null as never))).toBe('invalid_request');
        expect(codeOf(() => normalizeTokenAuthorization([] as never))).toBe('invalid_request');
    });
});

describe('amounts', () => {
    it('maxSendable = balance - fee, or 0 when the fee is not covered', () => {
        expect(maxSendable(10_000_000n, 50_000n)).toBe(9_950_000n);
        expect(maxSendable('10000000', '50000')).toBe(9_950_000n);
        expect(maxSendable(50_001n, 50_000n)).toBe(1n);
        expect(maxSendable(50_000n, 50_000n)).toBe(0n);
        expect(maxSendable(10n, 50_000n)).toBe(0n);
        expect(maxSendable(0n, 0n)).toBe(0n);
        expect(maxSendable(MAX_UINT256, 0n)).toBe(MAX_UINT256);
    });

    it('maxSendable rejects malformed inputs', () => {
        expect(() => maxSendable(-1n, 0n)).toThrow(TypeError);
        expect(() => maxSendable('1.5', '0')).toThrow(TypeError);
        expect(() => maxSendable('1e6', '0')).toThrow(TypeError);
        expect(() => maxSendable(MAX_UINT256 + 1n, 0n)).toThrow(TypeError);
        expect(() => maxSendable(1.5 as never, 0n)).toThrow(TypeError);
    });

    it('toUint256 and isCanonicalUint256', () => {
        expect(toUint256('0010')).toBe(10n);
        expect(toUint256(42)).toBe(42n);
        expect(() => toUint256(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
        expect(isCanonicalUint256('0')).toBe(true);
        expect(isCanonicalUint256('10')).toBe(true);
        expect(isCanonicalUint256(MAX_UINT256.toString())).toBe(true);
        for (const bad of ['010', '', '-1', '1.0', '1e3', ' 1', (MAX_UINT256 + 1n).toString(), 10, 10n]) {
            expect(isCanonicalUint256(bad), String(bad)).toBe(false);
        }
    });
});
