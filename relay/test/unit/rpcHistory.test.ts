// Every configured RPC must serve the state of older blocks that the search for the use of an intent nonce reads
// (src/ops/rpcHistory.ts). Startup reads nonces(anything) on each RPC at max(deployBlock, head − window) and refuses to
// start if one cannot, as it refuses an RPC on another chain; it logs which RPCs serve eth_getBlockReceipts. The same
// check runs every RELAY_RPC_HISTORY_CHECK_SECONDS: an RPC that fails it makes the relay degraded, with an ALERT.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcRequestError, TimeoutError, toHex } from 'viem';
import { CHAINLINK_POL_USD_POLYGON } from '@nimiq/gasless-sdk/core';
import type { ChainClient, ReadContractCall } from '../../src/chain/types.js';
import { ConfigError, loadConfig } from '../../src/config.js';
import { checkRpcHistory, historyWindowBlocks, historyWindowOf, verifyRpcHistory } from '../../src/ops/rpcHistory.js';
import { startServer, type RelayServer } from '../../src/server.js';
import { StartupError } from '../../src/startup.js';
import { FakeChain } from '../helpers/fakeChain.js';
import { CONTRACT, START_TIME, TEST_TX_SETTINGS, captureLogger, createHarness, deploymentJson, testDeployment, type Harness } from '../helpers/harness.js';
import { RELAY_ADDRESS, RELAY_KEY } from '../helpers/keys.js';
import { addressInUse, freePort } from '../helpers/ports.js';
import { serveFakeChain, type RpcAdapter } from '../helpers/rpcAdapter.js';
import { installTokenPins, testTokenPinsJson } from '../helpers/tokenPins.js';

let h: Harness | undefined;
let server: RelayServer | undefined;
const adapters: RpcAdapter[] = [];
let dir: string | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
    await server?.close();
    server = undefined;
    await Promise.all(adapters.splice(0).map((a) => a.close()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});

/** A chain at head `head` (its blocks one second apart, the head now). */
function chainAt(head: bigint, timestamp = START_TIME): FakeChain {
    const chain = new FakeChain({ deployment: testDeployment(), timestamp, relay: RELAY_ADDRESS });
    chain.head = { ...chain.head, number: head, hash: toHex(head, { size: 32 }) };
    chain.finalized = head - 64n;
    return chain;
}

/** `chain` as a pruned node serves it while `pruned()`: no state below `from()`. */
function prunedView(chain: FakeChain, from: () => bigint, pruned: () => boolean = () => true): ChainClient {
    const view = chain.rpcView();
    return {
        ...view,
        readContract: <T>(call: ReadContractCall): Promise<T> =>
            pruned() && call.blockNumber !== undefined && call.blockNumber < from()
                ? Promise.reject(new RpcRequestError({ body: {}, url: 'fake', error: { code: -32000, message: 'missing trie node' } }))
                : view.readContract<T>(call),
    };
}

