// Signing apps build all typed data themselves from validated fields and never sign typed data
// supplied by a relay or another application (§7). These helpers
// take plain fields, validate them against the pins, and build the typed data from the pins.

import { toUint256 } from './amounts.js';
import { deepFreeze, isPlainObject } from './bytes.js';
import { GaslessValidationError } from './errors.js';
import { findPinnedToken, type ChainPins } from './pins.js';
import { normalizeTokenAuthorization } from './signature.js';
import { normalizeTransferRequest, type TransferRequestInput } from './submit.js';
import {
    buildMetaTxApproveTypedData,
    buildPermitTypedData,
    buildTransferTypedData,
    type MetaTxApproveTypedData,
    type PermitTypedData,
    type TransferTypedData,
} from './typedData.js';
import type { Address, AuthModeName, DecimalString, TokenAuthorization, TransferRequest } from './types.js';
import {
    assertUnixSeconds,
    assertValidTransferRequest,
    checkAcceptableFee,
    checkCorrection,
    checkTransferPolicy,
    parseMaxAcceptableFee,
    type TransferValidationOptions,
} from './validate.js';

export type TokenAuthTypedData = PermitTypedData | MetaTxApproveTypedData;

const AUTH_MODES: readonly AuthModeName[] = ['none', 'permit', 'metaTxApprove'];

/**
 * A validated transfer: the request and the token authorization to sign first. Its id (the transfer digest) is
 * known only once the token authorization is signed, because the intent signs it (`transferSigningPayload`).
 */
export interface TransferIntent {
    readonly chainId: number;
    /** The pinned GaslessTransfer contract (verifyingContract of the intent). */
    readonly contract: Address;
    readonly request: TransferRequest;
    readonly authMode: AuthModeName;
    /** Permit or meta-tx approve typed data; null for mode "none". */
    readonly tokenAuth: TokenAuthTypedData | null;
}

export interface TransferIntentParams {
    readonly token: string;
    readonly from: string;
    readonly to: string;
    readonly amount: bigint | DecimalString | number;
    /** The relay's quote (`RelayClient.fee()`), in token units. */
    readonly fee: bigint | DecimalString | number;
    /** The relay address from the quote; must be pinned. */
    readonly relay: string;
    readonly authMode: AuthModeName;
    /** Unix seconds; the relay accepts now + 60 … now + 7200. A correction's deadline is not earlier than the corrected one's. */
    readonly deadline: bigint | DecimalString | number;
    /**
     * The intent nonce. A new payment takes the sender's current `nonces(from)`, read on-chain right before (never a
     * higher one: such a request cannot execute before the lower nonces are used), and only once the sender has no
     * other open payment, so that two payments never share a nonce unknowingly (sdk/README.md, "One payment, one
     * nonce"). With `corrects` it may be omitted, and the corrected version's nonce is taken over; given, it must
     * equal that. The core cannot read the chain and cannot tell an earlier version's nonce from a new one: passed
     * without `corrects`, it starts a new payment, and none of the correction rules is checked. The client passes the
     * nonce alone only for the first version of a payment, passes `corrects` (the payment's latest signed version)
     * for every later version, and reads `nonces(from)` on-chain before requesting a correction signature (once it
     * is above the payment's nonce, the payment's outcome is decided).
     */
    readonly nonce?: bigint | DecimalString | number;
    /** The token's current nonce for the owner (`nonces(owner)` for permit, `getNonce(owner)` for meta-tx). Required unless mode is "none". */
    readonly tokenNonce?: bigint | DecimalString | number;
    /**
     * The request of the payment's latest signed version, when this intent corrects it (`checkCorrection`):
     * the intent keeps its intent nonce (so at most one version executes), its `from`, `token` and `to`, and a deadline
     * at least as late. Otherwise `correction_mismatch`. Before asking for a correction, the caller checks on-chain that
     * the nonce is still unused (`nonces(from)` is not above it; `prepareTransfer` does this itself, the core cannot
     * read the chain, so the client must do it): once it is used, the payment's outcome is decided, and
     * `waitForTransferOutcome` with the latest version tells it.
     */
    readonly corrects?: TransferRequestInput;
}

/** The request of the version a correction corrects, in canonical form; malformed fields fail as `corrects.<name>`. */
export function normalizeCorrectedRequest(input: TransferRequestInput): TransferRequest {
    try {
        return normalizeTransferRequest(input);
    } catch (error) {
        if (error instanceof GaslessValidationError) {
            throw new GaslessValidationError(error.code, error.field.replace(/^request\b/, 'corrects'), error.message);
        }
        throw error;
    }
}

