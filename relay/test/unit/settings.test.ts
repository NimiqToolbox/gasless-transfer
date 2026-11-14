// Operational settings: the internal listener, HTTP server limits, the validation deadline, the bounds of the
// queue and the cool-down per sender, the readiness cache, the monitor intervals, the priority fee floors, finality
// depths and deadline windows, and the warning about a private key file that other users can read.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGwei } from 'viem';
import { AMOY_CHAIN_ID, POLYGON_CHAIN_ID } from '@nimiq/gasless-sdk/core';
import {
    ConfigError,
    DEFAULT_HTTP_LIMITS,
    checkChainSettings,
    loadConfig,
    maxMinSecondsToBroadcast,
    maxValidationTimeoutMs,
    privateKeyFileMode,
} from '../../src/config.js';
import { warnIfKeyFileExposed } from '../../src/server.js';
import { captureLogger } from '../helpers/harness.js';
import { RELAY_KEY } from '../helpers/keys.js';

const baseEnv = {
    RELAY_RPC_URLS: 'http://anvil:8545',
    RELAY_DEPLOYMENT_FILE: '/app/deployments/137.json',
    RELAY_PRIVATE_KEY_FILE: '/run/secrets/relay_key',
    // No RELAY_POLUSD_FALLBACK: the relay refuses a static price (Chainlink pricing is required).
};

describe('listeners, HTTP limits, readiness cache and monitors', () => {
    it('defaults: internal listener on 127.0.0.1:9464, server limits, 5 s readiness cache, 60 s monitor intervals', () => {
        const c = loadConfig(baseEnv);
        expect(c.ops).toEqual({ host: '127.0.0.1', port: 9464 });
        expect(c.http).toEqual(DEFAULT_HTTP_LIMITS);
        expect(c.http).toEqual({
            requestTimeoutMs: 15_000,
            // A connection that has not sent its headers after 5 s is closed.
            headersTimeoutMs: 5_000,
            keepAliveTimeoutMs: 10_000,
            idleTimeoutMs: 60_000,
            maxConnections: 1024,
        });
        expect(c.validationTimeoutMs).toBe(10_000);
        // A sender whose request failed for a reason it caused cools down for 600 s.
        expect(c.admission).toEqual({ maxQueued: 100, maxRetainedRequests: 100_000, preflightCooldownMs: 600_000 });
        expect(c.readinessCacheMs).toBe(5000);
        expect(c.tokenDomainCheckMs).toBe(60_000);
    });

    it('parses the overrides, `off` for the internal listener and 0 for the monitor intervals', () => {
        const c = loadConfig({
            ...baseEnv,
            RELAY_OPS_HOST: '0.0.0.0',
            RELAY_OPS_PORT: '9100',
            RELAY_HTTP_REQUEST_TIMEOUT_MS: '5000',
            RELAY_HTTP_KEEP_ALIVE_TIMEOUT_MS: '2000',
            RELAY_HTTP_MAX_CONNECTIONS: '64',
            RELAY_READINESS_CACHE_MS: '0',
            RELAY_TOKEN_DOMAIN_CHECK_SECONDS: '0',
        });
        expect(c.ops).toEqual({ host: '0.0.0.0', port: 9100 });
        // The headers must arrive within the request timeout as well.
        expect(c.http).toEqual({
            requestTimeoutMs: 5000,
            headersTimeoutMs: 5000,
            keepAliveTimeoutMs: 2000,
            idleTimeoutMs: 60_000,
            maxConnections: 64,
        });
        expect(c.readinessCacheMs).toBe(0);
        expect(c.tokenDomainCheckMs).toBe(0);
        expect(loadConfig({ ...baseEnv, RELAY_OPS_PORT: 'off' }).ops).toBeNull();
        expect(loadConfig({ ...baseEnv, RELAY_OPS_PORT: '0' }).ops).toEqual({ host: '127.0.0.1', port: 0 });
        expect(loadConfig({ ...baseEnv, RELAY_HTTP_REQUEST_TIMEOUT_MS: '2000' }).http.headersTimeoutMs).toBe(2000);
    });

    it('rejects out-of-range values', () => {
        for (const [name, value] of [
            ['RELAY_OPS_PORT', '65536'],
            ['RELAY_OPS_PORT', 'on'],
            ['RELAY_HTTP_REQUEST_TIMEOUT_MS', '0'],
            ['RELAY_HTTP_REQUEST_TIMEOUT_MS', '999'],
            ['RELAY_HTTP_KEEP_ALIVE_TIMEOUT_MS', '0'],
            ['RELAY_HTTP_MAX_CONNECTIONS', '0'],
            ['RELAY_VALIDATION_TIMEOUT_MS', '999'],
            ['RELAY_VALIDATION_TIMEOUT_MS', '55001'],
            ['RELAY_MAX_QUEUED', '0'],
            ['RELAY_PREFLIGHT_COOLDOWN_SECONDS', '-1'],
            ['RELAY_PREFLIGHT_COOLDOWN_SECONDS', '86401'],
            ['RELAY_PREFLIGHT_COOLDOWN_SECONDS', '1.5'],
            ['RELAY_READINESS_CACHE_MS', '60001'],
            ['RELAY_TOKEN_DOMAIN_CHECK_SECONDS', '-1'],
        ] as const) {
            expect(() => loadConfig({ ...baseEnv, [name]: value }), `${name}=${value}`).toThrow(name);
        }
    });
});

