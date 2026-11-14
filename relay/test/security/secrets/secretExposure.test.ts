// No secret leaves the relay process. The intent signature, the token authorization (r, s), raw transactions and
// the relay key must never appear in the log output (debug level), in any HTTP response (accepted and rejected
// submissions, request views in every state, info, fee, readiness) or in /metrics. Logs and responses reach more
// readers than the database does, and a token authorization or a signed transaction that was never executed is
// usable by whoever holds it. The test walks the error paths as well as the happy path: invalid token
// authorization, conflicts, high-s and malformed signatures, simulation failure at acceptance and before broadcast,
// speed-ups, cancels, expiry in flight, a reorg, a dropped mempool and a restart.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeErrorResult, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, tokenAuthHash } from '@nimiq/gasless-sdk/core';
import type { CallOutcome } from '../../../src/chain/types.js';
import {
    buildTransfer,
    CONTRACT,
    createHarness,
    fundedSender,
    restartHarness,
    toHighS,
    USDC,
    USDT0,
    type BuiltTransfer,
    type Harness,
} from '../../helpers/harness.js';
import { OTHER_KEY, RELAY_ADDRESS, RELAY_KEY, USER3_KEY, USER_KEY } from '../../helpers/keys.js';

let h: Harness;
const responses: string[] = [];
const logSources: Array<() => string> = [];

const FAIL_KEY = generatePrivateKey();

beforeEach(async () => {
    h = await createHarness();
    for (const key of [OTHER_KEY, USER3_KEY, FAIL_KEY]) {
        const a = privateKeyToAccount(key).address;
        h.chain.setBalance(USDC, a, 100_000_000n);
        h.chain.setBalance(USDT0, a, 100_000_000n);
    }
    for (const key of [USER_KEY, OTHER_KEY, USER3_KEY]) {
        const a = privateKeyToAccount(key).address;
        h.chain.setAllowance(USDC, a, CONTRACT, 10n ** 15n);
        h.chain.setAllowance(USDT0, a, CONTRACT, 10n ** 15n);
    }
    responses.length = 0;
    logSources.length = 0;
    logSources.push(h.logs.text);
});

afterEach(async () => {
    await h.close();
});

