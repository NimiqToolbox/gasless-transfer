import type BetterSqlite3 from 'better-sqlite3';

export interface Migration {
    readonly version: number;
    readonly description: string;
    readonly sql: string;
}

/**
 * Append-only list of schema migrations. Never edit an applied migration; add a new version. A new database gets
 * versions 1 to 7 in one transaction, and migrate refuses one at an older schema (MIN_SCHEMA_VERSION): so 6 replaces
 * the empty tables of 1 to 5, and 7 changes no table.
 * Secrets (signature, auth_json, raw) are nullable because they are purged at terminal states.
 */
export const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        description: 'requests, transactions, key-value state',
        sql: `
CREATE TABLE kv (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE requests (
    id TEXT PRIMARY KEY NOT NULL,
    operation TEXT NOT NULL,
    contract TEXT NOT NULL,
    signer TEXT NOT NULL,
    nonce TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL,
    signature TEXT,
    auth_json TEXT,
    auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'permit', 'metaTxApprove')),
    token TEXT,
    spender TEXT,
    debit TEXT,
    fee TEXT NOT NULL,
    deadline TEXT NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'submitted', 'mined', 'confirmed', 'failed', 'expired')),
    tx_nonce INTEGER,
    final_tx_hash TEXT,
    block_number TEXT,
    error_code TEXT,
    error_message TEXT,
    pending_final_status TEXT CHECK (pending_final_status IS NULL OR pending_final_status IN ('failed', 'expired')),
    pending_error_code TEXT,
    pending_error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    submitted_at INTEGER,
    mined_at INTEGER,
    confirmed_at INTEGER,
    UNIQUE (contract, signer, nonce)
) STRICT;

-- At most one pending PERMIT / META_TX_APPROVE request per (token, owner): the token nonce is sequential.
CREATE UNIQUE INDEX requests_one_token_auth_in_flight ON requests (token, signer)
    WHERE token IS NOT NULL AND status IN ('queued', 'submitted') AND auth_mode IN ('permit', 'metaTxApprove');

-- Every relay tx nonce belongs to exactly one request.
CREATE UNIQUE INDEX requests_tx_nonce ON requests (tx_nonce) WHERE tx_nonce IS NOT NULL;

-- Queue order: priority, then insertion order (rowid; requests are never deleted).
CREATE INDEX requests_by_status ON requests (status, priority DESC);
CREATE INDEX requests_by_token_owner ON requests (token, signer, status);

CREATE TABLE transactions (
    hash TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL REFERENCES requests (id),
    seq INTEGER NOT NULL,
    tx_nonce INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('call', 'cancel')),
    max_fee_per_gas TEXT NOT NULL,
    max_priority_fee_per_gas TEXT NOT NULL,
    gas_limit TEXT NOT NULL,
    raw TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'mined', 'replaced', 'failed')),
    sent_block TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    mined_block TEXT,
    gas_used TEXT,
    effective_gas_price TEXT,
    UNIQUE (request_id, seq)
) STRICT;

CREATE INDEX transactions_by_request ON transactions (request_id, seq);
`,
    },
    {
        version: 2,
        description: 'provisional terminal states until finality; retention of settled requests',
        // A terminal state decided by an inclusion (a mined call, a reverted call or a cancel) is provisional
        // until that block is final: `resolved_*` name the deciding transaction and block (hash NULL when a
        // foreign transaction consumed the tx nonce), and `settled_at` is set once the outcome is final and
        // the secrets are purged. Settled terminal requests are deleted after the retention period, so the
        // remark of migration 1 "requests are never deleted" no longer holds; the queue order still follows rowid,
        // because only rows older than every queued row are deleted.
        //
        // `reopened_at` marks a request that a reorg put back in flight after its outcome had been decided.
        // Its token authorization was accepted before a newer PERMIT/META_TX request of the same (token, owner)
        // may have been accepted ("retry when it is mined"), so both can be in flight at once: the one-per-owner
        // index applies to accepted requests only. New submissions are still refused while either is pending
        // (tokenUsage counts every pending request).
        sql: `
ALTER TABLE requests ADD COLUMN resolved_tx_hash TEXT;
ALTER TABLE requests ADD COLUMN resolved_block TEXT;
ALTER TABLE requests ADD COLUMN settled_at INTEGER;
ALTER TABLE requests ADD COLUMN reopened_at INTEGER;

-- Migration 1 purged failed, expired and confirmed requests at once: they are settled.
UPDATE requests SET settled_at = updated_at WHERE status IN ('confirmed', 'failed', 'expired');
UPDATE requests SET resolved_tx_hash = final_tx_hash, resolved_block = block_number WHERE status = 'mined';

DROP INDEX requests_one_token_auth_in_flight;
CREATE UNIQUE INDEX requests_one_token_auth_in_flight ON requests (token, signer)
    WHERE token IS NOT NULL AND status IN ('queued', 'submitted') AND auth_mode IN ('permit', 'metaTxApprove')
        AND reopened_at IS NULL;

CREATE INDEX requests_unsettled ON requests (status) WHERE settled_at IS NULL;
CREATE INDEX requests_settled_at ON requests (settled_at) WHERE settled_at IS NOT NULL;
`,
    },
    {
        version: 3,
        description: 'time the current inclusion of a mined request was seen',
        // `mined_at` is the first time a request was seen mined and survives reorgs (fee revenue and time-to-mine
        // count once). The step-9 re-check needs the current inclusion instead: a request that a
        // reorg put back in flight and that is mined again while another request of its sender is validated is
        // missing from that request's balance read. `included_at` is set whenever the relay sees an inclusion
        // (mined, or moved to another block by a reorg) and cleared when the request leaves the mined state.
        sql: `
ALTER TABLE requests ADD COLUMN included_at INTEGER;
UPDATE requests SET included_at = mined_at WHERE status IN ('mined', 'confirmed');
`,
    },
    {
        version: 4,
        description: 'step 9 by block number instead of wall-clock time; index for the per-sender admission bound',
        // the step-9 re-check compared `included_at` (the wall-clock time the relay saw an
        // inclusion) with the time step 6 started. That misses a request mined before step 6 when the balance
        // read came from a node that had not imported its block yet, and a backwards clock step (NTP) can
        // hide one. Steps 6 and 7 now read at a pinned block B, and step 9 counts the sender's mined or
        // confirmed requests with block_number > B: the inclusion block, which a reorg updates or clears.
        // `included_at` has no reader left.
        //
        // The per-sender admission bound counts the queued and in-flight
        // requests of one signer across tokens and operations on every submission.
        sql: `
ALTER TABLE requests DROP COLUMN included_at;
CREATE INDEX requests_by_signer_status ON requests (signer, status);
`,
    },
    {
        version: 5,
        description: 'durable monotonic native gas exposure by relay nonce',
        sql: `
CREATE TABLE gas_reservations (
    tx_nonce INTEGER PRIMARY KEY NOT NULL CHECK (tx_nonce >= 0),
    maximum_wei TEXT NOT NULL
) STRICT;
`,
    },
    {
        version: 6,
        description: 'sequential intent nonces, signed token authorization',
        // Sequential intent nonces and the signed token authorization (docs/STEP-1-GAS-ABSTRACTION.md §4). Runs only on
        // a new database, in the same transaction as 1 to 5, and replaces their empty tables with this layout:
        // - `nonce` is the intent nonce, a canonical uint256 decimal string;
        // - `auth_hash` is hashStruct(TokenAuth) of the signed token authorization; GET /v1/requests/:id returns it,
        //   also after `auth_json` is purged;
        // - (contract, signer, nonce) is unique among the requests that hold the nonce: all but a failed or expired
        //   request whose outcome is settled. Such a request can never execute, so the sender may sign its nonce again;
        // - one queued or in-flight request per signer (requests a reorg put back in flight are exempt, as from the
        //   one-token-authorization index).
        sql: `
DROP TABLE transactions;
DROP TABLE requests;

CREATE TABLE requests (
    id TEXT PRIMARY KEY NOT NULL,
    operation TEXT NOT NULL,
    contract TEXT NOT NULL,
    signer TEXT NOT NULL,
    nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 1 AND 78 AND nonce NOT GLOB '*[^0-9]*'),
    fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL,
    auth_hash TEXT NOT NULL,
    signature TEXT,
    auth_json TEXT,
    auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'permit', 'metaTxApprove')),
    token TEXT,
    spender TEXT,
    debit TEXT,
    fee TEXT NOT NULL,
    deadline TEXT NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'submitted', 'mined', 'confirmed', 'failed', 'expired')),
    tx_nonce INTEGER,
    final_tx_hash TEXT,
    block_number TEXT,
    error_code TEXT,
    error_message TEXT,
    pending_final_status TEXT CHECK (pending_final_status IS NULL OR pending_final_status IN ('failed', 'expired')),
    pending_error_code TEXT,
    pending_error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    submitted_at INTEGER,
    mined_at INTEGER,
    confirmed_at INTEGER,
    resolved_tx_hash TEXT,
    resolved_block TEXT,
    settled_at INTEGER,
    reopened_at INTEGER
) STRICT;

CREATE UNIQUE INDEX requests_nonce_holder ON requests (contract, signer, nonce)
    WHERE settled_at IS NULL OR status NOT IN ('failed', 'expired');
CREATE UNIQUE INDEX requests_one_pending_per_signer ON requests (signer)
    WHERE status IN ('queued', 'submitted') AND reopened_at IS NULL;
CREATE UNIQUE INDEX requests_one_token_auth_in_flight ON requests (token, signer)
    WHERE token IS NOT NULL AND status IN ('queued', 'submitted') AND auth_mode IN ('permit', 'metaTxApprove')
        AND reopened_at IS NULL;
CREATE UNIQUE INDEX requests_tx_nonce ON requests (tx_nonce) WHERE tx_nonce IS NOT NULL;
CREATE INDEX requests_by_status ON requests (status, priority DESC);
CREATE INDEX requests_by_token_owner ON requests (token, signer, status);
CREATE INDEX requests_by_signer_status ON requests (signer, status);
CREATE INDEX requests_unsettled ON requests (status) WHERE settled_at IS NULL;
CREATE INDEX requests_settled_at ON requests (settled_at) WHERE settled_at IS NOT NULL;

CREATE TABLE transactions (
    hash TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL REFERENCES requests (id),
    seq INTEGER NOT NULL,
    tx_nonce INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('call', 'cancel')),
    max_fee_per_gas TEXT NOT NULL,
    max_priority_fee_per_gas TEXT NOT NULL,
    gas_limit TEXT NOT NULL,
    raw TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'mined', 'replaced', 'failed')),
    sent_block TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    mined_block TEXT,
    gas_used TEXT,
    effective_gas_price TEXT,
    UNIQUE (request_id, seq)
) STRICT;

CREATE INDEX transactions_by_request ON transactions (request_id, seq);
`,
    },
    {
        version: 7,
        description: 'EIP-712 domain version 3',
        // Runs only on a new database, in the same transaction as 1 to 6, and changes no table: its version is
        // MIN_SCHEMA_VERSION, the oldest schema this relay opens.
        sql: `
-- No change to the layout of version 6.
`,
    },
];

