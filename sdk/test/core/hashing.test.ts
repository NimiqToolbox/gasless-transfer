// keccak-256, EIP-55 and EIP-712 of the zero-dependency core, compared with viem, ethers v5 and v6.

import { utils as ethers5Utils } from 'ethers5';
import { getAddress as ethers6GetAddress, keccak256 as ethers6Keccak, TypedDataEncoder } from 'ethers6';
import { describe, expect, it } from 'vitest';
import {
    domainSeparator,
    encodeAbiParameters,
    getAddress,
    hashStruct,
    hashTypedData,
    keccak256 as viemKeccak,
    parseAbiParameters,
    type TypedDataDefinition,
} from 'viem';
import { isAddress, isChecksumAddress, sameAddress, toChecksumAddress } from '../../src/core/address.js';
import { bytesToHex, hexToBytes, uint256Word } from '../../src/core/bytes.js';
import { POLYGON_USDC, POLYGON_USDT0 } from '../../src/core/constants.js';
import { hashDomain, tokenAuthHash, transferDigest, transferDigestFromAuthHash, typedDataDigest } from '../../src/core/eip712.js';
import { keccak256 } from '../../src/core/keccak.js';
import {
    buildMetaTxApproveTypedData,
    buildPermitTypedData,
    buildTransferTypedData,
    TOKEN_AUTH_TYPE,
    tokenAuthMessage,
    TRANSFER_TYPE,
    TRANSFER_TYPES,
    transferDomain,
} from '../../src/core/typedData.js';
import type { AuthModeName, TokenAuthorization, TransferRequest } from '../../src/core/types.js';
import { ADDR, hex, NONE_AUTH, prng, sampleRequest, TRANSFER_CONTRACT, ZERO32 } from '../helpers/fixtures.js';

const ascii = (s: string) => new TextEncoder().encode(s);
const asViem = (payload: unknown) => payload as TypedDataDefinition;

