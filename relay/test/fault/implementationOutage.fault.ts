// Token implementation verification through two RPCs, anvil itself (RPC 1) and the fault-injecting proxy in front of
// it (RPC 2), with the production wiring (src/server.ts) and its default retry delays. An RPC that stays unavailable
// holds the token's quotes, submissions and broadcasts; a failure that passes within a check does not; matching
// reads on every RPC restore service, and the admitted request then settles once, with exact balances and contiguous
// relay nonces. An actual implementation change is held on every RPC at once. Diagnostics name the RPC by position,
// the stage and a classified reason, never a URL.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, pad, toHex, type Address, type Hex } from 'viem';
import type { TokenImplementationMonitor } from '../../src/ops/tokenImplementationMonitor.js';
import {
    RECIPIENT,
    callsPerRequest,
    keyOf,
    postRaw,
    relayNonces,
    relayTxsOnChain,
    signTransfer,
    startFaultEnv,
    submit,
    tick,
    type FaultEnv,
    type RpcProxy,
    type Stack,
} from './helpers/fault.js';
import { method } from './helpers/rpcProxy.js';

const EIP1967_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const IMPLEMENTATION: Address = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION_CODE: Hex = '0x60016000';
const OTHER_IMPLEMENTATION: Address = '0x2222222222222222222222222222222222222222';
const RATE_LIMITED = { error: { code: -32029, message: 'Too Many Requests' } };

let env: FaultEnv | undefined;
let pinsDir: string | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
    if (pinsDir) rmSync(pinsDir, { recursive: true, force: true });
    pinsDir = undefined;
});

/** Gives both mock tokens an EIP-1967 implementation slot and the implementation code, and writes their reviewed pins. */
async function installPins(stack: Stack, proxy: RpcProxy, file: string): Promise<void> {
    await proxy.upstreamCall('anvil_setCode', [IMPLEMENTATION, IMPLEMENTATION_CODE]);
    const tokens = [];
    for (const token of [stack.usdc, stack.usdt0]) {
        await proxy.upstreamCall('anvil_setStorageAt', [token, EIP1967_SLOT, pad(IMPLEMENTATION)]);
        const code = (await proxy.upstreamCall('eth_getCode', [token, 'latest'])) as Hex;
        tokens.push({
            address: token,
            proxyCodeHash: keccak256(code),
            implementationSlot: EIP1967_SLOT,
            implementationAddress: IMPLEMENTATION,
            implementationCodeHash: keccak256(IMPLEMENTATION_CODE),
        });
    }
    const head = (await proxy.upstreamCall('eth_blockNumber')) as Hex;
    writeFileSync(file, JSON.stringify({ chainId: stack.deployment.chainId, reviewedBlock: BigInt(head).toString(), tokens }));
}

async function start(extraEnv: Record<string, string> = {}): Promise<{ e: FaultEnv; monitor: TokenImplementationMonitor }> {
    pinsDir = mkdtempSync(join(tmpdir(), 'token-pins-'));
    const file = join(pinsDir, 'token-pins.json');
    const e = await startFaultEnv({
        rpcUrls: (proxyUrl, anvilUrl) => `${anvilUrl},${proxyUrl}`,
        env: { RELAY_TOKEN_PINS_FILE: file, RELAY_READINESS_CACHE_MS: '0', ...extraEnv },
        beforeRelay: (stack, proxy) => installPins(stack, proxy, file),
    });
    env = e;
    const monitor = e.relay.server.relay.tokenImplementations!;
    // The test drives every check.
    await monitor.stop();
    expect(monitor.status().ok).toBe(true);
    return { e, monitor };
}

type Entry = Record<string, unknown> & { msg?: string; alert?: string; failures?: unknown };
const entries = (e: FaultEnv): Entry[] => e.relay.logs.lines.map((line) => JSON.parse(line) as Entry);
const alertsAfter = (e: FaultEnv, from: number): Entry[] => entries(e).slice(from).filter((entry) => entry.alert === 'token_implementation_unavailable');

async function feeStatus(e: FaultEnv, token: Address, authMode: string): Promise<number> {
    return (await fetch(`${e.relay.url}/v1/fee?operation=transfer&token=${token}&authMode=${authMode}`)).status;
}

async function ready(e: FaultEnv): Promise<boolean> {
    const res = await fetch(`${e.relay.server.opsAddress}/readyz`);
    return ((await res.json()) as { ready: boolean }).ready;
}

/** No URL of either RPC in any log line. */
function expectNoUrls(e: FaultEnv): void {
    const text = e.relay.logs.text();
    expect(text).not.toContain(e.proxy.url.replace('http://', ''));
    expect(text).not.toContain(e.stack.rpcUrl.replace('http://', ''));
}