// The queue is bounded for the relay as a whole and the cool-down applies per sender: the relay does not tell clients
// apart by network address, so no limit is keyed on one.
describe('validation deadline and admission', () => {
    it('RELAY_VALIDATION_TIMEOUT_MS ends at least 5 s before the idle timeout closes the connection', () => {
        expect(loadConfig({ ...baseEnv, RELAY_VALIDATION_TIMEOUT_MS: '1000' }).validationTimeoutMs).toBe(1000);
        expect(loadConfig({ ...baseEnv, RELAY_VALIDATION_TIMEOUT_MS: '55000' }).validationTimeoutMs).toBe(55_000);
        expect(maxValidationTimeoutMs(DEFAULT_HTTP_LIMITS.idleTimeoutMs)).toBe(55_000);
        // Short idle timeouts (tests) keep a third of it as the margin.
        expect(maxValidationTimeoutMs(3000)).toBe(2000);
        expect(() => loadConfig({ ...baseEnv, RELAY_VALIDATION_TIMEOUT_MS: '60000' })).toThrow(/RELAY_VALIDATION_TIMEOUT_MS must be between 1000 and 55000/);
    });

    it('RELAY_MAX_QUEUED bounds the queue; there is no per-sender setting (one request per sender)', () => {
        expect(loadConfig({ ...baseEnv, RELAY_MAX_QUEUED: '100000' }).admission).toEqual({
            maxQueued: 100_000,
            maxRetainedRequests: 100_000,
            preflightCooldownMs: 600_000,
        });
        expect(() => loadConfig({ ...baseEnv, RELAY_MAX_QUEUED: '100001' })).toThrow(/RELAY_MAX_QUEUED/);
    });

    it('RELAY_PREFLIGHT_COOLDOWN_SECONDS defaults to 600, 0 turns the cool-down off, at most one day', () => {
        const cooldown = (value?: string) =>
            loadConfig({ ...baseEnv, ...(value !== undefined ? { RELAY_PREFLIGHT_COOLDOWN_SECONDS: value } : {}) }).admission.preflightCooldownMs;
        expect(cooldown()).toBe(600_000);
        expect(cooldown('0')).toBe(0);
        expect(cooldown('30')).toBe(30_000);
        expect(cooldown('86400')).toBe(86_400_000);
        for (const value of ['-1', '86401', '1.5', 'ten']) expect(() => cooldown(value), value).toThrow(/RELAY_PREFLIGHT_COOLDOWN_SECONDS/);
    });
});

