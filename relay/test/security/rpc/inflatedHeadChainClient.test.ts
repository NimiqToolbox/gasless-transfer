// The scenario of inflatedHead.test.ts through the production chain client: a lying first RPC that reports higher block
// numbers cannot decide alone that an executed request gets a second call, or that it failed by invalidation.
//
// inflatedHead.test.ts makes the fake chain object itself the lying first RPC, so the liar is also the relay's own
// client. In production the relay's own client is a viem `fallback` client over RELAY_RPC_URLS (the first RPC that
// answers is used), and rpcClients() gives one separate client per URL. This file runs the relay on
// createViemChainClient with two JSON-RPC servers in front of one fake chain: one RPC lies once the relay's call has
// executed, the other answers from the chain's true state the whole time. The lies: block numbers (`latest` and
// `finalized`) shifted by an offset, no receipt of the executed call, and either (requeue case) the intent nonce unused
// (nonces(signer) still at it) and a successful eth_call of the call, or (nonce_used case) a forged NonceInvalidated
// log instead of the real logs of the call (the request's token transfer).
//
// Only the per-URL clients vote (the fail-over client does not, so the first RPC counts once), every one of them must
// confirm, and each RPC's evidence is judged on its own block numbers. So the request waits: no second call at tx nonce
// 1, no `failed` outcome, with a lead of 1e6 blocks and with a lead of only 20 blocks (under a minute on Polygon PoS).
// The controls: the same lies with the real block numbers, and the same lies with the honest RPC listed first.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { createLocalSigner } from '../../../src/chain/signer.js';
import type { BlockInfo, CallOutcome, CallParams, ChainClient, ChainLog, LogFilter, ReadContractCall } from '../../../src/chain/types.js';
import { createViemChainClient } from '../../../src/chain/viemChainClient.js';
import { createMetrics } from '../../../src/metrics.js';
import { createRelay } from '../../../src/relay.js';
import { SqliteStore } from '../../../src/store/sqliteStore.js';
import { FakeChain } from '../../helpers/fakeChain.js';
import { CONTRACT, DEFAULT_SETTINGS, START_TIME, TEST_GAS_TABLE, TestClock, USDC, USDT0, captureLogger, testDeployment, type Harness } from '../../helpers/harness.js';
import { RECIPIENT_ADDRESS, RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS } from '../../helpers/keys.js';
import { TestPriceSource } from '../../helpers/priceSource.js';
import { serveFakeChain, type RpcAdapter } from '../../helpers/rpcAdapter.js';
import { queue, stateOf } from '../../helpers/txManagerDriver.js';
import { counter, intentNonceUsed, isRelayTransferFor, relayCallNonces } from '../helpers/relayObservations.js';

/** What the lying RPC does once `on` is set. */
interface Lie {
    on: boolean;
    offset: bigint;
    kind: 'unused' | 'invalidated';
    hidden: string;
    /** The request's intent nonce (decimal) and signature (its relayTransfer calls carry no nonce). */
    nonce: string;
    signature: Hex;
}

/** The lying RPC: the chain's true state until `lie.on`, then the lies of `lie`. */
function lyingClient(chain: FakeChain, lie: Lie): ChainClient {
    const truth = chain.rpcView();
    const shift = (b: BlockInfo): BlockInfo => (lie.on ? { ...b, number: b.number + lie.offset } : b);
    return {
        ...truth,
        getBlock: async (tag) => shift(await truth.getBlock(tag)),
        getTransactionReceipt: async (hash) => (lie.on && hash.toLowerCase() === lie.hidden ? null : truth.getTransactionReceipt(hash)),
        // nonces(sender) still at the intent nonce: unused.
        readContract: async <T>(c: ReadContractCall): Promise<T> =>
            lie.on && lie.kind === 'unused' && c.functionName === 'nonces' && String(c.args?.[0]).toLowerCase() === USER_ADDRESS.toLowerCase()
                ? (BigInt(lie.nonce) as T)
                : truth.readContract<T>(c),
        call: async (p: CallParams): Promise<CallOutcome> =>
            lie.on && lie.kind === 'unused' && isRelayTransferFor(p.data, lie.signature) ? { ok: true, data: '0x' } : truth.call(p),
        // A forged NonceInvalidated(sender, nonce, nonce + 1), and no token transfer of the executed call.
        getLogs: async (filter: LogFilter): Promise<readonly ChainLog[]> => {
            if (!lie.on || lie.kind !== 'invalidated') return truth.getLogs!(filter);
            const topics = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer: USER_ADDRESS } }) as Hex[];
            return [
                {
                    address: CONTRACT,
                    topics,
                    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(lie.nonce), BigInt(lie.nonce) + 1n]),
                    blockNumber: filter.toBlock,
                    blockHash: toHex(filter.toBlock, { size: 32 }),
                    transactionHash: keccak256(toHex('forged invalidateNonces')),
                },
            ];
        },
    };
}

