// Crash recovery through the production entrypoint (`node dist/main.js`) against the real contract:
// the relay process is killed (SIGKILL) with one request in flight and one queued, the node loses the
// pending transaction as well, and a new process on the same database completes both.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { RelayClient, type RequestState, type RequestStatus } from '@nimiq/gasless-sdk/relay';
import { relayEnv, signTransfer, spawnRelay, waitFor, type RelayProcess, type SignedTransfer } from './helpers/relay.js';
import { anvilAccount, anvilKey, startStack, type Stack } from './helpers/stack.js';

const RELAY_INDEX = 12;
let stack: Stack;
const processes: RelayProcess[] = [];

beforeAll(async () => {
    stack = await startStack();
    await stack.setAutomine(false);
});

afterAll(async () => {
    for (const p of processes) {
        if (p.child.exitCode === null && p.child.signalCode === null) {
            p.child.kill('SIGKILL');
            await p.exited;
        }
    }
    await stack?.stop();
});

async function inMempool(hash: Hex): Promise<boolean> {
    try {
        return (await stack.publicClient.getTransaction({ hash })).blockNumber === null;
    } catch {
        return false;
    }
}

function reaches(client: RelayClient, id: Hex, status: RequestStatus): Promise<RequestState> {
    return waitFor(`${id} ${status}`, async () => {
        const state = await client.getRequest(id);
        return state.status === status ? state : undefined;
    });
}

it('T33: SIGKILL with one request submitted and one queued: a new process on the same database completes both', async () => {
    const env = await relayEnv(stack, {
        accountIndex: RELAY_INDEX,
        // One normal in-flight slot (the other is reserved for priority operations).
        env: { RELAY_MAX_IN_FLIGHT: '2', RELAY_RESERVED_PRIORITY_SLOTS: '1', RELAY_LOG_LEVEL: 'info' },
    });
    const first = spawnRelay(env);
    processes.push(first);
    await first.started();

    const relayAddress: Address = anvilAccount(RELAY_INDEX).address;
    const pins = stack.pins([relayAddress]);
    const client = new RelayClient(first.url, { pins });
    const to = anvilAccount(13).address;
    const x = await signTransfer(stack, { client, pins }, { from: 1, token: stack.usdc, authMode: 'permit', to, amount: 7_000_000n });
    const y = await signTransfer(stack, { client, pins }, { from: 2, token: stack.usdt0, authMode: 'metaTxApprove', to, amount: 8_000_000n });
    const tokens = (t: SignedTransfer) => (t === x ? stack.usdc : stack.usdt0);
    const balances = (t: SignedTransfer) => Promise.all([t.body.request.from, t.body.request.to, relayAddress].map((a) => stack.balanceOf(tokens(t), a)));
    const before = { x: await balances(x), y: await balances(y) };

    expect(await client.submitTransfer(x.body)).toEqual({ id: x.id, status: 'queued' });
    expect(await client.submitTransfer(y.body)).toEqual({ id: y.id, status: 'queued' });
    const xSubmitted = await reaches(client, x.id, 'submitted'); // broadcast; anvil does not mine (automine off)
    expect((await client.getRequest(y.id)).status).toBe('queued'); // no free slot
    const xHash = xSubmitted.txHash!;
    expect(await inMempool(xHash)).toBe(true);

    first.child.kill('SIGKILL');
    await first.exited;
    await stack.testClient.dropTransaction({ hash: xHash }); // the node lost it too

    const second = spawnRelay(env); // same key, database and port
    processes.push(second);
    await second.started();
    // Recovery re-broadcasts the signed transaction stored before the crash.
    await waitFor('re-broadcast of the stored transaction', async () => ((await inMempool(xHash)) ? true : undefined));
    expect((await client.getRequest(y.id)).status).toBe('queued');

    await stack.mine();
    const xMined = await reaches(client, x.id, 'mined');
    expect(xMined.txHash).toBe(xHash);
    expect(xMined.transactions).toHaveLength(1);
    await reaches(client, y.id, 'submitted');
    await stack.mine();
    await reaches(client, y.id, 'mined');

    for (const t of [x, y]) {
        const amount = BigInt(t.body.request.amount);
        const fee = BigInt(t.body.request.fee);
        const b = t === x ? before.x : before.y;
        expect(await balances(t)).toEqual([b[0]! - amount - fee, b[1]! + amount, b[2]! + fee]);
    }

    second.child.kill('SIGTERM');
    expect(await second.exited).toBe(0);
    const logs = second.logs();
    expect(logs.some((l) => l.msg === 'tracked transactions are missing from the mempool; re-broadcasting')).toBe(true);
    expect(logs.some((l) => l.msg === 'shutting down')).toBe(true);

    // Nothing secret in the output of either process.
    for (const p of [first, second]) {
        const out = p.output().toLowerCase();
        expect(out).not.toContain(anvilKey(RELAY_INDEX).slice(2).toLowerCase());
        for (const t of [x, y]) {
            expect(out).not.toContain(t.body.signature.slice(2).toLowerCase());
            expect(out).not.toContain(t.body.authorization.s!.slice(2).toLowerCase());
        }
    }
});