/**
 * The permit or meta-tx approve typed data for a request, built from the pins only: domain = the
 * pinned token domain, spender = the pinned contract, value = amount + fee, and for permits
 * deadline = the intent deadline. Returns null for mode "none".
 */
export function buildTokenAuthTypedData(
    pins: ChainPins,
    request: TransferRequest,
    authMode: AuthModeName,
    tokenNonce: bigint | DecimalString | number | undefined,
): TokenAuthTypedData | null {
    if (authMode === 'none') return null;
    const token = findPinnedToken(pins, request.token);
    if (token === undefined) throw new GaslessValidationError('unsupported_token', 'request.token', 'not a pinned token');
    if (!token.authModes.includes(authMode)) {
        throw new GaslessValidationError('unsupported_auth_mode', 'authMode', `${token.symbol} does not support auth mode "${authMode}"`);
    }
    if (tokenNonce === undefined) throw new GaslessValidationError('auth_missing', 'tokenNonce', `auth mode "${authMode}" needs the token nonce`);
    let nonce: bigint;
    try {
        nonce = toUint256(tokenNonce, 'tokenNonce');
    } catch (error) {
        throw new GaslessValidationError('invalid_request', 'tokenNonce', (error as Error).message);
    }
    const value = BigInt(request.amount) + BigInt(request.fee);
    if (authMode === 'permit') {
        return buildPermitTypedData({
            tokenDomain: token.domain,
            owner: request.from,
            spender: pins.transfer.address,
            value,
            nonce,
            deadline: request.deadline,
        });
    }
    return buildMetaTxApproveTypedData({ tokenDomain: token.domain, from: request.from, spender: pins.transfer.address, value, nonce });
}

/**
 * Options of `createTransferIntent`. Like `TransferValidationOptions`, they come from the signing app itself
 * (its own code and its user), never from the fields another application or a relay passes in.
 */
export interface TransferIntentOptions extends TransferValidationOptions {
    /**
     * Allows mode "metaTxApprove" for a token that also supports permit (default false: such an intent is
     * refused with `meta_tx_approve_not_allowed`). A META_TX approval has no deadline: once broadcast it stays
     * public and executable by anyone, also after the transaction reverted, until the owner's token nonce moves
     * on (spec §5). A permit expires with the intent. Set this only when the app itself deliberately
     * chose the META_TX approval, never because another application or a relay asked for that mode. A token without permit
     * needs no opt-in.
     */
    readonly allowMetaTxApprove?: boolean;
}

/**
 * Builds and validates a transfer intent. Throws `GaslessValidationError` (with the code of the first
 * failing check) if the fields violate the pins, if no nonce is given (`invalid_request`, field `nonce`), if a
 * correction (`params.corrects`) changes what it must keep (`correction_mismatch`), if the fee exceeds
 * `options.maxAcceptableFee` (`fee_above_limit`), or if mode "metaTxApprove" is asked for a token that supports
 * permit without `options.allowMetaTxApprove` (`meta_tx_approve_not_allowed`, spec §5). The result is deep-frozen.
 *
 * It takes `params.nonce` without `params.corrects` so that a client can supply a payment's first nonce. Therefore
 * the correction rules hold only if the caller passes `corrects` for every later version of a payment, never its
 * nonce alone (see `TransferIntentParams.nonce`).
 */
