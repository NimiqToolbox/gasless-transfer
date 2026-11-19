import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { getAddress, isAddress, parseEther, parseGwei, type Address, type Hex } from 'viem';
import { z } from 'zod';
import {
    AMOY_CHAIN_ID,
    MIN_DEADLINE_SECONDS,
    POLYGON_CHAIN_ID,
    TRANSFER_DOMAIN_VERSION,
    type AuthModeName,
    type TypedDataDomain,
} from '@nimiq/gasless-sdk/core';
import { SECP256K1_N, hashDomain } from './eip712.js';
import { finalityDepthFloor, parseTxPolicyEnv, type TxPolicySettings } from './tx/settings.js';
import { BYTES32_RE } from './util/validation.js';

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

export interface TxManagerSettings {
    /** Durable lifetime ceiling for aggregate worst-case native gas exposure, in wei. */
    readonly totalGasBudgetWei?: bigint;
    readonly pollIntervalMs: number;
    readonly speedUpAfterBlocks: number;
    readonly speedUpPercent: number;
    readonly maxFeePerGas: bigint;
    readonly minTip: bigint;
    readonly maxInFlight: number;
    readonly reservedPrioritySlots: number;
    readonly maxGasLimit: bigint;
    readonly gasLimitMarginPercent: number;
    readonly minSecondsToBroadcast: number;
    readonly deadlineSafetySeconds: number;
    readonly finalityFallbackDepth: number;
    readonly unknownNonceGraceBlocks: number;
}

/** Timeouts and connection caps of the HTTP listeners. */
export interface HttpServerLimits {
    /** Time to receive a whole request, headers and body; slower clients get 408 and are disconnected. */
    readonly requestTimeoutMs: number;
    /** Time to receive the request headers (at most `requestTimeoutMs`). */
    readonly headersTimeoutMs: number;
    /** Idle keep-alive connections are closed after this long. */
    readonly keepAliveTimeoutMs: number;
    /** A connection without any traffic in either direction for this long is closed. */
    readonly idleTimeoutMs: number;
    /** Connections beyond this number are closed as soon as they are accepted. */
    readonly maxConnections: number;
}

export const DEFAULT_HTTP_LIMITS: HttpServerLimits = Object.freeze({
    requestTimeoutMs: 15_000,
    // a new connection that has not sent its headers after 5 s is closed.
    headersTimeoutMs: 5_000,
    keepAliveTimeoutMs: 10_000,
    // Longer than the validation deadline (RELAY_VALIDATION_TIMEOUT_MS, at most maxValidationTimeoutMs of it),
    // so that the answer to a POST /v1/transfer is sent before this timer closes a quiet connection.
    idleTimeoutMs: 60_000,
    maxConnections: 1024,
});

/** How long a readiness report is reused (ms). */
export const DEFAULT_READINESS_CACHE_MS = 5000;

/**
 * The RPC reads of one POST /v1/transfer must end this long before the idle timeout closes the
 * quiet connection: 5 s, or a third of the idle timeout if that is shorter (tests).
 */
export function maxValidationTimeoutMs(idleTimeoutMs: number): number {
    return idleTimeoutMs - Math.min(5000, Math.floor(idleTimeoutMs / 3));
}

/** Default RELAY_VALIDATION_TIMEOUT_MS: below the SDK's default request timeout (15 s), so wallets get the 503. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000;

/** Default RELAY_MAX_CONCURRENT_VALIDATIONS: submissions reading the chain at the same time, relay-wide. */
export const DEFAULT_MAX_CONCURRENT_VALIDATIONS = 4;

/** Admission bounds. A sender has at most one request queued or in flight (sender_busy); this is not configurable. */
export interface AdmissionSettings {
    /**
     * RELAY_MAX_QUEUED: queued requests in total; beyond it submissions get unavailable (503), unless a queued request
     * held at its spend cap gives way.
     */
    readonly maxQueued: number;
    /** Total retained request rows, including settled history; capacity refuses new inserts without deleting history. */
    readonly maxRetainedRequests: number;
    /**
     * RELAY_PREFLIGHT_COOLDOWN_SECONDS, in ms: after a request of a sender failed its check before the broadcast
     * for a reason the sender controls, that sender's next submission is refused before any RPC read while it has a
     * request queued or in flight, and it makes no held request give way, for this long. 0 turns the cool-down off.
     */
    readonly preflightCooldownMs: number;
}

export const DEFAULT_ADMISSION: AdmissionSettings = Object.freeze({
    maxQueued: 100,
    maxRetainedRequests: 100_000,
    preflightCooldownMs: 600_000,
});

/** The admission settings for `given` (fields left out take their defaults). */
export function admissionSettings(given: Partial<AdmissionSettings> = {}): AdmissionSettings {
    return {
        maxQueued: given.maxQueued ?? DEFAULT_ADMISSION.maxQueued,
        maxRetainedRequests: given.maxRetainedRequests ?? DEFAULT_ADMISSION.maxRetainedRequests,
        preflightCooldownMs: given.preflightCooldownMs ?? DEFAULT_ADMISSION.preflightCooldownMs,
    };
}