/**
 * The oldest schema this relay opens. A database at an older one holds requests this relay cannot execute: it is
 * refused, never migrated.
 */
const MIN_SCHEMA_VERSION = 7;

/**
 * Applies pending migrations in order: those of a new database in one transaction, every later one in its own.
 * Refuses a newer database, and one older than MIN_SCHEMA_VERSION once the list reaches it.
 */
export function migrate(db: BetterSqlite3.Database, migrations: readonly Migration[], nowMs: number): number {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
    ) STRICT`);
    const current = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
    const latest = migrations.at(-1)?.version ?? 0;
    if (current > latest) {
        throw new Error(`database schema v${current} is newer than this relay supports (v${latest})`);
    }
    if (current > 0 && current < MIN_SCHEMA_VERSION && latest >= MIN_SCHEMA_VERSION) {
        throw new Error(
            `database schema v${current} is older than this relay supports (v${MIN_SCHEMA_VERSION}); start this relay with a new RELAY_DB_PATH`,
        );
    }
    for (const [i, m] of migrations.entries()) if (m.version !== i + 1) throw new Error('migrations must be numbered 1, 2, 3, …');
    const apply = (m: Migration): void => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)').run(m.version, m.description, nowMs);
    };
    const pending = migrations.filter((m) => m.version > current);
    // A new database gets every migration at once: it never exists at an older schema, not even after a crash.
    if (current === 0) db.transaction(() => pending.forEach(apply))();
    else for (const m of pending) db.transaction(() => apply(m))();
    return latest;
}
