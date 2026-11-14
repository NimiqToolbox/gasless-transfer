// RelayClient enforces its response size limit (1,000,000 bytes) while reading, not after buffering the
// whole body. A declared Content-Length above the limit is refused without reading the body; a streamed
// body is cancelled as soon as it passes the limit. (The request timeout bounds every call as well; the
// size limit bounds what a hostile relay URL can make the client buffer within that time.)
// A fetch whose body is not a WHATWG stream (node-fetch, cross-fetch on Node, React Native) cannot be
// read chunk by chunk: it is read with text() and its size checked afterwards.

import { describe, expect, it, vi } from 'vitest';
import { RelayClient } from '../../src/relay/client.js';
import { RelayClientError } from '../../src/relay/errors.js';
import { polygonPins } from '../helpers/fixtures.js';
import { infoFor } from '../helpers/relay.js';

const BASE = 'https://relay.test';
const LIMIT = 1_000_000;
const CHUNK = 65_536;
const pins = polygonPins();

interface StreamStats {
    /** Chunks handed to the reader. */
    pulled: number;
    cancelled: boolean;
}

/** A body of `chunks` chunks of `CHUNK` spaces, produced only on demand (highWaterMark 0). */
function streamedBody(chunks: number, stats: StreamStats): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                if (stats.pulled === chunks) {
                    controller.close();
                    return;
                }
                stats.pulled += 1;
                controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
            },
            cancel() {
                stats.cancelled = true;
            },
        },
        { highWaterMark: 0 },
    );
}

function relayAnswering(response: () => Response): RelayClient {
    const fetch = vi.fn(async () => response());
    return new RelayClient(BASE, { pins, fetch, requestTimeoutMs: 10_000 });
}

async function infoError(relay: RelayClient): Promise<RelayClientError> {
    const error = await relay.info().then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RelayClientError);
    return error as RelayClientError;
}

/** A valid /v1/info padded with JSON whitespace to exactly `bytes` bytes. */
function paddedInfo(bytes: number): string {
    const json = JSON.stringify(infoFor(pins));
    return json + ' '.repeat(bytes - json.length);
}

describe('RelayClient response size limit', () => {
    it('refuses a Content-Length above the limit without reading the body', async () => {
        const stats: StreamStats = { pulled: 0, cancelled: false };
        const relay = relayAnswering(() => new Response(streamedBody(64, stats), { status: 200, headers: { 'content-length': String(64 * CHUNK) } }));
        const error = await infoError(relay);
        expect(error.code).toBe('invalid_response');
        expect(error.message).toMatch(/too large/);
        expect(stats.pulled).toBe(0);
        expect(stats.cancelled).toBe(true);
    });

    it('stops reading a streamed body as soon as it passes the limit and cancels the stream', async () => {
        const stats: StreamStats = { pulled: 0, cancelled: false };
        // 64 chunks = 4 MiB, no Content-Length (chunked transfer encoding).
        const relay = relayAnswering(() => new Response(streamedBody(64, stats), { status: 200 }));
        const error = await infoError(relay);
        expect(error.code).toBe('invalid_response');
        expect(error.message).toMatch(/too large/);
        // The 16th chunk takes the body to 1,048,576 bytes, past the limit: nothing after it is read.
        expect(stats.pulled).toBe(Math.ceil((LIMIT + 1) / CHUNK));
        expect(stats.cancelled).toBe(true);
    });

    it('applies the limit to the error bodies of failed requests too', async () => {
        const stats: StreamStats = { pulled: 0, cancelled: false };
        const relay = relayAnswering(() => new Response(streamedBody(64, stats), { status: 503 }));
        const error = await infoError(relay);
        expect(error.code).toBe('invalid_response');
        expect(error.status).toBe(503);
        expect(stats.pulled).toBe(Math.ceil((LIMIT + 1) / CHUNK));
    });

    it('accepts a body of exactly the limit and refuses one byte more (streamed and with Content-Length)', async () => {
        const exact = paddedInfo(LIMIT);
        const bytes = new TextEncoder().encode(exact);
        const chunked = (body: Uint8Array) =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let offset = 0; offset < body.length; offset += CHUNK) controller.enqueue(body.slice(offset, offset + CHUNK));
                    controller.close();
                },
            });
        await expect(relayAnswering(() => new Response(chunked(bytes), { status: 200 })).info()).resolves.toMatchObject({ chainId: 137 });
        await expect(relayAnswering(() => new Response(exact, { status: 200, headers: { 'content-length': String(LIMIT) } })).info()).resolves.toMatchObject({
            chainId: 137,
        });

        const tooLong = new TextEncoder().encode(`${exact} `);
        expect((await infoError(relayAnswering(() => new Response(chunked(tooLong), { status: 200 })))).message).toMatch(/too large/);
        expect(
            (await infoError(relayAnswering(() => new Response(tooLong, { status: 200, headers: { 'content-length': String(LIMIT + 1) } })))).message,
        ).toMatch(/too large/);
    });

    it('counts bytes, not characters', async () => {
        // 400,000 three-byte characters: 400,002 characters of JSON, but 1,200,002 bytes.
        const relay = relayAnswering(() => new Response(JSON.stringify('€'.repeat(400_000)), { status: 200 }));
        expect((await infoError(relay)).message).toMatch(/too large/);
    });

    it('ignores a malformed Content-Length and still counts the bytes it reads', async () => {
        const stats: StreamStats = { pulled: 0, cancelled: false };
        const relay = relayAnswering(() => new Response(streamedBody(64, stats), { status: 200, headers: { 'content-length': '12, 12' } }));
        expect((await infoError(relay)).message).toMatch(/too large/);
        expect(stats.pulled).toBe(Math.ceil((LIMIT + 1) / CHUNK));
    });
});