/** Internal listener for /healthz, /readyz and /metrics (docs: relay/README.md, "Listeners"). */
const DEFAULT_OPS_HOST = '127.0.0.1';
const DEFAULT_OPS_PORT = 9464;

/** Bor (Polygon PoS) does not accept priority fees below 25 gwei. */
const POLYGON_MIN_TIP_GWEI = 25;

/**
 * Of the shortest deadline the relay accepts (MIN_DEADLINE_SECONDS, 60 s), this much is kept free for what
 * lies between an acceptance and the first expiry check after it besides the poll interval: a new block (2 s on
 * Polygon), the pass that is running when the request arrives, and small clock differences.
 */
const BROADCAST_WINDOW_MARGIN_SECONDS = 10;

/**
 * The largest RELAY_MIN_SECONDS_TO_BROADCAST for a poll interval: the window, the poll interval
 * (rounded up to seconds) and BROADCAST_WINDOW_MARGIN_SECONDS together fit into MIN_DEADLINE_SECONDS, so that a
 * request with the shortest accepted deadline is still sendable at the first pass after its acceptance. 48 with the
 * default 2 s poll interval.
 */
export function maxMinSecondsToBroadcast(pollIntervalMs: number): number {
    return MIN_DEADLINE_SECONDS - BROADCAST_WINDOW_MARGIN_SECONDS - Math.ceil(pollIntervalMs / 1000);
}

/** The largest RELAY_POLL_INTERVAL_MS: it leaves a window of 1 s (RELAY_MIN_SECONDS_TO_BROADCAST must exceed 0). */
const MAX_POLL_INTERVAL_MS = (MIN_DEADLINE_SECONDS - BROADCAST_WINDOW_MARGIN_SECONDS - 1) * 1000;

