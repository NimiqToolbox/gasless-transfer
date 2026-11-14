// Zero-dependency core: typed data, pins and ABIs. Also built as the IIFE global `NimiqGaslessCore`.
export * from './types.js';
export * from './typedData.js';
export * from './constants.js';
export * from './abi.js';

export { isAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from './address.js';
export { isCanonicalUint256, MAX_UINT256, maxSendable, toUint256 } from './amounts.js';
export { DEFAULT_DEADLINE_SECONDS, FEE_TOKEN_DECIMALS } from './defaults.js';
export { isDeniedRecipient, recipientDenylist } from './denylist.js';
export { hashDomain, tokenAuthHash, transferDigest, transferDigestFromAuthHash, typedDataDigest } from './eip712.js';
export {
    GaslessError,
    GaslessValidationError,
    InvalidPinsError,
    type ValidationErrorCode,
    type ValidationResult,
} from './errors.js';
export {
    buildTokenAuthTypedData,
    createTransferIntent,
    tokenAuthSigningPayload,
    transferSigningPayload,
    type TokenAuthTypedData,
    type TransferIntent,
    type TransferIntentOptions,
    type TransferIntentParams,
} from './intent.js';
export {
    chainIdSalt,
    definePins,
    findPinnedToken,
    pinsFromDeployment,
    sameDomain,
    type ChainPins,
    type ChainPinsInput,
    type DeploymentFile,
    type PinnedToken,
    type PinsFromDeploymentOptions,
    type TokenPinInput,
} from './pins.js';
export {
    NO_TOKEN_AUTHORIZATION,
    normalizeSignature,
    normalizeTokenAuthorization,
    SECP256K1_HALF_N,
    SECP256K1_N,
    splitSignature,
    toTokenAuthorization,
    type SignatureParts,
} from './signature.js';
export { buildSubmitTransferBody, normalizeTransferRequest, type SubmitTransferParams, type TransferRequestInput } from './submit.js';
export {
    assertUnixSeconds,
    assertValidTransferRequest,
    checkAcceptableFee,
    checkCorrection,
    checkSignedAuthorization,
    checkTokenAuthorization,
    checkTransferPolicy,
    checkTransferRequestShape,
    parseMaxAcceptableFee,
    validateSubmitTransferBody,
    validateTransferRequest,
    type SubmitBodyValidationOptions,
    type TransferValidationInput,
    type TransferValidationOptions,
} from './validate.js';
