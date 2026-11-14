import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Address, Hex } from 'viem';
import type { AuthModeName, DecimalString } from '@nimiq/gasless-sdk/core';
import type { ErrorCode, OperationName, RequestStatus } from '@nimiq/gasless-sdk/relay';
import { MIGRATIONS, migrate, type Migration } from './migrations.js';
import type {
    AdmissionCounts,
    AttemptKind,
    AttemptStatus,
    EvictionCandidate,
    FinalFailure,
    InsertGuards,
    InsertOutcome,
    MinedInfo,
    NewAttempt,
    NewRequest,
    OnChainResolution,
    RequestRecord,
    Store,
    StoredAuthorization,
    StoredError,
    TokenUsage,
    TxAttemptRecord,
} from './types.js';

interface RequestRow {
    id: string;
    operation: string;
    contract: string;
    signer: string;
    nonce: string;
    fingerprint: string;
    request_json: string;
    auth_hash: string;
    signature: string | null;
    auth_json: string | null;
    auth_mode: string;
    token: string | null;
    spender: string | null;
    debit: string | null;
    fee: string;
    deadline: string;
    priority: number;
    status: string;
    tx_nonce: number | null;
    final_tx_hash: string | null;
    block_number: string | null;
    error_code: string | null;
    error_message: string | null;
    pending_final_status: string | null;
    pending_error_code: string | null;
    pending_error_message: string | null;
    created_at: number;
    updated_at: number;
    submitted_at: number | null;
    mined_at: number | null;
    confirmed_at: number | null;
    resolved_tx_hash: string | null;
    resolved_block: string | null;
    settled_at: number | null;
    reopened_at: number | null;
}

interface AttemptRow {
    hash: string;
    request_id: string;
    seq: number;
    tx_nonce: number;
    kind: string;
    max_fee_per_gas: string;
    max_priority_fee_per_gas: string;
    gas_limit: string;
    raw: string | null;
    status: string;
    sent_block: string;
    created_at: number;
    mined_block: string | null;
    gas_used: string | null;
    effective_gas_price: string | null;
}

const PENDING_STATUSES = "('queued', 'submitted')";
const TERMINAL_STATUSES = "('confirmed', 'failed', 'expired')";
/** The requests that hold their intent nonce (migration 6, requests_nonce_holder). */
const HOLDS_NONCE = "(settled_at IS NULL OR status NOT IN ('failed', 'expired'))";
/** How long after its deadline the outcome of a request stays readable in any case (see dropUnsentHistory). */
const UNSENT_HISTORY_KEPT_SECONDS = 3600;

function toRequestRecord(row: RequestRow): RequestRecord {
    const error: StoredError | null =
        row.error_code !== null ? { code: row.error_code as ErrorCode, message: row.error_message ?? '' } : null;
    const pendingFinal: FinalFailure | null =
        row.pending_final_status !== null
            ? {
                  status: row.pending_final_status as 'failed' | 'expired',
                  error: { code: (row.pending_error_code ?? 'internal_error') as ErrorCode, message: row.pending_error_message ?? '' },
              }
            : null;
    return {
        id: row.id as Hex,
        operation: row.operation as OperationName,
        contract: row.contract as Address,
        signer: row.signer as Address,
        nonce: row.nonce,
        fingerprint: row.fingerprint as Hex,
        request: JSON.parse(row.request_json) as unknown,
        authHash: row.auth_hash as Hex,
        signature: row.signature as Hex | null,
        authorization: row.auth_json !== null ? (JSON.parse(row.auth_json) as StoredAuthorization) : null,
        authMode: row.auth_mode as AuthModeName,
        token: row.token as Address | null,
        spender: row.spender as Address | null,
        debit: row.debit !== null ? BigInt(row.debit) : null,
        fee: BigInt(row.fee),
        deadline: BigInt(row.deadline),
        priority: row.priority,
        status: row.status as RequestStatus,
        txNonce: row.tx_nonce,
        finalTxHash: row.final_tx_hash as Hex | null,
        blockNumber: row.block_number !== null ? BigInt(row.block_number) : null,
        error,
        pendingFinal,
        resolvedTxHash: row.resolved_tx_hash as Hex | null,
        resolvedBlock: row.resolved_block !== null ? BigInt(row.resolved_block) : null,
        settledAtMs: row.settled_at,
        reopenedAtMs: row.reopened_at,
        createdAtMs: row.created_at,
        updatedAtMs: row.updated_at,
        submittedAtMs: row.submitted_at,
        minedAtMs: row.mined_at,
        confirmedAtMs: row.confirmed_at,
    };
}

function toAttemptRecord(row: AttemptRow): TxAttemptRecord {
    return {
        hash: row.hash as Hex,
        requestId: row.request_id as Hex,
        seq: row.seq,
        txNonce: row.tx_nonce,
        kind: row.kind as AttemptKind,
        maxFeePerGas: BigInt(row.max_fee_per_gas),
        maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas),
        gasLimit: BigInt(row.gas_limit),
        raw: row.raw as Hex | null,
        status: row.status as AttemptStatus,
        sentBlock: BigInt(row.sent_block),
        createdAtMs: row.created_at,
        minedBlock: row.mined_block !== null ? BigInt(row.mined_block) : null,
        gasUsed: row.gas_used !== null ? BigInt(row.gas_used) : null,
        effectiveGasPrice: row.effective_gas_price !== null ? BigInt(row.effective_gas_price) : null,
    };
}

