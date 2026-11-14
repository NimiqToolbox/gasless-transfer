// Nonce gaps and lying RPC answers around eth_sendRawTransaction / receipts / pending nonces.
// anvil with automine off; the relay's polling loop is stopped and every pass is driven by the test.
import { afterEach, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseGwei, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { confirmOnChain } from '@nimiq/gasless-sdk/viem';
import { method } from './helpers/rpcProxy.js';
import {
    RECIPIENT,
    anvilAccount,
    intentNonceUsed,
    keyOf,
    mineAndTick,
    relayNonces,
    relayTxsOnChain,
    requestKeyOf,
    signTransfer,
    startFaultEnv,
    status,
    submit,
    tick,
    type FaultEnv,
    type SignedTransfer,
} from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

/** The intent nonce of `t` is used (executed or invalidated). */
const nonceUsed = (e: FaultEnv, t: SignedTransfer): Promise<boolean> => intentNonceUsed(e.stack, t);

/** What a wallet following sdk/README sees: the relay's final state through waitForRequest, and confirmOnChain. */
async function sdkView(e: FaultEnv, t: SignedTransfer, txHash: Hex): Promise<{ sdkWaitForRequest: string; sdkConfirmOnChain: string }> {
    const waited = await e.relay.client.waitForRequest(t.id, { until: 'mined', timeoutMs: 2_000 }).then(
        (s) => s.status as string,
        (err: unknown) => (err as { code?: string }).code ?? String(err),
    );
    const onChain = await confirmOnChain(e.stack.publicClient, e.relay.pins, { request: t.body.request }, { txHash });
    return { sdkWaitForRequest: waited, sdkConfirmOnChain: onChain.status };
}

describe('nonce gaps (§6.5 nonce handling)', () => {
    it('after one false "nonce too low" answer the call keeps its nonce and is re-sent; it and the next request are mined at consecutive nonces', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const start = await relayNonces(stack, relay.address);
        const a = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);

        // The node (or a gateway in front of it) answers "nonce too low" once, without taking the transaction.
        proxy.add({
            name: 'lie-nonce-too-low',
            times: 1,
            match: method('eth_sendRawTransaction'),
            before: () => ({ kind: 'answer', answer: { error: { code: -32000, message: 'nonce too low' } } }),
        });
        await tick(relay);
        // "nonce too low" is not proof that the nonce is used, so the attempt keeps its nonce
        // and is re-sent at it while the chain has not used it.
        expect(await status(relay, a.id)).toBe('submitted');
        await tick(relay);
        await mineAndTick(env, 12);

        // A later request: a gap left at the nonce of `a` would hold it in the queue for good while /readyz reports
        // ready.
        const b =await signTransfer(stack, relay, { from: 5, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, b);
        await mineAndTick(env, 12);
        const readyz = await fetch(`${relay.url}/readyz`);
        const after = await relayNonces(stack, relay.address);
        const record = relay.server.store.getRequest(a.id)!;
        console.log('false nonce too low', {
            chainNonce: after.latest,
            relayTxNonce: record.txNonce,
            storedNext: relay.server.store.getNextNonce(),
            status: record.status,
            later: { status: await status(relay, b.id), txNonce: relay.server.store.getRequest(b.id)!.txNonce },
            readyz: readyz.status,
        });
        // The request is included (the relay never leaves an unfilled gap below its own transactions): a at the
        // original nonce, b right after it, and nothing else of the relay's in between.
        expect({ status: record.status, txNonce: record.txNonce, chainNonce: after.latest }).toEqual({ status: 'mined', txNonce: start.latest, chainNonce: start.latest + 2 });
        expect({ status: await status(relay, b.id), txNonce: relay.server.store.getRequest(b.id)!.txNonce }).toEqual({ status: 'mined', txNonce: start.latest + 1 });
    });

    it('pending transactions of the relay key, adopted at startup and then evicted by the node: their nonces are re-used and the request is mined', async () => {
        const opsTx: Hex[] = [];
        env = await startFaultEnv({
            async beforeRelay(stack) {
                // While the relay is down, an operator sends two low-fee transactions from the relay key
                // (e.g. a manual top-up of another wallet); the relay then starts with them pending.
                await stack.setAutomine(false);
                const relayAccount = anvilAccount(10);
                const base = (await stack.latestBlock()).baseFeePerGas;
                for (let i = 0; i < 2; i++) {
                    const wallet = createWalletClient({ account: relayAccount, chain: foundry, transport: http(stack.rpcUrl) });
                    opsTx.push(await wallet.sendTransaction({ to: anvilAccount(12).address, value: 1n, maxFeePerGas: base + 1n, maxPriorityFeePerGas: 1n }));
                }
            },
        });
        const { stack, relay } = env;
        const start = await relayNonces(stack, relay.address);
        expect(start.pending).toBe(start.latest + 2);
        expect(relay.server.store.getNextNonce()).toBe(start.pending); // recover() adopted the pending nonce

        // The node evicts the two pending transactions (fee too low, restart, pool limits).
        for (const hash of opsTx) await stack.testClient.dropTransaction({ hash });
        const a = await signTransfer(stack, relay, { from: 2, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        await mineAndTick(env, 12);

        const record = relay.server.store.getRequest(a.id)!;
        const after = await relayNonces(stack, relay.address);
        console.log('evicted pending transactions', { chainNonce: after.latest, relayTxNonce: record.txNonce, status: record.status });
        expect({ status: record.status, chainNonce: after.latest }).toEqual({ status: 'mined', chainNonce: start.latest + 1 });
    });
});

describe('lying or lagging RPC answers', () => {
    it('a transaction that the node took, answered with "nonce too low", is not sent again at another nonce: one call, reported mined', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const a = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 2_000_000n });
        await submit(relay, a);
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });

        // A gateway retries the broadcast: the first attempt reached the node, the retry reports "nonce too low".
        proxy.add({
            name: 'taken-but-nonce-too-low',
            times: 1,
            match: method('eth_sendRawTransaction'),
            after: () => ({ error: { code: -32000, message: 'nonce too low' } }),
        });
        // The attempt keeps its nonce ("nonce too low" is not proof that the nonce is used). Rolling the request back
        // to the queue would re-send it at nonce + 1, a second call for one request; nothing is sent
        // at a second nonce.
        await tick(relay);
        await tick(relay);
        await stack.mine();
        await tick(relay);
        await tick(relay);

        const all = await relayTxsOnChain(stack, relay.address, block0 + 1n);
        console.log('taken but nonce too low: relay txs', all.map((t) => ({ nonce: t.nonce, key: requestKeyOf(t.input), to: t.to, status: t.receipt.status })), keyOf(a));
        const calls = all.filter((t) => requestKeyOf(t.input) === keyOf(a));
        const record = relay.server.store.getRequest(a.id)!;
        const executedCall = calls.find((c) => c.receipt.status === 'success');
        console.log('taken but nonce too low (what a wallet sees)', executedCall ? await sdkView(env, a, executedCall.hash) : 'no successful call');
        console.log('taken but nonce too low', {
            status: record.status,
            error: record.error,
            calls: calls.map((c) => ({ nonce: c.nonce, status: c.receipt.status, gasUsed: c.receipt.gasUsed })),
            transferExecuted: await nonceUsed(env, a),
        });
        expect(await nonceUsed(env, a)).toBe(true); // the transfer did execute
        // Expected: one relay call per request, and the request reported as mined.
        expect({ calls: calls.length, status: record.status }).toEqual({ calls: 1, status: 'mined' });
    });

    it('receipts hidden for 13 blocks after inclusion (lagging read node): the executed transfer is reported mined, not failed', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const a = await signTransfer(stack, relay, { from: 4, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 3_000_000n });
        await submit(relay, a);
        await tick(relay);
        const [x] = relay.server.store.listAttempts(a.id);
        proxy.add({
            name: 'receipt-hidden',
            match: method('eth_getTransactionReceipt', (p) => String(p[0]).toLowerCase() === x!.hash.toLowerCase()),
            before: () => ({ kind: 'answer', answer: { result: null } }),
        });
        await stack.mine(); // included
        await mineAndTick(env, 13);
        proxy.remove('receipt-hidden');
        await mineAndTick(env, 2);

        const record = relay.server.store.getRequest(a.id)!;
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: x!.hash });
        const sdk = await sdkView(env, a, x!.hash);
        console.log('receipts hidden for 13 blocks', { status: record.status, error: record.error, onChain: receipt.status, ...sdk });
        expect(receipt.status).toBe('success');
        expect(await nonceUsed(env, a)).toBe(true);
        expect(record.status).toBe('mined');
    });

});

describe('sanity of the fixture', () => {
    it('without faults, a request is mined and the relay nonce advances by one', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const start = await relayNonces(stack, relay.address);
        const a = await signTransfer(stack, relay, { from: 6, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        await stack.mine();
        await tick(relay);
        expect(await status(relay, a.id)).toBe('mined');
        expect((await relayNonces(stack, relay.address)).latest).toBe(start.latest + 1);
        expect(parseGwei('1')).toBeGreaterThan(0n);
    });
});