describe('the window: 2 × (longest request life + grace + finality margin + ALERT blocks), from the configuration', () => {
    it('defaults: 2 × (7200 + 12 + max(600, 256, 16) + 150) = 15,924 blocks', () => {
        expect(historyWindowOf(137, TEST_TX_SETTINGS)).toBe(15_924n);
        const env = { RELAY_RPC_URLS: 'http://a', RELAY_DEPLOYMENT_FILE: '/d.json', RELAY_PRIVATE_KEY_FILE: '/k' };
        expect(historyWindowOf(137, loadConfig(env).tx)).toBe(15_924n);
        // Each term follows its variable.
        expect(historyWindowOf(137, loadConfig({ ...env, RELAY_UNKNOWN_NONCE_GRACE_BLOCKS: '100' }).tx)).toBe(2n * (7200n + 100n + 600n + 150n));
        expect(historyWindowOf(137, loadConfig({ ...env, RELAY_FINALITY_FALLBACK_DEPTH: '2000' }).tx)).toBe(2n * (7200n + 12n + 2000n + 150n));
        expect(historyWindowOf(137, loadConfig({ ...env, RELAY_MAX_FINALITY_LAG_BLOCKS: '5000' }).tx)).toBe(2n * (7200n + 12n + 5000n + 150n));
        expect(historyWindowOf(137, loadConfig({ ...env, RELAY_MIN_FINALITY_DEPTH: '3000' }).tx)).toBe(2n * (7200n + 12n + 3000n + 150n));
        expect(historyWindowOf(137, loadConfig({ ...env, RELAY_STUCK_AFTER_BLOCKS: '1000' }).tx)).toBe(2n * (7200n + 12n + 600n + 1000n));
    });

    it('the finality depth the transaction manager applies (at least 16 on Polygon PoS), not less', () => {
        const s = { maxDeadlineSeconds: 7200, unknownNonceGraceBlocks: 1, minFinalityDepth: 0, finalityFallbackDepth: 1, maxFinalityLagBlocks: 0, stuckAfterBlocks: 10 };
        expect(historyWindowBlocks({ ...s, chainId: 137 })).toBe(2n * (7200n + 1n + 16n + 10n));
        expect(historyWindowBlocks({ ...s, chainId: 31337 })).toBe(2n * (7200n + 1n + 1n + 10n));
    });

    it('RELAY_RPC_HISTORY_CHECK_SECONDS: 600 by default, 0 (startup only) to 86400', () => {
        const env = { RELAY_RPC_URLS: 'http://a', RELAY_DEPLOYMENT_FILE: '/d.json', RELAY_PRIVATE_KEY_FILE: '/k' };
        expect(loadConfig(env).rpcHistoryCheckMs).toBe(600_000);
        expect(loadConfig({ ...env, RELAY_RPC_HISTORY_CHECK_SECONDS: '0' }).rpcHistoryCheckMs).toBe(0);
        expect(() => loadConfig({ ...env, RELAY_RPC_HISTORY_CHECK_SECONDS: '86401' })).toThrow(ConfigError);
    });
});

describe('the check: nonces(anything) at max(deployBlock, head − window) on every RPC', () => {
    it('reads each RPC at its own head − window; an RPC without that state fails it, named by position with the JSON-RPC code', async () => {
        const chain = chainAt(100_000n);
        const reads: bigint[] = [];
        const full = chain.rpcView();
        chain.rpcClients = () => [
            { ...full, readContract: <T>(call: ReadContractCall) => (reads.push(call.blockNumber!), full.readContract<T>(call)) },
            prunedView(chain, () => 99_000n),
        ];
        const window = 15_924n;
        expect(await checkRpcHistory(chain, CONTRACT, 1000n, window)).toEqual([
            { rpc: 1, ok: true, block: '84076' },
            { rpc: 2, ok: false, block: '84076', reason: 'error -32000' },
        ]);
        expect(reads).toEqual([84_076n]);
        // A node that keeps exactly the window passes.
        chain.rpcClients = () => [full, prunedView(chain, () => 84_076n)];
        expect((await checkRpcHistory(chain, CONTRACT, 1000n, window)).every((r) => r.ok)).toBe(true);
    });

    it('a chain younger than the window: at deployBlock; no data there (the contract not created yet) shows the state', async () => {
        const chain = chainAt(5000n);
        chain.contractCreatedAt = 1001n;
        expect(await checkRpcHistory(chain, CONTRACT, 1000n, 15_924n)).toEqual([{ rpc: 1, ok: true, block: '1000' }]);
        chain.stateFrom = 1001n;
        expect(await checkRpcHistory(chain, CONTRACT, 1000n, 15_924n)).toEqual([{ rpc: 1, ok: false, block: '1000', reason: 'error -32000' }]);
    });

    it('an RPC that does not answer fails it (silent: no refusal of the state); startup refuses it too', async () => {
        const chain = chainAt(100_000n);
        const down = chainAt(100_000n);
        down.rpcDown = true;
        const view = chain.rpcView();
        const slow: ChainClient = { ...view, readContract: () => Promise.reject(new TimeoutError({ body: {}, url: 'https://rpc.invalid' })) };
        chain.rpcClients = () => [chain.rpcView(), down.rpcView(), slow];
        expect(await checkRpcHistory(chain, CONTRACT, 1000n, 15_924n)).toEqual([
            { rpc: 1, ok: true, block: '84076' },
            { rpc: 2, ok: false, reason: 'no head (other)', silent: true },
            { rpc: 3, ok: false, block: '84076', reason: 'timeout', silent: true },
        ]);
        const error = await verifyRpcHistory(chain, CONTRACT, 1000n, 15_924n).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(StartupError);
        expect((error as Error).message).toContain(' - RPC #2: no answer (no head (other))\n - RPC #3: no answer at block 84076 (timeout)');
    });

    it('verifyRpcHistory throws a StartupError naming the RPC by position and the block, and logs eth_getBlockReceipts support', async () => {
        const chain = chainAt(100_000n);
        chain.rpcClients = () => [chain.rpcView(), prunedView(chain, () => 99_000n)];
        const error = await verifyRpcHistory(chain, CONTRACT, 1000n, 15_924n).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(StartupError);
        expect((error as Error).message).toBe(
            'every RPC in RELAY_RPC_URLS must serve the state of the last 15924 blocks (an archive node, or one that keeps that much state):\n - RPC #2: no state at block 84076 (error -32000)',
        );

        const refusing = chainAt(100_000n);
        refusing.failing.add('getBlockReceipts');
        chain.rpcClients = () => [chain.rpcView(), refusing.rpcView()];
        const logs = captureLogger('info');
        expect(await verifyRpcHistory(chain, CONTRACT, 1000n, 15_924n, logs.logger)).toHaveLength(2);
        expect(logs.text()).toContain('"rpcs":[{"rpc":1,"blockReceipts":"yes"},{"rpc":2,"blockReceipts":"no"}]');
        expect(logs.text()).toContain('eth_getBlockReceipts per RPC (where not: receipts are read one by one, at most 16 per block)');
    });
});

