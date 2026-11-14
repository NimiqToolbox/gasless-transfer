// A token rename against the real contracts and the mock USDT0 on anvil: the token admin renames USDT0
// (changeName replaces its EIP-712 domain separator) while the relay runs. At its next check the relay
// refuses USDT0 permit and meta-tx quotes and submissions with unsupported_auth_mode and a message that
// names the domain change (instead of quoting on and letting submissions end in a confusing
// simulation_failed), reports itself degraded but still ready, sets relay_token_domain_mismatch and logs
// an ALERT. USDC and USDT0 NONE mode keep working, and restoring the name clears the state.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { postRaw, signTransfer, startRelay, waitFor, type RunningRelay, type SignedTransfer } from './helpers/relay.js';
import { ADMIN_INDEX, anvilAccount, mockTokenAbi, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;

const admin = anvilAccount(ADMIN_INDEX);
const TO: Address = anvilAccount(13).address;
const WAIT = { timeoutMs: 30_000, pollIntervalMs: 100 } as const;

beforeAll(async () => {
    stack = await startStack();
    // Check the token domains every second (default 60 s).
    relay = await startRelay(stack, { env: { RELAY_TOKEN_DOMAIN_CHECK_SECONDS: '1' } });
});

afterAll(async () => {
    await relay?.stop();
    await stack?.stop();
});

/** 'ok' for a quote, else the error code. */
function quoteCode(token: Address, authMode: 'permit' | 'metaTxApprove' | 'none'): Promise<string> {
    return relay.client.fee({ token, authMode }).then(
        () => 'ok',
        (err: unknown) => (err as { code?: string }).code ?? String(err),
    );
}

async function relayed(t: SignedTransfer): Promise<string> {
    expect(await relay.client.submitTransfer(t.body)).toEqual({ id: t.id, status: 'queued' });
    return (await relay.client.waitForRequest(t.id, WAIT)).status;
}

describe('USDT0 renamed while the relay runs', () => {
    it('refuses USDT0 token signatures with a clear error, degrades readiness and alerts; USDC and NONE keep working; recovers', async () => {
        // Signed over the configured domain before the rename.
        const permit = await signTransfer(stack, relay, { from: 3, token: stack.usdt0, authMode: 'permit', to: TO, amount: 1_000_000n });
        const metaTx = await signTransfer(stack, relay, { from: 4, token: stack.usdt0, authMode: 'metaTxApprove', to: TO, amount: 1_000_000n });

        await stack.send(admin, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'changeName', args: ['USDT0 renamed'] });
        let restored = false;
        try {
            await waitFor('USDT0 permit quotes to be refused after the rename', async () =>
                (await quoteCode(stack.usdt0, 'permit')) === 'ok' ? undefined : true, 15_000, 200);
            expect(await quoteCode(stack.usdt0, 'permit')).toBe('unsupported_auth_mode');
            expect(await quoteCode(stack.usdt0, 'metaTxApprove')).toBe('unsupported_auth_mode');
            expect(await quoteCode(stack.usdt0, 'none')).toBe('ok');
            expect(await quoteCode(stack.usdc, 'permit')).toBe('ok');

            // Submissions with token signatures for the old domain: the same clear answer, nothing stored.
            for (const t of [permit, metaTx]) {
                const res = await postRaw(relay, t.body);
                expect(res.status).toBe(400);
                expect(res.json).toMatchObject({ error: { code: 'unsupported_auth_mode' } });
                expect((res.json as { error: { message: string } }).error.message).toMatch(/USDT0 .*\(DOMAIN_SEPARATOR\) changed on-chain/);
                expect(relay.server.store.getRequest(t.id)).toBeUndefined();
            }

            // Operators see it: ready but degraded, the gauge, and an ALERT line.
            const ops = relay.server.opsAddress!;
            const report = await fetch(`${ops}/readyz`);
            expect(report.status).toBe(200);
            expect(await report.json()).toMatchObject({ ready: true, degraded: true, checks: { tokenDomains: { ok: false, mismatched: ['USDT0'] } } });
            expect(await (await fetch(`${relay.url}/readyz`)).json()).toEqual({ ready: true, degraded: true });
            const metrics = await (await fetch(`${ops}/metrics`)).text();
            expect(metrics).toContain('relay_token_domain_mismatch{token="USDT0"} 1');
            expect(metrics).toContain('relay_token_domain_mismatch{token="USDC"} 0');
            expect(relay.logs.text()).toContain('ALERT: token DOMAIN_SEPARATOR() no longer matches the configured domain');

            // USDC and USDT0 NONE mode are relayed as usual.
            expect(await relayed(await signTransfer(stack, relay, { from: 5, token: stack.usdc, authMode: 'permit', to: TO, amount: 1_000_000n }))).toBe(
                'mined',
            );
            const none = await signTransfer(stack, relay, { from: 6, token: stack.usdt0, authMode: 'none', to: TO, amount: 1_000_000n });
            const value = BigInt(none.body.request.amount) + BigInt(none.body.request.fee);
            await stack.send(anvilAccount(6), { address: stack.usdt0, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, value] });
            expect(await relayed(none)).toBe('mined');

            // The name is restored: the relay notices, and the permit signed before the rename is valid again.
            await stack.send(admin, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'changeName', args: ['USDT0'] });
            restored = true;
            await waitFor('USDT0 permit quotes to work again', async () => ((await quoteCode(stack.usdt0, 'permit')) === 'ok' ? true : undefined), 15_000, 200);
            // Readiness follows once its cached report (RELAY_READINESS_CACHE_MS, 5 s) expires.
            await waitFor('readiness to clear the degraded state', async () => {
                const body = (await (await fetch(`${ops}/readyz`)).json()) as { degraded: boolean };
                return body.degraded ? undefined : true;
            }, 15_000, 250);
            expect(await (await fetch(`${relay.url}/readyz`)).json()).toEqual({ ready: true, degraded: false });
            expect(await (await fetch(`${ops}/metrics`)).text()).toContain('relay_token_domain_mismatch{token="USDT0"} 0');
            expect(await relayed(permit)).toBe('mined');
        } finally {
            if (!restored) await stack.send(admin, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'changeName', args: ['USDT0'] });
        }
    });
});