type RpcMessage = { id: number | string; method: string; params?: unknown[] };

/** JSON-RPC in front of `client`: the test adapter (serveFakeChain), plus eth_getLogs, which the adapter lacks. */
async function serve(client: ChainClient): Promise<RpcAdapter> {
    const inner = await serveFakeChain(client as unknown as FakeChain);
    const one = async (m: RpcMessage): Promise<unknown> => {
        if (m.method !== 'eth_getLogs') {
            const response = await fetch(inner.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
            return response.json();
        }
        try {
            const f = (m.params ?? [])[0] as { address: Hex; topics: LogFilter['topics']; fromBlock: Hex; toBlock: Hex };
            const logs = await client.getLogs!({ address: f.address, topics: f.topics, fromBlock: BigInt(f.fromBlock), toBlock: BigInt(f.toBlock) });
            return {
                jsonrpc: '2.0',
                id: m.id,
                result: logs.map((l, i) => ({
                    address: l.address,
                    topics: l.topics,
                    data: l.data,
                    blockNumber: toHex(l.blockNumber),
                    blockHash: l.blockHash,
                    transactionHash: l.transactionHash,
                    transactionIndex: '0x0',
                    logIndex: toHex(i),
                    removed: false,
                })),
            };
        } catch (err) {
            return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } };
        }
    };
    const server: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
            void (async () => {
                const message = JSON.parse(body) as RpcMessage | RpcMessage[];
                const reply = Array.isArray(message) ? await Promise.all(message.map(one)) : await one(message);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(reply));
            })();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        async close() {
            await new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            });
            await inner.close();
        },
    };
}

let h: Harness | undefined;
let tickErrors: string[] = [];

afterEach(async () => {
    await h?.close();
    h = undefined;
    tickErrors = [];
});

