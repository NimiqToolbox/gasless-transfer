// Transaction manager and concurrency against the real contract. anvil runs with automine off and the
// relay's polling loop is stopped: each test drives mining (base fee, timestamps, mempool drops) and
// the transaction manager passes explicitly, so every intermediate state is observable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { postRaw, signTransfer, startRelay, type RunningRelay, type SignedTransfer } from './helpers/relay.js';
import { anvilAccount, mockTokenAbi, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;

beforeAll(async () => {
    stack = await startStack();
    // The bursts below send 20 submissions per signer; the default limit is 10 per minute. Submissions that read
    // the chain are also limited relay-wide (RELAY_RATE_LIMIT_SUBMIT_MAX, default 120 per minute), which the bursts
    // of this file may exceed.
    relay = await startRelay(stack, { env: { RELAY_RATE_LIMIT_SIGNER_MAX: '100', RELAY_RATE_LIMIT_SUBMIT_MAX: '1000' } });
    await relay.server.relay.txManager.stop(); // passes are driven by the tests
    await stack.setAutomine(false);
});

afterAll(async () => {
    await relay?.stop();
    await stack?.stop();
});

const RECIPIENT: Address = anvilAccount(11).address;

async function submit(t: SignedTransfer): Promise<void> {
    expect(await relay.client.submitTransfer(t.body)).toEqual({ id: t.id, status: 'queued' });
}

function attempts(id: Hex) {
    return relay.server.store.listAttempts(id);
}

/** The transaction manager logged that the node no longer had this request's transaction. */
function loggedMissing(id: Hex): boolean {
    return relay.logs.lines.some((l) => l.includes('transaction missing from the mempool') && l.includes(id));
}

/** True while the node holds the transaction in its mempool. */
async function inMempool(hash: Hex): Promise<boolean> {
    try {
        return (await stack.publicClient.getTransaction({ hash })).blockNumber === null;
    } catch {
        return false;
    }
}

/** The sender's next intent nonce (GaslessTransfer.nonces). */
function nextNonce(from: Address): Promise<bigint> {
    return stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [from] });
}

async function tokenBalances(token: Address, t: SignedTransfer): Promise<bigint[]> {
    return Promise.all([t.body.request.from, t.body.request.to, relay.address].map((a) => stack.balanceOf(token, a)));
}

function expectMoved(before: readonly bigint[], after: readonly bigint[], t: SignedTransfer): void {
    const amount = BigInt(t.body.request.amount);
    const fee = BigInt(t.body.request.fee);
    expect(after).toEqual([before[0]! - amount - fee, before[1]! + amount, before[2]! + fee]);
}

describe('T32: concurrency', () => {
    it('20 concurrent identical submits: one 202, nineteen 200, one transfer on-chain', async () => {
        const t = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 3_000_000n });
        const before = await tokenBalances(stack.usdc, t);
        const results = await Promise.all(Array.from({ length: 20 }, () => postRaw(relay, t.body)));
        expect(results.filter((r) => r.status === 202)).toHaveLength(1);
        expect(results.filter((r) => r.status === 200)).toHaveLength(19);
        for (const r of results) expect(r.json).toEqual({ id: t.id, status: 'queued' });
        expect(relay.server.store.nonceHolder(stack.transfer, t.body.request.from, t.body.request.nonce)?.id).toBe(t.id);

        await relay.tick(); // broadcast
        await stack.mine();
        await relay.tick(); // mined
        expect((await relay.state(t.id)).status).toBe('mined');
        expectMoved(before, await tokenBalances(stack.usdc, t), t);
    });

    it('20 concurrent conflicting submits (one nonce, 20 amounts): one 202, nineteen 409 conflict; only that one executes', async () => {
        const nonce = await nextNonce(anvilAccount(2).address);
        // Twenty bodies for one nonce, built with the core (prepareTransfer refuses a nonce without corrects).
        const bodies = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                signTransfer(stack, relay, { from: 2, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n + BigInt(i), nonce }),
            ),
        );
        expect(new Set(bodies.map((b) => b.id)).size).toBe(20);
        const before = await tokenBalances(stack.usdc, bodies[0]!);
        const results = await Promise.all(bodies.map((b) => postRaw(relay, b.body)));
        const accepted = results.flatMap((r, i) => (r.status === 202 ? [bodies[i]!] : []));
        expect(accepted).toHaveLength(1);
        const rejected = results.filter((r) => r.status !== 202);
        expect(rejected).toHaveLength(19);
        for (const r of rejected) expect(r).toEqual({ status: 409, json: { error: { code: 'conflict', message: expect.any(String) } } });

        const winner = accepted[0]!;
        await relay.tick();
        await stack.mine();
        await relay.tick();
        expect((await relay.state(winner.id)).status).toBe('mined');
        expectMoved(before, await tokenBalances(stack.usdc, winner), winner);
    });
});

