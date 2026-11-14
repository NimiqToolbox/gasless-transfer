import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Address, Hex } from 'viem';
import { MIGRATIONS, migrate } from '../../src/store/migrations.js';
import { SqliteStore } from '../../src/store/sqliteStore.js';
import type { NewRequest } from '../../src/store/types.js';
import { CONTRACT, NO_AUTH, USDC, USDT0 } from '../helpers/harness.js';
import { OTHER_ADDRESS, USER3_ADDRESS, USER_ADDRESS } from '../helpers/keys.js';

let dir: string;
let path: string;
let store: SqliteStore;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
    path = join(dir, 'relay.sqlite');
    store = SqliteStore.open(path, { lockTimeoutMs: 50 });
});

afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function newRequest(overrides: Partial<NewRequest> = {}): NewRequest {
    counter += 1;
    return {
        id: `0x${'a'.repeat(56)}${counter.toString(16).padStart(8, '0')}` as Hex,
        operation: 'transfer',
        contract: CONTRACT,
        signer: USER_ADDRESS,
        nonce: counter.toString(),
        fingerprint: `0x${'f'.repeat(56)}${counter.toString(16).padStart(8, '0')}` as Hex,
        request: { hello: 'world' },
        authHash: `0x${'d'.repeat(56)}${counter.toString(16).padStart(8, '0')}` as Hex,
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

/** A distinct signer per index (the relay keeps one pending request per signer). */
const signerAt = (i: number): Address => `0x${(0x5000 + i).toString(16).padStart(40, '0')}`;

const attempt = (hash: string, raw = `0x${'99'.repeat(100)}`) => ({
    hash: hash as Hex,
    raw: raw as Hex,
    kind: 'call' as const,
    maxFeePerGas: 90n,
    maxPriorityFeePerGas: 30n,
    gasLimit: 250_000n,
    sentBlock: 100n,
});

/** What an open could change in a database file: applied migrations, layout, key-value state and requests. */
function contents(file: string) {
    const raw = new Database(file, { readonly: true });
    try {
        return {
            migrations: raw.prepare('SELECT version, description, applied_at FROM schema_migrations ORDER BY version').all() as Array<{
                version: number;
                description: string;
                applied_at: number;
            }>,
            layout: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
            kv: raw.prepare('SELECT key, value FROM kv ORDER BY key').all(),
            requests: raw.prepare('SELECT id, status, updated_at FROM requests ORDER BY id').all(),
        };
    } finally {
        raw.close();
    }
}

describe('SQLite setup', () => {
    it('uses WAL and the latest schema', () => {
        expect(store.journalMode()).toBe('wal');
        expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    });

    it('holds an exclusive lock: a second process/connection cannot open the database', () => {
        expect(() => SqliteStore.open(path, { lockTimeoutMs: 50 })).toThrow(/locked|busy/i);
        store.close();
        const again = SqliteStore.open(path, { lockTimeoutMs: 50 });
        expect(again.schemaVersion()).toBe(MIGRATIONS.length);
        again.close();
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
    });

    it('applies migrations once, adds later ones and refuses newer databases', () => {
        store.close();
        const upgradedPath = join(dir, 'upgraded.sqlite');
        SqliteStore.open(upgradedPath).close();
        const extra = [...MIGRATIONS, { version: MIGRATIONS.length + 1, description: 'test column', sql: 'ALTER TABLE kv ADD COLUMN note TEXT;' }];
        const upgraded = SqliteStore.open(upgradedPath, { migrations: extra });
        expect(upgraded.schemaVersion()).toBe(MIGRATIONS.length + 1);
        upgraded.close();
        const reopened = SqliteStore.open(upgradedPath, { migrations: extra });
        expect(reopened.schemaVersion()).toBe(MIGRATIONS.length + 1);
        reopened.close();
        expect(() => SqliteStore.open(upgradedPath, { migrations: MIGRATIONS })).toThrow(/newer/);
        const raw = new Database(upgradedPath);
        expect((raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(MIGRATIONS.length + 1);
        raw.close();
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
    });

    // A restart must not rewrite a database that is already at the latest schema: its requests and state stay as stored.
    it('reopens a database of migrations 1 to 7 without running a migration again or changing a row', () => {
        store.bindIdentity({ chainId: 137, relay: USER_ADDRESS, gaslessTransfer: CONTRACT });
        const pending = newRequest({ signer: signerAt(940) });
        expect(store.insertRequest(pending, {})).toMatchObject({ kind: 'inserted' });
        store.close();
        const before = contents(path);
        expect(before.migrations.map((m) => [m.version, m.description])).toEqual(MIGRATIONS.slice(0, 7).map((m) => [m.version, m.description]));
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
        expect(store.schemaVersion()).toBe(7);
        expect(store.getRequest(pending.id)?.status).toBe('queued');
        store.bindIdentity({ chainId: 137, relay: USER_ADDRESS, gaslessTransfer: CONTRACT });
        store.close();
        expect(contents(path)).toEqual(before);
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
    });

    it('refuses a database at an older schema (1 to 6) and leaves it untouched', () => {
        store.close();
        for (let version = 1; version < 7; version++) {
            const oldPath = join(dir, `schema${version}.sqlite`);
            const old = SqliteStore.open(oldPath, { migrations: MIGRATIONS.slice(0, version) });
            (old as unknown as { db: Database.Database }).db.prepare("INSERT INTO kv (key, value) VALUES ('relay', ?)").run(USER_ADDRESS);
            old.close();
            const before = contents(oldPath);
            expect(before.migrations).toHaveLength(version);
            expect(() => SqliteStore.open(oldPath)).toThrow(
                `database schema v${version} is older than this relay supports (v7); start this relay with a new RELAY_DB_PATH`,
            );
            expect(contents(oldPath)).toEqual(before);
        }
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
    });

    it('migration 7 changes no table, index or column of migration 6', () => {
        const layout = (db: Database.Database) =>
            db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
        const six = new Database(':memory:');
        migrate(six, MIGRATIONS.slice(0, 6), 0);
        const seven = new Database(':memory:');
        expect(migrate(seven, MIGRATIONS.slice(0, 7), 0)).toBe(7);
        expect(layout(seven)).toEqual(layout(six));
        expect(seven.prepare('SELECT version, description FROM schema_migrations WHERE version = 7').get()).toEqual({
            version: 7,
            description: 'EIP-712 domain version 3',
        });
        six.close();
        seven.close();
    });

    it('stores fees and debits of any uint256 exactly', () => {
        const max = 2n ** 256n - 1n;
        for (const [i, fee] of [2n ** 53n + 1n, 2n ** 128n + 1n, max - 1_000_000n].entries()) {
            const request = newRequest({ signer: signerAt(960 + i), fee, reservation: { token: USDC, spender: CONTRACT, debit: fee + 1_000_000n } });
            expect(store.insertRequest(request, {})).toMatchObject({ kind: 'inserted' });
            const stored = store.getRequest(request.id)!;
            expect(stored.fee).toBe(fee);
            expect(stored.debit).toBe(fee + 1_000_000n);
            expect(store.tokenUsage(USDC, signerAt(960 + i), CONTRACT).debits).toBe(fee + 1_000_000n);
        }
    });

    it('a new database never exists at an older schema: its migrations run in one transaction', () => {
        for (const { version } of MIGRATIONS) {
            const broken = [...MIGRATIONS.slice(0, version - 1), { version, description: 'fails', sql: 'NOT SQL;' }];
            const db = new Database(':memory:');
            expect(() => migrate(db, broken, 0)).toThrow();
            expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(0);
            expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'requests'").all()).toEqual([]);
            db.close();
        }
    });

    it('migration 6: uint256 decimal nonces, the auth hash, and the nonce-holder and one-pending indexes', () => {
        const db = (store as unknown as { db: Database.Database }).db;
        const columns = (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
        expect(columns).toEqual(expect.arrayContaining(['nonce', 'auth_hash', 'auth_json', 'reopened_at']));
        const indexes = (db.prepare('PRAGMA index_list(requests)').all() as Array<{ name: string }>).map((i) => i.name);
        expect(indexes).toEqual(expect.arrayContaining(['requests_nonce_holder', 'requests_one_pending_per_signer', 'requests_one_token_auth_in_flight']));
        // The nonce column takes canonical-looking decimal strings of at most 78 digits only.
        for (const nonce of ['0x01', '-1', '1e3', ' 1', '', '1'.repeat(79)]) {
            expect(() => store.insertRequest(newRequest({ nonce, signer: signerAt(900) }), {})).toThrow(/CHECK/);
        }
        const max = ((1n << 256n) - 1n).toString();
        expect(store.insertRequest(newRequest({ nonce: max, signer: signerAt(901) }), {}).kind).toBe('inserted');
        expect(store.nonceHolder(CONTRACT, signerAt(901), max)?.nonce).toBe(max);
    });

    it('rejects badly numbered migrations', () => {
        const db = new Database(':memory:');
        expect(() => migrate(db, [{ version: 2, description: 'x', sql: '' }], 0)).toThrow(/numbered/);
        db.close();
    });

    it('binds the database to one chain and relay key', () => {
        store.bindIdentity({ chainId: 137, relay: USER_ADDRESS, gaslessTransfer: CONTRACT });
        store.bindIdentity({ chainId: 137, relay: USER_ADDRESS, gaslessTransfer: CONTRACT });
        expect(() => store.bindIdentity({ chainId: 137, relay: OTHER_ADDRESS, gaslessTransfer: CONTRACT })).toThrow(/refusing/);
        expect(() => store.bindIdentity({ chainId: 80002, relay: USER_ADDRESS, gaslessTransfer: CONTRACT })).toThrow(/refusing/);
    });
});

describe('requests', () => {
    it('stores and reads a request', () => {
        const r = newRequest();
        const outcome = store.insertRequest(r, {});
        expect(outcome.kind).toBe('inserted');
        const stored = store.getRequest(r.id)!;
        expect(stored).toMatchObject({
            id: r.id,
            status: 'queued',
            contract: CONTRACT,
            signer: USER_ADDRESS,
            nonce: r.nonce,
            signature: r.signature,
            authorization: r.authorization,
            authMode: 'permit',
            token: USDC,
            debit: 1_010_000n,
            fee: 10_000n,
            deadline: 2_000_000_000n,
            request: { hello: 'world' },
            txNonce: null,
            error: null,
            pendingFinal: null,
            authHash: r.authHash,
        });
        expect(store.nonceHolder(CONTRACT, USER_ADDRESS, r.nonce)?.id).toBe(r.id);
        expect(store.nonceHolder(CONTRACT, USER_ADDRESS, `${r.nonce}0`)).toBeUndefined();
    });

    it('T32: (contract, signer, nonce) is unique among the requests that hold the nonce: duplicate vs conflict', () => {
        const r = newRequest();
        store.insertRequest(r, {});
        expect(store.insertRequest({ ...r }, {}).kind).toBe('duplicate');
        const conflict = store.insertRequest({ ...r, id: `0x${'b'.repeat(64)}`, fingerprint: `0x${'c'.repeat(64)}` }, {});
        expect(conflict.kind).toBe('conflict');
        // The same nonce for another signer is a different key; the same signer has a pending request.
        expect(store.insertRequest(newRequest({ nonce: r.nonce, signer: OTHER_ADDRESS }), {}).kind).toBe('inserted');
        expect(store.insertRequest(newRequest({ nonce: r.nonce, contract: OTHER_ADDRESS, reservation: undefined }), {})).toEqual({
            kind: 'sender_busy',
            reason: 'pending',
        });
    });

    it('a failed or expired request holds its nonce until it settles; then the sender may sign the nonce again', () => {
        const r = newRequest({ authorization: NO_AUTH, reservation: undefined });
        store.insertRequest(r, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(r.id, 0, attempt('0x01'), 1);
        const failure = { status: 'failed', error: { code: 'simulation_failed', message: 'x' } } as const;
        store.resolveFailed(
            r.id,
            failure,
            { kind: 'receipt', mined: { hash: '0x01', blockNumber: 5n, gasUsed: 1n, effectiveGasPrice: 1n }, attemptKind: 'call', callReverted: true },
            2,
        );
        expect(store.getRequest(r.id)).toMatchObject({ status: 'failed', settledAtMs: null });
        const again = newRequest({ nonce: r.nonce, authorization: NO_AUTH, reservation: undefined });
        // Unsettled: a reorg could still put the request back in flight (retryable sender_busy, not a conflict).
        expect(store.insertRequest(again, {})).toEqual({ kind: 'sender_busy', reason: 'nonce_unsettled' });
        expect(store.nonceHolder(CONTRACT, USER_ADDRESS, r.nonce)?.id).toBe(r.id);
        store.settle(r.id, 3);
        expect(store.nonceHolder(CONTRACT, USER_ADDRESS, r.nonce)).toBeUndefined();
        expect(store.insertRequest(again, {}).kind).toBe('inserted');
        expect(store.nonceHolder(CONTRACT, USER_ADDRESS, r.nonce)?.id).toBe(again.id);
        // The settled request is still answered by its id.
        expect(store.insertRequest(r, {}).kind).toBe('duplicate');
        // A mined (or confirmed) request holds its nonce for good.
        store.recordFirstAttempt(again.id, 1, attempt('0x02'), 4);
        store.markMined(again.id, { hash: '0x02', blockNumber: 6n, gasUsed: 1n, effectiveGasPrice: 1n }, 5);
        store.markConfirmed(again.id, 6);
        expect(store.insertRequest(newRequest({ nonce: r.nonce, authorization: NO_AUTH, reservation: undefined }), {}).kind).toBe('conflict');
    });

    it('nextNonceAfter: one above the highest nonce included after a block (by integer block order)', () => {
        const include = (nonce: string, block: bigint, txNonce: number): Hex => {
            const r = newRequest({ nonce, authorization: NO_AUTH, reservation: undefined });
            expect(store.insertRequest(r, {}).kind).toBe('inserted');
            store.setNextNonce(txNonce);
            store.recordFirstAttempt(r.id, txNonce, attempt(`0x${txNonce.toString(16).padStart(4, '0')}`), 1);
            store.markMined(r.id, { hash: `0x${txNonce.toString(16).padStart(4, '0')}` as Hex, blockNumber: block, gasUsed: 1n, effectiveGasPrice: 1n }, 2);
            return r.id;
        };
        expect(store.nextNonceAfter(CONTRACT, USER_ADDRESS, 0n)).toBeUndefined();
        include('0', 99n, 0);
        include('1', 100n, 1);
        const confirmed = include('2', 101n, 2);
        store.markConfirmed(confirmed, 3);
        expect(store.nextNonceAfter(CONTRACT, USER_ADDRESS, 98n)).toBe(3n);
        expect(store.nextNonceAfter(CONTRACT, USER_ADDRESS, 100n)).toBe(3n);
        expect(store.nextNonceAfter(CONTRACT, USER_ADDRESS, 101n)).toBeUndefined();
        expect(store.nextNonceAfter(CONTRACT, OTHER_ADDRESS, 0n)).toBeUndefined();
        expect(store.nextNonceAfter(OTHER_ADDRESS, USER_ADDRESS, 0n)).toBeUndefined();
        // Queued and in-flight requests are not inclusions.
        const pending = newRequest({ nonce: '3', authorization: NO_AUTH, reservation: undefined });
        store.insertRequest(pending, {});
        expect(store.nextNonceAfter(CONTRACT, USER_ADDRESS, 98n)).toBe(3n);
    });

    it('T32: enforces uniqueness and one pending request per signer in the database itself (not only in code)', () => {
        const r = newRequest();
        store.insertRequest(r, {});
        store.close();
        const raw = new Database(path);
        const insert = raw.prepare(
            `INSERT INTO requests (id, operation, contract, signer, nonce, fingerprint, request_json, auth_hash, auth_mode, token, fee, deadline, priority,
                status, settled_at, created_at, updated_at)
             VALUES (?, 'transfer', ?, ?, ?, 'x', '{}', '0x00', ?, ?, '0', '0', 0, ?, ?, 0, 0)`,
        );
        // The nonce is held: by a pending, mined or unsettled failed request.
        expect(() => insert.run('0xother', CONTRACT, USER3_ADDRESS, '5', 'none', null, 'mined', null)).not.toThrow();
        expect(() => insert.run('0xother2', CONTRACT, USER3_ADDRESS, '5', 'none', null, 'failed', null)).toThrow(/UNIQUE/);
        insert.run('0xf1', CONTRACT, OTHER_ADDRESS, '6', 'none', null, 'failed', 1);
        insert.run('0xf2', CONTRACT, OTHER_ADDRESS, '6', 'none', null, 'expired', 2);
        expect(() => insert.run('0xf3', CONTRACT, OTHER_ADDRESS, '6', 'none', null, 'failed', null)).not.toThrow();
        expect(() => insert.run('0xf4', CONTRACT, OTHER_ADDRESS, '6', 'none', null, 'mined', null)).toThrow(/UNIQUE/);
        // One queued or in-flight request per signer, whatever its nonce, token or mode.
        expect(() => insert.run('0xp1', CONTRACT, USER_ADDRESS, '77', 'none', null, 'queued', null)).toThrow(/UNIQUE/);
        expect(() => insert.run('0xp2', OTHER_ADDRESS, USER_ADDRESS, '78', 'none', null, 'submitted', null)).toThrow(/UNIQUE/);
        insert.run('0xp3', CONTRACT, USER_ADDRESS, '79', 'permit', USDC, 'mined', null);
        raw.prepare("UPDATE requests SET reopened_at = 1 WHERE id = '0xp3'").run();
        // A request a reorg put back in flight is exempt (from this index and from the token-authorization one).
        raw.prepare("UPDATE requests SET status = 'submitted' WHERE id = '0xp3'").run();
        // At most one pending PERMIT/META_TX request per (token, owner), besides a reopened one.
        insert.run('0xp4', CONTRACT, USER3_ADDRESS, '80', 'metaTxApprove', USDT0, 'queued', null);
        raw.close();
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
    });

    it('tokenUsage sums pending debits and reports token-signature requests as busy and pending NONE requests', () => {
        // One pending request per signer; a second one is a request a reorg put back in flight.
        const reopened = newRequest({ authorization: NO_AUTH, reservation: { token: USDC, spender: OTHER_ADDRESS, debit: 5n } });
        store.insertRequest(reopened, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(reopened.id, 0, attempt('0x01'), 1);
        store.markMined(reopened.id, { hash: '0x01', blockNumber: 5n, gasUsed: 1n, effectiveGasPrice: 1n }, 2);
        store.insertRequest(newRequest({ authorization: NO_AUTH }), {});
        store.reopen(reopened.id, 3);
        let usage = store.tokenUsage(USDC, USER_ADDRESS, CONTRACT);
        expect(usage).toEqual({ debits: 1_010_005n, noneDebits: 1_010_000n, busy: false, nonePending: true });
        // A NONE request for another spender does not use this spender's allowance.
        expect(store.tokenUsage(USDC, USER_ADDRESS, USDT0)).toEqual({ debits: 1_010_005n, noneDebits: 0n, busy: false, nonePending: false });
        store.insertRequest(newRequest({ signer: OTHER_ADDRESS, reservation: { token: USDT0, spender: CONTRACT, debit: 1_010_000n } }), {});
        usage = store.tokenUsage(USDT0, OTHER_ADDRESS, CONTRACT);
        expect(usage).toEqual({ debits: 1_010_000n, noneDebits: 0n, busy: true, nonePending: false });
        expect(store.tokenUsage(USDC, USER3_ADDRESS, CONTRACT)).toEqual({ debits: 0n, noneDebits: 0n, busy: false, nonePending: false });
    });

    it('with minedAfterBlock, tokenUsage also counts requests included after that block (step 9)', () => {
        const mine = (debit: bigint, block: bigint, mode: 'none' | 'permit' = 'none'): Hex => {
            const r = newRequest({
                authorization: mode === 'none' ? NO_AUTH : newRequest().authorization,
                reservation: { token: USDC, spender: CONTRACT, debit },
            });
            store.insertRequest(r, {});
            store.setNextNonce(Number(block));
            store.recordFirstAttempt(r.id, Number(block), attempt(`0x${block.toString(16).padStart(4, '0')}`), 1);
            store.markMined(r.id, { hash: `0x${block.toString(16).padStart(4, '0')}` as Hex, blockNumber: block, gasUsed: 1n, effectiveGasPrice: 1n }, 2);
            return r.id;
        };
        mine(1n, 99n);
        mine(10n, 100n);
        mine(100n, 101n, 'permit');
        const confirmed = mine(1000n, 250n);
        store.markConfirmed(confirmed, 3);
        store.insertRequest(newRequest({ authorization: NO_AUTH, reservation: { token: USDC, spender: CONTRACT, debit: 10_000n } }), {});
        // Without minedAfterBlock: pending requests only.
        expect(store.tokenUsage(USDC, USER_ADDRESS, CONTRACT)).toEqual({ debits: 10_000n, noneDebits: 10_000n, busy: false, nonePending: true });
        // A balance read at block 100 already reflects the requests included up to block 100. Block numbers
        // compare as integers, not as the text they are stored as: 99 is not after 100.
        expect(store.tokenUsage(USDC, USER_ADDRESS, CONTRACT, { minedAfterBlock: 100n })).toEqual({
            debits: 11_100n,
            noneDebits: 11_000n,
            // A permit request included after the block of the reads (101 > 100) is busy: its allowance change and
            // token nonce are not in those reads.
            busy: true,
            nonePending: true,
        });
        expect(store.tokenUsage(USDC, USER_ADDRESS, CONTRACT, { minedAfterBlock: 98n }).debits).toBe(11_111n);
        expect(store.tokenUsage(USDC, USER_ADDRESS, CONTRACT, { minedAfterBlock: 250n }).debits).toBe(10_000n);
        expect(store.tokenUsage(USDC, USER_ADDRESS, CONTRACT, { minedAfterBlock: 1000n }).debits).toBe(10_000n);
    });

    it('re-checks balance, allowance and sender_busy atomically when inserting', () => {
        // A NONE request included in block 10, after the block (9) that the submission's reads saw.
        const included = newRequest({ authorization: NO_AUTH });
        store.insertRequest(included, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(included.id, 0, attempt('0x01'), 1);
        store.markMined(included.id, { hash: '0x01', blockNumber: 10n, gasUsed: 1n, effectiveGasPrice: 1n }, 2);
        const seen = { observedBlock: 9n };
        expect(store.insertRequest(newRequest({ authorization: NO_AUTH }), { ...seen, observedBalance: 2_020_000n - 1n }).kind).toBe('insufficient_balance');
        expect(
            store.insertRequest(newRequest({ authorization: NO_AUTH }), { ...seen, observedBalance: 10n ** 9n, observedAllowance: 2_019_999n }).kind,
        ).toBe('insufficient_allowance');
        const plenty = { observedBalance: 10n ** 9n, observedAllowance: 10n ** 9n };
        expect(store.insertRequest(newRequest({ authorization: NO_AUTH }), plenty).kind).toBe('inserted');
        // A permit would overwrite the allowance the pending NONE request relies on.
        expect(store.insertRequest(newRequest(), plenty)).toEqual({ kind: 'sender_busy', reason: 'allowance_in_use' });
        // Any other request of the sender waits for its pending one.
        const usdt0 = { token: USDT0, spender: CONTRACT, debit: 1_010_000n };
        expect(store.insertRequest(newRequest({ authorization: NO_AUTH, reservation: usdt0 }), plenty)).toEqual({ kind: 'sender_busy', reason: 'pending' });
        expect(store.insertRequest(newRequest({ signer: OTHER_ADDRESS, reservation: usdt0 }), plenty).kind).toBe('inserted');
        expect(store.insertRequest(newRequest({ signer: OTHER_ADDRESS, reservation: usdt0 }), plenty)).toEqual({
            kind: 'sender_busy',
            reason: 'token_signature',
        });
        expect(store.insertRequest(newRequest({ signer: OTHER_ADDRESS, authorization: NO_AUTH, reservation: usdt0 }), plenty)).toEqual({
            kind: 'sender_busy',
            reason: 'token_signature',
        });
        expect(store.insertRequest(newRequest({ signer: OTHER_ADDRESS, authorization: NO_AUTH }), plenty)).toEqual({ kind: 'sender_busy', reason: 'pending' });
        expect(store.countRequests()).toBe(3);
    });

    it('admits one queued or in-flight request per sender and at most maxQueued in total, atomically', () => {
        const guards = { maxQueued: 3 };
        const none = (signer: Address = USER_ADDRESS): NewRequest => newRequest({ signer, authorization: NO_AUTH, reservation: undefined });
        const first = none();
        expect(store.insertRequest(first, guards).kind).toBe('inserted');
        expect(store.admissionCounts(USER_ADDRESS)).toEqual({ pendingOfSigner: 1, queued: 1 });
        expect(store.insertRequest(none(), guards)).toEqual({ kind: 'sender_busy', reason: 'pending' });
        // In flight counts as well; mined does not.
        store.setNextNonce(0);
        store.recordFirstAttempt(first.id, 0, attempt('0x01'), 1);
        expect(store.admissionCounts(USER_ADDRESS)).toEqual({ pendingOfSigner: 1, queued: 0 });
        expect(store.insertRequest(none(), guards)).toEqual({ kind: 'sender_busy', reason: 'pending' });
        store.markMined(first.id, { hash: '0x01', blockNumber: 5n, gasUsed: 1n, effectiveGasPrice: 1n }, 2);
        expect(store.insertRequest(none(), guards).kind).toBe('inserted');
        // Other senders fill the queue up to maxQueued; beyond it nothing is stored, whoever sends.
        for (const r of [none(OTHER_ADDRESS), none(USER3_ADDRESS)]) expect(store.insertRequest(r, guards).kind).toBe('inserted');
        expect(store.countByStatus('queued')).toBe(3);
        const before = store.countRequests();
        expect(store.insertRequest(none(signerAt(1)), guards)).toEqual({ kind: 'queue_full' });
        expect(store.insertRequest(none(CONTRACT), guards)).toEqual({ kind: 'queue_full' });
        expect(store.countRequests()).toBe(before);
        // An identical re-post is still answered from the stored row.
        expect(store.insertRequest(first, guards).kind).toBe('duplicate');
        // Without maxQueued there is no total bound; one pending request per sender holds regardless.
        expect(store.insertRequest(none(signerAt(2)), {}).kind).toBe('inserted');
        expect(store.insertRequest(none(signerAt(2)), {})).toEqual({ kind: 'sender_busy', reason: 'pending' });
    });

    describe('a held request gives way in a full queue', () => {
        const final = { status: 'failed', error: { code: 'fee_too_low', message: 'gave way to a request that pays the current price' } } as const;
        let senders = 0;
        const none = (overrides: Partial<NewRequest> = {}): NewRequest =>
            newRequest({ signer: signerAt(100 + ++senders), authorization: NO_AUTH, reservation: undefined, ...overrides });
        /** The queue is full at its current size. */
        const full = (candidates: ReadonlyArray<{ id: Hex; capPerGas: bigint }>) => ({
            maxQueued: store.countByStatus('queued'),
            evict: { candidates, final },
        });

        it('the held request with the lowest cap, and among equal caps the oldest, ends failed (final, secrets purged) in the insert transaction', () => {
            const [a, b, c, d] = [none(), none(), none(), none()];
            for (const r of [a, b, c, d]) expect(store.insertRequest(r, {}).kind).toBe('inserted');
            // Without a held request a full queue still refuses: nothing changes.
            expect(store.insertRequest(none(), full([]))).toEqual({ kind: 'queue_full' });
            expect(store.countRequests()).toBe(4);

            const e = none({ createdAtMs: 7777 });
            const out = store.insertRequest(e, full([{ id: b.id, capPerGas: 50n }, { id: c.id, capPerGas: 50n }, { id: d.id, capPerGas: 40n }]));
            expect(out.kind).toBe('inserted');
            expect(out.kind === 'inserted' ? out.evicted?.id : undefined).toBe(d.id);
            expect(store.getRequest(d.id)).toMatchObject({
                status: 'failed',
                error: final.error,
                signature: null,
                authorization: null,
                settledAtMs: 7777,
                pendingFinal: null,
                resolvedTxHash: null,
            });
            expect(store.getRequest(e.id)!.status).toBe('queued');
            expect(store.countByStatus('queued')).toBe(4);

            // Equal caps: the oldest (b before c), whatever the order of the candidates.
            const f = none();
            const second = store.insertRequest(f, full([{ id: c.id, capPerGas: 50n }, { id: b.id, capPerGas: 50n }]));
            expect(second.kind === 'inserted' ? second.evicted?.id : undefined).toBe(b.id);
            expect(store.getRequest(c.id)!.status).toBe('queued');
        });

        it('only a queued request that was never broadcast and has no higher priority than the new one gives way', () => {
            const [a, b, c] = [none(), none(), none()];
            const urgent = none({ priority: 10 });
            for (const r of [a, b, c, urgent]) expect(store.insertRequest(r, {}).kind).toBe('inserted');
            // b was broadcast once and requeued (its earlier transaction may still be included): not final at once.
            store.setNextNonce(0);
            store.recordFirstAttempt(b.id, 0, attempt('0x0b'), 1);
            store.requeue(b.id, 2);
            expect(store.getRequest(b.id)!.status).toBe('queued');
            // c is in flight.
            store.recordFirstAttempt(c.id, 1, attempt('0x0c'), 3);
            expect(store.getRequest(c.id)!.status).toBe('submitted');
            const ineligible = [
                { id: b.id, capPerGas: 1n },
                { id: c.id, capPerGas: 1n },
                { id: urgent.id, capPerGas: 1n },
                { id: `0x${'e'.repeat(64)}` as Hex, capPerGas: 1n }, // unknown
            ];
            const before = store.countRequests();
            expect(store.insertRequest(none(), full(ineligible))).toEqual({ kind: 'queue_full' });
            expect(store.countRequests()).toBe(before);
            for (const id of [b.id, urgent.id]) expect(store.getRequest(id)!.status).toBe('queued');
            // A normal request gives way to one of its own priority: a is chosen among the candidates.
            const out = store.insertRequest(none(), full([...ineligible, { id: a.id, capPerGas: 99n }]));
            expect(out.kind === 'inserted' ? out.evicted?.id : undefined).toBe(a.id);
            // An urgent new request may take the place of the held urgent one (same priority, the lowest cap).
            const urgentOut = store.insertRequest(none({ priority: 10 }), full(ineligible));
            expect(urgentOut.kind === 'inserted' ? urgentOut.evicted?.id : undefined).toBe(urgent.id);
        });

        it('a submission that another check refuses evicts nothing', () => {
            const [a, b] = [none(), none()];
            for (const r of [a, b]) expect(store.insertRequest(r, {}).kind).toBe('inserted');
            const candidates = [{ id: a.id, capPerGas: 1n }];
            // Its balance does not cover it (step 6 again at the insert).
            const poor = newRequest({ authorization: NO_AUTH, reservation: { token: USDC, spender: CONTRACT, debit: 1_010_000n } });
            expect(store.insertRequest(poor, { ...full(candidates), observedBalance: 1n, observedAllowance: 10n ** 9n }).kind).toBe('insufficient_balance');
            // A different request with the same nonce exists.
            expect(store.insertRequest({ ...none(), signer: b.signer, nonce: b.nonce }, full(candidates)).kind).toBe('conflict');
            // The sender has a pending request.
            expect(store.insertRequest({ ...none(), signer: b.signer }, full(candidates))).toEqual({ kind: 'sender_busy', reason: 'pending' });
            // An identical re-post.
            expect(store.insertRequest(b, full(candidates)).kind).toBe('duplicate');
            expect(store.getRequest(a.id)!.status).toBe('queued');
            expect(store.countByStatus('queued')).toBe(2);
        });
    });

    it('lists by status in priority, then insertion order', () => {
        const a = newRequest({ createdAtMs: 5 });
        const b = newRequest({ createdAtMs: 5, signer: OTHER_ADDRESS });
        const c = newRequest({ createdAtMs: 9, priority: 10, reservation: undefined, signer: USER3_ADDRESS });
        for (const r of [a, b, c]) store.insertRequest(r, {});
        expect(store.listByStatus('queued').map((r) => r.id)).toEqual([c.id, a.id, b.id]);
        expect(store.countByStatus('queued')).toBe(3);
    });
});

describe('transactions', () => {
    it('assigns tx nonces with compare-and-set, stores raw txs and purges secrets at the end', () => {
        const r = newRequest();
        store.insertRequest(r, {});
        store.setNextNonce(7);
        expect(() => store.recordFirstAttempt(r.id, 6, attempt('0x01'), 1)).toThrow(/next nonce/);
        store.recordFirstAttempt(r.id, 7, attempt('0x01'), 1);
        expect(store.getNextNonce()).toBe(8);
        expect(store.getRequest(r.id)).toMatchObject({ status: 'submitted', txNonce: 7 });
        expect(() => store.recordFirstAttempt(r.id, 8, attempt('0x02'), 1)).toThrow(/not queued/);
        store.recordReplacement(r.id, { ...attempt('0x02'), maxFeePerGas: 108n }, undefined, 2);
        const attempts = store.listAttempts(r.id);
        expect(attempts.map((a) => [a.hash, a.seq, a.txNonce, a.status])).toEqual([
            ['0x01', 1, 7, 'replaced'],
            ['0x02', 2, 7, 'pending'],
        ]);
        store.markMined(r.id, { hash: '0x02', blockNumber: 1234n, gasUsed: 100n, effectiveGasPrice: 60n }, 3);
        expect(store.getRequest(r.id)).toMatchObject({ status: 'mined', finalTxHash: '0x02', blockNumber: 1234n });
        expect(store.getRequest(r.id)!.signature).not.toBeNull(); // kept until final (reorgs)
        store.markConfirmed(r.id, 4);
        const done = store.getRequest(r.id)!;
        expect(done).toMatchObject({ status: 'confirmed', signature: null, authorization: null, confirmedAtMs: 4 });
        expect(store.listAttempts(r.id).every((a) => a.raw === null)).toBe(true);
    });

    it('each tx nonce belongs to one request', () => {
        const a = newRequest();
        const b = newRequest({ signer: OTHER_ADDRESS });
        store.insertRequest(a, {});
        store.insertRequest(b, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(a.id, 0, attempt('0x0a'), 1);
        store.setNextNonce(0);
        expect(() => store.recordFirstAttempt(b.id, 0, attempt('0x0b'), 1)).toThrow(/UNIQUE/);
    });

    it('finalize stores the reason, resolves attempts and purges signature, authorization and raw txs', () => {
        const r = newRequest({ authorization: { mode: 'metaTxApprove', v: 28, r: `0x${'44'.repeat(32)}`, s: `0x${'55'.repeat(32)}` } });
        store.insertRequest(r, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(r.id, 0, attempt('0x01'), 1);
        store.recordReplacement(r.id, { ...attempt('0x02'), kind: 'cancel' }, { status: 'expired', error: { code: 'deadline_out_of_range', message: 'late' } }, 2);
        expect(store.getRequest(r.id)!.pendingFinal).toEqual({ status: 'expired', error: { code: 'deadline_out_of_range', message: 'late' } });
        store.finalize(
            r.id,
            { status: 'expired', error: { code: 'deadline_out_of_range', message: 'late' } },
            { hash: '0x02', blockNumber: 5n, gasUsed: 21_000n, effectiveGasPrice: 1n, kind: 'cancel', callReverted: false },
            3,
        );
        const done = store.getRequest(r.id)!;
        expect(done).toMatchObject({
            status: 'expired',
            error: { code: 'deadline_out_of_range', message: 'late' },
            pendingFinal: null,
            signature: null,
            authorization: null,
            finalTxHash: null,
            blockNumber: null,
        });
        expect(store.listAttempts(r.id).map((a) => [a.status, a.raw])).toEqual([
            ['replaced', null],
            ['mined', null],
        ]);
    });

    it('requeue returns a request to the queue (its attempts stay); reorg returns a mined request to submitted', () => {
        const r = newRequest();
        store.insertRequest(r, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(r.id, 0, attempt('0x01'), 1);
        // A request whose tx nonce another transaction consumed is re-queued and gets a new tx nonce. Its earlier
        // attempts stay on record (as failed), so that any of them still resolves the request.
        store.requeue(r.id, 2);
        expect(store.getRequest(r.id)).toMatchObject({ status: 'queued', txNonce: null });
        expect(store.listAttempts(r.id).map((a) => [a.hash, a.txNonce, a.status])).toEqual([['0x01', 0, 'failed']]);
        expect(store.getNextNonce()).toBe(1);
        store.recordFirstAttempt(r.id, 1, attempt('0x03'), 3);
        expect(store.listAttempts(r.id).map((a) => [a.hash, a.seq, a.txNonce])).toEqual([
            ['0x01', 1, 0],
            ['0x03', 2, 1],
        ]);
        store.markMined(r.id, { hash: '0x03', blockNumber: 9n, gasUsed: 1n, effectiveGasPrice: 1n }, 4);
        store.reopen(r.id, 5);
        expect(store.getRequest(r.id)).toMatchObject({ status: 'submitted', finalTxHash: null, blockNumber: null });
        expect(store.listAttempts(r.id).map((a) => [a.hash, a.status])).toEqual([
            ['0x01', 'failed'],
            ['0x03', 'pending'],
        ]);
        expect(store.listAttempts(r.id)[1]).toMatchObject({ status: 'pending', raw: attempt('0x03').raw });
    });
});


describe('gas budget retention', () => {
    it('keeps the maximum per relay nonce after request pruning and reopen', () => {
        const r = newRequest();
        store.insertRequest(r, {});
        store.setNextNonce(0);
        store.recordFirstAttempt(r.id, 0, attempt('0x01'), 1);
        store.recordReplacement(r.id, { ...attempt('0x02'), maxFeePerGas: 100n }, undefined, 2);
        expect(store.reserveGasExposure(0, 25_000_000n, 25_000_000n)).toBe(true);
        store.close();
        store = SqliteStore.open(path);
        expect(store.gasExposureWei()).toBe(25_000_000n);
        expect(store.reserveGasExposure(0, 24_000_000n, 25_000_000n)).toBe(true);
        expect(store.reserveGasExposure(1, 1n, 25_000_000n)).toBe(false);
        store.finalize(r.id, { status: 'failed', error: { code: 'simulation_failed', message: 'test' } }, undefined, 3);
        expect(store.pruneSettled(4)).toBe(1);
        expect(store.listAttempts(r.id)).toHaveLength(0);
        store.close();
        store = SqliteStore.open(path);
        expect(store.gasExposureWei()).toBe(25_000_000n);
        expect(store.reserveGasExposure(1, 1n, 25_000_000n)).toBe(false);
    });
});
