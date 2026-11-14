// Admission without client addresses: the sender cool-down, the relay-wide validation bounds, and that nothing uses,
// logs or keeps a network address.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadContractCall } from '../../src/chain/types.js';
import { buildTransfer, createHarness, USDC, USDT0, type Harness, type HarnessOptions } from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER3_ADDRESS, USER3_KEY, USER_ADDRESS } from '../helpers/keys.js';

const CLIENT_ADDRESSES = ['203.0.113.7', '198.51.100.23', '2001:db8::1'];

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
    h = await createHarness(options);
    h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
    return h;
}

function post(harness: Harness, payload: unknown, headers: Record<string, string> = {}) {
    return harness.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object, headers });
}

function errorCode(body: string): string | undefined {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
}

/** Holds every readContract of the fake chain until `release` is called. */
function holdReads(harness: Harness): { release: () => void; waiting: () => number } {
    const original = harness.chain.readContract.bind(harness.chain);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let waiting = 0;
    vi.spyOn(harness.chain, 'readContract').mockImplementation(async <T>(call: ReadContractCall): Promise<T> => {
        waiting += 1;
        await gate;
        return original<T>(call);
    });
    return { release: () => open(), waiting: () => waiting };
}

describe('client addresses', () => {
    it('are neither used nor logged: forwarded headers change nothing', async () => {
        const harness = await start({ settings: { rateLimit: { signerMax: 10_000, signerWindowMs: 60_000, submitMax: 2, submitWindowMs: 60_000 } } });
        // Every submission names another address; the relay-wide bound applies to all of them together.
        const codes = [];
        for (const [i, address] of CLIENT_ADDRESSES.entries()) {
            const t = await buildTransfer(harness, [{}, { key: OTHER_KEY }, { token: USDT0 }][i]);
            const answer = await post(harness, t.body, { 'x-forwarded-for': address, 'x-real-ip': address, forwarded: `for=${address}` });
            codes.push(i < 2 ? answer.statusCode : errorCode(answer.body));
        }
        expect(codes).toEqual([202, 202, 'unavailable']);
        for (let i = 0; i < 50; i += 1) {
            expect((await harness.relay.app.inject({ method: 'GET', url: '/v1/info', headers: { 'x-forwarded-for': CLIENT_ADDRESSES[0]! } })).statusCode).toBe(200);
        }
        const logs = harness.logs.text();
        expect(logs).toContain('http request');
        for (const address of [...CLIENT_ADDRESSES, '127.0.0.1']) expect(logs).not.toContain(address);
        expect(logs).not.toMatch(/remoteAddress|remotePort|"ip"|"ips"/);
    });
});

