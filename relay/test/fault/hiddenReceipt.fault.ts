// The relay's call executes while the configured RPCs hide its receipt: RELAY_RPC_URLS=<proxy>,<second proxy>, both in
// front of anvil. The relay locates the block that used the request's intent nonce from state on each RPC, and only the
// call's successful receipt there is its execution:
// - eth_getTransactionReceipt and the logs hidden, eth_getBlockReceipts served: the receipt in the block's receipts is
//   the execution. The request ends mined, then confirmed once that block is final; the relay sends one call.
// - every receipt of the call hidden on every RPC (eth_getBlockReceipts too): the call listed in the block shows
//   nothing. The request waits with the ALERT for as long as that lasts, and is never failed and never mined; once the
//   block's receipts list it again, it is mined. (The inclusion of the call alone never makes it mined.)
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { method } from './helpers/rpcProxy.js';
import { RECIPIENT, RpcProxy, keyOf, relayTxsOnChain, requestKeyOf, signTransfer, startFaultEnv, submit, tick, type FaultEnv } from './helpers/fault.js';

let env: FaultEnv | undefined;
let second: RpcProxy | undefined;

afterEach(async () => {
    await env?.stop();
    await second?.stop();
    env = undefined;
    second = undefined;
});

const same = (hash: Hex) => (value: unknown) => String(value).toLowerCase() === hash.toLowerCase();

/** Hides transaction `hash` on `proxy`: no receipt from eth_getTransactionReceipt, and none of its logs in an eth_getLogs answer. */
function hide(proxy: RpcProxy, hash: Hex): void {
    proxy.add({ name: 'hide-receipt', match: method('eth_getTransactionReceipt', (p) => same(hash)(p[0])), before: () => ({ kind: 'answer', answer: { result: null } }) });
    proxy.add({
        name: 'hide-logs',
        match: method('eth_getLogs'),
        after: (_call, answer) =>
            Array.isArray(answer.result) ? { result: (answer.result as Array<{ transactionHash?: unknown }>).filter((log) => !same(hash)(log.transactionHash)) } : answer,
    });
}

/** Also leaves its receipt out of eth_getBlockReceipts answers on `proxy`. Returns a function that lists it again. */
function hideInBlockReceipts(proxy: RpcProxy, hash: Hex): () => void {
    return proxy.add({
        name: 'hide-block-receipt',
        match: method('eth_getBlockReceipts'),
        after: (_call, answer) =>
            Array.isArray(answer.result) ? { result: (answer.result as Array<{ transactionHash?: unknown }>).filter((r) => !same(hash)(r.transactionHash)) } : answer,
    });
}

async function twoRpcs(env: Record<string, string> = {}): Promise<FaultEnv> {
    return startFaultEnv({
        beforeRelay: async (stack) => {
            second = await new RpcProxy(stack.rpcUrl).start();
        },
        rpcUrls: (proxy) => `${proxy},${second!.url}`,
        env,
    });
}

