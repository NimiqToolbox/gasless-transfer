// T30 golden vectors, complementing vectors.test.ts (zero-dependency core and viem) on the same
// files: ethers v5 and ethers v6 must hash the typed data the SDK builders make from each vector to
// the digest the contract (hashTransfer) or the token computed; the files must exist, so the T30
// check cannot silently turn into a skip; and they must cover the cases listed in
// contracts/test/vectors/README.md. The files are generated and re-checked by
// contracts/test/vectors/GoldenVectors.t.sol.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { utils as ethers5Utils } from 'ethers5';
import { TypedDataEncoder as Ethers6TypedDataEncoder } from 'ethers6';
import { describe, expect, it } from 'vitest';
import { toChecksumAddress } from '../src/core/address.js';
import { MAX_UINT256 } from '../src/core/amounts.js';
import { buildMetaTxApproveTypedData, buildPermitTypedData, buildTransferTypedData } from '../src/core/typedData.js';
import type { Address, Hex, TokenAuthorization, TransferRequest, TypedDataDomain, TypedDataField } from '../src/core/types.js';

interface TransferVector {
    name: string;
    request: TransferRequest;
    authorization: TokenAuthorization;
    digest: Hex;
}

interface TokenAuthorizationVector {
    name: string;
    kind: 'permit' | 'metaTxApprove';
    domain: TypedDataDomain;
    message: Record<string, string>;
    digest: Hex;
}

interface VectorFile {
    chainId: number;
    verifyingContract: Address;
    transfers: TransferVector[];
    tokenAuthorizations?: TokenAuthorizationVector[];
}

interface Payload {
    domain: TypedDataDomain;
    types: Readonly<Record<string, readonly TypedDataField[]>>;
    message: Record<string, unknown>;
}

