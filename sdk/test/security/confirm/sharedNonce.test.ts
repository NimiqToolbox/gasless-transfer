// Two different payments of one sender can end up with the same intent nonce (nonces are sequential): an RPC node
// behind the chain answers prepareTransfer's nonces(from) read at "latest", or two wallet instances of one key each
// prepare a payment. At most one of them executes. The outcome check must tell the two apart: taking any execution
// at the nonce for another version of the checked payment would report a payment that never executed as paid
// (`other_version_executed`), and leaving a payment that lost its nonce to a payment to another recipient
// `unresolved` for good would keep its wallet from ever starting a new payment.
//
// So prepareTransfer refuses a nonce below `minNonce` (from the previous payment's outcome), the search finds every
// execution of the sender through the pinned tokens' Transfer logs from it, and an execution that is not a version of
// the payment (another token or recipient, or not in `versions`) is `other_payment_executed`, a final answer.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, custom, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { TransferVersion } from '../../../src/core/types.js';
import { confirmOnChain, prepareTransfer, signPrepared, waitForTransferOutcome, type PrepareTransferParams, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC, USDT0 } from '../../helpers/fixtures.js';
import { chainToolsAvailable, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';

const NONCES_SELECTOR = '0x7ecebe00';
const WAIT = { pollIntervalMs: 20, timeoutMs: 10_000 } as const;

function version(signed: SignedTransfer): TransferVersion {
    return { request: signed.request, authHash: signed.authHash };
}

describe.skipIf(!chainToolsAvailable())('two payments on one nonce are told apart', () => {
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

    /** A node that answers nonces(from) of the transfer contract at "latest" from block `lag` (it is behind). */
    function laggingClient(lag: bigint) {
        return createPublicClient({
            chain: ctx.chain,
            transport: custom({
                async request({ method, params }) {
                    let p = params as unknown[];
                    const call = p?.[0] as { to?: string; data?: string } | undefined;
                    if (method === 'eth_call' && p[1] === 'latest' && call?.to?.toLowerCase() === ctx.transfer.toLowerCase() && call.data?.startsWith(NONCES_SELECTOR)) {
                        p = [p[0], toHex(lag)];
                    }
                    const response = await fetch(ctx.anvil.url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: p }),
                    });
                    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
                    if (body.error) throw new Error(body.error.message);
                    return body.result;
                },
            }),
        });
    }

    function params(overrides: Partial<PrepareTransferParams> & { now: number }): PrepareTransferParams {
        return { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 10_000_000n, fee: 50_000n, relay: ADDR.relay, ...overrides };
    }

    async function payAndDecide(overrides: Partial<PrepareTransferParams> = {}) {
        const now = await ctx.now();
        const signed = await signPrepared(user, await prepareTransfer(ctx.publicClient, ctx.pins, params({ now, ...overrides })), ctx.pins, { now });
        const receipt = await ctx.relayExecute(buildSubmitTransferBody(signed));
        await ctx.testClient.mine({ blocks: 70 }); // anvil finalizes 64 blocks behind the head
        const outcome = await waitForTransferOutcome(ctx.publicClient, ctx.pins, { ...version(signed), versions: [version(signed)] }, WAIT);
        expect(outcome.status).toBe('executed');
        return { signed, receipt };
    }

    it('minNonce: prepareTransfer refuses the used nonce a lagging node reports for the next payment', async () => {
        const { signed, receipt } = await payAndDecide();
        const minNonce = BigInt(signed.request.nonce) + 1n; // the previous payment executed
        const now = await ctx.now();
        await expect(prepareTransfer(laggingClient(receipt.blockNumber - 1n), ctx.pins, params({ amount: 3_000_000n, minNonce, now }))).rejects.toMatchObject({
            code: 'nonce_used',
            field: 'minNonce',
        });
        // An up-to-date node: the next nonce.
        const next = await prepareTransfer(ctx.publicClient, ctx.pins, params({ amount: 3_000_000n, minNonce, now }));
        expect(next.request.nonce).toBe(minNonce.toString());
        // After `expired`, the previous nonce itself is allowed again.
        expect((await prepareTransfer(ctx.publicClient, ctx.pins, params({ amount: 3_000_000n, minNonce: minNonce - 1n, now }))).request.nonce).toBe('1');
        await expect(prepareTransfer(ctx.publicClient, ctx.pins, params({ minNonce: -1, now }))).rejects.toMatchObject({ code: 'invalid_request', field: 'minNonce' });
    });

    it('lagging node, same token and recipient: with its versions the second payment is other_payment_executed, never paid', async () => {
        const { signed: first, receipt } = await payAndDecide();
        const paid = await ctx.balanceOf(USDC, ADDR.recipient);
        // Payment 2, prepared without minNonce from a node one block behind payment 1's inclusion: it gets nonce 0.
        const now = await ctx.now();
        const p2 = await prepareTransfer(laggingClient(receipt.blockNumber - 1n), ctx.pins, params({ amount: 3_000_000n, now }));
        expect(p2.request.nonce).toBe(first.request.nonce);
        const s2 = await signPrepared(user, p2, ctx.pins, { now });
        await expect(ctx.relayExecute(buildSubmitTransferBody(s2))).rejects.toThrow();
        await ctx.testClient.mine({ blocks: 70 });

        const outcome = await waitForTransferOutcome(ctx.publicClient, ctx.pins, { ...version(s2), versions: [version(s2)] }, WAIT);
        expect(outcome.status).toBe('other_payment_executed');
        expect(outcome.executedTransfer).toEqual(version(first));
        expect(await ctx.balanceOf(USDC, ADDR.recipient)).toBe(paid);
        // Without the list the SDK cannot tell such a payment from a correction of this one (documented).
        expect((await confirmOnChain(ctx.publicClient, ctx.pins, version(s2), { blockTag: 'finalized' })).status).toBe('other_version_executed');
    });

    it.each([
        ['another recipient', { to: ADDR.other }],
        ['another token', { token: USDT0 }],
    ] as const)('two wallet instances, %s: the payment that lost the nonce is other_payment_executed, not unresolved', async (_name, other) => {
        const now = await ctx.now();
        const pA = await prepareTransfer(ctx.publicClient, ctx.pins, params({ now }));
        const pB = await prepareTransfer(ctx.publicClient, ctx.pins, params({ ...other, amount: 2_000_000n, now }));
        expect(pA.request.nonce).toBe(pB.request.nonce);
        const sA = await signPrepared(user, pA, ctx.pins, { now });
        const sB = await signPrepared(user, pB, ctx.pins, { now });
        const executedB = await ctx.relayExecute(buildSubmitTransferBody(sB));
        await expect(ctx.relayExecute(buildSubmitTransferBody(sA))).rejects.toThrow();
        await ctx.testClient.mine({ blocks: 70 });

        // No list needed: a version of A pays the same token to the same recipient.
        const confirmA = await confirmOnChain(ctx.publicClient, ctx.pins, version(sA), { blockTag: 'finalized' });
        expect(confirmA).toEqual({ status: 'other_payment_executed', txHash: executedB.transactionHash, blockNumber: executedB.blockNumber, executedTransfer: version(sB) });
        const waitA = await waitForTransferOutcome(ctx.publicClient, ctx.pins, version(sA), WAIT);
        expect(waitA.status).toBe('other_payment_executed');
        // B itself: executed.
        expect((await confirmOnChain(ctx.publicClient, ctx.pins, version(sB), { blockTag: 'finalized' })).status).toBe('executed');
    });

    it('versions: an executed earlier version in the list is other_version_executed; a list without it says other_payment_executed', async () => {
        const now = await ctx.now();
        const first = await signPrepared(user, await prepareTransfer(ctx.publicClient, ctx.pins, params({ now })), ctx.pins, { now });
        // A correction (another relay fee), signed before the first version executes.
        const second = await signPrepared(
            user,
            await prepareTransfer(ctx.publicClient, ctx.pins, params({ fee: 60_000n, corrects: first.request, now })),
            ctx.pins,
            { now },
        );
        await ctx.relayExecute(buildSubmitTransferBody(first));
        await ctx.testClient.mine({ blocks: 70 });
        const latest = version(second);
        const both = await confirmOnChain(ctx.publicClient, ctx.pins, { ...latest, versions: [version(first), latest] }, { blockTag: 'finalized' });
        expect(both).toMatchObject({ status: 'other_version_executed', executedTransfer: version(first) });
        expect((await confirmOnChain(ctx.publicClient, ctx.pins, latest, { blockTag: 'finalized' })).status).toBe('other_version_executed');
        // The list is the wallet's statement of every version it signed: one left out counts as another payment.
        expect((await confirmOnChain(ctx.publicClient, ctx.pins, { ...latest, versions: [latest] }, { blockTag: 'finalized' })).status).toBe('other_payment_executed');
    });

    it('versions must be one payment: same from, nonce, token and to', async () => {
        const now = await ctx.now();
        const signed = await signPrepared(user, await prepareTransfer(ctx.publicClient, ctx.pins, params({ now })), ctx.pins, { now });
        const other = { ...version(signed), request: { ...signed.request, to: ADDR.other } };
        await expect(confirmOnChain(ctx.publicClient, ctx.pins, { ...version(signed), versions: [other] })).rejects.toMatchObject({ code: 'invalid_request', field: 'versions[0]' });
        await expect(waitForTransferOutcome(ctx.publicClient, ctx.pins, { ...version(signed), versions: [{ ...version(signed), authHash: '0x12' as Hex }] }, WAIT)).rejects.toMatchObject({
            code: 'invalid_request',
            field: 'versions[0].authHash',
        });
    });
});