describe('one pending request per sender', () => {
    it("while a permit is in flight, the sender's other requests are refused (conflict at its nonce, nonce_too_high above), whatever the token and mode; the next one goes through once it is mined", async () => {
        const from = 3;
        const owner = anvilAccount(from);
        // An allowance for the NONE attempt below (mined before the permit request exists).
        await stack.send(owner, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 10n ** 12n] });

        const a = await signTransfer(stack, relay, { from, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(a);
        await relay.tick();
        expect((await relay.state(a.id)).status).toBe('submitted');
        const nonce = BigInt(a.body.request.nonce);

        // Signed now, while a is in flight: prepareTransfer reads the sender's nonce, which is still a's.
        const b = await signTransfer(stack, relay, { from, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 2_000_000n });
        const c = await signTransfer(stack, relay, { from, token: stack.usdt0, authMode: 'none', to: RECIPIENT, amount: 500_000n });
        const other = await signTransfer(stack, relay, { from, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 700_000n });
        for (const t of [b, c, other]) {
            expect(t.body.request.nonce).toBe(a.body.request.nonce);
            await expect(relay.client.submitTransfer(t.body)).rejects.toMatchObject({ code: 'conflict', status: 409 });
        }
        const following = await signTransfer(stack, relay, { from, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 700_000n, nonce: nonce + 1n });
        await expect(relay.client.submitTransfer(following.body)).rejects.toMatchObject({ code: 'nonce_too_high', status: 409 });

        await stack.mine();
        await relay.tick();
        expect((await relay.state(a.id)).status).toBe('mined');
        // a used the nonce b was signed for: b can never execute, so the wallet signs again (at the next nonce).
        await expect(relay.client.submitTransfer(b.body)).rejects.toMatchObject({ code: 'nonce_used', status: 409 });
        const b2 = await signTransfer(stack, relay, { from, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 2_000_000n });
        expect(b2.body.request.nonce).toBe(String(nonce + 1n));
        await submit(b2);
        await relay.tick();
        await stack.mine();
        await relay.tick();
        expect((await relay.state(b2.id)).status).toBe('mined');
        expect(await nextNonce(owner.address)).toBe(nonce + 2n);
    });
});

