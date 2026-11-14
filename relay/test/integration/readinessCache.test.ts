// /readyz must not let a client exhaust the relay's RPC quota. The route is unauthenticated, and an uncached report
// reads the chain on every hit (getChainId, getBlock('latest'), getBalance): without a bound, anyone who can reach
// /readyz could turn HTTP requests into three times as many RPC requests.
//
// Every listener serves the same cached report (RELAY_READINESS_CACHE_MS, with concurrent probes sharing one check),
// so the relay makes at most one set of readiness RPC reads per cache period, however often /readyz is requested.
// The readiness cache is what bounds the cost of /readyz in RPC reads.
//
// Runs the real relay (production wiring) against anvil.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay, type RunningRelay } from './helpers/relay.js';
import { startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;

beforeAll(async () => {
    stack = await startStack();
    // A long readiness cache keeps the caching assertion independent of the machine's speed.
    relay = await startRelay(stack, {
        env: { RELAY_READINESS_CACHE_MS: '60000' },
    });
    await relay.server.relay.txManager.stop();
});

afterAll(async () => {
    await relay?.stop();
    await stack?.stop();
});

async function hit(path: string): Promise<number> {
    const res = await fetch(`${relay.url}${path}`, { method: 'GET' });
    await res.text();
    return res.status;
}

async function readyBody(base: string): Promise<{ status: number; blockNumber?: string }> {
    const res = await fetch(`${base}/readyz`, { method: 'GET' });
    const json = (await res.json()) as { checks?: { rpc?: { blockNumber?: string } } };
    return { status: res.status, blockNumber: json.checks?.rpc?.blockNumber };
}

describe('/readyz is not an RPC amplifier', () => {
    it('/readyz is served from the readiness cache: the reported block number does not move within the cache period', async () => {
        // The internal listener shares the readiness cache.
        const ops = relay.server.opsAddress;
        expect(ops).not.toBeNull();
        const first = await readyBody(ops!);
        expect(first.blockNumber).toBeDefined();
        await stack.mine(3); // advance the chain
        const second = await readyBody(ops!);
        // No fresh getBlock('latest') per call: the cached report still names the first block.
        expect(second.blockNumber).toBe(first.blockNumber);
        // The public listener answers from the same cache, however often it is asked: every probe is answered.
        for (let i = 0; i < 60; i++) expect(await hit('/readyz')).toBe(first.status);
        expect((await readyBody(ops!)).blockNumber).toBe(first.blockNumber);
    });
});
