// RPC failures on each call of the transaction manager: HTTP 5xx, connection resets, timeouts and JSON-RPC errors,
// before and after the node took a broadcast; failing reads (simulation, estimate, receipts, finalized block); and a
// node that lies about finality.
import { afterEach, describe, expect, it } from 'vitest';
import { method, type Action, type JsonRpcCall } from './helpers/rpcProxy.js';
import {
    RECIPIENT,
    callsPerRequest,
    expectCleanNonces,
    intentNonceUsed,
    keyOf,
    mineAndTick,
    relayTxsOnChain,
    rpcAnswer,
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

const forwardThen =
    (e: FaultEnv, action: Action) =>
    async (call: JsonRpcCall): Promise<Action> => {
        await e.proxy.upstreamCall(call.method, call.params ?? []);
        return action;
    };

const broadcastFaults: Array<{ name: string; before: (e: FaultEnv) => (call: JsonRpcCall) => Action | Promise<Action> }> = [
    { name: 'HTTP 503, not forwarded', before: () => () => ({ kind: 'http', status: 503 }) },
    { name: 'connection reset, not forwarded', before: () => () => ({ kind: 'reset' }) },
    { name: 'timeout, not forwarded', before: () => () => ({ kind: 'hang' }) },
    { name: 'JSON-RPC internal error, not forwarded', before: () => () => ({ kind: 'answer', answer: { error: { code: -32603, message: 'internal error' } } }) },
    { name: 'forwarded, then HTTP 502', before: (e) => forwardThen(e, { kind: 'http', status: 502 }) },
    { name: 'forwarded, then connection reset', before: (e) => forwardThen(e, { kind: 'reset' }) },
    { name: 'forwarded, then timeout', before: (e) => forwardThen(e, { kind: 'hang' }) },
    { name: 'forwarded, then "txpool is full"', before: (e) => forwardThen(e, { kind: 'answer', answer: { error: { code: -32000, message: 'txpool is full' } } }) },
];

describe('eth_sendRawTransaction fails on the initial broadcast', () => {
    for (const fault of broadcastFaults) {
        it(`${fault.name}: the stored transaction is re-sent and mined once`, async () => {
            env = await startFaultEnv();
            const { stack, proxy, relay } = env;
            const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
            const a = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
            await submit(relay, a);
            proxy.add({ name: 'fault', times: 1, match: method('eth_sendRawTransaction'), before: fault.before(env) });
            await tick(relay);
            const afterFault = await relay.state(a.id);
            await tick(relay);
            await stack.mine();
            await tick(relay);
            const calls = callsPerRequest(await relayTxsOnChain(stack, relay.address, block0 + 1n)).get(keyOf(a));
            const result = { afterFault: afterFault.status, final: await status(relay, a.id), calls, broadcasts: proxy.count('eth_sendRawTransaction') };
            console.log(`broadcast fault "${fault.name}"`, result);
            expect(result).toMatchObject({ afterFault: 'submitted', final: 'mined', calls: ['success'] });
            await expectCleanNonces(env, block0 + 1n);
        });
    }
});

describe('read failures', () => {
    it('eth_call (pre-broadcast simulation) fails: the request stays queued, then is broadcast once', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const a = await signTransfer(stack, relay, { from: 2, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        const remove = proxy.add({ name: 'call-500', match: method('eth_call'), before: () => ({ kind: 'http', status: 500 }) });
        for (let i = 0; i < 3; i++) await tick(relay);
        const during = await status(relay, a.id);
        remove();
        await tick(relay);
        await stack.mine();
        await tick(relay);
        const calls = callsPerRequest(await relayTxsOnChain(stack, relay.address, block0 + 1n)).get(keyOf(a));
        console.log('eth_call failing', { during, final: await status(relay, a.id), calls });
        expect({ during, final: await status(relay, a.id), calls }).toEqual({ during: 'queued', final: 'mined', calls: ['success'] });
    });

    // The gas limit is min(estimate × 1.3, gas table, RELAY_MAX_GAS_LIMIT); without an estimate it is the gas table
    // entry itself (the measured worst case, which is also what the fee was priced with).
    it('eth_estimateGas fails: the gas limit falls back to the gas table entry and the call is mined', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const a = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        proxy.add({ name: 'estimate-error', match: method('eth_estimateGas'), before: () => ({ kind: 'answer', answer: { error: { code: -32000, message: 'gas required exceeds allowance' } } }) });
        await tick(relay);
        const [x] = relay.server.store.listAttempts(a.id);
        await stack.mine();
        await tick(relay);
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: x!.hash });
        console.log('eth_estimateGas failing', { gasLimit: x!.gasLimit, gasUsed: receipt.gasUsed, status: await status(relay, a.id) });
        expect(x!.gasLimit).toBe(280_000n); // the Polygon-calibrated gas table entry for permit
        expect(await status(relay, a.id)).toBe('mined');
    });

    it('eth_getTransactionReceipt fails: no state changes while it fails; every other request waits (the pass aborts); then all complete', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const a = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        const remove = proxy.add({ name: 'receipt-500', match: method('eth_getTransactionReceipt'), before: () => ({ kind: 'http', status: 500 }) });
        await stack.mine();
        const errors: Array<string | undefined> = [];
        for (let i = 0; i < 3; i++) errors.push(await tick(relay));
        const b = await signTransfer(stack, relay, { from: 5, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, b);
        errors.push(await tick(relay));
        const during = { a: await status(relay, a.id), b: await status(relay, b.id), errors: errors.map((x) => x?.slice(0, 60)) };
        remove();
        await tick(relay);
        await stack.mine();
        await tick(relay);
        const perRequest = callsPerRequest(await relayTxsOnChain(stack, relay.address, block0 + 1n));
        const after = { a: await status(relay, a.id), b: await status(relay, b.id), aCalls: perRequest.get(keyOf(a)), bCalls: perRequest.get(keyOf(b)) };
        console.log('eth_getTransactionReceipt failing', { during, after });
        expect(during.a).toBe('submitted');
        expect(during.b).toBe('queued');
        expect(after).toEqual({ a: 'mined', b: 'mined', aCalls: ['success'], bCalls: ['success'] });
    });

    it('"finalized" not supported by the node: confirmed only at the fallback depth (256 blocks)', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        proxy.add({
            name: 'no-finalized',
            match: method('eth_getBlockByNumber', (p) => p[0] === 'finalized'),
            before: () => ({ kind: 'answer', answer: { error: { code: -32601, message: 'finalized block not available' } } }),
        });
        const a = await signTransfer(stack, relay, { from: 6, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        await stack.mine();
        await tick(relay);
        await stack.mine(65);
        await tick(relay);
        const at65 = await status(relay, a.id);
        await stack.mine(200);
        await tick(relay);
        console.log('no finalized tag', { at65, at265: await status(relay, a.id) });
        expect(at65).toBe('mined');
        expect(await status(relay, a.id)).toBe('confirmed');
    });

    // The simulation is pinned to the head block, so the stale answer of this node for "latest" is
    // never consulted. A node without the head block is covered by pinnedReads.fault.ts, and a node whose "latest" is
    // older than the acceptance by test/unit/txLifecycle.test.ts.
    it('a read node one block behind on "latest" does not fail the accepted request (simulation pinned to the head block): broadcast and mined', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        // Two USDT0 transfers in a row (sender_busy: "retry when it is mined"): the second is signed and accepted
        // right after the first is mined; its permit uses the next USDT0 nonce.
        const first = await signTransfer(stack, relay, { from: 8, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, first);
        await tick(relay);
        await stack.mine();
        await tick(relay);
        expect(await status(relay, first.id)).toBe('mined');
        const minedAt = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const second = await signTransfer(stack, relay, { from: 8, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, second); // accepted: the relay read the new USDT0 nonce

        // The next eth_call lands on a node of the same provider that has not imported block `minedAt` yet.
        let laggedSimulations = 0;
        const remove = proxy.add({
            name: 'one-block-behind',
            match: method('eth_call', (p) => p[1] === 'latest' || p[1] === undefined),
            before: async (call) => {
                const [tx] = call.params ?? [];
                if (String((tx as { to?: unknown } | undefined)?.to).toLowerCase() === stack.transfer.toLowerCase()) laggedSimulations += 1;
                return { kind: 'answer', answer: await rpcAnswer(stack, 'eth_call', [tx, `0x${(minedAt - 1n).toString(16)}`]) };
            },
        });
        await tick(relay);
        remove();
        const afterLag = await relay.state(second.id);
        await tick(relay);
        await stack.mine();
        await tick(relay);
        const [call] = relay.server.store.listAttempts(second.id);
        // Would it have worked? The relay's own call, simulated at the current head.
        const op = relay.server.relay.registry.get('transfer')!;
        const encoded = op.encodeCall(relay.server.relay.ctx, op.schema.parse(second.body));
        const atHead = await rpcAnswer(stack, 'eth_call', [{ from: relay.address, to: encoded.to, data: encoded.data }, 'latest']);
        const result = {
            afterLag: { status: afterLag.status, code: afterLag.error?.code, message: afterLag.error?.message?.slice(0, 90) },
            final: await status(relay, second.id),
            broadcast: call !== undefined,
            executed: await nonceUsed(env, second),
            simulationAtHeadSucceeds: 'result' in atHead,
            laggedSimulations,
        };
        console.log('read node one block behind', result);
        // Expected: a revert seen on a lagging read after acceptance is not final (the request is broadcast once the
        // read catches up, or the simulation is pinned to a block at or after the acceptance block).
        expect(result.final).not.toBe('failed');
        expect({ final: result.final, broadcast: result.broadcast, executed: result.executed, laggedSimulations }).toEqual({
            final: 'mined',
            broadcast: true,
            executed: true,
            laggedSimulations: 0,
        });
    });

    it('a node that answers "finalized" with its latest block does not make a request "confirmed" at inclusion; after a reorg it is re-sent and mined again', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        proxy.add({
            name: 'finalized-is-latest',
            match: method('eth_getBlockByNumber', (p) => p[0] === 'finalized'),
            before: async (call) => ({ kind: 'answer', answer: { result: await proxy.upstreamCall('eth_getBlockByNumber', ['latest', ...(call.params ?? []).slice(1)]) } }),
        });
        const a = await signTransfer(stack, relay, { from: 7, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        const snapshot = await stack.testClient.snapshot();
        await stack.mine();
        await tick(relay);
        const atInclusion = await status(relay, a.id);
        await stack.testClient.revert({ id: snapshot });
        await stack.testClient.dropTransaction({ hash: relay.server.store.listAttempts(a.id)[0]!.hash }).catch(() => undefined);
        // The new chain's blocks are made after the relay recorded the outcome, as on a real chain: the relay undoes a
        // mined outcome only on heads made after that moment, and anvil can make several blocks within one second.
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000) + 2) });
        await mineAndTick(env, 5);
        const record = relay.server.store.getRequest(a.id)!;
        const result = {
            atInclusion,
            afterReorg: record.status,
            executed: await nonceUsed(env, a),
            rawKept: relay.server.store.listAttempts(a.id).some((x) => x.raw !== null),
            authorizationKept: record.authorization !== null,
        };
        console.log('finalized is latest', result);
        // Expected: "confirmed" is only reported for a block the chain cannot drop (a sanity bound on the
        // node's answer, e.g. finalized ≤ head − N, or a request that is re-checked after a reorg).
        expect(result.afterReorg === 'confirmed' && !result.executed).toBe(false);
        // Final means at or below min(finalized, head − RELAY_MIN_FINALITY_DEPTH), so the request is
        // still provisional (secrets kept) when the reorg comes, and its stored call is re-sent.
        expect(result).toEqual({ atInclusion: 'mined', afterReorg: 'mined', executed: true, rawKept: true, authorizationKept: true });
    });
});
