// Client-side validation of a transfer before anything is signed (§7) and before a body is sent.
// The first failing check determines the result; the policy checks run in the order of the relay
// pipeline (§6.3 step 2) so that the SDK and the relay report the same code for the same request.

import { isAddress, isChecksumAddress, sameAddress, ZERO_ADDRESS } from './address.js';
import { isCanonicalUint256, MAX_UINT256, toUint256 } from './amounts.js';
import { isPlainObject } from './bytes.js';
import { MAX_DEADLINE_SECONDS, MIN_DEADLINE_SECONDS } from './constants.js';
import { isDeniedRecipient } from './denylist.js';
import { GaslessValidationError, VALID, validationFailure as fail, type ValidationResult } from './errors.js';
import { findPinnedToken, sameDomain, type ChainPins } from './pins.js';
import { normalizeTokenAuthorization, splitSignature } from './signature.js';
import {
    APPROVE_SELECTOR,
    encodeApproveCalldata,
    META_TRANSACTION_TYPES,
    PERMIT_TYPES,
    type MetaTxApproveTypedData,
    type PermitTypedData,
} from './typedData.js';
import type {
    AuthModeName,
    DecimalString,
    SubmitTransferBody,
    TokenAuthorization,
    TransferRequest,
    TypedDataDomain,
    TypedDataField,
} from './types.js';

/** What a client is about to sign: the intent, the domain it is signed for, and the token authorization. */
export interface TransferValidationInput {
    /** Chain id of the GaslessTransfer domain the request will be signed for. */
    readonly chainId: number;
    /** verifyingContract of that domain. */
    readonly contract: string;
    readonly request: TransferRequest;
    readonly authMode: AuthModeName;
    /** The permit / meta-tx typed data to be signed with the request; null or absent for mode "none". */
    readonly tokenAuth?: PermitTypedData | MetaTxApproveTypedData | null;
    /**
     * The signed token authorization (mode, v, r, s) the intent will sign, once the token authorization is signed.
     * If present it must be of `authMode` and in the form `toTokenAuthorization` builds (`checkSignedAuthorization`).
     */
    readonly authorization?: TokenAuthorization;
}

const REQUEST_KEYS: readonly string[] = ['token', 'from', 'to', 'amount', 'fee', 'relay', 'nonce', 'deadline'];
const ADDRESS_FIELDS = ['token', 'from', 'to', 'relay'] as const;
const UINT_FIELDS = ['amount', 'fee', 'nonce', 'deadline'] as const;
const AUTH_MODES: readonly AuthModeName[] = ['none', 'permit', 'metaTxApprove'];
const APPROVE_CALLDATA_RE = /^0x[0-9a-fA-F]{136}$/;
const MAX_QUOTE_ID_LENGTH = 256;

/** Throws TypeError unless `now` is unix time in seconds. Values >= 2^32 are almost surely milliseconds. */
export function assertUnixSeconds(now: number): void {
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0 || now >= 2 ** 32) {
        throw new TypeError('now: expected unix time in seconds (a non-negative integer below 2^32)');
    }
}

/**
 * Structure of the 8 signed request fields: exactly these keys, addresses (valid EIP-55 checksum if
 * mixed case) and canonical uint256 decimal strings (also the intent nonce).
 */
export function checkTransferRequestShape(request: unknown, field = 'request'): ValidationResult {
    if (!isPlainObject(request)) return fail('invalid_request', field, 'expected an object');
    for (const key of Object.keys(request)) {
        if (!REQUEST_KEYS.includes(key)) return fail('invalid_request', `${field}.${key}`, 'unexpected field');
    }
    for (const key of ADDRESS_FIELDS) {
        if (!isAddress(request[key])) {
            return fail('invalid_request', `${field}.${key}`, 'expected an address (0x + 40 hex, valid checksum if mixed case)');
        }
    }
    for (const key of UINT_FIELDS) {
        if (!isCanonicalUint256(request[key])) {
            return fail('invalid_request', `${field}.${key}`, 'expected a uint256 as canonical decimal string');
        }
    }
    return VALID;
}

/**
 * The signed token authorization of an intent in mode `authMode`: in the form `normalizeTokenAuthorization`
 * accepts (zeros for "none"; v 27 or 28 and a low-s r, s otherwise) and of that mode (`auth_type_mismatch`).
 */
