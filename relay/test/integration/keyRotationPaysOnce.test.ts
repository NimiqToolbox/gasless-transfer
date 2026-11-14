// A key rotation with two honest relays (no party lies): the user pays at most once.
//
// Two relays run the production relay code during a key rotation (a new key needs a new database, relay/README.md),
// and one public URL is served first by the old relay, then by the new one. The wallet only uses the SDK and follows
// sdk/README.md "Failures, retries and replacements".
//
// The danger: the old relay stores request A, but its answer is lost; the re-post reaches the new relay, which refuses
// it (wrong_relay). A wallet that read this as "not stored" and signed a second payment would pay twice once A is
// mined. Two rules prevent that:
// - a re-post that cannot reach the relay that got the first post (an SDK error before sending, or `wrong_relay` from
//   the relay that serves the URL now) leaves the request possibly stored: the wallet runs waitForTransferOutcome with
//   the payment's latest version before it signs anything else (first test, the README's path);
// - the outcome check judges the nonce: a wallet that signs a correction anyway gets `other_version_executed` for it
//   (with the executed version's fields), never a "new payment is safe" answer (second test).
//
// Both tests assert on the payment itself: { replacementSigned: false, timesPaid: 1n }.
//
// The second test also checks what sdk/README.md ("Corrections") tells wallets about a correction sent to a second
// relay: once A executed, B fails the new relay's check before the broadcast (final, nothing sent; `nonce_used`,
// because A used up the intent nonce B was signed for), the new relay puts the sender (the signed `from`) on a
// cool-down (the old relay does not), so that sender's requests go one at a time there while other senders are not
// affected, and the outcome check reports `other_version_executed`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { buildSubmitTransferBody, type ChainPins } from '@nimiq/gasless-sdk/core';
import { RelayApiError, RelayClient, RelayClientError, RelayRequestFailedError, type SubmitTransferBody } from '@nimiq/gasless-sdk/relay';
import { prepareTransfer, signPrepared, waitForTransferOutcome, type PreparedTransfer, type SignedTransfer } from '@nimiq/gasless-sdk/viem';
import { startRelay, type RunningRelay } from './helpers/relay.js';
import { anvilAccount, startStack, type Stack } from './helpers/stack.js';

const AMOUNT = 2_000_000n;

