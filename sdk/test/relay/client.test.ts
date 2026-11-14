// RelayClient against a mocked fetch: pin verification, response validation, error mapping and
// polling (§6.2, §7).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tokenAuthHash, transferDigest } from '../../src/core/eip712.js';
import { GaslessValidationError } from '../../src/core/errors.js';
import { createTransferIntent, tokenAuthSigningPayload, transferSigningPayload } from '../../src/core/intent.js';
import type { ChainPins } from '../../src/core/pins.js';
import { toTokenAuthorization } from '../../src/core/signature.js';
import { buildSubmitTransferBody } from '../../src/core/submit.js';
import type { Hex } from '../../src/core/types.js';
import { RelayClient } from '../../src/relay/client.js';
import { RelayApiError, RelayClientError, RelayPinMismatchError, RelayRequestFailedError, sanitizeRelayMessage } from '../../src/relay/errors.js';
import { ERROR_HTTP_STATUS, type ErrorCode, type InfoResponse, type RequestState, type SubmitTransferBody } from '../../src/relay/types.js';
import { ADDR, KEYS, NOW, polygonPins, TRANSFER_CONTRACT, USDC, USDT0 } from '../helpers/fixtures.js';
import { infoFor } from '../helpers/relay.js';

const BASE = 'https://relay.test';
const pins = polygonPins();

type Reply = { status: number; body?: unknown; raw?: string } | Error | 'hang';
type Handler = (method: string, path: string, body: unknown) => Reply | Promise<Reply>;

interface Call {
    url: string;
    init: RequestInit;
}

function mockFetch(handler: Handler) {
    const calls: Call[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
        calls.push({ url, init });
        const path = url.slice(BASE.length);
        const reply = await handler(init.method ?? 'GET', path, init.body === undefined ? undefined : JSON.parse(String(init.body)));
        if (reply === 'hang') {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
            });
        }
        if (reply instanceof Error) throw reply;
        return new Response(reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body)), {
            status: reply.status,
            headers: { 'content-type': 'application/json' },
        });
    });
    return { fetch, calls };
}

function feeReply(overrides: Record<string, unknown> = {}) {
    return {
        operation: 'transfer',
        token: USDC,
        authMode: 'permit',
        fee: '50000',
        relay: ADDR.relay,
        gasUnits: '120000',
        gasPrice: '45000000000',
        polUsd: '0.1121',
        issuedAt: NOW,
        expiresAt: NOW + 120,
        quoteId: 'quote-1',
        ...overrides,
    };
}

async function signedBody(mode: 'permit' | 'metaTxApprove' | 'none' = 'metaTxApprove', relay: string = ADDR.relay, p: ChainPins = pins): Promise<SubmitTransferBody> {
    const account = privateKeyToAccount(KEYS.user);
    const intent = createTransferIntent(
        p,
        { token: USDT0, from: ADDR.user, to: ADDR.recipient, amount: 10_000_000n, fee: 50_000n, relay, authMode: mode, deadline: NOW + 600, nonce: 0n, tokenNonce: 0n },
        NOW,
        { allowMetaTxApprove: true },
    );
    const tokenAuth = tokenAuthSigningPayload(p, intent, NOW);
    const tokenSignature = tokenAuth === null ? undefined : await account.signTypedData(tokenAuth as unknown as TypedDataDefinition);
    const authorization = toTokenAuthorization(mode, tokenSignature);
    const signature = await account.signTypedData(transferSigningPayload(p, intent, authorization, NOW) as unknown as TypedDataDefinition);
    return buildSubmitTransferBody({ request: intent.request, signature, authorization, quoteId: 'quote-1' });
}

function stateFor(body: SubmitTransferBody, status: RequestState['status'], overrides: Partial<RequestState> = {}): RequestState {
    return {
        id: transferDigest(137, TRANSFER_CONTRACT, body.request, body.authorization),
        operation: 'transfer',
        status,
        request: body.request,
        authHash: tokenAuthHash(body.authorization),
        transactions: status === 'queued' ? [] : [{ hash: `0x${'11'.repeat(32)}`, txNonce: 5, maxFeePerGas: '60000000000', status: 'mined' }],
        txHash: status === 'queued' ? null : `0x${'11'.repeat(32)}`,
        blockNumber: status === 'mined' || status === 'confirmed' ? '94421001' : null,
        error: null,
        ...overrides,
    };
}

function client(handler: Handler, options: { requestTimeoutMs?: number; pins?: ChainPins; now?: () => number } = {}) {
    const { fetch, calls } = mockFetch(handler);
    return { relay: new RelayClient(BASE, { pins: options.pins ?? pins, fetch, now: () => NOW, ...options }), calls, fetch };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected a rejection');
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
});
afterEach(() => {
    // The SDK never logs (META_TX signatures must not end up in logs).
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
});

