# @nimiq/gasless-sdk

Client SDK for gasless USDC and USDT0 transfers on Polygon through the `GaslessTransfer` contract and
the relay ([protocol specification](../docs/STEP-1-GAS-ABSTRACTION.md), §5 and §7). When needed, the user first
signs a token authorization (permit or USDT0 meta-tx approve), then an EIP-712 `GaslessTransfer` intent that names
every parameter, including the relay, the sender's next nonce and that token authorization. The relay pays the POL
gas; the fee is paid in the same token.

| Entry point | Contents | Dependencies |
|---|---|---|
| `@nimiq/gasless-sdk/core` | typed data builders, pins, validators, intent and submit-body helpers, ABIs; also `dist/core/index.global.js` (global `NimiqGaslessCore`) for browser scripts | none |
| `@nimiq/gasless-sdk/relay` | `RelayClient` for the relay API | `fetch` |
| `@nimiq/gasless-sdk/viem` | `prepareTransfer`, `signPrepared`, `confirmOnChain`, `waitForTransferOutcome`, token reads | `viem` (peer) |

## Security rules

Integrations must enforce these rules at the signing boundary. The SDK checks the inputs and state
available to it; the client remains responsible for trusted configuration and user confirmation.

1. **Pin the deployment.** Chain id, contract, relay addresses, tokens with their domains and auth modes
   come from the client's own pins (`definePins` / `pinsFromDeployment`), never from the relay or an
   untrusted calling application. On Polygon (137) pinned tokens must equal the frozen,
   mainnet-verified constants.
2. **Build typed data yourself.** Sign only typed data built from validated fields
   (`createTransferIntent` + `tokenAuthSigningPayload` + `transferSigningPayload`, or `prepareTransfer` +
   `signPrepared`) in the signing app itself. Never sign typed data or an intent object supplied by a
   relay or another application.
3. **Validate before signing.** `validateTransferRequest` checks the pinned chain, contract, relay,
   token and auth mode, `amount > 0`, the recipient denylist, the deadline window (now + 60 s to
   now + 7200 s), `amount + fee` within uint256, that the token authorization is exactly permit/approve of
   `amount + fee` to the pinned contract with `deadline = intent deadline` (never 0 or max), and that the
   signed token authorization the intent covers is of the intent's mode (`checkSignedAuthorization`).
