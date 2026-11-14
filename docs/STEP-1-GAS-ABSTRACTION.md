# Gasless transfer protocol reference

This reference describes the implemented transfer contract, token authorization, relay API and client signing rules. See [deployment.md](deployment.md) for deploying and operating a relay, [polygon-137-deployment.md](operations/polygon-137-deployment.md) for the deployed contracts and [DEVELOPMENT.md](DEVELOPMENT.md) for building and testing.

The production token configuration is Polygon PoS (chain 137): native USDC 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 and USDT0 0xc2132D05D31c914a87C6611C10748AEb04B58e8F. The separate Amoy deployment on chain 80002 uses Circle's test USDC and a mock USDT0.

---

## 1. Scope

A sender authorizes a token transfer through a signed intent. The relay pays POL transaction gas and receives the signed fee in the transferred token. The transfer contract takes no custody of the principal and has no upgrade path.

The implementation consists of GaslessTransfer, its GaslessBase and TokenAuthLib dependencies, a persistent HTTP relay and a client SDK. This reference covers transfers only. The SDK provides a dependency-free signing core, relay client and viem adapter; the core is also available as an IIFE for isolated signing applications.

Signed field order, EIP-712 domains, ABI and wire types are compatibility boundaries. Changes require coordinated contract, relay and client review.

---

## 2. Protocol rules

| # | Decision |
|---|---|
| D1 | Signatures are ECDSA only, verified with OpenZeppelin `ECDSA.tryRecoverCalldata` (rejects high-s and malformed signatures). `from != address(0)`. No ERC-1271. |
| D2 | Replay protection uses one sequential nonce per signer, `nonces(signer)`. The contract reads it from storage: it is signed, but not part of the call data. A transfer raises it by exactly one before any external call, so a signer's requests execute in nonce order and at most one request per nonce executes. A signer cancels every request signed for a nonce below `newNonce` with a direct call to `invalidateNonces(newNonce)`, which raises its own nonce by 1 to 2^32 − 1 at once. |
| D3 | Deadlines are unix seconds, and a request is valid while `block.timestamp <= deadline`. The relay accepts transfer deadlines 60 s to 2 h in the future. |
| D4 | The contract obtains token authorization itself (§5). Permit `value = amount + fee` and permit `deadline = intent deadline`. The token call is wrapped in `try {} catch {}`, followed by an allowance check, so front-running cannot block it. The token authorization (`mode`, `v`, `r`, `s`) is part of the signed intent. Modes: USDC {PERMIT, NONE}; USDT0 {PERMIT, META_TX_APPROVE, NONE}. |
| D5 | The user co-signs the relay. Every signed request contains `address relay`, and the contract requires `msg.sender == relay`. The fee goes to `relay`. The contract has no allowlist, no pause, no rescue and no upgrade path; its owner can only change the token configuration (D6). Stopping a relay prevents further broadcasts by that operator; it does not revoke signed or broadcast requests. Rotating the relay key only requires clients to sign for the new address. |
| D6 | Each token has a configuration: its allowed auth modes. The constructor sets the initial tokens. The owner (`Ownable2Step`, a non-zero constructor argument) adds a token, replaces its configuration or removes it with `setTokenConfig`, which emits `TokenConfigSet`. The owner has no other power: it cannot move tokens, change nonces or alter a signed request. A configuration change can make a signed request fail, and it can make executable a signed request that the previous configuration refused (by adding its token or mode): a signed request stays valid until its nonce is used or its deadline passes, whatever the configuration. The contract sets no fee bound: the fee is what `from` signs, in the token's own units. The relay's quote is a hint; the client must show the fee to the user and check it before signing (§7). `renounceOwnership` freezes the configuration. |
| D10 | One `GaslessTransfer` covers the token type "ERC-20 stablecoin" (USDC and USDT0). |
| D11 | The contract rejects `to` ∈ {0, token, this}. The relay and SDK also reject every pinned token address, the pinned transfer contract, extra configured denied recipients, and the fixed legacy-recipient list on chain 137. The SDK also refuses a legacy contract as the pinned transfer contract on chain 137. |
| D13 | Fee first: the fee transfer to the relay executes before the principal transfer, within the same atomic call. This only affects the order of `Transfer` logs; the principal is the last one. The contract emits no event of its own for a transfer. |

---

## 3. Security principles and invariants

These authorization and execution properties are checked by the verification properties in §8.

**Principles:**
- **P1, only signed pulls.** A third party's tokens move only if that party's EIP-712 signature over *every* parameter (including `relay`, the nonce and the token authorization) is verified by this contract, in the same call. The signature is checked first: a request its sender did not sign meets no other check and causes no external call. This holds regardless of any existing allowance.
- **P2, own domain.** `("Nimiq Gasless Transfer", "3", chainId, verifyingContract)`, recomputed if the chainId changes. No replay across contracts, chains or tokens (the token is a signed field).
- **P3, minimal surface.** No `delegatecall`, arbitrary calldata, multicall, `receive`/`fallback`, proxy or `selfdestruct`. The only privileged functions are the owner's `setTokenConfig` and `Ownable2Step`'s own. A test compares `methodIdentifiers` with the allowlist in §4.4.

**What a relay can do.** A compromised relay key can only submit requests that users signed *for that relay*, with exactly the signed amounts, fee and token authorization. It can also withhold them (censorship). A withheld request leaves its nonce unused, so the sender's requests at later nonces wait as well. The sender signs another request at the same nonce for another relay, or sends with POL; at most one of the requests signed for a nonce executes. The relay cannot choose or swap the token authorization, which is signed (§4.1).

**Invariants:**
- **TI1 (successful transfer):** `from` pays `amount + fee`, `to` receives `amount`, and `relay == msg.sender` receives `fee`. `nonces[from]` rises from the signed nonce n to n + 1, the recovered signer equals `from`, and `block.timestamp <= deadline`.
- **TI2 (no unsigned debits):** no actor's balance decreases unless a tuple that actor signed is consumed in that transaction.
- **TI3 (nonces):** a signer's nonce never decreases. It rises by exactly one with each of its executed requests and otherwise only through its own `invalidateNonces`; no other account and no failed call changes it.
- **TI4 (no custody):** the contract's token balance stays 0, apart from tokens someone donates directly.
- **TI5 (no leftover allowance):** after a PERMIT-mode or META_TX-mode call, `allowance(from, this) == 0`. The contract enforces this: in these modes the allowance must equal `amount + fee` exactly before the pulls (§4.1).

The balance deltas in TI1 are additive by address: when the sender, recipient, or relay are the same account, sum their debits and credits. Self-transfers and self-relaying remain valid. TI1 and TI5 assume the configured token actually transfers the requested amounts and decrements allowance by the transferred value, as the reviewed USDC/USDT0 implementations do. SafeERC20 validates call results; it cannot guarantee honest accounting from arbitrary or issuer-upgraded tokens. A front-run token approval is a separate transaction and is not undone by an intent cancellation or a later reverted relay call.

**Security properties:**
- **A1:** no unauthorized pull through an existing allowance.
- **A2:** a field missing from the typed data.
- **A3:** replay (same contract, other contract, other chain, other token).
- **A10:** front-running the token authorization.
- **A11:** fee manipulation.

---

## 4. Contracts

### 4.1 `TokenAuthLib`

```solidity
enum AuthMode { NONE, PERMIT, META_TX_APPROVE }
struct TokenAuth { AuthMode mode; uint8 v; bytes32 r; bytes32 s; }   // signed; v,r,s unused for NONE (clients sign 0)

/// Ensures this contract may pull exactly `required` from owner, obtaining the allowance via the owner's token
/// signature if given: allowance == required in PERMIT/META_TX_APPROVE, >= required in NONE.
function ensureAllowance(address token, address owner, uint256 required, uint256 deadline, TokenAuth calldata auth) internal;
```

1. **PERMIT:** `try IERC20Permit(token).permit(owner, address(this), required, deadline, v, r, s) {} catch {}`
2. **META_TX_APPROVE:** `try INativeMetaTransaction(token).executeMetaTransaction(owner, abi.encodeCall(IERC20.approve, (address(this), required)), r, s, v) {} catch {}`. The call data is built by the contract; nothing is forwarded from the caller.
3. **Always afterwards**: `uint256 a = IERC20(token).allowance(owner, address(this));`
   - NONE requires `a >= required`.
   - PERMIT and META_TX_APPROVE require `a == required`.
   - Otherwise the call reverts with `InsufficientAllowance(a, required)`.

   In PERMIT and META_TX_APPROVE mode the two pulls then consume exactly `required`, so the allowance is 0 afterwards (TI5).

   **Standing allowances.** A standing allowance of any other value than `required` can only be spent in NONE mode, which `TokenConfig.allowance` gates.

   An allowance of exactly `required` that is already in place is accepted in every mode and used up, even when `TokenConfig.allowance` is false. The contract cannot tell it apart from a front-run of the request's own token signature (T18). An owner's plain `approve(this, amount + fee)` is therefore spent like one.

**Who chooses the mode**. The sender. `TokenAuth` is part of the signed intent (§4.3), so the relay must submit exactly the mode, `v`, `r` and `s` the sender signed; anything else reverts with `InvalidSignature`. If a token authorization becomes unusable (for example a burned USDT0 nonce, §5), the relay cannot replace it: the sender signs the intent again, at the same nonce, with a fresh one. In every mode the contract itself fixes the authorized value to `amount + fee` and the spender to itself, and the pulls move exactly the signed amounts to the signed recipient and relay. A transfer can still be served from an allowance already in place, leaving the token signature unused: any allowance ≥ `amount + fee` in NONE mode (if the token allows NONE), and exactly `amount + fee` in PERMIT and META_TX_APPROVE mode. An unused permit expires at the intent deadline. An unused USDT0 meta-tx does not expire (§5).

### 4.2 `GaslessBase`: EIP712, ReentrancyGuardTransient and Ownable2Step

