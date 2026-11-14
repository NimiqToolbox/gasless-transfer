# Security

## Reporting vulnerabilities

Use GitHub private vulnerability reporting for this repository (Security → Report a vulnerability). Do not open a public issue with exploit details.

Include the affected revision, impact and a reproduction using disposable accounts. Do not submit private keys, reusable signatures, RPC credentials or database contents.

## Signing rules for clients

Clients must use trusted contract, token and relay configuration, construct typed data locally, and display the recipient, amount and fee before signing. Nothing else bounds the fee: the contract has no maximum fee, and a relay's quote is only a hint, so a request pays exactly the fee its sender signed. Check the quoted fee before signing and enforce a client-side fee limit (the SDK's `maxAcceptableFee`).

Keep one intent nonce per payment. Corrections reuse that nonce and must refer to the latest signed version. After a timeout or ambiguous response, reconcile the finalized on-chain outcome before creating a new payment: a relay failure does not stop a previously signed version, which can still execute until its nonce is used or its deadline passes.

USDT0 meta-transaction approvals have no expiry. Prefer permit when available and avoid retaining or logging reusable signatures.

## Contract trust assumptions

- The contract has no pause, rescue or upgrade mechanism. A contract change requires a new deployment and updated client configuration.
- Its owner can only add, replace or remove token configurations. A compromised owner key can make requests fail, and it can make a signed request that the configuration refused executable until its deadline (by adding its token or mode); it cannot move tokens without the sender's signature, change nonces or change the fee a request pays.
- The configured tokens (USDC and USDT0) are trusted to transfer the requested amounts and to decrement allowances by the transferred value. Token issuer upgrades, freezes and domain changes can affect transfers.

## Relay and SDK infrastructure assumptions

The SDK and the relay rely on RPC responses for chain state and finality. Use independent RPC providers and monitor disagreement or unavailable historical reads.

Protect the relay's signing key and its database. Run one transaction manager per relay key and chain and preserve its transaction journal through restarts. See [deployment and recovery](docs/deployment.md).

## Relay operating risks

- A sender can change its balance, allowance or nonce after broadcast, causing a reverted transaction at the relay's expense.
- Gas requirements change with chain and token state. Measure gas limits for the intended deployment and retain configured fee and spend limits.
- Request and storage limits constrain individual workloads; public services also need proxy limits, monitoring and capacity planning.

See the [protocol reference](docs/STEP-1-GAS-ABSTRACTION.md) (§3 and §4.2) for the full invariants and owner powers, and [testing](docs/testing.md) for the verification workflows.