/** The relay on the production chain client: RELAY_RPC_URLS = the two servers, in `order`. */
async function productionWired(order: 'liar first' | 'honest first', lie: Lie): Promise<Harness> {
    const deployment = testDeployment();
    const chain = new FakeChain({ deployment, timestamp: START_TIME, relay: RELAY_ADDRESS });
    chain.setBalance(USDC, USER_ADDRESS, 100_000_000n);
    chain.setBalance(USDT0, USER_ADDRESS, 100_000_000n);
    const liar = await serve(lyingClient(chain, lie));
    const honest = await serve(chain.rpcView());
    const rpcUrls = order === 'liar first' ? [liar.url, honest.url] : [honest.url, liar.url];
    const dir = mkdtempSync(join(tmpdir(), 'relay-'));
    const dbPath = join(dir, 'relay.sqlite');
    const clock = new TestClock(START_TIME * 1000);
    const store = SqliteStore.open(dbPath, { lockTimeoutMs: 100 });
    store.bindIdentity({ chainId: 137, relay: RELAY_ADDRESS, gaslessTransfer: deployment.gaslessTransfer });
    const logs = captureLogger();
    const metrics = createMetrics();
    const relay = await createRelay({
        deployment,
        gasTable: TEST_GAS_TABLE,
        chain: createViemChainClient({ rpcUrls, timeoutMs: 5_000 }),
        signer: createLocalSigner(RELAY_KEY),
        store,
        // A fixed POL/USD price of 0.20 USD.
        priceSource: new TestPriceSource('0.2', metrics),
        logger: logs.logger,
        clock,
        metrics,
        settings: DEFAULT_SETTINGS,
    });
    return {
        dir,
        dbPath,
        chain,
        clock,
        store,
        logs,
        metrics,
        relay,
        deployment,
        async close() {
            await relay.close();
            store.close();
            await liar.close();
            await honest.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

async function pass(harness: Harness): Promise<void> {
    await harness.relay.txManager.tick();
    const error = harness.relay.txManager.lastTickError;
    if (error !== undefined) tickErrors.push(error);
}

/** Blocks with a pass after each; the chain's finalized tag at head (both RPCs apply the 16-block minimum). */
async function drive(harness: Harness, blocks: number): Promise<void> {
    for (let i = 0; i < blocks; i++) {
        harness.chain.mine();
        harness.chain.finalized = harness.chain.head.number;
        await pass(harness);
    }
}

/** A NONE transfer the chain executes at tx nonce 0 (exactly once); then the lying RPC starts to lie. */
async function executedThenLie(harness: Harness, lie: Lie): Promise<{ id: Hex; signature: Hex }> {
    const { chain } = harness;
    await harness.relay.txManager.recover();
    chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
    const t = await queue(harness, { token: USDC, mode: 'none', amount: 1_000_000n, fee: 10_000n });
    // The contract: another relayTransfer of the request after its nonce was used reverts (InvalidSignature: the
    // signature is checked over the sender's current nonce).
    chain.executor = (tx) => (isRelayTransferFor(tx.data, t.body.signature) && intentNonceUsed(harness, USER_ADDRESS, t.request.nonce) ? 'reverted' : 'success');
    await pass(harness);
    const [call1] = harness.store.listAttempts(t.id);
    expect(call1).toMatchObject({ kind: 'call', txNonce: 0 });
    chain.mine();
    expect(chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(1_000_000n);
    expect(intentNonceUsed(harness, USER_ADDRESS, t.request.nonce)).toBe(true);
    lie.hidden = call1!.hash.toLowerCase();
    lie.nonce = t.request.nonce;
    lie.signature = t.body.signature;
    lie.on = true;
    return { id: t.id, signature: t.body.signature };
}

async function facts(harness: Harness, id: Hex, signature: Hex) {
    const record = harness.store.getRequest(id)!;
    const state = stateOf(harness, id);
    return {
        relayCallTxNonces: relayCallNonces(harness, signature),
        requeued: await counter(harness, 'relay_nonce_events_total', 'event="requeued"'),
        nonceInvalidated: await counter(harness, 'relay_nonce_events_total', 'event="nonce_invalidated"'),
        status: state.status,
        code: state.error?.code ?? null,
        settled: record.settledAtMs !== null,
        recipientReceived: harness.chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase()),
        tickErrors: tickErrors.length,
    };
}

/** The request executed once; while an honest RPC answers, the relay must wait (no second call, not failed). */
const WAITS = { relayCallTxNonces: [0], requeued: 0, nonceInvalidated: 0, status: 'submitted', code: null, settled: false, recipientReceived: 1_000_000n, tickErrors: 0 };

async function run(order: 'liar first' | 'honest first', kind: Lie['kind'], offset: bigint, blocks: number) {
    const lie: Lie = { on: false, offset, kind, hidden: '', nonce: '', signature: '0x' };
    h = await productionWired(order, lie);
    const { id, signature } = await executedThenLie(h, lie);
    await drive(h, blocks);
    const result = await facts(h, id, signature);
    return result;
}

const LONG = { timeout: 120_000 };

describe('production chain client: a lying first RPC with higher block numbers cannot decide alone', () => {
    it('requeue case, liar first with head + 1e6: no second call, not failed', LONG, async () => {
        expect(await run('liar first', 'unused', 1_000_000n, 60)).toEqual(WAITS);
    });

    it('requeue case, liar first with head + 20 blocks: no second call, not failed', LONG, async () => {
        expect(await run('liar first', 'unused', 20n, 60)).toEqual(WAITS);
    });

    it('nonce_used case, liar first with head + 1e6: not failed on a forged NonceInvalidated log', LONG, async () => {
        expect(await run('liar first', 'invalidated', 1_000_000n, 40)).toEqual(WAITS);
    });

    it('nonce_used case, liar first with head + 20 blocks: not failed on a forged NonceInvalidated log', LONG, async () => {
        expect(await run('liar first', 'invalidated', 20n, 40)).toEqual(WAITS);
    });

    it('control: requeue case, liar first with the real block numbers: waits', LONG, async () => {
        expect(await run('liar first', 'unused', 0n, 60)).toEqual(WAITS);
    });

    it('control: nonce_used case, liar first with the real block numbers: waits', LONG, async () => {
        expect(await run('liar first', 'invalidated', 0n, 40)).toEqual(WAITS);
    });

    it('control: requeue case, honest first, liar second with head + 1e6: mined by the honest receipt, one call', LONG, async () => {
        // The fail-over client reads the honest RPC: the receipt is visible, so the request is mined; the liar only
        // holds back the settlement (confirmed), which needs every RPC.
        expect(await run('honest first', 'unused', 1_000_000n, 60)).toMatchObject({ relayCallTxNonces: [0], requeued: 0, status: 'mined', settled: false, tickErrors: 0 });
    });
});