/** startServer attempts, each with a new port from freePort. */
const PORT_ATTEMPTS = 3;

/** startServer, as main.ts runs it, with RELAY_RPC_URLS serving `chains` over JSON-RPC. */
async function start(chains: readonly FakeChain[], env: Record<string, string> = {}): Promise<{ server: RelayServer; logs: () => string }> {
    for (const chain of chains) {
        installTokenPins(chain);
        chain.feed = { address: CHAINLINK_POL_USD_POLYGON, decimals: 8, answer: 20_000_000n, updatedAt: BigInt(Math.floor(Date.now() / 1000)), description: 'POL / USD' };
        adapters.push(await serveFakeChain(chain));
    }
    dir = mkdtempSync(join(tmpdir(), 'relay-rpc-history-'));
    writeFileSync(join(dir, 'token-pins.json'), JSON.stringify(testTokenPinsJson()));
    writeFileSync(join(dir, 'deployment.json'), JSON.stringify(deploymentJson()));
    writeFileSync(join(dir, 'relay.key'), `${RELAY_KEY}\n`, { mode: 0o600 });
    // A port from freePort can be taken before the relay listens on it (EADDRINUSE): then a new one, as startRelay does.
    for (let attempt = 1; ; attempt++) {
        const config = loadConfig({
            RELAY_RPC_URLS: adapters.map((a) => a.url).join(','),
            RELAY_DEPLOYMENT_FILE: join(dir, 'deployment.json'),
            RELAY_TOKEN_PINS_FILE: join(dir, 'token-pins.json'),
            RELAY_PRIVATE_KEY_FILE: join(dir, 'relay.key'),
            RELAY_DB_PATH: join(dir, 'relay.sqlite'),
            RELAY_HOST: '127.0.0.1',
            RELAY_PORT: String(await freePort()),
            RELAY_OPS_PORT: '0',
            RELAY_POLL_INTERVAL_MS: '100',
            RELAY_READINESS_CACHE_MS: '0',
            ...env,
        });
        const captured = captureLogger('info');
        try {
            server = await startServer(config, captured.logger);
            return { server, logs: captured.text };
        } catch (err) {
            if (!addressInUse(err) || attempt >= PORT_ATTEMPTS) throw err;
        }
    }
}

