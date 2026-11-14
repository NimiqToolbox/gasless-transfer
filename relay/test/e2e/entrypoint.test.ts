// End-to-end test of the production entrypoint. Builds dist/ and runs `node dist/main.js` as a child
// process with a real configuration (env vars, key file, deployment file, SQLite file) and the real
// viem client, against the fake chain served over JSON-RPC. Everything binds 127.0.0.1 inside the
// test container; no port is published.
import { installTokenPins, testTokenPinsJson } from '../helpers/tokenPins.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAINLINK_POL_USD_POLYGON } from '@nimiq/gasless-sdk/core';
import type { FeeResponse, InfoResponse, RequestState } from '@nimiq/gasless-sdk/relay';
import { FakeChain } from '../helpers/fakeChain.js';
import { CONTRACT, TestClock, USDC, USDT0, buildTransfer, deploymentJson, testDeployment } from '../helpers/harness.js';
import { RECIPIENT_ADDRESS, RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS } from '../helpers/keys.js';
import { freePort } from '../helpers/ports.js';
import { serveFakeChain, type RpcAdapter } from '../helpers/rpcAdapter.js';

const RELAY_DIR = fileURLToPath(new URL('../..', import.meta.url));
const MAIN = join(RELAY_DIR, 'dist', 'main.js');
/** Stands in for an API key embedded in an RPC URL; it must never show up in the output. */
const URL_SECRET = 'e2e-secret-api-key';

interface RelayProcess {
    readonly child: ChildProcess;
    output(): string;
    /** JSON log lines emitted so far. */
    logs(): Array<Record<string, unknown>>;
    readonly exited: Promise<number | null>;
}

const running: RelayProcess[] = [];

function startRelay(env: Record<string, string>): RelayProcess {
    let out = '';
    const child = spawn(process.execPath, [MAIN], { cwd: RELAY_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
    const p: RelayProcess = {
        child,
        output: () => out,
        logs: () => {
            const lines = out.split('\n');
            lines.pop(); // incomplete (or empty) last line
            return lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
        },
        exited,
    };
    running.push(p);
    return p;
}

async function until<T>(what: string, relay: RelayProcess, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}; relay output:\n${relay.output()}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
    const res = await fetch(url);
    return { status: res.status, body: (await res.json()) as T };
}

beforeAll(() => {
    // Always test the current sources: compile them the way the production image does.
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: RELAY_DIR, stdio: 'pipe' });
}, 180_000);

