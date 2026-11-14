// Store rules for outcomes that a reorg can still undo: provisional outcomes (resolveFailed, settle, reopen), the
// one-token-authorization index after a reorg, retention (pruneSettled) and purged secrets that are gone from every
// database file. relay/docs/storage.md describes the rules.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Hex } from 'viem';
import { SqliteStore } from '../../src/store/sqliteStore.js';
import type { FinalFailure, NewRequest } from '../../src/store/types.js';
import { CONTRACT, NO_AUTH, USDC } from '../helpers/harness.js';
import { USER_ADDRESS } from '../helpers/keys.js';

let dir: string;
let path: string;
let store: SqliteStore;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-store-lifecycle-'));
    path = join(dir, 'relay.sqlite');
    store = SqliteStore.open(path, { lockTimeoutMs: 50 });
});

afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const db = (): Database.Database => (store as unknown as { db: Database.Database }).db;

let counter = 0;
function newRequest(overrides: Partial<NewRequest> = {}): NewRequest {
    counter += 1;
    const n = counter.toString(16).padStart(8, '0');
    return {
        id: `0x${'b'.repeat(56)}${n}` as Hex,
        operation: 'transfer',
        contract: CONTRACT,
        signer: USER_ADDRESS,
        nonce: counter.toString(),
        fingerprint: `0x${'e'.repeat(56)}${n}` as Hex,
        request: { n: counter },
        authHash: `0x${'d'.repeat(56)}${n}` as Hex,
        signature: `0x${'11'.repeat(65)}` as Hex,
        authorization: { mode: 'permit', v: 27, r: `0x${'22'.repeat(32)}`, s: `0x${'33'.repeat(32)}` },
        fee: 10_000n,
        deadline: 2_000_000_000n,
        priority: 0,
        reservation: { token: USDC, spender: CONTRACT, debit: 1_010_000n },
        createdAtMs: 1000,
        ...overrides,
    };
}

const attempt = (hash: string, raw = `0x${'99'.repeat(100)}`, kind: 'call' | 'cancel' = 'call') => ({
    hash: hash as Hex,
    raw: raw as Hex,
    kind,
    maxFeePerGas: 90n,
    maxPriorityFeePerGas: 30n,
    gasLimit: kind === 'cancel' ? 21_000n : 195_000n,
    sentBlock: 100n,
});

const mined = (hash: string, blockNumber: bigint) => ({ hash: hash as Hex, blockNumber, gasUsed: 100_000n, effectiveGasPrice: 1n });
const EXPIRED: FinalFailure = { status: 'expired', error: { code: 'deadline_out_of_range', message: 'late' } };
const REVERTED: FinalFailure = { status: 'failed', error: { code: 'simulation_failed', message: 'The transaction reverted on-chain' } };

/** Every file a copy of the relay volume would contain. */
function databaseBytes(): string {
    return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p).toString('latin1'))
        .join('');
}