export interface RelayConfig {
    readonly host: string;
    readonly port: number;
    /** Internal listener (/healthz, /readyz, /metrics); null when RELAY_OPS_PORT=off. */
    readonly ops: { readonly host: string; readonly port: number } | null;
    readonly http: HttpServerLimits;
    /** Overall bound of the RPC reads of one POST /v1/transfer. */
    readonly validationTimeoutMs: number;
    readonly admission: AdmissionSettings;
    readonly readinessCacheMs: number;
    /** Interval of the token DOMAIN_SEPARATOR() check; 0 = off. */
    readonly tokenDomainCheckMs: number;
    readonly tokenPinsFile?: string | undefined;
    readonly rpcUrls: readonly string[];
    readonly rpcTimeoutMs: number;
    /** Interval of the "rpc usage" log line; 0 = off. */
    readonly rpcUsageLogMs: number;
    /** Interval of the check that every RPC serves the state of older blocks (ops/rpcHistory.ts); 0 = startup only. */
    readonly rpcHistoryCheckMs: number;
    readonly deploymentFile: string;
    readonly gasTableFile: string;
    readonly dbPath: string;
    readonly privateKeyFile: string;
    /** RELAY_PRIVATE_KEY_FILE_REMOVE: startup deletes the key file once it has read the key (a temporary copy). */
    readonly privateKeyFileRemove?: boolean | undefined;
    readonly logLevel: string;
    /** Per signer, and relay-wide for submissions that read the chain. */
    readonly rateLimit: { signerMax: number; signerWindowMs: number; submitMax: number; submitWindowMs: number };
    /** RELAY_MAX_CONCURRENT_VALIDATIONS. */
    readonly maxConcurrentValidations: number;
    /**
     * RELAY_ variables that are set but that this configuration never read: a misspelt or unsupported name, whose
     * intended setting would otherwise silently stay at its default. Startup names them in a warning.
     */
    readonly unreadVariables: readonly string[];
    /** `default` = Chainlink POL/USD on chain 137; other chains require an explicit feed. */
    readonly priceFeed: Address | 'default';
    readonly priceCacheMs: number;
    readonly feeCacheMs: number;
    readonly feeMarginBps: number;
    readonly minPolBalanceWei: bigint;
    /** RELAY_ALERT_POL_BALANCE: below it the alert monitor warns (ops/alertMonitor.ts); default 2 × the minimum. */
    readonly alertPolBalanceWei: bigint;
    /** RELAY_ALERT_WEBHOOK_URL: where the alert monitor posts its messages; unset = alerts are only logged. */
    readonly alertWebhookUrl?: string | undefined;
    readonly recipientDenylist: readonly Address[];
    readonly tx: TxManagerSettings & TxPolicySettings;
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

type Env = Readonly<Record<string, string | undefined>>;

function raw(env: Env, name: string): string | undefined {
    const value = env[name]?.trim();
    return value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
    const value = raw(env, name);
    if (value === undefined) throw new ConfigError(`${name} is required`);
    return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
    const value = raw(env, name);
    if (value === undefined) return fallback;
    if (!/^-?[0-9]+$/.test(value)) throw new ConfigError(`${name} must be an integer`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
    return n;
}

function list(env: Env, name: string): string[] {
    const value = raw(env, name);
    if (value === undefined) return [];
    return value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
}

/** `true` or `false` (default false); anything else stops startup. */
function flag(env: Env, name: string): boolean {
    const value = raw(env, name);
    if (value === undefined || value === 'false') return false;
    if (value === 'true') return true;
    throw new ConfigError(`${name} must be true or false`);
}

/** A positive gwei amount: 0 would make the priority fee, the fee cap and with them break-even 0. */
function gwei(env: Env, name: string, fallback: string): bigint {
    const value = raw(env, name) ?? fallback;
    if (!/^[0-9]+(\.[0-9]{1,9})?$/.test(value)) throw new ConfigError(`${name} must be a decimal number of gwei`);
    const wei = parseGwei(value);
    if (wei === 0n) throw new ConfigError(`${name} must be greater than 0`);
    return wei;
}

/** RELAY_OPS_PORT: a port, 0 for any free port (tests), or `off` for no internal listener. */
function opsListener(env: Env): { host: string; port: number } | null {
    if (raw(env, 'RELAY_OPS_PORT') === 'off') return null;
    return { host: raw(env, 'RELAY_OPS_HOST') ?? DEFAULT_OPS_HOST, port: integer(env, 'RELAY_OPS_PORT', DEFAULT_OPS_PORT, 0, 65535) };
}

function httpLimits(env: Env): HttpServerLimits {
    const requestTimeoutMs = integer(env, 'RELAY_HTTP_REQUEST_TIMEOUT_MS', DEFAULT_HTTP_LIMITS.requestTimeoutMs, 1000, 120_000);
    return {
        requestTimeoutMs,
        headersTimeoutMs: Math.min(DEFAULT_HTTP_LIMITS.headersTimeoutMs, requestTimeoutMs),
        keepAliveTimeoutMs: integer(env, 'RELAY_HTTP_KEEP_ALIVE_TIMEOUT_MS', DEFAULT_HTTP_LIMITS.keepAliveTimeoutMs, 1000, 600_000),
        idleTimeoutMs: DEFAULT_HTTP_LIMITS.idleTimeoutMs,
        maxConnections: integer(env, 'RELAY_HTTP_MAX_CONNECTIONS', DEFAULT_HTTP_LIMITS.maxConnections, 1, 100_000),
    };
}

/** `env` as a view that records every name read from it (see `RelayConfig.unreadVariables`). */
function recordReads(env: Env): { readonly env: Env; readonly read: ReadonlySet<string> } {
    const read = new Set<string>();
    const recording = new Proxy(env, {
        get(target, name) {
            if (typeof name === 'string') read.add(name);
            return Reflect.get(target, name) as string | undefined;
        },
    });
    return { env: recording, read };
}

/** Reads the relay configuration from environment variables (documented in relay/README.md). */
export function loadConfig(processEnv: Env): RelayConfig {
    const { env, read } = recordReads(processEnv);
    // The environment of a process stays readable in /proc/<pid>/environ for its whole life, so the key itself must
    // never be in the relay's: the key is given as a file.
    if (raw(env, 'RELAY_PRIVATE_KEY') !== undefined) {
        throw new ConfigError('RELAY_PRIVATE_KEY must not be set for the relay process; give the key as a file (RELAY_PRIVATE_KEY_FILE)');
    }
    if (raw(env, 'RELAY_POLUSD_FALLBACK')) throw new ConfigError('Static price fallbacks are unsupported; remove RELAY_POLUSD_FALLBACK');
    const rpcUrls = list(env, 'RELAY_RPC_URLS');
    if (rpcUrls.length === 0) throw new ConfigError('RELAY_RPC_URLS is required (comma-separated http(s) URLs)');
    // An RPC listed twice would count twice in every rule that needs each RPC's own answer (the price, nonces,
    // settlement, the token implementation pins), and one provider could then decide them alone. URLs are compared
    // normalized (scheme and host case, default port, trailing slash of an empty path).
    const normalizedRpcUrls = new Map<string, number>();
    for (const [i, url] of rpcUrls.entries()) {
        // Never echo the URL: RPC URLs often embed API keys.
        if (!/^https?:\/\/[^\s]+$/.test(url) || !URL.canParse(url)) throw new ConfigError(`RELAY_RPC_URLS entry #${i + 1} is not an http(s) URL`);
        const normalized = new URL(url).href;
        const first = normalizedRpcUrls.get(normalized);
        if (first !== undefined) throw new ConfigError(`RELAY_RPC_URLS entry #${i + 1} repeats entry #${first + 1}; list each RPC once`);
        normalizedRpcUrls.set(normalized, i);
    }

    const feedRaw = raw(env, 'RELAY_POLUSD_FEED') ?? 'default';
    let priceFeed: Address | 'default';
    if (feedRaw === 'default') priceFeed = 'default';
    else if (isAddress(feedRaw, { strict: true })) priceFeed = getAddress(feedRaw);
    else throw new ConfigError('RELAY_POLUSD_FEED must be "default" or a feed address; a price feed is required');

    const denylist = list(env, 'RELAY_RECIPIENT_DENYLIST').map((a) => {
        if (!isAddress(a, { strict: true })) throw new ConfigError('RELAY_RECIPIENT_DENYLIST contains an invalid address');
        return getAddress(a);
    });

    const totalGasBudget = raw(env, 'RELAY_TOTAL_GAS_BUDGET_POL') ?? '1';
    if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(totalGasBudget) || parseEther(totalGasBudget) <= 0n) {
        throw new ConfigError('RELAY_TOTAL_GAS_BUDGET_POL must be a positive decimal POL amount');
    }
    const minPol = raw(env, 'RELAY_MIN_POL_BALANCE') ?? '1';
    if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(minPol)) throw new ConfigError('RELAY_MIN_POL_BALANCE must be a decimal POL amount');
    const minPolBalanceWei = parseEther(minPol);
    // The warning level of the balance alert: above the readiness minimum, so that there is time to top up.
    const alertPol = raw(env, 'RELAY_ALERT_POL_BALANCE');
    if (alertPol !== undefined && !/^[0-9]+(\.[0-9]{1,18})?$/.test(alertPol)) throw new ConfigError('RELAY_ALERT_POL_BALANCE must be a decimal POL amount');
    const alertPolBalanceWei = alertPol === undefined ? 2n * minPolBalanceWei : parseEther(alertPol);
    if (alertPolBalanceWei < minPolBalanceWei) throw new ConfigError('RELAY_ALERT_POL_BALANCE must not be below RELAY_MIN_POL_BALANCE');
    const alertWebhookUrl = raw(env, 'RELAY_ALERT_WEBHOOK_URL');
    // Never echo the URL: a chat webhook URL is a credential. fetch refuses URLs with a user name or password, so every
    // alert would fail to send.
    if (alertWebhookUrl !== undefined) {
        const url = URL.canParse(alertWebhookUrl) ? new URL(alertWebhookUrl) : undefined;
        if (url?.protocol !== 'https:') throw new ConfigError('RELAY_ALERT_WEBHOOK_URL must be an https URL');
        if (url.username !== '' || url.password !== '') throw new ConfigError('RELAY_ALERT_WEBHOOK_URL must not contain a user name or password');
    }

