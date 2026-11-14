// The fork harness's way to the fork RPC (helpers/forkUpstream.ts), offline: a plain anvil plays the fork RPC behind
// the fault-injecting proxy, and anvil forks it, directly or through ForkUpstream as startAnvilFork does. anvil alone
// fails a read whose request to the fork RPC gets no answer within its fork timeout, or a rate-limit answer it does
// not recognise; one such read of a public RPC is enough to fail the setup of forkE2E. Through ForkUpstream the same
// faults cost one retry each and every read is answered; a fault that outlasts the budget still ends in time.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort } from '../integration/helpers/stack.js';
import { startAnvilFork, type AnvilFork } from './helpers/forkStack.js';
import { ForkUpstream, transientReason, type ForkUpstreamRetry } from './helpers/forkUpstream.js';
import { FORWARD, RpcProxy, type Action, type JsonRpcCall } from './helpers/rpcProxy.js';

type Answer = { result: unknown; error?: undefined } | { error: { code: number; message: string }; result?: undefined };

async function call(url: string, method: string, params: readonly unknown[] = []): Promise<Answer> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    try {
        const json = JSON.parse(text) as Answer;
        return json.error ? { error: json.error } : { result: json.result ?? null };
    } catch {
        return { error: { code: res.status, message: text } };
    }
}

