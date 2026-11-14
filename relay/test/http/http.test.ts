import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { POLYGON_USDC, POLYGON_USDT0, tokenAuthHash } from '@nimiq/gasless-sdk/core';
import { ERROR_HTTP_STATUS, type ErrorCode, type RequestState } from '@nimiq/gasless-sdk/relay';
import { RelayError } from '../../src/errors.js';
import { ChainlinkPriceSource } from '../../src/fees/priceSource.js';
import { MAX_BODY_BYTES, toWireError } from '../../src/http/app.js';
import { checkReadiness } from '../../src/http/readiness.js';
import { CONTRACT, USDC, USDT0, buildTransfer, createHarness, type Harness, type TransferOptions } from '../helpers/harness.js';
import { OTHER_ADDRESS, RELAY_ADDRESS, USER_ADDRESS } from '../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
});

afterEach(async () => {
    await h.close();
});

const post = (payload: unknown, extra: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
    h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object, ...extra });

const get = (url: string, extra: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
    h.relay.app.inject({ method: 'GET', url, ...extra });

/** The internal listener (/healthz, the full /readyz report, /metrics). */
const getOps = (url: string) => h.relay.opsApp.inject({ method: 'GET', url });

function expectError(res: LightMyRequestResponse, code: ErrorCode): void {
    expect(res.statusCode).toBe(ERROR_HTTP_STATUS[code]);
    const body = res.json() as { error: { code: string; message: string } };
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
}

const transfer = (o: TransferOptions = {}) => buildTransfer(h, o);

describe('GET /v1/info', () => {
    it('returns chain, relay, contract domain (version "3"), token domains and policy', async () => {
        const res = await get('/v1/info');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            version: '0.2.0',
            chainId: 137,
            relay: RELAY_ADDRESS,
            contracts: {
                transfer: {
                    address: CONTRACT,
                    domain: { name: 'Nimiq Gasless Transfer', version: '3', chainId: 137, verifyingContract: CONTRACT },
                },
            },
            tokens: [
                { symbol: 'USDC', address: USDC, decimals: 6, authModes: ['permit', 'none'], tokenDomain: POLYGON_USDC.domain },
                {
                    symbol: 'USDT0',
                    address: USDT0,
                    decimals: 6,
                    authModes: ['permit', 'metaTxApprove', 'none'],
                    tokenDomain: POLYGON_USDT0.domain,
                },
            ],
            policy: { minDeadlineSeconds: 60, maxDeadlineSeconds: 7200, quoteTtlSeconds: 120 },
        });
    });
});

