// T30 golden vectors (format: contracts/test/vectors/README.md), generated from the real contract by
// contracts/test/vectors/GoldenVectors.t.sol; vectorsEthers.test.ts makes sure the files are present.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashTypedData, keccak256, toBytes, type TypedDataDefinition } from 'viem';
import { toChecksumAddress } from '../src/core/address.js';
import { hashDomain, tokenAuthHash, transferDigest, transferDigestFromAuthHash, typedDataDigest } from '../src/core/eip712.js';
import { buildMetaTxApproveTypedData, buildPermitTypedData, buildTransferTypedData, TOKEN_AUTH_TYPE, TRANSFER_TYPE, transferDomain } from '../src/core/typedData.js';
import type { Address, Hex, TokenAuthorization, TransferRequest, TypedDataDomain } from '../src/core/types.js';
import { hashTransfer } from '../src/viem/hash.js';
import { ADDR, SAMPLE_PERMIT_AUTH, sampleRequest, TRANSFER_CONTRACT } from './helpers/fixtures.js';

interface VectorFile {
    chainId: number;
    verifyingContract: Address;
    typeHash: Hex;
    tokenAuthTypeHash: Hex;
    domainSeparator: Hex;
    transfers: Array<{ name: string; request: TransferRequest; authorization: TokenAuthorization; digest: Hex }>;
    tokenAuthorizations?: Array<{ name: string; kind: 'permit' | 'metaTxApprove'; domain: TypedDataDomain; message: Record<string, string>; digest: Hex }>;
}

const vectorsDir = fileURLToPath(new URL('../../contracts/test/vectors/data', import.meta.url));
const files = readdirSync(vectorsDir).filter((file) => file.endsWith('.json'));

/** Checks one vector file; returns the number of digests compared. */
function checkVectorFile(file: VectorFile): number {
    let compared = 0;
    expect(file.typeHash).toBe(keccak256(toBytes(TRANSFER_TYPE)));
    expect(file.tokenAuthTypeHash).toBe(keccak256(toBytes(TOKEN_AUTH_TYPE)));
    expect(file.domainSeparator).toBe(hashDomain(transferDomain(file.chainId, file.verifyingContract)));
    expect(file.transfers.length).toBeGreaterThan(0);
    for (const vector of file.transfers) {
        expect(transferDigest(file.chainId, file.verifyingContract, vector.request, vector.authorization), vector.name).toBe(vector.digest);
        expect(hashTransfer(file.chainId, file.verifyingContract, vector.request, vector.authorization), vector.name).toBe(vector.digest);
        // The id a relay reports with the request and the hash of its authorization.
        expect(transferDigestFromAuthHash(file.chainId, file.verifyingContract, vector.request, tokenAuthHash(vector.authorization)), vector.name).toBe(vector.digest);
        compared++;
    }
    for (const vector of file.tokenAuthorizations ?? []) {
        const m = vector.message;
        let typed: ReturnType<typeof buildPermitTypedData> | ReturnType<typeof buildMetaTxApproveTypedData>;
        if (vector.kind === 'permit') {
            typed = buildPermitTypedData({
                tokenDomain: vector.domain,
                owner: m.owner as Address,
                spender: m.spender as Address,
                value: m.value as string,
                nonce: m.nonce as string,
                deadline: m.deadline as string,
            });
        } else {
            const call = m.functionSignature as string;
            const metaTx = buildMetaTxApproveTypedData({
                tokenDomain: vector.domain,
                from: m.from as Address,
                spender: toChecksumAddress(`0x${call.slice(34, 74)}`),
                value: BigInt(`0x${call.slice(74)}`),
                nonce: m.nonce as string,
            });
            // The vector's calldata must be exactly what the SDK (and the contract) encode.
            expect(metaTx.message.functionSignature, vector.name).toBe(call.toLowerCase());
            typed = metaTx;
        }
        expect(typedDataDigest(typed), vector.name).toBe(vector.digest);
        expect(hashTypedData(typed as unknown as TypedDataDefinition), vector.name).toBe(vector.digest);
        compared++;
    }
    return compared;
}