4. **META_TX approvals never expire.** Do not persist or log a `SignedTransfer`, a submit body or
   a token signature. The SDK never logs and never stores anything. Once the relay broadcasts a
   META_TX approval it is public for good, also if the transaction reverts, and anyone can execute
   it until the user's USDT0 nonce moves on. Prefer PERMIT for USDT0, which `prepareTransfer` does
   by default (see [Token authorization modes](#token-authorization-modes)). `createTransferIntent`
   refuses `metaTxApprove` for a token that supports permit (`meta_tx_approve_not_allowed`) unless
   the caller passes `{ allowMetaTxApprove: true }`, and `signPrepared` refuses a prepared transfer
   of that mode when the caller passes `{ allowMetaTxApprove: false }`.
5. **Verify independently.** `RelayClient` refuses a relay whose `/v1/info` differs from the pins in
   any field and recomputes every request id locally; `confirmOnChain` and `waitForTransferOutcome`
   read the contract directly. `RelayClient` talks to a relay over `https://` only; plain `http://` is
   accepted for localhost, 127.0.0.1 and [::1] (see [Relay client](#relay-client)).
6. **USDT0 can be renamed by its admin**, which changes its domain separator. `checkTokenDomain`
   compares the on-chain `DOMAIN_SEPARATOR()` with the pinned domain; `prepareTransfer` does this
   before any token signature.
7. **EIP-7702 accounts**: USDC checks permits of accounts with code through ERC-1271
   (`isValidSignature`) of the account's delegate, not with ECDSA. Such a permit fails if the
   delegate does not implement ERC-1271, and succeeds only if the delegate accepts the account's
   signature, which the SDK cannot check. The relay refuses these permits
   (`invalid_token_authorization`). So `prepareTransfer` refuses them with
   `eip7702_permit_unsupported` unless the caller opts in with `allowEip7702Permit: true`. Instead,
   approve the transfer contract once; while that allowance covers `amount + fee`,
   `prepareTransfer` uses mode `none`. USDT0 permits use plain ECDSA and work for these accounts.
   Contract accounts cannot sign at all (ECDSA only, no ERC-1271).
8. **Show the fee and ask for confirmation.** The fee is a signed field, and nothing caps it:
   `GaslessTransfer` has no maximum fee, and a greedy or compromised relay may quote any fee (its
   quote is only a hint). Wallets must show the fee (and amount and recipient) and let the user
   confirm before signing. They may also pass the most they accept to pay as `maxAcceptableFee` to
   `RelayClient.fee()`, `prepareTransfer` and `signPrepared`, or, with the core alone, to
   `createTransferIntent`, `tokenAuthSigningPayload`, `transferSigningPayload` and
   `validateTransferRequest`. These then refuse a higher fee with `fee_above_limit`.
   `maxAcceptableFee` is optional; without it the user's confirmation is the only bound on the fee.
9. **Never let the user pay twice.** A relay error, a timeout or a relay status `failed` / `expired`
   does not prove that a signed intent can no longer execute. One payment is one intent nonce: every
   version of a payment is signed with it (a correction keeps it, `corrects`), so at most one version
   executes. A new payment takes the sender's on-chain `nonces(from)`; `prepareTransfer` reads it and
   refuses a `nonce` without `corrects`. Post the same body again after an unclear submit error, and
   start a new payment only once the chain shows that no version of the previous one can execute:
   `waitForTransferOutcome` (or `confirmOnChain` with `blockTag: 'finalized'`) reports `expired`,
   `nonce_consumed` or `other_payment_executed` for the payment's latest version, checked with every
   version signed for it (`versions`). See
   [Failures, retries and replacements](#failures-retries-and-replacements).

## Pins

```ts
import { definePins, pinsFromDeployment, POLYGON_TOKENS } from '@nimiq/gasless-sdk/core';

const pins = definePins({
    chainId: 137,
    transfer: '0x…', // GaslessTransfer
    relays: ['0x…'], // relay address(es) clients may sign for; several allow a key rotation
    tokens: POLYGON_TOKENS, // USDC {permit, none}, USDT0 {permit, metaTxApprove, none}
    deployBlock: 94_500_000, // at or below the contract's creation: confirmOnChain searches nothing below it
});

// Or from the deployment file of the deploy script (relays are not part of it):
const pinsFromFile = pinsFromDeployment(deploymentJson, { relays: ['0x…'] });
```

Tokens carry no fee cap: the fee a request pays is the one its sender signed (security rule 8). The
deployment file format is
`{"chainId","version":"3","gaslessTransfer","initialOwner","deployBlock","tokens":[{"symbol","address","decimals","authModes","domain"}]}`.
Integers may be JSON numbers or decimal strings; `authModes` entries may be `"permit"`, `"PERMIT"`
or `1` (the Solidity enum value); a domain field that is absent may also be `null`; a token entry may
also carry its expected `domainSeparator`. The file and its token entries have exact keys: any other
key fails. A file without `"version":"3"` is refused (`InvalidPinsError`, field `version`). Pins are
deep-frozen; `definePins` throws `InvalidPinsError` (with the offending `field`) on any
inconsistency: wrong checksums, a token domain that does not name the token or the chain, decimals
other than 6, more than 32 tokens (the most a relay's `/v1/info` may list), and so on. On chain 137,
the contract is deployed at `0x5A3a650fCf35639153aA6bA9aa3e870DAED56199`
(`contracts/deployments/137.json`).

The contract's owner can change a token's configuration (`setTokenConfig`: its auth modes, or remove
it), not the signed fields of a request, and sets no fee bound. The pins are the client's own: after
such a change, update them (a relay whose `/v1/info` no longer matches them is refused). Until then a
request in a mode that is no longer allowed reverts and moves nothing. Such a refusal is not final:
until its deadline, the request executes if the owner adds its token or mode again. Only the outcome
check decides about a refused payment.

The recipient denylist is derived from the pins: the zero address, the pinned tokens, the transfer
contract, `pins.extraDeniedRecipients` and, on chain 137, the built-in blocked Polygon addresses
defined in [the core constants](src/core/constants.ts). On chain 137, `definePins` also refuses
these built-in addresses as `transfer`.

## Token authorization modes

The contract checks `allowance(from, GaslessTransfer)` after the token call (spec §4.1 step 3).
In mode `none` it must be at least `amount + fee`. In modes `permit` and `metaTxApprove` it must be
exactly `amount + fee`, the value the signature grants, so a standing allowance of any other value is
never spent in place of the signature. The user either signs a token authorization that sets exactly
this allowance within the call, or has approved the contract before:

| Mode | What the user signs before the intent | Lifetime of that signature |
|---|---|---|
| `permit` (USDC, USDT0) | EIP-2612 `Permit` for `amount + fee` | until the intent deadline |
| `metaTxApprove` (USDT0) | `MetaTransaction` calling `approve(contract, amount + fee)` | none: valid until the user's USDT0 nonce moves on |
| `none` | nothing; spends a standing allowance | — |

The intent signs the token authorization as `TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)`: the token
signature for `permit` and `metaTxApprove` (v 27 or 28), zeros for `none` (`toTokenAuthorization`). So the token
signature comes first, and a relay cannot submit the intent with another token authorization or mode. The contract
checks the intent signature, at the sender's current nonce, before anything else.

When `authMode` is omitted, `prepareTransfer` chooses the mode and reports it as `prepared.authMode`:

1. **`none`** if the token allows it and `allowance(from, contract) >= amount + fee`. In PERMIT and
   META_TX modes the contract accepts only the exact allowance the signature grants. A permit sets the
   allowance to `amount + fee`, so it would overwrite the larger standing allowance. NONE also needs
   less gas. The relay refuses NONE (`insufficient_allowance`) when the allowance does not cover the
   transfer at its own read (see below).
2. Otherwise **`permit`**, also for USDT0; **`metaTxApprove`** only for a token without permit.
   The reason: a META_TX approval has no deadline. Once the relay broadcasts it, it is public for
   good, also if the transaction reverts (for example because the user moved the funds before
   inclusion). Anyone can then execute it at a time of their choice. That uses up the user's USDT0
   nonce, which permit and meta-tx share, so the next pending permit or meta-tx fails, and it leaves
   `amount + fee` approved to the contract. It cannot move funds without a new intent signature.

Pass `authMode` to force a mode; it is used as given, without reading the allowance. Forcing
`metaTxApprove` in `prepareTransfer` is the caller's explicit choice of the META_TX approval. The core
`createTransferIntent` refuses `metaTxApprove` for a token that supports permit
(`meta_tx_approve_not_allowed`) unless the caller passes `{ allowMetaTxApprove: true }` as its fourth
argument (spec §5). The fee quote depends on the mode. Quote `permit`: that fee also covers `none`,
which needs less gas. To pay the lower `none` fee, quote `none` and pass `authMode: 'none'`.

**When the relay refuses `none` with `insufficient_allowance`** (422; not worth retrying with the same
body). The allowance does not cover `amount + fee` at the relay's read, which `prepareTransfer` may
have seen differently (the user changed the allowance, or another spender used it). Prepare a
correction of the refused version (`corrects: prepared.request`, which keeps its intent nonce; see
[Corrections](#corrections)); `prepareTransfer` then reads the allowance again and picks `none` or
`permit`. The relay keeps one pending request per sender. While one is pending, another request of
the same sender at its nonce gets `conflict`, and one at a higher nonce `nonce_too_high` (409,
retryable). `sender_busy` (409, retryable) means that the relay cannot take the request yet: the
sender's previous request was just mined and the relay's reads do not show it yet, a failed or expired
request at this nonce has not settled, a permit or meta-tx of the sender (or a pending `none` request
whose allowance a token signature would replace) is pending or just mined, or the sender still has a
request in flight at a nonce that it invalidated.

## viem

```ts
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { polygon } from 'viem/chains';
import { buildSubmitTransferBody, POLYGON_USDC, type TransferVersion } from '@nimiq/gasless-sdk/core';
import { RelayClient } from '@nimiq/gasless-sdk/relay';
import { confirmOnChain, prepareTransfer, signPrepared } from '@nimiq/gasless-sdk/viem';

const publicClient = createPublicClient({ chain: polygon, transport: http() });
const walletClient = createWalletClient({ chain: polygon, transport: custom(window.ethereum), account });
const relay = new RelayClient('https://relay.example.com', { pins });

// The most this wallet pays per transfer without asking again: 0.10 USDC (nothing else caps the fee).
const maxAcceptableFee = 100_000n;

// 1. Quote. The client verifies /v1/info against the pins first, then the quote.
const quote = await relay.fee({ token: POLYGON_USDC.address, authMode: 'permit', maxAcceptableFee });

// 2. Prepare: validates against the pins and maxAcceptableFee, checks the chain, reads the sender's
//    nonce (nonces(from)) and code, chooses the auth mode (none if an allowance covers amount + fee,
//    else permit), checks the token's DOMAIN_SEPARATOR(), reads the permit nonce, builds the token
//    authorization's typed data. Deadline: now + 600 s.
const prepared = await prepareTransfer(publicClient, pins, {
    token: POLYGON_USDC.address,
    from: account.address,
    to: recipient,
    amount: 10_000_000n, // 10.00 USDC
    fee: quote.fee,
    maxAcceptableFee,
    relay: quote.relay,
});

// 3. Show prepared.request (amount, fee, recipient) to the user and sign only after they confirm.
//    signPrepared accepts a viem LocalAccount or a WalletClient, re-validates, signs the token
//    authorization first and the intent over it second, and checks that both recover to `from`.
const signed = await signPrepared(walletClient, prepared, pins);
// Record the version (request and authHash, no signature) as the payment's latest version now.
const latest: TransferVersion = { request: signed.request, authHash: signed.authHash };

// 4. Submit and wait. The returned id must equal the local EIP-712 digest (signed.id). If a call
//    throws, see "Failures, retries and replacements": start no new payment before
//    waitForTransferOutcome reports expired, nonce_consumed or other_payment_executed for the
//    payment's latest version.
const { id } = await relay.submitTransfer(buildSubmitTransferBody({ ...signed, quoteId: quote.quoteId }));
const state = await relay.waitForRequest(id, { until: 'mined', timeoutMs: 120_000 });

// 5. Independent check on-chain, at the latest block: executed, other_version_executed,
//    other_payment_executed, pending, expired, nonce_consumed or unresolved. `versions` lists every
//    version signed for the payment (here only this one).
const onChain = await confirmOnChain(publicClient, pins, { ...latest, versions: [latest] }, { txHash: state.txHash ?? undefined });
```

`signPrepared(signer, prepared, pins, { account?, now?, maxAcceptableFee?, allowMetaTxApprove? })`
validates the prepared transfer again before each signature. With `maxAcceptableFee`, a higher fee
fails with `fee_above_limit` before anything is signed. With `allowMetaTxApprove: false`, a transfer of
mode `metaTxApprove` fails with `meta_tx_approve_not_allowed` before anything is signed (a META_TX
approval never expires, security rule 4). Without them it signs the fee and the mode of the prepared
transfer, as they are. An app that signs a transfer prepared by another application (a signing
boundary, such as a keyguard) passes both, from its own settings.

When the wallet fails to sign the intent (a rejection, a failed or timed-out request), `signPrepared`
throws the wallet's own error, so its class and `code` still tell a user rejection. viem's transport
errors quote the request, and the intent's typed data holds the token signature made just before, so
that signature is first removed from the error's string fields, its request body and its causes
(`[token signature]` stands in its place). An error that cannot be changed is replaced by a
`GaslessError` with code `signing_failed`.

`SignedTransfer` holds the token signature; persist a `TransferVersion` (`{ request, authHash }`, with
`authHash = tokenAuthHash(authorization)`) instead. `transferDigestFromAuthHash(chainId, contract, request,
authHash)` is its id.

The contract reads of this adapter (`prepareTransfer`, `checkTokenDomain`, `readTokenNonce`,
`confirmOnChain`, `waitForTransferOutcome`) run with viem's CCIP-Read off, whatever the client's own
`ccipRead` setting, and the client itself is not changed. An RPC that answers an `eth_call` with an
`OffchainLookup` revert gets an ordinary read error, not an HTTP request to the URLs it names.

`confirmOnChain(client, pins, { request, authHash?, versions? }, { txHash?, fromBlock?, blockTag? })`
reads `nonces(from)` and, when it is above the request's nonce, finds what used the nonce; it does not
trust the relay. All reads are pinned to one block: `blockTag` `latest` (default), `safe` or
`finalized`. An answer at the latest block can still change in a reorg. An answer at the finalized
block is final; use that one before starting a new payment. It returns `{ status, txHash, blockNumber,
executedTransfer, reason? }` (`reason` for `unresolved` only). Every version of a payment shares one
intent nonce (see [Corrections](#corrections)), so the answer is about the nonce, not only about this
version.
`versions` lists every version the wallet signed for the payment (`TransferVersion`s with the same
`from`, nonce, `token` and `to`, and none with a later deadline than the checked version, else
`invalid_request`; the checked one is added when its `authHash` is given): it tells a version of this
payment from another payment of the sender that got the same nonce.

| `status` | Meaning |
|---|---|
| `executed` | A successful `relayTransfer` call of the pinned contract with exactly this request (and, with `authHash`, this token authorization), signed by `from` at the nonce. |
| `other_version_executed` | Another request of `from` executed at the nonce, in a block not after this version's deadline, and it is a version of the payment: one in `versions`, or, without `versions`, one with the same token and recipient. `executedTransfer` holds it (`{ request, authHash }`). The payment went through. |
| `other_payment_executed` | Another request of `from` executed at the nonce, in a block not after this version's deadline, and it is not a version of the payment: another token or recipient, or, with `versions`, a request not listed. `executedTransfer` holds it. This payment did not execute, and no version of it can. |
| `pending` | `nonces(from)` is not above the nonce and the deadline has not passed: the request may still execute. |
| `expired` | The nonce was unused at the last block at or before the deadline: this version can never execute. For the payment's latest version, no version can. |
| `nonce_consumed` | The sender's `invalidateNonces` covered the nonce (its `NonceInvalidated` event was found): no version executed, and none can. |
| `unresolved` | The nonce is used, but neither its execution nor its invalidation was found. `reason` says why: `not_found` (the block that used the nonce shows neither, for example because another contract called `relayTransfer`) or `no_history` (the RPC has no state of older blocks, and its logs did not show the use; see below). Not an answer. |

Two payments of one sender get the same nonce when the second one is prepared while the first is
open (against rule 1 below: for example on two devices with one key) or from an RPC node behind the
chain (`minNonce` of `prepareTransfer` refuses that). At most one of them executes. Without `versions`,
a payment to the same token and recipient that executed at the nonce reads as `other_version_executed`
of the other: a correction may change the amount, so the SDK cannot tell them apart. So pass
`versions`, and leave no signed version out: one left out that executed reads as
`other_payment_executed`, and a new payment would then pay twice.

`txHash` and `blockNumber` name the transaction that used the nonce (`executed`,
`other_version_executed`, `other_payment_executed`, `nonce_consumed`); `executedTransfer` is set for the
three executed statuses.
A nonce is used once, but after `expired` the next payment of the sender takes the same nonce (it is
still `nonces(from)`). Such a later use is not this version's: an execution after this version's
deadline never counts for it, and once the nonce was unused at the deadline the answer is `expired`,
whatever used it later. So pass the payment's latest version, the one with the latest deadline (an
earlier version is `expired` also when a correction executed after its deadline). With `versions` the
check enforces this: a listed version with a later deadline than the checked one throws
`invalid_request` (field `versions[i].request.deadline`).

**The search and the RPC.** `GaslessTransfer` emits no event for a transfer. With the relay's
`txHash`, the receipt and the transaction usually answer at once. A reverted call is no execution
(the relay reports the hash of its call for a failed request too), and neither is the request's call
data sent to another contract (the transaction's `to` or its receipt's is not the pinned contract).
Otherwise the check finds the block that used the nonce from the contract's state, not from logs:
`nonces(from)` never decreases, so that block is the first one at whose state it is above the nonce.
It reads `nonces(from)` with `eth_call` at block numbers, stepping down from the block read by 1, 2,
4, … blocks until the nonce is unused there, then bisecting: at most 2·floor(log2(d + 1)) + 1 reads
for a use d blocks below the block read, never below `pins.deployBlock` (the block the deploy script
saw before its broadcast; up to the contract's creation `eth_call` answers no data there, which reads as
nonce 0 once `eth_getCode` shows no code at that block). No data where the contract has code is a wrong
answer of the RPC, not nonce 0: at the block read the read's error is thrown, and in the search it counts
as a read the node cannot serve (see below). When the search ends at the pin, the block under it is
read once: a nonce already used there means the pin is above the contract's creation, and the check
throws `InvalidPinsError` (field `deployBlock`) instead of answering. If that block is after the
deadline, the nonce was unused at the deadline: `expired`, whatever used it later. Otherwise it reads
that block with its transactions (`eth_getBlockByNumber`) and finds there either a direct
`relayTransfer` call of the pinned contract, sent by the request's relay, whose signature recovers to
the sender for the decoded request at this nonce and whose receipt is successful (an execution of
another payment at the nonce is an answer too), or the sender's `NonceInvalidated(signer,
previousNonce, newNonce)` event that covers the nonce (`previousNonce` to `newNonce − 1`; one
`eth_getLogs` for that block, with a filter only the sender's events match). The receipts come with
one `eth_getBlockReceipts` of that block, however many such calls it holds. From an RPC that refuses
it, only these calls' receipts are read, one by one and at most 16; a block with more such calls
gives no execution (`unresolved`, unless it holds the invalidation). No query asks for logs that
other accounts can emit: anyone can emit a `Transfer` of 0 from the sender (a `transferFrom` of 0
needs no allowance), and a flood of them changes neither the answer nor the number of requests (18
for an execution 100 blocks below the block read). A `relayTransfer` call from another contract (a
relay that is a smart account, uses a bundler, or is an EOA with an EIP-7702 delegation that sends
the transaction to itself: the transaction's `to` is not the pinned contract) is not recognized; the
answer is then `unresolved` (`not_found`), unless that block holds the sender's `NonceInvalidated`
covering the nonce.

So the RPC must serve the state of older blocks (an archive node). A node without it refuses those
reads, and the check falls back to a log search. It covers the blocks from the first one whose
timestamp is at least `d − 7800 s`, where d is the earliest deadline of this version and `versions`
(7200 s, the longest the SDK and the relay accept after the signing, plus 600 s for clocks and lagging
nodes; never below `pins.deployBlock`), up to the last one at or before the deadline, capped by the
block read, from the top down. Past the deadline, `nonces(from)` is first read at that last block if
the node can: unused there means `expired`. A node that cannot read that block's state either answers
nothing there, and the search then also covers the later blocks up to the block read, bottom up, for
an invalidation after the deadline. If that last block lies below `pins.deployBlock`, the log search
answers nothing (`unresolved`, never `expired`): a payment's deadline is after the contract's creation,
so this happens only with a pin above the creation, where the use can lie below the pin (the state
search throws `InvalidPinsError` in that case). For each range it asks `eth_getLogs` with two exact
filters: the pinned tokens' `Transfer` logs with the sender as `from`, to any recipient, and the
sender's `NonceInvalidated` events. It reads the transaction of each transfer of a positive amount (only the
sender and the spenders it approved can make one) and drops zero-amount logs without reading theirs,
as the contract never moves 0. It asks for at most 1000 blocks at a time and halves the range whenever
the RPC refuses one (public endpoints often allow only 100 blocks or fewer). A block whose `Transfer`
logs the RPC refuses even alone, or answers with 1000 or more (it may have cut them off), is read
through its transactions instead, as above; a refused `NonceInvalidated` query of a single block
throws the RPC's error. `fromBlock` replaces the start of the log search, for example to look further
back after an `unresolved` answer.

A check makes at most 500 JSON-RPC requests, each retried as the client's transport is configured;
then it answers `unresolved` (`no_history`), and `waitForTransferOutcome` keeps waiting. The state
search needs few, whatever others emit: the relay a signed version names can put hundreds of
reverted copies of its call (out of gas) before the executing one in the block of the use, and their
receipts come with that block's (6 + 2·floor(log2(d + 1)) requests for 510 copies). Without
`eth_getBlockReceipts` that relay can make the answer `unresolved` with 16 copies, as it can with a
call through code. A flood of zero-amount `Transfer` logs over many blocks can use up the requests
of the log search, on an RPC without the state of older blocks. `waitForTransferOutcome` then goes
on with the search where its previous poll stopped: no block searched without an answer is searched
again, and no block above the one the previous poll read (the nonce was used there already), while
that block is still the block of its number (its hash; after a reorg the search starts again). A
range in which the RPC did not serve a receipt or a transaction it must hold is searched again, and
so are the log queries of the blocks within 128 of the block a poll read: a load-balanced RPC can
answer `eth_getLogs` from an index that lags the block it serves, with no log where there is one. A
block whose transactions were read is not read again. So the wait searches the flooded blocks once,
a later poll reads little more than the block, `nonces(from)`, the bounds of the search and the
logs of those last 128 blocks (before the deadline, while the block read stays the same: the chain
id, the block, `nonces(from)`, the refused read of older state, and one `Transfer` and one
`NonceInvalidated` query per stretch of those blocks whose transactions were not read, one
`NonceInvalidated` query per stretch whose transactions were), and the answer comes once the search
reaches the use. A log index more than 128 blocks behind the block read can hide the use for the
rest of the wait (`timeout`), never give another answer.

`waitForTransferOutcome(client, pins, { request, authHash, id?, versions? }, { relay?, blockTag?,
pollIntervalMs?, timeoutMs?, fromBlock?, signal?, now? })` waits until the outcome is final, by
default at the finalized block, and returns `{ status, txHash, blockNumber, executedTransfer,
relayState }`. Pass the payment's latest version (a `TransferVersion`, or the `SignedTransfer`), and
every version signed for the payment as `versions` (as for `confirmOnChain`). `status` is one of:

- `executed` or `other_version_executed`: the payment went through (`executedTransfer`); never sign
  again for it;
- `other_payment_executed`: another payment of the sender used the intent nonce (`executedTransfer`),
  so no version of this one can execute;
- `expired`: the intent nonce was unused at the deadline and a finalized block is past it, so no
  version with a deadline up to this one can execute;
- `nonce_consumed`: the sender invalidated the intent nonce, so no version can execute.

`pending` and `unresolved` are not final: it keeps waiting. The chain decides; the relay (optional; a
`RelayClient` or any object with `getRequest(id)`) only says when reading the chain is worthwhile, and
its `txHash` saves a search. Before the deadline the chain is read only while the relay reports
`mined`, `confirmed`, `failed` or `expired`, or does not answer; after the deadline on every poll. By
default it gives up 30 minutes after the deadline with a `timeout` error (`GaslessError`, code
`timeout`): the outcome is not final yet. When the nonce is used, the message says why its use was
not found: the RPC serves no state of older blocks (it is not an archive node; one that is answers at
once), or the block that used it shows neither its execution nor its invalidation. RPC errors are
thrown. The finalized block trails the head; by how much depends on the chain and the RPC node.

`hashTransfer(chainId, contract, request, authorization)` computes the digest with viem's
`hashTypedData`; it equals the core `transferDigest`, the contract's `hashTransfer(r, nonce, auth)` and
the relay request id.

## ethers v5 and browser bundle

An application can load the core without a bundler and sign with ethers v5 `_signTypedData`, which takes
the SDK payloads as they are (types without `EIP712Domain`, uint256 values as decimal strings).

```html
<script src="…/@nimiq/gasless-sdk/dist/core/index.global.js"></script>
<script>
    const C = NimiqGaslessCore;
    const pins = C.definePins({ chainId: 137, transfer: '0x…', relays: ['0x…'], tokens: C.POLYGON_TOKENS });
    // The signing app's own setting: the most the user pays per transfer (0.10).
    const options = { maxAcceptableFee: 100000 };

    async function signTransfer(wallet, fields) {
        // `fields` are plain values from the client: token, to, amount, fee, relay, authMode, deadline,
        // tokenNonce, nonce (the sender's nonces(from), for a payment's first version only), and for every
        // later version of a payment `corrects` (the latest version's request) instead of its nonce. They
        // are validated here; typed data supplied by the client is never used.
        const now = Math.floor(Date.now() / 1000);
        const intent = C.createTransferIntent(pins, { ...fields, from: wallet.address }, now, options); // throws GaslessValidationError
        // The token authorization first (null for mode "none") ...
        const tokenAuth = C.tokenAuthSigningPayload(pins, intent, now, options);
        const tokenSignature = tokenAuth === null ? null : await wallet._signTypedData(tokenAuth.domain, tokenAuth.types, tokenAuth.message);
        const authorization = C.toTokenAuthorization(intent.authMode, tokenSignature);
        // ... then the intent over it.
        const transfer = C.transferSigningPayload(pins, intent, authorization, now, options);
        const signature = await wallet._signTypedData(transfer.domain, transfer.types, transfer.message);
        return C.buildSubmitTransferBody({ request: intent.request, signature, authorization });
    }
</script>
```

`createTransferIntent` checks the fields against the pins (same codes as `validateTransferRequest`)
and builds the permit or meta-tx approve from the pinned token domain, with spender = the pinned
contract, value = amount + fee and, for permits, deadline = the intent deadline.
`tokenAuthSigningPayload` and `transferSigningPayload` re-validate an intent right before each
signature (for example after the user confirmed) and rebuild the typed data; only the token nonce is
taken over from the intent. `transferSigningPayload` also checks that the token authorization is of
the intent's mode and in the form the relay submits. The core does not read the chain, so the caller
reads the sender's `nonces(from)` from the contract, picks `authMode` by the rules of
[Token authorization modes](#token-authorization-modes), and the signing app shows amount, fee and
recipient for confirmation before it signs (security rule 8). A new version of a payment comes with
`corrects`: `createTransferIntent` then keeps the intent nonce and enforces the
[correction rules](#corrections). `createTransferIntent` needs a `nonce` or `corrects`
(`invalid_request`, field `nonce`), and, unlike `prepareTransfer`, takes a `nonce` without `corrects`,
so a client supplies a payment's first nonce. It cannot tell an earlier version's nonce passed that way
from a new payment, and then checks none of the correction rules. A client using this interface must
therefore enforce the following requirements:

- it passes `nonce` alone only for the first version of a payment, and that nonce is the sender's
  current `nonces(from)`, read on-chain right before: never a higher one (it cannot execute before the
  nonces below it are used) and never while another payment of the sender is open
  ([One payment, one nonce](#failures-retries-and-replacements));
- for every later version it passes `corrects` (the payment's latest signed version), never that
  version's nonce alone;
- before it requests a correction signature, it reads `nonces(from)` on-chain. Once it is above the
  payment's nonce, a version executed or the nonce was invalidated: it asks for nothing more and runs
  `waitForTransferOutcome` with the latest version.

The last argument holds the signing app's own options. It is separate from the fields, so fields
supplied by the client cannot set these options:

| Option | Taken by | Effect |
|---|---|---|
| `maxAcceptableFee` | `createTransferIntent`, `tokenAuthSigningPayload`, `transferSigningPayload`, `validateTransferRequest` | The most the user pays, in token units (bigint, decimal string or safe integer). A higher fee fails with `fee_above_limit`. Optional, but nothing else caps the fee: neither the contract nor the pins, and a relay may quote any fee. |
| `allowMetaTxApprove` | `createTransferIntent` | Default false: mode `metaTxApprove` for a token that supports permit (USDT0) fails with `meta_tx_approve_not_allowed`, because a META_TX approval never expires (security rule 4). Set it only when the signing app itself chose the META_TX approval, never because another application asked for that mode. A token without permit needs no opt-in. |

`tokenAuthSigningPayload` and `transferSigningPayload` take the auth mode from the intent, so build the
intent with `createTransferIntent` in the signing app; never sign an intent object supplied by another
application.
`checkAcceptableFee(fee, maxAcceptableFee, field)` and `parseMaxAcceptableFee(value)` are the checks
behind `maxAcceptableFee`, for example to refuse a quote before building the intent. The IIFE global
`NimiqGaslessCore` contains all of these.

## ethers v6

```ts
import { Contract, JsonRpcProvider, Wallet, type TypedDataField } from 'ethers';
import {
    buildSubmitTransferBody,
    createTransferIntent,
    findPinnedToken,
    gaslessTransferAbi,
    POLYGON_USDT0,
    toTokenAuthorization,
    tokenAuthSigningPayload,
    transferSigningPayload,
    usdt0Abi,
} from '@nimiq/gasless-sdk/core';
import { RelayClient } from '@nimiq/gasless-sdk/relay';

const provider = new JsonRpcProvider(rpcUrl, 137);
const wallet = new Wallet(privateKey, provider);
const relay = new RelayClient('https://relay.example.com', { pins });
const usdt0 = new Contract(POLYGON_USDT0.address, usdt0Abi, provider);
const gasless = new Contract(pins.transfer.address, gaslessTransferAbi, provider);

// Refuse to sign token authorizations if USDT0's domain changed (admin rename).
if ((await usdt0.getFunction('DOMAIN_SEPARATOR')()) !== findPinnedToken(pins, POLYGON_USDT0.address)?.domainSeparator) {
    throw new Error('USDT0 domain changed');
}

// A USDT0 permit (valid until the intent deadline), not the META_TX approval that never expires.
// Use mode 'none' instead if allowance(wallet, contract) >= amount + fee (Token authorization modes).
const quote = await relay.fee({ token: POLYGON_USDT0.address, authMode: 'permit', maxAcceptableFee: 100_000n });
const now = Math.floor(Date.now() / 1000);
const intent = createTransferIntent(
    pins,
    {
        token: POLYGON_USDT0.address,
        from: wallet.address,
        to: recipient,
        amount: 10_000_000n,
        fee: quote.fee,
        relay: quote.relay,
        authMode: 'permit',
        deadline: now + 600,
        // A new payment: the sender's next nonce. Only once its previous payment is decided.
        nonce: (await gasless.getFunction('nonces')(wallet.address)) as bigint,
        tokenNonce: (await usdt0.getFunction('nonces')(wallet.address)) as bigint,
    },
    now,
);
// ethers' types want mutable arrays; the SDK payloads are deep-frozen `as const` data.
const types = (payload: { types: object }) => payload.types as Record<string, TypedDataField[]>;
// The permit first, then the intent over it.
const tokenAuth = tokenAuthSigningPayload(pins, intent, now);
if (tokenAuth === null) throw new Error('unreachable: permit mode has a token authorization');
const permitSignature = await wallet.signTypedData(tokenAuth.domain, types(tokenAuth), tokenAuth.message);
const authorization = toTokenAuthorization('permit', permitSignature);
const transfer = transferSigningPayload(pins, intent, authorization, now);
const signature = await wallet.signTypedData(transfer.domain, types(transfer), transfer.message);

const { id } = await relay.submitTransfer(buildSubmitTransferBody({ request: intent.request, signature, authorization, quoteId: quote.quoteId }));
await relay.waitForRequest(id);
```

## Relay client

`new RelayClient(baseUrl, { pins, fetch?, requestTimeoutMs?, now?, allowInsecureHttp? })`, where
`baseUrl` is the relay origin without `/v1`.

- `baseUrl` must use `https://`. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and
  `[::1]` (a relay on the same machine); any other `http://` URL throws a `TypeError`. Signed bodies,
  including META_TX approvals that never expire, must not cross a network unencrypted.
  `allowInsecureHttp: true` lifts this for a relay on a private test network, such as the compose
  stack (`http://relay:8080`). Never set it in a wallet.
- `requestTimeoutMs` bounds each HTTP request, including its response body (default 15 000).
  Timeout and abort settle the SDK promise even if a supplied fetch ignores `AbortSignal`; the SDK
  requests cancellation and discards late responses. It cannot force a custom transport to stop its
  own background work. A timed-out or aborted POST may already have reached the relay: use the
  identical-body retry and on-chain outcome rules below. Poll timeouts use monotonic elapsed time;
  unix-clock adjustments still affect the explicit signing/deadline checks.
- Native WHATWG response bodies have a streaming 1 MB limit. Polyfills with only `text()` keep
  their compatibility fallback and check size after buffering; use a native streaming fetch for
  untrusted relay URLs. Timeouts cannot preempt synchronous code that blocks the JavaScript thread.
- `now` is the clock in unix seconds (default: the system clock). It is used for the deadline checks
  before submitting and for the settle margin of `waitForRequest`.

| Method | Checks |
|---|---|
| `info()` | `/v1/info` must match the pins in every field the client reads: chain id, relay address (one of `pins.relays`), contract address and domain (version `3`), token set, symbols, decimals, auth modes and token domains. Otherwise `RelayPinMismatchError` (`code: 'pin_mismatch'`, `field`, e.g. `tokens[0].tokenDomain`). Fields the client does not use are ignored. |
| `fee({ token, authMode, maxAcceptableFee? })` | Token and mode pinned; quote for the same token and mode, naming the verified relay, a multiple of 0.01. Nothing in the pins caps the quote; show it to the user. With `maxAcceptableFee`, a higher quote throws `GaslessValidationError` `fee_above_limit` (field `fee.fee`). |
| `submitTransfer(body, { repost?, signal? })` | Body validated against the pins (`validateSubmitTransferBody`) and signed for the verified relay before it is sent; the returned id must be the request digest (`transferDigest(chainId, contract, body.request, body.authorization)`). Resolves for 202 (stored) and 200 (the identical body was stored before). `repost: true` marks a re-post of a body whose first post got no clear answer: the client-side deadline window (now + 60 s … now + 7200 s) is then not checked, because a relay answers an identical body it stored with 200 before any policy check, also after the deadline. Every other check still applies. |
| `getRequest(id)` | The returned request with its `authHash` (`tokenAuthHash` of its token authorization; the state never holds a token signature) must hash to `id`. |
| `waitForRequest(id, { until, timeoutMs, pollIntervalMs, settleMarginSeconds, signal })` | Polls until `submitted` / `mined` / `confirmed` (`until`, default `mined`; `timeoutMs` default 600 000, `pollIntervalMs` 1 000); retries network errors, timeouts, 429 and 5xx, waiting twice as long after each failed poll in a row (up to 16 s). For `failed` / `expired` see below. Other relay errors are thrown at once: `not_found` means that the relay behind the URL does not know the id (see the table below). Otherwise throws a `timeout` or an `aborted` error. |

The client verifies `/v1/info` once and reuses it; if a quote or body names another relay it verifies
again after a key rotation, and a relay that stops matching the pins is not trusted from the older
check. Redirects are refused, so a signed body only reaches the configured URL.

**`failed` and `expired` are not always final** (spec §6.5). The relay reports them as soon as
an inclusion decided them, for example a call that reverted on-chain or a mined cancel transaction.
Until that block is final, a reorg or a lagging node can still turn the request into `mined`. So
`waitForRequest`:

- throws `RelayRequestFailedError` with `final: true` at once if the request lists no transactions:
  nothing was broadcast, so no inclusion can change the outcome;
- otherwise keeps polling until the client clock is past `request.deadline` plus
  `settleMarginSeconds` (default 180), and returns a `mined` or `confirmed` status that the relay
  reports meanwhile. After that it throws `RelayRequestFailedError` with `final: true`;
- if `timeoutMs` ends first, throws the last failure with `final: false`: the outcome can still
  change.

`RelayRequestFailedError` has `code` (`request_failed` or `request_expired`), `state` (the relay's
last answer), `relayCode` (the relay's reason, such as `simulation_failed`, or null) and `final`.
`final` is a hint, derived from the relay's transaction list and the client clock; only
`waitForTransferOutcome` (or `confirmOnChain` with `blockTag: 'finalized'`) decides whether the
payment can still execute. The 180 s margin covers the relay's usual finality rule
(`min(finalized, head − 16)`), not every case: on an RPC without the `finalized` tag the relay settles
only 256 blocks deep (`RELAY_FINALITY_FALLBACK_DEPTH`, about 6.4 minutes at Polygon PoS's 1.5 s per
block), it treats a `finalized` tag up to 600 blocks behind the head as normal
(`RELAY_MAX_FINALITY_LAG_BLOCKS`), and a client clock that is ahead shortens the margin. So the relay
can still report `mined` after `final: true`. Before signing anything new for the payment, check the
chain with the payment's latest version
(see [Failures, retries and replacements](#failures-retries-and-replacements)). The error's message
says so, final or not.

Response bodies are limited to 1,000,000 bytes (`invalid_response`, "response too large"). A larger
`Content-Length` is refused before the body is read. A body that is a WHATWG `ReadableStream` (the
built-in `fetch` of Node 18 and later, browsers, Deno) is read chunk by chunk and cancelled as soon as
it passes the limit. Any other body is read in full with `text()` and its size is checked afterwards;
only `requestTimeoutMs` bounds that read. This is the case for node-fetch and cross-fetch on Node,
whose body is a Node.js stream, and for React Native, which has no body stream. Prefer the built-in
`fetch` where there is one.

Errors:

- `RelayApiError` carries the relay `ErrorCode` and the HTTP `status`. `retryable` is true for
  `rate_limited`, `unavailable` and `internal_error` (post the same body again later), for
  `sender_busy` (the relay cannot take this sender's request yet, for example right after its previous
  one was mined) and for `nonce_too_high` (the request's nonce is above the sender's `nonces(from)`: it
  can execute only after the request at the lower nonce). After either 409, wait until the sender's
  pending request is mined, then check the body's nonce against `nonces(from)`: if they are equal, post
  the body again as it is; if the nonce was used meanwhile, the payment of the body is decided
  (`waitForTransferOutcome` with its latest version); if `nonces(from)` stays below it, sign nothing new
  and wait for the outcome too (`expired` after the deadline). A `permit` or `metaTxApprove` body whose token nonce the other request used up must be
  prepared and signed again (a correction, `corrects`). Every other relay code is the final answer for
  that body.
- `RelayClientError` has the codes `network_error`, `timeout`, `aborted`, `http_error`,
  `invalid_response` and `pin_mismatch` (`RelayPinMismatchError`). `retryable` is true for
  `network_error`, `timeout`, and `http_error` with status 429 or 5xx.
- `RelayRequestFailedError` (above) comes from `waitForRequest`.

## Failures, retries and replacements

The rule behind this section: the user must never pay twice. A signed intent stays executable until
its deadline unless its intent nonce is used. The contract keeps one nonce per sender, `nonces(from)`,
executes a request only at that nonce and then moves it on by one, and `invalidateNonces(newNonce)`
lets the sender move it further. So at most one request executes per `(from, nonce)`, and a request at
a higher nonce waits for the ones below it. Three rules follow (spec §7):

1. **One payment, one nonce.** A new payment takes the sender's current `nonces(from)`
   (`prepareTransfer` reads it at the latest block, never a higher one; a core client reads it itself).
   Every later version of the same payment is a correction (`corrects`, below) and keeps that nonce.
   However many versions the user signed, at most one of them executes. Start a new payment only once
   the previous payment of the sender is decided (rule 3): while its nonce is unused, `nonces(from)` is
   still that nonce, and the new payment would get it too. Then at most one of the two could execute.
   A wallet keeps one open payment per sender, and passes `minNonce` to `prepareTransfer`: the previous
   payment's nonce + 1 after `executed`, `other_version_executed`, `other_payment_executed` or
   `nonce_consumed`, its nonce after `expired`. An RPC node behind the chain then cannot hand the new
   payment a used nonce (`nonce_used`, field `minNonce`). The SDK keeps no state, so it cannot enforce
   one open payment across two wallet instances of one key (two devices); when that happens, the outcome
   check with `versions` still tells the two payments apart (`other_payment_executed`).
2. **Track every version.** Keep each version the user signed for each payment (a `TransferVersion`:
   its request and `authHash`, no signature), and prepare every correction from the latest one
   (`corrects: latest.request`); the correction is then the latest version. Record a version as the
   latest as soon as it is signed, before it is submitted, and keep the earlier ones: a wallet that
   records it only after the relay's 202 loses it on a network error and a restart, and then checks
   an older version with an earlier deadline, and without that version in `versions`. A
   correction's deadline is never earlier than the corrected one's, so the latest version has the
   latest deadline: once it can no longer execute, no version can. Every check below that decides about
   the payment (`waitForTransferOutcome`, or `confirmOnChain` with `blockTag: 'finalized'`) takes the
   latest version, not the request that failed, and all versions as `versions`.
3. **A new payment only after the outcome.** Start one only after `waitForTransferOutcome` (or
   `confirmOnChain` with `blockTag: 'finalized'`) reports `expired`, `nonce_consumed` or
   `other_payment_executed` for the latest version of the previous payment, or `executed` or
   `other_version_executed` (that payment went through). After `expired` the new payment gets the same
   nonce again; the expired payment can never execute, so the two cannot both execute.

### Corrections

`prepareTransfer(client, pins, { ...params, corrects: latest.request })`, or in the core
`createTransferIntent(pins, { ...fields, corrects: latest.request }, now)`, prepares a new version of
the payment whose latest signed version is `latest`. `checkCorrection(latest.request, request)` is the
same check on its own.

| Field | Rule | Why |
|---|---|---|
| `from`, `nonce` | Equal. Without `nonce`, the corrected version's nonce is taken over. | The contract executes at most one request per `(from, nonce)`. |
| `token`, `to` | Equal. | They define the payment: which token goes to whom. Without `versions`, the outcome check takes an execution at the nonce with the same token and recipient for a version of the payment, and one with another token or recipient for another payment (`other_payment_executed`). Another token or recipient is a new payment. |
| `deadline` | Not earlier. `prepareTransfer`'s default is the later of the corrected deadline and now + 600 s. | `expired` of the latest version then covers every version. |
| `amount`, `fee`, `relay`, auth mode, token authorization | May change. | A correction may need a higher fee after `fee_too_low` (and a lower amount for a "send all" transfer so that amount + fee stays within the balance), another relay after a key rotation or when a relay does not execute, another mode or a new token nonce after `insufficient_allowance`, `sender_busy` or `invalid_token_authorization`. |

A correction that breaks a rule throws `GaslessValidationError` `correction_mismatch`, with the field.
`prepareTransfer` also reads `nonces(from)`: once it is above the payment's nonce, a version executed
or the nonce was invalidated, and it throws `nonce_used`; run `waitForTransferOutcome` with the latest
version instead. The core cannot read the chain, so a client using it must read `nonces(from)` before
requesting a correction signature.

`prepareTransfer` takes `nonce` only together with `corrects`, where it must equal the corrected
version's nonce. A `nonce` without `corrects` throws `GaslessValidationError` `invalid_request` with
the field `nonce`, before any RPC call: a later version of a payment is prepared with `corrects`, and
a new payment takes the sender's on-chain nonce. The reason: the SDK cannot tell an earlier version's
nonce passed alone from a new payment, so none of the rules above would apply. Such a version could
get an earlier deadline than the version before it (the default is now + 600 s), and `expired` of it
would then say nothing about that earlier version, which may still execute: a wallet that started a
new payment on that answer could make the user pay twice.

The core `createTransferIntent` also takes a `nonce` without `corrects`, allowing a client to supply
a payment's first nonce. The rules hold only if the client passes `corrects` (the payment's latest
version) for every later version, never its nonce alone, and reads `nonces(from)` before requesting a
correction signature (see [ethers v5 and browser bundle](#ethers-v5-and-browser-bundle)).

A correction is safe even if a relay kept an earlier version, because they share the nonce: whichever
executes first uses it, and the signature of every other version is then for a used nonce.

A correction sent to a second relay (after a key rotation, or because the first relay does not
execute) can still lose to the version the first relay holds. If that version executes after the
second relay accepted the correction, or so shortly before that the second relay's reads did not show
it yet, the correction fails that relay's check before the broadcast, with nothing of it sent: it ends
`failed` with `nonce_used`, or with `invalid_token_authorization` when its permit or meta-tx approval
was signed for the token nonce that the executed version used up. The relay counts either as a
failure the sender caused and may limit that sender's requests for a while (`rate_limited`, 429,
retryable). `waitForTransferOutcome` with the correction (the latest version) reports
`other_version_executed`, with the version that executed: the payment went through once, and the
wallet signs nothing more for it.

### What to do

| What happened | What it means | What to do |
|---|---|---|
| `submitTransfer` resolved (202 or 200) | The relay stored the request. | `waitForRequest(signed.id)`. |
| `submitTransfer` threw `RelayClientError` `timeout`, `network_error`, `http_error`, `invalid_response` or `aborted`, or `RelayApiError` `internal_error` | Unknown whether the relay stored the request. | Post the same body again with `submitTransfer(body, { repost: true })`, until the relay answers. It answers an identical body it stored with 200 and the current state, also after the deadline, so this cannot create a second request; `repost` skips the client-side deadline window for this reason. |
| `RelayApiError` `rate_limited` or `unavailable` | This post was not taken. | Post the same body again later (with `repost: true` if an earlier post of it got no clear answer). |
| `RelayApiError` `sender_busy` or `nonce_too_high` | Not stored: the relay cannot take this sender's request yet (see [Token authorization modes](#token-authorization-modes)), or the body's nonce is above `nonces(from)`. | Wait until the sender's pending request is mined, and read `nonces(from)`. Equal to the body's nonce: post the body again (a `permit` or `metaTxApprove` body whose token nonce the other request used up: prepare a correction, `corrects`, which reads the new token nonce, and sign it). Above it: sign nothing new, run `waitForTransferOutcome` with the latest version. Still below it (the body's nonce came from a node ahead of the chain, or a reorg removed an inclusion): the body can execute only after the nonces below it are used; sign nothing new, run `waitForTransferOutcome` with the latest version, which reports `expired` once the deadline passed. |
| `GaslessValidationError` or `RelayPinMismatchError` from `submitTransfer`, thrown before sending | This call sent nothing. That does not mean that the relay stored nothing: an earlier post of the same body may be stored. | If an earlier post of this body got no clear answer (you are re-posting it), treat the request as possibly stored: run `waitForTransferOutcome` with the latest version before signing anything else for the payment. This includes a key rotation, when the URL now serves another relay: the relay the body was signed for may hold it. Otherwise the body was never sent: fix the cause and prepare a correction. |
| `RelayApiError` `wrong_relay` for a re-post | The URL now serves another relay (a key rotation); the relay that got the first post may hold it. | As in the row above: `waitForTransferOutcome` with the latest version before signing anything else for the payment. |
| Any other `RelayApiError` except `conflict` and `nonce_used` | The relay refused this version and says that it did not store it. | Fix the cause (for `insufficient_allowance` see [Token authorization modes](#token-authorization-modes)) and prepare a correction ([Corrections](#corrections)). |
| `RelayApiError` `conflict` or `nonce_used` | Another request of the sender at this nonce is stored by this relay (a version of the payment, or another payment that got the same nonce), or the nonce was used on-chain. | Sign nothing new. Run `waitForTransferOutcome` with the latest version and `versions`. |
| `waitForRequest` threw `timeout` | Still pending. | Keep waiting (`waitForRequest`, or `waitForTransferOutcome` with the payment's latest version). |
| `waitForRequest` threw `RelayRequestFailedError` | The relay reports `failed` / `expired`; `final` is only a hint. | Show `relayCode` to the user. Before offering to try again, run `waitForTransferOutcome` with the payment's latest version (not only the request that failed). |
| `waitForRequest` threw `RelayApiError` `not_found` | Unknown. The relay behind the URL does not know the id: after a key rotation (a new database), after the retention period deleted a settled request, or while a first post is still on its way. | Run `waitForTransferOutcome` with the latest version before any new signature. |
| `waitForTransferOutcome` returned `executed` or `other_version_executed` | The payment went through, once, also if the relay said otherwise. With `other_version_executed` another version executed: show `outcome.executedTransfer`. | Done. Never sign again for this payment. |
| `waitForTransferOutcome` returned `expired`, `nonce_consumed` or `other_payment_executed` | No version of the payment can execute any more (this is its latest version). With `other_payment_executed` another payment of the sender used the nonce (`outcome.executedTransfer`); this one did not execute. | A new payment is safe; it takes `nonces(from)` again (`minNonce`, rule 1). |
| `waitForTransferOutcome` threw `timeout` | Not final yet. | Keep waiting. Sign nothing new. |

Waiting for `expired` lasts until a finalized block is past the latest version's deadline;
`prepareTransfer`'s default deadline is now + 600 s. A user with POL can end a payment earlier by
calling `invalidateNonces(nonce + 1)` on the contract (it moves `nonces(from)` from the current nonce to
the given one; at most 2^32 − 1 further): then no version can execute (`nonce_consumed`).

```ts
import { waitForTransferOutcome } from '@nimiq/gasless-sdk/viem';

// `latest` is the payment's latest signed version and `versions` every version signed for it (TransferVersions).
// Reads the finalized block; the relay only says when to look.
const outcome = await waitForTransferOutcome(publicClient, pins, { ...latest, versions }, { relay });
if (outcome.status === 'executed' || outcome.status === 'other_version_executed') {
    // The payment went through (outcome.txHash, outcome.executedTransfer). Never sign again for it.
} else {
    // 'expired', 'nonce_consumed' or 'other_payment_executed': no version can execute. A new payment is safe.
}
```

A correction, for example after `fee_too_low`: a new quote, the same intent nonce, a deadline no
earlier than the latest version's.

```ts
import { prepareTransfer } from '@nimiq/gasless-sdk/viem';

const quote = await relay.fee({ token: latest.request.token, authMode: 'permit', maxAcceptableFee });
const corrected = await prepareTransfer(publicClient, pins, {
    token: latest.request.token,
    from: latest.request.from,
    to: latest.request.to,
    amount: BigInt(latest.request.amount),
    fee: quote.fee,
    maxAcceptableFee,
    relay: quote.relay,
    corrects: latest.request,
});
// Show the new fee and sign. Record `corrected` as the payment's latest version as soon as it is signed, before
// you submit it ({ request, authHash } of its SignedTransfer); from then on every outcome check of the payment
// takes it.
```

## Core reference

| Function | Purpose |
|---|---|
| `buildTransferTypedData`, `buildPermitTypedData`, `buildMetaTxApproveTypedData`, `encodeApproveCalldata` | EIP-712 builders (`{domain, types, primaryType, message}`) and approval calldata encoding |
| `definePins`, `pinsFromDeployment`, `findPinnedToken` | Pins |
| `validateTransferRequest(req, pins, now, { maxAcceptableFee? })` / `assertValidTransferRequest` | `{ok: true}` or `{ok: false, code, field, message}` / throws `GaslessValidationError` |
| `createTransferIntent(pins, params, now, { maxAcceptableFee?, allowMetaTxApprove? })`, `tokenAuthSigningPayload(pins, intent, now, { maxAcceptableFee? })`, `transferSigningPayload(pins, intent, authorization, now, { maxAcceptableFee? })`, `buildTokenAuthTypedData` | Build what the user signs from validated fields, the token authorization first and the intent over it second (options: [ethers v5](#ethers-v5-and-browser-bundle)); `params.nonce` is the sender's `nonces(from)` for a new payment, `params.corrects` prepares a correction ([Corrections](#corrections)) |
| `checkCorrection(corrected, request)` | The correction rules on their own (`correction_mismatch`) |
| `checkSignedAuthorization(authMode, authorization)` | A signed token authorization of the intent's mode, in the form the relay submits |
| `checkAcceptableFee(fee, maxAcceptableFee, field)`, `parseMaxAcceptableFee(value)` | The fee ceiling behind `maxAcceptableFee` (`fee_above_limit`) |
| `buildSubmitTransferBody`, `normalizeTransferRequest`, `validateSubmitTransferBody(body, pins, now, { repost? })` | POST /v1/transfer bodies in canonical wire form (checksummed addresses, a signature with v 27 or 28, the nonce as a decimal string; it is not a field of the contract's `TransferRequest`, which takes `nonces(from)`); `repost` skips the deadline window (a re-post) |
| `splitSignature`, `normalizeSignature`, `toTokenAuthorization`, `normalizeTokenAuthorization`, `NO_TOKEN_AUTHORIZATION` | 65-byte signatures, v normalized to 27/28, high-s and malformed input rejected; the signed `{ mode, v, r, s }` (zeros for `none`) |
| `maxSendable(balance, fee)` | Maximum transferable amount after the fee: `balance - fee`, or 0 |
| `recipientDenylist`, `isDeniedRecipient` | Recipient restrictions derived from the pins and built-in Polygon denylist |
| `transferDigest(chainId, contract, request, authorization)`, `tokenAuthHash(authorization)`, `transferDigestFromAuthHash(chainId, contract, request, authHash)` | The intent digest (the contract's `hashTransfer(r, nonce, auth)` and the relay request id), and the same from a `TransferVersion` |
| `typedDataDigest`, `hashDomain`, `toChecksumAddress`, `isAddress` | Zero-dependency keccak-256, EIP-712 (nested structs) and EIP-55 |

`now` is always unix time in seconds; values of 2^32 or more (milliseconds) throw a `TypeError`.

### Validation codes

`validateTransferRequest` reports the first failing check, in the order of the relay pipeline, so the
SDK and the relay use the same code for the same request.

| Code | Meaning |
|---|---|
| `invalid_request` | Malformed field (address, EIP-55 checksum, non-canonical integer, nonce, unknown field, token authorization); `prepareTransfer`: a `nonce` without `corrects`; `createTransferIntent`: neither `nonce` nor `corrects` (field `nonce`, [Corrections](#corrections)) |
| `wrong_chain`, `wrong_contract` | Not the pinned chain or GaslessTransfer contract |
| `wrong_relay`, `unsupported_token`, `unsupported_auth_mode` | Not pinned |
| `invalid_sender` | `from` is the zero address |
| `invalid_amount` | `amount` is 0, or `amount + fee` overflows uint256 |
| `invalid_recipient` | `to` is on the denylist |
| `deadline_out_of_range` | Not within now + 60 s … now + 7200 s |
| `fee_above_limit` | The fee (or quote) exceeds the caller's `maxAcceptableFee` (`RelayClient.fee()`, `prepareTransfer`, `signPrepared`, `createTransferIntent`, `tokenAuthSigningPayload`, `transferSigningPayload`, `validateTransferRequest`) |
| `meta_tx_approve_not_allowed` | `createTransferIntent`: mode `metaTxApprove` for a token that supports permit, without `allowMetaTxApprove` (security rule 4); `signPrepared`: mode `metaTxApprove` with `allowMetaTxApprove: false` |
| `auth_missing`, `auth_unexpected` | Token authorization missing for permit / meta-tx, or present for `none` (a signed `none` authorization must be v 0, r and s zero) |
| `auth_type_mismatch` | Not exactly the `Permit` / `MetaTransaction` type, not `approve(address,uint256)` calldata, or a signed authorization of another mode than the intent's |
| `auth_domain_mismatch` | Not the pinned token domain (e.g. USDT0 with a chainId domain instead of its salt domain) |
| `auth_owner_mismatch`, `auth_spender_mismatch`, `auth_value_mismatch`, `auth_deadline_mismatch` | Owner ≠ from, spender ≠ contract, value ≠ amount + fee, permit deadline ≠ intent deadline |
| `invalid_signature` | Not 65 bytes, v not in {0, 1, 27, 28} (a signed token authorization: not 27 or 28), r or s out of range, or high-s |
| `correction_mismatch` | A correction (`corrects`) changes `from`, the intent nonce, `token` or `to`, or moves the deadline earlier ([Corrections](#corrections)) |
| `nonce_used` | `prepareTransfer` with `corrects`: the payment's intent nonce is already used on-chain, `nonces(from)` is above it (the relay's code for the same state); run `waitForTransferOutcome` with the latest version. With `minNonce` (field `minNonce`): the RPC node reports a `nonces(from)` below it, a nonce the previous payment used; read again from an up-to-date node |
| `signer_mismatch`, `sender_is_contract`, `eip7702_permit_unsupported` | viem adapter checks of the signer and the sender account (`eip7702_permit_unsupported`: a USDC permit from an EIP-7702 account without `allowEip7702Permit`, security rule 7) |

## Development

See [Development](../docs/DEVELOPMENT.md) for Docker and native Linux setup. From the repository root:

```bash
docker compose run --build --rm node-test 'cd sdk && pnpm typecheck && pnpm test'
make test-node   # typecheck, unit and integration tests of the SDK and the relay
```

The SDK suites cover validation, signer compatibility with viem and ethers v5/v6, relay response
handling, the browser bundle, and on-chain behavior using Anvil. Integration tests exercise the SDK
with the production contract and relay, including allowance selection, corrections, relay key
rotation, reorgs, the state search under a flood of zero-amount `Transfer` logs and under hundreds of
reverted copies of the relay's call, reverted calls and calls of other contracts on every path of the
check, the bounded log search and its progress from poll to poll. These tests check that multiple
signed versions of one payment cannot cause duplicate payment, that a nonce reused after an expired
payment is not mistaken for it, that two payments that got the same nonce are told apart, and that
uncertain outcomes do not authorize a new payment.

The TypeScript API examples in [test/examples.ts](test/examples.ts) are compiled by `pnpm typecheck`.
[Golden vectors](../contracts/test/vectors/README.md) compare typed-data hashes and signatures against the contract.
