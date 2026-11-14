// Every relay error code, produced against the real contract and the real token state on anvil, with
// the HTTP status of the frozen ERROR_HTTP_STATUS and the {error: {code, message}} body the SDK parses.
// internal_error has no legitimate trigger through the API; the HTTP unit tests cover it.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
    NO_TOKEN_AUTHORIZATION,
    buildSubmitTransferBody,
    createTransferIntent,
    gaslessTransferAbi,
    usdcAbi,
    type TokenAuthorization,
    type TransferRequest,
} from '@nimiq/gasless-sdk/core';
import { ERROR_HTTP_STATUS, type ErrorCode } from '@nimiq/gasless-sdk/relay';
import { signPrepared } from '@nimiq/gasless-sdk/viem';
import { postRaw, signRawRequest, signTransfer, startRelay, type RunningRelay } from './helpers/relay.js';
import { ADMIN_INDEX, RELAY_INDEX, anvilAccount, mockTokenAbi, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;
/** A second relay whose transaction manager never runs: its requests stay queued (conflict, sender_busy). */
let idle: RunningRelay;

beforeAll(async () => {
    stack = await startStack();
    // No fee cache: the unavailable test must not be answered from a cached gas price. No token domain
    // monitor: the changeName test below exercises the step-8 path (simulation_failed) of a rename the
    // relay has not noticed yet; the monitor has its own test (tokenDomain.test.ts).
    const env = { RELAY_TOKEN_DOMAIN_CHECK_SECONDS: '0' };
    relay = await startRelay(stack, { env: { ...env, RELAY_RPC_TIMEOUT_MS: '1000', RELAY_FEE_CACHE_MS: '0' } });
    // Started with a temporary key file: a copy that startup deletes (see the startup test below).
    idle = await startRelay(stack, { accountIndex: 12, env: { ...env, RELAY_PRIVATE_KEY_FILE_REMOVE: 'true' } });
    await idle.server.relay.txManager.stop();
});

afterAll(async () => {
    await relay?.stop();
    await idle?.stop();
    await stack?.stop();
});

const admin = anvilAccount(ADMIN_INDEX);
const TO: Address = anvilAccount(11).address;
const now = () => Math.floor(Date.now() / 1000);

async function expectApiError(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
    await expect(promise).rejects.toMatchObject({ name: 'RelayApiError', code, status: ERROR_HTTP_STATUS[code] });
}

async function expectRawError(target: RunningRelay, body: unknown, code: ErrorCode): Promise<void> {
    const res = await postRaw(target, body);
    expect(res).toEqual({ status: ERROR_HTTP_STATUS[code], json: { error: { code, message: expect.any(String) } } });
}

/**
 * A body the SDK refuses to build (policy violations): signed with viem directly, over the token authorization
 * (default mode none). The intent nonce defaults to 0: no sender of these bodies has used a nonce.
 */
async function rawBody(
    overrides: Partial<TransferRequest> = {},
    options: { from?: number; signer?: number; authorization?: TokenAuthorization } = {},
): Promise<{ request: TransferRequest; signature: Hex; authorization: TokenAuthorization }> {
    const account = anvilAccount(options.from ?? 1);
    const request: TransferRequest = {
        token: stack.usdc,
        from: account.address,
        to: TO,
        amount: '1000000',
        fee: '10000',
        relay: relay.address,
        nonce: '0',
        deadline: String(now() + 600),
        ...overrides,
    };
    const authorization = options.authorization ?? NO_TOKEN_AUTHORIZATION;
    const signature = await signRawRequest(anvilAccount(options.signer ?? options.from ?? 1), stack.transfer, request, authorization);
    return { request, signature, authorization };
}

describe('T31: 400', () => {
    it('invalid_request: schema, unknown fields, no client-supplied calldata or target', async () => {
        await expectRawError(relay, { request: 1 }, 'invalid_request');
        const body = await rawBody();
        await expectRawError(relay, { ...body, data: '0x12345678' }, 'invalid_request');
        await expectRawError(relay, { ...body, request: { ...body.request, target: stack.transfer } }, 'invalid_request');
        await expectRawError(relay, { ...body, request: { ...body.request, amount: '01000000' } }, 'invalid_request');
    });

    it('unsupported_operation', async () => {
        const res = await fetch(`${relay.url}/v1/fee?operation=other&token=${stack.usdc}&authMode=permit`);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: { code: 'unsupported_operation', message: expect.any(String) } });
    });

    it('wrong_relay: signed for another relay', async () => {
        await expectRawError(relay, await rawBody({ relay: idle.address }), 'wrong_relay');
    });

    it('unsupported_token', async () => {
        await expectRawError(relay, await rawBody({ token: anvilAccount(17).address }), 'unsupported_token');
    });

    it('unsupported_auth_mode: USDC has no meta-transactions', async () => {
        const authorization = { mode: 'metaTxApprove' as const, v: 27, r: `0x${'11'.repeat(32)}` as Hex, s: `0x${'22'.repeat(32)}` as Hex };
        await expectRawError(relay, await rawBody({}, { authorization }), 'unsupported_auth_mode');
    });

    it('invalid_amount', async () => {
        await expectRawError(relay, await rawBody({ amount: '0' }), 'invalid_amount');
    });

    it('invalid_recipient: zero address, the tokens, the contract (D11)', async () => {
        for (const to of ['0x0000000000000000000000000000000000000000', stack.usdc, stack.usdt0, stack.transfer] as Address[]) {
            await expectRawError(relay, await rawBody({ to }), 'invalid_recipient');
        }
    });

    it('deadline_out_of_range', async () => {
        await expectRawError(relay, await rawBody({ deadline: String(now() + 30) }), 'deadline_out_of_range');
        await expectRawError(relay, await rawBody({ deadline: String(now() + 7300) }), 'deadline_out_of_range');
    });

    // What the owner can change is a token's modes, which startup compares with the deployment record.
    it("unsupported_auth_mode: the owner disables USDC's existing-allowance mode (setTokenConfig); startup refuses the old record, a relay on the new one refuses the mode", async () => {
        const config = await stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'tokenConfig', args: [stack.usdc] });
        expect(config).toEqual({ permit: true, metaTxApprove: false, allowance: true });
        await stack.send(admin, { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'setTokenConfig', args: [stack.usdc, { ...config, allowance: false }] });
        let restarted: RunningRelay | undefined;
        try {
            // The deployment record names the old modes: startup fails closed.
            await expect(startRelay(stack, { accountIndex: 19 })).rejects.toThrow(
                /USDC: tokenConfig on-chain \(permit true, metaTxApprove false, allowance false\) does not match authModes \["permit","none"\]/,
            );
            const json = structuredClone(stack.deploymentJson) as { tokens: Array<{ symbol: string; authModes: string[] }> };
            json.tokens.find((t) => t.symbol === 'USDC')!.authModes = ['permit'];
            const file = join(stack.dir, 'deployment-modes.json');
            writeFileSync(file, JSON.stringify(json));
            restarted = await startRelay(stack, { accountIndex: 18, env: { RELAY_DEPLOYMENT_FILE: file } });
            // Raw: the SDK client compares /v1/info with its pins, which name the old modes.
            const info = (await (await fetch(`${restarted.url}/v1/info`)).json()) as { tokens: Array<{ symbol: string; authModes: string[] }> };
            expect(info.tokens.map((t) => [t.symbol, t.authModes])).toEqual([
                ['USDC', ['permit']],
                ['USDT0', ['permit', 'metaTxApprove', 'none']],
            ]);
            await expectRawError(restarted, await rawBody({ relay: restarted.address }), 'unsupported_auth_mode');
            // USDT0 keeps the mode: not refused for it.
            const usdt0 = await postRaw(restarted, await rawBody({ relay: restarted.address, token: stack.usdt0 }, { from: 3 }));
            expect(usdt0.json).not.toMatchObject({ error: { code: 'unsupported_auth_mode' } });
        } finally {
            await restarted?.stop();
            await stack.send(admin, { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'setTokenConfig', args: [stack.usdc, config] });
        }
    });

    it('invalid_signature: signed by another key', async () => {
        await expectRawError(relay, await rawBody({}, { from: 1, signer: 2 }), 'invalid_signature');
    });

    it('invalid_token_authorization: a permit signed for another token nonce', async () => {
        const from = anvilAccount(1).address;
        const live = await stack.publicClient.readContract({ address: stack.usdc, abi: usdcAbi, functionName: 'nonces', args: [from] });
        const intent = createTransferIntent(
            relay.pins,
            { token: stack.usdc, from, to: TO, amount: 1_000_000n, fee: 10_000n, relay: relay.address, authMode: 'permit', deadline: now() + 600, nonce: 0n, tokenNonce: live + 1n },
            now(),
        );
        const signed = await signPrepared(anvilAccount(1), intent, relay.pins);
        const body = buildSubmitTransferBody({ request: signed.request, signature: signed.signature, authorization: signed.authorization });
        await expectApiError(relay.client.submitTransfer(body), 'invalid_token_authorization');
    });
});