describe('SQLite settings for purged secrets', () => {
    it('opens with secure_delete on, journal_size_limit 0 and the exclusive locking mode', () => {
        expect(db().pragma('secure_delete', { simple: true })).toBe(1);
        expect(db().pragma('journal_size_limit', { simple: true })).toBe(0);
        expect(db().pragma('locking_mode', { simple: true })).toBe('exclusive');
        expect(store.journalMode()).toBe('wal');
    });

    it('a purge leaves the signature, the token authorization and the raw transactions in none of the files; the WAL is empty after it', () => {
        const signature = 'c7'.repeat(65);
        const r = 'd8'.repeat(32);
        const s = 'e9'.repeat(32);
        const raw = 'f1'.repeat(120);
        const req = newRequest({
            signature: `0x${signature}`,
            authorization: { mode: 'metaTxApprove', v: 27, r: `0x${r}`, s: `0x${s}` },
        });
        store.insertRequest(req, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(req.id, 0, attempt('0x01', `0x${raw}`), 1);
        // A checkpoint while the request is pending copies the secrets into the main file, too.
        db().pragma('wal_checkpoint(TRUNCATE)');
        const found = (bytes: string) => Object.entries({ signature, r, s, raw }).filter(([, v]) => bytes.includes(v)).map(([k]) => k);
        expect(found(databaseBytes())).toEqual(['signature', 'r', 's', 'raw']);

        store.resolveFailed(req.id, REVERTED, { kind: 'receipt', mined: mined('0x01', 5n), attemptKind: 'call', callReverted: true }, 2);
        expect(found(databaseBytes())).toEqual(['signature', 'r', 's', 'raw']); // provisional: kept
        store.settle(req.id, 3);
        expect(found(databaseBytes())).toEqual([]);
        if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).size).toBe(0);
    });

    it('the same holds for a request that ends before any broadcast (finalize) and after a clean shutdown', () => {
        const signature = 'a5'.repeat(65);
        const req = newRequest({ signature: `0x${signature}` });
        store.insertRequest(req, {});
        store.finalize(req.id, { status: 'failed', error: { code: 'simulation_failed', message: 'x' } }, undefined, 2);
        expect(databaseBytes().includes(signature)).toBe(false);
        store.close();
        expect(databaseBytes().includes(signature)).toBe(false);
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
    });
});