describe('startup (startServer, the viem client, the fake chain over JSON-RPC)', () => {
    it('refuses to start when one RPC does not serve the state at head − window, as it refuses another chain', async () => {
        const now = Math.floor(Date.now() / 1000);
        const full = chainAt(100_000n, now);
        const pruned = chainAt(100_000n, now);
        pruned.stateFrom = 99_000n;
        const error = await start([full, pruned]).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(StartupError);
        expect((error as Error).message).toContain('RPC #2: no state at block 84076 (error -32000)');
        expect((error as Error).message).not.toContain(adapters[1]!.url);
    }, 30_000);

    it('starts when every RPC serves it; logs which RPCs serve eth_getBlockReceipts; ready and not degraded', async () => {
        const now = Math.floor(Date.now() / 1000);
        const a = chainAt(100_000n, now);
        const b = chainAt(100_000n, now);
        b.stateFrom = 84_076n;
        b.failing.add('getBlockReceipts');
        const { server: s, logs } = await start([a, b]);
        expect(logs()).toContain('"rpcs":[{"rpc":1,"blockReceipts":"yes"},{"rpc":2,"blockReceipts":"no"}]');
        expect(s.relay.rpcHistory.status()).toMatchObject({ ok: true, window: '15924', failures: [] });
        const report = (await (await fetch(`${s.opsAddress}/readyz`)).json()) as { degraded: boolean; checks: { rpcHistory: unknown } };
        expect(report.degraded).toBe(false);
        expect(report.checks.rpcHistory).toMatchObject({ ok: true, window: '15924', failures: [] });
        expect(await (await fetch(`${s.opsAddress}/metrics`)).text()).toContain('relay_rpc_history_unavailable{rpc="2"} 0');
    }, 30_000);

    it('RELAY_RPC_HISTORY_CHECK_SECONDS: an RPC pruned while the relay runs makes /readyz degraded, with the ALERT', async () => {
        const now = Math.floor(Date.now() / 1000);
        const a = chainAt(100_000n, now);
        const b = chainAt(100_000n, now);
        const { server: s, logs } = await start([a, b], { RELAY_RPC_HISTORY_CHECK_SECONDS: '1' });
        b.stateFrom = 99_000n;
        const end = Date.now() + 10_000;
        let report: { ready: boolean; degraded: boolean; checks: { rpcHistory?: unknown } } | undefined;
        for (;;) {
            report = (await (await fetch(`${s.opsAddress}/readyz`)).json()) as typeof report;
            if (report!.degraded || Date.now() > end) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(report).toMatchObject({ degraded: true, checks: { rpcHistory: { ok: false, failures: [{ rpc: 2, ok: false, block: '84076', reason: 'error -32000' }] } } });
        expect(logs()).toContain('ALERT: RPC #2 in RELAY_RPC_URLS does not serve the state of older blocks');
        expect(await (await fetch(`${s.opsAddress}/metrics`)).text()).toContain('relay_rpc_history_unavailable{rpc="2"} 1');
    }, 30_000);
});

describe('at runtime: degraded and the ALERT while an RPC fails the check', () => {
    it('an RPC that stops serving the state: degraded (still ready), gauge 1, ALERT (again after 5 minutes); cleared once it serves it again', async () => {
        h = await createHarness({ settings: { readinessCacheMs: 0 } });
        const chain = h.chain;
        chain.head = { ...chain.head, number: 20_000n, hash: toHex(20_000n, { size: 32 }) };
        chain.finalized = 19_936n;
        let pruned = false;
        chain.rpcClients = () => [chain.rpcView(), prunedView(chain, () => 19_000n, () => pruned)];
        // ALERT lines are errors.
        const alerts = () => h!.logs.lines.filter((l) => l.includes('"alert":"rpc_history"') && l.includes('"level":"error"')).length;

        await h.relay.rpcHistory.check();
        expect(await h.relay.readiness()).toMatchObject({ ready: true, degraded: false, checks: { rpcHistory: { ok: true, window: '15924', failures: [] } } });

        pruned = true;
        await h.relay.rpcHistory.check();
        expect(await h.relay.readiness()).toMatchObject({
            ready: true,
            degraded: true,
            checks: { rpcHistory: { ok: false, failures: [{ rpc: 2, ok: false, block: '4076', reason: 'error -32000' }] } },
        });
        expect(h.logs.text()).toContain(
            'ALERT: RPC #2 in RELAY_RPC_URLS does not serve the state of older blocks that the search for the use of an intent nonce reads (the last 15924 blocks)',
        );
        const metrics = await h.metrics.registry.metrics();
        expect(metrics).toContain('relay_rpc_history_unavailable{rpc="1"} 0');
        expect(metrics).toContain('relay_rpc_history_unavailable{rpc="2"} 1');
        expect(alerts()).toBe(1);

        await h.relay.rpcHistory.check();
        expect(alerts()).toBe(1); // not repeated within 5 minutes
        h.clock.advance(300);
        await h.relay.rpcHistory.check();
        expect(alerts()).toBe(2);

        pruned = false;
        await h.relay.rpcHistory.check();
        expect(await h.relay.readiness()).toMatchObject({ ready: true, degraded: false, checks: { rpcHistory: { ok: true, failures: [] } } });
        expect(await h.metrics.registry.metrics()).toContain('relay_rpc_history_unavailable{rpc="2"} 0');
        expect(h.logs.text()).toContain('every RPC serves the state of older blocks again');
    });

    // One check an RPC does not answer (a timeout, a rate limit, a lost connection) must not make the relay degraded and
    // log the ALERT for a whole interval. Only a refusal of the state (an error answer, as the search takes it) counts;
    // no answer leaves the RPC's last answered result.
    it('a check an RPC does not answer (no head, a timeout of the state read) changes nothing: its last answered result stands', async () => {
        h = await createHarness({ settings: { readinessCacheMs: 0 } });
        const chain = h.chain;
        chain.head = { ...chain.head, number: 20_000n, hash: toHex(20_000n, { size: 32 }) };
        chain.finalized = 19_936n;
        let mode: 'serves' | 'no head' | 'timeout' | 'pruned' = 'serves';
        const view = chain.rpcView();
        const timeout = () => new TimeoutError({ body: {}, url: 'https://rpc.invalid' });
        chain.rpcClients = () => [
            chain.rpcView(),
            {
                ...view,
                getBlock: (tag) => (mode === 'no head' ? Promise.reject(timeout()) : view.getBlock(tag)),
                readContract: <T>(call: ReadContractCall): Promise<T> => {
                    if (call.blockNumber !== undefined && call.blockNumber < 19_000n && mode === 'timeout') return Promise.reject(timeout());
                    if (call.blockNumber !== undefined && call.blockNumber < 19_000n && mode === 'pruned') {
                        return Promise.reject(new RpcRequestError({ body: {}, url: 'fake', error: { code: -32000, message: 'missing trie node' } }));
                    }
                    return view.readContract<T>(call);
                },
            },
        ];
        const alerts = () => h!.logs.lines.filter((l) => l.includes('"alert":"rpc_history"') && l.includes('"level":"error"')).length;
        const gauge = async () => ((await h!.metrics.registry.metrics()).match(/relay_rpc_history_unavailable\{rpc="2"\} (\d)/) ?? [])[1];

        for (const blip of ['no head', 'timeout'] as const) {
            mode = blip;
            await h.relay.rpcHistory.check();
            expect(await h.relay.readiness(), blip).toMatchObject({ ready: true, degraded: false, checks: { rpcHistory: { ok: true, failures: [] } } });
            expect(await gauge(), blip).toBe('0');
        }
        expect(alerts()).toBe(0);
        expect(h.logs.text()).toContain('RPC #2 did not answer the check of the state of older blocks; the last answer stands');

        mode = 'pruned';
        await h.relay.rpcHistory.check();
        expect(alerts()).toBe(1);
        // A refusal stands while the RPC does not answer.
        for (const blip of ['no head', 'timeout'] as const) {
            mode = blip;
            await h.relay.rpcHistory.check();
            expect(await h.relay.readiness(), blip).toMatchObject({
                ready: true,
                degraded: true,
                checks: { rpcHistory: { ok: false, failures: [{ rpc: 2, ok: false, block: '4076', reason: 'error -32000' }] } },
            });
            expect(await gauge(), blip).toBe('1');
        }
        mode = 'serves';
        await h.relay.rpcHistory.check();
        expect(await h.relay.readiness()).toMatchObject({ degraded: false, checks: { rpcHistory: { ok: true, failures: [] } } });
        expect(await gauge()).toBe('0');
    });

    it('start(interval) repeats the check on its own', async () => {
        h = await createHarness({ settings: { readinessCacheMs: 0 } });
        const chain = h.chain;
        chain.head = { ...chain.head, number: 20_000n, hash: toHex(20_000n, { size: 32 }) };
        chain.rpcClients = () => [chain.rpcView(), prunedView(chain, () => 19_000n)];
        expect(h.relay.rpcHistory.status().ok).toBe(true);
        h.relay.rpcHistory.start(10);
        const end = Date.now() + 5000;
        while (h.relay.rpcHistory.status().ok && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(h.relay.rpcHistory.status()).toMatchObject({ ok: false, failures: [{ rpc: 2 }] });
        expect((await h.relay.readiness()).degraded).toBe(true);
        await h.relay.rpcHistory.stop();
    });
});
