// EIP-55 address helpers for the zero-dependency core.

import { keccak256 } from './keccak.js';
import type { Address } from './types.js';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const ADDRESS_FORMAT_RE = /^0x[0-9a-fA-F]{40}$/;

function checksum(lowercaseBody: string): string {
    // EIP-55: hash the lowercase hex characters (as ASCII), uppercase letter i if nibble i of the hash >= 8.
    const hash = keccak256(new TextEncoder().encode(lowercaseBody));
    let out = '';
    for (let i = 0; i < 40; i++) {
        const char = lowercaseBody.charAt(i);
        const byte = hash[i >> 1] ?? 0;
        const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
        out += nibble >= 8 ? char.toUpperCase() : char;
    }
    return out;
}

function hasMixedCase(body: string): boolean {
    return body !== body.toLowerCase() && body !== body.toUpperCase();
}

/**
 * True for `0x` + 40 hex digits. All-lowercase and all-uppercase digits are accepted as
 * non-checksummed; mixed case must be a valid EIP-55 checksum (a typo guard, as in ethers).
 */
export function isAddress(value: unknown): value is Address {
    if (typeof value !== 'string' || !ADDRESS_FORMAT_RE.test(value)) return false;
    const body = value.slice(2);
    return !hasMixedCase(body) || checksum(body.toLowerCase()) === body;
}

/** True only for the EIP-55 checksummed form, the form of an address on the wire (the relay accepts no other). */
export function isChecksumAddress(value: unknown): value is Address {
    return typeof value === 'string' && ADDRESS_FORMAT_RE.test(value) && checksum(value.slice(2).toLowerCase()) === value.slice(2);
}

/** EIP-55 checksummed form. Throws TypeError on malformed input or on a wrong mixed-case checksum. */
export function toChecksumAddress(value: string, field = 'address'): Address {
    if (typeof value !== 'string' || !ADDRESS_FORMAT_RE.test(value)) {
        throw new TypeError(`${field}: expected 0x followed by 40 hex characters`);
    }
    const body = value.slice(2);
    const checksummed = checksum(body.toLowerCase());
    if (hasMixedCase(body) && checksummed !== body) throw new TypeError(`${field}: invalid EIP-55 checksum`);
    return `0x${checksummed}`;
}

/** Case-insensitive address equality. Does not validate the format; callers validate first. */
export function sameAddress(a: string, b: string): boolean {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}
