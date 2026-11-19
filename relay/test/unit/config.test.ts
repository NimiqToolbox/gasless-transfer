import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAINLINK_POL_USD_POLYGON, POLYGON_USDC, POLYGON_USDT0 } from '@nimiq/gasless-sdk/core';
import {
    ConfigError,
    checkGasTableCoverage,
    loadConfig,
    loadDeploymentFile,
    loadGasTableFile,
    parseDeployment,
    parseGasTable,
    privateKeyFileToRemove,
    readPrivateKeyFile,
    removePrivateKeyFile,
} from '../../src/config.js';
import { DEFAULT_TX_POLICY } from '../../src/tx/settings.js';
import { RELAY_VERSION } from '../../src/version.js';
import { CONTRACT, USDC, USDT0, deploymentJson } from '../helpers/harness.js';
import { RELAY_KEY } from '../helpers/keys.js';

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-config-'));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const baseEnv = {
    RELAY_RPC_URLS: 'http://anvil:8545',
    RELAY_DEPLOYMENT_FILE: '/app/deployments/137.json',
    RELAY_PRIVATE_KEY_FILE: '/run/secrets/relay_key',
    // No RELAY_POLUSD_FALLBACK: the relay refuses a static price (the fee always comes from the Chainlink feed).
};

describe('environment', () => {
    it('uses a finite aggregate gas budget and rejects disabled, malformed or negative budgets', () => {
        expect(loadConfig(baseEnv).tx.totalGasBudgetWei).toBe(10n ** 18n);
        expect(loadConfig({ ...baseEnv, RELAY_TOTAL_GAS_BUDGET_POL: '0.125' }).tx.totalGasBudgetWei).toBe(125_000_000_000_000_000n);
        for (const value of ['0', '-1', 'off', '1e9', '0.0000000000000000001']) {
            expect(() => loadConfig({ ...baseEnv, RELAY_TOTAL_GAS_BUDGET_POL: value })).toThrow(/RELAY_TOTAL_GAS_BUDGET_POL/);
        }
    });

    it('applies the documented defaults', () => {
        const c = loadConfig(baseEnv);
        expect(c).toMatchObject({
            host: '0.0.0.0',
            port: 8080,
            rpcUrls: ['http://anvil:8545'],
            rpcTimeoutMs: 5000,
            gasTableFile: 'config/gasTable.json',
            dbPath: 'data/relay.sqlite',
            logLevel: 'info',
            // A limit per signer and a relay-wide limit of the submissions that read the chain; none by client address.
            rateLimit: { signerMax: 10, signerWindowMs: 60_000, submitMax: 120, submitWindowMs: 60_000 },
            priceFeed: 'default',
            feeMarginBps: 1000,
            minPolBalanceWei: 10n ** 18n,
            recipientDenylist: [],
        });
        expect(c.tx).toMatchObject({
            speedUpAfterBlocks: 10,
            speedUpPercent: 20,
            minTip: 30_000_000_000n,
            maxFeePerGas: 3_000_000_000_000n,
            maxInFlight: 4,
            reservedPrioritySlots: 1,
        });
    });

    it('parses lists, feed and gwei values', () => {
        const c = loadConfig({
            ...baseEnv,
            RELAY_RPC_URLS: 'https://a.example/rpc, https://b.example/rpc',
            RELAY_POLUSD_FEED: CHAINLINK_POL_USD_POLYGON,
            RELAY_MIN_TIP_GWEI: '25.5',
            RELAY_RECIPIENT_DENYLIST: USDC.toLowerCase(),
            RELAY_MIN_POL_BALANCE: '0.5',
        });
        expect(c.rpcUrls).toEqual(['https://a.example/rpc', 'https://b.example/rpc']);
        expect(c.priceFeed).toBe(CHAINLINK_POL_USD_POLYGON);
        expect(c.tx.minTip).toBe(25_500_000_000n);
        expect(c.recipientDenylist).toEqual([USDC]);
        expect(c.minPolBalanceWei).toBe(5n * 10n ** 17n);
        // A price feed is required: `none` would leave the relay without a price for its fees.
        expect(() => loadConfig({ ...baseEnv, RELAY_POLUSD_FEED: 'none' })).toThrow(/RELAY_POLUSD_FEED must be "default" or a feed address/);
    });

    it('reads the alert settings: a warning level at or above the minimum, an https webhook URL that is never echoed', () => {
        const defaults = loadConfig({ ...baseEnv, RELAY_MIN_POL_BALANCE: '0.25' });
        expect(defaults.alertPolBalanceWei).toBe(5n * 10n ** 17n);
        expect(defaults.alertWebhookUrl).toBeUndefined();

        const url = 'https://hooks.example/services/FAKE_TOKEN';
        const set = loadConfig({ ...baseEnv, RELAY_MIN_POL_BALANCE: '0.25', RELAY_ALERT_POL_BALANCE: '2', RELAY_ALERT_WEBHOOK_URL: url });
        expect(set.alertPolBalanceWei).toBe(2n * 10n ** 18n);
        expect(set.alertWebhookUrl).toBe(url);
        expect(set.unreadVariables).toEqual([]);
        expect(loadConfig({ ...baseEnv, RELAY_MIN_POL_BALANCE: '0.25', RELAY_ALERT_POL_BALANCE: '0.25' }).alertPolBalanceWei).toBe(25n * 10n ** 16n);

        expect(() => loadConfig({ ...baseEnv, RELAY_MIN_POL_BALANCE: '0.25', RELAY_ALERT_POL_BALANCE: '0.2' })).toThrow(/must not be below RELAY_MIN_POL_BALANCE/);
        expect(() => loadConfig({ ...baseEnv, RELAY_ALERT_POL_BALANCE: '-1' })).toThrow(/RELAY_ALERT_POL_BALANCE must be a decimal POL amount/);
        for (const bad of ['http://hooks.example/services/FAKE_TOKEN', 'hooks.example/FAKE_TOKEN', 'wss://hooks.example/FAKE_TOKEN']) {
            const load = (): unknown => loadConfig({ ...baseEnv, RELAY_ALERT_WEBHOOK_URL: bad });
            expect(load).toThrow(/^RELAY_ALERT_WEBHOOK_URL must be an https URL$/);
            expect(load).not.toThrow(/FAKE_TOKEN/);
        }
        for (const bad of ['https://user:FAKE_TOKEN@hooks.example/services', 'https://FAKE_TOKEN@hooks.example/services']) {
            const load = (): unknown => loadConfig({ ...baseEnv, RELAY_ALERT_WEBHOOK_URL: bad });
            expect(load).toThrow(/^RELAY_ALERT_WEBHOOK_URL must not contain a user name or password$/);
            expect(load).not.toThrow(/FAKE_TOKEN/);
        }
    });

    it('names missing or invalid variables and never echoes RPC URLs', () => {
        for (const name of Object.keys(baseEnv)) {
            const env: Record<string, string> = { ...baseEnv };
            delete env[name];
            expect(() => loadConfig(env)).toThrow(name);
        }
        let message = '';
        try {
            loadConfig({ ...baseEnv, RELAY_RPC_URLS: 'wss://user:SECRETKEY@node.example' });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('RELAY_RPC_URLS');
        expect(message).not.toContain('SECRETKEY');
        expect(() => loadConfig({ ...baseEnv, RELAY_PORT: 'abc' })).toThrow(ConfigError);
        expect(() => loadConfig({ ...baseEnv, RELAY_POLUSD_FEED: '0x123' })).toThrow(/RELAY_POLUSD_FEED/);
        expect(() => loadConfig({ ...baseEnv, RELAY_RECIPIENT_DENYLIST: 'nope' })).toThrow(/DENYLIST/);
        expect(() => loadConfig({ ...baseEnv, RELAY_LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
        expect(() => loadConfig({ ...baseEnv, RELAY_MAX_IN_FLIGHT: '2', RELAY_RESERVED_PRIORITY_SLOTS: '2' })).toThrow(/RESERVED/);
    });

    it('passes the transaction policy settings (relay/src/tx/settings.ts) through, as ConfigError when invalid', () => {
        expect(loadConfig(baseEnv).tx).toMatchObject(DEFAULT_TX_POLICY);
        const c = loadConfig({ ...baseEnv, RELAY_MAX_COST_PERCENT_OF_FEE: '150', RELAY_MIN_FINALITY_DEPTH: '32', RELAY_REQUEST_RETENTION_DAYS: '7' });
        expect(c.tx).toMatchObject({ maxCostPercentOfFee: 150, minFinalityDepth: 32, requestRetentionMs: 7 * 24 * 3600 * 1000 });
        expect(() => loadConfig({ ...baseEnv, RELAY_MAX_COST_PERCENT_OF_FEE: '99' })).toThrow(ConfigError);
        expect(() => loadConfig({ ...baseEnv, RELAY_NONCE_GAP_BLOCKS: 'x' })).toThrow(/RELAY_NONCE_GAP_BLOCKS/);
    });

    // Any value is refused, plausible or not: an operator who sets a static price must learn at startup that the
    // relay does not use it.
    it('refuses RELAY_POLUSD_FALLBACK (static price fallbacks are unsupported)', () => {
        for (const value of ['0.01', '10', '0.009', '10.00000001', '-1', '1e-2', 'abc', '0.123456789']) {
            expect(() => loadConfig({ ...baseEnv, RELAY_POLUSD_FALLBACK: value }), value).toThrow(/RELAY_POLUSD_FALLBACK/);
        }
        expect(() => loadConfig({ ...baseEnv, RELAY_POLUSD_FALLBACK: '0.2' })).toThrow(ConfigError);
    });
});

describe('private key file', () => {
    it('reads a 32-byte hex key with or without 0x and surrounding whitespace', () => {
        const file = join(dir, 'key');
        writeFileSync(file, `${RELAY_KEY}\n`);
        expect(readPrivateKeyFile(file)).toBe(RELAY_KEY);
        writeFileSync(file, `  ${RELAY_KEY.slice(2).toUpperCase()}  `);
        expect(readPrivateKeyFile(file)).toBe(RELAY_KEY);
    });

    it('rejects invalid content without echoing it', () => {
        const file = join(dir, 'key');
        for (const content of [`${RELAY_KEY}00`, 'not a key', `${RELAY_KEY}\n${RELAY_KEY}`, `0x${'0'.repeat(64)}`, `0x${'f'.repeat(64)}`]) {
            writeFileSync(file, content);
            let message = '';
            try {
                readPrivateKeyFile(file);
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toMatch(/RELAY_PRIVATE_KEY_FILE/);
            expect(message).not.toContain(RELAY_KEY.slice(2, 20));
            expect(message).not.toContain('not a key');
        }
        expect(() => readPrivateKeyFile(join(dir, 'missing'))).toThrow(/ENOENT/);
    });
});

describe('deployment file', () => {
    it('parses the contracts deployment format and normalizes addresses', () => {
        const json = deploymentJson() as Record<string, unknown> & { tokens: Array<Record<string, unknown>> };
        const d = parseDeployment({
            ...json,
            gaslessTransfer: CONTRACT.toLowerCase(),
            initialOwner: USDC,
            // The SDK's record format allows the expected separator of a token domain.
            tokens: [{ ...json.tokens[0], domainSeparator: POLYGON_USDC.domainSeparator.toUpperCase().replace('0X', '0x') }, json.tokens[1]],
            deployBlock: 94_421_000,
        });
        expect(d.chainId).toBe(137);
        expect(d.gaslessTransfer).toBe(CONTRACT);
        expect(d.deployBlock).toBe(94_421_000n);
        expect(d.tokens.map((t) => [t.symbol, t.kind, t.address, t.authModes])).toEqual([
            ['USDC', 'usdc', USDC, ['permit', 'none']],
            ['USDT0', 'usdt0', USDT0, ['permit', 'metaTxApprove', 'none']],
        ]);
        for (const t of d.tokens) expect(Object.keys(t).sort()).toEqual(['address', 'authModes', 'decimals', 'domain', 'kind', 'symbol']);
        expect(d.tokens[1]!.domain).toEqual(POLYGON_USDT0.domain);
        const file = join(dir, '137.json');
        writeFileSync(file, JSON.stringify(json));
        expect(loadDeploymentFile(file)).toEqual(parseDeployment(json));
    });

    it('accepts Solidity enum names and numeric auth modes', () => {
        const json = deploymentJson() as { tokens: Array<Record<string, unknown>> };
        json.tokens[0]!.authModes = ['PERMIT', 'NONE'];
        json.tokens[1]!.authModes = [1, 2, 0];
        const d = parseDeployment(json);
        expect(d.tokens[0]!.authModes).toEqual(['permit', 'none']);
        expect(d.tokens[1]!.authModes).toEqual(['permit', 'metaTxApprove', 'none']);
    });

    it('rejects inconsistent deployments', () => {
        const variants: Array<(j: Record<string, unknown> & { tokens: Array<Record<string, unknown>> }) => void> = [
            (j) => void delete j.version,
            (j) => void (j.version = '1'),
            (j) => void (j.version = '2'),
            (j) => void (j.version = 3),
            // Exact keys, as in the SDK's pinsFromDeployment: an unknown key is refused, whatever its value.
            (j) => void (j.tokens[0]!.maxFee = '5000000'),
            (j) => void (j.tokens[1]!.maxFee = undefined),
            (j) => void (j.maxFee = '5000000'),
            (j) => void (j.extra = 'x'),
            (j) => void (j.tokens[1]!.extra = 1),
            (j) => void (j.tokens[0]!.domainSeparator = POLYGON_USDT0.domainSeparator), // not the hash of the USDC domain
            (j) => void (j.tokens[0]!.domainSeparator = '0x1234'),
            (j) => void (j.gaslessTransfer = '0x5fbdb2315678afecb367f032d93F642f64180aa3'), // bad checksum
            (j) => void (j.tokens = []),
            (j) => void (j.tokens = [j.tokens[0]!, j.tokens[0]!]),
            (j) => void (j.tokens[0]!.authModes = ['permit', 'metaTxApprove']),
            (j) => void (j.tokens[0]!.authModes = ['permit', 'permit']),
            (j) => void (j.tokens[0]!.authModes = ['bogus']),
            (j) => void (j.tokens[0]!.decimals = 18),
            (j) => void (j.tokens[0]!.symbol = 'DAI'),
            (j) => void (j.tokens[0]!.domain = { ...(j.tokens[0]!.domain as object), chainId: 1 }),
            (j) => void (j.tokens[0]!.domain = { ...(j.tokens[0]!.domain as object), verifyingContract: USDT0 }),
            (j) => void (j.tokens[0]!.domain = { ...(j.tokens[0]!.domain as object), extra: 1 }),
            (j) => void (j.tokens[1]!.domain = { ...(j.tokens[1]!.domain as object), salt: `0x${'0'.repeat(63)}1` }),
            (j) => void (j.tokens[1]!.domain = { name: 'USDT0', version: '1', verifyingContract: USDT0 }),
        ];
        for (const mutate of variants) {
            const json = JSON.parse(JSON.stringify(deploymentJson())) as Record<string, unknown> & { tokens: Array<Record<string, unknown>> };
            mutate(json);
            expect(() => parseDeployment(json)).toThrow(ConfigError);
        }
        const file = join(dir, 'bad.json');
        writeFileSync(file, '{not json');
        expect(() => loadDeploymentFile(file)).toThrow(/not valid JSON/);
    });

    // Wallets and the relay must agree on a record: the SDK's pinsFromDeployment refuses the same values.
    it('refuses a malformed token domainSeparator or initialOwner, as the SDK does', () => {
        const separators = [null, 0, 12345, true, {}, [POLYGON_USDC.domainSeparator], '', POLYGON_USDC.domainSeparator.replace('0x', '0X')];
        for (const domainSeparator of separators) {
            const json = deploymentJson() as Record<string, unknown> & { tokens: Array<Record<string, unknown>> };
            json.tokens[0]!.domainSeparator = domainSeparator;
            expect(() => parseDeployment(json), JSON.stringify(domainSeparator)).toThrow(/tokens\.0\.domainSeparator/);
        }
        for (const initialOwner of [null, 7, '', 'not-an-address', {}, [USDC], '0x5fbdb2315678afecb367f032d93F642f64180aa3']) {
            expect(() => parseDeployment({ ...deploymentJson(), initialOwner }), JSON.stringify(initialOwner)).toThrow(/initialOwner/);
        }
        // Accepted by both: an owner in lowercase, a separator in upper-case hex digits.
        const json = deploymentJson() as Record<string, unknown> & { tokens: Array<Record<string, unknown>> };
        json.initialOwner = USDC.toLowerCase();
        json.tokens[0]!.domainSeparator = `0x${POLYGON_USDC.domainSeparator.slice(2).toUpperCase()}`;
        expect(parseDeployment(json).tokens).toHaveLength(2);
    });

    it('names the version a record has instead of "3", and a key it does not know', () => {
        const json = deploymentJson() as Record<string, unknown> & { tokens: Array<Record<string, unknown>> };
        delete json.version;
        const file = join(dir, 'other.json');
        writeFileSync(file, JSON.stringify(json));
        expect(() => loadDeploymentFile(file)).toThrow(/invalid deployment file: version must be "3", not missing/);
        json.version = '2';
        expect(() => parseDeployment(json)).toThrow(/invalid deployment file: version must be "3", not "2"$/);
        json.version = '3';
        json.tokens[1]!.maxFee = '5000000';
        expect(() => parseDeployment(json)).toThrow(/invalid deployment file: tokens\.1: Unrecognized key: "maxFee"/);
        delete json.tokens[1]!.maxFee;
        expect(parseDeployment(json).tokens).toHaveLength(2);
    });
});

describe('gas table', () => {
    it('the shipped gas table holds the Polygon-calibrated values and covers every token mode', () => {
        const table = loadGasTableFile(join(import.meta.dirname, '../../config/gasTable.json'));
        // Calibrated with Polygon RPC state overrides; Anvil gas measurements must not replace these values.
        expect(table).toEqual({
            source: 'polygon-rpc-state-overrides@94503409;ceil5000',
            margin: 0.1,
            operations: { transfer: { permit: 280_000, metaTxApprove: 280_000, none: 210_000 } },
        });
        checkGasTableCoverage(table, parseDeployment(deploymentJson()));
    });

    it('validates the format and coverage', () => {
        expect(() => parseGasTable({ source: 'x', margin: 0.1, operations: { transfer: { permit: 100 } } })).toThrow(ConfigError);
        expect(() => parseGasTable({ source: 'x', margin: 2, operations: {} })).toThrow(ConfigError);
        expect(() => parseGasTable({ source: 'x', margin: 0.1, operations: { transfer: { permit: 100_000, bogus: 1 } } })).toThrow(ConfigError);
        const partial = parseGasTable({ source: 'x', margin: 0.1, operations: { transfer: { permit: 100_000, none: 100_000 } } });
        expect(() => checkGasTableCoverage(partial, parseDeployment(deploymentJson()))).toThrow(/metaTxApprove/);
    });
});

it('RELAY_VERSION matches relay/package.json', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string };
    expect(RELAY_VERSION).toBe(pkg.version);
});

// The variables every start needs besides RELAY_RPC_URLS, which the tests below set themselves.
const BASE = { RELAY_DEPLOYMENT_FILE: '/deployment.json', RELAY_PRIVATE_KEY_FILE: '/key' };
const withRpcs = (urls: string) => () => loadConfig({ ...BASE, RELAY_RPC_URLS: urls });

describe('RELAY_RPC_URLS', () => {
    it('accepts distinct RPCs, also the same provider with another path or key', () => {
        expect(loadConfig({ ...BASE, RELAY_RPC_URLS: 'https://a.example/v2/key-1, https://a.example/v2/key-2,https://b.example' }).rpcUrls)
            .toEqual(['https://a.example/v2/key-1', 'https://a.example/v2/key-2', 'https://b.example']);
    });

    it.each([
        'https://a.example/v2/secret-key,https://a.example/v2/secret-key',
        'https://a.example/v2/secret-key,https://A.EXAMPLE:443/v2/secret-key',
        'http://b.example,https://a.example/v2/secret-key,http://b.example/',
    ])('refuses an RPC listed twice (%s), naming entries, not URLs', (urls) => {
        const load = withRpcs(urls);
        expect(load).toThrow(ConfigError);
        expect(load).toThrow(/^RELAY_RPC_URLS entry #[23] repeats entry #1; list each RPC once$/);
        try {
            load();
        } catch (err) {
            expect((err as Error).message).not.toMatch(/example|secret/i);
        }
    });

    it('refuses an entry that is not an http(s) URL without echoing it', () => {
        expect(withRpcs('https://a.example,ws://secret.example')).toThrow(/^RELAY_RPC_URLS entry #2 is not an http\(s\) URL$/);
        expect(withRpcs('https://[secret')).toThrow(/^RELAY_RPC_URLS entry #1 is not an http\(s\) URL$/);
    });
});

describe('RELAY_PRIVATE_KEY_FILE_REMOVE', () => {
    let dir: string | undefined;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it('is off by default and accepts only true or false', () => {
        const env = { ...BASE, RELAY_RPC_URLS: 'http://rpc.invalid' };
        expect(loadConfig(env).privateKeyFileRemove).toBe(false);
        expect(loadConfig({ ...env, RELAY_PRIVATE_KEY_FILE_REMOVE: 'false' }).privateKeyFileRemove).toBe(false);
        expect(loadConfig({ ...env, RELAY_PRIVATE_KEY_FILE_REMOVE: 'true' }).privateKeyFileRemove).toBe(true);
        expect(() => loadConfig({ ...env, RELAY_PRIVATE_KEY_FILE_REMOVE: 'yes' })).toThrow('RELAY_PRIVATE_KEY_FILE_REMOVE must be true or false');
    });

    it('privateKeyFileToRemove reads the two variables as loadConfig does, without the rest of the configuration', () => {
        const env = { ...BASE, RELAY_RPC_URLS: 'http://rpc.invalid' };
        for (const [variables, file] of [
            [{}, undefined],
            [{ RELAY_PRIVATE_KEY_FILE_REMOVE: 'false' }, undefined],
            [{ RELAY_PRIVATE_KEY_FILE_REMOVE: ' ' }, undefined],
            [{ RELAY_PRIVATE_KEY_FILE_REMOVE: 'true' }, '/key'],
            [{ RELAY_PRIVATE_KEY_FILE: ' /run/key\n', RELAY_PRIVATE_KEY_FILE_REMOVE: ' true ' }, '/run/key'],
        ] as const) {
            const config = loadConfig({ ...env, ...variables });
            expect(config.privateKeyFileRemove ? config.privateKeyFile : undefined).toBe(file);
            // The answer needs no other variable: none of those loadConfig requires is set here.
            expect(privateKeyFileToRemove({ RELAY_PRIVATE_KEY_FILE: BASE.RELAY_PRIVATE_KEY_FILE, ...variables })).toBe(file);
        }
        expect(privateKeyFileToRemove({ RELAY_PRIVATE_KEY_FILE_REMOVE: 'true' })).toBeUndefined();
        expect(privateKeyFileToRemove({ RELAY_PRIVATE_KEY_FILE: ' ', RELAY_PRIVATE_KEY_FILE_REMOVE: 'true' })).toBeUndefined();
        // A value that is neither true nor false names no file: it is refused, as loadConfig refuses it.
        const unclear = (): unknown => privateKeyFileToRemove({ ...BASE, RELAY_PRIVATE_KEY_FILE_REMOVE: 'yes' });
        expect(unclear).toThrow(ConfigError);
        expect(unclear).toThrow('RELAY_PRIVATE_KEY_FILE_REMOVE must be true or false');
    });

    it('deletes the key file, and stops startup when it cannot, without naming the path', () => {
        dir = mkdtempSync(join(tmpdir(), 'relay-config-test-'));
        const path = join(dir, 'key');
        writeFileSync(path, `0x${'11'.repeat(32)}`, { mode: 0o600 });
        removePrivateKeyFile(path);
        expect(existsSync(path)).toBe(false);
        expect(() => removePrivateKeyFile(path)).toThrow(/^RELAY_PRIVATE_KEY_FILE could not be removed \(ENOENT\)/);
    });
});

describe('variables the relay does not use', () => {
    const env = { ...BASE, RELAY_RPC_URLS: 'http://rpc.invalid' };

    it('refuses the key itself in the environment, without echoing it', () => {
        const key = `0x${'11'.repeat(32)}`;
        const load = (): unknown => loadConfig({ ...env, RELAY_PRIVATE_KEY: key });
        expect(load).toThrow(/^RELAY_PRIVATE_KEY must not be set for the relay process/);
        expect(load).not.toThrow(key);
    });

    it('names RELAY_ variables that are set but never read, and nothing else', () => {
        expect(loadConfig(env).unreadVariables).toEqual([]);
        const config = loadConfig({
            ...env,
            RELAY_RECIPIENT_DENY_LIST: '0x0000000000000000000000000000000000000001', // misspelt RELAY_RECIPIENT_DENYLIST
            RELAY_MAX_COST_PERCENT_OF_FEE: '150', // read by the transaction-manager policy
            PLATFORM_SERVICE_NAME: 'relay', // not a relay variable
        });
        expect(config.unreadVariables).toEqual(['RELAY_RECIPIENT_DENY_LIST']);
        expect(config.recipientDenylist).toEqual([]);
    });

    it('names RELAY_OPS_HOST when RELAY_OPS_PORT=off leaves it without effect', () => {
        expect(loadConfig({ ...env, RELAY_OPS_PORT: 'off', RELAY_OPS_HOST: '0.0.0.0' }).unreadVariables).toEqual(['RELAY_OPS_HOST']);
        expect(loadConfig({ ...env, RELAY_OPS_HOST: '0.0.0.0' }).unreadVariables).toEqual([]);
    });
});