describe('T31: 402, 404', () => {
    it('fee_too_low: a fee below break-even is refused although it is signed', async () => {
        const t = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n, fee: 0n });
        await expectApiError(relay.client.submitTransfer(t.body), 'fee_too_low');
    });

    it('not_found', async () => {
        await expectApiError(relay.client.getRequest(`0x${'ab'.repeat(32)}`), 'not_found');
    });
});

describe('T31: 409', () => {
    it('nonce_used: the sender invalidated the nonce on-chain', async () => {
        // invalidateNonces(3) raises the sender's next nonce from 0 to 3: nonces 0 to 2 can never execute.
        await stack.send(anvilAccount(4), { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [3n] });
        // A body for an invalidated nonce, built with the core (prepareTransfer refuses a nonce without corrects).
        for (const nonce of [0n, 2n]) {
            const t = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n, nonce });
            await expectApiError(relay.client.submitTransfer(t.body), 'nonce_used');
        }
    });

    it('nonce_too_high: a nonce above the sender\'s next one', async () => {
        const t = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n, nonce: 4n });
        await expectApiError(relay.client.submitTransfer(t.body), 'nonce_too_high');
    });

    it('conflict (a correction of a queued request: the same intent nonce, another amount), nonce_too_high, and sender_busy while a request is queued', async () => {
        const a = await signTransfer(stack, idle, { from: 5, token: stack.usdt0, authMode: 'permit', to: TO, amount: 1_000_000n });
        expect(await idle.client.submitTransfer(a.body)).toEqual({ id: a.id, status: 'queued' });
        const sameNonce = await signTransfer(stack, idle, { from: 5, token: stack.usdt0, authMode: 'permit', to: TO, amount: 2_000_000n, corrects: a.body.request });
        expect(sameNonce.body.request.nonce).toBe(a.body.request.nonce);
        await expectApiError(idle.client.submitTransfer(sameNonce.body), 'conflict');
        // The following nonce could execute only after the queued request.
        const following = BigInt(a.body.request.nonce) + 1n;
        const next = await signTransfer(stack, idle, { from: 5, token: stack.usdt0, authMode: 'metaTxApprove', to: TO, amount: 3_000_000n, nonce: following });
        await expectApiError(idle.client.submitTransfer(next.body), 'nonce_too_high');
        // The sender raises its nonce on-chain past the queued request: `next` has the sender's next nonce now, but the
        // relay keeps one pending request per sender until the queued one has settled.
        await stack.send(anvilAccount(5), { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [following] });
        await expectApiError(idle.client.submitTransfer(next.body), 'sender_busy');
    });
});

