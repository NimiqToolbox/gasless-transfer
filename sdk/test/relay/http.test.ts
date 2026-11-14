// RelayClient with the real Node fetch (undici) against a local HTTP server inside the container:
// the request options (redirect: "error", credentials, cache) are accepted, redirects are refused
// so that a signed body can only reach the configured relay URL, and an endless body is cut off at
// the size limit (the connection is dropped instead of reading on).

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayClient } from '../../src/relay/client.js';
import { RelayApiError, RelayClientError } from '../../src/relay/errors.js';
import { polygonPins } from '../helpers/fixtures.js';
import { infoFor } from '../helpers/relay.js';

const pins = polygonPins();
let server: Server;
let base: string;
const seen: Array<{ method: string; url: string; headers: Record<string, unknown> }> = [];

/** The /huge route streams up to 64 MiB without a Content-Length, as fast as the client reads. */
const HUGE_TOTAL = 64 * 1024 * 1024;
const huge = { written: 0, done: Promise.resolve({ written: 0, finished: true }) };

beforeAll(async () => {
    server = createServer((req, res) => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
        if (req.url === '/v1/info') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(infoFor(pins)));
        } else if (req.url === '/huge/v1/info') {
            res.writeHead(200, { 'content-type': 'application/json' });
            const chunk = Buffer.alloc(65_536, 0x20);
            let open = true;
            huge.written = 0;
            huge.done = new Promise((resolve) => {
                res.on('close', () => {
                    open = false;
                    resolve({ written: huge.written, finished: res.writableFinished });
                });
            });
            const pump = () => {
                while (open && huge.written < HUGE_TOTAL) {
                    huge.written += chunk.length;
                    if (!res.write(chunk)) {
                        res.once('drain', pump);
                        return;
                    }
                }
                if (open) res.end();
            };
            pump();
        } else if (req.url?.startsWith('/moved/')) {
            res.writeHead(307, { location: req.url.slice('/moved'.length) });
            res.end();
        } else {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'not_found', message: 'unknown request' } }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

describe('RelayClient over real HTTP', () => {
    it('verifies /v1/info with the global fetch', async () => {
        const info = await new RelayClient(base, { pins }).info();
        expect(info.relay).toBe(pins.relays[0]);
        const last = seen.at(-1);
        expect(last).toMatchObject({ method: 'GET', url: '/v1/info' });
        expect(last?.headers.cookie).toBeUndefined();
    });

    it('maps a JSON error response to RelayApiError', async () => {
        const error = await new RelayClient(base, { pins }).getRequest(`0x${'00'.repeat(32)}`).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RelayApiError);
        expect((error as RelayApiError).code).toBe('not_found');
        expect((error as RelayApiError).status).toBe(404);
    });

    it('refuses to follow redirects', async () => {
        const before = seen.length;
        const error = await new RelayClient(`${base}/moved`, { pins }).info().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RelayClientError);
        expect((error as RelayClientError).code).toBe('network_error');
        expect(seen.slice(before).map((r) => r.url)).toEqual(['/moved/v1/info']);
    });

    it('drops the connection of an endless body once it passes the size limit', async () => {
        const error = await new RelayClient(`${base}/huge`, { pins, requestTimeoutMs: 20_000 }).info().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RelayClientError);
        expect((error as RelayClientError).code).toBe('invalid_response');
        expect((error as RelayClientError).message).toMatch(/too large/);
        const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000));
        const result = await Promise.race([huge.done, timeout]);
        // The client read about 1 MB and closed the connection; what the server wrote on top of that sat
        // in socket buffers. Reading the whole body would have taken all 64 MiB.
        expect(result).not.toBe('timeout');
        expect(result).toMatchObject({ finished: false });
        expect((result as { written: number }).written).toBeLessThan(HUGE_TOTAL / 2);
    });
});