```solidity
struct TokenConfig { bool permit; bool metaTxApprove; bool allowance; }   // one storage slot; no fee bound
struct TokenInit { address token; TokenConfig config; }

string public constant TOKEN_AUTH_TYPE = "TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)";
bytes32 public constant TOKEN_AUTH_TYPEHASH = keccak256(bytes(TOKEN_AUTH_TYPE));
mapping(address signer => uint256) public nonces;              // the nonce of the signer's next request

event NonceInvalidated(address indexed signer, uint256 previousNonce, uint256 newNonce);
event TokenConfigSet(address indexed token, TokenConfig config);
// plus Ownable2Step's OwnershipTransferStarted and OwnershipTransferred

error InvalidConfig();
error NotRelay(address caller, address relay);
error DeadlineExpired(uint256 deadline);
error InvalidSigner();
error InvalidSignature();
error InvalidNonceIncrease(uint256 currentNonce, uint256 newNonce);
error TokenNotSupported(address token);
error AuthModeNotSupported(address token, AuthMode mode);
error InsufficientAllowance(uint256 allowance, uint256 required);
error ZeroAmount();
error InvalidRecipient(address to);
// plus Ownable's OwnableUnauthorizedAccount(address) and OwnableInvalidOwner(address)

constructor(string memory name, address initialOwner, TokenInit[] memory tokens)
    EIP712(name, "3") Ownable(initialOwner);
    // OwnableInvalidOwner(0) for a zero owner. InvalidConfig if: no tokens, an entry without any mode, a token an
    // earlier entry already enabled (a duplicate), or an entry setTokenConfig would reject

function tokenConfig(address token) external view returns (TokenConfig memory);   // all false: not supported
function DOMAIN_SEPARATOR() external view returns (bytes32);   // plus OZ eip712Domain() (EIP-5267)
function invalidateNonces(uint256 newNonce) external;
    // msg.sender's own nonce: current < newNonce <= current + 2^32 - 1, else InvalidNonceIncrease
function setTokenConfig(address token, TokenConfig calldata config) external onlyOwner;
    // A config with a mode needs a token with code and token != this, else InvalidConfig; one without any mode
    // removes the token, for any address. Emits TokenConfigSet.
// plus Ownable2Step's owner, pendingOwner, transferOwnership, acceptOwnership and renounceOwnership

// internal helpers
function _requireToken(address token, AuthMode mode) internal view;
    // one storage read; TokenNotSupported (no mode enabled) / AuthModeNotSupported
function _requireRelay(address relay) internal view;                  // msg.sender == relay, else NotRelay
function _checkDeadline(uint256 deadline) internal view;              // block.timestamp <= deadline
function _verify(address signer, bytes32 structHash, bytes calldata sig) internal view;
    // signer != 0 (InvalidSigner); ECDSA.tryRecoverCalldata(_hashTypedDataV4(structHash), sig) == (signer, NoError)
```

NONE mode requires `TokenConfig.allowance`. Even in NONE mode the intent signature from `from` is mandatory. The token pulls (`_collect`) belong to `GaslessTransfer` (§4.3); `TokenAuthLib` stays a separate library.

**Gas**. The reentrancy guard keeps its flag in transient storage (`ReentrancyGuardTransient`, EIP-1153; Cancun, which Polygon PoS and Amoy run), and the signature is read from calldata: on the mocks this saves about 4,900 gas per `relayTransfer` against a storage guard with a memory copy (`GasMeterTest`). solc 0.8.28 does not fold `TOKEN_AUTH_TYPEHASH` and `TRANSFER_TYPEHASH` (§4.3), written as hashes of the type strings, into constants: each call hashes them, about 510 gas more than literal hashes.

**Owner**. The owner manages the token configuration and nothing else. It cannot pull tokens, change nonces or alter a signed request, so no funds move without the sender's signature (P1). A compromised owner key can:
- remove tokens or modes, so that pending and new requests revert (liveness);
- make executable a signed request that the configuration refused, as long as its nonce is unused and its deadline has not passed, by adding its token or mode. A refusal with `TokenNotSupported` or `AuthModeNotSupported` is therefore not final; only the nonce and the deadline are.

The owner has no say over the fee: the contract pays the relay exactly the fee `from` signed, however large. Only the client bounds it (§7).

Ownership moves in two steps (`transferOwnership`, then `acceptOwnership` by the new owner). After `renounceOwnership` the configuration is fixed for good.

**Trusted token set**. Robustness against a hostile token rests on the configured tokens being trusted (USDC and USDT0):
- `nonReentrant` blocks re-entry.
- SafeERC20 and the try/catch token calls bound the returndata they copy.
- The high-level `allowance()` read copies the whole returndata, so a token that returns megabytes there makes the call run out of gas. This is a token-behavior assumption, not a bound enforced by the transfer contract.

Adding another token with `setTokenConfig`, or relying on a changed token implementation, requires compatibility and security review. The contract takes any token, with the fee in that token's units and of any size, but the relay and the SDK serve only the 6-decimal USD stablecoins USDC and USDT0 (§6.4, §7): serving another token needs relay and SDK changes (decimals, a price source for the token, `MIN_FEE` and the fee granularity).

### 4.3 `GaslessTransfer`

**EIP-712:**
- Domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` = `("Nimiq Gasless Transfer", "3", 137, <address>)`.
- Type (`TRANSFER_TYPE`, the struct type followed by `GaslessBase.TOKEN_AUTH_TYPE`): `GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)`.
- `mode` is the `AuthMode` value: 0 NONE, 1 PERMIT, 2 META_TX_APPROVE. `nonce` is `nonces(from)` when the request executes.
- Struct hash: `keccak256(abi.encode(TRANSFER_TYPEHASH, token, from, to, amount, fee, relay, nonce, deadline, keccak256(abi.encode(TOKEN_AUTH_TYPEHASH, mode, v, r, s))))`.

```solidity
struct TransferRequest { address token; address from; address to; uint256 amount; uint256 fee; address relay; uint256 deadline; }
string public constant TRANSFER_TYPE = string(abi.encodePacked("GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)", TOKEN_AUTH_TYPE));
bytes32 public constant TRANSFER_TYPEHASH = keccak256(bytes(TRANSFER_TYPE));
// TOKEN_AUTH_TYPE and TOKEN_AUTH_TYPEHASH come from GaslessBase (§4.2)

constructor(address initialOwner, TokenInit[] memory tokens) GaslessBase("Nimiq Gasless Transfer", initialOwner, tokens);
function relayTransfer(TransferRequest calldata r, bytes calldata signature, TokenAuth calldata auth) external nonReentrant;
function hashTransfer(TransferRequest calldata r, uint256 nonce, TokenAuth calldata auth) external view returns (bytes32);
    // EIP-712 digest = relay request id

// private
function _collect(address token, address from, address to, uint256 amount, uint256 fee,
                  address relay, uint256 deadline, TokenAuth calldata auth) private;
    // TokenAuthLib.ensureAllowance(token, from, amount + fee, deadline, auth);   // amount + fee overflow: Panic(0x11)
    // if (fee > 0) safeTransferFrom(token, from, relay, fee);   // fee first (D13)
    // safeTransferFrom(token, from, to, amount);
