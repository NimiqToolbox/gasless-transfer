# Transaction lifecycle

The transaction manager processes accepted requests, maintains the relay account's transaction nonces and reconciles receipts until settlement. Configuration defaults and ranges are in the [relay reference](../README.md#transaction-manager); database guarantees are in [Storage](storage.md).

## States

| Status | Meaning | Can it still change? | Secrets stored? |
|---|---|---|---|
| `queued` | Accepted, no transaction yet. | yes | yes |
| `submitted` | A transaction at the request's tx nonce is in flight. | yes | yes |
| `mined` | Its call was included and succeeded: its successful receipt shows it, answered for the call's hash or, where no RPC answers that, in the receipts of the block that used the request's intent nonce on every RPC (see [Nonces](#nonces)). An inclusion without a receipt is never `mined`. | yes, until settled (reorg) | yes, until settled |
| `confirmed` | `mined`, and the block is final. | no | no |
| `failed` | It can no longer succeed: it failed a check before broadcast, reverted on-chain, was cancelled, or its intent nonce was used otherwise (its sender invalidated it, or another version of the payment executed). `error.code` says why. | only if decided on-chain and not yet settled | only until settled |
| `expired` | The deadline came before inclusion: it was never sent, it was cancelled, or its intent nonce was used only after the deadline while another transaction took its tx nonce (see [Nonces](#nonces)). `error.code` is `deadline_out_of_range`. | same as `failed` | same as `failed` |

**Settled.** An outcome decided on-chain (a mined call, a reverted call, a mined cancel, or another transaction that took the request's tx nonce) is provisional until its block is final. A block is final when:

- It is at or below `min(finalized tag, head − RELAY_MIN_FINALITY_DEPTH)`. Without the `finalized` tag (or when reading it fails), `head − max(RELAY_FINALITY_FALLBACK_DEPTH, RELAY_MIN_FINALITY_DEPTH)` applies. On Polygon PoS (137) and Amoy (80002) both depths are at least 16: the relay refuses to start with less, and the transaction manager never applies less there, whatever it is given.
- It is still the canonical block at its height (`eth_getBlockByNumber` hash = receipt block hash).
- With several RPCs, every configured RPC shows the same, each by its own head, `finalized` tag and canonical block (see "Several RPCs" below).

For a failed or expired outcome decided by a foreign transaction, settlement additionally checks the request's intent nonce on every provider. If it is now used, that provider must show positive evidence of what used it in the block that used it (located from its own state, see [Nonces](#nonces)), final by its own `finalized` tag and head: the sender's `NonceInvalidated` covering the nonce, a successful call of another request of the sender at the nonce, or a block after the request's deadline. Each provider then settles on its own observation, as above. Every provider showing the successful receipt of the same call of the relay there turns the outcome into `mined`. A provider that shows such a call, a provider that cannot tell, a nonfinal block, a receipt of any of the request's transactions or a missing answer holds settlement and preserves secrets. A `mined` outcome settles the same way on a provider that does not answer the receipt of its call for its hash: the call's successful receipt in the receipts of the block that used the intent nonce, final by its own view; a provider that shows another call there holds it back. If every provider shows the same other call of the relay key executing the request there (a reorg put a speed-up in place of the stored call), the request is `mined` by that call (its `txHash`), and settles by it.

At that point the request settles: `mined` becomes `confirmed`, while `failed` and `expired` keep their status. `settled_at` is set, and the intent signature, the token authorization and the raw transactions are purged (see [Storage](storage.md)). An outcome decided without anything on-chain is final and purged at once, for example a failed simulation before the first broadcast or an expiry in the queue.

The API does not expose a separate settlement flag. A `failed` or `expired` request can, rarely, turn into `mined` if a reorg happens within the finality window. A wallet that needs certainty should check on-chain (`waitForTransferOutcome` in the SDK, or `confirmOnChain` with `blockTag: 'finalized'`), or wait for `confirmed`.

## Processing and scheduling

Only one pass runs at a time. The next pass starts `RELAY_POLL_INTERVAL_MS` after the previous one ended, or sooner when a new request is queued: a newly queued request starts the next pass at once, but no sooner than 500 ms after the previous pass ended (and never later than the poll would). A request queued during a pass that has not yet listed the queue is handled by that pass. While every in-flight slot that a new request may use is taken (for a normal request, all but the reserved ones), it does not start a pass. A new request is thus broadcast without waiting for the poll, and submissions cannot make passes, and their RPC reads, run back to back: under load the passes fall back to the poll's pace. Only a submission that passed every check and limit is queued. While a relay transaction is in flight, the relay also reads the block number every 500 ms between passes through its own client; a head past the last pass's head starts the next pass, at most one per new head and no sooner than 500 ms after the previous pass. An inclusion is thus noticed within about half a second of its block. The pass decides from its own reads, as at the poll. There is no such read while nothing is in flight, more than 60 s after the relay's last new transaction (re-sends of a stored one do not count), after a failed pass, or after a failed read until the next pass. A pass that a new request or a new block started early does not count a transaction as missing from the mempool sooner than the poll would have: only once `RELAY_POLL_INTERVAL_MS` has passed since the relay broadcast it. Each pass reads the chain view, reconciles in-flight transactions and provisional outcomes, handles deadlines and replacements, maintains the nonce range, broadcasts eligible requests and applies retention.

- A successful call receipt takes precedence over a cancellation or reverted attempt. Every stored attempt of the request remains relevant, including attempts at an earlier transaction nonce.
- At most 32 provisional outcomes are checked per pass, least recently checked first. Larger backlogs are reported as degraded; each request remains eligible for later checks.
- New work is ordered by priority, then in rounds across senders, oldest request per sender first (one pending request per sender; requests a reorg put back in flight can add a second). Within a round, senders with fewer in-flight requests come first. At most `RELAY_MAX_IN_FLIGHT` slots are occupied, with `RELAY_RESERVED_PRIORITY_SLOTS` reserved for higher-priority operations.
- Full queued-request checks are limited to `2 × RELAY_MAX_IN_FLIGHT` per pass, shared between broadcasts, checks before cancelling held work and background classification. A large backlog of invalid requests can therefore require several passes.
- Every queued request receives a cheap spend-cap precheck. A successful estimate supplies its known gas limit; otherwise the table is the fallback. An unclassified request that might be held is not treated as sendable work.
- Unclassified requests and held requests without a successful estimate receive full checks even when no slot is free, within the same budget. A request that passes is checked again before broadcast. A sender-caused failure before broadcast starts the submitting client's cooldown.
- Before signing or ending a queued request, its stored status is checked again. A request displaced by admission while a pass was awaiting the chain is not subsequently broadcast.
- Signed transactions and nonces are committed before broadcast. Retention runs at most once a minute.

## Several RPCs

`RELAY_RPC_URLS` provides ordered failover for ordinary reads and separate clients for decisions requiring every provider. Broadcasts go to all configured providers.

### Ordinary reads

Admission checks, simulation, gas estimation, ordinary fee inputs, the pass's initial chain view and readiness trust the first provider that responds. This provider can affect availability and can end a request that has never been broadcast by reporting expiry or a failed check. A non-broadcast outcome settles immediately.

It can also end a request in flight on its own. A queued request whose deadline is nearer than `RELAY_MIN_SECONDS_TO_BROADCAST` by the relay's clock when its call is about to be signed (a pass can last longer than that margin) is not sent in that pass. The relay cancels the call when this provider's head timestamp reaches the deadline safety margin (`expired`), when a re-simulation or the USDC permit sender's code check on it fails (`failed`), or when its base fee prices the request out at its spend cap while others wait (`fee_too_low`). No funds of the sender move: the cancel replaces the call, and the relay pays the cancel's gas. The payment fails, unless the call is included first, while its signed intent stays valid until its deadline. Such an outcome is decided on-chain and stays provisional until it settles.

Block numbers the transaction manager stores from this provider's head (the sent block of a transaction, the clocks of `stalled` and `backlog`, decision waits, the nonce gap) are re-based on a lower head later. A head it once reported too high therefore cannot hold speed-ups or health conditions back for good.

Each provider is tried twice for ordinary reads. A first provider that accepts connections but does not answer, or that starts an answer and does not finish it, can add about `2 × RELAY_RPC_TIMEOUT_MS` before failover on each read. Put the most reliable provider first and investigate its health when validation times out or readiness reports stale passes. Use the internal readiness report to identify the failing check.

### Decisions requiring every provider

Every configured provider must support the decision in the same pass, using its own head, finality and canonical evidence. The failover client is not an additional vote.

| Decision | Every RPC must show |
|---|---|
| A request gets a new tx nonce (a second call) | The tx nonce used, no receipt of any of the request's transactions, the request's intent nonce unused, and its own observation block (its head when it first showed this) final by its own `finalized` tag and head. |
| A request is `mined` although no RPC answers the receipt of its call for its hash | The tx nonce used, the intent nonce used, and in the block that used it (located from its own state) the successful receipt of the same call of the relay executing this request; see "Nonces". A call listed there without a receipt decides nothing. |
| A request fails because its intent nonce was used without its call (`nonce_used`) | The tx nonce used, no receipt of any of the request's transactions, the intent nonce used, and in the block that used it (located from its own state) positive evidence of the same kind: a `NonceInvalidated(signer, previousNonce, newNonce)` covering the nonce (the sender invalidated it), or a successful call of another request of the sender at the nonce (another version of the payment, or another payment); see "Nonces". The same with that block after the request's deadline: `expired`. |
| An outcome settles (the secrets are purged) | Decided by a receipt: the deciding receipt with the same block and status, its block canonical at its height and final by that RPC's own `finalized` tag and head; for `mined` on an RPC that does not answer the call's receipt for its hash, the call's successful receipt in the receipts of the block that used the intent nonce, final by its own view. Decided by another transaction that took the tx nonce: no receipt of any of the request's transactions, the tx nonce used, its own observation block final by its own view and, for a used intent nonce, the evidence of the use in a block final by its own view. A request that ended in the queue after a requeue needs no new observation: its requeue already waited for every RPC's. For `failed` and `expired` in both cases: no successful call among the request's transactions. |
| A `mined` outcome is undone (back in flight, back in the queue, or re-resolved as `failed`/`expired`) | Its head made after the moment the relay recorded the outcome (see below), no successful call among the request's transactions, the intent nonce unused, and the state the undo is based on: the other transaction's receipt that now decides, or no receipt at all and the relay's tx nonce unused again (a reorg) or used by another transaction. A request that had ended in the queue after a requeue and was found `mined` by the block that used its intent nonce has no tx nonce: it needs no receipt and the intent nonce unused, and goes back to the queue, where it is sent with a new tx nonce or ends at its deadline. |
| The stored next nonce is raised from chain state (pending transactions of the key that the relay does not track, at startup and before a broadcast) | Its `pending` count. The next nonce is raised only to the lowest of them; a single RPC's answer is never stored. |
| The stored next nonce is lowered (nonces at the top re-used) | Its `latest` and `pending` counts. Only nonces above the highest of them are re-used. |
| A nonce gap is filled | Its `latest` count. Fillers are signed only for nonces at or above the highest `latest` count, at most `RELAY_MAX_IN_FLIGHT` of them per pass. |
| A POL/USD reading is taken | A reading that passes the §6.4 checks; all readings within 10 % of each other. The relay then uses the highest (the lower spend cap and the higher break-even). |

For foreign-transaction settlement, the intent-nonce check in [States](#states) also applies. A provider's earlier answer on the use of an intent nonce is re-used only while that provider still shows the same block hash at its height and the same evidence in it (the invalidation's log, the call's successful receipt in that block, or the block's timestamp after the deadline); otherwise it is located again.

An error, missing response or insufficient evidence postpones the decision. A provider that fails a read is treated as unavailable for the remainder of the pass. No new agreement-related read starts more than 20 seconds after the pass began; an already-started read remains subject to `RELAY_RPC_TIMEOUT_MS`. Ordinary failover reads and cached price reads have their own deadlines.

Each provider records its own observation block. A previously reported block above its current head is rebased only when that head's timestamp is later than the observation. One provider's block height does not set another provider's finality threshold. Contradictory evidence from any provider prevents the proposed decision.

Undoing a mined outcome requires heads with timestamps later than the relay's recorded outcome time; a head from the same second is insufficient. Keep the host clock synchronized. A chain whose timestamps lag behind the host clock may delay an undo until sufficiently recent heads are available.

A prolonged decision wait logs an alert after `RELAY_STUCK_AFTER_BLOCKS` and increments `relay_decision_waits_total`. An unavailable provider can hold settlement, requeue or nonce maintenance until it returns or the operator changes configuration and restarts. Preserve the database during that intervention.

POL/USD readings require usable responses from every provider within 10% of each other; the highest reading is used. If any provider is unavailable, disagrees, or returns an invalid reading, the refresh fails and the price cache is cleared. No static or previous price is substituted. See [Fees](../README.md#fees).

## Nonces

The relay distinguishes the sender's signed intent nonce from its own Ethereum transaction nonce. It does not abandon a transaction nonce merely because a node returns `nonce too low`.

GaslessTransfer keeps one intent nonce per sender (`nonces(from)`): a request executes only at that nonce and raises it by one, and `invalidateNonces(newNonce)` raises it past unused nonces. The relay accepts only a request at the sender's next nonce (step 4) and one pending request per sender, so a used intent nonce means that this request executed, the sender invalidated it, or another request at that nonce executed: another version of the payment (signed again, for example for another relay), or another payment that the sender signed at the same nonce.

- If the transaction nonce is still unused, the stored attempt stays at that nonce and is rebroadcast after checks. Provisional outcomes reserve their transaction nonces because a reorg may put them back in flight.
- If the transaction nonce is used but no stored attempt has a receipt, the relay waits `RELAY_UNKNOWN_NONCE_GRACE_BLOCKS`, then asks every provider for evidence, at most once per `RELAY_UNKNOWN_NONCE_GRACE_BLOCKS`. Any receipt, unused transaction nonce, disagreement or missing response delays resolution.
- If every provider shows the intent nonce unused and its observation final, the request can be requeued at a new transaction nonce. Earlier attempts remain recorded. An already-decided cancellation instead retains its intended failure/expiry outcome pending settlement.
- If every provider shows the intent nonce used, each locates the block that used it from its own state and shows what in that block did (below). The successful receipt of the same transaction of the relay executing this request there, on every provider, makes the request `mined` (event `mined_by_nonce_search`); gas and fee come from that receipt. Positive evidence of another use, the same kind on every provider, makes it provisional `failed/nonce_used`: a `NonceInvalidated(signer, previousNonce, newNonce)` with `previousNonce ≤ nonce < newNonce` (invalidated), or a successful call of another request of the sender at the nonce (another version of the payment, or another payment). That block after the request's deadline makes it provisional `expired` (the contract refuses the request there). An already-decided cancellation keeps its outcome. Anything else waits, with an ALERT after `RELAY_STUCK_AFTER_BLOCKS` (`receipt` when a provider shows the relay's call there, with or without its receipt, else `nonce_evidence`): a provider that cannot tell, disagreement or a missing answer. No missing receipt or log fails a request, and none makes it `mined`.
- Requests awaiting an unknown-nonce decision hold no in-flight slot, but their pending sender debit remains reserved.

`nonces(from)` only rises, so the block that used the nonce is the first block whose state has it above the nonce. A provider reads it at its head, then 1, 2, 4, … blocks lower until the nonce is unused there, then bisects: at most 2·⌊log2(d + 1)⌋ + 2 `eth_call`s for a block d blocks below its head, never below the deployment file's `deployBlock`. That block is the one the deploy script saw before its broadcast; from there to the contract's creation `eth_call` answers no data, which counts as nonce 0. A JSON-RPC error answer to one of these reads means that the provider has no state of that block; a timeout, rate limit, HTTP error or lost connection means that it does not answer (it is then unavailable for the rest of the pass). In that block it reads the block's transactions, the block's receipts with one `eth_getBlockReceipts` (only receipts that name that block's hash count), and one `eth_getLogs` of that block for the sender's `NonceInvalidated` (filtered by event and indexed signer; the range is compared in event data). Of the transactions only the direct calls of `relayTransfer` that execute a request of the sender at the nonce (recovered from the call's signature at that nonce, low-s only) sent by the relay that request names (the contract requires `msg.sender == relay`; nobody else can add such a call) count. A reverted call did not use the nonce and is skipped before its signature is recovered. From a provider that refuses `eth_getBlockReceipts` (a JSON-RPC or HTTP error answer), these calls' receipts are read one by one, at most 16 per search: past that the provider cannot tell. Only a call's successful receipt in that block is its execution; a call listed without a receipt shows nothing. A provider cannot tell when it serves no state of the older block, does not serve those receipts, shows a receipt in another block, or shows nothing in the block that used the nonce. A `relayTransfer` called through code (a contract, or an EOA with an EIP-7702 delegation that sends the transaction to itself) shows nothing: when such a call executed another version of the payment before the relay's call, the relay's reverted call never makes the request `mined`, and the request waits with the ALERT.

No log range is searched. The reads are bounded whatever head, timestamps or logs a provider reports, and logs that other accounts can emit (token `Transfer` logs, other signers' `NonceInvalidated`) match no filter the relay sends. Only the relays named in requests of the sender at the nonce can add such calls: another such relay can put hundreds of reverted copies of its call before the executing one. With `eth_getBlockReceipts` they cost nothing more (one read of the block's receipts, and no signature recovery for a reverted call: 511 copies are decided within one pass); from a provider that refuses the method, 16 copies make it unable to tell, and the decision waits, as it does for a call through code. Read-budget exhaustion postpones a search. Settlement re-uses a provider's answer while it still shows it (see "Several RPCs"); after a restart the block is located again.

The providers must serve the state of older blocks: from their head down to about as far below the block that used the nonce as that block is below the head. The relay checks this at startup and every `RELAY_RPC_HISTORY_CHECK_SECONDS` (see [RPC configuration](#rpc-configuration)).

### Startup and gaps

A new database starts from the lowest pending transaction count reported by all providers; a missing response prevents initial recovery. An existing next nonce is raised only as far as every provider's pending count supports. Recovery resends stored in-flight requests.

Unused nonces above all in-flight and provisional work can be reclaimed only above every provider's latest and pending counts. If unused nonces below the lowest in-flight request persist for `RELAY_NONCE_GAP_BLOCKS`, the relay fills them with zero-value self-transfers. Fillers begin at or above the highest latest count reported by the providers, require all providers to respond and are limited to `RELAY_MAX_IN_FLIGHT` per pass.

Fillers are held in memory and can be reconstructed after restart. They are sped up like cancellations. Do not send unrelated transactions from the relay key; another process or wallet can consume its nonces and force reconciliation.

## Checks before a call leaves the relay

These run before the first broadcast, before every speed-up and before every re-broadcast of a call. There is no exception: a call the relay decided to cancel is never sent again.

1. **Simulation pinned to the head block.** `eth_call` and `eth_estimateGas` run with the head block number, not `latest`. A node that does not have that block answers with an error instead of older state; the pass then stops and retries. `nonces(from)` reads that decide a request's fate are pinned the same way.
2. **A revert on an old head is not trusted at once.** Suppose the simulation reverts on a head whose timestamp is older than the request's acceptance, for example a read node that lags behind the node the acceptance used. The request then stays queued or in flight. It fails only when the revert is seen on a head at least as new as the acceptance, or still two blocks later. The first rule compares block timestamps with the relay's clock (keep it synchronized). On a chain whose timestamps are far behind that clock, for example a fork of mainnet, only the second rule applies: such a failure is decided two blocks later.
3. **USDC permits: the sender must still have no code.** USDC verifies permits of accounts with code through ERC-1271, for example an EIP-7702 delegation made after acceptance. A delegate could then burn the relay's gas. Such a request fails with `invalid_token_authorization`: before the broadcast it costs nothing, and in flight it is cancelled.
4. **Failure attribution.** When a check fails or a call reverts on-chain, the relay reports the cause rather than the contract error it surfaces as.
   - The contract verifies the signature over the sender's current nonce first, so a request whose nonce was used surfaces as `InvalidSignature`. The relay then reads `nonces(from)` at the head: above the request's nonce, it fails with `nonce_used`; below it (a reorg removed an earlier request of the sender), it waits. A reverted receipt carries no revert data: a used intent nonce is reported as `nonce_used` there too.
   - It re-runs the operation's token-state checks for this request alone. A pause is reported as `token_paused`, and a block list or blacklist entry as `blocked_address`.
   - For a PERMIT or META_TX_APPROVE request it compares the token's `DOMAIN_SEPARATOR()` with the configured domain (a rename), and checks the token signature against the token's current nonce and the sender's code, as step 7 of the pipeline does. A signature that no longer matches, for example because the sender used the token nonce elsewhere after acceptance, is reported as `invalid_token_authorization` instead of the `insufficient_allowance` the failed permit surfaces as.
   - Otherwise the decoded contract error applies (`nonce_used`, `insufficient_allowance`, …, else `simulation_failed`).

## Gas limit and spend cap

```text
gasLimit = min(estimate × (1 + RELAY_GAS_LIMIT_MARGIN_PERCENT / 100),
               gasTableEntry, RELAY_MAX_GAS_LIMIT)
spendCapPerGas = feeInWei × RELAY_MAX_COST_PERCENT_OF_FEE / 100 / gasLimit
feeInWei = fee × 10^(12 + priceDecimals) / price
```

Without an estimate, the gas limit uses the lower of the table entry and global cap. Only successful estimates are remembered for later spend-cap prechecks. An estimate above the cap fails before broadcast with `simulation_failed`.

At signing, `gasLimit × maxFeePerGas` must fit the spend cap at the current POL/USD price. If the capped fee cannot cover base fee plus `RELAY_MIN_TIP_GWEI`, the request is held. It can proceed when prices fall, expire at its deadline or give way under the rules below.

Speed-ups increase both fee fields by `RELAY_SPEEDUP_PERCENT` (at least 10%), also considering current market fees, within the per-call and global caps. If a valid replacement cannot fit, the stored call is resent unchanged and checked again after `RELAY_SPEEDUP_AFTER_BLOCKS`. An unchanged signed transaction retains the price assumptions from signing; a later POL/USD increase changes its token-denominated exposure.

Only the transaction at the next nonce the chain can include (the relay account's `latest` transaction count) is sped up: calls, cancels and nonce fillers alike. A transaction behind a lower nonce that is not included cannot be included first at any fee, so raising it would only consume the gas budget. It keeps its fees and is resent unchanged only if the node lost it. A call there is still re-simulated every `RELAY_SPEEDUP_AFTER_BLOCKS` and cancelled if it can no longer succeed, and it counts as held at its spend cap when its cap would hold it once its nonce is next. Once its nonce is next and it is still not included, it is due for one normal speed-up at once. Replacing a call by a decided cancel does not wait for its nonce to be next.

### Queue displacement and cancellation

In a full queue, an eligible never-broadcast held request with no higher priority can give way to a fully validated new request. Lowest spend cap, then oldest insertion, selects it. Displacement and insertion are atomic. The displaced request becomes `failed/fee_too_low`, but its history and signed intent nonce remain associated with it.

One sender (`request.from`) may have only one queued request that displaced held work, and none while cooling down. It can displace another only after the prior request is broadcast or leaves the queue. This accounting is in memory and resets at restart. The relay does not tell clients apart by network address, so a party with many funded senders can displace one held request per sender.

An in-flight request is held at its spend cap when its next replacement would be above the cap and its current transaction pays less than the includable fee (base fee + `RELAY_MIN_TIP_GWEI`). A request at its cap whose transaction already pays that fee is kept out of the blocks by something else (an account without POL, RPCs that refuse the broadcast): it is not held, counts for `stalled`, and is never cancelled as `fee_too_low`. An in-flight held request may be cancelled to unblock work that can actually proceed: a higher-nonce call able to pay the includable fee, a higher-nonce cancel (exempt from the spend cap, so payable whenever `RELAY_MAX_FEE_PER_GAS_GWEI` covers the includable fee), or a queued request that passes a current full check and fits its cap. An unknown estimate, failed check, exhausted check budget or RPC error does not justify cancelling for queued work.

Once cancellation is selected, the relay does not resend the call. It signs a zero-value self-transfer at the same nonce. If replacement pricing exceeds the global fee cap while a node still holds the call, it waits and retries. If the call has disappeared from the mempool, cancellation can use market fees. Whichever transaction is included determines the outcome; the original call may still win.

Queued requests expire within `RELAY_MIN_SECONDS_TO_BROADCAST` of the deadline; in-flight requests are cancelled when `head.timestamp + RELAY_DEADLINE_SAFETY_SECONDS >= deadline`. These decisions use chain time.

Cancels and fillers use 21,000 gas and are exempt from the request's fee-based spend cap, but remain subject to `RELAY_MAX_FEE_PER_GAS_GWEI`. At the default 3,000 gwei ceiling, one such transaction can cost up to 0.063 POL. These controls are not an aggregate campaign budget.

## State changes after broadcast

A sender can move funds, change allowances, consume a token nonce or invalidate the intent before inclusion. The call can then revert while the relay pays gas and receives no token fee. Monitor `relay_requests_reverted_onchain_total`, `relay_reverted_call_gas_pol_total` and total cost versus revenue.

A relay status or queue displacement does not revoke a signed intent. Clients must reconcile finalized payment evidence before signing a new payment. Corrections of one payment retain its intent nonce; the sender can end an unused one with `invalidateNonces`.

## Success

GaslessTransfer emits no event for a transfer. `relayTransfer` reverts on every failed check, so a successful receipt of one of the relay's own call transactions for the request is its execution: the request is `mined` and its fee counts as revenue. When no provider answers that receipt for its hash, the call's successful receipt in the receipts of the block that used the intent nonce, on every provider, is the execution (see [Nonces](#nonces)); an inclusion without a receipt never is. A successful receipt of another transaction is never taken as the request's success.

## Retention

Settled requests and their transactions are deleted after `RELAY_REQUEST_RETENTION_DAYS`. Unsettled work is retained. Deleted IDs return 404; reposting an old intent still faces its deadline and on-chain nonce checks. See [Storage](storage.md#retention-and-capacity).

## Health

`TxManager.health()` returns `{ ok, reasons, degraded }` synchronously for readiness probes. Every entry reads `code: explanation`. `reasons` make the relay unready (`ok` is false when there is any); `degraded` lists conditions worth an alert while the relay keeps working and stays ready. `insufficient_funds` and `gas_budget` are those of the last pass, not of one under way.

While there is a reason, new submissions answer 503 `unavailable` and nothing is stored (see [Admission and validation](../README.md#admission-and-validation)); before the first pass they are accepted, and that pass sends them.

| Code | List | When |
|---|---|---|
| `not_recovered` | reasons | Startup recovery has not run. |
| `no_pass` | reasons | No pass has completed yet. |
| `pass_stale` | reasons | The last successful pass is older than `max(60 s, 10 × RELAY_POLL_INTERVAL_MS)`, measured on the monotonic clock: a step of the system clock does not change it. |
| `head_stale` | reasons | The head block of the last pass is more than 60 seconds behind the relay's clock: the first RPC in `RELAY_RPC_URLS` that answers stands still, or the chain does. No queued request is sent on that state; requests in flight are followed as before. The conditions that count blocks (`stalled`, `nonce_gap`, `backlog`) count the blocks of that head and cannot see it. |
| `insufficient_funds` | reasons | The last broadcast failed with insufficient funds. |
| `gas_budget` | reasons | The lifetime gas exposure reached `RELAY_TOTAL_GAS_BUDGET_POL`, or an increase was refused this pass (see [Durable aggregate gas budget](../README.md#durable-aggregate-gas-budget)). Operator review is required; funding the relay does not clear it. |
| `nonce_gap` | reasons | The chain's latest nonce has stayed below the lowest in-flight relay nonce for `RELAY_NONCE_GAP_BLOCKS`. |
| `finality_lag` | reasons | The `finalized` tag is more than `RELAY_MAX_FINALITY_LAG_BLOCKS` (default 600) behind head. |
| `stalled` | reasons | Requests wait to be sent (queued and not held by their spend cap, or in flight and not held at it) but no relay transaction was broadcast, sped up or included, and no queued request ended in its check before the broadcast, for `RELAY_STUCK_AFTER_BLOCKS` (default 150). The clock starts when such work appears. |
| `backlog` | degraded | The oldest queued request that can be sent has waited longer than `RELAY_STUCK_AFTER_BLOCKS`. The relay is working, but it cannot keep up. |
| `held_at_cap` | degraded | At least one request, queued or in flight, waits because gas prices are above what its fee covers (spend cap). It is sent when the price falls, cancelled when others wait behind it, or ends at its deadline. |
| `settle_backlog` | degraded | More provisional outcomes wait to settle than a pass checks (32). Each is still checked in turn; settlements take longer, and their secrets stay stored until then. Usually an RPC that does not answer, lags, or holds settlements back (see "Several RPCs"). |

`viewHead()` returns the head block number of the last completed pass. Backlog and spend-cap holds are degraded conditions; failure to make progress can make the relay unready.

## RPC configuration

Startup checks `eth_chainId` separately on every configured endpoint and refuses a wrong chain or missing response. Errors identify providers by position, not URL. Use independent providers and monitor them individually.

Every endpoint must also serve the state of older blocks (see [Nonces](#nonces)). Startup reads `nonces(0x0…0)` on each at max(`deployBlock`, its head − window) and refuses to start if one cannot, as it refuses a wrong chain:

```text
window = 2 × (7200 + RELAY_UNKNOWN_NONCE_GRACE_BLOCKS
              + max(RELAY_MAX_FINALITY_LAG_BLOCKS, RELAY_FINALITY_FALLBACK_DEPTH, RELAY_MIN_FINALITY_DEPTH)
              + RELAY_STUCK_AFTER_BLOCKS)                       15,924 blocks by default
```

7200 s is the longest request life, and a chain adds at most one block per second (block timestamps rise). A first search starts a grace period after the tx nonce was seen used, a settlement locates the block again once it is final (the finality margin), and a decision that waits longer raises the ALERT; the block that used a nonce lies at most the sum of these, d, below the head of a search, which reads down to 2·d + 1 below its head. The default window, 15,924 blocks, is about 6.6 hours at Polygon PoS's 1.5 s per block. Startup also logs which endpoints serve `eth_getBlockReceipts` (asked for that block). `RELAY_RPC_HISTORY_CHECK_SECONDS` (default 600; 0: startup only) repeats the check: an endpoint that refuses the state (an error answer, as the search takes it) makes the relay degraded (it stays ready; `checks.rpcHistory` in the internal readiness report), sets `relay_rpc_history_unavailable{rpc}` to 1 and logs an ALERT, repeated every 5 minutes while it lasts. A check an endpoint does not answer (a timeout, a rate limit, a lost connection) leaves its last answer; `RelayRpcHistoryUnavailable` fires after 15 minutes.

## Metrics

| Metric | Meaning |
|---|---|
| `relay_requests_reverted_onchain_total{operation}` | Accepted requests whose call was included and reverted: the relay paid gas and earned no fee. Alert on growth. |
| `relay_reverted_call_gas_pol_total{operation}` | Gas of those calls, in POL. |
| `relay_nonce_events_total{event}` | `nonce_too_low`, `receipt_hidden`, `mined_by_nonce_search` (every RPC shows the successful receipt of the relay's call in the block that used the intent nonce, none answers it for the call's hash), `nonce_invalidated`, `nonce_used_elsewhere` (another version of the payment used the intent nonce), `requeued`, `next_nonce_lowered`, `gap_filled`. Alert on `requeued` and `gap_filled`: something else uses the relay key, or the RPCs lose transactions. |
| `relay_nonce_gap` | 1 while unused nonces hold relay transactions back. |
| `relay_spend_cap_holds_total{kind}` | `initial`, `speedup`, `cancel`: requests held or cancelled by their spend cap (gas above what their fee covers). |
| `relay_spend_cap_held` | Requests held by their spend cap right now (queued, and in flight at their cap). |
| `relay_queue_backlog_blocks` | Blocks the oldest queued request that can be sent has waited (0: none). |
| `relay_decision_waits_total{decision}` | ALERT: a decision waited longer than `RELAY_STUCK_AFTER_BLOCKS` for every RPC to confirm or for evidence (`requeue`, `nonce_evidence`, `receipt`, `outcome`, `settle`). Check the RPCs; the ALERT log line names an RPC that does not answer. |
| `relay_unsettled_requests` | Provisional outcomes (`mined`, `failed`, `expired`) that wait to settle. Above 32 the relay reports `settle_backlog` (degraded). Alert on steady growth: an RPC holds settlements back. |
| `relay_price_unavailable_total{reason}` | Oracle rejection; `rpc_disagreement` when prices differ by more than 10 %, `rpc_error` when any provider fails to answer. |
| `relay_finality_lag_blocks` | Head minus the `finalized` tag, or -1 if the tag is unsupported. |
| `relay_rpc_history_unavailable{rpc}` | ALERT when 1: the RPC (position in `RELAY_RPC_URLS`) refused the state of older blocks in the last check it answered (see [RPC configuration](#rpc-configuration)); the relay is degraded. |
| `relay_request_rows`, `relay_requests_pruned_total` | Stored requests and deletions by retention. |

`relay_tx_broadcasts_total{kind}` also has the kinds `filler`, `filler_rebroadcast` and `filler_speedup`, and `relay_gas_cost_pol_total{kind}` has the kind `filler`.

## Configuration

The [transaction-manager settings](../README.md#transaction-manager) list defaults, ranges and validation constraints. Invalid values prevent startup. Chain-dependent tip and finality floors are checked after the deployment's chain ID is known.
