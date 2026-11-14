// RelayClient's timeout and abort must hold whatever the injected fetch or the response body do: a transport that
// ignores AbortSignal, never settles or stalls while streaming must not keep a caller waiting.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayClient } from '../../../src/relay/client.js';
import { tokenAuthHash, transferDigest } from '../../../src/core/eip712.js';
import { NONE_AUTH, polygonPins, sampleRequest } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';

const pins = polygonPins();
const request = sampleRequest();
const id = transferDigest(pins.chainId, pins.transfer.address, request, NONE_AUTH);
const authHash = tokenAuthHash(NONE_AUTH);
const pending = () => new Promise<Response>(() => undefined);
const make = (fetch: (url: string, init: RequestInit) => Promise<Response>, requestTimeoutMs = 20) =>
    new RelayClient('https://relay.test', { pins, fetch, requestTimeoutMs });

// A watchdog makes a call that stays pending fail the test promptly instead of hanging the test process.
async function boundedResult(work: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            work.then(() => 'unexpected-success', (error: unknown) => (error as { code?: string; name?: string }).code ?? (error as Error).name),
            new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still-pending'), 300); }),
        ]);
    } finally { clearTimeout(timer!); }
}

afterEach(() => vi.restoreAllMocks());

describe('RelayClient bounds every call independently of its transport', () => {
    it('times out even when an injected fetch ignores AbortSignal', async () => {
        expect(await boundedResult(make(pending).info())).toBe('timeout');
    });

    it('aborts even when an injected fetch ignores AbortSignal', async () => {
        const controller = new AbortController();
        const result = boundedResult(make(pending, 10_000).info({ signal: controller.signal }));
        controller.abort();
        expect(await result).toBe('aborted');
    });

    it('bounds a polyfill text() read and destroys its body', async () => {
        const destroy = vi.fn();
        const response = { status: 200, headers: new Headers(), body: { destroy }, text: () => new Promise<string>(() => undefined) };
        expect(await boundedResult(make(async () => response as unknown as Response).info())).toBe('timeout');
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('cancels a stalled WHATWG reader without waiting for stream cleanup', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const response = new Response(new ReadableStream({ cancel }));
        expect(await boundedResult(make(async () => response).info())).toBe('timeout');
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('discards a response that arrives after timeout without reading or trusting it', async () => {
        let answer!: (response: Response) => void;
        const relay = make(() => new Promise((resolve) => { answer = resolve; }));
        expect(await boundedResult(relay.info())).toBe('timeout');
        const cancel = vi.fn();
        answer(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('does not overflow timers for a supported large timeout', async () => {
        const relay = make(async (_url, init) => {
            await new Promise<void>((resolve, reject) => {
                setTimeout(resolve, 15);
                init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            });
            return new Response(JSON.stringify(infoFor(pins)));
        }, 2_147_483_648);
        await expect(relay.info()).resolves.toMatchObject({ chainId: 137 });
    });

    it.each([0, -1, NaN, Infinity, 1.5])('rejects an invalid per-call timeout (%s) before fetching', async (timeoutMs) => {
        const fetch = vi.fn(pending);
        expect(await boundedResult(make(fetch).getRequest(id, { timeoutMs }))).toBe('TypeError');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('a second caller can abort shared info discovery without waiting for its owner', async () => {
        const relay = make(pending, 10_000);
        const firstController = new AbortController();
        const first = relay.fee({ token: request.token, authMode: 'permit' }, { signal: firstController.signal }).catch(() => undefined);
        const secondController = new AbortController();
        const second = boundedResult(relay.fee({ token: request.token, authMode: 'permit' }, { signal: secondController.signal }));
        secondController.abort();
        const result = await second;
        firstController.abort();
        // Observe the first promise without awaiting it: its transport ignores the abort.
        void first;
        expect(result).toBe('aborted');
    });

    it('poll timeout uses elapsed time despite a backward wall-clock correction', async () => {
        let clock = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => clock);
        const relay = make(async () => {
            clock -= 60_000;
            return new Response(JSON.stringify({ id, operation: 'transfer', status: 'queued', request, authHash,
                transactions: [], txHash: null, blockNumber: null, error: null }));
        });
        const controller = new AbortController();
        const result = await boundedResult(relay.waitForRequest(id, { timeoutMs: 30, pollIntervalMs: 5, signal: controller.signal }));
        controller.abort();
        expect(result).toBe('timeout');
    });
});