describe('T35: GET /v1/fee', () => {
    it('quotes a fee in multiples of 0.01 with the gas price, POL/USD and a 120 s TTL', async () => {
        const res = await get(`/v1/fee?operation=transfer&token=${USDC}&authMode=permit`);
        expect(res.statusCode).toBe(200);
        const body = res.json() as Record<string, unknown>;
        expect(body).toMatchObject({
            operation: 'transfer',
            token: USDC,
            authMode: 'permit',
            fee: '10000', // MIN_FEE: 250000 gas × 75 gwei × 0.2 × 1.1 = 4125 units
            relay: RELAY_ADDRESS,
            gasUnits: '250000',
            gasPrice: '75000000000', // 30 gwei × 1.5 + 30 gwei
            polUsd: '0.2',
        });
        expect(body.expiresAt).toBe((body.issuedAt as number) + 120);
        expect(body.issuedAt).toBe(h.clock.seconds());
        expect(body.quoteId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Object.keys(body).sort()).toEqual(
            ['authMode', 'expiresAt', 'fee', 'gasPrice', 'gasUnits', 'issuedAt', 'operation', 'polUsd', 'quoteId', 'relay', 'token'].sort(),
        );
    });

    it('follows the gas price', async () => {
        h.chain.head = { ...h.chain.head, baseFeePerGas: 1000n * 1_000_000_000n };
        const res = await get(`/v1/fee?operation=transfer&token=${USDT0}&authMode=metaTxApprove`);
        // 260000 × (1500 + 30) gwei × 0.2 × 1.1 = 87516 → 90000
        expect(res.json()).toMatchObject({ fee: '90000', gasUnits: '260000', gasPrice: '1530000000000' });
    });

    it('has no upper cap: expensive gas is quoted above 5.00, not refused', async () => {
        h.chain.head = { ...h.chain.head, baseFeePerGas: 100_000n * 1_000_000_000n };
        const res = await get(`/v1/fee?operation=transfer&token=${USDC}&authMode=permit`);
        expect(res.statusCode).toBe(200);
        // 250000 × (150000 + 30) gwei × 0.2 × 1.1 = 8.25165 → 8.26
        expect(res.json()).toMatchObject({ fee: '8260000', gasUnits: '250000', gasPrice: '150030000000000' });
    });

    it('rejects unsupported operations, tokens and modes, and malformed queries', async () => {
        expectError(await get(`/v1/fee?operation=example.open&token=${USDC}&authMode=permit`), 'unsupported_operation');
        expectError(await get(`/v1/fee?operation=transfer&token=${OTHER_ADDRESS}&authMode=permit`), 'unsupported_token');
        expectError(await get(`/v1/fee?operation=transfer&token=${USDC}&authMode=metaTxApprove`), 'unsupported_auth_mode');
        expectError(await get(`/v1/fee?operation=transfer&token=${USDC.toLowerCase()}&authMode=permit`), 'invalid_request');
        expectError(await get(`/v1/fee?operation=transfer&token=${USDC}&authMode=PERMIT`), 'invalid_request');
        expectError(await get(`/v1/fee?operation=transfer&token=${USDC}`), 'invalid_request');
        expectError(await get(`/v1/fee?operation=transfer&token=${USDC}&authMode=permit&x=1`), 'invalid_request');
        expectError(await get(`/v1/fee?operation=transfer&operation=transfer&token=${USDC}&authMode=permit`), 'invalid_request');
    });

    it('is unavailable when the chain cannot be reached', async () => {
        h.chain.rpcDown = true;
        expectError(await get(`/v1/fee?operation=transfer&token=${USDC}&authMode=permit`), 'unavailable');
    });
});

