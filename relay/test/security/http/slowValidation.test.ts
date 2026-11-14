// When validation is slow, the client gets an answer, and a request is never stored after its answer is gone.
//
// The HTTP server closes a connection without traffic in either direction for 60 s
// (DEFAULT_HTTP_LIMITS.idleTimeoutMs). The timer also runs while the relay is still validating a POST
// /v1/transfer: no bytes flow then. One RPC read can take long: RELAY_RPC_TIMEOUT_MS goes up to 120 s, and with two
// or more RELAY_RPC_URLS viem's fallback transport tries every URL in turn and retries the round. If validation
// outlasted the idle timeout, the relay would destroy the client's socket without an answer, keep validating and
// store the request as queued: it would be broadcast and executed while the wallet only saw a network error. A
// wallet that then signs the transfer again with a new nonce makes the user pay twice.
//
// So all RPC reads of one submission share one deadline (src/pipeline/pipeline.ts), RELAY_VALIDATION_TIMEOUT_MS
// (default 10 s, at most the idle timeout minus 5 s, or minus a third of it if that is shorter). When it passes,
// the answer is 503 `unavailable` (nothing was stored, retry the same request) and nothing is stored. A client that
// closes its connection during validation aborts it: the request is not stored once nobody can receive the answer.
// The deadline is checked again right before the synchronous insert.
//
// The test shortens the idle timeout to 1.5 s (so the deadline is 1 s) and delays every contract read by
// 1 s instead of waiting for minutes; the timing relation is the same.
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadContractCall } from '../../../src/chain/types.js';
import { DEFAULT_HTTP_LIMITS } from '../../../src/config.js';
import { buildTransfer, createHarness, USDC, type Harness } from '../../helpers/harness.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A relay whose contract reads each take `delayMs` (a slow or failing-over RPC), with a 1.5 s idle timeout. */
async function slowRelay(delayMs: number): Promise<number> {
    h = await createHarness({ settings: { httpLimits: { ...DEFAULT_HTTP_LIMITS, idleTimeoutMs: 1500 } } });
    const chain = h.chain;
    const readContract = chain.readContract.bind(chain);
    chain.readContract = async <T>(call: ReadContractCall): Promise<T> => {
        await sleep(delayMs);
        return readContract<T>(call);
    };
    await h.relay.app.listen({ host: '127.0.0.1', port: 0 });
    return (h.relay.app.server.address() as AddressInfo).port;
}

/**
 * POSTs `body` on a raw socket; returns the raw answer ('' if the relay closed without one). With
 * `closeAfterMs`, the client closes the connection itself after that time.
 */
function post(port: number, body: unknown, waitMs = 10_000, closeAfterMs?: number): Promise<string> {
    const json = JSON.stringify(body);
    return new Promise((resolve) => {
        let response = '';
        const socket = connect({ host: '127.0.0.1', port }, () =>
            socket.write(
                `POST /v1/transfer HTTP/1.1\r\nHost: relay\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
            ),
        );
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(response);
        }, waitMs);
        if (closeAfterMs !== undefined) setTimeout(() => socket.destroy(), closeAfterMs);
        socket.on('data', (chunk: Buffer) => (response += chunk.toString()));
        socket.on('error', () => undefined);
        socket.on('close', () => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

describe('control: validation within the idle timeout', () => {
    it('a submission whose reads take 100 ms each is answered 202', async () => {
        const port = await slowRelay(100);
        const t = await buildTransfer(h!, { token: USDC, mode: 'permit' });
        expect(await post(port, t.body)).toMatch(/^HTTP\/1\.1 202 /);
    });
});

describe('validation slower than the idle timeout', () => {
    it('the client gets an answer (or the request is not stored) when validation outlasts the idle timeout', async () => {
        const port = await slowRelay(1000);
        const t = await buildTransfer(h!, { token: USDC, mode: 'permit' });
        const answer = await post(port, t.body);
        // Let the reads that were still running finish.
        await sleep(3000);
        const stored = h!.store.getRequest(t.id);
        console.log(`HTTP answer ${JSON.stringify(answer.slice(0, 40))}; stored request status ${stored?.status ?? 'none'}`);
        // Consistent outcomes: the client learns the result, or nothing was accepted behind its back.
        expect(answer === '' && stored !== undefined, 'the connection was closed without an answer, but the transfer was accepted').toBe(false);
    });

    it('the answer is 503 unavailable, before the idle timeout, and nothing is stored', async () => {
        const port = await slowRelay(1000);
        const t = await buildTransfer(h!, { token: USDC, mode: 'permit' });
        const started = Date.now();
        const answer = await post(port, t.body);
        const answeredAfterMs = Date.now() - started;
        expect(answer).toMatch(/^HTTP\/1\.1 503 /);
        expect(answer).toContain('"code":"unavailable"');
        expect(answer).toContain('nothing was stored');
        expect(answeredAfterMs).toBeLessThan(1500);
        await sleep(3000);
        expect(h!.store.getRequest(t.id)).toBeUndefined();
        expect(h!.store.countRequests()).toBe(0);
        // The same request, sent again once the chain answers in time, is accepted.
        const chain = h!.chain as unknown as { readContract: unknown };
        delete chain.readContract;
        expect(await post(port, t.body)).toMatch(/^HTTP\/1\.1 202 /);
        expect(h!.store.getRequest(t.id)?.status).toBe('queued');
    });

    it('a client that closes its connection during validation gets nothing stored', async () => {
        // Reads of 300 ms: the whole validation (about 1 s) fits the deadline, but the client leaves after 400 ms.
        const port = await slowRelay(300);
        const t = await buildTransfer(h!, { token: USDC, mode: 'permit' });
        expect(await post(port, t.body, 10_000, 400)).toBe('');
        await sleep(2000);
        expect(h!.store.getRequest(t.id)).toBeUndefined();
        expect(h!.logs.text()).toContain('client disconnected during validation; nothing stored');
    });
});