describe('T31: 422', () => {
    it('insufficient_balance', async () => {
        const t = await signTransfer(stack, relay, { from: 13, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n });
        await expectApiError(relay.client.submitTransfer(t.body), 'insufficient_balance');
    });

    it('insufficient_allowance: NONE mode without an approval', async () => {
        const t = await signTransfer(stack, relay, { from: 3, token: stack.usdt0, authMode: 'none', to: TO, amount: 1_000_000n });
        await expectApiError(relay.client.submitTransfer(t.body), 'insufficient_allowance');
    });

    it('token_paused: USDC paused by its admin', async () => {
        const t = await signTransfer(stack, relay, { from: 6, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n });
        await stack.send(admin, { address: stack.usdc, abi: mockTokenAbi, functionName: 'pause' });
        try {
            await expectApiError(relay.client.submitTransfer(t.body), 'token_paused');
        } finally {
            await stack.send(admin, { address: stack.usdc, abi: mockTokenAbi, functionName: 'unpause' });
        }
    });

    it('blocked_address: USDC-blacklisted recipient, USDT0-blocked sender', async () => {
        const usdc = await signTransfer(stack, relay, { from: 6, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n });
        await stack.send(admin, { address: stack.usdc, abi: mockTokenAbi, functionName: 'blacklist', args: [TO] });
        try {
            await expectApiError(relay.client.submitTransfer(usdc.body), 'blocked_address');
        } finally {
            await stack.send(admin, { address: stack.usdc, abi: mockTokenAbi, functionName: 'unBlacklist', args: [TO] });
        }
        const sender = anvilAccount(7).address;
        const usdt0 = await signTransfer(stack, relay, { from: 7, token: stack.usdt0, authMode: 'permit', to: TO, amount: 1_000_000n });
        await stack.send(admin, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'addToBlockedList', args: [sender] });
        try {
            await expectApiError(relay.client.submitTransfer(usdt0.body), 'blocked_address');
        } finally {
            await stack.send(admin, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'removeFromBlockedList', args: [sender] });
        }
    });

    it('simulation_failed: the USDT0 domain changed after signing (changeName), decoded as InsufficientAllowance', async () => {
        const t = await signTransfer(stack, relay, { from: 8, token: stack.usdt0, authMode: 'permit', to: TO, amount: 1_000_000n });
        await stack.send(admin, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'changeName', args: ['USDT0 renamed'] });
        try {
            // Step 7 checks the permit against the configured domain; the token rejects it in the
            // simulation, the contract catches that and reverts on the missing allowance.
            const error = await relay.client.submitTransfer(t.body).catch((e: unknown) => e);
            expect(error).toMatchObject({ name: 'RelayApiError', code: 'simulation_failed', status: 422 });
            expect((error as Error).message).toContain('InsufficientAllowance(0, ');
        } finally {
            await stack.send(admin, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'changeName', args: ['USDT0'] });
        }
        // Restored: the same signed request now goes through.
        expect(await relay.client.submitTransfer(t.body)).toEqual({ id: t.id, status: 'queued' });
        expect((await relay.client.waitForRequest(t.id, { timeoutMs: 30_000, pollIntervalMs: 100 })).status).toBe('mined');
    });
});

