// The relay against the SDK's strict RelayClient, over real HTTP on 127.0.0.1 (fake chain). The client
// refuses anything that deviates from the frozen wire format (sdk/src/relay/types.ts) and the pins;
// each point it checks is also asserted explicitly on the raw responses.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
    CHAINLINK_POL_USD_POLYGON,
    FEE_GRANULARITY,
    buildSubmitTransferBody,
    chainIdSalt,
    createTransferIntent,
    isCanonicalUint256,
    pinsFromDeployment,
    transferDigest,
    type AuthModeName,
    type ChainPins,
} from '@nimiq/gasless-sdk/core';
import {
    ERROR_HTTP_STATUS,
    RelayApiError,
    RelayClient,
    RelayRequestFailedError,
    type FeeResponse,
    type InfoResponse,
    type SubmitTransferBody,
} from '@nimiq/gasless-sdk/relay';
import { signPrepared } from '@nimiq/gasless-sdk/viem';
import { ChainlinkPriceSource } from '../../src/fees/priceSource.js';
import { CONTRACT, USDC, USDT0, ZERO_WORD as ZERO_BYTES32, createHarness, deploymentJson, fundedSender, type Harness, type HarnessOptions } from '../helpers/harness.js';
import { RECIPIENT_ADDRESS, RELAY_ADDRESS, USER_ADDRESS, USER_KEY } from '../helpers/keys.js';

const DECIMAL_NUMBER_RE = /^[0-9]{1,20}(\.[0-9]{1,20})?$/;
const MODES: ReadonlyArray<readonly [Address, AuthModeName]> = [
    [USDC, 'permit'],
    [USDC, 'none'],
    [USDT0, 'permit'],
    [USDT0, 'metaTxApprove'],
    [USDT0, 'none'],
];

let h: Harness;
let base: string;
let pins: ChainPins;
let client: RelayClient;

async function start(options: HarnessOptions = {}): Promise<void> {
    h = await createHarness(options);
    base = await h.relay.app.listen({ host: '127.0.0.1', port: 0 });
    pins = pinsFromDeployment(deploymentJson(), { relays: [RELAY_ADDRESS] });
    client = new RelayClient(base, { pins, now: () => h.clock.seconds() });
}

beforeEach(async () => {
    await start();
});

afterEach(async () => {
    await h.close();
});

async function raw(path: string, init: RequestInit = {}): Promise<{ status: number; json: unknown; location: string | null }> {
    const res = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
    const text = await res.text();
    return { status: res.status, json: text === '' ? undefined : (JSON.parse(text) as unknown), location: res.headers.get('location') };
}

/**
 * A body built and signed only with SDK functions, as a wallet would (viem signer), at the sender's next intent nonce
 * (`nonces(from)`). `key`: the sender (USER by default).
 */
async function sdkBody(token: Address, authMode: AuthModeName, quote?: FeeResponse, key: Hex = USER_KEY): Promise<SubmitTransferBody> {
    const now = h.clock.seconds();
    const from = privateKeyToAccount(key).address;
    if (authMode === 'none') h.chain.setAllowance(token, from, CONTRACT, 10n ** 12n);
    const intent = createTransferIntent(
        pins,
        {
            token,
            from,
            to: RECIPIENT_ADDRESS,
            amount: 1_000_000n,
            fee: quote?.fee ?? '10000',
            relay: quote?.relay ?? RELAY_ADDRESS,
            nonce: h.chain.intentNonce(from),
            authMode,
            deadline: now + 600,
            ...(authMode === 'none' ? {} : { tokenNonce: h.chain.token(token).nonces.get(from.toLowerCase()) ?? 0n }),
        },
        now,
        // The SDK builds META_TX_APPROVE for a token with permit only when asked to (spec §5).
        { allowMetaTxApprove: authMode === 'metaTxApprove' },
    );
    const signed = await signPrepared(privateKeyToAccount(key), intent, pins, { now });
    return buildSubmitTransferBody({
        request: signed.request,
        signature: signed.signature,
        authorization: signed.authorization,
        ...(quote ? { quoteId: quote.quoteId } : {}),
    });
}