describe('speed-up, dropped transactions, expiry', () => {
    it('T34: base-fee spike: the priced-out transaction is sped up after 10 blocks; txHash is the included replacement', async () => {
        const t = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 4_000_000n });
        const before = await tokenBalances(stack.usdc, t);
        await submit(t);
        await relay.tick();
        const [first] = attempts(t.id);
        const spike = first!.maxFeePerGas * 3n;
        for (let i = 0; i < 9; i++) {
            await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: spike });
            await stack.mine();
        }
        await relay.tick();
        // 9 blocks: no replacement yet. (anvil evicts the priced-out transaction, unlike geth/Bor,
        // which keep it; the relay notices and re-sends it, which anvil refuses while the fee cap is
        // below the base fee.)
        expect(attempts(t.id)).toHaveLength(1);
        expect(loggedMissing(t.id)).toBe(true);
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: spike });
        await stack.mine();
        expect((await relay.state(t.id)).status).toBe('submitted');
        await relay.tick(); // 10 blocks: re-simulate, then replace at the same nonce

        const [, second] = attempts(t.id);
        expect(second).toBeDefined();
        expect(second!.kind).toBe('call');
        expect(second!.txNonce).toBe(first!.txNonce);
        // Both fee fields: max(+20%, the market price 2 × baseFee(head) + tip), capped at RELAY_MAX_FEE_PER_GAS_GWEI.
        expect(second!.maxFeePerGas).toBeGreaterThanOrEqual(spike * 2n + 30_000_000_000n);
        expect(second!.maxFeePerGas).toBeLessThanOrEqual(3_000_000_000_000n);
        expect(second!.maxPriorityFeePerGas).toBeGreaterThanOrEqual((first!.maxPriorityFeePerGas * 120n + 99n) / 100n);
        expect(await inMempool(second!.hash)).toBe(true);
        expect(await inMempool(first!.hash)).toBe(false); // replaced in the node's pool

        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: spike });
        await stack.mine();
        await relay.tick();
        const state = await relay.state(t.id);
        expect(state.status).toBe('mined');
        expect(state.txHash).toBe(second!.hash);
        expect(state.transactions.map((x) => [x.hash, x.status])).toEqual([
            [first!.hash, 'replaced'],
            [second!.hash, 'mined'],
        ]);
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: second!.hash });
        expect(receipt.effectiveGasPrice).toBeGreaterThanOrEqual(spike);
        expectMoved(before, await tokenBalances(stack.usdc, t), t);
        // Back to a normal base fee for the next tests.
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 1_000_000_000n });
        await stack.mine();
    });

    it('T34: a transaction dropped from the mempool is re-sent at the next pass (the same signed transaction)', async () => {
        const t = await signTransfer(stack, relay, { from: 5, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 5_000_000n });
        const before = await tokenBalances(stack.usdt0, t);
        await submit(t);
        await relay.tick();
        const [attempt] = attempts(t.id);
        expect(await inMempool(attempt!.hash)).toBe(true);

        await stack.testClient.dropTransaction({ hash: attempt!.hash });
        expect(await inMempool(attempt!.hash)).toBe(false);
        await relay.tick();
        expect(await inMempool(attempt!.hash)).toBe(true);
        expect(attempts(t.id)).toHaveLength(1);
        expect(loggedMissing(t.id)).toBe(true);

        await stack.mine();
        await relay.tick();
        const state = await relay.state(t.id);
        expect(state.status).toBe('mined');
        expect(state.txHash).toBe(attempt!.hash);
        expectMoved(before, await tokenBalances(stack.usdt0, t), t);
    });

    // Moves chain time past the deadline: keep it last in this file.
    it('deadline passed while pending: a 0-value self-transfer takes the nonce → expired; nothing moved, secrets purged', async () => {
        const t = await signTransfer(stack, relay, {
            from: 6,
            token: stack.usdc,
            authMode: 'permit',
            to: RECIPIENT,
            amount: 6_000_000n,
            deadlineSeconds: 90,
        });
        const before = await tokenBalances(stack.usdc, t);
        await submit(t);
        await relay.tick();
        const [call] = attempts(t.id);
        const deadline = BigInt(t.body.request.deadline);
        const spike = call!.maxFeePerGas * 3n;

        // Priced out until 1 s before the deadline: head.timestamp + 2 s ≥ deadline → cancel.
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: spike });
        await stack.testClient.setNextBlockTimestamp({ timestamp: deadline - 1n });
        await stack.mine();
        await relay.tick();
        const [, cancel] = attempts(t.id);
        expect(cancel?.kind).toBe('cancel');
        expect(cancel!.txNonce).toBe(call!.txNonce);
        const cancelTx = await stack.publicClient.getTransaction({ hash: cancel!.hash });
        expect(cancelTx.to?.toLowerCase()).toBe(relay.address.toLowerCase());
        expect(cancelTx.from.toLowerCase()).toBe(relay.address.toLowerCase());
        expect(cancelTx.value).toBe(0n);
        expect(cancelTx.input).toBe('0x');
        expect(cancelTx.gas).toBe(21_000n);
        expect((await relay.state(t.id)).status).toBe('submitted'); // until a transaction takes the nonce

        const ethBefore = await stack.publicClient.getBalance({ address: relay.address });
        await stack.mine();
        await relay.tick();
        const state = await relay.state(t.id);
        expect(state.status).toBe('expired');
        expect(state.error?.code).toBe('deadline_out_of_range');
        expect(state.txHash).toBeNull();
        expect(state.transactions).toEqual([{ hash: call!.hash, txNonce: call!.txNonce, maxFeePerGas: call!.maxFeePerGas.toString(), status: 'replaced' }]);

        const receipt = await stack.publicClient.getTransactionReceipt({ hash: cancel!.hash });
        expect(receipt.status).toBe('success');
        expect(await stack.publicClient.getBalance({ address: relay.address })).toBe(ethBefore - receipt.gasUsed * receipt.effectiveGasPrice);
        expect(await tokenBalances(stack.usdc, t)).toEqual(before);
        // The intent nonce is unused: the sender's next nonce is still the request's.
        expect(await nextNonce(t.body.request.from)).toBe(BigInt(t.body.request.nonce));
        // The secrets are not purged when the cancel is seen included: failed and expired are
        // provisional until the deciding block is final (min(finalized tag, head - 16)); until then the request keeps
        // what it needs to be re-sent after a reorg, and its secrets are purged when it settles.
        expect(relay.server.store.getRequest(t.id)!.signature).not.toBeNull();
        await stack.mine(65); // anvil's finalized tag is head - 64
        await relay.tick();
        expect((await relay.state(t.id)).status).toBe('expired');
        const record = relay.server.store.getRequest(t.id)!;
        expect(record.settledAtMs).not.toBeNull();
        expect(record.signature).toBeNull();
        expect(record.authorization).toBeNull();
        expect(attempts(t.id).every((a) => a.raw === null)).toBe(true);
    });
});