    const logLevel = raw(env, 'RELAY_LOG_LEVEL') ?? 'info';
    if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
        throw new ConfigError('RELAY_LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent');
    }

    const maxInFlight = integer(env, 'RELAY_MAX_IN_FLIGHT', 4, 1, 64);
    const reservedPrioritySlots = integer(env, 'RELAY_RESERVED_PRIORITY_SLOTS', 1, 0, 63);
    if (reservedPrioritySlots >= maxInFlight) {
        throw new ConfigError('RELAY_RESERVED_PRIORITY_SLOTS must be smaller than RELAY_MAX_IN_FLIGHT');
    }

    // MIN_TIP > 0 keeps break-even above 0 (gas units ≥ 21000, POL/USD ≥ 0.01): with 0, a chain or RPC
    // reporting base fee 0 would make a fee of 0 acceptable. Chain-specific floors are
    // checked once the deployment is known (checkChainSettings).
    const minTip = gwei(env, 'RELAY_MIN_TIP_GWEI', '30');
    const maxFeePerGas = gwei(env, 'RELAY_MAX_FEE_PER_GAS_GWEI', '3000');
    if (maxFeePerGas < minTip) throw new ConfigError('RELAY_MAX_FEE_PER_GAS_GWEI must not be below RELAY_MIN_TIP_GWEI');
    // a queued request is broadcast only while its deadline is more than RELAY_MIN_SECONDS_TO_BROADCAST
    // ahead, and an in-flight one is cancelled once it is RELAY_DEADLINE_SAFETY_SECONDS ahead. With the safety
    // value not below the other, every request whose deadline lies between them would get a call and then a cancel.
    // the relay accepts deadlines from MIN_DEADLINE_SECONDS (60 s) ahead, and a queued request is
    // checked against RELAY_MIN_SECONDS_TO_BROADCAST at the first pass after its acceptance, which comes up to
    // RELAY_POLL_INTERVAL_MS later, on a head that can be newer than the acceptance. So the window, the poll interval
    // and BROADCAST_WINDOW_MARGIN_SECONDS together must fit into 60 s; otherwise the relay would accept requests (202)
    // that it then lets expire unsent.
    const pollIntervalMs = integer(env, 'RELAY_POLL_INTERVAL_MS', 2000, 100, MAX_POLL_INTERVAL_MS);
    const minSecondsToBroadcast = integer(env, 'RELAY_MIN_SECONDS_TO_BROADCAST', 10, 0, Number.MAX_SAFE_INTEGER);
    const maxSecondsToBroadcast = maxMinSecondsToBroadcast(pollIntervalMs);
    if (minSecondsToBroadcast > maxSecondsToBroadcast) {
        throw new ConfigError(
            `RELAY_MIN_SECONDS_TO_BROADCAST must be at most ${maxSecondsToBroadcast} with RELAY_POLL_INTERVAL_MS=${pollIntervalMs}: the relay accepts deadlines from ${MIN_DEADLINE_SECONDS} s ahead, and a request must still be sendable at the first pass after its acceptance (the poll interval later, plus ${BROADCAST_WINDOW_MARGIN_SECONDS} s for a new block and a long pass); otherwise accepted requests expire unsent`,
        );
    }
    const deadlineSafetySeconds = integer(env, 'RELAY_DEADLINE_SAFETY_SECONDS', 2, 0, 600);
    if (deadlineSafetySeconds >= minSecondsToBroadcast) {
        throw new ConfigError('RELAY_DEADLINE_SAFETY_SECONDS must be smaller than RELAY_MIN_SECONDS_TO_BROADCAST');
    }

    const http = httpLimits(env);
    const maxQueued = integer(env, 'RELAY_MAX_QUEUED', DEFAULT_ADMISSION.maxQueued, 1, 100_000);

    const config: Omit<RelayConfig, 'unreadVariables'> = {
        host: raw(env, 'RELAY_HOST') ?? '0.0.0.0',
        port: integer(env, 'RELAY_PORT', 8080, 1, 65535),
        ops: opsListener(env),
        http,
        // Below the idle timeout minus a margin: the answer must go out before the connection is closed.
        validationTimeoutMs: integer(
            env,
            'RELAY_VALIDATION_TIMEOUT_MS',
            DEFAULT_VALIDATION_TIMEOUT_MS,
            1000,
            maxValidationTimeoutMs(http.idleTimeoutMs),
        ),
        admission: {
            maxQueued,
            maxRetainedRequests: integer(env, 'RELAY_MAX_RETAINED_REQUESTS', DEFAULT_ADMISSION.maxRetainedRequests, 1, 10_000_000),
            preflightCooldownMs: integer(env, 'RELAY_PREFLIGHT_COOLDOWN_SECONDS', DEFAULT_ADMISSION.preflightCooldownMs / 1000, 0, 86_400) * 1000,
        },
        readinessCacheMs: integer(env, 'RELAY_READINESS_CACHE_MS', DEFAULT_READINESS_CACHE_MS, 0, 60_000),
        tokenDomainCheckMs: integer(env, 'RELAY_TOKEN_DOMAIN_CHECK_SECONDS', 60, 0, 86_400) * 1000,
        tokenPinsFile: raw(env, 'RELAY_TOKEN_PINS_FILE'),
        rpcUrls,
        rpcTimeoutMs: integer(env, 'RELAY_RPC_TIMEOUT_MS', 5000, 100, 120_000),
        rpcUsageLogMs: integer(env, 'RELAY_RPC_USAGE_LOG_SECONDS', 300, 0, 86_400) * 1000,
        rpcHistoryCheckMs: integer(env, 'RELAY_RPC_HISTORY_CHECK_SECONDS', 600, 0, 86_400) * 1000,
        deploymentFile: required(env, 'RELAY_DEPLOYMENT_FILE'),
        gasTableFile: raw(env, 'RELAY_GAS_TABLE_FILE') ?? 'config/gasTable.json',
        dbPath: raw(env, 'RELAY_DB_PATH') ?? 'data/relay.sqlite',
        privateKeyFile: required(env, 'RELAY_PRIVATE_KEY_FILE'),
        privateKeyFileRemove: flag(env, 'RELAY_PRIVATE_KEY_FILE_REMOVE'),
        logLevel,
        rateLimit: {
            signerMax: integer(env, 'RELAY_RATE_LIMIT_SIGNER_MAX', 10, 1, 1_000_000),
            signerWindowMs: integer(env, 'RELAY_RATE_LIMIT_SIGNER_WINDOW_SECONDS', 60, 1, 86_400) * 1000,
            submitMax: integer(env, 'RELAY_RATE_LIMIT_SUBMIT_MAX', 120, 1, 1_000_000),
            submitWindowMs: integer(env, 'RELAY_RATE_LIMIT_SUBMIT_WINDOW_SECONDS', 60, 1, 86_400) * 1000,
        },
        maxConcurrentValidations: integer(env, 'RELAY_MAX_CONCURRENT_VALIDATIONS', DEFAULT_MAX_CONCURRENT_VALIDATIONS, 1, 256),
        priceFeed,
        priceCacheMs: integer(env, 'RELAY_PRICE_CACHE_SECONDS', 30, 0, 3600) * 1000,
        feeCacheMs: integer(env, 'RELAY_FEE_CACHE_MS', 2000, 0, 60_000),
        feeMarginBps: integer(env, 'RELAY_FEE_MARGIN_BPS', 1000, 0, 10_000),
        minPolBalanceWei,
        alertPolBalanceWei,
        alertWebhookUrl,
        recipientDenylist: denylist,
        tx: {
            totalGasBudgetWei: parseEther(totalGasBudget),
            pollIntervalMs,
            speedUpAfterBlocks: integer(env, 'RELAY_SPEEDUP_AFTER_BLOCKS', 10, 1, 1000),
            speedUpPercent: integer(env, 'RELAY_SPEEDUP_PERCENT', 20, 10, 100),
            maxFeePerGas,
            minTip,
            maxInFlight,
            reservedPrioritySlots,
            maxGasLimit: BigInt(integer(env, 'RELAY_MAX_GAS_LIMIT', 1_000_000, 21_000, 30_000_000)),
            // At least 10 %: with no margin the gas limit is the pinned estimate itself, and any state change
            // before the inclusion (a cold storage slot) makes the call run out of gas at the relay's expense.
            gasLimitMarginPercent: integer(env, 'RELAY_GAS_LIMIT_MARGIN_PERCENT', 30, 10, 200),
            minSecondsToBroadcast,
            deadlineSafetySeconds,
            finalityFallbackDepth: integer(env, 'RELAY_FINALITY_FALLBACK_DEPTH', 256, 1, 100_000),
            unknownNonceGraceBlocks: integer(env, 'RELAY_UNKNOWN_NONCE_GRACE_BLOCKS', 12, 1, 10_000),
            ...parseTxPolicyEnv(env, (m) => new ConfigError(m)),
        },
    };
    // Last: by now every variable this configuration uses has been read.
    const unreadVariables = Object.keys(processEnv).filter((name) => name.startsWith('RELAY_') && !read.has(name));
    return { ...config, unreadVariables };
}

