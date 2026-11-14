// Runs once before the integration files: checks the chain tools of the toolchain image, compiles the
// contracts (each file's `forge script` then reuses the build) and builds the relay's dist/ for the
// tests that run the production entrypoint as a child process.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CONTRACTS_DIR, RELAY_DIR } from './helpers/stack.js';

function run(file: string, args: readonly string[], cwd: string): void {
    try {
        execFileSync(file, args, { cwd, stdio: 'pipe' });
    } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer };
        throw new Error(`${file} ${args.join(' ')} failed:\n${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`);
    }
}

export default function setup(): void {
    for (const tool of ['anvil', 'forge']) {
        try {
            execFileSync(tool, ['--version'], { stdio: 'ignore' });
        } catch {
            throw new Error(`${tool} is not available: run the integration tests in the verification image (make test-contained, docs/DEVELOPMENT.md)`);
        }
    }
    if (!existsSync(`${CONTRACTS_DIR}/lib/openzeppelin-contracts`)) {
        throw new Error('contracts/lib (the pinned Solidity libraries, docs/dependencies.md) is missing');
    }
    run('forge', ['build'], CONTRACTS_DIR);
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], RELAY_DIR);
}
