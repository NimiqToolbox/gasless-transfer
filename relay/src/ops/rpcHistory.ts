// The state of older blocks that every configured RPC must serve (docs/STEP-1-GAS-ABSTRACTION.md §6.2, §6.5; relay/README.md, "RPC
// history"). When a request's intent nonce is used while no RPC answers a receipt of its transactions, each RPC locates
// the block that used it from historical nonces(signer) (quorum.findNonceUse): from its head down to about as far below
// that block as the block is below the head. An RPC without that state holds the decision back for good. Startup
// refuses such an RPC, as it refuses one on another chain, and this monitor repeats the check while the relay runs.
import { zeroAddress, type Address } from 'viem';
import { MAX_DEADLINE_SECONDS } from '@nimiq/gasless-sdk/core';
import { readIntentNonce } from '../chain/reads.js';
import type { ChainClient } from '../chain/types.js';
import { classifyRpcFailure } from '../chain/viemChainClient.js';
import { monotonicMs, type Clock } from '../clock.js';
import type { TxManagerSettings } from '../config.js';
import type { Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';
import { StartupError } from '../startup.js';
import { MAX_RECEIPT_READS, answeredNoData, refusedBlockReceipts, rpcClientsOf } from '../tx/quorum.js';
import { finalityDepthFloor, txPolicy, type TxPolicySettings } from '../tx/settings.js';

/** What the history window is derived from: the request life and the transaction manager's settings. */
export interface HistoryWindowSettings {
    readonly chainId: number;
    /** The longest deadline the relay accepts (7200 s). */
    readonly maxDeadlineSeconds: number;
    readonly unknownNonceGraceBlocks: number;
    readonly minFinalityDepth: number;
    readonly finalityFallbackDepth: number;
    readonly maxFinalityLagBlocks: number;
    readonly stuckAfterBlocks: number;
}

/**
 * How far below its head every RPC must serve state, in blocks:
 *
 *     window = 2 × (maxDeadlineSeconds + RELAY_UNKNOWN_NONCE_GRACE_BLOCKS
 *                   + max(RELAY_MAX_FINALITY_LAG_BLOCKS, RELAY_FINALITY_FALLBACK_DEPTH, RELAY_MIN_FINALITY_DEPTH)
 *                   + RELAY_STUCK_AFTER_BLOCKS)
 *
 * A request is used at most maxDeadlineSeconds after its acceptance, and a chain adds at most one block per second
 * (block timestamps rise by at least 1 s), so that many blocks. The first search runs a grace period after its tx nonce
 * was seen used; a settlement locates the block again once it is final, which the finality margin bounds (the
 * `finalized` tag at most RELAY_MAX_FINALITY_LAG_BLOCKS behind before readiness fails, or the fallback depth); a
 * decision that waits longer than RELAY_STUCK_AFTER_BLOCKS raises the ALERT. The sum bounds the depth d of the block
 * that used a nonce below the head of a search, and the search's steps read down to 2·d + 1 below the head (Polygon PoS
 * makes a block every 1.5 s, not every second, so d stays well below the sum). With the defaults:
 * 2 × (7200 + 12 + 600 + 150) = 15,924 blocks, about 6.6 h at 1.5 s per block.
 */
export function historyWindowBlocks(s: HistoryWindowSettings): bigint {
    const floor = finalityDepthFloor(s.chainId);
    const finality = Math.max(s.maxFinalityLagBlocks, Math.max(s.finalityFallbackDepth, floor), Math.max(s.minFinalityDepth, floor));
    return 2n * BigInt(s.maxDeadlineSeconds + s.unknownNonceGraceBlocks + finality + s.stuckAfterBlocks);
}

/** historyWindowBlocks of the relay's configuration (policy fields left out take their defaults). */
export function historyWindowOf(chainId: number, tx: Pick<TxManagerSettings, 'unknownNonceGraceBlocks' | 'finalityFallbackDepth'> & Partial<TxPolicySettings>): bigint {
    const policy = txPolicy(tx);
    return historyWindowBlocks({
        chainId,
        maxDeadlineSeconds: MAX_DEADLINE_SECONDS,
        unknownNonceGraceBlocks: tx.unknownNonceGraceBlocks,
        minFinalityDepth: policy.minFinalityDepth,
        finalityFallbackDepth: tx.finalityFallbackDepth,
        maxFinalityLagBlocks: policy.maxFinalityLagBlocks,
        stuckAfterBlocks: policy.stuckAfterBlocks,
    });
}

/** One RPC's answer to the check (by position in RELAY_RPC_URLS, 1-based; never its URL or message). */
export interface RpcHistory {
    readonly rpc: number;
    readonly ok: boolean;
    /** The block whose state was read: max(deployBlock, head − window). */
    readonly block?: string;
    /** Why not: the failure's reason or JSON-RPC code. */
    readonly reason?: string;
    /**
     * The RPC did not answer (no head, or a timeout, a rate limit, an HTTP error or no connection for the state read),
     * as the search classifies it (quorum.findNonceUse): no refusal of the state.
     */
    readonly silent?: true;
}

const describe = (err: unknown): string => {
    const failure = classifyRpcFailure(err);
    return failure.rpcCode !== undefined ? `error ${failure.rpcCode}` : failure.httpStatus !== undefined ? `HTTP ${failure.httpStatus}` : failure.reason;
};

/** Whether a failed state read is the RPC's answer (a JSON-RPC error: it has no state of that block), as the search takes it. */
const answered = (err: unknown): boolean => {
    const { reason } = classifyRpcFailure(err);
    return reason === 'rpc_error' || reason === 'other';
};

const headOf = async (rpc: ChainClient): Promise<bigint> => (rpc.getBlockNumber ? rpc.getBlockNumber() : (await rpc.getBlock('latest')).number);

/**
 * Every configured RPC (by position) reads `nonces(anything)` of the contract at max(deployBlock, its head − window). A
 * value, or no data (between deployBlock and the contract's creation), shows the state; an error answer refuses it; no
 * answer is `silent`.
 */
export async function checkRpcHistory(chain: ChainClient, contract: Address, deployBlock: bigint, window: bigint): Promise<RpcHistory[]> {
    return Promise.all(
        rpcClientsOf(chain).map(async (rpc, i): Promise<RpcHistory> => {
            let head: bigint;
            try {
                head = await headOf(rpc);
            } catch (err) {
                return { rpc: i + 1, ok: false, reason: `no head (${describe(err)})`, silent: true };
            }
            const block = head - window > deployBlock ? head - window : deployBlock;
            try {
                await readIntentNonce(rpc, contract, zeroAddress, block);
            } catch (err) {
                if (!answeredNoData(err)) return { rpc: i + 1, ok: false, block: block.toString(), reason: describe(err), ...(answered(err) ? {} : { silent: true as const }) };
            }
            return { rpc: i + 1, ok: true, block: block.toString() };
        }),
    );
}

/** eth_getBlockReceipts per RPC (by position): `yes`, `no` (refused) or `no answer`, asked for the block given. */
async function blockReceiptsSupport(chain: ChainClient, block: (rpc: number) => bigint | undefined): Promise<Array<{ rpc: number; blockReceipts: 'yes' | 'no' | 'no answer' }>> {
    return Promise.all(
        rpcClientsOf(chain).map(async (rpc, i) => {
            const at = block(i + 1);
            if (!rpc.getBlockReceipts) return { rpc: i + 1, blockReceipts: 'no' as const };
            try {
                const receipts = await rpc.getBlockReceipts(at ?? (await headOf(rpc)));
                return { rpc: i + 1, blockReceipts: receipts === null ? ('no answer' as const) : ('yes' as const) };
            } catch (err) {
                return { rpc: i + 1, blockReceipts: refusedBlockReceipts(err) ? ('no' as const) : ('no answer' as const) };
            }
        }),
    );
}

/**
 * Startup: refuses to start unless every configured RPC serves the state at max(deployBlock, head − window), as it
 * refuses an RPC on another chain, and logs which RPCs serve eth_getBlockReceipts (asked for the block checked). The
 * results go to the monitor.
 */
export async function verifyRpcHistory(chain: ChainClient, contract: Address, deployBlock: bigint, window: bigint, logger?: Logger): Promise<RpcHistory[]> {
    const results = await checkRpcHistory(chain, contract, deployBlock, window);
    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
        throw new StartupError(
            `every RPC in RELAY_RPC_URLS must serve the state of the last ${window} blocks (an archive node, or one that keeps that much state):\n - ` +
                failures
                    .map((f) => `RPC #${f.rpc}: ${f.silent || f.block === undefined ? `no answer${f.block !== undefined ? ` at block ${f.block}` : ''}` : `no state at block ${f.block}`} (${f.reason ?? 'error'})`)
                    .join('\n - '),
        );
    }
    const support = await blockReceiptsSupport(chain, (rpc) => {
        const block = results.find((r) => r.rpc === rpc)?.block;
        return block === undefined ? undefined : BigInt(block);
    });
    logger?.info(
        { window: window.toString(), rpcs: support },
        `every RPC serves the state of older blocks; eth_getBlockReceipts per RPC (where not: receipts are read one by one, at most ${MAX_RECEIPT_READS} per block)`,
    );
    return results;
}

