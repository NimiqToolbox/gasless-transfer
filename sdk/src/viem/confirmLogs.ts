// The log search of the on-chain check (confirm.ts), for an RPC that refuses reads of older state, and its progress
// from one check of a payment to the next.

import { encodeEventTopics, pad } from 'viem';
import { usdcAbi } from '../core/abi.js';
import { MAX_DEADLINE_SECONDS } from '../core/constants.js';
import type { Hex } from '../core/types.js';
import { missing, notUsed, type Block, type Bracket, type LogFilter, type OnChainConfirmation, type Search } from './confirmContext.js';
import { executionAmong, executionInBlock, invalidationFilter, invalidationIn } from './confirmEvidence.js';
import { blockWithTransactions, headerAt, logsIn, unusedAt } from './confirmRpc.js';

/** How long before the earliest deadline the log search starts: the longest lifetime the SDK signs, plus a margin for clocks. */
const SEARCH_BEFORE_DEADLINE_SECONDS = BigInt(MAX_DEADLINE_SECONDS) + 600n;
/** Blocks per eth_getLogs query at first; halved each time the RPC refuses a range. */
const LOG_RANGE_BLOCKS = 1_000n;
/** A response with this many Transfer logs may be cut off by the RPC: it counts as refused. */
const MAX_LOGS_PER_RESPONSE = 1_000;
/**
 * Blocks below the block read whose log answers are not taken as final: a load-balanced RPC can answer eth_getLogs
 * from an index that lags the block it serves, with no log for blocks that have some. The log ranges a check searched
 * there are searched again by the next check of the payment (`scan`); a block whose transactions it read is not.
 */
export const LOG_INDEX_LAG_BLOCKS = 128n;

const TRANSFER_TOPIC = encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer' })[0] as Hex;

/** Blocks lo to hi. */
interface Span {
    readonly lo: bigint;
    readonly hi: bigint;
}

/**
 * What the log search of the earlier checks of one payment (`waitForTransferOutcome`'s polls, with the same target and
 * options) found out. It holds while the block the last of them read (`anchor`) is still the block of its number on
 * the RPC: a block hash commits to every block below it, so none of them changed. Otherwise it is cleared. An empty
 * log answer counts only LOG_INDEX_LAG_BLOCKS below the block read: closer to it, the RPC's log index may lag.
 */
export interface SearchProgress {
    anchor: { readonly number: bigint; readonly hash: Hex } | undefined;
    /** The lowest block at which the nonce was seen used, and the highest at which it was seen unused. */
    used: bigint | undefined;
    unused: bigint | undefined;
    /** The default start of the log search, and the last block at or before the deadline, once found. */
    start: bigint | undefined;
    last: bigint | undefined;
    /** The size of the next log range (`scan`). */
    readonly cursor: { range: bigint };
    /**
     * Blocks searched for executions and invalidations, and for invalidations only, without an answer, at least
     * LOG_INDEX_LAG_BLOCKS below the block read then.
     */
    readonly executions: Span[];
    readonly invalidations: Span[];
    /** Blocks whose transactions were read (their Transfer logs refused or cut off) without an execution. */
    readonly blocks: Span[];
}

/** An empty progress, for the first check of a payment. */
export function newSearchProgress(): SearchProgress {
    return {
        anchor: undefined,
        used: undefined,
        unused: undefined,
        start: undefined,
        last: undefined,
        cursor: { range: LOG_RANGE_BLOCKS },
        executions: [],
        invalidations: [],
        blocks: [],
    };
}

function clearProgress(progress: SearchProgress): void {
    progress.anchor = undefined;
    progress.used = undefined;
    progress.unused = undefined;
    progress.start = undefined;
    progress.last = undefined;
    progress.executions.length = 0;
    progress.invalidations.length = 0;
    progress.blocks.length = 0;
}