describe('GET /v1/info', () => {
    it('passes RelayClient.info() (verified against pins from the deployment file)', async () => {
        const info = await client.info();
        expect(info.relay).toBe(RELAY_ADDRESS);
        expect(info.chainId).toBe(137);
    });

    it('has exactly the fields the client expects, token domains with only their own fields, no salt on the contract', async () => {
        const { status, json } = await raw('/v1/info');
        expect(status).toBe(200);
        const info = json as InfoResponse;
        expect(Object.keys(info).sort()).toEqual(['chainId', 'contracts', 'policy', 'relay', 'tokens', 'version']);
        expect(info.contracts.transfer).toEqual({
            address: CONTRACT,
            domain: { name: 'Nimiq Gasless Transfer', version: '3', chainId: 137, verifyingContract: CONTRACT },
        });
        expect(info.tokens.map((t) => t.symbol)).toEqual(['USDC', 'USDT0']);
        for (const token of info.tokens) {
            expect(Object.keys(token).sort()).toEqual(['address', 'authModes', 'decimals', 'symbol', 'tokenDomain']);
            expect(token.decimals).toBe(6);
            expect(new Set(token.authModes).size).toBe(token.authModes.length);
            expect(token.authModes).toEqual(pins.tokens.find((t) => t.address === token.address)!.authModes);
        }
        expect(info.tokens[0]!.tokenDomain).toEqual({ name: 'USD Coin', version: '2', chainId: 137, verifyingContract: USDC });
        expect(Object.keys(info.tokens[0]!.tokenDomain)).toEqual(['name', 'version', 'chainId', 'verifyingContract']);
        expect(info.tokens[1]!.tokenDomain).toEqual({ name: 'USDT0', version: '1', verifyingContract: USDT0, salt: chainIdSalt(137) });
        expect(Object.keys(info.tokens[1]!.tokenDomain)).toEqual(['name', 'version', 'verifyingContract', 'salt']);
        const { minDeadlineSeconds, maxDeadlineSeconds, quoteTtlSeconds } = info.policy;
        for (const n of [minDeadlineSeconds, maxDeadlineSeconds, quoteTtlSeconds]) expect(Number.isSafeInteger(n) && n >= 1).toBe(true);
        expect(minDeadlineSeconds).toBeLessThanOrEqual(maxDeadlineSeconds);
    });
});

describe('GET /v1/fee', () => {
    it.each(MODES)('passes RelayClient.fee() for %s / %s and meets every wire rule', async (token, authMode) => {
        const quote = await client.fee({ token, authMode });
        const { status, json } = await raw(`/v1/fee?operation=transfer&token=${token}&authMode=${authMode}`);
        expect(status).toBe(200);
        for (const q of [quote, json as FeeResponse]) {
            expect(q.operation).toBe('transfer');
            expect(q.token).toBe(token);
            expect(q.authMode).toBe(authMode);
            expect(q.relay).toBe((await client.info()).relay);
            for (const v of [q.fee, q.gasUnits, q.gasPrice]) expect(isCanonicalUint256(v)).toBe(true);
            expect(BigInt(q.fee) % BigInt(FEE_GRANULARITY)).toBe(0n);
            expect(q.polUsd).toMatch(DECIMAL_NUMBER_RE);
            expect(Number.isSafeInteger(q.issuedAt) && Number.isSafeInteger(q.expiresAt)).toBe(true);
            expect(q.issuedAt).toBeLessThanOrEqual(q.expiresAt);
            expect(q.quoteId.length).toBeGreaterThan(0);
            expect(q.quoteId.length).toBeLessThanOrEqual(256);
        }
    });

    it('formats polUsd within 20 fractional digits for an 18-decimal Chainlink feed', async () => {
        await h.close();
        await start({
            priceSource: ({ chain, clock, metrics }) =>
                new ChainlinkPriceSource({ chain, feed: CHAINLINK_POL_USD_POLYGON, clock, cacheMs: 0, metrics }),
        });
        h.chain.feed = {
            address: CHAINLINK_POL_USD_POLYGON,
            decimals: 18,
            answer: 123_456_789_012_345_678n,
            updatedAt: BigInt(h.clock.seconds()),
            description: 'POL / USD',
        };
        const quote = await client.fee({ token: USDC, authMode: 'permit' });
        expect(quote.polUsd).toBe('0.123456789012345678');
        expect(quote.polUsd).toMatch(DECIMAL_NUMBER_RE);
    });
});

