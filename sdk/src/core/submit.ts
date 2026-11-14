// Assembling the POST /v1/transfer body in the wire format of §6.1: checksummed addresses,
// canonical decimal strings (also the intent nonce), lowercase bytes32 values, 65-byte low-s signatures
// with v in {27, 28}.

import { toChecksumAddress } from './address.js';
import { toUint256 } from './amounts.js';
import { deepFreeze, isPlainObject } from './bytes.js';
import { GaslessValidationError } from './errors.js';
import { normalizeSignature, normalizeTokenAuthorization } from './signature.js';
import type { DecimalString, SubmitTransferBody, TokenAuthorization, TransferRequest } from './types.js';

export interface TransferRequestInput {
    readonly token: string;
    readonly from: string;
    readonly to: string;
    readonly amount: bigint | DecimalString | number;
    readonly fee: bigint | DecimalString | number;
    readonly relay: string;
    /** The intent nonce, `nonces(from)` when the request executes. */
    readonly nonce: bigint | DecimalString | number;
    readonly deadline: bigint | DecimalString | number;
}

const REQUEST_KEYS: readonly string[] = ['token', 'from', 'to', 'amount', 'fee', 'relay', 'nonce', 'deadline'];
const MAX_QUOTE_ID_LENGTH = 256;

function invalid(field: string, error: unknown): GaslessValidationError {
    return new GaslessValidationError('invalid_request', field, error instanceof Error ? error.message : String(error));
}

/**
 * The canonical wire form of the 8 signed request fields. Accepts bigint / safe-integer / decimal-string
 * integers; rejects unknown fields, malformed values and wrong EIP-55 checksums.
 */
export function normalizeTransferRequest(input: TransferRequestInput): TransferRequest {
    if (!isPlainObject(input)) throw new GaslessValidationError('invalid_request', 'request', 'expected an object');
    for (const key of Object.keys(input)) {
        if (!REQUEST_KEYS.includes(key)) throw new GaslessValidationError('invalid_request', `request.${key}`, 'unexpected field');
    }
    const address = (key: 'token' | 'from' | 'to' | 'relay') => {
        try {
            return toChecksumAddress(input[key], `request.${key}`);
        } catch (error) {
            throw invalid(`request.${key}`, error);
        }
    };
    const uint = (key: 'amount' | 'fee' | 'nonce' | 'deadline') => {
        try {
            return toUint256(input[key], `request.${key}`).toString(10);
        } catch (error) {
            throw invalid(`request.${key}`, error);
        }
    };
    return {
        token: address('token'),
        from: address('from'),
        to: address('to'),
        amount: uint('amount'),
        fee: uint('fee'),
        relay: address('relay'),
        nonce: uint('nonce'),
        deadline: uint('deadline'),
    };
}

export interface SubmitTransferParams {
    readonly request: TransferRequestInput;
    /** The owner's 65-byte signature over the GaslessTransfer typed data. */
    readonly signature: string;
    /** The token authorization the intent signed (`toTokenAuthorization(mode, tokenSignature)`). */
    readonly authorization: TokenAuthorization;
    /** From the fee quote; optional. */
    readonly quoteId?: string;
}

/**
 * The POST /v1/transfer body in canonical wire form. The authorization is taken as it is (`normalizeTokenAuthorization`
 * only checks it): the intent signs it, and the relay must submit exactly these values. The body contains the token
 * signature; for META_TX approvals it never expires, so do not persist or log the body (§5).
 */
export function buildSubmitTransferBody(params: SubmitTransferParams): SubmitTransferBody {
    if (!isPlainObject(params)) throw new GaslessValidationError('invalid_request', 'params', 'expected an object');
    const request = normalizeTransferRequest(params.request);
    const signature = normalizeSignature(params.signature, 'signature');
    const authorization = normalizeTokenAuthorization(params.authorization);
    const { quoteId } = params;
    if (quoteId !== undefined && (typeof quoteId !== 'string' || quoteId.length === 0 || quoteId.length > MAX_QUOTE_ID_LENGTH)) {
        throw new GaslessValidationError('invalid_request', 'quoteId', `expected a non-empty string of at most ${MAX_QUOTE_ID_LENGTH} characters`);
    }
    return deepFreeze({ request, signature, authorization, ...(quoteId !== undefined ? { quoteId } : {}) });
}
