// The checks before a broadcast read state at the head block, not at
// "latest". A node behind a load balancer that has not imported that block answers with an error instead of older
// state; the relay retries instead of deciding on stale state. (The lagging-head case, a node whose "latest" itself
// is older than the acceptance, is covered deterministically in test/unit/txLifecycle.test.ts.)
import { afterEach, describe, expect, it } from 'vitest';
import { method } from './helpers/rpcProxy.js';
import { RECIPIENT, signTransfer, startFaultEnv, status, submit, tick, type FaultEnv } from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

const pinnedToABlock = (p: readonly unknown[]) => typeof p[1] === 'string' && /^0x[0-9a-f]+$/i.test(p[1]);

describe('reads pinned to the head block', () => {
    it('a node without the head block errors on the pinned simulation: the request waits (no failure, no broadcast) and is sent once the node has it', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const a = await signTransfer(stack, relay, { from: 2, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        const head = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const pinnedTo: unknown[] = [];
        const remove = proxy.add({
            name: 'header-not-found',
            match: method('eth_call', pinnedToABlock),
            before: (call) => {
                pinnedTo.push((call.params ?? [])[1]);
                return { kind: 'answer', answer: { error: { code: -32000, message: 'header not found' } } };
            },
        });
        const tickErrors = [];
        for (let i = 0; i < 3; i++) tickErrors.push(await tick(relay));
        const during = { status: await status(relay, a.id), attempts: relay.server.store.listAttempts(a.id).length };
        remove();
        await tick(relay);
        await stack.mine();
        await tick(relay);
        const result = { pinnedTo: [...new Set(pinnedTo)], during, tickErrors, final: await status(relay, a.id) };
        console.log('pinned simulation vs a node without the block', result);
        expect(result.pinnedTo).toEqual([`0x${head.toString(16)}`]);
        expect(result.during).toEqual({ status: 'queued', attempts: 0 });
        expect(result.final).toBe('mined');
    });
});
