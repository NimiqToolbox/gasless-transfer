// signPrepared and submitTransfer work on a snapshot of their validated input: a caller that changes the object
// while the wallet signs, or while the client talks to the relay, cannot change what is signed or sent.

import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type LocalAccount } from 'viem';
import { transferDigest } from '../../../src/core/eip712.js';
import { createTransferIntent, tokenAuthSigningPayload } from '../../../src/core/intent.js';
import { buildTransferTypedData } from '../../../src/core/typedData.js';
import { RelayClient } from '../../../src/relay/client.js';
import { infoFor } from '../../helpers/relay.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { signPrepared } from '../../../src/viem/sign.js';
import { toViemTypedData } from '../../../src/viem/typedData.js';
import { ADDR, polygonPins, sampleRequest, KEYS, NONE_AUTH, NOW, TRANSFER_CONTRACT, USDT0 } from '../../helpers/fixtures.js';

const pins = polygonPins();

describe('signing prompt snapshot', () => {
    it('signs and returns the validated request even if the caller changes it while the wallet signs (mode none)', async () => {
        const original = createTransferIntent(pins, { ...sampleRequest(), authMode: 'none' }, NOW);
        const mutable = JSON.parse(JSON.stringify(original));
        const account = privateKeyToAccount(KEYS.user);
        const signer = { ...account, async signTypedData(payload: Parameters<LocalAccount['signTypedData']>[0]) {
            mutable.request.amount = '1';
            mutable.request.nonce = '8';
            return account.signTypedData(payload);
        } } as LocalAccount;
        const signed = await signPrepared(signer, mutable, pins, { now: NOW });
        expect(signed.request).toEqual(original.request);
        expect(signed.id).toBe(transferDigest(137, TRANSFER_CONTRACT, original.request, NONE_AUTH));
    });

    it.each(['permit', 'metaTxApprove'] as const)('signs the intent over the %s authorization of the validated request, whatever the caller changes during the first prompt', async (authMode) => {
        const original = createTransferIntent(pins, {
            ...sampleRequest({ token: USDT0 }), authMode, tokenNonce: 0n,
        }, NOW, { allowMetaTxApprove: true });
        // Serialized input from another application is intentionally supported by signPrepared.
        const mutable = JSON.parse(JSON.stringify(original));
        const account = privateKeyToAccount(KEYS.user);
        const prompts: string[] = [];
        const signer = { ...account, async signTypedData(payload: Parameters<LocalAccount['signTypedData']>[0]) {
            prompts.push(String(payload.primaryType));
            if (prompts.length === 1) {
                mutable.authMode = 'none';
                mutable.tokenAuth = null;
                mutable.request.amount = '1';
                mutable.request.nonce = '8';
            }
            return account.signTypedData(payload);
        } } as LocalAccount;
        const signed = await signPrepared(signer, mutable, pins, { now: NOW });
        // The token authorization first, then the intent over it.
        expect(prompts).toEqual([authMode === 'permit' ? 'Permit' : 'MetaTransaction', 'GaslessTransfer']);
        expect(signed.request).toEqual(original.request);
        expect(signed.authorization.mode).toBe(authMode);
        expect(signed.authorization.r).toMatch(/^0x[0-9a-f]{64}$/);
        expect(signed.id).toBe(transferDigest(137, TRANSFER_CONTRACT, original.request, signed.authorization));
        // Both signatures are the user's, over the validated request and its token authorization.
        const tokenAuth = tokenAuthSigningPayload(pins, original, NOW);
        const tokenSignature = `0x${signed.authorization.r.slice(2)}${signed.authorization.s.slice(2)}${signed.authorization.v.toString(16)}` as const;
        expect(await recoverTypedDataAddress({ ...toViemTypedData(tokenAuth as NonNullable<typeof tokenAuth>), signature: tokenSignature })).toBe(ADDR.user);
        const transfer = buildTransferTypedData(137, TRANSFER_CONTRACT, original.request, signed.authorization);
        expect(await recoverTypedDataAddress({ ...toViemTypedData(transfer), signature: signed.signature })).toBe(ADDR.user);
    });
});


describe('submission envelope snapshot', () => {
    it('sends the validated body even if its caller changes it during relay discovery', async () => {
        const intent = createTransferIntent(pins, { ...sampleRequest(), authMode: 'none' }, NOW);
        const original = buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.user), intent, pins, { now: NOW }));
        const id = transferDigest(137, TRANSFER_CONTRACT, original.request, original.authorization);
        const mutable = JSON.parse(JSON.stringify(original));
        let posted: unknown;
        const relay = new RelayClient('https://relay.test', { pins, now: () => NOW, fetch: async (_url, init) => {
            if (init.method === 'GET') {
                mutable.request.amount = '1';
                mutable.signature = `0x${'00'.repeat(65)}`;
                mutable.authorization.mode = 'permit';
                mutable.authorization.v = 27;
                return new Response(JSON.stringify(infoFor(pins)));
            }
            posted = JSON.parse(String(init.body));
            return new Response(JSON.stringify({ id, status: 'queued' }), { status: 202 });
        } });
        await expect(relay.submitTransfer(mutable)).resolves.toEqual({ id, status: 'queued' });
        expect(posted).toEqual(original);
    });
});
