# GaslessTransfer relay

The relay accepts signed USDC and USDT0 transfer intents, validates them and submits `GaslessTransfer.relayTransfer` on Polygon. It pays gas in POL and receives the fee specified by the sender in the transferred token.

Clients supply the signed request and token authorization. The relay constructs the call from the configured contract and SDK ABI; it does not accept client-supplied calldata, targets or gas settings. The API types are defined in `sdk/src/relay/types.ts`.

## Running

Build and check the self-hosted image from the repository root:

```sh
make relay-image-check
```

The image runs as UID 1000. Mount a verified deployment record and a readable key file as read-only inputs, and persistent storage at `/data`. Use a read-only root filesystem, bounded `/tmp`, explicit CPU/memory/PID limits, dropped capabilities and `no-new-privileges`. Keep the public listener behind a TLS proxy and the operations listener private.

| Image setting | Default |
|---|---|
| Entrypoint | `node dist/main.js`, working directory `/app` |
| Key file | `/run/secrets/relay_key` |
| Database | `/data/relay.sqlite` |
| Gas table | `/app/config/gasTable.json` |
| Public listener | `0.0.0.0:8080` |
| Operations listener | `127.0.0.1:9464` |

Set the required variables below before starting the image. Use one relay process and one durable database per relay key and chain; the same key may serve another chain from its own process and database. File permissions must let UID 1000 read the key without granting access to other users. Docker secret defaults may need an explicit UID and mode.

For native Linux, use the pinned build helper described in [deployment](../docs/deployment.md), then run `node relay/dist/main.js` with absolute configuration paths. Build and container instructions are in [development](../docs/DEVELOPMENT.md).

### Local stack

```sh
make stack-up
make stack-test
make stack-down
```

The local stack uses Anvil, mock tokens and public development keys on an internal Docker network. It publishes no host ports. Its chain and volumes are disposable; `stack-down` removes the stack volumes. Do not use its keys or database for funded deployments.

### Startup and shutdown

Startup validates configuration, key, gas table and deployment; checks every RPC's chain ID; verifies contract/token configuration; checks that every RPC serves the state of older blocks (see [RPC history](#rpc-history)) and logs which RPCs serve `eth_getBlockReceipts`; opens and locks SQLite; binds the database to the chain, relay address and GaslessTransfer deployment; reconciles transaction nonces; and starts the transaction manager and the token-domain monitor. The operations listener opens before the public listener. A failed startup check exits with status 1.

A changed token domain permits startup in a degraded state, with that token's signature-based authorization modes disabled. A key readable by other users produces a warning.

`SIGTERM` and `SIGINT` stop acceptance and the token-domain monitor, wait for the current transaction-manager pass, close SQLite and exit with status 0. Accepted requests are committed before acknowledgment, and signed transactions before broadcast. Restart with the same database to reconcile interrupted work.

## Configuration

All configuration comes from environment variables and files. An invalid value stops the relay at startup with a message that names the variable, not the value. Integers must be plain decimal integers within the given range.

A `RELAY_` variable that is set but that the relay does not use (a misspelt or unsupported name, or `RELAY_OPS_HOST` with `RELAY_OPS_PORT=off`) changes nothing: startup logs a warning that names it. `RELAY_PRIVATE_KEY` stops the relay at startup: the key is given as a file, never in the relay's environment.

### Required