```

**`relayTransfer` order:**

Signature first:
1. `nonce = nonces[r.from]`, then `_verify(r.from, structHash(r, nonce, auth), signature)`. Nothing is checked or called before.

Checks:

2. `_requireToken(r.token, auth.mode)`
3. `_requireRelay(r.relay)`
4. `_checkDeadline(r.deadline)`
5. `r.amount > 0` (`ZeroAmount`) and `r.to ∉ {0, r.token, this}` (`InvalidRecipient`)

No check bounds the fee: it is what `from` signed.

Effect:

6. `nonces[r.from] = nonce + 1`

Interactions:

7. `_collect(r.token, r.from, r.to, r.amount, r.fee, r.relay, r.deadline, auth)`

A request signed for another nonce, or submitted with another token authorization, fails at step 1 with `InvalidSignature`; the contract cannot tell it from a forged one. A request whose `amount + fee` exceeds 2^256 − 1 reverts in step 7 before any token call. A reverted call leaves the nonce unchanged.

Log order. Guaranteed, in this order:
1. The token authorization's logs, if this call executes the token authorization (PERMIT and META_TX_APPROVE only). They are absent when the permit or meta-tx was executed before (front-run, T13–T15) or is otherwise no longer valid, and the call is then paid from exactly `amount + fee` already in place. An allowance of exactly `amount + fee` does not skip a valid token authorization: it still executes and logs.
2. `Transfer(from → relay, fee)`, only if `fee > 0`.
3. `Transfer(from → to, amount)`, the last `Transfer` log of the call.

`GaslessTransfer` itself emits nothing. Tokens emit further events in between, so consumers filter by emitter and topic:
- **USDC:** PERMIT emits `Approval`, `Transfer` (fee), `Transfer` (amount). NONE emits the same without the `Approval`, and so does a PERMIT call whose permit was executed before.
- **USDT0:** every `transferFrom` also emits an `Approval` with the reduced allowance, and `executeMetaTransaction` emits `MetaTransactionExecuted` before the meta-tx `Approval`.
  - A META_TX_APPROVE call with a fee therefore emits six logs: `MetaTransactionExecuted`, `Approval`, `Transfer`, `Approval`, `Transfer`, `Approval`.
  - It emits four logs, without the first two, when the meta-tx was executed before.

An executed request shows on-chain as a successful call of the relay's transaction, the principal `Transfer` and `nonces(from)` above the signed nonce. `NonceInvalidated` marks nonces the signer cancelled.

### 4.4 External surface (allowlist)

- Transfer: `relayTransfer`, `hashTransfer`, `TRANSFER_TYPE`, `TRANSFER_TYPEHASH`, `TOKEN_AUTH_TYPE`, `TOKEN_AUTH_TYPEHASH`
- Nonces: `nonces`, `invalidateNonces`
- Config and EIP-712: `tokenConfig`, `setTokenConfig` (owner only), `DOMAIN_SEPARATOR`, `eip712Domain`
- Ownership (`Ownable2Step`): `owner`, `pendingOwner`, `transferOwnership`, `acceptOwnership`, `renounceOwnership`

Nothing else.

### 4.5 Ephemeral signer accounts

An ephemeral key can hold tokens. It signs a `GaslessTransfer` of `balance − fee` to the recipient, at its current nonce (0 for a fresh key). The same authorization and nonce rules apply; no special method is required.

---

## 5. Token authorization (client side)

| Token | Mode | The user signs | Domain |
|---|---|---|---|
| USDC (FiatTokenV2_2) | PERMIT | `Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)`, nonce = `nonces(owner)` | `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` = `("USD Coin","2",137,token)` |
| USDT0 (UChildUSDT0) | PERMIT | same `Permit`, nonce = `nonces(owner)` (shared with meta-tx) | `EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)` = `("USDT0","1",token,bytes32(uint256(137)))` |
| USDT0 | META_TX_APPROVE | `MetaTransaction(uint256 nonce,address from,bytes functionSignature)`, where `functionSignature = approve(<GaslessTransfer>, amount + fee)` and nonce = `getNonce(owner)` | same USDT0 salt domain |

**Values:** `spender` is always `GaslessTransfer`. `value` is always `amount + fee`. The permit `deadline` equals the intent deadline; the SDK never signs 0 or max.

**Signing order:** the client signs the token authorization first, then the `GaslessTransfer` intent over it: `TokenAuth(mode, v, r, s)` holds that signature with v 27 or 28 (the SDK normalizes 0/1 before the intent signs it), or zeros for NONE. A relay therefore cannot submit the intent with another authorization or mode (`InvalidSignature`), and the relay request id, the intent digest, depends on the token signature. A wallet that stores a payment's version keeps `tokenAuthHash` (the `TokenAuth` struct hash) instead of the signature.

**USDT0 nonces:** they are sequential and shared between permit and meta-tx, so a token signature is valid only for the owner's current token nonce. The relay keeps at most one pending request per sender (`sender_busy`), so two pending token authorizations of one owner never compete.

**Storing token signatures**. META_TX signatures never expire on-chain; only a later use of the owner's USDT0 nonce kills them. So the relay:
- persists token signatures only for accepted requests;
- keeps them only until the outcome is final, because a crash or reorg can require re-sending the stored transaction (§6.5);
- then purges them from every database file;
- never logs them.

**A broadcast META_TX stays public**. Once broadcast, a META_TX is public for good, whatever the outcome. If the call reverts or is cancelled, anyone can still execute it later. That creates an allowance of `amount + fee` for this contract, which moves nothing without a new intent signature but uses up the nonce. The SDK therefore prefers PERMIT for USDT0, whose deadline is the intent deadline. It uses META_TX_APPROVE only for a token without permit, or when the caller asks for it: `prepareTransfer` with `authMode: 'metaTxApprove'`, or `createTransferIntent` with the option `allowMetaTxApprove`. Otherwise the core refuses it with `meta_tx_approve_not_allowed`.

**EIP-7702-delegated EOAs**. USDC verifies permits of accounts with code through ERC-1271 of the account's delegate, not ECDSA, so whether such a permit works depends on the delegate:
- It fails for delegates without ERC-1271.
- It succeeds for delegates that accept the account's key.
- A permissive delegate even accepts permits nobody signed. P1 still holds, because the intent signature is ECDSA.

Handling of USDC permits from accounts with code:
- **Relay:** refuses them as a policy: at acceptance with `invalid_token_authorization`, and again before every broadcast (with the same code, or with the simulation's error if the delegate already makes the permit fail). A delegation made after acceptance could otherwise turn the call into a gas burner.
- **SDK:** refuses them unless the caller sets `allowEip7702Permit`, and suggests a one-time approval plus NONE mode.

USDT0 verifies permits and meta-txs with `ecrecover`, so 7702 accounts can use both.

---

## 6. Relay (TypeScript, Node 24, viem, Fastify 5, zod, better-sqlite3)

### 6.1 Conventions

- Base path `/v1`.
- Bodies are JSON. Integers are decimal strings, addresses are checksummed hex, and `bytes32` values are `0x` plus 64 hex characters.
- Errors use the shape `{"error": {"code": "<code>", "message": "..."}}`.
- Status codes: 400 invalid, 402 fee too low, 404 not found, 409 conflict/used/busy, 422 unprocessable, 429 rate limited, 500 internal error, 503 unavailable. 410 is not used:
  - At submit time, a deadline outside the window is 400 `deadline_out_of_range`.
  - A request whose deadline passes before inclusion gets status `expired`, with error code `deadline_out_of_range`.

### 6.2 Endpoints

- **`GET /v1/info`** returns `{version, chainId, relay, contracts:{transfer:{address, domain}}, tokens:[{symbol, address, decimals, authModes, tokenDomain}], policy:{minDeadlineSeconds:60, maxDeadlineSeconds:7200, quoteTtlSeconds:120}}`. The transfer domain has version `"3"`. No token names a fee cap: there is none (§4.2).
- **`GET /v1/fee?operation=transfer&token=<addr>&authMode=permit|metaTxApprove|none`** returns `{operation, token, authMode, fee, relay, gasUnits, gasPrice, polUsd, issuedAt, expiresAt, quoteId}`.
- **`POST /v1/transfer`** with body `{request:{token,from,to,amount,fee,relay,nonce,deadline}, signature:"0x<65 bytes>", authorization:{mode, v, r, s}, quoteId?}`. `nonce` is the intent nonce as a decimal string; the signature covers the request, its nonce and the token authorization (§4.3); mode `none` has `v`, `r` and `s` zero:
  - 202 `{id:"0x<EIP-712 digest>", status:"queued"}`; the digest is `hashTransfer(r, nonce, auth)`.
  - An identical re-post returns 200 with the current state.
  - A nonce below the sender's next nonce returns 409 `nonce_used`, one above it 409 `nonce_too_high`. At the next nonce, a different pending request returns 409 `conflict`.
- **`GET /v1/requests/:id`** returns `{id, operation, status:"queued|submitted|mined|confirmed|failed|expired", request, authHash, transactions:[{hash, txNonce, maxFeePerGas, status}], txHash, blockNumber, error}`. `authHash` is `hashStruct(TokenAuth)` of the request's token authorization; with `request` it gives the id, also after the authorization was purged. `txHash` is always the final hash, including after a speed-up.
- **`/healthz`, `/readyz`, `/metrics`**.
  - Readiness requires all of these:
    - the RPC is on the right chain;
    - the relay's POL balance is above a threshold;
    - a validated POL/USD price exists (§6.4);
    - the transaction manager is live and healthy: it has recovered and completes its passes, it can pay for its transactions, and it has no lasting nonce gap and no lagging `finalized` tag. It must also not be stalled: requests wait to be sent, but no relay transaction was broadcast, sped up or included, and no queued request ended in its check before the broadcast, for `RELAY_STUCK_AFTER_BLOCKS`.
  - Ordinary reachability and balance checks use the first RPC that answers. Oracle prices and irreversible transaction decisions require agreement across all configured providers.
  - `degraded` is true in three cases:
    - A token's EIP-712 domain differs from the configured one, as after a USDT0 rename. That token's PERMIT and META_TX requests then get `unsupported_auth_mode`, and everything else works.
    - The transaction manager reports a backlog (the oldest queued request has waited longer than `RELAY_STUCK_AFTER_BLOCKS`), requests held at their spend cap, or a settle backlog (more provisional outcomes wait to settle than a pass checks, §6.5).
    - An RPC refused the state of older blocks in the last check it answered (§6.5, "Key and nonce"; repeated every `RELAY_RPC_HISTORY_CHECK_SECONDS`, default 600), with an alert. Only the decisions that locate the use of an intent nonce wait.

    A degraded relay stays ready. `degraded` is reported whether the relay is ready or not.
  - The public listener's `/readyz` returns only `{ready, degraded}`. The full report, with the reasons and the degraded conditions, and `/metrics` are served on a separate internal listener (default `127.0.0.1:9464`).
  - Reports are cached (5 s). The age of a report and the time since the last pass are measured on a monotonic clock, so a step of the system clock changes neither. `/healthz` does no I/O. No route is limited by client address: however often `/readyz` is requested, the cache allows one set of readiness reads per period.
  - At startup, a token whose on-chain `DOMAIN_SEPARATOR()` differs from the deployment file starts the relay degraded, exactly as a rename while it runs. A `GaslessTransfer` domain mismatch, or a deployment file that contradicts the SDK pins, still stops startup, and so does an RPC without the state of older blocks (§6.5).

### 6.3 Validation pipeline

Checks run in order; the first failing check returns its code.

| # | Check | Error code |
|---|---|---|
| 1 | Strict zod schema, body ≤ 16 KB, unknown fields rejected | `invalid_request` |
| 2 | Policy: `relay == self`; token and mode supported; `amount > 0`; recipient not on the D11 denylist; `now+60 ≤ deadline ≤ now+7200`; no upper bound on the fee | `wrong_relay`, `unsupported_token`, `unsupported_auth_mode`, `invalid_amount`, `invalid_recipient`, `deadline_out_of_range` |
| 3 | Local EIP-712 recovery of the `GaslessTransfer` digest (request, nonce and the nested `TokenAuth`) equals `from` (65 bytes, low-s) | `invalid_signature` |
| 4 | The nonce must be the sender's next nonce: `nonces(from)` at block B, raised past the sender's requests the relay recorded as included after B. Lower: `nonce_used`; higher: `nonce_too_high`; equal while B does not show such an inclusion yet: `sender_busy`. Then the DB: another request holding the nonce is a `conflict` (a failed or expired one not yet settled: `sender_busy`) | `nonce_used`, `nonce_too_high`, `sender_busy`, `conflict` |
| 5 | Fee acceptance (§6.4): `fee ≥ max(MIN_FEE, breakEven)` | `fee_too_low` (402) |
| 6 | `balanceOf(from) ≥ amount+fee`; USDC `paused()` and `isBlacklisted(from, to, relay, contract)`; USDT0 `isBlocked(from)` | `insufficient_balance`, `token_paused`, `blocked_address` |
| 7 | First `sender_busy`, in this order: a PERMIT/META_TX request of (token, from) that is pending, or that the relay recorded as included after block B (the reads at B show neither its token nonce nor the allowance it set and used); for a PERMIT/META_TX request, a pending NONE request of (token, from), whose allowance it would replace; any queued or in-flight request of `from`, across tokens (one pending request per sender: GaslessTransfer executes a sender's requests in nonce order). Then the token authorization: rebuild the token typed data with the current token nonce and recover the signer. NONE mode instead requires `allowance ≥ amount+fee` plus the sender's pending NONE debits. | `sender_busy`, `invalid_token_authorization`, `insufficient_allowance` |
| 8 | `simulateContract` from the relay account; custom errors are decoded | `simulation_failed` |
| 9 | Persist the request (unique on `(contract, from, nonce)` among the requests that hold the nonce: all but a settled failed or expired one), then enqueue it. The sender's cool-down is checked again right before. The same database transaction re-checks the queue bound, the balance, the allowance, the three `sender_busy` conditions and retained-row capacity. It counts the sender's pending requests and also its requests included after block B, the block that steps 4 to 8 read. In a full queue, a queued request held at its spend cap gives way in that transaction (see "Queue bound"). A refusal of steps 6 to 9 caused by another request stored at the same nonce meanwhile is answered `conflict`. | `conflict`, `unavailable`, `rate_limited`, `insufficient_balance`, `insufficient_allowance`, `sender_busy` |

Notes on the steps and on the rate limit:
- `sender_busy` comes first in step 7. A client that signs for the next token nonce while a request is pending then gets the retryable 409, not a permanent `invalid_token_authorization`.
- The per-signer rate limit is checked after step 3 and charged only after step 4. So re-posting someone's public intent cannot use up their quota. A changed token authorization changes the digest of step 3, so a copied intent cannot be posted with another one.
- **Queue bound**: after step 3, while `RELAY_MAX_QUEUED` (default 100) requests are queued and none of them is held at its spend cap, the answer is 503 `unavailable`. That happens before any RPC read, and nothing is stored. If queued requests are held at their cap, a new request that passes every check takes the place of the held one with the lowest cap per gas (then the oldest), in the step-9 transaction. That request was never broadcast and has no higher priority; it ends `failed` with `fee_too_low`, final at once, and its secrets are purged. Admission requires a fee that covers the current break-even, so the new request can be sent at that moment. A sender may have only one queued request at a time that took a held request's place: it may make another held request give way once that request was broadcast or left the queue, and not while it cools down (see below). Otherwise a full queue answers it 503.
- **Retained-row bound:** after balance, busy and allowance checks, the insert transaction checks `RELAY_MAX_RETAINED_REQUESTS` (default 100,000). At capacity a new request gets 503 `unavailable`; duplicates/conflicts keep their normal behavior. A held request is displaced only after this check passes because its historical row remains retained. Lowering the limit does not delete existing rows early; normal retention releases capacity.
- **No client addresses**: the relay does not tell clients apart by network address. It reads no forwarded header, and it neither limits, logs nor stores by address.
- **Sender cool-down**: after one of a sender's requests fails its check before the broadcast for a reason the sender controls (funds, allowance, token authorization, intent nonce), for `RELAY_PREFLIGHT_COOLDOWN_SECONDS` (default 600; 0 turns this off) a further submission of that sender while it has a request queued or in flight gets 429 `rate_limited`, which is retryable, and the sender makes no held request give way. Every sender has at most one pending request anyway; the cool-down refuses the next one before any RPC read instead of with 409 after the reads (step 4 or 7). The attribution reads the block of the failed simulation. It is checked after the per-signer limit, before any RPC read, and again at step 9. The state is in memory only.
- **Relay-wide validation bounds**: right before the first RPC read, at most `RELAY_RATE_LIMIT_SUBMIT_MAX` (default 120) submissions per `RELAY_RATE_LIMIT_SUBMIT_WINDOW_SECONDS` (default 60) read the chain, and at most `RELAY_MAX_CONCURRENT_VALIDATIONS` (default 4) at a time. A further one waits for a slot in arrival order, for at most half the validation deadline, with at most four times as many waiting. Beyond these bounds the answer is 503 `unavailable`, and nothing is stored. Only submissions with a valid intent signature of a signer within its limit count. These bound what submissions cost in reads from the RPC providers the transaction manager also depends on.
- **One block for steps 4 to 8**: they read and simulate at block B = max(the transaction manager's newest head, the latest block). A node that does not have block B makes the answer 503 `unavailable`. Step 9 counts the sender's requests included after B (a block number above B), because the read cannot contain them; if one of them is a PERMIT/META_TX request, steps 7 and 9 answer `sender_busy` until a later submission reads past its block. The EIP-7702 code check of §5 reads the latest block; the transaction manager repeats it before every broadcast.
- **Validation deadline**: the RPC reads of steps 4 to 8 share one deadline, `RELAY_VALIDATION_TIMEOUT_MS` (default 10 s; it ends at least 5 s before the idle timeout closes the connection). When it passes, or when the client's connection closes first, the answer is 503 `unavailable` and nothing is stored. A request is never stored after its answer is gone.
- **Concurrent identical copies**: a copy whose identical twin was stored while it was being validated gets 200 with the stored state, as a re-post does (§6.2).

The relay never accepts arbitrary transaction targets or calldata. The request contains its signed recipient `to`; the relay validates it and encodes the call from its configured ABI and contract address.

### 6.4 Fee engine

```
priceGas   = baseFee(latest) × 1.5 + tip                 tip = max(eth_maxPriorityFeePerGas, MIN_TIP)
breakEven  = gasUnits[op][mode] × (baseFee + tip) × POLUSD                      (USD → 6-dec token units)
quote      = roundUp_to_0.01( max(MIN_FEE, gasUnits[op][mode] × priceGas × POLUSD × (1 + MARGIN)) )
```

The engine prices every fee token as 1 USD with 6 decimals; the relay's deployment parser accepts only USDC and USDT0 with `decimals` 6.

- **POL/USD price:**
  - Source: Chainlink `0xAB594600376Ec9fD91F8e885dADF0CE036862dE0` on Polygon (on-chain description "MATIC / USD", 8 decimals). On another chain `RELAY_POLUSD_FEED` must name a Chainlink-compatible feed (`default` is refused there); Amoy has no live Chainlink POL/USD feed, so `DeployAmoyDryRun` deploys a fixed-price `TestnetPriceFeed` there and writes its address to `contracts/deployments/80002.feed`.
  - A price older than 3600 s, more than 15 s in the future (Polygon block timestamps, and with them a round's `updatedAt`, run a few seconds ahead of the wall clock), non-positive or outside [0.01, 10] USD is rejected. No static price is substituted; pricing becomes unavailable and raises an alert.
  - Every configured RPC must return a usable price and the prices must agree within 10 %. The relay uses the highest, which gives the lower spend cap and the higher break-even. An unreadable RPC (`rpc_error`), invalid reading or disagreement (`rpc_disagreement`) rejects the refresh and clears the price cache. A previous reading is never substituted after a failed refresh. Normal cache age is measured on a monotonic clock, and cached readings must still satisfy the oracle staleness limit. Fee quotes and new submissions fail while pricing is unavailable; liveness remains available and readiness returns 503.
  - USDC and USDT0 count as $1.
- **Gas units:** `gasUnits` use Polygon-native read-only state-override measurements (including fresh recipients and relay balances), plus at least 10% and rounding up to 5,000 gas, committed as `relay/config/gasTable.json`. Anvil-only gas measurements are diagnostic. GaslessTransfer was measured at block 94,977,066 before its deployment: its largest need is 269,925 including the margin (USDT0 meta-tx approve, fresh allowance slot), so every entry (permit 280,000, meta-tx approve 280,000, none 210,000) holds.
- **Acceptance at submit:** `fee ≥ max(MIN_FEE, breakEven(now))`. Nothing caps the fee from above (§4.2): the relay quotes the formula at any gas price, and the quote, like its TTL (120 s), is only a hint that clients check before they sign (§7).
- **Defaults:** `MIN_FEE = 10000` (0.01), `MARGIN = 10%`, `MIN_TIP = 30 gwei`. Quotes are rounded upward to two decimal places.

### 6.5 Transaction manager

The details are in `relay/docs/transaction-lifecycle.md`.

- **Key and nonce**:
  - One writer process per relay key and chain. The tx nonce is persisted in the DB and reconciled against the `pending` transaction count on start. The stored next nonce is raised from chain state only when every configured RPC answers, and only to the lowest `pending` count among them; a single RPC's answer is never stored. A fresh database needs every RPC to answer at startup.
  - The relay never gives up a nonce that the chain has not passed. A "nonce too low" answer alone is no proof.
  - Unused nonces below in-flight transactions are filled with 0-value self-transfers after 20 blocks: only nonces at or above the highest `latest` count that the RPCs report, at most `RELAY_MAX_IN_FLIGHT` per pass, and only while every RPC answers.
  - A request whose tx nonce was used by a transaction the relay cannot see gets a new tx nonce only when every configured RPC shows: its intent nonce is unused, its tx nonce is used, no receipt of its transactions exists, and the block where that RPC first saw this is final by that RPC's own `finalized` tag and head.
  - An intent nonce that is used on-chain without a receipt of the request is resolved from state, on every configured RPC on its own. `nonces(from)` only rises, so the block that used the nonce is the first whose state has it above the nonce: the RPC reads it at its head, then 1, 2, 4, … blocks lower, then bisects (at most 2·⌊log2(d + 1)⌋ + 2 `eth_call`s for a block d blocks back), never below the deployment record's `deployBlock` (§9). From there to the contract's creation `eth_call` answers no data: nonce 0. In that block it reads the transactions, the block's receipts with one `eth_getBlockReceipts` (only receipts that name that block's hash count), and one `eth_getLogs` of the block for the sender's `NonceInvalidated`. Of the transactions it considers only the direct `relayTransfer` calls of a request of the sender at the nonce sent by the relay that request names; reverted ones are skipped before any signature is recovered. From an RPC that refuses `eth_getBlockReceipts`, it reads these calls' receipts one by one, at most 16: past that the RPC cannot tell (a relay named in a signed request can put any number of reverted copies of its call into the block). No log range is searched, so logs that anyone can emit do not change the reads or the answer.
    - The successful receipt of the relay's own call of the request there, the same transaction on every RPC: `mined`. A call without a receipt shows nothing: listed in the block while no RPC serves its receipt, the request waits with the alert, never `failed` and never `mined`, until a receipt shows.
    - Positive evidence of another use, the same kind on every RPC: a `NonceInvalidated(signer, previousNonce, newNonce)` covering the nonce (invalidated), or a successful call of another request of the sender at the nonce (another version of the payment): `failed` with `nonce_used`; the block after the request's deadline: `expired`. Provisional until final.
    - Anything else (an RPC without the state of older blocks, receipts it does not serve, nothing in the block that shows the use, such as a `relayTransfer` called through code, disagreement, a missing answer): the relay waits, with an alert. No missing receipt or log fails a request. A JSON-RPC error answer to such a read means the RPC has no state of that block; a timeout, rate limit, HTTP error or lost connection counts as no answer (the RPC is then silent for the rest of the pass).
  - The RPCs must therefore serve the state of older blocks: from the head down to about as far below the block that used the nonce as that block is below the head. At startup and every `RELAY_RPC_HISTORY_CHECK_SECONDS` (default 600), each RPC must answer `nonces` at max(`deployBlock`, head − window), with window = 2 × (7200 + `RELAY_UNKNOWN_NONCE_GRACE_BLOCKS` + max(`RELAY_MAX_FINALITY_LAG_BLOCKS`, `RELAY_FINALITY_FALLBACK_DEPTH`, `RELAY_MIN_FINALITY_DEPTH`) + `RELAY_STUCK_AFTER_BLOCKS`) blocks, 15,924 by default (about 6.6 h at Polygon PoS's 1.5 s per block). 7200 s is the longest request life, and a chain adds at most one block per second; the grace, the finality margin and the alert's blocks bound how much later the block is located again; for a block d below the head the search reads down to 2·d + 1 below it. At startup an RPC that fails it, or does not answer, stops the relay, as one on another chain does; later one that refuses the state (an error answer) makes the relay degraded, with an alert (§6.2), and one that does not answer keeps its last result. Startup logs which RPCs serve `eth_getBlockReceipts`.
- **Broadcast:** the signed raw tx is written to the DB before broadcast. It is broadcast to every configured RPC separately, while reads fail over in order (viem `fallback`). At startup every RPC must answer `eth_chainId` with the deployment's chain.
- **Several RPCs**:
  - The decisions that cannot be undone, or that cost a second transaction, need a positive answer from every configured RPC in `RELAY_RPC_URLS`, each asked through its own client, in the same pass: a new tx nonce, a failure because the intent nonce was used without the request's call, settling an outcome (which purges the secrets), undoing a mined outcome, raising, lowering or filling the nonce range, and the POL/USD price (§6.4).
  - An RPC that does not answer, answers with an error, or has not yet seen the state counts as "not yet": the relay waits, and raises an alert after `RELAY_STUCK_AFTER_BLOCKS` naming the RPC. For pricing, an unsuccessful oracle refresh makes new pricing unavailable (§6.4).
  - Evidence that holds a decision back counts from any RPC, whatever its head: a receipt of any attempt, the intent nonce used, the relay's call in the block that used the intent nonce. Evidence that lets a decision go ahead is judged on each RPC's own observation block, head and `finalized` tag. No block number that one RPC reported decides for another, or holds a decision back for good: a stored observation above an RPC's head is re-based once that RPC's head was made after it.
  - Undoing a mined outcome needs every RPC's head to be made after the moment the relay recorded the outcome (the head's timestamp against the relay's clock; a head of the same second does not count), no successful call of the request on any RPC, and the intent nonce unused. On a chain whose timestamps lag the relay's clock no undo happens, and the request waits with the alert.
  - The reads for these decisions start only within the first 20 s of a pass; later ones count as "not yet" and wait for the next pass. So a slow RPC stretches a decision over several passes, not one pass.
  - These agreement rules prevent an affirmative decision contradicted by an honest configured provider; an unavailable provider blocks the decision. They do not establish the correctness of a chain view shared by every provider. A dead RPC delays these decisions until it answers again or is removed from the configuration. With a single RPC, a lying or broken node cannot be detected. A production relay therefore uses at least two independent providers, the most reliable one listed first; with one RPC on chain 137 or 80002, the relay warns at startup.
  - Readiness and the ordinary reads (the checks of a submission, simulations, quotes, the transaction manager's view of the chain) follow the first RPC that answers. That RPC alone can therefore make the relay unready or refuse submissions, and can end a request:
    - a queued request before its first broadcast: `expired` too early, or `failed` by the checks before the broadcast. That end is final at once; nothing was sent, so no funds move;
    - a request in flight, which the relay then cancels: `expired` when that RPC's head timestamp reaches the deadline safety margin, `failed` when a re-simulation (or the USDC permit sender's code check) on it fails, or `fee_too_low` when its base fee prices the request out at its spend cap while others wait. The sender's funds do not move (the cancel replaces the call; the relay pays the cancel's gas), but the payment fails unless the call is included first, while the signed intent stays valid until its deadline. The outcome is provisional until final, like any outcome decided on-chain.
  - A first RPC that hangs (accepts connections, never answers) delays every ordinary read by about 2 × `RELAY_RPC_TIMEOUT_MS`. Block numbers the transaction manager stores from that RPC's head (the sent block of a transaction, the clocks of `stalled` and `backlog`, waits) are re-based on a lower head later, so a head it once reported too high cannot hold speed-ups or these alerts back for good.
- **Queue:** the transaction manager supports reserved in-flight capacity for higher-priority operations; transfer uses normal priority. Within a priority, queued requests are sent round-robin across senders. A sender has one pending request (§6.3), so it has no backlog of its own; its next request is accepted once the previous one is mined.
- **Checks before every broadcast, speed-up and re-broadcast**:
  - Re-simulate, pinned to the head block. If the request can no longer succeed, cancel it and mark it `failed` with the reason. A revert seen on a lagging node is not trusted at once.
  - The sender of a USDC permit must still have no code (§5).
  - Once a cancel is decided, the call is never sent again. While the cancel cannot be priced within `MAX_FEE_PER_GAS`, the relay waits as long as the node still holds the call. If the node dropped the call, the cancel goes out at market fees.
  - A PERMIT or META_TX request whose token signature no longer matches the token's current nonce fails with `invalid_token_authorization`, not `insufficient_allowance`.
  - The contract checks the signature over `nonces(from)` first, so a request whose intent nonce was used surfaces as `InvalidSignature`. The relay reads `nonces(from)`: above the request's nonce, it fails with `nonce_used`; below it (a reorg removed an earlier request of the sender), it waits.
- **Gas and cost**:
  - The gas limit is `min(estimate × 1.3, gas table)`. An estimate above the gas table fails the request. The margin (`RELAY_GAS_LIMIT_MARGIN_PERCENT`, default 30) is between 10 and 200 %.
  - A spend cap limits `gas limit × maxFeePerGas` to 200 % of the request's fee (`RELAY_MAX_COST_PERCENT_OF_FEE`).
  - The cap applies at the POL/USD price when a call is signed: its first broadcast and every speed-up. Re-sending a signed call does not change what it may cost. If POL/USD rises by a factor k while the call waits (at most until its deadline, 2 h), the call may cost up to k × the cap at the new price.
  - Speed up by 20 % after 10 blocks, up to `MAX_FEE_PER_GAS` and the spend cap. Only the transaction at the next nonce the chain can include (the relay account's `latest` count) is sped up, whether a call, a cancel or a nonce filler: one behind a lower nonce that is not included cannot get in first at any fee, so it keeps its fees (re-sent unchanged only if a node lost it; a call is still re-simulated every 10 blocks and cancelled if it can no longer succeed). Once its nonce is next and it is still not included, it is due for one normal speed-up at once.
  - A request above its cap waits. If it holds up other requests, it is cancelled with `fee_too_low`. Holding up means: another request would be sent and included if this request's tx nonce were free. That is an in-flight request at a higher tx nonce whose call pays base fee plus `MIN_TIP` or whose cap allows it, a cancel in flight at a higher tx nonce (exempt from the spend cap), or a queued request whose full check at the pass's head passed and which fits its cap. Requests held at their own caps do not count. If that check cannot be made (an RPC error, the budget used up), nobody is cancelled in that pass.
  - Every queued request gets the cap pre-check at the start of every pass, without any RPC call, at the gas limit the relay would send it with: one known from a successful estimate (its own, else the smallest of its kind), else the gas table's entry. Only a successful estimate becomes a known gas limit. A request held there is held; a request never checked that the table's entry may hold is "not known yet": neither held nor waiting.
  - At most 2 × `RELAY_MAX_IN_FLIGHT` full checks (simulation and estimate) per pass: before a broadcast, before a held request is cancelled for a waiting one, and, with the rest of that budget, requests never checked and requests held after a check without an estimate (the longest since their check first), also while no slot is free. Nothing is sent by those checks.
  - A queued request that ends in its check before the broadcast counts as progress for `stalled` (§6.2).
- **Deadline passed while pending:** cancel with a 0-value self-transfer and mark the request `expired`. `RELAY_MIN_SECONDS_TO_BROADCAST` must be larger than `RELAY_DEADLINE_SAFETY_SECONDS`; otherwise a call could be cancelled right after its broadcast. It must also leave room for the first pass after acceptance: `RELAY_MIN_SECONDS_TO_BROADCAST + ceil(RELAY_POLL_INTERVAL_MS / 1000) + 10` must be at most 60, the shortest deadline the relay accepts (48 with the default poll interval), and `RELAY_POLL_INTERVAL_MS` is at most 49,000. Otherwise accepted requests could expire unsent.
- **Status**:
  - `mined` means a successful receipt of one of the relay's own call transactions for the request: answered for its hash, or, where no RPC answers that, in the receipts of the block that used the intent nonce, the same call on every RPC (see "Key and nonce"). An inclusion without a receipt is never `mined`.
  - `confirmed` means the block is at or below `min(finalized, head − 16)` and still canonical. On chains 137 and 80002 both finality depths (`RELAY_MIN_FINALITY_DEPTH`, `RELAY_FINALITY_FALLBACK_DEPTH`) are at least 16. An RPC without the `finalized` tag uses head − max(fallback depth, minimum depth).
  - A `failed` or `expired` outcome decided by an inclusion is provisional until that point: a reorg can still turn it into `mined`.
  - Secrets are purged when the outcome is final, and with several RPCs only once every configured RPC shows it final and canonical by its own `finalized` tag and head. A failed or expired outcome settles only if no RPC shows a successful call among the request's transactions. Outcomes decided by a foreign transaction settle on each RPC's own observation. A pass checks at most 32 provisional outcomes, the least recently checked first; more is a settle backlog (§6.2). Settled requests are deleted after 30 days; unsettled ones are never deleted.
- **Foreign-transaction settlement:** a failed or expired outcome with a used intent nonce requires, on every provider, the positive evidence of the use (see "Key and nonce") in a block final by its own view. Each provider settles on its own observation. Every provider showing the successful receipt of the same call of the relay there turns the outcome into `mined`; a provider that shows it, a receipt of any of the request's transactions, one that cannot tell, a nonfinal block or a missing answer prevents settlement and signature purge. A `mined` outcome settles on a provider that does not answer the receipt of its call for its hash by that call's successful receipt in the block that used the intent nonce, final by its own view; a provider that shows another call there holds it back. If every provider shows the same other call of the relay key executing the request there (a reorg put a speed-up in place of the stored call), the request is `mined` by that call, and settles by it.
- **Success without an event:** GaslessTransfer emits no event for a transfer (D13). A successful receipt of the relay's own call is the execution (where no RPC answers it for the call's hash: the call's receipt in the block that used the intent nonce, above).
- **Accepted residual**:
  - After the broadcast, the sender (or anyone who is ordered first) can make the call revert, for example by invalidating the nonce or moving the funds. The relay then pays for the reverted call, up to the spend cap, and earns no fee. Metrics count these calls.
  - The step-9 re-check (§6.3) takes every inclusion the relay recorded at or below block B to be in the balance read. A reorg can remove such an inclusion before the relay has processed it (at its next pass). A request accepted in that window can revert on-chain, and the relay pays for it within the spend cap.
  - A sender that makes its waiting request unsendable right after the relay has checked it (see "Gas and cost" above) can still make a held request be cancelled; the failure of its own request then starts its sender's cool-down (§6.3).

### 6.6 Operations

- **Storage:** better-sqlite3 (WAL) behind a `Store` interface, schema 7. A database with another schema, newer or older, is refused (`relay/docs/storage.md`).
- **Token configuration:** the owner can change a token's modes (`setTokenConfig`). The relay checks them against the deployment record at startup only; after a change, the record (and on chain 137 the SDK pins) must follow before a restart. Until then, a request outside the new configuration fails its simulation and costs the relay nothing unless it was already broadcast. The relay ends such a request `failed` (`unsupported_token`, `unsupported_auth_mode`), but on-chain the refusal is not final: a later configuration change can make the request executable until its deadline (§4.2). Like every relay `failed`, it does not by itself make a new payment safe (§7).
- **Access control:** a per-signer rate limit and relay-wide validation bounds (§6.3). CORS allows every origin, so that self-hosted Wallet, Hub and Keyguard instances can use the relay; the signed intent, not the origin, authorizes a transfer. For privacy, the relay does not tell clients apart by network address: no limit keys on it, no forwarded header is read, and no address is logged or stored.
  - Each listener holds at most `RELAY_HTTP_MAX_CONNECTIONS` open connections, shared by all clients. Request headers must arrive within 5 s. Per-client connection or request limits, if wanted, belong to the TLS proxy in front.
  - The admission bounds of §6.3 (one pending request per sender, `RELAY_MAX_QUEUED`, the sender cool-down) limit how much of the queue one sender can hold. `MIN_FEE` is paid only by requests that are mined: a request that fails its check before the broadcast pays nothing. A party with many funded senders can still keep the queue full, and a flood of submissions can use up the relay-wide validation bounds; both answer 503, which is retryable, and no funds are at risk (accepted residual).
- **Key custody:** the relay reads its key from a restricted key file (`RELAY_PRIVATE_KEY_FILE`), mounted read-only in a plain Docker deployment. The relay refuses to start with the key in its environment (`RELAY_PRIVATE_KEY`), which stays readable for the life of the process. With `RELAY_PRIVATE_KEY_FILE_REMOVE=true` it deletes the key file once it has read the key, for setups that give it a temporary copy. The relay address should hold only the POL it needs; fees accrue on it as USDC/USDT0.
- **Logging and metrics:** pino, with signatures and keys redacted. Prometheus metrics: requests by status/code, time to confirm, relay POL balance, fee revenue vs. gas cost, price source status.
- **Operation registry:** `OperationDefinition = {name, priority, schema, typedData, signer, nonceKey, policy, fee, deadline, reservation, authHash, executionOf, onchainChecks:{nextNonce, state, authorization}, encodeCall, publicRequest, restore}`. `nonceKey` and `onchainChecks.nextNonce` carry the sequential intent nonce; `executionOf` names the request (id, signer, relay) a call of the contract executes at a nonce, which identifies the use of an intent nonce (§6.5). The transfer operation supplies these fields; the generic registry does not imply other operations are implemented.

---

## 7. SDK (`@nimiq/gasless-sdk`)

**`core/`** (zero dependencies; ESM, CJS and an IIFE global `NimiqGaslessCore` for isolated signing applications):
- **Pinned constants per chain:** contract address and domain (version `"3"`), tokens with their token domains and auth modes (on chain 137 the frozen token constants), and the expected relay address(es). Nothing in the pins or on-chain caps the fee: only the fee `from` signs bounds it, so wallets show it to the user and may pass `maxAcceptableFee` (optional). `pinsFromDeployment` reads the deployment record of §9 and refuses a record without `"version": "3"` and a record or token entry with any other key.
- **Typed-data builders:** `buildTransferTypedData(chainId, contract, request, authorization)`, `buildPermitTypedData`, `buildMetaTxApproveTypedData`. Each returns `{domain, types (without EIP712Domain), primaryType, message}` with integers as decimal strings; the transfer type includes the nested `TokenAuth` and the nonce. The output works with ethers v5 `_signTypedData`, ethers v6 and viem.
- **Helpers:** `encodeApproveCalldata`, `splitSignature` (normalizes v to 27/28), `toTokenAuthorization` (the signed `{mode, v, r, s}`; zeros for NONE), `tokenAuthHash`, `transferDigest(chainId, contract, request, authorization)`, `transferDigestFromAuthHash` and `maxSendable(balance, fee)`.
- **`validateTransferRequest(req, pins, now, {maxAcceptableFee?})`:** checks the pinned contract, token and relay, `value == amount + fee`, the deadline window, `amount + fee ≤ 2^256 − 1`, `fee ≤ maxAcceptableFee` when given (the only upper bound), the recipient denylist, and, when the request carries its signed token authorization, that it is of the intent's mode and in the form the relay submits (`checkSignedAuthorization`).
- **Signing**: `createTransferIntent(pins, params, now, {maxAcceptableFee?, allowMetaTxApprove?})` builds the request and the token authorization's typed data; `tokenAuthSigningPayload(pins, intent, now, {maxAcceptableFee?})` returns the token authorization to sign first (null for NONE), and `transferSigningPayload(pins, intent, authorization, now, {maxAcceptableFee?})` the intent over it. Both re-validate the intent. `checkAcceptableFee` and `parseMaxAcceptableFee` are exported, also in `NimiqGaslessCore`. `createTransferIntent` refuses META_TX_APPROVE for a token with permit unless `allowMetaTxApprove` is set (§5).
- **Nonces and corrections**: `createTransferIntent` needs `nonce` (the sender's `nonces(from)`, read on-chain right before, for a new payment) or `corrects`. With `{...fields, corrects}` it prepares a later version of a payment, and `checkCorrection(corrected, request)` checks one, also in `NimiqGaslessCore`. A correction keeps `from`, `nonce`, `token` and `to`, and a deadline at least as late as the version it corrects; amount, fee, relay and token authorization may change. `validateSubmitTransferBody(body, pins, now, {repost?})`. Validation codes: `correction_mismatch`, `nonce_used`. The core cannot read the chain or distinguish an earlier version's nonce from a new one, so it accepts a plain `nonce`. The integrating application must take `nonces(from)` for a new payment, never a higher nonce, and only once the sender's previous payment is decided; pass `corrects` (the payment's latest version) for every later version, never that nonce alone; and read `nonces(from)` before requesting a correction signature.

**`relay/`:** `RelayClient(baseUrl, {pins, allowInsecureHttp?})` with `info()` (refuses any mismatch with the pins, including the transfer domain's version), `fee()` (checks token, mode, relay and the 0.01 granularity, and the caller's optional `maxAcceptableFee`; nothing else bounds the quote), `submitTransfer()`, `getRequest()` and `waitForRequest()`.
- `baseUrl` must use `https://`. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, or with the explicit `allowInsecureHttp` for private test networks.
- The request id is the intent digest over the request, its nonce and its token authorization. `submitTransfer` recomputes it from the body; `getRequest` from the returned request and its `authHash` (the relay's state carries the hash, never the token signature).
- `waitForRequest` ends at once on `failed` or `expired` only when nothing was broadcast. Otherwise the outcome is still provisional (§6.5), and it keeps polling until the client clock is past the request's deadline plus a settle margin (default 180 s); a `mined` or `confirmed` status reported meanwhile is returned. `RelayRequestFailedError.final` is only a hint, derived from the relay's transaction list and the client clock; only `waitForTransferOutcome`, or `confirmOnChain` at the finalized block, with the payment's latest version, decides.
- `submitTransfer(body, {repost: true})` re-posts a body: it skips only the client-side deadline window, because the relay answers a stored identical body before its policy checks; every other check stays.
- `sender_busy` (the relay cannot take the sender's request yet, §6.3 steps 4 and 7) and `nonce_too_high` (the body's nonce is above `nonces(from)`) are retryable; another request at the nonce of a pending one gets `conflict`. Once the pending request is mined, a body whose nonce equals `nonces(from)` is re-posted; a PERMIT or META_TX body whose token nonce was used meanwhile is prepared and signed again as a correction with the same intent nonce; a body whose nonce is used is decided (`waitForTransferOutcome`); a body whose nonce stays above `nonces(from)` waits for its outcome as well (`expired` after its deadline), and nothing new is signed.

**`viem/`:**
- `readTokenNonce`
- `checkTokenDomain` (compares against the on-chain `DOMAIN_SEPARATOR()`)
- `prepareTransfer`: a new payment takes `nonces(from)` at the latest block, never a higher nonce, and with `minNonce` (from the previous payment's outcome) never a lower one: an RPC node behind the chain gets `nonce_used`. `corrects` prepares a correction (the rules above; the default deadline is no earlier than the corrected one) and refuses with `nonce_used` once `nonces(from)` is above the payment's nonce. A `nonce` without `corrects` is refused.
- `signPrepared`: signs the token authorization first and the intent over it second, checks that both recover to `from`, and returns the `SignedTransfer` with its `id` and `authHash`. A wallet persists the `TransferVersion` `{request, authHash}`, never the signatures.
- `confirmOnChain(client, pins, {request, authHash?, versions?})`: every read at one block, `latest` by default, or `safe` or `finalized`. It judges the nonce, not only the given version; `versions` lists every version the wallet signed for the payment. The contract emits no transfer event, so an execution is recognized from its transaction: a successful `relayTransfer` call of the pinned contract, in a canonical block not after the version's deadline, whose decoded request and token authorization recover to `from` at this nonce. A reverted call (the relay reports the hash of its call for a failed request too) is none, and neither is the request's call data sent to another contract (the transaction's or the receipt's `to` is not the pinned contract), on every path: the relay's `txHash`, the block B below, and the log search's transactions and blocks. An invalidation is the sender's `NonceInvalidated` whose range covers the nonce. Statuses: `executed` (exactly this request, and with `authHash` this authorization); `other_version_executed` (another version of the payment at this nonce, with the executed version: one in `versions`, or without them one with the same token and recipient); `other_payment_executed` (a request of another payment of `from` at this nonce: another token or recipient, or one not in `versions`; this payment did not execute and cannot); `pending`; `expired` (the nonce was unused at the last block at or before the deadline); `nonce_consumed` (only with `NonceInvalidated`); `unresolved` (the nonce is used but neither use was found; not an answer; `reason` `not_found`: B shows neither, as for a `relayTransfer` call from another contract; `no_history`: an RPC without the state of older blocks whose logs did not show it). The use is located from state, not from logs: `nonces(from)` never decreases, so the block B that used the nonce is the first block at whose state it is above the nonce. `eth_call` at block numbers finds B, stepping down from the block read by 1, 2, 4, … blocks and then bisecting: at most 2·floor(log2(d + 1)) + 1 reads for B d blocks below the block read, never below the deploy block (where the contract has no code yet, `nonces(from)` reads 0). B after the deadline means `expired` (the nonce was unused at the last block at or before the deadline), so a later payment that reuses the nonce is never taken for this one. Otherwise only B is read: its direct `relayTransfer` calls of the pinned contract, sent by the request's relay and signed by `from` at this nonce, with B's receipts from one `eth_getBlockReceipts` (from an RPC that refuses it, these calls' receipts one by one, at most 16: B gives no execution past that), and the sender's `NonceInvalidated` events of B. No query returns logs that other accounts can emit, so a flood of zero-amount `Transfer` logs of the sender (a `transferFrom` of 0 needs no allowance) changes neither the answer nor the number of requests. A `relayTransfer` call from another contract, or from an EOA with an EIP-7702 delegation (the transaction's `to` is not the pinned contract), is not recognized: `unresolved`, unless B holds the sender's `NonceInvalidated` covering the nonce. This needs an RPC with the state of older blocks (an archive node). Without it, the check falls back to a log search: from the first block at or after the earliest deadline of the versions − 7800 s (or `fromBlock`), never below the deploy block, to the last block at or before the deadline, where `nonces(from)` is read first if the node can (unused means `expired`), and only when it cannot, on to the block read for invalidations; ranges of at most 1000 blocks that halve when the RPC refuses one; two exact filters, the pinned tokens' `Transfer` logs from the sender, to any recipient, whose transactions are checked (zero-amount logs are dropped), and the sender's `NonceInvalidated`. A block whose `Transfer` logs the RPC refuses even alone, or answers with 1000 or more (possibly cut off), is read through its transactions instead, its receipts as in B. A check makes at most 500 JSON-RPC requests and then answers `unresolved` (`no_history`). The state search needs about 2·log2(d) + 7, also when the relay a signed version names puts hundreds of reverted copies of its call before the executing one in B (6 + 2·floor(log2(d + 1)) for 510 copies); without `eth_getBlockReceipts` that relay can make the answer `unresolved` with 16 copies, as it can with a call through code. The log search needs more, and a flood over many blocks can use them up there.
- Confirmation requires canonical block hashes for candidate receipts/logs and consistent transaction/block metadata. Missing or orphaned evidence cannot establish execution. The outcome poller bounds external waits by its overall monotonic deadline and stops further confirmation work after timeout.
- `waitForTransferOutcome(client, pins, {request, authHash, id?, versions?})`: waits until the chain shows the payment executed (by this or another version), its nonce used by another payment, expired or its nonce consumed, read at the finalized block by default; `pending` and `unresolved` keep it waiting. The relay's status only says when to look. Its polls keep the log search's progress: the bracket of the use only narrows (no block above the one the previous poll read is searched), and log ranges searched without an answer, and without a receipt or transaction the RPC did not serve, are not searched again, while the block the previous poll read is still the block of its number (its hash; otherwise the search starts again). An empty log answer counts only 128 blocks (`LOG_INDEX_LAG_BLOCKS`) below the block read: a load-balanced RPC can answer `eth_getLogs` from an index that lags the block it serves, so the log queries of the last 128 blocks are repeated by the next poll; a block whose transactions were read is not read again. So a flood is searched once over the whole wait, a later poll reads little more than the block, `nonces(from)`, the bounds of the search and the logs of those last 128 blocks (before the deadline, while the block read stays the same: the chain id, the block, `nonces(from)`, the refused read of older state, and one `Transfer` and one `NonceInvalidated` query per stretch of those blocks whose transactions were not read, one `NonceInvalidated` query per stretch whose transactions were), and the answer comes once the search reaches the use. A log index more than 128 blocks behind the block read can hide the use for the rest of the wait, never give another answer. Its `timeout` error names an RPC without the state of older blocks.