/** Ticks and mines until the request is mined; returns its status history's last value. */
async function settle(e: FaultEnv, id: Hex): Promise<void> {
    for (let i = 0; i < 10; i++) {
        expect(await tick(e.relay)).toBeUndefined();
        const { status } = await e.relay.state(id);
        if (status === 'mined' || status === 'confirmed') return;
        await e.stack.mine();
    }
    throw new Error(`${id} did not settle`);
}

async function balances(e: FaultEnv, token: Address, from: Address): Promise<[bigint, bigint, bigint]> {
    return Promise.all([e.stack.balanceOf(token, from), e.stack.balanceOf(token, RECIPIENT), e.stack.balanceOf(token, e.relay.address)]);
}

describe('token implementation verification with an unreliable second RPC', () => {
    it('absorbs a passing failure, holds everything while RPC 2 stays rate-limited and settles once after it recovers', async () => {
        const { e, monitor } = await start({ RELAY_RPC_USAGE_LOG_SECONDS: '1' });
        const { stack, proxy, relay } = e;

        // A single rate-limited read passes within the check.
        let mark = relay.logs.lines.length;
        proxy.add({ name: 'blip', match: method('eth_getStorageAt'), before: () => ({ kind: 'answer', answer: RATE_LIMITED }), times: 1 });
        await monitor.check();
        expect(monitor.status().ok).toBe(true);
        expect(alertsAfter(e, mark)).toHaveLength(0);
        expect(await relay.server.relay.metrics.registry.metrics()).toContain('relay_token_implementation_check_failures_total{rpc="2",stage="implementation_slot",reason="rate_limited"} 1');

        const t1 = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        const t2 = await signTransfer(stack, relay, { from: 2, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        const from = t1.body.request.from as Address;
        const before = await balances(e, stack.usdc, from);
        const nonces0 = await relayNonces(stack, relay.address);
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        await submit(relay, t1);

        // RPC 2 stays rate-limited: nothing is broadcast, quotes and submissions are refused, the relay is unready.
        mark = relay.logs.lines.length;
        proxy.add({ name: 'outage', match: method('eth_getStorageAt'), before: () => ({ kind: 'answer', answer: RATE_LIMITED }) });
        expect(await tick(relay)).toBeUndefined();
        expect((await relay.state(t1.id)).status).toBe('queued');
        expect(proxy.count('eth_sendRawTransaction')).toBe(0);
        expect(await relayNonces(stack, relay.address)).toEqual(nonces0);
        expect(monitor.tokenUnavailable(stack.usdc)).toBeDefined();
        // USDC has no meta-transaction approve.
        for (const mode of ['permit', 'none']) expect(await feeStatus(e, stack.usdc, mode)).toBe(503);
        const refused = await postRaw(relay, t2.body);
        expect(refused.status).toBe(503);
        expect((refused.json as { error: { code: string } }).error.code).toBe('unavailable');
        expect(await ready(e)).toBe(false);
        expect(alertsAfter(e, mark)[0]!.failures).toEqual([
            { rpc: 2, stage: 'implementation_slot', category: 'transport', reason: 'rate_limited', rpcCode: -32029, attempts: 3 },
        ]);

        // The periodic usage line shows the failures by RPC position.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        const usage = entries(e).filter((entry) => entry.msg === 'rpc usage').at(-1) as { rpcs: Array<{ rpc: number; failures: Record<string, number> }> };
        expect(usage.rpcs.map((r) => r.rpc)).toEqual([1, 2]);

        // Matching reads on every RPC restore service; the admitted request settles once.
        proxy.remove('outage');
        await monitor.check();
        expect(monitor.status().ok).toBe(true);
        expect(entries(e).some((entry) => entry.msg === 'token implementation matches the reviewed pins again')).toBe(true);
        expect(await ready(e)).toBe(true);
        await settle(e, t1.id);
        const txs = await relayTxsOnChain(stack, relay.address, block0 + 1n);
        expect(callsPerRequest(txs).get(keyOf(t1))).toEqual(['success']);
        expect(txs.map((t) => t.nonce)).toEqual([nonces0.latest]);
        const fee = BigInt(t1.body.request.fee);
        expect(await balances(e, stack.usdc, from)).toEqual([before[0] - 1_000_000n - fee, before[1] + 1_000_000n, before[2] + fee]);
        expect(entries(e).filter((entry) => entry.msg === 'rpc usage').some((entry) =>
            (entry as { rpcs: Array<{ rpc: number; failures: Record<string, number> }> }).rpcs[1]!.failures.rate_limited! > 0)).toBe(true);
        expectNoUrls(e);
    });

    it('holds every mode on an actual implementation change, on both RPCs without retries, until the reviewed values return', async () => {
        const { e, monitor } = await start();
        const { stack, proxy, relay } = e;
        const t1 = await signTransfer(stack, relay, { from: 3, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 2_000_000n });
        const from = t1.body.request.from as Address;
        const before = await balances(e, stack.usdt0, from);
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        await submit(relay, t1);

        // The issuer points USDT0 at another implementation.
        let mark = relay.logs.lines.length;
        await proxy.upstreamCall('anvil_setStorageAt', [stack.usdt0, EIP1967_SLOT, pad(OTHER_IMPLEMENTATION)]);
        await stack.mine();
        expect(await tick(relay)).toBeUndefined();
        expect((await relay.state(t1.id)).status).toBe('queued');
        expect(proxy.count('eth_sendRawTransaction')).toBe(0);
        expect(alertsAfter(e, mark)[0]!.failures).toEqual([
            { rpc: 1, stage: 'implementation_slot', category: 'pins', reason: 'mismatch', attempts: 1 },
            { rpc: 2, stage: 'implementation_slot', category: 'pins', reason: 'mismatch', attempts: 1 },
        ]);
        for (const mode of ['permit', 'metaTxApprove', 'none']) expect(await feeStatus(e, stack.usdt0, mode)).toBe(503);
        await monitor.check();
        expect(monitor.status().unavailable).toEqual([stack.usdt0]);
        expect(await feeStatus(e, stack.usdc, 'permit')).toBe(200);

        // Upgraded code at the pinned implementation address holds both tokens.
        await proxy.upstreamCall('anvil_setStorageAt', [stack.usdt0, EIP1967_SLOT, pad(IMPLEMENTATION)]);
        mark = relay.logs.lines.length;
        await proxy.upstreamCall('anvil_setCode', [IMPLEMENTATION, '0x60026000']);
        await stack.mine();
        await monitor.check();
        expect(monitor.status().unavailable).toEqual([stack.usdc, stack.usdt0]);
        const codeAlerts = alertsAfter(e, mark).map((entry) => entry.failures);
        expect(codeAlerts).toContainEqual([
            { rpc: 1, stage: 'implementation_code', category: 'pins', reason: 'mismatch', attempts: 1 },
            { rpc: 2, stage: 'implementation_code', category: 'pins', reason: 'mismatch', attempts: 1 },
        ]);

        // Only the reviewed values restore service.
        await proxy.upstreamCall('anvil_setCode', [IMPLEMENTATION, IMPLEMENTATION_CODE]);
        await stack.mine();
        await monitor.check();
        expect(monitor.status().ok).toBe(true);
        await settle(e, t1.id);
        const txs = await relayTxsOnChain(stack, relay.address, block0 + 1n);
        expect(callsPerRequest(txs).get(keyOf(t1))).toEqual(['success']);
        const fee = BigInt(t1.body.request.fee);
        expect(await balances(e, stack.usdt0, from)).toEqual([before[0] - 2_000_000n - fee, before[1] + 2_000_000n, before[2] + fee]);
        expectNoUrls(e);
    });

    it('classifies a lagging head, another chain, a timeout and an HTTP rate limit on RPC 2', async () => {
        const { e, monitor } = await start();
        const { stack, proxy, relay } = e;
        const failuresOf = async (): Promise<unknown> => {
            const mark = relay.logs.lines.length;
            expect(await monitor.checkToken(stack.usdc)).toBe(false);
            const failures = alertsAfter(e, mark)[0]?.failures;
            proxy.clear();
            expect(await monitor.checkToken(stack.usdc)).toBe(true);
            return failures;
        };

        // RPC 2 reports a head below the last verified one: retried, then held.
        const floor = BigInt((await proxy.upstreamCall('eth_blockNumber')) as Hex);
        proxy.add({
            name: 'lagging',
            match: method('eth_getBlockByNumber', (params) => params[0] === 'latest'),
            before: async () => ({ kind: 'answer', answer: { result: await proxy.upstreamCall('eth_getBlockByNumber', [toHex(floor - 1n), false]) } }),
        });
        expect(await failuresOf()).toEqual([{ rpc: 2, stage: 'head', category: 'chain', reason: 'head_behind', attempts: 3 }]);

        proxy.add({ name: 'chain', match: method('eth_chainId'), before: () => ({ kind: 'answer', answer: { result: '0x89' } }) });
        expect(await failuresOf()).toEqual([{ rpc: 2, stage: 'chain_id', category: 'chain', reason: 'chain_mismatch', attempts: 1 }]);

        proxy.add({ name: 'hang', match: method('eth_getCode'), before: () => ({ kind: 'hang' }) });
        expect(await failuresOf()).toEqual([expect.objectContaining({ rpc: 2, category: 'transport', reason: 'timeout' })]);

        proxy.add({ name: 'http429', match: method('eth_getStorageAt'), before: () => ({ kind: 'http', status: 429 }) });
        expect(await failuresOf()).toEqual([{ rpc: 2, stage: 'implementation_slot', category: 'transport', reason: 'rate_limited', httpStatus: 429, attempts: 3 }]);
        expectNoUrls(e);
    });
});
