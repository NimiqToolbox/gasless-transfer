// The alert monitor: readiness and error counters become one message per check with every transition, posted to the
// operator's webhook and logged with `condition` and `alertState`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'viem';
import type { ReadinessReport } from '../../src/http/readiness.js';
import { createMetrics } from '../../src/metrics.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { ALERT_CHECK_MS, ALERT_OUTBOX_MAX, ALERT_REMIND_MS, AlertMonitor, webhookSender, type AlertSend } from '../../src/ops/alertMonitor.js';
import { txMetrics } from '../../src/tx/txMetrics.js';
import { buildTransfer, captureLogger, createHarness, TestClock, type Harness } from '../helpers/harness.js';
import { RELAY_ADDRESS } from '../helpers/keys.js';

const MIN = parseEther('0.25');
const WARN = parseEther('0.5');

/** What the fake readiness report says; `wei` undefined = the balance could not be read. */
interface FakeState {
    wei: bigint | undefined;
    rpcError?: string | undefined;
    priceOk: boolean;
    reasons: string[];
    degraded: string[];
    tokenDomainMismatch?: string[] | undefined;
}

function fakeReadiness(s: FakeState): () => Promise<ReadinessReport> {
    return async () => {
        const balance =
            s.wei === undefined
                ? { ok: false, minimumWei: MIN.toString(), error: s.rpcError ?? 'read failed' }
                : { ok: s.wei >= MIN, wei: s.wei.toString(), minimumWei: MIN.toString() };
        const rpc = s.rpcError === undefined ? { ok: true, chainId: 137, blockNumber: '1' } : { ok: false, error: s.rpcError };
        const priceSource = s.priceOk
            ? { ok: true, source: 'chainlink' as const, polUsd: '0.2', reason: null, feed: null }
            : { ok: false, reason: 'the round is stale', feed: null };
        const txManager = { ok: s.reasons.length === 0, recovered: true, lastTickAtMs: 0, lastTickError: null, reasons: s.reasons, degraded: s.degraded };
        const tokenDomains = s.tokenDomainMismatch ? { ok: false, mismatched: s.tokenDomainMismatch, lastCheckAtMs: 0, lastError: null } : undefined;
        return {
            ready: rpc.ok && balance.ok && priceSource.ok && txManager.ok,
            degraded: s.degraded.length > 0 || tokenDomains !== undefined,
            checks: { rpc, balance, priceSource, txManager, ...(tokenDomains ? { tokenDomains } : {}) },
        };
    };
}

function setup(options: { send?: AlertSend | null } = {}) {
    const clock = new TestClock(1_800_000_000_000);
    const logs = captureLogger();
    const metrics = createMetrics();
    const txm = txMetrics(metrics.registry);
    const state: FakeState = { wei: parseEther('10'), priceOk: true, reasons: [], degraded: [] };
    const posts: string[] = [];
    const send: AlertSend | undefined =
        options.send === null
            ? undefined
            : (options.send ??
              (async (text) => {
                  posts.push(text);
              }));
    const monitor = new AlertMonitor({
        readiness: fakeReadiness(state),
        metrics,
        clock,
        logger: logs.logger,
        chainId: 137,
        relay: RELAY_ADDRESS,
        minBalanceWei: MIN,
        warnBalanceWei: WARN,
        send,
    });
    /** One check, then a minute passes (ALERT_CHECK_MS). */
    const tick = async (n = 1): Promise<void> => {
        for (let i = 0; i < n; i++) {
            await monitor.check();
            clock.advance(60);
        }
    };
    const transitions = () =>
        logs.lines
            .map((l) => JSON.parse(l) as { level: string; condition?: string; alertState?: string; msg: string })
            .filter((l) => l.alertState !== undefined);
    return { clock, logs, metrics, txm, state, posts, monitor, tick, transitions };
}