describe('production entrypoint (node dist/main.js)', () => {
    let dir: string;
    let chain: FakeChain;
    let rpc: RpcAdapter;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'relay-e2e-'));
        const now = Math.floor(Date.now() / 1000);
        chain = new FakeChain({ deployment: testDeployment(), timestamp: now, relay: RELAY_ADDRESS });
        chain.setBalance(USDC, USER_ADDRESS, 100_000_000n);
        chain.feed = { address: CHAINLINK_POL_USD_POLYGON, decimals: 8, answer: 25_000_000n, updatedAt: BigInt(now), description: 'POL / USD' };
        installTokenPins(chain);
        writeFileSync(join(dir, 'token-pins.json'), JSON.stringify(testTokenPinsJson()));
        rpc = await serveFakeChain(chain);
        writeFileSync(join(dir, 'deployment.json'), JSON.stringify(deploymentJson()));
        writeFileSync(join(dir, 'relay.key'), `${RELAY_KEY}\n`, { mode: 0o600 });
    });

    afterEach(async () => {
        for (const p of running.splice(0)) {
            if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
            await p.exited;
        }
        await rpc.close();
        rmSync(dir, { recursive: true, force: true });
    });

    function env(overrides: Record<string, string> = {}): Record<string, string> {
        return {
            RELAY_RPC_URLS: `${rpc.url}/v2/${URL_SECRET}`,
            RELAY_DEPLOYMENT_FILE: join(dir, 'deployment.json'),
            RELAY_TOKEN_PINS_FILE: join(dir, 'token-pins.json'),
            RELAY_PRIVATE_KEY_FILE: join(dir, 'relay.key'),
            // No RELAY_POLUSD_FALLBACK (the relay refuses one): the fake chain serves the default Chainlink feed.
            RELAY_DB_PATH: join(dir, 'data', 'relay.sqlite'),
            RELAY_HOST: '127.0.0.1',
            RELAY_OPS_PORT: '0',
            RELAY_POLL_INTERVAL_MS: '100',
            RELAY_RPC_TIMEOUT_MS: '2000',
            RELAY_LOG_LEVEL: 'debug',
            ...overrides,
        };
    }

    it('refuses Polygon mainnet startup without reviewed token implementation pins', async () => {
        const relay = startRelay(env({ RELAY_TOKEN_PINS_FILE: '' }));
        expect(await relay.exited).toBe(1);
        expect(relay.output()).toContain('RELAY_TOKEN_PINS_FILE');
        expect(chain.broadcasts).toHaveLength(0);
    });

    it('T33: starts, relays a permit transfer to confirmation, keeps state across a restart and stops on SIGTERM', async () => {
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        let opsPort = await freePort();
        while (opsPort === port) opsPort = await freePort();
        const opsBase = `http://127.0.0.1:${opsPort}`;
        const relay = startRelay(env({ RELAY_PORT: String(port), RELAY_OPS_PORT: String(opsPort) }));
        const started = await until('startup', relay, () => relay.logs().find((l) => l.msg === 'relay started'));
        // All URLs are removed from logs, even known local listener URLs. Probe the explicitly
        // configured endpoints rather than recovering connection information from log output.
        expect(started).toMatchObject({ relay: RELAY_ADDRESS, chainId: 137, address: '[REDACTED_URL]', opsAddress: '[REDACTED_URL]' });
        const logs = relay.logs();
        expect(logs.find((l) => l.msg === 'deployment verified on-chain')).toMatchObject({ contract: CONTRACT, tokens: ['USDC', 'USDT0'] });
        expect(logs.find((l) => l.msg === 'POL/USD price feed')).toMatchObject({ feed: CHAINLINK_POL_USD_POLYGON, description: 'POL / USD' });
        // The committed gas table holds the Polygon-native calibration, so there is no placeholder warning.
        expect(logs.some((l) => String(l.msg).startsWith('gas table is a placeholder'))).toBe(false);

        expect((await getJson(`${base}/healthz`)).body).toEqual({ status: 'ok' });
        // Polled on the internal listener, which serves the whole report.
        const ready = await until('readiness', relay, async () => {
            const r = await getJson<{ ready: boolean; checks: Record<string, unknown> }>(`${opsBase}/readyz`);
            return r.status === 200 ? r.body : undefined;
        });
        expect(ready.ready).toBe(true);
        expect(Object.keys(ready.checks).sort()).toEqual(['balance', 'priceSource', 'rpc', 'rpcHistory', 'tokenDomains', 'tokenImplementations', 'txManager']);
        expect(ready.checks.rpcHistory).toMatchObject({ ok: true, failures: [] });
        expect(logs.some((l) => String(l.msg).startsWith('every RPC serves the state of older blocks; eth_getBlockReceipts per RPC'))).toBe(true);
        expect((await getJson<{ ready: boolean }>(`${base}/readyz`)).body.ready).toBe(true);

        const info = (await getJson<InfoResponse>(`${base}/v1/info`)).body;
        expect(info).toMatchObject({ chainId: 137, relay: RELAY_ADDRESS });
        expect(info.contracts.transfer).toMatchObject({ address: CONTRACT, domain: { version: '3' } });

        const quote = await getJson<FeeResponse>(`${base}/v1/fee?operation=transfer&token=${USDC}&authMode=permit`);
        expect(quote.status).toBe(200);
        expect(quote.body.polUsd).toBe('0.25'); // read from the Chainlink feed over JSON-RPC

        const transfer = await buildTransfer({ chain, clock: new TestClock(Date.now()) }, { fee: BigInt(quote.body.fee) });
        const submit = await fetch(`${base}/v1/transfer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
            body: JSON.stringify(transfer.body),
        });
        expect(submit.status).toBe(202);
        // Every origin may call the relay: self-hosted Wallet, Hub and Keyguard instances have their own origins.
        expect(submit.headers.get('access-control-allow-origin')).toBe('*');
        expect(await submit.json()).toEqual({ id: transfer.id, status: 'queued' });

        await until('broadcast', relay, () => (chain.mempool.size > 0 ? true : undefined));
        chain.mine();
        const includedAt = chain.head.number;
        // `confirmed` needs the finalized tag and RELAY_MIN_FINALITY_DEPTH (16) blocks on top.
        chain.mineBlocks(16);
        chain.finalized = chain.head.number;
        const confirmed = await until('confirmation', relay, async () => {
            const s = (await getJson<RequestState>(`${base}/v1/requests/${transfer.id}`)).body;
            return s.status === 'confirmed' ? s : undefined;
        });
        expect(confirmed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(confirmed.blockNumber).toBe(includedAt.toString());
        expect(chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(1_000_000n);
        expect(chain.token(USDC).balances.get(RELAY_ADDRESS.toLowerCase())).toBe(BigInt(quote.body.fee));

        // /metrics is only served on the internal listener.
        expect((await fetch(`${base}/metrics`)).status).toBe(404);
        const metrics = await (await fetch(`${opsBase}/metrics`)).text();
        expect(metrics).toMatch(/relay_submissions_total\{operation="transfer",outcome="accepted"\} 1/);
        expect(metrics).toContain('relay_process_cpu_user_seconds_total');

        // A second process on the same database refuses to start (single writer).
        const second = startRelay(env({ RELAY_PORT: String(await freePort()) }));
        expect(await second.exited).toBe(1);
        expect(second.output()).toContain('relay failed to start');
        expect(second.output()).toMatch(/database is locked/i);

        relay.child.kill('SIGTERM');
        expect(await relay.exited).toBe(0);
        expect(relay.logs().some((l) => l.msg === 'shutting down')).toBe(true);

        // Restart on the same database: the request is still there and still confirmed.
        const port2 = await freePort();
        const restarted = startRelay(env({ RELAY_PORT: String(port2) }));
        await until('restart', restarted, () => restarted.logs().find((l) => l.msg === 'relay started'));
        const after = (await getJson<RequestState>(`http://127.0.0.1:${port2}/v1/requests/${transfer.id}`)).body;
        expect(after).toMatchObject({ status: 'confirmed', txHash: confirmed.txHash });
        restarted.child.kill('SIGTERM');
        expect(await restarted.exited).toBe(0);

        // Secrets never reach the output: key, request signature, token authorization, RPC URL.
        const permitS = transfer.body.authorization.s;
        expect(permitS).toBeDefined();
        for (const p of [relay, second, restarted]) {
            const out = p.output().toLowerCase();
            expect(out).not.toContain(RELAY_KEY.slice(2).toLowerCase());
            expect(out).not.toContain(transfer.body.signature.slice(2).toLowerCase());
            expect(out).not.toContain(permitS?.slice(2).toLowerCase());
            expect(out).not.toContain(URL_SECRET);
        }
    }, 90_000);

    it('exits with status 1 when the RPC is unreachable, without logging the RPC URL', async () => {
        const closedPort = await freePort();
        const relay = startRelay(env({ RELAY_PORT: String(await freePort()), RELAY_RPC_URLS: `http://127.0.0.1:${closedPort}/v2/${URL_SECRET}` }));
        expect(await relay.exited).toBe(1);
        const fatal = relay.logs().find((l) => l.msg === 'relay failed to start');
        expect(fatal).toBeDefined();
        expect(relay.output()).not.toContain(URL_SECRET);
        expect(relay.output()).not.toContain(`127.0.0.1:${closedPort}`);
    }, 30_000);

    it('refuses to start when the chain does not match the deployment file', async () => {
        // The owner changed the token configuration (setTokenConfig) after the deployment file was written.
        chain.setTokenConfig(USDT0, { metaTxApprove: false });
        chain.setTokenConfig(USDC, { permit: false });
        const relay = startRelay(env({ RELAY_PORT: String(await freePort()) }));
        expect(await relay.exited).toBe(1);
        const out = relay.output();
        expect(out).toContain('USDT0: tokenConfig on-chain (permit true, metaTxApprove false, allowance true)');
        expect(out).toContain('USDC: tokenConfig on-chain');
        expect(out).not.toContain('relay started');
    }, 30_000);

    it('reports configuration errors without echoing secret values', async () => {
        const badUrl = startRelay(env({ RELAY_RPC_URLS: `wss://user:${URL_SECRET}@rpc.example` }));
        expect(await badUrl.exited).toBe(1);
        expect(badUrl.output()).toContain('relay configuration error: RELAY_RPC_URLS entry #1 is not an http(s) URL');
        expect(badUrl.output()).not.toContain(URL_SECRET);

        writeFileSync(join(dir, 'relay.key'), 'not-a-key secret-material\n');
        const badKey = startRelay(env({ RELAY_PORT: String(await freePort()) }));
        expect(await badKey.exited).toBe(1);
        expect(badKey.output()).toContain('RELAY_PRIVATE_KEY_FILE must contain exactly one 32-byte hex private key');
        expect(badKey.output()).not.toContain('secret-material');
    }, 30_000);

    it('a configuration error leaves no temporary key copy behind (RELAY_PRIVATE_KEY_FILE_REMOVE)', async () => {
        const keyFile = join(dir, 'relay.key');
        const refused = { RELAY_LOG_LEVEL: 'loud' };
        const configurationError = 'relay configuration error: RELAY_LOG_LEVEL must be one of';
        const lines = (relay: RelayProcess): string[] => relay.output().trim().split('\n');

        // Without the setting, and with a value that is not `true`, the file can be the only copy of the key: it stays.
        const kept = startRelay(env(refused));
        expect(await kept.exited).toBe(1);
        expect(lines(kept)).toEqual([expect.stringContaining(configurationError)]);
        const unclear = startRelay(env({ RELAY_PRIVATE_KEY_FILE_REMOVE: 'yes' }));
        expect(await unclear.exited).toBe(1);
        expect(lines(unclear)).toEqual(['relay configuration error: RELAY_PRIVATE_KEY_FILE_REMOVE must be true or false']);
        expect(existsSync(keyFile)).toBe(true);

        const removed = startRelay(env({ ...refused, RELAY_PRIVATE_KEY_FILE_REMOVE: ' true ' }));
        expect(await removed.exited).toBe(1);
        expect(lines(removed)).toEqual([expect.stringContaining(configurationError)]);
        expect(existsSync(keyFile)).toBe(false);

        // A file that cannot be removed is reported after the configuration error.
        const missing = startRelay(env({ ...refused, RELAY_PRIVATE_KEY_FILE_REMOVE: 'true' }));
        expect(await missing.exited).toBe(1);
        expect(lines(missing)).toEqual([
            expect.stringContaining(configurationError),
            'relay configuration error: RELAY_PRIVATE_KEY_FILE could not be removed (ENOENT) although RELAY_PRIVATE_KEY_FILE_REMOVE is true',
        ]);
    }, 30_000);
});