/**
 * Checks that depend on the chain of the deployment file, on Polygon PoS (137, and Amoy 80002):
 * - Bor refuses priority fees below 25 gwei, so a lower MIN_TIP would only produce underpriced broadcasts.
 * - docs/STEP-1-GAS-ABSTRACTION.md §6.5: `confirmed` (and the purge of the secrets) needs at least 16 blocks on top, so
 *   RELAY_MIN_FINALITY_DEPTH and RELAY_FINALITY_FALLBACK_DEPTH must be at least 16 there. Local chains
 *   may use less. Fields that are not given are not checked (their defaults pass).
 */
export function checkChainSettings(
    config: {
        readonly tx: Pick<TxManagerSettings, 'minTip'> & Partial<Pick<TxManagerSettings, 'finalityFallbackDepth'> & Pick<TxPolicySettings, 'minFinalityDepth'>>;
    },
    chainId: number,
): void {
    if (chainId !== POLYGON_CHAIN_ID && chainId !== AMOY_CHAIN_ID) return;
    if (config.tx.minTip < parseGwei(String(POLYGON_MIN_TIP_GWEI))) {
        throw new ConfigError(`RELAY_MIN_TIP_GWEI must be at least ${POLYGON_MIN_TIP_GWEI} on Polygon PoS (chain ${chainId})`);
    }
    const floor = finalityDepthFloor(chainId);
    if (config.tx.minFinalityDepth !== undefined && config.tx.minFinalityDepth < floor) {
        throw new ConfigError(`RELAY_MIN_FINALITY_DEPTH must be at least ${floor} on Polygon PoS (chain ${chainId})`);
    }
    if (config.tx.finalityFallbackDepth !== undefined && config.tx.finalityFallbackDepth < floor) {
        throw new ConfigError(`RELAY_FINALITY_FALLBACK_DEPTH must be at least ${floor} on Polygon PoS (chain ${chainId})`);
    }
}

