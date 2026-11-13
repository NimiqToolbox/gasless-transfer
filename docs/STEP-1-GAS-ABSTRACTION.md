# Gasless transfer protocol reference

This reference describes the implemented transfer contract, token authorization and the client signing rules the contract relies on. See [polygon-137-deployment.md](operations/polygon-137-deployment.md) for the deployment and [DEVELOPMENT.md](DEVELOPMENT.md) for building and testing.

The production token configuration is Polygon PoS (chain 137): native USDC 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 and USDT0 0xc2132D05D31c914a87C6611C10748AEb04B58e8F. The separate Amoy deployment on chain 80002 uses Circle's test USDC and a mock USDT0.

---

## 1. Scope

A sender authorizes a token transfer through a signed intent. The relay pays POL transaction gas and receives the signed fee in the transferred token. The transfer contract takes no custody of the principal and has no upgrade path.

The implementation consists of GaslessTransfer and its GaslessBase and TokenAuthLib dependencies. This reference covers transfers only.

Signed field order, EIP-712 domains and the ABI are compatibility boundaries. Changes require coordinated contract and client review.

---

## 2. Protocol rules

| # | Decision |
|---|---|
| D1 | Signatures are ECDSA only, verified with OpenZeppelin `ECDSA.tryRecoverCalldata` (rejects high-s and malformed signatures). `from != address(0)`. No ERC-1271. |
| D2 | Replay protection uses one sequential nonce per signer, `nonces(signer)`. The contract reads it from storage: it is signed, but not part of the call data. A transfer raises it by exactly one before any external call, so a signer's requests execute in nonce order and at most one request per nonce executes. A signer cancels every request signed for a nonce below `newNonce` with a direct call to `invalidateNonces(newNonce)`, which raises its own nonce by 1 to 2^32 − 1 at once. |
| D3 | Deadlines are unix seconds, and a request is valid while `block.timestamp <= deadline`. |
| D4 | The contract obtains token authorization itself (§5). Permit `value = amount + fee` and permit `deadline = intent deadline`. The token call is wrapped in `try {} catch {}`, followed by an allowance check, so front-running cannot block it. The token authorization (`mode`, `v`, `r`, `s`) is part of the signed intent. Modes: USDC {PERMIT, NONE}; USDT0 {PERMIT, META_TX_APPROVE, NONE}. |
| D5 | The user co-signs the relay. Every signed request contains `address relay`, and the contract requires `msg.sender == relay`. The fee goes to `relay`. The contract has no allowlist, no pause, no rescue and no upgrade path; its owner can only change the token configuration (D6). Stopping a relay prevents further broadcasts by that operator; it does not revoke signed or broadcast requests. Rotating the relay key only requires clients to sign for the new address. |
| D6 | Each token has a configuration: its allowed auth modes. The constructor sets the initial tokens. The owner (`Ownable2Step`, a non-zero constructor argument) adds a token, replaces its configuration or removes it with `setTokenConfig`, which emits `TokenConfigSet`. The owner has no other power: it cannot move tokens, change nonces or alter a signed request. A configuration change can make a signed request fail, and it can make executable a signed request that the previous configuration refused (by adding its token or mode): a signed request stays valid until its nonce is used or its deadline passes, whatever the configuration. The contract sets no fee bound: the fee is what `from` signs, in the token's own units. The relay's quote is a hint; the client must show the fee to the user and check it before signing. `renounceOwnership` freezes the configuration. |
| D10 | One `GaslessTransfer` covers the token type "ERC-20 stablecoin" (USDC and USDT0). |
| D11 | The contract rejects `to` ∈ {0, token, this}. |
| D13 | Fee first: the fee transfer to the relay executes before the principal transfer, within the same atomic call. This only affects the order of `Transfer` logs; the principal is the last one. After the principal transfer, the contract emits `TransferRelayed(from, nonce, digest)`, its only event for a transfer and the last log of the call (§4.3). |

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

The owner has no say over the fee: the contract pays the relay exactly the fee `from` signed, however large. Only the client bounds it (D6).

Ownership moves in two steps (`transferOwnership`, then `acceptOwnership` by the new owner). After `renounceOwnership` the configuration is fixed for good.

**Trusted token set**. Robustness against a hostile token rests on the configured tokens being trusted (USDC and USDT0):
- `nonReentrant` blocks re-entry.
- SafeERC20 and the try/catch token calls bound the returndata they copy.
- The high-level `allowance()` read copies the whole returndata, so a token that returns megabytes there makes the call run out of gas. This is a token-behavior assumption, not a bound enforced by the transfer contract.

Adding another token with `setTokenConfig`, or relying on a changed token implementation, requires compatibility and security review. The contract takes any token, with the fee in that token's units and of any size.

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

event TransferRelayed(address indexed from, uint256 indexed nonce, bytes32 indexed digest);
    // relayTransfer executed the request of `from` at `nonce`; digest = hashTransfer(r, nonce, auth)

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

Event, after the token transfers:

