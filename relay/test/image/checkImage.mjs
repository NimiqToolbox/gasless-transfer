// Checks a relay runtime image (docker/relay.Dockerfile) from the inside, with the
// image's own node and no shell. docker/check-image-contained.sh bakes this file into a check image and runs it
// (make relay-image-check).
// Runs as node (uid 1000; the script checks the image's declared user); no setuid/setgid binary; no package manager
// front end; nothing that uid/gid 1000 may write outside /data and /tmp. better-sqlite3 carries node-gyp's record
// of a source build against the build stage's copy of this image's Node headers (config.gypi:
// build_from_source, nodedir /opt/node-headers), its ObjectWrap has no environment cleanup hooks (see
// docker/relay.Dockerfile), garbage collection of statements outside a JavaScript context does not
// abort, no binary downloader is in the closure, and the addon loads. Prints an inventory and exits 1
// if any check fails.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const failures = [];
const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
};

/** Every path under `dir` (not following symlinks), except the pseudo filesystems and the writable mounts. */
function walk(dir, visit) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (['/proc', '/sys', '/dev', '/data', '/tmp'].includes(path)) continue;
        let st;
        try {
            st = lstatSync(path);
        } catch {
            continue;
        }
        visit(path, st);
        if (st.isDirectory()) walk(path, visit);
    }
}

/**
 * Whether the image's user (uid and gid 1000) may write the path by its owner and mode. Judged from the inode, not by
 * access(): this check runs on a read-only root filesystem, where access() refuses every path, while a deployment
 * without one has only the owner and mode in the way. A path the user owns counts whatever its mode: the
 * owner can give itself the write permission.
 */
const writableByNode = (st) => st.uid === 1000 || (st.mode & 0o002) !== 0 || (st.gid === 1000 && (st.mode & 0o020) !== 0);

const setId = [];
const writable = [];
walk('/', (path, st) => {
    if (st.isFile() && (st.mode & 0o6000) !== 0) setId.push(path);
    if (!st.isSymbolicLink() && writableByNode(st)) writable.push(path);
});

const searchPath = (process.env.PATH ?? '').split(':');
const found = (tool) => searchPath.some((dir) => existsSync(join(dir, tool)));
const managers = ['apt', 'apt-get', 'dpkg', 'npm', 'npx', 'corepack', 'yarn', 'pnpm'].filter(found);
const compilers = ['gcc', 'g++', 'cc', 'make', 'python3', 'tsc'].filter(found);

check(process.getuid() === 1000 && process.getgid() === 1000, `runs as node (uid ${process.getuid()}, gid ${process.getgid()})`);
check(setId.length === 0, `no setuid/setgid binaries${setId.length ? `: ${setId.join(', ')}` : ''}`);
check(managers.length === 0, `no package manager front ends${managers.length ? `: ${managers.join(', ')}` : ''}`);
check(compilers.length === 0, `no compilers or build tools${compilers.length ? `: ${compilers.join(', ')}` : ''}`);
check(writable.length === 0, `nothing writable outside /data and /tmp${writable.length ? `: ${writable.slice(0, 10).join(', ')}` : ''}`);

const store = '/app/node_modules/.pnpm';
const packages = readdirSync(store);
check(!packages.some((p) => p.startsWith('prebuild-install@')), 'no prebuild-install (binary downloader) in the closure');
check(!packages.some((p) => p.startsWith('typescript@')), 'no TypeScript compiler in the closure');

const sqlite = packages.find((p) => p.startsWith('better-sqlite3@'));
const build = join(store, sqlite, 'node_modules/better-sqlite3/build');
const gypi = existsSync(join(build, 'config.gypi')) ? readFileSync(join(build, 'config.gypi'), 'utf8') : '';
check(/"build_from_source":\s*"true"/.test(gypi), `${sqlite}: node-gyp config.gypi records build_from_source=true`);
check(/"nodedir":\s*"\/opt\/node-headers"/.test(gypi), `${sqlite}: compiled against the build stage's copy of the image's Node headers (nodedir /opt/node-headers)`);
const addon = readFileSync(join(build, 'Release/better_sqlite3.node'));
console.log(`     better_sqlite3.node: ${addon.length} bytes, sha256 ${createHash('sha256').update(addon).digest('hex')}`);
check(!addon.toString('latin1').includes('RemoveEnvironmentCleanupHook'), `${sqlite}: ObjectWrap without environment cleanup hooks`);
const Database = (await import(join(store, sqlite, 'node_modules/better-sqlite3/lib/index.js'))).default;
const db = new Database(':memory:');
check(typeof db.prepare('SELECT sqlite_version() AS v').get().v === 'string', 'the compiled addon loads and runs SQL');
db.close();

// Garbage Statement objects collected by V8's own GC tasks (outside any JavaScript context), as in the
// long-running relay; same as relay/test/image/sqliteGcStress.cjs, which the image build runs.
const stress = `
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE t (a INTEGER)');
let rounds = 0;
const timer = setInterval(() => {
    for (let i = 0; i < 2000; i++) db.prepare('SELECT a FROM t WHERE a = ?').all(i);
    const garbage = [];
    for (let i = 0; i < 20000; i++) garbage.push({ i, s: 'x'.repeat(32) });
    if (++rounds === 300) { clearInterval(timer); db.close(); }
}, 10);`;
const gc = spawnSync(process.execPath, ['-e', stress], { cwd: '/app', encoding: 'utf8', timeout: 120_000 });
check(gc.status === 0, `garbage collection of statements outside a JavaScript context does not abort (exit ${gc.status ?? gc.signal})`);

console.log(failures.length === 0 ? 'image checks passed' : `${failures.length} image check(s) failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
