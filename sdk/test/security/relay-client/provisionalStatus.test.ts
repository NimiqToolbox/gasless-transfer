// How the relay client reads what a relay reports, and what it needs from its environment.
//
// - A "failed" or "expired" status of a request that was broadcast is provisional. The relay decides these by an
//   inclusion and may still turn them into "mined" until the block is final (spec §6.5,
//   relay/docs/transaction-lifecycle.md "States"). A wallet that took such a status as the end would let the user
//   sign again with a new nonce; if the first request is mined after all, the user pays twice. So waitForRequest
//   keeps polling until the deadline plus a settle margin, unless nothing was broadcast.
// - RelayApiError.retryable is true for sender_busy and nonce_too_high, the 409s of spec §6.3 that the relay asks
//   to retry once the pending request is mined.
// - A fetch whose Response.body is a Node.js stream instead of a WHATWG stream (node-fetch, cross-fetch on Node)
//   has no body.getReader(): such a body is read with text() and its size checked afterwards.
// - The caller's fee ceiling is part of the core entry point, so core-only callers (the browser IIFE global
//   NimiqGaslessCore) can use it.
//
// More on each: test/relay/client.test.ts (waitForRequest, http://), test/relay/responseLimit.test.ts (body
// readers), test/core/intent.test.ts and test/core/validate.test.ts (the fee ceiling), test/dist.test.ts (the IIFE).

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as core from '../../../src/core/index.js';
import { tokenAuthHash, transferDigest } from '../../../src/core/eip712.js';
import type { TransferRequest } from '../../../src/core/types.js';
import { RelayClient } from '../../../src/relay/client.js';
import { RelayApiError } from '../../../src/relay/errors.js';
import type { RequestState } from '../../../src/relay/types.js';
import { NONE_AUTH, NOW, polygonPins, sampleRequest, TRANSFER_CONTRACT } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';

const BASE = 'https://relay.test';
const pins = polygonPins();

function state(request: TransferRequest, status: RequestState['status'], error: RequestState['error'] = null): RequestState {
    const included = status !== 'queued';
    return {
        id: transferDigest(137, TRANSFER_CONTRACT, request, NONE_AUTH),
        operation: 'transfer',
        status,
        request,
        authHash: tokenAuthHash(NONE_AUTH),
        transactions: included ? [{ hash: `0x${'11'.repeat(32)}`, txNonce: 7, maxFeePerGas: '60000000000', status: 'mined' }] : [],
        txHash: included ? `0x${'11'.repeat(32)}` : null,
        blockNumber: status === 'mined' || status === 'confirmed' ? '94421001' : null,
        error,
    };
}

/** A relay whose GET /v1/requests/:id answers with the given states in turn (the last one repeats). */
function relayWithStates(states: readonly RequestState[]): { relay: RelayClient; polls: () => number } {
    let polls = 0;
    const fetch = async (): Promise<Response> => {
        const next = states[Math.min(polls, states.length - 1)];
        polls += 1;
        return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { relay: new RelayClient(BASE, { pins, fetch, now: () => NOW }), polls: () => polls };
}

async function outcome(promise: Promise<RequestState>): Promise<string> {
    return promise.then(
        (s) => `resolved ${s.status}`,
        (error: unknown) => `threw ${(error as { code?: string }).code ?? String(error)}`,
    );
}

describe('RelayClient: provisional statuses, retryable errors and fetch compatibility', () => {
    describe('a provisional failed/expired status is not reported as final', () => {
        // The request's deadline (NOW + 600) has not passed by the client's clock, so the intent can
        // still execute; the relay documents that such a status can still turn into "mined".
        const request = sampleRequest();

        it('waitForRequest(until "mined") keeps polling after a "failed" of a broadcast request and returns the "mined" the relay reports one poll later', async () => {
            const reverted = state(request, 'failed', { code: 'simulation_failed', message: 'The transaction reverted on-chain' });
            const { relay, polls } = relayWithStates([reverted, state(request, 'mined')]);
            const result = await outcome(relay.waitForRequest(reverted.id, { until: 'mined', pollIntervalMs: 1, timeoutMs: 5_000 }));
            // Stopping at the first poll would be "threw request_failed" after one poll.
            expect({ result, polls: polls() }).toEqual({ result: 'resolved mined', polls: 2 });
        });

        it('waitForRequest keeps polling after an "expired" (mined cancel) and returns the "mined" a reorg turns it into', async () => {
            const cancelled = state(request, 'expired', { code: 'deadline_out_of_range', message: 'The deadline passed before the transaction was included; it was cancelled' });
            const { relay } = relayWithStates([cancelled, state(request, 'mined')]);
            const result = await outcome(relay.waitForRequest(cancelled.id, { until: 'mined', pollIntervalMs: 1, timeoutMs: 5_000 }));
            expect(result).toBe('resolved mined');
        });
    });

    it('a sender_busy answer is retryable (spec §6.3: the 409 to retry once the pending request is mined)', () => {
        const error = new RelayApiError('sender_busy', 'a request from this sender is still pending; retry when it is mined', 409);
        expect(error.retryable).toBe(true);
        // A request above the sender's on-chain nonce waits for the lower one in the same way.
        expect(new RelayApiError('nonce_too_high', 'the nonce is above nonces(from); retry when the lower nonce is used', 409).retryable).toBe(true);
    });

    it('a fetch whose Response.body is a Node.js stream (node-fetch, cross-fetch) works', async () => {
        const json = JSON.stringify(infoFor(pins));
        // The shape node-fetch returns: WHATWG headers and text(), but body is a Node.js Readable.
        const nodeFetchLike = async (): Promise<Response> =>
            ({
                status: 200,
                ok: true,
                headers: new Headers({ 'content-type': 'application/json', 'content-length': String(json.length) }),
                body: Readable.from([Buffer.from(json)]),
                text: async () => json,
            }) as unknown as Response;
        const relay = new RelayClient(BASE, { pins, fetch: nodeFetchLike });
        const result = await relay.info().then(
            (info) => `resolved chain ${info.chainId}`,
            (error: unknown) => `threw ${(error as { code?: string }).code}: ${(error as { cause?: Error }).cause?.message ?? ''}`,
        );
        // A reader that assumes a WHATWG stream gives "threw network_error: body.getReader is not a function".
        expect(result).toBe('resolved chain 137');
    });

    it('the fee ceiling is exported from the core entry point used by the IIFE global', () => {
        const exported = core as unknown as Record<string, unknown>;
        expect({ checkAcceptableFee: typeof exported.checkAcceptableFee, parseMaxAcceptableFee: typeof exported.parseMaxAcceptableFee }).toEqual({
            checkAcceptableFee: 'function',
            parseMaxAcceptableFee: 'function',
        });
    });
});
