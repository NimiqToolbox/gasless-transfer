# GaslessTransfer

Gasless USDC and USDT0 transfers on Polygon PoS. A sender signs a transfer intent; a relay submits it, pays the gas in POL and receives the signed fee in the transferred token. The contract executes the transfer only with the sender's signature over every field of the intent.

Each intent binds the sender, recipient, token, amount, fee, relay, deadline, the sender's sequential nonce and the token authorization. Token authorization supports permits and existing allowances, with meta-transaction approval available for USDT0.

This repository contains the three parts of the protocol and their tests:

| Part | Path | What it is |
| --- | --- | --- |
| Contracts | [contracts/](contracts/) | `GaslessTransfer` (Solidity), its tests and deployment scripts |
| SDK | [sdk/](sdk/README.md) | TypeScript client: typed data, pins, signing, relay client and on-chain confirmation |
| Relay | [relay/](relay/README.md) | TypeScript server that validates signed intents, quotes fees and submits the transactions |

The [protocol reference](docs/STEP-1-GAS-ABSTRACTION.md) specifies the contracts, the signing rules and the relay API. The relay is software to run yourself; clients configure the relay URL and address they trust ([SDK pins](sdk/README.md)).

## Deployed contracts — Polygon PoS

Network: **Polygon mainnet, chain ID 137**.

GaslessTransfer has no maximum fee: only the fee the sender signs bounds what the relay is paid, so clients show the fee before the sender signs. Its EIP-712 domain version is `3`.