async function inject(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const res = await h.relay.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    responses.push(`${method} ${url} -> ${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
    return res;
}

const code = (body: string) => (JSON.parse(body) as { error?: { code: string } }).error?.code ?? 'ok';

function secretsOf(t: BuiltTransfer): string[] {
    const out = [t.body.signature.slice(2).toLowerCase()];
    const a = t.body.authorization;
    if (a.mode !== 'none') out.push(a.r!.slice(2).toLowerCase(), a.s!.slice(2).toLowerCase());
    return out;
}

const revert = (debit: bigint): CallOutcome => ({
    ok: false,
    revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, debit] }),
    message: 'execution reverted',
});

describe('secrets never leave the process', () => {
    it('logs, HTTP responses and /metrics contain no signature, token authorization, raw transaction or key on any path', async () => {
        const submitted: BuiltTransfer[] = [];
        const accepted: BuiltTransfer[] = [];

        // Accepted: every token and mode, one with a deadline that expires in flight (one request per sender).
        const [fourth, fifth, sixth] = [1, 2, 3].map((i) => fundedSender(h.chain, i).key);
        h.chain.setAllowance(USDC, privateKeyToAccount(fourth!).address, CONTRACT, 10n ** 15n);
        const plan = [
            { key: USER3_KEY, token: USDT0, mode: 'none' as const, deadline: 70 },
            { key: USER_KEY, token: USDC, mode: 'permit' as const },
            { key: OTHER_KEY, token: USDT0, mode: 'metaTxApprove' as const },
            { key: fourth!, token: USDC, mode: 'none' as const },
            { key: fifth!, token: USDT0, mode: 'permit' as const },
        ];
        for (const p of plan) {
            const t = await buildTransfer(h, {
                key: p.key,
                token: p.token,
                mode: p.mode,
                ...(p.deadline !== undefined ? { deadline: BigInt(h.clock.seconds() + p.deadline) } : {}),
            });
            submitted.push(t);
            expect((await inject('POST', '/v1/transfer', t.body)).statusCode).toBe(202);
            accepted.push(t);
        }

        // Rejected submissions that carry secrets.
        const wrongNonce = await buildTransfer(h, { key: sixth!, token: USDC, mode: 'permit', authNonce: 5n });
        const conflict = await buildTransfer(h, { key: USER_KEY, token: USDC, mode: 'permit', nonce: BigInt(accepted[1]!.body.request.nonce), amount: 2_000_000n });
        const highS = await buildTransfer(h, { key: OTHER_KEY, token: USDC, mode: 'permit' });
        const malformed = await buildTransfer(h, { key: OTHER_KEY, token: USDT0, mode: 'metaTxApprove' });
        const failsAtAcceptance = await buildTransfer(h, { key: FAIL_KEY, token: USDT0, mode: 'metaTxApprove' });
        submitted.push(wrongNonce, conflict, highS, malformed, failsAtAcceptance);

        expect(code((await inject('POST', '/v1/transfer', wrongNonce.body)).body)).toBe('invalid_token_authorization');
        expect(code((await inject('POST', '/v1/transfer', conflict.body)).body)).toBe('conflict');
        expect(code((await inject('POST', '/v1/transfer', { ...highS.body, signature: toHighS(highS.body.signature) })).body)).toBe(
            'invalid_signature',
        );
        // 66 bytes: the schema takes any hex, step 3 requires exactly 65 bytes.
        expect(code((await inject('POST', '/v1/transfer', { ...malformed.body, signature: `${malformed.body.signature}ab` })).body)).toBe(
            'invalid_signature',
        );
        expect(
            code((await inject('POST', '/v1/transfer', { ...malformed.body, authorization: { ...malformed.body.authorization, extra: 1 } })).body),
        ).toBe('invalid_request');
        const baseSimulate = h.chain.simulate;
        h.chain.simulate = () => revert(1_010_000n);
        expect(code((await inject('POST', '/v1/transfer', failsAtAcceptance.body)).body)).toBe('simulation_failed');
        h.chain.simulate = baseSimulate;

        // A META_TX request that is accepted and then fails its pre-broadcast simulation.
        const failsBeforeBroadcast = await buildTransfer(h, { key: FAIL_KEY, token: USDT0, mode: 'metaTxApprove' });
        submitted.push(failsBeforeBroadcast);
        expect((await inject('POST', '/v1/transfer', failsBeforeBroadcast.body)).statusCode).toBe(202);
        const failingSignature = failsBeforeBroadcast.body.signature.slice(2).toLowerCase();
        h.chain.simulate = (call) => (call.data.toLowerCase().includes(failingSignature) ? revert(1_010_000n) : baseSimulate(call));

        // Views while queued.
        for (const t of [...accepted, failsBeforeBroadcast]) await inject('GET', `/v1/requests/${t.id}`);

        // Nothing is included for 14 blocks: speed-ups, then the short-deadline request is cancelled.
        await h.relay.txManager.recover();
        h.chain.includeFilter = () => false;
        for (let i = 0; i < 14; i++) {
            await h.relay.txManager.tick();
            h.chain.mine({ timestampDelta: 5 });
            if (i === 3) for (const t of accepted) await inject('GET', `/v1/requests/${t.id}`);
        }
        h.chain.includeFilter = () => true;
        h.chain.mine();
        await h.relay.txManager.tick();
        const firstMined = [...h.chain.mined.values()].find((tx) => tx.to?.toLowerCase() === CONTRACT.toLowerCase());
        if (firstMined) h.chain.reorg(firstMined.hash);
        h.chain.dropMempool();
        h = await restartHarness(h);
        logSources.push(h.logs.text);
        await h.relay.txManager.recover();
        for (let i = 0; i < 6; i++) {
            await h.relay.txManager.tick();
            h.chain.mine();
        }

        // Views in the final states, and every other route.
        const statuses = new Set<string>();
        for (const t of [...accepted, failsBeforeBroadcast]) {
            const res = await inject('GET', `/v1/requests/${t.id}`);
            statuses.add((JSON.parse(res.body) as { status: string }).status);
        }
        expect(statuses.has('expired')).toBe(true);
        expect(statuses.has('failed')).toBe(true);
        expect([...statuses].some((s) => s === 'mined' || s === 'confirmed')).toBe(true);
        await inject('GET', '/metrics');
        await inject('GET', '/readyz');
        // /metrics and the full readiness report are served on the internal listener: scan those too.
        for (const url of ['/metrics', '/readyz']) {
            const res = await h.relay.opsApp.inject({ method: 'GET', url });
            if (url === '/metrics') expect(res.body).toContain('relay_http_requests_total');
            responses.push(`GET (internal) ${url} -> ${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
        }
        await inject('GET', '/v1/info');
        await inject('GET', `/v1/fee?operation=transfer&token=${USDT0}&authMode=metaTxApprove`);
        // Identical re-posts of every submission after the purge (idempotent answers).
        for (const t of accepted) await inject('POST', '/v1/transfer', t.body);

        const logs = logSources.map((text) => text()).join('\n').toLowerCase();
        const http = responses.join('\n').toLowerCase();
        // Sensitivity: request ids are logged and 32-byte values (the token authorization's authHash) appear verbatim
        // in the request views, so r/s (32 bytes each, below the 64-byte log scrubber threshold) would be found.
        expect(logs).toContain(accepted[0]!.id.toLowerCase());
        expect(http).toContain(tokenAuthHash(accepted[2]!.authorization).slice(2).toLowerCase());
        expect(http).toContain('txhash');
        // The lifecycle really produced speed-ups/re-broadcasts and a cancel.
        expect(h.chain.broadcasts.length).toBeGreaterThan(accepted.length);
        expect(h.chain.broadcasts.some((raw) => parseTransaction(raw).to?.toLowerCase() === RELAY_ADDRESS.toLowerCase())).toBe(true);

        const leaks: string[] = [];
        const check = (label: string, needle: string) => {
            if (logs.includes(needle)) leaks.push(`log: ${label}`);
            if (http.includes(needle)) leaks.push(`http: ${label}`);
        };
        submitted.forEach((t, i) => secretsOf(t).forEach((s, j) => check(`submission ${i} secret ${j}`, s)));
        check('relay key', RELAY_KEY.slice(2).toLowerCase());
        h.chain.broadcasts.forEach((raw, i) => check(`raw transaction ${i}`, raw.slice(2).toLowerCase()));
        expect(leaks).toEqual([]);
    });
});
