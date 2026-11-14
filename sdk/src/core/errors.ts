// Error types of the SDK. Every error has a stable `code`; prefer checking `code` over `instanceof`
// (the CJS builds of the entry points do not share class identities).
//
// No error message or field ever contains a signature: META_TX approvals never expire, so they
// must not end up in logs (docs/STEP-1-GAS-ABSTRACTION.md §5).

/**
 * Validation failures. Codes shared with the relay (`wrong_relay` … `deadline_out_of_range`,
 * `invalid_signature`, `invalid_request`, `nonce_used`) mean the same as the relay's ErrorCode.
 */
export type ValidationErrorCode =
    // malformed input
    | 'invalid_request'
    | 'invalid_signature'
    // pins (§7): chain, contract, relay, token, auth mode
    | 'wrong_chain'
    | 'wrong_contract'
    | 'wrong_relay'
    | 'unsupported_token'
    | 'unsupported_auth_mode'
    // request policy (§6.3 step 2, §4.3 step 4)
    | 'invalid_sender'
    | 'invalid_amount'
    | 'invalid_recipient'
    | 'deadline_out_of_range'
    // the caller's own fee ceiling (`maxAcceptableFee`); nothing else caps the fee
    | 'fee_above_limit'
    // createTransferIntent: a META_TX approval (it never expires) for a token that has permit, without
    // the caller's explicit `allowMetaTxApprove` (spec §5); signPrepared: a META_TX approval with
    // `allowMetaTxApprove: false`
    | 'meta_tx_approve_not_allowed'
    // token authorization (§5): permit / meta-tx typed data must match the request and the pins, and the signed
    // authorization (mode, v, r, s) the intent's auth mode
    | 'auth_missing'
    | 'auth_unexpected'
    | 'auth_type_mismatch'
    | 'auth_domain_mismatch'
    | 'auth_owner_mismatch'
    | 'auth_spender_mismatch'
    | 'auth_value_mismatch'
    | 'auth_deadline_mismatch'
    // a correction (`corrects`) must keep from, nonce, token and to of the version it corrects, and a
    // deadline at least as late
    | 'correction_mismatch'
    // prepareTransfer with `corrects`: the intent nonce of the payment is already used on-chain (`nonces(from)` is
    // above it; the relay's code for the same state); a version executed or the nonce was invalidated
    | 'nonce_used'
    // signer and sender checks of the viem adapter
    | 'signer_mismatch'
    | 'sender_is_contract'
    | 'eip7702_permit_unsupported';

export type ValidationResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly code: ValidationErrorCode; readonly field: string; readonly message: string };

export class GaslessError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'GaslessError';
        this.code = code;
    }
}

export class GaslessValidationError extends GaslessError {
    declare readonly code: ValidationErrorCode;
    /** Dotted path of the offending input field, e.g. `request.to` or `tokenAuth.message.value`. */
    readonly field: string;

    constructor(code: ValidationErrorCode, field: string, message: string) {
        super(code, message);
        this.name = 'GaslessValidationError';
        this.field = field;
    }

    static fromResult(result: Extract<ValidationResult, { ok: false }>): GaslessValidationError {
        return new GaslessValidationError(result.code, result.field, result.message);
    }
}

/** Thrown by `definePins` / `pinsFromDeployment` for inconsistent or malformed pins. */
export class InvalidPinsError extends GaslessError {
    declare readonly code: 'invalid_pins';
    readonly field: string;

    constructor(field: string, message: string) {
        super('invalid_pins', `${field}: ${message}`);
        this.name = 'InvalidPinsError';
        this.field = field;
    }
}

export function validationFailure(
    code: ValidationErrorCode,
    field: string,
    message: string,
): Extract<ValidationResult, { ok: false }> {
    return { ok: false, code, field, message };
}

export const VALID: ValidationResult = Object.freeze({ ok: true });