export function createTransferIntent(pins: ChainPins, params: TransferIntentParams, now: number, options: TransferIntentOptions = {}): TransferIntent {
    assertUnixSeconds(now);
    const maxAcceptableFee = parseMaxAcceptableFee(options?.maxAcceptableFee);
    const corrected = params.corrects === undefined ? undefined : normalizeCorrectedRequest(params.corrects);
    const nonce = params.nonce ?? corrected?.nonce;
    if (nonce === undefined) {
        throw new GaslessValidationError(
            'invalid_request',
            'nonce',
            'the intent nonce is required: the sender\'s nonces(from) read on-chain for a new payment, or corrects for a correction',
        );
    }
    const request = normalizeTransferRequest({
        token: params.token,
        from: params.from,
        to: params.to,
        amount: params.amount,
        fee: params.fee,
        relay: params.relay,
        nonce,
        deadline: params.deadline,
    });
    if (!AUTH_MODES.includes(params.authMode)) throw new GaslessValidationError('invalid_request', 'authMode', 'unknown auth mode');
    // Request policy first, so that e.g. an unpinned token reports `unsupported_token` rather than a
    // token-authorization error; then the correction rules, the caller's fee ceiling and the META_TX preference;
    // then the full validation including the built token authorization.
    const policy = checkTransferPolicy(request, params.authMode, pins, now);
    if (!policy.ok) throw GaslessValidationError.fromResult(policy);
    if (corrected !== undefined) {
        const correction = checkCorrection(corrected, request);
        if (!correction.ok) throw GaslessValidationError.fromResult(correction);
    }
    const acceptable = checkAcceptableFee(BigInt(request.fee), maxAcceptableFee, 'request.fee');
    if (!acceptable.ok) throw GaslessValidationError.fromResult(acceptable);
    const token = findPinnedToken(pins, request.token);
    if (params.authMode === 'metaTxApprove' && token?.authModes.includes('permit') === true && options?.allowMetaTxApprove !== true) {
        throw new GaslessValidationError(
            'meta_tx_approve_not_allowed',
            'authMode',
            `${token.symbol} supports permit, which expires with the intent; a META_TX approval never expires and stays ` +
                'executable once broadcast (spec §5). Use authMode "permit", or set options.allowMetaTxApprove',
        );
    }
    const intent = {
        chainId: pins.chainId,
        contract: pins.transfer.address,
        request,
        authMode: params.authMode,
        tokenAuth: buildTokenAuthTypedData(pins, request, params.authMode, params.tokenNonce),
    };
    assertValidTransferRequest(intent, pins, now);
    return deepFreeze(intent);
}

/**
 * The permit or meta-tx approve typed data to sign first, rebuilt from a re-validated intent (e.g. one kept while
 * the user confirmed, or passed between the signing app's own frames) and the pins; null for mode "none". Only the
 * token nonce is taken over from `intent.tokenAuth`; a wrong nonce only makes the token signature invalid on-chain.
 * With `options.maxAcceptableFee`, a higher fee fails with `fee_above_limit`.
 *
 * The auth mode is taken from the intent as it is: the META_TX preference (`allowMetaTxApprove`) is
 * decided when the intent is built. Build intents with `createTransferIntent` (or `prepareTransfer`)
 * in the signing app itself; never sign an intent object that another application or a relay built.
 */
export function tokenAuthSigningPayload(
    pins: ChainPins,
    intent: TransferIntent,
    now: number,
    options: TransferValidationOptions = {},
): TokenAuthTypedData | null {
    assertValidTransferRequest(withoutAuthorization(intent), pins, now, options);
    const request = normalizeTransferRequest(intent.request);
    // Mode "none" (validated above) may come with tokenAuth null or, from plain JS, undefined.
    const tokenNonce = intent.tokenAuth === null || intent.tokenAuth === undefined ? undefined : intent.tokenAuth.message.nonce;
    return deepFreeze(buildTokenAuthTypedData(pins, request, intent.authMode, tokenNonce));
}

/**
 * The `GaslessTransfer` typed data to sign second, over the signed token authorization: `toTokenAuthorization(mode,
 * tokenSignature)` with the signature of `tokenAuthSigningPayload`, or `toTokenAuthorization('none')`. Re-validates
 * the intent as `tokenAuthSigningPayload` does, and checks that the authorization is of the intent's mode and in
 * the form the relay submits (`checkSignedAuthorization`). The core cannot check the token signature itself
 * (`signPrepared` recovers it); a wrong one makes the relay refuse the request (`invalid_token_authorization`).
 */
export function transferSigningPayload(
    pins: ChainPins,
    intent: TransferIntent,
    authorization: TokenAuthorization,
    now: number,
    options: TransferValidationOptions = {},
): TransferTypedData {
    assertValidTransferRequest({ ...withoutAuthorization(intent), authorization }, pins, now, options);
    const request = normalizeTransferRequest(intent.request);
    return deepFreeze(buildTransferTypedData(pins.chainId, pins.transfer.address, request, normalizeTokenAuthorization(authorization)));
}

/** The intent's fields that `validateTransferRequest` reads, without an `authorization` the caller's object may carry. */
function withoutAuthorization(intent: TransferIntent): TransferIntent {
    if (!isPlainObject(intent)) return intent;
    return { chainId: intent.chainId, contract: intent.contract, request: intent.request, authMode: intent.authMode, tokenAuth: intent.tokenAuth };
}