// ---------------------------------------------------------------------------------------------
// Private key (Docker secret file)
// ---------------------------------------------------------------------------------------------

/** Permission bits of the key file; the relay warns when group or others may read it. */
export function privateKeyFileMode(path: string): number | undefined {
    try {
        return statSync(path).mode & 0o777;
    } catch {
        return undefined;
    }
}

/**
 * Reads the relay private key from a file (a Docker secret in production). The file must contain one
 * 32-byte hex key, optionally 0x-prefixed. Error messages never include the file content.
 */
export function readPrivateKeyFile(path: string): Hex {
    let content: string;
    try {
        content = readFileSync(path, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'error';
        throw new ConfigError(`RELAY_PRIVATE_KEY_FILE could not be read (${code})`);
    }
    const trimmed = content.trim();
    const hex = /^0x/i.test(trimmed) ? trimmed.slice(2) : trimmed;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new ConfigError('RELAY_PRIVATE_KEY_FILE must contain exactly one 32-byte hex private key');
    }
    const n = BigInt(`0x${hex}`);
    if (n === 0n || n >= SECP256K1_N) throw new ConfigError('RELAY_PRIVATE_KEY_FILE does not contain a valid secp256k1 key');
    return `0x${hex.toLowerCase()}`;
}

/**
 * RELAY_PRIVATE_KEY_FILE_REMOVE: deletes the key file once startup has read it, so that the key then exists only in
 * the relay's memory. For a temporary copy only; never for the only copy of a key. A file that cannot be deleted
 * stops startup, since the operator asked for it to be gone (a Docker secret is on a read-only mount: leave the
 * setting off there).
 */
