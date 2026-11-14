// ECDSA signature helpers. The contract (OZ ECDSA.tryRecover), USDC (ECRecover) and the relay
// require 65-byte signatures with v in {27, 28} and s in the lower half of the curve order.

import { GaslessValidationError } from './errors.js';
import type { AuthModeName, Hex, TokenAuthorization } from './types.js';

/** secp256k1 group order n. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Largest accepted s (n / 2, rounded down), as in OpenZeppelin ECDSA and EIP-2. */
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export interface SignatureParts {
    readonly r: Hex;
    readonly s: Hex;
    /** Always 27 or 28. */
    readonly v: 27 | 28;
    readonly yParity: 0 | 1;
}

function invalid(field: string, message: string): GaslessValidationError {
    return new GaslessValidationError('invalid_signature', field, message);
}

function checkRS(r: bigint, s: bigint, field: string): void {
    if (r === 0n || r >= SECP256K1_N) throw invalid(field, 'r is out of range');
    if (s === 0n || s >= SECP256K1_N) throw invalid(field, 's is out of range');
    if (s > SECP256K1_HALF_N) throw invalid(field, 'high-s signature (malleable); expected s <= n/2');
}

function normalizeV(v: number, field: string): 27 | 28 {
    if (v === 27 || v === 0) return 27;
    if (v === 28 || v === 1) return 28;
    throw invalid(field, 'v must be 27, 28, 0 or 1');
}

/**
 * Splits a 65-byte signature (r ‖ s ‖ v) and normalizes v to 27/28 (0/1 are accepted, e.g. from
 * hardware wallets). Rejects other lengths (including 64-byte EIP-2098 signatures), other v values,
 * r or s out of range, and high-s signatures.
 */
export function splitSignature(signature: string, field = 'signature'): SignatureParts {
    if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
        throw invalid(field, 'expected a 65-byte signature: 0x followed by 130 hex characters');
    }
    const r = `0x${signature.slice(2, 66).toLowerCase()}` as Hex;
    const s = `0x${signature.slice(66, 130).toLowerCase()}` as Hex;
    checkRS(BigInt(r), BigInt(s), field);
    const v = normalizeV(Number.parseInt(signature.slice(130, 132), 16), field);
    return { r, s, v, yParity: v === 27 ? 0 : 1 };
}

/** The canonical 65-byte form: lowercase hex, low-s, v in {27, 28}. */
export function normalizeSignature(signature: string, field = 'signature'): Hex {
    const { r, s, v } = splitSignature(signature, field);
    return `0x${r.slice(2)}${s.slice(2)}${v.toString(16)}`;
}

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`;

/** The token authorization of mode "none" as it is signed and sent: v = 0, r = s = 0. */
export const NO_TOKEN_AUTHORIZATION: TokenAuthorization = Object.freeze({ mode: 'none', v: 0, r: ZERO_BYTES32, s: ZERO_BYTES32 });

/**
 * The token authorization that the intent signs and the relay submits. For `none` there is no token signature
 * (v, r and s are 0); for `permit` and `metaTxApprove` the owner's token signature is split into v (27 or 28;
 * 0 and 1 are normalized), r and s. Build it before the intent is signed: the intent signs it as it is.
 */
export function toTokenAuthorization(mode: AuthModeName, tokenSignature?: string | null): TokenAuthorization {
    if (mode === 'none') {
        if (tokenSignature !== undefined && tokenSignature !== null) {
            throw new GaslessValidationError('auth_unexpected', 'tokenSignature', 'auth mode "none" takes no token signature');
        }
        return { ...NO_TOKEN_AUTHORIZATION };
    }
    if (mode !== 'permit' && mode !== 'metaTxApprove') {
        throw new GaslessValidationError('invalid_request', 'authorization.mode', 'unknown auth mode');
    }
    if (tokenSignature === undefined || tokenSignature === null) {
        throw new GaslessValidationError('auth_missing', 'tokenSignature', `auth mode "${mode}" needs the owner's token signature`);
    }
    const { r, s, v } = splitSignature(tokenSignature, 'tokenSignature');
    return { mode, v, r, s };
}

/**
 * Validates a wire `TokenAuthorization` and returns it with lowercase r and s and no other change: the intent
 * signs it, so v is not normalized here. Exactly the keys mode, v, r and s (`invalid_request` otherwise). Mode
 * "none" needs v = 0 and r = s = 0 (`auth_unexpected` otherwise); "permit" and "metaTxApprove" need v 27 or 28 and
 * r, s in range with low s (`invalid_signature`), as `toTokenAuthorization` builds them.
 */
export function normalizeTokenAuthorization(auth: TokenAuthorization, field = 'authorization'): TokenAuthorization {
    if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
        throw new GaslessValidationError('invalid_request', field, 'expected an object');
    }
    const keys = Object.keys(auth);
    if (keys.length !== 4 || !['mode', 'v', 'r', 's'].every((key) => keys.includes(key))) {
        throw new GaslessValidationError('invalid_request', field, 'expected exactly mode, v, r and s');
    }
    if (auth.mode !== 'none' && auth.mode !== 'permit' && auth.mode !== 'metaTxApprove') {
        throw new GaslessValidationError('invalid_request', `${field}.mode`, 'unknown auth mode');
    }
    if (typeof auth.v !== 'number' || typeof auth.r !== 'string' || typeof auth.s !== 'string') {
        throw new GaslessValidationError('invalid_request', field, 'v must be a number, r and s hex strings');
    }
    if (!BYTES32_RE.test(auth.r) || !BYTES32_RE.test(auth.s)) {
        throw new GaslessValidationError('invalid_request', field, 'r and s must be 0x followed by 64 hex characters');
    }
    const r = auth.r.toLowerCase() as Hex;
    const s = auth.s.toLowerCase() as Hex;
    if (auth.mode === 'none') {
        if (auth.v !== 0 || r !== ZERO_BYTES32 || s !== ZERO_BYTES32) {
            throw new GaslessValidationError('auth_unexpected', field, 'auth mode "none" signs v = 0, r = 0 and s = 0');
        }
        return { mode: 'none', v: 0, r, s };
    }
    if (auth.v !== 27 && auth.v !== 28) throw invalid(`${field}.v`, 'v must be 27 or 28 (the intent signs it as it is)');
    checkRS(BigInt(r), BigInt(s), field);
    return { mode: auth.mode, v: auth.v, r, s };
}