async function startAnvil(args: readonly string[]): Promise<{ child: ChildProcess; url: string; stop(): Promise<void> }> {
    const port = await freePort();
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent', ...args], { stdio: 'ignore' });
    const exited = once(child, 'exit').catch(() => undefined);
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
        if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`);
        const up = await call(url, 'eth_chainId').then(() => true, () => false);
        if (up) break;
        if (i > 300) throw new Error('anvil did not start');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
        child,
        url,
        async stop() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await exited;
            }
        },
    };
}

/** The fork's reads of one account's state from the fork RPC. */
const STATE_READS = new Set(['eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getProof']);
const readsOf = (account: string) => (c: JsonRpcCall) => STATE_READS.has(c.method) && String(c.params?.[0]).toLowerCase() === account;

/**
 * Like the public Polygon RPC, the fork RPC does not offer eth_getAccountInfo, so anvil reads an account's balance,
 * nonce and code one by one (a plain anvil offers it, and anvil falls back to those reads when it fails).
 */
function withoutAccountInfo(): void {
    faults.add({
        name: 'no eth_getAccountInfo',
        match: (c) => c.method === 'eth_getAccountInfo',
        before: () => ({ kind: 'answer', answer: { error: { code: -32601, message: 'the method eth_getAccountInfo does not exist/is not available' } } }),
    });
}

// A rate-limit answer whose code and wording anvil's own retry does not recognise.
const RATE_LIMITED: Action = { kind: 'answer', answer: { error: { code: 29, message: 'over capacity, try again later' } } };
const HANG: Action = { kind: 'hang' };
const account = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const balance = (n: number): string => `0x${(0x1000 + n).toString(16)}`;

let origin: Awaited<ReturnType<typeof startAnvil>>;
let faults: RpcProxy;
let block: bigint;

describe('the fork harness reads the fork RPC through ForkUpstream', () => {
    beforeAll(async () => {
        origin = await startAnvil([]);
        for (let n = 1; n <= 12; n++) await call(origin.url, 'anvil_setBalance', [account(n), balance(n)]);
        await call(origin.url, 'evm_mine');
        block = BigInt((await call(origin.url, 'eth_blockNumber')).result as string);
        faults = await new RpcProxy(origin.url).start();
    });

    afterAll(async () => {
        await faults?.stop();
        await origin?.stop();
    });

    it('anvil alone fails the read whose fork-RPC request gets no answer within its fork timeout, or a rate-limit answer it does not know', async () => {
        withoutAccountInfo();
        faults.add({ name: 'stall 1', match: readsOf(account(1)), before: () => HANG, times: 1 });
        faults.add({ name: 'limit 2', match: readsOf(account(2)), before: () => RATE_LIMITED, times: 1 });
        const fork = await startAnvil(['--fork-url', faults.url, '--fork-block-number', block.toString(), '--timeout', '2000', '--retries', '10', '--fork-retry-backoff', '200']);
        try {
            const started = Date.now();
            const stalled = await call(fork.url, 'eth_getBalance', [account(1), 'latest']);
            const stalledMs = Date.now() - started;
            const limited = await call(fork.url, 'eth_getBalance', [account(2), 'latest']);
            const plain = await call(fork.url, 'eth_getBalance', [account(3), 'latest']);
            console.log('anvil alone', { stalled, stalledMs, limited, plain });
            expect(stalled.error?.message).toMatch(/timed out/i);
            expect(stalledMs).toBeGreaterThanOrEqual(2000);
            expect(limited.error?.message).toMatch(/over capacity/);
            expect(plain).toEqual({ result: balance(3) });
        } finally {
            faults.clear();
            await fork.stop();
        }
    });

    it('through startAnvilFork (ForkUpstream) a stalled read, a rate-limit answer, HTTP 503 and HTTP 429 each cost one retry; every read is answered', async () => {
        withoutAccountInfo();
        faults.add({ name: 'stall 4', match: readsOf(account(4)), before: () => HANG, times: 1 });
        faults.add({ name: 'limit 5', match: readsOf(account(5)), before: () => RATE_LIMITED, times: 1 });
        faults.add({ name: 'http 503 6', match: readsOf(account(6)), before: () => ({ kind: 'http', status: 503 }), times: 1 });
        faults.add({ name: 'http 429 7', match: readsOf(account(7)), before: () => ({ kind: 'http', status: 429 }), times: 1 });
        const retries: ForkUpstreamRetry[] = [];
        const callsBefore = faults.calls.length;
        let fork: AnvilFork | undefined;
        try {
            fork = await startAnvilFork(block, [], faults.url, { attemptTimeoutMs: 1000, budgetMs: 20_000, backoffMs: 50, onRetry: (r) => retries.push(r) });
            const reads: Answer[] = [];
            for (const n of [4, 5, 6, 7, 8]) reads.push(await call(fork.rpcUrl, 'eth_getBalance', [account(n), 'latest']));
            console.log('through ForkUpstream', { reads, retries, stats: fork.upstream.stats });
            expect(reads).toEqual([4, 5, 6, 7, 8].map((n) => ({ result: balance(n) })));
            const faulted = faults.calls.slice(callsBefore).filter((c) => c.rule !== undefined && c.rule !== 'no eth_getAccountInfo');
            expect(faulted.map((c) => c.rule).sort()).toEqual(['http 429 7', 'http 503 6', 'limit 5', 'stall 4']);
            expect(retries.map((r) => r.reason).sort()).toEqual(['HTTP 429', 'HTTP 503', 'no answer within 1 s', 'rpc 29 over capacity, try again later']);
            expect(fork.upstream.stats).toMatchObject({ retried: 4, gaveUp: 0 });
        } finally {
            faults.clear();
            if (fork) {
                fork.child.kill('SIGKILL');
                await fork.upstream.stop();
            }
        }
    });

    it('a fault that outlasts the budget ends in time: the last answer (or 504 without one) reaches the caller', async () => {
        faults.add({ name: 'limit 9', match: readsOf(account(9)), before: () => RATE_LIMITED });
        faults.add({ name: 'stall 10', match: readsOf(account(10)), before: () => HANG });
        const upstream = await new ForkUpstream(faults.url, { attemptTimeoutMs: 300, budgetMs: 1500, backoffMs: 50 }).start();
        try {
            let started = Date.now();
            const limited = await call(upstream.url, 'eth_getBalance', [account(9), 'latest']);
            const limitedMs = Date.now() - started;
            started = Date.now();
            const stalled = await call(upstream.url, 'eth_getBalance', [account(10), 'latest']);
            const stalledMs = Date.now() - started;
            console.log('budget', { limited, limitedMs, stalled, stalledMs, stats: upstream.stats });
            expect(limited.error).toEqual({ code: 29, message: 'over capacity, try again later' });
            expect(stalled.error).toMatchObject({ code: 504 });
            for (const ms of [limitedMs, stalledMs]) expect(ms).toBeLessThan(1500 + 1000);
            expect(faults.calls.filter((c) => c.rule === 'limit 9').length).toBeGreaterThanOrEqual(3);
            expect(faults.calls.filter((c) => c.rule === 'stall 10').length).toBeGreaterThanOrEqual(2);
            expect(upstream.stats).toMatchObject({ requests: 2, retried: 2, gaveUp: 2 });
        } finally {
            faults.clear();
            await upstream.stop();
        }
    });

    it('holds at most maxInFlight requests at the fork RPC at a time', async () => {
        let open = 0;
        let most = 0;
        faults.add({
            name: 'slow',
            match: () => true,
            before: async () => {
                open++;
                most = Math.max(most, open);
                await new Promise((resolve) => setTimeout(resolve, 100));
                open--;
                return FORWARD;
            },
        });
        const upstream = await new ForkUpstream(faults.url, { maxInFlight: 2 }).start();
        try {
            const answers = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => call(upstream.url, 'eth_getBalance', [account(n), 'latest'])));
            expect(answers).toEqual([1, 2, 3, 4, 5, 6].map((n) => ({ result: balance(n) })));
            expect(most).toBe(2);
        } finally {
            faults.clear();
            await upstream.stop();
        }
    });

    it('retries only passing failures: rate limits, timeouts and unavailability, not a method the RPC does not offer', () => {
        const rpc = (code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } });
        expect(transientReason(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))).toBeUndefined();
        expect(transientReason(400, rpc(-32601, 'method is not available'))).toBeUndefined();
        expect(transientReason(200, rpc(3, 'execution reverted'))).toBeUndefined();
        expect(transientReason(200, rpc(29, 'over capacity, try again later'))).toBe('rpc 29 over capacity, try again later');
        expect(transientReason(200, rpc(-32005, 'limit exceeded'))).toBe('rpc -32005 limit exceeded');
        expect(transientReason(200, rpc(-32000, 'header not found'))).toBe('rpc -32000 header not found');
        expect(transientReason(200, rpc(-32603, 'upstream request timed out'))).toBe('rpc -32603 upstream request timed out');
        expect(transientReason(200, JSON.stringify([{ id: 1, result: '0x1' }, { id: 2, error: { code: -32029, message: 'x' } }]))).toBe('rpc -32029 x');
        expect(transientReason(429, '')).toBe('HTTP 429');
        expect(transientReason(502, '<html>')).toBe('HTTP 502');
        expect(transientReason(200, '<html>')).toBe('HTTP 200 without JSON');
    });
});