/** Adds [lo, hi] to `spans`, merged with the spans it overlaps or adjoins. */
function addSpan(spans: Span[], lo: bigint, hi: bigint): void {
    let merged: Span = { lo, hi };
    const kept: Span[] = [];
    for (const span of spans) {
        if (span.hi + 1n < merged.lo || span.lo > merged.hi + 1n) kept.push(span);
        else merged = { lo: span.lo < merged.lo ? span.lo : merged.lo, hi: span.hi > merged.hi ? span.hi : merged.hi };
    }
    kept.push(merged);
    spans.splice(0, spans.length, ...kept);
}

/**
 * The logs of [lo, hi] for the search without historical state: with `executions` the pinned tokens' Transfer logs
 * from the sender, whose transactions are checked (`executionAmong`), then the sender's NonceInvalidated events.
 * 'refused' if the RPC refuses a query of more than one block. A Transfer query that it refuses for one block, or
 * answers with MAX_LOGS_PER_RESPONSE logs (it may have cut them off; anyone can add zero-amount Transfer logs of the
 * sender), is replaced by that block's transactions (`executionInBlock`; `scanned`, and `read` if that read missed
 * nothing). A refused NonceInvalidated query of one block throws the RPC's error: only the sender emits those events.
 */
async function logRange(
    search: Search,
    lo: bigint,
    hi: bigint,
    executions: boolean,
): Promise<'refused' | { readonly answer: OnChainConfirmation | undefined; readonly scanned: boolean; readonly read: boolean }> {
    let scanned = false;
    let read = false;
    if (executions) {
        const transfers: LogFilter = {
            address: search.pins.tokens.map((token) => token.address),
            topics: [TRANSFER_TOPIC, pad(search.request.from.toLowerCase() as Hex, { size: 32 })],
        };
        const logs = await logsIn(search, transfers, lo, hi);
        let answer: OnChainConfirmation | undefined;
        if (!('refused' in logs) && logs.length < MAX_LOGS_PER_RESPONSE) {
            answer = await executionAmong(search, logs, lo, hi);
        } else if (hi > lo) {
            return 'refused';
        } else {
            scanned = true;
            const before = search.seen.missing;
            const block = await blockWithTransactions(search, lo);
            answer = block === undefined ? missing(search) : await executionInBlock(search, block);
            read = search.seen.missing === before;
        }
        if (answer !== undefined) return { answer, scanned, read };
    }
    const logs = await logsIn(search, invalidationFilter(search), lo, hi);
    if ('refused' in logs) {
        if (hi > lo) return 'refused';
        throw logs.refused;
    }
    return { answer: await invalidationIn(search, logs, lo, hi), scanned, read };
}

/**
 * The two parts of the log search (`searchLogs`): the blocks up to the last one at or before the deadline, searched
 * top down for executions and invalidations, and the blocks after it, searched bottom up for invalidations only.
 */
type ScanPart = 'toDeadline' | 'afterDeadline';

/**
 * Scans [from, to] for the use of the nonce, top down for executions and invalidations (`toDeadline`) or bottom up for
 * invalidations only (`afterDeadline`), in ranges of at most `progress.cursor.range` blocks. A range the RPC refuses is
 * split in half and tried again, and the smaller size is kept: providers limit the range of one query. Refusals down
 * to one block whose transactions were then read came from that block's logs, not from such a limit: the size starts
 * again at LOG_RANGE_BLOCKS. Blocks that an earlier check of the payment searched without an answer are skipped
 * (`SearchProgress`), and so are, for executions, the blocks whose transactions it read (their invalidations are
 * searched with one log query). A range searched without an answer and without a `missing` read is added to them, as
 * far as it is at least LOG_INDEX_LAG_BLOCKS below the block read: an empty log answer of a range closer to it may come
 * from a log index behind it, so the next check searches that range again.
 */