describe('priority fee floors', () => {
    it('RELAY_MIN_TIP_GWEI and RELAY_MAX_FEE_PER_GAS_GWEI must be positive, and the cap must not be below the tip', () => {
        for (const value of ['0', '0.0', '0.000000000']) {
            expect(() => loadConfig({ ...baseEnv, RELAY_MIN_TIP_GWEI: value }), value).toThrow(/RELAY_MIN_TIP_GWEI must be greater than 0/);
            expect(() => loadConfig({ ...baseEnv, RELAY_MAX_FEE_PER_GAS_GWEI: value }), value).toThrow(/RELAY_MAX_FEE_PER_GAS_GWEI must be greater than 0/);
        }
        expect(() => loadConfig({ ...baseEnv, RELAY_MIN_TIP_GWEI: '40', RELAY_MAX_FEE_PER_GAS_GWEI: '39' })).toThrow(/must not be below RELAY_MIN_TIP_GWEI/);
        expect(loadConfig({ ...baseEnv, RELAY_MIN_TIP_GWEI: '40', RELAY_MAX_FEE_PER_GAS_GWEI: '40' }).tx.maxFeePerGas).toBe(40_000_000_000n);
    });

    it('on Polygon PoS (137, 80002) the tip must be at least 25 gwei, which Bor requires; elsewhere any positive tip', () => {
        const tip = (gwei: string) => ({ tx: { minTip: parseGwei(gwei) } });
        for (const chainId of [POLYGON_CHAIN_ID, AMOY_CHAIN_ID]) {
            expect(() => checkChainSettings(tip('24.999999999'), chainId)).toThrow(ConfigError);
            expect(() => checkChainSettings(tip('24.999999999'), chainId)).toThrow(/at least 25 on Polygon PoS/);
            expect(() => checkChainSettings(tip('25'), chainId)).not.toThrow();
        }
        expect(() => checkChainSettings(tip('0.000000001'), 31_337)).not.toThrow();
        // The documented default passes everywhere.
        expect(() => checkChainSettings(loadConfig(baseEnv), POLYGON_CHAIN_ID)).not.toThrow();
    });
});