export interface RpcHistoryReport {
    /** False while an RPC failed the last check. */
    readonly ok: boolean;
    readonly window: string;
    readonly failures: readonly RpcHistory[];
    readonly lastCheckAtMs: number | null;
}

export interface RpcHistoryMonitorOptions {
    readonly chain: ChainClient;
    readonly contract: Address;
    readonly deployBlock: bigint;
    readonly window: bigint;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly metrics?: RelayMetrics | undefined;
}

/** Minimum interval between repeated ALERT lines while an RPC keeps failing (monotonic clock). */
const ALERT_REPEAT_MS = 300_000;

/**
 * Repeats the startup check every interval. An RPC that refuses the state (an error answer, as the search takes it) makes
 * the relay degraded (it stays ready: ordinary work goes on, and only the decisions that need the state of older blocks
 * wait), sets `relay_rpc_history_unavailable{rpc}` to 1 and logs an ALERT (again when the failing RPCs change, and every
 * 5 minutes while it lasts). A later check it passes clears that. A check an RPC does not answer (a timeout, a rate
 * limit, a lost connection) changes nothing: its last answered result stands.
 */
export class RpcHistoryMonitor {
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    private checking: Promise<void> | undefined;
    private failures: readonly RpcHistory[] = [];
    /** The last answered result of each RPC (by position). */
    private readonly answers = new Map<number, RpcHistory>();
    private lastCheckAtMs: number | null = null;
    private lastAlertMonoMs = Number.NEGATIVE_INFINITY;