describe('POST /v1/transfer', () => {
    it.each(MODES)('accepts an SDK-built %s / %s body with its quoteId: 202, then 200; id == hashTransfer', async (token, authMode) => {
        const quote = await client.fee({ token, authMode });
        const body = await sdkBody(token, authMode, quote);
        // What the SDK sends: checksummed addresses, canonical decimals (the intent nonce too), a signature with v
        // 27/28, and the signed token authorization: {mode:'none', v:0, r:0, s:0} or {mode, v, r, s} with v 27/28.
        expect(body.request.nonce).toBe(h.chain.intentNonce(USER_ADDRESS).toString());
        expect(isCanonicalUint256(body.request.nonce)).toBe(true);
        expect(body.signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/);
        if (authMode === 'none') expect(body.authorization).toEqual({ mode: 'none', v: 0, r: ZERO_BYTES32, s: ZERO_BYTES32 });
        else expect([27, 28]).toContain(body.authorization.v);

        const expectedId = transferDigest(pins.chainId, pins.transfer.address, body.request, body.authorization);
        const first = await raw('/v1/transfer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(first).toMatchObject({ status: 202, json: { id: expectedId, status: 'queued' } });
        expect(await client.submitTransfer(body)).toEqual({ id: expectedId, status: 'queued' }); // identical re-post: 200
        const again = await raw('/v1/transfer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(again).toMatchObject({ status: 200, json: { id: expectedId, status: 'queued' } });
    });

    it('accepts a quoteId of up to 256 characters, and no quoteId at all', async () => {
        const body = await sdkBody(USDC, 'none');
        expect((await client.submitTransfer({ ...body, quoteId: 'q'.repeat(256) })).status).toBe('queued');
        const other = await sdkBody(USDT0, 'none', undefined, fundedSender(h.chain, 1).key); // one pending request per sender
        expect((await client.submitTransfer(other)).status).toBe('queued');
    });
});

describe('GET /v1/requests/:id', () => {
    it('accepts lowercase and uppercase ids; the request has exactly the 8 signed fields (7 and the intent nonce)', async () => {
        const body = await sdkBody(USDC, 'permit');
        const { id } = await client.submitTransfer(body);
        expect(id).toBe(id.toLowerCase());
        const state = await client.getRequest(id);
        expect(state.status).toBe('queued');
        for (const path of [id, `0x${id.slice(2).toUpperCase()}`]) {
            const { status, json } = await raw(`/v1/requests/${path}`);
            expect(status).toBe(200);
            const s = json as { id: Hex; request: Record<string, unknown> };
            expect(s.id).toBe(id);
            expect(Object.keys(s.request).sort()).toEqual(['amount', 'deadline', 'fee', 'from', 'nonce', 'relay', 'to', 'token']);
            expect(s.request).toEqual(body.request);
        }
    });

    it('reports transactions as {hash, txNonce, maxFeePerGas, status} through a speed-up to mined', async () => {
        await h.relay.txManager.recover();
        const { id } = await client.submitTransfer(await sdkBody(USDC, 'permit'));
        h.chain.includeFilter = () => false;
        await h.relay.txManager.tick();
        h.chain.mineBlocks(10);
        await h.relay.txManager.tick(); // speed-up
        h.chain.includeFilter = () => true;
        h.chain.mine();
        await h.relay.txManager.tick();
        const state = await client.waitForRequest(id, { timeoutMs: 5_000, pollIntervalMs: 50 });
        expect(state.status).toBe('mined');
        expect(state.transactions).toHaveLength(2);
        for (const tx of state.transactions) {
            expect(Object.keys(tx).sort()).toEqual(['hash', 'maxFeePerGas', 'status', 'txNonce']);
            expect(Number.isSafeInteger(tx.txNonce)).toBe(true);
            expect(isCanonicalUint256(tx.maxFeePerGas)).toBe(true);
        }
        expect(state.transactions.map((t) => t.status)).toEqual(['replaced', 'mined']);
        expect(state.txHash).toBe(state.transactions[1]!.hash);
        expect(state.blockNumber).toBe(h.chain.head.number.toString());
    });

    it('ends as a RelayRequestFailedError with a known error code when the request fails', async () => {
        await h.relay.txManager.recover();
        const body = await sdkBody(USDC, 'permit');
        const { id } = await client.submitTransfer(body);
        h.chain.invalidateNonces(USER_ADDRESS, BigInt(body.request.nonce) + 1n);
        await h.relay.txManager.tick();
        const error = await client.waitForRequest(id, { timeoutMs: 5_000, pollIntervalMs: 50 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RelayRequestFailedError);
        expect((error as RelayRequestFailedError).relayCode).toBe('nonce_used');
        expect(Object.keys(ERROR_HTTP_STATUS)).toContain((error as RelayRequestFailedError).state.error?.code);
    });
});

describe('errors and redirects', () => {
    it('answers errors as {error: {code, message}} with a known code, which the client surfaces as RelayApiError', async () => {
        const unknown = `0x${'ab'.repeat(32)}` as Hex;
        const error = await client.getRequest(unknown).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RelayApiError);
        expect(error).toMatchObject({ code: 'not_found', status: 404 });
        const res = await raw('/v1/transfer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"request":1}' });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } });
    });

    it('never redirects (trailing slashes, doubled slashes, unknown paths)', async () => {
        const { id } = await client.submitTransfer(await sdkBody(USDC, 'none'));
        for (const path of ['/v1/info/', '//v1/info', `/v1/requests/${id}/`, '/v1', '/v1/', '/', '/v1/fee/']) {
            const res = await raw(path);
            expect(res.status, path).toBe(404);
            expect(res.location, path).toBeNull();
            expect(res.json, path).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
        }
    });
});
