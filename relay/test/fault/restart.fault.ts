// SIGKILL of the production entrypoint (node dist/main.js) with requests in every state, including a broadcast
// that is in progress (raw stored, eth_sendRawTransaction hanging in the proxy) and one whose answer was lost after
// the node took it. A new process on the same database must finish every request exactly once, leave no nonce
// gap and never send a second call for one request.
import { afterEach, describe, expect, it } from 'vitest';
import { parseGwei, type Hex } from 'viem';
import type { RequestStatus } from '@nimiq/gasless-sdk/relay';
import { method } from './helpers/rpcProxy.js';
import {
    RECIPIENT,
    anvilAccount,
    callsPerRequest,
    decodedBroadcasts,
    inMempool,
    intentNonceUsed,
    keyOf,
    mineUntil,
    mockTokenAbi,
    reaches,
    relayNonces,
    relayTxsOnChain,
    sendFrom,
    signTransfer,
    spawnRelay,
    startProcessEnv,
    waitFor,
    type ProcessEnv,
    type SignedTransfer,
    type TransferParams,
} from './helpers/fault.js';

let pe: ProcessEnv | undefined;

afterEach(async () => {
    await pe?.stop();
    pe = undefined;
});

const HIGH_TIP = { maxFeePerGas: parseGwei('2000'), maxPriorityFeePerGas: parseGwei('500') };
const ENV = { RELAY_MAX_IN_FLIGHT: '16', RELAY_RESERVED_PRIORITY_SLOTS: '1', RELAY_RPC_TIMEOUT_MS: '30000' };

function signer(e: ProcessEnv) {
    return (p: Omit<TransferParams, 'to' | 'amount'> & Partial<Pick<TransferParams, 'to' | 'amount'>>) =>
        signTransfer(e.stack, { client: e.client, pins: e.pins }, { to: RECIPIENT, amount: 1_000_000n, ...p });
}

async function submit(e: ProcessEnv, t: SignedTransfer): Promise<void> {
    expect(await e.client.submitTransfer(t.body)).toEqual({ id: t.id, status: 'queued' });
}

/**
 * The request is submitted and the node holds its transaction. The relay stores a transaction (the status reads
 * "submitted") before eth_sendRawTransaction reaches the node through the proxy, so a block mined as soon as the
 * status reads "submitted" can miss it (and with automine off no later block would include it).
 */
async function inNodePool(e: ProcessEnv, t: SignedTransfer): Promise<void> {
    const { txHash } = await reaches(e, t.id, 'submitted');
    await waitFor(`${t.id} in the node's pool`, async () => ((await inMempool(e.stack, txHash!)) ? true : undefined));
}

/** The intent nonce of `t` is used (executed or invalidated). */
const nonceUsed = (e: ProcessEnv, t: SignedTransfer): Promise<boolean> => intentNonceUsed(e.stack, t);

async function statuses(e: ProcessEnv, ts: Record<string, SignedTransfer>): Promise<Record<string, RequestStatus>> {
    const out: Record<string, RequestStatus> = {};
    for (const [name, t] of Object.entries(ts)) out[name] = (await e.state(t.id)).status;
    return out;
}

/** Every relay transaction on-chain since `fromBlock`: contiguous nonces, nothing left in the pool. */
async function expectCleanNonces(e: ProcessEnv, fromBlock: bigint): Promise<void> {
    const txs = await relayTxsOnChain(e.stack, e.relayAddress, fromBlock);
    const nonces = await relayNonces(e.stack, e.relayAddress);
    const first = txs[0]?.nonce ?? nonces.latest;
    expect(txs.map((t) => t.nonce)).toEqual(Array.from({ length: nonces.latest - first }, (_, i) => first + i));
    expect(nonces.pending).toBe(nonces.latest);
}