async function scan(
    search: Search,
    bounds: { readonly from: bigint; readonly to: bigint; readonly part: ScanPart },
    progress: SearchProgress,
): Promise<OnChainConfirmation | undefined> {
    const { cursor } = progress;
    // Direction and content go together: the range arithmetic below holds for these two pairs only.
    const executions = bounds.part === 'toDeadline';
    const downward = executions;
    const searched = executions ? progress.executions : progress.invalidations;
    // A range searched for executions was searched for invalidations too.
    const covered = executions ? progress.executions : [...progress.executions, ...progress.invalidations];
    const read = executions ? progress.blocks : [];
    const settled = search.block.number - LOG_INDEX_LAG_BLOCKS;
    let { from, to } = bounds;
    while (from <= to) {
        const edge = downward ? to : from;
        const skipped = covered.find((span) => span.lo <= edge && edge <= span.hi);
        if (skipped !== undefined) {
            if (downward) to = skipped.lo - 1n;
            else from = skipped.hi + 1n;
            continue;
        }
        // Blocks whose transactions were read (`read` is empty for the upward scan of invalidations).
        const known = read.find((span) => span.lo <= edge && edge <= span.hi);
        const size = cursor.range;
        let lo = downward ? (to - from + 1n > size ? to - size + 1n : from) : from;
        let hi = downward ? to : to - from + 1n > size ? from + size - 1n : to;
        if (known !== undefined && known.lo > lo) lo = known.lo;
        for (const span of known === undefined ? [...covered, ...read] : covered) {
            if (downward && span.hi < to && span.hi >= lo) lo = span.hi + 1n;
            if (!downward && span.lo > from && span.lo <= hi) hi = span.lo - 1n;
        }
        const before = search.seen.missing;
        const result = await logRange(search, lo, hi, executions && known === undefined);
        if (result === 'refused') {
            cursor.range = (hi - lo + 1n) / 2n;
            continue;
        }
        // At most one transaction uses a nonce, so the first match is the answer.
        if (result.answer !== undefined) return result.answer;
        if (search.seen.missing === before && lo <= settled) addSpan(searched, lo, hi < settled ? hi : settled);
        if (result.read) addSpan(progress.blocks, lo, hi);
        if (result.scanned) cursor.range = LOG_RANGE_BLOCKS;
        if (downward) to = lo - 1n;
        else from = hi + 1n;
    }
    return undefined;
}

/**
 * The lowest block number in [low, high.number] whose timestamp is at least `target`, or high.number + 1 if there is
 * none. Block timestamps never decrease. Interpolation steps alternate with bisection steps, so a skewed chain costs
 * at most twice the reads of a plain bisection; a regular one (Polygon PoS) needs a few.
 */
async function firstBlockAtOrAfter(search: Search, target: bigint, low: bigint, high: Block): Promise<bigint> {
    if (high.timestamp < target) return high.number + 1n;
    if (low >= high.number) return high.number;
    let lo = low;
    let loTs = (await headerAt(search, lo)).timestamp;
    if (loTs >= target) return lo;
    let hi = high.number;
    let hiTs = high.timestamp;
    // Invariant: timestamp(lo) < target <= timestamp(hi), so hiTs > loTs.
    for (let step = 0; hi - lo > 1n; step++) {
        let mid = step % 2 === 0 ? lo + ((target - loTs) * (hi - lo)) / (hiTs - loTs) : lo + (hi - lo) / 2n;
        if (mid <= lo) mid = lo + 1n;
        if (mid >= hi) mid = hi - 1n;
        const ts = (await headerAt(search, mid)).timestamp;
        if (ts >= target) {
            hi = mid;
            hiTs = ts;
        } else {
            lo = mid;
            loTs = ts;
        }
    }
    return hi;
}

/**
 * The search on an RPC that refused a read of older state (`firstUse` returned `found`): the use is at or below
 * `found.used` and above `found.unused`. A version of the payment executes only in a block whose timestamp is at most
 * its deadline, after it was signed, and the SDK and the relay accept a deadline at most 7200 s after the signing. So
 * executions are searched from `d − 7800 s` (d the earliest deadline of the versions, or `fromBlock`) up to the last
 * block at or before the deadline, top down (a request usually executes soon after it is signed, near the top).
 * Invalidations are searched there too, and on up to `found.used`, bottom up: they can come after the deadline.
 *
 * Past the deadline the nonce is first read at the last block at or before it: if it was unused there, no version
 * executed, whatever used the nonce later (an invalidation, or a later payment of the sender at the same nonce),
 * and the answer is `expired`. A node without that block's state answers nothing, and the search decides. If that
 * block lies below `floor` (`pins.deployBlock`), it is not read and the search gives no answer: the pin alone does
 * not show that the nonce was unused there (the state search reads the block under the pin for that, `firstUse`).
 *
 * The earlier checks of the payment (`progress`) narrow the bracket and skip the blocks they searched, as long as the
 * block the last of them read is still the block of its number here (`resume`). So the polls of
 * `waitForTransferOutcome` go on where the previous one stopped, and the blocks above the use are searched once, except
 * the log queries of the blocks within LOG_INDEX_LAG_BLOCKS of the block a poll read, which the next poll repeats.
 */
