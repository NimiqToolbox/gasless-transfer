// Every package in the relay's deployed closure must be exactly a version that pnpm-lock.yaml records.
//
// docker/relay.Dockerfile builds the production closure with
// `pnpm deploy --legacy`, which resolves the relay's dependencies again instead of copying the lockfile's
// resolution. Today it arrives at the locked versions, but a release published after the lockfile was written
// (within a dependency's semver range) could otherwise enter the image unreviewed, without the lockfile's
// integrity hashes and without the minimum release age. This check makes such a build fail instead.
//
// For each package directory in <root>/node_modules/.pnpm it reads the package's own package.json (name and
// version) and requires `name@version` among the keys of the lockfile's `packages:` section. Workspace
// packages (linked from the repository, e.g. the SDK) are skipped: they are built from the checked-out source.
//   node lockedClosure.mjs /out /build/pnpm-lock.yaml
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [root = '/app', lockfile = 'pnpm-lock.yaml'] = process.argv.slice(2);
const store = join(root, 'node_modules', '.pnpm');

/** `name@version` keys of the lockfile's top-level `packages:` section (lockfile v9). */
function lockedPackages(text) {
    const keys = new Set();
    let inPackages = false;
    for (const line of text.split('\n')) {
        if (/^\S/.test(line)) inPackages = line.trimEnd() === 'packages:';
        if (!inPackages) continue;
        const match = /^ {2}'?((?:@[^@/\s']+\/)?[^@\s']+)@([^\s'():]+)'?:\s*$/.exec(line);
        if (match) keys.add(`${match[1]}@${match[2]}`);
    }
    return keys;
}

/** The package name of a virtual store entry: `@scope+name@1.2.3_peer@4.5.6` → `@scope/name`. */
function nameOf(entry) {
    const at = entry.indexOf('@', 1);
    return at < 0 ? undefined : entry.slice(0, at).replace('+', '/');
}

const locked = lockedPackages(readFileSync(lockfile, 'utf8'));
if (locked.size === 0) throw new Error(`no packages found in ${lockfile}`);

const unlocked = [];
let checked = 0;
for (const entry of readdirSync(store)) {
    const name = nameOf(entry);
    if (name === undefined) continue; // lock.yaml, node_modules
    if (/@(file|link)\+/.test(entry)) continue; // a workspace package, built from source
    const manifest = join(store, entry, 'node_modules', name, 'package.json');
    if (!existsSync(manifest)) {
        unlocked.push(`${entry} (no ${name}/package.json)`);
        continue;
    }
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (pkg.name !== name || !locked.has(key)) unlocked.push(`${entry}: ${key} is not in ${lockfile}`);
    checked += 1;
}
if (checked === 0) throw new Error(`no packages found in ${store}`);
if (unlocked.length > 0) {
    console.error(`packages outside the lockfile:\n  ${unlocked.join('\n  ')}`);
    process.exit(1);
}
console.log(`ok   ${checked} packages match ${lockfile}`);
