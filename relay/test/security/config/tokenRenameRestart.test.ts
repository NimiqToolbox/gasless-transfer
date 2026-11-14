// After a token rename, a restart starts the relay degraded, as the running relay is.
//
// USDT0 can be renamed on-chain (changeName), which replaces the token's EIP-712 domain. A running relay survives
// that: the token domain monitor refuses that token's permit and meta-tx requests, the relay stays ready with
// `degraded: true`, and USDC and NONE mode keep working (relay/README.md). Startup must not be stricter than the
// running relay. If verifyDeployment (src/startup.ts) refused a token whose DOMAIN_SEPARATOR() differs from the
// deployment file, any restart (a crash, an OOM kill, a reboot, a deployment) would take USDC and every other token
// down with the renamed one; and on chain 137 the deployment file cannot simply be updated, since the token domain
// must equal the SDK pin.
//
// So verifyDeployment reports the tokens whose on-chain domain differs (tokenDomainMismatches), and startServer
// (src/server.ts) hands the readings to the token domain monitor: the relay starts with that token's permit and
// meta-tx refused and reports itself degraded. A GaslessTransfer domain mismatch and a deployment file that
// contradicts the SDK pins still stop startup.
//
// The restart tests run startServer, the production wiring, against the fake chain served over JSON-RPC.
import { installTokenPins, testTokenPinsJson } from '../../helpers/tokenPins.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAINLINK_POL_USD_POLYGON } from '@nimiq/gasless-sdk/core';
import { loadConfig, parseDeployment } from '../../../src/config.js';
import { startServer, type RelayServer } from '../../../src/server.js';
import { StartupError, verifyDeployment } from '../../../src/startup.js';
import { FakeChain } from '../../helpers/fakeChain.js';
import {
    CONTRACT,
    START_TIME,
    TestClock,
    USDC,
    USDT0,
    buildTransfer,
    captureLogger,
    createHarness,
    deploymentJson,
    testDeployment,
    type Harness,
} from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS } from '../../helpers/keys.js';
import { freePort } from '../../helpers/ports.js';
import { serveFakeChain, type RpcAdapter } from '../../helpers/rpcAdapter.js';

/** Any other value: USDT0's DOMAIN_SEPARATOR() after `changeName`. */
const RENAMED = `0x${'ab'.repeat(32)}` as const;

let h: Harness | undefined;
let server: RelayServer | undefined;
let rpc: RpcAdapter | undefined;
let dir: string | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
    await server?.close();
    server = undefined;
    await rpc?.close();
    rpc = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});

function renamedChain(timestamp = START_TIME): FakeChain {
    const chain = new FakeChain({ deployment: testDeployment(), timestamp, relay: RELAY_ADDRESS });
    chain.token(USDT0).domainSeparator = RENAMED;
    return chain;
}

/** startServer, as main.ts runs it, against `chain` served over JSON-RPC. */
async function start(chain: FakeChain, deployment: unknown = deploymentJson()): Promise<{ server: RelayServer; logs: () => string }> {
    installTokenPins(chain);
    // The relay requires a price feed (RELAY_POLUSD_FEED): the fake chain serves the default Chainlink POL/USD feed
    // of chain 137 with a fresh answer.
    chain.feed = { address: CHAINLINK_POL_USD_POLYGON, decimals: 8, answer: 20_000_000n, updatedAt: BigInt(Math.floor(Date.now() / 1000)), description: 'POL / USD' };
    rpc = await serveFakeChain(chain);
    dir = mkdtempSync(join(tmpdir(), 'relay-'));
    writeFileSync(join(dir, 'token-pins.json'), JSON.stringify(testTokenPinsJson()));
    writeFileSync(join(dir, 'deployment.json'), JSON.stringify(deployment));
    writeFileSync(join(dir, 'relay.key'), `${RELAY_KEY}\n`, { mode: 0o600 });
    const config = loadConfig({
        RELAY_RPC_URLS: rpc.url,
        RELAY_DEPLOYMENT_FILE: join(dir, 'deployment.json'),
            RELAY_TOKEN_PINS_FILE: join(dir, 'token-pins.json'),
        RELAY_PRIVATE_KEY_FILE: join(dir, 'relay.key'),
        RELAY_DB_PATH: join(dir, 'relay.sqlite'),
        RELAY_HOST: '127.0.0.1',
        RELAY_PORT: String(await freePort()),
        RELAY_OPS_PORT: '0',
        RELAY_POLL_INTERVAL_MS: '100',
        RELAY_READINESS_CACHE_MS: '0',
        // Off: the state below comes from startup verification alone.
        RELAY_TOKEN_DOMAIN_CHECK_SECONDS: '0',
    });
    const captured = captureLogger('info');
    server = await startServer(config, captured.logger);
    return { server, logs: captured.text };
}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
    const end = Date.now() + 10_000;
    for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe('control: the running relay survives the rename', () => {
    it('USDT0 renamed while the relay runs: ready and degraded, USDC permits still accepted', async () => {
        h = await createHarness();
        h.chain.token(USDT0).domainSeparator = RENAMED;
        await h.relay.tokenDomains.check();
        expect(await h.relay.readiness()).toMatchObject({ ready: true, degraded: true });
        const usdc = await buildTransfer(h, { token: USDC, mode: 'permit' });
        expect((await h.relay.pipeline.submit(h.relay.registry.get('transfer')!, usdc.body)).statusCode).toBe(202);
    });
});

