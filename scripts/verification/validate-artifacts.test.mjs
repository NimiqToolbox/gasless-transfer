import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const validator = fileURLToPath(new URL('./validate-artifacts.mjs', import.meta.url));
const root = '/tmp/export';
const label = 'run-1-2';
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync('/tmp/artifact-hardlink-source', { force: true }); });
const run = (kind) => spawnSync(process.execPath, [validator, kind, label], { encoding: 'utf8' });
function file(path, value = 'report') {
    mkdirSync(`${root}/${path.substring(0, path.lastIndexOf('/'))}`, { recursive: true });
    writeFileSync(`${root}/${path}`, value);
}

test('accepts only the declared complete ABI set', () => {
    file('sdk/abi/GaslessTransfer.json', '[]');
    assert.notEqual(run('abi').status, 0);
    file('sdk/src/core/abi.ts', 'export const gaslessTransferAbi = [] as const;');
    assert.equal(run('abi').status, 0);
    file('sdk/src/core/unexpected.ts');
    assert.notEqual(run('abi').status, 0);
});
test('admits the current versioned report tree, rejecting other runs', () => {
    file(`build/static/${label}/report.txt`);
    assert.equal(run('static').status, 0);
    assert.equal(statSync(`${root}/build/static/${label}/report.txt`).mode & 0o777, 0o644);
    file('build/static/run-9-9/report.txt');
    assert.notEqual(run('static').status, 0);
});
test('rejects symlink traversal even beneath an allowed report tree', () => {
    file(`build/static/${label}/report.txt`);
    symlinkSync('/work', `${root}/build/static/${label}/escape`);
    assert.notEqual(run('static').status, 0);
});
test('rejects hardlinks and empty report trees', () => {
    mkdirSync(`${root}/build/static/${label}`, { recursive: true });
    assert.notEqual(run('static').status, 0);
    writeFileSync('/tmp/artifact-hardlink-source', 'data');
    linkSync('/tmp/artifact-hardlink-source', `${root}/build/static/${label}/linked`);
    assert.notEqual(run('static').status, 0);
});
