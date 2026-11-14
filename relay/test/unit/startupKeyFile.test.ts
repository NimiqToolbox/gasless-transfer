// The key file at startup (startServer). With RELAY_PRIVATE_KEY_FILE_REMOVE it is a temporary copy of the key, and a
// start must not leave it behind: neither when it accepted the content nor when it refused it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';
import { startServer } from '../../src/server.js';
import { captureLogger } from '../helpers/harness.js';
import { RELAY_KEY } from '../helpers/keys.js';

const REMOVE = { RELAY_PRIVATE_KEY_FILE_REMOVE: 'true' };
const NOT_ONE_KEY = 'RELAY_PRIVATE_KEY_FILE must contain exactly one 32-byte hex private key';

let dir: string;
let keyFile: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-startup-key-'));
    keyFile = join(dir, 'relay.key');
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/**
 * The error startServer stops with, and what it logged. No start here gets past its files: after the key it reads the
 * deployment file, which does not exist.
 */
async function failedStart(env: Record<string, string> = {}): Promise<{ message: string; logs: string }> {
    const config = loadConfig({
        RELAY_RPC_URLS: 'http://rpc.invalid',
        RELAY_DEPLOYMENT_FILE: join(dir, 'deployment.json'),
        RELAY_PRIVATE_KEY_FILE: keyFile,
        ...env,
    });
    const captured = captureLogger();
    const error: unknown = await startServer(config, captured.logger).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConfigError);
    return { message: (error as Error).message, logs: captured.text() };
}

describe('RELAY_PRIVATE_KEY_FILE_REMOVE at startup', () => {
    it.each([
        ['a key that lost its last digit', RELAY_KEY.slice(0, -1), NOT_ONE_KEY],
        ['text', 'not-a-key secret-material', NOT_ONE_KEY],
        ['the zero key', `0x${'0'.repeat(64)}`, 'RELAY_PRIVATE_KEY_FILE does not contain a valid secp256k1 key'],
    ])('a key file whose content is refused (%s) is deleted; the start fails as it does without the setting', async (_what, content, message) => {
        writeFileSync(keyFile, content, { mode: 0o600 });
        const kept = await failedStart();
        expect(kept.message).toBe(message);
        expect(existsSync(keyFile)).toBe(true);

        const removed = await failedStart(REMOVE);
        expect(removed.message).toBe(message);
        expect(existsSync(keyFile)).toBe(false);
        expect(removed.logs).not.toContain(content);
    });

    it('an accepted key file is deleted before another file can stop the start', async () => {
        writeFileSync(keyFile, `${RELAY_KEY}\n`, { mode: 0o600 });
        const { message } = await failedStart(REMOVE);
        expect(message).toMatch(/^deployment file .+ could not be read \(ENOENT\)$/);
        expect(existsSync(keyFile)).toBe(false);
    });

    it('a key file that can be neither read nor deleted: the start fails with the read error, and the log says that the file stayed', async () => {
        mkdirSync(keyFile);
        const { message, logs } = await failedStart(REMOVE);
        expect(message).toBe('RELAY_PRIVATE_KEY_FILE could not be read (EISDIR)');
        expect(logs).toMatch(/RELAY_PRIVATE_KEY_FILE could not be removed \(E[A-Z]+\) although RELAY_PRIVATE_KEY_FILE_REMOVE is true/);
        expect(existsSync(keyFile)).toBe(true);
    });
});