describe('finality depths and deadline settings', () => {
    it('on Polygon PoS (137, 80002) RELAY_MIN_FINALITY_DEPTH and RELAY_FINALITY_FALLBACK_DEPTH must be at least 16; elsewhere they may be lower', () => {
        for (const chainId of [POLYGON_CHAIN_ID, AMOY_CHAIN_ID]) {
            expect(() => checkChainSettings(loadConfig({ ...baseEnv, RELAY_MIN_FINALITY_DEPTH: '15' }), chainId)).toThrow(
                `RELAY_MIN_FINALITY_DEPTH must be at least 16 on Polygon PoS (chain ${chainId})`,
            );
            expect(() => checkChainSettings(loadConfig({ ...baseEnv, RELAY_FINALITY_FALLBACK_DEPTH: '15' }), chainId)).toThrow(
                `RELAY_FINALITY_FALLBACK_DEPTH must be at least 16 on Polygon PoS (chain ${chainId})`,
            );
            expect(() => checkChainSettings(loadConfig({ ...baseEnv, RELAY_MIN_FINALITY_DEPTH: '16', RELAY_FINALITY_FALLBACK_DEPTH: '16' }), chainId)).not.toThrow();
        }
        const local = loadConfig({ ...baseEnv, RELAY_MIN_FINALITY_DEPTH: '0', RELAY_FINALITY_FALLBACK_DEPTH: '1' });
        expect(local.tx).toMatchObject({ minFinalityDepth: 0, finalityFallbackDepth: 1 });
        expect(() => checkChainSettings(local, 31_337)).not.toThrow();
    });

    it('RELAY_DEADLINE_SAFETY_SECONDS must be smaller than RELAY_MIN_SECONDS_TO_BROADCAST', () => {
        expect(loadConfig(baseEnv).tx).toMatchObject({ minSecondsToBroadcast: 10, deadlineSafetySeconds: 2 });
        for (const [min, safety] of [
            ['10', '10'],
            ['10', '120'],
            ['0', '0'],
        ] as const) {
            expect(() => loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: min, RELAY_DEADLINE_SAFETY_SECONDS: safety }), `${min}/${safety}`).toThrow(
                'RELAY_DEADLINE_SAFETY_SECONDS must be smaller than RELAY_MIN_SECONDS_TO_BROADCAST',
            );
        }
        // The largest pair that passes with the default 2 s poll interval (60 − 10 − 2 = 48).
        expect(loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '48', RELAY_DEADLINE_SAFETY_SECONDS: '47' }).tx).toMatchObject({
            minSecondsToBroadcast: 48,
            deadlineSafetySeconds: 47,
        });
        expect(loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '1', RELAY_DEADLINE_SAFETY_SECONDS: '0' }).tx.deadlineSafetySeconds).toBe(0);
    });

    it('RELAY_MIN_SECONDS_TO_BROADCAST, the poll interval and 10 s must fit into 60 s, the shortest deadline the relay accepts (with a 2 s poll interval 48 passes, 49 is refused)', () => {
        const refused = (max: number, pollMs: number) =>
            new RegExp(`^RELAY_MIN_SECONDS_TO_BROADCAST must be at most ${max} with RELAY_POLL_INTERVAL_MS=${pollMs}: the relay accepts deadlines from 60 s ahead`);
        expect(maxMinSecondsToBroadcast(2000)).toBe(48);
        expect(loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '48' }).tx.minSecondsToBroadcast).toBe(48);
        for (const value of ['49', '59', '60', '61', '600', '3600', '3601']) {
            expect(() => loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: value }), value).toThrow(refused(48, 2000));
        }
        // The poll interval counts in whole seconds, rounded up.
        expect(loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '49', RELAY_POLL_INTERVAL_MS: '1000' }).tx).toMatchObject({ minSecondsToBroadcast: 49, pollIntervalMs: 1000 });
        expect(loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '49', RELAY_POLL_INTERVAL_MS: '100' }).tx.minSecondsToBroadcast).toBe(49);
        expect(() => loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '49', RELAY_POLL_INTERVAL_MS: '1001' })).toThrow(refused(48, 1001));
        expect(() => loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '10', RELAY_POLL_INTERVAL_MS: '41000' })).toThrow(refused(9, 41000));
        // A poll interval that leaves no window at all (RELAY_MIN_SECONDS_TO_BROADCAST must be at least 1) is refused itself.
        expect(loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '1', RELAY_DEADLINE_SAFETY_SECONDS: '0', RELAY_POLL_INTERVAL_MS: '49000' }).tx.pollIntervalMs).toBe(49_000);
        expect(() => loadConfig({ ...baseEnv, RELAY_POLL_INTERVAL_MS: '49001' })).toThrow(/^RELAY_POLL_INTERVAL_MS must be between 100 and 49000/);
        expect(() => loadConfig({ ...baseEnv, RELAY_MIN_SECONDS_TO_BROADCAST: '-1' })).toThrow(/^RELAY_MIN_SECONDS_TO_BROADCAST must be between 0 and /);
    });

    it('RELAY_GAS_LIMIT_MARGIN_PERCENT is at least 10 (default 30)', () => {
        expect(loadConfig(baseEnv).tx.gasLimitMarginPercent).toBe(30);
        expect(loadConfig({ ...baseEnv, RELAY_GAS_LIMIT_MARGIN_PERCENT: '10' }).tx.gasLimitMarginPercent).toBe(10);
        expect(() => loadConfig({ ...baseEnv, RELAY_GAS_LIMIT_MARGIN_PERCENT: '9' })).toThrow(/RELAY_GAS_LIMIT_MARGIN_PERCENT must be between 10 and 200/);
    });
});

describe('private key file permissions', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'relay-key-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('warns when group or others may read the key file, and never logs the key', () => {
        const file = join(dir, 'relay_key');
        writeFileSync(file, `${RELAY_KEY}\n`);
        for (const [mode, warns] of [
            [0o400, false],
            [0o600, false],
            [0o640, true],
            [0o444, true],
            [0o604, true],
        ] as const) {
            chmodSync(file, mode);
            expect(privateKeyFileMode(file)).toBe(mode);
            const logs = captureLogger();
            warnIfKeyFileExposed(file, logs.logger);
            const lines = logs.lines.map((l) => JSON.parse(l) as { level: number; msg: string; mode?: string });
            if (warns) {
                expect(lines).toHaveLength(1);
                expect(lines[0]).toMatchObject({ level: 40, mode: `0${mode.toString(8)}` });
                expect(lines[0]!.msg).toContain('readable by other users');
            } else {
                expect(lines).toEqual([]);
            }
            expect(logs.text()).not.toContain(RELAY_KEY.slice(2));
        }
    });

    it('a missing file is left to readPrivateKeyFile (no warning, no throw)', () => {
        const logs = captureLogger();
        expect(privateKeyFileMode(join(dir, 'missing'))).toBeUndefined();
        warnIfKeyFileExposed(join(dir, 'missing'), logs.logger);
        expect(logs.lines).toEqual([]);
    });
});
