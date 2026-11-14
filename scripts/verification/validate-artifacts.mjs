// Validate the exact export allowlist before the Docker-only host runner copies it. No symlinks, hardlinks,
// devices, sockets, or unexpected files may escape into the workspace. Generated reports use fresh run names.
import { chmodSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [kind, label] = process.argv.slice(2);
if (!/^run-\d+-\d+$/.test(label ?? '')) throw new Error('Invalid artifact label');
const exact = kind === 'abi' ? ['sdk/abi/GaslessTransfer.json', 'sdk/src/core/abi.ts'] : kind === 'lock' ? ['pnpm-lock.yaml'] : [];
const tree = ['deps', 'static', 'coverage', 'mutation', 'mutation-smoke'].includes(kind) ? `build/${kind}/${label}` : undefined;
if (!exact.length && !tree) throw new Error('Invalid artifact kind');
const seen = new Set();
function visit(relative = '') {
    const absolute = join('/tmp/export', relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
        throw new Error(`Unsafe artifact type: ${relative}`);
    }
    const roots = tree ? [tree] : exact;
    const allowed = relative === '' || roots.some((p) => p === relative || p.startsWith(`${relative}/`) || (tree && relative.startsWith(`${tree}/`)));
    if (!allowed) throw new Error(`Unexpected artifact: ${relative}`);
    if (stat.isDirectory()) {
        chmodSync(absolute, 0o755);
        for (const name of readdirSync(absolute)) visit(relative ? `${relative}/${name}` : name);
    } else {
        chmodSync(absolute, 0o644);
        seen.add(relative);
    }
}
visit();
for (const path of exact) if (!seen.has(path)) throw new Error(`Missing artifact: ${path}`);
if (tree && ![...seen].some((p) => p.startsWith(`${tree}/`))) throw new Error('Empty artifact result');
if (kind === 'abi') JSON.parse(readFileSync('/tmp/export/sdk/abi/GaslessTransfer.json', 'utf8'));
console.log(`Validated ${seen.size} artifact files for ${kind}`);