const vectorsDir = fileURLToPath(new URL('../../contracts/test/vectors/data', import.meta.url));
const files = readdirSync(vectorsDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

function load(file: string): VectorFile {
    return JSON.parse(readFileSync(path.join(vectorsDir, file), 'utf8')) as VectorFile;
}

/** The digest of `payload` with ethers v5 (`_TypedDataEncoder`, as behind `_signTypedData`) and ethers v6. */
function ethersDigests(payload: Payload): { ethers5: string; ethers6: string } {
    const types = payload.types as Record<string, TypedDataField[]>;
    return {
        ethers5: ethers5Utils._TypedDataEncoder.hash(payload.domain, types, payload.message),
        ethers6: Ethers6TypedDataEncoder.hash(payload.domain, types, payload.message),
    };
}

/** The typed data the SDK builds for a token authorization vector (rebuilt as in vectors.test.ts). */
function tokenAuthorizationTypedData(vector: TokenAuthorizationVector): Payload {
    const m = vector.message;
    if (vector.kind === 'permit') {
        return buildPermitTypedData({
            tokenDomain: vector.domain,
            owner: m.owner as Address,
            spender: m.spender as Address,
            value: m.value as string,
            nonce: m.nonce as string,
            deadline: m.deadline as string,
        }) as unknown as Payload;
    }
    // functionSignature = approve(spender, value): selector, then one 32-byte word each.
    const call = m.functionSignature as string;
    const typed = buildMetaTxApproveTypedData({
        tokenDomain: vector.domain,
        from: m.from as Address,
        spender: toChecksumAddress(`0x${call.slice(34, 74)}`),
        value: BigInt(`0x${call.slice(74)}`),
        nonce: m.nonce as string,
    });
    expect(typed.message.functionSignature, vector.name).toBe(call.toLowerCase());
    return typed as unknown as Payload;
}

const addressesOf = (r: TransferRequest): string[] => [r.token, r.from, r.to, r.relay];

describe('T30 golden vectors: ethers v5 and v6, presence and coverage', () => {
    it('the vector files are present, so vectors.test.ts checks them instead of skipping', () => {
        expect(files).toEqual(expect.arrayContaining(['gasless-transfer-137.json', 'gasless-transfer-31337.json']));
    });

    it.each(files)('%s: ethers v5 and v6 hash the SDK typed data to the contract and token digests', (name) => {
        const file = load(name);
        for (const vector of file.transfers) {
            const payload = buildTransferTypedData(file.chainId, file.verifyingContract, vector.request, vector.authorization);
            const digests = ethersDigests(payload as unknown as Payload);
            expect(digests.ethers5, vector.name).toBe(vector.digest);
            expect(digests.ethers6, vector.name).toBe(vector.digest);
        }
        for (const vector of file.tokenAuthorizations ?? []) {
            const digests = ethersDigests(tokenAuthorizationTypedData(vector));
            expect(digests.ethers5, vector.name).toBe(vector.digest);
            expect(digests.ethers6, vector.name).toBe(vector.digest);
        }
    });

    it.each(files)('%s covers the cases listed in the vectors README', (name) => {
        const file = load(name);
        const requests = file.transfers.map((vector) => vector.request);
        const some = (predicate: (r: TransferRequest) => boolean): boolean => requests.some(predicate);
        const tokens = new Set(requests.map((r) => r.token.toLowerCase()));
        const max = MAX_UINT256.toString();

        expect(tokens.size, 'both tokens').toBe(2);
        expect(some((r) => r.fee === '0'), 'fee 0').toBe(true);
        expect(some((r) => r.fee === '10000'), 'fee 10000').toBe(true);
        expect(some((r) => r.fee === '5000000'), 'fee 5000000').toBe(true);
        // The contract bounds no fee: one executed transfer pays 50.00.
        expect(file.transfers.slice(0, 5).some((v) => v.request.fee === '50000000'), 'fee 50000000, executed').toBe(true);
        expect(some((r) => r.fee === max), 'fee 2^256 - 1').toBe(true);
        expect(some((r) => r.amount === '1'), 'amount 1').toBe(true);
        expect(some((r) => r.fee !== '0' && BigInt(r.amount) + BigInt(r.fee) === MAX_UINT256), 'amount 2^256 - 1 - fee').toBe(true);
        expect(some((r) => r.amount === max && r.fee === '0'), 'amount 2^256 - 1, fee 0').toBe(true);
        // The first five transfers were executed in order, at the signer's nonces 0 to 4.
        expect(file.transfers.slice(0, 5).map((v) => v.request.nonce)).toEqual(['0', '1', '2', '3', '4']);
        for (const nonce of ['0', '5', '7', '9', '4294967295', max]) expect(some((r) => r.nonce === nonce), `nonce ${nonce}`).toBe(true);
        expect(some((r) => r.deadline === '0'), 'deadline 0').toBe(true);
        expect(some((r) => r.deadline === max), 'deadline 2^256 - 1').toBe(true);
        expect(some((r) => tokens.has(r.to.toLowerCase()) && r.to.toLowerCase() !== r.token.toLowerCase()), 'recipient = the other token').toBe(
            true,
        );
        expect(some((r) => [r.from, r.to, r.relay].every((a) => a.startsWith('0x00'))), 'leading zero bytes').toBe(true);
        expect(
            some((r) => addressesOf(r).every((a) => a === toChecksumAddress(a) && a !== a.toLowerCase())),
            'checksummed (mixed-case) addresses',
        ).toBe(true);

        // An all-lowercase request has the same digest as its checksummed twin.
        const lowercase = file.transfers.filter((v) => addressesOf(v.request).every((a) => a === a.toLowerCase()));
        expect(lowercase.length, 'all-lowercase addresses').toBeGreaterThan(0);
        for (const vector of lowercase) {
            const twin = file.transfers.find(
                (v) =>
                    v !== vector &&
                    JSON.stringify(v.request).toLowerCase() === JSON.stringify(vector.request).toLowerCase() &&
                    JSON.stringify(v.authorization) === JSON.stringify(vector.authorization),
            );
            expect(twin?.digest, vector.name).toBe(vector.digest);
        }

        // Authorizations of every mode; "none" with the zeros clients sign and with other values; v 27 and 28.
        const auths = file.transfers.map((v) => v.authorization);
        const zero = `0x${'00'.repeat(32)}`;
        for (const mode of ['none', 'permit', 'metaTxApprove']) expect(auths.some((a) => a.mode === mode), `mode ${mode}`).toBe(true);
        expect(auths.some((a) => a.mode === 'none' && a.v === 0 && a.r === zero && a.s === zero), 'none with zeros').toBe(true);
        expect(auths.some((a) => a.mode === 'none' && (a.v !== 0 || a.r !== zero || a.s !== zero)), 'none with other values').toBe(true);
        for (const v of [27, 28]) expect(auths.some((a) => a.mode !== 'none' && a.v === v), `v ${v}`).toBe(true);

        const authorizations = file.tokenAuthorizations ?? [];
        expect(authorizations.some((a) => a.kind === 'permit' && a.domain.chainId === file.chainId), 'USDC permit (chainId domain)').toBe(true);
        expect(authorizations.some((a) => a.kind === 'permit' && a.domain.salt !== undefined), 'USDT0 permit (salt domain)').toBe(true);
        expect(authorizations.some((a) => a.kind === 'metaTxApprove'), 'USDT0 meta-tx approve').toBe(true);
        for (const authorization of authorizations) {
            // Every authorization is for the transfer contract of this file (spender, and approve's spender).
            const spender = authorization.kind === 'permit' ? authorization.message.spender : `0x${authorization.message.functionSignature?.slice(34, 74)}`;
            expect(spender?.toLowerCase(), authorization.name).toBe(file.verifyingContract.toLowerCase());
        }
    });
});