describe('startup', () => {
    it('RELAY_PRIVATE_KEY_FILE_REMOVE: the key file is gone once startup has read it; otherwise it stays', async () => {
        // relayEnv writes relay-<account index>.key into the stack directory.
        expect(existsSync(join(stack.dir, `relay-${RELAY_INDEX}.key`))).toBe(true);
        expect(existsSync(join(stack.dir, 'relay-12.key'))).toBe(false);
        // The relay kept the key it read: it still answers for its own address.
        expect((await idle.client.info()).relay).toBe(idle.address);
    });
});

describe('429, 503', () => {
    it('T36: unavailable: the relay-wide limit of submissions that read the chain, and no per-address limit', async () => {
        const limited = await startRelay(stack, { accountIndex: 14, env: { RELAY_RATE_LIMIT_SUBMIT_MAX: '1' } });
        try {
            // No limit keys on the client's address: many requests from one address all get through.
            for (let i = 0; i < 20; i += 1) await limited.client.info();
            // Senders 13 and 15 hold no tokens: each submission reads the chain and ends insufficient_balance.
            const first = await signTransfer(stack, limited, { from: 13, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n });
            const second = await signTransfer(stack, limited, { from: 15, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n });
            // A bad signature is refused before the limit and does not use it up.
            // (the signature of another intent: well-formed, but it does not recover to this request's sender).
            const forged = await postRaw(limited, { ...second.body, signature: first.body.signature });
            expect(forged).toMatchObject({ status: 400, json: { error: { code: 'invalid_signature' } } });
            await expectApiError(limited.client.submitTransfer(first.body), 'insufficient_balance');
            await expectApiError(limited.client.submitTransfer(second.body), 'unavailable');
        } finally {
            await limited.stop();
        }
    });

    // Stops the chain: keep it last in this file.
    it('T31: unavailable: the chain cannot be reached', async () => {
        const t = await signTransfer(stack, relay, { from: 9, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n });
        await stack.stopChain();
        await expectApiError(relay.client.fee({ token: stack.usdc, authMode: 'permit' }), 'unavailable');
        await expectApiError(relay.client.submitTransfer(t.body), 'unavailable');
        expect(relay.server.store.getRequest(t.id)).toBeUndefined();
        const ready = await fetch(`${relay.url}/readyz`);
        expect(ready.status).toBe(503);
    });
});