describe('SIGKILL and restart on the same database', () => {
    it('requests in every state (confirmed, mined, failed, submitted, dropped, broadcast in progress, queued) finish exactly once', async () => {
        pe = await startProcessEnv({ env: ENV });
        const e = pe;
        const { stack, proxy } = e;
        const sign = signer(e);
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });

        const c = await sign({ from: 1, token: stack.usdc, authMode: 'permit' });
        await submit(e, c);
        await inNodePool(e, c);
        await stack.mine();
        await reaches(e, c.id, 'mined');
        await stack.mine(65);
        await reaches(e, c.id, 'confirmed');

        const m = await sign({ from: 2, token: stack.usdt0, authMode: 'metaTxApprove' });
        await submit(e, m);
        await inNodePool(e, m);
        await stack.mine();
        await reaches(e, m.id, 'mined');

        // failed on-chain: the sender revokes its allowance after the broadcast
        const user3 = anvilAccount(3);
        const f = await sign({ from: 3, token: stack.usdt0, authMode: 'none' });
        await stack.send(user3, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 1_000_000n + BigInt(f.body.request.fee)] });
        await submit(e, f);
        await inNodePool(e, f);
        await sendFrom(stack, user3, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 0n] }, HIGH_TIP);
        await stack.mine();
        await reaches(e, f.id, 'failed');

        const s1 = await sign({ from: 4, token: stack.usdc, authMode: 'permit' });
        await submit(e, s1);
        const s1State = await reaches(e, s1.id, 'submitted');
        const s2 = await sign({ from: 5, token: stack.usdt0, authMode: 'permit' });
        await submit(e, s2);
        const s2State = await reaches(e, s2.id, 'submitted');

        // Broadcast in progress: the raw transaction is stored, eth_sendRawTransaction never reaches the node.
        proxy.add({ name: 'hang-broadcast', times: 1, match: method('eth_sendRawTransaction'), before: () => ({ kind: 'hang' }) });
        const b = await sign({ from: 6, token: stack.usdc, authMode: 'permit' });
        await submit(e, b);
        await waitFor('hanging broadcast', async () => (proxy.calls.some((x) => x.rule === 'hang-broadcast') ? true : undefined));
        // The node loses s2 (the transaction manager is blocked, so nothing re-sends it before the kill).
        await stack.testClient.dropTransaction({ hash: s2State.txHash! });
        // Accepted while the transaction manager is blocked: stays queued.
        const q = await sign({ from: 7, token: stack.usdt0, authMode: 'metaTxApprove' });
        await submit(e, q);

        const bState = await e.state(b.id);
        const atKill = {
            ...(await statuses(e, { c, m, f, s1, s2, b, q })),
            s1InPool: await inMempool(stack, s1State.txHash!),
            s2InPool: await inMempool(stack, s2State.txHash!),
            bHash: bState.txHash,
            bInPool: bState.txHash ? await inMempool(stack, bState.txHash) : null,
        };
        console.log('restart: state at SIGKILL', atKill);
        expect(atKill).toMatchObject({ c: 'confirmed', m: 'mined', f: 'failed', s1: 'submitted', s2: 'submitted', b: 'submitted', q: 'queued', s1InPool: true, s2InPool: false, bInPool: false });

        await e.kill();
        proxy.clear();
        await e.restart();

        const pending = { s1, s2, b, q };
        const blocks = await mineUntil(
            stack,
            async () => Object.values(await statuses(e, pending)).every((s) => s === 'mined' || s === 'confirmed'),
            30,
        );
        await stack.mine(65);
        await sleep(1_000);
        const final = await statuses(e, { c, m, f, s1, s2, b, q });
        const perRequest = callsPerRequest(await relayTxsOnChain(stack, e.relayAddress, block0 + 1n));
        const calls = Object.fromEntries(Object.entries({ c, m, f, s1, s2, b, q }).map(([n, t]) => [n, perRequest.get(keyOf(t)) ?? []]));
        const recoveryLogs = e.logs().filter((l) => /re-broadcast|missing|resynchron|nonce/i.test(String(l.msg))).map((l) => l.msg);
        console.log('restart: after recovery', { blocksToMine: blocks, final, calls, recoveryLogs });

        expect(final).toEqual({ c: 'confirmed', m: 'confirmed', f: 'failed', s1: 'confirmed', s2: 'confirmed', b: 'confirmed', q: 'confirmed' });
        expect(calls).toEqual({ c: ['success'], m: ['success'], f: ['reverted'], s1: ['success'], s2: ['success'], b: ['success'], q: ['success'] });
        expect((await e.state(b.id)).txHash).toBe(atKill.bHash); // the stored transaction, not a new one
        for (const t of [c, m, s1, s2, b, q]) expect(await nonceUsed(e, t)).toBe(true);
        await expectCleanNonces(e, block0 + 1n);
    });

    it('cancel in flight, deadline passed while the relay was down, and a node that lost the cancel', async () => {
        pe = await startProcessEnv({ env: ENV });
        const e = pe;
        const { stack, proxy, relayAddress } = e;
        const sign = signer(e);
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const cancelOf = (nonce: number) =>
            waitFor(`cancel at nonce ${nonce}`, async () => decodedBroadcasts(proxy, relayAddress).find((x) => x.kind === 'cancel' && x.nonce === nonce));
        // The status reads "submitted" before eth_sendRawTransaction reaches the node (see inNodePool).
        const callOf = async (id: Hex) => {
            const { txHash } = await reaches(e, id, 'submitted');
            return waitFor(`${id} in the node`, () => stack.publicClient.getTransaction({ hash: txHash! }).then((tx) => tx, () => undefined));
        };

        // e1: priced out until two seconds before its deadline; the relay cancels and the cancel is mined → expired.
        const e1 = await sign({ from: 1, token: stack.usdc, authMode: 'permit', deadlineSeconds: 90 });
        await submit(e, e1);
        const e1Call = await callOf(e1.id);
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: e1Call.maxFeePerGas! * 3n });
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(e1.body.request.deadline) - 1n });
        await stack.mine();
        await cancelOf(e1Call.nonce);
        await stack.mine();
        const e1Final = await reaches(e, e1.id, 'expired');

        // x: same, but the cancel is still in flight when the relay is killed.
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('1') });
        await stack.mine();
        const x = await sign({ from: 2, token: stack.usdt0, authMode: 'metaTxApprove', deadlineSeconds: 300 });
        await submit(e, x);
        const xCall = await callOf(x.id);
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: xCall.maxFeePerGas! * 3n });
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(x.body.request.deadline) - 1n });
        await stack.mine();
        const xCancel = await cancelOf(xCall.nonce);

        // qx: queued (the transaction manager hangs in eth_estimateGas while broadcasting it); its deadline
        // passes while the relay is down.
        proxy.add({ name: 'hang-estimate', times: 1, match: method('eth_estimateGas'), before: () => ({ kind: 'hang' }) });
        const chainNow = (await stack.latestBlock()).timestamp;
        const wallNow = BigInt(Math.floor(Date.now() / 1000));
        const qx = await sign({ from: 3, token: stack.usdc, authMode: 'permit', deadlineSeconds: Number(chainNow - wallNow) + 60 });
        await submit(e, qx);
        await waitFor('hanging estimate', async () => (proxy.calls.some((c) => c.rule === 'hang-estimate') ? true : undefined));
        const atKill = { ...(await statuses(e, { e1, x, qx })), xCancelInPool: await inMempool(stack, xCancel.hash), xCallInPool: await inMempool(stack, xCall.hash) };
        console.log('restart (cancel): state at SIGKILL', atKill);
        expect(atKill).toMatchObject({ e1: 'expired', x: 'submitted', qx: 'queued', xCancelInPool: true });

        await e.kill();
        proxy.clear();
        // While the relay is down: the node loses the cancel, and qx's deadline passes.
        await stack.testClient.dropTransaction({ hash: xCancel.hash });
        if (atKill.xCallInPool) await stack.testClient.dropTransaction({ hash: xCall.hash });
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('1') });
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(qx.body.request.deadline) + 5n });
        await stack.mine();
        await e.restart();

        await mineUntil(stack, async () => Object.values(await statuses(e, { x, qx })).every((s) => s === 'expired'), 20);
        const final = { e1: e1Final.status, ...(await statuses(e, { x, qx })) };
        const xState = await e.state(x.id);
        const qxState = await e.state(qx.id);
        const onChain = await relayTxsOnChain(stack, relayAddress, block0 + 1n);
        const atXNonce = onChain.find((t) => t.nonce === xCall.nonce);
        const qxBroadcasts = decodedBroadcasts(proxy, relayAddress).filter((b) => b.key === keyOf(qx));
        console.log('restart (cancel): after recovery', {
            final,
            xError: xState.error,
            qxError: qxState.error,
            atXNonce: atXNonce && { to: atXNonce.to, status: atXNonce.receipt.status },
            qxBroadcasts: qxBroadcasts.length,
        });
        expect(final).toEqual({ e1: 'expired', x: 'expired', qx: 'expired' });
        expect(atXNonce?.to?.toLowerCase()).toBe(relayAddress.toLowerCase()); // the cancel took x's nonce
        expect(qxBroadcasts).toHaveLength(0); // never broadcast
        for (const t of [e1, x, qx]) expect(await nonceUsed(e, t)).toBe(false);

        // The relay is healthy afterwards.
        const n = await sign({ from: 4, token: stack.usdt0, authMode: 'permit' });
        await submit(e, n);
        await mineUntil(stack, async () => (await e.state(n.id)).status === 'mined', 10);
        expect((await e.state(n.id)).status).toBe('mined');
        await expectCleanNonces(e, block0 + 1n);
    });

    it('a second process on the same database (other port) refuses to start while the first runs; the first keeps working', async () => {
        pe = await startProcessEnv({ env: ENV });
        const e = pe;
        const { stack } = e;
        const second = spawnRelay({ ...e.env, RELAY_PORT: String(Number(e.env.RELAY_PORT) + 1) });
        const code = await Promise.race([second.exited, sleep(20_000).then(() => 'still running' as const)]);
        if (code === 'still running') second.child.kill('SIGKILL');
        const reason = second.output().trim().split('\n').slice(-2).map((l) => l.slice(0, 240));
        const a = await signer(e)({ from: 7, token: stack.usdc, authMode: 'permit' });
        await submit(e, a);
        await mineUntil(stack, async () => (await e.state(a.id)).status === 'mined', 10);
        console.log('second process on the same database', { exitCode: code, reason, firstStillWorks: (await e.state(a.id)).status });
        expect(code).not.toBe('still running');
        expect(code).not.toBe(0);
        expect((await e.state(a.id)).status).toBe('mined');
    });

    it('SIGKILL after the node took the transaction but before the relay saw the answer: one call, no second nonce', async () => {
        pe = await startProcessEnv({ env: ENV });
        const e = pe;
        const { stack, proxy, relayAddress } = e;
        const sign = signer(e);
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        proxy.add({
            name: 'taken-then-hang',
            times: 1,
            match: method('eth_sendRawTransaction'),
            before: async (call) => {
                await proxy.upstreamCall('eth_sendRawTransaction', call.params ?? []);
                return { kind: 'hang' };
            },
        });
        const a = await sign({ from: 5, token: stack.usdc, authMode: 'permit' });
        await submit(e, a);
        await waitFor('forwarded broadcast', async () => (proxy.calls.some((c) => c.rule === 'taken-then-hang') ? true : undefined));
        const aHash = (await e.state(a.id)).txHash!;
        await waitFor('transaction in the pool', async () => ((await inMempool(stack, aHash)) ? true : undefined));
        await e.kill();
        proxy.clear();
        await e.restart();
        const n = await sign({ from: 6, token: stack.usdt0, authMode: 'metaTxApprove' });
        await submit(e, n);
        await mineUntil(stack, async () => Object.values(await statuses(e, { a, n })).every((s) => s === 'mined'), 10);
        const perRequest = callsPerRequest(await relayTxsOnChain(stack, relayAddress, block0 + 1n));
        const result = { ...(await statuses(e, { a, n })), aCalls: perRequest.get(keyOf(a)), nCalls: perRequest.get(keyOf(n)), aTxHash: (await e.state(a.id)).txHash };
        console.log('restart (answer lost)', result, decodedBroadcasts(proxy, relayAddress).map((x) => ({ nonce: x.nonce, kind: x.kind })));
        expect(result).toEqual({ a: 'mined', n: 'mined', aCalls: ['success'], nCalls: ['success'], aTxHash: aHash });
        await expectCleanNonces(e, block0 + 1n);
    });
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
