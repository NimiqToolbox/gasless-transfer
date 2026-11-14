# Golden vectors (T30)

The SDK digest must equal the contract digest (T30). The JSON files in `data/` are generated from the
real `GaslessTransfer` and the token mocks (not from the test double in `sdk/test/fixtures/solidity`),
and both sides check the same files:

| Test | Runs in | Checks |
|---|---|---|
| `sdk/test/vectors.test.ts` | `pnpm test` | zero-dependency core (`hashDomain`, `transferDigest`, `typedDataDigest`) and viem (`hashTransfer`, `hashTypedData`) |
| `sdk/test/vectorsEthers.test.ts` | `pnpm test` | ethers v5 (`_TypedDataEncoder`) and ethers v6 (`TypedDataEncoder`); that both files exist, so `vectors.test.ts` cannot silently skip; that they cover the cases below |
| `GoldenVectorsTest` in `contracts/test/vectors/GoldenVectors.t.sol` | `forge test` | every digest in the committed files, recomputed by the contract (`hashTransfer(r, nonce, auth)`) and the tokens (`DOMAIN_SEPARATOR()`); then each file byte for byte against the generator, which runs on the current code |

## Files

| File | Chain | Contracts |
|---|---|---|
| `gasless-transfer-137.json` | Polygon PoS (137) | `MockUSDC` and `MockUSDT0` (`contracts/test/mocks`) at the real USDC `0x3c49…3359` and USDT0 `0xc213…8e8F` addresses, where their `DOMAIN_SEPARATOR()` equals the frozen mainnet pins `0xcaa2…e2ca` and `0x7b43…9a05` (asserted). `GaslessTransfer` sits at the placeholder `0x0000000000C0DE00000000000000000000000137`, so the vectors do not depend on a deployment address; its leading zero bytes exercise the domain encoding. It uses the mainnet configuration: USDC {permit, none} and USDT0 {permit, metaTxApprove, none}. |
| `gasless-transfer-31337.json` | anvil (31337) | The addresses `contracts/script/DeployLocalStack.s.sol` gets on a fresh anvil (account 0, nonces 0 to 2): MockUSDC `0x5FbDB2315678afecb367f032d93F642f64180aa3`, MockUSDT0 `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`, GaslessTransfer `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`. Same configuration. |

## How they are produced

`GoldenVectorsWriter` in `contracts/test/vectors/GoldenVectors.t.sol` installs the contracts at these
fixed addresses with `deployCodeTo`, so their constructors run there and the files are stable. It
then builds each file:

- Transfer digests are the deployed contract's `hashTransfer(r, nonce, auth)`: the request, the
  intent nonce and the token authorization, which is signed into the intent.
- Token authorization digests combine the token's `DOMAIN_SEPARATOR()` with the struct hash of the
  message: `keccak256(0x1901 ‖ DOMAIN_SEPARATOR() ‖ structHash)`. The struct hash uses the token's
  own `PERMIT_TYPEHASH()` and `nonces(owner)`. UChildUSDT0 keeps its `MetaTransaction` type hash
  private, so that one comes from spec §5. `functionSignature` is `approve(<GaslessTransfer>,
  amount + fee)`, encoded as `TokenAuthLib` encodes it.
- The first five transfers are executed in order at intent nonces 0 to 4: USDC permit (token nonces
  0 and 1), USDT0 permit (token nonce 0), USDT0 meta-tx approve (token nonce 1, since USDT0 shares one
  counter between permit and meta-tx), and USDC `none` after an exact approval. Anvil account #1
  signs the token authorization first, then the transfer digest over it, and account #9 (the relay)
  submits both through `relayTransfer`. For permit and meta-tx there is no allowance in place, so the
  call succeeds only if the contract recovers the signer from the transfer digest at the signer's
  current nonce and the token grants the allowance from its own digest. `GoldenVectorsTest` repeats
  this on every run.

Cases in each file:

- Fees 0, 10000, 5000000, 50000000 (executed: the contract bounds no fee) and `2^256 - 1`. The
  last comes with amount 1: it is hashed as signed, and `relayTransfer` reverts on amount + fee
  above `2^256 - 1`.
- Amounts 1, `2^256 - 1 - 5000000` (with fee 5000000) and `2^256 - 1` (with fee 0).
- Intent nonces 0 to 5, 7, 9, `2^32 - 1`, `2^256 - 1` and pseudo-random ones.
- Deadlines 0 and `2^256 - 1`.
- Authorizations of every mode; `none` with zero `v`, `r`, `s` (what clients sign) and with
  non-zero values, which are hashed as given; `v` 27 and 28.
- Both tokens, and each token sent to the other token's contract.
- `from`, `to` and `relay` with leading zero bytes.
- Checksummed (EIP-55 mixed-case) addresses, plus one request with all-lowercase addresses. That
  request has the same digest as its checksummed twin.