describe('POST /v1/transfer', () => {
    it('T32: 202 on first submit, 200 with the current state on an identical re-post, 409 conflict otherwise', async () => {
        const t = await transfer();
        const first = await post(t.body);
        expect(first.statusCode).toBe(202);
        expect(first.json()).toEqual({ id: t.id, status: 'queued' });
        const again = await post(t.body);
        expect(again.statusCode).toBe(200);
        expect(again.json()).toEqual({ id: t.id, status: 'queued' });
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        expect((await post(t.body)).json()).toEqual({ id: t.id, status: 'submitted' });
        const other = await transfer({ nonce: BigInt(t.body.request.nonce), amount: 2_000_000n });
        expectError(await post(other.body), 'conflict');
    });

    it('T32: 20 concurrent identical submits: exactly one 202, nineteen 200, one row', async () => {
        h.chain.latency = true;
        const t = await transfer();
        const results = await Promise.all(Array.from({ length: 20 }, () => post(t.body)));
        expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
        expect(results.filter((r) => r.statusCode === 200)).toHaveLength(19);
        for (const r of results) expect(r.json()).toEqual({ id: t.id, status: 'queued' });
        expect(h.store.countByStatus('queued')).toBe(1);
        // The submissions really raced: several passed every check before the first one was stored.
        expect(h.chain.calls.length).toBeGreaterThan(1);
    });

    it('T32: 20 concurrent conflicting submits (the sender\'s next nonce, different payloads): one 202, nineteen 409 conflict', async () => {
        h.chain.latency = true;
        const bodies = await Promise.all(Array.from({ length: 20 }, (_, i) => transfer({ nonce: 0n, amount: 1_000_000n + BigInt(i) })));
        const results = await Promise.all(bodies.map((b) => post(b.body)));
        expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
        const rejected = results.filter((r) => r.statusCode !== 202);
        expect(rejected).toHaveLength(19);
        for (const r of rejected) expectError(r, 'conflict');
        expect(h.store.countByStatus('queued')).toBe(1);
        expect(h.chain.calls.length).toBeGreaterThan(1); // the submissions raced: the atomic insert at step 9 decided
    });

    it('T32: another version of the payment stored while a submission reads the chain: conflict, not sender_busy', async () => {
        const first = await transfer({ nonce: 0n, amount: 1_000_000n });
        const second = await transfer({ nonce: 0n, amount: 2_000_000n });
        // `second` passes step 4 (nothing holds nonce 0 yet); at its first balance read (step 6) `first` is stored.
        const read = h.chain.readContract.bind(h.chain);
        let stored: ReturnType<typeof post> | undefined;
        h.chain.readContract = (async (call: Parameters<typeof read>[0]) => {
            if (stored === undefined && call.functionName === 'balanceOf') {
                stored = post(first.body);
                await stored;
            }
            return read(call);
        }) as typeof h.chain.readContract;
        const res = await post(second.body);
        expect((await stored!).statusCode).toBe(202);
        expectError(res, 'conflict');
        expect((res.json() as { error: { message: string } }).error.message).toContain(first.id);
    });

    it('T32: 20 concurrent submits of one sender at its next 20 nonces: one 202, nineteen nonce_too_high (nothing is queued ahead of the chain)', async () => {
        h.chain.latency = true;
        const bodies = await Promise.all(Array.from({ length: 20 }, (_, i) => transfer({ nonce: BigInt(i) })));
        const results = await Promise.all(bodies.map((b) => post(b.body)));
        expect(results.map((r) => r.statusCode === 202)).toEqual(Array.from({ length: 20 }, (_, i) => i === 0));
        for (const r of results.slice(1)) expectError(r, 'nonce_too_high');
        expect(h.store.countByStatus('queued')).toBe(1);
    });

    // A sender has one pending request at a time, so its queued requests cannot together exceed its balance (a second
    // one at the same nonce is a conflict).

    it('T31: enforces the 16 KB body limit with invalid_request', async () => {
        const t = await transfer();
        const json = JSON.stringify(t.body);
        const exact = json + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(json));
        expect(Buffer.byteLength(exact)).toBe(MAX_BODY_BYTES);
        const ok = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: exact, headers: { 'content-type': 'application/json' } });
        expect(ok.statusCode).toBe(202);
        const tooBig = await h.relay.app.inject({
            method: 'POST',
            url: '/v1/transfer',
            payload: `${exact} `,
            headers: { 'content-type': 'application/json' },
        });
        expectError(tooBig, 'invalid_request');
        expect(tooBig.json().error.message).toContain('16384');
    });

    it('T31: rejects unknown fields, other content types, invalid JSON and empty bodies with invalid_request', async () => {
        const t = await transfer();
        expectError(await post({ ...t.body, gasLimit: '1' }), 'invalid_request');
        expectError(await post({ ...t.body, request: { ...t.body.request, data: '0x' } }), 'invalid_request');
        const inject = (payload: string, contentType: string) =>
            h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload, headers: { 'content-type': contentType } });
        expectError(await inject(JSON.stringify(t.body), 'text/plain'), 'invalid_request');
        expectError(await inject(JSON.stringify(t.body), 'application/x-www-form-urlencoded'), 'invalid_request');
        expectError(await inject('{"request":', 'application/json'), 'invalid_request');
        expectError(await inject('', 'application/json'), 'invalid_request');
        expectError(await inject('{"__proto__":{"x":1}}', 'application/json'), 'invalid_request');
    });

    it('T31: maps every error code to the frozen HTTP status', async () => {
        const codes = Object.keys(ERROR_HTTP_STATUS) as ErrorCode[];
        const original = h.relay.pipeline.submit.bind(h.relay.pipeline);
        for (const code of codes) {
            h.relay.pipeline.submit = () => Promise.reject(new RelayError(code, `test ${code}`));
            expectError(await post({}), code);
            expect(toWireError(new RelayError(code, 'x'))).toEqual({ code, message: 'x' });
        }
        h.relay.pipeline.submit = original;
    });

    it('T31: returns a generic internal_error and logs it for unexpected failures', async () => {
        h.relay.pipeline.submit = () => Promise.reject(new TypeError('boom at /secret/path'));
        const res = await post({});
        expectError(res, 'internal_error');
        expect(res.json().error.message).toBe('internal error');
        expect(h.logs.text()).toContain('unhandled error');
    });
});