**Signing application requirements:** clients build all typed data themselves from validated fields. They never sign an unvalidated typed-data payload supplied by a relay or another application. After a failure, clients follow these rules, so that a user never pays twice:
- After an unclear submit error (timeout, network error, invalid response, `internal_error`), re-post the identical body with `submitTransfer(body, {repost: true})`. The relay answers 200 for an identical body it has stored, also after the deadline.
- An SDK error before sending means "this call sent nothing", not "the relay stored nothing". If an earlier post of the body got no clear answer, also across a relay key rotation, treat the request as possibly stored and run `waitForTransferOutcome` with the payment's latest version before signing anything else for the payment.
- One payment, one nonce: a new payment takes `nonces(from)`; every later version is a correction of the payment's latest signed version (`corrects`), with the same nonce and a deadline at least as late. Clients record every version as soon as it is signed, before it is submitted, and pass them all as `versions` to the outcome checks.
- One open payment per sender: start a new payment only after `waitForTransferOutcome`, or `confirmOnChain` at the finalized block, reports `expired`, `nonce_consumed` or `other_payment_executed` for the latest version of the previous one (the new payment may then get the same nonce after `expired`), or `executed` or `other_version_executed` (the payment went through), and pass `minNonce` from that outcome to `prepareTransfer`. Two payments started while one is open (two wallet instances of one key), or one prepared from a node behind the chain without `minNonce`, get the same nonce; at most one of them executes. The outcome check tells them apart by token and recipient, and with `versions` also for the same token and recipient; without `versions`, such a payment reads as `other_version_executed` of the other.

