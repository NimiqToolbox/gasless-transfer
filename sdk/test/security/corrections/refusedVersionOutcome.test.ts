// One payment, one intent nonce: a payment can have several signed versions (the first one and its corrections,
// spec §7, sdk/README.md "Failures, retries and replacements"), and a relay that refused a version may still hold
// and execute it. A wallet that judged the payment by ONE version alone could pay twice: it would read
// `nonce_consumed` when the refused first version executed, or `expired` for the corrected version while the first
// version, with a later deadline, can still execute, and take either as "a new payment is safe".
//
// The rules that prevent it:
// - the outcome check judges the nonce: another version that executed is `other_version_executed`, with its fields,
//   and `nonce_consumed` needs the NonceInvalidated event (neither found: no answer);
// - a correction is prepared with `corrects` (prepareTransfer, createTransferIntent): it keeps the intent nonce, from,
//   token and to, and a deadline at least as late, so `expired` of the latest version covers every version.
//
// Each test follows the README step by step and asserts the property the rules exist for: the recipient is paid at
// most once, and no new payment is signed while a version executed or can still execute. The relay is a scripted
// fetch behind the SDK's own RelayClient that refuses the first version but keeps it (a compromised relay;
// relay/test/integration/keyRotationPaysOnce.test.ts has the same with two honest relays). The chain is anvil with
// the production GaslessTransfer (test/helpers/productionChain.ts); the relay's on-chain actions are real
// relayTransfer calls.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { usdcAbi } from '../../../src/core/abi.js';
import { tokenAuthHash, transferDigest } from '../../../src/core/eip712.js';
import type { ChainPins } from '../../../src/core/pins.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { RelayClient } from '../../../src/relay/client.js';
import { RelayApiError, RelayRequestFailedError } from '../../../src/relay/errors.js';
import type { ErrorCode, RequestState, SubmitTransferBody } from '../../../src/relay/types.js';
import {
    prepareTransfer,
    signPrepared,
    waitForTransferOutcome,
    type PrepareTransferParams,
    type PreparedTransfer,
    type SignedTransfer,
    type TransferOutcome,
} from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';
import { chainToolsAvailable, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';

const AMOUNT = 10_000_000n;
const REVERTED_CALL = `0x${'5a'.repeat(32)}` as Hex;

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
 * A relay whose first POST /v1/transfer answer is a refusal (`refusal`) although it keeps the body; every later POST
 * is accepted with 202. GET /v1/requests/:id answers from `states`, which the test sets.
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

function statusOf(outcome: TransferOutcome | { readonly thrown: unknown }): string {
    return 'status' in outcome ? outcome.status : `threw ${String((outcome.thrown as { code?: string }).code)}`;
}

describe.skipIf(!chainToolsAvailable())('one payment, one intent nonce: the outcome check judges the nonce, and a correction keeps the deadline', () => {
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

    async function sign(prepared: PreparedTransfer, now: number): Promise<SignedTransfer> {
        return signPrepared(user, prepared, ctx.pins, { now });
    }

    /**
     * README, "Failures, retries and replacements": after `expired` or `nonce_consumed` of the payment's latest version,
     * a new payment is safe. Returns whether the wallet signed (and the relay executed) one.
     */
    async function replaceIfReadmeSaysSafe(relay: RelayClient, status: string, setClock: (now: number) => void): Promise<boolean> {
        if (status !== 'expired' && status !== 'nonce_consumed') return false;
        const now = await ctx.now();
        setClock(now);
        const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, now })); // nonces(from)
        const body = buildSubmitTransferBody(await sign(prepared, now));
        await relay.submitTransfer(body);
        await ctx.relayExecute(body);
        return true;
    }

    it('the refused first version executed: waitForTransferOutcome(corrected version) is other_version_executed with its fields, no new payment is signed, the recipient is paid once', async () => {
        const t0 = await ctx.now();
        let clock = t0;
        const script = scriptedRelay(ctx.pins, {
            code: 'fee_too_low',
            status: 402,
            message: 'fee 50000 is below 60000, the larger of the minimum fee 10000 and the current break-even fee; request a new quote',
        });
        const relay = new RelayClient('https://relay.test', { pins: ctx.pins, fetch: script.fetch, now: () => clock });
        const paidBefore = await ctx.balanceOf(USDC, ADDR.recipient);

        // 1. Version A (automatic mode: permit). The relay answers 402 fee_too_low, but keeps the body.
        const preparedA = await prepareTransfer(ctx.publicClient, ctx.pins, params({ now: t0 }));
        const signedA = await sign(preparedA, t0);
        const refusal = await settle(relay.submitTransfer(buildSubmitTransferBody(signedA)));
        expect((refusal as { thrown: unknown }).thrown).toBeInstanceOf(RelayApiError);
        expect(((refusal as { thrown: RelayApiError }).thrown).code).toBe('fee_too_low');

        // 2. README: "Any other RelayApiError ... Fix the cause and prepare a correction with corrects". Version B keeps
        //    A's nonce, with the higher fee. Accepted (202).
        const preparedB = await prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, corrects: preparedA.request, now: t0 }));
        expect(preparedB.request.nonce).toBe(preparedA.request.nonce);
        const signedB = await sign(preparedB, t0);
        const bodyB = buildSubmitTransferBody(signedB);
        expect(await relay.submitTransfer(bodyB)).toEqual({ id: signedB.id, status: 'queued' });

        // 3. The relay executes A, the body it "did not store". B's call then reverts (the nonce is used).
        const [bodyA] = script.kept;
        await ctx.relayExecute(bodyA as SubmitTransferBody);
        script.states.set(
            signedB.id,
            stateOf(bodyB, signedB.id, 'failed', {
                transactions: [{ hash: REVERTED_CALL, txNonce: 7, maxFeePerGas: '60000000000', status: 'mined' }],
                error: { code: 'nonce_used', message: 'simulation before broadcast failed: InvalidSignature' },
            }),
        );

        // 4. README: "waitForRequest threw RelayRequestFailedError | ... | Before offering to try again, run
        //    waitForTransferOutcome" with the latest version, B. It reads the finalized block (anvil finalizes 64 blocks
        //    behind the head).
        const waited = await settle(relay.waitForRequest(signedB.id, { timeoutMs: 200, pollIntervalMs: 20 }));
        expect((waited as { thrown: unknown }).thrown).toBeInstanceOf(RelayRequestFailedError);
        await ctx.testClient.mine({ blocks: 70 });
        const outcome = await settle(waitForTransferOutcome(ctx.publicClient, ctx.pins, signedB, { relay, pollIntervalMs: 20, timeoutMs: 10_000 }));
        const status = statusOf(outcome);

        // 5. README: expired or nonce_consumed -> a new payment is safe; executed or other_version_executed -> done.
        const replacementSigned = await replaceIfReadmeSaysSafe(relay, status, (now) => {
            clock = now;
        });
        const timesPaid = ((await ctx.balanceOf(USDC, ADDR.recipient)) - paidBefore) / AMOUNT;
        // Judging B alone as nonce_consumed would give { replacementSigned: true, timesPaid: 2n }.
        expect({ replacementSigned, timesPaid }, `waitForTransferOutcome(corrected version B) = ${status}`).toEqual({ replacementSigned: false, timesPaid: 1n });
        // The answer names what executed: A, with its lower fee.
        expect(status).toBe('other_version_executed');
        expect((outcome as TransferOutcome).executedTransfer).toEqual({ request: signedA.request, authHash: signedA.authHash });
    });

    it('the refused first version has the later deadline: the correction keeps it (an earlier one is refused), the corrected version is not expired while the first can execute, no new payment is signed, the recipient is paid once', async () => {
        // A standing allowance covers several transfers, so prepareTransfer picks mode none (two NONE intents can
        // both execute; a permit would share the token nonce with the next one).
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

        // 1. Version A, one hour lifetime (the relay accepts up to two). The relay refuses it with insufficient_allowance
        //    but keeps it.
        const preparedA = await prepareTransfer(ctx.publicClient, ctx.pins, params({ deadlineSeconds: 3_600, now: t0 }));
        expect(preparedA.authMode).toBe('none');
        const refusal = await settle(relay.submitTransfer(buildSubmitTransferBody(await sign(preparedA, t0))));
        expect(((refusal as { thrown: RelayApiError }).thrown).code).toBe('insufficient_allowance');

        // 2. README: prepare a correction (`corrects`). A shorter lifetime than A's is refused; by default the correction
        //    keeps A's deadline.
        const shorter = await settle(prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, corrects: preparedA.request, deadlineSeconds: 600, now: t0 })));
        expect(((shorter as { thrown: { code?: string; field?: string } }).thrown)).toMatchObject({ code: 'correction_mismatch', field: 'request.deadline' });
        const preparedB = await prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, corrects: preparedA.request, now: t0 }));
        expect(preparedB.request.deadline).toBe(preparedA.request.deadline);
        const signedB = await sign(preparedB, t0);
        const bodyB = buildSubmitTransferBody(signedB);
        expect(await relay.submitTransfer(bodyB)).toEqual({ id: signedB.id, status: 'queued' });
        // The relay lets B expire in its queue (nothing broadcast: final at once, by the relay's word).
        script.states.set(signedB.id, stateOf(bodyB, signedB.id, 'expired', { error: { code: 'deadline_out_of_range', message: 'The deadline passed before the request could be submitted' } }));
        const waited = await settle(relay.waitForRequest(signedB.id, { timeoutMs: 5_000, pollIntervalMs: 20 }));
        expect(((waited as { thrown: RelayRequestFailedError }).thrown).final).toBe(true);

        // 3. README: run waitForTransferOutcome with the latest version (B) before offering to try again. 700 s later its
        //    deadline, A's, has not passed: not expired, the wait goes on until its timeout.
        await ctx.testClient.increaseTime({ seconds: 700 });
        await ctx.testClient.mine({ blocks: 70 });
        clock = await ctx.now();
        const outcome = await settle(waitForTransferOutcome(ctx.publicClient, ctx.pins, signedB, { relay, pollIntervalMs: 20, timeoutMs: 10_000 }));
        const status = statusOf(outcome);

        // 4. No new payment unless the README says it is safe. Then the relay executes A, still within its deadline.
        const replacementSigned = await replaceIfReadmeSaysSafe(relay, status, (now) => {
            clock = now;
        });
        const [bodyA] = script.kept;
        const lateA = await settle(ctx.relayExecute(bodyA as SubmitTransferBody));
        const timesPaid = ((await ctx.balanceOf(USDC, ADDR.recipient)) - paidBefore) / AMOUNT;
        // Judging B alone as expired would give { replacementSigned: true, timesPaid: 2n }.
        expect(
            { replacementSigned, timesPaid },
            `waitForTransferOutcome(corrected version B) = ${status}; the relay's late call of A ${'thrown' in lateA ? 'reverted' : 'executed'}`,
        ).toEqual({ replacementSigned: false, timesPaid: 1n });
        expect(status).toBe('threw timeout');

        // Once the chain has decided, the latest version's outcome names the executed version A.
        await ctx.testClient.mine({ blocks: 70 });
        const decided = await waitForTransferOutcome(ctx.publicClient, ctx.pins, signedB, { relay, pollIntervalMs: 20, timeoutMs: 5_000 });
        expect({ status: decided.status, fee: decided.executedTransfer?.request.fee }).toEqual({ status: 'other_version_executed', fee: preparedA.request.fee });
    });
});
