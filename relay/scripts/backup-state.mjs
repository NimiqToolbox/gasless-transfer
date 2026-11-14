// Run with the SAME relay image, after stopping its writer. No key is opened, no RPC is used.
import { createReadStream, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const sync = (path) => {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
};

export async function backupState(source, destination) {
    process.umask(0o077);
    const input = resolve(source);
    const output = resolve(destination);
    if (!lstatSync(input).isFile()) throw new Error('source must be a regular database file, not a symlink');
    const db = new Database(input, { fileMustExist: true, timeout: 1000 });
    try {
        // The relay holds this lock throughout its lifetime. Fail rather than copy its live WAL.
        db.pragma('locking_mode = EXCLUSIVE');
        db.exec('BEGIN EXCLUSIVE; COMMIT;');
        if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('source integrity check failed');
        // Require a relay schema; never migrate or reset state as part of a backup.
        const schema = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
        const identity = Object.fromEntries(db.prepare(
            "SELECT key, value FROM kv WHERE key IN ('chain_id', 'relay', 'gasless_transfer', 'gas_exposure_wei') ORDER BY key",
        ).all().map(({ key, value }) => [key, value]));
        if (!identity.chain_id || !identity.relay) throw new Error('source has no bound relay identity');
        mkdirSync(output, { mode: 0o700 }); // Refuse an existing destination, including symlinks.
        const file = join(output, 'relay.sqlite');
        await db.backup(file);
        const copy = new Database(file, { readonly: true, fileMustExist: true });
        try {
            if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup integrity check failed');
        } finally { copy.close(); }
        sync(file);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        const receipt = {
            format: 1, createdAt: new Date().toISOString(), schema, identity,
            file: 'relay.sqlite', sha256: hash.digest('hex'),
            caution: 'Sensitive plaintext. Encrypt before off-device storage. This receipt cannot prove that this is the latest state.',
        };
        const manifest = join(output, 'manifest.json');
        writeFileSync(manifest, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        sync(manifest);
        sync(output);
        sync(dirname(output));
        return receipt;
    } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.length !== 4) {
        console.error('Usage: node scripts/backup-state.mjs /data/relay.sqlite /backup/NEW-directory');
        process.exitCode = 2;
    } else {
        try {
            const receipt = await backupState(process.argv[2], process.argv[3]);
            console.log(JSON.stringify({ status: 'complete', schema: receipt.schema, sha256: receipt.sha256 }));
        } catch (error) {
            console.error(`Backup failed: ${error.code ?? error.message}. Do not use a partial destination.`);
            process.exitCode = 1;
        }
    }
}
