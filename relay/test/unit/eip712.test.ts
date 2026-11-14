import { describe, expect, it } from 'vitest';
import { encodeFunctionData, hashTypedData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
    META_TRANSACTION_TYPES,
    PERMIT_TYPES,
    POLYGON_USDC,
    POLYGON_USDT0,
    TRANSFER_TYPES,
    buildMetaTxApproveTypedData,
    buildPermitTypedData,
    buildTransferTypedData,
    tokenAuthHash,
    transferDigestFromAuthHash,
    transferDomain,
    usdt0Abi,
    type TokenAuthorization,
} from '@nimiq/gasless-sdk/core';
import {
    SECP256K1_HALF_N,
    SECP256K1_N,
    hashDomain,
    hashSdkTypedData,
    isCanonicalEcdsa,
    recoverCanonical,
    splitSignature65,
} from '../../src/eip712.js';
import { CONTRACT, NO_AUTH, expectedRequestId, toHighS } from '../helpers/harness.js';
import { RECIPIENT_ADDRESS, RELAY_ADDRESS, USER_ADDRESS, USER_KEY } from '../helpers/keys.js';

const request = {
    token: POLYGON_USDC.address,
    from: USER_ADDRESS,
    to: RECIPIENT_ADDRESS,
    amount: '1000000',
    fee: '10000',
    relay: RELAY_ADDRESS,
    nonce: '42',
    deadline: '1790000600',
};
const permit: TokenAuthorization = { mode: 'permit', v: 28, r: `0x${'12'.repeat(32)}`, s: `0x${'34'.repeat(32)}` };

describe('EIP-712 hashing', () => {
    it('token domains hash to the on-chain DOMAIN_SEPARATOR values pinned in the SDK', () => {
        expect(hashDomain(POLYGON_USDC.domain)).toBe(POLYGON_USDC.domainSeparator);
        expect(hashDomain(POLYGON_USDT0.domain)).toBe(POLYGON_USDT0.domainSeparator);
    });

    it('the transfer digest (request id, version "3", nested TokenAuth) equals viem typed-data hashing with bigint values', () => {
        for (const authorization of [permit, NO_AUTH]) {
            const digest = hashSdkTypedData(buildTransferTypedData(137, CONTRACT, request, authorization));
            expect(digest).toBe(expectedRequestId(request, authorization));
            expect(transferDomain(137, CONTRACT).version).toBe('3');
            expect(digest).toBe(
                hashTypedData({
                    domain: transferDomain(137, CONTRACT),
                    types: TRANSFER_TYPES,
                    primaryType: 'GaslessTransfer',
                    message: {
                        ...request,
                        amount: 1_000_000n,
                        fee: 10_000n,
                        nonce: 42n,
                        deadline: 1_790_000_600n,
                        auth: { mode: authorization === permit ? 1 : 0, v: authorization.v, r: authorization.r, s: authorization.s },
                    },
                }),
            );
            // The id from the auth hash (a version without its token signature) is the same.
            expect(transferDigestFromAuthHash(137, CONTRACT, request, tokenAuthHash(authorization))).toBe(digest);
        }
    });

    it('the signed token authorization is part of the id: any change of mode, v, r or s changes it', () => {
        const id = expectedRequestId(request, permit);
        const variants: TokenAuthorization[] = [
            { ...permit, mode: 'metaTxApprove' },
            { ...permit, v: 27 },
            { ...permit, r: `0x${'13'.repeat(32)}` },
            { ...permit, s: `0x${'35'.repeat(32)}` },
            NO_AUTH,
        ];
        const ids = variants.map((a) => hashSdkTypedData(buildTransferTypedData(137, CONTRACT, request, a)));
        expect(new Set([id, ...ids]).size).toBe(variants.length + 1);
    });

    it('permit and meta-tx digests equal viem typed-data hashing for both token domains', () => {
        for (const token of [POLYGON_USDC, POLYGON_USDT0]) {
            const permit = buildPermitTypedData({ tokenDomain: token.domain, owner: USER_ADDRESS, spender: CONTRACT, value: 1_010_000n, nonce: 3n, deadline: 99n });
            expect(hashSdkTypedData(permit)).toBe(
                hashTypedData({
                    domain: token.domain,
                    types: PERMIT_TYPES,
                    primaryType: 'Permit',
                    message: { owner: USER_ADDRESS, spender: CONTRACT, value: 1_010_000n, nonce: 3n, deadline: 99n },
                }),
            );
        }
        const meta = buildMetaTxApproveTypedData({ tokenDomain: POLYGON_USDT0.domain, from: USER_ADDRESS, spender: CONTRACT, value: 1_010_000n, nonce: 7n });
        expect(hashSdkTypedData(meta)).toBe(
            hashTypedData({
                domain: POLYGON_USDT0.domain,
                types: META_TRANSACTION_TYPES,
                primaryType: 'MetaTransaction',
                message: {
                    nonce: 7n,
                    from: USER_ADDRESS,
                    functionSignature: encodeFunctionData({ abi: usdt0Abi, functionName: 'approve', args: [CONTRACT, 1_010_000n] }),
                },
            }),
        );
    });

    it('different requests have different ids', () => {
        const a = hashSdkTypedData(buildTransferTypedData(137, CONTRACT, request, permit));
        const b = hashSdkTypedData(buildTransferTypedData(137, CONTRACT, { ...request, nonce: '43' }, permit));
        const c = hashSdkTypedData(buildTransferTypedData(80002, CONTRACT, request, permit));
        expect(new Set([a, b, c]).size).toBe(3);
    });
});

