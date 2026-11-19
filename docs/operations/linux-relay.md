# Linux relay operating contract

Linux deployment uses `compose.production.yaml`. Hosting, alert receivers and encrypted backup storage are operator configuration.

## Funding and service identity

Users sign USDC/USDT0 intents and token authorizations; they do not need POL for these gasless routes.
The operator funds its relay signer with POL, receives the successful transfer's signed stablecoin fee,
and manages native-token replenishment. Failed atomic transfers do not retain a user token fee.
Use a dedicated runtime signer, one active writer and one durable database. Do not repurpose the
deployment signer or use the relay signer from another wallet, service or database.

`RELAY_TOTAL_GAS_BUDGET_POL` is a lifetime gross exposure authorization, including successful calls.
Top-ups, restarts and retention do not reset it. Review outstanding transactions and operator losses
before raising it. It is not a profitability counter or an automatic daily allowance.

## Production container

Use [compose.production.yaml](../../compose.production.yaml), separate from the disposable local test
stack. Supply the reviewed runtime image by registry digest (`name@sha256:...`), the environment file,
the signer path, the public deployment record and an existing dedicated external volume through its
five required variables. The template cannot create or fund a signer. It never mounts the repository
as executable source. The external volume must contain a `/data` directory writable only by UID/GID
1000 and enough capacity for requests, transaction attempts and WAL growth. Do not share it with
unrelated services. Use reliable local/block storage with SQLite locking and durability guarantees;
do not assume a network filesystem provides those guarantees.

Copy [polygon-137.env.example](../../relay/config/polygon-137.env.example) outside version control.
Set two independent HTTPS RPC providers, the Chainlink feed and the spending limits. There is no
client-origin or proxy-trust setting: the relay answers every origin and reads no forwarded headers
(see below). Both providers must serve the state of older blocks: archive nodes, or nodes that keep
at least the relay's history window (15,924 blocks with the default settings, about 6.6 hours at
Polygon PoS's 1.5 s per block; the formula is in the relay README, "RPC history"). The relay refuses to start with a provider that does not, naming it by
position, and logs which providers serve `eth_getBlockReceipts`; prefer providers that do (without it,
the relay reads receipts one by one and cannot tell past 16 copies of a call in one block). Preserve the recorded deployment,
token implementation pins and calibrated gas table. A new image/configuration requires review;
do not automatically accept issuer upgrades or edit token pins merely to restore readiness.
Protect environment files (including RPC credentials), signer material and state with restrictive
permissions. The runtime signer file must be readable by UID 1000 and otherwise protected (0600 or
0400); container bind mounts preserve host permissions. Keep encrypted recovery material outside
the repository and disposable deployment directories. No secret belongs in an image layer.

The compose API and operations ports bind to host loopback. Put an operator-managed TLS proxy in
front of `127.0.0.1:8080`, publish only the public API, and set body/connection/time limits there. The
relay reads no forwarded headers and neither limits nor logs by client address; any per-client limits
belong to the proxy. Do not expose 9464 through the public proxy.
Keep the Docker bridge private to trusted workloads and restrict host administration.

The image runs non-root with a read-only root filesystem, dropped capabilities, no new privileges,
bounded memory/CPU/PIDs, bounded logs, and a small temporary filesystem. Readiness is a traffic gate,
not a reason to kill the relay: a service holding new work must still reconcile pending transactions.
Allow graceful SIGTERM before maintenance and confirm the process exited before opening its state.

