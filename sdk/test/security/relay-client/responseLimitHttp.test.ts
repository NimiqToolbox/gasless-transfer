// The RelayClient response size limit and its timeouts against a real HTTP server on 127.0.0.1 and Node's own
// fetch (undici), including compressed bodies, which fetch decompresses before the SDK counts the bytes. A relay
// URL is untrusted input: whatever answers there must not make the client buffer an unbounded body or wait forever.
//
// This is the WHATWG-stream path of a real fetch; test/relay/responseLimit.test.ts covers the body readers with
// scripted responses.

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, constants as zlibConstants, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayClient } from '../../../src/relay/client.js';
import { polygonPins } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';

const pins = polygonPins();
const LIMIT = 1_000_000;
/** 64 MiB of JSON whitespace: a few KB once compressed. */
const EXPANDED = 64 * 1024 * 1024;

interface Route {
    readonly handle: (req: IncomingMessage, res: ServerResponse) => void;
    /** Bytes of body the server managed to write before the client went away. */
    written: number;
}

/** Content codings fetch undoes by itself; "gzip, gzip" is two codings applied in turn. */
const CODINGS = ['gzip', 'br', 'deflate', 'gzip, gzip'] as const;
type Coding = (typeof CODINGS)[number];

describe('RelayClient response limit and timeouts over real HTTP', () => {
    let server: Server;
    let base: string;
    const routes = new Map<string, Route>();
    const info = Buffer.from(JSON.stringify(infoFor(pins)));
    // Built in beforeAll, so that a run filtered to other files does not pay for compressing 64 MiB.
    const encoded = {} as Record<Coding, Buffer>;

    function route(name: string, handle: (req: IncomingMessage, res: ServerResponse, self: Route) => void): string {
        const r: Route = { written: 0, handle: (req, res) => handle(req, res, r) };
        routes.set(`/${name}`, r);
        return `${base}/${name}`;
    }

    /** Writes `total` bytes of spaces in 64 KiB chunks, as fast as the socket takes them. */
    function stream(res: ServerResponse, self: Route, total: number): void {
        const chunk = Buffer.alloc(65_536, 0x20);
        const pump = () => {
            while (self.written < total && !res.destroyed) {
                self.written += chunk.length;
                if (!res.write(chunk)) {
                    res.once('drain', pump);
                    return;
                }
            }
            if (!res.destroyed) res.end();
        };
        res.on('close', () => undefined);
        pump();
    }

    async function failure(url: string, timeoutMs = 10_000): Promise<{ code: string | undefined; message: string; ms: number }> {
        const started = Date.now();
        const error = await new RelayClient(url, { pins, requestTimeoutMs: timeoutMs }).info().then(
            () => undefined,
            (e: unknown) => e as { code?: string; message: string },
        );
        expect(error, url).toBeDefined();
        return { code: error?.code, message: error?.message ?? '', ms: Date.now() - started };
    }

    beforeAll(async () => {
        const bomb = Buffer.alloc(EXPANDED, 0x20);
        encoded.gzip = gzipSync(bomb, { level: 9 });
        encoded.br = brotliCompressSync(bomb, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
        encoded.deflate = deflateSync(bomb, { level: 9 });
        encoded['gzip, gzip'] = gzipSync(encoded.gzip, { level: 9 });
        server = createServer((req, res) => {
            const prefix = `/${(req.url ?? '').split('/')[1] ?? ''}`;
            const r = routes.get(prefix);
            if (r === undefined) {
                res.statusCode = 404;
                res.end();
                return;
            }
            r.handle(req, res);
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
    });

    it.each(CODINGS)(
        'a compression bomb (%s, 64 MiB of JSON whitespace, a small Content-Length) is refused as too large, quickly',
        async (coding) => {
            const body = encoded[coding];
            const url = route(`bomb-${coding.replace(/[^a-z]/g, '')}`, (_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': coding, 'content-length': String(body.length) });
                res.end(body);
            });
            expect(body.length).toBeLessThan(LIMIT);
            const result = await failure(url);
            expect(result.code).toBe('invalid_response');
            expect(result.message).toMatch(/too large/);
            // Decompression stops at the limit; inflating all 64 MiB and parsing would take far longer.
            expect(result.ms).toBeLessThan(5_000);
        },
    );

    it('a compressed, valid /v1/info is accepted (the limit counts decompressed bytes, which are small here)', async () => {
        const body = gzipSync(info);
        const url = route('gzip-ok', (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) });
            res.end(body);
        });
        await expect(new RelayClient(url, { pins }).info()).resolves.toMatchObject({ chainId: 137 });
    });

    it('a declared Content-Length above the limit is refused without downloading the body', async () => {
        const total = 64 * 1024 * 1024;
        let self: Route | undefined;
        const url = route('declared', (_req, res, r) => {
            self = r;
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(total) });
            stream(res, r, total);
        });
        const result = await failure(url);
        expect(result.code).toBe('invalid_response');
        expect(result.message).toMatch(/too large/);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(self?.written ?? 0).toBeLessThan(total / 4);
    });

    it('a chunked body without Content-Length is cut off shortly after the limit', async () => {
        const total = 64 * 1024 * 1024;
        let self: Route | undefined;
        const url = route('chunked', (_req, res, r) => {
            self = r;
            res.writeHead(200, { 'content-type': 'application/json' });
            stream(res, r, total);
        });
        const result = await failure(url);
        expect(result.code).toBe('invalid_response');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(self?.written ?? 0).toBeLessThan(total / 4);
    });

    it('a body that trickles in after the headers is bounded by requestTimeoutMs (timeout, not a hang)', async () => {
        const url = route('trickle', (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"version":');
            const timer = setInterval(() => (res.destroyed ? clearInterval(timer) : res.write(' ')), 100);
            res.on('close', () => clearInterval(timer));
        });
        const result = await failure(url, 700);
        expect(result.code).toBe('timeout');
        expect(result.ms).toBeLessThan(3_000);
    });

    it('an error status with a compression bomb as body is refused as too large, not buffered', async () => {
        const body = encoded.gzip;
        const url = route('error-bomb', (_req, res) => {
            res.writeHead(503, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) });
            res.end(body);
        });
        const result = await failure(url);
        expect(result.code).toBe('invalid_response');
        expect(result.message).toMatch(/too large/);
    });
});