export async function searchLogs(search: Search, fromBlock: bigint | undefined, floor: bigint, found: Bracket, progress: SearchProgress): Promise<OnChainConfirmation | undefined> {
    const { block, deadline } = search;
    await resume(search, progress);
    let { used, unused } = found;
    if (progress.used !== undefined && progress.used < used) used = progress.used;
    if (progress.unused !== undefined && (unused === undefined || progress.unused > unused)) unused = progress.unused;
    if (unused !== undefined && unused >= used) {
        // Not one chain: start again from this check's own reads.
        clearProgress(progress);
        ({ used, unused } = found);
    }
    // Set after the progress may have been cleared: what this check finds from here on holds for the block it read.
    if (block.hash !== null) progress.anchor = { number: block.number, hash: block.hash };
    progress.used = used;
    progress.unused = unused;
    let from = fromBlock ?? progress.start;
    if (from === undefined) {
        from = await firstBlockAtOrAfter(search, search.earliestDeadline - SEARCH_BEFORE_DEADLINE_SECONDS, floor, block);
        if (from <= block.number) progress.start = from;
    }
    if (from < floor) from = floor;
    let executionEnd = used;
    let usedByDeadline: boolean | undefined;
    if (block.timestamp > deadline) {
        let last = progress.last;
        if (last === undefined) {
            const low = from <= block.number ? from : floor;
            let first = await firstBlockAtOrAfter(search, deadline + 1n, low, block);
            // The search start may itself lie after the deadline (a late fromBlock): find the deadline from the floor.
            if (first === low && low > floor) first = await firstBlockAtOrAfter(search, deadline + 1n, floor, block);
            last = first - 1n;
            progress.last = last;
        }
        // Every block from the pin on is after the deadline, and no block below the pin is read. With a pin at or
        // below the contract's creation that cannot be: a payment's deadline is after the creation. With a pin above
        // it, the use can lie below the pin. So this is no evidence of an unused nonce, and neither is a bracket
        // whose `unused` is the block under the pin, which `firstUse` assumes without a read: no answer.
        if (last < floor) return undefined;
        if (unused !== undefined && unused >= last) return notUsed('expired');
        if (used <= last) {
            usedByDeadline = true;
        } else {
            const state = await unusedAt(search, last);
            if (state === true) return notUsed('expired');
            if (state === false) {
                usedByDeadline = true;
                progress.used = last;
            }
            executionEnd = last;
        }
    }
    if (unused !== undefined && from <= unused) from = unused + 1n;
    if (from > used) return undefined;
    const before = await scan(search, { from, to: executionEnd, part: 'toDeadline' }, progress);
    if (before !== undefined || usedByDeadline === true) return before;
    const lower = executionEnd + 1n > from ? executionEnd + 1n : from;
    return scan(search, { from: lower, to: used, part: 'afterDeadline' }, progress);
}

/**
 * Keeps `progress` if the block the previous check read is still the block of its number (a block hash commits to
 * every block below it), else clears it. The caller then makes this check's block read the anchor.
 */
async function resume(search: Search, progress: SearchProgress): Promise<void> {
    const { anchor } = progress;
    const kept =
        anchor !== undefined &&
        anchor.number <= search.block.number &&
        (await headerAt(search, anchor.number)).hash?.toLowerCase() === anchor.hash.toLowerCase();
    if (!kept) clearProgress(progress);
}
