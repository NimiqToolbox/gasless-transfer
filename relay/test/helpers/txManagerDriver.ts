// Helpers for tests that drive the transaction manager by hand: a minimal configuration environment, queueing a
// request through the pipeline, running one pass or a pass per block, a second RPC in front of the fake chain, reading
// a request's public state, and a POL/USD price the test can change between passes.
import { expect } from 'vitest';
import type { Hex } from 'viem';
import type { ChainClient } from '../../src/chain/types.js';
import { toRequestState } from '../../src/http/app.js';
import { transferOperation } from '../../src/operations/transfer.js';
import type { PriceReading, PriceSource } from '../../src/fees/priceSource.js';
import { autoSender, buildTransfer, type BuiltTransfer, type Harness, type TransferOptions } from './harness.js';

/** A minimal valid environment for loadConfig (the files are not read by loadConfig). */
export const BASE_ENV = {
    RELAY_RPC_URLS: 'http://127.0.0.1:8545',
    RELAY_DEPLOYMENT_FILE: '/config/deployment.json',
    RELAY_PRIVATE_KEY_FILE: '/run/secrets/relay_key',
    // No RELAY_POLUSD_FALLBACK: loadConfig refuses a static price, the Chainlink feed is required.
} as const;

/** Queues a request; from a further sender (autoSender) when USER already has one pending (one per sender). */
export async function queue(h: Harness, o: TransferOptions = {}): Promise<BuiltTransfer> {
    const built = await buildTransfer(h, autoSender(h, o));
    const result = await h.relay.pipeline.submit(transferOperation, built.body);
    expect(result.statusCode).toBe(202);
    return built;
}

/** One pass; fails the test if the pass itself failed. */
export async function tick(h: Harness): Promise<void> {
    await h.relay.txManager.tick();
    expect(h.relay.txManager.lastTickError).toBeUndefined();
}

/** `n` blocks with a pass after each; the node's finalized tag `finalizedLag` blocks below head. */
export async function blocks(x: Harness, n: number, finalizedLag = 0n): Promise<void> {
    for (let i = 0; i < n; i++) {
        x.chain.mine();
        x.chain.finalized = x.chain.head.number - finalizedLag;
        await tick(x);
    }
}

/** RELAY_RPC_URLS=<the fake chain>,<a second RPC in front of the same chain, with `overrides`>. */
export function secondRpc(x: Harness, overrides: Partial<ChainClient> = {}): ChainClient {
    const rpc = { ...x.chain.rpcView(), ...overrides };
    x.chain.rpcClients = () => [x.chain, rpc];
    return rpc;
}

export const stateOf = (h: Harness, id: Hex) => toRequestState(h.store.getRequest(id)!, h.store.listAttempts(id));

/** A POL/USD price the test can change between passes (8 decimals, like the test price source). */
export class MutablePrice implements PriceSource {
    readonly feed = null;
    constructor(public value: bigint) {}
    private reading(): PriceReading {
        // `chainlink` is the only kind of price source the relay knows.
        return { value: this.value, decimals: 8, source: 'chainlink', updatedAt: null, reason: null };
    }
    get(): Promise<PriceReading> {
        return Promise.resolve(this.reading());
    }
    last(): PriceReading {
        return this.reading();
    }
}