- Three pseudo-random requests with pseudo-random authorizations.
- Token authorizations: USDC permit (chainId domain), USDT0 permit (salt domain), and USDT0 meta-tx
  approve.

### Regenerating

Regenerate after a change to `contracts/src`, the mocks or the generator that alters the output.
`GoldenVectorsTest` fails when a digest or anything else in the generator's output changes (a
different type hash, domain, `hashTransfer` or token digest).

The writer skips itself unless `WRITE_GOLDEN_VECTORS=true`, and it needs a value for `source.commit`
(`GOLDEN_VECTORS_COMMIT`): the committed files carry 40 zeros, and the value changes no digest. Run it
on its own, because `GoldenVectorsTest` reads the same files. From `contracts/`:

```sh
WRITE_GOLDEN_VECTORS=true GOLDEN_VECTORS_COMMIT=0000000000000000000000000000000000000000 \
    forge test --match-contract GoldenVectorsWriter
```

Then run `forge test` and the SDK tests. `GoldenVectorsTest` reads `test/vectors/data` through the
project's `fs_permissions` (`contracts/foundry.toml`); `GoldenVectorsWriter` gets write access to that
directory through inline config (`/// forge-config: default.fs_permissions = …`), which applies to
that contract only.

## File format

`gasless-transfer-<chainId>.json`, with the keys in this order. The layout is that of
`JSON.stringify(value, null, 2)` plus a trailing newline, because `GoldenVectorsTest` compares the
files byte for byte:

```json
{
  "description": "…",
  "source": {
    "contract": "contracts/src/GaslessTransfer.sol",
    "commit": "<GOLDEN_VECTORS_COMMIT; 40 zeros in the committed files>",
    "generatedBy": "WRITE_GOLDEN_VECTORS=true GOLDEN_VECTORS_COMMIT=<commit> forge test --match-contract GoldenVectorsWriter"
  },
  "chainId": 137,
  "verifyingContract": "0x…",
  "typeHash": "0x…",
  "tokenAuthTypeHash": "0x…",
  "domainSeparator": "0x…",
  "transfers": [
    {
      "name": "USDC via permit: amount 1, fee 0, nonce 0",
      "request": {
        "token": "0x…", "from": "0x…", "to": "0x…", "amount": "1", "fee": "0",
        "relay": "0x…", "nonce": "0", "deadline": "1790000600"
      },
      "authorization": { "mode": "permit", "v": 27, "r": "0x…", "s": "0x…" },
      "digest": "0x…"
    }
  ],
  "tokenAuthorizations": [
    {
      "name": "USDC permit, nonce 0, for '…'",
      "kind": "permit",
      "domain": { "name": "USD Coin", "version": "2", "chainId": 137, "verifyingContract": "0x…" },
      "message": { "owner": "0x…", "spender": "0x…", "value": "…", "nonce": "0", "deadline": "…" },
      "digest": "0x…"
    },
    {
      "name": "USDT0 meta-tx approve, nonce 1, for '…'",
      "kind": "metaTxApprove",
      "domain": { "name": "USDT0", "version": "1", "verifyingContract": "0x…", "salt": "0x…89" },
      "message": { "nonce": "1", "from": "0x…", "functionSignature": "0x095ea7b3…" },
      "digest": "0x…"
    }
  ]
}
```

Values follow these rules:

- Integers are canonical decimal strings, except `chainId` and `authorization.v`, which are JSON
  numbers.
- `request` holds the signed request fields; `request.nonce` is the intent nonce, which the contract
  reads from `nonces(from)` and which is not part of the `TransferRequest` call data.
- `authorization.mode` is the SDK's `AuthModeName` (`none`, `permit`, `metaTxApprove`); the signed
  `TokenAuth.mode` is its enum value 0, 1 or 2.
- Addresses are checksummed, except in the all-lowercase vector.
- `bytes32` values and `functionSignature` are lowercase hex.

`tokenAuthorizations` is optional for the loader in `vectors.test.ts`. For every file, that test
checks the following:

- `typeHash` = keccak256 of the frozen `TRANSFER_TYPE`
  (`GaslessTransfer(…,uint256 nonce,uint256 deadline,TokenAuth auth)TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)`),
  and `tokenAuthTypeHash` = keccak256 of `TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)`.
- `domainSeparator` = the core `hashDomain` of `("Nimiq Gasless Transfer", "3", chainId, verifyingContract)`.
- For each transfer, the core `transferDigest` and the viem `hashTransfer` of the request, nonce and
  authorization equal `digest`.
- For each token authorization, the frozen builders rebuild the typed data from `domain` and
  `message`, and it hashes to `digest` with both the core `typedDataDigest` and the viem
  `hashTypedData`.

`vectorsEthers.test.ts` repeats the digest checks with ethers v5 and v6.
