// A correction must retain the payment's intent nonce and must not shorten its latest deadline.
// Passing only `nonce` to prepareTransfer bypasses that relationship, so the SDK rejects it before signing.
// The payment tests check that no new payment is signed while an earlier version can still execute,
// and that the recipient is paid at most once. The control uses `corrects` from the start.
// They need Anvil, Forge and the pinned OpenZeppelin dependency.
//
// Core createTransferIntent accepts a caller-supplied first nonce. Clients must pass `corrects` for every
// later version and read nonces(from) before requesting a correction. The documentation tests retain both
// requirements and prohibit examples that reuse a nonce without the latest request.
//
// With sequential nonces a new payment prepared while an earlier one is open gets the same nonce,
// so at most one of them executes; the third test shows that for a wallet that ignores the correction rules.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { usdcAbi } from '../../../src/core/abi.js';
import { tokenAuthHash, transferDigest } from '../../../src/core/eip712.js';
import type { ChainPins } from '../../../src/core/pins.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { RelayClient } from '../../../src/relay/client.js';
import { RelayApiError } from '../../../src/relay/errors.js';
import type { ErrorCode, RequestState, SubmitTransferBody } from '../../../src/relay/types.js';
import { prepareTransfer, signPrepared, waitForTransferOutcome, type PrepareTransferParams, type PreparedTransfer, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';
import { chainToolsAvailable, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';

const AMOUNT = 10_000_000n;

function stateOf(body: SubmitTransferBody, id: Hex, status: RequestState['status'], extra: Partial<RequestState> = {}): RequestState {
    return {
        id,
        operation: 'transfer',
        status,
        request: body.request,
        authHash: tokenAuthHash(body.authorization),
        transactions: [],
        txHash: null,
        blockNumber: null,
        error: null,
        ...extra,
    };
}

/**
 * A relay whose first POST /v1/transfer answer is a refusal although it keeps the body (a compromised relay, or two
 * relays during a key rotation); every later POST is accepted with 202. GET /v1/requests/:id answers from `states`.
 */
function scriptedRelay(pins: ChainPins, refusal: { code: ErrorCode; status: number; message: string }) {
    const kept: SubmitTransferBody[] = [];
    const states = new Map<string, RequestState>();
    let refused = false;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname;
        if (init.method === 'GET' && path === '/v1/info') return reply(200, infoFor(pins));
        if (init.method === 'POST' && path === '/v1/transfer') {
            const body = JSON.parse(String(init.body)) as SubmitTransferBody;
            const id = transferDigest(pins.chainId, pins.transfer.address, body.request, body.authorization);
            if (!refused) {
                refused = true;
                kept.push(body);
                return reply(refusal.status, { error: { code: refusal.code, message: refusal.message } });
            }
            states.set(id, stateOf(body, id, 'queued'));
            return reply(202, { id, status: 'queued' });
        }
        if (init.method === 'GET' && path.startsWith('/v1/requests/')) {
            const state = states.get(path.slice('/v1/requests/'.length));
            return state !== undefined ? reply(200, state) : reply(404, { error: { code: 'not_found', message: 'unknown request' } });
        }
        return reply(404, { error: { code: 'not_found', message: 'no such route' } });
    };
    return { fetch, kept, states };
}

async function settle<T>(promise: Promise<T>): Promise<T | { readonly thrown: unknown }> {
    return promise.catch((thrown: unknown) => ({ thrown }));
}

describe.skipIf(!chainToolsAvailable())('prepareTransfer prepares no second version of a payment outside the correction rules (`nonce` without `corrects` is refused)', () => {
    let ctx: ProductionChain;
    let snapshot: Hex;
    const user = privateKeyToAccount(KEYS.user);

    beforeAll(async () => {
        ctx = await startProductionChain();
    }, 240_000);

    afterAll(async () => {
        await ctx?.stop();
    });

    beforeEach(async () => {
        snapshot = await ctx.testClient.snapshot();
    });

    afterEach(async () => {
        await ctx.testClient.revert({ id: snapshot });
    });

    function params(overrides: Partial<PrepareTransferParams> & { now: number }): PrepareTransferParams {
        return { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: 50_000n, relay: ADDR.relay, ...overrides };
    }

    async function sign(prepared: PreparedTransfer, now: number): Promise<SubmitTransferBody> {
        return buildSubmitTransferBody(await signPrepared(user, prepared, ctx.pins, { now }));
    }

    async function signed(prepared: PreparedTransfer, now: number): Promise<{ signedB: SignedTransfer; bodyB: SubmitTransferBody }> {
        const signedB = await signPrepared(user, prepared, ctx.pins, { now });
        return { signedB, bodyB: buildSubmitTransferBody(signedB) };
    }

    /**
     * Version A (one hour, mode none on a standing allowance) is refused with insufficient_allowance by a relay that keeps
     * it; the wallet prepares version B with `prepareB`, the relay lets B expire in its queue, and 700 s later the wallet
     * runs waitForTransferOutcome(B) and signs a new payment only if the README says that is safe. Then the relay executes
     * A. Returns whether a new payment was signed, how often the recipient was paid, and what led there.
     */
    async function payment(prepareB: (preparedA: PreparedTransfer, now: number) => Promise<PreparedTransfer>) {
        await ctx.send(KEYS.user, USDC, usdcAbi, 'approve', [ctx.transfer, 10n * (AMOUNT + 60_000n)]);
        const t0 = await ctx.now();
        let clock = t0;
        const script = scriptedRelay(ctx.pins, {
            code: 'insufficient_allowance',
            status: 422,
            message: 'allowance to the contract does not cover amount + fee (including pending requests)',
        });
        const relay = new RelayClient('https://relay.test', { pins: ctx.pins, fetch: script.fetch, now: () => clock });
        const paidBefore = await ctx.balanceOf(USDC, ADDR.recipient);

        const preparedA = await prepareTransfer(ctx.publicClient, ctx.pins, params({ deadlineSeconds: 3_600, now: t0 }));
        expect(preparedA.authMode).toBe('none');
        const refusal = await settle(relay.submitTransfer(await sign(preparedA, t0)));
        expect(((refusal as { thrown: RelayApiError }).thrown).code).toBe('insufficient_allowance');

        const preparedB = await prepareB(preparedA, t0);
        // A version of the same payment, or (sequential nonces) a new payment while A is open: the same nonce.
        expect(preparedB.request.nonce).toBe(preparedA.request.nonce);
        const { signedB, bodyB } = await signed(preparedB, t0);
        expect(await relay.submitTransfer(bodyB)).toEqual({ id: signedB.id, status: 'queued' });
        script.states.set(signedB.id, stateOf(bodyB, signedB.id, 'expired', { error: { code: 'deadline_out_of_range', message: 'The deadline passed before the request could be submitted' } }));

        await ctx.testClient.increaseTime({ seconds: 700 });
        await ctx.testClient.mine({ blocks: 70 });
        clock = await ctx.now();
        const outcome = await settle(waitForTransferOutcome(ctx.publicClient, ctx.pins, signedB, { relay, pollIntervalMs: 20, timeoutMs: 5_000 }));
        const status = 'status' in outcome ? outcome.status : `threw ${String((outcome.thrown as { code?: string }).code)}`;

        // README: only `expired` or `nonce_consumed` of the latest version make a new payment safe.
        let replacementSigned = false;
        if (status === 'expired' || status === 'nonce_consumed') {
            replacementSigned = true;
            const now = await ctx.now();
            clock = now;
            const replacement = await prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, now }));
            const body = await sign(replacement, now);
            await relay.submitTransfer(body);
            await ctx.relayExecute(body);
        }
        // The relay executes A, which it kept, still within A's deadline.
        const [bodyA] = script.kept;
        const lateA = await settle(ctx.relayExecute(bodyA as SubmitTransferBody));
        const timesPaid = ((await ctx.balanceOf(USDC, ADDR.recipient)) - paidBefore) / AMOUNT;
        return { replacementSigned, timesPaid, status, lateA: 'thrown' in lateA ? 'reverted' : 'executed', deadlines: { a: preparedA.request.deadline, b: preparedB.request.deadline } };
    }

    it('a wallet that prepares the corrected version with `nonce: A.nonce` alone is refused before signing (invalid_request, field nonce), corrects with `corrects`, and the recipient is paid at most once', async () => {
        let refusal: unknown = null;
        const result = await payment(async (preparedA, now) => {
            // The wallet reuses the intent nonce by passing it alone, without the version it corrects.
            const reused = await settle(prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, nonce: preparedA.request.nonce, now })));
            // Not refused: the wallet would sign that version, whose deadline the correction rules never checked.
            if ('request' in reused) return reused;
            // Refused before anything was signed: the wallet follows the README (a correction with `corrects`).
            refusal = reused.thrown;
            return prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, corrects: preparedA.request, now }));
        });
        // A version prepared from the nonce alone would give { replacementSigned: true, timesPaid: 2n }, with
        // waitForTransferOutcome(B) = expired: B would get the default 600 s lifetime while A lives 3600 s (deadlines in
        // the message).
        expect(
            { replacementSigned: result.replacementSigned, timesPaid: result.timesPaid },
            `waitForTransferOutcome(B) = ${result.status}; the late call of A ${result.lateA}; deadlines A ${result.deadlines.a}, B ${result.deadlines.b}`,
        ).toEqual({ replacementSigned: false, timesPaid: 1n });
        // The mechanism: prepareTransfer refuses a nonce without corrects, before any signature.
        expect(refusal).toMatchObject({ name: 'GaslessValidationError', code: 'invalid_request', field: 'nonce' });
        expect(result.deadlines.b).toBe(result.deadlines.a);
    });

    it('control: the same payment with the correction prepared through `corrects` is paid once (B keeps A deadline; no new payment while A can execute)', async () => {
        const result = await payment((preparedA, now) => prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, corrects: preparedA.request, now })));
        expect(result.deadlines.b).toBe(result.deadlines.a);
        expect({ replacementSigned: result.replacementSigned, timesPaid: result.timesPaid, status: result.status, lateA: result.lateA }).toEqual({
            replacementSigned: false,
            timesPaid: 1n,
            status: 'threw timeout',
            lateA: 'executed',
        });
    });

    it('sequential nonces: a wallet that prepares B as a new payment while A is open gets A’s nonce, so the replacement after B expired and A exclude each other', async () => {
        const result = await payment((_preparedA, now) => prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, now })));
        // B (600 s) expired before A (3600 s): the wallet broke the rules and signed a replacement, at the same nonce.
        // The replacement executed; A's signature is for a nonce that is used now.
        expect({ replacementSigned: result.replacementSigned, timesPaid: result.timesPaid, status: result.status, lateA: result.lateA }).toEqual({
            replacementSigned: true,
            timesPaid: 1n,
            status: 'expired',
            lateA: 'reverted',
        });
    });
});

describe('the README states the nonce rules for prepareTransfer and core clients', () => {
    const README = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

    it('requires corrects for later versions and a nonces(from) check before a core correction', () => {
        expect(README).toContain('A `nonce` without `corrects` throws `GaslessValidationError` `invalid_request` with the field `nonce`');
        expect(README).toContain("for every later version it passes `corrects` (the payment's latest signed version), never that version's nonce alone");
        expect(README).toContain('before it requests a correction signature, it reads `nonces(from)` on-chain');
    });

    it('does not recommend reusing a nonce without corrects or choosing a nonce for a new payment in prepareTransfer', () => {
        expect(README).not.toContain('nonce: prepared.request.nonce');
        expect(README).not.toMatch(/`nonce` without `corrects` is for a new payment/);
    });
});
