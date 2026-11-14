// Transfers through the real GaslessTransfer on anvil (automine), relay in-process with the production
// startup code and its polling loop. Wallet side only through the SDK:
// fee → prepareTransfer → sign (viem; ethers v5; ethers v6) → submitTransfer → mined → exact balances.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erc20Abi, parseEventLogs, type Address } from 'viem';
import { AUTH_MODE_ID, gaslessTransferAbi, maxSendable } from '@nimiq/gasless-sdk/core';
import type { RequestState } from '@nimiq/gasless-sdk/relay';
import { postRaw, signTransfer, startRelay, type RunningRelay, type SignedTransfer } from './helpers/relay.js';
import { RELAY_INDEX, anvilAccount, anvilKey, mockTokenAbi, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;
/** Every body sent in this file (for the log check). */
const submitted: SignedTransfer[] = [];

beforeAll(async () => {
    stack = await startStack();
    relay = await startRelay(stack);
});

afterAll(async () => {
    await relay?.stop();
    await stack?.stop();
});

const WAIT = { timeoutMs: 30_000, pollIntervalMs: 100 } as const;

/** Submits through the SDK client, waits for `mined` and checks every token movement and the chain. */
async function relayAndCheck(t: SignedTransfer, token: Address): Promise<RequestState> {
    const r = t.body.request;
    const amount = BigInt(r.amount);
    const fee = BigInt(r.fee);
    const [fromBefore, toBefore, relayBefore] = await Promise.all([
        stack.balanceOf(token, r.from),
        stack.balanceOf(token, r.to),
        stack.balanceOf(token, relay.address),
    ]);

    submitted.push(t);
    expect(await relay.client.submitTransfer(t.body)).toEqual({ id: t.id, status: 'queued' });
    const state = await relay.client.waitForRequest(t.id, WAIT);
    expect(state.status).toBe('mined');
    expect(state.error).toBeNull();
    expect(state.request).toEqual(r);

    // Exact amounts: from pays amount + fee, to gets amount, the relay gets fee; no custody, no allowance left.
    expect(await stack.balanceOf(token, r.from)).toBe(fromBefore - amount - fee);
    expect(await stack.balanceOf(token, r.to)).toBe(toBefore + amount);
    expect(await stack.balanceOf(token, relay.address)).toBe(relayBefore + fee);
    expect(await stack.balanceOf(token, stack.transfer)).toBe(0n);
    expect(await stack.allowance(token, r.from, stack.transfer)).toBe(0n);

    // On-chain: the relay called the contract. GaslessTransfer emits no event of its own; the token moved the fee
    // to the relay first, then the amount to the recipient, both from `from`.
    const hash = state.txHash!;
    const [tx, receipt] = await Promise.all([stack.publicClient.getTransaction({ hash }), stack.publicClient.getTransactionReceipt({ hash })]);
    expect(tx.from.toLowerCase()).toBe(relay.address.toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(stack.transfer.toLowerCase());
    expect(receipt.status).toBe('success');
    expect(state.blockNumber).toBe(receipt.blockNumber.toString());
    expect(state.transactions).toEqual([{ hash, txNonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas!.toString(), status: 'mined' }]);
    expect(receipt.logs.filter((log) => log.address.toLowerCase() === stack.transfer.toLowerCase())).toEqual([]);
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs.filter((log) => log.address.toLowerCase() === token.toLowerCase()) });
    expect(transfers.map(({ args }) => ({ from: args.from.toLowerCase(), to: args.to.toLowerCase(), value: args.value }))).toEqual([
        { from: r.from.toLowerCase(), to: relay.address.toLowerCase(), value: fee },
        { from: r.from.toLowerCase(), to: r.to.toLowerCase(), value: amount },
    ]);
    // The intent nonce is used: the sender's next nonce is the following one.
    const next = await stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [r.from] });
    expect(next).toBe(BigInt(r.nonce) + 1n);
    // The request id is the contract's hashTransfer (at the request's nonce, over the signed token authorization).
    const a = t.body.authorization;
    const hashTransfer = await stack.publicClient.readContract({
        address: stack.transfer,
        abi: gaslessTransferAbi,
        functionName: 'hashTransfer',
        args: [
            { token: r.token, from: r.from, to: r.to, amount, fee, relay: r.relay, deadline: BigInt(r.deadline) },
            BigInt(r.nonce),
            { mode: AUTH_MODE_ID[a.mode], v: a.v, r: a.r, s: a.s },
        ],
    });
    expect(hashTransfer).toBe(t.id);
    return state;
}