describe('GET /v1/requests/:id', () => {
    it('returns the request state as it moves through the transaction manager', async () => {
        const t = await transfer();
        await post(t.body);
        let res = await get(`/v1/requests/${t.id}`);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            id: t.id,
            operation: 'transfer',
            status: 'queued',
            request: t.body.request,
            authHash: tokenAuthHash(t.authorization),
            transactions: [],
            txHash: null,
            blockNumber: null,
            error: null,
        });
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        res = await get(`/v1/requests/${t.id.toUpperCase().replace('0X', '0x')}`);
        const submitted = res.json() as RequestState;
        expect(submitted.status).toBe('submitted');
        expect(submitted.transactions).toHaveLength(1);
        expect(submitted.transactions[0]).toMatchObject({ txNonce: 0, status: 'pending', maxFeePerGas: '90000000000' });
        expect(submitted.txHash).toBe(submitted.transactions[0]!.hash);
        h.chain.mine();
        await h.relay.txManager.tick();
        const mined = (await get(`/v1/requests/${t.id}`)).json() as RequestState;
        expect(mined).toMatchObject({ status: 'mined', txHash: submitted.txHash, blockNumber: h.chain.head.number.toString(), error: null });
    });

    it('404 not_found for unknown ids, 400 invalid_request for malformed ids', async () => {
        expectError(await get(`/v1/requests/0x${'12'.repeat(32)}`), 'not_found');
        expectError(await get('/v1/requests/0x1234'), 'invalid_request');
        expectError(await get('/v1/requests/abc'), 'invalid_request');
    });

    it('404 not_found for unknown routes and methods', async () => {
        expectError(await get('/v1/unknown'), 'not_found');
        expectError(await get('/v1/transfer'), 'not_found');
        expectError(await h.relay.app.inject({ method: 'DELETE', url: '/v1/info' }), 'not_found');
    });
});

// The relay has no CORS allowlist: self-hosted Wallet, Hub and Keyguard instances call it from their own origins.
describe('CORS', () => {
    it('answers every origin, without credentials', async () => {
        for (const origin of ['https://wallet.nimiq.com', 'https://wallet.self-hosted.example', 'http://localhost:8080']) {
            const res = await get('/v1/info', { headers: { origin } });
            expect(res.headers['access-control-allow-origin'], origin).toBe('*');
            expect(res.headers['access-control-allow-credentials'], origin).toBeUndefined();
            const preflight = await h.relay.app.inject({
                method: 'OPTIONS',
                url: '/v1/transfer',
                headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
            });
            expect(preflight.statusCode, origin).toBe(204);
            expect(preflight.headers['access-control-allow-origin'], origin).toBe('*');
            expect(String(preflight.headers['access-control-allow-methods'])).toContain('POST');
            expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain('content-type');
        }
    });
});