---

## 8. Verification properties

**Signature binding and unsigned pulls:**
- **T01.** An account holds a maximum token approval. An attacker relays with an empty signature, their own signature, a tampered signature, or a victim signature bound to another relay. The call reverts and balances are unchanged.
- **T02.** Calling every selector against a max-approved victim without a valid signature moves nothing.
- **T03 (fuzz).** Mutating any one of the 7 request fields, the nonce, the token authorization's `mode`, `v`, `r` or `s`, the chainId or the verifying contract reverts with `InvalidSignature`. The unmodified request succeeds.
- **T04.** The same request submitted twice fails the second time with `InvalidSignature`: the nonce it was signed for is used. A request signed for nonce n + 1 fails until nonce n is used.

**Replay and signature format:**
- **T05–T07.** Replay against another contract, another chain or another token reverts.
- **T08–T09.** High-s signatures, flipped v, bad lengths, and `from = 0` all revert.

**Fee, relay binding and deadline:**
- **T10.** Amounts are exact: the relay gets exactly `fee`, `to` gets exactly `amount`, and the contract balance stays 0. No configuration bounds the fee: fees up to 2^256 − 2 are paid exactly as signed in every route; `amount + fee` above 2^256 − 1 reverts and moves nothing.
- **T11.** Relay binding: `msg.sender != r.relay` reverts, and a tampered `relay` field gives `InvalidSignature`.
- **T12.** Deadline boundary: equal passes, +1 reverts.
- **Check order.** A bad signature reverts with `InvalidSignature` before every other check, and the call touches no account but the contract and the ecrecover precompile before verification.