describe('fee → sign → submit → mined, with exact balances', () => {
    it.each([
        ['USDC', 'permit', 1],
        ['USDC', 'none', 2],
        ['USDT0', 'permit', 3],
        ['USDT0', 'metaTxApprove', 4],
        ['USDT0', 'none', 5],
    ] as const)('%s with %s (viem)', async (symbol, authMode, from) => {
        const token = symbol === 'USDC' ? stack.usdc : stack.usdt0;
        const amount = 12_340_000n;
        const t = await signTransfer(stack, relay, { from, token, authMode, to: anvilAccount(11).address, amount });
        expect(t.body.request.fee).toBe(t.quote.fee);
        if (authMode === 'none') {
            // NONE mode: the sender approved the contract beforehand (still signs the intent).
            const value = amount + BigInt(t.body.request.fee);
            await stack.send(anvilAccount(from), { address: token, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, value] });
        }
        await relayAndCheck(t, token);
    });

    // Nothing but the sender's signature bounds the fee, and the relay refuses none for its height.
    it.each([
        ['USDC', 'permit', 1],
        ['USDT0', 'metaTxApprove', 4],
    ] as const)('%s with %s and a fee of 50.00 is relayed and paid exactly', async (symbol, authMode, from) => {
        const token = symbol === 'USDC' ? stack.usdc : stack.usdt0;
        const t = await signTransfer(stack, relay, { from, token, authMode, to: anvilAccount(12).address, amount: 1_000_000n, fee: 50_000_000n });
        expect(t.body.request.fee).toBe('50000000');
        await relayAndCheck(t, token);
    });

    it('USDC permit signed with ethers v5 (_signTypedData on the SDK payloads)', async () => {
        const t = await signTransfer(stack, relay, {
            from: 6,
            token: stack.usdc,
            authMode: 'permit',
            to: anvilAccount(12).address,
            amount: 2_500_000n,
            signer: 'ethers5',
        });
        await relayAndCheck(t, stack.usdc);
    });

    // §8 names ethers v6 among the signers of the fee → sign → submit → mined round trip.
    // USDT0 meta-tx covers the salt domain and the `bytes functionSignature` field in ethers v6.
    it.each([
        ['USDC', 'permit', 7],
        ['USDT0', 'metaTxApprove', 6],
    ] as const)('%s with %s signed with ethers v6 (signTypedData on the SDK payloads)', async (symbol, authMode, from) => {
        const token = symbol === 'USDC' ? stack.usdc : stack.usdt0;
        const t = await signTransfer(stack, relay, { from, token, authMode, to: anvilAccount(12).address, amount: 2_500_000n, signer: 'ethers6' });
        await relayAndCheck(t, token);
    });

    it('cashlink: an ephemeral key without POL sends its whole balance minus the fee', async () => {
        const cashlink = anvilAccount(15);
        const claimer = anvilAccount(16).address;
        await stack.testClient.setBalance({ address: cashlink.address, value: 0n }); // no POL at all
        await stack.send(anvilAccount(7), { address: stack.usdc, abi: mockTokenAbi, functionName: 'transfer', args: [cashlink.address, 5_000_000n] });
        const balance = await stack.balanceOf(stack.usdc, cashlink.address);
        const quote = await relay.client.fee({ token: stack.usdc, authMode: 'permit' });
        const amount = maxSendable(balance, quote.fee);
        const t = await signTransfer(stack, relay, { from: 15, token: stack.usdc, authMode: 'permit', to: claimer, amount, fee: BigInt(quote.fee) });
        await relayAndCheck(t, stack.usdc);
        expect(await stack.balanceOf(stack.usdc, cashlink.address)).toBe(0n);
        expect(await stack.balanceOf(stack.usdc, claimer)).toBe(balance - BigInt(quote.fee));
        expect(await stack.publicClient.getBalance({ address: cashlink.address })).toBe(0n);
    });
});

