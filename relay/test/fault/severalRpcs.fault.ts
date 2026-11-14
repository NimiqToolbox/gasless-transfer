// Several RPCs, the first of which lies (every configured RPC must confirm before the relay gives a request a new
// tx nonce): the relay runs with RELAY_RPC_URLS=<proxy>,<anvil>. The proxy is the first RPC, so the relay's fail-over
// client reads through it; it lies the way a node would that claims a foreign transaction took the relay's nonce: no
// receipt for the relay's call, and the request's intent nonce unused (nonces(from) still at it). anvil is the honest
// second RPC. Before the relay gives a request a new tx nonce (a second call), it asks every RPC on its own; the
// honest one still shows the receipt, so the relay waits instead.
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { method } from './helpers/rpcProxy.js';
import { RECIPIENT, keyOf, mineAndTick, relayTxsOnChain, requestKeyOf, signTransfer, startFaultEnv, submit, tick, type FaultEnv } from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

describe('several RPCs', () => {
    it('a first RPC that hides the executed call and reports its nonce unused cannot make the relay send a second call', async () => {
        env = await startFaultEnv({ rpcUrls: (proxy, anvil) => `${proxy},${anvil}` });
        const { stack, proxy, relay } = env;
        const fromBlock = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const t = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, t);
        await tick(relay);
        const [call] = relay.server.store.listAttempts(t.id);
        // The lie is nonces(from) still at the request's nonce (unused).
        const noncesData = encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'nonces', args: [t.body.request.from] }).toLowerCase();
        const unused = encodeAbiParameters([{ type: 'uint256' }], [BigInt(t.body.request.nonce)]);
        proxy.add({
            name: 'hide-receipt',
            match: method('eth_getTransactionReceipt', (p) => String(p[0]).toLowerCase() === call!.hash.toLowerCase()),
            before: () => ({ kind: 'answer', answer: { result: null } }),
        });
        proxy.add({
            name: 'nonce-unused',
            match: method('eth_call', (p) => {
                const tx = p[0] as { data?: string; input?: string };
                return (tx.data ?? tx.input ?? '').toLowerCase() === noncesData;
            }),
            before: () => ({ kind: 'answer', answer: { result: unused } }),
        });
        await stack.mine(); // included: the transfer executes
        // Past RELAY_UNKNOWN_NONCE_GRACE_BLOCKS and far past anvil's finalized block (latest − 64): finality alone
        // would allow a new nonce by now; the honest RPC's receipt is what holds it back.
        await mineAndTick(env, 90);
        const calls = (await relayTxsOnChain(stack, relay.address, fromBlock)).filter((tx) => requestKeyOf(tx.input) === keyOf(t));
        const record = relay.server.store.getRequest(t.id)!;
        console.log('lying first RPC (two RPCs)', { status: record.status, txNonce: record.txNonce, calls: calls.length });
        expect(calls).toHaveLength(1);
        expect(record).toMatchObject({ status: 'submitted', txNonce: call!.txNonce });
        expect(await relay.server.relay.metrics.registry.metrics()).not.toContain('event="requeued"');
        // The lie stops (the operator removes the RPC, or it catches up): the request resolves by its receipt.
        proxy.clear();
        await mineAndTick(env, 1);
        expect(['mined', 'confirmed']).toContain(relay.server.store.getRequest(t.id)!.status);
    });
});