describe('provisional outcomes', () => {
    it('resolveFailed keeps secrets, raw transactions and the pending final state until settle; settle keeps failed/expired', () => {
        const req = newRequest();
        store.insertRequest(req, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(req.id, 0, attempt('0x01'), 1);
        store.recordReplacement(req.id, attempt('0x02', `0x${'98'.repeat(40)}`, 'cancel'), EXPIRED, 2);
        store.resolveFailed(req.id, EXPIRED, { kind: 'receipt', mined: mined('0x02', 7n), attemptKind: 'cancel', callReverted: false }, 3);
        let rec = store.getRequest(req.id)!;
        expect(rec).toMatchObject({ status: 'expired', resolvedTxHash: '0x02', resolvedBlock: 7n, settledAtMs: null, finalTxHash: null, pendingFinal: EXPIRED });
        expect(rec.signature).not.toBeNull();
        expect(store.listAttempts(req.id).map((a) => [a.hash, a.status, a.raw !== null])).toEqual([
            ['0x01', 'replaced', true],
            ['0x02', 'mined', true],
        ]);
        expect(store.listUnsettled().map((r) => r.id)).toEqual([req.id]);
        store.settle(req.id, 4);
        rec = store.getRequest(req.id)!;
        expect(rec).toMatchObject({ status: 'expired', settledAtMs: 4, pendingFinal: null, signature: null, authorization: null });
        expect(store.listAttempts(req.id).every((a) => a.raw === null)).toBe(true);
        expect(store.listUnsettled()).toEqual([]);
    });

    it('a foreign transaction on the nonce: all attempts failed, decided at the observation block', () => {
        const req = newRequest();
        store.insertRequest(req, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(req.id, 0, attempt('0x01'), 1);
        store.resolveFailed(req.id, EXPIRED, { kind: 'foreign', block: 42n }, 2);
        expect(store.getRequest(req.id)).toMatchObject({ status: 'expired', resolvedTxHash: null, resolvedBlock: 42n, settledAtMs: null });
        expect(store.listAttempts(req.id).map((a) => a.status)).toEqual(['failed']);
    });

    it('markMined keeps the pending final state and the first mined time; reopen keeps them, too', () => {
        const req = newRequest();
        store.insertRequest(req, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(req.id, 0, attempt('0x01'), 1);
        store.recordReplacement(req.id, attempt('0x02', `0x${'98'.repeat(40)}`, 'cancel'), EXPIRED, 2);
        store.markMined(req.id, mined('0x01', 9n), 3); // the call won the race against its cancel
        expect(store.getRequest(req.id)).toMatchObject({ status: 'mined', pendingFinal: EXPIRED, minedAtMs: 3, blockNumber: 9n, resolvedTxHash: '0x01' });
        store.reopen(req.id, 4);
        expect(store.getRequest(req.id)).toMatchObject({
            status: 'submitted',
            pendingFinal: EXPIRED,
            minedAtMs: 3,
            blockNumber: null,
            reopenedAtMs: 4,
            resolvedTxHash: null,
            finalTxHash: null,
        });
        // The newest attempt at the tx nonce is the one in flight again.
        expect(store.listAttempts(req.id).map((a) => [a.hash, a.status])).toEqual([
            ['0x01', 'replaced'],
            ['0x02', 'pending'],
        ]);
        store.resolveFailed(req.id, EXPIRED, { kind: 'receipt', mined: mined('0x02', 10n), attemptKind: 'cancel', callReverted: false }, 5);
        // The cancel took the nonce: the call is included nowhere.
        expect(store.getRequest(req.id)).toMatchObject({ status: 'expired', minedAtMs: 3, blockNumber: null });
        store.markMined(req.id, mined('0x01', 11n), 6);
        expect(store.getRequest(req.id)).toMatchObject({ status: 'mined', minedAtMs: 3, blockNumber: 11n });
        // A reorg that moves the inclusion to another block updates its block number, which step 9 compares
        // with the block of the balance read.
        store.updateMinedBlock(req.id, 12n, 7);
        expect(store.getRequest(req.id)).toMatchObject({ status: 'mined', blockNumber: 12n, minedAtMs: 3 });
    });

    it('the step-9 re-check counts a request that a reorg put back in flight and that is mined again after the balance read', () => {
        const a = newRequest({ authorization: NO_AUTH });
        store.insertRequest(a, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(a.id, 0, attempt('0x01'), 1);
        store.markMined(a.id, mined('0x01', 9n), 2);
        store.reopen(a.id, 3);
        // Another request of the sender reads the balance at block 9 of the new chain: `a` is not in it, its
        // funds are still in the balance. `a` is then mined again in block 10, so it is no longer pending when
        // the request is stored. Step 9 counts it: it was included after the block of the read.
        store.markMined(a.id, mined('0x01', 10n), 5);
        const guards = { observedBalance: 2_000_000n, observedAllowance: 10n ** 9n };
        expect(store.insertRequest(newRequest({ authorization: NO_AUTH }), { ...guards, observedBlock: 9n })).toEqual({
            kind: 'insufficient_balance',
            pending: 1_010_000n,
        });
        // A balance read at block 10 already reflects the inclusion.
        expect(store.insertRequest(newRequest({ authorization: NO_AUTH }), { ...guards, observedBlock: 10n }).kind).toBe('inserted');
    });

    it('reopen is a no-op for settled requests and for requests without a tx nonce', () => {
        const a = newRequest();
        store.insertRequest(a, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(a.id, 0, attempt('0x01'), 1);
        store.markMined(a.id, mined('0x01', 5n), 2);
        store.settle(a.id, 3);
        store.reopen(a.id, 4);
        expect(store.getRequest(a.id)).toMatchObject({ status: 'confirmed', reopenedAtMs: null });
        const b = newRequest({ signer: CONTRACT });
        store.insertRequest(b, {});
        store.finalize(b.id, EXPIRED, undefined, 5);
        store.reopen(b.id, 6);
        expect(store.getRequest(b.id)).toMatchObject({ status: 'expired', reopenedAtMs: null });
    });

    it('settle and markConfirmed purge nothing unless they settle the request (a request in flight again keeps its secrets)', () => {
        const a = newRequest();
        store.insertRequest(a, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(a.id, 0, attempt('0x0b'), 1);
        // In flight (e.g. a reorg put it back since the caller read it): nothing changes, nothing is purged.
        store.settle(a.id, 2);
        store.markConfirmed(a.id, 2);
        expect(store.getRequest(a.id)).toMatchObject({ status: 'submitted', settledAtMs: null, signature: newRequest().signature });
        expect(store.getRequest(a.id)!.authorization).not.toBeNull();
        expect(store.listAttempts(a.id)[0]!.raw).not.toBeNull();
        // Queued, too.
        const b = newRequest({ signer: CONTRACT });
        store.insertRequest(b, {});
        store.settle(b.id, 3);
        expect(store.getRequest(b.id)).toMatchObject({ status: 'queued', settledAtMs: null });
        expect(store.getRequest(b.id)!.signature).not.toBeNull();
        // Mined: markConfirmed settles and purges, a second call changes nothing.
        store.markMined(a.id, mined('0x0b', 5n), 4);
        store.markConfirmed(a.id, 5);
        expect(store.getRequest(a.id)).toMatchObject({ status: 'confirmed', settledAtMs: 5, confirmedAtMs: 5, signature: null, authorization: null });
        store.markConfirmed(a.id, 6);
        store.settle(a.id, 6);
        expect(store.getRequest(a.id)).toMatchObject({ settledAtMs: 5, confirmedAtMs: 5 });
    });

    it('a reorged permit request goes back in flight although a newer permit request of the same signer and token is queued', () => {
        const a = newRequest();
        store.insertRequest(a, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(a.id, 0, attempt('0x0a'), 1);
        store.markMined(a.id, mined('0x0a', 5n), 2);
        // Once a is mined, the same sender may sign the next permit (its token nonce moved on).
        const b = newRequest();
        expect(store.insertRequest(b, {}).kind).toBe('inserted');
        // The one-token-authorization index exempts a request a reorg put back in flight. If reopen threw here, every
        // later pass would throw with it.
        expect(() => store.reopen(a.id, 3)).not.toThrow();
        expect(store.getRequest(a.id)).toMatchObject({ status: 'submitted', reopenedAtMs: 3 });
        expect(store.getRequest(b.id)!.status).toBe('queued');
        // Both are pending for the sender now: a third request is refused as sender_busy.
        expect(store.insertRequest(newRequest(), {}).kind).toBe('sender_busy');
        expect(store.insertRequest(newRequest({ authorization: NO_AUTH, reservation: undefined }), {})).toEqual({ kind: 'sender_busy', reason: 'pending' });
        // Without the reorg exemption the indexes still allow only one pending token-signature request, and one pending
        // request per signer.
        for (const name of ['requests_one_token_auth_in_flight', 'requests_one_pending_per_signer']) {
            const index = db().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string };
            expect(index.sql).toContain('reopened_at IS NULL');
        }
    });
});

describe('retention', () => {
    it('pruneSettled deletes settled requests (and their transactions) that settled before the cutoff, nothing else', () => {
        const old = newRequest();
        const recent = newRequest({ signer: CONTRACT });
        const unsettled = newRequest({ signer: USDC });
        const queued = newRequest({ signer: `0x${'77'.repeat(20)}` });
        for (const r of [old, recent, unsettled, queued]) store.insertRequest(r, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(old.id, 0, attempt('0x01'), 1);
        store.markMined(old.id, mined('0x01', 5n), 2);
        store.settle(old.id, 100);
        store.finalize(recent.id, EXPIRED, undefined, 500);
        store.recordFirstAttempt(unsettled.id, 1, attempt('0x02'), 3);
        store.markMined(unsettled.id, mined('0x02', 6n), 4);
        expect(store.countRequests()).toBe(4);
        expect(store.pruneSettled(200)).toBe(1);
        expect(store.getRequest(old.id)).toBeUndefined();
        expect(store.listAttempts(old.id)).toEqual([]);
        expect(store.countRequests()).toBe(3);
        expect(store.pruneSettled(200)).toBe(0);
        expect(store.pruneSettled(10_000)).toBe(1); // the expired one; mined-unsettled and queued stay
        expect(store.getRequest(unsettled.id)!.status).toBe('mined');
        expect(store.getRequest(queued.id)!.status).toBe('queued');
    });
});
