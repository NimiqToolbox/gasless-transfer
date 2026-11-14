// The zero-dependency core bundles, in particular the browser IIFE global NimiqGaslessCore. Two builds give
// byte-identical files, so a published bundle can be reproduced from the sources, and the core bundles (with the
// shared chunks the ESM core imports) contain no network, timer, messaging or code-evaluation API: the core never
// talks to anything.
//
// test/dist.test.ts runs the core's exports and options inside the IIFE global.
//
// The builds run in a temporary copy of the package, so they cannot race with test/dist.test.ts and
// test/security/signing/pinMismatch.test.ts, which build and read sdk/dist.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sdkRoot = fileURLToPath(new URL('../../..', import.meta.url));
const repoRoot = path.dirname(sdkRoot);

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    );
}

/** The files of an ESM entry: the entry and every chunk it imports, transitively. */
function esmClosure(entry: string): string[] {
    const seen = new Set<string>();
    const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const code = readFileSync(file, 'utf8');
        for (const [, specifier] of code.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*["']([^"']+)["']/g)) {
            if (specifier?.startsWith('.')) visit(path.resolve(path.dirname(file), specifier));
        }
    };
    visit(entry);
    return [...seen];
}

const FORBIDDEN =
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\beval\s*\(|new\s+Function\b|\bFunction\s*\(|setTimeout|setInterval|postMessage|navigator\.|\/work\/|\/tmp\//;

describe('core bundles are reproducible and talk to nothing', () => {
    let tmp: string;
    let pkg: string;
    let dist: string;

    /** Runs the package build (tsup.config.ts, as `pnpm build`) from scratch; sha256 of every file in dist/. */
    function build(): Record<string, string> {
        rmSync(dist, { recursive: true, force: true });
        execFileSync(path.join(sdkRoot, 'node_modules', '.bin', 'tsup'), [], { cwd: pkg, stdio: 'pipe' });
        return Object.fromEntries(
            files(dist)
                .sort()
                .map((file) => [path.relative(dist, file), createHash('sha256').update(readFileSync(file)).digest('hex')]),
        );
    }

    beforeAll(() => {
        tmp = mkdtempSync(path.join(os.tmpdir(), 'sdk-build-'));
        pkg = path.join(tmp, 'sdk');
        dist = path.join(pkg, 'dist');
        cpSync(path.join(sdkRoot, 'src'), path.join(pkg, 'src'), { recursive: true });
        for (const file of ['package.json', 'tsconfig.json', 'tsup.config.ts']) cpSync(path.join(sdkRoot, file), path.join(pkg, file));
        cpSync(path.join(repoRoot, 'tsconfig.base.json'), path.join(tmp, 'tsconfig.base.json'));
        symlinkSync(path.join(sdkRoot, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
    });

    afterAll(() => {
        if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    });

    it('two builds are byte-identical (every file in dist/)', () => {
        const first = build();
        expect(Object.keys(first)).toContain(path.join('core', 'index.global.js'));
        expect(build()).toEqual(first);
    }, 180_000);

    it('the core bundles use no network, timer, messaging or code-evaluation API and embed no build path', () => {
        build();
        const core = [path.join(dist, 'core', 'index.global.js'), path.join(dist, 'core', 'index.cjs'), ...esmClosure(path.join(dist, 'core', 'index.js'))];
        for (const file of core) expect(readFileSync(file, 'utf8'), path.relative(dist, file)).not.toMatch(FORBIDDEN);
        // The relay entry is where fetch lives; the pattern does find it there.
        expect(readFileSync(path.join(dist, 'relay', 'index.js'), 'utf8')).toMatch(/\bfetch\b/);
    }, 180_000);
});
