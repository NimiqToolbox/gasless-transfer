// A relay database belongs to one chain, one relay key and one GaslessTransfer deployment. The store pins all three
// (SqliteStore.bindIdentity) and refuses to be used for another deployment: recovery would otherwise encode and
// interpret the stored requests against a contract they were not signed for. A database that names no deployment yet
// is adopted only if every request in it is for the configured contract, and keeps its tx nonce and gas exposure.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../../src/store/sqliteStore.js';
import { CONTRACT, USDC } from '../../helpers/harness.js';
import { OTHER_ADDRESS, RELAY_ADDRESS, USER_ADDRESS } from '../../helpers/keys.js';

let dir: string;
let path: string;
let store: SqliteStore;
const identity = { chainId: 137, relay: RELAY_ADDRESS, gaslessTransfer: CONTRACT };
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deployment-binding-'));
    path = join(dir, 'relay.sqlite');
    store = SqliteStore.open(path);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A database bound to the chain and relay but to no deployment, with a request for `contract` if given. */
function unpinned(contract?: string) {
    const db = (store as unknown as { db: Database.Database }).db;
    db.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run('chain_id', '137');
    db.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run('relay', RELAY_ADDRESS);
    if (contract) db.prepare(`INSERT INTO requests
        (id, operation, contract, signer, nonce, fingerprint, request_json, auth_hash, auth_mode, token, spender, debit,
        fee, deadline, priority, status, created_at, updated_at)
        VALUES ('0x01','transfer',?,?,'1','0x01','{}','0x02','none',?,?,'1','0','2000000000',0,'queued',0,0)`)
        .run(contract, USER_ADDRESS, USDC, contract);
}

describe('durable deployment identity', () => {
    it('refuses another transfer deployment on the same chain and signer after restart', () => {
        store.bindIdentity(identity);
        store.close();
        store = SqliteStore.open(path);
        store.bindIdentity(identity); // legitimate restart
        const other = { ...identity, gaslessTransfer: OTHER_ADDRESS };
        expect(() => store.bindIdentity(other)).toThrow(/refusing/);
    });
    it('refuses adoption of a database without a pinned deployment that has requests for another deployment', () => {
        unpinned(OTHER_ADDRESS);
        expect(() => store.bindIdentity(identity)).toThrow(/refusing/);
    });
    it('adopts a matching database without a pinned deployment without losing its nonce and gas exposure', () => {
        unpinned(CONTRACT.toLowerCase());
        store.setNextNonce(7);
        store.reserveGasExposure(6, 123n, 1000n);
        store.bindIdentity(identity);
        expect(store.getNextNonce()).toBe(7);
        expect(store.gasExposureWei()).toBe(123n);
        expect(store.getRequest('0x01')?.status).toBe('queued');
        const other = { ...identity, gaslessTransfer: OTHER_ADDRESS };
        expect(() => store.bindIdentity(other)).toThrow(/refusing/);
    });
    it('pins the deployment of an empty database on its first verified startup', () => {
        unpinned();
        store.bindIdentity(identity);
        const other = { ...identity, gaslessTransfer: OTHER_ADDRESS };
        expect(() => store.bindIdentity(other)).toThrow(/refusing/);
    });
});