describe('RelayClient construction', () => {
    it('normalizes the base URL and requires pins', () => {
        expect(new RelayClient('https://relay.test/', { pins, fetch: vi.fn() }).baseUrl).toBe('https://relay.test');
        expect(new RelayClient('https://relay.test/api/', { pins, fetch: vi.fn() }).baseUrl).toBe('https://relay.test/api');
        for (const bad of ['relay.test', 'ftp://relay.test', 'https://user:pw@relay.test', 'https://relay.test/?x=1', 'https://relay.test/#x']) {
            expect(() => new RelayClient(bad, { pins, fetch: vi.fn() })).toThrow(TypeError);
        }
        expect(() => new RelayClient(BASE, {} as never)).toThrow(/pins/);
        expect(() => new RelayClient(BASE, { pins, fetch: vi.fn(), requestTimeoutMs: 0 })).toThrow(TypeError);
    });

    it('refuses plain http:// except for localhost, 127.0.0.1 and [::1]; allowInsecureHttp is an explicit opt-in', () => {
        for (const [url, normalized] of [
            ['http://localhost:8080', 'http://localhost:8080'],
            ['http://LOCALHOST:8080/api/', 'http://localhost:8080/api'],
            ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
            ['http://127.1', 'http://127.0.0.1'], // WHATWG URL normalizes IPv4 shorthand
            ['http://[::1]:8080', 'http://[::1]:8080'],
            ['http://[0:0:0:0:0:0:0:1]', 'http://[::1]'],
        ] as const) {
            expect(new RelayClient(url, { pins, fetch: vi.fn() }).baseUrl, url).toBe(normalized);
        }
        for (const url of [
            'http://relay.example.com',
            'http://relay:8080',
            'http://10.0.0.5:8080',
            'http://127.0.0.2:8080',
            'http://0.0.0.0:8080',
            'http://localhost.example.com',
            'http://localhost.:8080',
            'http://[::2]:8080',
        ]) {
            expect(() => new RelayClient(url, { pins, fetch: vi.fn() }), url).toThrow(/https:\/\//);
            expect(() => new RelayClient(url, { pins, fetch: vi.fn(), allowInsecureHttp: false }), url).toThrow(TypeError);
            expect(() => new RelayClient(url, { pins, fetch: vi.fn(), allowInsecureHttp: 'yes' as never }), url).toThrow(TypeError);
            expect(new RelayClient(url, { pins, fetch: vi.fn(), allowInsecureHttp: true }).baseUrl, url).toBe(new URL(url).href.replace(/\/+$/, ''));
        }
        expect(new RelayClient('https://relay.example.com', { pins, fetch: vi.fn() }).baseUrl).toBe('https://relay.example.com');
    });
});

describe('info()', () => {
    it('returns the verified, frozen info', async () => {
        const { relay, calls } = client(() => ({ status: 200, body: infoFor(pins) }));
        const info = await relay.info();
        expect(info).toEqual(infoFor(pins));
        expect(Object.isFrozen(info.tokens[0]?.tokenDomain)).toBe(true);
        expect(calls[0]?.url).toBe(`${BASE}/v1/info`);
        expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    });

    it('accepts token order and case differences', async () => {
        const info = infoFor(pins);
        const reordered = { ...info, relay: info.relay.toLowerCase(), tokens: [...info.tokens].reverse().map((t) => ({ ...t, authModes: [...t.authModes].reverse() })) };
        const { relay } = client(() => ({ status: 200, body: reordered }));
        await expect(relay.info()).resolves.toBeDefined();
    });

    const base = infoFor(pins);
    const usdc = base.tokens[0] as InfoResponse['tokens'][number];
    const usdt0 = base.tokens[1] as InfoResponse['tokens'][number];
    const withToken = (index: number, change: Partial<InfoResponse['tokens'][number]>) => ({
        ...base,
        tokens: base.tokens.map((t, i) => (i === index ? { ...t, ...change } : t)),
    });
    it.each<[string, unknown]>([
        ['chainId', { ...base, chainId: 80002 }],
        ['relay', { ...base, relay: ADDR.other }],
        ['contracts.transfer.address', { ...base, contracts: { transfer: { ...base.contracts.transfer, address: ADDR.other } } }],
        ['contracts.transfer.domain', { ...base, contracts: { transfer: { ...base.contracts.transfer, domain: { ...base.contracts.transfer.domain, name: 'Nimiq Gasless Other' } } } }],
        ['contracts.transfer.domain', { ...base, contracts: { transfer: { ...base.contracts.transfer, domain: { ...base.contracts.transfer.domain, version: '1' } } } }],
        ['contracts.transfer.domain', { ...base, contracts: { transfer: { ...base.contracts.transfer, domain: { ...base.contracts.transfer.domain, chainId: 1 } } } }],
        ['contracts.transfer.domain', { ...base, contracts: { transfer: { ...base.contracts.transfer, domain: { ...base.contracts.transfer.domain, verifyingContract: ADDR.other } } } }],
        ['contracts.transfer.domain', { ...base, contracts: { transfer: { ...base.contracts.transfer, domain: { ...base.contracts.transfer.domain, salt: `0x${'00'.repeat(31)}89` } } } }],
        ['tokens', { ...base, tokens: [usdc] }],
        ['tokens', { ...base, tokens: [usdc, usdt0, { ...usdc, symbol: 'USDC.e', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' }] }],
        ['tokens[1].address', { ...base, tokens: [usdc, { ...usdt0, address: ADDR.other }] }],
        ['tokens[1].address', { ...base, tokens: [usdc, usdc] }],
        ['tokens[0].symbol', withToken(0, { symbol: 'USDC.e' })],
        ['tokens[0].decimals', withToken(0, { decimals: 18 })],
        ['tokens[0].authModes', withToken(0, { authModes: ['permit'] })],
        ['tokens[0].authModes', withToken(0, { authModes: ['permit', 'none', 'metaTxApprove'] })],
        ['tokens[1].authModes', withToken(1, { authModes: ['permit', 'none', 'none'] })],
        ['tokens[1].tokenDomain', withToken(1, { tokenDomain: { ...usdt0.tokenDomain, name: 'Tether USD' } })],
        ['tokens[1].tokenDomain', withToken(1, { tokenDomain: { name: 'USDT0', version: '1', chainId: 137, verifyingContract: USDT0 } })],
        ['tokens[0].tokenDomain', withToken(0, { tokenDomain: { ...usdc.tokenDomain, verifyingContract: USDT0 } })],
        ['tokens[0].tokenDomain', withToken(0, { tokenDomain: { ...usdc.tokenDomain, salt: `0x${'00'.repeat(31)}89` } })],
    ])('refuses a mismatch at %s', async (field, info) => {
        const { relay } = client(() => ({ status: 200, body: info }));
        const error = await rejection(relay.info());
        expect(error).toBeInstanceOf(RelayPinMismatchError);
        expect((error as RelayPinMismatchError).code).toBe('pin_mismatch');
        expect((error as RelayPinMismatchError).field).toBe(field);
    });

    it.each<[string, unknown]>([
        ['not an object', 'hello'],
        ['missing policy', { ...base, policy: undefined }],
        ['chainId as string', { ...base, chainId: '137' }],
        ['malformed relay', { ...base, relay: '0x12' }],
        ['unknown auth mode', withToken(0, { authModes: ['approve' as never] })],
        ['unknown domain field', withToken(0, { tokenDomain: { ...usdc.tokenDomain, extensions: [] } as never })],
        ['policy min > max', { ...base, policy: { minDeadlineSeconds: 7200, maxDeadlineSeconds: 60, quoteTtlSeconds: 120 } }],
    ])('rejects a malformed info: %s', async (_name, info) => {
        const { relay } = client(() => ({ status: 200, body: info }));
        const error = await rejection(relay.info());
        expect(error).toBeInstanceOf(RelayClientError);
        expect((error as RelayClientError).code).toBe('invalid_response');
    });

    // The parser ignores fields outside domain objects that it does not use (additive relay changes): they are dropped,
    // never compared or returned.
    it('ignores an unknown tokens[] field: it is neither checked nor returned', async () => {
        for (const extra of ['5000000', '1', 5000000, null, { nested: 1 }]) {
            const info = { ...base, tokens: base.tokens.map((t) => ({ ...t, extra })) };
            const verified = await client(() => ({ status: 200, body: info })).relay.info();
            expect(verified, JSON.stringify(extra)).toEqual(base);
            for (const token of verified.tokens) expect(token).not.toHaveProperty('extra');
        }
    });

    it('rejects unexpected success statuses and non-JSON bodies', async () => {
        expect(((await rejection(client(() => ({ status: 204 })).relay.info())) as RelayClientError).code).toBe('invalid_response');
        expect(((await rejection(client(() => ({ status: 200, raw: '<html>' })).relay.info())) as RelayClientError).code).toBe('invalid_response');
    });

    it('refuses a token list longer than 32 entries before parsing any of them', async () => {
        const token = base.tokens[0];
        const info = (count: number) => ({ ...base, tokens: Array.from({ length: count }, () => token) });
        const tooLong = (await rejection(client(() => ({ status: 200, body: info(33) })).relay.info())) as RelayClientError;
        expect(tooLong.code).toBe('invalid_response');
        expect(tooLong.message).toMatch(/tokens: expected at most 32 tokens/);
        // 32 entries are parsed; they then fail the comparison with the pins, not the bound.
        expect(await rejection(client(() => ({ status: 200, body: info(32) })).relay.info())).toBeInstanceOf(RelayPinMismatchError);
    });
});

describe('the /v1/info request that concurrent callers share', () => {
    /** A fetch that, like the real one, ends a request when its signal aborts; /v1/info answers once `release` runs. */
    function gatedInfo() {
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        const fetch = vi.fn(
            (url: string, init: RequestInit) =>
                new Promise<Response>((resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
                    if (!url.endsWith('/v1/info')) resolve(reply(feeReply()));
                    else void gate.then(() => resolve(reply(infoFor(pins))));
                }),
        );
        return { relay: new RelayClient(BASE, { pins, fetch, now: () => NOW }), fetch, release };
    }

    it('is not ended by the cancellation of the caller that started it', async () => {
        const { relay, fetch, release } = gatedInfo();
        const controller = new AbortController();
        const first = rejection(relay.fee({ token: USDC, authMode: 'permit' }, { signal: controller.signal }));
        const second = relay.fee({ token: USDC, authMode: 'permit' });
        controller.abort(new Error('user cancelled'));
        expect(((await first) as RelayClientError).code).toBe('aborted');
        release();
        expect(await second).toEqual(feeReply());
        expect(fetch.mock.calls.filter(([url]) => url === `${BASE}/v1/info`)).toHaveLength(1);
    });

    it('is not started for a caller whose signal is already aborted', async () => {
        const { relay, fetch } = gatedInfo();
        const error = (await rejection(relay.fee({ token: USDC, authMode: 'permit' }, { signal: AbortSignal.abort() }))) as RelayClientError;
        expect(error.code).toBe('aborted');
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('fee()', () => {
    it('verifies /v1/info once, sends the query and returns the checked quote', async () => {
        const { relay, calls } = client((_method, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status: 200, body: feeReply() }));
        const quote = await relay.fee({ token: USDC.toLowerCase() as `0x${string}`, authMode: 'permit' });
        await relay.fee({ token: USDC, authMode: 'permit' });
        expect(quote).toEqual(feeReply());
        expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/info`, `${BASE}/v1/fee?operation=transfer&token=${USDC}&authMode=permit`, `${BASE}/v1/fee?operation=transfer&token=${USDC}&authMode=permit`]);
    });

    it('refuses unpinned tokens and unsupported modes without calling the relay', async () => {
        const { relay, fetch } = client(() => ({ status: 200, body: infoFor(pins) }));
        expect(((await rejection(relay.fee({ token: ADDR.other, authMode: 'permit' }))) as GaslessValidationError).code).toBe('unsupported_token');
        expect(((await rejection(relay.fee({ token: USDC, authMode: 'metaTxApprove' }))) as GaslessValidationError).code).toBe('unsupported_auth_mode');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses to quote through a relay whose info does not match the pins', async () => {
        const { relay, calls } = client(() => ({ status: 200, body: { ...infoFor(pins), chainId: 1 } }));
        expect(await rejection(relay.fee({ token: USDC, authMode: 'permit' }))).toBeInstanceOf(RelayPinMismatchError);
        expect(calls).toHaveLength(1);
    });

    it.each<[string, Record<string, unknown>]>([
        ['fee.token', { token: USDT0 }],
        ['fee.authMode', { authMode: 'none' }],
        ['fee.relay', { relay: ADDR.other }],
        ['fee.fee', { fee: '50001' }],
    ])('refuses a quote with a mismatching %s', async (field, overrides) => {
        const { relay } = client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status: 200, body: feeReply(overrides) }));
        const error = await rejection(relay.fee({ token: USDC, authMode: 'permit' }));
        expect(error).toBeInstanceOf(RelayPinMismatchError);
        expect((error as RelayPinMismatchError).field).toBe(field);
    });

    it.each<[string, Record<string, unknown>]>([
        ['polUsd', { polUsd: '1e-3' }],
        ['quoteId', { quoteId: '' }],
        ['expiresAt', { expiresAt: NOW - 1 }],
        ['operation', { operation: 'example.open' }],
        ['fee', { fee: 50000 }],
    ])('rejects a malformed quote (%s)', async (_field, overrides) => {
        const { relay } = client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status: 200, body: feeReply(overrides) }));
        expect(((await rejection(relay.fee({ token: USDC, authMode: 'permit' }))) as RelayClientError).code).toBe('invalid_response');
    });

    // The pins cap no quote, only the caller's maxAcceptableFee does.
    it('takes a quote of any size from the pins, for each token', async () => {
        const quoting = (token: string, fee: string, authMode = 'permit') =>
            client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status: 200, body: feeReply({ token, fee, authMode }) }));
        for (const fee of ['5010000', '50000000', (10n ** 70n).toString()]) {
            await expect(quoting(USDC, fee).relay.fee({ token: USDC, authMode: 'permit' }), fee).resolves.toMatchObject({ fee });
            await expect(quoting(USDT0, fee, 'metaTxApprove').relay.fee({ token: USDT0, authMode: 'metaTxApprove' }), fee).resolves.toMatchObject({ fee });
        }
        // The granularity still applies, at any size.
        const error = await rejection(quoting(USDC, '50000001').relay.fee({ token: USDC, authMode: 'permit' }));
        expect((error as RelayPinMismatchError).field).toBe('fee.fee');
    });

    it('ignores an unknown field in the quote: it is neither checked nor returned', async () => {
        const { relay } = client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status: 200, body: feeReply({ extra: '10000' }) }));
        const quote = await relay.fee({ token: USDC, authMode: 'permit' });
        expect(quote).toEqual(feeReply());
        expect(quote).not.toHaveProperty('extra');
    });

    describe("the caller's fee ceiling", () => {
        const quoting = (fee: string) => client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status: 200, body: feeReply({ fee }) }));
        const greedyFee = '50000000';

        it('refuses a quote above maxAcceptableFee, the only cap on the fee', async () => {
            // A greedy relay quotes 50.00 whatever the gas costs (nothing caps it on-chain); the wallet accepts at most 0.10.
            const { relay } = quoting(greedyFee);
            await expect(relay.fee({ token: USDC, authMode: 'permit' })).resolves.toMatchObject({ fee: greedyFee });
            const error = await rejection(relay.fee({ token: USDC, authMode: 'permit', maxAcceptableFee: 100_000n }));
            expect(error).toBeInstanceOf(GaslessValidationError);
            expect((error as GaslessValidationError).code).toBe('fee_above_limit');
            expect((error as GaslessValidationError).field).toBe('fee.fee');
            expect(error.message).toContain(greedyFee);
            expect(error.message).toContain('100000');
        });

        it('accepts a quote up to and including the limit (bigint or decimal string)', async () => {
            const { relay } = quoting('50000');
            await expect(relay.fee({ token: USDC, authMode: 'permit', maxAcceptableFee: 50_000n })).resolves.toMatchObject({ fee: '50000' });
            await expect(relay.fee({ token: USDC, authMode: 'permit', maxAcceptableFee: '1000000' })).resolves.toMatchObject({ fee: '50000' });
            expect(((await rejection(relay.fee({ token: USDC, authMode: 'permit', maxAcceptableFee: '49999' }))) as GaslessValidationError).code).toBe('fee_above_limit');
        });

        it('rejects a malformed maxAcceptableFee without calling the relay', async () => {
            const { relay, fetch } = quoting('50000');
            for (const bad of [-1n, 2n ** 256n, '0x10', '1.5', '', 'abc', 1.5, null]) {
                const error = await rejection(relay.fee({ token: USDC, authMode: 'permit', maxAcceptableFee: bad as never }));
                expect((error as GaslessValidationError).code, String(bad)).toBe('invalid_request');
                expect((error as GaslessValidationError).field).toBe('maxAcceptableFee');
            }
            expect(fetch).not.toHaveBeenCalled();
        });
    });
});

describe('submitTransfer()', () => {
    it('posts the body and checks the returned id against the local digest (202 and 200)', async () => {
        const body = await signedBody();
        const id = transferDigest(137, TRANSFER_CONTRACT, body.request, body.authorization);
        for (const status of [202, 200]) {
            const { relay, calls } = client((method, path, sent) => {
                if (path === '/v1/info') return { status: 200, body: infoFor(pins) };
                expect(method).toBe('POST');
                expect(sent).toEqual(body);
                return { status, body: { id, status: status === 202 ? 'queued' : 'mined' } };
            });
            const result = await relay.submitTransfer(body);
            expect(result).toEqual({ id, status: status === 202 ? 'queued' : 'mined' });
            expect(calls[1]?.url).toBe(`${BASE}/v1/transfer`);
            expect(calls[1]?.init.headers).toMatchObject({ 'content-type': 'application/json' });
        }
    });

    it('refuses an id that is not the request digest', async () => {
        const body = await signedBody();
        const { relay } = client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status: 202, body: { id: `0x${'00'.repeat(32)}`, status: 'queued' } }));
        expect(((await rejection(relay.submitTransfer(body))) as RelayClientError).code).toBe('invalid_response');
    });

    it('never sends an invalid body or one signed for another relay', async () => {
        const twoRelays = polygonPins({ relays: [ADDR.relay, ADDR.other] });
        const body = await signedBody('metaTxApprove', ADDR.relay, twoRelays);
        // The relay at this URL is the other pinned relay: the signature is not for it.
        const { relay, calls } = client(() => ({ status: 200, body: infoFor(twoRelays, ADDR.other) }), { pins: twoRelays });
        const error = await rejection(relay.submitTransfer(body));
        expect((error as GaslessValidationError).code).toBe('wrong_relay');
        expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/info`]);

        const { relay: relay2, fetch } = client(() => ({ status: 200, body: infoFor(pins) }));
        const tampered = { ...body, request: { ...body.request, to: USDC } };
        expect(((await rejection(relay2.submitTransfer(tampered))) as GaslessValidationError).code).toBe('invalid_recipient');
        expect(((await rejection(relay2.submitTransfer({ ...body, signature: '0x1234' as Hex }))) as GaslessValidationError).code).toBe('invalid_signature');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('re-verifies /v1/info after a failed check instead of trusting an older result', async () => {
        const body = await signedBody();
        let info: unknown = infoFor(pins);
        const { relay, calls } = client((_m, path) => {
            if (path === '/v1/info') return { status: 200, body: info };
            return { status: 202, body: { id: transferDigest(137, TRANSFER_CONTRACT, body.request, body.authorization), status: 'queued' } };
        });
        await relay.info();
        info = { ...infoFor(pins), relay: ADDR.other };
        await expect(relay.info()).rejects.toBeInstanceOf(RelayPinMismatchError);
        await expect(relay.submitTransfer(body)).rejects.toBeInstanceOf(RelayPinMismatchError);
        expect(calls.filter((c) => c.url.endsWith('/v1/transfer'))).toHaveLength(0);
    });

    it('follows a relay key rotation (D5) to another pinned address, but not to an unpinned one', async () => {
        const rotating = polygonPins({ relays: [ADDR.relay, ADDR.other] });
        const body = await signedBody('metaTxApprove', ADDR.other, rotating);
        let current: string = ADDR.relay;
        const { relay, calls } = client(
            (_m, path) => {
                if (path === '/v1/info') return { status: 200, body: infoFor(rotating, current) };
                if (path.startsWith('/v1/fee')) return { status: 200, body: feeReply({ token: USDT0, authMode: 'metaTxApprove', relay: current }) };
                return { status: 202, body: { id: transferDigest(137, TRANSFER_CONTRACT, body.request, body.authorization), status: 'queued' } };
            },
            { pins: rotating },
        );
        expect((await relay.info()).relay).toBe(ADDR.relay);
        current = ADDR.other; // the operator rotated the key; the cached info still names the old one
        expect((await relay.fee({ token: USDT0, authMode: 'metaTxApprove' })).relay).toBe(ADDR.other);
        await expect(relay.submitTransfer(body)).resolves.toMatchObject({ status: 'queued' });
        expect(calls.filter((c) => c.url.endsWith('/v1/info'))).toHaveLength(2);

        current = ADDR.recipient; // not pinned
        expect(await rejection(relay.fee({ token: USDT0, authMode: 'metaTxApprove' }))).toBeInstanceOf(RelayPinMismatchError);
        expect(await rejection(relay.submitTransfer(body))).toBeInstanceOf(RelayPinMismatchError);
    });

    it.each(Object.entries(ERROR_HTTP_STATUS) as Array<[ErrorCode, number]>)('maps the relay error %s (HTTP %i) to RelayApiError', async (code, status) => {
        const body = await signedBody();
        const { relay } = client((_m, path) =>
            path === '/v1/info' ? { status: 200, body: infoFor(pins) } : { status, body: { error: { code, message: `relay says ${code}\u0000\n` } } },
        );
        const error = await rejection(relay.submitTransfer(body));
        expect(error).toBeInstanceOf(RelayApiError);
        expect((error as RelayApiError).code).toBe(code);
        expect((error as RelayApiError).status).toBe(status);
        expect(error.message).toBe(`relay says ${code}  `);
        // sender_busy and nonce_too_high are the retryable 409s: retry after the pending request, or the request at the
        // lower nonce, is mined.
        expect((error as RelayApiError).retryable).toBe(['rate_limited', 'unavailable', 'internal_error', 'sender_busy', 'nonce_too_high'].includes(code));
    });

    it('maps unknown codes and non-JSON errors to http_error, network failures to network_error', async () => {
        const body = await signedBody();
        const cases: Array<[Reply, string, boolean]> = [
            [{ status: 418, body: { error: { code: 'teapot', message: 'x' } } }, 'http_error', false],
            [{ status: 502, raw: '<html>bad gateway</html>' }, 'http_error', true],
            [{ status: 429, raw: '' }, 'http_error', true],
            [new TypeError('fetch failed'), 'network_error', true],
        ];
        for (const [reply, code, retryable] of cases) {
            const { relay } = client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : reply));
            const error = (await rejection(relay.submitTransfer(body))) as RelayClientError;
            expect(error).toBeInstanceOf(RelayClientError);
            expect(error.code).toBe(code);
            expect(error.retryable).toBe(retryable);
        }
    });

    it('times out a hanging request and honours an AbortSignal', async () => {
        const body = await signedBody();
        const hanging = client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : 'hang'), { requestTimeoutMs: 30 });
        expect(((await rejection(hanging.relay.submitTransfer(body))) as RelayClientError).code).toBe('timeout');

        const controller = new AbortController();
        const aborting = client((_m, path) => {
            if (path === '/v1/info') return { status: 200, body: infoFor(pins) };
            setTimeout(() => controller.abort(new Error('user cancelled')), 5);
            return 'hang';
        });
        const error = (await rejection(aborting.relay.submitTransfer(body, { signal: controller.signal }))) as RelayClientError;
        expect(error.code).toBe('aborted');

        const already = client(() => ({ status: 200, body: infoFor(pins) }));
        expect(((await rejection(already.relay.info({ signal: AbortSignal.abort() }))) as RelayClientError).code).toBe('aborted');
        expect(already.fetch).not.toHaveBeenCalled();
    });

    it('keeps signatures out of error messages (META_TX approvals never expire)', async () => {
        const body = await signedBody('metaTxApprove');
        const secrets = [body.signature.slice(2), (body.authorization.r as string).slice(2), (body.authorization.s as string).slice(2)];
        const replies: Reply[] = [
            { status: 400, body: { error: { code: 'invalid_token_authorization', message: 'bad' } } },
            { status: 500, raw: 'oops' },
            new TypeError('fetch failed'),
            { status: 202, body: { id: `0x${'00'.repeat(32)}`, status: 'queued' } },
        ];
        for (const reply of replies) {
            const { relay } = client((_m, path) => (path === '/v1/info' ? { status: 200, body: infoFor(pins) } : reply));
            const error = await rejection(relay.submitTransfer(body));
            const text = `${String(error)} ${error.message} ${JSON.stringify(error)} ${error.stack ?? ''}`.toLowerCase();
            for (const secret of secrets) expect(text).not.toContain(secret);
        }
    });
});

describe('getRequest()', () => {
    it('returns the state after checking that its request and authHash hash to the id', async () => {
        const body = await signedBody();
        const state = stateFor(body, 'mined');
        const { relay, calls } = client(() => ({ status: 200, body: state }));
        expect(await relay.getRequest(state.id.toUpperCase().replace('0X', '0x') as Hex)).toEqual(state);
        expect(calls[0]?.url).toBe(`${BASE}/v1/requests/${state.id}`);
        // The state carries the hash of the token authorization, never its signature.
        expect(JSON.stringify(state)).not.toContain(body.authorization.s.slice(2));
    });

    it('rejects a mismatching id, a request or authHash that does not hash to it, and malformed states', async () => {
        const body = await signedBody();
        const state = stateFor(body, 'queued');
        const other = { ...body.request, amount: '1' };
        const cases: unknown[] = [
            { ...state, id: `0x${'00'.repeat(32)}` },
            { ...state, request: other },
            { ...state, request: { ...body.request, nonce: '1' } },
            { ...state, authHash: tokenAuthHash({ ...body.authorization, v: body.authorization.v === 27 ? 28 : 27 }) },
            { ...state, authHash: undefined },
            { ...state, authHash: '0x12' },
            { ...state, status: 'done' },
            { ...state, operation: 'example.open' },
            { ...state, transactions: [{ hash: '0x12', txNonce: 1, maxFeePerGas: '1', status: 'mined' }] },
            { ...state, error: { code: 'something_new', message: 'x' } },
            { ...state, request: { ...body.request, extra: 1 } },
        ];
        for (const reply of cases) {
            const { relay } = client(() => ({ status: 200, body: reply }));
            expect(((await rejection(relay.getRequest(state.id))) as RelayClientError).code).toBe('invalid_response');
        }
    });

    it('validates the id before calling the relay', async () => {
        const { relay, fetch } = client(() => ({ status: 200, body: {} }));
        for (const bad of ['0x12', `0x${'00'.repeat(32)}/../info`, '../../admin']) {
            expect(((await rejection(relay.getRequest(bad as Hex))) as GaslessValidationError).code).toBe('invalid_request');
        }
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('waitForRequest()', () => {
    function sequence(body: SubmitTransferBody, replies: Array<Reply | RequestState['status']>) {
        let i = 0;
        return client(() => {
            const next = replies[Math.min(i++, replies.length - 1)] as Reply | RequestState['status'];
            return typeof next === 'string' && next !== 'hang' ? { status: 200, body: stateFor(body, next) } : (next as Reply);
        });
    }

    it('polls until the request is mined', async () => {
        const body = await signedBody();
        const { relay, calls } = sequence(body, ['queued', 'submitted', 'mined']);
        const state = await relay.waitForRequest(stateFor(body, 'queued').id, { pollIntervalMs: 1 });
        expect(state.status).toBe('mined');
        expect(calls).toHaveLength(3);
    });

    it('honours until: "submitted" and "confirmed"', async () => {
        const body = await signedBody();
        const id = stateFor(body, 'queued').id;
        expect((await sequence(body, ['queued', 'submitted', 'mined']).relay.waitForRequest(id, { pollIntervalMs: 1, until: 'submitted' })).status).toBe('submitted');
        const confirmed = sequence(body, ['submitted', 'mined', 'mined', 'confirmed']);
        expect((await confirmed.relay.waitForRequest(id, { pollIntervalMs: 1, until: 'confirmed' })).status).toBe('confirmed');
        expect(confirmed.calls).toHaveLength(4);
    });

    it('throws RelayRequestFailedError at once, final, for failed and expired requests that were never broadcast (no transactions)', async () => {
        const body = await signedBody();
        const id = stateFor(body, 'queued').id;
        const failedState = stateFor(body, 'failed', { transactions: [], txHash: null, error: { code: 'simulation_failed', message: 'InsufficientAllowance' } });
        const failed = client(() => ({ status: 200, body: failedState }));
        const error = (await rejection(failed.relay.waitForRequest(id, { pollIntervalMs: 1 }))) as RelayRequestFailedError;
        expect(error).toBeInstanceOf(RelayRequestFailedError);
        expect(error.code).toBe('request_failed');
        expect(error.relayCode).toBe('simulation_failed');
        expect(error.state.status).toBe('failed');
        expect(error.final).toBe(true);
        expect(error.message).not.toMatch(/not final/);
        expect(failed.calls).toHaveLength(1);
        const neverSent = sequence(body, ['queued', { status: 200, body: stateFor(body, 'expired', { transactions: [], txHash: null }) }]);
        const expired = (await rejection(neverSent.relay.waitForRequest(id, { pollIntervalMs: 1 }))) as RelayRequestFailedError;
        expect(expired.code).toBe('request_expired');
        expect(expired.relayCode).toBeNull();
        expect(expired.final).toBe(true);
        expect(neverSent.calls).toHaveLength(2);
    });

    describe('a failed or expired request that was broadcast is provisional until its deadline plus the settle margin', () => {
        // stateFor lists a mined call transaction for every status but "queued": the relay broadcast it, and an
        // inclusion (a reverted call, a mined cancel) decided the outcome. The deadline is NOW + 600.
        const reverted = (body: SubmitTransferBody) =>
            stateFor(body, 'failed', { txHash: null, error: { code: 'simulation_failed', message: 'the call reverted on-chain' } });

        it('keeps polling and returns a later "mined" or "confirmed" (a reorg, a lagging node)', async () => {
            const body = await signedBody();
            const id = stateFor(body, 'queued').id;
            for (const [first, then] of [
                ['failed', 'mined'],
                ['expired', 'mined'],
                ['failed', 'confirmed'],
            ] as const) {
                const flip = sequence(body, [{ status: 200, body: first === 'failed' ? reverted(body) : stateFor(body, 'expired') }, 'submitted', then]);
                const state = await flip.relay.waitForRequest(id, { pollIntervalMs: 1, timeoutMs: 5_000 });
                expect(state.status, `${first} → ${then}`).toBe(then);
                expect(flip.calls).toHaveLength(3);
            }
        });

        it('throws final: false when timeoutMs ends first, with the last provisional state', async () => {
            const body = await signedBody();
            const id = stateFor(body, 'queued').id;
            const { relay, calls } = client(() => ({ status: 200, body: reverted(body) }));
            const started = Date.now();
            const error = (await rejection(relay.waitForRequest(id, { pollIntervalMs: 5, timeoutMs: 60 }))) as RelayRequestFailedError;
            expect(error).toBeInstanceOf(RelayRequestFailedError);
            expect({ code: error.code, final: error.final, status: error.state.status, relayCode: error.relayCode }).toEqual({
                code: 'request_failed',
                final: false,
                status: 'failed',
                relayCode: 'simulation_failed',
            });
            expect(error.message).toMatch(/not final/);
            expect(calls.length).toBeGreaterThan(1);
            expect(Date.now() - started).toBeLessThan(2_000);
            // Transient errors after the provisional answer do not hide it.
            let i = 0;
            const flaky = client(() => (i++ === 0 ? { status: 200, body: stateFor(body, 'expired') } : new TypeError('fetch failed')));
            const expired = (await rejection(flaky.relay.waitForRequest(id, { pollIntervalMs: 5, timeoutMs: 60 }))) as RelayRequestFailedError;
            expect({ code: expired.code, final: expired.final }).toEqual({ code: 'request_expired', final: false });
        });

        it('throws final: true once the client clock is past deadline + settleMarginSeconds (default 180)', async () => {
            const body = await signedBody();
            const id = stateFor(body, 'queued').id;
            const deadline = Number(body.request.deadline);
            const at = (now: number, settleMarginSeconds?: number) => {
                const c = client(() => ({ status: 200, body: reverted(body) }), { now: () => now });
                return {
                    calls: c.calls,
                    wait: c.relay.waitForRequest(id, { pollIntervalMs: 5, timeoutMs: 60, ...(settleMarginSeconds !== undefined ? { settleMarginSeconds } : {}) }),
                };
            };
            // At deadline + 180 the outcome is still provisional; one second later it is final at the first poll.
            expect(((await rejection(at(deadline + 180).wait)) as RelayRequestFailedError).final).toBe(false);
            const past = at(deadline + 181);
            const final = (await rejection(past.wait)) as RelayRequestFailedError;
            expect({ code: final.code, final: final.final }).toEqual({ code: 'request_failed', final: true });
            expect(past.calls).toHaveLength(1);
            // A custom margin.
            expect(((await rejection(at(deadline + 1, 0).wait)) as RelayRequestFailedError).final).toBe(true);
            expect(((await rejection(at(deadline + 1, 10).wait)) as RelayRequestFailedError).final).toBe(false);
        });

        it('a request the relay puts back in flight clears the provisional failure: the wait then times out as usual', async () => {
            const body = await signedBody();
            const { relay } = sequence(body, [{ status: 200, body: reverted(body) }, 'submitted']);
            const error = (await rejection(relay.waitForRequest(stateFor(body, 'queued').id, { pollIntervalMs: 5, timeoutMs: 60 }))) as RelayClientError;
            expect(error).toBeInstanceOf(RelayClientError);
            expect(error.code).toBe('timeout');
        });

        it('validates settleMarginSeconds and needs a clock in seconds', async () => {
            const body = await signedBody();
            const id = stateFor(body, 'queued').id;
            const { relay } = client(() => ({ status: 200, body: reverted(body) }));
            for (const bad of [-1, 1.5, Number.NaN, '180' as never]) {
                await expect(relay.waitForRequest(id, { settleMarginSeconds: bad })).rejects.toThrow(TypeError);
            }
            const milliseconds = client(() => ({ status: 200, body: reverted(body) }), { now: () => Date.now() });
            await expect(milliseconds.relay.waitForRequest(id, { pollIntervalMs: 1 })).rejects.toThrow(TypeError);
        });
    });

    it('retries transient failures (503, 429, network errors, request timeouts)', async () => {
        const body = await signedBody();
        const { relay, calls } = sequence(body, [
            { status: 503, body: { error: { code: 'unavailable', message: 'x' } } },
            { status: 429, body: { error: { code: 'rate_limited', message: 'x' } } },
            new TypeError('fetch failed'),
            { status: 502, raw: 'bad gateway' },
            'mined',
        ]);
        expect((await relay.waitForRequest(stateFor(body, 'queued').id, { pollIntervalMs: 1 })).status).toBe('mined');
        expect(calls).toHaveLength(5);
    });

    it('waits twice as long after each failed poll in a row, and the poll interval again after a success', async () => {
        const body = await signedBody();
        const unavailable: Reply = { status: 503, body: { error: { code: 'unavailable', message: 'x' } } };
        const replies: Array<Reply | RequestState['status']> = [unavailable, unavailable, unavailable, 'queued', 'mined'];
        const at: number[] = [];
        let i = 0;
        const { relay } = client(() => {
            at.push(performance.now());
            const next = replies[Math.min(i++, replies.length - 1)]!;
            return typeof next === 'string' && next !== 'hang' ? { status: 200, body: stateFor(body, next) } : (next as Reply);
        });
        expect((await relay.waitForRequest(stateFor(body, 'queued').id, { pollIntervalMs: 20 })).status).toBe('mined');
        const gaps = at.slice(1).map((t, k) => t - at[k]!);
        // 40, 80 and 160 ms after the three failures, then the poll interval (20 ms) after the success.
        expect(gaps[0]).toBeGreaterThanOrEqual(38);
        expect(gaps[1]).toBeGreaterThanOrEqual(78);
        expect(gaps[2]).toBeGreaterThanOrEqual(158);
        expect(gaps[3]).toBeLessThan(gaps[2]!);
    });

    it('stops at once on a non-transient error such as not_found', async () => {
        const body = await signedBody();
        const { relay, calls } = sequence(body, [{ status: 404, body: { error: { code: 'not_found', message: 'unknown id' } } }, 'mined']);
        const error = (await rejection(relay.waitForRequest(stateFor(body, 'queued').id, { pollIntervalMs: 1 }))) as RelayApiError;
        expect(error.code).toBe('not_found');
        expect(calls).toHaveLength(1);
    });

    it('times out with the last transient error as cause', async () => {
        const body = await signedBody();
        const { relay } = sequence(body, ['queued']);
        const started = Date.now();
        const error = (await rejection(relay.waitForRequest(stateFor(body, 'queued').id, { pollIntervalMs: 5, timeoutMs: 60 }))) as RelayClientError;
        expect(error.code).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(2000);
        const failing = sequence(body, [{ status: 503, body: { error: { code: 'unavailable', message: 'x' } } }]);
        const withCause = (await rejection(failing.relay.waitForRequest(stateFor(body, 'queued').id, { pollIntervalMs: 5, timeoutMs: 40 }))) as RelayClientError;
        expect(withCause.code).toBe('timeout');
        expect((withCause.cause as RelayApiError).code).toBe('unavailable');
    });

    it('aborts while sleeping, while fetching, and before starting', async () => {
        const body = await signedBody();
        const id = stateFor(body, 'queued').id;
        const sleeping = new AbortController();
        const polling = sequence(body, ['queued']);
        setTimeout(() => sleeping.abort(), 20);
        expect(((await rejection(polling.relay.waitForRequest(id, { pollIntervalMs: 10_000, signal: sleeping.signal }))) as RelayClientError).code).toBe('aborted');

        const fetching = new AbortController();
        const hanging = sequence(body, ['hang']);
        setTimeout(() => fetching.abort(), 20);
        expect(((await rejection(hanging.relay.waitForRequest(id, { signal: fetching.signal }))) as RelayClientError).code).toBe('aborted');

        const idle = sequence(body, ['mined']);
        expect(((await rejection(idle.relay.waitForRequest(id, { signal: AbortSignal.abort() }))) as RelayClientError).code).toBe('aborted');
        expect(idle.calls).toHaveLength(0);
    });

    it('validates its options', async () => {
        const { relay } = client(() => ({ status: 200, body: {} }));
        const id = `0x${'00'.repeat(32)}` as Hex;
        await expect(relay.waitForRequest(id, { timeoutMs: 0 })).rejects.toThrow(TypeError);
        await expect(relay.waitForRequest(id, { pollIntervalMs: -1 })).rejects.toThrow(TypeError);
        await expect(relay.waitForRequest(id, { until: 'final' as never })).rejects.toThrow(TypeError);
    });
});

// Relay text ends up in error messages and logs of the client: nothing in it may start a new line there or reorder
// the text around it.
describe('sanitizeRelayMessage', () => {
    it.each([
        ['C0 controls and DEL', [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]],
        ['C1 controls, with NEL', [0x80, 0x85, 0x9f]],
        ['the line and paragraph separators', [0x2028, 0x2029]],
        ['the bidi marks', [0x200e, 0x200f]],
        ['the bidi embeddings and overrides', [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]],
        ['the bidi isolates', [0x2066, 0x2067, 0x2068, 0x2069]],
    ])('replaces %s by a space', (_name, codes) => {
        for (const code of codes) expect(sanitizeRelayMessage(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)}`).toBe('a b');
    });

    it('keeps the characters next to these ranges, and other text', () => {
        const kept = `${[0x20, 0x7e, 0xa0, 0x200d, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a].map((code) => String.fromCharCode(code)).join('')}é→語`;
        expect(sanitizeRelayMessage(kept)).toBe(kept);
    });
});
