// Smoke test of the compose stack (make stack-test): the relay image (docker/relay.Dockerfile) serving
// the deployment that the deploy service wrote, on the stack's anvil. The client pins come from the
// deployment file and the dev key's address, never from the relay itself.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, type Address, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { pinsFromDeployment, usdcAbi } from '@nimiq/gasless-sdk/core';
import { RelayClient } from '@nimiq/gasless-sdk/relay';
import { signTransfer } from '../integration/helpers/relay.js';
import { anvilAccount, mockTokenAbi } from '../integration/helpers/stack.js';

function env(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required (set by the stack-test service in compose.yaml)`);
    return value;
}

const relayUrl = env('STACK_RELAY_URL');

/** The relay's internal listener: the relay host on port 9464 (compose.yaml sets RELAY_OPS_HOST=0.0.0.0). */
function internalUrl(): string {
    if (process.env.STACK_RELAY_OPS_URL) return process.env.STACK_RELAY_OPS_URL;
    const url = new URL(relayUrl);
    url.port = '9464';
    return url.origin;
}
const opsUrl = internalUrl();
const deployment = JSON.parse(readFileSync(env('STACK_DEPLOYMENT_FILE'), 'utf8')) as Record<string, unknown> & {
    tokens: Array<{ symbol: string; address: Address }>;
};
const relayAddress = env('STACK_RELAY_ADDRESS') as Address;
const pins = pinsFromDeployment(deployment, { relays: [relayAddress] });
// The stack's relay listens on plain HTTP on the private compose network; the SDK refuses http:// for other hosts
// than localhost unless asked (allowInsecureHttp).
const client = new RelayClient(relayUrl, { pins, allowInsecureHttp: true });
const publicClient = createPublicClient({ chain: foundry, transport: http(env('STACK_RPC_URL')) }) as PublicClient;
const token = (symbol: string) => deployment.tokens.find((t) => t.symbol === symbol)!.address;
const balance = (t: Address, owner: Address) => publicClient.readContract({ address: t, abi: usdcAbi, functionName: 'balanceOf', args: [owner] });

describe('compose stack', () => {
    it('is live and ready, and exposes metrics on the internal listener only', async () => {
        expect(await (await fetch(`${relayUrl}/healthz`)).json()).toEqual({ status: 'ok' });
        const ready = await fetch(`${relayUrl}/readyz`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ ready: true, degraded: false });
        expect((await fetch(`${relayUrl}/metrics`)).status).toBe(404);
        const report = (await (await fetch(`${opsUrl}/readyz`)).json()) as { ready: boolean; checks: Record<string, unknown> };
        expect(report.ready).toBe(true);
        expect(Object.keys(report.checks).sort()).toEqual(['balance', 'priceSource', 'rpc', 'rpcHistory', 'tokenDomains', 'txManager']);
        expect(report.checks.rpcHistory).toMatchObject({ ok: true, failures: [] });
        const metrics = await (await fetch(`${opsUrl}/metrics`)).text();
        expect(metrics).toContain('relay_price_source{source="chainlink"} 1');
        expect(metrics).toContain('relay_rpc_history_unavailable{rpc="1"} 0');
        expect(metrics).toContain('relay_nodejs_version_info');
    });

    it('/v1/info matches the pins from the deployment file', async () => {
        const info = await client.info();
        expect(info.relay).toBe(relayAddress);
        expect(info.chainId).toBe(31_337);
    });

    it.each([
        ['USDC', 'permit'],
        ['USDC', 'none'],
        ['USDT0', 'permit'],
        ['USDT0', 'metaTxApprove'],
        ['USDT0', 'none'],
    ] as const)('%s with %s: fee → sign → submit → mined, exact balances', async (symbol, authMode) => {
        const t = token(symbol);
        const from = anvilAccount(9).address;
        const to = anvilAccount(19).address;
        if (authMode === 'none') {
            const wallet = createWalletClient({ account: anvilAccount(9), chain: foundry, transport: http(env('STACK_RPC_URL')) });
            const hash = await wallet.writeContract({ address: t, abi: mockTokenAbi, functionName: 'approve', args: [pins.transfer.address, 10n ** 18n] });
            await publicClient.waitForTransactionReceipt({ hash });
        }
        const before = await Promise.all([from, to, relayAddress].map((a) => balance(t, a)));
        const signed = await signTransfer({ publicClient }, { client, pins }, { from: 9, token: t, authMode, to, amount: 1_230_000n });
        expect(await client.submitTransfer(signed.body)).toEqual({ id: signed.id, status: 'queued' });
        const state = await client.waitForRequest(signed.id, { timeoutMs: 60_000, pollIntervalMs: 250 });
        expect(state.status).toBe('mined');
        const fee = BigInt(signed.body.request.fee);
        const amount = BigInt(signed.body.request.amount);
        expect(await Promise.all([from, to, relayAddress].map((a) => balance(t, a)))).toEqual([
            before[0]! - amount - fee,
            before[1]! + amount,
            before[2]! + fee,
        ]);
    });
});