**Token authorization:**
- **T13–T16 (fork).** Front-running a USDC permit, front-running a USDT0 permit or meta-tx, and a USDT0 shared-nonce DoS each end either in success or a clean revert. The USDT0 meta-tx spender is always `this`.
- **T17 (fork).** A USDT0 permit signed with the standard domain fails; one signed with the salt domain succeeds.
- **T18**. A permit whose value differs from `amount + fee` cannot authorize the call:
  - The call reverts unless the allowance already equals `amount + fee` exactly.
  - In that case the call succeeds and the unused permit stays valid until its deadline, which is the intent deadline.
  - The allowance is 0 after every PERMIT or META_TX call.
- **T19.** NONE mode with an existing allowance still requires the intent signature.
- A token authorization other than the signed one (another mode, `v`, `r` or `s`) reverts with `InvalidSignature`.

**Surface, owner, token behaviour and edge cases:**
- **T20.** The surface lock of §4.4 holds. Only the owner can call `setTokenConfig`, `transferOwnership` and `renounceOwnership`, and only the pending owner `acceptOwnership`; the owner can add, replace and remove token configurations, and it cannot move tokens or change nonces. A signed request that a configuration refused executes after the owner adds its token or mode, until its nonce is used or its deadline passes.
- **T22–T25.** A reentrant mock token, a mock returning no bool, USDC blacklist/pause and USDT0 block cases on the fork, and each recipient in the denylist.
- **T26–T29.** Sequential nonces rise by exactly one per transfer, and `invalidateNonces` raises the caller's own nonce within its bounds, cancelling every request below it. An EIP-7702 EOA is handled. A contract signer is rejected. Permit gas starvation causes no partial state change.