describe('relay-wide validation bounds', () => {
    it('lets submissions beyond RELAY_MAX_CONCURRENT_VALIDATIONS wait in order, and refuses more than the wait queue holds', async () => {
        const harness = await start({ settings: { maxConcurrentValidations: 1 } });
        harness.chain.setBalance(USDT0, OTHER_ADDRESS, 100_000_000n);
        harness.chain.setBalance(USDC, USER3_ADDRESS, 100_000_000n);
        harness.chain.setBalance(USDT0, USER3_ADDRESS, 100_000_000n);
        // Six senders: one pending request per sender.
        const pairs = [{}, { key: OTHER_KEY }, { token: USDT0, sender: 1 }, { token: USDT0, sender: 2 }, { key: USER3_KEY }, { token: USDT0, sender: 3 }];
        const transfers = [];
        for (const p of pairs) transfers.push(await buildTransfer(harness, p));
        const held = holdReads(harness);
        const running = post(harness, transfers[0]!.body);
        await vi.waitFor(() => expect(held.waiting()).toBeGreaterThan(0));
        // One slot: four submissions (VALIDATION_WAITERS_PER_SLOT) wait for it, the next is refused at once.
        const waiting = transfers.slice(1, 5).map((t) => post(harness, t.body));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(held.waiting()).toBe(1);
        const refused = await post(harness, transfers[5]!.body);
        expect(refused.statusCode).toBe(503);
        expect(errorCode(refused.body)).toBe('unavailable');
        expect(harness.store.getRequest(transfers[5]!.id)).toBeUndefined();
        held.release();
        expect((await Promise.all([running, ...waiting])).map((a) => a.statusCode)).toEqual([202, 202, 202, 202, 202]);
        // The slot is free again.
        expect((await post(harness, transfers[5]!.body)).statusCode).toBe(202);
        const events = await harness.metrics.registry.getSingleMetricAsString('relay_admission_events_total');
        expect(events).toContain('event="validation_busy"} 1');
    });

    it('answers 503 after half the validation deadline without a slot, and leaves the queue', async () => {
        const harness = await start({ settings: { maxConcurrentValidations: 1, validationTimeoutMs: 1000 } });
        const first = await buildTransfer(harness);
        const second = await buildTransfer(harness, { key: OTHER_KEY });
        const held = holdReads(harness);
        const running = post(harness, first.body);
        await vi.waitFor(() => expect(held.waiting()).toBeGreaterThan(0));
        const started = performance.now();
        const refused = await post(harness, second.body);
        expect(performance.now() - started).toBeGreaterThanOrEqual(450);
        expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'unavailable', message: expect.stringContaining('too many requests') } });
        // The first one ran out of its deadline meanwhile; nothing waits for its slot any more.
        expect(errorCode((await running).body)).toBe('unavailable');
        held.release();
        expect((await post(harness, second.body)).statusCode).toBe(202);
    });

    it('frees the slot when validation fails', async () => {
        const harness = await start({ settings: { maxConcurrentValidations: 1 } });
        harness.chain.setBalance(USDC, USER_ADDRESS, 0n);
        for (let i = 0; i < 3; i += 1) {
            const t = await buildTransfer(harness);
            expect(errorCode((await post(harness, t.body)).body)).toBe('insufficient_balance');
        }
    });

    it('counts only submissions that reach the chain against RELAY_RATE_LIMIT_SUBMIT_MAX', async () => {
        const harness = await start({ settings: { rateLimit: { signerMax: 10_000, signerWindowMs: 60_000, submitMax: 1, submitWindowMs: 60_000 } } });
        const forged = await buildTransfer(harness, { signWith: OTHER_KEY });
        for (let i = 0; i < 5; i += 1) expect(errorCode((await post(harness, forged.body)).body)).toBe('invalid_signature');
        const first = await buildTransfer(harness);
        expect((await post(harness, first.body)).statusCode).toBe(202);
        // An identical re-post is answered from the store, without reading the chain.
        expect((await post(harness, first.body)).statusCode).toBe(200);
        const second = await buildTransfer(harness, { key: OTHER_KEY });
        const refused = await post(harness, second.body);
        expect(refused.statusCode).toBe(503);
        expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'unavailable', message: expect.stringMatching(/Retry in [0-9]+ s/) } });
        harness.clock.advance(60);
        expect((await post(harness, second.body)).statusCode).toBe(202);
    });
});

describe('sender cool-down', () => {
    it('keys on the sender: one request pending while it cools down, other senders unaffected', async () => {
        const harness = await start();
        expect(harness.relay.senderAdmission.senderFailed(USER_ADDRESS)).toBe(true);
        const first = await buildTransfer(harness);
        const second = await buildTransfer(harness, { token: USDT0, deadline: BigInt(harness.clock.seconds() + 3600) });
        expect((await post(harness, first.body, { 'x-forwarded-for': CLIENT_ADDRESSES[0]! })).statusCode).toBe(202);
        // Another address changes nothing: the rule follows the sender.
        const refused = await post(harness, second.body, { 'x-forwarded-for': CLIENT_ADDRESSES[1]! });
        expect(refused.statusCode).toBe(429);
        expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'rate_limited', message: expect.stringContaining('this sender') } });
        const other = await buildTransfer(harness, { key: OTHER_KEY });
        expect((await post(harness, other.body)).statusCode).toBe(202);
        // Once the cool-down has ended, the refusal before the chain reads is gone; one request per sender stays the
        // rule: the second, at the nonce of the first, conflicts with it.
        harness.clock.advance(600);
        const conflict = await post(harness, second.body);
        expect(conflict.statusCode).toBe(409);
        expect(errorCode(conflict.body)).toBe('conflict');
    });

    it('lets one held request give way per sender at a time', async () => {
        const harness = await start();
        const admission = harness.relay.senderAdmission;
        const t = await buildTransfer(harness);
        expect(admission.mayEvict(USER_ADDRESS)).toBe(true);
        expect((await post(harness, t.body)).statusCode).toBe(202);
        admission.evicted(USER_ADDRESS, t.id);
        // Still queued and never sent: this sender may not make another give way; another sender may.
        expect(admission.mayEvict(USER_ADDRESS.toLowerCase())).toBe(false);
        expect(admission.mayEvict(OTHER_ADDRESS)).toBe(true);
        admission.senderFailed(OTHER_ADDRESS);
        expect(admission.mayEvict(OTHER_ADDRESS)).toBe(false);
    });
});