describe('an executed call whose receipt no RPC answers on its own', () => {
    it('eth_getTransactionReceipt and the logs hidden on both RPCs, eth_getBlockReceipts served: mined by the block receipts, then confirmed; never failed; one call', async () => {
        env = await twoRpcs();
        const { stack, proxy, relay } = env;
        const fromBlock = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const t = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, t);
        expect(await tick(relay)).toBeUndefined();
        const [call] = relay.server.store.listAttempts(t.id);
        for (const p of [proxy, second!]) hide(p, call!.hash);
        await stack.mine(); // included: the transfer executes
        const statuses: string[] = [];
        // Past RELAY_UNKNOWN_NONCE_GRACE_BLOCKS (12) and past anvil's finalized block (latest − 64).
        for (let i = 0; i < 100; i++) {
            await stack.mine();
            expect(await tick(relay)).toBeUndefined();
            const now = relay.server.store.getRequest(t.id)!.status;
            if (statuses.at(-1) !== now) statuses.push(now);
        }
        const record = relay.server.store.getRequest(t.id)!;
        const calls = (await relayTxsOnChain(stack, relay.address, fromBlock)).filter((tx) => requestKeyOf(tx.input) === keyOf(t));
        const receiptsServed = [proxy, second!].flatMap((p) => p.calls).filter((c) => c.method === 'eth_getTransactionReceipt' && same(call!.hash)(c.params[0]) && c.rule === undefined);
        const blockReceipts = [proxy, second!].map((p) => p.count('eth_getBlockReceipts'));
        console.log('hidden receipt (two RPCs, block receipts served)', { statuses, status: record.status, error: record.error, calls: calls.length, receiptsServed: receiptsServed.length, blockReceipts });
        expect(statuses).toEqual(['submitted', 'mined', 'confirmed']);
        expect(await relay.state(t.id)).toMatchObject({ status: 'confirmed', txHash: call!.hash, error: null });
        expect(record.settledAtMs).not.toBeNull();
        expect(calls.map((c) => c.receipt.status)).toEqual(['success']);
        expect(receiptsServed).toHaveLength(0); // no RPC ever answered eth_getTransactionReceipt for it
        expect(blockReceipts.every((n) => n > 0)).toBe(true);
        expect(await relay.server.relay.metrics.registry.metrics()).toContain('relay_nonce_events_total{event="mined_by_nonce_search"} 1');
    });

    it('every receipt of it hidden on both RPCs (eth_getBlockReceipts too): waits with the ALERT for 150 blocks, never failed or mined; once listed again, mined, then confirmed', async () => {
        env = await twoRpcs({ RELAY_STUCK_AFTER_BLOCKS: '40' });
        const { stack, proxy, relay } = env;
        const t = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, t);
        expect(await tick(relay)).toBeUndefined();
        const [call] = relay.server.store.listAttempts(t.id);
        const relist: Array<() => void> = [];
        for (const p of [proxy, second!]) {
            hide(p, call!.hash);
            relist.push(hideInBlockReceipts(p, call!.hash));
        }
        await stack.mine(); // included: the transfer executes
        const block = (await stack.publicClient.getTransactionReceipt({ hash: call!.hash })).blockNumber;
        const statuses = new Set<string>();
        for (let i = 0; i < 150; i++) {
            await stack.mine();
            expect(await tick(relay)).toBeUndefined();
            statuses.add(relay.server.store.getRequest(t.id)!.status);
        }
        const metrics = await relay.server.relay.metrics.registry.metrics();
        console.log('hidden receipt (two RPCs, every receipt hidden)', { statuses: [...statuses], blockReceipts: [proxy, second!].map((p) => p.count('eth_getBlockReceipts')) });
        expect([...statuses]).toEqual(['submitted']);
        expect(metrics).toContain('relay_decision_waits_total{decision="receipt"} 1');
        expect(metrics).not.toContain('event="mined_by_nonce_search"');
        expect(relay.logs.text()).toContain(`the RPC shows the relay's call in block ${block} but serves no receipt of it`);
        expect(relay.server.store.listAttempts(t.id)).toHaveLength(1); // nothing re-sent

        for (const r of relist) r(); // the block's receipts list it again (eth_getTransactionReceipt still hides it)
        const after: string[] = [];
        for (let i = 0; i < 20 && relay.server.store.getRequest(t.id)!.status !== 'confirmed'; i++) {
            await stack.mine();
            expect(await tick(relay)).toBeUndefined();
            const now = relay.server.store.getRequest(t.id)!.status;
            if (after.at(-1) !== now) after.push(now);
        }
        // Mined at the next search, and, its block long final, confirmed in the same pass.
        expect(after.at(-1)).toBe('confirmed');
        expect(await relay.state(t.id)).toMatchObject({ status: 'confirmed', txHash: call!.hash, error: null });
        expect(await relay.server.relay.metrics.registry.metrics()).toContain('relay_nonce_events_total{event="mined_by_nonce_search"} 1');
    });
});