describe('alert monitor', () => {
    it('stays quiet while the relay is healthy', async () => {
        const t = setup();
        await t.tick(5);
        expect(t.posts).toEqual([]);
        expect(t.transitions()).toEqual([]);
    });

    it('warns of a low balance after two checks, once, and resolves after two clear checks', async () => {
        const t = setup();
        t.state.wei = parseEther('0.4');
        await t.tick();
        expect(t.posts).toEqual([]);
        await t.tick();
        expect(t.posts).toHaveLength(1);
        expect(t.posts[0]).toMatch(/^Polygon relay 0x\w{4}…\w{4}\nWARNING pol_low: balance 0\.4 POL is below the warning level 0\.5 POL; top up soon$/);
        expect(t.posts[0]).not.toContain(RELAY_ADDRESS);
        await t.tick(3);
        expect(t.posts).toHaveLength(1);

        t.state.wei = parseEther('1');
        await t.tick();
        expect(t.posts).toHaveLength(1);
        await t.tick();
        expect(t.posts).toHaveLength(2);
        expect(t.posts[1]).toContain('RESOLVED pol_low: balance 0.4 POL is below the warning level');
        expect(t.transitions().map((l) => [l.condition, l.alertState, l.level])).toEqual([
            ['pol_low', 'firing', 'warn'],
            ['pol_low', 'resolved', 'warn'],
        ]);
    });

    it('raises pol_empty below the readiness minimum, without a separate not-ready alert', async () => {
        const t = setup();
        t.state.wei = parseEther('0.1');
        await t.tick(2);
        expect(t.posts).toEqual([expect.stringContaining('CRITICAL pol_empty: balance 0.1 POL is below the readiness minimum 0.25 POL; top up now')]);
        expect(t.posts[0]).not.toContain('not_ready');
        expect(t.transitions()).toEqual([expect.objectContaining({ condition: 'pol_empty', alertState: 'firing', level: 'error' })]);
    });

    it('raises pol_empty when the relay cannot pay for gas above the minimum, not as not_ready:tx', async () => {
        const t = setup();
        t.state.reasons = ['insufficient_funds: the relay account cannot pay for its transactions'];
        await t.tick(2);
        expect(t.posts).toEqual([expect.stringContaining('CRITICAL pol_empty: the relay cannot pay for gas (balance 10 POL)')]);
        expect(t.posts[0]).not.toContain('not_ready');
    });

    it('keeps the balance state while the balance cannot be read, and reports the RPC', async () => {
        const t = setup();
        t.state.wei = parseEther('0.4');
        await t.tick(2);
        t.state.wei = undefined;
        t.state.rpcError = 'the request timed out';
        await t.tick(4);
        expect(t.posts).toHaveLength(2);
        expect(t.posts[1]).toContain('CRITICAL not_ready:rpc: RPC unavailable: the request timed out');
        expect(t.posts.join('\n')).not.toContain('RESOLVED pol_low');
    });

    it('does not report pol_low resolved while the balance falls below the minimum; both resolve after a top-up', async () => {
        const t = setup();
        t.state.wei = parseEther('0.4');
        await t.tick(2);
        t.state.wei = parseEther('0.1');
        await t.tick(4);
        expect(t.posts).toHaveLength(2);
        expect(t.posts[1]).toContain('CRITICAL pol_empty');
        expect(t.posts.join('\n')).not.toContain('RESOLVED');

        t.state.wei = parseEther('1');
        await t.tick(2);
        expect(t.posts).toHaveLength(3);
        expect(t.posts[2]).toContain('RESOLVED pol_empty');
        expect(t.posts[2]).toContain('RESOLVED pol_low');
    });

    it('fires a condition only after two checks in a row that see it, not across checks that cannot judge it', async () => {
        const t = setup();
        for (const wei of [parseEther('0.4'), undefined, parseEther('0.4'), undefined]) {
            t.state.wei = wei;
            t.state.rpcError = wei === undefined ? 'the request timed out' : undefined;
            await t.tick();
        }
        expect(t.transitions().filter((l) => l.condition === 'pol_low')).toEqual([]);
    });

    it('reports a failing readiness read and keeps the other conditions as they are', async () => {
        let fail = false;
        const t = setup();
        const healthy = fakeReadiness(t.state);
        const posts: string[] = [];
        const monitor = new AlertMonitor({
            readiness: async () => {
                if (fail) throw new Error('the report could not be produced');
                return healthy();
            },
            metrics: t.metrics,
            clock: t.clock,
            logger: t.logs.logger,
            chainId: 137,
            relay: RELAY_ADDRESS,
            minBalanceWei: MIN,
            warnBalanceWei: WARN,
            send: async (text) => {
                posts.push(text);
            },
        });
        const tick = async (n: number): Promise<void> => {
            for (let i = 0; i < n; i++) {
                await monitor.check();
                t.clock.advance(60);
            }
        };
        t.state.wei = parseEther('0.4');
        await tick(2);
        fail = true;
        await tick(4);
        expect(posts).toHaveLength(2);
        expect(posts[1]).toContain('CRITICAL not_ready:readiness: the readiness check failed: the report could not be produced');
        expect(posts.join('\n')).not.toContain('RESOLVED pol_low');
    });

    it('posts one message for every transition of a check: not ready, degraded, token domain', async () => {
        const t = setup();
        t.state.reasons = ['nonce_gap: the chain nonce 7 is below the lowest in-flight relay nonce 9 for 20 blocks'];
        t.state.degraded = ['held_at_cap: 2 request(s) wait because gas prices are above what their fees cover (spend cap)'];
        t.state.tokenDomainMismatch = ['USDT0'];
        t.state.priceOk = false;
        await t.tick(2);
        expect(t.posts).toHaveLength(1);
        const lines = t.posts[0]!.split('\n').slice(1);
        expect(lines).toEqual([
            'CRITICAL not_ready:price: no usable POL/USD price: the round is stale',
            'CRITICAL not_ready:tx:nonce_gap: the chain nonce 7 is below the lowest in-flight relay nonce 9 for 20 blocks',
            'WARNING degraded:tx:held_at_cap: 2 request(s) wait because gas prices are above what their fees cover (spend cap)',
            'WARNING degraded:token_domain: the EIP-712 domain of USDT0 changed on-chain; its permit and meta-tx requests are refused',
        ]);
    });

    it('ignores a condition that does not hold for two checks in a row', async () => {
        const t = setup();
        for (let i = 0; i < 5; i++) {
            t.state.wei = i % 2 === 0 ? parseEther('0.4') : parseEther('1');
            await t.tick();
        }
        expect(t.posts).toEqual([]);
    });

    it('raises transfers_failing on on-chain reverts and expiries in the window, not on failed requests', async () => {
        const t = setup();
        await t.tick();
        t.metrics.requestStatus.inc({ operation: 'transfer', status: 'failed' }, 10);
        await t.tick(3);
        expect(t.posts).toEqual([]);

        t.txm.revertedOnChain.inc({ operation: 'transfer' }, 2);
        t.metrics.requestStatus.inc({ operation: 'transfer', status: 'expired' });
        await t.tick(2);
        expect(t.posts).toEqual([expect.stringContaining('CRITICAL transfers_failing: 3 on-chain reverts of relay calls or request expiries in the last 15 min')]);
        // The failures leave the 15-minute window.
        await t.tick(16);
        expect(t.posts).toHaveLength(2);
        expect(t.posts[1]).toContain('RESOLVED transfers_failing');
    });

    it('raises http_5xx on server errors of the API, not on readiness probes', async () => {
        const t = setup();
        await t.tick();
        t.metrics.httpRequests.inc({ method: 'GET', route: '/readyz', status_code: '503', error_code: '' }, 100);
        await t.tick(2);
        expect(t.posts).toEqual([]);

        t.metrics.httpRequests.inc({ method: 'POST', route: '/v1/transfer', status_code: '503', error_code: 'unavailable' }, 8);
        t.metrics.httpRequests.inc({ method: 'POST', route: '/v1/transfer', status_code: '500', error_code: 'internal_error' }, 2);
        t.metrics.httpRequests.inc({ method: 'POST', route: '/v1/transfer', status_code: '400', error_code: 'invalid_request' }, 50);
        await t.tick(2);
        expect(t.posts).toEqual([expect.stringContaining('WARNING http_5xx: 10 HTTP 5xx answers in the last 5 min (unavailable 8, internal_error 2)')]);
    });

    it('reminds of a condition that is still firing after ALERT_REMIND_MS, and not before', async () => {
        const t = setup();
        t.state.wei = parseEther('0.4');
        await t.tick(2);
        const minutes = ALERT_REMIND_MS / 60_000;
        await t.tick(minutes - 1);
        expect(t.posts).toHaveLength(1);
        await t.tick();
        expect(t.posts).toHaveLength(2);
        expect(t.posts[1]).toContain('STILL WARNING pol_low');
        expect(t.transitions().at(-1)).toMatchObject({ condition: 'pol_low', alertState: 'reminder' });
    });

    it('retries undelivered messages in order at the next check and bounds the outbox', async () => {
        let up = false;
        const delivered: string[] = [];
        const t = setup({
            send: async (text) => {
                if (!up) throw new Error('the alert webhook answered HTTP 502');
                delivered.push(text);
            },
        });
        // Every 4 checks one firing and one resolved message: 2 × (ALERT_OUTBOX_MAX / 2 + 1) messages in all.
        for (let i = 0; i < ALERT_OUTBOX_MAX / 2 + 1; i++) {
            t.state.wei = parseEther('0.4');
            await t.tick(2);
            t.state.wei = parseEther('1');
            await t.tick(2);
        }
        expect(delivered).toEqual([]);
        expect(t.logs.text()).toContain('alert delivery failed; retrying at the next check');
        expect(t.logs.text()).toContain('alert outbox full; dropped the oldest undelivered message');

        up = true;
        await t.tick();
        expect(delivered).toHaveLength(ALERT_OUTBOX_MAX);
        // The two oldest were dropped: the first one kept is a firing message, the last one a resolution.
        expect(delivered[0]).toContain('WARNING pol_low');
        expect(delivered.at(-1)).toContain('RESOLVED pol_low');
    });

    it('stops delivering after the message in flight when stopped, so shutdown is not held up', async () => {
        let up = false;
        let sending = false;
        let release = (): void => {};
        const slow = new Promise<void>((resolve) => {
            release = resolve;
        });
        const delivered: string[] = [];
        const t = setup({
            send: async (text) => {
                if (!up) throw new Error('the alert webhook answered HTTP 502');
                sending = true;
                await slow;
                delivered.push(text);
            },
        });
        // Six undelivered messages: a firing and a resolved one per round.
        for (let i = 0; i < 3; i++) {
            t.state.wei = parseEther('0.4');
            await t.tick(2);
            t.state.wei = parseEther('1');
            await t.tick(2);
        }
        up = true;
        const checking = t.monitor.check();
        await vi.waitFor(() => expect(sending).toBe(true));
        const stopped = t.monitor.stop();
        release();
        await stopped;
        await checking;
        expect(delivered).toHaveLength(1);
    });

    it('checks first one interval after start, then every interval, until stopped', async () => {
        vi.useFakeTimers();
        try {
            let reads = 0;
            const t = setup();
            const monitor = new AlertMonitor({
                readiness: async () => {
                    reads += 1;
                    return fakeReadiness(t.state)();
                },
                metrics: t.metrics,
                clock: t.clock,
                logger: t.logs.logger,
                chainId: 137,
                relay: RELAY_ADDRESS,
                minBalanceWei: MIN,
                warnBalanceWei: WARN,
            });
            monitor.start();
            await vi.advanceTimersByTimeAsync(ALERT_CHECK_MS - 1);
            expect(reads).toBe(0);
            await vi.advanceTimersByTimeAsync(1);
            expect(reads).toBe(1);
            await vi.advanceTimersByTimeAsync(ALERT_CHECK_MS);
            expect(reads).toBe(2);
            await monitor.stop();
            await vi.advanceTimersByTimeAsync(3 * ALERT_CHECK_MS);
            expect(reads).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('only logs when no webhook is configured', async () => {
        const t = setup({ send: null });
        t.state.wei = parseEther('0.1');
        await t.tick(2);
        expect(t.transitions()).toEqual([expect.objectContaining({ condition: 'pol_empty', msg: expect.stringMatching(/^ALERT: balance 0\.1 POL/) })]);
    });
});

describe('webhookSender', () => {
    const url = 'https://hooks.example/services/FAKE_TOKEN';

    it('posts {"text": …} as JSON without following redirects', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const send = webhookSender(url, async (input, init) => {
            calls.push({ url: String(input), init: init! });
            return new Response('ok', { status: 200 });
        });
        await send('hello');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(url);
        expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' } });
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'hello' });
        expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('rejects when the request fails, so that the message is kept for the next check', async () => {
        const send = webhookSender(url, async () => {
            throw new TypeError('fetch failed');
        });
        await expect(send('hello')).rejects.toThrow('fetch failed');
    });

    it('rejects on a non-2xx answer with the status only, never the URL', async () => {
        const send = webhookSender(url, async () => new Response('no', { status: 404 }));
        const failure = await send('hello').catch((err: unknown) => err as Error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('the alert webhook answered HTTP 404');
        expect((failure as Error).message).not.toContain('FAKE_TOKEN');
    });
});

describe('alert monitor on a relay', () => {
    let h: Harness | undefined;
    afterEach(async () => {
        await h?.close();
        h = undefined;
    });

    /** Two checks, past the readiness cache (5 s) each. */
    async function checkTwice(x: Harness, between?: () => Promise<void>): Promise<void> {
        await x.relay.alerts.check();
        x.clock.advance(6);
        await between?.();
        await x.relay.alerts.check();
    }

    const transitions = (x: Harness) =>
        x.logs.lines.map((l) => JSON.parse(l) as { condition?: string; alertState?: string }).filter((l) => l.alertState !== undefined);

    it('reads the balance and the RPC from the readiness report', async () => {
        // The harness minimum is 1 POL, so the default warning level is 2 POL.
        h = await createHarness();
        h.chain.nativeBalances.set(RELAY_ADDRESS.toLowerCase(), parseEther('1.5'));
        await checkTwice(h);
        expect(transitions(h)).toEqual([expect.objectContaining({ condition: 'pol_low', alertState: 'firing' })]);

        h.chain.rpcDown = true;
        h.clock.advance(6);
        await checkTwice(h);
        expect(transitions(h).map((l) => l.condition)).toEqual(['pol_low', 'not_ready:rpc']);
    });

    it('reports a broadcast the relay could not pay for as pol_empty', async () => {
        h = await createHarness({ settings: { readinessIncludesTxManager: true } });
        const x = h;
        await x.relay.txManager.recover();
        const built = await buildTransfer(x);
        expect((await x.relay.pipeline.submit(transferOperation, built.body)).statusCode).toBe(202);
        x.chain.forcedBroadcasts.push({ kind: 'insufficient_funds' }, { kind: 'insufficient_funds' });
        await x.relay.txManager.tick();
        await checkTwice(x, () => x.relay.txManager.tick());
        expect(x.relay.txManager.health().reasons).toEqual([expect.stringMatching(/^insufficient_funds: /)]);
        expect(transitions(x)).toEqual([expect.objectContaining({ condition: 'pol_empty', alertState: 'firing' })]);
    });
});