describe('canonical ECDSA', () => {
    it('splits exactly 65-byte signatures', () => {
        const sig = `0x${'11'.repeat(32)}${'22'.repeat(32)}1c` as Hex;
        expect(splitSignature65(sig)).toEqual({ r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 28 });
        expect(splitSignature65(sig.slice(0, 130) as Hex)).toBeUndefined();
        expect(splitSignature65(`${sig}00`)).toBeUndefined();
    });

    it('accepts v ∈ {27, 28}, 0 < r < n, 0 < s ≤ n/2 only', () => {
        const r = `0x${'11'.repeat(32)}` as Hex;
        const hex = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
        expect(isCanonicalEcdsa({ v: 27, r, s: hex(SECP256K1_HALF_N) })).toBe(true);
        expect(isCanonicalEcdsa({ v: 28, r, s: hex(1n) })).toBe(true);
        expect(isCanonicalEcdsa({ v: 27, r, s: hex(SECP256K1_HALF_N + 1n) })).toBe(false);
        expect(isCanonicalEcdsa({ v: 27, r, s: hex(0n) })).toBe(false);
        expect(isCanonicalEcdsa({ v: 27, r: hex(0n), s: hex(1n) })).toBe(false);
        expect(isCanonicalEcdsa({ v: 27, r: hex(SECP256K1_N), s: hex(1n) })).toBe(false);
        for (const v of [0, 1, 26, 29, 255]) expect(isCanonicalEcdsa({ v, r, s: hex(1n) })).toBe(false);
    });

    it('recovers the signer of a low-s signature and rejects its high-s twin', async () => {
        const digest = hashSdkTypedData(buildTransferTypedData(137, CONTRACT, request, permit));
        const account = privateKeyToAccount(USER_KEY);
        const sig = await account.sign({ hash: digest });
        expect(await recoverCanonical(digest, splitSignature65(sig)!)).toBe(USER_ADDRESS);
        expect(await recoverCanonical(digest, splitSignature65(toHighS(sig))!)).toBeUndefined();
        expect(await recoverCanonical(digest, { v: 27, r: `0x${'ff'.repeat(32)}`, s: `0x${'01'.padStart(64, '0')}` })).toBeUndefined();
    });
});
