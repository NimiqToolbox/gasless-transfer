// What a client's HTTP requests cost the relay in RPC calls, and the limits its HTTP server runs with.
//
// RPC providers meter and rate-limit requests, so an unauthenticated client must not be able to turn cheap
// HTTP requests into many RPC requests:
// - POST /v1/transfer reads nothing from the chain before the intent signature verifies, and a bounded number of
//   values after that;
// - /readyz answers from the readiness cache (RELAY_READINESS_CACHE_MS): uncached, every probe would cost three RPC
//   calls, so N probes would become 3N requests against the providers.
//
// The tests count the calls the relay makes on its chain client.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ChainClient } from '../../../src/chain/types.js';
import { buildTransfer, createHarness, type Harness, type HarnessOptions } from '../../helpers/harness.js';

const METHODS: ReadonlyArray<keyof ChainClient> = [
    'getChainId',
    'getBlock',
    'getMaxPriorityFeePerGas',
    'getBalance',
    'getCode',
    'getTransactionCount',
    'readContract',
    'call',
    'estimateGas',
    'sendRawTransaction',
    'getTransactionReceipt',
];

let h: Harness;
let rpcCalls = 0;

async function setup(options: HarnessOptions = {}): Promise<void> {
    h = await createHarness(options);
    rpcCalls = 0;
    const chain = h.chain as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of METHODS) {
        const original = chain[name]!.bind(h.chain);
        chain[name] = (...args: unknown[]) => {
            rpcCalls += 1;
            return original(...args);
        };
    }
}

afterEach(async () => {
    await h.close();
});

const PROD = { signerMax: 10, signerWindowMs: 60_000, submitMax: 120, submitWindowMs: 60_000 };

describe('RPC amplification', () => {
    beforeEach(async () => {
        await setup({ settings: { rateLimit: PROD, feeCacheMs: 2000 } });
    });

    it('POST /v1/transfer: 0 RPC calls before a valid signature, ~8 for a valid signature of an empty account', async () => {
        const base = await buildTransfer(h, { mode: 'permit' });
        // Invalid signature: rejected locally.
        let before = rpcCalls;
        const bad = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: { ...base.body, signature: `0x${'11'.repeat(65)}` } });
        expect(bad.statusCode).toBe(400);
        expect(rpcCalls - before).toBe(0);

        // A fresh random key (costs nothing to create) with a valid signature: nonce, fee context and
        // token state are read before the request fails with insufficient_balance.
        const key = generatePrivateKey();
        const t = await buildTransfer(h, { key, mode: 'permit' });
        before = rpcCalls;
        const res = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body as object });
        expect((res.json() as { error: { code: string } }).error.code).toBe('insufficient_balance');
        const perRequest = rpcCalls - before;
        expect(perRequest).toBeGreaterThanOrEqual(7);
        expect(perRequest).toBeLessThanOrEqual(10);
        expect(privateKeyToAccount(key).address).toBe(t.request.from);
    });

    it('/readyz answers from the readiness cache: 50 probes cost less than one RPC call each', async () => {
        const statuses: number[] = [];
        const before = rpcCalls;
        for (let i = 0; i < 50; i++) {
            statuses.push((await h.relay.app.inject({ method: 'GET', url: '/readyz' })).statusCode);
        }
        const perCall = (rpcCalls - before) / 50;
        // An uncached report costs 3 RPC calls (eth_chainId, eth_getBlockByNumber, eth_getBalance). The report is
        // cached, so repeated probes cost (almost) nothing. The cache is what bounds the cost: every probe is
        // answered.
        expect(perCall, 'RPC calls per /readyz').toBeLessThan(1);
        expect(statuses.every((s) => s === 200)).toBe(true);
    });
});

describe('HTTP server limits', () => {
    it('reports the connection and request timeouts the relay HTTP server runs with', async () => {
        await setup();
        const s = h.relay.app.server;
        const values = {
            requestTimeout: s.requestTimeout,
            headersTimeout: s.headersTimeout,
            keepAliveTimeout: s.keepAliveTimeout,
            timeout: s.timeout,
            maxConnections: s.maxConnections,
            maxRequestsPerSocket: s.maxRequestsPerSocket,
        };
        console.log(`http server limits: ${JSON.stringify(values)}`);
        expect(typeof values.headersTimeout).toBe('number');
    });
});

