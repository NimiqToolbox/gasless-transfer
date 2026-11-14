import { formatEther, keccak256, parseTransaction, type Address, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import type { ErrorCode } from '@nimiq/gasless-sdk/relay';
import { readBalanceOf, readIntentNonce, readIntentNonceUsed, readTokenDomainSeparator } from '../chain/reads.js';
import { decodeRevert, errorCodeForRevert, type DecodedRevert } from '../chain/revert.js';
import type { TxSigner } from '../chain/signer.js';
import type { BlockInfo, BroadcastOutcome, ChainClient, ReceiptInfo } from '../chain/types.js';
import { monotonicMs, nowSeconds, type Clock } from '../clock.js';
import type { TxManagerSettings } from '../config.js';
import { hashDomain } from '../eip712.js';
import { RelayError } from '../errors.js';
import type { FeeEngine } from '../fees/feeEngine.js';
import { PriceUnavailableError, type PriceReading, type PriceSource } from '../fees/priceSource.js';
import { serializeError, type Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';
import { PRIORITY_NORMAL, type EncodedCall, type OperationDefinition, type OperationRegistry, type RelayContext, type Submission } from '../operations/types.js';
import { readsAt } from '../pipeline/pipeline.js';
import type { FinalFailure, MinedInfo, RequestRecord, Store, TxAttemptRecord } from '../store/types.js';
import { ceilDiv, formatFixed, maxBig, minBig } from '../util/bigint.js';
import { analyzeNonces, callGasLimit, combineNonces, fairOrder, spendCapPerGas, type AccountNonces, type GasLimitDecision } from './policy.js';
import {
    ReadBudgetExceeded,
    findNonceUse,
    findReceiptOn,
    finalityOf,
    nonceEventFilter,
    receiptFor,
    receiptInBlock,
    rpcClientsOf,
    withReadBudget,
    type Finality,
    type NonceUse,
    type UseQuery,
} from './quorum.js';
import { finalityDepthFloor, txPolicy, type TxPolicySettings } from './settings.js';
import { txMetrics, type TxMetrics } from './txMetrics.js';

export interface TxManagerDeps {
    readonly ctx: RelayContext;
    readonly registry: OperationRegistry;
    readonly store: Store;
    readonly signer: TxSigner;
    readonly fees: FeeEngine;
    readonly priceSource?: PriceSource | undefined;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly metrics: RelayMetrics;
    /** RELAY_* settings; the policy fields (src/tx/settings.ts) default when absent. */
    readonly settings: TxManagerSettings & Partial<TxPolicySettings>;
    /** Fresh token implementation verification; cancellation transactions do not call tokens. */
    readonly tokenImplementations?: { checkToken(token: Address): Promise<boolean> } | undefined;
    /**
     * Called when a queued request fails its check before the broadcast for a reason its sender controls
     * (its funds, its allowance, its token authorization or its intent nonce). Admission then puts its sender on a
     * cool-down (pipeline/senderAdmission.ts).
     */
    readonly onSenderFailure?: ((requestId: Hex) => void) | undefined;
}

/** A queued request held at its spend cap, as a request that takes its place when the queue is full sees it. */
export interface HeldRequest {
    readonly id: Hex;
    /** The spend cap per gas at which it was held (at its known gas limit), at the price of that pass. */
    readonly capPerGas: bigint;
}

/**
 * Synchronous health of the transaction manager, for /readyz. Every entry reads "code: explanation".
 * - `reasons` stop relaying and make the relay unready (empty when `ok`): not_recovered, no_pass, pass_stale,
 *   insufficient_funds, gas_budget, nonce_gap, finality_lag, stalled.
 * - `degraded` are worth an alert while the relay keeps working and stays ready: backlog, held_at_cap, settle_backlog.
 */
export interface TxHealth {
    readonly ok: boolean;
    readonly reasons: readonly string[];
    readonly degraded: readonly string[];
}

type Simulation =
    | { kind: 'ok'; call: EncodedCall }
    | { kind: 'revert'; revert: DecodedRevert }
    | { kind: 'rpc_error' }
    | { kind: 'corrupt'; message: string };

/** Outcome of the checks before a call is (re-)broadcast. */
type Preflight =
    | { kind: 'ok'; call: EncodedCall }
    /**
     * Try again at a later pass; `stopPass` after an RPC error (the other requests would hit it too), not after a failed
     * implementation check of the request's token (only the requests of that token would).
     */
    | { kind: 'retry'; stopPass: boolean }
    | { kind: 'fail'; final: FinalFailure };

/** `capped`: the request's spend cap prevents a valid replacement; `at_max`: RELAY_MAX_FEE_PER_GAS_GWEI does. */
type SpeedUpOutcome = 'sent' | 'capped' | 'at_max';

/**
 * The spend-cap pre-check of a queued request, without an RPC call. The gas
 * limit it uses is one known from a successful estimate (the request's own, else the smallest of its kind of call); if
 * there is none, the gas table's entry, the largest gas limit the relay would use (so the smallest cap per gas):
 * - `held`: the cap at that gas limit is below the cheapest includable fee. `estimated` is false when the gas limit is
 *   the gas table's entry because the request's last full check had no estimate: the relay would send it at that gas
 *   limit now, so it is held, and it is checked in full again in turn (broadcastQueued, phase 2);
 * - `fits`: the cap allows the cheapest includable fee (at the gas table's entry, at any gas limit the relay would use);
 * - `unknown`: never checked in full, no gas limit known, and at the gas table's entry its cap would hold it. Only its
 *   full check can tell: it is not known to be held (a request that takes its place in a full queue could not rely on
 *   that), and it does not count as waiting behind a held request until a full check shows that it could be sent.
 */
type Precheck =
    | { readonly kind: 'held'; readonly cap: bigint; readonly estimated: boolean }
    | { readonly kind: 'fits' }
    | { readonly kind: 'unknown' };

/** Outcome of the full check of a queued request at the pass's head (TxManager.checkQueued). */
type QueuedCheck =
    /** It failed its check, or needs more gas than the gas table allows: it ended in the queue (or had ended already). */
    | { readonly kind: 'ended' }
    /** Not decided now (see Preflight); `stopPass` after an RPC error. */
    | { readonly kind: 'retry'; readonly stopPass: boolean }
    /** Its spend cap holds it at the gas limit of this check. */
    | { readonly kind: 'held' }
    /** It could be sent now: `fees` within its spend cap at `gas`. */
    | { readonly kind: 'fits'; readonly call: EncodedCall; readonly gas: bigint; readonly fees: Fees };

interface Fees {
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
}

/**
 * The relay account's nonces through the relay's own client (see TxManager.nonces). `pending` is never above the
 * stored next nonce on that client's word alone: it may raise the stored next nonce.
 */
type Nonces = AccountNonces;

/** What one pass knows about the chain, through the relay's own (fail-over) client. */
interface TickView {
    readonly head: BlockInfo;
    /** Inclusions at or below this block are final (the `finalized` tag, at least RELAY_MIN_FINALITY_DEPTH deep). */
    readonly finalized: bigint;
    /** The node's `finalized` tag, undefined if unsupported. */
    readonly finalizedTag: bigint | undefined;
}

/** What one RPC reports as its head and final block (read at most once per pass, and only when needed). */
interface RpcView {
    readonly head: BlockInfo;
    readonly finalized: bigint;
}

/** An in-flight request whose tx nonce the chain used while no receipt of its transactions is visible. */
interface UnknownNonce {
    /** Head block of the relay's own client at the first observation (starts the grace period, and nothing else). */
    sinceBlock: bigint;
    /** receipt_hidden was counted and logged. */
    warned: boolean;
    /** Head block of the last search for what used the intent nonce (at most one per grace period). */
    searchedAt: bigint | undefined;
    /** Why the last search could not decide (for the ALERT). */
    searchSilent?: string | undefined;
    /**
     * In the last search an RPC showed the relay's call of the request in the block that used its intent nonce (with or
     * without its receipt), but not every RPC showed its successful receipt there.
     */
    executed?: boolean | undefined;
    /**
     * Per RPC (by position in RELAY_RPC_URLS): its own head when it first showed the tx nonce used without a receipt
     * of the request. A new tx nonce needs that block final by the same RPC's own view.
     */
    readonly seen: Map<number, Observation>;
}

/**
 * When one RPC first showed a state: its own head block then, and the relay's clock then (see TxManager.observation:
 * the time lets a block number that the RPC reported above its later heads be re-based, but never on a stale head).
 */
interface Observation {
    readonly block: bigint;
    readonly atMs: number;
}

/** What one RPC says about such a request. */
type NonceObservation =
    /** No answer in this pass: not yet. */
    | { readonly kind: 'silent' }
    /** A receipt of one of the request's transactions. */
    | { readonly kind: 'receipt' }
    /** Its latest nonce has not passed the tx nonce. */
    | { readonly kind: 'nonce_free' }
    /** The request's intent nonce is unused at its head; `final`: its own observation block is final by its own view. */
    | { readonly kind: 'unused'; readonly final: boolean }
    /** The request's intent nonce is used at its head (by a request of the signer, or invalidated with invalidateNonces). */
    | { readonly kind: 'used' };

/** An RPC's vote on a decision that needs every RPC: yes, no (it shows something against it), or not yet (no answer). */
type Vote = 'yes' | 'no' | undefined;

/** One RPC's answer to how a request's intent nonce was used, other than "unknown" (see quorum.findNonceUse). */
type FoundUse = Exclude<NonceUse, { readonly kind: 'unknown' }>;
type ExecutedUse = Extract<NonceUse, { readonly kind: 'executed' }>;

/** Decisions that wait for every RPC to agree, or for on-chain evidence (an ALERT fires when one waits too long). */
type WaitingDecision = 'requeue' | 'nonce_evidence' | 'receipt' | 'outcome' | 'settle';

/** A 0-value self-transfer that fills a nonce no relay transaction uses (kept in memory; see manageNonces). */
interface Filler extends Fees {
    readonly nonce: number;
    readonly hash: Hex;
    readonly raw: Hex;
    readonly sentBlock: bigint;
}

const CANCEL_GAS = 21_000n;
/** Nodes (geth, Bor) only accept a replacement that raises both fee fields by at least 10%. */
const MIN_REPLACEMENT_BUMP_PERCENT = 110n;
/** Settled requests are pruned at most this often. */
const PRUNE_INTERVAL_MS = 60_000;
/**
 * A head block whose timestamp is further behind the relay's clock is not the chain's state any more: the RPC that
 * answered stands still, or the chain does (Polygon PoS adds a block about every two seconds). The watchdogs that
 * count blocks cannot see it, because they count the blocks of that head.
 */
const HEAD_STALE_AFTER_SECONDS = 60;
/**
 * A wake-up (see wake) starts a pass no sooner than this long after the previous pass ended (and never later than the
 * poll would): new requests cannot make the passes, and their RPC reads, run back to back.
 */
export const WAKE_MIN_GAP_MS = 500;
/**
 * While a relay transaction is in flight, the head is read this often between passes (watchHead): a new block starts
 * the next pass (after WAKE_MIN_GAP_MS), so an inclusion is noticed within this long instead of at the next poll.
 */
export const HEAD_WATCH_MS = 500;
/**
 * The head watch runs only this long after the relay's last new transaction (re-sends of a stored one do not count): a
 * transaction that stays in flight (held at its spend cap, for example) is followed at the poll's pace after that.
 */
export const HEAD_WATCH_WINDOW_MS = 60_000;
/**
 * At most this many pre-broadcast checks (a pinned simulation and a gas estimate each) per pass and in-flight
 * slot. The checks of requests that end in the queue do not use a slot; this bounds the RPC work of one pass.
 */
const PREFLIGHTS_PER_SLOT = 2;
/**
 * At most this many provisional outcomes are checked per pass (reconcileResolved), the ones the relay has not
 * checked for the longest time first, so that the work of a pass does not grow with the number of unsettled requests.
 * More of them than this is a settle backlog (`settle_backlog`, degraded).
 */
export const SETTLE_CHECKS_PER_PASS = 32;
/**
 * The reads on the configured RPCs for the decisions that need every RPC (see ask) start only within this
 * long after a pass began, measured on the monotonic clock. After that every RPC counts as not answering for the rest
 * of the pass and those decisions wait for a later pass. A read under way ends within RELAY_RPC_TIMEOUT_MS, so however
 * slowly an RPC answers (below its timeout) and however many reads a decision needs on it, a pass stays well below the
 * 60 s liveness limit. A step of the wall clock changes neither: a backward step does not stretch the budget, and a
 * forward step does not end it early.
 */
export const RPC_READ_BUDGET_MS = 20_000;
/** A pass that ran out of RPC_READ_BUDGET_MS is logged at most this often. */
const READ_BUDGET_WARNING_INTERVAL_MS = 300_000;

const EXPIRED_BEFORE_SUBMIT: FinalFailure = {
    status: 'expired',
    error: { code: 'deadline_out_of_range', message: 'The deadline passed before the request could be submitted' },
};
const EXPIRED_AFTER_REQUEUE: FinalFailure = {
    status: 'expired',
    error: {
        code: 'deadline_out_of_range',
        message: 'The deadline passed before the request could be sent again (another transaction used the nonce of its earlier transaction)',
    },
};
const EXPIRED_IN_FLIGHT: FinalFailure = {
    status: 'expired',
    error: { code: 'deadline_out_of_range', message: 'The deadline passed before the transaction was included; it was cancelled' },
};
const FEE_BELOW_MARKET: FinalFailure = {
    status: 'failed',
    error: {
        code: 'fee_too_low',
        message:
            'Gas prices rose above what the fee of this request covers; it was cancelled so that it does not hold back other requests. ' +
            'Its signed intent stays valid until its deadline; a correction of this payment (the same nonce) with a higher fee can ' +
            'replace it once this outcome is final, and at most one of them executes.',
    },
};
const NONCE_INVALIDATED: FinalFailure = {
    status: 'failed',
    error: { code: 'nonce_used', message: 'The sender invalidated the nonce of this request (invalidateNonces) before it was executed' },
};
/** The intent nonce is used, but by no transaction of this relay and without an invalidation: another request took it. */
const NONCE_USED_ELSEWHERE: FinalFailure = {
    status: 'failed',
    error: {
        code: 'nonce_used',
        message: 'Another request of the sender at this nonce executed first (another version of the payment, for example through another relay)',
    },
};
/** The intent nonce was used only after the request's deadline: the request did not execute, and never can. */
const EXPIRED_UNUSED: FinalFailure = {
    status: 'expired',
    error: { code: 'deadline_out_of_range', message: 'The deadline passed before the request executed (its nonce was used after the deadline)' },
};
/** Usage of "this request only" for the operation's token-state checks (failure attribution). */
const OWN_USAGE = { debits: 0n, noneDebits: 0n, busy: false } as const;
/**
 * Failure codes of a check before the broadcast that its sender caused, without any doubt: its intent
 * nonce is used (its sender invalidated it, or another request of it executed, before the relay sent anything), or its
 * allowance no longer covers the transfer (it lowered the allowance, or its permit or meta-transaction can no longer
 * set it). `invalid_token_authorization` and `simulation_failed` are checked further (senderCaused).
 */
const SENDER_FAILURE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['nonce_used', 'insufficient_allowance', 'insufficient_balance']);

const sameHash = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * §6.5 transaction manager: the only writer of relay transactions. relay/docs/transaction-lifecycle.md
 * describes the states and rules in full; in short:
 *
 * - Several RPCs. Ordinary reads follow the relay's own client (the first RPC that
 *   answers), and so does the end of a queued request before its first broadcast (queue expiry, the checks before the
 *   broadcast), which is final at once. So does the decision to cancel a request in flight (its deadline against
 *   that client's head timestamp, a failed re-simulation, fee_too_low): no funds move, the cancel only replaces the
 *   call, but the payment fails while its signed intent stays valid until its deadline. The decisions about outcomes
 *   on-chain and the nonce range (a new tx nonce, a failure because the intent nonce was used elsewhere, settling,
 *   undoing a mined outcome, raising, lowering or filling the nonce range) need a positive answer from every
 *   configured RPC in the same pass; evidence against them from any RPC, or an RPC that does not answer (or not
 *   within RPC_READ_BUDGET_MS of the pass), holds them back.
 *   Go-ahead evidence is judged on each RPC against its own head and `finalized` tag, and against the relay's clock
 *   for an undo (heads made after the relay recorded the outcome); no block number that one RPC reported decides for
 *   another, and a stored one that lies above an RPC's head is re-based on that head once the head was made after it
 *   was stored. So one honest configured RPC keeps them safe; a dead or slow one delays them.
 * - Nonces. A relay nonce is never given up while the chain's latest nonce has not passed it. "nonce too
 *   low" is not proof that a nonce is used: the attempt is kept and the next passes look at receipts, the
 *   latest nonce and the request's own intent nonce (nonces(signer)) before anything else happens. A request whose tx
 *   nonce a foreign transaction consumed gets a new nonce only once every configured RPC shows that none of its
 *   transactions executed and its own observation of that is final; any of its transactions (at any nonce) still
 *   resolves it. Only a successful receipt of one of the request's own calls proves that it executed (the contract
 *   emits no event of its own). While no RPC answers eth_getTransactionReceipt for one and the intent nonce is used,
 *   every RPC locates the block that used it from state (quorum.findNonceUse) and shows what in it did: the successful
 *   receipt of the relay's call there (mined), or, as positive evidence, another request of the sender at that nonce
 *   or its invalidateNonces (failed with nonce_used). Without such evidence on every RPC the request waits. Nonces
 *   that no transaction uses are re-used (top of the range) or filled with 0-value self-transfers (below an in-flight
 *   transaction).
 * - Finality. mined, failed and expired that were decided by an inclusion stay provisional until that block
 *   is final (the `finalized` tag, but at least RELAY_MIN_FINALITY_DEPTH deep, in the canonical chain, and so on
 *   every configured RPC). Until then the raw transactions and secrets are kept, and a reorg resolves the nonce
 *   again by whichever of the request's transactions is found, or puts the request back in flight.
 * - Spend. Every broadcast and speed-up of a call is preceded by a simulation pinned to the head block (and,
 *   for USDC permits, a check that the sender has no code); a call the relay decided to cancel is never sent
 *   again; the gas limit is the estimate plus margin, capped by the gas table; and a call's maxFeePerGas is capped
 *   so that gas limit × maxFeePerGas stays within RELAY_MAX_COST_PERCENT_OF_FEE of the request's fee at the
 *   POL/USD price when it is signed. Cancels and nonce fillers are exempt from that cap. Only the transaction at
 *   the next nonce the chain can include (the relay account's `latest` count) is sped up: one behind a lower nonce
 *   that is not included cannot get in first at any fee, so it keeps its fees until its nonce is next.
 * - Queue. Priority first, then round-robin across senders (one sender's backlog delays another sender by at
 *   most one round).
 */
export class TxManager {
    private ticking: Promise<void> | undefined;
    private timer: NodeJS.Timeout | undefined;
    /** When `timer` fires (performance.now). */
    private timerDueMs = Number.POSITIVE_INFINITY;
    private running = false;
    /**
     * A wake-up came while a pass ran, after it listed the queue: the loop's next pass follows it after WAKE_MIN_GAP_MS
     * instead of the poll.
     */
    private wakeWanted = false;
    /** When the last pass ended, on the real monotonic clock that the loop's timers run on (performance.now). */
    private lastPassEndMs = Number.NEGATIVE_INFINITY;
    /** The next head read of watchHead. */
    private headWatch: NodeJS.Timeout | undefined;
    /** A head read of watchHead is under way (one at a time). */
    private headProbing = false;
    /** The head at which watchHead last started a pass. */
    private headWoken: bigint | undefined;
    /** When the relay last broadcast a new transaction, not a re-send (performance.now), for HEAD_WATCH_WINDOW_MS. */
    private lastBroadcastMs = Number.NEGATIVE_INFINITY;
    /** When this process last broadcast a transaction of each in-flight request (performance.now; see sentRecently). */
    private readonly sentAtMs = new Map<string, number>();
    private recovered = false;
    private lowFunds = false;
    private gasBudgetHeld = false;
    /**
     * `lowFunds` and `gasBudgetHeld` as the last pass left them. A pass finds both out again, so health and admission
     * read these: read in the middle of a pass, the relay would look able to send.
     */
    private lastPass = { lowFunds: false, gasBudgetHeld: false };
    private tickTip: bigint | undefined;
    private tickNonces: Promise<Nonces> | undefined;
    private lastNonces: Nonces | undefined;
    private readonly policy: TxPolicySettings;
    private readonly txm: TxMetrics;
    /** Effective finality depths: the configured ones, but never below the chain's floor. */
    private readonly minFinalityDepth: number;
    private readonly finalityFallbackDepth: number;
    /** Effective RELAY_MIN_SECONDS_TO_BROADCAST: always above RELAY_DEADLINE_SAFETY_SECONDS. */
    private readonly minSecondsToBroadcast: number;
    /** Head of the running pass. */
    private passHead = 0n;
    /** Seconds the head of the running pass is behind the relay's clock, if more than HEAD_STALE_AFTER_SECONDS. */
    private staleHeadSeconds: number | undefined;
    /** Passes started (the settlement round-robin counts in passes). */
    private passes = 0;
    /**
     * Per pass: one read client per configured RPC, by position in RELAY_RPC_URLS (the relay's own client when only
     * one is configured). These are the voters of every decision that needs every RPC; the fail-over client is not one.
     */
    private passRpcs: readonly ChainClient[] = [];
    /** Per pass: `passRpcs` as the decisions read them: no read starts once the pass has used RPC_READ_BUDGET_MS. */
    private passVoters: readonly ChainClient[] = [];
    /**
     * Per pass: when the reads for the decisions that need every RPC must have started, on the monotonic clock: a step
     * of the wall clock neither ends the budget early nor lets a pass read beyond it.
     */
    private readBudgetEndsMonoMs = 0;
    /** Per pass: a read was not started because the pass ran out of RPC_READ_BUDGET_MS (for the ALERT reasons). */
    private readBudgetSpent = false;
    /** Monotonic time of the last warning that a pass ran out of its read budget. */
    private lastReadBudgetWarningMonoMs = Number.NEGATIVE_INFINITY;
    /** Per pass: each RPC's head and final block (by position), read when a decision needs every RPC. */
    private rpcViews = new Map<number, Promise<RpcView | undefined>>();
    /** Per pass: RPCs (by position) that failed a read; they count as not answering for the rest of the pass. */
    private silentRpcs = new Set<number>();
    /** Per pass: the relay account's nonces on every RPC (undefined if one does not answer), read when needed. */
    private rpcNonces: Promise<readonly Nonces[] | undefined> | undefined;
    /** Per pass: a chain read of a check before a broadcast failed (see preflight). */
    private passChainReadFailed = false;
    /** Per pass: tokens (lowercase) whose implementation check before a broadcast failed (see preflight). */
    private passUnverifiedTokens = new Set<string>();
    /** RPCs (by position) whose last read failed (logged when they fail and when they answer again). */
    private readonly rpcDown = new Set<number>();
    /** Pass in which each provisional outcome was last checked. */
    private readonly settleChecked = new Map<string, number>();
    /**
     * Provisional outcomes decided without a receipt of the request (a foreign transaction took its tx nonce): per RPC
     * (by position), its own head when it first showed the outcome. They settle once that block is final by that RPC
     * (and, with the intent nonce used, the block of its use: foreignFinalOn).
     */
    private readonly settleSeen = new Map<string, Map<number, Observation>>();
    /**
     * Per request, per RPC (by position): how that RPC showed the use of the request's intent nonce (findNonceUse), and
     * the pass in which it last showed it. The answer depends only on the chain up to B, the block of the use, so it is
     * re-used while the RPC shows the same B and the same evidence in it (nonceUseOn): a later check (a settlement)
     * costs two or three reads and needs no state of older blocks.
     */
    private readonly uses = new Map<string, Map<number, { readonly use: FoundUse; pass: number }>>();
    /** Degraded entry while more provisional outcomes wait than one pass checks. */
    private settleBacklog: string | undefined;
    /** The raise of the stored next nonce that the last pass held back (logged once per value). */
    private heldRaise: number | undefined;
    /** Requests whose latest attempt must be re-sent (after recovery, reorgs or failed broadcasts). */
    private readonly resend = new Set<string>();
    /** In-flight requests whose tx nonce is used on-chain while no receipt of theirs is visible. */
    private readonly unknownNonce = new Map<string, UnknownNonce>();
    /** Provisional outcomes whose deciding receipt is not visible while the nonce stays used: first block. */
    private readonly receiptMissing = new Map<string, bigint>();
    /** Reverts seen on a head older than the request's acceptance (maybe a lagging node): first block. */
    private readonly revertSeen = new Map<string, bigint>();
    /**
     * Queued requests held back by their spend cap, with the cap per gas at which they were held (logged once). Set by
     * the pre-check of every queued request at the start of each pass and by the full check; see precheckQueued.
     */
    private readonly capHeld = new Map<string, bigint>();
    /**
     * Gas limit of each queued request's last full check (simulation and estimate), for the spend-cap pre-check. Only a
     * successful estimate sets it: the gas table's fallback is no known gas limit.
     */
    private readonly checkedGas = new Map<string, bigint>();
    /**
     * The pass of each queued request's last full check: a request without an entry was never
     * checked in full; requests held by a check without an estimate are checked again in the order of this pass.
     */
    private readonly lastCheck = new Map<string, number>();
    /** Passes run so far (for lastCheck). */
    private passNumber = 0;
    /** Full checks of queued requests in the running pass: at most PREFLIGHTS_PER_SLOT × RELAY_MAX_IN_FLIGHT. */
    private passChecks = 0;
    /** Queued requests that got a full check in the running pass, whatever its outcome (learnQueued skips them). */
    private readonly passTried = new Set<string>();
    /** Whether a queued request could be sent if a tx nonce were free, as this pass found out (see queuedCanGo). */
    private passWaiting: Promise<boolean> | undefined;
    /** The smallest gas limit a full check with a successful estimate computed per kind of call (see callKind). */
    private readonly minGasByKind = new Map<string, bigint>();
    /**
     * In-flight requests whose speed-up is held at their spend cap while nothing waits behind them, and calls behind a
     * lower nonce that their cap would hold once their nonce is next (see waitBehind).
     */
    private readonly heldAtCap = new Set<string>();
    /**
     * In-flight calls behind a lower nonce that the chain has not included: the head block of their last re-simulation
     * while they wait (see waitBehind). Their sent block stays as it is, so it cannot pace these checks.
     */
    private readonly blockedChecks = new Map<string, bigint>();
    /** Decisions waiting for the RPCs to agree or for evidence, by `${requestId}:${decision}`. */
    private readonly waits = new Map<string, { since: bigint; alerted: boolean }>();
    /** First block at which a request was seen queued (health: backlog). */
    private readonly queuedSince = new Map<string, bigint>();
    /**
     * Last block at which a relay transaction was broadcast, sped up or included, or a queued request ended in its
     * check before the broadcast (health: stalled).
     */
    private progressBlock: bigint | undefined;
    /** The previous pass had work to move (health: the stall clock starts when work appears). */
    private hadWork = false;
    /** 0-value self-transfers filling nonce gaps, by nonce. */
    private readonly fillers = new Map<number, Filler>();
    /**
     * The current gap (chain nonce below the lowest in-flight relay nonce): chain nonce, lowest in-flight nonce, first
     * block, and whether the relay has started filling it (its own fillers then move the chain nonce, which does not
     * start the wait again).
     */
    private gap: { latest: number; lowest: number; sinceBlock: bigint; filling: boolean } | undefined;
    /** Monotonic time of the last retention run (see prune). */
    private lastPruneMonoMs: number | undefined;
    private healthReasons: readonly string[] = [];
    private healthDegraded: readonly string[] = [];
    private lastViewHead: bigint | undefined;
    /** Wall-clock time of the last successful pass, for display (status(), the readiness report). */
    lastTickAtMs: number | undefined;
    /** Monotonic time of the last successful pass: its liveness. */
    private lastPassMonoMs: number | undefined;
    lastTickError: string | undefined;

    constructor(private readonly deps: TxManagerDeps) {
        if (deps.settings.totalGasBudgetWei !== undefined && deps.settings.totalGasBudgetWei <= 0n) throw new Error('totalGasBudgetWei must be positive');
        this.policy = txPolicy(deps.settings);
        this.txm = txMetrics(deps.metrics.registry);
        this.txm.gasBudgetPol.set(Number(formatEther(this.gasBudgetLimit())));
        this.txm.gasExposurePol.set(Number(formatEther(deps.store.gasExposureWei())));
        const floor = finalityDepthFloor(deps.ctx.chainId);
        this.minFinalityDepth = Math.max(this.policy.minFinalityDepth, floor);
        this.finalityFallbackDepth = Math.max(deps.settings.finalityFallbackDepth, floor);
        this.minSecondsToBroadcast = Math.max(deps.settings.minSecondsToBroadcast, deps.settings.deadlineSafetySeconds + 1);
    }

    /**
     * `lastTickAtMs` is the wall-clock time of the last successful pass (for display); `lastPassAgeMs` its age on the
     * monotonic clock, which readiness judges.
     */
    status(): {
        recovered: boolean;
        running: boolean;
        lowFunds: boolean;
        lastTickAtMs: number | null;
        lastTickError: string | null;
        lastPassAgeMs: number | null;
    } {
        return {
            recovered: this.recovered,
            running: this.running,
            lowFunds: this.lastPass.lowFunds,
            lastTickAtMs: this.lastTickAtMs ?? null,
            lastTickError: this.lastTickError ?? null,
            lastPassAgeMs: this.passAgeMs() ?? null,
        };
    }

    /** Age of the last successful pass on the monotonic clock (undefined before the first one). */
    private passAgeMs(): number | undefined {
        return this.lastPassMonoMs === undefined ? undefined : monotonicMs(this.deps.clock) - this.lastPassMonoMs;
    }

    /**
     * Synchronous health for /readyz (see TxHealth). Unready: not recovered, no recent successful pass, a head block
     * that is old against the clock (`head_stale`), no POL,
     * the lifetime gas budget reached or an increase refused (`gas_budget`), a nonce gap, stalled finality, or
     * `stalled`: requests wait to be sent (queued and not held by their spend cap, or in flight and not held at it)
     * but no relay transaction was broadcast, sped up or included, and no queued request ended in its check before
     * the broadcast, for RELAY_STUCK_AFTER_BLOCKS. Degraded (still ready): `backlog`, the oldest queued request that
     * can be sent waited longer than that; `held_at_cap`, requests wait because gas prices are above what their fees
     * cover; `settle_backlog`, more provisional outcomes wait to settle than a pass checks.
     * The chain-derived entries are those of the last completed pass. The age of that pass is measured on the
     * monotonic clock, so a step of the wall clock does not change it.
     */
    health(): TxHealth {
        const reasons: string[] = [];
        const age = this.passAgeMs();
        const staleMs = Math.max(60_000, this.deps.settings.pollIntervalMs * 10);
        if (!this.recovered) reasons.push('not_recovered: startup recovery has not run');
        if (age === undefined) {
            reasons.push('no_pass: the transaction manager has not completed a pass yet');
        } else if (age > staleMs) {
            reasons.push(`pass_stale: the last successful pass was ${Math.round(age / 1000)} s ago`);
        }
        if (this.lastPass.lowFunds) reasons.push('insufficient_funds: the relay account cannot pay for its transactions');
        if (this.lastPass.gasBudgetHeld || this.deps.store.gasExposureWei() >= this.gasBudgetLimit()) {
            reasons.push('gas_budget: aggregate gas exposure reached its configured ceiling; operator review is required');
        }
        reasons.push(...this.healthReasons);
        return { ok: reasons.length === 0, reasons, degraded: this.healthDegraded };
    }

    /**
     * Why a request accepted now would not be sent: the first reason that makes the relay unready (see health), or
     * undefined. Admission refuses new requests while there is one. Before the first pass nothing is known yet, and
     * a request accepted then waits for that pass.
     */
    cannotSend(): string | undefined {
        if (!this.recovered || this.lastPassMonoMs === undefined) return undefined;
        return this.health().reasons[0];
    }

    /** Head block number of the last completed pass (undefined before the first one). */
    viewHead(): bigint | undefined {
        return this.lastViewHead;
    }

    /**
     * The queued requests held at their spend cap, as the last pre-check or full check saw them.
     * When the queue is full, a new request that passed admission takes the place of one of them (the store decides
     * which, in one transaction with the insert: see Store.insertRequest). Held state is kept in memory only: after a
     * restart, a request that was never checked in full is not known to be held; the passes check requests never checked
     * in full also while no slot is free (learnQueued, within their budget), and once one request of a kind of call was
     * estimated the pre-check knows the others of that kind. Until then a full queue answers 503.
     */
    heldInQueue(): readonly HeldRequest[] {
        return [...this.capHeld].map(([id, capPerGas]) => ({ id: id as Hex, capPerGas }));
    }

    /**
     * Restart recovery. The stored next nonce is reconciled with the chain: a database without one (fresh or
     * restored) starts at the pending nonce, above transactions of the key it does not track. That range is
     * not trusted blindly: every pass re-uses those nonces if the transactions disappear and fills them if
     * they stay below the relay's own transactions (manageNonces).
     *
     * the pending nonce is the lowest pending count that every configured RPC reports. A single RPC's
     * answer is never stored: a fresh database needs every RPC to answer (recovery fails otherwise, and startup with
     * it), and a stored next nonce is raised only when every RPC answers.
     */
    async recover(): Promise<void> {
        const { store, logger } = this.deps;
        this.beginPass();
        const every = await this.everyRpcNonces();
        const stored = store.getNextNonce();
        if (every === undefined) {
            if (stored === undefined) throw new Error('the relay account nonce could not be read from every RPC in RELAY_RPC_URLS');
            logger.warn({ stored }, 'not every RPC answered the relay account nonce; the stored next nonce is kept');
        } else {
            const { lowestPending: pending, highestLatest: latest } = combineNonces(every);
            if (stored === undefined) {
                store.setNextNonce(pending);
                if (pending > latest) {
                    logger.warn(
                        { pending, latest },
                        'relay account has pending transactions this database does not track; their nonces are re-used if they are dropped',
                    );
                }
            } else if (pending > stored) {
                logger.warn(
                    { stored, pending },
                    'chain nonce is ahead of the database: the relay key sent transactions this relay does not track (another process?)',
                );
                store.setNextNonce(pending);
            } else if (pending < stored) {
                logger.info({ stored, pending }, 'tracked transactions are missing from the mempool; re-broadcasting');
            }
        }
        for (const request of store.listByStatus('submitted')) this.resend.add(request.id);
        this.recovered = true;
    }

    start(): void {
        if (this.running) return;
        if (!this.recovered) throw new Error('TxManager.recover() must run before start()');
        this.running = true;
        this.schedule(this.deps.settings.pollIntervalMs);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        if (this.headWatch) clearTimeout(this.headWatch);
        this.headWatch = undefined;
        await this.ticking;
    }

    /**
     * A request was queued (the pipeline calls this): the loop's next pass starts now instead of at the next poll, so a
     * new request is sent without waiting for up to RELAY_POLL_INTERVAL_MS. A wake-up only brings that pass forward:
     * passes still run one at a time (tick), each in full, and one starts at least WAKE_MIN_GAP_MS after the previous
     * one ended. While a pass runs, the next one follows it after that gap, unless that pass had not yet listed the
     * queue (then it answers the wake-up). Nothing happens unless the loop runs and a slot is free for the new
     * request's priority.
     */
    wake(priority: number = PRIORITY_NORMAL): void {
        if (!this.running) return;
        // With every slot the request may use taken, it cannot be sent before a pass frees one: the poll suffices.
        // Under load the passes therefore fall back to the poll's pace.
        if (this.slots().inFlight >= this.slotLimit(priority)) return;
        if (this.ticking !== undefined) {
            this.wakeWanted = true;
            return;
        }
        this.scheduleSoon();
    }

    /** The next pass as soon as WAKE_MIN_GAP_MS after the previous one allows. */
    private scheduleSoon(): void {
        this.schedule(Math.max(0, this.lastPassEndMs + this.wakeGapMs() - performance.now()));
    }

    /**
     * Between passes, while a relay transaction is in flight: reads the head every HEAD_WATCH_MS through the relay's own
     * client, and once it is past the last pass's head, starts the next pass (scheduleSoon). The pass decides from its
     * own reads, as at the poll; this read only picks the moment. One read at a time; none starts while a pass runs
     * (its end starts the watch again), and the answer of one that was under way when a pass started is dropped. No
     * watch with nothing in flight, later than HEAD_WATCH_WINDOW_MS after the last new transaction, or if the poll is not
     * slower. It backs off to the poll when the RPCs fail: no watch after a failed pass, and a failed read ends the
     * watch until the next pass.
     */
    private watchHead(): void {
        if (!this.running || this.headWatch !== undefined || this.headProbing) return;
        if (this.deps.settings.pollIntervalMs <= HEAD_WATCH_MS) return;
        if (this.lastTickError !== undefined) return;
        if (performance.now() - this.lastBroadcastMs > HEAD_WATCH_WINDOW_MS) return;
        if (this.slots().inFlight === 0) return;
        this.headWatch = setTimeout(() => {
            this.headWatch = undefined;
            void this.probeHead();
        }, HEAD_WATCH_MS);
    }

    private async probeHead(): Promise<void> {
        if (!this.running || this.ticking !== undefined) return;
        this.headProbing = true;
        const { chain } = this.deps.ctx;
        let head: bigint;
        try {
            head = chain.getBlockNumber ? await chain.getBlockNumber() : (await chain.getBlock('latest')).number;
        } catch {
            return;
        } finally {
            this.headProbing = false;
        }
        if (!this.running || this.ticking !== undefined) return;
        // At most one pass per new head: if the pass then reads an older head (another RPC answers), the next one waits
        // for a newer head or the poll. A head far below the one that started a pass (a lie) forgets it, so that one
        // inflated answer cannot stop the watch; RPCs behind a load balancer differ by a block or two, which does not.
        if (this.headWoken !== undefined && head + 16n < this.headWoken) this.headWoken = undefined;
        if (this.lastViewHead !== undefined && head > this.lastViewHead && (this.headWoken === undefined || head > this.headWoken)) {
            this.headWoken = head;
            this.scheduleSoon();
            return;
        }
        this.watchHead();
    }

    /** At most the poll interval, so that a wake-up never delays the next pass. */
    private wakeGapMs(): number {
        return Math.min(WAKE_MIN_GAP_MS, this.deps.settings.pollIntervalMs);
    }

    /**
     * The loop: one timer at a time, and the earlier one wins. Each pass sets the timer of the next one when it ends;
     * a wake-up that came first keeps its earlier timer.
     */
    private schedule(delayMs: number): void {
        const due = performance.now() + delayMs;
        if (this.timer !== undefined) {
            if (due >= this.timerDueMs) return;
            clearTimeout(this.timer);
        }
        this.timerDueMs = due;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.tick().finally(() => {
                if (!this.running) return;
                const woken = this.wakeWanted;
                this.wakeWanted = false;
                this.schedule(woken ? this.wakeGapMs() : this.deps.settings.pollIntervalMs);
                this.watchHead();
            });
        }, delayMs);
    }

    /** One pass of the state machine. Concurrent calls share the running pass (single writer). */
    tick(): Promise<void> {
        this.ticking ??= this.runTick().finally(() => {
            this.ticking = undefined;
            this.lastPassEndMs = performance.now();
        });
        return this.ticking;
    }

    private async runTick(): Promise<void> {
        try {
            if (!this.recovered) await this.recover();
            this.tickTip = undefined;
            this.tickNonces = undefined;
            this.beginPass();
            const { chain } = this.deps.ctx;
            // The pass reads the head and the finalized tag through the relay's own client (the first RPC that
            // answers): ordinary reads, readiness and health follow it. The decisions that need every RPC read each
            // RPC's own head and finalized tag (rpcView).
            const head = await chain.getBlock('latest');
            this.passHead = head.number;
            this.noteHeadAge(head);
            const view: TickView = { head, ...(await this.finality(head)) };
            // The relay's own client is one of the RPCs when only one is configured: its view is this one.
            const own = this.passRpcs.indexOf(chain);
            if (own >= 0) this.rpcViews.set(own, Promise.resolve({ head, finalized: view.finalized }));
            await this.reconcileSubmitted(view);
            await this.reconcileResolved(view);
            this.expireQueued(head);
            await this.processSubmitted(view);
            await this.manageNonces(view);
            // A wake-up until here is answered by this pass: broadcastQueued lists the queue before its first await.
            this.wakeWanted = false;
            try {
                await this.broadcastQueued(view);
            } catch (err) {
                if (!(err instanceof PriceUnavailableError)) throw err;
                // Without a price no new call is sent (its spend cap is unknown). The pass itself completes, as it
                // does with an empty queue: health, gauges and pruning must not stop with the oracle.
            }
            this.prune();
            await this.updateGauges(view);
            this.lastTickAtMs = this.deps.clock.nowMs();
            this.lastPassMonoMs = monotonicMs(this.deps.clock);
            this.lastViewHead = head.number;
            this.lastTickError = undefined;
        } catch (err) {
            this.lastTickError = String(serializeError(err).message ?? 'error');
            this.deps.metrics.txManagerErrors.inc();
            this.deps.logger.warn({ err }, 'transaction manager tick failed');
        }
        this.lastPass = { lowFunds: this.lowFunds, gasBudgetHeld: this.gasBudgetHeld };
    }

    /**
     * Whether the head of this pass is old against the relay's clock (HEAD_STALE_AFTER_SECONDS). While it is, the pass
     * sends no queued request (its deadline and its checks would be judged on old state) and the relay is unready
     * (`head_stale`). What is in flight is followed as before.
     */
    private noteHeadAge(head: BlockInfo): void {
        const age = nowSeconds(this.deps.clock) - Number(head.timestamp);
        const stale = age > HEAD_STALE_AFTER_SECONDS ? age : undefined;
        if (stale !== undefined && this.staleHeadSeconds === undefined) {
            this.deps.logger.warn(
                { head: head.number, ageSeconds: age },
                'ALERT: the head block of the relay\'s RPC is old (the RPC or the chain stands still); no queued request is sent until it moves. Check the first RPC in RELAY_RPC_URLS',
            );
        } else if (stale === undefined && this.staleHeadSeconds !== undefined) {
            this.deps.logger.info({ head: head.number }, 'the head block of the relay\'s RPC is current again');
        }
        this.staleHeadSeconds = stale;
    }

    /** min(finalized tag, head − min depth), or head − max(fallback depth, min depth) without the tag. */
    private finality(head: BlockInfo): Promise<Finality> {
        return finalityOf(this.deps.ctx.chain, head, this.minFinalityDepth, this.finalityFallbackDepth);
    }

    /**
     * The relay account's latest and pending nonce through the relay's own client, read at most once per pass.
     *
     * `pending` is where transactions of the key that the relay does not track would end, and the relay skips their
     * nonces (broadcastQueued raises the stored next nonce to it). one RPC's answer must not move the
     * relay's nonce range, so a `pending` above the stored next nonce is checked on every RPC: it applies only up to
     * the lowest pending count among them, and not at all (the stored next nonce) when one of them does not answer.
     */
    private nonces(): Promise<Nonces> {
        this.tickNonces ??= (async () => {
            const { ctx, signer, store, logger } = this.deps;
            const [latest, reported] = await Promise.all([
                ctx.chain.getTransactionCount(signer.address, 'latest'),
                ctx.chain.getTransactionCount(signer.address, 'pending'),
            ]);
            // A relay transaction (a request's, a filler, or one this database does not track) was included.
            if (this.lastNonces !== undefined && latest > this.lastNonces.latest) this.progress();
            let pending = reported;
            const next = store.getNextNonce();
            if (next !== undefined && reported > next) {
                const every = await this.everyRpcNonces();
                pending = Math.min(reported, every ? Math.max(next, combineNonces(every).lowestPending) : next);
                if (pending < reported && this.heldRaise !== reported) {
                    logger.warn(
                        { next, reported, applied: pending, everyRpcAnswered: every !== undefined },
                        'the relay client reports pending transactions of the relay key above the next nonce that not every RPC shows; not skipping those nonces',
                    );
                }
                this.heldRaise = pending < reported ? reported : undefined;
            }
            this.lastNonces = { latest, pending };
            return this.lastNonces;
        })();
        return this.tickNonces;
    }

    /**
     * Starts a pass: the voters (one client per configured RPC, whose reads start only within RPC_READ_BUDGET_MS of
     * the pass) and the per-pass caches of their answers.
     */
    private beginPass(): void {
        const { ctx } = this.deps;
        this.passes += 1;
        this.passRpcs = rpcClientsOf(ctx.chain);
        this.readBudgetEndsMonoMs = monotonicMs(this.deps.clock) + RPC_READ_BUDGET_MS;
        this.readBudgetSpent = false;
        this.passVoters = this.passRpcs.map((rpc) => withReadBudget(rpc, () => this.readBudgetUsedUp()));
        this.rpcViews = new Map();
        this.silentRpcs = new Set();
        this.rpcNonces = undefined;
        this.passChainReadFailed = false;
        this.passUnverifiedTokens = new Set();
    }

    /** The pass has used RPC_READ_BUDGET_MS for the reads of the decisions that need every RPC (monotonic clock). */
    private readBudgetUsedUp(): boolean {
        return monotonicMs(this.deps.clock) >= this.readBudgetEndsMonoMs;
    }

    /**
     * A read on RPC `i` for a decision that needs every RPC; undefined when the RPC does not answer. An RPC that fails
     * a read counts as not answering for the rest of the pass, so an RPC that times out costs a pass at most one
     * timeout, and every decision that needs it waits. an RPC that answers, but slowly, costs a
     * pass at most RPC_READ_BUDGET_MS (and one timeout): after that no read of these decisions starts in this pass.
     */
    private async ask<T>(i: number, read: () => Promise<T>): Promise<T | undefined> {
        if (this.silentRpcs.has(i)) return undefined;
        try {
            const answer = await read();
            if (this.rpcDown.delete(i)) this.deps.logger.info({ rpc: i + 1 }, 'RPC answers again');
            return answer;
        } catch (err) {
            this.silentRpcs.add(i);
            if (err instanceof ReadBudgetExceeded) {
                this.readBudgetSpent = true;
                const now = monotonicMs(this.deps.clock);
                if (now - this.lastReadBudgetWarningMonoMs >= READ_BUDGET_WARNING_INTERVAL_MS) {
                    this.lastReadBudgetWarningMonoMs = now;
                    this.deps.logger.warn(
                        { budgetMs: RPC_READ_BUDGET_MS },
                        'the reads on the RPCs for the decisions that need every RPC took longer than their budget in this pass; the rest wait for the next pass (an RPC in RELAY_RPC_URLS is slow)',
                    );
                }
                return undefined;
            }
            if (!this.rpcDown.has(i)) {
                this.rpcDown.add(i);
                this.deps.logger.warn(
                    { err, rpc: i + 1 },
                    'an RPC does not answer; the decisions that need every RPC in RELAY_RPC_URLS wait until it answers again',
                );
            }
            return undefined;
        }
    }

    /** The relay account's nonces on every RPC (by position), read at most once per pass; undefined if one does not answer. */
    private everyRpcNonces(): Promise<readonly Nonces[] | undefined> {
        this.rpcNonces ??= (async () => {
            const { signer } = this.deps;
            const all = await Promise.all(
                this.passVoters.map((rpc, i) =>
                    this.ask(i, async (): Promise<Nonces> => {
                        const [latest, pending] = await Promise.all([
                            rpc.getTransactionCount(signer.address, 'latest'),
                            rpc.getTransactionCount(signer.address, 'pending'),
                        ]);
                        return { latest, pending };
                    }),
                ),
            );
            return all.every((n): n is Nonces => n !== undefined) ? all : undefined;
        })();
        return this.rpcNonces;
    }

    /** True if `head` holds state at least as new as the wall-clock time `ms` (block timestamps are seconds). */
    private static atLeastAsNewAs(head: BlockInfo, ms: number): boolean {
        return head.timestamp >= BigInt(Math.floor(ms / 1000));
    }

    /**
     * True if `head` was made after the wall-clock time `ms`: its timestamp is later than that moment (block timestamps
     * are whole seconds, so a block of the same second may be older and does not count). the
     * freshness bar of an undo and of a re-based observation; the relay's clock sets it, no RPC does.
     */
    private static newerThan(head: BlockInfo, ms: number): boolean {
        return head.timestamp * 1000n > BigInt(ms);
    }

    /** The operation and the stored submission of a request, or undefined if it cannot be restored. */
    private restored(request: RequestRecord): { op: OperationDefinition; sub: Submission } | undefined {
        const op = this.deps.registry.get(request.operation);
        if (!op || !request.signature || !request.authorization) return undefined;
        try {
            return { op, sub: op.restore({ request: request.request, signature: request.signature, authorization: request.authorization }) };
        } catch {
            return undefined;
        }
    }

    /**
     * A relay transaction was broadcast (new or replacement) or included in this pass, or a queued request ended in
     * its check before the broadcast (health: stalled).
     */
    private progress(): void {
        this.progressBlock = this.passHead;
    }

    // -----------------------------------------------------------------------------------------
    // Several RPCs
    // -----------------------------------------------------------------------------------------

    /**
     * RPC `i`'s head and final block (by its own `finalized` tag), read once per pass; undefined
     * if it does not answer.
     */
    private rpcView(i: number): Promise<RpcView | undefined> {
        let view = this.rpcViews.get(i);
        if (!view) {
            const rpc = this.passVoters[i]!;
            view = this.ask(i, async (): Promise<RpcView> => {
                const head = await rpc.getBlock('latest');
                const { finalized } = await finalityOf(rpc, head, this.minFinalityDepth, this.finalityFallbackDepth);
                return { head, finalized };
            });
            this.rpcViews.set(i, view);
        }
        return view;
    }

    /**
     * Every RPC's vote (by position) on a decision, asked in parallel: `vote` gets the RPC's view of this pass and
     * gives yes, no, or not yet. An RPC that does not answer votes not yet.
     */
    private async everyRpc(vote: (i: number, rpc: ChainClient, view: RpcView) => Promise<Vote>): Promise<Vote[]> {
        return Promise.all(
            this.passVoters.map(async (rpc, i): Promise<Vote> => {
                const view = await this.rpcView(i);
                if (!view) return undefined;
                return (await this.ask(i, () => vote(i, rpc, view))) ?? undefined;
            }),
        );
    }

    /** Why a decision that needs every RPC waits (for the ALERT): evidence against it wins over an RPC that does not answer. */
    private whyNot(votes: readonly Vote[], against: string): string {
        if (votes.includes('no')) return against;
        const silent = votes.flatMap((v, i) => (v === undefined ? [`#${i + 1}`] : []));
        const slow = this.readBudgetSpent ? '; this pass also ran out of time for these reads, so an RPC may just be slow' : '';
        return `not every RPC answered (RPC ${silent.join(', ')} in RELAY_RPC_URLS${slow})`;
    }

    /** RPC `i` is the relay's own (fail-over) client, which happens when only one RPC is configured. */
    private isOwnClient(i: number): boolean {
        return this.passRpcs[i] === this.deps.ctx.chain;
    }

    /**
     * An RPC's observation of a state it shows now, at `head` (its head of this pass): the stored one, or `head` if there
     * is none. A stored block above `head`, while `head` was made after the stored observation by the relay's clock, is
     * no block of the chain this RPC shows now (it reported a higher head or log block before: a lie, or a switch to a
     * shorter chain). The observation then starts again at `head`, so a number that an RPC once gave cannot hold its
     * vote back for good; a stale head (not newer than the observation) never replaces it.
     */
    private observation(stored: Observation | undefined, head: BlockInfo): Observation {
        if (stored && (stored.block <= head.number || !TxManager.newerThan(head, stored.atMs))) return stored;
        return { block: head.number, atMs: this.deps.clock.nowMs() };
    }

    /**
     * A decision waits (for every RPC to answer and agree, or for on-chain evidence). Once it has waited
     * RELAY_STUCK_AFTER_BLOCKS an ALERT is logged and `relay_decision_waits_total{decision}` counts it; the
     * relay keeps waiting (it never decides on the word of a single RPC).
     */
    private waiting(request: RequestRecord, decision: WaitingDecision, head: bigint, why: string): void {
        const key = `${request.id}:${decision}`;
        let wait = this.waits.get(key);
        if (!wait) {
            wait = { since: head, alerted: false };
            this.waits.set(key, wait);
        }
        // A head the relay's client once reported above today's (a lie, or another RPC answering then) must not keep
        // the ALERT away for good: the wait counts from today's head.
        if (head < wait.since) wait.since = head;
        const blocks = head - wait.since;
        if (wait.alerted || blocks < BigInt(this.policy.stuckAfterBlocks)) return;
        wait.alerted = true;
        this.txm.decisionWaits.inc({ decision });
        this.deps.logger.error(
            { requestId: request.id, decision, blocks, why },
            `ALERT: request ${request.id} has waited ${blocks} blocks for a decision (${decision}): ${why}. Check the RPCs in RELAY_RPC_URLS`,
        );
    }

    /** The decision (all of the request's decisions if none is named) no longer waits. */
    private decided(requestId: string, ...decisions: WaitingDecision[]): void {
        if (decisions.length > 0) {
            for (const d of decisions) this.waits.delete(`${requestId}:${d}`);
            return;
        }
        for (const key of [...this.waits.keys()]) if (key.startsWith(`${requestId}:`)) this.waits.delete(key);
    }

    /** The request left the "tx nonce used without a receipt" state. */
    private forgetUnknownNonce(requestId: string): void {
        this.unknownNonce.delete(requestId);
        this.decided(requestId, 'requeue', 'nonce_evidence', 'receipt');
    }

    // -----------------------------------------------------------------------------------------
    // Reconciliation of requests in flight
    // -----------------------------------------------------------------------------------------

    private async reconcileSubmitted(view: TickView): Promise<void> {
        const { store, logger } = this.deps;
        const submitted = store.listByStatus('submitted');
        for (const id of [...this.unknownNonce.keys()]) if (!submitted.some((r) => r.id === id)) this.forgetUnknownNonce(id);
        for (const id of [...this.sentAtMs.keys()]) if (!submitted.some((r) => r.id === id)) this.sentAtMs.delete(id);
        if (submitted.length === 0) return;
        const nonces = await this.nonces();
        for (const request of submitted) {
            // any of the request's transactions can have taken a nonce; a successful call wins.
            const found = await this.findReceipt(store.listAttempts(request.id));
            if (found) {
                this.forgetUnknownNonce(request.id);
                await this.resolveByReceipt(request, found.attempt, found.receipt);
                continue;
            }
            if (request.txNonce === null) continue;
            if (request.txNonce < nonces.latest) {
                await this.nonceUsedWithoutReceipt(request, view);
                continue;
            }
            this.forgetUnknownNonce(request.id);
            if (!this.sentRecently(request.id) && request.txNonce >= nonces.pending && !this.resend.has(request.id)) {
                // The node has no transaction at this nonce: dropped from the mempool (node restart, eviction),
                // or a broadcast answered "nonce too low" although the nonce is free.
                // Re-send the stored one now (after a re-simulation in processSubmitted; a call the relay decided
                // to cancel is cancelled instead).
                logger.warn({ requestId: request.id, txNonce: request.txNonce }, 'transaction missing from the mempool; re-broadcasting');
                this.resend.add(request.id);
            }
        }
    }

    /** The receipt of one of `attempts` through the relay's own client (a successful call is preferred). */
    private findReceipt(attempts: readonly TxAttemptRecord[]): Promise<{ attempt: TxAttemptRecord; receipt: ReceiptInfo } | undefined> {
        return findReceiptOn(this.deps.ctx.chain, attempts);
    }

    /**
     * The chain's latest nonce passed the request's tx nonce, but no receipt of the request is visible.
     * After the grace period every configured RPC is asked on its own:
     * - evidence against a decision counts from any RPC, whatever its head: a receipt of one of the request's
     *   transactions, or its tx nonce unused, holds every decision back; the intent nonce used on one RPC and unused
     *   on another holds them back too;
     * - an RPC that does not answer holds every decision back (not yet);
     * - every RPC shows the request's intent nonce unused: none of its transactions can be mined any more. It ends as
     *   already decided (a cancel was intended), or gets a new nonce once each RPC's own observation block (its head
     *   when it first showed the tx nonce used without a receipt) is final by that RPC's own `finalized` tag, so that
     *   no reorg can include one of its earlier transactions after that;
     * - every RPC shows it used: the relay's call executed it while no RPC shows its receipt, or something else used it
     *   (the signer's invalidateNonces, or another request at that nonce); see usedIntentNonce.
     * Every wait raises an ALERT after RELAY_STUCK_AFTER_BLOCKS, except the wait for finality before a new nonce.
     */
    private async nonceUsedWithoutReceipt(request: RequestRecord, view: TickView): Promise<void> {
        const { store, settings, logger, clock, metrics } = this.deps;
        const head = view.head.number;
        let known = this.unknownNonce.get(request.id);
        if (!known) {
            known = { sinceBlock: head, warned: false, searchedAt: undefined, seen: new Map() };
            this.unknownNonce.set(request.id, known);
        }
        const entry: UnknownNonce = known;
        // Nothing can be sent at a nonce the chain already used.
        this.resend.delete(request.id);
        this.heldAtCap.delete(request.id);
        // The grace period counts on the relay's own client. It is no safety rule (finality per RPC is); if that client
        // now reports an older head (another RPC answers, or a lie), the period starts again.
        if (head < entry.sinceBlock) entry.sinceBlock = head;
        if (head - entry.sinceBlock < BigInt(settings.unknownNonceGraceBlocks)) return;
        const attempts = store.listAttempts(request.id);
        const seen = await Promise.all(this.passVoters.map((rpc, i) => this.observeNonce(i, rpc, request, attempts, entry)));
        if (seen.some((o) => o.kind === 'receipt' || o.kind === 'nonce_free')) {
            return this.waiting(request, 'requeue', head, 'an RPC still shows a transaction of the request, or its tx nonce unused');
        }
        if (seen.some((o) => o.kind === 'used') && seen.some((o) => o.kind === 'unused')) {
            return this.waiting(request, 'requeue', head, 'the RPCs disagree whether the request executed');
        }
        if (seen.some((o) => o.kind === 'silent')) {
            return this.waiting(request, 'requeue', head, this.whyNot(seen.map((o) => (o.kind === 'silent' ? undefined : 'yes')), ''));
        }
        if (seen.every((o) => o.kind === 'used')) {
            await this.usedIntentNonce(request, entry, view);
            return;
        }
        // Every RPC shows the intent nonce unused.
        if (request.pendingFinal) {
            // The relay was cancelling the request anyway; provisional until the observation is final on every RPC
            // (each RPC's observation of this state carries over into the settlement, see foreignFinalOn).
            this.settleSeen.set(request.id, new Map(entry.seen));
            this.forgetUnknownNonce(request.id);
            store.resolveFailed(request.id, request.pendingFinal, { kind: 'foreign', block: entry.sinceBlock }, clock.nowMs());
            metrics.requestStatus.inc({ operation: request.operation, status: request.pendingFinal.status });
            logger.warn({ requestId: request.id, txNonce: request.txNonce }, 'tx nonce consumed by an unknown transaction; the request ends as already decided');
            return;
        }
        // A new nonce means a second call: only once the transaction that took the nonce cannot be reorged out any
        // more, on every RPC. Waiting for finality is normal, not an anomaly (finality_lag reports a stalled one).
        if (seen.some((o) => o.kind === 'unused' && !o.final)) return;
        this.forgetUnknownNonce(request.id);
        store.requeue(request.id, clock.nowMs());
        this.txm.nonceEvents.inc({ event: 'requeued' });
        metrics.requestStatus.inc({ operation: request.operation, status: 'queued' });
        logger.error(
            { requestId: request.id, txNonce: request.txNonce, rpcs: seen.length },
            'tx nonce consumed by an unknown transaction; the request did not execute and gets a new nonce',
        );
    }

    /** RPC `i`'s view of a request whose tx nonce is used without a visible receipt (see nonceUsedWithoutReceipt). */
    private async observeNonce(i: number, rpc: ChainClient, request: RequestRecord, attempts: readonly TxAttemptRecord[], entry: UnknownNonce): Promise<NonceObservation> {
        const { signer } = this.deps;
        const own = this.isOwnClient(i);
        const view = await this.rpcView(i);
        if (!view) return { kind: 'silent' };
        const observation = await this.ask(i, async (): Promise<NonceObservation> => {
            // The relay's own client was asked for receipts at the start of this pass (reconcileSubmitted).
            if (!own && (await findReceiptOn(rpc, attempts))) return { kind: 'receipt' };
            const latest = own ? (await this.nonces()).latest : await rpc.getTransactionCount(signer.address, 'latest');
            if (latest <= request.txNonce!) return { kind: 'nonce_free' };
            // This RPC shows the tx nonce used without a receipt: its observation block is its own head the first time
            // (re-based if it reported a higher one before, see observation()).
            const since = this.observation(entry.seen.get(i), view.head);
            entry.seen.set(i, since);
            const used = await readIntentNonceUsed(rpc, request.contract, request.signer, BigInt(request.nonce), view.head.number);
            return used ? { kind: 'used' } : { kind: 'unused', final: since.block <= view.finalized };
        });
        if (!observation) return { kind: 'silent' };
        // The state is gone on this RPC: its observation starts again when it shows the state again.
        if (observation.kind === 'receipt' || observation.kind === 'nonce_free') entry.seen.delete(i);
        return observation;
    }

    /**
     * Every RPC shows the request's intent nonce used while no RPC answers eth_getTransactionReceipt for one of its
     * transactions. Only the relay named in the request can execute it: either one of its own calls did (its receipt is
     * hidden), or something else used the nonce, and the request can never execute. At most once per grace period every
     * RPC locates the block that used the nonce from its own state and shows what in it did (findNonceUse, through
     * nonceUseOn):
     * - the successful receipt of the relay's call of this request there on every RPC (the same transaction, from
     *   eth_getBlockReceipts of that block or read on its own): mined; provisional until every RPC shows that block final
     *   (see resolvedWithoutReceipt). The call in the block without its receipt shows nothing: a relayTransfer of another
     *   request called through code before it makes it revert;
     * - positive evidence that something else used it, the same kind on every RPC: a NonceInvalidated of the signer
     *   covering the nonce (the signer cancelled it), a successful relayTransfer of another request of the signer at the
     *   nonce (another version of the payment, or another payment), each failed with nonce_used; or a use after the
     *   request's deadline, expired. A pending final state wins. Provisional until settled on every RPC;
     * - otherwise (an RPC shows the relay's call without its receipt, an RPC cannot tell, does not answer, or the RPCs
     *   disagree): the relay waits, with an ALERT after RELAY_STUCK_AFTER_BLOCKS. No missing receipt or log fails it, and
     *   none makes it mined.
     */
    private async usedIntentNonce(request: RequestRecord, entry: UnknownNonce, view: TickView): Promise<void> {
        const { store, settings, logger, clock, metrics } = this.deps;
        const head = view.head.number;
        if (!entry.warned) {
            entry.warned = true;
            this.txm.nonceEvents.inc({ event: 'receipt_hidden' });
            logger.warn(
                { requestId: request.id, txNonce: request.txNonce },
                'the request nonce is used on-chain but no receipt of its transactions is visible; looking up how it was used',
            );
        }
        // The relay client's head once reported above today's must not stop the searches for good.
        if (entry.searchedAt !== undefined && head < entry.searchedAt) entry.searchedAt = head;
        if (entry.searchedAt === undefined || head - entry.searchedAt >= BigInt(settings.unknownNonceGraceBlocks)) {
            entry.searchedAt = head;
            const uses = await this.everyRpcUse(request);
            const agreed = TxManager.agreedUse(uses);
            entry.executed = uses.some((u) => u?.kind === 'executed' || (u?.kind === 'unknown' && u.listed === true));
            entry.searchSilent = agreed ? undefined : this.whyUndecided(uses);
            if (agreed?.kind === 'executed') {
                this.forgetUnknownNonce(request.id);
                await this.executedInUseBlock(request, agreed.uses, store.listAttempts(request.id));
                return;
            }
            if (agreed) {
                const kind = agreed.kind;
                const final = request.pendingFinal ?? (kind === 'invalidated' ? NONCE_INVALIDATED : kind === 'other' ? NONCE_USED_ELSEWHERE : EXPIRED_UNUSED);
                // Each RPC settles the failure on its own numbers only: its observation of the used tx nonce and its
                // own block of the use (foreignFinalOn); no block is stored as a bar for all of them.
                this.settleSeen.set(request.id, new Map(entry.seen));
                this.forgetUnknownNonce(request.id);
                store.resolveFailed(request.id, final, { kind: 'foreign', block: entry.sinceBlock }, clock.nowMs());
                if (kind !== 'late') this.txm.nonceEvents.inc({ event: kind === 'invalidated' ? 'nonce_invalidated' : 'nonce_used_elsewhere' });
                metrics.requestStatus.inc({ operation: request.operation, status: final.status });
                logger.warn(
                    { requestId: request.id, txNonce: request.txNonce, usedIn: agreed.uses.map((u) => u.block.number) },
                    kind === 'invalidated'
                        ? 'the sender invalidated the request nonce and another transaction took its tx nonce; the request failed (final once every RPC shows that final)'
                        : kind === 'other'
                          ? 'another request of the sender used the request nonce and another transaction took its tx nonce; the request failed (final once every RPC shows that final)'
                          : 'the request nonce was used after its deadline and another transaction took its tx nonce; the request expired (final once every RPC shows that final)',
                );
                return;
            }
        }
        if (entry.executed) {
            this.waiting(
                request,
                'receipt',
                head,
                `an RPC shows the relay's call in the block that used the request nonce, but not every RPC serves its successful receipt there: ${entry.searchSilent ?? ''}`,
            );
            return;
        }
        this.waiting(request, 'nonce_evidence', head, entry.searchSilent ?? 'the RPCs disagree how the request nonce was used');
    }

    /**
     * The use every RPC shows (by position; undefined: no answer), if they all show one of the same kind: for the relay's
     * call, the same transaction. Each RPC's own block counts for that RPC only.
     */
    private static agreedUse(
        uses: readonly (NonceUse | undefined)[],
    ): { kind: 'executed'; uses: readonly ExecutedUse[] } | { kind: 'other' | 'invalidated' | 'late'; uses: readonly FoundUse[] } | undefined {
        const found = uses.filter((u): u is FoundUse => u !== undefined && u.kind !== 'unknown');
        const first = found[0];
        if (!first || found.length !== uses.length || found.some((u) => u.kind !== first.kind)) return undefined;
        if (first.kind !== 'executed') return { kind: first.kind, uses: found };
        const executed = found as ExecutedUse[];
        return executed.every((u) => sameHash(u.tx.hash, first.tx.hash)) ? { kind: 'executed', uses: executed } : undefined;
    }

    /** Why the RPCs' uses (see agreedUse) decide nothing, for the ALERT. */
    private whyUndecided(uses: readonly (NonceUse | undefined)[]): string {
        if (uses.includes(undefined)) return this.whyNot(uses.map((u) => (u === undefined ? undefined : 'yes')), '');
        const unknown = uses.flatMap((u, i) => (u?.kind === 'unknown' ? [`RPC #${i + 1} cannot tell how the request nonce was used: ${u.why}`] : []));
        if (unknown.length > 0) return unknown.join('; ');
        return `the RPCs disagree how the request nonce was used (${uses.map((u, i) => `#${i + 1}: ${u?.kind}`).join(', ')})`;
    }

    /** How every RPC (by position) shows the use of the request's intent nonce (nonceUseOn); undefined: no answer. */
    private async everyRpcUse(request: RequestRecord): Promise<(NonceUse | undefined)[]> {
        return Promise.all(
            this.passVoters.map(async (rpc, i): Promise<NonceUse | undefined> => {
                const view = await this.rpcView(i);
                if (!view) return undefined;
                return this.ask(i, () => this.nonceUseOn(i, rpc, view.head, request));
            }),
        );
    }

    /**
     * How RPC `i` shows the use of the request's intent nonce, read at `head` (its head of this pass) and below
     * (quorum.findNonceUse). An earlier answer of the same RPC is re-used while that RPC still shows it (stillShows): the
     * same block at the height of the use, and in it the same evidence. The chain up to that block is the same, and so
     * is the answer; the state of older blocks is not read again.
     */
    private async nonceUseOn(i: number, rpc: ChainClient, head: BlockInfo, request: RequestRecord): Promise<NonceUse> {
        const cached = this.uses.get(request.id)?.get(i);
        if (cached && cached.use.block.number <= head.number) {
            if (cached.pass === this.passes) return cached.use;
            if (await TxManager.stillShows(rpc, request, cached.use)) {
                cached.pass = this.passes;
                return cached.use;
            }
        }
        const query = this.useQuery(request);
        const use: NonceUse = query ? await findNonceUse(rpc, query, head.number) : { kind: 'unknown', why: `the operation ${request.operation} is not registered` };
        // Looked up again: the other RPCs' searches run at the same time and may have stored their answers meanwhile.
        let known = this.uses.get(request.id);
        if (use.kind === 'unknown') {
            known?.delete(i);
            return use;
        }
        if (!known) {
            known = new Map();
            this.uses.set(request.id, known);
        }
        known.set(i, { use, pass: this.passes });
        return use;
    }

    /**
     * Whether `rpc` still shows `use`: the block of the use with the same hash, and in it the same evidence (its
     * timestamp after the deadline; the invalidation's log; the successful receipt of the call, read on its own or from
     * eth_getBlockReceipts of that block). Two or three reads, none of older state.
     */
    private static async stillShows(rpc: ChainClient, request: RequestRecord, use: FoundUse): Promise<boolean> {
        const b = use.block.number;
        const block = rpc.getBlockByNumber ? await rpc.getBlockByNumber(b) : null;
        if (!block || !sameHash(block.hash, use.block.hash)) return false;
        if (use.kind === 'late') return block.timestamp > request.deadline;
        if (use.kind === 'invalidated') {
            if (!rpc.getLogs) return false;
            const logs = await rpc.getLogs({ address: request.contract, topics: nonceEventFilter(request.signer), fromBlock: b, toBlock: b });
            return logs.some((log) => log.blockNumber === b && sameHash(log.blockHash, use.block.hash) && sameHash(log.transactionHash, use.tx));
        }
        const receipt = await receiptInBlock(rpc, use.block, use.kind === 'other' ? use.tx : use.tx.hash);
        return receipt?.status === 'success';
    }

    /** What findNonceUse looks for, for this request; undefined if its operation is not registered. */
    private useQuery(request: RequestRecord): UseQuery | undefined {
        const { ctx, registry } = this.deps;
        const op = registry.get(request.operation);
        if (!op) return undefined;
        return {
            contract: request.contract,
            floor: ctx.deployBlock,
            signer: request.signer,
            nonce: BigInt(request.nonce),
            deadline: request.deadline,
            id: request.id,
            executionOf: (call, nonce) => op.executionOf(ctx, call, nonce),
        };
    }

    /**
     * Every RPC shows the successful receipt of the relay's call `uses[0].tx` executing the request in the block that
     * used its intent nonce, while no RPC answers eth_getTransactionReceipt for it (the receipt came from
     * eth_getBlockReceipts of that block, or the call is a transaction of the relay key the relay does not track): the
     * request is mined (provisional, like any inclusion), by the receipt of the highest of the RPCs' blocks.
     */
    private async executedInUseBlock(request: RequestRecord, uses: readonly ExecutedUse[], attempts: readonly TxAttemptRecord[]): Promise<void> {
        const { tx, receipt } = uses.reduce((a, b) => (b.block.number > a.block.number ? b : a));
        this.txm.nonceEvents.inc({ event: 'mined_by_nonce_search' });
        this.deps.logger.warn(
            { requestId: request.id, txHash: tx.hash, usedIn: uses.map((u) => u.block.number) },
            "every RPC shows the successful receipt of the relay's call in the block that used the request nonce, none answers it on its own: mined",
        );
        // A transaction of the relay key with this request's call that the relay does not track is its execution too.
        await this.resolveByReceipt(request, attempts.find((a) => sameHash(a.hash, tx.hash)) ?? { hash: tx.hash, kind: 'call', gasUsed: null }, receipt);
    }

    /** Whether the request's intent nonce is used at `blockNumber` (latest without), through the relay's own client; undefined if unreadable. */
    private async intentNonceUsed(request: RequestRecord, blockNumber?: bigint): Promise<boolean | undefined> {
        try {
            return await readIntentNonceUsed(this.deps.ctx.chain, request.contract, request.signer, BigInt(request.nonce), blockNumber);
        } catch (err) {
            this.deps.logger.warn({ err, requestId: request.id }, 'could not read the intent nonce; will retry');
            return undefined;
        }
    }

    /** One of the request's transactions took the tx nonce: mined, or a provisional failed/expired. */
    private async resolveByReceipt(request: RequestRecord, attempt: Pick<TxAttemptRecord, 'hash' | 'kind' | 'gasUsed'>, receipt: ReceiptInfo): Promise<void> {
        const { ctx, store, clock, logger, metrics } = this.deps;
        const mined: MinedInfo = {
            hash: attempt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
        };
        // Gas is counted when an attempt is first seen included (again after a reorg re-included it).
        const firstSeen = attempt.gasUsed === null;
        if (firstSeen) this.progress();
        this.heldAtCap.delete(request.id);

        if (attempt.kind === 'call' && receipt.status === 'success') {
            // The relay's own call of exactly this request (encodeCall) succeeded: the contract verified the signature
            // over the sender's nonce first and moved the signed amounts, so the request executed. The contract emits no
            // event of its own; the token's Transfer logs are in the receipt.
            this.resend.delete(request.id);
            if (firstSeen) this.recordGasCost('call', receipt);
            const now = clock.nowMs();
            store.markMined(request.id, mined, now);
            if (request.status !== 'mined') metrics.requestStatus.inc({ operation: request.operation, status: 'mined' });
            if (request.minedAtMs === null) {
                // First time mined (a reorg re-inclusion does not count again).
                metrics.timeToMine.observe({ operation: request.operation }, Math.max(0, now - request.createdAtMs) / 1000);
                const symbol = (request.token && ctx.tokens.get(request.token.toLowerCase())?.symbol) ?? 'unknown';
                metrics.feeRevenueUsd.inc({ token: symbol }, Number(request.fee) / 1e6);
            }
            logger.info({ requestId: request.id, txHash: attempt.hash, blockNumber: receipt.blockNumber }, 'request mined');
            return;
        }

        let final: FinalFailure;
        if (request.pendingFinal) {
            final = request.pendingFinal;
        } else if (attempt.kind === 'call') {
            // a token admin action (pause, block list, rename) is reported with its own code.
            const attributed = await this.attribute(request);
            final = {
                status: 'failed',
                error: attributed
                    ? { code: attributed.code, message: `${attributed.message} (the transaction reverted on-chain)` }
                    : { code: 'simulation_failed', message: 'The transaction reverted on-chain' },
            };
        } else {
            final = { status: 'failed', error: { code: 'internal_error', message: 'The transaction was cancelled' } };
        }
        this.resend.delete(request.id);
        if (firstSeen) {
            this.recordGasCost(attempt.kind, receipt);
            if (attempt.kind === 'call') {
                // the accepted request was invalidated after the broadcast (front-running by
                // its sender, a token admin action). The relay paid a full reverted call and earned no fee.
                this.txm.revertedOnChain.inc({ operation: request.operation });
                this.txm.revertedGasPol.inc({ operation: request.operation }, Number(formatEther(receipt.gasUsed * receipt.effectiveGasPrice)));
            }
        }
        store.resolveFailed(
            request.id,
            final,
            { kind: 'receipt', mined, attemptKind: attempt.kind, callReverted: attempt.kind === 'call' },
            clock.nowMs(),
        );
        if (request.status !== final.status) metrics.requestStatus.inc({ operation: request.operation, status: final.status });
        logger.warn(
            { requestId: request.id, txHash: attempt.hash, kind: attempt.kind, status: final.status, code: final.error.code },
            'request ended without a successful transaction',
        );
    }

    private recordGasCost(kind: string, receipt: ReceiptInfo): void {
        const pol = Number(formatEther(receipt.gasUsed * receipt.effectiveGasPrice));
        this.deps.metrics.gasCostPol.inc({ kind }, pol);
        const price = this.deps.priceSource?.last();
        if (price) this.deps.metrics.gasCostUsd.inc({ kind }, pol * Number(formatFixed(price.value, price.decimals)));
    }

    // -----------------------------------------------------------------------------------------
    // Provisional outcomes until finality
    // -----------------------------------------------------------------------------------------

    /**
     * Mined, and failed/expired decided by an inclusion or by a foreign transaction, are re-checked until they settle
     * (mined → confirmed; the secrets are purged). a pass checks at most SETTLE_CHECKS_PER_PASS of them, the
     * ones checked least recently first (never checked ones first, oldest first), so that the work of a pass does not
     * grow with the number of unsettled requests; more of them than that is reported as `settle_backlog` (degraded)
     * and in `relay_unsettled_requests`. Unsettled requests are never deleted (retention deletes settled ones only).
     */
    private async reconcileResolved(view: TickView): Promise<void> {
        const { store } = this.deps;
        const unsettled = store.listUnsettled();
        const live = new Set<string>(unsettled.map((r) => r.id));
        for (const id of [...this.receiptMissing.keys()]) if (!live.has(id)) this.receiptMissing.delete(id);
        for (const id of [...this.settleChecked.keys()]) if (!live.has(id)) this.settleChecked.delete(id);
        for (const id of [...this.settleSeen.keys()]) if (!live.has(id)) this.settleSeen.delete(id);
        for (const id of [...this.uses.keys()]) if (!live.has(id) && !this.unknownNonce.has(id)) this.uses.delete(id);
        // listUnsettled is in insertion order and the sort is stable.
        const batch = [...unsettled]
            .sort((a, b) => (this.settleChecked.get(a.id) ?? 0) - (this.settleChecked.get(b.id) ?? 0))
            .slice(0, SETTLE_CHECKS_PER_PASS);
        for (const request of batch) {
            this.settleChecked.set(request.id, this.passes);
            await this.reconcileOutcome(request, view);
        }
        // What is left after this pass (settled, reopened or re-resolved requests change it).
        const left = unsettled.length === 0 ? 0 : store.listUnsettled().length;
        this.txm.unsettled.set(left);
        this.settleBacklog =
            left > SETTLE_CHECKS_PER_PASS ? `settle_backlog: ${left} provisional outcomes wait to settle; a pass checks ${SETTLE_CHECKS_PER_PASS} of them` : undefined;
    }

    /**
     * One provisional outcome. Once its deciding block is final and canonical through the relay's own client, it
     * settles when every RPC agrees (settleAgreed). If the deciding transaction is gone, the nonce is resolved again by
     * whichever of the request's transactions is found; if none is, resolvedWithoutReceipt decides. Undoing a mined
     * outcome needs every RPC (undoConfirmed).
     */
    private async reconcileOutcome(request: RequestRecord, view: TickView): Promise<void> {
        const { ctx, store, clock, logger } = this.deps;
        const attempts = store.listAttempts(request.id);
        if (request.resolvedTxHash !== null) {
            const deciding = attempts.find((a) => sameHash(a.hash, request.resolvedTxHash));
            const receipt = await receiptFor(ctx.chain, request.resolvedTxHash);
            if (receipt && deciding && this.sameOutcome(request, deciding, receipt)) {
                this.receiptMissing.delete(request.id);
                this.decided(request.id, 'outcome');
                if (receipt.blockNumber !== request.resolvedBlock) store.updateMinedBlock(request.id, receipt.blockNumber, clock.nowMs());
                if (receipt.blockNumber <= view.finalized && (await this.canonical(receipt))) {
                    await this.settleAgreed(request, view, (i, rpc, rpcView) => this.receiptFinalOn(i, rpc, rpcView, request, attempts, receipt));
                }
                return;
            }
        }
        // The deciding transaction is gone, or its receipt says something else now: whichever of the request's
        // transactions took the nonce decides.
        const found = await this.findReceipt(attempts);
        if (found) {
            const stillMined = found.attempt.kind === 'call' && found.receipt.status === 'success';
            if (request.status === 'mined' && !stillMined && !(await this.undoConfirmed(request, attempts, view, { kind: 'receipt', receipt: found.receipt }))) return;
            this.receiptMissing.delete(request.id);
            this.decided(request.id, 'outcome');
            if (!sameHash(found.attempt.hash, request.resolvedTxHash)) {
                logger.warn({ requestId: request.id, txHash: found.attempt.hash }, 'reorg: the request is resolved again by the transaction now included');
            }
            await this.resolveByReceipt(request, found.attempt, found.receipt);
            return;
        }
        const elsewhere = await this.receiptElsewhere(attempts);
        if (!elsewhere.every((v) => v === 'yes')) {
            this.waiting(request, 'outcome', view.head.number, this.whyNot(elsewhere, 'the relay client shows no transaction of the request, but another RPC does'));
            return;
        }
        this.decided(request.id, 'outcome');
        await this.resolvedWithoutReceipt(request, attempts, view);
    }

    /**
     * Every RPC's answer to "no receipt of any of `attempts` here" ('no': it shows one). The relay's own client was
     * asked already; an RPC that does not answer is unknown, not "no receipt": the caller waits.
     */
    private async receiptElsewhere(attempts: readonly TxAttemptRecord[]): Promise<Vote[]> {
        return Promise.all(
            this.passVoters.map(async (rpc, i): Promise<Vote> => {
                if (this.isOwnClient(i)) return 'yes';
                const shown = await this.ask(i, async () => (await findReceiptOn(rpc, attempts)) !== undefined);
                return shown === undefined ? undefined : shown ? 'no' : 'yes';
            }),
        );
    }

    /**
     * A provisional outcome without any visible receipt of the request's transactions (and no other RPC shows one):
     * - the tx nonce is unused again through the relay's own client: a reorg removed the deciding inclusion, and the
     *   request goes back in flight (its stored transactions are re-sent);
     * - the tx nonce is used, but the request's intent nonce is unused while it is mined: back in flight, where
     *   reconcileSubmitted decides (the receipt, or a new tx nonce once every RPC agrees);
     * - a mined request whose intent nonce is used settles once every RPC shows its call in the block that used the
     *   nonce, final by that RPC's own view (executedFinalOn);
     * - a mined request without a tx nonce (it ended in the queue after a requeue and was found executed) whose
     *   intent nonce is unused again goes back to the queue (requeueUnexecuted);
     * - a failed or expired request decided by a foreign transaction settles once every RPC shows it final, with
     *   positive evidence of what else used its intent nonce if that is used (settleForeign); every RPC showing the
     *   relay's call there makes it mined instead;
     * - otherwise the outcome holds and settles once every RPC agrees (settleAgreed).
     * A mined outcome goes back in flight only once every RPC confirms it (undoConfirmed). an outcome
     * decided by a foreign transaction is not held back by its stored block (one RPC's number): every RPC's vote
     * decides, on its own observation (foreignFinalOn).
     */
    private async resolvedWithoutReceipt(request: RequestRecord, attempts: readonly TxAttemptRecord[], view: TickView): Promise<void> {
        const { store, settings, clock, logger } = this.deps;
        const now = clock.nowMs();
        if (request.txNonce === null) {
            // Ended in the queue after a requeue: its earlier transactions' nonce was used by another transaction.
            if (request.status === 'mined' && request.resolvedTxHash !== null) {
                // settleForeign found the relay's call executing it after all (executedInUseBlock). A reorg can remove
                // that execution again: the intent nonce is unused then, and once every RPC shows that the request did
                // not execute it waits in the queue again, where it is sent with a new tx nonce or ends at its
                // deadline. (Without this it stayed mined, and unsettled, for good.)
                const used = await this.intentNonceUsed(request, view.head.number);
                if (used === undefined) return;
                if (!used) {
                    if (!(await this.undoConfirmed(request, attempts, view, { kind: 'not_executed' }))) return;
                    logger.warn({ requestId: request.id, txHash: request.resolvedTxHash }, 'reorg: the execution of the request is gone; the request is queued again');
                    this.requeueUnexecuted(request, now);
                    return;
                }
                // It settles like every mined request whose call no RPC answers on its own: once every RPC shows that
                // call's block final.
                await this.settleExecuted(request, attempts, view, request.resolvedTxHash);
                return;
            }
            await this.settleForeign(request, attempts, view);
            return;
        }
        const nonces = await this.nonces();
        if (request.txNonce >= nonces.latest) {
            if (request.status === 'mined' && !(await this.undoConfirmed(request, attempts, view, { kind: 'nonce_unused' }))) return;
            logger.warn({ requestId: request.id, txNonce: request.txNonce }, 'reorg: the tx nonce is unused again; the request is in flight again');
            this.reopen(request, now);
            return;
        }
        // The tx nonce is used, but no receipt of the request is visible: a lagging receipt node, or a foreign
        // transaction. A mined request whose intent nonce is unused did not execute.
        if (request.status === 'mined') {
            const used = await this.intentNonceUsed(request, view.head.number);
            if (used === undefined) return;
            if (!used) {
                if (!(await this.undoConfirmed(request, attempts, view, { kind: 'not_executed' }))) return;
                // What executed no longer matches the stored outcome: in flight again, and reconcileSubmitted decides
                // (waiting for the receipt, or a new nonce once every RPC agrees). Its tx nonce is used: nothing is sent.
                logger.warn({ requestId: request.id, status: request.status }, 'reorg: the on-chain outcome changed; the request is in flight again');
                this.reopen(request, now, view.head.number);
                return;
            }
        }
        if (request.resolvedTxHash === null) {
            // Decided by a foreign transaction: settles once every RPC shows it final.
            await this.settleForeign(request, attempts, view);
            return;
        }
        if (request.status === 'mined') {
            // No RPC answers eth_getTransactionReceipt for its call (maybe none ever did: executedInUseBlock).
            await this.settleExecuted(request, attempts, view, request.resolvedTxHash);
            return;
        }
        // The stored outcome holds, but its deciding receipt is not visible. A failed or expired one whose receipt
        // stays hidden for the grace period is re-based on this observation, so that it can settle (once every RPC
        // agrees) and its secrets can be purged. (A first block the relay's client once reported above today's head
        // counts from today's.)
        const since = minBig(this.receiptMissing.get(request.id) ?? view.head.number, view.head.number);
        this.receiptMissing.set(request.id, since);
        if (view.head.number - since < BigInt(settings.unknownNonceGraceBlocks)) return;
        this.receiptMissing.delete(request.id);
        store.resolveFailed(
            request.id,
            { status: request.status as FinalFailure['status'], error: request.error ?? { code: 'internal_error', message: 'The transaction was cancelled' } },
            { kind: 'foreign', block: view.head.number },
            now,
        );
        logger.warn({ requestId: request.id, txNonce: request.txNonce }, 'the deciding receipt is not visible; the outcome settles on the observed nonce');
    }

    /**
     * Undoing a mined outcome needs every RPC to show, in this pass, that the
     * request did not execute and the state the undo is based on:
     * - its head made after the moment the relay recorded the outcome (its timestamp later than the relay's clock when
     *   it stored the inclusion, `updatedAtMs` of a mined request). An RPC whose head is not newer may not have seen
     *   the inclusion yet, and shows exactly what an undo needs. the bar is the relay's clock, not the block
     *   number of the receipt: that number came from one RPC (the relay's own client), which could have chosen one
     *   that no RPC ever reaches. On a chain whose timestamps lag far behind the relay's clock (a fork of mainnet) no
     *   head is newer, and a mined outcome is not undone (it waits with the ALERT);
     * - no successful call among the request's transactions, and the request's intent nonce unused;
     * - `receipt`: another of the request's transactions now decides, and the RPC shows that receipt;
     *   `nonce_unused`: no receipt of the request's transactions, and the relay's tx nonce unused again;
     *   `not_executed`: no receipt of the request's transactions, and the tx nonce used (by another transaction).
     * Any RPC that shows otherwise holds the undo back, and so does one that does not answer (ALERT after
     * RELAY_STUCK_AFTER_BLOCKS).
     */
    private async undoConfirmed(
        request: RequestRecord,
        attempts: readonly TxAttemptRecord[],
        view: TickView,
        basis: { kind: 'receipt'; receipt: ReceiptInfo } | { kind: 'nonce_unused' } | { kind: 'not_executed' },
    ): Promise<boolean> {
        // Without a tx nonce (the request ended in the queue after a requeue, and was mined by the nonce search) there
        // is none to look at: its earlier transactions' nonce went to another transaction for good.
        const { txNonce } = request;
        // markMined and updateMinedBlock set updatedAtMs; nothing else changes a mined request that is not settled.
        const recordedAtMs = request.updatedAtMs;
        const votes = await this.everyRpc(async (_i, rpc, rpcView): Promise<Vote> => {
            if (!TxManager.newerThan(rpcView.head, recordedAtMs)) return 'no';
            const theirs = await findReceiptOn(rpc, attempts);
            if (theirs && theirs.attempt.kind === 'call' && theirs.receipt.status === 'success') return 'no';
            if (basis.kind === 'receipt') {
                if (!theirs || !sameHash(theirs.receipt.transactionHash, basis.receipt.transactionHash)) return 'no';
            } else {
                if (theirs) return 'no';
                if (txNonce !== null) {
                    const latest = await rpc.getTransactionCount(this.deps.signer.address, 'latest');
                    if ((latest > txNonce) !== (basis.kind === 'not_executed')) return 'no';
                }
            }
            const used = await readIntentNonceUsed(rpc, request.contract, request.signer, BigInt(request.nonce), rpcView.head.number);
            return used ? 'no' : 'yes';
        });
        if (votes.every((v) => v === 'yes')) return true;
        this.waiting(
            request,
            'outcome',
            view.head.number,
            this.whyNot(votes, 'not every RPC shows, at a head made after the relay recorded the outcome, that the mined request did not execute'),
        );
        return false;
    }

    /**
     * Whether the deciding receipt still says what the stored state says: a successful call of the request is its
     * execution (mined); a cancel or a reverted call decides a failed or expired outcome.
     */
    private sameOutcome(request: RequestRecord, deciding: TxAttemptRecord, receipt: ReceiptInfo): boolean {
        const executed = deciding.kind === 'call' && receipt.status === 'success';
        return request.status === 'mined' ? executed : !executed;
    }

    /**
     * The request is in flight again. Its stored transactions are re-sent, unless `nonceUsedAt` says that its tx
     * nonce is used on-chain already (then it waits in the "tx nonce used without a receipt" state from that block).
     */
    private reopen(request: RequestRecord, now: number, nonceUsedAt?: bigint): void {
        this.deps.store.reopen(request.id, now);
        this.forgetUnknownNonce(request.id);
        if (nonceUsedAt === undefined) this.resend.add(request.id);
        else this.unknownNonce.set(request.id, { sinceBlock: nonceUsedAt, warned: false, searchedAt: undefined, seen: new Map() });
        this.receiptMissing.delete(request.id);
        this.settleSeen.delete(request.id);
        this.uses.delete(request.id);
        this.decided(request.id);
        this.deps.metrics.requestStatus.inc({ operation: request.operation, status: 'submitted' });
    }

    /** A mined request without a tx nonce did not execute after all: queued again (Store.requeueUnexecuted). */
    private requeueUnexecuted(request: RequestRecord, now: number): void {
        this.deps.store.requeueUnexecuted(request.id, now);
        this.receiptMissing.delete(request.id);
        this.settleSeen.delete(request.id);
        this.uses.delete(request.id);
        this.decided(request.id);
        this.deps.metrics.requestStatus.inc({ operation: request.operation, status: 'queued' });
    }

    /**
     * The outcome is final (and canonical) through the relay's own client. Settling purges the secrets and raw
     * transactions, so every RPC must agree in this pass (`vote`):
     * - decided by a receipt: each RPC shows the deciding receipt with the same block and status, that block canonical
     *   at its height and final by the RPC's own `finalized` tag and head (receiptFinalOn). A mined request on an RPC
     *   that does not answer eth_getTransactionReceipt for its call: that RPC shows the call's successful receipt in the
     *   block that used the intent nonce (eth_getBlockReceipts), final by its own view (executedFinalOn);
     * - decided by a foreign transaction: see settleForeign;
     * - failed or expired: no RPC shows a successful call among the request's transactions (that would be its execution).
     * Otherwise the request stays provisional (ALERT after RELAY_STUCK_AFTER_BLOCKS).
     */
    private async settleAgreed(request: RequestRecord, view: TickView, vote: (i: number, rpc: ChainClient, view: RpcView) => Promise<Vote>): Promise<void> {
        const votes = await this.everyRpc(vote);
        if (!votes.every((v) => v === 'yes')) {
            this.waiting(request, 'settle', view.head.number, this.whyNot(votes, 'not every RPC shows the outcome final and canonical'));
            return;
        }
        this.decided(request.id, 'settle');
        this.settle(request, this.deps.clock.nowMs());
    }

    /**
     * A mined request whose call `hash` no RPC answers on its own settles once every RPC shows that call's successful
     * receipt in the block that used the intent nonce, final by its own view (executedFinalOn). If every RPC shows
     * another of the relay's calls of the request executing it there instead (a reorg included a speed-up, or another
     * transaction of the relay key with the call, in its place), the request is mined by that call (executedInUseBlock)
     * and settles by it in a later pass; until the RPCs agree it waits, with the ALERT.
     */
    private async settleExecuted(request: RequestRecord, attempts: readonly TxAttemptRecord[], view: TickView, hash: Hex): Promise<void> {
        const uses = new Map<number, NonceUse>();
        const votes = await this.everyRpc((i, rpc, rpcView) => this.executedFinalOn(i, rpc, rpcView, request, hash, uses));
        const agreed = TxManager.agreedUse(this.passVoters.map((_, i) => uses.get(i)));
        const executing = agreed?.kind === 'executed' ? agreed.uses[0]?.tx.hash : undefined;
        if (agreed?.kind === 'executed' && executing !== undefined && !sameHash(executing, hash)) {
            this.decided(request.id, 'settle');
            this.deps.logger.warn(
                { requestId: request.id, txHash: executing, stored: hash },
                "every RPC shows another of the relay's calls of the request executing it: the request is mined by that call",
            );
            await this.executedInUseBlock(request, agreed.uses, attempts);
            return;
        }
        if (!votes.every((v) => v === 'yes')) {
            this.waiting(request, 'settle', view.head.number, this.whyNot(votes, 'not every RPC shows the outcome final and canonical'));
            return;
        }
        this.decided(request.id, 'settle');
        this.settle(request, this.deps.clock.nowMs());
    }

    /**
     * An outcome decided by a foreign transaction settles once every RPC shows it final (foreignFinalOn, which needs
     * positive evidence of what used the request's intent nonce if that is used). If instead every RPC shows the
     * successful receipt of the relay's call executing the request in the block that used the nonce, the provisional
     * failure becomes mined (executedInUseBlock).
     */
    private async settleForeign(request: RequestRecord, attempts: readonly TxAttemptRecord[], view: TickView): Promise<void> {
        const uses = new Map<number, NonceUse>();
        const votes = await this.everyRpc((i, rpc, rpcView) => this.foreignFinalOn(i, rpc, rpcView, request, attempts, uses));
        const agreed = TxManager.agreedUse(this.passVoters.map((_, i) => uses.get(i)));
        if (agreed?.kind === 'executed') {
            this.decided(request.id, 'settle');
            this.deps.logger.warn({ requestId: request.id, status: request.status }, "every RPC shows the relay's call executing the request: the provisional outcome becomes mined");
            await this.executedInUseBlock(request, agreed.uses, attempts);
            return;
        }
        if (!votes.every((v) => v === 'yes')) {
            this.waiting(request, 'settle', view.head.number, this.whyNot(votes, 'not every RPC shows the outcome final and canonical'));
            return;
        }
        this.decided(request.id, 'settle');
        this.settle(request, this.deps.clock.nowMs());
    }

    /** RPC `i`'s vote on settling an outcome decided by `receipt` (see settleAgreed). */
    private async receiptFinalOn(
        i: number,
        rpc: ChainClient,
        view: RpcView,
        request: RequestRecord,
        attempts: readonly TxAttemptRecord[],
        receipt: ReceiptInfo,
    ): Promise<Vote> {
        const theirs = await receiptFor(rpc, receipt.transactionHash);
        if (!theirs && request.status === 'mined') return this.executedFinalOn(i, rpc, view, request, receipt.transactionHash);
        if (!theirs || theirs.status !== receipt.status || theirs.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) return 'no';
        if (theirs.blockNumber > view.finalized) return 'no';
        if (rpc.getBlockByNumber) {
            const block = await rpc.getBlockByNumber(theirs.blockNumber);
            if (!block || block.hash.toLowerCase() !== theirs.blockHash.toLowerCase()) return 'no';
        }
        if (request.status === 'mined') return 'yes';
        const success = await findReceiptOn(rpc, attempts);
        return success && success.attempt.kind === 'call' && success.receipt.status === 'success' ? 'no' : 'yes';
    }

    /**
     * RPC `i`'s vote on settling a mined request by the block that used its intent nonce (the RPC does not answer
     * eth_getTransactionReceipt for its call): that RPC shows the successful receipt of the call `hash` executing the
     * request there (findNonceUse: eth_getBlockReceipts of that block), and the block is canonical and final by the RPC's
     * own view. The use it shows is put in `uses`.
     */
    private async executedFinalOn(i: number, rpc: ChainClient, view: RpcView, request: RequestRecord, hash: Hex, uses?: Map<number, NonceUse>): Promise<Vote> {
        const use = await this.nonceUseOn(i, rpc, view.head, request);
        uses?.set(i, use);
        return use.kind === 'executed' && sameHash(use.tx.hash, hash) && use.block.number <= view.finalized ? 'yes' : 'no';
    }

    /**
     * RPC `i`'s vote on settling an outcome decided by a foreign transaction (see settleForeign): no receipt of any of
     * the request's transactions, the tx nonce used, and the RPC's own observation of that final by its own view. The
     * observation carries over from the decision (nonceUsedWithoutReceipt: the same state, on the same RPC); otherwise
     * it starts at the RPC's head at the first check. A stored observation above the RPC's head is re-based (see
     * observation()), so a block number an RPC once gave cannot keep the outcome unsettled for good. A request that
     * ended in the queue after a requeue (no tx nonce) needs no new observation: its requeue waited until every RPC's
     * observation that the earlier transactions' nonce is used was final. If the request's intent nonce is used, this RPC
     * must show positive evidence that something else used it, in a block final by its own view (findNonceUse, through
     * nonceUseOn; its answer is put in `uses`): another request of the signer at the nonce, the signer's invalidation, or
     * a use after the deadline. The relay's call there, or no answer (an internal call, receipts it does not serve, no
     * state of older blocks), holds the settlement back: a missing receipt or log never settles a failure.
     */
    private async foreignFinalOn(
        i: number,
        rpc: ChainClient,
        view: RpcView,
        request: RequestRecord,
        attempts: readonly TxAttemptRecord[],
        uses: Map<number, NonceUse>,
    ): Promise<Vote> {
        // The votes of the RPCs run in parallel: the request's observations are looked up after each await, never kept
        // across one (a vote that created the map would otherwise replace the one another vote just created).
        const shows =
            (await findReceiptOn(rpc, attempts)) === undefined &&
            (request.txNonce === null || (await rpc.getTransactionCount(this.deps.signer.address, 'latest')) > request.txNonce);
        if (!shows) {
            this.settleSeen.get(request.id)?.delete(i);
            return 'no';
        }
        if (request.status !== 'mined' && (await readIntentNonceUsed(rpc, request.contract, request.signer, BigInt(request.nonce), view.head.number))) {
            const use = await this.nonceUseOn(i, rpc, view.head, request);
            uses.set(i, use);
            if (use.kind === 'executed') {
                this.settleSeen.get(request.id)?.delete(i);
                return 'no';
            }
            // Evidence awaiting depth does not contradict the existing observation. Resetting it every pass would require
            // a second full finality delay after the block of the use.
            if (use.kind === 'unknown' || use.block.number > view.finalized) return 'no';
        }
        // Without a tx nonce there is no observation to age: a failure that ended in the queue is final with the
        // evidence above. An execution is never settled by this vote (resolvedWithoutReceipt gives it to settleExecuted).
        if (request.txNonce === null) return request.status === 'mined' ? 'no' : 'yes';
        let seen = this.settleSeen.get(request.id);
        if (!seen) {
            seen = new Map();
            this.settleSeen.set(request.id, seen);
        }
        const since = this.observation(seen.get(i), view.head);
        seen.set(i, since);
        return since.block <= view.finalized ? 'yes' : 'no';
    }

    private settle(request: RequestRecord, now: number): void {
        const { store, metrics } = this.deps;
        store.settle(request.id, now);
        this.receiptMissing.delete(request.id);
        this.settleSeen.delete(request.id);
        this.uses.delete(request.id);
        this.settleChecked.delete(request.id);
        this.decided(request.id);
        if (request.status === 'mined') {
            metrics.requestStatus.inc({ operation: request.operation, status: 'confirmed' });
            metrics.timeToConfirm.observe({ operation: request.operation }, Math.max(0, now - request.createdAtMs) / 1000);
        }
    }

    /** The receipt's block is the canonical block at its height; true if the client cannot tell. */
    private async canonical(receipt: ReceiptInfo): Promise<boolean> {
        const { chain } = this.deps.ctx;
        if (!chain.getBlockByNumber) return true;
        const block = await chain.getBlockByNumber(receipt.blockNumber);
        if (block && block.hash.toLowerCase() === receipt.blockHash.toLowerCase()) return true;
        this.deps.logger.warn(
            { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber },
            'the receipt block is not the canonical block at its height; not settling yet',
        );
        return false;
    }

    // -----------------------------------------------------------------------------------------
    // Deadlines, speed-ups, re-broadcasts
    // -----------------------------------------------------------------------------------------

    private expireQueued(head: BlockInfo): void {
        const { store, logger } = this.deps;
        for (const request of store.listByStatus('queued')) {
            if (head.timestamp + BigInt(this.minSecondsToBroadcast) >= request.deadline) {
                const requeued = store.listAttempts(request.id).length > 0;
                if (this.endInQueue(request, requeued ? EXPIRED_AFTER_REQUEUE : EXPIRED_BEFORE_SUBMIT, head)) {
                    logger.info({ requestId: request.id }, 'request expired before submission');
                }
            }
        }
    }

    private async processSubmitted(view: TickView): Promise<void> {
        const { store, settings, logger } = this.deps;
        const { head } = view;
        this.lowFunds = false;
        this.gasBudgetHeld = false;
        // The queue side of a new pass: its budget of full checks (shared with broadcastQueued), and what it found out.
        this.passNumber += 1;
        this.passChecks = 0;
        this.passTried.clear();
        this.passWaiting = undefined;
        // Which queued requests their spend cap holds, as of this pass (othersWaiting below needs it).
        try {
            await this.precheckQueued(head);
        } catch (err) {
            if (!(err instanceof PriceUnavailableError)) throw err;
            // Unknown pricing holds new calls, but must not block cancellation or nonce maintenance.
            this.capHeld.clear();
        }
        const submitted = store.listByStatus('submitted');
        for (const id of [...this.heldAtCap]) if (!submitted.some((r) => r.id === id)) this.heldAtCap.delete(id);
        for (const id of [...this.blockedChecks.keys()]) if (!submitted.some((r) => r.id === id)) this.blockedChecks.delete(id);
        // The next nonce the chain can include: the relay account's `latest` count (reconcileSubmitted read it already).
        const includableNonce = submitted.length > 0 ? (await this.nonces()).latest : 0;
        const interval = BigInt(settings.speedUpAfterBlocks);
        for (const request of submitted) {
            // Its tx nonce is used on-chain: nothing can be sent at it (see nonceUsedWithoutReceipt).
            if (this.unknownNonce.has(request.id) || request.txNonce === null) continue;
            const latest = store
                .listAttempts(request.id)
                .filter((a) => a.txNonce === request.txNonce)
                .at(-1);
            if (!latest) continue;
            const sent = this.sentBlockOf(latest, head);
            const due = head.number - sent >= interval;
            // Behind a lower nonce that the chain has not included (a stuck or missing transaction of the relay key): no
            // fee of this transaction can get it included before that one, so it is not sped up. Every raise would only
            // climb towards the spend cap and RELAY_MAX_FEE_PER_GAS_GWEI and stay in the lifetime gas budget for good.
            // It is re-sent unchanged when the node lost it, and its sent block stays as it is: once its nonce is next
            // and it is still not included, it is due for one normal speed-up at once.
            const blocked = request.txNonce > includableNonce;
            if (!blocked) this.blockedChecks.delete(request.id);

            if (request.pendingFinal) {
                this.heldAtCap.delete(request.id);
                // A cancel is in flight (or could not be priced yet): keep it moving and the nonce filled. The call
                // itself is never sent again: the relay decided that it must not execute. If the node
                // lost the call, the cancel goes out at market fees (see cancel). Replacing the call by the cancel does
                // not wait for the nonce to be next: a call that must not execute must not wait in the pool until the
                // lower nonce is included, and it is one replacement, no escalation.
                if (latest.kind === 'call') {
                    if (due || this.resend.has(request.id)) await this.cancel(request, latest, head, request.pendingFinal);
                } else if (due && !blocked) {
                    if ((await this.speedUp(request, latest, head, undefined)) !== 'sent') await this.hold(request, latest, head);
                } else if (this.resend.has(request.id)) {
                    await this.rebroadcast(request, latest);
                }
                continue;
            }

            if (head.timestamp + BigInt(settings.deadlineSafetySeconds) >= request.deadline) {
                this.heldAtCap.delete(request.id);
                await this.cancel(request, latest, head, EXPIRED_IN_FLIGHT);
                continue;
            }

            if (blocked) {
                await this.waitBehind(request, latest, sent, head);
                continue;
            }
            if (!due && !this.resend.has(request.id)) continue;
            // Re-simulate (and re-check the sender) before every speed-up and re-broadcast of the call.
            const check = await this.preflight(request, head, 're-simulation failed');
            if (check.kind === 'retry') continue;
            if (check.kind === 'fail') {
                this.heldAtCap.delete(request.id);
                await this.cancel(request, latest, head, check.final);
                continue;
            }
            if (!due) {
                await this.rebroadcast(request, latest);
                continue;
            }
            try {
                const sped = await this.speedUp(request, latest, head, check.call);
                // At its spend cap, and its transaction pays less than a block takes now: the price keeps it out.
                // (At its cap while its transaction pays that already, something else does: an account without POL,
                // RPCs that refuse the broadcast. That is not the fee's fault, and it must show as `stalled`.)
                const pricedOut = sped === 'capped' && latest.maxFeePerGas < (head.baseFeePerGas ?? 0n) + settings.minTip;
                if (sped === 'sent') {
                    this.heldAtCap.delete(request.id);
                } else if (pricedOut && (await this.othersWaiting(request, submitted, head))) {
                    // Its fee no longer covers the gas price needed to get it included, and the requests behind it
                    // wait for its nonce: cancel it instead of holding the relay back until its deadline.
                    this.heldAtCap.delete(request.id);
                    this.txm.spendCapHolds.inc({ kind: 'cancel' });
                    logger.warn({ requestId: request.id, txNonce: request.txNonce }, 'request priced out at its spend cap while others wait; cancelling it');
                    await this.cancel(request, latest, head, FEE_BELOW_MARKET);
                } else {
                    // Held at its spend cap (it waits for the price to fall or for its deadline, like a queued
                    // request held by its cap), or at RELAY_MAX_FEE_PER_GAS_GWEI (the relay cannot pay more: stalled).
                    if (pricedOut) this.heldAtCap.add(request.id);
                    else this.heldAtCap.delete(request.id);
                    await this.hold(request, latest, head);
                }
            } catch (err) {
                if (!(err instanceof PriceUnavailableError)) throw err;
                // Another request may need a price-independent cancellation in this same pass.
            }
        }
    }

    /** Keeps the current transaction (re-sent as is) and checks again in `speedUpAfterBlocks`. */
    private async hold(request: RequestRecord, latest: TxAttemptRecord, head: BlockInfo): Promise<void> {
        this.deps.store.touchAttempt(latest.hash, head.number);
        await this.rebroadcast(request, latest);
    }

    /**
     * The block from which `attempt` counts towards its next speed-up: its sent block, or the pass's head when that is
     * below it. A head the relay's client once reported above today's (a lie, or another RPC answering then) would
     * otherwise hold every speed-up back for good; the attempt counts from today's head (stored).
     */
    private sentBlockOf(attempt: TxAttemptRecord, head: BlockInfo): bigint {
        if (attempt.sentBlock <= head.number) return attempt.sentBlock;
        this.deps.store.touchAttempt(attempt.hash, head.number);
        return head.number;
    }

    /**
     * A call in flight behind a lower nonce that the chain has not included (see processSubmitted): not sped up. At
     * the speed-up interval its call is still re-simulated, so a call that can no longer succeed is cancelled before
     * the lower nonce clears (the cancel replaces it once; see cancel), and it is re-sent unchanged only when the
     * node lost it (after the same checks). For `stalled` and `held_at_cap` it counts as held at its spend cap when
     * its cap would hold it once its nonce is next: its call pays less than the cheapest includable fee and its cap
     * allows no more (as othersWaiting judges it for the request in front of it). `sent`: its sent block (sentBlockOf).
     */
    private async waitBehind(request: RequestRecord, latest: TxAttemptRecord, sent: bigint, head: BlockInfo): Promise<void> {
        const { settings } = this.deps;
        try {
            if (await this.callCanGo(request, latest, head)) this.heldAtCap.delete(request.id);
            else this.heldAtCap.add(request.id);
        } catch (err) {
            if (!(err instanceof PriceUnavailableError)) throw err;
        }
        // The last re-simulation while it waits (a block the relay's client once reported above today's head counts
        // from today's); none yet: its sent block.
        let checked = this.blockedChecks.get(request.id);
        if (checked !== undefined && checked > head.number) this.blockedChecks.set(request.id, (checked = head.number));
        const due = head.number - maxBig(sent, checked ?? sent) >= BigInt(settings.speedUpAfterBlocks);
        if (!due && !this.resend.has(request.id)) return;
        const check = await this.preflight(request, head, 're-simulation failed');
        if (check.kind === 'retry') return;
        if (check.kind === 'fail') {
            this.heldAtCap.delete(request.id);
            this.blockedChecks.delete(request.id);
            await this.cancel(request, latest, head, check.final);
            return;
        }
        this.blockedChecks.set(request.id, head.number);
        if (this.resend.has(request.id)) await this.rebroadcast(request, latest);
    }

    /**
     * The call of an in-flight request would be included if its tx nonce were next: it pays the cheapest includable
     * fee (base fee + RELAY_MIN_TIP_GWEI) already, or its spend cap allows a speed-up to it.
     */
    private async callCanGo(request: RequestRecord, call: TxAttemptRecord, head: BlockInfo): Promise<boolean> {
        const includable = (head.baseFeePerGas ?? 0n) + this.deps.settings.minTip;
        return call.maxFeePerGas >= includable || (await this.callCap(request, call.gasLimit)) >= includable;
    }

    /**
     * Another request would be sent and included if this request's tx nonce were free, so this one holds it
     * back. That is:
     * - a request in flight at a higher tx nonce that is not held at its own spend cap: its call already pays the
     *   cheapest includable fee (base fee + RELAY_MIN_TIP_GWEI), or its cap allows a speed-up to it (callCanGo);
     * - a cancel in flight at a higher tx nonce (or a call the relay decided to cancel): cancels are exempt from the
     *   spend cap, so the relay can pay the cheapest includable fee for it whenever RELAY_MAX_FEE_PER_GAS_GWEI allows
     *   that. It is not sped up while it waits behind this request (processSubmitted), and without this it would wait
     *   for this request's deadline, holding its slot and every nonce above it;
     * - a queued request that passes its full check at this pass's head and fits its spend cap there (queuedCanGo).
     *   Neither the pre-check alone nor an
     *   unknown gas limit is enough.
     * A request whose tx nonce the chain already used does not count. Requests held at their own caps do not count,
     * so a gas spike that holds every request holds all of them, and nobody is cancelled.
     */
    private async othersWaiting(request: RequestRecord, submitted: readonly RequestRecord[], head: BlockInfo): Promise<boolean> {
        const { store, settings } = this.deps;
        const includable = (head.baseFeePerGas ?? 0n) + settings.minTip;
        const nonce = request.txNonce;
        if (nonce !== null) {
            for (const other of submitted) {
                if (other.id === request.id || other.txNonce === null || other.txNonce <= nonce) continue;
                if (this.unknownNonce.has(other.id)) continue;
                if (other.pendingFinal) {
                    if (settings.maxFeePerGas >= includable) return true;
                    continue;
                }
                const call = store
                    .listAttempts(other.id)
                    .filter((a) => a.txNonce === other.txNonce && a.kind === 'call')
                    .at(-1);
                if (!call) continue;
                if (await this.callCanGo(other, call, head)) return true;
            }
        }
        return this.queuedCanGo(head);
    }

    /**
     * Whether a queued request could be sent if a tx nonce were free (othersWaiting), found out once
     * per pass: in the send order, each queued request that the pre-check does not hold gets its full check at this
     * pass's head (the simulation and the gas estimate, within the pass's budget of full checks), until one fits its
     * spend cap. A request that fails the check ends in the queue there; one that its cap holds at its estimated gas
     * limit is held. A cancel is final and a held request would be included once gas prices fall, so when the check
     * cannot be made (an RPC error, the budget used up) nothing counts as waiting. What the sender does after this check
     * (moving its funds away) cannot be seen: the relay decided on the chain state of this pass's head.
     */
    private queuedCanGo(head: BlockInfo): Promise<boolean> {
        this.passWaiting ??= this.findQueuedThatCanGo(head);
        return this.passWaiting;
    }

    private async findQueuedThatCanGo(head: BlockInfo): Promise<boolean> {
        const { store, settings } = this.deps;
        const queued = store.listByStatus('queued');
        if (queued.length === 0) return false;
        const market = await this.marketFees(head);
        if (!market.affordable) return false;
        const includable = (head.baseFeePerGas ?? 0n) + settings.minTip;
        const price = await this.price();
        for (const request of fairOrder(queued, this.slots().perSender)) {
            const pre = this.precheck(request, includable, price);
            if (pre.kind === 'held') {
                this.holdQueued(request, pre.cap, head);
                continue;
            }
            if (this.tokenUnverified(request)) continue;
            if (this.passChecks >= this.maxChecks()) return false;
            this.passChecks += 1;
            const check = await this.checkQueued(request, head, market, price);
            if (check.kind === 'fits') return true;
            if (check.kind === 'retry' && check.stopPass) return false;
        }
        return false;
    }

    /** Market fees for a new transaction: tip = max(eth_maxPriorityFeePerGas, MIN_TIP), maxFee = 2 × baseFee + tip (capped). */
    private async marketFees(head: BlockInfo): Promise<Fees & { affordable: boolean }> {
        const { ctx, settings } = this.deps;
        if (this.tickTip === undefined) {
            try {
                this.tickTip = maxBig(await ctx.chain.getMaxPriorityFeePerGas(), settings.minTip);
            } catch {
                this.tickTip = settings.minTip;
            }
        }
        const base = head.baseFeePerGas ?? 0n;
        const maxFeePerGas = minBig(base * 2n + this.tickTip, settings.maxFeePerGas);
        return {
            maxFeePerGas,
            maxPriorityFeePerGas: minBig(this.tickTip, maxFeePerGas),
            affordable: settings.maxFeePerGas >= base + this.tickTip,
        };
    }

    /**
     * +speedUpPercent on both fee fields (at least the market price), capped at MAX_FEE_PER_GAS and, for calls,
     * at the request's spend cap; undefined if a replacement would be rejected.
     */
    private async replacementFees(previous: Fees, head: BlockInfo, callCap?: bigint): Promise<Fees | undefined> {
        const { settings } = this.deps;
        const pct = BigInt(100 + settings.speedUpPercent);
        const market = await this.marketFees(head);
        const ceiling = callCap !== undefined ? minBig(settings.maxFeePerGas, callCap) : settings.maxFeePerGas;
        let maxFeePerGas = maxBig(ceilDiv(previous.maxFeePerGas * pct, 100n), market.maxFeePerGas);
        let maxPriorityFeePerGas = maxBig(ceilDiv(previous.maxPriorityFeePerGas * pct, 100n), market.maxPriorityFeePerGas);
        maxFeePerGas = minBig(maxFeePerGas, ceiling);
        maxPriorityFeePerGas = minBig(maxPriorityFeePerGas, maxFeePerGas);
        const minFee = ceilDiv(previous.maxFeePerGas * MIN_REPLACEMENT_BUMP_PERCENT, 100n);
        const minTip = ceilDiv(previous.maxPriorityFeePerGas * MIN_REPLACEMENT_BUMP_PERCENT, 100n);
        if (maxFeePerGas < minFee || maxPriorityFeePerGas < minTip) return undefined;
        return { maxFeePerGas, maxPriorityFeePerGas };
    }

    private cancelTx(txNonce: number, fees: Fees): TransactionSerializableEIP1559 {
        return {
            type: 'eip1559',
            chainId: this.deps.ctx.chainId,
            nonce: txNonce,
            to: this.deps.signer.address,
            value: 0n,
            data: '0x',
            gas: CANCEL_GAS,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        };
    }

    /**
     * Fills the request's tx nonce with a 0-value self-transfer; `final` applies once a tx takes the nonce.
     * The cancel replaces the pending transaction (+RELAY_SPEEDUP_PERCENT, at least +10 %). If that cannot be
     * priced within RELAY_MAX_FEE_PER_GAS_GWEI and the node no longer holds anything at the nonce (it dropped the
     * call), the cancel goes out at market fees: nothing needs to be outbid there.
     */
    private async cancel(request: RequestRecord, latest: TxAttemptRecord, head: BlockInfo, final: FinalFailure): Promise<void> {
        const { signer, store, clock, logger } = this.deps;
        // Cancels are exempt from the per-request spend cap (a 21000-gas transfer; RELAY_MAX_FEE_PER_GAS_GWEI applies).
        let fees = await this.replacementFees(latest, head);
        if (!fees && request.txNonce! >= (await this.nonces()).pending) {
            const market = await this.marketFees(head);
            fees = { maxFeePerGas: market.maxFeePerGas, maxPriorityFeePerGas: market.maxPriorityFeePerGas };
        }
        const now = clock.nowMs();
        if (!fees) {
            store.setPendingFinal(request.id, final, now);
            store.touchAttempt(latest.hash, head.number);
            // The node holds the call: nothing to re-send; the next try is when it is due again.
            this.resend.delete(request.id);
            logger.error({ requestId: request.id }, 'cannot outbid the pending transaction within RELAY_MAX_FEE_PER_GAS_GWEI; waiting');
            return;
        }
        if (!this.reserveGas(request.txNonce!, CANCEL_GAS, fees.maxFeePerGas)) return;
        const raw = await signer.signTransaction(this.cancelTx(request.txNonce!, fees));
        const hash = keccak256(raw);
        store.recordReplacement(request.id, { hash, raw, kind: 'cancel', ...fees, gasLimit: CANCEL_GAS, sentBlock: head.number }, final, now);
        logger.info({ requestId: request.id, txHash: hash, reason: final.error.code }, 'cancelling in-flight transaction');
        await this.send(request, raw, 'cancel');
    }

    private async speedUp(request: RequestRecord, latest: TxAttemptRecord, head: BlockInfo, call: EncodedCall | undefined): Promise<SpeedUpOutcome> {
        const { ctx, signer, store, clock, logger } = this.deps;
        const isCall = latest.kind === 'call' && call !== undefined;
        const callCap = isCall ? await this.callCap(request, latest.gasLimit) : undefined;
        const fees = await this.replacementFees(latest, head, callCap);
        if (!fees) {
            if (callCap !== undefined && (await this.replacementFees(latest, head)) !== undefined) {
                this.txm.spendCapHolds.inc({ kind: 'speedup' });
                logger.warn({ requestId: request.id, spendCapPerGas: callCap }, 'speed-up held at the request spend cap');
                return 'capped';
            }
            return 'at_max';
        }
        const tx: TransactionSerializableEIP1559 = isCall
            ? { type: 'eip1559', chainId: ctx.chainId, nonce: request.txNonce!, to: call.to, data: call.data, value: 0n, gas: latest.gasLimit, ...fees }
            : this.cancelTx(request.txNonce!, fees);
        if (!this.reserveGas(request.txNonce!, isCall ? latest.gasLimit : CANCEL_GAS, fees.maxFeePerGas)) return 'at_max';
        const raw = await signer.signTransaction(tx);
        const hash = keccak256(raw);
        const kind = isCall ? 'call' : 'cancel';
        store.recordReplacement(
            request.id,
            { hash, raw, kind, ...fees, gasLimit: kind === 'cancel' ? CANCEL_GAS : latest.gasLimit, sentBlock: head.number },
            undefined,
            clock.nowMs(),
        );
        logger.info({ requestId: request.id, txHash: hash, maxFeePerGas: fees.maxFeePerGas }, 'speeding up transaction');
        await this.send(request, raw, 'speedup');
        return 'sent';
    }

    private async rebroadcast(request: RequestRecord, latest: TxAttemptRecord): Promise<void> {
        if (!latest.raw) {
            this.resend.delete(request.id);
            return;
        }
        await this.send(request, latest.raw, 'rebroadcast');
    }

    private gasBudgetLimit(): bigint {
        return this.deps.settings.totalGasBudgetWei ?? 10n ** 18n;
    }

    /** Reserve before signing. Exposure is permanent: receipts, pruning, restarts and clock changes cannot refund it. */
    private reserveGas(nonce: number, gas: bigint, maxFeePerGas: bigint): boolean {
        const reserved = this.deps.store.reserveGasExposure(nonce, gas * maxFeePerGas, this.gasBudgetLimit());
        this.txm.gasExposurePol.set(Number(formatEther(this.deps.store.gasExposureWei())));
        if (reserved) return true;
        if (!this.gasBudgetHeld) {
            this.deps.logger.error({ alert: 'gas_budget', totalWei: this.deps.store.gasExposureWei(), limitWei: this.gasBudgetLimit() },
                'ALERT: aggregate gas budget refuses additional exposure; review costs before raising the lifetime ceiling');
        }
        this.gasBudgetHeld = true;
        return false;
    }

    /** Includes restored raw transactions and nonce fillers, not only the request signing paths. */
    private async broadcastWithinBudget(raw: Hex, request?: RequestRecord, fresh = true): Promise<BroadcastOutcome> {
        const tx = parseTransaction(raw);
        if (tx.nonce === undefined || tx.gas === undefined || tx.maxFeePerGas === undefined || (tx.value ?? 0n) !== 0n) {
            throw new Error('cannot account for relay transaction gas exposure');
        }
        if (!this.reserveGas(tx.nonce, tx.gas, tx.maxFeePerGas)) return { kind: 'error', message: 'Aggregate gas budget reached' };
        if (request?.token && tx.data && tx.data !== '0x' && this.deps.tokenImplementations &&
            !(await this.deps.tokenImplementations.checkToken(request.token))) {
            return { kind: 'error', message: 'Token implementation could not be verified' };
        }
        const now = performance.now();
        // The head watch follows new transactions (first sends, replacements, fillers), not re-sends of a stored one.
        if (fresh) this.lastBroadcastMs = now;
        if (request) this.sentAtMs.set(request.id, now);
        return this.deps.ctx.chain.sendRawTransaction(raw);
    }

    /**
     * While the loop runs: this process broadcast a transaction of the request less than RELAY_POLL_INTERVAL_MS ago. A
     * pass that a wake-up or a new block started early does not count that transaction as missing from the mempool
     * sooner than the next pass at the poll would have: an RPC behind a load balancer may not count a transaction sent
     * moments ago in its pending nonce yet.
     */
    private sentRecently(id: string): boolean {
        const sent = this.sentAtMs.get(id);
        return this.running && sent !== undefined && performance.now() - sent < this.deps.settings.pollIntervalMs;
    }

    private async send(request: RequestRecord, raw: Hex, kind: 'cancel' | 'speedup' | 'rebroadcast'): Promise<BroadcastOutcome> {
        const outcome = await this.broadcastWithinBudget(raw, request, kind !== 'rebroadcast');
        this.deps.metrics.txBroadcasts.inc({ kind, outcome: outcome.kind });
        switch (outcome.kind) {
            case 'accepted':
            case 'known':
            case 'nonce_too_low': // not proof: the next reconciliation looks at receipts and the latest nonce
                // A new transaction (a replacement) moved the relay forward; re-sending the same one does not.
                if (outcome.kind !== 'nonce_too_low' && kind !== 'rebroadcast') this.progress();
                this.resend.delete(request.id);
                break;
            case 'insufficient_funds':
                this.lowFunds = true;
                this.resend.add(request.id);
                this.deps.logger.error({ requestId: request.id }, 'ALERT: relay account has insufficient POL');
                break;
            case 'underpriced':
            case 'error':
                this.resend.add(request.id);
                this.deps.logger.warn({ requestId: request.id, outcome: outcome.kind }, 'broadcast not accepted; will retry');
                break;
        }
        return outcome;
    }

    // -----------------------------------------------------------------------------------------
    // Checks before a call leaves the relay
    // -----------------------------------------------------------------------------------------

    /**
     * Simulation (pinned to the head block) and sender check before every broadcast of a call. A revert only
     * fails the request if the simulated state is not older than the request's acceptance, or if it is seen
     * again two blocks later.
     */
    private async preflight(request: RequestRecord, head: BlockInfo, context: string): Promise<Preflight> {
        // What failed for one request of this pass fails for the next ones too: a chain read for all, the implementation
        // check of a token for the requests of that token (the requests of other tokens go on). They wait for the next
        // pass instead of repeating the failing read one after another, which would hold back the cancels of the
        // in-flight requests behind them.
        if (this.passChainReadFailed) return { kind: 'retry', stopPass: true };
        if (this.tokenUnverified(request)) return { kind: 'retry', stopPass: false };
        if (request.token && this.deps.tokenImplementations && !(await this.deps.tokenImplementations.checkToken(request.token))) {
            this.passUnverifiedTokens.add(request.token.toLowerCase());
            return { kind: 'retry', stopPass: false };
        }
        const simulation = await this.simulate(request, head.number);
        if (simulation.kind === 'rpc_error') return this.chainReadFailed();
        if (simulation.kind === 'corrupt') {
            return { kind: 'fail', final: { status: 'failed', error: { code: 'internal_error', message: simulation.message } } };
        }
        if (simulation.kind === 'revert') {
            if (!this.revertIsCurrent(request, head)) return { kind: 'retry', stopPass: false };
            const decoded = `${context}: ${simulation.revert.description}`;
            if (simulation.revert.name === 'InvalidSignature') {
                // The contract verifies the signature over the sender's current nonce first. Once the nonce moved on
                // (another request executed at it, or the sender invalidated it), the request can never execute; while it
                // is below the request's (a reorg removed the sender's request before it), the request waits for it.
                let next: bigint;
                try {
                    next = await readIntentNonce(this.deps.ctx.chain, request.contract, request.signer, head.number);
                } catch (err) {
                    this.deps.logger.warn({ err, requestId: request.id }, 'could not read the intent nonce; will retry');
                    return this.chainReadFailed();
                }
                const nonce = BigInt(request.nonce);
                if (next > nonce) {
                    return {
                        kind: 'fail',
                        final: { status: 'failed', error: { code: 'nonce_used', message: `The intent nonce was used or invalidated before this request executed (${decoded})` } },
                    };
                }
                if (next < nonce) return { kind: 'retry', stopPass: false };
            }
            const attributed = await this.attribute(request);
            return {
                kind: 'fail',
                final: {
                    status: 'failed',
                    error: attributed
                        ? { code: attributed.code, message: `${attributed.message} (${decoded})` }
                        : { code: errorCodeForRevert(simulation.revert), message: decoded },
                },
            };
        }
        this.revertSeen.delete(request.id);
        const hasCode = await this.usdcPermitSenderHasCode(request);
        if (hasCode === undefined) return this.chainReadFailed();
        if (hasCode) {
            return {
                kind: 'fail',
                final: {
                    status: 'failed',
                    error: {
                        code: 'invalid_token_authorization',
                        message: 'The sender has code now (e.g. an EIP-7702 delegation); USDC permits from accounts with code are not relayed',
                    },
                },
            };
        }
        return { kind: 'ok', call: simulation.call };
    }

    /** A chain read of a check before a broadcast failed: no further such check starts in this pass (see preflight). */
    /**
     * The implementation check of the request's token failed in this pass. Its requests wait for the next pass, and
     * the queue skips them before it counts a full check: they must not use up the checks of the other tokens.
     */
    private tokenUnverified(request: RequestRecord): boolean {
        return request.token !== null && this.passUnverifiedTokens.has(request.token.toLowerCase());
    }

    private chainReadFailed(): Preflight {
        this.passChainReadFailed = true;
        return { kind: 'retry', stopPass: true };
    }

    private revertIsCurrent(request: RequestRecord, head: BlockInfo): boolean {
        if (TxManager.atLeastAsNewAs(head, request.createdAtMs)) {
            this.revertSeen.delete(request.id);
            return true;
        }
        const first = this.revertSeen.get(request.id);
        if (first === undefined) {
            this.revertSeen.set(request.id, head.number);
            this.deps.logger.info(
                { requestId: request.id, blockNumber: head.number },
                'simulation reverted on a block older than the acceptance; checking again',
            );
            return false;
        }
        // A first block the relay's client once reported above today's head counts from today's.
        if (head.number < first) {
            this.revertSeen.set(request.id, head.number);
            return false;
        }
        if (head.number - first < 2n) return false;
        this.revertSeen.delete(request.id);
        return true;
    }

    /**
     * A failure caused by a token admin action after acceptance is reported with the pipeline's
     * code (token_paused, blocked_address) instead of the contract error it surfaces as (InsufficientAllowance
     * for a paused permit): the operation's step-6 checks run for this request alone. A token signature of a
     * token whose EIP-712 domain changed on-chain (a rename), or a PERMIT / META_TX_APPROVE signature that no
     * longer matches the token's current nonce (the sender used the token nonce elsewhere after acceptance), is
     * reported as invalid_token_authorization. Before all of them, an intent nonce that is used now (the call of a
     * reverted receipt carries no revert data) is reported as nonce_used.
     */
    private async attribute(request: RequestRecord): Promise<{ code: ErrorCode; message: string } | undefined> {
        const { ctx } = this.deps;
        const restored = this.restored(request);
        if (!restored) return undefined;
        if (await this.intentNonceUsed(request)) {
            return { code: 'nonce_used', message: 'The intent nonce was used or invalidated before this request executed' };
        }
        try {
            await restored.op.onchainChecks.state(ctx, restored.sub, OWN_USAGE);
        } catch (err) {
            if (err instanceof RelayError && (err.code === 'token_paused' || err.code === 'blocked_address')) return { code: err.code, message: err.message };
        }
        const token = request.token !== null ? ctx.tokens.get(request.token.toLowerCase()) : undefined;
        if (token && request.authMode !== 'none') {
            try {
                const separator = await readTokenDomainSeparator(ctx.chain, token.address);
                if (separator.toLowerCase() !== hashDomain(token.domain).toLowerCase()) {
                    return {
                        code: 'invalid_token_authorization',
                        message: `The ${token.symbol} EIP-712 domain changed on-chain after the request was accepted; its token signature can no longer be used`,
                    };
                }
            } catch {
                // not attributable
            }
            try {
                // Step 7 for this request alone: the signature against the token's current nonce.
                await restored.op.onchainChecks.authorization(ctx, restored.sub, OWN_USAGE);
            } catch (err) {
                if (err instanceof RelayError && err.code === 'invalid_token_authorization') {
                    return { code: err.code, message: `The token authorization is no longer valid on-chain: ${err.message}` };
                }
            }
        }
        return undefined;
    }

    /**
     * USDC verifies permits of accounts with code through ERC-1271 (EIP-7702 delegations), where a
     * delegate can burn the relay's gas. The pipeline refuses such senders; this re-checks before every broadcast.
     * undefined if the code cannot be read.
     */
    private async usdcPermitSenderHasCode(request: RequestRecord): Promise<boolean | undefined> {
        const { ctx, logger } = this.deps;
        if (request.authMode !== 'permit' || request.token === null) return false;
        if (ctx.tokens.get(request.token.toLowerCase())?.kind !== 'usdc') return false;
        try {
            const code = await ctx.chain.getCode(request.signer);
            return code !== undefined && code !== '0x';
        } catch (err) {
            logger.warn({ err, requestId: request.id }, 'could not read the sender code; will retry');
            return undefined;
        }
    }

    private async simulate(request: RequestRecord, blockNumber: bigint): Promise<Simulation> {
        const { ctx, registry, signer, logger } = this.deps;
        if (!registry.get(request.operation)) return { kind: 'corrupt', message: `unknown operation ${request.operation}` };
        const restored = this.restored(request);
        if (!restored) return { kind: 'corrupt', message: request.signature && request.authorization ? 'stored request is invalid' : 'request data is missing' };
        let call: EncodedCall;
        try {
            call = restored.op.encodeCall(ctx, restored.sub);
        } catch {
            return { kind: 'corrupt', message: 'stored request is invalid' };
        }
        try {
            // Pinned to the head block: a node that has not imported it errors instead of answering from older state.
            const outcome = await ctx.chain.call({ from: signer.address, to: call.to, data: call.data, blockNumber });
            return outcome.ok ? { kind: 'ok', call } : { kind: 'revert', revert: decodeRevert(outcome.revertData) };
        } catch (err) {
            logger.warn({ err, requestId: request.id }, 'simulation RPC error; will retry');
            return { kind: 'rpc_error' };
        }
    }

    /** Calls of one kind (operation, authorization mode, token) have about the same gas limit. */
    private static callKind(request: RequestRecord): string {
        return `${request.operation}:${request.authMode}:${(request.token ?? '').toLowerCase()}`;
    }

    /**
     * Estimate (pinned) plus margin, capped by the gas table and RELAY_MAX_GAS_LIMIT (policy.callGasLimit).
     * `estimated` is false when the estimate failed and the gas limit is the gas table's fallback.
     */
    private async gasLimit(request: RequestRecord, call: EncodedCall, blockNumber: bigint): Promise<GasLimitDecision & { readonly estimated: boolean }> {
        const { ctx, signer, fees, settings, logger } = this.deps;
        let table: bigint | undefined;
        try {
            table = fees.gasUnits(request.operation, request.authMode);
        } catch {
            logger.error({ operation: request.operation, mode: request.authMode }, 'no gas table entry');
        }
        let estimate: bigint | undefined;
        try {
            estimate = await ctx.chain.estimateGas({ from: signer.address, to: call.to, data: call.data, blockNumber });
        } catch (err) {
            logger.warn({ err, requestId: request.id }, 'gas estimation failed; using the gas table');
        }
        const decision = callGasLimit({ estimate, table, maxGasLimit: settings.maxGasLimit, marginPercent: settings.gasLimitMarginPercent });
        return { ...decision, estimated: estimate !== undefined };
    }

    private async price(): Promise<PriceReading> {
        return this.deps.priceSource ? this.deps.priceSource.get() : (await this.deps.fees.context()).price;
    }

    /** The request's spend cap for a call with `gasLimit` (policy.spendCapPerGas), at the current POL/USD price. */
    private async callCap(request: RequestRecord, gasLimit: bigint): Promise<bigint> {
        return spendCapPerGas(request.fee, await this.price(), gasLimit, this.policy.maxCostPercentOfFee);
    }

    // -----------------------------------------------------------------------------------------
    // Nonces
    // -----------------------------------------------------------------------------------------

    /**
     * Keeps the relay's nonce range free of unused nonces:
     * - nonces at the top of the range that no transaction uses any more (for example untracked pending
     *   transactions adopted at startup that the node then evicted) are re-used by lowering the next nonce;
     * - nonces below the lowest in-flight relay transaction that no relay transaction uses hold every later
     *   transaction back; if the chain's latest nonce stays below the lowest in-flight nonce for
     *   RELAY_NONCE_GAP_BLOCKS, they are filled with 0-value self-transfers.
     * The relay's own client shows whether there is anything to do (and the `nonce_gap` health entry follows it).
     * Changing the range needs every configured RPC to answer: the next nonce is
     * lowered only to where no RPC holds or has used a transaction of the key (the highest `latest` and `pending`
     * counts), and gap fillers are signed only for nonces at or above the highest `latest` count, at most
     * RELAY_MAX_IN_FLIGHT of them per pass (so the work and the cost of a pass do not depend on what an RPC reports).
     * The tx nonces of provisional outcomes count as used by the relay: a reorg can put such a request back in
     * flight at its nonce, so its nonce is neither re-used nor filled.
     * Gap fillers are kept in memory only: after a restart the same analysis finds and fills the gap again.
     */
    private async manageNonces(view: TickView): Promise<void> {
        const { store, settings, logger } = this.deps;
        const next = store.getNextNonce();
        if (next === undefined) return;
        const submitted = store.listByStatus('submitted');
        if (submitted.length === 0 && this.fillers.size === 0 && this.lastNonces !== undefined && next <= this.lastNonces.latest) {
            this.gap = undefined;
            return;
        }
        const nonces = await this.nonces();
        await this.resolveFillers(view.head, nonces);
        const fillers = new Set<number>(this.fillers.keys());
        const tracked = new Set<number>(fillers);
        for (const request of [...submitted, ...store.listUnsettled()]) if (request.txNonce !== null) tracked.add(request.txNonce);
        // The relay client's view: is there anything to do? (One missing nonce is enough to tell.)
        const own = analyzeNonces({ ...nonces, next, tracked, fillers }, 1);
        if (own.missing.length === 0 || own.lowestInFlight === undefined) {
            this.gap = undefined;
        } else if (!this.gap || this.gap.lowest !== own.lowestInFlight || (this.gap.latest !== nonces.latest && !this.gap.filling)) {
            this.gap = { latest: nonces.latest, lowest: own.lowestInFlight, sinceBlock: view.head.number, filling: false };
        } else {
            // While the relay fills the gap, its own fillers move the chain nonce: that does not start the wait again.
            this.gap.latest = nonces.latest;
            // A first block the relay's client once reported above today's head counts from today's.
            if (view.head.number < this.gap.sinceBlock) this.gap.sinceBlock = view.head.number;
        }
        const fillDue = this.gap !== undefined && view.head.number - this.gap.sinceBlock >= BigInt(this.policy.nonceGapBlocks);
        if (own.lowerNextTo === undefined && !fillDue) return;
        const every = await this.everyRpcNonces();
        if (!every) return; // not every RPC answered: the range stays as it is (the RPC is reported by ask())
        const { highestLatest, highestPending } = combineNonces(every);
        const all = analyzeNonces({ latest: highestLatest, pending: highestPending, next, tracked, fillers }, settings.maxInFlight);
        if (own.lowerNextTo !== undefined && all.lowerNextTo !== undefined) {
            logger.warn(
                { next, lowerTo: all.lowerNextTo, latest: highestLatest, pending: highestPending },
                'no transaction uses the nonces at the top of the relay range any more; re-using them',
            );
            store.setNextNonce(all.lowerNextTo);
            this.txm.nonceEvents.inc({ event: 'next_nonce_lowered' });
        }
        if (!fillDue || this.gap === undefined || all.missing.length === 0) return;
        this.gap.filling = true;
        for (const nonce of all.missing) await this.fill(nonce, view.head);
    }

    private async fill(nonce: number, head: BlockInfo): Promise<void> {
        const { signer, logger, metrics } = this.deps;
        if (this.fillers.has(nonce)) return;
        const market = await this.marketFees(head);
        if (!market.affordable) return;
        const fees: Fees = { maxFeePerGas: market.maxFeePerGas, maxPriorityFeePerGas: market.maxPriorityFeePerGas };
        if (!this.reserveGas(nonce, CANCEL_GAS, fees.maxFeePerGas)) return;
        const raw = await signer.signTransaction(this.cancelTx(nonce, fees));
        const hash = keccak256(raw);
        this.fillers.set(nonce, { nonce, hash, raw, ...fees, sentBlock: head.number });
        this.txm.nonceEvents.inc({ event: 'gap_filled' });
        logger.warn({ txNonce: nonce, txHash: hash }, 'ALERT: filling an unused relay nonce with a 0-value self-transfer');
        const outcome = await this.broadcastWithinBudget(raw);
        metrics.txBroadcasts.inc({ kind: 'filler', outcome: outcome.kind });
        if (outcome.kind === 'accepted' || outcome.kind === 'known') this.progress();
        if (outcome.kind === 'insufficient_funds') this.lowFunds = true;
    }

    private async resolveFillers(head: BlockInfo, nonces: Nonces): Promise<void> {
        const { ctx, signer, settings, logger, metrics } = this.deps;
        for (const [nonce, stored] of [...this.fillers]) {
            if (nonces.latest > nonce) {
                this.fillers.delete(nonce);
                const receipt = await receiptFor(ctx.chain, stored.hash).catch(() => null);
                if (receipt) this.recordGasCost('filler', receipt);
                logger.info({ txNonce: nonce, txHash: stored.hash, ours: receipt !== null }, 'relay nonce gap filled');
                continue;
            }
            // A sent block the relay's client once reported above today's head counts from today's (see sentBlockOf).
            const filler = stored.sentBlock > head.number ? { ...stored, sentBlock: head.number } : stored;
            if (filler !== stored) this.fillers.set(nonce, filler);
            let raw = filler.raw;
            let kind: 'rebroadcast' | 'speedup' = 'rebroadcast';
            // Like a request's transaction, a filler is sped up only at the next nonce the chain can include: behind a
            // lower one no fee gets it included first (see processSubmitted). Its sent block stays as it is meanwhile.
            if (nonce === nonces.latest && head.number - filler.sentBlock >= BigInt(settings.speedUpAfterBlocks)) {
                const fees = await this.replacementFees(filler, head);
                if (fees) {
                    if (!this.reserveGas(nonce, CANCEL_GAS, fees.maxFeePerGas)) continue;
                    raw = await signer.signTransaction(this.cancelTx(nonce, fees));
                    this.fillers.set(nonce, { nonce, hash: keccak256(raw), raw, ...fees, sentBlock: head.number });
                    kind = 'speedup';
                } else {
                    this.fillers.set(nonce, { ...filler, sentBlock: head.number });
                }
            } else if (nonces.pending > nonce) {
                continue; // in the node's pool
            }
            const outcome = await this.broadcastWithinBudget(raw, undefined, kind === 'speedup');
            metrics.txBroadcasts.inc({ kind: `filler_${kind}`, outcome: outcome.kind });
            if (kind === 'speedup' && (outcome.kind === 'accepted' || outcome.kind === 'known')) this.progress();
            if (outcome.kind === 'insufficient_funds') this.lowFunds = true;
        }
    }

    // -----------------------------------------------------------------------------------------
    // New broadcasts
    // -----------------------------------------------------------------------------------------

    /**
     * Sends queued requests while in-flight slots are free. Order: priority first, then round-robin
     * across senders (policy.fairOrder), so that one sender's backlog cannot starve the others. a request
     * whose spend cap is below base fee + RELAY_MIN_TIP_GWEI at the gas limit the relay would use is held without any
     * RPC call (precheck), and at most PREFLIGHTS_PER_SLOT × RELAY_MAX_IN_FLIGHT requests get a full check (simulation
     * and gas estimate) per pass: the cost of a pass does not grow with the number of held requests. A request that
     * ends in its check counts as progress.
     *
     * Phase 1 sends, in that order, until the first request without a free slot. Phase 2 spends the rest of the pass's
     * budget on full checks that only find out what the pre-check cannot, without a broadcast
     * (learnQueued).
     */
    private async broadcastQueued(view: TickView): Promise<void> {
        const { store, settings, logger } = this.deps;
        const { head } = view;
        if (!this.recovered || this.lowFunds || this.staleHeadSeconds !== undefined) return;
        // No await before this line: runTick relies on it (wakeWanted).
        const queued = store.listByStatus('queued');
        if (queued.length === 0) return;
        const market = await this.marketFees(head);
        if (!market.affordable) {
            logger.warn({ baseFee: head.baseFeePerGas }, 'gas price above RELAY_MAX_FEE_PER_GAS_GWEI; holding queued requests');
            return;
        }
        // Transactions of the key that the relay does not track are pending above its next nonce: do not
        // collide with them (the same rule as at startup; manageNonces re-uses the nonces if they vanish).
        const nonces = await this.nonces();
        const next = store.getNextNonce();
        if (next !== undefined && nonces.pending > next) {
            logger.warn({ next, pending: nonces.pending }, 'untracked transactions of the relay key are pending; skipping their nonces');
            store.setNextNonce(nonces.pending);
        }
        const slots = this.slots();
        let inFlight = slots.inFlight;
        const includable = (head.baseFeePerGas ?? 0n) + settings.minTip;
        const price = await this.price();
        const order = fairOrder(queued, slots.perSender);
        // one full check of the budget stays for phase 2 while a request waits for its check again after a
        // check without an estimate, so those checks go round even while phase 1 uses the budget.
        const reserve = order.some((r) => this.recheckDue(r, includable, price)) ? 1 : 0;
        for (const request of order) {
            // held at the gas limit the relay would use, without an RPC call (precheckQueued did the same at
            // the start of the pass, for every queued request). Only a request that may fit its cap is checked here.
            const pre = this.precheck(request, includable, price);
            if (pre.kind === 'held') {
                this.holdQueued(request, pre.cap, head);
                continue;
            }
            if (this.tokenUnverified(request)) continue;
            // The order is by priority first, so no request after the first one without a free slot has one.
            if (inFlight >= this.slotLimit(request.priority)) break;
            if (this.passChecks >= this.maxChecks() - reserve) break;
            this.passChecks += 1;
            const check = await this.checkQueued(request, head, market, price);
            if (check.kind === 'retry') {
                if (check.stopPass) return;
                continue;
            }
            if (check.kind !== 'fits') continue;
            const sent = await this.sendQueued(request, check, head);
            if (sent === 'stop') return;
            if (sent === 'sent') inFlight += 1;
        }
        await this.learnQueued(head, market, price);
    }

    /** In-flight slots in use, and per sender. A request whose tx nonce the chain already used holds none. */
    private slots(): { inFlight: number; perSender: Map<string, number> } {
        // Slots are held by transactions in flight. A request whose tx nonce the chain already used (it waits
        // for its receipt or for a decision) has no transaction in the pool and holds none.
        let inFlight = 0;
        const perSender = new Map<string, number>();
        for (const request of this.deps.store.listByStatus('submitted')) {
            if (this.unknownNonce.has(request.id)) continue;
            inFlight += 1;
            const sender = request.signer.toLowerCase();
            perSender.set(sender, (perSender.get(sender) ?? 0) + 1);
        }
        return { inFlight, perSender };
    }

    /** In-flight slots a request of this priority may use: higher priorities also get the reserved ones. */
    private slotLimit(priority: number): number {
        const { settings } = this.deps;
        return priority > PRIORITY_NORMAL ? settings.maxInFlight : settings.maxInFlight - settings.reservedPrioritySlots;
    }

    /** Full checks of queued requests per pass. */
    private maxChecks(): number {
        return PREFLIGHTS_PER_SLOT * this.deps.settings.maxInFlight;
    }

    /**
     * The full check of a queued request at the pass's head (the caller counts it against the pass's budget): the
     * checks before a broadcast (preflight), then the gas limit (the estimate plus margin, capped by the gas table) and
     * the spend cap at that gas limit. Only a successful estimate becomes the known gas limit of the request and of its
     * kind. A request that fails ends in the queue (counted as progress; and the cool-down of its
     * sender if the sender caused it).
     */
    private async checkQueued(request: RequestRecord, head: BlockInfo, market: Fees, price: PriceReading): Promise<QueuedCheck> {
        const { logger, store } = this.deps;
        // It may have ended since the pass listed the queue (it gave way in a full queue).
        if (store.getRequest(request.id)?.status !== 'queued') return { kind: 'ended' };
        this.passTried.add(request.id);
        const check = await this.preflight(request, head, 'simulation before broadcast failed');
        // Not decided: the request counts as not checked yet (learnQueued tries again first).
        if (check.kind === 'retry') return check;
        if (check.kind === 'fail') {
            await this.failedBeforeBroadcast(request, check.final, head);
            return { kind: 'ended' };
        }
        this.lastCheck.set(request.id, this.passNumber);
        const gas = await this.gasLimit(request, check.call, head.number);
        if (!gas.ok) {
            const final: FinalFailure = {
                status: 'failed',
                error: { code: 'simulation_failed', message: `The call needs ${gas.needed} gas, more than the relay's gas table allows (${gas.cap})` },
            };
            if (this.endInQueue(request, final, head)) {
                this.progress();
                logger.warn({ requestId: request.id, needed: gas.needed, cap: gas.cap }, 'request failed before broadcast: gas above the gas table');
            }
            return { kind: 'ended' };
        }
        if (gas.estimated) {
            this.checkedGas.set(request.id, gas.gas);
            const kind = TxManager.callKind(request);
            this.minGasByKind.set(kind, minBig(this.minGasByKind.get(kind) ?? gas.gas, gas.gas));
        } else {
            // the gas table's fallback is not a known gas limit. If the cap holds the request there, it is
            // held (the relay would send it at that gas limit now) and checked in full again in turn (learnQueued).
            this.checkedGas.delete(request.id);
        }
        // The spend cap at the call's own gas limit: gas limit × maxFeePerGas ≤ RELAY_MAX_COST_PERCENT_OF_FEE of the fee.
        const includable = (head.baseFeePerGas ?? 0n) + this.deps.settings.minTip;
        const cap = spendCapPerGas(request.fee, price, gas.gas, this.policy.maxCostPercentOfFee);
        const maxFeePerGas = minBig(market.maxFeePerGas, cap);
        if (maxFeePerGas < includable) {
            this.holdQueued(request, cap, head);
            return { kind: 'held' };
        }
        this.capHeld.delete(request.id);
        return { kind: 'fits', call: check.call, gas: gas.gas, fees: { maxFeePerGas, maxPriorityFeePerGas: minBig(market.maxPriorityFeePerGas, maxFeePerGas) } };
    }

    /**
     * Signs and sends the first transaction of a queued request that its check found ready. 'skipped' if the request left
     * the queue meanwhile; 'stop' when the pass must not send anything more.
     */
    private async sendQueued(request: RequestRecord, ready: Extract<QueuedCheck, { kind: 'fits' }>, head: BlockInfo): Promise<'sent' | 'skipped' | 'stop'> {
        const { ctx, signer, store, clock, logger, metrics } = this.deps;
        const { fees } = ready;
        const txNonce = store.getNextNonce();
        if (txNonce === undefined) throw new Error('tx nonce is not initialized');
        // The margin to the deadline was tested against the head of this pass (expireQueued), and a pass can last
        // longer than the margin. By the relay's clock the call must still have it, or it would be sent to revert at
        // its deadline: it stays queued, and the next pass ends it at its head.
        if (BigInt(nowSeconds(clock) + this.minSecondsToBroadcast) >= request.deadline) return 'skipped';
        if (!this.reserveGas(txNonce, ready.gas, fees.maxFeePerGas)) return 'stop';
        const raw = await signer.signTransaction({
            type: 'eip1559',
            chainId: ctx.chainId,
            nonce: txNonce,
            to: ready.call.to,
            data: ready.call.data,
            value: 0n,
            gas: ready.gas,
            ...fees,
        });
        const hash = keccak256(raw);
        // a held request may have given way to a new request in a full queue since this pass listed the
        // queue (Store.insertRequest). Checked right before the synchronous insert of the attempt, so nothing can
        // change in between: its outcome is final, and it is never sent.
        if (store.getRequest(request.id)?.status !== 'queued') return 'skipped';
        // Persist the signed transaction before it leaves the process.
        store.recordFirstAttempt(request.id, txNonce, { hash, raw, kind: 'call', ...fees, gasLimit: ready.gas, sentBlock: head.number }, clock.nowMs());
        metrics.requestStatus.inc({ operation: request.operation, status: 'submitted' });
        const outcome = await this.broadcastWithinBudget(raw, request);
        metrics.txBroadcasts.inc({ kind: 'initial', outcome: outcome.kind });
        if (outcome.kind === 'accepted' || outcome.kind === 'known') this.progress();
        if (outcome.kind === 'nonce_too_low') {
            // Not proof that the nonce is used (a lying or lagging RPC, or a gateway that retried a
            // broadcast the node already took): the attempt stays, and the next passes decide from receipts,
            // the latest nonce and the request's intent nonce (reconcileSubmitted). Stop this pass.
            this.txm.nonceEvents.inc({ event: 'nonce_too_low' });
            logger.warn({ requestId: request.id, txHash: hash, txNonce }, 'initial broadcast answered "nonce too low"; keeping the transaction and checking');
            return 'stop';
        } else if (outcome.kind === 'insufficient_funds') {
            this.lowFunds = true;
            this.resend.add(request.id);
            logger.error({ requestId: request.id }, 'ALERT: relay account has insufficient POL');
            return 'stop';
        } else if (outcome.kind === 'underpriced' || outcome.kind === 'error') {
            this.resend.add(request.id);
            logger.warn({ requestId: request.id, outcome: outcome.kind }, 'initial broadcast not accepted; will retry');
        }
        logger.info({ requestId: request.id, txHash: hash, txNonce }, 'transaction broadcast');
        return 'sent';
    }

    /**
     * Phase 2 of broadcastQueued: full checks, with the rest of the pass's budget, of requests
     * that phase 1 did not reach, whatever the free slots; nothing is sent here (a request found ready is sent by phase 1
     * of a later pass, once a slot is free). First the requests never checked in full, in the send order, unless the
     * pre-check holds them at an estimated gas limit: after a restart, or for the first request of a kind of call, this
     * finds out which requests are held (for a full queue, "others wait" and `stalled`) without waiting for a free slot,
     * and a request that can no longer be sent ends early. Then the requests held after a check without an estimate, the
     * longest since their last check first: each is checked again in turn, and the budget reaches every request.
     */
    private async learnQueued(head: BlockInfo, market: Fees, price: PriceReading): Promise<void> {
        const includable = (head.baseFeePerGas ?? 0n) + this.deps.settings.minTip;
        const order = fairOrder(this.deps.store.listByStatus('queued'), this.slots().perSender);
        const candidates = order
            .filter((r) => !this.passTried.has(r.id) && (!this.lastCheck.has(r.id) || this.recheckDue(r, includable, price)))
            .sort((a, b) => (this.lastCheck.get(a.id) ?? -1) - (this.lastCheck.get(b.id) ?? -1));
        for (const request of candidates) {
            // Again: an earlier check of this pass may have found the gas limit of its kind.
            const pre = this.precheck(request, includable, price);
            if (pre.kind === 'held' && pre.estimated) {
                this.holdQueued(request, pre.cap, head);
                continue;
            }
            if (this.tokenUnverified(request)) continue;
            if (this.passChecks >= this.maxChecks()) return;
            this.passChecks += 1;
            const check = await this.checkQueued(request, head, market, price);
            if (check.kind === 'retry' && check.stopPass) return;
        }
    }

    /**
     * The request is held after a check without an estimate in an earlier pass: it is checked in full again in turn
     * (learnQueued).
     */
    private recheckDue(request: RequestRecord, includable: bigint, price: PriceReading): boolean {
        if ((this.lastCheck.get(request.id) ?? this.passNumber) >= this.passNumber) return false;
        const pre = this.precheck(request, includable, price);
        return pre.kind === 'held' && !pre.estimated;
    }

    /**
     * The spend cap of a queued request without any RPC call (see
     * Precheck). The gas limit is one the relay knows from a successful estimate: the request's own last full check, or
     * else the smallest gas limit computed for its kind of call (the most favourable one); without one, the gas table's
     * entry (the largest the relay would use). The request is held while even the cheapest includable fee (base fee +
     * RELAY_MIN_TIP_GWEI) is above its cap.
     */
    private precheck(request: RequestRecord, includable: bigint, price: PriceReading): Precheck {
        const known = this.checkedGas.get(request.id) ?? this.minGasByKind.get(TxManager.callKind(request));
        if (known !== undefined) {
            const cap = spendCapPerGas(request.fee, price, known, this.policy.maxCostPercentOfFee);
            return cap < includable ? { kind: 'held', cap, estimated: true } : { kind: 'fits' };
        }
        const cap = spendCapPerGas(request.fee, price, this.tableGas(request), this.policy.maxCostPercentOfFee);
        if (cap >= includable) return { kind: 'fits' };
        // Checked before, without an estimate: the relay would send it at the gas table's entry now.
        if (this.lastCheck.has(request.id)) return { kind: 'held', cap, estimated: false };
        return { kind: 'unknown' };
    }

    /** The gas limit of a call without an estimate: the gas table's entry, capped by RELAY_MAX_GAS_LIMIT (policy.callGasLimit). */
    private tableGas(request: RequestRecord): bigint {
        const { fees, settings } = this.deps;
        let table: bigint | undefined;
        try {
            table = fees.gasUnits(request.operation, request.authMode);
        } catch {
            // no entry: RELAY_MAX_GAS_LIMIT
        }
        const decision = callGasLimit({ estimate: undefined, table, maxGasLimit: settings.maxGasLimit, marginPercent: settings.gasLimitMarginPercent });
        return decision.ok ? decision.gas : settings.maxGasLimit;
    }

    /**
     * The spend-cap pre-check of every queued request, at the start of every pass and without an RPC call
     * per request, also for the requests beyond the free in-flight slots, which the sending phase of broadcastQueued
     * does not reach. So capHeld says which queued requests their caps hold now: `stalled` and `held_at_cap`
     * (updateGauges) and the place a new request may take in a full queue (heldInQueue) judge the queue as it is. A
     * request never checked whose gas limit is not known (`unknown`) is not known to be held; the full checks of the
     * passes find out (queuedCanGo, learnQueued).
     */
    private async precheckQueued(head: BlockInfo): Promise<void> {
        const queued = this.deps.store.listByStatus('queued');
        const live = new Set<string>(queued.map((r) => r.id));
        for (const id of [...this.capHeld.keys()]) if (!live.has(id)) this.capHeld.delete(id);
        for (const id of [...this.checkedGas.keys()]) if (!live.has(id)) this.checkedGas.delete(id);
        for (const id of [...this.lastCheck.keys()]) if (!live.has(id)) this.lastCheck.delete(id);
        if (queued.length === 0) return;
        const includable = (head.baseFeePerGas ?? 0n) + this.deps.settings.minTip;
        const price = await this.price();
        for (const request of queued) {
            const pre = this.precheck(request, includable, price);
            if (pre.kind === 'held') this.holdQueued(request, pre.cap, head);
            else this.capHeld.delete(request.id);
        }
    }

    /** A queued request waits for gas prices to fall below its spend cap (or for its deadline); logged once. */
    private holdQueued(request: RequestRecord, cap: bigint, head: BlockInfo): void {
        const already = this.capHeld.has(request.id);
        this.capHeld.set(request.id, cap);
        if (already) return;
        this.txm.spendCapHolds.inc({ kind: 'initial' });
        this.deps.logger.warn({ requestId: request.id, spendCapPerGas: cap, baseFee: head.baseFeePerGas }, 'gas price above the request spend cap; holding it');
    }

    /**
     * A queued request failed its check before the broadcast. That counts as progress for `stalled`: the
     * relay dealt with it. If its sender caused the failure, the sender goes on a cool-down.
     */
    private async failedBeforeBroadcast(request: RequestRecord, final: FinalFailure, head: BlockInfo): Promise<void> {
        const sender = await this.senderCaused(request, final, head.number);
        if (!this.endInQueue(request, final, head)) return;
        this.progress();
        this.deps.logger.info({ requestId: request.id, code: final.error.code, senderCaused: sender }, 'request failed before broadcast');
        if (sender) this.deps.onSenderFailure?.(request.id);
    }

    /**
     * Whether the sender of a queued request caused the failure of its check before the broadcast: its intent nonce
     * was used (it invalidated it, or another request of it executed), it lowered its allowance, used its token nonce
     * elsewhere or gave its account code (its token
     * authorization no longer works), or moved its funds away. A token admin's action (a pause, a block list, a
     * rename), a cause on the relay's side, or an answer that cannot be read is not the sender's; nor is the failure
     * of a request that was broadcast before (requeued), whose own earlier transactions are involved. The token reads
     * are pinned to `blockNumber`, the block whose state the failed simulation saw: a sender that moves its funds back
     * in the next block does not escape the cool-down, and a lagging node cannot blame it for older state.
     */
    private async senderCaused(request: RequestRecord, final: FinalFailure, blockNumber: bigint): Promise<boolean> {
        const { ctx, store } = this.deps;
        if (store.listAttempts(request.id).length > 0) return false;
        const code = final.error.code;
        if (SENDER_FAILURE_CODES.has(code)) return true;
        const token = request.token !== null ? ctx.tokens.get(request.token.toLowerCase()) : undefined;
        if (!token) return false;
        const pinned = readsAt(ctx.chain, blockNumber);
        try {
            if (code === 'invalid_token_authorization') {
                // The token signature no longer works, unless the token's EIP-712 domain changed (a rename by its admin).
                const separator = await readTokenDomainSeparator(pinned, token.address);
                return separator.toLowerCase() === hashDomain(token.domain).toLowerCase();
            }
            if (code === 'simulation_failed' && request.debit !== null) {
                // The token transfer reverts because the sender's balance no longer covers amount + fee.
                return (await readBalanceOf(pinned, token.address, request.signer)) < request.debit;
            }
        } catch {
            // not readable: not the sender's
        }
        return false;
    }

    /**
     * A queued request ends (failed or expired); false if it is not queued any more. If nothing of it was ever
     * broadcast, the outcome is final at once and the secrets are purged. A requeued request's earlier transactions
     * lost their nonce to another transaction on the current chain; until that is final a reorg could still include
     * one of them, so its outcome stays provisional (reconcileResolved keeps looking for their receipts).
     */
    private endInQueue(request: RequestRecord, final: FinalFailure, head: BlockInfo): boolean {
        const { store, clock, metrics } = this.deps;
        this.capHeld.delete(request.id);
        this.checkedGas.delete(request.id);
        this.lastCheck.delete(request.id);
        this.revertSeen.delete(request.id);
        // a request that gave way to a new one in a full queue (Store.insertRequest) while this pass waited
        // for the chain has its final outcome already, and a final outcome never changes. Checked synchronously with
        // the update below.
        if (store.getRequest(request.id)?.status !== 'queued') return false;
        if (store.listAttempts(request.id).length > 0) {
            store.resolveFailed(request.id, final, { kind: 'foreign', block: head.number }, clock.nowMs());
        } else {
            store.finalize(request.id, final, undefined, clock.nowMs());
        }
        metrics.requestStatus.inc({ operation: request.operation, status: final.status });
        return true;
    }

    // -----------------------------------------------------------------------------------------
    // Retention, gauges and health
    // -----------------------------------------------------------------------------------------

    /**
     * Settled requests are deleted after RELAY_REQUEST_RETENTION_DAYS (settled_at is wall-clock time). The
     * interval between two runs is measured on the monotonic clock, so a backward step of the wall clock does not
     * pause retention.
     */
    private prune(): void {
        const { store, clock, logger } = this.deps;
        const mono = monotonicMs(clock);
        if (this.lastPruneMonoMs !== undefined && mono - this.lastPruneMonoMs < PRUNE_INTERVAL_MS) return;
        this.lastPruneMonoMs = mono;
        const deleted = store.pruneSettled(clock.nowMs() - this.policy.requestRetentionMs);
        if (deleted > 0) {
            this.txm.requestsPruned.inc(deleted);
            logger.info({ deleted }, 'deleted settled requests after the retention period');
        }
    }

    private async updateGauges(view: TickView): Promise<void> {
        const { ctx, signer, store, metrics } = this.deps;
        const { head } = view;
        const submitted = store.listByStatus('submitted');
        const queued = store.listByStatus('queued');
        const live = new Set([...submitted, ...queued, ...store.listUnsettled()].map((r) => r.id as string));
        for (const key of [...this.waits.keys()]) if (!live.has(key.slice(0, key.indexOf(':')))) this.waits.delete(key);
        for (const id of [...this.revertSeen.keys()]) if (!live.has(id)) this.revertSeen.delete(id);
        for (const id of [...this.queuedSince.keys()]) if (!queued.some((r) => r.id === id)) this.queuedSince.delete(id);
        for (const r of queued) {
            // A first block the relay's client once reported above today's head counts from today's (otherwise the
            // request would never show in `backlog`).
            const since = this.queuedSince.get(r.id);
            if (since === undefined || since > head.number) this.queuedSince.set(r.id, head.number);
        }

        metrics.queueDepth.set(queued.length);
        metrics.txInFlight.set(submitted.length);
        this.txm.requestRows.set(store.countRequests());
        this.txm.finalityLag.set(view.finalizedTag !== undefined ? Number(head.number - view.finalizedTag) : -1);
        this.txm.nonceGap.set(this.gap ? 1 : 0);

        const reasons: string[] = [];
        const degraded: string[] = [];
        if (this.staleHeadSeconds !== undefined) {
            reasons.push(`head_stale: the head block ${head.number} of the relay's RPC is ${this.staleHeadSeconds} s old`);
        }
        const stuckAfter = BigInt(this.policy.stuckAfterBlocks);
        const gapAge = this.gap ? head.number - this.gap.sinceBlock : undefined;
        if (this.gap && gapAge !== undefined && gapAge >= BigInt(this.policy.nonceGapBlocks)) {
            reasons.push(`nonce_gap: the chain nonce ${this.gap.latest} is below the lowest in-flight relay nonce ${this.gap.lowest} for ${gapAge} blocks`);
        }
        // Work the relay should be moving: queued requests not held by their spend cap, and requests in flight
        // that are neither held at their cap nor waiting for a decision about a used tx nonce.
        const sendable = queued.filter((r) => !this.capHeld.has(r.id));
        const moving = submitted.filter((r) => !this.heldAtCap.has(r.id) && !this.unknownNonce.has(r.id));
        const work = sendable.length > 0 || moving.length > 0;
        // A progress block the relay's client once reported above today's head counts from today's: `stalled` would
        // never fire otherwise.
        if (this.progressBlock !== undefined && this.progressBlock > head.number) this.progressBlock = head.number;
        if (work && (!this.hadWork || this.progressBlock === undefined)) this.progressBlock = head.number;
        this.hadWork = work;
        if (work && this.progressBlock !== undefined && head.number - this.progressBlock >= stuckAfter) {
            reasons.push(
                `stalled: ${sendable.length} queued and ${moving.length} in-flight requests wait, but no relay transaction was broadcast, sped up or included for ${head.number - this.progressBlock} blocks`,
            );
        }
        if (view.finalizedTag !== undefined && head.number - view.finalizedTag > BigInt(this.policy.maxFinalityLagBlocks)) {
            reasons.push(`finality_lag: the finalized block is ${head.number - view.finalizedTag} blocks behind head`);
        }
        let oldest: bigint | undefined;
        for (const r of sendable) {
            const since = this.queuedSince.get(r.id);
            if (since !== undefined && (oldest === undefined || since < oldest)) oldest = since;
        }
        const backlog = oldest === undefined ? 0n : head.number - oldest;
        this.txm.backlogBlocks.set(Number(backlog));
        if (backlog > stuckAfter) degraded.push(`backlog: the oldest queued request that can be sent has waited ${backlog} blocks`);
        const held = queued.filter((r) => this.capHeld.has(r.id)).length + submitted.filter((r) => this.heldAtCap.has(r.id)).length;
        this.txm.spendCapHeld.set(held);
        if (held > 0) degraded.push(`held_at_cap: ${held} request(s) wait because gas prices are above what their fees cover (spend cap)`);
        if (this.settleBacklog) degraded.push(this.settleBacklog);
        this.healthReasons = reasons;
        this.healthDegraded = degraded;
        try {
            metrics.polBalance.set(Number(formatEther(await ctx.chain.getBalance(signer.address))));
        } catch {
            // reported by /readyz
        }
    }
}