export function checkSignedAuthorization(authMode: AuthModeName, authorization: unknown, field = 'authorization'): ValidationResult {
    let mode: AuthModeName;
    try {
        mode = normalizeTokenAuthorization(authorization as TokenAuthorization, field).mode;
    } catch (error) {
        if (error instanceof GaslessValidationError) return fail(error.code, error.field, error.message);
        throw error;
    }
    if (mode !== authMode) return fail('auth_type_mismatch', `${field}.mode`, `the intent is in auth mode "${authMode}"`);
    return VALID;
}

/**
 * Policy checks of a well-formed request against the pins, in relay order: relay, token, auth mode,
 * sender, amount (amount + fee within uint256), recipient denylist, deadline window (now + 60 … now + 7200). Neither
 * the pins nor the contract cap the fee: the caller shows it to the user and may bound it (`checkAcceptableFee`).
 */
export function checkTransferPolicy(request: TransferRequest, authMode: AuthModeName, pins: ChainPins, now: number): ValidationResult {
    return checkPolicy(request, authMode, pins, now, true);
}

/** `checkTransferPolicy`, optionally without the deadline window (a re-post of a body). */
function checkPolicy(request: TransferRequest, authMode: AuthModeName, pins: ChainPins, now: number, deadlineWindow: boolean): ValidationResult {
    assertUnixSeconds(now);
    if (!pins.relays.some((relay) => sameAddress(relay, request.relay))) {
        return fail('wrong_relay', 'request.relay', 'not a pinned relay address');
    }
    const token = findPinnedToken(pins, request.token);
    if (token === undefined) return fail('unsupported_token', 'request.token', 'not a pinned token');
    if (!token.authModes.includes(authMode)) {
        return fail('unsupported_auth_mode', 'authMode', `${token.symbol} does not support auth mode "${authMode}"`);
    }
    if (sameAddress(request.from, ZERO_ADDRESS)) return fail('invalid_sender', 'request.from', 'must not be the zero address');
    const amount = BigInt(request.amount);
    const fee = BigInt(request.fee);
    if (amount === 0n) return fail('invalid_amount', 'request.amount', 'must be greater than zero');
    if (amount + fee > MAX_UINT256) return fail('invalid_amount', 'request.amount', 'amount + fee exceeds uint256');
    if (isDeniedRecipient(pins, request.to)) {
        return fail('invalid_recipient', 'request.to', 'recipient is denied (zero address, a token or a Nimiq contract)');
    }
    const deadline = BigInt(request.deadline);
    if (deadlineWindow && (deadline < BigInt(now + MIN_DEADLINE_SECONDS) || deadline > BigInt(now + MAX_DEADLINE_SECONDS))) {
        return fail(
            'deadline_out_of_range',
            'request.deadline',
            `must be between now + ${MIN_DEADLINE_SECONDS} s and now + ${MAX_DEADLINE_SECONDS} s`,
        );
    }
    return VALID;
}

/**
 * A correction (a new version of a payment, spec §7) against the version it corrects.
 * Every version of a payment is signed with one intent nonce, so the contract executes at most one of them. The
 * correction keeps:
 * - `from` and `nonce`: the payment's one intent nonce;
 * - `token` and `to`: what is paid to whom. The outcome check reports any executed version as the outcome of the
 *   payment, so every version must pay the same token to the same recipient;
 * - a `deadline` at least as late: the latest version then has the latest deadline, and once it can no longer
 *   execute (expired), no version can.
 *
 * `amount`, `fee`, `relay` and the token authorization may change: that is what refusals are about (a higher fee, and
 * with it a lower amount for a "send all" transfer or a cashlink claim; another relay after a key rotation or when a
 * relay does not execute; another auth mode or a new token nonce, which the relay cannot change itself because the
 * intent signs the token authorization). Fails with `correction_mismatch` (field `request.<name>`), or
 * `invalid_request` for a malformed request.
 */
export function checkCorrection(corrected: TransferRequest, request: TransferRequest): ValidationResult {
    const shapes: Array<[unknown, string]> = [
        [corrected, 'corrects'],
        [request, 'request'],
    ];
    for (const [value, field] of shapes) {
        const shape = checkTransferRequestShape(value, field);
        if (!shape.ok) return shape;
    }
    for (const key of ['from', 'token', 'to'] as const) {
        if (!sameAddress(corrected[key], request[key])) {
            return fail('correction_mismatch', `request.${key}`, `a correction keeps the ${key} of the version it corrects (${corrected[key]})`);
        }
    }
    if (corrected.nonce !== request.nonce) {
        return fail('correction_mismatch', 'request.nonce', `a correction keeps the intent nonce of the version it corrects (${corrected.nonce})`);
    }
    if (BigInt(request.deadline) < BigInt(corrected.deadline)) {
        return fail(
            'correction_mismatch',
            'request.deadline',
            `a correction keeps a deadline at least as late as the version it corrects (${corrected.deadline})`,
        );
    }
    return VALID;
}

