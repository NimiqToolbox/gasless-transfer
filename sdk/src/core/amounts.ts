import type { DecimalString } from './types.js';

export const MAX_UINT256 = (1n << 256n) - 1n;

const UINT_RE = /^[0-9]{1,78}$/;
const CANONICAL_UINT_RE = /^(0|[1-9][0-9]{0,77})$/;

/** A uint256 as bigint, canonical-or-padded decimal string, or safe integer number. Throws TypeError otherwise. */
export function toUint256(value: bigint | DecimalString | number, field = 'value'): bigint {
    let n: bigint;
    if (typeof value === 'bigint') n = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
    else if (typeof value === 'string' && UINT_RE.test(value)) n = BigInt(value);
    else throw new TypeError(`${field}: expected a uint256 as bigint, decimal string or safe integer`);
    if (n < 0n || n > MAX_UINT256) throw new TypeError(`${field}: out of uint256 range`);
    return n;
}

/** True for the wire format of a uint256: a decimal string without sign, exponent or leading zeros. */
export function isCanonicalUint256(value: unknown): value is DecimalString {
    return typeof value === 'string' && CANONICAL_UINT_RE.test(value) && BigInt(value) <= MAX_UINT256;
}

/**
 * The largest amount `from` can send when `fee` is paid on top (`amount + fee <= balance`), or 0n
 * when the balance does not cover the fee plus the smallest unit. For cashlinks this is the claim
 * amount (§4.5).
 */
export function maxSendable(balance: bigint | DecimalString, fee: bigint | DecimalString): bigint {
    const b = toUint256(balance, 'balance');
    const f = toUint256(fee, 'fee');
    return b > f ? b - f : 0n;
}
