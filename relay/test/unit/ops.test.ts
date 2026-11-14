// Token-domain monitoring, admission, quotes, readiness and metrics.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transferOperation } from '../../src/operations/transfer.js';
import { buildTransfer, CONTRACT, createHarness, USDC, USDT0, type Harness } from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY } from '../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
});

afterEach(async () => {
    await h.close();
});

const RENAMED = `0x${'ab'.repeat(32)}` as const;

async function submitCode(body: unknown): Promise<string> {
    try {
        const result = await h.relay.pipeline.submit(transferOperation, body);
        return String(result.statusCode);
    } catch (err) {
        return (err as { code: string }).code;
    }
}

describe('token domain monitor', () => {
    it('refuses permit and meta-tx of a token whose DOMAIN_SEPARATOR() changed, keeps NONE mode, and recovers', async () => {
        const original = h.chain.token(USDT0).domainSeparator;
        await h.relay.tokenDomains.check();
        expect(h.relay.tokenDomains.status()).toMatchObject({ ok: true, mismatched: [] });

        // The USDT0 admin renames the token while the relay runs.
        h.chain.token(USDT0).domainSeparator = RENAMED;
        await h.relay.tokenDomains.check();
        expect(h.relay.tokenDomains.status()).toMatchObject({ ok: false, mismatched: ['USDT0'] });

        // Pipeline: permit and meta-tx for USDT0 are refused before any RPC call, with a clear message.
        const reads = h.chain.reads.length;
        const refused = await h.relay.pipeline
            .submit(transferOperation, (await buildTransfer(h, { token: USDT0, mode: 'permit' })).body)
            .catch((e: unknown) => e as { code: string; message: string });
        expect(refused).toMatchObject({ code: 'unsupported_auth_mode' });
        expect((refused as { message: string }).message).toMatch(/USDT0 .*domain.*authorization mode "none"/);
        expect(h.chain.reads.length).toBe(reads);
        expect(await submitCode((await buildTransfer(h, { token: USDT0, mode: 'metaTxApprove' })).body)).toBe('unsupported_auth_mode');
        // Other tokens and NONE mode are not affected. (The NONE request comes from another sender: the relay
        // accepts one request per sender at a time, so the sender of the pending USDC permit would get sender_busy.)
        expect(await submitCode((await buildTransfer(h, { token: USDC, mode: 'permit' })).body)).toBe('202');
        h.chain.setBalance(USDT0, OTHER_ADDRESS, 100_000_000n);
        h.chain.setAllowance(USDT0, OTHER_ADDRESS, CONTRACT, 10n ** 12n);
        expect(await submitCode((await buildTransfer(h, { token: USDT0, mode: 'none', key: OTHER_KEY })).body)).toBe('202');

        // Quotes: the same answer for token-signature modes; NONE is quoted.
        const quote = (mode: string) =>
            h.relay.app.inject({ method: 'GET', url: `/v1/fee?operation=transfer&token=${USDT0}&authMode=${mode}` });
        for (const mode of ['permit', 'metaTxApprove']) {
            const res = await quote(mode);
            expect(res.statusCode).toBe(400);
            expect((res.json() as { error: { code: string } }).error.code).toBe('unsupported_auth_mode');
        }
        expect((await quote('none')).statusCode).toBe(200);

        // Alert: metric and an ALERT log line; readiness reports the relay as degraded.
        expect(await h.metrics.registry.metrics()).toContain('relay_token_domain_mismatch{token="USDT0"} 1');
        expect(h.logs.text()).toContain('ALERT: token DOMAIN_SEPARATOR() no longer matches the configured domain');
        const ready = await h.relay.readiness();
        expect(ready).toMatchObject({ ready: true, degraded: true });

        // The name is restored: permits are accepted again.
        h.chain.token(USDT0).domainSeparator = original;
        await h.relay.tokenDomains.check();
        expect(h.relay.tokenDomains.status().ok).toBe(true);
        expect(await h.metrics.registry.metrics()).toContain('relay_token_domain_mismatch{token="USDT0"} 0');
        // (From another sender: the USDC permit above is pending, one request per sender.)
        expect(await submitCode((await buildTransfer(h, { token: USDT0, mode: 'permit', sender: 1 })).body)).toBe('202');
        expect(h.logs.text()).toContain('token DOMAIN_SEPARATOR() matches the configured domain again');
    });

    it('keeps the last state when the read fails, and counts the failure', async () => {
        h.chain.token(USDT0).domainSeparator = RENAMED;
        await h.relay.tokenDomains.check();
        h.chain.failing.add('read:DOMAIN_SEPARATOR');
        await h.relay.tokenDomains.check();
        expect(h.relay.tokenDomains.status()).toMatchObject({ ok: false, mismatched: ['USDT0'] });
        expect(h.relay.tokenDomains.status().lastError).toContain('fake RPC unavailable');
        expect(await h.metrics.registry.metrics()).toMatch(/relay_monitor_errors_total\{monitor="token_domain"\} 2/);
        expect(h.logs.text()).toContain('token DOMAIN_SEPARATOR() check failed; keeping the last state');
    });

    it('repeats the ALERT line every 5 minutes while the mismatch lasts, on the monotonic clock: a backward step of the system clock does not silence it (control: not before 5 minutes)', async () => {
        h.chain.token(USDT0).domainSeparator = RENAMED;
        const alerts = () => h.logs.lines.filter((l) => l.includes('ALERT: token DOMAIN_SEPARATOR() no longer matches')).length;
        await h.relay.tokenDomains.check();
        expect(alerts()).toBe(1);
        h.clock.advance(-3600); // the system clock steps back one hour
        h.clock.advance(299);
        await h.relay.tokenDomains.check();
        expect(alerts()).toBe(1);
        h.clock.advance(2);
        await h.relay.tokenDomains.check();
        expect(alerts()).toBe(2);
    });

    it('checks periodically once started, and stops', async () => {
        h.relay.tokenDomains.start(20);
        h.chain.token(USDT0).domainSeparator = RENAMED;
        const until = Date.now() + 5000;
        while (h.relay.tokenDomains.status().ok && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(h.relay.tokenDomains.status().mismatched).toEqual(['USDT0']);
        await h.relay.tokenDomains.stop();
    });
});
