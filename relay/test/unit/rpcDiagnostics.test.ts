// Classified RPC failures and per-RPC request statistics: only closed-set reasons, positions and numeric codes leave
// the chain client; URLs and provider text never do.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError, toHex, type Address, type Hex } from 'viem';
import { classifyRpcFailure, createViemChainClient, type RpcRequestEvent } from '../../src/chain/viemChainClient.js';
import { createMetrics } from '../../src/metrics.js';
import { RpcUsage } from '../../src/ops/rpcUsage.js';
import { captureLogger } from '../helpers/harness.js';

const SECRET_URL = 'https://rpc.example/v2/secret-key-123';
const rpcError = (code: number, message: string) => new RpcRequestError({ body: { method: 'eth_call' }, error: { code, message }, url: SECRET_URL });

describe('classifyRpcFailure', () => {
    it.each([
        ['a rate-limiting provider', rpcError(-32029, 'Too Many Requests'), { reason: 'rate_limited', rpcCode: -32029 }],
        ['EIP-1474 limit exceeded', new LimitExceededRpcError(rpcError(-32005, 'limit exceeded')), { reason: 'rate_limited', rpcCode: -32005 }],
        ['rate limit wording in a generic code', rpcError(-32000, 'daily request limit reached'), { reason: 'rate_limited', rpcCode: -32000 }],
        ['another JSON-RPC error', rpcError(-32000, 'upstream overloaded'), { reason: 'rpc_error', rpcCode: -32000 }],
        ['HTTP 429', new HttpRequestError({ url: SECRET_URL, status: 429 }), { reason: 'rate_limited', httpStatus: 429 }],
        ['another HTTP status', new HttpRequestError({ url: SECRET_URL, status: 503 }), { reason: 'http_status', httpStatus: 503 }],
        ['no HTTP answer', new HttpRequestError({ url: SECRET_URL, cause: new Error(`connect ECONNREFUSED ${SECRET_URL}`) }), { reason: 'network' }],
        ['a timeout', new TimeoutError({ body: {}, url: SECRET_URL }), { reason: 'timeout' }],
        ['a non-viem error', new Error(`request to ${SECRET_URL} failed`), { reason: 'other' }],
        ['a thrown string', SECRET_URL, { reason: 'other' }],
    ])('%s', (_name, err, expected) => {
        // Exactly these fields: nothing of the error's text or URL.
        expect(classifyRpcFailure(err)).toEqual(expected);
    });
});

type Answer = { result: unknown } | { error: { code: number; message: string } } | { status: number };

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
        server.close();
        server.closeAllConnections();
        await once(server, 'close').catch(() => undefined);
    }));
});

