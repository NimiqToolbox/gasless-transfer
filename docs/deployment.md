# Deploy and operate on Linux

Build and deploy the transfer contract, configure the SDK, and run the relay on Linux.

## 1. Choose a build workflow

### Docker

Install Docker Engine, Docker Compose v2, Bash and Make through your Linux distribution's supported process. From the repository root:

```sh
make test-contained
make relay-image-check
```

The first command builds the pinned development and verification images and runs default contract, SDK, relay, integration and offline fault tests. The second builds `gasless/relay:local` and checks the runtime image, including the native SQLite addon. Builds download dependencies; default test execution is offline and bounded.

Try the complete disposable stack before configuring a public chain:

```sh
make stack-up
make stack-test
make stack-down
```

The stack uses chain 31337, mock tokens and publicly known Anvil keys on an internal Docker network. Its volumes are disposable and the down command removes them. Do not fund these accounts on public chains.

### Native Linux

Use an unprivileged build account and a writable build checkout. Required tools are Node **24.22.2** with matching headers, pnpm **10.34.5**, Python 3, Make and a C++ compiler. For Solidity and local-chain tests, also provide Foundry **1.8.3**, solc **0.8.28** and the pinned Solidity libraries described in [dependencies](dependencies.md). The SDK tests that start Anvil read the libraries from `/deps`, where the images place them: on a host without that path they are skipped (and fail when `CI` is set), so the Docker path is the one that runs the full SDK suite.

```sh
# Dependency-download phase; lifecycle scripts are disabled.
bash scripts/native-build.sh download

# Build phase: run with networking disabled by your build environment.
# Set NODE_HEADERS_DIR if matching headers are not at /usr/local/include/node.
bash scripts/native-build.sh build

pnpm typecheck
pnpm test
pnpm --filter @nimiq/gasless-relay test:integration
```

The helper checks tool versions, compiles the SQLite addon and builds both packages. Install system tools separately. Run the build phase without network access; the helper does not configure network restrictions.

## 2. Deploy or select the contract

The deployment entrypoint is [DeployGaslessTransfer.s.sol](../contracts/script/DeployGaslessTransfer.s.sol). It refuses chains other than **Polygon PoS, chain 137**, checks the live token domain separators, and deploys GaslessTransfer with this initial token configuration:

| Token | Address | Authorization modes |
| --- | --- | --- |
| Native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | permit, existing allowance |
| USDT0 | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | permit, meta-transaction approve, existing allowance |

