// Source-level guarantees: the SDK never logs or persists anything (META_TX approvals never expire
// and must not end up in logs or storage, §5), and the core has zero runtime dependencies.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? sources(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [],
    );
}

describe('SDK sources', () => {
    const files = sources(srcRoot);

    it('found the sources', () => {
        expect(files.length).toBeGreaterThan(20);
    });

    it('never log and never persist (no console, storage, cookies or IndexedDB)', () => {
        for (const file of files) {
            const code = readFileSync(file, 'utf8');
            expect(code, path.relative(srcRoot, file)).not.toMatch(/\bconsole\s*\.|localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open/);
        }
    });

    it('core imports only its own modules', () => {
        for (const file of files.filter((f) => f.includes(`${path.sep}core${path.sep}`))) {
            const code = readFileSync(file, 'utf8');
            for (const match of code.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
                const specifier = match[1];
                expect(specifier, `${path.relative(srcRoot, file)} imports ${specifier}`).toMatch(/^\.\/[A-Za-z0-9]+\.js$/);
            }
        }
    });

    it('relay/ does not import viem', () => {
        for (const file of files.filter((f) => f.includes(`${path.sep}relay${path.sep}`))) {
            expect(readFileSync(file, 'utf8'), file).not.toMatch(/from\s+['"]viem/);
        }
    });
});