| Variable | Description |
|---|---|
| `RELAY_RPC_URLS` | Comma-separated `http(s)` JSON-RPC URLs. Ordinary reads fail over in order (viem `fallback`: the first RPC that answers), and so do readiness, health, the end of a queued request before its first broadcast and the decision to cancel a request in flight (its deadline, a failed re-simulation, `fee_too_low`); every transaction is broadcast to all of them. The decisions that cannot be undone or that cost a transaction (a new tx nonce, a failure by invalidation, settling and purging, undoing a mined outcome, changing the relay's nonce range, the POL/USD price) ask every RPC on its own and need a positive answer from each of them, so one lying or lagging RPC cannot decide them; an RPC that does not answer delays them until it answers again or is removed. A URL listed twice (compared after normalizing scheme and host case, a default port and an empty path) stops startup, since that RPC would count twice. Use at least two independent providers in production, the most reliable one first: with one RPC a lying node cannot be detected, and the relay warns at startup on Polygon PoS. See [Several RPCs](docs/transaction-lifecycle.md#several-rpcs). Every RPC must serve the state of older blocks (an archive node, or one that keeps at least the [history window](#rpc-history)); startup refuses one that does not. `eth_getBlockReceipts` is used where an RPC serves it. Treat RPC URLs as credentials; logging removes URL tokens. |
| `RELAY_DEPLOYMENT_FILE` | Path to the deployment file (see [Deployment file](#deployment-file)). |
| `RELAY_PRIVATE_KEY_FILE` | Path to a file containing exactly one 32-byte hex private key, optionally with `0x`. Surrounding whitespace is ignored. Use a Docker secret. The image default is `/run/secrets/relay_key`. |
| `RELAY_TOKEN_PINS_FILE` | Path to the reviewed token implementation pins (see [Token implementation pins](#token-implementation-pins)). Required on Polygon mainnet (chain 137); optional on other chains. |

### Server and storage

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_HOST` | `0.0.0.0` | | Listen address of the public listener. |
| `RELAY_PORT` | `8080` | 1–65535 | Listen port of the public listener. |
| `RELAY_PRIVATE_KEY_FILE_REMOVE` | `false` | `true` or `false` | `true` deletes `RELAY_PRIVATE_KEY_FILE` as soon as startup has read the key; from then on the key exists only in the relay's memory. A file whose content startup refuses is deleted as well, and so is the file of a start that stops at a configuration error. Only for a temporary copy of the key; never for the only copy. If the file cannot be deleted (a Docker secret is mounted read-only), startup stops. |
| `RELAY_DB_PATH` | `data/relay.sqlite` | | SQLite database file (image: `/data/relay.sqlite`). The directory is created if missing. Put it on a persistent volume. |
| `RELAY_GAS_TABLE_FILE` | `config/gasTable.json` | | Gas table (see [Gas table](#gas-table)), relative to the working directory (image: `/app/config/gasTable.json`). |
| `RELAY_RPC_TIMEOUT_MS` | `5000` | 100–120000 | Timeout per RPC request, from sending it until the whole answer is read. |
| `RELAY_RPC_USAGE_LOG_SECONDS` | `300` | 0–86400 | Interval of the `rpc usage` log line (see [Metrics and alerts](#metrics-and-alerts)); `0` disables it. |
| `RELAY_RPC_HISTORY_CHECK_SECONDS` | `600` | 0–86400 | Interval of the check that every RPC serves the state of older blocks (see [RPC history](#rpc-history)); `0` checks at startup only. |
| `RELAY_LOG_LEVEL` | `info` | | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |

### Listeners, HTTP limits and readiness

The relay serves two listeners (see [Listeners](#listeners)): the public one (`RELAY_HOST:RELAY_PORT`) and an internal one for monitoring (`RELAY_OPS_HOST:RELAY_OPS_PORT`). The limits apply to each of them.

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_OPS_HOST` | `127.0.0.1` | | Listen address of the internal listener (`/healthz`, the full `/readyz` report, `/metrics`). The default is loopback because metrics and the readiness report are operator information: only processes on the same host (or in the same container) reach them. In a container, set `0.0.0.0` and keep the port on the monitoring network; never publish it. |
| `RELAY_OPS_PORT` | `9464` | 0–65535 or `off` | Port of the internal listener. `0` picks a free port (tests). `off` disables the internal listener, and with it `/metrics`. |
| `RELAY_HTTP_REQUEST_TIMEOUT_MS` | `15000` | 1000–120000 | A request, headers and body, must arrive within this time; a slower client gets 408 and is disconnected. The headers must arrive within the smaller of 5 s and this value. |
| `RELAY_HTTP_KEEP_ALIVE_TIMEOUT_MS` | `10000` | 1000–600000 | Idle keep-alive connections are closed after this time. Behind a load balancer that reuses connections, set it above the balancer's idle timeout. |
| `RELAY_HTTP_MAX_CONNECTIONS` | `1024` | 1–100000 | Open connections per listener, shared by all clients. Further connections are closed as soon as they are accepted (`relay_http_connections_refused_total`). |
| `RELAY_READINESS_CACHE_MS` | `5000` | 0–60000 | How long a readiness report is reused. Concurrent probes always share one check, also with `0`. So however often `/readyz` is requested, the relay makes at most one set of readiness RPC reads per period. The age of a report is measured on the monotonic clock: a step of the system clock neither keeps an old report nor shortens the period. |

Fixed limits: a connection without traffic in either direction for 60 s is closed (the validation deadline, `RELAY_VALIDATION_TIMEOUT_MS`, ends at least 5 s before that), bodies are limited to 16 KB, and the server checks the timeouts every second (Node's default is every 30 s, which would let a slow client hold a connection far longer than the configured timeout).

### HTTP access

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_RATE_LIMIT_SIGNER_MAX` | `10` | 1–1000000 | Submissions per signer (`request.from`) and window. A signer over the limit is refused once its intent signature is verified, before any RPC read. A submission is counted only when it passes step 4 of the [validation pipeline](#validation-pipeline), that is, when it could become a new request. Re-posts of an intent the relay already knows (answered with 200, `conflict` or `nonce_used`) are not counted, so nobody can use up another signer's quota by re-posting that signer's public intent. |
| `RELAY_RATE_LIMIT_SIGNER_WINDOW_SECONDS` | `60` | 1–86400 | Window of the per-signer limit. |
| `RELAY_RATE_LIMIT_SUBMIT_MAX` | `120` | 1–1000000 | Submissions that read the chain, relay-wide, per window. Counted once the intent signature is verified and the signer is within its limit, right before the first RPC read; beyond it a submission gets 503 `unavailable` and nothing is stored. It bounds what forged or failing submissions cost in reads from the RPC providers that the transaction manager also needs; it does not share the capacity out between clients. |
| `RELAY_RATE_LIMIT_SUBMIT_WINDOW_SECONDS` | `60` | 1–86400 | Window of the relay-wide submission limit. |
| `RELAY_MAX_CONCURRENT_VALIDATIONS` | `4` | 1–256 | Submissions reading the chain at the same time, relay-wide. A further one waits for a slot, in arrival order, for at most half of `RELAY_VALIDATION_TIMEOUT_MS`; at most four times as many wait. Beyond that, or when the wait ends without a slot, it gets 503 `unavailable`, and nothing is stored. |

The public listener answers cross-origin requests from every origin (`Access-Control-Allow-Origin: *`, methods GET and POST, request header `content-type`), so self-hosted Wallet, Hub and Keyguard instances can use the relay. Requests carry no credentials, and the signed intent, not the origin, authorizes a transfer. The internal listener sends no CORS headers.

The relay does not tell clients apart by their network address: no limit keys on it, no proxy header (`X-Forwarded-For`, `X-Real-IP`) is read, and no address is logged or stored. Every request is bounded by the signer it names or relay-wide. A proxy in front of the relay may log client addresses on its own; that is outside the relay.

### Admission and validation

Retained request history also has a finite capacity: `RELAY_MAX_RETAINED_REQUESTS` defaults to 100000 (range 1–10000000). All request rows count, including failed, settled, and unsettled requests. At the limit, a new request takes the place of the longest-settled request that was never sent (it failed or expired before any transaction was signed for it) and whose deadline passed more than an hour ago: by then its outcome has been read, its intent cannot be accepted again, and nothing of it is on chain. Requests that end before the broadcast cost their senders nothing, so without this they could fill the limit and close the relay for the whole retention period; `relay_admission_events_total{event="unsent_history_dropped"}` counts these deletions. Without such a request, a new submission returns 503 `unavailable` (before its RPC reads, and again at step 9), and no held request is displaced: the history of requests that had a transaction is never deleted early. Identical stored submissions, status queries, quotes, and processing of accepted requests continue. Normal retention removes settled requests after its configured period (30 days by default); unsettled requests are never deleted. Lowering the limit below an existing database's row count refuses new inserts until capacity becomes available; it does not truncate the database. `relay_admission_events_total{event="retention_full"}` counts these refusals. Size this limit for the expected retention window and available storage, and monitor `relay_request_rows` and disk use. It limits request rows, not transaction-attempt bytes or unrelated files, and intentionally trades new-request availability for preserving recovery state.

While the transaction manager cannot send, a new submission gets 503 `unavailable` before any RPC read, and nothing is stored: the request would only wait in the queue until its deadline, after its sender signed it. That is the case for every `reasons` entry of its [health](docs/transaction-lifecycle.md#health) once a first pass has completed: no POL, the gas budget reached, no recent pass, an old head block, a nonce gap, lagging finality or a stalled queue. Identical stored submissions, status queries and quotes continue. `relay_admission_events_total{event="cannot_send"}` counts these refusals; the internal readiness report names the reason.

A sender (`request.from`) has at most one request queued or in flight, across tokens and operations: GaslessTransfer executes a sender's requests in nonce order, and the relay accepts only the sender's next nonce. Another request at that nonce gets 409 `conflict`, one at a higher nonce 409 `nonce_too_high`, and one at the next nonce while an earlier request is still pending (its nonce was invalidated meanwhile) 409 `sender_busy`.

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_MAX_QUEUED` | `100` | 1–100000 | Queued requests in total (in flight does not count). In a full queue, a submission that passes every check takes the place of a queued request held at its spend cap, if there is one: the one with the lowest cap, then the oldest, which ends `failed` with `fee_too_low` (see [Validation pipeline](#validation-pipeline), step 9). One sender does so one at a time: not again while its request that took a held place waits for its first broadcast, and not while it cools down (`RELAY_PREFLIGHT_COOLDOWN_SECONDS`). Otherwise a submission gets 503 `unavailable` before any RPC read, and nothing is stored; retry later with the same body. Quotes and status queries keep working. The queue is shared: a party with many funded senders can fill it. |
| `RELAY_PREFLIGHT_COOLDOWN_SECONDS` | `600` | 0–86400 | After a request of a sender failed its check before the broadcast for a reason the sender controls (the intent nonce was used, the allowance lowered, the token authorization used elsewhere, the funds moved away), for this long a further submission of that sender, while it has a request queued or in flight, gets 429 `rate_limited` before any RPC read (every sender has at most one pending request; without the cool-down it would get 409 after the reads, step 4 or 7). For this long it also makes no request held at its spend cap give way: in a full queue it gets 503 `unavailable`. A later such failure restarts the period. `0` turns the cool-down off. Kept in memory only; a restart forgets it. |
| `RELAY_VALIDATION_TIMEOUT_MS` | `10000` | 1000–55000 | Overall bound of the RPC reads of one `POST /v1/transfer`. When it has passed, the answer is 503 `unavailable` ("nothing was stored"), and nothing is stored, also if a read answers later. The maximum keeps the answer 5 s ahead of the 60 s idle timeout; the default stays below the SDK's 15 s request timeout. |

### Price and fees

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_POLUSD_FEED` | `default` | | `default` uses Chainlink POL/USD `0xAB594600376Ec9fD91F8e885dADF0CE036862dE0` on chain 137. Other chains require an explicit aggregator address. Disabling the oracle is not supported, and neither is a static price: `RELAY_POLUSD_FALLBACK` stops startup. |
| `RELAY_PRICE_CACHE_SECONDS` | `30` | 0–3600 | How long a feed reading is reused, measured on the monotonic clock (a step of the system clock does not change it). |
| `RELAY_FEE_CACHE_MS` | `2000` | 0–60000 | How long base fee and tip data are reused, measured on the monotonic clock. Pricing is checked separately through the oracle cache. |
| `RELAY_FEE_MARGIN_BPS` | `1000` | 0–10000 | Quote margin in basis points (1000 = 10%). |
| `RELAY_MIN_TIP_GWEI` | `30` | decimal gwei > 0 | `MIN_TIP`: lower bound of the priority fee, for quotes and for transactions. It must be greater than 0: with 0, a chain or RPC reporting a base fee of 0 would make break-even, and with it an acceptable fee, 0. On Polygon PoS (137) and Amoy (80002) it must be at least 25, because Bor refuses lower priority fees; this is checked once the deployment file is read. |
| `RELAY_MIN_POL_BALANCE` | `1` | decimal POL | Readiness threshold for the relay's POL balance. Below it the alert monitor raises `pol_empty`. |
| `RELAY_RECIPIENT_DENYLIST` | *(empty)* | | Extra recipient addresses to reject, comma-separated. They are added to the built-in D11 denylist: zero address, the contract, the tokens and the built-in legacy addresses. |

### Transaction manager

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_TOTAL_GAS_BUDGET_POL` | `1` | positive decimal POL | Lifetime ceiling of the gas cost the relay may commit to (see [Durable aggregate gas budget](#durable-aggregate-gas-budget)). A request whose reservation would exceed it is not broadcast, and readiness fails, until the operator raises it. |
| `RELAY_POLL_INTERVAL_MS` | `2000` | 100–49000 | Time from the end of one pass to the start of the next. A newly queued request starts the next pass sooner, at least 500 ms after the previous one ended. A request accepted with the shortest deadline (60 s) must still be sendable at the first pass after its acceptance, so this, in seconds and rounded up, plus `RELAY_MIN_SECONDS_TO_BROADCAST` plus 10 s must not exceed 60 (see below). |
| `RELAY_SPEEDUP_AFTER_BLOCKS` | `10` | 1–1000 | Blocks without inclusion before a speed-up. Only the transaction at the next nonce the chain can include is sped up; one behind a lower nonce that is not included keeps its fees until its nonce is next. |
| `RELAY_SPEEDUP_PERCENT` | `20` | 10–100 | Fee increase per speed-up, applied to both fee fields. Nodes need at least 10% to accept a replacement. |
| `RELAY_MAX_FEE_PER_GAS_GWEI` | `3000` | decimal gwei > 0, ≥ `RELAY_MIN_TIP_GWEI` | `MAX_FEE_PER_GAS` cap. Nothing is broadcast while `baseFee + tip` exceeds it. |
| `RELAY_MAX_IN_FLIGHT` | `4` | 1–64 | Maximum relay transactions in flight (requests submitted but not yet mined). A request whose tx nonce the chain already used, while the relay waits for its receipt or a decision, holds none. |
| `RELAY_RESERVED_PRIORITY_SLOTS` | `1` | 0–63 | In-flight slots reserved for priority operations. It must be smaller than `RELAY_MAX_IN_FLIGHT`. |
| `RELAY_MAX_GAS_LIMIT` | `1000000` | 21000–30000000 | Upper bound of any gas limit, also of the gas table entry. |
| `RELAY_GAS_LIMIT_MARGIN_PERCENT` | `30` | 10–200 | Margin on `eth_estimateGas`. The gas limit is `min(estimate × (1 + margin), gas table entry, RELAY_MAX_GAS_LIMIT)`, or the gas table entry if estimation fails. An estimate above the gas table fails the request with `simulation_failed`. |
| `RELAY_MAX_COST_PERCENT_OF_FEE` | `200` | 100–10000 | Spend cap: `gas limit × maxFeePerGas` of a call may be at most this percentage of the request's fee, at the POL/USD price when the call is signed (a call re-sent unchanged keeps the price of its signature; see "Gas limit and spend cap" in [docs/transaction-lifecycle.md](docs/transaction-lifecycle.md)). Speed-ups stop at the cap; a request priced out waits, or is cancelled with `fee_too_low` if it holds up others. Cancels and nonce fillers are exempt. |
| `RELAY_MIN_SECONDS_TO_BROADCAST` | `10` | 0–48 with the default poll interval | A queued request whose deadline is closer than this (by chain time) expires instead of being broadcast. Must be larger than `RELAY_DEADLINE_SAFETY_SECONDS`. This value plus `RELAY_POLL_INTERVAL_MS` in seconds (rounded up) plus 10 s (a new block and a long pass) must not exceed 60, the shortest deadline the relay accepts, so that a request is still sendable at the first pass after its acceptance: at most 48 with the default 2 s poll interval. With more, the relay would accept requests that it then lets expire unsent; it refuses to start instead, naming the variable. |
| `RELAY_DEADLINE_SAFETY_SECONDS` | `2` | 0–600 | An in-flight request is cancelled once `head.timestamp + this ≥ deadline`. Must be smaller than `RELAY_MIN_SECONDS_TO_BROADCAST`. |
| `RELAY_FINALITY_FALLBACK_DEPTH` | `256` | 1–100000 | Confirmation depth used when an RPC does not answer the `finalized` block tag; never less than `RELAY_MIN_FINALITY_DEPTH`. At least 16 on Polygon PoS (137) and Amoy (80002): the relay refuses to start otherwise. |
| `RELAY_MIN_FINALITY_DEPTH` | `16` | 0–10000 | An outcome is final only at or below `min(finalized tag, head − this)`, and only while its block is still canonical. At least 16 on Polygon PoS (137) and Amoy (80002), as the [protocol reference](../docs/STEP-1-GAS-ABSTRACTION.md) §6.5 requires; lower values are for local chains. |
| `RELAY_UNKNOWN_NONCE_GRACE_BLOCKS` | `12` | 1–10000 | Blocks to wait when a stored transaction's nonce was used but no receipt of the request is visible, and between two searches after that. Then every RPC is asked: the request's intent nonce unused on all of them means a new tx nonce once that is final; for a used intent nonce, each RPC locates the block that used it from its own state and shows what in it did (the successful receipt of the relay's call of the request, read with `eth_getBlockReceipts` or on its own: `mined`; the sender's `NonceInvalidated` covering it, or another request of the sender executing at it: `failed` with `nonce_used`; that block after the request's deadline: `expired`; anything else, including the relay's call listed without a receipt: wait, with an ALERT). The RPCs must serve the state of older blocks (`eth_call` at a block number, from the head down to about as far below the block that used the nonce as that block is below the head, never below the deployment file's `deployBlock`; see [RPC history](#rpc-history)); one that does not holds these decisions back. See "Nonces" in [docs/transaction-lifecycle.md](docs/transaction-lifecycle.md). |
| `RELAY_NONCE_GAP_BLOCKS` | `20` | 1–10000 | Blocks the chain's nonce may stay below the lowest in-flight relay nonce before the unused nonces are filled with 0-value self-transfers. |
| `RELAY_REQUEST_RETENTION_DAYS` | `30` | 1–3650 | Settled requests are deleted this long after their outcome became final. |
| `RELAY_STUCK_AFTER_BLOCKS` | `150` | 10–1000000 | Readiness fails (`stalled`) when requests wait to be sent but no relay transaction was broadcast, sped up or included, and no queued request ended in its check before the broadcast, for this long; a backlog older than this is reported as degraded (`backlog`), and a decision that waits this long for the RPCs to agree raises an ALERT. |
| `RELAY_MAX_FINALITY_LAG_BLOCKS` | `600` | 16–1000000 | Readiness reports a `finalized` tag further behind head than this. |

### Token-domain monitor

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_TOKEN_DOMAIN_CHECK_SECONDS` | `60` | 0–86400 | Interval of the token domain check (see [Monitors](#token-domain-monitoring)). `0` disables it: the readings of startup verification then stay as they are until the next restart, so a mismatch found at startup keeps the relay `degraded` (and that token's permit and meta-tx refused) until then, even if the rename is reverted, and a change while the relay runs is not noticed. |

### Alert monitor

| Variable | Default | Range | Description |
|---|---|---|---|
| `RELAY_ALERT_WEBHOOK_URL` | *(unset)* | `https` URL without user name or password | Where the [alert monitor](#alert-monitoring) posts its messages, as `{"text": "…"}` JSON (the body incoming chat webhooks accept). The URL is a credential: keep it in a secret store; the relay never logs it. Unset: alerts are only logged. |
| `RELAY_ALERT_POL_BALANCE` | 2 × `RELAY_MIN_POL_BALANCE` | decimal POL, ≥ `RELAY_MIN_POL_BALANCE` | Warning level of the balance alert (`pol_low`): set it so that the time from this level to the minimum is enough to top up. |

## Files

### Deployment file

`RELAY_DEPLOYMENT_FILE` is the output of the contracts deployment scripts (`contracts/deployments/<chainId>.json`, written by `DeployGaslessTransfer` for 137, `DeployAmoyDryRun` for 80002 and `DeployLocalStack` for 31337):

```json
{
  "chainId": 137,
  "version": "3",
  "gaslessTransfer": "0x…",
  "initialOwner": "0x…",
  "deployBlock": "…",
  "tokens": [
    {
      "symbol": "USDC",
      "address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "decimals": 6,
      "authModes": ["permit", "none"],
      "domain": { "name": "USD Coin", "version": "2", "chainId": 137, "verifyingContract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" }
    },
    {
      "symbol": "USDT0",
      "address": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      "decimals": 6,
      "authModes": ["permit", "metaTxApprove", "none"],
      "domain": { "name": "USDT0", "version": "1", "verifyingContract": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "salt": "0x0000000000000000000000000000000000000000000000000000000000000089" }
    }
  ]
}
```

`version` is the contract's EIP-712 domain version: a record without `"version": "3"` stops startup. The committed `contracts/deployments/137.json` and `contracts/deployments/80002.json` are the records of the GaslessTransfer deployments on Polygon and Amoy ([deployment](../docs/deployment.md)).

The parser accepts the following:

- `deployBlock` as a decimal string or a safe integer. It must be at or below the block that created the contract: the search for the use of an intent nonce reads no state below it (the deployment verifier checks this, see [deployment](../docs/deployment.md)). `initialOwner` is optional and informational.
- Addresses in lower case or in valid EIP-55 mixed case (a wrong checksum is an error).
- `authModes` as SDK names (`permit`, `metaTxApprove`, `none`), contract enum names (`PERMIT`, `META_TX_APPROVE`, `NONE`) or enum values (`1`, `2`, `0`).
- A token's expected `domainSeparator` (optional, as in the SDK's record format); it must be the hash of `domain`.

It rejects the following:

- A missing `version` or one other than `"3"`.
- Unknown keys in the record or in a token entry: the keys are exactly those above, as in the SDK's `pinsFromDeployment`.
- Duplicate tokens or duplicate modes.
- Modes a token does not support. USDC supports {permit, none}; USDT0 supports {permit, metaTxApprove, none}.
- A domain whose `verifyingContract` is not the token.
- A domain `chainId` or `salt` that does not match `chainId`, or a domain with neither.
- Unknown domain fields.

### Startup verification

Before it serves anything, the relay compares the deployment file with the chain. Every mismatch is reported, and the relay exits:

- The RPC chain id equals `chainId`.
- `gaslessTransfer` has code. `DOMAIN_SEPARATOR()` equals ("Nimiq Gasless Transfer", "3", chainId, contract).
- For every token:
  - The token has code.
  - `decimals()` matches.
  - The contract's `tokenConfig(token)` matches `authModes`.
- On chain 137, every token must also match the SDK pins (address, symbol, domain, modes).
- Every RPC serves the state of the history window (see [RPC history](#rpc-history)).

A token-domain mismatch starts the relay in a degraded state: that token's permit and meta-transaction modes are refused, while existing-allowance mode and other tokens remain available. The token-domain monitor starts from these readings (see [Monitors](#token-domain-monitoring)).

The contract's owner can change a token's configuration (`setTokenConfig`: its modes, or removing the token). The relay reads it only at startup. After a change, update the deployment file (and, on chain 137, the SDK pins) and restart; the old file stops startup. Until then the running relay keeps accepting the old modes: a request for a removed token or mode fails its simulation (`simulation_failed` at submission, `unsupported_token` or `unsupported_auth_mode` before the broadcast) and costs the relay nothing; one already broadcast reverts. On-chain such a refusal is not final: a later change that adds the token or mode again makes the signed request executable again until its deadline.

The relay and the SDK serve only the 6-decimal USD stablecoins USDC and USDT0: the deployment parser accepts no other symbol or `decimals`, and the fee engine prices a fee token as 1 USD. Any other token the owner adds on-chain needs relay and SDK changes (decimals, a price source for the token, `MIN_FEE` and the fee granularity) before it can be served.

### Gas table

`RELAY_GAS_TABLE_FILE` holds the gas units per operation and authorization mode, with the margin already included. The entries of the committed `config/gasTable.json` come from a Polygon-native read-only state-override measurement at block 94,503,409 (the `source` string), with at least a 10% margin, then rounding up to 5,000 gas:

```json
{ "source": "polygon-rpc-state-overrides@94503409;ceil5000", "margin": 0.10, "operations": { "transfer": { "permit": 280000, "metaTxApprove": 280000, "none": 210000 } } }
```

- GaslessTransfer was measured with the same flow (`POLYGON_NATIVE_GAS=true FORK_BLOCK=94977066 POLYGON_RPC_URL=<archive RPC with historical state overrides> make test-gas-calibration`, see [deployment](../docs/deployment.md)) at block 94,977,066 before its deployment: the largest need with the 10% margin is 269,925 gas (USDT0 meta-tx approval with a fresh allowance slot), USDC permit 263,932 and the existing-allowance modes at most 200,053, so the entries hold.
- Anvil/Foundry gas measurements do not implement Polygon's Chicago pricing and must not replace the production table.
- Re-measure the table after a contract, token, or chain gas-schedule change. Validate it against the intended chain state before deployment; a historical measurement is not a permanent gas bound.
- Every mode of every configured token must have an entry, or the relay does not start.
- A table whose `source` is `placeholder` makes the relay log a warning at startup.

### Database

The SQLite database uses WAL mode, `synchronous=FULL`, foreign keys and `locking_mode=EXCLUSIVE`. It has four tables, plus `schema_migrations` ([docs/storage.md](docs/storage.md) has the details):

- `requests`: one row per accepted request. It is unique on `(contract, signer, nonce)` among the requests that hold their nonce, with one queued or in-flight request per signer, at most one pending permit or meta-tx per `(token, signer)`, and each relay tx nonce belongs to at most one request.
- `transactions`: every signed transaction of a request (its call, speed-ups and cancel), keyed by hash. They share the request's tx nonce.
- `kv`: the next tx nonce, the chain id, relay address and GaslessTransfer deployment the database belongs to, and the lifetime gas exposure.
- `gas_reservations`: the largest native gas exposure reserved per relay tx nonce (the lifetime gas budget, see [Durable aggregate gas budget](#durable-aggregate-gas-budget)); never pruned.

Schema migrations are applied at startup: a new database receives the current schema, version 7. A database with any other schema version, newer or older, is refused ([docs/storage.md](docs/storage.md#recovery-backups-and-migrations)).

## HTTP API

The wire types are in `sdk/src/relay/types.ts`. Integers are canonical decimal strings, addresses are EIP-55 checksummed, and errors look like `{"error": {"code": "…", "message": "…"}}`. Status codes follow `ERROR_HTTP_STATUS` in that file. The SDK's `RelayClient` validates responses against these types.

### Listeners

| Listener | Address | Routes |
|---|---|---|
| Public | `RELAY_HOST:RELAY_PORT` (image: `0.0.0.0:8080`) | `/v1/*`, `/healthz`, and `/readyz` with the status code and `{ready, degraded}` only. |
| Internal | `RELAY_OPS_HOST:RELAY_OPS_PORT` (default `127.0.0.1:9464`) | `/healthz`, `/readyz` with the full report, and `/metrics`. No CORS. |

`/metrics` (fee revenue, the POL balance, error counters) and the full readiness report (the POL balance, RPC error messages, the transaction manager's state) are operator information, so they are served only on the internal listener. Load balancers and health checks should probe the internal `/readyz`. Neither listener limits requests by client address (see [HTTP access](#http-access)): the reads behind `/readyz` are shared through `RELAY_READINESS_CACHE_MS`, quotes through `RELAY_FEE_CACHE_MS` and the price cache (a failed refresh of either is answered again for up to 1 s without new reads), and submissions are bounded per signer and relay-wide. Both apply the server limits of [Listeners, HTTP limits and readiness](#listeners-http-limits-and-readiness): a request that does not arrive completely within `RELAY_HTTP_REQUEST_TIMEOUT_MS` gets 408 and its connection is closed; headers must arrive within 5 s; idle and silent connections are closed; connections beyond `RELAY_HTTP_MAX_CONNECTIONS` are closed on accept.

### Routes

| Route | Description |
|---|---|
| `GET /v1/info` | Chain id, relay address (clients put it into `request.relay`), contract domain (version `"3"`) and token domains, auth modes, and deadline and quote policy. |
| `GET /v1/fee?operation=transfer&token=<address>&authMode=<mode>` | Fee quote: `fee` (a multiple of 0.01, with no upper bound, see [Fees](#fees)), `gasUnits`, `gasPrice`, `polUsd`, `issuedAt`/`expiresAt` (120 s, a hint only) and `quoteId`. Returns 503 `unavailable` when the chain is unreachable. Returns 400 `unsupported_auth_mode` for `permit` and `metaTxApprove` of a token whose EIP-712 domain changed on-chain (see [Monitors](#token-domain-monitoring)). |
| `POST /v1/transfer` | Body `{request, signature, authorization, quoteId?}`. `request.nonce` is the sender's intent nonce as a decimal string; the signature covers the request and the token authorization (mode `none`: `v`, `r` and `s` zero). Returns 202 `{id, status: "queued"}`. An identical re-post returns 200 with the current status. A nonce below the sender's next one returns 409 `nonce_used`, one above it 409 `nonce_too_high`; at the next nonce, another pending request with different content returns 409 `conflict`. 409 `sender_busy`, 409 `nonce_too_high`, 429 `rate_limited` and 503 `unavailable` are retryable, and nothing was stored for them (see [Validation pipeline](#validation-pipeline)); after a network error, re-post the same body: the answer is the stored state if the first post was accepted. `id` is the EIP-712 digest of the request at its nonce with its token authorization, which equals the contract's `hashTransfer(r, nonce, auth)`. |
| `GET /v1/requests/:id` | `{id, operation, status, request, authHash, transactions, txHash, blockNumber, error}`. `authHash` is `hashStruct(TokenAuth)` of the request's token authorization: with `request` it hashes to `id`, without revealing the token signature. `status` is `queued`, `submitted`, `mined`, `confirmed`, `failed` or `expired`. `txHash` is the included transaction, also after a speed-up. The id is accepted in any hex case. |
| `GET /healthz` | Liveness: `{"status":"ok"}` while the process serves HTTP. Both listeners. |
| `GET /readyz` | 200 when ready, otherwise 503. Public response: `{ready, degraded}`. Internal response adds `checks: {tokenImplementations, rpc, balance, priceSource, txManager, tokenDomains, rpcHistory}` (`tokenImplementations` only with `RELAY_TOKEN_PINS_FILE`). Checks include token implementation pins, RPC chain/reachability, POL balance, usable price and transaction-manager health (including the gas budget). Degraded conditions include token-domain mismatch, backlog, spend-cap holds and an RPC that fails the history check; they do not alone make the relay unready. See [Health](docs/transaction-lifecycle.md#health). Concurrent probes share the cached report (`RELAY_READINESS_CACHE_MS`). |
| `GET /metrics` | Prometheus metrics (see [Metrics and alerts](#metrics-and-alerts)). Internal listener only; 404 on the public one. |

- Only `application/json` bodies are accepted, with a limit of 16 KB.
- Unknown fields are rejected at every level.
- `text/plain` bodies are rejected, so a cross-origin "simple request" cannot submit.
- `quoteId` is optional: 1–256 characters, the same rule as the SDK. It is a hint only; it is never used for acceptance, stored or logged.
- Routes match exactly. There are no redirects: a trailing slash or a double slash is a 404 `not_found`.

## Validation pipeline

`POST /v1/transfer` runs these steps in order. The first failure returns its code, and nothing is stored for a rejected request.

| # | Step | Error codes |
|---|---|---|
| 1 | Strict schema. Canonical decimal strings (`0` or no leading zeros, ≤ 2^256−1, also the nonce), checksummed addresses, a hex signature, an authorization of `{mode, v, r, s}` (mode `none` with `v`, `r` and `s` zero), and `quoteId` of 1–256 characters. | `invalid_request` |
| – | Idempotency lookup (not a check). If the same request id (the request at its nonce with its token authorization) was already accepted with the same signature, return 200 with the current status. | — |
| 2 | Policy. `relay` is this relay. The token and mode are supported. `amount > 0` and `amount + fee ≤ 2^256−1`, the SDK's rule. The recipient is not on the denylist. `now+60 ≤ deadline ≤ now+7200` (wall clock). The fee has no upper bound (GaslessTransfer has no maximum fee). For `permit` and `metaTxApprove`: the token's EIP-712 domain has not changed on-chain (see [Monitors](#token-domain-monitoring)); the message says so and suggests mode `none`. | `wrong_relay`, `unsupported_token`, `unsupported_auth_mode`, `invalid_amount`, `invalid_recipient`, `deadline_out_of_range` |
| 3 | Intent signature over the request, its nonce and the token authorization (the EIP-712 `GaslessTransfer` with the nested `TokenAuth`, domain version `"3"`). Exactly 65 bytes; canonical ECDSA (`v` ∈ {27, 28}, `0 < r < n`, `0 < s ≤ n/2`); recovers to `from`. A changed token authorization changes the digest, so a copied request cannot be posted with another one. | `invalid_signature` |
| – | Per-signer rate limit: a signer that used up its window is refused here, before any RPC read. | `rate_limited` |
| – | Sender cool-down: after a failure the sender caused (`RELAY_PREFLIGHT_COOLDOWN_SECONDS`), a submission of the sender while it has a request queued or in flight is refused here, before any RPC read, and again right before the insert. | `rate_limited` (429) |
| – | Queue bound: while `RELAY_MAX_QUEUED` requests are queued, the submission is refused here, before any RPC read, unless some of them are held at their spend cap and its sender may make one give way now: it has no queued request that took a held place and still waits for its first broadcast, and it does not cool down. Then it goes on, and at step 9 one of them gives way. | `unavailable` (503) |
| – | Relay-wide bounds, right before the first RPC read: `RELAY_RATE_LIMIT_SUBMIT_MAX` per window, and at most `RELAY_MAX_CONCURRENT_VALIDATIONS` submissions reading the chain at a time (a further one waits for a slot, see the variable). | `unavailable` (503) |
| 4 | Nonce, read at block B (see step 6). The sender's next nonce is `nonces(from)` at B, raised past the sender's requests the relay recorded as included in a block after B. Below it the nonce is used (executed or invalidated) and can never succeed again, also after its own request was mined; above it the request could execute only after requests at the nonces in between. At the next nonce, while B does not yet show the sender's request the relay recorded as included after it, the answer is `sender_busy` (retry in a few seconds). Then the database: another request holding this nonce is a `conflict` (a failed or expired one whose outcome is not settled: `sender_busy`), and an identical one returns 200. A submission that passes this step is counted against the signer's rate limit; the answers above are not. | `nonce_used`, `nonce_too_high`, `sender_busy`, `conflict`, `rate_limited` |
| 5 | Fee acceptance: `fee ≥ max(MIN_FEE, breakEven(now))`, as quotes are. `MIN_FEE` (0.01) is the smallest quote, so every accepted request covers the current gas price. It is paid only when the request is mined: it does not make a full queue cost anything (see [Operations](#operations)). The quote is only a hint. | `fee_too_low` (402) |
| 6 | Balance and token state, read at block B: the newer of the transaction manager's newest head and the latest block. Requests the relay recorded as included in a block after B are not in that state; step 9 counts them, by block number. `balanceOf(from) ≥ amount + fee + pending debits`. USDC: `paused()`, and `isBlacklisted` for from, to, relay and contract. USDT0: `isBlocked` for from, relay and contract. A node that does not have block B answers with an error. | `insufficient_balance`, `token_paused`, `blocked_address`, `unavailable` |
| 7 | First `sender_busy`, in this order: another permit or meta-tx request of `from` for this token that is pending, or that the relay recorded as included in a block after B (its token nonce and the allowance it set and used are not in the reads at B; step 9 checks this again); for a permit or meta-tx, a pending NONE request of `from` for this token (the new authorization would overwrite the allowance that request relies on); any other queued or in-flight request of `from` (one per sender; reached when the sender invalidated the nonce of its pending request). Then the token authorization at block B. Permit or meta-tx: rebuild the token typed data with the live token nonce, `spender` = contract and `value` = amount + fee (permit `deadline` = intent deadline), and check that the canonical signature recovers `from`. NONE: `allowance(from, contract) ≥ amount + fee + pending NONE debits`. | `sender_busy`, `invalid_token_authorization`, `insufficient_allowance` |
| 8 | Simulation at block B: `eth_call` of the exact `relayTransfer(r, signature, auth)` call from the relay account (the call carries no nonce: the contract verifies the signature over `nonces(from)`). The revert is decoded with the contract ABI (including the OpenZeppelin errors) and reported in the message, for example `InsufficientAllowance(0, 1010000)`. | `simulation_failed` |
| 9 | Atomic insert. The sender's cool-down is checked again. One SQLite transaction re-checks the idempotency key and the nonce holder, the queue bound, the balance and allowance reservations, and the three `sender_busy` conditions, then stores the request as `queued`. A refusal of steps 6 to 9 that another request stored at this nonce meanwhile caused (its debit, or one pending request per sender) is reported as `conflict`. The reservations count the sender's pending requests and those included in blocks after B (by block number; a reorg that moves or removes an inclusion updates it): the balance and allowance read at B do not reflect them yet. In a full queue, the queued request held at its spend cap with the lowest cap per gas (among equal caps the oldest) gives way in the same transaction, once every other check has passed: it ends `failed` with `fee_too_low`, final at once because nothing of it was broadcast. Only a request that was never broadcast and has no higher priority than the new one can give way, and only if the sender may make one give way now (checked again here, see the queue bound); otherwise the answer is 503. | `rate_limited`, `conflict`, `insufficient_balance`, `insufficient_allowance`, `sender_busy`, `unavailable` |

The sender cool-down is rechecked synchronously with insertion. Queue, balance, sender-busy, allowance and retained-row guards are rechecked in the same SQLite transaction; a rejected insertion does not displace a held request. See [Storage](docs/storage.md#atomic-admission).

Validation stops when its time budget expires or the HTTP connection closes before insertion. A connection can still fail after a request has been committed: after a network error, clients must repost the same body or reconcile its outcome rather than assume nothing was accepted.

## Fees

The fee engine (§6.4) does not use a DEX:

```
tip       = max(eth_maxPriorityFeePerGas, MIN_TIP)
priceGas  = ceil(1.5 × baseFee) + tip
breakEven = ceil(gasUnits × (baseFee + tip) × POLUSD)                    in 6-decimal token units
quote     = roundUp_0.01(max(0.01, gasUnits × priceGas × POLUSD × (1 + margin)))
```

- A submission is accepted when `fee ≥ max(MIN_FEE, breakEven(now))`, the same floor as quotes (`MIN_FEE` = 0.01). Quotes are hints.
- Nothing caps the fee from above. GaslessTransfer has no maximum fee: a request pays exactly the fee its sender signed, and the relay quotes the formula at any gas price. Clients must check a quote before they sign it: wallets show the fee to the user and may pass the SDK's `maxAcceptableFee`.
- **POL/USD** comes from the Chainlink feed on Polygon, read through every RPC in `RELAY_RPC_URLS` on its own. A reading is rejected if any of these holds:
  - It is older than 3600 s. Exactly 3600 s is still accepted.
  - Its round is more than 15 s ahead of the wall clock (`future_timestamp`). A round's `updatedAt` is its block's timestamp, and Polygon block timestamps run a few seconds ahead, so up to 15 s ahead is accepted.
  - It is outside [0.01, 10] USD, or not positive.
  - The feed reports more than 18 decimals. Each RPC's `decimals()` answer is reused until a refresh is rejected; then every RPC is asked again, so one wrong answer cannot keep pricing unavailable until a restart.
  - It is unreadable.
- A reading is taken only when every RPC answers. The readings must be usable and lie within 10 % of each other; the relay then uses the highest: it gives the lower spend cap and the higher break-even. A single RPC could otherwise set the price, and with it the spend cap and break-even.
- When a reading is rejected, the RPCs disagree (`rpc_disagreement`), or an RPC does not answer (`rpc_error`), the relay rejects pricing and raises an alert. It never substitutes a static price or an older reading after a failed refresh. `polUsd` in quotes has at most 18 decimals.
- `/healthz` stays live during an oracle outage; `/readyz` returns 503 and new quotes/submissions are refused. Validated readings are cached for `RELAY_PRICE_CACHE_SECONDS`, within the feed's staleness limit.
- Receipt reconciliation, deadline cancellations and nonce maintenance continue during an oracle outage, subject to their existing RPC and gas-budget checks. New calls and call fee increases require a usable oracle price.
- The isolated local stack deploys a mock oracle. Production code always requires an oracle.

## Transaction manager

The transaction manager processes one pass at a time, every `RELAY_POLL_INTERVAL_MS`, and starts the next pass as soon as a new request is queued (at least 500 ms after the previous one), so new requests are broadcast without waiting for the poll. While a relay transaction is in flight, a new block also starts the next pass (the head is read every 500 ms), so inclusions are noticed within about half a second. It reconciles receipts, checks provisional outcomes, expires or cancels requests at their deadlines, manages replacements and nonce gaps, broadcasts eligible queued requests and prunes settled history.

A successful receipt of the relay's own call is `mined` (GaslessTransfer emits no event for a transfer), and nothing else is: an inclusion without a receipt never counts. It becomes `confirmed` only after canonical finality checks. An on-chain `failed` or `expired` outcome can change before settlement. Clients should use the SDK's finalized on-chain reconciliation before signing a new payment.

See [Transaction lifecycle](docs/transaction-lifecycle.md) for finality, provider agreement, nonce recovery, gas caps, scheduling and health. [Storage](docs/storage.md) describes retained signatures, atomic admission and backups.

## Operations

- Run one process per relay key and chain. A database lock does not protect against another process using the same key on the same chain with a different database.
- Configure independent RPC providers and put the most reliable first. Ordinary reads trust the first responding provider; settlement and nonce decisions require each provider's evidence.
- Keep the system clock synchronized. Deadline policy, price staleness and checks of chain-head freshness use wall time; interval and cache ages use monotonic time.
- Maintain a POL balance above the readiness threshold and transaction costs. Token fees accrue at the relay address; the relay has no sweep function.
- The relay does not limit or log by client address. Any per-client limits (connections, request rates) belong to the proxy in front of it, if you want them. CORS allows every origin; it is not access control.
- Keep the internal listener on loopback, or on a dedicated monitoring network. Do not expose metrics or the detailed readiness report through the public proxy.
- Monitor retained rows and disk space as well as the active queue. The row limit does not cap physical SQLite, WAL, backup or transaction-attempt bytes.
- Preserve the current database during recovery. Do not reset state or restore an older copy to resolve a nonce problem. Before key rotation, reconcile in-flight transactions; the new key requires a separate database.

### Metrics and alerts

| Metric | Meaning |
|---|---|
| `relay_http_requests_total{method,route,status_code,error_code}` | HTTP requests. |
| `relay_http_connections_refused_total{listener}` | Connections closed on accept because the listener already held `RELAY_HTTP_MAX_CONNECTIONS` (`public` or `internal` listener). |
| `relay_submissions_total{operation,outcome}` | Submissions: `accepted`, `duplicate` or the error code (`sender_busy` includes one pending request per sender; `rate_limited` the per-signer limit and the sender cool-down; `unavailable` includes a full queue, the relay-wide validation bounds and the validation deadline). |
| `relay_admission_events_total{event}` | Admission: `sender_cooldown` (a submission refused with 429 because its sender cools down and has a request pending), `cooldown_started` (a sender's request failed before the broadcast for a reason the sender controls), `evicted` (a queued request held at its spend cap gave way to a new request in a full queue), `sender_eviction` (a submission refused with 503 in a full queue with held requests, because its sender may not make one give way now: its request that took a held place was not sent yet, or it cools down), `validation_busy` (a submission refused with 503 because no validation slot came free: the wait queue was full or its wait ended) and `validation_rate` (refused with 503 by `RELAY_RATE_LIMIT_SUBMIT_MAX`), `retention_full` (retained-row capacity reached), `unsent_history_dropped` (the history of a request that was never sent gave way to a new request at that capacity), `cannot_send` (a submission refused with 503 because the transaction manager cannot send: the internal readiness report names the reason). |
| `relay_request_status_total{operation,status}` | Status transitions. |
| `relay_time_to_mine_seconds`, `relay_time_to_confirm_seconds` | Latency from acceptance. |
| `relay_pol_balance` | Relay POL balance. |
| `relay_fee_revenue_usd_total{token}`, `relay_gas_cost_pol_total{kind}`, `relay_gas_cost_usd_total{kind}` | Fee revenue vs. gas cost. `kind` is `call`, `cancel` or `filler` (a 0-value transfer that fills an unused nonce). |
| `relay_price_source{source}`, `relay_pol_usd` | Chainlink availability (1 or 0) and the price in use; the price becomes NaN when rejected. |
| `relay_price_unavailable_total{reason}` | Oracle rejections: `stale`, `future_timestamp`, `out_of_bounds`, `non_positive`, `bad_decimals`, `rpc_error`, and `rpc_disagreement` (prices more than 10 % apart). |
| `relay_queue_depth`, `relay_tx_in_flight` | Queue and in-flight counts. |
| `relay_tx_broadcasts_total{kind,outcome}` | Broadcasts by kind (`initial`, `speedup`, `cancel`, `rebroadcast`, `filler`, `filler_rebroadcast`, `filler_speedup`) and outcome. |
| `relay_tx_manager_errors_total` | Failed ticks (usually RPC errors). |
| `relay_token_domain_mismatch{token}` | 1 while the token's on-chain `DOMAIN_SEPARATOR()` differs from the configured domain; its permit and meta-tx requests are refused. |
| `relay_monitor_errors_total{monitor}` | Failed reads of the periodic checks: `token_domain`. |
| `relay_token_implementation_check_failures_total{rpc,stage,reason}` | Failed attempts of the token implementation check by RPC position, stage and reason (see [Token implementation pins](#token-implementation-pins)), including attempts a retry then passed. |
| `relay_rpc_requests_total{rpc,method,outcome}` | JSON-RPC requests by RPC position in `RELAY_RPC_URLS` (1-based), method and outcome: `ok`, `timeout`, `rate_limited` (HTTP 429, JSON-RPC 429, `-32005`, `-32007`, `-32029` or rate-limit wording), `http_status`, `network`, `rpc_error` or `other`. |
| `relay_rpc_request_duration_seconds{rpc}` | Request duration per RPC, including viem's retry. |
| `relay_rpc_head_lag_blocks{rpc}` | Blocks the RPC's head was behind the highest head another configured RPC reported in the 5 seconds before, measured each time the RPC reports a head; the value stands until its next report with such a head to compare with. Every RPC is asked for its head at least with each token implementation check (every 30 seconds). The rule `RelayRpcHeadLagging` fires above 5 blocks for 2 minutes. It compares the configured RPCs with each other: with one RPC, or when all stall together, it shows nothing. |
| `relay_rpc_history_unavailable{rpc}` | ALERT when 1: the RPC refused the state of older blocks in the last check it answered (see [RPC history](#rpc-history)); the relay is degraded. |
| `relay_process_*`, `relay_nodejs_*` | Node.js process metrics. |

The transaction manager's other metrics (reverted calls, nonce events and gaps, spend-cap holds, the queue backlog, decisions waiting for the RPCs, unsettled requests, finality lag, stored and deleted requests) are listed in [docs/transaction-lifecycle.md](docs/transaction-lifecycle.md#metrics). The metrics are served on the internal listener only.

Alert on failed readiness, persistent degradation, low POL, increasing RPC/monitor errors, prolonged spend-cap holds, growing settlement backlog, nonce gaps and unexpected nonce consumption. Compare gas cost with fee revenue. Investigate decision waits on hidden receipts and sustained on-chain reverts. Admission refusals distinguish queue pressure, client limits, cooldown and retained-row capacity.

Every `RELAY_RPC_USAGE_LOG_SECONDS` the relay also logs one `rpc usage` line, so that provider capacity can also be judged from the logs. For each configured RPC, by position, it reports the interval's requests, failures by reason, p50/p95/maximum latency in ms, the latest head and the largest head lag in blocks. URLs are never logged. Every RPC must confirm every token implementation check, so one provider that rate-limits holds all transfers: use endpoints with enough capacity for the relay.

### Alert monitoring

The relay alerts its operator itself, also where no metrics collector can reach the internal listener. Every 60 seconds (the first check one interval after startup) the alert monitor reads the readiness report (the same as `/readyz`, from its cache) and the request and HTTP counters, and derives these conditions:

| Condition | Severity | When |
|---|---|---|
| `pol_low` | warning | The POL balance is below `RELAY_ALERT_POL_BALANCE`. |
| `pol_empty` | critical | The POL balance is below `RELAY_MIN_POL_BALANCE` (readiness fails, but the relay keeps sending while it can pay), or a broadcast could not pay for gas (`insufficient_funds`: queued requests wait). |
| `not_ready:<part>` | critical | A readiness check fails: `rpc` (also a failed balance read), `price`, `token_implementation`, `tx:<reason>` (the transaction manager's reasons, e.g. `tx:nonce_gap`, `tx:gas_budget`, `tx:pass_stale`, `tx:head_stale`), or `tx` when it is not ready without naming a reason. `readiness`: the report itself could not be produced; the other conditions then keep their state. |
| `degraded:<part>` | warning | `tx:backlog`, `tx:held_at_cap`, `tx:settle_backlog`, `token_domain`, `rpc_history`. |
| `transfers_failing` | critical | At least 3 on-chain reverts of relay calls or request expiries in the last 15 minutes (a request whose call reverts after its deadline counts twice). Failed requests do not count: most are refusals the sender caused. |
| `http_5xx` | warning | At least 10 HTTP 5xx answers in the last 5 minutes, not counting `/healthz`, `/readyz` and `/metrics`; the message breaks them down by error code. |

A condition fires after two checks in a row that see it and resolves after two in a row that do not, so a single failed read does not page anyone. While the balance cannot be read, the balance conditions keep their state; while `pol_empty` holds, `pol_low` does too, so a falling balance does not report it resolved. A condition still firing after 6 hours is posted again. Each check adds at most one message, which holds all of its transitions (`CRITICAL`, `WARNING`, `STILL …`, `RESOLVED`) under a header with the chain and the relay's shortened address. A message that could not be delivered is retried, in order, at the next check; at most 20 wait, and the oldest is dropped beyond that. On shutdown the monitor waits only for the message being posted (at most 10 seconds). The state lives in memory: after a restart, conditions that still hold fire again. The monitor cannot report a stopped or hung process: keep an external availability probe or the platform's crash notifications for that.

Messages carry no client addresses, senders or request data. Every transition is also logged, with the fields `condition`, `alertState` (`firing`, `reminder`, `resolved`) and `severity`; critical conditions log at `error` when they fire and when they are posted again, the rest at `warn`.

### Token-domain monitoring

The token-domain monitor reads each token's `DOMAIN_SEPARATOR()` at startup and every `RELAY_TOKEN_DOMAIN_CHECK_SECONDS`. A mismatch refuses permit/meta-transaction quotes and submissions with `unsupported_auth_mode`; existing-allowance mode and other tokens remain available. Readiness reports `degraded`, the mismatch metric is set and an alert is logged. A failed read retains the last state; a matching later reading clears it. A permanent domain change requires compatible deployment metadata and client pins. Disabling the interval retains the startup readings until restart.

### RPC history

When a request's intent nonce was used without a receipt of the relay's call, every RPC locates the block that used it from the historical `nonces(from)` (see "Nonces" in [docs/transaction-lifecycle.md](docs/transaction-lifecycle.md#nonces)). So every RPC must serve the state of older blocks, back to:

```text
window = 2 × (7200 + RELAY_UNKNOWN_NONCE_GRACE_BLOCKS
              + max(RELAY_MAX_FINALITY_LAG_BLOCKS, RELAY_FINALITY_FALLBACK_DEPTH, RELAY_MIN_FINALITY_DEPTH)
              + RELAY_STUCK_AFTER_BLOCKS)
```

15,924 blocks with the defaults, about 6.6 hours at Polygon PoS's 1.5 s per block. 7200 s is the longest request life, and a chain adds at most one block per second; for a block d blocks below its head, the search reads down to 2·d + 1 below it. At startup each RPC must answer `nonces(0x0…0)` at max(`deployBlock`, its head − window); one that cannot (a pruned full node answers `missing trie node`), or does not answer, stops startup, named by its position in `RELAY_RPC_URLS`. Startup then logs, per RPC, whether it serves `eth_getBlockReceipts` (`yes`, `no` or `no answer`): one that does not has the receipts of the block read one by one, at most 16. Every `RELAY_RPC_HISTORY_CHECK_SECONDS` the check runs again: an RPC that refuses the state (an error answer) makes the relay degraded (it stays ready; `checks.rpcHistory` names it), sets `relay_rpc_history_unavailable{rpc}` and logs an ALERT, repeated every 5 minutes while it lasts. A check an RPC does not answer (a timeout, a rate limit, a lost connection) changes nothing: its last answer stands. The rule `RelayRpcHistoryUnavailable` fires after 15 minutes, two failed checks in a row with the default interval. Replace such an RPC; until then only the decisions that locate the use of an intent nonce wait.


### Logs and sensitive state

Logs are JSON lines on stdout. `level` is the level's name (`info`, `warn`, `error`, `fatal`), which log platforms map to a severity. The ALERT lines of the relay's own checks carry an `alert` field with a stable key (`insufficient_funds`, `head_stale`, `decision_wait`, `nonce_filler`, `gas_budget`, `price_unavailable`, `token_domain_mismatch`, `token_implementation_unavailable`, `rpc_history`), and the alert monitor's lines carry `condition` and `alertState`, so that a log search can select them. HTTP entries contain method, route, status, error code and duration, without request bodies. Lifecycle entries identify the request and transaction. Structured redaction removes signing fields; string scrubbing removes URL tokens and long hexadecimal payloads. Avoid adding arbitrary secrets to log messages.

Protect the key and database as sensitive inputs. Pending requests require persisted intent signatures, token authorizations and signed transactions for recovery. They are purged when the outcome settles; storage snapshots and backups can retain older copies.

USDT0 meta-transaction approvals have no on-chain expiry and may remain usable after a reverted call or cancellation. Clients should prefer permit when available and preserve one intent nonce across corrections. The intent signs the token authorization: a token signature copied from a broadcast call cannot be submitted with another request or as mode `none`. A sender can also change funds or authorizations after broadcast and cause a paid revert; the spend cap limits a call under its configured price assumptions, not aggregate operator losses.

### Token implementation pins

Polygon mainnet startup requires `RELAY_TOKEN_PINS_FILE`, a read-only JSON configuration reviewed by the operator. The relay never learns trusted implementations from its startup RPC responses and never rewrites this file. Missing pins stop mainnet startup; malformed pins, the wrong chain, duplicate tokens, or an incomplete token set are rejected on every chain where pins are configured.

The file has this shape (placeholders must be replaced with independently verified values):

```json
{
  "chainId": 137,
  "reviewedBlock": "FINALIZED_BLOCK_NUMBER",
  "tokens": [
    {
      "address": "TOKEN_PROXY_ADDRESS",
      "proxyCodeHash": "KECCAK256_OF_PROXY_RUNTIME",
      "implementationSlot": "EXACT_BYTES32_IMPLEMENTATION_STORAGE_SLOT",
      "implementationAddress": "REVIEWED_IMPLEMENTATION_ADDRESS",
      "implementationCodeHash": "KECCAK256_OF_IMPLEMENTATION_RUNTIME"
    }
  ]
}
```

Include every token in the deployment configuration. Establish each proxy's actual storage layout from its verified source, then compare the slot value, proxy runtime and implementation runtime at the same finalized block through independent RPC providers. Review the implementation before recording its address and hashes; do not automatically copy changed observations into the pins. The monitor supports proxies whose implementation address occupies the low 20 bytes of one configured 32-byte slot with zero upper bytes. Other proxy patterns require separate reviewed support.

At startup, every 30 seconds, and immediately before every transfer-call broadcast or rebroadcast, the relay checks each relevant proxy runtime hash, implementation slot and implementation runtime hash. Each configured RPC must independently match the reviewed values at its own pinned latest block and confirm the block hash has not changed during the read. Provider errors, missing code, mismatches and stale observations refuse all authorization modes, including existing allowance. Quotes and new submissions return `unavailable`; queued requests are held. Transaction receipt reconciliation and relay nonce cancellation remain available. `/readyz` reports `checks.tokenImplementations` and becomes unready while any configured token is unavailable. Checks older than 120 seconds also make readiness and new admission fail closed.

Within one check, a failure that can pass by itself is retried on the RPC concerned: a failed read, a head below the freshness floor, or a block that changed during the pass. The freshness floor starts at the pins' `reviewedBlock`; after a confirmed check it rises to the lowest head any RPC confirmed in that check (never to a head only one RPC reported, so one RPC with an inflated head cannot make the others fail), and it is never lowered. It is retried at most twice, after 1 and 3 seconds, and only while the check is less than 8 seconds old. A timed-out read is therefore not retried. The token is held only if an RPC still fails after that. Another chain and any difference from the reviewed values hold the token at once. As soon as one RPC's final answer fails the check, the token is held and the other RPCs stop retrying; the diagnostics name every RPC that did not confirm the pins. An observation's age (the 120 seconds) counts from the start of its check. While a token is held, the next periodic check follows after 5 seconds, then 10 and 20, then every 30 seconds again.

Route the structured `token_implementation_unavailable` ALERT to the operator's alert receiver. Its `failures` list has one entry per RPC that did not confirm the pins:

- `rpc`: its 1-based position in `RELAY_RPC_URLS`.
- `stage`: `client`, `chain_id`, `head`, `proxy_code`, `implementation_slot`, `implementation_code` or `block_hash`.
- `category` and `reason`:
  - `transport`: `timeout`, `rate_limited`, `http_status`, `network`, `rpc_error`, `other` or `unsupported`, with the numeric `httpStatus` or `rpcCode` when the RPC answered.
  - `chain`: `chain_mismatch` or `head_behind`.
  - `pins`: `mismatch` or `empty`.
  - `block`: `block_changed` or `block_missing`.
- `attempts`: how many attempts that RPC got.

Provider text and URLs are not logged. While the token stays held, a warning repeats the diagnostics when they change, and at least every 5 minutes. The recovery line reports `heldMs`. Confirm a detected upgrade with independent providers, review the new source and relevant behavior, rerun all affected authorization routes against the upgraded token, then update the read-only pins and restart. Restarts do not trust a changed implementation. Matching the original reviewed values permits recovery after a temporary RPC fault or a reverted change.

This control detects changes before observations and broadcasts; it cannot prevent an issuer upgrade between the final check and transaction inclusion, prevent issuer freezes, or detect behavior changes through other token storage. It needs no on-chain pause, contract permission, user deposit, fee change or signature change. A paused relay can still have previously broadcast transactions in the network; the control cannot retract them.

The dedicated metric `relay_token_implementation_unavailable{token="0x…"}` is 1 for a missing, mismatched or stale observation, and 0 after every provider matches the reviewed configuration. Metric collection recomputes freshness, so stopping the periodic checker cannot leave a stale healthy metric.

`relay/scripts/collect-token-pins.mjs` prepares candidate evidence through two public RPCs at one common finalized block and fetches the upstream proxy source used to derive each slot. It also checks that implementation addresses match the real-token regression fixtures. Run it in a freshly built contained source snapshot with explicitly approved network access, for example:

```sh
TOKEN_PINS_RPC_URLS=https://your-primary-provider.example,https://your-independent-provider.example \
    GASLESS_TEST_NETWORK=bridge bash docker/test-contained.sh 'cd relay && node scripts/collect-token-pins.mjs'
```

The output is labelled `candidate-requires-review`; it is deliberately not an accepted pins-file shape. Review its block hash, source hashes, implementation identities and compatibility results before placing its `pins` object in an operator-approved file. A changed implementation stops collection for explicit review. The collector cannot establish source equivalence merely from an unchanged address, and it does not automatically approve future upgrades. Its offline negative tests are `cd relay && node --test scripts/collect-token-pins.test.mjs` within the contained test workflow.


### Durable aggregate gas budget

`RELAY_TOTAL_GAS_BUDGET_POL` is a positive decimal native-token amount (default **1 POL**). Before signing or broadcasting, the relay durably reserves `gasLimit × maxFeePerGas` in SQLite. The lifetime total is the sum of the largest reservation for each relay account transaction nonce. Replacements and cancellations share a nonce and cannot both execute on the canonical chain, so only an increased maximum consumes additional budget. Initial calls, speed-ups, cancellations, gap fillers and restored raw transactions all pass the same check. An identical rebroadcast remains permitted without new exposure, even if the configured ceiling was lowered.

This is deliberately a **gross exposure ceiling**, not a profit estimate or a daily loss counter. Success, failure, missing receipts, pruning, reorgs, time changes and restarts never release the reserved amount. A signing failure after reservation conservatively consumes capacity. SQLite commits the reservation before the signature is produced; a crash cannot erase already-authorized exposure. The ledger is separate from retained requests and is never pruned.

A refused increase leaves the request queued/in flight, emits `alert=gas_budget`, and makes readiness fail for that pass. Reconciliation continues, and cheaper cancellations that fit an existing reservation are allowed. With remaining capacity below the next request's cost, readiness may fail before the exact ceiling is reached. `relay_gas_exposure_pol` and `relay_gas_budget_pol` expose the conservative total and the configured ceiling. Operators must review receipts and pending liabilities before deliberately raising the **lifetime** ceiling. Funding the signer does not reset it. Never delete/replace/reset the database to restore capacity, reuse this signer for unrelated spending, or run another writer with the same signer on the same chain and a different database; those actions defeat a process-local spending bound. Keep a low signer float and a consistent protected database backup as independent controls.

The limit may stop healthy traffic after the allocated budget is used, even when successful user fees covered costs in stablecoins. It changes relay availability policy only: contract payment semantics, signatures, trust and user funding remain unchanged. It cannot revoke transactions already broadcast, guarantee inclusion of a cancellation, recover burned gas, or protect against a compromised process/key/operator.

[polygon-137.env.example](config/polygon-137.env.example) is an explicit production policy template. It requires independent RPC endpoints, a usable Chainlink feed, reviewed token pins and external secret/database mounts. There is no static price fallback. [alerts.yml](config/alerts.yml) contains Prometheus rules for budget usage, paid reverts, domain/implementation changes, RPC history and head lag, and readiness. The readiness rule requires a blackbox HTTP probe job named `gasless-relay-readiness` targeting the private `/readyz` listener. Run `make test-alerts` from the repository root for offline syntax and behavior tests in a digest-pinned Promtool container. Scrape `/metrics` privately. Alert delivery and independent signer/database recovery storage are operator responsibilities.

[Linux operations](../docs/operations/linux-relay.md) supplies the production Compose template, private Prometheus scrape/probe configuration, response actions and consistent SQLite backup/restore procedure. Hosting, alert receivers and encrypted backup destinations belong to the operator. A separate scrape-failure rule detects an unavailable relay or blackbox exporter even when application metrics disappear.


The [Polygon token implementation pins](config/token-pins.polygon-137.json) are included in the production image at `/app/config/token-pins.polygon-137.json`. Mount the deployment JSON read-only at `/app/deployments/137.json`, the durable database at `/data`, and the signer file read-only at `/run/secrets/relay_key`. Configure at least two independently operated RPC providers.

## Development and tests

Run `make test-contained` from the repository root for the default contract, SDK and relay checks. Use `make stack-test` for the running disposable stack and `make relay-image-check` for runtime checks. Fork tests require the explicit networked workflow described in [development](../docs/DEVELOPMENT.md).

The relay tests cover HTTP/schema behavior, persistence, transaction scheduling, restart/reorg recovery, token modes, provider disagreement and resource limits. Test helpers use disposable keys and local chain fixtures.
