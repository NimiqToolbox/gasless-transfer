import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { backupState } from './backup-state.mjs';

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'relay-backup-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, 'source.sqlite');
    const db = new Database(source);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE schema_migrations (version INTEGER); INSERT INTO schema_migrations VALUES (5);
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO kv VALUES ('chain_id', '137'), ('relay', '0x1234'), ('gas_exposure_wei', '9999999999999999999');
        CREATE TABLE transactions (raw TEXT); INSERT INTO transactions VALUES ('sensitive signed transaction');`);
    db.close();
    return { dir, source, destination: join(dir, 'backup') };
}

test('backup is restorable, preserves exact exposure and pending material, has restrictive modes and a matching hash', async (t) => {
    const { source, destination } = fixture(t);
    const receipt = await backupState(source, destination);
    const bytes = readFileSync(join(destination, 'relay.sqlite'));
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(receipt.identity.gas_exposure_wei, '9999999999999999999');
    assert.equal(statSync(destination).mode & 0o777, 0o700);
    assert.equal(statSync(join(destination, 'relay.sqlite')).mode & 0o777, 0o600);
    assert.equal(statSync(join(destination, 'manifest.json')).mode & 0o777, 0o600);
    const restored = new Database(join(destination, 'relay.sqlite'));
    assert.equal(restored.prepare('SELECT raw FROM transactions').get().raw, 'sensitive signed transaction');
    restored.close();
});

test('recovers committed WAL after a crash rather than losing the latest state', async (t) => {
    const { source, destination } = fixture(t);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import Database from 'better-sqlite3';
        const db = new Database(process.argv[1]);
        db.pragma('wal_autocheckpoint = 0');
        db.prepare("UPDATE kv SET value = '123456789123456789123456789' WHERE key = 'gas_exposure_wei'").run();
        process.exit(0);
    `, source], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(statSync(`${source}-wal`).size > 0);
    const receipt = await backupState(source, destination);
    assert.equal(receipt.identity.gas_exposure_wei, '123456789123456789123456789');
});

test('refuses a live exclusive writer', async (t) => {
    const { source, destination } = fixture(t);
    const writer = new Database(source);
    writer.pragma('locking_mode = EXCLUSIVE');
    writer.exec('BEGIN EXCLUSIVE; COMMIT;');
    try { await assert.rejects(backupState(source, destination), { code: 'SQLITE_BUSY' }); }
    finally { writer.close(); }
});

test('never overwrites an existing destination and rejects symlink sources', async (t) => {
    const { source, destination, dir } = fixture(t);
    writeFileSync(destination, 'operator data');
    await assert.rejects(backupState(source, destination), { code: 'EEXIST' });
    assert.equal(readFileSync(destination, 'utf8'), 'operator data');
    const link = join(dir, 'link.sqlite');
    symlinkSync(source, link);
    await assert.rejects(backupState(link, join(dir, 'second')), /regular database file/);
});
