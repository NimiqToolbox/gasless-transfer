// The two listeners and readiness: /metrics and the readiness report only on the internal listener, /readyz
// served from a single-flight cache, the transaction manager's health() and the token domain state in the
// report, and the server's timeouts and connection cap (configured values, and their effect on real sockets).
import { connect, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChainClient } from '../../src/chain/types.js';
import { DEFAULT_HTTP_LIMITS } from '../../src/config.js';
import { cachedReadiness, checkReadiness, type ReadinessReport } from '../../src/http/readiness.js';
import { USDT0, createHarness, type Harness, type HarnessOptions } from '../helpers/harness.js';

let h: Harness;
let rpcCalls = 0;

const COUNTED: ReadonlyArray<keyof ChainClient> = ['getChainId', 'getBlock', 'getBalance', 'readContract', 'call'];

async function setup(options: HarnessOptions = {}): Promise<void> {
    h = await createHarness(options);
    rpcCalls = 0;
    const chain = h.chain as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of COUNTED) {
        const original = chain[name]!.bind(h.chain);
        chain[name] = (...args: unknown[]) => {
            rpcCalls += 1;
            return original(...args);
        };
    }
}

beforeEach(async () => {
    await setup();
});

afterEach(async () => {
    await h.close();
});

// `chainlink` is the only kind of price source the relay has.
const staticPrice = {
    get: async () => ({ value: 1n, decimals: 0, source: 'chainlink' as const, updatedAt: null, reason: null }),
    last: () => undefined,
    feed: null,
};