export function removePrivateKeyFile(path: string): void {
    try {
        unlinkSync(path);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'error';
        throw new ConfigError(`RELAY_PRIVATE_KEY_FILE could not be removed (${code}) although RELAY_PRIVATE_KEY_FILE_REMOVE is true`);
    }
}

/**
 * The key file that a start has to delete: RELAY_PRIVATE_KEY_FILE if RELAY_PRIVATE_KEY_FILE_REMOVE is true. Read as
 * loadConfig reads these two variables, but from them alone: main.ts needs the answer for a start whose other settings
 * loadConfig refuses, which must not leave the temporary copy behind either.
 */
export function privateKeyFileToRemove(env: Env): string | undefined {
    const path = raw(env, 'RELAY_PRIVATE_KEY_FILE');
    return path !== undefined && flag(env, 'RELAY_PRIVATE_KEY_FILE_REMOVE') ? path : undefined;
}

// ---------------------------------------------------------------------------------------------
// Deployment file (contracts/deployments/<chainId>.json)
// ---------------------------------------------------------------------------------------------

export type TokenKind = 'usdc' | 'usdt0';

export interface DeploymentToken {
    readonly symbol: 'USDC' | 'USDT0';
    readonly kind: TokenKind;
    readonly address: Address;
    readonly decimals: 6;
    readonly authModes: readonly AuthModeName[];
    readonly domain: TypedDataDomain;
}

export interface Deployment {
    readonly chainId: number;
    readonly gaslessTransfer: Address;
    readonly deployBlock: bigint;
    readonly tokens: readonly DeploymentToken[];
}

/** The deployment record version this relay serves: the contract's EIP-712 domain version. */
const DEPLOYMENT_VERSION = TRANSFER_DOMAIN_VERSION;

const zAddressAnyCase = z
    .string()
    .refine((s) => isAddress(s, { strict: true }), 'expected an address (mixed case must be a valid checksum)')
    .transform((s) => getAddress(s));

const zUintLike = z
    .union([z.string().regex(/^(0|[1-9][0-9]{0,77})$/), z.number().int().nonnegative().refine(Number.isSafeInteger)])
    .transform((v) => BigInt(v));

const AUTH_MODE_ALIASES: Readonly<Record<string, AuthModeName>> = {
    none: 'none',
    permit: 'permit',
    metaTxApprove: 'metaTxApprove',
    NONE: 'none',
    PERMIT: 'permit',
    META_TX_APPROVE: 'metaTxApprove',
    '0': 'none',
    '1': 'permit',
    '2': 'metaTxApprove',
};

const zAuthMode = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const mode = AUTH_MODE_ALIASES[String(value)];
    if (!mode) {
        ctx.addIssue({ code: 'custom', message: `unknown auth mode ${String(value).slice(0, 32)}` });
        return z.NEVER;
    }
    return mode;
});

const zDomain = z.strictObject({
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(20),
    chainId: z
        .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]{0,15}$/)])
        .transform((v) => Number(v))
        .optional(),
    verifyingContract: zAddressAnyCase,
    salt: z
        .string()
        .regex(BYTES32_RE)
        .transform((s) => s.toLowerCase() as Hex)
        .optional(),
});

// The record and its token entries have exact keys, as in the SDK's pinsFromDeployment: a key this relay does not know
// is refused, not ignored. `domainSeparator` is optional; if given, it must be the hash of `domain`.
const zDeploymentToken = z.strictObject({
    symbol: z.enum(['USDC', 'USDT0']),
    address: zAddressAnyCase,
    decimals: z.literal(6),
    authModes: z.array(zAuthMode).min(1).max(3),
    domain: zDomain,
    domainSeparator: z
        .string()
        .regex(BYTES32_RE)
        .transform((s) => s.toLowerCase() as Hex)
        .optional(),
});

const zDeployment = z.strictObject({
    chainId: z.number().int().positive(),
    version: z.literal(DEPLOYMENT_VERSION),
    gaslessTransfer: zAddressAnyCase,
    initialOwner: zAddressAnyCase.optional(),
    deployBlock: zUintLike,
    tokens: z.array(zDeploymentToken).min(1).max(10),
});

const ALLOWED_MODES: Readonly<Record<'USDC' | 'USDT0', readonly AuthModeName[]>> = {
    USDC: ['permit', 'none'],
    USDT0: ['permit', 'metaTxApprove', 'none'],
};

function formatIssues(error: z.ZodError): string {
    return error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
}

/**
 * Validates a parsed deployment JSON (format produced by the contracts deployment script, contracts/script/DeploymentWriter.sol).
 * Fails closed on a record whose `version` is not "3", the EIP-712 domain version of the contract whose requests this
 * relay verifies and encodes.
 */