describe('T30 golden vectors', () => {
    it.skipIf(files.length === 0)(`SDK digests equal the contract digests (${files.length} vector files)`, () => {
        for (const name of files) {
            const file = JSON.parse(readFileSync(path.join(vectorsDir, name), 'utf8')) as VectorFile;
            expect(checkVectorFile(file), name).toBeGreaterThan(0);
        }
    });

    it('the fixed golden vector of contracts/test/unit/Config.t.sol (test_T30_goldenVector)', () => {
        const contract: Address = '0x1000000000000000000000000000000000000001';
        const request: TransferRequest = {
            token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
            from: '0x2000000000000000000000000000000000000002',
            to: '0x3000000000000000000000000000000000000003',
            amount: '250000000',
            fee: '20000',
            relay: '0x4000000000000000000000000000000000000004',
            nonce: '7',
            deadline: '1790000000',
        };
        const authorization: TokenAuthorization = { mode: 'permit', v: 27, r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}` };
        const digest = '0x9648bc257717069e3c477bfa718892deaf7ac75c4466ae3aa80350922b621ab7';
        expect(hashDomain(transferDomain(137, contract))).toBe('0x03db845517913f4867fd5147fed3b13e71422ab18322688dcea57f997fe94623');
        expect(transferDigest(137, contract, request, authorization)).toBe(digest);
        expect(hashTransfer(137, contract, request, authorization)).toBe(digest);
        // The nonce and every field of the authorization are signed.
        expect(transferDigest(137, contract, { ...request, nonce: '8' }, authorization)).not.toBe(digest);
        for (const change of [{ mode: 'none' }, { mode: 'metaTxApprove' }, { v: 28 }, { r: `0x${'03'.repeat(32)}` }, { s: `0x${'03'.repeat(32)}` }] as const) {
            expect(transferDigest(137, contract, request, { ...authorization, ...change }), JSON.stringify(change)).not.toBe(digest);
        }
    });

    it('the checker accepts the documented format (self-test with viem-computed digests, not a golden vector)', () => {
        const request = sampleRequest();
        const permit = buildPermitTypedData({
            tokenDomain: { name: 'USD Coin', version: '2', chainId: 137, verifyingContract: request.token },
            owner: ADDR.user,
            spender: TRANSFER_CONTRACT,
            value: 1n,
            nonce: 0n,
            deadline: request.deadline,
        });
        const file: VectorFile = {
            chainId: 137,
            verifyingContract: TRANSFER_CONTRACT,
            typeHash: keccak256(toBytes(TRANSFER_TYPE)),
            tokenAuthTypeHash: keccak256(toBytes(TOKEN_AUTH_TYPE)),
            domainSeparator: hashDomain(transferDomain(137, TRANSFER_CONTRACT)),
            transfers: [
                {
                    name: 'sample',
                    request,
                    authorization: SAMPLE_PERMIT_AUTH,
                    digest: hashTypedData(buildTransferTypedData(137, TRANSFER_CONTRACT, request, SAMPLE_PERMIT_AUTH) as unknown as TypedDataDefinition),
                },
            ],
            tokenAuthorizations: [
                { name: 'permit', kind: 'permit', domain: permit.domain, message: permit.message, digest: hashTypedData(permit as unknown as TypedDataDefinition) },
            ],
        };
        expect(checkVectorFile(file)).toBe(2);
        const transfer = file.transfers[0] as VectorFile['transfers'][number];
        expect(() => checkVectorFile({ ...file, transfers: [{ ...transfer, request: { ...request, fee: '1' } }] })).toThrow();
        expect(() => checkVectorFile({ ...file, transfers: [{ ...transfer, authorization: { ...SAMPLE_PERMIT_AUTH, v: 28 } }] })).toThrow();
    });
});
