// Every package in the relay runtime image must be reachable from its entrypoint.
//
// docker/relay.Dockerfile removes prebuild-install (better-sqlite3's binary downloader, used only at
// install time) and TypeScript (an optional peer of viem, used only for types) from the production closure.
// Removing prebuild-install alone leaves the packages that only it needed: its HTTP client and tarball
// extractor (simple-get, tar-fs, tar-stream, ...), its config reader (rc) and the rest of its tree, about 30
// packages that nothing can load: dead code in the image that holds the relay key.
//
// This script walks the dependency graph from <root>/package.json (each dependency is resolved the way
// Node resolves it: the node_modules entry next to the dependent package, then the directories above) and
// lists every package in <root>/node_modules/.pnpm that it cannot reach. Exit status 1 if there is one.
// With --prune it deletes them instead, with every symbolic link that then points nowhere; the build stage
// of docker/relay.Dockerfile runs it that way on the deployed closure, then checks the result:
//   node closureOrphans.mjs /out --prune
// make relay-image-check runs the check inside the image (root /app), like checkImage.mjs
// (docker/check-image-contained.sh bakes both into a check image).
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '-');
const prune = args.includes('--prune');
const APP = args.find((a) => !a.startsWith('--')) ?? '/app';
const MODULES = join(APP, 'node_modules');
const STORE = join(MODULES, '.pnpm');

/** Every package directory stored in the virtual store (real directories, not the symlinks between them), by store entry. */
const stored = new Map();
for (const entry of readdirSync(STORE)) {
    const modules = join(STORE, entry, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
        const scoped = name.startsWith('@') ? readdirSync(join(modules, name)).map((s) => join(name, s)) : [name];
        for (const n of scoped) {
            const dir = join(modules, n);
            if (!lstatSync(dir).isSymbolicLink() && existsSync(join(dir, 'package.json'))) stored.set(dir, join(STORE, entry));
        }
    }
}

/** The real directory of `dep` as seen from package directory `from` (Node's lookup through node_modules). */
function resolveFrom(from, dep) {
    for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
        const candidate = join(dir, 'node_modules', dep);
        if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
        if (dir.endsWith(`${sep}node_modules`)) {
            // Inside a store entry: the dependency is a sibling of the package.
            const sibling = join(dir, dep);
            if (existsSync(join(sibling, 'package.json'))) return realpathSync(sibling);
        }
    }
    return undefined;
}

const reachable = new Set();
const missing = new Set();
const queue = [realpathSync(APP)];
while (queue.length > 0) {
    const dir = queue.pop();
    if (reachable.has(dir)) continue;
    reachable.add(dir);
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys({ ...pj.dependencies, ...pj.optionalDependencies, ...pj.peerDependencies })) {
        const target = resolveFrom(dir, dep);
        if (target) queue.push(target);
        else if (!pj.peerDependencies?.[dep] && !pj.optionalDependencies?.[dep]) missing.add(`${pj.name} -> ${dep}`);
    }
}

const orphans = [...stored.keys()].filter((dir) => !reachable.has(realpathSync(dir)));
const label = (dir) => relative(STORE, dir).split(`${sep}node_modules${sep}`)[1];
console.log(`${stored.size} packages in the closure, ${reachable.size - 1} reachable from ${APP}/package.json`);
if (missing.size > 0) console.log(`     (not resolvable, probably removed on purpose: ${[...missing].join(', ')})`);

if (prune) {
    // A store entry holds one package and links to its dependencies: an unreachable package goes with its entry.
    for (const dir of orphans) rmSync(stored.get(dir), { recursive: true, force: true });
    let links = 0;
    const removeDangling = (dir) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            const st = lstatSync(path);
            if (st.isSymbolicLink()) {
                let target = true;
                try {
                    statSync(path);
                } catch {
                    target = false;
                }
                if (!target) {
                    rmSync(path);
                    links += 1;
                }
            } else if (st.isDirectory()) {
                removeDangling(path);
            }
        }
    };
    removeDangling(MODULES);
    console.log(`pruned ${orphans.length} unreachable packages (${orphans.map(label).sort().join(', ') || 'none'}) and ${links} dangling links`);
} else if (orphans.length === 0) {
    console.log('ok   no unreachable packages');
} else {
    console.log(`FAIL ${orphans.length} packages that nothing in the relay can load:\n     ${orphans.map(label).sort().join('\n     ')}`);
    process.exitCode = 1;
}
