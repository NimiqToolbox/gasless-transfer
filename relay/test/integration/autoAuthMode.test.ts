// The wallet side without a forced auth mode, against the real relay and the production GaslessTransfer on anvil:
// prepareTransfer chooses the mode itself (none if a standing allowance covers amount + fee, else
// permit, never the META_TX for USDT0), and the relay mines the result under the exact-allowance rule. The
// other integration files always pass an explicit authMode.
//
// The last describe block checks the SDK's reading of a failure after a broadcast against the real
// relay: a call that reverted on-chain is only a provisional failure. waitForRequest reports it with
// final: false until the deadline plus its settle margin, and waitForTransferOutcome answers "expired" only once
// a finalized block is past the deadline. It stops the relay's polling loop and anvil's automine, so it runs last.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseGwei, type Address, type Hash, type PrivateKeyAccount } from 'viem';
import { foundry } from 'viem/chains';
import { NO_TOKEN_AUTHORIZATION, buildSubmitTransferBody, gaslessTransferAbi, type AuthModeName } from '@nimiq/gasless-sdk/core';
import { RelayClient, type RequestState } from '@nimiq/gasless-sdk/relay';
import {
    confirmOnChain,
    prepareTransfer,
    signPrepared,
    waitForTransferOutcome,
    type PreparedTransfer,
    type SignedTransfer,
} from '@nimiq/gasless-sdk/viem';
import { startRelay, type RunningRelay } from './helpers/relay.js';
import { anvilAccount, mockTokenAbi, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;

beforeAll(async () => {
    stack = await startStack();
    // anvil's finalized tag trails the head by 64 blocks. Past the deployment, the finalized-block reads of
    // waitForTransferOutcome find the contract (the deployment file's deployBlock is only a lower bound).
    await stack.mine(100);
    relay = await startRelay(stack);
});

afterAll(async () => {
    await relay?.stop();
    await stack?.stop();
});

const RECIPIENT: Address = anvilAccount(13).address;
const WAIT = { timeoutMs: 30_000, pollIntervalMs: 100 } as const;

interface AutoTransfer {
    readonly prepared: PreparedTransfer;
    /** The signed version: its id (the request id) and authHash for the outcome checks. */
    readonly signed: SignedTransfer;
    readonly body: ReturnType<typeof buildSubmitTransferBody>;
}

/** What a wallet does without choosing a mode: quote permit (it also covers none), prepare, sign, build the body. */
async function autoTransfer(from: number, token: Address, amount: bigint): Promise<AutoTransfer> {
    const account = anvilAccount(from);
    const quote = await relay.client.fee({ token, authMode: 'permit' });
    const prepared = await prepareTransfer(stack.publicClient, relay.pins, {
        token,
        from: account.address,
        to: RECIPIENT,
        amount,
        fee: quote.fee,
        relay: quote.relay,
        // no authMode: prepareTransfer decides
    });
    const signed = await signPrepared(account, prepared, relay.pins);
    expect(signed.authorization.mode).toBe(prepared.authMode);
    return { prepared, signed, body: buildSubmitTransferBody({ request: signed.request, signature: signed.signature, authorization: signed.authorization, quoteId: quote.quoteId }) };
}

async function approve(from: number, token: Address, value: bigint): Promise<void> {
    await stack.send(anvilAccount(from), { address: token, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, value] });
}