export function parseDeployment(json: unknown): Deployment {
    const version = (json as { version?: unknown } | null)?.version;
    if (version !== DEPLOYMENT_VERSION) {
        const found = version === undefined ? 'missing' : JSON.stringify(version).slice(0, 20);
        throw new ConfigError(`invalid deployment file: version must be "${DEPLOYMENT_VERSION}", not ${found}`);
    }
    const parsed = zDeployment.safeParse(json);
    if (!parsed.success) throw new ConfigError(`invalid deployment file: ${formatIssues(parsed.error)}`);
    const d = parsed.data;
    const seen = new Set<string>();
    const tokens = d.tokens.map((t): DeploymentToken => {
        const key = t.address.toLowerCase();
        if (seen.has(key)) throw new ConfigError(`deployment lists token ${t.address} twice`);
        seen.add(key);
        if (new Set(t.authModes).size !== t.authModes.length) throw new ConfigError(`${t.symbol}: duplicate auth modes`);
        for (const mode of t.authModes) {
            if (!ALLOWED_MODES[t.symbol].includes(mode)) throw new ConfigError(`${t.symbol} does not support auth mode ${mode}`);
        }
        if (t.domain.verifyingContract.toLowerCase() !== key) {
            throw new ConfigError(`${t.symbol}: domain.verifyingContract must be the token address`);
        }
        if (t.domain.chainId !== undefined && t.domain.chainId !== d.chainId) {
            throw new ConfigError(`${t.symbol}: domain.chainId does not match chainId`);
        }
        if (t.domain.salt !== undefined && BigInt(t.domain.salt) !== BigInt(d.chainId)) {
            throw new ConfigError(`${t.symbol}: domain.salt must be bytes32(chainId)`);
        }
        if (t.domain.chainId === undefined && t.domain.salt === undefined) {
            throw new ConfigError(`${t.symbol}: domain needs chainId or salt`);
        }
        const domain: TypedDataDomain = {
            name: t.domain.name,
            version: t.domain.version,
            ...(t.domain.chainId !== undefined ? { chainId: t.domain.chainId } : {}),
            verifyingContract: t.domain.verifyingContract,
            ...(t.domain.salt !== undefined ? { salt: t.domain.salt } : {}),
        };
        if (t.domainSeparator !== undefined && t.domainSeparator !== hashDomain(domain)) {
            throw new ConfigError(`${t.symbol}: domainSeparator does not match the hash of the domain`);
        }
        return {
            symbol: t.symbol,
            kind: t.symbol === 'USDC' ? 'usdc' : 'usdt0',
            address: t.address,
            decimals: 6,
            authModes: t.authModes,
            domain,
        };
    });
    return { chainId: d.chainId, gaslessTransfer: d.gaslessTransfer, deployBlock: d.deployBlock, tokens };
}

function readJsonFile(path: string, what: string): unknown {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (err) {
        throw new ConfigError(`${what} ${path} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new ConfigError(`${what} ${path} is not valid JSON`);
    }
}

export function loadDeploymentFile(path: string): Deployment {
    return parseDeployment(readJsonFile(path, 'deployment file'));
}

// ---------------------------------------------------------------------------------------------
// Gas table (relay/config/gasTable.json)
// ---------------------------------------------------------------------------------------------

export interface GasTable {
    /**
     * Where the numbers come from, e.g. `polygon-rpc-state-overrides@94503409;ceil5000` (the Polygon-native calibration of
     * the committed table).
     */
    readonly source: string;
    /** Margin already included in the numbers (informational). */
    readonly margin: number;
    readonly operations: Readonly<Record<string, Readonly<Partial<Record<AuthModeName, number>>>>>;
}

const zGasUnits = z.number().int().min(21_000).max(30_000_000);

const zGasTable = z.object({
    source: z.string().min(1).max(200),
    margin: z.number().min(0).max(1),
    operations: z.record(
        z.string().regex(/^[a-z][a-zA-Z0-9.]*$/),
        z.strictObject({ permit: zGasUnits.optional(), metaTxApprove: zGasUnits.optional(), none: zGasUnits.optional() }),
    ),
});

export function parseGasTable(json: unknown): GasTable {
    const parsed = zGasTable.safeParse(json);
    if (!parsed.success) throw new ConfigError(`invalid gas table: ${formatIssues(parsed.error)}`);
    return parsed.data;
}

export function loadGasTableFile(path: string): GasTable {
    return parseGasTable(readJsonFile(path, 'gas table'));
}

/** Every configured token mode needs a gas entry for the transfer operation. */
export function checkGasTableCoverage(gasTable: GasTable, deployment: Deployment): void {
    const transfer = gasTable.operations.transfer;
    for (const token of deployment.tokens) {
        for (const mode of token.authModes) {
            if (transfer?.[mode] === undefined) {
                throw new ConfigError(`gas table has no entry operations.transfer.${mode} (needed by ${token.symbol})`);
            }
        }
    }
}