/**
 * The caller's fee ceiling as bigint, or undefined if none is given. Neither the contract nor the pins cap the fee
 * and a relay may quote any fee, so a wallet shows the fee to the user and can pass the most it accepts to pay.
 * Throws `invalid_request` for a malformed value.
 */
export function parseMaxAcceptableFee(value: bigint | DecimalString | number | undefined): bigint | undefined {
    if (value === undefined) return undefined;
    try {
        return toUint256(value, 'maxAcceptableFee');
    } catch (error) {
        throw new GaslessValidationError('invalid_request', 'maxAcceptableFee', (error as Error).message);
    }
}

/** `fee_above_limit` if `fee` exceeds the caller's ceiling from `parseMaxAcceptableFee`. */
export function checkAcceptableFee(fee: bigint, maxAcceptableFee: bigint | undefined, field: string): ValidationResult {
    if (maxAcceptableFee === undefined || fee <= maxAcceptableFee) return VALID;
    return fail('fee_above_limit', field, `fee ${fee} exceeds the maximum acceptable fee ${maxAcceptableFee}`);
}

/**
 * Options of `validateTransferRequest`, `tokenAuthSigningPayload` and `transferSigningPayload`. They come from the
 * signing app itself (its user's setting), never from another application or a relay: those could raise the ceiling
 * they check.
 */