GaslessTransfer has no maximum fee: only the fee the sender signs bounds what the relay is paid. Wallets must show the fee and should enforce a user-approved limit (the SDK's `maxAcceptableFee`). Both tokens use six decimals. USDC uses the chain-ID EIP-712 domain; USDT0 uses a chain salt. Do not replace either domain with a generic token-domain template.

GaslessTransfer is deployed on Polygon (`contracts/deployments/137.json`, [Polygon deployment record](operations/polygon-137-deployment.md)).

The contract has an owner (`Ownable2Step`) that can add, replace or remove token configurations with `setTokenConfig`, and nothing else. The script takes the initial owner from `GASLESS_TRANSFER_OWNER` and refuses to run without it; there is no default. The constructor sets that owner directly, without an acceptance step, so the script accepts only the EIP-55 checksummed form of the address (a lowercase value or a broken checksum is refused). Choose the owner deliberately, for example a multisig, separate from the deployment and relay accounts, and check `owner()` with the verifier below before publishing client pins. A new owner must accept with `acceptOwnership`; `renounceOwnership` fixes the configuration for good.

For a native Foundry build with pinned dependencies, run the script without broadcasting first:

```sh
cd contracts
forge build
GASLESS_TRANSFER_OWNER=0xYourOwner forge script script/DeployGaslessTransfer.s.sol --rpc-url polygon
```

The `polygon` endpoint reads `POLYGON_RPC_URL` from the operator environment. Configure a real signer separately using the pinned Foundry version's supported keystore or hardware-wallet options. The script only broadcasts when explicitly invoked with `--broadcast` and the selected signer options:

```sh
# Add the signer options selected for your environment.
GASLESS_TRANSFER_OWNER=0xYourOwner forge script script/DeployGaslessTransfer.s.sol --rpc-url polygon --broadcast
```

An operator must review the target chain, intended deployment and gas budget before broadcasting. Never use the local fixture keys. Do not place a private key in a command line, source file, image build argument or committed environment file. A deployment account and relay account have different roles and should be configured deliberately.

For Docker deployment, use the container template below with persistent output volumes and read-only signer mounts.

The script writes `contracts/deployments/137.json`. Simulation can also write this file, so **the file alone is not proof of a mined deployment**. Confirm a successful canonical deployment receipt and compare deployed runtime against the compiled artifact, including constructor-dependent immutable values, before distributing it. Record the actual address and deployment transaction. The script's `deployBlock` is the block it saw before the broadcast, not necessarily the receipt block. The relay and the SDK read no state below it when they look for what used an intent nonce, and take every nonce as unused there, so it must be at or below the receipt block; never raise it above that.

Preserve the deployment record fields:

```text
chainId, version ("3"), gaslessTransfer, initialOwner, deployBlock,
tokens[{symbol, address, decimals, authModes, domain}]
```

`version` is the contract's EIP-712 domain version; readers reject a record without `"3"`, and a record or token entry with any other key (a token entry may also carry its expected `domainSeparator`, which must be the hash of its `domain`). The token entries are the constructor's configuration. After any `TokenConfigSet` event, `tokenConfig(token)` on-chain is authoritative; update the record and client pins to match.

Publish only verified public metadata. Keep signer material, transaction journals and private operator state separate. If selecting an existing deployment, independently verify the same fields and bytecode; do not infer trust from a repository address or explorer link.

Keep encrypted signing backups outside disposable repositories/worktrees and verify restoration before funding. Preserve transaction journals separately. The [Polygon deployment record](operations/polygon-137-deployment.md) lists the deployment and its verification.

The current build has an executable read-only verifier:

```sh
POLYGON_RPC_URL=https://your-primary-provider.example \
POLYGON_VERIFY_RPC_URL=https://your-independent-provider.example \
DEPLOYMENT_ADDRESS=0xYourActualAddress DEPLOYMENT_TX_HASH=0xYourMinedTransaction \
GASLESS_TRANSFER_OWNER=0xTheIntendedOwner DEPLOY_BLOCK=TheRecordsDeployBlock \
make verify-deployment
```

It requires a finalized canonical direct-CREATE receipt, exact constructor/creation bytes, full runtime including independently reconstructed immutables, and matching token/domain configuration. `GASLESS_TRANSFER_OWNER` is required: the constructor's initial owner must equal it, so a deployment of this build with another owner fails. `DEPLOY_BLOCK` is required too: the record's `deployBlock` must be at or below the receipt block. At the snapshot, `owner()` must be that owner, or `GASLESS_TRANSFER_CURRENT_OWNER` after an accepted transfer, with no transfer pending, and each token's `tokenConfig` must still equal the deployed configuration. Supplying the second provider requires both to answer and both results to agree; a failure names the provider by its position and variable (`provider #2 (POLYGON_VERIFY_RPC_URL)`), never by its URL. A one-provider result remains explicitly limited. Metadata differences are verification failures even when executable instructions match.

Before production operation, run `POLYGON_NATIVE_GAS=true FORK_BLOCK=<recorded-finalized-block> POLYGON_RPC_URL=... make test-gas-calibration`. The RPC must support historical state overrides. With `DEPLOYMENT_ADDRESS` and `DEPLOYMENT_TX_HASH` it measures that deployment and first runs the verifier above on it, which needs `GASLESS_TRANSFER_OWNER` (and `GASLESS_TRANSFER_CURRENT_OWNER` after an ownership transfer) and checks `DEPLOY_BLOCK` if it is set. Local Anvil measurements alone understate Polygon gas; do not use their diagnostic output to overwrite the calibrated table. This procedure uses temporary local funding and read-only remote simulation, without signing or sending a real transaction.

The Amoy script uses an existing token for `AMOY_USDC` or `AMOY_USDT0` (Circle's test USDC for `AMOY_USDC`) and deploys a mock for the other; it also deploys a fixed-price POL/USD test feed, since Amoy has no live Chainlink POL/USD, and takes its owner from `GASLESS_TRANSFER_OWNER`. It does not establish compatibility with Polygon's issuer-operated token contracts. The local script similarly targets development fixtures.

### Bounded Docker deployment template

Build the current source with `make verify-image`. For keystore signing, set `DEPLOYER_KEYSTORE` and `DEPLOYER_PASSWORD_FILE` to the two absolute operator-managed file paths. Both files must be readable by UID 1000 and unavailable to other users. Supply `POLYGON_RPC_URL` and `GASLESS_TRANSFER_OWNER` separately. Create dedicated, initially empty output volumes; do not reuse local-stack volumes:

```sh
docker volume create gasless-deployment-records
docker volume create gasless-deployment-broadcasts
```

On their first mount, Docker initializes empty volumes from the image's output directories, which are owned by UID 1000 with mode 0700. The template checks writability before invoking Foundry. Existing volumes with incompatible ownership fail that check; inspect and provision the intended volume deliberately rather than recursively changing ownership on unrelated state.

The following is a **simulation template**. It grants RPC access but contains no `--broadcast`. It mounts only signer files and output volumes, with source/dependencies in the image:

```sh
docker run --rm --init --network bridge \
  --user 1000:1000 --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --cpus 2 --memory 4g --memory-swap 4g --pids-limit 256 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --tmpfs /work/contracts/out:rw,nosuid,nodev,size=768m,uid=1000,gid=1000 \
  --tmpfs /work/contracts/cache:rw,nosuid,nodev,size=256m,uid=1000,gid=1000 \
  --tmpfs /home/node/.foundry/cache:rw,nosuid,nodev,size=128m,uid=1000,gid=1000 \
  --mount type=volume,src=gasless-deployment-records,dst=/work/contracts/deployments \
  --mount type=volume,src=gasless-deployment-broadcasts,dst=/work/contracts/broadcast \
  --mount "type=bind,src=${DEPLOYER_KEYSTORE:?},dst=/run/secrets/deployer.json,readonly" \
  --mount "type=bind,src=${DEPLOYER_PASSWORD_FILE:?},dst=/run/secrets/deployer-password,readonly" \
  --env POLYGON_RPC_URL --env GASLESS_TRANSFER_OWNER \
  --workdir /work/contracts \
  gasless/verify:local \
  'test -w deployments && test -w broadcast && forge script script/DeployGaslessTransfer.s.sol --rpc-url polygon --keystore /run/secrets/deployer.json --password-file /run/secrets/deployer-password'
```

Inspect the simulation and selected signer before adding `--broadcast` to the final Foundry invocation. Preserve both output volumes after any broadcast or ambiguous error; do not blindly rerun deployment or use `--resume` without reconciling the signer's nonce and recorded transactions. Export the verified public deployment record separately from private signing/broadcast state.

The deployment container can read both the keystore and its password. Restrict those mounts to the deployment process.

## 3. Configure the relay

Use a dedicated relay key and persistent database. At minimum configure:

| Setting | Operator responsibility |
| --- | --- |
| `RELAY_RPC_URLS` | At least two independent Polygon RPC providers for production; reliable finalized/historical reads and agreement are needed for irreversible decisions. |
| `RELAY_DEPLOYMENT_FILE` | Verified deployment record, mounted read-only. |
| `RELAY_PRIVATE_KEY_FILE` | File containing one 32-byte hex key; restrict to the service user, preferably mode 0400 or 0600. |
| `RELAY_POLUSD_FEED` | `default` uses Chainlink POL/USD on Polygon. A valid oracle price is required; there is no static fallback. |
| `RELAY_DB_PATH` | Durable SQLite state on a dedicated writable directory. |
| `RELAY_GAS_TABLE_FILE` | Reviewed, chain-appropriate gas table; use an absolute path for native operation. |
| `RELAY_TOKEN_PINS_FILE` | Reviewed token implementation pins; required on Polygon mainnet. |
| `RELAY_TOTAL_GAS_BUDGET_POL` | Lifetime ceiling of the gas cost the relay may commit to (default 1 POL). When it is used up the relay stops broadcasting until you raise it. |

The full settings, defaults and startup checks are in the [relay reference](../relay/README.md). Measure gas requirements against current chain state before operating the relay. Retain the configured gas and spend limits, and investigate rejected estimates before adjusting them.

### Docker runtime

Build with `make relay-image-check`. Run the resulting image with:

- the application/root filesystem read-only, capabilities dropped and `no-new-privileges`;
- explicit CPU, memory and PID limits, and core dumps off (`ulimits: core: 0`): a dump of the relay contains its key;
- the key and deployment record mounted read-only;
- a persistent, service-user-writable volume at `/data` and bounded temporary storage at `/tmp`;
- the public listener behind a TLS reverse proxy, and the operations listener inaccessible from public networks.

The image defaults to UID 1000, key file `/run/secrets/relay_key`, database `/data/relay.sqlite`, gas table `/app/config/gasTable.json`, public port 8080 and operations port 9464. A Docker volume must be writable by the runtime user without making the source or key directory writable.

The relay does not read forwarded headers, limit by client address or log client addresses. Per-client connection or request limits, if wanted, belong to the proxy in front; the relay bounds submissions per signer and relay-wide. The public listener allows cross-origin requests from every origin, so self-hosted wallets can use the relay; there is no CORS setting.

### Native runtime

After the native build, the actual entrypoint is:

```sh
node relay/dist/main.js
```

Supply absolute paths for key, deployment, gas table and database in the service environment. In particular, the non-container default gas-table path is relative to the working directory. Supervise the process as an unprivileged user with read-only application files, a restricted environment, dedicated writable state and OS-level resource/network controls. The native entrypoint does not create those controls for you.

## 4. Pin clients and exercise the flow

Use [`pinsFromDeployment` or `definePins`](../sdk/README.md) in the signing application, with independently selected relay addresses. Build typed data in that application, display recipient/amount/fee, enforce `maxAcceptableFee`, and validate token domains before signing.

Start with a deliberately small authorized transfer and verify exact sender, recipient and relay token deltas, then a canonical finalized outcome. Verify idempotent reposts and the intended correction behavior on a disposable local chain before handling real payments. Existing-allowance mode may require a sender-paid approval first; the transfer being gasless does not make the prior approval gasless.

A timeout or lost HTTP response leaves execution ambiguous. Repost the same signed body when appropriate and preserve the payment's original nonce across corrections. Keep the latest version needed by SDK confirmation. Do not create a new nonce merely because a relay reports failure.

## 5. Operate and recover

Monitor readiness, RPC agreement, token domains, relay POL balance, gas estimates, queue/retained-row occupancy and persistent storage. Keep the operations listener private. A provider outage can intentionally prevent final settlement rather than risk deleting evidence.

Use one transaction manager per relay key and chain, with its durable journal. The database is bound to chain, relay identity and GaslessTransfer deployment, and the process takes an exclusive database lock; separate databases using the same key on the same chain are not made safe by that lock. Use the [Linux deployment, monitoring and recovery procedure](operations/linux-relay.md) and its stopped-writer SQLite backup helper.

On shutdown, allow SIGTERM handling to finish. After a crash, retain the database and signed transaction records for reconciliation. Never reset a live database to resolve a stuck nonce. Before changing keys, RPCs, deployment pins or state, determine what has already been broadcast and can still execute.

See [security](../SECURITY.md) for trust assumptions and operating risks.
