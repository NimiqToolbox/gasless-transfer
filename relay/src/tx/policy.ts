// Pure rules of the transaction manager (gas limit, spend cap, finality, nonce gaps), kept apart so that
// each one can be tested on its own. relay/docs/transaction-lifecycle.md explains the reasons.
import type { PriceReading } from '../fees/priceSource.js';
import { ceilDiv, minBig } from '../util/bigint.js';

/** Stablecoin fees have 6 decimals; wei has 18. */
const FEE_TO_WEI_DECIMALS = 12;

/**
 * The block up to which the relay treats inclusions as final: the node's `finalized` tag, but never less
 * than `minDepth` blocks below head (a node that answers `finalized` with its head block must not
 * make a fresh inclusion final). -1 when nothing is final yet.
 */
export function effectiveFinalized(head: bigint, finalizedTag: bigint, minDepth: number): bigint {
    const byDepth = head - BigInt(minDepth);
    return minBig(finalizedTag, byDepth < 0n ? -1n : byDepth);
}

/**
 * The same bound for a node without the `finalized` tag (or when reading it fails): `max(fallbackDepth, minDepth)`
 * blocks below head. -1 when nothing
 * is final yet.
 */
export function fallbackFinalized(head: bigint, fallbackDepth: number, minDepth: number): bigint {
    const byDepth = head - BigInt(Math.max(fallbackDepth, minDepth));
    return byDepth < 0n ? -1n : byDepth;
}

/**
 * The order in which queued requests are served: priority first; within a priority, round-robin across
 * senders. Round r holds the r-th oldest queued request of every sender, so one sender's backlog delays another
 * sender's request by at most one round. Within a round, senders with fewer requests in flight come first, then
 * the sender whose oldest queued request is older; so a sender waiting for its first slot is not overtaken by a
 * sender that already has transactions in flight, however slots free up.
 *
 * `queued` must be in priority, then insertion order (Store.listByStatus). `inFlight` counts each sender's
 * requests with a transaction in flight (lowercase addresses).
 */
export function fairOrder<T extends { readonly priority: number; readonly signer: string }>(
    queued: readonly T[],
    inFlight: ReadonlyMap<string, number> = new Map(),
): T[] {
    const out: T[] = [];
    let i = 0;
    while (i < queued.length) {
        const priority = queued[i]!.priority;
        const lanes = new Map<string, T[]>();
        for (; i < queued.length && queued[i]!.priority === priority; i++) {
            const request = queued[i]!;
            const sender = request.signer.toLowerCase();
            const lane = lanes.get(sender);
            if (lane) lane.push(request);
            else lanes.set(sender, [request]);
        }
        // Map order is the order of each sender's oldest request; the sort is stable.
        const ordered = [...lanes.entries()].sort(([a], [b]) => (inFlight.get(a) ?? 0) - (inFlight.get(b) ?? 0)).map(([, lane]) => lane);
        const rounds = Math.max(...ordered.map((lane) => lane.length));
        for (let round = 0; round < rounds; round++) for (const lane of ordered) if (round < lane.length) out.push(lane[round]!);
    }
    return out;
}

export type GasLimitDecision = { readonly ok: true; readonly gas: bigint } | { readonly ok: false; readonly needed: bigint; readonly cap: bigint };

/**
 * Gas limit of a call: the estimate plus the margin, capped by the gas table entry (the measured
 * worst case plus 10%, which is also what the fee was priced with) and by RELAY_MAX_GAS_LIMIT. Without an
 * estimate the cap itself is used. A call whose estimate alone exceeds the cap is refused: it would run out
 * of gas or cost more than it was priced at.
 */
export function callGasLimit(o: { estimate: bigint | undefined; table: bigint | undefined; maxGasLimit: bigint; marginPercent: number }): GasLimitDecision {
    const cap = o.table !== undefined ? minBig(o.table, o.maxGasLimit) : o.maxGasLimit;
    if (o.estimate === undefined) return { ok: true, gas: cap };
    if (o.estimate > cap) return { ok: false, needed: o.estimate, cap };
    return { ok: true, gas: minBig(ceilDiv(o.estimate * BigInt(100 + o.marginPercent), 100n), cap) };
}