describe('two honest relays during a key rotation: the user pays at most once', () => {
    let stack: Stack;
    let oldRelay: RunningRelay;
    let newRelay: RunningRelay;

    beforeAll(async () => {
        stack = await startStack();
        await stack.mine(100); // finalized-block reads must find the contract (anvil finalizes 64 blocks behind the head)
        oldRelay = await startRelay(stack, { accountIndex: 10 });
        newRelay = await startRelay(stack, { accountIndex: 11 });
        // Passes are driven by the test, so the order of events is deterministic.
        await oldRelay.server.relay.txManager.stop();
        await newRelay.server.relay.txManager.stop();
    });

    afterAll(async () => {
        await oldRelay?.stop();
        await newRelay?.stop();
        await stack?.stop();
    });

    /** One public relay URL, served by `live` (the old relay before the rotation, the new one after it). */
    function publicUrl() {
        const route = { live: oldRelay, loseNextPostAnswer: false };
        const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
            const url = new URL(input);
            const target = new URL(route.live.url);
            url.protocol = target.protocol;
            url.host = target.host;
            const response = await fetch(url, init);
            if (route.loseNextPostAnswer && init.method === 'POST') {
                route.loseNextPostAnswer = false;
                await response.text();
                throw new TypeError('fetch failed: connection reset'); // the relay processed the body, the answer is lost
            }
            return response;
        };
        return { route, fetch: fetchImpl };
    }

    function walletFor(userIndex: number, recipient: Address, pins: ChainPins, fetchImpl: ReturnType<typeof publicUrl>['fetch']) {
        const user = anvilAccount(userIndex);
        const client = new RelayClient('http://127.0.0.1:8443', { pins, fetch: fetchImpl });
        async function prepareAndSign(corrects?: PreparedTransfer): Promise<{ prepared: PreparedTransfer; signed: SignedTransfer; body: SubmitTransferBody }> {
            const quote = await client.fee({ token: stack.usdc, authMode: 'permit' });
            const prepared = await prepareTransfer(stack.publicClient, pins, {
                token: stack.usdc,
                from: user.address,
                to: recipient,
                amount: AMOUNT,
                fee: quote.fee,
                relay: quote.relay,
                ...(corrects !== undefined ? { corrects: corrects.request } : {}),
            });
            const signed = await signPrepared(user, prepared, pins);
            const body = buildSubmitTransferBody({ request: signed.request, signature: signed.signature, authorization: signed.authorization, quoteId: quote.quoteId });
            return { prepared, signed, body };
        }
        return { user, client, prepareAndSign };
    }

    /** Steps 1 and 2 of both tests: A is stored by the old relay (answer lost) and broadcast; then the key rotation. */
    async function firstPostThenRotation(route: ReturnType<typeof publicUrl>['route'], wallet: ReturnType<typeof walletFor>) {
        const a = await wallet.prepareAndSign();
        expect(a.body.request.relay).toBe(oldRelay.address);
        route.loseNextPostAnswer = true;
        const firstPost = await wallet.client.submitTransfer(a.body).catch((error: unknown) => error);
        expect(firstPost).toBeInstanceOf(RelayClientError);
        expect((firstPost as RelayClientError).code).toBe('network_error'); // README: "Unknown whether the relay stored the request"
        expect((await oldRelay.state(a.signed.id)).status).toBe('queued');

        // The old relay broadcasts A (it stays in the mempool for now). Then the key rotation.
        await stack.setAutomine(false);
        await oldRelay.tick();
        expect((await oldRelay.state(a.signed.id)).status).toBe('submitted');
        route.live = newRelay;

        // README: post the same body again with { repost: true }. The relay behind the URL now has another key: wrong_relay.
        const repost = await wallet.client.submitTransfer(a.body, { repost: true }).catch((error: unknown) => error);
        expect(repost).toBeInstanceOf(RelayApiError);
        expect((repost as RelayApiError).code).toBe('wrong_relay');
        return a;
    }

    it('after the re-post of A is refused with wrong_relay, the wallet waits for the outcome of A instead of signing anything else: A executed, paid once', async () => {
        const recipient: Address = anvilAccount(13).address;
        // The wallet pins both relay keys, as the SDK README suggests for a key rotation.
        const pins: ChainPins = stack.pins([oldRelay.address, newRelay.address]);
        const { route, fetch: fetchImpl } = publicUrl();
        const wallet = walletFor(1, recipient, pins, fetchImpl);
        const paidBefore = await stack.balanceOf(stack.usdc, recipient);
        const userBefore = await stack.balanceOf(stack.usdc, wallet.user.address);

        const a = await firstPostThenRotation(route, wallet);
        // A wallet restarted after the rotation (a new client) checks /v1/info again and refuses before sending: this
        // call sent nothing, which does not mean that the old relay stored nothing (same README row).
        const restarted = new RelayClient('http://127.0.0.1:8443', { pins, fetch: fetchImpl });
        const refusedBeforeSending = await restarted.submitTransfer(a.body, { repost: true }).catch((error: unknown) => error);
        expect(refusedBeforeSending).toMatchObject({ name: 'GaslessValidationError', code: 'wrong_relay' });

        // README: treat the request as possibly stored; run waitForTransferOutcome with the latest version (A) before
        // signing anything else. The relay at the URL does not know A (not_found): the chain decides. While A is in
        // the mempool the answer is not final.
        let replacementSigned = false;
        const early = await waitForTransferOutcome(stack.publicClient, pins, a.signed, { relay: wallet.client, pollIntervalMs: 50, timeoutMs: 500 }).catch(
            (error: unknown) => error as { code?: string },
        );
        expect(early).toMatchObject({ code: 'timeout' });

        // The old relay's call of A is mined, then final.
        await stack.mine(1);
        await oldRelay.tick();
        expect((await oldRelay.state(a.signed.id)).status).toBe('mined');
        await stack.setAutomine(true);
        await stack.mine(70);
        const outcome = await waitForTransferOutcome(stack.publicClient, pins, a.signed, { relay: wallet.client, pollIntervalMs: 50, timeoutMs: 15_000 });
        if (outcome.status === 'expired' || outcome.status === 'nonce_consumed') {
            replacementSigned = true; // README: only then is a new payment safe
            const c = await wallet.prepareAndSign();
            await wallet.client.submitTransfer(c.body);
            for (let pass = 0; pass < 5 && !['mined', 'confirmed'].includes((await newRelay.state(c.signed.id)).status); pass++) await newRelay.tick();
        }

        const timesPaid = ((await stack.balanceOf(stack.usdc, recipient)) - paidBefore) / AMOUNT;
        const userPaid = userBefore - (await stack.balanceOf(stack.usdc, wallet.user.address));
        expect({ replacementSigned, timesPaid }, `waitForTransferOutcome(A) = ${outcome.status}; the user paid ${userPaid} for one payment of ${AMOUNT} + fee`).toEqual({
            replacementSigned: false,
            timesPaid: 1n,
        });
        expect(outcome.status).toBe('executed');
        expect(userPaid).toBe(AMOUNT + BigInt(a.body.request.fee));
    });

    it('a wallet that signs a correction B for the new relay instead gets other_version_executed for B (A executed), never "a new payment is safe": paid once', async () => {
        const recipient: Address = anvilAccount(14).address;
        const pins: ChainPins = stack.pins([oldRelay.address, newRelay.address]);
        const { route, fetch: fetchImpl } = publicUrl();
        const wallet = walletFor(2, recipient, pins, fetchImpl);
        const paidBefore = await stack.balanceOf(stack.usdc, recipient);
        const userBefore = await stack.balanceOf(stack.usdc, wallet.user.address);

        const a = await firstPostThenRotation(route, wallet);
        // A correction of A for the new relay: same intent nonce (A is still unused on-chain), a deadline no earlier.
        const b = await wallet.prepareAndSign(a.prepared);
        expect({ relay: b.body.request.relay, nonce: b.body.request.nonce }).toEqual({ relay: newRelay.address, nonce: a.body.request.nonce });
        expect(BigInt(b.body.request.deadline)).toBeGreaterThanOrEqual(BigInt(a.body.request.deadline));
        expect(await wallet.client.submitTransfer(b.body)).toEqual({ id: b.signed.id, status: 'queued' });
        const coolingDown = () => ({
            oldRelay: oldRelay.server.relay.senderAdmission.cooldownSeconds(wallet.user.address) > 0,
            newRelay: newRelay.server.relay.senderAdmission.cooldownSeconds(wallet.user.address) > 0,
        });
        expect(coolingDown()).toEqual({ oldRelay: false, newRelay: false });

        // The old relay's call of A is mined. The new relay's B can no longer succeed.
        await stack.mine(1);
        await oldRelay.tick();
        expect((await oldRelay.state(a.signed.id)).status).toBe('mined');
        for (let pass = 0; pass < 5 && (await newRelay.state(b.signed.id)).status === 'queued'; pass++) {
            await newRelay.tick();
            await stack.mine(1);
        }
        const failedB = await wallet.client.waitForRequest(b.signed.id, { timeoutMs: 3_000, pollIntervalMs: 50 }).catch((error: unknown) => error);
        expect(failedB).toBeInstanceOf(RelayRequestFailedError); // README: run waitForTransferOutcome before trying again

        // sdk/README.md "Corrections": B failed the new relay's check before the broadcast (A had executed), with nothing
        // sent, so the failure is final at once. GaslessTransfer verifies the signature over the sender's current
        // nonce first, which A used up: the simulation reverts with InvalidSignature and the relay reports nonce_used.
        // The new relay counts it as caused by the sender: the sender cools down there (the signed `from`, not the
        // wallet's network address), and its requests there go one at a time (one is queued, a second one gets
        // rate_limited, retryable). Other senders and the old relay are not affected.
        expect({ relayCode: (failedB as RelayRequestFailedError).relayCode, final: (failedB as RelayRequestFailedError).final }).toEqual({
            relayCode: 'nonce_used',
            final: true,
        });
        expect(coolingDown()).toEqual({ oldRelay: false, newRelay: true });
        const otherRecipient: Address = anvilAccount(15).address;
        // The same sender (user 2) pays another recipient; these stay queued (the test drives no pass that sends them).
        const same = walletFor(2, otherRecipient, pins, fetchImpl);
        const firstPayment = await same.prepareAndSign();
        expect(await same.client.submitTransfer(firstPayment.body)).toEqual({ id: firstPayment.signed.id, status: 'queued' });
        // Another request of the sender (to a third recipient; prepareTransfer gives it the same next nonce, as the first
        // is not mined): the cool-down refuses it before the nonce checks.
        const secondPayment = await walletFor(2, anvilAccount(16).address, pins, fetchImpl).prepareAndSign();
        expect(secondPayment.body.request.nonce).toBe(firstPayment.body.request.nonce);
        await expect(same.client.submitTransfer(secondPayment.body)).rejects.toMatchObject({ name: 'RelayApiError', code: 'rate_limited', status: 429, retryable: true });
        const other = walletFor(3, otherRecipient, pins, fetchImpl);
        const otherPayment = await other.prepareAndSign();
        expect(await other.client.submitTransfer(otherPayment.body)).toEqual({ id: otherPayment.signed.id, status: 'queued' });

        // README: waitForTransferOutcome with the latest version (B), read at the finalized block.
        await stack.setAutomine(true);
        await stack.mine(70);
        const outcome = await waitForTransferOutcome(stack.publicClient, pins, b.signed, { relay: wallet.client, pollIntervalMs: 50, timeoutMs: 15_000 });

        let replacementSigned = false;
        if (outcome.status === 'expired' || outcome.status === 'nonce_consumed') {
            replacementSigned = true;
            const c = await wallet.prepareAndSign(); // a new payment: the sender's next intent nonce
            await wallet.client.submitTransfer(c.body);
            for (let pass = 0; pass < 5 && !['mined', 'confirmed'].includes((await newRelay.state(c.signed.id)).status); pass++) await newRelay.tick();
        }

        const timesPaid = ((await stack.balanceOf(stack.usdc, recipient)) - paidBefore) / AMOUNT;
        const userPaid = userBefore - (await stack.balanceOf(stack.usdc, wallet.user.address));
        expect(
            { replacementSigned, timesPaid },
            `waitForTransferOutcome(B) = ${outcome.status} (relay: ${outcome.relayState?.status}/${outcome.relayState?.error?.code}); ` +
                `the user paid ${userPaid} for one payment of ${AMOUNT} + fee`,
        ).toEqual({ replacementSigned: false, timesPaid: 1n });
        // What executed is A: the old relay, A's fee.
        expect({ status: outcome.status, relay: outcome.executedTransfer?.request.relay, fee: outcome.executedTransfer?.request.fee }).toEqual({
            status: 'other_version_executed',
            relay: oldRelay.address,
            fee: a.body.request.fee,
        });
    });
});