// The relay limits per signer, never per client address: the same signer is limited whatever address it sends from.
describe('rate limits', () => {
    it('T36: limits requests per signer across IPs', async () => {
        await h.close();
        h = await createHarness({ settings: { rateLimit: { signerMax: 2, signerWindowMs: 60_000 } } });
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        await h.relay.txManager.recover();
        // One pending request per sender: each is mined before the next nonce is submitted.
        const mined = async (): Promise<void> => {
            await h.relay.txManager.tick();
            h.chain.mine();
            await h.relay.txManager.tick();
        };
        expect((await post((await transfer({ mode: 'none' })).body, { remoteAddress: '10.0.0.1' })).statusCode).toBe(202);
        await mined();
        expect((await post((await transfer({ mode: 'none' })).body, { remoteAddress: '10.0.0.2' })).statusCode).toBe(202);
        await mined();
        expectError(await post((await transfer({ mode: 'none' })).body, { remoteAddress: '10.0.0.3' }), 'rate_limited');
    });
});

describe('health, readiness, metrics', () => {
    it('/healthz', async () => {
        const res = await get('/healthz');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok' });
    });

    // The harness prices with its fixed test price source.
    it('/readyz is ready with RPC, balance and price source OK (the harness test price)', async () => {
        // The public listener answers with the status only; the report is on the internal listener.
        const summary = await get('/readyz');
        expect(summary.statusCode).toBe(200);
        expect(summary.json()).toEqual({ ready: true, degraded: false });
        const res = await getOps('/readyz');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            ready: true,
            degraded: false,
            checks: {
                rpc: { ok: true, chainId: 137, blockNumber: '1000' },
                balance: { ok: true, wei: (10n ** 20n).toString(), minimumWei: (10n ** 18n).toString() },
                priceSource: { ok: true, source: 'chainlink', polUsd: '0.2', reason: null, feed: null },
                tokenDomains: { ok: true, mismatched: [], lastCheckAtMs: null, lastError: null },
                rpcHistory: { ok: true, window: '15924', failures: [], lastCheckAtMs: null },
            },
        });
    });

    it('/readyz is 503 when the relay POL balance is below the threshold or the RPC is down', async () => {
        h.chain.nativeBalances.set(RELAY_ADDRESS.toLowerCase(), 10n ** 18n - 1n);
        let res = await getOps('/readyz');
        expect(res.statusCode).toBe(503);
        expect(res.json().checks.balance.ok).toBe(false);
        // The public listener gives the same answer, without the report.
        const summary = await get('/readyz');
        expect(summary.statusCode).toBe(503);
        expect(summary.json()).toEqual({ ready: false, degraded: false });
        h.chain.nativeBalances.set(RELAY_ADDRESS.toLowerCase(), 10n ** 18n);
        h.clock.advance(5); // past the readiness cache
        expect((await get('/readyz')).statusCode).toBe(200);
        h.chain.rpcDown = true;
        h.clock.advance(5);
        res = await getOps('/readyz');
        expect(res.statusCode).toBe(503);
        expect(res.json().checks.rpc.ok).toBe(false);
        expect(JSON.stringify(res.json())).not.toContain('http');
    });

    // There is no static fallback price: a rejected feed makes pricing unavailable and the relay unready, with the
    // reason reported.
    it('readiness refuses a rejected Chainlink feed (no static fallback) and reports why', async () => {
        h.chain.feed = {
            address: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
            decimals: 8,
            answer: 11_210_000n,
            updatedAt: BigInt(h.clock.seconds() - 4000),
            description: 'MATIC / USD',
        };
        const priceSource = new ChainlinkPriceSource({ chain: h.chain, feed: h.chain.feed.address, clock: h.clock, cacheMs: 0 });
        const report = await checkReadiness({ ctx: h.relay.ctx, minBalanceWei: 1n, priceSource, clock: h.clock });
        expect(report.ready).toBe(false);
        expect(report.checks.priceSource).toEqual({
            ok: false,
            reason: 'Chainlink POL/USD unavailable: stale',
            feed: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
        });
        // A fresh round makes it ready again.
        h.chain.feed.updatedAt = BigInt(h.clock.seconds());
        const recovered = await checkReadiness({ ctx: h.relay.ctx, minBalanceWei: 1n, priceSource, clock: h.clock });
        expect(recovered.ready).toBe(true);
        expect(recovered.checks.priceSource).toMatchObject({ ok: true, source: 'chainlink', polUsd: '0.1121', reason: null });
    });

    it('readiness includes the transaction manager when configured', async () => {
        const notRecovered = await checkReadiness({
            ctx: h.relay.ctx,
            minBalanceWei: 1n,
            priceSource: { get: async () => ({ value: 1n, decimals: 0, source: 'chainlink', updatedAt: null, reason: null }), last: () => undefined, feed: null },
            clock: h.clock,
            txManager: h.relay.txManager,
        });
        expect(notRecovered.ready).toBe(false);
        expect(notRecovered.checks.txManager?.ok).toBe(false);
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        const ready = await checkReadiness({
            ctx: h.relay.ctx,
            minBalanceWei: 1n,
            priceSource: { get: async () => ({ value: 1n, decimals: 0, source: 'chainlink', updatedAt: null, reason: null }), last: () => undefined, feed: null },
            clock: h.clock,
            txManager: h.relay.txManager,
        });
        expect(ready.ready).toBe(true);
        h.clock.advance(3600);
        const stale = await checkReadiness({
            ctx: h.relay.ctx,
            minBalanceWei: 1n,
            priceSource: { get: async () => ({ value: 1n, decimals: 0, source: 'chainlink', updatedAt: null, reason: null }), last: () => undefined, feed: null },
            clock: h.clock,
            txManager: h.relay.txManager,
        });
        expect(stale.ready).toBe(false);
    });

    it('/metrics exposes requests by status/code, price source, balance and fee/gas counters', async () => {
        const t = await transfer();
        await post(t.body);
        await post({ bogus: true });
        await get('/v1/fee?operation=transfer&token=' + USDC + '&authMode=permit');
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        h.chain.mine();
        await h.relay.txManager.tick();
        // Only the internal listener serves /metrics.
        expect((await get('/metrics', { remoteAddress: '10.0.0.9' })).statusCode).toBe(404);
        const res = await h.relay.opsApp.inject({ method: 'GET', url: '/metrics' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/plain');
        const text = res.body;
        expect(text).toContain('relay_http_requests_total{method="POST",route="/v1/transfer",status_code="202",error_code=""} 1');
        expect(text).toContain('relay_http_requests_total{method="POST",route="/v1/transfer",status_code="400",error_code="invalid_request"} 1');
        // `chainlink` is the only price source (no `static` or `fallback`).
        expect(text).toContain('relay_price_source{source="chainlink"} 1');
        expect(text).not.toContain('source="fallback"');
        expect(text).toContain('relay_pol_usd 0.2');
        expect(text).toContain('relay_pol_balance 100');
        expect(text).toContain('relay_fee_revenue_usd_total{token="USDC"} 0.01');
        expect(text).toMatch(/relay_gas_cost_usd_total\{kind="call"\} [0-9.e-]+/);
        expect(text).toContain('relay_time_to_mine_seconds_count{operation="transfer"} 1');
        expect(text).toContain('relay_time_to_confirm_seconds');
        expect(text).toContain('relay_request_status_total{operation="transfer",status="mined"} 1');
    });
});

describe('T36: log hygiene over a full request', () => {
    it('never logs the intent signature, the token authorization, raw transactions or the relay key', async () => {
        const t = await transfer();
        await post(t.body);
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        h.chain.mine();
        await h.relay.txManager.tick();
        const logs = h.logs.text().toLowerCase();
        expect(logs.length).toBeGreaterThan(0);
        const auth = t.body.authorization as { r: string; s: string };
        for (const secret of [t.body.signature, auth.r, auth.s, ...h.chain.broadcasts]) {
            expect(logs).not.toContain(secret.slice(2).toLowerCase());
        }
        expect(logs).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
        // Request ids and tx hashes are logged (they are public).
        expect(logs).toContain(t.id.toLowerCase());
    });
});