/** A fee in 6-decimal stablecoin units ($1 each) converted to wei at `price` USD per POL, rounded down. */
export function feeInWei(fee: bigint, price: PriceReading): bigint {
    if (price.value <= 0n || fee <= 0n) return 0n;
    return (fee * 10n ** BigInt(FEE_TO_WEI_DECIMALS + price.decimals)) / price.value;
}

/**
 * The highest maxFeePerGas a call may be sent with: gas limit × maxFeePerGas stays
 * within `percent` % of the request's fee, so a request never costs the relay much more than it earns.
 */
export function spendCapPerGas(fee: bigint, price: PriceReading, gasLimit: bigint, percent: number): bigint {
    if (gasLimit <= 0n) return 0n;
    return (feeInWei(fee, price) * BigInt(percent)) / 100n / gasLimit;
}

export interface NonceView {
    /** getTransactionCount(latest): every nonce below it is used on-chain. */
    readonly latest: number;
    /** getTransactionCount(pending): the node also holds executable transactions up to here. */
    readonly pending: number;
    /** The relay's stored next nonce. */
    readonly next: number;
    /** Nonces of the relay's own transactions in flight (requests and gap fillers). */
    readonly tracked: ReadonlySet<number>;
    /** The gap fillers among `tracked`: they fill a gap, but no transaction waits for them. */
    readonly fillers?: ReadonlySet<number> | undefined;
}

export interface NonceAnalysis {
    /**
     * The stored next nonce can go down to this value: no transaction of the relay uses a nonce from here up,
     * and the node holds nothing there either (e.g. untracked transactions that were adopted at startup and
     * then evicted). The nonces are re-used instead of being left as a gap.
     */
    readonly lowerNextTo: number | undefined;
    /**
     * Nonces between the chain's latest nonce and the lowest in-flight relay nonce that no relay transaction
     * occupies, lowest first and at most `limit` of them (analyzeNonces). While they stay unused, every relay
     * transaction above them waits; after RELAY_NONCE_GAP_BLOCKS the relay fills them with 0-value self-transfers.
     */
    readonly missing: readonly number[];
    /** The lowest nonce of a relay transaction other than a gap filler in flight at or above the chain's latest nonce, if any. */
    readonly lowestInFlight: number | undefined;
}

/**
 * The relay's nonce range as `v` shows it. `missing` lists at most `limit` nonces, so the work does not depend on how
 * large a gap an RPC reports.
 */
export function analyzeNonces(v: NonceView, limit = Number.POSITIVE_INFINITY): NonceAnalysis {
    // Tracked nonces below the latest nonce are used on-chain already (by whichever transaction): not in flight.
    const inFlight = [...v.tracked].filter((n) => n >= v.latest);
    const highest = inFlight.length > 0 ? Math.max(...inFlight) : undefined;
    const top = highest === undefined ? v.latest : Math.max(v.latest, highest + 1);
    const lowerNextTo = v.next > top && v.pending <= top ? top : undefined;
    const waiting = inFlight.filter((n) => !v.fillers?.has(n));
    const lowest = waiting.length > 0 ? Math.min(...waiting) : undefined;
    const missing: number[] = [];
    if (lowest !== undefined) for (let n = v.latest; n < lowest && missing.length < limit; n++) if (!v.tracked.has(n)) missing.push(n);
    return { lowerNextTo, missing, lowestInFlight: lowest };
}

/** The relay account's nonces as one RPC reports them. */
export interface AccountNonces {
    readonly latest: number;
    readonly pending: number;
}

/**
 * The relay account's nonces as every configured RPC reports them, combined for the decisions that change the relay's
 * nonce range. A single RPC's count is never used on its own:
 * - `lowestPending`: the stored next nonce is raised from chain state only up to this (transactions of the key that
 *   the relay does not track are skipped only where every RPC holds them);
 * - `highestLatest`: every nonce below it is used on some RPC's chain, so gap fillers go only at or above it;
 * - `highestPending`: the stored next nonce is lowered (nonces re-used) only down to where no RPC holds a transaction.
 */
export function combineNonces(views: readonly AccountNonces[]): { lowestPending: number; highestLatest: number; highestPending: number } {
    if (views.length === 0) throw new Error('no RPC answered');
    return {
        lowestPending: Math.min(...views.map((v) => v.pending)),
        highestLatest: Math.max(...views.map((v) => v.latest)),
        highestPending: Math.max(...views.map((v) => v.pending)),
    };
}
