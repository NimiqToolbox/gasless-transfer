// The retry path after an unclear submit error. These tests need no chain (the relay is a mocked fetch).
//
// Re-posts: sdk/README.md tells a wallet, after an unclear submit error (timeout, network error, invalid response),
// to post the same body again until the relay answers, and the relay answers an identical stored body with 200 and
// its current state before any policy check, also after the deadline. A re-post must therefore reach the relay
// even when the deadline is less than 60 s away or has passed, where the client-side policy check refuses a first
// post: otherwise the wallet could not learn whether the relay stored the body. `submitTransfer(body, { repost:
// true })` skips the client-side deadline window and keeps the pin, shape and signature checks. An SDK error before
// sending means "this call sent nothing", not "the relay stored nothing". Without `repost` a post is checked as a
// first post (a control below).
//
// The message of a provisional RelayRequestFailedError: confirmOnChain reads the LATEST block by default, where
// `expired` can still change in a reorg; the spec rule (§7) and the README require waitForTransferOutcome or
// confirmOnChain at the FINALIZED block, so the message must point there.

import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tokenAuthHash, transferDigest } from '../../../src/core/eip712.js';
import { createTransferIntent, tokenAuthSigningPayload, transferSigningPayload } from '../../../src/core/intent.js';
import { toTokenAuthorization } from '../../../src/core/signature.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { RelayClient } from '../../../src/relay/client.js';
import { RelayRequestFailedError } from '../../../src/relay/errors.js';
import type { RequestState, SubmitTransferBody } from '../../../src/relay/types.js';
import { ADDR, KEYS, NONE_AUTH, NOW, polygonPins, TRANSFER_CONTRACT, USDC } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';

const pins = polygonPins();

async function permitBody(deadline: number): Promise<SubmitTransferBody> {
    const account = privateKeyToAccount(KEYS.user);
    const intent = createTransferIntent(
        pins,
        { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 10_000_000n, fee: 50_000n, relay: ADDR.relay, authMode: 'permit', deadline, nonce: 0n, tokenNonce: 0n },
        NOW,
    );
    const permit = await account.signTypedData(tokenAuthSigningPayload(pins, intent, NOW) as never);
    const authorization = toTokenAuthorization('permit', permit);
    const signature = await account.signTypedData(transferSigningPayload(pins, intent, authorization, NOW) as never);
    return buildSubmitTransferBody({ request: intent.request, signature, authorization });
}

/**
 * A relay that stores the first post but loses the answer (the wallet sees a network error), and answers every later
 * post of the same body with 200 and the stored state (spec §6.2; the relay pipeline looks up an identical body before
 * step 2). `posts` counts the POSTs that reached it.
 */
function lostAnswerRelay(body: SubmitTransferBody) {
    const id = transferDigest(137, TRANSFER_CONTRACT, body.request, body.authorization);
    const seen = { posts: 0 };
    const fetch = async (url: string): Promise<Response> => {
        const path = new URL(url).pathname;
        if (path === '/v1/info') return new Response(JSON.stringify(infoFor(pins)), { status: 200 });
        seen.posts += 1;
        if (seen.posts === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ id, status: 'submitted' }), { status: 200 });
    };
    return { fetch, seen };
}

function outcome(promise: Promise<{ status: string }>): Promise<string> {
    return promise.then(
        (answer) => `resolved ${answer.status}`,
        (error: unknown) => `threw ${(error as { name?: string }).name} ${(error as { code?: string }).code}`,
    );
}

