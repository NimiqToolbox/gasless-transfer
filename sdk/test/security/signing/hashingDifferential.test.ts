// Differential check: the zero-dependency core's own keccak-256, EIP-55 and EIP-712 code against viem (and
// ethers v6) on large random input sets, including edge cases the other hashing tests do not generate:
// unicode / empty / long domain strings, domains with and without chainId and salt, extreme uint256
// values, empty and odd-sized `bytes` (MetaTransaction functionSignature), multi-block keccak inputs.
// The core computes the digests users sign, so any disagreement with the libraries wallets use is a bug.

import { TypedDataEncoder } from 'ethers6';
import { describe, expect, it } from 'vitest';
import { domainSeparator, getAddress, hashTypedData, keccak256 as viemKeccak, type TypedDataDefinition } from 'viem';
import { toChecksumAddress } from '../../../src/core/address.js';
import { bytesToHex } from '../../../src/core/bytes.js';
import { hashDomain, typedDataDigest } from '../../../src/core/eip712.js';
import { keccak256 } from '../../../src/core/keccak.js';
import { META_TRANSACTION_TYPES, PERMIT_TYPES, TRANSFER_TYPES } from '../../../src/core/typedData.js';
import type { Hex, TypedDataDomain } from '../../../src/core/types.js';

function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function tools(seed: number) {
    const random = rng(seed);
    const int = (max: number) => Math.floor(random() * max);
    const bytes = (n: number) => Uint8Array.from({ length: n }, () => int(256));
    const hex = (n: number): Hex => bytesToHex(bytes(n));
    const address = () => getAddress(hex(20));
    const uint = (): string => {
        switch (int(6)) {
            case 0:
                return '0';
            case 1:
                return ((1n << 256n) - 1n).toString();
            case 2:
                return (1n << BigInt(int(256))).toString();
            default:
                return BigInt(hex(1 + int(32))).toString();
        }
    };
    const text = (): string => {
        const alphabet = ['a', 'Z', '0', ' ', 'é', 'ß', '€', '中', '😀', '\u0000', '"', '\\', '(', ',', ')'];
        const length = int(4) === 0 ? 0 : int(80);
        let s = '';
        for (let i = 0; i < length; i++) s += alphabet[int(alphabet.length)];
        return s;
    };
    const domain = (): TypedDataDomain => {
        const withChain = int(3) !== 0;
        const withSalt = !withChain || int(2) === 0;
        return {
            name: text(),
            // viem drops a falsy `version` from EIP712Domain while the core, ethers and OpenZeppelin keep it; pins and the
            // relay's deployment parser require a non-empty version, so only non-empty versions are compared.
            version: text() || '1',
            ...(withChain ? { chainId: 1 + int(2 ** 31) } : {}),
            verifyingContract: address(),
            ...(withSalt ? { salt: hex(32) } : {}),
        };
    };
    return { int, bytes, hex, address, uint, domain };
}

describe('keccak-256 (core) vs viem', () => {
    it('3000 random inputs up to 5 rate blocks, plus every length around the 136-byte boundaries', () => {
        const t = tools(11);
        for (let i = 0; i < 3000; i++) {
            const data = t.bytes(t.int(136 * 5 + 1));
            expect(bytesToHex(keccak256(data))).toBe(viemKeccak(data));
        }
        for (const base of [136, 272, 408, 544]) {
            for (let d = -2; d <= 2; d++) {
                const data = t.bytes(base + d);
                expect(bytesToHex(keccak256(data)), `length ${base + d}`).toBe(viemKeccak(data));
            }
        }
    });
});

describe('EIP-55 (core) vs viem', () => {
    it('2000 random addresses in lower, checksummed and upper case', () => {
        const t = tools(12);
        for (let i = 0; i < 2000; i++) {
            const lower = t.hex(20);
            const expected = getAddress(lower);
            expect(toChecksumAddress(lower)).toBe(expected);
            expect(toChecksumAddress(expected)).toBe(expected);
            expect(toChecksumAddress(`0x${lower.slice(2).toUpperCase()}`)).toBe(expected);
        }
    });
});

describe('EIP-712 (core) vs viem and ethers v6', () => {
    it('domain separators for 2000 random domains (unicode, empty strings, with/without chainId and salt)', () => {
        const t = tools(13);
        for (let i = 0; i < 2000; i++) {
            const d = t.domain();
            const expected = domainSeparator({ domain: d });
            expect(hashDomain(d)).toBe(expected);
            if (i % 10 === 0) expect(TypedDataEncoder.hashDomain(d)).toBe(expected);
        }
    });

    it('digests of 1500 random GaslessTransfer, Permit and MetaTransaction payloads', () => {
        const t = tools(14);
        for (let i = 0; i < 1500; i++) {
            const domain = t.domain();
            let payload: { domain: TypedDataDomain; types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
            switch (i % 3) {
                case 0:
                    payload = {
                        domain,
                        types: TRANSFER_TYPES,
                        primaryType: 'GaslessTransfer',
                        message: {
                            token: t.address(),
                            from: t.address(),
                            to: t.address(),
                            amount: t.uint(),
                            fee: t.uint(),
                            relay: t.address(),
                            nonce: t.uint(),
                            deadline: t.uint(),
                            auth: { mode: t.int(3), v: t.int(256), r: t.hex(32), s: t.hex(32) },
                        },
                    };
                    break;
                case 1:
                    payload = {
                        domain,
                        types: PERMIT_TYPES,
                        primaryType: 'Permit',
                        message: { owner: t.address(), spender: t.address(), value: t.uint(), nonce: t.uint(), deadline: t.uint() },
                    };
                    break;
                default:
                    payload = {
                        domain,
                        types: META_TRANSACTION_TYPES,
                        primaryType: 'MetaTransaction',
                        message: { nonce: t.uint(), from: t.address(), functionSignature: t.hex(t.int(200)) },
                    };
            }
            const expected = hashTypedData(payload as unknown as TypedDataDefinition);
            expect(typedDataDigest(payload)).toBe(expected);
            if (i % 15 === 0) expect(TypedDataEncoder.hash(payload.domain, payload.types as never, payload.message)).toBe(expected);
        }
    });
});