function isUniqueViolation(err: unknown): boolean {
    return (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export interface SqliteStoreOptions {
    /** Busy timeout for acquiring the exclusive lock (ms). */
    readonly lockTimeoutMs?: number;
    readonly migrations?: readonly Migration[];
    readonly nowMs?: () => number;
}

/**
 * better-sqlite3 store in WAL mode. The connection takes an EXCLUSIVE lock at open, so a second relay
 * process on the same database file fails to start (one writer, one relay key).
 *
 * Purged secrets must not survive in the files: `secure_delete`
 * zeroes freed cell space and pages in the main file, and every purge is followed by
 * `wal_checkpoint(TRUNCATE)`, which copies the purged pages into the main file and truncates the -wal file
 * that still holds the older page images. The same checkpoint runs at open (leftovers of a crash) and at
 * close. `journal_size_limit = 0` also truncates the WAL whenever SQLite resets it on its own.
 */
export class SqliteStore implements Store {
    private readonly db: Database.Database;

    private constructor(db: Database.Database) {
        this.db = db;
    }

    static open(path: string, options: SqliteStoreOptions = {}): SqliteStore {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        const db = new Database(path, { timeout: options.lockTimeoutMs ?? 5000 });
        try {
            db.pragma('locking_mode = EXCLUSIVE');
            const mode = db.pragma('journal_mode = WAL', { simple: true });
            if (path !== ':memory:' && mode !== 'wal') throw new Error(`could not enable WAL (journal_mode=${String(mode)})`);
            db.pragma('synchronous = FULL');
            db.pragma('foreign_keys = ON');
            if (db.pragma('secure_delete = ON', { simple: true }) !== 1) throw new Error('could not enable secure_delete');
            db.pragma('journal_size_limit = 0');
            // Take the exclusive lock now instead of at the first write.
            db.exec('BEGIN EXCLUSIVE; COMMIT;');
            migrate(db, options.migrations ?? MIGRATIONS, (options.nowMs ?? Date.now)());
            SqliteStore.truncateWal(db);
        } catch (err) {
            db.close();
            throw err;
        }
        return new SqliteStore(db);
    }

    /** Moves every committed page into the main file and truncates the -wal file to zero bytes. */
    private static truncateWal(db: Database.Database): void {
        const [result] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
        if (result && result.busy !== 0) throw new Error('wal_checkpoint(TRUNCATE) could not complete');
    }

    close(): void {
        if (!this.db.open) return;
        try {
            SqliteStore.truncateWal(this.db);
        } finally {
            this.db.close();
        }
    }

    journalMode(): string {
        return String(this.db.pragma('journal_mode', { simple: true }));
    }

    schemaVersion(): number {
        return (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
    }

    private getKv(key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value;
    }

    private setKv(key: string, value: string): void {
        this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    }

    bindIdentity(identity: { chainId: number; relay: Address; gaslessTransfer: Address }): void {
        this.db.transaction(() => {
            const chainId = this.getKv('chain_id');
            const relay = this.getKv('relay');
            const deployment = this.getKv('gasless_transfer');
            if (!/^0x[0-9a-fA-F]{40}$/.test(identity.gaslessTransfer ?? '')) {
                throw new Error('refusing database binding without a valid GaslessTransfer deployment');
            }
            if ((chainId !== undefined || relay !== undefined) &&
                (chainId !== String(identity.chainId) || relay?.toLowerCase() !== identity.relay.toLowerCase())) {
                throw new Error(
                    `database belongs to relay ${relay ?? '?'} on chain ${chainId ?? '?'}; refusing to use it for relay ${identity.relay} on chain ${identity.chainId}`,
                );
            }
            if (deployment !== undefined && deployment.toLowerCase() !== identity.gaslessTransfer.toLowerCase()) {
                throw new Error(`database belongs to GaslessTransfer ${deployment}; refusing deployment ${identity.gaslessTransfer}`);
            }
            // No deployment pinned yet. Every retained request must match before adopting the database;
            // otherwise recovery would encode/interpret those requests against another contract.
            if (deployment === undefined) {
                const mismatch = this.db.prepare('SELECT contract FROM requests WHERE lower(contract) != ? LIMIT 1')
                    .get(identity.gaslessTransfer.toLowerCase()) as { contract: string } | undefined;
                if (mismatch) throw new Error(`database contains requests for ${mismatch.contract}; refusing deployment ${identity.gaslessTransfer}`);
                this.setKv('gasless_transfer', identity.gaslessTransfer.toLowerCase());
            }
            if (chainId === undefined && relay === undefined) {
                this.setKv('chain_id', String(identity.chainId));
                this.setKv('relay', identity.relay);
            }
        })();
    }

    // -----------------------------------------------------------------------------------------
    // Requests
    // -----------------------------------------------------------------------------------------

    getRequest(id: Hex): RequestRecord | undefined {
        const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id.toLowerCase()) as RequestRow | undefined;
        return row ? toRequestRecord(row) : undefined;
    }

    nonceHolder(contract: Address, signer: Address, nonce: DecimalString): RequestRecord | undefined {
        const row = this.db
            .prepare(`SELECT * FROM requests WHERE contract = ? AND signer = ? AND nonce = ? AND ${HOLDS_NONCE}`)
            .get(contract, signer, nonce) as RequestRow | undefined;
        return row ? toRequestRecord(row) : undefined;
    }

    nextNonceAfter(contract: Address, signer: Address, block: bigint): bigint | undefined {
        // block_number is the block of the current inclusion (a reorg that moves it updates it, one that removes it puts
        // the request back in flight).
        const rows = this.db
            .prepare(
                `SELECT nonce FROM requests WHERE contract = ? AND signer = ? AND status IN ('mined', 'confirmed')
                    AND CAST(block_number AS INTEGER) > ?`,
            )
            .all(contract, signer, block) as Array<{ nonce: string }>;
        let next: bigint | undefined;
        for (const row of rows) {
            const n = BigInt(row.nonce) + 1n;
            if (next === undefined || n > next) next = n;
        }
        return next;
    }

    tokenUsage(token: Address, owner: Address, spender: Address, options: { readonly minedAfterBlock?: bigint | undefined } = {}): TokenUsage {
        // Pending requests, and requests included after the block a balance was read at:
        // block_number is the block of the current inclusion (a reorg that moves it updates it, one that
        // removes it puts the request back in flight).
        const after = options.minedAfterBlock;
        const rows = (
            after === undefined
                ? this.db
                      .prepare(`SELECT auth_mode, spender, debit, status FROM requests WHERE token = ? AND signer = ? AND status IN ${PENDING_STATUSES}`)
                      .all(token, owner)
                : this.db
                      .prepare(
                          `SELECT auth_mode, spender, debit, status FROM requests WHERE token = ? AND signer = ? AND (status IN ${PENDING_STATUSES}
                              OR (status IN ('mined', 'confirmed') AND CAST(block_number AS INTEGER) > ?))`,
                      )
                      .all(token, owner, after)
        ) as Array<{ auth_mode: string; spender: string | null; debit: string | null; status: string }>;
        let debits = 0n;
        let noneDebits = 0n;
        let busy = false;
        let nonePending = false;
        for (const row of rows) {
            const debit = row.debit !== null ? BigInt(row.debit) : 0n;
            const pending = row.status === 'queued' || row.status === 'submitted';
            const sameSpender = row.spender?.toLowerCase() === spender.toLowerCase();
            debits += debit;
            if (row.auth_mode === 'none' && sameSpender) {
                noneDebits += debit;
                if (pending) nonePending = true;
            }
            // A PERMIT or META_TX_APPROVE request that is pending, or that was included after the block of the reads (only
            // those rows are here besides the pending ones): its token signature set the allowance, its transfer used it,
            // and it advanced the token nonce, none of which a read at that block shows. The allowance and the token nonce
            // read there are stale, so the answer is the retryable sender_busy until a read sees the inclusion.
            if (row.auth_mode === 'permit' || row.auth_mode === 'metaTxApprove') busy = true;
        }
        return { debits, noneDebits, busy, nonePending };
    }

    admissionCounts(signer: Address): AdmissionCounts {
        const pending = this.db
            .prepare(`SELECT COUNT(*) AS n FROM requests WHERE signer = ? AND status IN ${PENDING_STATUSES}`)
            .get(signer) as { n: number };
        return { pendingOfSigner: pending.n, queued: this.countByStatus('queued') };
    }

    /**
     * An identical stored request (`duplicate`), a different one with this id or holding this nonce (`conflict`), or
     * the signer's request at this nonce that ended but is not settled (`sender_busy`); undefined if there is none.
     */
    private identity(request: NewRequest): InsertOutcome | undefined {
        const same = this.getRequest(request.id);
        if (same) return same.fingerprint === request.fingerprint ? { kind: 'duplicate', record: same } : { kind: 'conflict', record: same };
        const holder = this.nonceHolder(request.contract, request.signer, request.nonce);
        if (!holder) return undefined;
        // A failed or expired request holds its nonce only until it settles: a reorg could still put it back in flight.
        if (holder.status === 'failed' || holder.status === 'expired') return { kind: 'sender_busy', reason: 'nonce_unsettled' };
        return { kind: 'conflict', record: holder };
    }

    insertRequest(request: NewRequest, guards: InsertGuards): InsertOutcome {
        const run = this.db.transaction((): InsertOutcome => {
            const known = this.identity(request);
            if (known) return known;
            // The same checks as the pipeline, in its order, against the requests stored now (single writer:
            // nothing can change between these reads and the insert): the queue bound, the balance (step 6),
            // sender_busy and the allowance (step 7).
            const admission = this.admissionCounts(request.signer);
            // in a full queue, a request held at its spend cap gives way. It is chosen here and ended only
            // right before the insert, once every other check has passed: a refused submission changes nothing.
            let victim: string | undefined;
            if (guards.maxQueued !== undefined && admission.queued >= guards.maxQueued) {
                victim = this.evictionVictim(guards.evict?.candidates ?? [], request.priority);
                if (victim === undefined) return { kind: 'queue_full' };
            }
            const reservation = request.reservation;
            const usage = reservation
                ? this.tokenUsage(reservation.token, request.signer, reservation.spender, { minedAfterBlock: guards.observedBlock })
                : undefined;
            if (reservation && usage && guards.observedBalance !== undefined && guards.observedBalance < usage.debits + reservation.debit) {
                return { kind: 'insufficient_balance', pending: usage.debits };
            }
            if (usage?.busy) return { kind: 'sender_busy', reason: 'token_signature' };
            if (usage?.nonePending && request.authorization.mode !== 'none') return { kind: 'sender_busy', reason: 'allowance_in_use' };
            if (admission.pendingOfSigner > 0) return { kind: 'sender_busy', reason: 'pending' };
            if (
                reservation &&
                usage &&
                request.authorization.mode === 'none' &&
                guards.observedAllowance !== undefined &&
                guards.observedAllowance < usage.noneDebits + reservation.debit
            ) {
                return { kind: 'insufficient_allowance', pending: usage.noneDebits };
            }
            // A failed/settled request still occupies storage until normal retention removes it; at the limit, the
            // oldest history of a request that was never sent gives way (dropUnsentHistory).
            // Check inside the insert transaction, after duplicates and the existing admission checks,
            // but before a held request gives way: eviction retains its row and cannot make room here.
            let dropped: Hex | undefined;
            if (guards.maxRetainedRequests !== undefined && this.countRequests() >= guards.maxRetainedRequests) {
                dropped = this.dropUnsentHistory(request.createdAtMs);
                if (dropped === undefined) return { kind: 'retention_full' };
            }
            const evicted = victim !== undefined ? this.evict(victim, guards.evict!.final, request.createdAtMs) : undefined;
            this.db
                .prepare(
                    `INSERT INTO requests (id, operation, contract, signer, nonce, fingerprint, request_json, auth_hash, signature,
                        auth_json, auth_mode, token, spender, debit, fee, deadline, priority, status, created_at, updated_at)
                     VALUES (@id, @operation, @contract, @signer, @nonce, @fingerprint, @request_json, @auth_hash, @signature,
                        @auth_json, @auth_mode, @token, @spender, @debit, @fee, @deadline, @priority, 'queued', @now, @now)`,
                )
                .run({
                    id: request.id.toLowerCase(),
                    operation: request.operation,
                    contract: request.contract,
                    signer: request.signer,
                    nonce: request.nonce,
                    fingerprint: request.fingerprint,
                    request_json: JSON.stringify(request.request),
                    auth_hash: request.authHash.toLowerCase(),
                    signature: request.signature,
                    auth_json: JSON.stringify(request.authorization),
                    auth_mode: request.authorization.mode,
                    token: reservation?.token ?? null,
                    spender: reservation?.spender ?? null,
                    debit: reservation ? reservation.debit.toString() : null,
                    fee: request.fee.toString(),
                    deadline: request.deadline.toString(),
                    priority: request.priority,
                    now: request.createdAtMs,
                });
            return { kind: 'inserted', record: this.getRequest(request.id)!, ...(evicted ? { evicted } : {}), ...(dropped ? { dropped } : {}) };
        });
        try {
            const outcome = run();
            // The request that gave way had its secrets purged: out of the -wal file as well (as after finalize).
            if (outcome.kind === 'inserted' && outcome.evicted) SqliteStore.truncateWal(this.db);
            return outcome;
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            // Backstop for the database constraints (the checks above make this unreachable).
            const known = this.identity(request);
            if (known) return known;
            return { kind: 'sender_busy', reason: this.admissionCounts(request.signer).pendingOfSigner > 0 ? 'pending' : 'token_signature' };
        }
    }

    /**
     * The held request that gives way in a full queue: among `candidates` that are still queued, were never
     * broadcast (no transaction: its end is final at once) and have no higher priority than the new request, the one
     * with the lowest cap per gas, and among equal caps the oldest. Undefined if there is none.
     */
    private evictionVictim(candidates: readonly EvictionCandidate[], priority: number): string | undefined {
        if (candidates.length === 0) return undefined;
        const caps = new Map(candidates.map((c) => [c.id.toLowerCase(), c.capPerGas]));
        const rows = this.db
            .prepare(
                `SELECT r.id AS id, r.rowid AS seq FROM requests r
                 WHERE r.id IN (SELECT value FROM json_each(?)) AND r.status = 'queued' AND r.priority <= ?
                   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.request_id = r.id)`,
            )
            .all(JSON.stringify([...caps.keys()]), priority) as Array<{ id: string; seq: number }>;
        let best: { id: string; cap: bigint; seq: number } | undefined;
        for (const row of rows) {
            const cap = caps.get(row.id);
            if (cap === undefined) continue;
            if (!best || cap < best.cap || (cap === best.cap && row.seq < best.seq)) best = { id: row.id, cap, seq: row.seq };
        }
        return best?.id;
    }

    /**
     * Makes room for one row at the retained-row limit: deletes the longest-settled request that was never sent (it
     * failed or expired without a transaction, so nothing of it is on chain or in the gas accounting) and whose
     * deadline passed more than UNSENT_HISTORY_KEPT_SECONDS ago. By then the client that waited for it has read its
     * outcome, and its intent cannot be accepted again. Returns its ID, or undefined if there is none.
     *
     * Without this, requests that cost their senders nothing (they end before the broadcast) could fill the limit
     * and close the relay to every new request for the whole retention period.
     */
    private dropUnsentHistory(nowMs: number): Hex | undefined {
        const id = this.oldestUnsentHistory(nowMs);
        if (id !== undefined) this.db.prepare('DELETE FROM requests WHERE id = ?').run(id);
        return id;
    }

    private oldestUnsentHistory(nowMs: number): Hex | undefined {
        const row = this.db
            .prepare(
                `SELECT id FROM requests
                 WHERE settled_at IS NOT NULL AND status IN ('failed', 'expired') AND resolved_tx_hash IS NULL
                    AND CAST(deadline AS INTEGER) < ?
                    AND NOT EXISTS (SELECT 1 FROM transactions WHERE transactions.request_id = requests.id)
                 ORDER BY settled_at LIMIT 1`,
            )
            .get(Math.floor(nowMs / 1000) - UNSENT_HISTORY_KEPT_SECONDS) as { id: Hex } | undefined;
        return row?.id;
    }

    hasRetainedRoom(maxRetainedRequests: number, nowMs: number): boolean {
        return this.countRequests() < maxRetainedRequests || this.oldestUnsentHistory(nowMs) !== undefined;
    }

    /** a queued request that was never broadcast ends with `final`, final at once; its secrets are purged. */
    private evict(id: string, final: FinalFailure, nowMs: number): RequestRecord {
        const updated = this.db
            .prepare(
                `UPDATE requests SET status = ?, error_code = ?, error_message = ?, updated_at = ?,
                    pending_final_status = NULL, pending_error_code = NULL, pending_error_message = NULL,
                    resolved_tx_hash = NULL, resolved_block = NULL, settled_at = ?
                 WHERE id = ? AND status = 'queued'`,
            )
            .run(final.status, final.error.code, final.error.message, nowMs, nowMs, id);
        if (updated.changes !== 1) throw new Error(`request ${id} is not queued`);
        this.purgeSecrets(id as Hex);
        return this.getRequest(id as Hex)!;
    }

    /** Ordered by priority, then FIFO (insertion order). */
    listByStatus(status: RequestStatus): RequestRecord[] {
        const rows = this.db
            .prepare('SELECT * FROM requests WHERE status = ? ORDER BY priority DESC, rowid ASC')
            .all(status) as RequestRow[];
        return rows.map(toRequestRecord);
    }

    countByStatus(status: RequestStatus): number {
        return (this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE status = ?').get(status) as { n: number }).n;
    }

    countRequests(): number {
        return (this.db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    }

    // -----------------------------------------------------------------------------------------
    // Transaction manager
    // -----------------------------------------------------------------------------------------

    /** Starts the ledger once, at the per-nonce maximum of the stored attempts, using exact bigint arithmetic. */
    private initializeGasExposure(): void {
        if (this.getKv('gas_exposure_wei') !== undefined) return;
        const maxima = new Map<number, bigint>();
        const rows = this.db.prepare('SELECT tx_nonce, gas_limit, max_fee_per_gas FROM transactions').all() as
            Array<{ tx_nonce: number; gas_limit: string; max_fee_per_gas: string }>;
        for (const row of rows) {
            const cost = BigInt(row.gas_limit) * BigInt(row.max_fee_per_gas);
            if (cost > (maxima.get(row.tx_nonce) ?? 0n)) maxima.set(row.tx_nonce, cost);
        }
        let total = 0n;
        for (const [nonce, cost] of maxima) {
            this.db.prepare('INSERT INTO gas_reservations (tx_nonce, maximum_wei) VALUES (?, ?)').run(nonce, cost.toString());
            total += cost;
        }
        this.setKv('gas_exposure_wei', total.toString());
    }

    gasExposureWei(): bigint {
        return this.db.transaction(() => {
            this.initializeGasExposure();
            return BigInt(this.getKv('gas_exposure_wei')!);
        })();
    }

    reserveGasExposure(txNonce: number, maximumWei: bigint, limitWei: bigint): boolean {
        if (!Number.isSafeInteger(txNonce) || txNonce < 0 || maximumWei <= 0n || limitWei <= 0n) {
            throw new Error('invalid aggregate gas reservation');
        }
        return this.db.transaction(() => {
            this.initializeGasExposure();
            const total = BigInt(this.getKv('gas_exposure_wei')!);
            const row = this.db.prepare('SELECT maximum_wei FROM gas_reservations WHERE tx_nonce = ?').get(txNonce) as
                { maximum_wei: string } | undefined;
            const previous = BigInt(row?.maximum_wei ?? '0');
            const increase = maximumWei > previous ? maximumWei - previous : 0n;
            // Already exposed transactions may be rebroadcast even after the operator lowers the limit.
            if (increase === 0n) return true;
            if (total + increase > limitWei) return false;
            this.db.prepare(`INSERT INTO gas_reservations (tx_nonce, maximum_wei) VALUES (?, ?)
                ON CONFLICT(tx_nonce) DO UPDATE SET maximum_wei = excluded.maximum_wei`).run(txNonce, maximumWei.toString());
            this.setKv('gas_exposure_wei', (total + increase).toString());
            return true;
        })();
    }

    getNextNonce(): number | undefined {
        const value = this.getKv('next_tx_nonce');
        return value !== undefined ? Number(value) : undefined;
    }

    setNextNonce(nonce: number): void {
        if (!Number.isSafeInteger(nonce) || nonce < 0) throw new RangeError('invalid tx nonce');
        this.setKv('next_tx_nonce', String(nonce));
    }

    listAttempts(requestId: Hex): TxAttemptRecord[] {
        const rows = this.db
            .prepare('SELECT * FROM transactions WHERE request_id = ? ORDER BY seq ASC')
            .all(requestId.toLowerCase()) as AttemptRow[];
        return rows.map(toAttemptRecord);
    }

    private nextSeq(requestId: Hex): number {
        const { seq } = this.db
            .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM transactions WHERE request_id = ?')
            .get(requestId.toLowerCase()) as { seq: number };
        return seq + 1;
    }

    private insertAttempt(requestId: Hex, seq: number, txNonce: number, attempt: NewAttempt, nowMs: number): void {
        this.db
            .prepare(
                `INSERT INTO transactions (hash, request_id, seq, tx_nonce, kind, max_fee_per_gas, max_priority_fee_per_gas,
                    gas_limit, raw, status, sent_block, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
                attempt.hash.toLowerCase(),
                requestId.toLowerCase(),
                seq,
                txNonce,
                attempt.kind,
                attempt.maxFeePerGas.toString(),
                attempt.maxPriorityFeePerGas.toString(),
                attempt.gasLimit.toString(),
                attempt.raw,
                attempt.sentBlock.toString(),
                nowMs,
            );
    }

    recordFirstAttempt(requestId: Hex, txNonce: number, attempt: NewAttempt, nowMs: number): void {
        this.db.transaction(() => {
            const next = this.getNextNonce();
            if (next !== txNonce) throw new Error(`tx nonce ${txNonce} is not the next nonce (${String(next)})`);
            const updated = this.db
                .prepare(
                    `UPDATE requests SET status = 'submitted', tx_nonce = ?, submitted_at = ?, updated_at = ?
                     WHERE id = ? AND status = 'queued'`,
                )
                .run(txNonce, nowMs, nowMs, requestId.toLowerCase());
            if (updated.changes !== 1) throw new Error(`request ${requestId} is not queued`);
            // A requeued request keeps its earlier attempts (at their old tx nonce): continue the sequence.
            this.insertAttempt(requestId, this.nextSeq(requestId), txNonce, attempt, nowMs);
            this.setNextNonce(txNonce + 1);
        })();
    }

    requeue(requestId: Hex, nowMs: number): void {
        this.db.transaction(() => {
            const updated = this.db
                .prepare(
                    `UPDATE requests SET status = 'queued', tx_nonce = NULL, submitted_at = NULL, updated_at = ?
                     WHERE id = ? AND status = 'submitted' AND pending_final_status IS NULL`,
                )
                .run(nowMs, requestId.toLowerCase());
            if (updated.changes !== 1) throw new Error(`request ${requestId} is not in flight without a pending final state`);
            this.db
                .prepare("UPDATE transactions SET status = 'failed' WHERE request_id = ? AND status IN ('pending', 'replaced')")
                .run(requestId.toLowerCase());
        })();
    }

    recordReplacement(requestId: Hex, attempt: NewAttempt, pendingFinal: FinalFailure | undefined, nowMs: number): void {
        this.db.transaction(() => {
            const request = this.getRequest(requestId);
            if (!request || request.status !== 'submitted' || request.txNonce === null) {
                throw new Error(`request ${requestId} is not in flight`);
            }
            const seq = this.nextSeq(requestId);
            this.db
                .prepare("UPDATE transactions SET status = 'replaced' WHERE request_id = ? AND status = 'pending'")
                .run(requestId.toLowerCase());
            this.insertAttempt(requestId, seq, request.txNonce, attempt, nowMs);
            if (pendingFinal) this.setPendingFinal(requestId, pendingFinal, nowMs);
            else this.db.prepare('UPDATE requests SET updated_at = ? WHERE id = ?').run(nowMs, requestId.toLowerCase());
        })();
    }

    setPendingFinal(requestId: Hex, pendingFinal: FinalFailure, nowMs: number): void {
        this.db
            .prepare(
                `UPDATE requests SET pending_final_status = ?, pending_error_code = ?, pending_error_message = ?, updated_at = ?
                 WHERE id = ?`,
            )
            .run(pendingFinal.status, pendingFinal.error.code, pendingFinal.error.message, nowMs, requestId.toLowerCase());
    }

    touchAttempt(hash: Hex, sentBlock: bigint): void {
        this.db.prepare('UPDATE transactions SET sent_block = ? WHERE hash = ?').run(sentBlock.toString(), hash.toLowerCase());
    }

    private setAttemptMined(mined: MinedInfo, status: AttemptStatus): void {
        this.db
            .prepare('UPDATE transactions SET status = ?, mined_block = ?, gas_used = ?, effective_gas_price = ? WHERE hash = ?')
            .run(status, mined.blockNumber.toString(), mined.gasUsed.toString(), mined.effectiveGasPrice.toString(), mined.hash.toLowerCase());
    }

    /** Every other attempt of the request lost the race for the tx nonce (or was never mined). */
    private markOthersReplaced(requestId: Hex, hash: Hex): void {
        this.db
            .prepare(
                `UPDATE transactions SET status = 'replaced', mined_block = NULL, gas_used = NULL, effective_gas_price = NULL
                 WHERE request_id = ? AND hash != ? AND (status IN ('pending', 'mined') OR (status = 'failed' AND mined_block IS NOT NULL))`,
            )
            .run(requestId.toLowerCase(), hash.toLowerCase());
    }

    markMined(requestId: Hex, mined: MinedInfo, nowMs: number): void {
        this.db.transaction(() => {
            this.setAttemptMined(mined, 'mined');
            this.markOthersReplaced(requestId, mined.hash);
            // pending_final_* stays until settle(): if a reorg removes this inclusion while a cancel was
            // intended, the cancel's reason still applies to whichever transaction takes the nonce then.
            this.db
                .prepare(
                    `UPDATE requests SET status = 'mined', final_tx_hash = ?, block_number = ?, mined_at = COALESCE(mined_at, ?), updated_at = ?,
                        error_code = NULL, error_message = NULL,
                        resolved_tx_hash = ?, resolved_block = ?, settled_at = NULL
                     WHERE id = ?`,
                )
                .run(
                    mined.hash.toLowerCase(),
                    mined.blockNumber.toString(),
                    nowMs,
                    nowMs,
                    mined.hash.toLowerCase(),
                    mined.blockNumber.toString(),
                    requestId.toLowerCase(),
                );
        })();
    }

    updateMinedBlock(requestId: Hex, blockNumber: bigint, nowMs: number): void {
        this.db.transaction(() => {
            const request = this.getRequest(requestId);
            if (!request?.resolvedTxHash) return;
            this.db.prepare('UPDATE transactions SET mined_block = ? WHERE hash = ?').run(blockNumber.toString(), request.resolvedTxHash);
            this.db
                .prepare(
                    `UPDATE requests SET resolved_block = ?, block_number = CASE WHEN block_number IS NULL THEN NULL ELSE ? END, updated_at = ?
                     WHERE id = ?`,
                )
                .run(blockNumber.toString(), blockNumber.toString(), nowMs, requestId.toLowerCase());
        })();
    }

    resolveFailed(requestId: Hex, final: FinalFailure, resolution: OnChainResolution, nowMs: number): void {
        this.db.transaction(() => {
            let hash: string | null = null;
            let block: bigint;
            let call: { hash: string; block: bigint } | null = null;
            if (resolution.kind === 'receipt') {
                const { mined } = resolution;
                this.setAttemptMined(mined, resolution.callReverted ? 'failed' : 'mined');
                this.markOthersReplaced(requestId, mined.hash);
                hash = mined.hash.toLowerCase();
                block = mined.blockNumber;
                if (resolution.attemptKind === 'call') call = { hash, block };
            } else {
                // A foreign transaction took the tx nonce: none of the request's transactions can be mined.
                this.db
                    .prepare("UPDATE transactions SET status = 'failed' WHERE request_id = ? AND status IN ('pending', 'replaced')")
                    .run(requestId.toLowerCase());
                block = resolution.block;
            }
            // Secrets and raw transactions stay (and so does pending_final_*): the state is provisional until settle().
            // mined_at stays too (see reopen): a request that was mined before a reorg is not counted twice.
            this.db
                .prepare(
                    `UPDATE requests SET status = ?, error_code = ?, error_message = ?, final_tx_hash = ?, block_number = ?,
                        resolved_tx_hash = ?, resolved_block = ?, settled_at = NULL, updated_at = ?
                     WHERE id = ?`,
                )
                .run(
                    final.status,
                    final.error.code,
                    final.error.message,
                    call?.hash ?? null,
                    call ? call.block.toString() : null,
                    hash,
                    block.toString(),
                    nowMs,
                    requestId.toLowerCase(),
                );
        })();
    }

    reopen(requestId: Hex, nowMs: number): void {
        this.db.transaction(() => {
            const request = this.getRequest(requestId);
            if (!request || request.txNonce === null || request.settledAtMs !== null || !['mined', 'failed', 'expired'].includes(request.status)) {
                return;
            }
            const id = requestId.toLowerCase();
            // Attempts that were marked by the vanished inclusion are candidates again; the newest one at the
            // current tx nonce is the one in flight.
            this.db
                .prepare(
                    `UPDATE transactions SET status = 'replaced', mined_block = NULL, gas_used = NULL, effective_gas_price = NULL
                     WHERE request_id = ? AND (mined_block IS NOT NULL OR (status = 'failed' AND tx_nonce = ?))`,
                )
                .run(id, request.txNonce);
            this.db
                .prepare(
                    `UPDATE transactions SET status = 'pending'
                     WHERE hash = (SELECT hash FROM transactions WHERE request_id = ? AND tx_nonce = ? ORDER BY seq DESC LIMIT 1)`,
                )
                .run(id, request.txNonce);
            // mined_at stays: it records that the request was mined once (fee revenue and time-to-mine are
            // counted only the first time); block_number, the current inclusion, is cleared.
            // reopened_at exempts the request from the one-token-authorization index (migration 2).
            this.db
                .prepare(
                    `UPDATE requests SET status = 'submitted', error_code = NULL, error_message = NULL, final_tx_hash = NULL,
                        block_number = NULL, resolved_tx_hash = NULL, resolved_block = NULL, reopened_at = ?, updated_at = ?
                     WHERE id = ?`,
                )
                .run(nowMs, nowMs, id);
        })();
    }

    requeueUnexecuted(requestId: Hex, nowMs: number): void {
        this.db.transaction(() => {
            const id = requestId.toLowerCase();
            // reopened_at exempts the request from the one-pending-per-signer and one-token-authorization indexes,
            // as in reopen(): its sender may have a newer request pending by now.
            const updated = this.db
                .prepare(
                    `UPDATE requests SET status = 'queued', error_code = NULL, error_message = NULL, final_tx_hash = NULL,
                        block_number = NULL, resolved_tx_hash = NULL, resolved_block = NULL, reopened_at = ?, updated_at = ?
                     WHERE id = ? AND status = 'mined' AND tx_nonce IS NULL AND settled_at IS NULL`,
                )
                .run(nowMs, nowMs, id);
            if (updated.changes !== 1) throw new Error(`request ${requestId} is not mined without a tx nonce and unsettled`);
            // The attempt the vanished inclusion had marked is one of the transactions that can never be mined again
            // (their tx nonce went to another transaction), like the others since the requeue.
            this.db
                .prepare("UPDATE transactions SET status = 'failed', mined_block = NULL, gas_used = NULL, effective_gas_price = NULL WHERE request_id = ? AND mined_block IS NOT NULL")
                .run(id);
        })();
    }

    listUnsettled(): RequestRecord[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM requests WHERE settled_at IS NULL AND status IN ('mined', 'failed', 'expired')
                 ORDER BY rowid ASC`,
            )
            .all() as RequestRow[];
        return rows.map(toRequestRecord);
    }

    private purgeSecrets(requestId: Hex): void {
        this.db.prepare('UPDATE requests SET signature = NULL, auth_json = NULL WHERE id = ?').run(requestId.toLowerCase());
        this.db.prepare('UPDATE transactions SET raw = NULL WHERE request_id = ?').run(requestId.toLowerCase());
    }

    // settle() and markConfirmed() purge only if they changed the request: a request that is in flight again (or
    // queued, or already settled) keeps what it still needs.
    settle(requestId: Hex, nowMs: number): void {
        const settled = this.db.transaction((): boolean => {
            const updated = this.db
                .prepare(
                    `UPDATE requests SET
                        confirmed_at = CASE WHEN status = 'mined' THEN ? ELSE confirmed_at END,
                        status = CASE WHEN status = 'mined' THEN 'confirmed' ELSE status END,
                        pending_final_status = NULL, pending_error_code = NULL, pending_error_message = NULL,
                        settled_at = ?, updated_at = ?
                     WHERE id = ? AND settled_at IS NULL AND status IN ('mined', 'failed', 'expired')`,
                )
                .run(nowMs, nowMs, nowMs, requestId.toLowerCase());
            if (updated.changes !== 1) return false;
            this.purgeSecrets(requestId);
            return true;
        })();
        if (settled) SqliteStore.truncateWal(this.db);
    }

    markConfirmed(requestId: Hex, nowMs: number): void {
        const confirmed = this.db.transaction((): boolean => {
            const updated = this.db
                .prepare(
                    `UPDATE requests SET status = 'confirmed', confirmed_at = ?, settled_at = ?, updated_at = ?,
                        pending_final_status = NULL, pending_error_code = NULL, pending_error_message = NULL
                     WHERE id = ? AND status = 'mined' AND settled_at IS NULL`,
                )
                .run(nowMs, nowMs, nowMs, requestId.toLowerCase());
            if (updated.changes !== 1) return false;
            this.purgeSecrets(requestId);
            return true;
        })();
        if (confirmed) SqliteStore.truncateWal(this.db);
    }

    finalize(
        requestId: Hex,
        final: FinalFailure,
        mined: (MinedInfo & { kind: AttemptKind; callReverted: boolean }) | undefined,
        nowMs: number,
    ): void {
        this.db.transaction(() => {
            if (mined) {
                this.setAttemptMined(mined, mined.callReverted ? 'failed' : 'mined');
                this.markOthersReplaced(requestId, mined.hash);
            } else {
                this.db
                    .prepare("UPDATE transactions SET status = 'failed' WHERE request_id = ? AND status IN ('pending', 'replaced')")
                    .run(requestId.toLowerCase());
            }
            const minedCall = mined?.kind === 'call';
            this.db
                .prepare(
                    `UPDATE requests SET status = ?, error_code = ?, error_message = ?,
                        final_tx_hash = ?, block_number = ?, updated_at = ?,
                        pending_final_status = NULL, pending_error_code = NULL, pending_error_message = NULL,
                        resolved_tx_hash = ?, resolved_block = ?, settled_at = ?
                     WHERE id = ?`,
                )
                .run(
                    final.status,
                    final.error.code,
                    final.error.message,
                    minedCall ? mined.hash.toLowerCase() : null,
                    minedCall ? mined.blockNumber.toString() : null,
                    nowMs,
                    mined ? mined.hash.toLowerCase() : null,
                    mined ? mined.blockNumber.toString() : null,
                    nowMs,
                    requestId.toLowerCase(),
                );
            this.purgeSecrets(requestId);
        })();
        SqliteStore.truncateWal(this.db);
    }

    pruneSettled(beforeMs: number): number {
        const deleted = this.db.transaction((): number => {
            const where = `settled_at IS NOT NULL AND settled_at < ? AND status IN ${TERMINAL_STATUSES}`;
            this.db.prepare(`DELETE FROM transactions WHERE request_id IN (SELECT id FROM requests WHERE ${where})`).run(beforeMs);
            return this.db.prepare(`DELETE FROM requests WHERE ${where}`).run(beforeMs).changes;
        })();
        if (deleted > 0) SqliteStore.truncateWal(this.db);
        return deleted;
    }
}