export interface TransferValidationOptions {
    /**
     * The most the caller accepts to pay, in token units (a bigint, decimal string or safe integer). A higher
     * `request.fee` fails with `fee_above_limit`. Optional, but nothing else caps the fee: without it, the user's review
     * of the fee is the only bound.
     */
    readonly maxAcceptableFee?: bigint | DecimalString | number;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

/** The types object must be exactly `{ [primaryType]: fields }`: no EIP712Domain, no extra types or fields. */
function hasExactTypes(value: unknown, expected: Readonly<Record<string, readonly TypedDataField[]>>): boolean {
    const names = Object.keys(expected);
    if (!hasExactKeys(value, names)) return false;
    return names.every((name) => {
        const actual = value[name];
        const fields = expected[name] ?? [];
        return (
            Array.isArray(actual) &&
            actual.length === fields.length &&
            fields.every((f, i) => hasExactKeys(actual[i], ['name', 'type']) && actual[i].name === f.name && actual[i].type === f.type)
        );
    });
}

function isDomain(value: unknown): value is TypedDataDomain {
    return isPlainObject(value) && Object.keys(value).every((key) => ['name', 'version', 'chainId', 'verifyingContract', 'salt'].includes(key));
}

/**
 * The permit / meta-tx typed data must be exactly what the contract will need (§5): the pinned
 * token domain, owner = from, spender = the pinned contract, value = amount + fee, and for permits
 * deadline = the intent deadline (so never 0 or max). Assumes the policy checks passed.
 */
export function checkTokenAuthorization(input: TransferValidationInput, pins: ChainPins): ValidationResult {
    const { request, authMode, tokenAuth } = input;
    if (authMode === 'none') {
        return tokenAuth === undefined || tokenAuth === null
            ? VALID
            : fail('auth_unexpected', 'tokenAuth', 'auth mode "none" signs no token authorization');
    }
    if (tokenAuth === undefined || tokenAuth === null) {
        return fail('auth_missing', 'tokenAuth', `auth mode "${authMode}" needs the permit or meta-tx typed data`);
    }
    const token = findPinnedToken(pins, request.token);
    if (token === undefined) return fail('unsupported_token', 'request.token', 'not a pinned token');

    const isPermit = authMode === 'permit';
    const primaryType = isPermit ? 'Permit' : 'MetaTransaction';
    if (
        !isPlainObject(tokenAuth) ||
        tokenAuth.primaryType !== primaryType ||
        !hasExactTypes(tokenAuth.types, isPermit ? PERMIT_TYPES : META_TRANSACTION_TYPES)
    ) {
        return fail('auth_type_mismatch', 'tokenAuth.types', `expected exactly the ${primaryType} type`);
    }
    if (!isDomain(tokenAuth.domain) || !sameDomain(tokenAuth.domain, token.domain)) {
        return fail('auth_domain_mismatch', 'tokenAuth.domain', `must equal the pinned ${token.symbol} domain`);
    }

    const value = BigInt(request.amount) + BigInt(request.fee);
    const message: unknown = tokenAuth.message;
    if (isPermit) {
        if (!hasExactKeys(message, ['owner', 'spender', 'value', 'nonce', 'deadline'])) {
            return fail('auth_type_mismatch', 'tokenAuth.message', 'expected exactly owner, spender, value, nonce, deadline');
        }
        if (!isAddress(message.owner) || !sameAddress(message.owner, request.from)) {
            return fail('auth_owner_mismatch', 'tokenAuth.message.owner', 'must equal request.from');
        }
        if (!isAddress(message.spender) || !sameAddress(message.spender, pins.transfer.address)) {
            return fail('auth_spender_mismatch', 'tokenAuth.message.spender', 'must be the pinned transfer contract');
        }
        if (!isCanonicalUint256(message.value) || BigInt(message.value) !== value) {
            return fail('auth_value_mismatch', 'tokenAuth.message.value', 'must equal amount + fee');
        }
        if (!isCanonicalUint256(message.nonce)) {
            return fail('invalid_request', 'tokenAuth.message.nonce', 'expected a uint256 as canonical decimal string');
        }
        if (message.deadline !== request.deadline) {
            return fail('auth_deadline_mismatch', 'tokenAuth.message.deadline', 'must equal the intent deadline');
        }
        return VALID;
    }

    if (!hasExactKeys(message, ['nonce', 'from', 'functionSignature'])) {
        return fail('auth_type_mismatch', 'tokenAuth.message', 'expected exactly nonce, from, functionSignature');
    }
    if (!isAddress(message.from) || !sameAddress(message.from, request.from)) {
        return fail('auth_owner_mismatch', 'tokenAuth.message.from', 'must equal request.from');
    }
    if (!isCanonicalUint256(message.nonce)) {
        return fail('invalid_request', 'tokenAuth.message.nonce', 'expected a uint256 as canonical decimal string');
    }
    const call = message.functionSignature;
    if (typeof call !== 'string' || !APPROVE_CALLDATA_RE.test(call) || call.slice(0, 10).toLowerCase() !== APPROVE_SELECTOR) {
        return fail('auth_type_mismatch', 'tokenAuth.message.functionSignature', 'expected approve(address,uint256) calldata');
    }
    const spenderWord = call.slice(10, 74);
    if (!/^0{24}/.test(spenderWord) || !sameAddress(`0x${spenderWord.slice(24)}`, pins.transfer.address)) {
        return fail('auth_spender_mismatch', 'tokenAuth.message.functionSignature', 'approve spender must be the pinned transfer contract');
    }
    if (BigInt(`0x${call.slice(74)}`) !== value) {
        return fail('auth_value_mismatch', 'tokenAuth.message.functionSignature', 'approve value must equal amount + fee');
    }
    // Belt and braces: byte-identical to the calldata the contract builds itself.
    if (call.toLowerCase() !== encodeApproveCalldata(pins.transfer.address, value)) {
        return fail('auth_type_mismatch', 'tokenAuth.message.functionSignature', 'non-canonical approve calldata');
    }
    return VALID;
}

/**
 * Validates a transfer against the pins before signing (§7): the domain's chain and contract, the
 * relay, token and auth mode, the amount (amount + fee within uint256), the recipient denylist, the deadline window,
 * the caller's own fee ceiling (`options.maxAcceptableFee`, `fee_above_limit`), for permit / meta-tx that
 * the token authorization matches (value == amount + fee, …), and the signed authorization if given
 * (`checkSignedAuthorization`). `now` is unix time in seconds.
 */
export function validateTransferRequest(
    req: TransferValidationInput,
    pins: ChainPins,
    now: number,
    options: TransferValidationOptions = {},
): ValidationResult {
    assertUnixSeconds(now);
    let maxAcceptableFee: bigint | undefined;
    try {
        maxAcceptableFee = parseMaxAcceptableFee(options?.maxAcceptableFee);
    } catch (error) {
        if (error instanceof GaslessValidationError) return fail(error.code, error.field, error.message);
        throw error;
    }
    if (!isPlainObject(req)) return fail('invalid_request', 'input', 'expected an object');
    if (typeof req.chainId !== 'number' || !Number.isSafeInteger(req.chainId) || req.chainId <= 0) {
        return fail('invalid_request', 'chainId', 'expected a positive integer');
    }
    if (!isAddress(req.contract)) return fail('invalid_request', 'contract', 'expected an address');
    if (!AUTH_MODES.includes(req.authMode)) return fail('invalid_request', 'authMode', 'unknown auth mode');
    const shape = checkTransferRequestShape(req.request);
    if (!shape.ok) return shape;
    if (req.chainId !== pins.chainId) return fail('wrong_chain', 'chainId', `expected chain ${pins.chainId}`);
    if (!sameAddress(req.contract, pins.transfer.address)) return fail('wrong_contract', 'contract', 'not the pinned transfer contract');
    const policy = checkTransferPolicy(req.request, req.authMode, pins, now);
    if (!policy.ok) return policy;
    const acceptable = checkAcceptableFee(BigInt(req.request.fee), maxAcceptableFee, 'request.fee');
    if (!acceptable.ok) return acceptable;
    const tokenAuth = checkTokenAuthorization(req, pins);
    if (!tokenAuth.ok || req.authorization === undefined) return tokenAuth;
    return checkSignedAuthorization(req.authMode, req.authorization);
}

/** `validateTransferRequest` that throws `GaslessValidationError` instead of returning a failure. */
export function assertValidTransferRequest(
    req: TransferValidationInput,
    pins: ChainPins,
    now: number,
    options: TransferValidationOptions = {},
): void {
    const result = validateTransferRequest(req, pins, now, options);
    if (!result.ok) throw GaslessValidationError.fromResult(result);
}

/** Options of `validateSubmitTransferBody`. */
export interface SubmitBodyValidationOptions {
    /**
     * The body is posted again after an unclear answer: the deadline window (now + 60 … now + 7200) is not
     * checked. A relay answers an identical body it stored with its current state before any policy check, also after
     * the deadline; a body it did not store it refuses itself. Every other check still applies.
     */
    readonly repost?: boolean;
}

/**
 * Validates a POST /v1/transfer body against the pins before it is sent: structure, signature
 * format (65 bytes, low-s), authorization format (`normalizeTokenAuthorization`: zeros for "none"),
 * and the request policy. The body must be in the wire form `buildSubmitTransferBody` produces: the relay refuses
 * an address that is not EIP-55 checksummed and a signature whose v is 0 or 1, so they fail here too instead of
 * after a round trip. The token signature itself (v, r, s) cannot be checked against amount + fee
 * here; `validateTransferRequest` does that on the typed data before signing. With `options.repost`
 * the deadline window is not checked.
 */
export function validateSubmitTransferBody(
    body: SubmitTransferBody,
    pins: ChainPins,
    now: number,
    options: SubmitBodyValidationOptions = {},
): ValidationResult {
    assertUnixSeconds(now);
    if (!isPlainObject(body)) return fail('invalid_request', 'body', 'expected an object');
    for (const key of Object.keys(body)) {
        if (!['request', 'signature', 'authorization', 'quoteId'].includes(key)) return fail('invalid_request', key, 'unexpected field');
    }
    const shape = checkTransferRequestShape(body.request);
    if (!shape.ok) return shape;
    for (const key of ADDRESS_FIELDS) {
        if (!isChecksumAddress(body.request[key])) {
            return fail('invalid_request', `request.${key}`, 'expected an EIP-55 checksummed address');
        }
    }
    let mode: AuthModeName;
    try {
        const { v } = splitSignature(body.signature, 'signature');
        if (Number.parseInt(body.signature.slice(130), 16) !== v) {
            return fail('invalid_signature', 'signature', 'v must be 27 or 28 (normalizeSignature converts 0 and 1)');
        }
        mode = normalizeTokenAuthorization(body.authorization).mode;
    } catch (error) {
        if (error instanceof GaslessValidationError) return fail(error.code, error.field, error.message);
        throw error;
    }
    if (body.quoteId !== undefined && (typeof body.quoteId !== 'string' || body.quoteId.length === 0 || body.quoteId.length > MAX_QUOTE_ID_LENGTH)) {
        return fail('invalid_request', 'quoteId', `expected a non-empty string of at most ${MAX_QUOTE_ID_LENGTH} characters`);
    }
    return checkPolicy(body.request, mode, pins, now, options?.repost !== true);
}