/** Submits, waits for mined, and checks the token movements, the allowance left and the event. */
async function relayAndCheck(t: AutoTransfer, allowanceAfter: bigint): Promise<RequestState> {
    const r = t.body.request;
    const [fromBefore, toBefore, relayBefore] = await Promise.all([
        stack.balanceOf(r.token, r.from),
        stack.balanceOf(r.token, r.to),
        stack.balanceOf(r.token, relay.address),
    ]);
    expect(await relay.client.submitTransfer(t.body)).toEqual({ id: t.signed.id, status: 'queued' });
    const state = await relay.client.waitForRequest(t.signed.id, WAIT);
    expect(state.status).toBe('mined');
    const amount = BigInt(r.amount);
    const fee = BigInt(r.fee);
    expect(await stack.balanceOf(r.token, r.from)).toBe(fromBefore - amount - fee);
    expect(await stack.balanceOf(r.token, r.to)).toBe(toBefore + amount);
    expect(await stack.balanceOf(r.token, relay.address)).toBe(relayBefore + fee);
    expect(await stack.balanceOf(r.token, stack.transfer)).toBe(0n);
    expect(await stack.allowance(r.token, r.from, stack.transfer)).toBe(allowanceAfter);
    // GaslessTransfer emits no event of its own; the intent nonce is used.
    const receipt = await stack.publicClient.getTransactionReceipt({ hash: state.txHash! });
    expect(receipt.logs.filter((log) => log.address.toLowerCase() === stack.transfer.toLowerCase())).toEqual([]);
    expect(await stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [r.from] })).toBe(BigInt(r.nonce) + 1n);
    expect((await confirmOnChain(stack.publicClient, relay.pins, t.signed, { txHash: state.txHash! })).status).toBe('executed');
    return state;
}

describe('prepareTransfer without authMode, through the relay to the production GaslessTransfer', () => {
    it('without an allowance: permit for USDC and for USDT0 (never the META_TX); mined, exact amounts, no allowance left', async () => {
        for (const [from, token] of [
            [1, stack.usdc],
            [2, stack.usdt0],
        ] as const) {
            const t = await autoTransfer(from, token, 2_000_000n);
            expect(t.prepared.authMode, token).toBe('permit');
            expect(t.prepared.tokenAuth?.primaryType).toBe('Permit');
            await relayAndCheck(t, 0n);
        }
    });

    it('with a standing allowance above amount + fee: none; mined, and the rest of the allowance stays', async () => {
        for (const [from, token] of [
            [3, stack.usdc],
            [4, stack.usdt0],
        ] as const) {
            await approve(from, token, 50_000_000n);
            const t = await autoTransfer(from, token, 2_000_000n);
            expect(t.prepared.authMode, token).toBe('none');
            expect(t.body.authorization).toEqual(NO_TOKEN_AUTHORIZATION);
            await relayAndCheck(t, 50_000_000n - 2_000_000n - BigInt(t.body.request.fee));
        }
    });

    it('an allowance of exactly amount + fee gives none (0 left); one unit less gives permit, which replaces it (0 left)', async () => {
        const quote = await relay.client.fee({ token: stack.usdt0, authMode: 'permit' });
        const value = 3_000_000n + BigInt(quote.fee);
        const cases: Array<[number, bigint, AuthModeName]> = [
            [5, value, 'none'],
            [6, value - 1n, 'permit'],
        ];
        for (const [from, standing, mode] of cases) {
            await approve(from, stack.usdt0, standing);
            const t = await autoTransfer(from, stack.usdt0, 3_000_000n);
            expect(BigInt(t.body.request.fee), 'the quote did not change').toBe(BigInt(quote.fee));
            expect(t.prepared.authMode, `standing ${standing}`).toBe(mode);
            await relayAndCheck(t, 0n);
        }
    });

    it('waitForTransferOutcome reads "executed" once the inclusion is in a finalized block', async () => {
        const t = await autoTransfer(7, stack.usdc, 1_000_000n);
        const state = await relayAndCheck(t, 0n);
        // anvil's finalized tag is 64 blocks behind the head: not final yet.
        const early = await waitForTransferOutcome(stack.publicClient, relay.pins, t.signed, { relay: relay.client, pollIntervalMs: 50, timeoutMs: 300 }).catch(
            (error: unknown) => (error as { code?: string }).code,
        );
        expect(early).toBe('timeout');
        await stack.mine(70);
        const outcome = await waitForTransferOutcome(stack.publicClient, relay.pins, t.signed, { relay: relay.client, pollIntervalMs: 50, timeoutMs: 10_000 });
        expect({ status: outcome.status, txHash: outcome.txHash, blockNumber: outcome.blockNumber?.toString() }).toEqual({
            status: 'executed',
            txHash: state.txHash,
            blockNumber: state.blockNumber,
        });
        expect(['mined', 'confirmed']).toContain(outcome.relayState?.status);
    });
});