| Contract | Address | Supported authorization |
| --- | --- | --- |
| [GaslessTransfer](contracts/src/GaslessTransfer.sol) | [0x5A3a650fCf35639153aA6bA9aa3e870DAED56199](https://polygonscan.com/address/0x5A3a650fCf35639153aA6bA9aa3e870DAED56199) | Signed transfer intents |
| Native USDC | [0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359](https://polygonscan.com/address/0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359) | Permit, existing allowance |
| USDT0 | [0xc2132D05D31c914a87C6611C10748AEb04B58e8F](https://polygonscan.com/address/0xc2132D05D31c914a87C6611C10748AEb04B58e8F) | Permit, meta-transaction approval, existing allowance |

USDC and USDT0 are existing token contracts. `GaslessBase` and `TokenAuthLib` are compiled into `GaslessTransfer`; they have no separate deployment addresses.

| Deployment detail | Value |
| --- | --- |
| Transaction | [0x5e1851e9598de5b08f62f73bcbaee5e0b6f5eb7733aebfd3f62db0ee02bda14d](https://polygonscan.com/tx/0x5e1851e9598de5b08f62f73bcbaee5e0b6f5eb7733aebfd3f62db0ee02bda14d) |
| Block | [95,893,593](https://polygonscan.com/block/95893593) |
| Deployer and initial owner | [0x682c578E5f07E6A742Fa5C681507c785d3f32256](https://polygonscan.com/address/0x682c578E5f07E6A742Fa5C681507c785d3f32256) |
| Owner | [0x6465e47837DB340D8Ac465E2F58cD6c08b275965](https://polygonscan.com/address/0x6465e47837DB340D8Ac465E2F58cD6c08b275965) since block [96,722,258](https://polygonscan.com/block/96722258) |
| Transfer EIP-712 domain | Name `Nimiq Gasless Transfer`, version `3`, chain ID `137`, verifying contract `0x5A3a650fCf35639153aA6bA9aa3e870DAED56199` |
| Domain separator | `0x036cd5f7684d421a11ff62ffdd91308769a47e6fe620935caeba61c872d828de` |
| Runtime keccak256 | `0x8637b384103bf3468d6509a3529f190ce34f9ac48f521f01f6a4daa6e2388b21` |

Machine-readable record: [contracts/deployments/137.json](contracts/deployments/137.json). How to reproduce the deployed bytecode from this source: [Polygon deployment](docs/operations/polygon-137-deployment.md).

## Test deployment — Polygon Amoy

Network: **Polygon Amoy testnet, chain ID 80002**.

| Contract | Address | Supported authorization |
| --- | --- | --- |
| [GaslessTransfer](contracts/src/GaslessTransfer.sol) | [0xe5D40efb4a89F6D3aDd07D8881F4b372f02c8075](https://amoy.polygonscan.com/address/0xe5D40efb4a89F6D3aDd07D8881F4b372f02c8075) | Signed transfer intents |
| USDC, Circle's test token | [0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582](https://amoy.polygonscan.com/address/0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582) | Permit, existing allowance |
| USDT0, [mock](contracts/test/mocks/MockUSDT0.sol) | [0xfA9Dabbf3C68a126a627ad48098700DFc6F27c82](https://amoy.polygonscan.com/address/0xfA9Dabbf3C68a126a627ad48098700DFc6F27c82) | Permit, meta-transaction approval, existing allowance |

| Deployment detail | Value |
| --- | --- |
| Transaction | [0x37c8fa65a34305bfc3e6ac4b83ec78da5b96b91b13eb1236732e465080553294](https://amoy.polygonscan.com/tx/0x37c8fa65a34305bfc3e6ac4b83ec78da5b96b91b13eb1236732e465080553294) |
| Block | [51,892,090](https://amoy.polygonscan.com/block/51892090) |
| Deployer and owner | [0x6465e47837DB340D8Ac465E2F58cD6c08b275965](https://amoy.polygonscan.com/address/0x6465e47837DB340D8Ac465E2F58cD6c08b275965) |
| Transfer EIP-712 domain | Name `Nimiq Gasless Transfer`, version `3`, chain ID `80002`, verifying contract `0xe5D40efb4a89F6D3aDd07D8881F4b372f02c8075` |
| Domain separator | `0xed1217efe85143e718fc9f59d3cffb6a27f3d671bf2c3a70435f0efc6301a5d7` |

Record: [contracts/deployments/80002.json](contracts/deployments/80002.json).

## Build and test

The contracts need only Foundry 1.8.3 (natively or its pinned Docker image) and the two pinned libraries in `contracts/lib` ([how to fetch them](docs/DEVELOPMENT.md#dependencies)):

```sh
cd contracts
forge build
forge test
```

Contracts, SDK and relay together build and test in Docker (Linux, Docker Engine, Docker Compose v2, Bash and Make):

```sh
make test-contained      # type checks, SDK and relay tests, Solidity formatting and tests
make relay-image-check   # builds the relay runtime image and checks it from the inside
make stack-up            # local stack: Anvil, mock tokens, GaslessTransfer and the relay
make stack-test
make stack-down
```

Image builds need network access; the tests run offline with disposable keys. Polygon fork tests read an archive RPC and broadcast nothing:

```sh
POLYGON_RPC_URL=https://your-archive-rpc.example make test-fork-contained
```

[Development](docs/DEVELOPMENT.md) lists the pinned toolchain and every command; [testing](docs/testing.md) describes the suites.

## Repository layout

| Path | Contents |
| --- | --- |
| `contracts/src/` | `GaslessTransfer`, `GaslessBase`, `TokenAuthLib` and their interfaces |
| `contracts/test/` | Unit, specification, invariant, fork and golden-vector tests, test mocks |
| `contracts/test/vectors/data/` | Golden vectors: EIP-712 digests of transfers and token authorizations, checked by the contracts and the SDK |
| `contracts/script/` | Deployment scripts and the deployment-record writer |
| `contracts/deployments/` | Deployment records per chain ID |
| `sdk/src/` | `core` (zero-dependency signing core), `relay` (relay client), `viem` (viem adapter) |
| `sdk/abi/` | ABIs of GaslessTransfer and of the token functions the SDK uses |
| `sdk/test/` | SDK tests; `sdk/scripts/` regenerates the ABI files |
| `relay/src/` | HTTP API, validation pipeline, fee engine, transaction manager and SQLite store |
| `relay/config/` | Gas table, token implementation pins, example policy and alert rules |
| `relay/scripts/` | Operator scripts: state backup, token-pin collection and deployment verification |
| `relay/test/` | Relay tests by kind ([testing](docs/testing.md)) |
| `relay/docs/` | Storage and transaction lifecycle of the relay |
| `docker/` | Build, test and runtime images and their contained runners |
| `scripts/` | Native build helper and verification scripts |
| `docs/` | Protocol reference, development, deployment and operations |

## Documentation

- [Protocol reference](docs/STEP-1-GAS-ABSTRACTION.md) — contracts, signatures, invariants, token authorization and the relay API.
- [SDK](sdk/README.md) — client integration and examples.
- [Relay](relay/README.md) — configuration, HTTP API and operation; [storage](relay/docs/storage.md) and [transaction lifecycle](relay/docs/transaction-lifecycle.md).
- [Development](docs/DEVELOPMENT.md) — toolchain, build and tests; [testing](docs/testing.md) — the test suites.
- [Deployment](docs/deployment.md) — building, deploying contracts and running a relay; [Linux relay operation](docs/operations/linux-relay.md).
- [Polygon deployment](docs/operations/polygon-137-deployment.md) — reproducing the deployed bytecode.
- [Supply chain](docs/supply-chain.md) and [dependencies](docs/dependencies.md) — how build inputs are pinned, and licenses.
- [Containment](docs/containment.md) — the sandbox of the test and build runners.
- [Security](SECURITY.md) — trust assumptions, operating risks and vulnerability reporting.

## License

[MIT](LICENSE). Dependencies retain their own licenses; see [dependencies](docs/dependencies.md).
