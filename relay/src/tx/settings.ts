// Transaction-manager policy settings and defaults. Each policy field is optional on the transaction manager.
// `parseTxPolicyEnv` reads them from the RELAY_* environment; the configuration loader passes its own
// error type in, so this module does not import config.ts (no import cycle).
import { AMOY_CHAIN_ID, POLYGON_CHAIN_ID } from '@nimiq/gasless-sdk/core';

export interface TxPolicySettings {
    /**
     * Relay spend cap per request: the worst-case gas cost of one of its calls (gas limit × maxFeePerGas, at
     * the current POL/USD price) may be at most this percentage of the fee the user signed. Speed-ups stop at
     * the cap and a queued request whose market price is above it waits. Cancels and nonce fillers are exempt
     * (RELAY_MAX_FEE_PER_GAS_GWEI still caps them).
     */
    readonly maxCostPercentOfFee: number;
    /** `confirmed` (and settling a failed/expired outcome) needs the `finalized` tag and at least this depth below head. */
    readonly minFinalityDepth: number;
    /** Blocks the chain's latest nonce may stay below the lowest in-flight relay nonce before the gap is filled. */
    readonly nonceGapBlocks: number;
    /** Settled requests (confirmed, failed, expired) are deleted this long after their outcome became final. */
    readonly requestRetentionMs: number;
    /**
     * health(): `stalled` when work can be sent but no relay transaction was broadcast, sped up or included for this
     * many blocks; `backlog` (degraded) when the oldest queued request that can be sent has waited longer. A decision
     * that waits for the RPCs to agree raises an ALERT after this many blocks.
     */
    readonly stuckAfterBlocks: number;
    /** health(): a `finalized` block further behind head than this is reported (finality stalled). */
    readonly maxFinalityLagBlocks: number;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * docs/STEP-1-GAS-ABSTRACTION.md §6.5: `confirmed` means at or below min(finalized, head − 16). On Polygon PoS (137) and Amoy (80002)
 * RELAY_MIN_FINALITY_DEPTH and RELAY_FINALITY_FALLBACK_DEPTH must be at least this (checkChainSettings refuses less
 * at startup, and the transaction manager never applies less there). Local chains may use less.
 */
export const POLYGON_MIN_FINALITY_DEPTH = 16;
const POLYGON_CHAIN_IDS: readonly number[] = [POLYGON_CHAIN_ID, AMOY_CHAIN_ID];

/** The least finality depth the transaction manager applies on `chainId` (16 on Polygon PoS and Amoy, else 0). */
export function finalityDepthFloor(chainId: number): number {
    return POLYGON_CHAIN_IDS.includes(chainId) ? POLYGON_MIN_FINALITY_DEPTH : 0;
}

export const DEFAULT_TX_POLICY: TxPolicySettings = Object.freeze({
    maxCostPercentOfFee: 200,
    minFinalityDepth: 16,
    nonceGapBlocks: 20,
    requestRetentionMs: 30 * DAY_MS,
    stuckAfterBlocks: 150,
    maxFinalityLagBlocks: 600,
});

/** Environment variables of the policy settings, with their bounds (documented in relay/docs/transaction-lifecycle.md). */
export const TX_POLICY_ENV = Object.freeze({
    maxCostPercentOfFee: { name: 'RELAY_MAX_COST_PERCENT_OF_FEE', min: 100, max: 10_000 },
    // 0 is for local chains: on Polygon PoS and Amoy the startup refuses less than POLYGON_MIN_FINALITY_DEPTH
    // (checkChainSettings) and the transaction manager never applies less (finalityDepthFloor).
    minFinalityDepth: { name: 'RELAY_MIN_FINALITY_DEPTH', min: 0, max: 10_000 },
    nonceGapBlocks: { name: 'RELAY_NONCE_GAP_BLOCKS', min: 1, max: 10_000 },
    // At least one day: a pruned request's deadline (at most 2 h ahead) has long passed, so a re-post of it
    // is refused by the deadline policy or as nonce_used.
    requestRetentionDays: { name: 'RELAY_REQUEST_RETENTION_DAYS', min: 1, max: 3650 },
    stuckAfterBlocks: { name: 'RELAY_STUCK_AFTER_BLOCKS', min: 10, max: 1_000_000 },
    maxFinalityLagBlocks: { name: 'RELAY_MAX_FINALITY_LAG_BLOCKS', min: 16, max: 1_000_000 },
});

type Env = Readonly<Record<string, string | undefined>>;
type ErrorFactory = (message: string) => Error;

function integer(env: Env, spec: { name: string; min: number; max: number }, fallback: number, fail: ErrorFactory): number {
    const value = env[spec.name]?.trim();
    if (value === undefined || value === '') return fallback;
    if (!/^[0-9]+$/.test(value)) throw fail(`${spec.name} must be an integer`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < spec.min || n > spec.max) throw fail(`${spec.name} must be between ${spec.min} and ${spec.max}`);
    return n;
}

/**
 * Reads the policy settings from the environment; unset variables take the defaults. `fail` builds the error
 * for an invalid value (the configuration loader passes `(m) => new ConfigError(m)`).
 */
export function parseTxPolicyEnv(env: Env, fail: ErrorFactory = (message) => new Error(message)): TxPolicySettings {
    const d = DEFAULT_TX_POLICY;
    const e = TX_POLICY_ENV;
    return {
        maxCostPercentOfFee: integer(env, e.maxCostPercentOfFee, d.maxCostPercentOfFee, fail),
        minFinalityDepth: integer(env, e.minFinalityDepth, d.minFinalityDepth, fail),
        nonceGapBlocks: integer(env, e.nonceGapBlocks, d.nonceGapBlocks, fail),
        requestRetentionMs: integer(env, e.requestRetentionDays, d.requestRetentionMs / DAY_MS, fail) * DAY_MS,
        stuckAfterBlocks: integer(env, e.stuckAfterBlocks, d.stuckAfterBlocks, fail),
        maxFinalityLagBlocks: integer(env, e.maxFinalityLagBlocks, d.maxFinalityLagBlocks, fail),
    };
}

/** The defaults, overridden by every policy field that is set (other fields of `settings` are ignored). */
export function txPolicy(settings: Partial<TxPolicySettings>): TxPolicySettings {
    const pick = <K extends keyof TxPolicySettings>(key: K): TxPolicySettings[K] => settings[key] ?? DEFAULT_TX_POLICY[key];
    return {
        maxCostPercentOfFee: pick('maxCostPercentOfFee'),
        minFinalityDepth: pick('minFinalityDepth'),
        nonceGapBlocks: pick('nonceGapBlocks'),
        requestRetentionMs: pick('requestRetentionMs'),
        stuckAfterBlocks: pick('stuckAfterBlocks'),
        maxFinalityLagBlocks: pick('maxFinalityLagBlocks'),
    };
}
