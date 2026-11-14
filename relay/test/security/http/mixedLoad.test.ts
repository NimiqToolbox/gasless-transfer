// Clients that disconnect while their submission still waits for an RPC read must leave nothing behind. An attacker
// opens many signed submissions, lets each reach its chain read and then drops the connections. The relay must end
// those submissions at once, keep serving a healthy client, and store none of the abandoned requests when their reads
// complete later: otherwise dropped connections could fill the queue or reach the chain without anyone waiting for
// the answer.
//
// The relay does not tell clients apart by network address: the two addresses below only keep the test's parties on
// separate connections.
import { Agent, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { ReadContractCall } from '../../../src/chain/types.js';
import { buildTransfer, createHarness, USDC } from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER_ADDRESS } from '../../helpers/keys.js';

const ATTACKER = '127.0.0.2';
const HEALTHY = '127.0.0.3';
// No RELAY_POLUSD_FALLBACK: loadConfig refuses a static price, the Chainlink feed is required.
const defaults = loadConfig({ RELAY_RPC_URLS: 'http://localhost:8545', RELAY_DEPLOYMENT_FILE: '/unused/deployment.json', RELAY_PRIVATE_KEY_FILE: '/unused/key' });

interface Reply { status: number; ms: number; body: Record<string, unknown> }
async function until(observed: () => boolean, description: string): Promise<void> {
    const deadline = performance.now() + 2500;
    while (!observed() && performance.now() < deadline) await delay(5);
    expect(observed(), description).toBe(true);
}
function exchange(port: number, agent: Agent, localAddress: string, path: string, body?: unknown): Promise<Reply> {
    const start = performance.now();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path, agent, localAddress, method: payload ? 'POST' : 'GET', headers: {
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        } }, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.once('error', reject);
            res.once('end', () => {
                try { resolve({ status: res.statusCode!, ms: performance.now() - start, body: JSON.parse(raw) }); }
                catch (error) { reject(error); }
            });
        });
        req.setTimeout(3000, () => req.destroy(new Error('Local HTTP exchange exceeded 3 s')));
        req.once('error', reject);
        req.end(payload);
    });
}

/** The sender of a submitted body (the attacker's requests all come from USER). */
const senderOf = (body: unknown): string | undefined => (body as { request?: { from?: string } } | undefined)?.request?.from?.toLowerCase();

it('disconnected signed clients cannot persist after their pending RPC completes', async () => {
    // The relay bounds the submissions that read the chain at the same time, relay-wide
    // (RELAY_MAX_CONCURRENT_VALIDATIONS, default 4, with at most four more waiting per slot). The 24 disconnecting
    // submissions below must all wait in their reads, so the bound is raised to them.
    const h = await createHarness({ settings: { rateLimit: defaults.rateLimit, httpLimits: defaults.http, admission: defaults.admission, maxConcurrentValidations: 24 } });
    const healthyAgent = new Agent({ keepAlive: true, maxSockets: 4 });
    const requests: ReturnType<typeof httpRequest>[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
        h.chain.setBalance(USDC, OTHER_ADDRESS, 100_000_000n);
        const healthy = await buildTransfer(h, { key: OTHER_KEY });
        // 24 versions of one payment at the sender's next nonce.
        const bodies = await Promise.all(Array.from({ length: 24 }, (_, i) => buildTransfer(h, { amount: 1_000_000n + BigInt(i) })));
        const read = h.chain.readContract.bind(h.chain);
        let entered = 0;
        let completed = 0;
        let submissionsSettled = 0;
        const submit = h.relay.pipeline.submit.bind(h.relay.pipeline);
        h.relay.pipeline.submit = async (...args: Parameters<typeof submit>) => {
            try { return await submit(...args); }
            finally { if (senderOf(args[1]) === USER_ADDRESS.toLowerCase()) submissionsSettled++; }
        };
        h.chain.readContract = async <T>(call: ReadContractCall): Promise<T> => {
            if (call.functionName === 'nonces' && call.args?.some(arg => typeof arg === 'string' && arg.toLowerCase() === USER_ADDRESS.toLowerCase())) {
                entered++;
                await gate;
                const result = await read<T>(call);
                completed++;
                return result;
            }
            return read<T>(call);
        };
        await h.relay.app.listen({ host: '127.0.0.1', port: 0 });
        const port = (h.relay.app.server.address() as AddressInfo).port;
        const attack = Promise.all(bodies.map(body => new Promise<void>(resolve => {
            const payload = JSON.stringify(body.body);
            const req = httpRequest({ hostname: '127.0.0.1', port, localAddress: ATTACKER, agent: false, path: '/v1/transfer', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => { res.resume(); });
            requests.push(req);
            req.once('error', () => resolve());
            req.once('close', () => resolve());
            req.end(payload);
        })));
        await until(() => entered === 24, 'all attacker nonce reads enter');
        expect(entered).toBe(24);
        requests.forEach(req => req.destroy());
        await attack;
        // Observe complete submission settlement through the real response-close listener.
        await until(() => submissionsSettled === 24, 'all disconnected submissions settle before upstream completion');
        const accepted = await exchange(port, healthyAgent, HEALTHY, '/v1/transfer', healthy.body);
        expect(accepted.status).toBe(202);
        for (const path of ['/healthz', '/v1/info', `/v1/requests/${healthy.id}`]) expect((await exchange(port, healthyAgent, HEALTHY, path)).status).toBe(200);
        expect(h.store.countRequests()).toBe(1);
        release();
        await until(() => completed === 24, 'all underlying nonce reads finish');
        await nextTurn(); // Drain promise continuations after actual upstream completion.
        expect(completed).toBe(24);
        expect(h.store.countRequests()).toBe(1);
        for (const body of bodies) expect(h.store.getRequest(body.id)).toBeUndefined();
        expect(h.chain.broadcasts).toHaveLength(0);
        console.log(JSON.stringify({ scenario: 'disconnected-late-rpc', disconnectedClients: entered, lateRpcCompletions: completed, healthyAdmissionMs: Math.ceil(accepted.ms), retainedRows: h.store.countRequests() }));
    } finally { release(); requests.forEach(req => req.destroy()); healthyAgent.destroy(); await h.close(); }
}, 10000);
