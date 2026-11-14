// Relay API types (docs/STEP-1-GAS-ABSTRACTION.md §6). The relay server (relay/) and the SDK client
// both implement exactly this wire format.
//
// JSON conventions: uint256 values (amounts, fees, intent nonces, deadlines, gas units, wei prices, block
// numbers) are canonical decimal strings; chain ids, tx nonces, unix timestamps, policy seconds and the v of a
// token authorization are JSON numbers; addresses are checksummed; bytes32 values are 0x + 64 hex characters.

import type { Address, AuthModeName, DecimalString, Hex, TransferRequest, TypedDataDomain } from '../core/types.js';

export type OperationName = 'transfer';

export type RequestStatus = 'queued' | 'submitted' | 'mined' | 'confirmed' | 'failed' | 'expired';

export type ErrorCode =
    // 400
    | 'invalid_request'
    | 'unsupported_operation'
    | 'wrong_relay'
    | 'unsupported_token'
    | 'unsupported_auth_mode'
    | 'invalid_amount'
    | 'invalid_recipient'
    | 'deadline_out_of_range'
    | 'invalid_signature'
    | 'invalid_token_authorization'
    // 402
    | 'fee_too_low'
    // 404
    | 'not_found'
    // 409
    | 'nonce_used'
    | 'nonce_too_high'
    | 'conflict'
    | 'sender_busy'
    // 422
    | 'insufficient_balance'
    | 'insufficient_allowance'
    | 'token_paused'
    | 'blocked_address'
    | 'simulation_failed'
    // 429
    | 'rate_limited'
    // 500 / 503
    | 'internal_error'
    | 'unavailable';

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
    invalid_request: 400,
    unsupported_operation: 400,
    wrong_relay: 400,
    unsupported_token: 400,
    unsupported_auth_mode: 400,
    invalid_amount: 400,
    invalid_recipient: 400,
    deadline_out_of_range: 400,
    invalid_signature: 400,
    invalid_token_authorization: 400,
    fee_too_low: 402,
    not_found: 404,
    nonce_used: 409,
    nonce_too_high: 409,
    conflict: 409,
    sender_busy: 409,
    insufficient_balance: 422,
    insufficient_allowance: 422,
    token_paused: 422,
    blocked_address: 422,
    simulation_failed: 422,
    rate_limited: 429,
    internal_error: 500,
    unavailable: 503,
});

export interface ErrorResponse {
    error: { code: ErrorCode; message: string };
}

/** GET /v1/info */
export interface InfoResponse {
    version: string;
    chainId: number;
    /** The address clients must put into `request.relay`. */
    relay: Address;
    contracts: {
        transfer: { address: Address; domain: TypedDataDomain };
    };
    tokens: Array<{
        symbol: string;
        address: Address;
        decimals: number;
        authModes: AuthModeName[];
        tokenDomain: TypedDataDomain;
    }>;
    policy: { minDeadlineSeconds: number; maxDeadlineSeconds: number; quoteTtlSeconds: number };
}

/** GET /v1/fee?operation=transfer&token=<address>&authMode=<AuthModeName> */
export interface FeeQuery {
    operation: OperationName;
    token: Address;
    authMode: AuthModeName;
}

export interface FeeResponse {
    operation: OperationName;
    token: Address;
    authMode: AuthModeName;
    /** Fee to sign, in token units (multiple of 10000). */
    fee: DecimalString;
    relay: Address;
    gasUnits: DecimalString;
    /** Gas price used for the quote, in wei. */
    gasPrice: DecimalString;
    /** POL/USD price used, as a decimal number string, e.g. "0.1121". */
    polUsd: string;
    /** Unix seconds. The quote TTL is a hint; acceptance is re-checked at submit. */
    issuedAt: number;
    expiresAt: number;
    quoteId: string;
}

// The POST /v1/transfer body is built and validated by the core, so it is defined there.
export type { SubmitTransferBody } from '../core/types.js';

/** 202 on first submit; an identical re-submit returns 200 with the current status. */
export interface SubmitResponse {
    /** EIP-712 digest of the request at its nonce with its authorization (== contract `hashTransfer(r, nonce, auth)`). */
    id: Hex;
    status: RequestStatus;
}

export interface RequestTransaction {
    hash: Hex;
    txNonce: number;
    maxFeePerGas: DecimalString;
    status: 'pending' | 'mined' | 'replaced' | 'failed';
}

/** GET /v1/requests/:id */
export interface RequestState {
    id: Hex;
    operation: OperationName;
    status: RequestStatus;
    request: TransferRequest;
    /**
     * `hashStruct(TokenAuth)` of the request's token authorization (`tokenAuthHash`): with `request` it hashes to
     * `id`, without revealing the token signature.
     */
    authHash: Hex;
    transactions: RequestTransaction[];
    /** The final transaction hash, also after a speed-up; null until submitted. */
    txHash: Hex | null;
    blockNumber: DecimalString | null;
    error: { code: ErrorCode; message: string } | null;
}