Before starting, use `docker compose --env-file OPERATOR-COMPOSE-ENV -f compose.production.yaml config --quiet`.
Then verify the image digest, environment file permissions and volume ownership. Do not print a
resolved configuration containing credentials into tickets or shared logs. Deployment requires a
modern Docker Compose supporting raw `env_file` format (2.30.0+;
[official service reference](https://docs.docker.com/reference/compose-file/services/)); validate against the operator's installed version.

## Monitoring and response

Recommended integration: Prometheus plus Alertmanager. Its routing and receiver configuration lets
the operator choose an on-call paging service, email or webhook without changing application code
([official configuration](https://prometheus.io/docs/alerting/latest/configuration/)). Use a paging
receiver with escalation for `severity=critical`; use the operator's ordinary notification channel for
warnings. Email alone is a poor default for a time-sensitive outage unless it is actively monitored.

The [Prometheus example](../../relay/config/prometheus.yml.example) assumes host-local Prometheus,
Alertmanager and a blackbox exporter with the `http_2xx` module. Copy the
[rules](../../relay/config/alerts.yml) to its configured rules path. For remote monitoring, adapt
addresses through a private authenticated connection. No notification destination is embedded.

Without such a stack, or next to it, the relay's [alert monitor](../../relay/README.md#alert-monitoring) can post
balance, readiness, degradation and error alerts to a chat webhook (`RELAY_ALERT_WEBHOOK_URL`; the container then
needs outbound HTTPS to that host). It cannot report a stopped or hung process, so keep an availability probe.

| Signal | Required response |
|---|---|
| Domain/implementation mismatch | Hold new transfers; verify with independent providers, review issuer changes and rerun all affected routes before updating pins. |
| Gas exposure near/reached ceiling | Inspect receipts, outstanding nonces and losses; deliberately authorize any increase. Never reset the DB. |
| Token configuration changed by the contract owner (`setTokenConfig`) | Update the reviewed deployment record (and, on chain 137, wait for matching SDK pins), then restart; the relay refuses to start on the old record. Until then requests outside the new configuration fail their simulation. |
| Paid reverts increasing | Investigate sender activity, balances/allowances, token administration, gas estimates and RPC disagreement. |
| RPC history unavailable (`relay_rpc_history_unavailable`, readiness `degraded`, ALERT `rpc_history`) | Replace the provider at the named position with one that serves the history window, then restart. Until then the decisions that locate the use of an intent nonce wait; the relay keeps serving. Do not lower the finality or alert settings to shrink the window. |
| Readiness or metrics unavailable | Check process, private probe/scrape, providers, signer float and disk; preserve the journal while recovering. |
| Host disk capacity/IO errors, clock drift | Alert through host monitoring. SQLite row limits do not bound bytes; price freshness assumes a reliable host clock. |

Run `make test-alerts` for rule tests. At rollout, test a synthetic alert end to end through the chosen
receiver, verify recovery notifications, and check that stopping the relay produces both readiness
and scrape failures. Monitor the monitoring system itself; locally passing rule tests do not prove
that notifications arrive. An external availability probe should also exercise the TLS/public API.

## Consistent state backup and recovery

The runtime includes `node /app/scripts/backup-state.mjs SOURCE NEW-DESTINATION-DIRECTORY`.
Run it using the same reviewed image after stopping the relay; mount only the operator's state and
backup output paths for this maintenance operation, never a key or source checkout. The source needs
write access for SQLite recovery/locking. The helper refuses an active exclusive writer and an
existing destination, recovers committed WAL if necessary, verifies integrity, takes a SQLite backup,
and writes a SHA-256 manifest. It performs no migrations, resets, signing or RPC calls. An interrupted
backup without a completed manifest is invalid. Source state must be retained even if backup fails.

The output contains sensitive plaintext signatures and signed transactions, with directory mode 0700
and file mode 0600. Use the operator's authenticated encryption/backup system before transferring it
off-device, protect decryption keys independently, and verify a decrypted restore in isolation. Keep
the reviewed image digest, deployment/configuration hashes and encrypted signer recovery alongside
the backup inventory, without placing plaintext secrets in the manifest. Choose retention deliberately:
backups may preserve authorizations already purged from the active database.

For a restore drill: stop every writer for the signer; decrypt into a new protected directory; verify
the database SHA-256 against its authenticated manifest; use the matching reviewed binary and check
integrity, chain/signer/deployment identity, schema, pending requests/attempts and gas exposure. Compare
against the latest retained state and independently inspect chain pending/finalized nonces before any
networked restart. Only the latest complete state is a routine restoration candidate. Keep the original
state and evidence until reconciliation finishes. Start one writer and confirm reconciliation/readiness
before admitting new submissions.

**A hash or manifest cannot establish freshness.** Restoring an older DB or starting a fresh DB with
the same signer can lose gas reservations and signed transactions that remain executable. Never do
that to clear a nonce, regain budget or bypass startup checks. If the latest state cannot be recovered,
keep this signer out of service and reconcile outstanding transactions before an explicitly reviewed
recovery/key-rotation procedure. There is no automatic safe rollback of externally broadcast transactions.

Backup location, receiver selection and an actual restore/delivery drill are operator rollout duties.
