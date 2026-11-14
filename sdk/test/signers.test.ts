// The SDK's typed data signed with viem, ethers v5 (`_signTypedData`) and ethers v6
// gives byte-identical signatures (RFC 6979), and every signature recovers to the signer.

import { utils as ethers5Utils, Wallet as Ethers5Wallet } from 'ethers5';
import { verifyTypedData as ethers6Verify, Wallet as Ethers6Wallet } from 'ethers6';
import { describe, expect, it } from 'vitest';
import { getAddress, recoverTypedDataAddress, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MAX_UINT256 } from '../src/core/amounts.js';
import { POLYGON_USDC, POLYGON_USDT0 } from '../src/core/constants.js';
import { typedDataDigest } from '../src/core/eip712.js';
import { createTransferIntent, tokenAuthSigningPayload, transferSigningPayload } from '../src/core/intent.js';
import { normalizeSignature, splitSignature, toTokenAuthorization } from '../src/core/signature.js';
import { buildMetaTxApproveTypedData, buildPermitTypedData, buildTransferTypedData } from '../src/core/typedData.js';
import type { TokenAuthorization, TypedDataDomain, TypedDataField } from '../src/core/types.js';
import { ADDR, hex, KEYS, NONE_AUTH, NOW, polygonPins, prng, SAMPLE_PERMIT_AUTH, sampleRequest, TRANSFER_CONTRACT, USDT0 } from './helpers/fixtures.js';

interface Payload {
    domain: TypedDataDomain;
    types: Readonly<Record<string, readonly TypedDataField[]>>;
    primaryType: string;
    message: Record<string, unknown>;
}

const viemAccount = privateKeyToAccount(KEYS.user);
const ethers5Wallet = new Ethers5Wallet(KEYS.user);
const ethers6Wallet = new Ethers6Wallet(KEYS.user);

async function signAll(payload: Payload) {
    const types = payload.types as Record<string, TypedDataField[]>;
    return {
        viem: await viemAccount.signTypedData(payload as unknown as TypedDataDefinition),
        ethers5: await ethers5Wallet._signTypedData(payload.domain, types, payload.message),
        ethers6: await ethers6Wallet.signTypedData(payload.domain, types, payload.message),
    };
}

async function expectConsistent(payload: Payload): Promise<void> {
    const { viem, ethers5, ethers6 } = await signAll(payload);
    expect(ethers5).toBe(viem);
    expect(ethers6).toBe(viem);
    const types = payload.types as Record<string, TypedDataField[]>;
    expect(await recoverTypedDataAddress({ ...(payload as unknown as TypedDataDefinition), signature: viem })).toBe(ADDR.user);
    expect(ethers5Utils.verifyTypedData(payload.domain, types, payload.message, viem)).toBe(ADDR.user);
    expect(ethers6Verify(payload.domain, types, payload.message, viem)).toBe(ADDR.user);
    // The signature is in the form the contract, USDC and the relay require.
    expect(normalizeSignature(viem)).toBe(viem.toLowerCase());
    expect([27, 28]).toContain(splitSignature(viem).v);
    // And the core digest is the digest that was signed.
    expect(typedDataDigest(payload)).toBe(ethers5Utils._TypedDataEncoder.hash(payload.domain, types, payload.message));
}

describe('viem, ethers v5 and ethers v6 sign the SDK typed data identically', () => {
    const request = sampleRequest();

    it.each([
        ['GaslessTransfer on Polygon, mode none', buildTransferTypedData(137, TRANSFER_CONTRACT, request, NONE_AUTH)],
        ['GaslessTransfer on Polygon, permit', buildTransferTypedData(137, TRANSFER_CONTRACT, request, SAMPLE_PERMIT_AUTH)],
        ['GaslessTransfer on Amoy', buildTransferTypedData(80002, TRANSFER_CONTRACT, request, NONE_AUTH)],
        [
            'GaslessTransfer with extreme values',
            buildTransferTypedData(
                137,
                TRANSFER_CONTRACT,
                { ...request, amount: MAX_UINT256.toString(), fee: '0', deadline: MAX_UINT256.toString(), nonce: MAX_UINT256.toString() },
                { mode: 'metaTxApprove', v: 255, r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}` },
            ),
        ],
        [
            'USDC permit (chainId domain)',
            buildPermitTypedData({ tokenDomain: POLYGON_USDC.domain, owner: ADDR.user, spender: TRANSFER_CONTRACT, value: 10_050_000n, nonce: 0n, deadline: request.deadline }),
        ],
        [
            'USDT0 permit (salt domain)',
            buildPermitTypedData({ tokenDomain: POLYGON_USDT0.domain, owner: ADDR.user, spender: TRANSFER_CONTRACT, value: 10_050_000n, nonce: 12n, deadline: request.deadline }),
        ],
        [
            'USDT0 meta-tx approve (salt domain, bytes field)',
            buildMetaTxApproveTypedData({ tokenDomain: POLYGON_USDT0.domain, from: ADDR.user, spender: TRANSFER_CONTRACT, value: 10_050_000n, nonce: 12n }),
        ],
    ])('%s', async (_name, payload) => {
        await expectConsistent(payload as unknown as Payload);
    });

    it('for 20 random transfers with random token authorizations', async () => {
        const random = prng(7);
        const modes = ['none', 'permit', 'metaTxApprove'] as const;
        for (let i = 0; i < 20; i++) {
            const authorization: TokenAuthorization = { mode: modes[i % 3] as TokenAuthorization['mode'], v: random(1)[0] as number, r: hex(random(32)), s: hex(random(32)) };
            const payload = buildTransferTypedData(
                137,
                getAddress(hex(random(20))),
                {
                    token: getAddress(hex(random(20))),
                    from: ADDR.user,
                    to: getAddress(hex(random(20))),
                    amount: BigInt(hex(random(12))).toString(10),
                    fee: BigInt(hex(random(3))).toString(10),
                    relay: getAddress(hex(random(20))),
                    nonce: BigInt(hex(random(1 + (i % 32)))).toString(10),
                    deadline: String(NOW + i),
                },
                authorization,
            );
            await expectConsistent(payload as unknown as Payload);
        }
    });

    it('for the signing payloads of a validated intent: the token authorization first, then the transfer over its signature', async () => {
        const pins = polygonPins();
        const intent = createTransferIntent(
            pins,
            {
                token: USDT0,
                from: ADDR.user,
                to: ADDR.recipient,
                amount: 1n,
                fee: 10_000n,
                relay: ADDR.relay,
                authMode: 'metaTxApprove',
                deadline: NOW + 300,
                nonce: 3n,
                tokenNonce: 0n,
            },
            NOW,
            { allowMetaTxApprove: true },
        );
        const tokenAuth = tokenAuthSigningPayload(pins, intent, NOW) as NonNullable<ReturnType<typeof tokenAuthSigningPayload>>;
        await expectConsistent(tokenAuth as unknown as Payload);
        const authorization = toTokenAuthorization('metaTxApprove', (await signAll(tokenAuth as unknown as Payload)).viem);
        await expectConsistent(transferSigningPayload(pins, intent, authorization, NOW) as unknown as Payload);
    });
});