describe('the retry path after an unclear submit error', () => {
    it('an identical re-post ({ repost: true }) after a network error reaches the relay, which answers 200 for the stored body, also when the deadline is less than 60 s away', async () => {
        const deadline = NOW + 600;
        const body = await permitBody(deadline);
        const relay = lostAnswerRelay(body);
        let clock = NOW;
        const client = new RelayClient('https://relay.test', { pins, fetch: relay.fetch, now: () => clock });
        const first = await client.submitTransfer(body).then(
            () => 'resolved',
            (error: unknown) => (error as { code?: string }).code,
        );
        expect(first).toBe('network_error');

        // README: "Post the same body again with submitTransfer(body, { repost: true }), until the relay answers." The
        // wallet was offline for a while (or the relay did not answer); the deadline is now 30 s away.
        clock = deadline - 30;
        const second = await outcome(client.submitTransfer(body, { repost: true }));
        // A re-post checked like a first post would be { second: 'threw GaslessValidationError deadline_out_of_range',
        // posts: 1 }: refused before sending, although the relay stored the body.
        expect({ second, posts: relay.seen.posts }).toEqual({ second: 'resolved submitted', posts: 2 });
    });

    it('a re-post is sent also after the deadline; a first post keeps the client-side deadline window', async () => {
        const deadline = NOW + 600;
        const body = await permitBody(deadline);
        const relay = lostAnswerRelay(body);
        let clock = NOW;
        const client = new RelayClient('https://relay.test', { pins, fetch: relay.fetch, now: () => clock });
        await expect(client.submitTransfer(body)).rejects.toMatchObject({ code: 'network_error' });
        // Control: without `repost` the call is checked as a first post, and sends nothing ("this call sent nothing").
        clock = deadline - 30;
        expect(await outcome(client.submitTransfer(body))).toBe('threw GaslessValidationError deadline_out_of_range');
        expect(relay.seen.posts).toBe(1);
        // Past the deadline the relay still answers for a stored body: the re-post finds out.
        clock = deadline + 3_600;
        expect(await outcome(client.submitTransfer(body, { repost: true }))).toBe('resolved submitted');
        expect(relay.seen.posts).toBe(2);
        // Only the literal true skips the window.
        for (const value of [1, 'true', {}]) {
            expect(await outcome(client.submitTransfer(body, { repost: value as never })), String(value)).toBe('threw GaslessValidationError deadline_out_of_range');
        }
        expect(relay.seen.posts).toBe(2);
    });

    it('a re-post keeps the pin, shape and signature checks, and the relay identity check', async () => {
        const body = await permitBody(NOW + 600);
        const relay = lostAnswerRelay(body);
        const client = new RelayClient('https://relay.test', { pins, fetch: relay.fetch, now: () => NOW + 3_600 });
        const cases: Array<[SubmitTransferBody, string]> = [
            [{ ...body, request: { ...body.request, to: USDC } }, 'invalid_recipient'],
            [{ ...body, request: { ...body.request, relay: ADDR.other } }, 'wrong_relay'],
            [{ ...body, request: { ...body.request, fee: (2n ** 256n - 1n).toString() } }, 'invalid_amount'],
            [{ ...body, signature: '0x1234' as Hex }, 'invalid_signature'],
            [{ ...body, request: { ...body.request, amount: '1.5' } }, 'invalid_request'],
            [{ ...body, request: { ...body.request, nonce: '0x00' } }, 'invalid_request'],
            [{ ...body, authorization: { ...body.authorization, mode: 'none' } }, 'auth_unexpected'],
            [{ ...body, authorization: { ...body.authorization, mode: 'metaTxApprove' } }, 'unsupported_auth_mode'],
        ];
        for (const [tampered, code] of cases) {
            expect(await outcome(client.submitTransfer(tampered, { repost: true })), code).toBe(`threw GaslessValidationError ${code}`);
        }
        expect(relay.seen.posts).toBe(0);
        // The URL now serves another pinned relay (a key rotation): the body signed for the old one is not sent.
        const rotated = polygonPins({ relays: [ADDR.relay, ADDR.other] });
        const rotatedFetch = async (url: string): Promise<Response> => {
            if (new URL(url).pathname === '/v1/info') return new Response(JSON.stringify(infoFor(rotated, ADDR.other)), { status: 200 });
            throw new Error('the body must not be sent');
        };
        const afterRotation = new RelayClient('https://relay.test', { pins: rotated, fetch: rotatedFetch, now: () => NOW + 3_600 });
        expect(await outcome(afterRotation.submitTransfer(body, { repost: true }))).toBe('threw GaslessValidationError wrong_relay');
    });

    it('a provisional RelayRequestFailedError points to a final on-chain check (waitForTransferOutcome, or confirmOnChain at the finalized block), not to confirmOnChain at its default latest block', () => {
        const request = {
            token: USDC,
            from: ADDR.user,
            to: ADDR.recipient,
            amount: '10000000',
            fee: '50000',
            relay: ADDR.relay,
            nonce: '4',
            deadline: String(NOW + 600),
        } as RequestState['request'];
        const state: RequestState = {
            id: transferDigest(137, TRANSFER_CONTRACT, request, NONE_AUTH),
            operation: 'transfer',
            status: 'failed',
            request,
            authHash: tokenAuthHash(NONE_AUTH),
            transactions: [{ hash: `0x${'11'.repeat(32)}` as Hex, txNonce: 7, maxFeePerGas: '60000000000', status: 'mined' }],
            txHash: null,
            blockNumber: null,
            error: { code: 'simulation_failed', message: 'the call reverted on-chain' },
        };
        const error = new RelayRequestFailedError(state, { final: false });
        // A bare "check confirmOnChain before signing again" would send the wallet to the latest block.
        expect(error.message).toMatch(/finalized|waitForTransferOutcome/);
        expect(error.message).toMatch(/waitForTransferOutcome, or confirmOnChain with blockTag "finalized"/);
        expect(error.message).not.toMatch(/check confirmOnChain before/);
    });
});
