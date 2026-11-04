# Development

All commands run from `contracts/`, the Foundry project root.

## Pinned toolchain

| Tool | Version or source pin |
| --- | --- |
| Foundry: forge, cast, anvil | 1.8.3; image `ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7` |
| solc | 0.8.28; settings in [contracts/foundry.toml](../contracts/foundry.toml): optimizer 10,000 runs, EVM `cancun`, no via-IR, IPFS metadata hash |
| OpenZeppelin Contracts | v5.6.1, commit `5fd1781b1454fd1ef8e722282f86f9293cacf256` |
| forge-std | v1.16.2, commit `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` |

These pins, the source paths and the remapping in [contracts/remappings.txt](../contracts/remappings.txt) are part of the metadata hash: other versions or layouts compile to different bytecode.

## Dependencies

The libraries are not vendored. Clone them at their pinned commits into `contracts/lib`:

```sh
git clone --quiet --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git clone --quiet --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std.git lib/forge-std
git -C lib/openzeppelin-contracts rev-parse HEAD   # 5fd1781b1454fd1ef8e722282f86f9293cacf256
git -C lib/forge-std rev-parse HEAD                # bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
```

## Build and test

```sh
forge build
forge test
```

The default profile runs the unit, specification, invariant and golden-vector suites. It excludes `test/fork` (run it with `FOUNDRY_PROFILE=fork`, below); `test/fork-verify` skips itself unless `VER_FORK=true` and `POLYGON_RPC_URL` are set. `forge fmt --check` checks formatting.

## Fork tests

Fork tests read Polygon state through an archive-capable RPC and execute only locally; nothing is broadcast.

```sh
POLYGON_RPC_URL=<archive RPC URL> FOUNDRY_PROFILE=fork forge test
VER_FORK=true POLYGON_RPC_URL=<archive RPC URL> forge test --match-path 'test/fork-verify/*'
```

The `test/fork` suites pin block `94421000` and accept a `FORK_BLOCK` override.

## Golden vectors

`contracts/test/vectors/data/gasless-transfer-137.json` and `gasless-transfer-31337.json` hold the T30 golden vectors: transfer and token authorization digests generated from `contracts/src` and the token mocks. `GoldenVectorsTest` fails when a file differs from the generator's output. Regenerate both files after a change that affects them; `source.commit` records a commit (40 zeros in this repository) and changes no digest:

```sh
WRITE_GOLDEN_VECTORS=true GOLDEN_VECTORS_COMMIT=<commit> forge test --match-contract GoldenVectorsWriter
```

## Long invariant run

```sh
FOUNDRY_PROFILE=invariant-final forge test --summary
```

## Static analysis

Slither 0.11.6 reads its configuration from [contracts/slither.config.json](../contracts/slither.config.json) (`slither .` in `contracts/`).

## Deployed bytecode

[Polygon deployment](operations/polygon-137-deployment.md) reproduces the deployed creation and runtime bytecode from this source.

## Protocol compatibility

The [protocol reference](STEP-1-GAS-ABSTRACTION.md) specifies the contracts. The signed field order, the EIP-712 domains, the ABI in `contracts/src/interfaces/IGaslessBase.sol` and `IGaslessTransfer.sol`, and the type strings are compatibility boundaries: changing them breaks existing clients and signatures.
