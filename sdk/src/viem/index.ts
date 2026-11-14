// viem adapter (docs/STEP-1-GAS-ABSTRACTION.md §7). viem is a peer dependency.
export {
    confirmOnChain,
    type ConfirmBlockTag,
    type ConfirmOnChainOptions,
    type ConfirmTarget,
    type OnChainConfirmation,
    type OnChainStatus,
    type UnresolvedReason,
} from './confirm.js';
export { hashTransfer } from './hash.js';
export {
    waitForTransferOutcome,
    type RelayStatusSource,
    type TransferOutcome,
    type WaitForTransferOutcomeOptions,
} from './outcome.js';
export { prepareTransfer, type PrepareTransferParams, type PreparedTransfer } from './prepare.js';
export { signPrepared, type SignedTransfer, type SignPreparedOptions, type TransferSigner } from './sign.js';
export { assertTokenDomain, checkTokenDomain, readTokenNonce, TokenDomainMismatchError, type TokenDomainCheck } from './tokens.js';