describe('against the real relay: a call that reverted on-chain is a provisional failure', () => {
    /**
     * Sends an approve with a tip far above the relay's, so that it is ordered before the relay's call. The gas
     * limit is explicit: anvil would estimate against the pending block, after the relay's call.
     */
    async function sendAhead(account: PrivateKeyAccount, token: Address, value: bigint): Promise<Hash> {
        const wallet = createWalletClient({ account, chain: foundry, transport: http(stack.rpcUrl) });
        return wallet.writeContract({
            address: token,
            abi: mockTokenAbi,
            functionName: 'approve',
            args: [stack.transfer, value],
            gas: 200_000n,
            maxFeePerGas: parseGwei('2000'),
            maxPriorityFeePerGas: parseGwei('500'),
        });
    }

    it('waitForRequest: final false before deadline + settle margin, final true after it; waitForTransferOutcome: expired only once a finalized block is past the deadline', async () => {
        await relay.server.relay.txManager.stop(); // passes are driven by this test from here on
        await stack.setAutomine(false);
        const from = 8;
        const user = anvilAccount(from);
        const probe = await relay.client.fee({ token: stack.usdc, authMode: 'permit' });
        await approve(from, stack.usdc, 1_000_000n + BigInt(probe.fee));
        const t = await autoTransfer(from, stack.usdc, 1_000_000n);
        expect(t.prepared.authMode).toBe('none');
        expect(await relay.client.submitTransfer(t.body)).toEqual({ id: t.signed.id, status: 'queued' });
        await relay.tick(); // broadcast
        expect(relay.server.store.listAttempts(t.signed.id).map((a) => a.kind)).toEqual(['call']);

        // The sender revokes the allowance ahead of the relay's call: the call is included and reverts.
        const revoke = await sendAhead(user, stack.usdc, 0n);
        await stack.mine();
        expect((await stack.publicClient.getTransactionReceipt({ hash: revoke })).status).toBe('success');
        await relay.tick();
        const failed = await relay.state(t.signed.id);
        expect(failed.status).toBe('failed');
        expect(failed.transactions.length).toBeGreaterThan(0);

        // The relay may still revise this outcome (a reorg): waitForRequest keeps polling and, at its timeout,
        // reports it with final: false.
        const provisional = await relay.client.waitForRequest(t.signed.id, { timeoutMs: 600, pollIntervalMs: 50 }).catch((error: unknown) => error);
        expect(provisional).toMatchObject({ code: 'request_failed', final: false });
        expect((provisional as { state: RequestState }).state.status).toBe('failed');

        // A client whose clock is past deadline + 180 s reports it as final at once.
        const deadline = Number(t.body.request.deadline);
        const later = new RelayClient(relay.url, { pins: relay.pins, now: () => deadline + 181 });
        const final = await later.waitForRequest(t.signed.id, { timeoutMs: 5_000, pollIntervalMs: 50 }).catch((error: unknown) => error);
        expect(final).toMatchObject({ code: 'request_failed', final: true });

        // On-chain the intent could still execute until its deadline: not final.
        const early = await waitForTransferOutcome(stack.publicClient, relay.pins, t.signed, { relay: relay.client, pollIntervalMs: 50, timeoutMs: 300 }).catch(
            (error: unknown) => (error as { code?: string }).code,
        );
        expect(early).toBe('timeout');
        expect((await confirmOnChain(stack.publicClient, relay.pins, t.signed)).status).toBe('pending');

        // Past the deadline by chain time, and 70 blocks later (anvil finalizes 64 blocks behind the head).
        await stack.testClient.increaseTime({ seconds: 700 });
        await stack.mine(70);
        const outcome = await waitForTransferOutcome(stack.publicClient, relay.pins, t.signed, { relay: relay.client, pollIntervalMs: 50, timeoutMs: 10_000 });
        expect({ status: outcome.status, txHash: outcome.txHash, relayStatus: outcome.relayState?.status }).toEqual({
            status: 'expired',
            txHash: null,
            relayStatus: 'failed',
        });
        // Nothing moved except what the sender did itself: the intent nonce is unused.
        expect(await stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [t.body.request.from] })).toBe(
            BigInt(t.body.request.nonce),
        );
    });
});