describe('public and internal listener', () => {
    it('the public listener serves the API, /healthz and /readyz (status only), but no /metrics', async () => {
        expect((await h.relay.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
        const ready = await h.relay.app.inject({ method: 'GET', url: '/readyz' });
        expect(ready.statusCode).toBe(200);
        // No balance, error messages or transaction manager state on the public listener.
        expect(ready.json()).toEqual({ ready: true, degraded: false });
        expect((await h.relay.app.inject({ method: 'GET', url: '/v1/info' })).statusCode).toBe(200);
        const metrics = await h.relay.app.inject({ method: 'GET', url: '/metrics' });
        expect(metrics.statusCode).toBe(404);
        expect(metrics.body).not.toContain('relay_');
        // The internal listener has the whole report.
        const report = (await h.relay.opsApp.inject({ method: 'GET', url: '/readyz' })).json() as ReadinessReport;
        expect(report.checks.balance.wei).toBe((10n ** 20n).toString());
    });

    it('the internal listener serves /healthz, /readyz and /metrics, and nothing else', async () => {
        const ops = h.relay.opsApp;
        expect((await ops.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
        expect((await ops.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
        const metrics = await ops.inject({ method: 'GET', url: '/metrics' });
        expect(metrics.statusCode).toBe(200);
        expect(metrics.body).toContain('relay_pol_balance');
        expect(metrics.body).toContain('relay_token_domain_mismatch{token="USDT0"} 0');
        for (const url of ['/v1/info', '/v1/fee?operation=transfer', `/v1/requests/0x${'00'.repeat(32)}`]) {
            expect((await ops.inject({ method: 'GET', url })).statusCode).toBe(404);
        }
        expect((await ops.inject({ method: 'POST', url: '/v1/transfer', payload: {} })).statusCode).toBe(404);
    });

    it('the internal listener sends no CORS headers, and answers probes and scrapers without a limit', async () => {
        const ops = h.relay.opsApp;
        const res = await ops.inject({ method: 'GET', url: '/metrics', headers: { origin: 'https://wallet.nimiq.com' } });
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        // /healthz, /readyz and /metrics serve probes and scrapers: never limited.
        for (const url of ['/healthz', '/readyz', '/metrics']) {
            for (let i = 0; i < 3; i++) expect((await ops.inject({ method: 'GET', url })).statusCode, url).toBe(200);
        }
    });

    it('both listeners run with request/headers timeouts, a short keep-alive, an idle timeout and a connection cap', async () => {
        for (const app of [h.relay.app, h.relay.opsApp]) {
            expect(app.server.requestTimeout).toBe(DEFAULT_HTTP_LIMITS.requestTimeoutMs);
            expect(app.server.headersTimeout).toBe(DEFAULT_HTTP_LIMITS.headersTimeoutMs);
            expect(app.server.keepAliveTimeout).toBe(DEFAULT_HTTP_LIMITS.keepAliveTimeoutMs);
            expect(app.server.timeout).toBe(DEFAULT_HTTP_LIMITS.idleTimeoutMs);
            expect(app.server.maxConnections).toBe(DEFAULT_HTTP_LIMITS.maxConnections);
        }
        await h.close();
        const limits = { requestTimeoutMs: 5000, headersTimeoutMs: 4000, keepAliveTimeoutMs: 3000, idleTimeoutMs: 20_000, maxConnections: 7 };
        await setup({ settings: { httpLimits: limits } });
        expect(h.relay.app.server.requestTimeout).toBe(5000);
        expect(h.relay.app.server.headersTimeout).toBe(4000);
        expect(h.relay.app.server.keepAliveTimeout).toBe(3000);
        expect(h.relay.app.server.timeout).toBe(20_000);
        expect(h.relay.app.server.maxConnections).toBe(7);
    });
});

interface RawExchange {
    readonly response: string;
    /** ms from connecting until the server closed the connection; null if it was still open after `waitMs`. */
    readonly closedAfterMs: number | null;
}

/**
 * Opens a TCP connection to the relay, writes `data` and waits up to `waitMs` for the server to close it.
 * `localAddress` is the client address (Linux routes all of 127.0.0.0/8 to the loopback interface).
 */
function rawExchange(port: number, data: string, waitMs: number, localAddress = '127.0.0.1'): Promise<RawExchange> {
    return new Promise((resolve) => {
        const started = Date.now();
        let response = '';
        const socket = connect({ host: '127.0.0.1', port, localAddress }, () => socket.write(data));
        const timer = setTimeout(() => {
            socket.destroy();
            resolve({ response, closedAfterMs: null });
        }, waitMs);
        socket.on('data', (chunk: Buffer) => (response += chunk.toString()));
        socket.on('error', () => undefined); // a dropped connection may surface as ECONNRESET
        socket.on('close', () => {
            clearTimeout(timer);
            resolve({ response, closedAfterMs: Date.now() - started });
        });
    });
}

async function listenPublic(): Promise<number> {
    await h.relay.app.listen({ host: '127.0.0.1', port: 0 });
    return (h.relay.app.server.address() as AddressInfo).port;
}

describe('slow clients and the connection cap', () => {
    const limits = { requestTimeoutMs: 1500, headersTimeoutMs: 500, keepAliveTimeoutMs: 1000, idleTimeoutMs: 20_000, maxConnections: 2 };

    it('a client that never finishes its headers or its body gets 408 and is disconnected within the timeouts', async () => {
        await h.close();
        await setup({ settings: { httpLimits: { ...limits, maxConnections: 100 } } });
        const port = await listenPublic();
        const [slowHeaders, slowBody] = await Promise.all([
            rawExchange(port, 'GET /v1/info HTTP/1.1\r\nHost: relay\r\nX-Slow: 1\r\n', 10_000),
            rawExchange(port, 'POST /v1/transfer HTTP/1.1\r\nHost: relay\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"req', 10_000),
        ]);
        // Timeouts plus at most one connection sweep (1 s); without the limits both connections would stay open.
        for (const exchange of [slowHeaders, slowBody]) {
            expect(exchange.response).toMatch(/^HTTP\/1\.1 408 /);
            expect(exchange.closedAfterMs).not.toBeNull();
            expect(exchange.closedAfterMs!).toBeLessThan(4000);
        }
        // A complete request on a fresh connection is served normally.
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    });

    it('connections beyond maxConnections are closed as soon as they are accepted', async () => {
        await h.close();
        await setup({ settings: { httpLimits: limits } });
        const port = await listenPublic();
        // Two clients hold the two slots.
        const held = ['127.0.0.2', '127.0.0.3'].map((localAddress) => connect({ host: '127.0.0.1', port, localAddress }));
        for (const socket of held) socket.on('error', () => undefined);
        const until = Date.now() + 5000;
        while ((await connections()) < 2 && Date.now() < until) await sleep(10);
        expect(await connections()).toBe(2);

        const third = await rawExchange(port, 'GET /healthz HTTP/1.1\r\nHost: relay\r\n\r\n', 3000);
        expect(third.response).toBe('');
        expect(third.closedAfterMs).not.toBeNull();

        for (const socket of held) socket.destroy();
        while ((await connections()) > 0 && Date.now() < until + 5000) await sleep(10);
        const again = await rawExchange(port, 'GET /healthz HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n', 3000);
        expect(again.response).toMatch(/^HTTP\/1\.1 200 /);
    });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function connections(): Promise<number> {
    return new Promise<number>((resolve, reject) => h.relay.app.server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
}

describe('readiness cache', () => {
    it('50 concurrent probes and every probe within the cache period cost one set of RPC reads', async () => {
        const before = rpcCalls;
        const responses = await Promise.all(Array.from({ length: 50 }, () => h.relay.opsApp.inject({ method: 'GET', url: '/readyz' })));
        expect(responses.every((r) => r.statusCode === 200)).toBe(true);
        const oneCheck = rpcCalls - before;
        expect(oneCheck).toBe(3); // eth_chainId, eth_getBlockByNumber, eth_getBalance
        h.clock.advance(4);
        for (let i = 0; i < 20; i++) await h.relay.app.inject({ method: 'GET', url: '/readyz', remoteAddress: `10.0.0.${i}` });
        expect(rpcCalls - before).toBe(oneCheck);
        // After the cache period the report is fresh again.
        h.clock.advance(2);
        h.chain.mine();
        const fresh = (await h.relay.opsApp.inject({ method: 'GET', url: '/readyz' })).json() as ReadinessReport;
        expect(rpcCalls - before).toBe(2 * oneCheck);
        expect(fresh.checks.rpc.blockNumber).toBe('1001');
    });

    it('cachedReadiness shares a running check and caches for ttlMs; ttlMs 0 only shares', async () => {
        let runs = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const report = { ready: true, degraded: false, checks: {} } as unknown as ReadinessReport;
        const check = async () => {
            runs += 1;
            await gate;
            return report;
        };
        const cached = cachedReadiness(check, h.clock, 5000);
        const pending = [cached(), cached(), cached()];
        release();
        expect(await Promise.all(pending)).toEqual([report, report, report]);
        expect(runs).toBe(1);
        await cached();
        expect(runs).toBe(1);
        h.clock.advance(5);
        await cached();
        expect(runs).toBe(2);

        const uncached = cachedReadiness(check, h.clock, 0);
        await uncached();
        await uncached();
        expect(runs).toBe(4);
    });
});

describe('readiness contents', () => {
    it('is not ready when the transaction manager reports itself unhealthy, and lists the reasons', async () => {
        const txManager = {
            status: () => ({ recovered: true, lastTickAtMs: h.clock.nowMs(), lastTickError: null, lastPassAgeMs: 0 }),
            health: () => ({ ok: false, reasons: ['tx nonce gap at 7'] }),
        };
        const report = await checkReadiness({ ctx: h.relay.ctx, minBalanceWei: 1n, priceSource: staticPrice, clock: h.clock, txManager });
        expect(report.ready).toBe(false);
        expect(report.checks.txManager).toEqual({
            ok: false,
            recovered: true,
            lastTickAtMs: h.clock.nowMs(),
            lastTickError: null,
            reasons: ['tx nonce gap at 7'],
            degraded: [],
        });
        expect(report.degraded).toBe(false);
        const healthy = await checkReadiness({
            ctx: h.relay.ctx,
            minBalanceWei: 1n,
            priceSource: staticPrice,
            clock: h.clock,
            txManager: { ...txManager, health: () => ({ ok: true, reasons: [] }) },
        });
        expect(healthy.ready).toBe(true);
        expect(healthy.checks.txManager?.ok).toBe(true);
        // A transaction manager without health() is judged by recovery and tick liveness only.
        const legacy = await checkReadiness({
            ctx: h.relay.ctx,
            minBalanceWei: 1n,
            priceSource: staticPrice,
            clock: h.clock,
            txManager: { status: txManager.status },
        });
        expect(legacy.ready).toBe(true);
        expect(legacy.checks.txManager).not.toHaveProperty('reasons');
    });

    it("the transaction manager's degraded conditions (backlog, held at cap) make the relay degraded, not unready", async () => {
        const status = () => ({ recovered: true, lastTickAtMs: h.clock.nowMs(), lastTickError: null, lastPassAgeMs: 0 });
        const deps = { ctx: h.relay.ctx, minBalanceWei: 1n, priceSource: staticPrice, clock: h.clock };
        const busy = await checkReadiness({ ...deps, txManager: { status, health: () => ({ ok: true, reasons: [], degraded: ['backlog', 'held_at_cap'] }) } });
        expect(busy).toMatchObject({ ready: true, degraded: true });
        expect(busy.checks.txManager).toMatchObject({ ok: true, reasons: [], degraded: ['backlog', 'held_at_cap'] });
        // Degraded and unready are independent: a stalled relay with a backlog is both.
        const stalled = await checkReadiness({
            ...deps,
            txManager: { status, health: () => ({ ok: false, reasons: ['stalled'], degraded: ['backlog'] }) },
        });
        expect(stalled).toMatchObject({ ready: false, degraded: true });
        expect(stalled.checks.txManager).toMatchObject({ ok: false, reasons: ['stalled'], degraded: ['backlog'] });
        // Nothing degraded: not degraded.
        const idle = await checkReadiness({ ...deps, txManager: { status, health: () => ({ ok: true, reasons: [], degraded: [] }) } });
        expect(idle).toMatchObject({ ready: true, degraded: false });
    });

    it('the public /readyz answers only {ready, degraded}; the internal one lists the reasons', async () => {
        await h.close();
        await setup({ settings: { readinessIncludesTxManager: true, readinessCacheMs: 0 } });
        const health = { ok: false, reasons: ['stalled'], degraded: ['backlog'] };
        const txManager = h.relay.txManager as unknown as { health: () => typeof health; status: () => unknown };
        txManager.health = () => health;
        txManager.status = () => ({ recovered: true, lastTickAtMs: h.clock.nowMs(), lastTickError: null, lastPassAgeMs: 0 });
        const pub = await h.relay.app.inject({ method: 'GET', url: '/readyz' });
        expect(pub.statusCode).toBe(503);
        expect(pub.json()).toEqual({ ready: false, degraded: true });
        const internal = await h.relay.opsApp.inject({ method: 'GET', url: '/readyz' });
        expect(internal.statusCode).toBe(503);
        expect((internal.json() as ReadinessReport).checks.txManager).toMatchObject({ ok: false, reasons: ['stalled'], degraded: ['backlog'] });
        health.ok = true;
        health.reasons = [];
        const ready = await h.relay.app.inject({ method: 'GET', url: '/readyz' });
        expect(ready.statusCode).toBe(200);
        expect(ready.json()).toEqual({ ready: true, degraded: true });
    });

    it('a token whose domain changed makes the relay degraded, but still ready (200)', async () => {
        h.chain.token(USDT0).domainSeparator = `0x${'ab'.repeat(32)}`;
        await h.relay.tokenDomains.check();
        const res = await h.relay.opsApp.inject({ method: 'GET', url: '/readyz' });
        expect(res.statusCode).toBe(200);
        const report = res.json() as ReadinessReport;
        expect(report.ready).toBe(true);
        expect(report.degraded).toBe(true);
        expect(report.checks.tokenDomains).toMatchObject({ ok: false, mismatched: ['USDT0'], lastError: null });
    });
});
