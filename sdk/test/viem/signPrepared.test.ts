// signPrepared at a signing boundary: an app that signs a transfer prepared by another application (the Keyguard
// pattern) enforces its own fee ceiling and refuses a META_TX approval, which never expires, before any wallet prompt.
// And what it throws when the wallet fails to sign the intent never holds the token signature made just before.

import { describe, expect, it } from 'vitest';
import { createWalletClient, http, type Hex, type LocalAccount, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTransferIntent } from '../../src/core/intent.js';
import type { AuthModeName } from '../../src/core/types.js';
import { signPrepared } from '../../src/viem/sign.js';
import { KEYS, NOW, polygonPins, sampleRequest, USDT0 } from '../helpers/fixtures.js';

const pins = polygonPins();
const account = privateKeyToAccount(KEYS.user);
// The fee of sampleRequest.
const FEE = 50_000n;

type TypedData = Parameters<LocalAccount['signTypedData']>[0];

/** A USDT0 transfer as another application prepared it, in the mode it chose. */
function prepared(authMode: AuthModeName) {
    return createTransferIntent(pins, { ...sampleRequest({ token: USDT0 }), authMode, tokenNonce: 0n }, NOW, { allowMetaTxApprove: true });
}

/** The user's account, recording the typed data of each wallet prompt; `onPrompt` runs before each signature. */
function wallet(onPrompt: (payload: TypedData) => void = () => {}) {
    const prompts: string[] = [];
    const signer = {
        ...account,
        async signTypedData(payload: TypedData) {
            prompts.push(String(payload.primaryType));
            onPrompt(payload);
            return account.signTypedData(payload);
        },
    } as LocalAccount;
    return { signer, prompts };
}

describe('signPrepared: maxAcceptableFee', () => {
    it('refuses a fee above the ceiling with fee_above_limit before anything is signed', async () => {
        const { signer, prompts } = wallet();
        await expect(signPrepared(signer, prepared('permit'), pins, { now: NOW, maxAcceptableFee: FEE - 1n })).rejects.toMatchObject({
            code: 'fee_above_limit',
            field: 'request.fee',
        });
        expect(prompts).toEqual([]);
    });

    it('signs a fee at the ceiling', async () => {
        const { signer, prompts } = wallet();
        const signed = await signPrepared(signer, prepared('permit'), pins, { now: NOW, maxAcceptableFee: FEE });
        expect(signed.request.fee).toBe(String(FEE));
        expect(prompts).toEqual(['Permit', 'GaslessTransfer']);
    });

    it('applies the ceiling again before the intent signature', async () => {
        // The ceiling is lowered while the wallet signs the token authorization: the validation before the intent
        // signature reads it too.
        const options = { now: NOW, maxAcceptableFee: FEE };
        const { signer, prompts } = wallet(() => {
            options.maxAcceptableFee = FEE - 1n;
        });
        await expect(signPrepared(signer, prepared('permit'), pins, options)).rejects.toMatchObject({ code: 'fee_above_limit' });
        expect(prompts).toEqual(['Permit']);
    });

    it('refuses a malformed ceiling before anything is signed', async () => {
        const { signer, prompts } = wallet();
        await expect(signPrepared(signer, prepared('permit'), pins, { now: NOW, maxAcceptableFee: '1.5' })).rejects.toMatchObject({ code: 'invalid_request' });
        expect(prompts).toEqual([]);
    });
});

describe('signPrepared: allowMetaTxApprove', () => {
    it('false refuses an intent of mode metaTxApprove with meta_tx_approve_not_allowed before anything is signed', async () => {
        const { signer, prompts } = wallet();
        await expect(signPrepared(signer, prepared('metaTxApprove'), pins, { now: NOW, allowMetaTxApprove: false })).rejects.toMatchObject({
            code: 'meta_tx_approve_not_allowed',
            field: 'authMode',
        });
        expect(prompts).toEqual([]);
    });

    it('false signs a permit', async () => {
        const { signer, prompts } = wallet();
        expect((await signPrepared(signer, prepared('permit'), pins, { now: NOW, allowMetaTxApprove: false })).authorization.mode).toBe('permit');
        expect(prompts).toEqual(['Permit', 'GaslessTransfer']);
    });

    it.each([{}, { allowMetaTxApprove: true }])('omitted or true (%o) signs the intent in its mode, at any fee', async (options) => {
        const { signer, prompts } = wallet();
        const signed = await signPrepared(signer, prepared('metaTxApprove'), pins, { now: NOW, ...options });
        expect(signed.authorization.mode).toBe('metaTxApprove');
        expect(prompts).toEqual(['MetaTransaction', 'GaslessTransfer']);
    });
});

