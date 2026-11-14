// A purged secret must not stay physically in the SQLite files.
//
// docs/STEP-1-GAS-ABSTRACTION.md §5: USDT0 META_TX signatures never expire on-chain, so unexecuted ones must not
// outlive their use and are purged. purgeSecrets() (relay/src/store/sqliteStore.ts) sets `signature`, `auth_json`
// and `transactions.raw` to NULL when a request ends (failed, expired, confirmed). In a database in WAL mode that
// alone does not remove the bytes: the page images from before the purge, with the signature and v/r/s, stay in the
// -wal file until later traffic happens to overwrite those frames, and automatic (PASSIVE) checkpoints keep and
// reuse the file. Anyone who obtains a copy of the live volume (a backup, a snapshot, a debugging dump) would
// recover signatures that were never broadcast.
//
// The store therefore runs with secure_delete and makes a wal_checkpoint(TRUNCATE) after every purge
// (relay/docs/storage.md). The tests search the main file, -wal and -shm for the purged values; the control tests
// show the cases in which the main file is clean after a checkpoint anyway.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeErrorResult } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { SqliteStore } from '../../../src/store/sqliteStore.js';
import { autoSender, buildTransfer, createHarness, USDT0, type BuiltTransfer, type Harness } from '../../helpers/harness.js';

let h: Harness;
let closed = false;

beforeEach(async () => {
    // The traffic below stays queued: one pending request per sender, so it comes from further senders (autoSender).
    // The cool-down of a sender whose request failed before its broadcast (RELAY_PREFLIGHT_COOLDOWN_SECONDS) is
    // turned off: these tests are about the database files, not admission.
    h = await createHarness({ settings: { admission: { preflightCooldownMs: 0 } } });
    closed = false;
});

afterEach(async () => {
    if (!closed) await h.close();
    else rmSync(h.dir, { recursive: true, force: true });
});

/** Every place a leaked copy of the relay volume would contain: main file, WAL and shared memory. */
function databaseBytes(dbPath: string): Buffer {
    return Buffer.concat([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) => existsSync(p)).map((p) => readFileSync(p)));
}

function secretsOf(t: BuiltTransfer): Record<string, string> {
    const auth = t.body.authorization as { r: string; s: string };
    return {
        intentSignature: t.body.signature.slice(2).toLowerCase(),
        metaTxR: auth.r.slice(2).toLowerCase(),
        metaTxS: auth.s.slice(2).toLowerCase(),
    };
}

function remnants(bytes: Buffer, secrets: Record<string, string>): string[] {
    const text = bytes.toString('latin1');
    return Object.entries(secrets)
        .filter(([, value]) => text.includes(value))
        .map(([name]) => name);
}

/** A META_TX request that is accepted, then fails its pre-broadcast simulation: it is never broadcast. */
async function acceptThenFailBeforeBroadcast(): Promise<BuiltTransfer> {
    const t = await buildTransfer(h, { token: USDT0, mode: 'metaTxApprove' });
    const res = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body as object });
    expect(res.statusCode).toBe(202);
    // The user's USDT0 nonce moved on elsewhere: the pre-broadcast simulation reverts.
    h.chain.simulate = () => ({
        ok: false,
        revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, 1_010_000n] }),
        message: 'execution reverted',
    });
    await h.relay.txManager.recover();
    await h.relay.txManager.tick();
    const record = h.store.getRequest(t.id);
    expect(record?.status).toBe('failed');
    expect(h.chain.broadcasts).toHaveLength(0);
    // Logically purged ...
    expect(record?.signature).toBeNull();
    expect(record?.authorization).toBeNull();
    return t;
}