    constructor(private readonly options: RpcHistoryMonitorOptions) {
        for (let i = 1; i <= rpcClientsOf(options.chain).length; i++) options.metrics?.rpcHistoryUnavailable.set({ rpc: String(i) }, 0);
    }

    status(): RpcHistoryReport {
        return { ok: this.failures.length === 0, window: this.options.window.toString(), failures: this.failures, lastCheckAtMs: this.lastCheckAtMs };
    }

    /** Applies a check made elsewhere (startup's). */
    record(checked: readonly RpcHistory[]): void {
        const { clock, logger, metrics, window } = this.options;
        const silent = checked.filter((r) => r.silent);
        if (silent.length > 0) {
            logger.warn({ rpcs: silent }, `${silent.map((r) => `RPC #${r.rpc}`).join(', ')} did not answer the check of the state of older blocks; the last answer stands`);
        }
        for (const r of checked) if (!r.silent) this.answers.set(r.rpc, r);
        const results = checked.map((r) => this.answers.get(r.rpc) ?? { rpc: r.rpc, ok: true });
        const failures = results.filter((r) => !r.ok);
        for (const r of results) metrics?.rpcHistoryUnavailable.set({ rpc: String(r.rpc) }, r.ok ? 0 : 1);
        const mono = monotonicMs(clock);
        const changed = failures.map((f) => f.rpc).join() !== this.failures.map((f) => f.rpc).join();
        if (failures.length > 0 && (changed || mono - this.lastAlertMonoMs >= ALERT_REPEAT_MS)) {
            this.lastAlertMonoMs = mono;
            logger.error(
                { alert: 'rpc_history', window: window.toString(), failures },
                `ALERT: ${failures.map((f) => `RPC #${f.rpc}`).join(', ')} in RELAY_RPC_URLS does not serve the state of older blocks that the search for the use of an intent nonce reads (the last ${window} blocks): such decisions wait until it does, or until it is replaced`,
            );
        } else if (failures.length === 0 && this.failures.length > 0) {
            logger.warn({ window: window.toString() }, 'every RPC serves the state of older blocks again');
        }
        this.failures = failures;
        this.lastCheckAtMs = clock.nowMs();
    }

    /** Checks every `intervalMs` (the first check after one interval: startup just checked). 0: off. */
    start(intervalMs: number): void {
        if (this.running || intervalMs <= 0) return;
        this.running = true;
        const loop = (): void => {
            if (!this.running) return;
            this.timer = setTimeout(() => {
                void this.check().finally(loop);
            }, intervalMs);
        };
        loop();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        await this.checking;
    }

    /** One check of every RPC; never rejects. Concurrent calls share the running check. */
    check(): Promise<void> {
        const { chain, contract, deployBlock, window } = this.options;
        this.checking ??= checkRpcHistory(chain, contract, deployBlock, window)
            .then((results) => this.record(results))
            .finally(() => {
                this.checking = undefined;
            });
        return this.checking;
    }
}