8. `emit TransferRelayed(r.from, nonce, digest)` with `digest = hashTransfer(r, nonce, auth)`

A request signed for another nonce, or submitted with another token authorization, fails at step 1 with `InvalidSignature`; the contract cannot tell it from a forged one. A request whose `amount + fee` exceeds 2^256 − 1 reverts in step 7 before any token call. A reverted call leaves the nonce unchanged.

Log order. Guaranteed, in this order:
1. The token authorization's logs, if this call executes the token authorization (PERMIT and META_TX_APPROVE only). They are absent when the permit or meta-tx was executed before (front-run, T13–T15) or is otherwise no longer valid, and the call is then paid from exactly `amount + fee` already in place. An allowance of exactly `amount + fee` does not skip a valid token authorization: it still executes and logs.
2. `Transfer(from → relay, fee)`, only if `fee > 0`.
3. `Transfer(from → to, amount)`, the last `Transfer` log of the call.
4. `TransferRelayed(from, nonce, digest)` from `GaslessTransfer`, the last log of the call.

`TransferRelayed` is the only event `GaslessTransfer` emits for a transfer. Tokens emit further events in between, so consumers filter by emitter and topic:
- **USDC:** PERMIT emits `Approval`, `Transfer` (fee), `Transfer` (amount), `TransferRelayed`. NONE emits the same without the `Approval`, and so does a PERMIT call whose permit was executed before.
- **USDT0:** every `transferFrom` also emits an `Approval` with the reduced allowance, and `executeMetaTransaction` emits `MetaTransactionExecuted` before the meta-tx `Approval`.
  - A META_TX_APPROVE call with a fee therefore emits seven logs: `MetaTransactionExecuted`, `Approval`, `Transfer`, `Approval`, `Transfer`, `Approval`, `TransferRelayed`.
  - It emits five logs, without the first two, when the meta-tx was executed before.

An executed request shows on-chain as its `TransferRelayed(from, nonce, digest)` log. All three fields are indexed: a log filter on the contract address, `from` and `nonce` finds the request that used a nonce, and `digest` identifies which of the requests signed for that nonce it was (the relay request id). `NonceInvalidated` marks nonces the signer cancelled.

The Polygon and Amoy deployments listed in the README were built from commit `837fb6b`, before `TransferRelayed` was added, and emit no event for a transfer. There an executed request shows only as a successful call of the relay's transaction, the principal `Transfer` and `nonces(from)` above the signed nonce; telling apart several requests signed for that nonce takes the transaction's call data.

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

**Values:** `spender` is always `GaslessTransfer`. `value` is always `amount + fee`. The permit `deadline` equals the intent deadline; the client never signs 0 or max.

**Signing order:** the client signs the token authorization first, then the `GaslessTransfer` intent over it: `TokenAuth(mode, v, r, s)` holds that signature with v 27 or 28 (the client normalizes 0/1 before the intent signs it), or zeros for NONE. A relay therefore cannot submit the intent with another authorization or mode (`InvalidSignature`), and the relay request id, the intent digest, depends on the token signature.

**USDT0 nonces:** they are sequential and shared between permit and meta-tx, so a token signature is valid only for the owner's current token nonce.

**Storing token signatures**. META_TX signatures never expire on-chain; only a later use of the owner's USDT0 nonce kills them.

**A broadcast META_TX stays public**. Once broadcast, a META_TX is public for good, whatever the outcome. If the call reverts or is cancelled, anyone can still execute it later. That creates an allowance of `amount + fee` for this contract, which moves nothing without a new intent signature but uses up the nonce. Clients should therefore prefer PERMIT for USDT0, whose deadline is the intent deadline, and use META_TX_APPROVE only for a token without permit, or when the caller explicitly asks for it.

**EIP-7702-delegated EOAs**. USDC verifies permits of accounts with code through ERC-1271 of the account's delegate, not ECDSA, so whether such a permit works depends on the delegate:
- It fails for delegates without ERC-1271.
- It succeeds for delegates that accept the account's key.
- A permissive delegate even accepts permits nobody signed. P1 still holds, because the intent signature is ECDSA.

Clients should not sign USDC permits for accounts with code unless the caller explicitly allows them, and should suggest a one-time approval plus NONE mode instead.

USDT0 verifies permits and meta-txs with `ecrecover`, so 7702 accounts can use both.

---

## 6. Relay

The relay is an off-chain component and not part of this repository. What the contract guarantees does not depend on it (§3). The contract accepts any account as relay, as long as it is the `relay` the sender signed (D5).

---

## 7. SDK