describe('keccak256', () => {
    it('matches published vectors', () => {
        expect(bytesToHex(keccak256(new Uint8Array()))).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
        expect(bytesToHex(keccak256(ascii('abc')))).toBe('0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
        expect(bytesToHex(keccak256(ascii('The quick brown fox jumps over the lazy dog')))).toBe(
            '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
        );
    });

    it('matches viem and ethers for every length 0..700 (all padding and block-boundary cases)', () => {
        const random = prng(1);
        for (let length = 0; length <= 700; length++) {
            const data = random(length);
            const expected = viemKeccak(data);
            expect(bytesToHex(keccak256(data)), `length ${length}`).toBe(expected);
            if (length % 50 === 0) {
                expect(ethers5Utils.keccak256(data)).toBe(expected);
                expect(ethers6Keccak(data)).toBe(expected);
            }
        }
    });

    it('matches viem for 1000 random inputs of the sizes the SDK hashes', () => {
        const random = prng(2);
        for (let i = 0; i < 1000; i++) {
            const data = random([20, 32, 40, 64, 66, 96, 288][i % 7] as number);
            expect(bytesToHex(keccak256(data))).toBe(viemKeccak(data));
        }
    });
});

describe('byte helpers', () => {
    it('round-trip hex and reject malformed hex', () => {
        expect(bytesToHex(hexToBytes('0x00ff10'))).toBe('0x00ff10');
        expect(() => hexToBytes('00ff')).toThrow(TypeError);
        expect(() => hexToBytes('0x0')).toThrow(TypeError);
        expect(() => hexToBytes('0xzz')).toThrow(TypeError);
    });

    it('encodes uint256 words and rejects out-of-range values', () => {
        expect(bytesToHex(uint256Word(1n))).toBe(`0x${'00'.repeat(31)}01`);
        expect(bytesToHex(uint256Word((1n << 256n) - 1n))).toBe(`0x${'ff'.repeat(32)}`);
        expect(() => uint256Word(1n << 256n)).toThrow(RangeError);
        expect(() => uint256Word(-1n)).toThrow(RangeError);
    });
});

describe('EIP-55 addresses', () => {
    // Test vectors from EIP-55.
    const vectors = [
        '0x52908400098527886E0F7030069857D2E4169EE7',
        '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
        '0xde709f2102306220921060314715629080e2fb77',
        '0x27b1fdb04752bbc536007a920d24acb045561c26',
        '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
        '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
        '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ];

    it('checksums the EIP-55 vectors', () => {
        for (const vector of vectors) {
            expect(toChecksumAddress(vector.toLowerCase())).toBe(vector);
            expect(isAddress(vector)).toBe(true);
        }
    });

    it('matches viem and ethers for 300 random addresses', () => {
        const random = prng(3);
        for (let i = 0; i < 300; i++) {
            const lower = hex(random(20));
            const expected = getAddress(lower);
            expect(toChecksumAddress(lower)).toBe(expected);
            expect(toChecksumAddress(expected)).toBe(expected);
            expect(ethers5Utils.getAddress(lower)).toBe(expected);
            expect(ethers6GetAddress(lower)).toBe(expected);
        }
    });

    it('accepts all-lowercase and all-uppercase digits, rejects a wrong mixed-case checksum', () => {
        const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
        const flipped = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'; // last letter case flipped
        expect(isAddress(good.toLowerCase())).toBe(true);
        expect(isAddress(`0x${good.slice(2).toUpperCase()}`)).toBe(true);
        expect(isAddress(flipped)).toBe(false);
        expect(() => toChecksumAddress(flipped)).toThrow(/checksum/);
    });

    it('isChecksumAddress accepts only the checksummed form, like the relay', () => {
        const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
        expect(isChecksumAddress(good)).toBe(true);
        expect(isChecksumAddress(good.toLowerCase())).toBe(false);
        expect(isChecksumAddress(`0x${good.slice(2).toUpperCase()}`)).toBe(false);
        expect(isChecksumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false);
        // Digits only: the address is its own checksum.
        expect(isChecksumAddress(`0x${'12'.repeat(20)}`)).toBe(true);
        for (const bad of ['', '0x', `0X${good.slice(2)}`, good.slice(2), 42, null, undefined]) expect(isChecksumAddress(bad)).toBe(false);
        for (const address of Object.values(ADDR)) expect(isChecksumAddress(address)).toBe(getAddress(address) === address);
    });

    it('rejects malformed addresses', () => {
        for (const bad of ['', '0x', '0x1234', `0x${'a'.repeat(39)}`, `0x${'a'.repeat(41)}`, `0X${'a'.repeat(40)}`, `${'a'.repeat(40)}`, `0x${'g'.repeat(40)}`, 42, null, undefined]) {
            expect(isAddress(bad)).toBe(false);
            expect(() => toChecksumAddress(bad as string)).toThrow(TypeError);
        }
    });

    it('compares case-insensitively', () => {
        expect(sameAddress(ADDR.user, ADDR.user.toLowerCase())).toBe(true);
        expect(sameAddress(ADDR.user, ADDR.recipient)).toBe(false);
    });
});

describe('EIP-712 hashing', () => {
    it('reproduces the frozen, mainnet-read token domain separators', () => {
        expect(hashDomain(POLYGON_USDC.domain)).toBe(POLYGON_USDC.domainSeparator);
        expect(hashDomain(POLYGON_USDT0.domain)).toBe(POLYGON_USDT0.domainSeparator);
        expect(domainSeparator({ domain: POLYGON_USDC.domain })).toBe(POLYGON_USDC.domainSeparator);
        expect(domainSeparator({ domain: POLYGON_USDT0.domain })).toBe(POLYGON_USDT0.domainSeparator);
    });

    it('hashes the transfer domain like viem and ethers', () => {
        const domain = transferDomain(137, TRANSFER_CONTRACT);
        const expected = domainSeparator({ domain });
        expect(hashDomain(domain)).toBe(expected);
        expect(ethers5Utils._TypedDataEncoder.hashDomain(domain)).toBe(expected);
        expect(TypedDataEncoder.hashDomain(domain)).toBe(expected);
    });

    it('the frozen TRANSFER_TYPE and TOKEN_AUTH_TYPE strings are the encodeType of TRANSFER_TYPES, and match the contract type hashes', () => {
        expect(TypedDataEncoder.from(TRANSFER_TYPES as never).encodeType('GaslessTransfer')).toBe(TRANSFER_TYPE);
        expect(TypedDataEncoder.from({ TokenAuth: TRANSFER_TYPES.TokenAuth } as never).encodeType('TokenAuth')).toBe(TOKEN_AUTH_TYPE);
        // TRANSFER_TYPEHASH and TOKEN_AUTH_TYPEHASH of contracts/src/GaslessTransfer.sol.
        expect(viemKeccak(ascii(TRANSFER_TYPE))).toBe('0x7ab85ade3e686e1c69984c37565b73a20f3bea60cd9870d043cac7acb2d10273');
        expect(viemKeccak(ascii(TOKEN_AUTH_TYPE))).toBe('0xd2c6df1fc0c41180a4ec92ee33b18dac8247c79ed4d0a933db3cb5a9338acabe');
    });

    it('a payload cannot edit the type definitions every later payload is built from', () => {
        const transfer = buildTransferTypedData(137, TRANSFER_CONTRACT, sampleRequest(), NONE_AUTH);
        const permit = buildPermitTypedData({ tokenDomain: POLYGON_USDC.domain, owner: ADDR.user, spender: TRANSFER_CONTRACT, value: 1n, nonce: 0n, deadline: 1n });
        const metaTx = buildMetaTxApproveTypedData({ tokenDomain: POLYGON_USDT0.domain, from: ADDR.user, spender: TRANSFER_CONTRACT, value: 1n, nonce: 0n });
        for (const payload of [transfer, permit, metaTx]) {
            const types = payload.types as unknown as Record<string, Array<{ name: string; type: string }>>;
            const fields = types[payload.primaryType] ?? [];
            expect(() => { types.EIP712Domain = []; }).toThrow(TypeError);
            expect(() => fields.push({ name: 'extra', type: 'uint256' })).toThrow(TypeError);
            expect(() => { (fields[0] as { type: string }).type = 'bytes'; }).toThrow(TypeError);
        }
        expect(buildTransferTypedData(137, TRANSFER_CONTRACT, sampleRequest(), NONE_AUTH)).toEqual(transfer);
    });

    it('matches viem, ethers v5 and ethers v6 for 60 random transfers, permits and meta-tx approvals', () => {
        const random = prng(4);
        const uint = (bytes: number) => (bytes === 0 ? '0' : BigInt(hex(random(bytes))).toString(10));
        const modes = ['none', 'permit', 'metaTxApprove'] as const;
        for (let i = 0; i < 20; i++) {
            const request: TransferRequest = {
                token: getAddress(hex(random(20))),
                from: getAddress(hex(random(20))),
                to: getAddress(hex(random(20))),
                amount: uint(1 + (i % 32)),
                fee: uint(1 + (i % 4)),
                relay: getAddress(hex(random(20))),
                nonce: uint(i % 33),
                deadline: uint(1 + (i % 8)),
            };
            const authorization: TokenAuthorization = { mode: modes[i % 3] as AuthModeName, v: (random(1)[0] as number), r: hex(random(32)), s: hex(random(32)) };
            const contract = getAddress(hex(random(20)));
            const payloads = [
                buildTransferTypedData(i % 2 === 0 ? 137 : 80002, contract, request, authorization),
                buildPermitTypedData({
                    tokenDomain: i % 2 === 0 ? POLYGON_USDC.domain : POLYGON_USDT0.domain,
                    owner: request.from,
                    spender: contract,
                    value: uint(32),
                    nonce: uint(i % 3),
                    deadline: request.deadline,
                }),
                buildMetaTxApproveTypedData({ tokenDomain: POLYGON_USDT0.domain, from: request.from, spender: contract, value: uint(16), nonce: uint(2) }),
            ];
            for (const payload of payloads) {
                const expected = hashTypedData(asViem(payload));
                expect(typedDataDigest(payload)).toBe(expected);
                expect(ethers5Utils._TypedDataEncoder.hash(payload.domain, payload.types as never, payload.message)).toBe(expected);
                expect(TypedDataEncoder.hash(payload.domain, payload.types as never, payload.message)).toBe(expected);
            }
            const expected = hashTypedData(asViem(buildTransferTypedData(137, contract, request, authorization)));
            expect(transferDigest(137, contract, request, authorization)).toBe(expected);
            // The id from the request and the hash of the token authorization, without the signature.
            const authHash = hashStruct({ types: TRANSFER_TYPES, primaryType: 'TokenAuth', data: tokenAuthMessage(authorization) as never });
            expect(tokenAuthHash(authorization)).toBe(authHash);
            expect(transferDigestFromAuthHash(137, contract, request, authHash)).toBe(expected);
        }
    });

    it('tokenAuthHash is the contract word: keccak256(abi.encode(TOKEN_AUTH_TYPEHASH, mode, v, r, s))', () => {
        const auth = { mode: 'metaTxApprove', v: 28, r: `0x${'0a'.repeat(32)}`, s: `0x${'0b'.repeat(32)}` } as const;
        const encoded = encodeAbiParameters(parseAbiParameters('bytes32, uint8, uint8, bytes32, bytes32'), [
            viemKeccak(ascii(TOKEN_AUTH_TYPE)),
            2,
            28,
            auth.r,
            auth.s,
        ]);
        expect(tokenAuthHash(auth)).toBe(viemKeccak(encoded));
        // Mode "none" with zeros: the authorization every NONE intent signs.
        expect(tokenAuthHash(NONE_AUTH)).toBe(
            viemKeccak(encodeAbiParameters(parseAbiParameters('bytes32, uint8, uint8, bytes32, bytes32'), [viemKeccak(ascii(TOKEN_AUTH_TYPE)), 0, 0, ZERO32, ZERO32])),
        );
    });

    it('the token authorization of the message is checked: mode name, v a uint8, r and s bytes32', () => {
        const request = sampleRequest();
        for (const bad of [
            { ...NONE_AUTH, mode: 'NONE' },
            { ...NONE_AUTH, mode: 1 },
            { ...NONE_AUTH, v: 256 },
            { ...NONE_AUTH, v: -1 },
            { ...NONE_AUTH, v: 1.5 },
            { ...NONE_AUTH, v: '27' },
            { ...NONE_AUTH, r: '0x12' },
            { ...NONE_AUTH, s: undefined },
            null,
        ]) {
            expect(() => buildTransferTypedData(137, TRANSFER_CONTRACT, request, bad as never), JSON.stringify(bad)).toThrow(TypeError);
        }
        expect(() => transferDigestFromAuthHash(137, TRANSFER_CONTRACT, request, '0x12' as never)).toThrow(TypeError);
        expect(() => buildTransferTypedData(137, TRANSFER_CONTRACT, { ...request, nonce: '0x07' }, NONE_AUTH)).toThrow(TypeError);
    });

    it('refuses unreferenced types, a primary type outside types, EIP712Domain in types, arrays and unknown field types', () => {
        const transfer = buildTransferTypedData(137, TRANSFER_CONTRACT, sampleRequest(), NONE_AUTH);
        expect(() => typedDataDigest({ ...transfer, types: { ...transfer.types, Extra: [{ name: 'x', type: 'uint256' }] } })).toThrow(/references/);
        expect(() => typedDataDigest({ ...transfer, primaryType: 'Other' })).toThrow(/primary type/);
        expect(() => typedDataDigest({ ...transfer, types: { ...transfer.types, EIP712Domain: [] } })).toThrow(/EIP712Domain/);
        expect(() => typedDataDigest({ ...transfer, types: { GaslessTransfer: [{ name: 'x', type: 'uint256[]' }] }, message: { x: ['1'] } })).toThrow(/unsupported/);
        expect(() => typedDataDigest({ ...transfer, types: { GaslessTransfer: [{ name: 'x', type: 'int256' }] }, message: { x: '1' } })).toThrow(/unsupported/);
        // Without the nested type the auth member is unknown.
        expect(() => typedDataDigest({ ...transfer, types: { GaslessTransfer: transfer.types.GaslessTransfer } })).toThrow(/unsupported/);
    });
});