// The intent's typed data holds the token signature (`auth`), and viem's transport errors quote the request they
// could not complete. A META_TX approval never expires, so the token signature must not leave signPrepared in an error.
describe('signPrepared: the wallet fails to sign the intent', () => {
    /** What an error and its causes show: their own fields, `message` and `stack`. */
    function shown(error: unknown): string {
        const parts: unknown[] = [];
        for (let e = error, depth = 0; typeof e === 'object' && e !== null && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
            const { message, stack } = e as { message?: unknown; stack?: unknown };
            parts.push({ ...e, message, stack });
        }
        return JSON.stringify(parts).toLowerCase();
    }

    /** r and s of a 65-byte signature, as hex digits. */
    const halves = (signature: Hex) => [signature.slice(2, 66), signature.slice(66, 130)] as const;

    /**
     * A WalletClient with a JSON-RPC account over viem's http transport. The wallet behind it signs the first request
     * (the token authorization) with the user's key and fails the second one (the intent). `seen` holds the token
     * signature and what the client threw.
     */
    function remoteWallet(failure: 'rejected' | 'http' | 'timeout') {
        const seen: { tokenSignature?: Hex; thrown?: unknown } = {};
        const fetchFn = async (_url: unknown, init?: RequestInit): Promise<Response> => {
            const { id, params } = JSON.parse(String(init?.body)) as { id: number; params: [string, string] };
            if (seen.tokenSignature === undefined) {
                seen.tokenSignature = await account.signTypedData(JSON.parse(params[1]) as TypedData);
                return Response.json({ jsonrpc: '2.0', id, result: seen.tokenSignature });
            }
            if (failure === 'rejected') return Response.json({ jsonrpc: '2.0', id, error: { code: 4001, message: 'User rejected the request.' } });
            if (failure === 'http') return new Response('bad gateway', { status: 502 });
            // No answer: the request ends with the abort of the transport's timeout, as fetch does.
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
            });
        };
        const client = createWalletClient({ account: account.address, transport: http('https://wallet.invalid', { fetchFn, retryCount: 0, timeout: 50 }) });
        const signer = {
            account: client.account,
            async signTypedData(args: Parameters<typeof client.signTypedData>[0]) {
                try {
                    return await client.signTypedData(args);
                } catch (error) {
                    seen.thrown = error;
                    throw error;
                }
            },
        } as unknown as WalletClient;
        return { signer, seen };
    }

    it.each([
        ['the wallet rejects the request', 'rejected', { name: 'UserRejectedRequestError', code: 4001 }],
        ['the HTTP request fails', 'http', { name: 'HttpRequestError', status: 502 }],
        ['the request times out', 'timeout', { name: 'TimeoutError' }],
    ] as const)("%s: the wallet client's own error, without the token signature", async (_name, failure, expected) => {
        const { signer, seen } = remoteWallet(failure);
        const error: unknown = await signPrepared(signer, prepared('metaTxApprove'), pins, { now: NOW }).catch((e: unknown) => e);
        expect(error).toBe(seen.thrown);
        expect(error).toMatchObject(expected);
        const [r, s] = halves(seen.tokenSignature as Hex);
        // The error still names the request it could not complete.
        expect(shown(error)).toContain('eth_signtypeddata_v4');
        expect(shown(error)).not.toContain(r);
        expect(shown(error)).not.toContain(s);
    });

    it.each([
        ['a frozen error', (quote: string): unknown => Object.freeze(new Error(`cannot sign ${quote}`))],
        ['a string', (quote: string): unknown => `cannot sign ${quote}`],
    ])('%s that quotes the request cannot be cleared: it is withheld (signing_failed)', async (_name, failure) => {
        let auth = { r: '', s: '' };
        const { signer } = wallet((payload) => {
            if (payload.primaryType !== 'GaslessTransfer') return;
            auth = (payload.message as { auth: { r: Hex; s: Hex } }).auth;
            throw failure(JSON.stringify(payload.message));
        });
        const error: unknown = await signPrepared(signer, prepared('metaTxApprove'), pins, { now: NOW }).catch((e: unknown) => e);
        expect(error).toMatchObject({ name: 'GaslessError', code: 'signing_failed' });
        expect((error as Error).cause).toBeUndefined();
        expect(auth.r).toMatch(/^0x[0-9a-f]{64}$/);
        expect(shown(error)).not.toContain(auth.r.slice(2));
        expect(shown(error)).not.toContain(auth.s.slice(2));
    });

    it('mode "none" has no token signature: the error is thrown as it is', async () => {
        let thrown: Error | undefined;
        const { signer } = wallet((payload) => {
            thrown = new Error(`cannot sign ${JSON.stringify(payload.message)}`);
            throw thrown;
        });
        const error: unknown = await signPrepared(signer, prepared('none'), pins, { now: NOW }).catch((e: unknown) => e);
        expect(error).toBe(thrown);
        // The zero r and s of mode "none" are no signature and stay.
        expect((error as Error).message).toContain(`"r":"0x${'00'.repeat(32)}"`);
    });
});