**Invariants (stateful fuzzing):**
- **Actions.** Two handlers, the black-box one in `contracts/test/spec` and the one in `contracts/test/unit`, interleave transfers in every route (also front-run), forged, altered, replayed, misrouted and expired requests, nonce increases, standing allowances, donations and time jumps with the owner's actions:
  - `setTokenConfig` adds, replaces and removes tokens, with random modes; users sign fees up to 2^34;
  - ownership moves in two steps, and a transfer can stay pending; the owner rarely renounces (in one of 16 calls of the action that can renounce, chosen by a hash of the seed: in about a sixth of the runs at the default depth, a third at `invariant-final`);
  - other accounts, the pending owner and invalid configurations try the same;
  - only the spec handler also configures tokens outside the initial set, and reconfigures a token between a request's signature and its submission.
- **Oracle.** Both handlers keep a ghost copy of what the owner set and judge every validly signed request against it, never against `tokenConfig()`: it executes, whatever its fee, only if the configuration at call time allows its token and mode, and it is refused with that configuration's error exactly when it does not. Forged, altered, replayed, misrouted and expired submissions only have to revert.
- **Owner.** `tokenConfig()`, `owner()` and `pendingOwner()` equal the ghost copy. Only the pending owner accepts ownership, and after `renounceOwnership` nothing changes the configuration or the ownership. Owner actions move no balance, allowance or nonce.
- **Events** (spec handler; the unit handler checks `TokenConfigSet`). A successful `invalidateNonces`, `setTokenConfig` or ownership step emits its one event; a transfer or a failed call emits none from the contract, and an executed transfer's `Transfer` logs are the fee, then the principal (§4.3).
- **Not vacuous.** Every spec run judged validly signed requests, attacked, and had the owner set a configuration (the first owner action of a run starts with the owner's own `setTokenConfig` of a token, whoever the fuzzer picks as callers); every unit run judged validly signed requests and attacked (`afterInvariant`). Self-tests drive every handler path, also every owner path, with fixed inputs.
- **Owner rates.** Self-tests call each owner action of both handlers from one state for fixed seeds from keccak256, over the whole uint256 range and of every bit length (as the fuzzer draws them), and require the actions of the account allowed to act to take effect (the ghost copy follows them) at the designed rate, within four standard deviations of the binomial count. Spec: the owner calls in 3 of 4 calls of `setTokenConfig`, of the reconfiguration between signature and submission and of `transferOwnership`; a configuration for a token is always valid, and one for an address without code or the contract itself (2 of 10 targets) only if it removes (11 of 64). So it sets a configuration in 801 of 1280 `setTokenConfig` calls and in 3 of 4 reconfigurations, and names a candidate in 3 of 4 `transferOwnership` calls; with a transfer pending, the pending owner accepts in 5 of 8 acceptance calls. Unit: the owner sets a configuration in 6 of 8 configuration calls (it calls in 7, one with an invalid configuration), and every ownership call is one step of the account allowed to take it, an acceptance in 15 of 32. A renounce in 1 of 16. A handler that let the owner act, or set a valid configuration, only for small, large or odd seeds, or never, fails them; the per-run checks above cannot see it, and neither can the invariants, since the ghost copy follows a refusal.
- **Configuration variety.** Self-tests over the same seed families (512 seeds each) classify the configurations set, read back with `tokenConfig()`, by modes (removed; permit and allowance; others), and require each class at its designed rate within four standard deviations. Spec `setTokenConfig`: 165, 456 and 180 of 1280 calls; reconfiguration between signature and submission: 66, 228 and 90 of 512. Unit: 36, 168 and 180 of 512. A handler that set one fixed valid configuration for large seeds passes the rate self-tests and every invariant, and fails these.
- TI1–TI5 and nonce monotonicity hold throughout, also under reconfiguration.

**SDK and relay:**
- **T30.** Golden vectors: the SDK digest equals the contract's `hashTransfer(r, nonce, auth)` over the request, its nonce and its token authorization (every mode; NONE with zeros and with other values; v 27 and 28; nonces up to 2^256 − 1), in the zero-dependency core, viem, ethers v5 and ethers v6; the token authorization digests equal the tokens'. The vectors are generated from `contracts/src` with the token mocks, GaslessTransfer at fixed addresses (a placeholder on chain 137, the local-stack address on 31337; see `contracts/test/vectors/README.md`); the generator executes the first five of them in nonce order.
- **T31–T36.** Relay input rejection, idempotency under concurrency, crash recovery, gas spikes and replacement, fee-quote bounds, rate limits, and log redaction.

**Solidity fork tests** use real USDC and USDT0 at block 94,421,000 (the `test/fork` suite accepts a `FORK_BLOCK` override); the relay's fork E2E forks a recent block (§11). **Local gas tests** (`GasMeterTest`) log diagnostic gas numbers on the mocks; Polygon-native calibration is recorded separately. **The relay integration and SDK end-to-end tests** run against anvil: fee → sign (viem, ethers v5, ethers v6) → submit → mined → balances. They also cover every error code, 20 concurrent submits, tx replacement and expiry, restart recovery, and the ephemeral-signer flow.

---

## 9. Deployment configuration

The production deployment script fixes chain 137, the token addresses at the top of this document and the modes in §5. The initial owner comes from `GASLESS_TRANSFER_OWNER`, which has no default. It verifies live token domain separators before deployment. The Amoy script uses test tokens (Circle's test USDC, a mock USDT0) and does not establish mainnet token compatibility.

The deployment record contains chainId, version (`"3"`, the contract's EIP-712 domain version), gaslessTransfer, initialOwner, deployBlock and each token's symbol (`USDC` or `USDT0`), address, decimals, allowed modes and domain. Readers reject a record of another version, and a record or token entry with any other key (a token may carry its expected `domainSeparator`). The token entries are the constructor's configuration; after a `TokenConfigSet` event, `tokenConfig(token)` on-chain is authoritative. The deployBlock value is the block the deploy script saw before its broadcast, a lower bound of the contract's creation: the relay's and the SDK's searches read no state and no logs below it, and between it and the creation `nonces(from)` reads as 0 (`eth_call` answers no data). It must never be above the creation block: the searches take every nonce as unused below it, so they would place a use below it in the deployBlock block itself, and answer nothing there or, if that block is after the request's deadline, `expired` for a request that executed. The deployment verifier checks it against the deployment receipt (`DEPLOY_BLOCK`). A simulation-generated record does not prove a contract was mined: verify the address, deployment receipt and runtime before distributing client pins.

Clients select relay addresses independently of the deployment record. Relay key rotation changes the relay field of new signatures, not the contract. Corrections retain the payment nonce and follow §7.

---

## 10. Compatibility boundaries

The definitions in §4.3 and §5 and surface in §4.4 govern signature and ABI compatibility. A transfer digest, over the request, its nonce and its token authorization, is also its relay request ID. Token authorization and transfer intent are separate signatures; the intent covers the token authorization, and the token authorization alone cannot select a new principal recipient, relay fee or transfer amount. The SDK pins domain version `"3"`: it refuses a deployment record of another version and a relay whose `/v1/info` transfer domain names another version.

Canonical receipt and event checks depend on RPC chain views; the SDK is not a consensus-verifying light client. Unavailable evidence can delay confirmation. Relay failure or an HTTP timeout does not revoke a signed intent: it stays valid until its nonce is used or its deadline passes (D6); retry and correction rules are defined in §7.

The transfer-contract configuration does not freeze an issuer-controlled token implementation. Admission limits do not guarantee unlimited service availability. Spend caps constrain individual signed attempts under configured price assumptions, not aggregate losses across identities.

The contract has no administrative recovery method; the owner manages only the token configuration (§4.2). A required contract change needs a new deployment and coordinated client pins.

---

## 11. Parameters

| Parameter | Value |
|---|---|
| solc / EVM | 0.8.28, `evm_version = cancun` |
| OpenZeppelin | v5.6.1, commit `5fd1781b1454fd1ef8e722282f86f9293cacf256` ([DEVELOPMENT.md](DEVELOPMENT.md)) |
| Token modes | USDC {PERMIT, NONE}; USDT0 {PERMIT, META_TX_APPROVE, NONE} |
| Owner | `Ownable2Step`; initial owner from `GASLESS_TRANSFER_OWNER` (production), no default |
| Nonces | sequential per signer; `invalidateNonces` raises by 1 to 2^32 − 1 per call |
| Fork blocks | 94,421,000 (fixed token-state fixture; `FORK_BLOCK` overrides it for `test/fork`); the relay's fork E2E forks the RPC's head minus 200 blocks, or a `FORK_BLOCK` of the last hour (the POL/USD round must be at most 3600 s old); gas measured at 94,977,066, before the deployment |
| Relay policy | deadline 60–7200 s; quote TTL 120 s; `MIN_FEE` 0.01, also the lowest fee accepted; margin 10%; no upper bound on the fee; requests only at the sender's next intent nonce |
| Relay limits | one pending request per sender and 100 queued requests; for 600 s after a failure it caused, a sender's further submissions are refused (429) before any RPC read while one is pending; relay-wide at most 4 submissions reading the chain at a time and 120 per minute; validation deadline 10 s; 1024 connections per listener, headers within 5 s; no limit or log by client address; finality depths at least 16 on chains 137 and 80002; `RELAY_MIN_SECONDS_TO_BROADCAST` + poll interval + 10 s ≤ 60 s; at least two independent RPC providers in production, the most reliable one first |
