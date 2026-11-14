// Internal byte and hex helpers of the zero-dependency core. Not re-exported from the package index.

import type { Hex } from './types.js';

const HEX_DIGITS_RE = /^[0-9a-fA-F]*$/;

/** Decodes 0x-prefixed hex with an even number of digits. */
export function hexToBytes(hex: string, field = 'value'): Uint8Array {
    if (typeof hex !== 'string' || !hex.startsWith('0x') || hex.length % 2 !== 0 || !HEX_DIGITS_RE.test(hex.slice(2))) {
        throw new TypeError(`${field}: expected 0x-prefixed hex with an even number of digits`);
    }
    const out = new Uint8Array((hex.length - 2) / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
    return out;
}

/** Lowercase 0x-prefixed hex. */
export function bytesToHex(bytes: Uint8Array): Hex {
    let hex = '0x';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex as Hex;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** 32-byte big-endian word of an unsigned integer below 2^256. */
export function uint256Word(value: bigint): Uint8Array {
    if (value < 0n || value >> 256n !== 0n) throw new RangeError('uint256 out of range');
    const out = new Uint8Array(32);
    let rest = value;
    for (let i = 31; i >= 0; i--) {
        out[i] = Number(rest & 0xffn);
        rest >>= 8n;
    }
    return out;
}

export function utf8Bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** Recursively freezes plain objects and arrays in place and returns the same value. */
export function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value)) deepFreeze(nested);
    }
    return value;
}

/**
 * A non-null, non-array object. Deliberately does not compare prototypes: objects from another realm
 * (an iframe, node:vm, postMessage clones) have a different Object.prototype.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