The SDK is an off-chain client component and not part of this repository. The client-side signing rules the contract relies on are in §5.

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
- **Events** (spec handler; the unit handler checks `TokenConfigSet`). A successful `invalidateNonces`, `setTokenConfig` or ownership step emits its one event, and an executed transfer exactly one `TransferRelayed` with the spec's digest of the request, after every token log; a failed call emits none from the contract, and an executed transfer's `Transfer` logs are the fee, then the principal (§4.3).
- **Not vacuous.** Every spec run judged validly signed requests, attacked, and had the owner set a configuration (the first owner action of a run starts with the owner's own `setTokenConfig` of a token, whoever the fuzzer picks as callers); every unit run judged validly signed requests and attacked (`afterInvariant`). Self-tests drive every handler path, also every owner path, with fixed inputs.
- **Owner rates.** Self-tests call each owner action of both handlers from one state for fixed seeds from keccak256, over the whole uint256 range and of every bit length (as the fuzzer draws them), and require the actions of the account allowed to act to take effect (the ghost copy follows them) at the designed rate, within four standard deviations of the binomial count. Spec: the owner calls in 3 of 4 calls of `setTokenConfig`, of the reconfiguration between signature and submission and of `transferOwnership`; a configuration for a token is always valid, and one for an address without code or the contract itself (2 of 10 targets) only if it removes (11 of 64). So it sets a configuration in 801 of 1280 `setTokenConfig` calls and in 3 of 4 reconfigurations, and names a candidate in 3 of 4 `transferOwnership` calls; with a transfer pending, the pending owner accepts in 5 of 8 acceptance calls. Unit: the owner sets a configuration in 6 of 8 configuration calls (it calls in 7, one with an invalid configuration), and every ownership call is one step of the account allowed to take it, an acceptance in 15 of 32. A renounce in 1 of 16. A handler that let the owner act, or set a valid configuration, only for small, large or odd seeds, or never, fails them; the per-run checks above cannot see it, and neither can the invariants, since the ghost copy follows a refusal.
- **Configuration variety.** Self-tests over the same seed families (512 seeds each) classify the configurations set, read back with `tokenConfig()`, by modes (removed; permit and allowance; others), and require each class at its designed rate within four standard deviations. Spec `setTokenConfig`: 165, 456 and 180 of 1280 calls; reconfiguration between signature and submission: 66, 228 and 90 of 512. Unit: 36, 168 and 180 of 512. A handler that set one fixed valid configuration for large seeds passes the rate self-tests and every invariant, and fails these.
- TI1–TI5 and nonce monotonicity hold throughout, also under reconfiguration.

**Golden vectors:**
- **T30.** The client-side digest equals the contract's `hashTransfer(r, nonce, auth)` over the request, its nonce and its token authorization (every mode; NONE with zeros and with other values; v 27 and 28; nonces up to 2^256 − 1); the token authorization digests equal the tokens'. The vectors are generated from `contracts/src` (GaslessTransfer at a placeholder address with the token mocks); the generator executes the first five of them in nonce order.

**Fork tests** use real USDC and USDT0 at block 94,421,000 (the `test/fork` suites accept a `FORK_BLOCK` override).

---

## 9. Deployment configuration

The production deployment script fixes chain 137, the token addresses at the top of this document and the modes in §5. The initial owner comes from `GASLESS_TRANSFER_OWNER`, which has no default. It verifies live token domain separators before deployment. The Amoy script uses test tokens (Circle's test USDC, a mock USDT0) and does not establish mainnet token compatibility.

The deployment record contains chainId, version (`"3"`, the contract's EIP-712 domain version), gaslessTransfer, initialOwner, deployBlock and each token's address, decimals, allowed modes and domain. The deployBlock value is the block the deploy script saw before its broadcast, a lower bound of the creation block, never above it.

Clients select relay addresses independently of the deployment record. Relay key rotation changes the relay field of new signatures, not the contract.

---

## 10. Compatibility boundaries

The definitions in §4.3 and §5 and surface in §4.4 govern signature and ABI compatibility. A transfer digest, over the request, its nonce and its token authorization, is also its relay request ID. Token authorization and transfer intent are separate signatures; the intent covers the token authorization, and the token authorization alone cannot select a new principal recipient, relay fee or transfer amount. Clients pin domain version `"3"` and refuse a deployment record of another version.

A relay failure does not revoke a signed intent: it stays valid until its nonce is used or its deadline passes (D6).

The transfer-contract configuration does not freeze an issuer-controlled token implementation.

The contract has no administrative recovery method; the owner manages only the token configuration (§4.2). A required contract change needs a new deployment and coordinated client pins.

---

## 11. Parameters

| Parameter | Value |
|---|---|
| solc / EVM | 0.8.28, `evm_version = cancun`. The Amoy script uses test tokens. |
| OpenZeppelin | v5.6.1, commit `5fd1781b1454fd1ef8e722282f86f9293cacf256` ([DEVELOPMENT.md](DEVELOPMENT.md)) |
| Token modes | USDC {PERMIT, NONE}; USDT0 {PERMIT, META_TX_APPROVE, NONE} |
| Owner | `Ownable2Step`; initial owner from `GASLESS_TRANSFER_OWNER` (production), no default |
| Nonces | sequential per signer; `invalidateNonces` raises by 1 to 2^32 − 1 per call |
| Fork block | 94,421,000 (fixed token-state fixture) |