/** A JSON-RPC endpoint on 127.0.0.1 that answers every call with `answer(method)`. */
async function fakeRpc(answer: (method: string) => Answer): Promise<string> {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string };
            const out = answer(call.method);
            if ('status' in out) {
                res.writeHead(out.status).end();
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...out }));
        });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/secret-key-123`;
}

const block = (number: number) => ({
    number: toHex(number),
    hash: toHex(number, { size: 32 }),
    parentHash: toHex(number - 1, { size: 32 }),
    timestamp: toHex(1_700_000_000 + number * 2),
    baseFeePerGas: '0x1',
    transactions: [],
});
const TOKEN: Address = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const SLOT: Hex = `0x${'01'.repeat(32)}`;

describe('per-RPC request statistics', () => {
    it('reports every request under its RPC position with the classified outcome and head, and logs a summary without URLs', async () => {
        const first = await fakeRpc((method) =>
            method === 'eth_getStorageAt' ? { error: { code: -32029, message: `Too Many Requests ${SECRET_URL}` } }
                : method === 'eth_getBlockByNumber' ? { result: block(20) } : { result: '0x89' });
        const second = await fakeRpc((method) =>
            method === 'eth_getStorageAt' ? { status: 503 } : method === 'eth_getBlockByNumber' ? { result: block(16) } : { result: '0x89' });
        const events: RpcRequestEvent[] = [];
        const chain = createViemChainClient({ rpcUrls: [first, second], timeoutMs: 2000, onRequest: (event) => events.push(event) });
        const [one, two] = chain.rpcClients!();
        await one!.getBlock('latest');
        await two!.getBlock('latest');
        await expect(one!.getStorageAt!(TOKEN, SLOT, 16n)).rejects.toThrow();
        await expect(two!.getStorageAt!(TOKEN, SLOT, 16n)).rejects.toThrow();
        expect(await chain.getChainId()).toBe(137);
        expect(events.map(({ rpc, method, outcome, head }) => ({ rpc, method, outcome, head }))).toEqual([
            { rpc: 1, method: 'eth_getBlockByNumber', outcome: 'ok', head: 20n },
            { rpc: 2, method: 'eth_getBlockByNumber', outcome: 'ok', head: 16n },
            { rpc: 1, method: 'eth_getStorageAt', outcome: 'rate_limited', head: undefined },
            // viem's retry of the 503 is part of the one request.
            { rpc: 2, method: 'eth_getStorageAt', outcome: 'http_status', head: undefined },
            { rpc: 1, method: 'eth_chainId', outcome: 'ok', head: undefined },
        ]);
        expect(events.every((event) => event.durationMs >= 0)).toBe(true);

        const logs = captureLogger();
        const metrics = createMetrics();
        const usage = new RpcUsage({ logger: logs.logger, metrics, rpcCount: 2 });
        for (const event of events) usage.record(event);
        usage.flush();
        usage.flush();
        const [summary, quiet] = logs.lines.map((line) => JSON.parse(line) as { msg: string; rpcs: unknown[] });
        expect(summary!.msg).toBe('rpc usage');
        expect(summary!.rpcs).toEqual([
            { rpc: 1, requests: 3, failed: 1, failures: { rate_limited: 1 }, p50Ms: expect.any(Number), p95Ms: expect.any(Number), maxMs: expect.any(Number), head: '20', maxLagBlocks: null },
            { rpc: 2, requests: 2, failed: 1, failures: { http_status: 1 }, p50Ms: expect.any(Number), p95Ms: expect.any(Number), maxMs: expect.any(Number), head: '16', maxLagBlocks: 4 },
        ]);
        expect(quiet!.rpcs).toEqual([
            { rpc: 1, requests: 0, failed: 0, failures: {}, p50Ms: null, p95Ms: null, maxMs: null, head: '20', maxLagBlocks: null },
            { rpc: 2, requests: 0, failed: 0, failures: {}, p50Ms: null, p95Ms: null, maxMs: null, head: '16', maxLagBlocks: null },
        ]);
        expect(logs.text()).not.toMatch(/127\.0\.0\.1|secret-key|Too Many/);
        const scraped = await metrics.registry.metrics();
        expect(scraped).toContain('relay_rpc_requests_total{rpc="1",method="eth_getStorageAt",outcome="rate_limited"} 1');
        expect(scraped).toContain('relay_rpc_requests_total{rpc="2",method="eth_getBlockByNumber",outcome="ok"} 1');
        expect(scraped).toContain('relay_rpc_head_lag_blocks{rpc="2"} 4');
        expect(scraped).toContain('relay_rpc_request_duration_seconds_count{rpc="1"} 3');
    });

    describe('head lag', () => {
        const head = (rpc: number, number: bigint): RpcRequestEvent => ({ rpc, method: 'eth_blockNumber', durationMs: 1, outcome: 'ok', head: number });
        const setup = () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const metrics = createMetrics();
            const usage = new RpcUsage({ logger: captureLogger().logger, metrics, rpcCount: 2 });
            return { usage, lag: async () => Object.fromEntries((await metrics.rpcHeadLag.get()).values.map((v) => [v.labels.rpc, v.value])) };
        };
        afterEach(() => vi.useRealTimers());

        it('an RPC asked for its head less often than another does not show the blocks in between as its lag', async () => {
            const { usage, lag } = setup();
            usage.record(head(1, 100n));
            usage.record(head(2, 100n));
            // The passes read the first RPC's head every two seconds; the second one is asked again a minute later.
            for (let block = 101n; block <= 130n; block++) {
                vi.advanceTimersByTime(2000);
                usage.record(head(1, block));
            }
            expect(await lag()).toEqual({ '1': 0, '2': 0 });
            usage.record(head(2, 130n));
            expect(await lag()).toEqual({ '1': 0, '2': 0 });
        });

        it('an RPC whose head is behind one another RPC reported just before shows the difference, until it reports again', async () => {
            const { usage, lag } = setup();
            usage.record(head(1, 130n));
            usage.record(head(2, 100n));
            expect((await lag())['2']).toBe(30);
            vi.advanceTimersByTime(60_000);
            usage.record(head(1, 160n));
            expect((await lag())['2']).toBe(30);
            usage.record(head(2, 160n));
            expect((await lag())['2']).toBe(0);
        });

        it('a first RPC that stands still shows its lag once another RPC reports, and keeps it', async () => {
            const { usage, lag } = setup();
            usage.record(head(1, 100n));
            vi.advanceTimersByTime(2000);
            usage.record(head(2, 130n));
            vi.advanceTimersByTime(2000);
            usage.record(head(1, 100n));
            expect(await lag()).toEqual({ '1': 30, '2': 0 });
            vi.advanceTimersByTime(60_000);
            usage.record(head(1, 100n));
            expect((await lag())['1']).toBe(30);
        });
    });
});