describe('a restart after a token rename', () => {
    it('startup verification lets the relay start degraded (USDC and NONE mode), as the running relay is', async () => {
        const verified = await verifyDeployment(renamedChain(), testDeployment()).then(
            (result) => result,
            (err: unknown) => err,
        );
        expect(verified, `startup refused: ${verified instanceof Error ? verified.message : ''}`).not.toBeInstanceOf(Error);
        expect(verified).toMatchObject({ tokenDomainMismatches: ['USDT0'] });
    });

    it('startServer starts degraded: USDT0 permit and meta-tx refused, USDT0 NONE mode and USDC accepted', async () => {
        const now = Math.floor(Date.now() / 1000);
        const chain = renamedChain(now);
        chain.setBalance(USDC, USER_ADDRESS, 100_000_000n);
        chain.setBalance(USDT0, USER_ADDRESS, 100_000_000n);
        chain.setAllowance(USDT0, USER_ADDRESS, CONTRACT, 10n ** 12n);
        chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
        const { server: s, logs } = await start(chain);
        expect(logs()).toContain('starting degraded, with its permit and meta-tx refused');
        expect(logs()).toContain('ALERT: token DOMAIN_SEPARATOR() no longer matches the configured domain');
        expect(s.relay.tokenDomains.status()).toMatchObject({ ok: false, mismatched: ['USDT0'] });

        // Ready (once the transaction manager has made its first pass) and degraded, on both listeners.
        const ready = await until('readiness', async () => {
            const res = await fetch(`${s.address}/readyz`);
            return res.status === 200 ? ((await res.json()) as unknown) : undefined;
        });
        expect(ready).toEqual({ ready: true, degraded: true });
        const report = (await (await fetch(`${s.opsAddress}/readyz`)).json()) as { degraded: boolean; checks: { tokenDomains: unknown } };
        expect(report.degraded).toBe(true);
        expect(report.checks.tokenDomains).toMatchObject({ ok: false, mismatched: ['USDT0'] });
        expect(await (await fetch(`${s.opsAddress}/metrics`)).text()).toContain('relay_token_domain_mismatch{token="USDT0"} 1');

        const clock = new TestClock(Date.now());
        const post = async (options: Parameters<typeof buildTransfer>[1]) => {
            const t = await buildTransfer({ chain, clock }, options);
            const res = await fetch(`${s.address}/v1/transfer`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(t.body),
            });
            return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string } } };
        };
        for (const mode of ['permit', 'metaTxApprove'] as const) {
            const refused = await post({ token: USDT0, mode });
            expect(refused.status, mode).toBe(400);
            expect(refused.body.error?.code, mode).toBe('unsupported_auth_mode');
            expect(refused.body.error?.message, mode).toMatch(/USDT0 .*domain.*authorization mode "none"/);
        }
        expect((await post({ token: USDT0, mode: 'none' })).status).toBe(202);
        expect((await post({ token: USDC, mode: 'permit', key: OTHER_KEY })).status).toBe(202); // one pending request per sender
    }, 30_000);

    it('a GaslessTransfer domain mismatch still stops startServer', async () => {
        const chain = renamedChain(Math.floor(Date.now() / 1000));
        chain.contract.domainSeparator = `0x${'12'.repeat(32)}`;
        await expect(start(chain)).rejects.toThrow(/GaslessTransfer DOMAIN_SEPARATOR/);
    });

    it('on chain 137 a deployment file that contradicts the SDK pins (the new name) still stops startup', async () => {
        // A deployment file whose USDT0 domain carries the new name: on chain 137 the token must also equal
        // the SDK pin, which keeps the old name. The operator waits for an SDK release; meanwhile the relay
        // runs degraded on the unchanged file (test above).
        const json = deploymentJson() as { tokens: Array<{ symbol: string; domain: Record<string, unknown> }> };
        const usdt0 = json.tokens.find((t) => t.symbol === 'USDT0')!;
        usdt0.domain = { ...usdt0.domain, name: 'USDT0 renamed' };
        const renamedFile = parseDeployment(json);
        const chain = new FakeChain({ deployment: renamedFile, timestamp: START_TIME, relay: RELAY_ADDRESS });
        const error = await verifyDeployment(chain, renamedFile).then(
            () => undefined,
            (err: unknown) => err,
        );
        expect(error).toBeInstanceOf(StartupError);
        expect((error as Error).message).toMatch(/USDT0: domain or auth modes differ from the SDK pins/);
    });
});

describe('a deployment file without the renamed token', () => {
    it('a deployment file without USDT0 starts as well (and serves USDC only)', async () => {
        const json = deploymentJson() as { tokens: Array<{ symbol: string }> };
        json.tokens = json.tokens.filter((t) => t.symbol !== 'USDT0');
        const usdcOnly = parseDeployment(json);
        await expect(verifyDeployment(renamedChain(), usdcOnly)).resolves.toMatchObject({ tokenDomainMismatches: [] });
        expect(usdcOnly.tokens.map((t) => t.symbol)).toEqual(['USDC']);
    });
});