describe('request lifecycle', () => {
    it('becomes confirmed at the finalized block (anvil: head − 64); stored signatures and raw txs are purged', async () => {
        const t = await signTransfer(stack, relay, { from: 8, token: stack.usdt0, authMode: 'metaTxApprove', to: anvilAccount(12).address, amount: 1_000_000n });
        const mined = await relayAndCheck(t, stack.usdt0);
        // While only mined, the relay keeps what it needs to re-broadcast after a reorg.
        expect(relay.server.store.getRequest(t.id)!.signature).not.toBeNull();
        await stack.mine(64);
        const confirmed = await relay.client.waitForRequest(t.id, { ...WAIT, until: 'confirmed' });
        expect(confirmed.status).toBe('confirmed');
        expect(confirmed.txHash).toBe(mined.txHash);
        const record = relay.server.store.getRequest(t.id)!;
        expect(record.signature).toBeNull();
        expect(record.authorization).toBeNull();
        expect(relay.server.store.listAttempts(t.id).every((a) => a.raw === null)).toBe(true);
    });

    it('an identical re-post returns 200 with the current state; a different payload for the mined nonce is nonce_used', async () => {
        const to = anvilAccount(13).address;
        const t = await signTransfer(stack, relay, { from: 9, token: stack.usdc, authMode: 'permit', to, amount: 1_000_000n });
        submitted.push(t);
        expect(await postRaw(relay, t.body)).toEqual({ status: 202, json: { id: t.id, status: 'queued' } });
        const again = await postRaw(relay, t.body);
        expect(again.status).toBe(200);
        expect(again.json).toMatchObject({ id: t.id });
        await relay.client.waitForRequest(t.id, WAIT);
        expect(await postRaw(relay, t.body)).toEqual({ status: 200, json: { id: t.id, status: 'mined' } });

        // Built with the core: prepareTransfer refuses a nonce without corrects, and with corrects it would refuse the used
        // nonce itself (nonce_used) before signing. The relay's answer is what this test checks.
        const other = await signTransfer(stack, relay, { from: 9, token: stack.usdc, authMode: 'permit', to, amount: 2_000_000n, nonce: t.body.request.nonce });
        submitted.push(other);
        await expect(relay.client.submitTransfer(other.body)).rejects.toMatchObject({ code: 'nonce_used', status: 409 });
    });

    it('T36: logged no signature, token authorization, raw transaction or key', async () => {
        const text = relay.logs.text().toLowerCase();
        expect(text).toContain('request mined');
        expect(submitted.length).toBeGreaterThanOrEqual(9);
        expect(text).not.toContain(anvilKey(RELAY_INDEX).slice(2).toLowerCase());
        for (const t of submitted) {
            expect(text).not.toContain(t.body.signature.slice(2).toLowerCase());
            const auth = t.body.authorization;
            if (auth.mode !== 'none') {
                expect(text).not.toContain(auth.r!.slice(2).toLowerCase());
                expect(text).not.toContain(auth.s!.slice(2).toLowerCase());
            }
            // Rejected submissions (nonce_used above) are not stored.
            const record = relay.server.store.getRequest(t.id);
            if (record?.finalTxHash) {
                const tx = await stack.publicClient.getTransaction({ hash: record.finalTxHash });
                expect(text).not.toContain(tx.input.slice(2, 202).toLowerCase()); // calldata (embeds the signatures)
            }
        }
    });
});