describe('fetch implementations without a WHATWG body stream', () => {
    /**
     * The shape node-fetch and cross-fetch on Node return (WHATWG headers and text(), but `body` is a
     * Node.js stream without getReader), React Native's (no `body`), or a polyfill's (`body` null).
     */
    function nodeStyleResponse(text: string, body: unknown, headers: Record<string, string> = {}) {
        const read = vi.fn(async () => text);
        const response = { status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json', ...headers }), body, text: read };
        return { response: response as unknown as Response, read };
    }

    function destroyable() {
        return { destroy: vi.fn(), pipe: vi.fn(), on: vi.fn() };
    }

    it.each([
        ['a Node.js stream (node-fetch, cross-fetch)', () => destroyable()],
        ['no body property (React Native)', () => undefined],
        ['a null body with text() (fetch polyfills)', () => null],
    ])('reads %s with text(): info() resolves', async (_name, body) => {
        const json = JSON.stringify(infoFor(pins));
        const { response, read } = nodeStyleResponse(json, body(), { 'content-length': String(json.length) });
        await expect(relayAnswering(() => response).info()).resolves.toMatchObject({ chainId: 137 });
        expect(read).toHaveBeenCalledOnce();
    });

    it('checks the size after text(): one byte over the limit is refused as too large, the limit itself is accepted', async () => {
        const exact = paddedInfo(LIMIT);
        await expect(relayAnswering(() => nodeStyleResponse(exact, destroyable()).response).info()).resolves.toMatchObject({ chainId: 137 });
        const error = await infoError(relayAnswering(() => nodeStyleResponse(`${exact} `, destroyable()).response));
        expect(error.code).toBe('invalid_response');
        expect(error.message).toMatch(/too large/);
        // Bytes, not characters.
        expect((await infoError(relayAnswering(() => nodeStyleResponse(JSON.stringify('€'.repeat(400_000)), undefined).response))).message).toMatch(/too large/);
    });

    it('refuses a Content-Length above the limit without reading, and destroys a Node.js stream body', async () => {
        const body = destroyable();
        const { response, read } = nodeStyleResponse('{}', body, { 'content-length': String(LIMIT + 1) });
        const error = await infoError(relayAnswering(() => response));
        expect(error.message).toMatch(/too large/);
        expect(read).not.toHaveBeenCalled();
        expect(body.destroy).toHaveBeenCalledOnce();
        // A body whose cleanup throws still yields the size error, not a network error.
        const throwing = nodeStyleResponse('{}', { destroy: () => { throw new Error('boom'); } }, { 'content-length': String(LIMIT + 1) });
        expect((await infoError(relayAnswering(() => throwing.response))).message).toMatch(/too large/);
    });
});
