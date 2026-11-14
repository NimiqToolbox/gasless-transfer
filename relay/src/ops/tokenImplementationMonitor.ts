import { readFileSync } from 'node:fs';
import { isAddress, keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { ChainClient } from '../chain/types.js';
import { classifyRpcFailure, type RpcFailureReason } from '../chain/viemChainClient.js';
import { monotonicMs, type Clock } from '../clock.js';
import type { Deployment } from '../config.js';
import type { Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';
import { rpcClientsOf } from '../tx/quorum.js';

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().refine((value) => isAddress(value) && !/^0x0{40}$/i.test(value));
const pinSchema = z.object({
    address,
    proxyCodeHash: bytes32,
    implementationSlot: bytes32,
    implementationAddress: address,
    implementationCodeHash: bytes32,
}).strict();
const fileSchema = z.object({
    chainId: z.number().int().positive(),
    reviewedBlock: z.string().regex(/^[1-9][0-9]*$/),
    tokens: z.array(pinSchema).min(1).max(16),
}).strict();

export interface TokenImplementationPin {
    readonly address: Address;
    readonly proxyCodeHash: Hex;
    readonly implementationSlot: Hex;
    readonly implementationAddress: Address;
    readonly implementationCodeHash: Hex;
}
export interface TokenImplementationPins {
    readonly chainId: number;
    readonly reviewedBlock: bigint;
    readonly tokens: readonly TokenImplementationPin[];
}

/** Pins are operator-reviewed configuration; observed RPC values never rewrite them, including on restart. */
export function parseTokenImplementationPins(input: unknown, deployment: Deployment): TokenImplementationPins {
    const parsed = fileSchema.safeParse(input);
    if (!parsed.success) throw new Error('token implementation pins: invalid file schema');
    const file = parsed.data;
    const configured = new Set(deployment.tokens.map((token) => token.address.toLowerCase()));
    const pinned = new Set(file.tokens.map((token) => token.address.toLowerCase()));
    if (file.chainId !== deployment.chainId || pinned.size !== file.tokens.length || pinned.size !== configured.size || [...configured].some((key) => !pinned.has(key))) {
        throw new Error('token implementation pins: chain or token set differs from deployment');
    }
    return { chainId: file.chainId, reviewedBlock: BigInt(file.reviewedBlock), tokens: file.tokens as TokenImplementationPin[] };
}

export function loadTokenImplementationPins(path: string, deployment: Deployment): TokenImplementationPins {
    return parseTokenImplementationPins(JSON.parse(readFileSync(path, 'utf8')) as unknown, deployment);
}

export interface TokenImplementationReport {
    readonly ok: boolean;
    readonly unavailable: readonly Address[];
    readonly lastCheckAtMs: number | null;
}

/** The read or comparison of one RPC's verification pass that did not confirm the pins. */
export type ImplementationCheckStage = 'client' | 'chain_id' | 'head' | 'proxy_code' | 'implementation_slot' | 'implementation_code' | 'block_hash';

/**
 * Why one RPC did not confirm the pins, from a closed set (safe for logs and metric labels; the RPC's own text and
 * its URL are never reported):
 * - `transport`: the read failed (RpcFailureReason), or the client cannot make it (`unsupported`);
 * - `chain`: another chain (`chain_mismatch`), or a head below the freshness floor (`head_behind`);
 * - `pins`: the code or implementation slot differs from the reviewed pin (`mismatch`), or there is no code (`empty`);
 * - `block`: the verified block is no longer canonical (`block_changed`) or the RPC no longer has it (`block_missing`).
 */
export type ImplementationCheckFailure =
    | { readonly category: 'transport'; readonly reason: RpcFailureReason | 'unsupported'; readonly httpStatus?: number; readonly rpcCode?: number }
    | { readonly category: 'chain'; readonly reason: 'chain_mismatch' | 'head_behind' }
    | { readonly category: 'pins'; readonly reason: 'mismatch' | 'empty' }
    | { readonly category: 'block'; readonly reason: 'block_changed' | 'block_missing' };

/** What one RPC answered in the last attempt of a check that failed (`rpc`: its 1-based position in RELAY_RPC_URLS). */
export type ImplementationCheckDiagnostic = ImplementationCheckFailure & {
    readonly rpc: number;
    readonly stage: ImplementationCheckStage;
    /** Attempts made on this RPC in the check. */
    readonly attempts: number;
};

class CheckFailed extends Error {
    constructor(readonly stage: ImplementationCheckStage, readonly failure: ImplementationCheckFailure) {
        super(`${stage}: ${failure.reason}`);
    }
}

/** A read of `stage` whose failure is classified instead of carried on (the error text can hold credential-bearing URLs). */
async function readAt<T>(stage: ImplementationCheckStage, value: Promise<T>): Promise<T> {
    try {
        return await value;
    } catch (err) {
        const { reason, httpStatus, rpcCode } = classifyRpcFailure(err);
        throw new CheckFailed(stage, {
            category: 'transport',
            reason,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
            ...(rpcCode !== undefined ? { rpcCode } : {}),
        });
    }
}

function codeMatches(stage: ImplementationCheckStage, code: Hex | undefined, hash: Hex): void {
    if (!code || code === '0x') throw new CheckFailed(stage, { category: 'pins', reason: 'empty' });
    if (keccak256(code).toLowerCase() !== hash.toLowerCase()) throw new CheckFailed(stage, { category: 'pins', reason: 'mismatch' });
}

/**
 * Only failures that can pass by themselves are retried within a check: a failed read, a head that has not reached
 * the freshness floor yet, and a block that changed during the pass. Another chain or a difference from the pins holds
 * the token at once.
 */
function retryable(failure: ImplementationCheckFailure): boolean {
    return (failure.category === 'transport' && failure.reason !== 'unsupported')
        || failure.category === 'block'
        || (failure.category === 'chain' && failure.reason === 'head_behind');
}

/** Waits between the attempts of one RPC within a check (default); the attempts are one more than the waits. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];
/**
 * No further attempt starts later than this after the check began (a timed-out read is not retried), and none
 * starts once another RPC's final answer failed the check.
 */
const RETRY_WINDOW_MS = 8_000;
/** Interval of the periodic check while every token is verified. */
const CHECK_INTERVAL_MS = 30_000;
/** First interval after a periodic check that held a token; it doubles with each further such check, up to CHECK_INTERVAL_MS. */
const HELD_RECHECK_MS = 5_000;
/** An observation older than this holds the token (monotonic clock). */
const MAX_OBSERVATION_AGE_MS = 120_000;
/** While a token stays held, its diagnostics are logged again when they change, and at least this often. */
const HELD_LOG_REPEAT_MS = 300_000;

/** The delay before the next periodic check after `failedChecks` consecutive checks that held a token. */
export function nextCheckDelayMs(failedChecks: number): number {
    if (failedChecks <= 0) return CHECK_INTERVAL_MS;
    return Math.min(CHECK_INTERVAL_MS, HELD_RECHECK_MS * 2 ** Math.min(failedChecks - 1, 16));
}

/** One check of one token over every RPC. */
interface CheckRun {
    readonly startedMonoMs: number;
    /** An RPC's final answer did not confirm the pins. */
    failed: boolean;
}

interface State {
    readonly pin: TokenImplementationPin;
    ok: boolean;
    lastCheckMonoMs: number | null;
    /**
     * The freshness floor: every RPC's head must be at least this. The reviewed block at first; after each confirmed
     * check, the lowest head that check confirmed, if that is higher. Never lowered.
     */
    lastHead: bigint;
    checking?: Promise<boolean> | undefined;
    /** Since when the token is held (monotonic), undefined while it is verified. */
    heldSinceMonoMs?: number | undefined;
    /** The RPCs, stages and reasons of the last failed check, and when its diagnostics were last logged. */
    lastFailureKey?: string | undefined;
    lastFailureLogMonoMs?: number | undefined;
}

export interface TokenImplementationMonitorOptions {
    readonly chain: ChainClient;
    readonly pins: TokenImplementationPins;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly metrics?: RelayMetrics | undefined;
    /** Waits between attempts on one RPC within a check (default DEFAULT_RETRY_DELAYS_MS). */
    readonly retryDelaysMs?: readonly number[] | undefined;
}

/** All modes stop on a code/implementation change or uncertain read. This is a relay policy, not an on-chain pause. */
export class TokenImplementationMonitor {
    private readonly states: Map<string, State>;
    private readonly retryDelaysMs: readonly number[];
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    private checking: Promise<void> | undefined;
    private lastCheckAtMs: number | null = null;
    /** Consecutive periodic checks after which a token was held (the next one comes sooner, see nextCheckDelayMs). */
    private failedChecks = 0;

    constructor(private readonly options: TokenImplementationMonitorOptions) {
        this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
        this.states = new Map(options.pins.tokens.map((pin) => [pin.address.toLowerCase(), {
            pin, ok: false, lastCheckMonoMs: null, lastHead: options.pins.reviewedBlock,
        }]));
        // Scrapes recompute freshness even if the periodic monitor has stopped.
        options.metrics?.watchTokenImplementations(() => [...this.states.values()].map((state) => ({
            token: state.pin.address, unavailable: this.tokenUnavailable(state.pin.address) !== undefined,
        })));
    }

    tokenUnavailable(token: Address): string | undefined {
        const state = this.states.get(token.toLowerCase());
        if (!state || !state.ok || state.lastCheckMonoMs === null || monotonicMs(this.options.clock) - state.lastCheckMonoMs > MAX_OBSERVATION_AGE_MS) {
            return 'Token implementation verification is unavailable or differs from the reviewed pins; relaying is held pending verification';
        }
        return undefined;
    }

    status(): TokenImplementationReport {
        const unavailable = [...this.states.values()].filter((state) => this.tokenUnavailable(state.pin.address)).map((state) => state.pin.address);
        return { ok: unavailable.length === 0, unavailable, lastCheckAtMs: this.lastCheckAtMs };
    }

    /** Fresh checks immediately before a call broadcast, also for allowance mode and stored requests after restart. */
    async checkToken(token: Address): Promise<boolean> {
        const state = this.states.get(token.toLowerCase());
        if (!state) return false;
        state.checking ??= this.read(state).finally(() => { state.checking = undefined; });
        return state.checking;
    }

    /**
     * One RPC's verification pass: chain, head, then the proxy code, implementation slot and implementation code at
     * that head, and the head's hash once more. Returns the verified head; throws CheckFailed.
     */
    private async verifyOn(rpc: ChainClient, state: State): Promise<bigint> {
        const { pins } = this.options;
        const { pin } = state;
        const getStorageAt = rpc.getStorageAt?.bind(rpc);
        const getBlockByNumber = rpc.getBlockByNumber?.bind(rpc);
        if (!getStorageAt || !getBlockByNumber) throw new CheckFailed('client', { category: 'transport', reason: 'unsupported' });
        const [chainId, head] = await Promise.all([readAt('chain_id', rpc.getChainId()), readAt('head', rpc.getBlock('latest'))]);
        if (chainId !== pins.chainId) throw new CheckFailed('chain_id', { category: 'chain', reason: 'chain_mismatch' });
        if (head.number < state.lastHead) throw new CheckFailed('head', { category: 'chain', reason: 'head_behind' });
        const [proxyCode, slot, implementationCode] = await Promise.all([
            readAt('proxy_code', rpc.getCode(pin.address, head.number)),
            readAt('implementation_slot', getStorageAt(pin.address, pin.implementationSlot, head.number)),
            readAt('implementation_code', rpc.getCode(pin.implementationAddress, head.number)),
        ]);
        codeMatches('proxy_code', proxyCode, pin.proxyCodeHash);
        const expectedSlot = `0x${'0'.repeat(24)}${pin.implementationAddress.slice(2)}`.toLowerCase();
        if (slot?.toLowerCase() !== expectedSlot) throw new CheckFailed('implementation_slot', { category: 'pins', reason: 'mismatch' });
        codeMatches('implementation_code', implementationCode, pin.implementationCodeHash);
        const block = await readAt('block_hash', getBlockByNumber(head.number));
        if (!block) throw new CheckFailed('block_hash', { category: 'block', reason: 'block_missing' });
        if (block.hash !== head.hash) throw new CheckFailed('block_hash', { category: 'block', reason: 'block_changed' });
        return head.number;
    }

    /** verifyOn with the retries of a check; never rejects. */
    private async verifyWithRetries(rpc: ChainClient, index: number, state: State, run: CheckRun): Promise<{ head: bigint } | { diagnostic: ImplementationCheckDiagnostic }> {
        const { clock, metrics } = this.options;
        for (let attempt = 1; ; attempt++) {
            let failed: CheckFailed;
            try {
                return { head: await this.verifyOn(rpc, state) };
            } catch (err) {
                failed = err instanceof CheckFailed ? err : new CheckFailed('client', { category: 'transport', reason: 'other' });
            }
            metrics?.tokenImplementationCheckFailures.inc({ rpc: String(index), stage: failed.stage, reason: failed.failure.reason });
            const delay = this.retryDelaysMs[attempt - 1];
            if (!run.failed && delay !== undefined && retryable(failed.failure) && monotonicMs(clock) - run.startedMonoMs + delay <= RETRY_WINDOW_MS) {
                await new Promise((resolve) => setTimeout(resolve, delay));
                if (!run.failed) continue;
            }
            // This RPC does not confirm the pins, so the check fails: the token is held now, not once every RPC has
            // finished, and the other RPCs stop retrying.
            run.failed = true;
            state.ok = false;
            return { diagnostic: { rpc: index, stage: failed.stage, ...failed.failure, attempts: attempt } };
        }
    }

    private async read(state: State): Promise<boolean> {
        const { chain, clock, logger } = this.options;
        const { pin } = state;
        // The observation's age counts from the start of the check: its first reads can be up to the retry window
        // older than its end.
        const run: CheckRun = { startedMonoMs: monotonicMs(clock), failed: false };
        // Every RPC must confirm the pins. Each is asked until its answer is final, so that the diagnostics name every
        // RPC that did not confirm them.
        const results = await Promise.all(rpcClientsOf(chain).map((rpc, i) => this.verifyWithRetries(rpc, i + 1, state, run)));
        const diagnostics = results.flatMap((result) => ('diagnostic' in result ? [result.diagnostic] : []));
        const now = monotonicMs(clock);
        if (diagnostics.length === 0) {
            // The freshness floor rises to the lowest head this check confirmed, never higher: a head only one RPC
            // reports (an inflated one, with consistent code and block hash) would otherwise make every other RPC fail
            // `head_behind` until a restart. Each RPC confirmed its own head, so every RPC has reached the lowest one.
            // Never lower the floor: an RPC must not fall back behind a head that every RPC confirmed.
            const confirmed = results.flatMap((result) => ('head' in result ? [result.head] : []));
            const lowest = confirmed.reduce((a, head) => (head < a ? head : a), confirmed[0] ?? state.lastHead);
            if (lowest > state.lastHead) state.lastHead = lowest;
            if (state.heldSinceMonoMs !== undefined) {
                logger.warn({ token: pin.address, heldMs: Math.round(now - state.heldSinceMonoMs) }, 'token implementation matches the reviewed pins again');
            }
            state.ok = true;
            state.heldSinceMonoMs = undefined;
            state.lastFailureKey = undefined;
        } else {
            // Diagnostics carry positions, stages and classified reasons only: RPC bodies can contain credential-bearing endpoints.
            const key = diagnostics.map((d) => `${d.rpc}:${d.stage}:${d.reason}`).join(',');
            if (state.heldSinceMonoMs === undefined) {
                state.heldSinceMonoMs = now;
                state.lastFailureLogMonoMs = now;
                logger.error({ alert: 'token_implementation_unavailable', token: pin.address, failures: diagnostics }, 'ALERT: token implementation verification failed; all authorization modes are held');
            } else if (key !== state.lastFailureKey || now - (state.lastFailureLogMonoMs ?? now) >= HELD_LOG_REPEAT_MS) {
                state.lastFailureLogMonoMs = now;
                logger.warn({ token: pin.address, heldMs: Math.round(now - state.heldSinceMonoMs), failures: diagnostics }, 'token implementation verification still fails; all authorization modes remain held');
            }
            state.lastFailureKey = key;
            state.ok = false;
        }
        state.lastCheckMonoMs = run.startedMonoMs;
        this.lastCheckAtMs = clock.nowMs();
        return state.ok;
    }

    check(): Promise<void> {
        this.checking ??= Promise.all([...this.states.values()].map((state) => this.checkToken(state.pin.address))).then((verified) => {
            this.failedChecks = verified.every(Boolean) ? 0 : this.failedChecks + 1;
        }).finally(() => { this.checking = undefined; });
        return this.checking;
    }

    /** Checks every CHECK_INTERVAL_MS, and sooner while a token is held (nextCheckDelayMs). */
    start(): void {
        if (this.running) return;
        this.running = true;
        const loop = (): void => {
            if (!this.running) return;
            this.timer = setTimeout(() => { void this.check().finally(loop); }, nextCheckDelayMs(this.failedChecks));
        };
        loop();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        await this.checking;
        await Promise.all([...this.states.values()].map((state) => state.checking));
    }
}
