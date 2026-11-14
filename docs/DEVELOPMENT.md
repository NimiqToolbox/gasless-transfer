# Development

The contracts build and test natively with Foundry ([Contracts](#contracts)). The whole repository — contracts, SDK and relay — builds and tests in Docker on Linux with Docker Compose v2, Bash and Make ([Whole repository](#whole-repository)). Native Linux builds of the SDK and relay use the pinned build helper described in [deployment](deployment.md#native-linux).

## Pinned toolchain

| Tool | Version or source pin |
| --- | --- |
| Foundry: forge, cast, anvil | 1.8.3; image `ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7` |
| solc | 0.8.28; settings in [contracts/foundry.toml](../contracts/foundry.toml): optimizer 10,000 runs, EVM `cancun`, no via-IR, IPFS metadata hash |
| OpenZeppelin Contracts | v5.6.1, commit `5fd1781b1454fd1ef8e722282f86f9293cacf256` |
| forge-std | v1.16.2, commit `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` |
| Node | 24.22.2; image digests in `docker/dev.Dockerfile` and `docker/relay.Dockerfile` |
| pnpm | 10.34.5; tarball sha512 in the Dockerfiles |
| Slither / Aderyn / solhint | 0.11.6 / 0.6.8 / 6.2.4; hashed lockfiles in `docker/analysis/`, Aderyn sha256 in `docker/analysis.Dockerfile` |

The Foundry, solc and library pins, the source paths and the remapping in [contracts/remappings.txt](../contracts/remappings.txt) are part of the metadata hash: other versions or layouts compile to different bytecode. [Supply chain](supply-chain.md) describes how every input is pinned and updated; [dependencies](dependencies.md) lists the libraries and their licenses.

## Contracts

All commands in this section run from `contracts/`, the Foundry project root.

### Dependencies

The libraries are not part of the repository. Clone them at their pinned commits into `contracts/lib`:

```sh
git clone --quiet --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git clone --quiet --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std.git lib/forge-std
git -C lib/openzeppelin-contracts rev-parse HEAD   # 5fd1781b1454fd1ef8e722282f86f9293cacf256
git -C lib/forge-std rev-parse HEAD                # bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
```

### Build and test

```sh
forge build
forge test
```

The default profile runs the unit, specification, invariant and golden-vector suites. It excludes `test/fork` (run it with `FOUNDRY_PROFILE=fork`, below); `test/fork-verify` skips itself unless `VER_FORK=true` and `POLYGON_RPC_URL` are set. `forge fmt --check` checks formatting.

### Fork tests

Fork tests read Polygon state through an archive-capable RPC and execute only locally; nothing is broadcast.

```sh
POLYGON_RPC_URL=<archive RPC URL> FOUNDRY_PROFILE=fork forge test
VER_FORK=true POLYGON_RPC_URL=<archive RPC URL> forge test --match-path 'test/fork-verify/*'
```

The `test/fork` suites pin block `94421000` and accept a `FORK_BLOCK` override.

### Golden vectors

`contracts/test/vectors/data/gasless-transfer-137.json` and `gasless-transfer-31337.json` hold the T30 golden vectors: transfer and token authorization digests generated from `contracts/src` and the token mocks. `GoldenVectorsTest` fails when a file differs from the generator's output, and the SDK tests check the same files. Regenerate both files after a change that affects them; `source.commit` records a commit (40 zeros in this repository) and changes no digest:

```sh
WRITE_GOLDEN_VECTORS=true GOLDEN_VECTORS_COMMIT=<commit> forge test --match-contract GoldenVectorsWriter
```

The [vectors README](../contracts/test/vectors/README.md) describes the files and their format.

### Long invariant run

```sh
FOUNDRY_PROFILE=invariant-final forge test --summary
```

### Static analysis

Slither 0.11.6 reads its configuration from [contracts/slither.config.json](../contracts/slither.config.json) (`slither .` in `contracts/`).

## Whole repository

All commands in this section run from the repository root. Image builds need network access; the test runs are offline.

### Default checks

```sh
make test-contained
make relay-image-check
```

`test-contained` runs the type checks, the SDK and relay unit tests, the relay integration and offline fault tests, the tests of the backup and token-pin scripts, Solidity formatting and the default Foundry suite. Three checks have their own targets: `make test-deployment-verifier` (the deployment verifier), `make test-alerts` (the alert rules) and `make artifact-check` (the artifact validator). `make test` runs the contract and Node checks only; `make test-fault` runs the offline fault suite. [Testing](testing.md) lists the suites.

The verification image contains a source snapshot. Rebuild it after every source change. For a focused test:

```sh
make verify-image
bash docker/test-contained.sh 'cd contracts && forge test -vvv'
bash docker/test-contained.sh 'cd relay && pnpm exec vitest run test/unit/logger.test.ts'
```

The runner is offline by default, non-root, read-only and resource-bounded. Its writable locations are temporary output and cache directories, not the source or the installed runtime. [Containment](containment.md) describes the boundary.

### Local end-to-end stack

```sh
make stack-up
make stack-test
make stack-down
```

This builds and starts Anvil, mock tokens, GaslessTransfer and the relay runtime image on an internal Docker network. No host ports are published. The fixture uses public development keys. `stack-down` deletes the stack volumes. See the [relay reference](../relay/README.md#local-stack).

### Archive and fork checks

```sh
POLYGON_RPC_URL=https://your-archive-rpc.example make test-fork-contained
```

This explicitly enables RPC reads. Transactions execute only in local simulation; no live keys are needed and nothing is broadcast to Polygon. Keep credential-bearing URLs out of logs, committed files and shared command transcripts.

The relay's fork E2E (`relay/test/fault/forkE2E.fault.ts`) forks the RPC's head minus 200 blocks: its fee quotes need a POL/USD round at most 3600 s old, so a `FORK_BLOCK` given to it must be from the last hour. Its anvil reads the RPC through a local proxy (`relay/test/fault/helpers/forkUpstream.ts`), which retries reads that got no answer or a rate-limit answer (20 s per attempt, at most 90 s); the run logs each retry and a `fork upstream` summary. Fork tests are skipped when the RPC or the opt-in settings are absent.

`make test-fork-contained` runs the contract fork suite (`test/fork`) and the relay fault suite against the fork. `make test-fork` and `make test-fault-fork` run one of the two; `make test-verify` runs the EIP-7702 cases in `test/fork-verify`, which no other target runs. All need `POLYGON_RPC_URL`.

### Invariants, analysis and generated artifacts

| Target | Purpose and output |
| --- | --- |
| `make invariant-final` | Long Foundry invariant profile |
| `make coverage` | Solidity coverage, fresh `build/coverage/run-*` output |
| `make static` | Slither, Aderyn and solhint, fresh `build/static/run-*` output |
| `make mutation` | Mutates a disposable source copy, fresh `build/mutation/run-*` output |
| `make abi` | Regenerates only `sdk/abi/GaslessTransfer.json` and `sdk/src/core/abi.ts` |
| `make lock` | Explicit registry-network operation; lifecycle scripts disabled; exports `pnpm-lock.yaml` |
| `make deps` | Exports verified Solidity libraries to fresh `build/deps/run-*` |

Artifact workloads use a read-only source and runtime, bounded scratch space and task-owned output storage. The launcher exports only the target's permitted outputs and preserves older runs. The verification scripts themselves are under [scripts/verification](../scripts/verification/); the Make targets run them in the contained environment.

The SDK's ABI files are tested against the contract build. `relay/config/gasTable.json` holds a Polygon-native calibration ([relay reference](../relay/README.md#gas-table)); local gas tests (`GasMeterTest`, on the mocks) only log diagnostic numbers, because their EVM pricing differs from Polygon's. Recalibrate after a contract, token or chain gas-schedule change. Review lockfile and generated-code changes rather than accepting a regeneration unseen.

## Deployed bytecode

[Polygon deployment](operations/polygon-137-deployment.md) reproduces the deployed creation and runtime bytecode from this source.

## Protocol compatibility

The [protocol reference](STEP-1-GAS-ABSTRACTION.md) specifies the contracts and the relay API. Changes to these surfaces break existing clients and signatures and need a coordinated contract, relay and client review:

- the signed field order, the EIP-712 domains and the type strings;
- the ABI in `contracts/src/interfaces/IGaslessBase.sol` and `IGaslessTransfer.sol`;
- `sdk/src/core/types.ts`, `typedData.ts` and `constants.ts`;
- `sdk/src/relay/types.ts`, which defines the relay wire format.
