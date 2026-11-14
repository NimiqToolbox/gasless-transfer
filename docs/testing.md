# Testing

`make test-contained` builds an immutable verification image and runs the TypeScript checks, the SDK and relay tests, the local integration and fault tests, the tests of the backup and token-pin scripts, Solidity formatting and the default Foundry suite.

| Location | Scope | Runs with |
| --- | --- | --- |
| `contracts/test/` | Contract configuration, authorization, signatures, transfers, nonces, invariants and golden vectors | `forge test` |
| `sdk/test/core`, `relay`, `viem` | Typed-data hashing, pins, validation, the relay client and the viem adapter | `pnpm test` in `sdk/` |
| `sdk/test/*.test.ts` | Golden vectors (`vectors`, `vectorsEthers`), ABI files against the compiled contract (`abiSync`), built output (`dist`), identical signatures from viem and ethers (`signers`), and source rules: no logging or storage, a dependency-free core (`hygiene`) | `pnpm test` in `sdk/` |
| `sdk/test/security/` | Adversarial cases by subject: `signing`, `confirm` (on-chain confirmation), `corrections` (payment versions), `relay-client`, `bundles` (built output) | `pnpm test` in `sdk/` |
| `relay/test/unit/` | Configuration, fees, EIP-712, store, pipeline, transaction manager, logging | `pnpm test` in `relay/` |
| `relay/test/http/`, `relay/test/e2e/` | HTTP listeners and the process entrypoint against an in-process chain double | `pnpm test` in `relay/` |
| `relay/test/security/` | Adversarial cases by subject: `admission`, `config`, `http`, `pricing`, `rpc` (lying, silent or lagging providers), `secrets`, `tx` (transaction manager) | `pnpm test` in `relay/` |
| `relay/test/integration/` | Relay against Anvil and the real contract: transfers, errors, restarts, key rotation | `pnpm test:integration` in `relay/` |
| `relay/test/fault/` | Fault injection on a local chain: concurrency, reorgs, RPC errors, restarts; optional Polygon fork and gas calibration | `make test-fault` |
| `relay/test/stack/` | Complete local transfer stack | `make stack-test` |
| `relay/test/image/` | Runtime image restrictions, dependency closure and SQLite operation | `make relay-image-check` |
| `relay/test/ops/` | Alert rules | `make test-alerts` |
| `relay/scripts/*.test.mjs` | Backup, token-pin collection and deployment verifier scripts | `make test-contained` (the first two), `make test-deployment-verifier` |

The SDK tests that start Anvil and the relay integration and fault suites need Foundry and the pinned Solidity libraries; the verification image provides both.

Default tests run offline with disposable accounts. Polygon tests require an archive RPC:

```sh
POLYGON_RPC_URL=https://your-archive-rpc.example make test-fork-contained
```

Other targets: `make relay-image-check`, `make test-alerts`, `make test-deployment-verifier`, `make invariant-final`, `make coverage`, `make static`, `make mutation`, and `make artifact-check`. One check is run by hand when the Node version changes: `relay/test/image/objectWrapPatch.sh` (its header gives the two commands) shows what the header patch of the relay image changes and that the SQLite stress check catches the crash it prevents.

The local stack uses `make stack-up`, `make stack-test`, and `make stack-down`. Generated outputs go under `build/`. See [development](DEVELOPMENT.md) for individual commands.
