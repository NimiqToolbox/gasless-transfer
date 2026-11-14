// Secret lifetime (docs §5: token signatures are persisted only for accepted requests until their outcome is
// final, then purged from every database file; relay/docs/storage.md). The purge is checked where it matters: in the
// bytes of the database files, not only through SQL.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, type Hex } from 'viem';
import { usdcAbi } from '@nimiq/gasless-sdk/core';
import {
    RECIPIENT,
    anvilAccount,
    mockTokenAbi,
    signTransfer,
    startFaultEnv,
    status,
    submit,
    tick,
    type FaultEnv,
} from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

function dbFiles(e: FaultEnv): string[] {
    const base = join(e.stack.dir, 'relay-10.sqlite');
    return [base, `${base}-wal`, `${base}-shm`].filter((f) => existsSync(f));
}

function filesContain(files: readonly string[], needle: string): string[] {
    return files.filter((f) => readFileSync(f).toString('latin1').toLowerCase().includes(needle.toLowerCase()));
}

const executeMetaTransactionAbi = [
    {
        type: 'function',
        name: 'executeMetaTransaction',
        stateMutability: 'payable',
        inputs: [
            { name: 'userAddress', type: 'address' },
            { name: 'functionSignature', type: 'bytes' },
            { name: 'sigR', type: 'bytes32' },
            { name: 'sigS', type: 'bytes32' },
            { name: 'sigV', type: 'uint8' },
        ],
        outputs: [{ type: 'bytes' }],
    },
] as const;

describe('secrets after the terminal state', () => {
    it('once a request fails before broadcast, its never-executed USDT0 META_TX approval and intent signature are in none of the SQLite files', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const user = anvilAccount(5);
        const t = await signTransfer(stack, relay, { from: 5, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 2_000_000n });
        const auth = t.body.authorization as { mode: 'metaTxApprove'; v: number; r: Hex; s: Hex };
        await submit(relay, t);
        // While it is queued, the sender moves its funds: the pre-broadcast simulation fails, the request ends
        // "failed" and the relay purges the signature and the authorization.
        await stack.setAutomine(true);
        const balance = await stack.balanceOf(stack.usdt0, user.address);
        await stack.send(user, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'transfer', args: [anvilAccount(12).address, balance] });
        await stack.setAutomine(false);
        await tick(relay);
        expect(await status(relay, t.id)).toBe('failed');
        const record = relay.server.store.getRequest(t.id)!;
        expect(record.signature).toBeNull(); // purged as far as SQL can tell
        expect(record.authorization).toBeNull();

        const secure = relay.server.store as unknown as { db: { pragma(s: string, o?: { simple: true }): unknown } };
        const secureDelete = secure.db.pragma('secure_delete', { simple: true });
        const files = dbFiles(env);
        const leaks = {
            secureDelete,
            intentSignature: filesContain(files, t.body.signature.slice(2)),
            authorizationR: filesContain(files, auth.r.slice(2)),
            authorizationS: filesContain(files, auth.s.slice(2)),
        };
        // A further full checkpoint (what SQLite does on its own at 1000 WAL pages or on close) copies the pages into
        // the main database file. Without secure_delete the old content of the purged cell would stay there in the
        // free space of the page; secure_delete zeroes it.
        const checkpoint = secure.db.pragma('wal_checkpoint(TRUNCATE)');
        const mainFile = dbFiles(env).filter((f) => f.endsWith('.sqlite'));
        const afterCheckpoint = {
            checkpoint,
            walSize: existsSync(`${mainFile[0]}-wal`) ? readFileSync(`${mainFile[0]}-wal`).length : null,
            intentSignature: filesContain(mainFile, t.body.signature.slice(2)),
            authorizationR: filesContain(mainFile, auth.r.slice(2)),
            authorizationS: filesContain(mainFile, auth.s.slice(2)),
        };
        console.log('purged secrets in the database files', { files: files.map((f) => f.split('/').pop()), ...leaks, afterCheckpoint });

        // If the files still held the approval, whoever reads them (backup, volume snapshot) could execute it: it never
        // expires. Show that before the assertion below fails.
        if (leaks.authorizationR.length > 0 && leaks.authorizationS.length > 0) {
            const functionSignature = encodeFunctionData({
                abi: usdcAbi,
                functionName: 'approve',
                args: [stack.transfer, BigInt(t.body.request.amount) + BigInt(t.body.request.fee)],
            });
            await stack.setAutomine(true);
            await stack.send(anvilAccount(13), {
                address: stack.usdt0,
                abi: executeMetaTransactionAbi,
                functionName: 'executeMetaTransaction',
                args: [user.address, functionSignature, auth.r, auth.s, auth.v],
            });
            console.log('replayed the purged META_TX approval: allowance =', await stack.allowance(stack.usdt0, user.address, stack.transfer));
        }
        expect({ intentSignature: leaks.intentSignature, authorizationR: leaks.authorizationR, authorizationS: leaks.authorizationS }).toEqual({
            intentSignature: [],
            authorizationR: [],
            authorizationS: [],
        });
        expect({ intentSignature: afterCheckpoint.intentSignature, authorizationR: afterCheckpoint.authorizationR, authorizationS: afterCheckpoint.authorizationS }).toEqual({
            intentSignature: [],
            authorizationR: [],
            authorizationS: [],
        });
    });

    it('confirmed and expired requests: SQL columns are NULL (the SQL-level purge works)', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const c = await signTransfer(stack, relay, { from: 6, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        const x = await signTransfer(stack, relay, { from: 7, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n, deadlineSeconds: 90 });
        await submit(relay, c);
        await tick(relay);
        await stack.mine();
        await tick(relay);
        expect(await status(relay, c.id)).toBe('mined');
        // x: broadcast, then priced out until the deadline, cancelled
        await submit(relay, x);
        await tick(relay);
        const [xCall] = relay.server.store.listAttempts(x.id);
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: xCall!.maxFeePerGas * 3n });
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(x.body.request.deadline) - 1n });
        await stack.mine();
        await tick(relay);
        await stack.mine(65);
        await tick(relay);
        expect(await status(relay, c.id)).toBe('confirmed');
        expect(await status(relay, x.id)).toBe('expired');
        for (const id of [c.id, x.id]) {
            const r = relay.server.store.getRequest(id)!;
            expect(r.signature).toBeNull();
            expect(r.authorization).toBeNull();
            expect(relay.server.store.listAttempts(id).every((a) => a.raw === null)).toBe(true);
        }
    });
});
