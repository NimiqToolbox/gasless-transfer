# Storage

The relay stores accepted requests, signed transactions and nonce state in one SQLite database at `RELAY_DB_PATH`. The production image uses `/data/relay.sqlite`. Use dedicated persistent storage and one writer per relay key and chain.

## Database settings

| Setting | Purpose |
|---|---|
| `journal_mode=WAL`, `synchronous=FULL` | Durable commits before request acknowledgment or transaction broadcast. |
| `locking_mode=EXCLUSIVE` | A second process opening the same database fails. The WAL index is held in process memory. |
| `foreign_keys=ON` | Transaction rows reference their accepted request. |
| `secure_delete=ON` | Overwrite freed content; opening fails if the setting cannot be enabled. |
| `journal_size_limit=0` | Truncate the WAL when SQLite resets it. |

The store also runs `wal_checkpoint(TRUNCATE)` at open, close, after signature purges and after retention deletes. This writes updated pages to the main database and removes old page images from the WAL.

## Records and identity

| Table | Contents |
|---|---|
| `requests` | Signed request fields (the intent nonce as a decimal string), status, outcome and settlement timestamps, intent signature, token authorization and its `auth_hash` (`hashStruct(TokenAuth)`, kept after the purge). |
| `transactions` | Signed calls and cancellations, nonce, gas/fee fields, hash and receipt information. |
| `kv` | Next transaction nonce, chain ID, relay address, GaslessTransfer deployment and lifetime gas exposure. |
| `gas_reservations` | Maximum native gas exposure reserved for each signer transaction nonce, retained independently of request pruning. |
| `schema_migrations` | Applied schema versions. |

A new database is bound to the chain, relay address and GaslessTransfer deployment on its first verified startup; the binding is kept in `kv`. A database bound to another chain, relay address or GaslessTransfer deployment is refused. The exclusive file lock does not prevent a second database or wallet from using the same relay key on the same chain; operators must prevent that.

Requests are unique on `(contract, signer, nonce)` among the requests that hold their nonce: every request except a `failed` or `expired` one whose outcome is settled, which can never execute, so its sender may sign that nonce again. A signer has at most one queued or in-flight request, and at most one pending permit or meta-transaction authorization per token. Requests reopened by a reorg are exempt from the last two indexes so recovery can restore them alongside a newer accepted request; new submissions remain blocked while either is pending.

`block_number` records the current inclusion and changes or clears after a reorg. `mined_at` records the first observed inclusion. `resolved_tx_hash` and `resolved_block` identify a provisional outcome, `settled_at` marks final settlement and `reopened_at` marks recovery after a reorg.

## Signature retention and purge

The store retains the intent signature (`signature`), token authorization (`auth_json`) and signed transaction (`raw`) while a request may need retransmission. Rejected submissions are not stored.

Signatures and signed transactions are set to NULL in the same transaction that settles the outcome:

- immediately for a request that ends before any broadcast, including queue expiry or displacement at its spend cap;
- after canonical finality for an outcome decided on-chain, including confirmation, revert or cancellation.

The purge is followed by a truncating WAL checkpoint. These measures remove the values from the active database files; they cannot erase filesystem snapshots, backups, copy-on-write storage or remapped SSD blocks. Protect and encrypt the database volume and its backups as sensitive material. Unused USDT0 meta-transaction approvals can remain valid indefinitely.

## Atomic admission

The final insertion runs in a synchronous SQLite transaction. It rechecks these guards in order:

1. **Identity:** an identical request returns its current state; different content for the same contract/signer/nonce conflicts, and so does a submission whose nonce another request took while it read the chain; a failed or expired request at the nonce whose outcome is not settled yet answers `sender_busy`.
2. **Queue capacity:** a full queue refuses a new row unless an eligible queued request held at its spend cap can be displaced. The candidate must have no stored transaction and no higher priority than the new request. Lowest cap, then oldest insertion, determines the candidate.
3. **Balance:** the balance read at block B must cover the new debit, pending debits and recorded inclusions above B.
4. **Sender occupancy:** pending token authorization, pending existing-allowance requests that a new authorization would overwrite, and any other queued or in-flight request of the sender (one per sender; GaslessTransfer executes a sender's requests in nonce order).
5. **Allowance:** existing-allowance mode must cover the new debit and the applicable pending/deferred debits.
6. **Retained-row capacity:** `RELAY_MAX_RETAINED_REQUESTS` counts all retained rows, including failed, settled and unsettled requests. At capacity, the longest-settled `failed` or `expired` request without any transaction whose deadline passed more than an hour ago is deleted with the insertion; without one, insertion returns 503 `unavailable`.

No candidate is displaced until every guard succeeds. Displacement and insertion commit together; the displaced request becomes `failed/fee_too_low`, with signatures purged. Its history row remains, so displacement does not free retained-row capacity. A retained-capacity refusal records `relay_admission_events_total{event="retention_full"}`, a deletion at capacity `relay_admission_events_total{event="unsent_history_dropped"}`.

The sender cool-down and displacement permission are checked synchronously immediately before the store call. Cool-down and spend-cap classification state are in memory only. After restart, the transaction manager rebuilds classifications through full checks; a full queue can return 503 until an eligible held request is known.

B is the newer of the latest block and the transaction manager's last completed head. Recorded inclusions at or below B are already reflected in the read; those above B must be counted separately. An unprocessed reorg can temporarily invalidate that accounting and lead to an accepted request that later reverts. The transaction manager reconciles these inclusions on subsequent passes.

## Retention and capacity

Settled `confirmed`, `failed` and `expired` requests and their transactions are deleted `RELAY_REQUEST_RETENTION_DAYS` after settlement (default 30 days, minimum 1). The transaction manager runs retention at most once a minute. Queued, in-flight and unsettled requests are not deleted.

One kind of row can go earlier, and only at the retained-row limit: a settled `failed` or `expired` request for which no transaction was ever signed, once its deadline is more than an hour past, gives way to a new request (see [Atomic admission](#atomic-admission)). Such requests cost their senders nothing, so they must not be able to hold the limit for the retention period. A deleted ID returns 404, and its intent is refused for its deadline if posted again.

`relay_request_rows` reports retained rows and `relay_requests_pruned_total` reports deletions after the retention period. Lowering the retained-row limit below an existing count blocks new insertions (except where such a row gives way) without truncating history. Duplicate requests, queries and processing of accepted work continue.

Freed space is zeroed and reused, but the main file does not automatically shrink. Capacity planning must cover SQLite/WAL bytes and backups in addition to row counts. If compaction is necessary, stop the relay cleanly and use compatible SQLite tooling; do not run maintenance against a live writer.

## Recovery, backups and migrations

Restart against the same database to recover accepted work and reconcile stored transactions with the chain. Do not delete state to clear a stuck nonce or restore an older copy after a newer database has processed requests.

Use the stopped-writer backup helper and restore procedure in [Linux operations](../../docs/operations/linux-relay.md). A live file copy can omit committed WAL data. Retain the complete, consistent state, including `kv` and `gas_reservations`, and protect the backup's signing material. A backup checksum proves content integrity, not that it is the latest state. Before a restore or key rotation, reconcile outstanding transactions and requests; never reset the database to regain gas budget.

Schema migrations are append-only and applied at startup: a new database receives every migration, up to the current schema version 7, in one transaction. A database with any other schema version, newer or older, is refused. Migration 4 requires SQLite 3.35 or newer; the pinned SQLite dependency satisfies that requirement. Keep a consistent protected backup before upgrading the relay.

See [Transaction lifecycle](transaction-lifecycle.md) for settlement and nonce recovery.