describe('purged META_TX signatures in the SQLite files', () => {
    it('the store runs with SQLite secure_delete on', () => {
        const store = SqliteStore.open(':memory:');
        const db = (store as unknown as { db: { pragma(s: string, o: { simple: true }): unknown } }).db;
        // The store opens every database with secure_delete = 1 (on): freed row content is overwritten.
        expect(db.pragma('secure_delete', { simple: true })).toBe(1);
        store.close();
    });

    it('a purged, never-broadcast META_TX signature is not recoverable from the live database files', async () => {
        const t = await acceptThenFailBeforeBroadcast();
        const found = remnants(databaseBytes(h.dbPath), secretsOf(t));
        expect(found, `purged secrets still present in ${h.dbPath}{,-wal,-shm}`).toEqual([]);
    });

    it('control: a secret that only ever lived in the WAL is gone from the main file after a clean shutdown', async () => {
        const t = await acceptThenFailBeforeBroadcast();
        await h.relay.close();
        h.store.close();
        closed = true;
        const found = remnants(databaseBytes(h.dbPath), secretsOf(t));
        expect(found, `purged secrets still present in ${h.dbPath}`).toEqual([]);
    });

    it('control: a secret that reached the main file (checkpoint while pending) is gone from it after purge + TRUNCATE checkpoint', async () => {
        const db = (h.store as unknown as { db: { pragma(s: string): unknown } }).db;
        const t = await buildTransfer(h, { token: USDT0, mode: 'metaTxApprove' });
        expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: t.body as object })).statusCode).toBe(202);
        // SQLite checkpoints automatically every 1000 WAL pages; a pending request can span one.
        db.pragma('wal_checkpoint(TRUNCATE)');
        expect(remnants(readFileSync(h.dbPath), secretsOf(t)), 'precondition: the pending secret is in the main file').toHaveLength(3);
        h.chain.simulate = () => ({
            ok: false,
            revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, 1_010_000n] }),
            message: 'execution reverted',
        });
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(t.id)?.signature).toBeNull();
        db.pragma('wal_checkpoint(TRUNCATE)');
        const found = remnants(databaseBytes(h.dbPath), secretsOf(t));
        expect(found, `purged secrets still present in ${h.dbPath} after purge + checkpoint`).toEqual([]);
    });

    it('control: in a small WAL the purged secret is overwritten after a PASSIVE checkpoint and ten more requests', async () => {
        const db = (h.store as unknown as { db: { pragma(s: string): unknown } }).db;
        const t = await acceptThenFailBeforeBroadcast();
        db.pragma('wal_checkpoint(PASSIVE)');
        h.chain.simulate = () => ({ ok: true, data: '0x' });
        h.chain.setAllowance(USDT0, t.request.from, h.relay.ctx.contracts.transfer, 10n ** 15n);
        for (let i = 0; i < 10; i++) {
            const next = await buildTransfer(h, autoSender(h, { token: USDT0, mode: 'none' }));
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: next.body as object })).statusCode).toBe(202);
        }
        expect(remnants(databaseBytes(h.dbPath), secretsOf(t))).toEqual([]);
    });

    it('in a busy WAL the purged secret is gone from the main file and the -wal file after an automatic (PASSIVE) checkpoint and further traffic', async () => {
        const db = (h.store as unknown as { db: { pragma(s: string): unknown } }).db;
        // Earlier write traffic: the WAL already holds a few hundred frames when the META_TX request arrives
        // (each committed write transaction appends at least one frame; 300 small ones stand in for normal use).
        for (let i = 1; i <= 300; i++) h.store.setNextNonce(i);
        h.store.setNextNonce(0);
        const t = await acceptThenFailBeforeBroadcast();
        // What SQLite's auto-checkpoint does (every 1000 pages): copy back, but keep and later reuse the WAL file.
        expect(db.pragma('wal_checkpoint(PASSIVE)')).toEqual([expect.objectContaining({ busy: 0 })]);
        // Normal traffic afterwards: ten more accepted requests (new WAL frames from the start of the file).
        h.chain.simulate = () => ({ ok: true, data: '0x' });
        h.chain.setAllowance(USDT0, t.request.from, h.relay.ctx.contracts.transfer, 10n ** 15n);
        for (let i = 0; i < 10; i++) {
            const next = await buildTransfer(h, autoSender(h, { token: USDT0, mode: 'none' }));
            expect((await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: next.body as object })).statusCode).toBe(202);
        }
        db.pragma('wal_checkpoint(PASSIVE)');
        const wal = existsSync(`${h.dbPath}-wal`) ? readFileSync(`${h.dbPath}-wal`) : Buffer.alloc(0);
        expect(remnants(readFileSync(h.dbPath), secretsOf(t)), 'main file').toEqual([]);
        expect(remnants(wal, secretsOf(t)), `purged secrets still present in ${h.dbPath}-wal (${wal.length} bytes)`).toEqual([]);
    });
});
