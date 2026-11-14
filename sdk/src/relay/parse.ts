// Strict parsers for relay responses (wire format: docs/STEP-1-GAS-ABSTRACTION.md §6.1, relay/types.ts).
// Every field the SDK uses is type-checked and normalized; unknown extra fields are ignored so that
// additive relay changes do not break clients.

import { isAddress, toChecksumAddress } from '../core/address.js';
import { isCanonicalUint256 } from '../core/amounts.js';
import { isPlainObject } from '../core/bytes.js';
import { MAX_PINNED_TOKENS } from '../core/pins.js';
import { checkTransferRequestShape } from '../core/validate.js';
import type { Address, AuthModeName, DecimalString, Hex, TransferRequest, TypedDataDomain } from '../core/types.js';
import { RelayClientError, sanitizeRelayMessage } from './errors.js';
import {
    ERROR_HTTP_STATUS,
    type ErrorCode,
    type FeeResponse,
    type InfoResponse,
    type RequestState,
    type RequestStatus,
    type RequestTransaction,
    type SubmitResponse,
} from './types.js';

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_NUMBER_RE = /^[0-9]{1,20}(\.[0-9]{1,20})?$/;
const AUTH_MODES: readonly AuthModeName[] = ['none', 'permit', 'metaTxApprove'];
const REQUEST_STATUSES: readonly RequestStatus[] = ['queued', 'submitted', 'mined', 'confirmed', 'failed', 'expired'];
const TX_STATUSES: readonly RequestTransaction['status'][] = ['pending', 'mined', 'replaced', 'failed'];
const DOMAIN_KEYS: readonly string[] = ['name', 'version', 'chainId', 'verifyingContract', 'salt'];

function bad(path: string, message: string): never {
    throw new RelayClientError('invalid_response', `invalid relay response at ${path}: ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
    if (!isPlainObject(value)) bad(path, 'expected an object');
    return value;
}

function string(value: unknown, path: string, maxLength = 256): string {
    if (typeof value !== 'string' || value.length > maxLength) bad(path, `expected a string of at most ${maxLength} characters`);
    return value;
}

function address(value: unknown, path: string): Address {
    if (!isAddress(value)) bad(path, 'expected an address');
    return toChecksumAddress(value);
}

function bytes32(value: unknown, path: string): Hex {
    if (typeof value !== 'string' || !BYTES32_RE.test(value)) bad(path, 'expected bytes32');
    return value.toLowerCase() as Hex;
}

function uint(value: unknown, path: string): DecimalString {
    if (!isCanonicalUint256(value)) bad(path, 'expected a uint256 as canonical decimal string');
    return value;
}

function integer(value: unknown, path: string, min = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) bad(path, `expected an integer >= ${min}`);
    return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) bad(path, `expected one of ${allowed.join(', ')}`);
    return value as T;
}

function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
    return value === null ? null : parse(value);
}

/** Domain objects are parsed strictly: an unknown field would change the EIP-712 domain. */
function domain(value: unknown, path: string): TypedDataDomain {
    const d = object(value, path);
    for (const key of Object.keys(d)) if (!DOMAIN_KEYS.includes(key)) bad(`${path}.${key}`, 'unexpected domain field');
    return {
        name: string(d.name, `${path}.name`),
        version: string(d.version, `${path}.version`),
        ...(d.chainId !== undefined ? { chainId: integer(d.chainId, `${path}.chainId`, 1) } : {}),
        verifyingContract: address(d.verifyingContract, `${path}.verifyingContract`),
        ...(d.salt !== undefined ? { salt: bytes32(d.salt, `${path}.salt`) } : {}),
    };
}

function transferRequest(value: unknown, path: string): TransferRequest {
    const shape = checkTransferRequestShape(value, path);
    if (!shape.ok) bad(shape.field, shape.message);
    const r = value as TransferRequest;
    return {
        token: toChecksumAddress(r.token),
        from: toChecksumAddress(r.from),
        to: toChecksumAddress(r.to),
        amount: r.amount,
        fee: r.fee,
        relay: toChecksumAddress(r.relay),
        nonce: r.nonce,
        deadline: r.deadline,
    };
}

export function parseInfo(json: unknown): InfoResponse {
    const info = object(json, 'info');
    const contracts = object(info.contracts, 'contracts');
    const transfer = object(contracts.transfer, 'contracts.transfer');
    if (!Array.isArray(info.tokens)) bad('tokens', 'expected an array');
    // Before any entry is parsed: each one costs several hashes (address checksums), and the comparison with the
    // pins, which would refuse a long list, comes only after parsing.
    if (info.tokens.length > MAX_PINNED_TOKENS) bad('tokens', `expected at most ${MAX_PINNED_TOKENS} tokens`);
    const policy = object(info.policy, 'policy');
    const minDeadlineSeconds = integer(policy.minDeadlineSeconds, 'policy.minDeadlineSeconds', 1);
    const maxDeadlineSeconds = integer(policy.maxDeadlineSeconds, 'policy.maxDeadlineSeconds', 1);
    if (minDeadlineSeconds > maxDeadlineSeconds) bad('policy', 'minDeadlineSeconds > maxDeadlineSeconds');
    return {
        version: string(info.version, 'version'),
        chainId: integer(info.chainId, 'chainId', 1),
        relay: address(info.relay, 'relay'),
        contracts: {
            transfer: {
                address: address(transfer.address, 'contracts.transfer.address'),
                domain: domain(transfer.domain, 'contracts.transfer.domain'),
            },
        },
        tokens: info.tokens.map((raw: unknown, i: number) => {
            const token = object(raw, `tokens[${i}]`);
            if (!Array.isArray(token.authModes)) bad(`tokens[${i}].authModes`, 'expected an array');
            return {
                symbol: string(token.symbol, `tokens[${i}].symbol`, 32),
                address: address(token.address, `tokens[${i}].address`),
                decimals: integer(token.decimals, `tokens[${i}].decimals`),
                authModes: token.authModes.map((mode: unknown, j: number) => oneOf(mode, AUTH_MODES, `tokens[${i}].authModes[${j}]`)),
                tokenDomain: domain(token.tokenDomain, `tokens[${i}].tokenDomain`),
            };
        }),
        policy: {
            minDeadlineSeconds,
            maxDeadlineSeconds,
            quoteTtlSeconds: integer(policy.quoteTtlSeconds, 'policy.quoteTtlSeconds', 1),
        },
    };
}

export function parseFee(json: unknown): FeeResponse {
    const fee = object(json, 'fee');
    const polUsd = string(fee.polUsd, 'polUsd', 41);
    if (!DECIMAL_NUMBER_RE.test(polUsd)) bad('polUsd', 'expected a decimal number string');
    const issuedAt = integer(fee.issuedAt, 'issuedAt');
    const expiresAt = integer(fee.expiresAt, 'expiresAt');
    if (expiresAt < issuedAt) bad('expiresAt', 'is before issuedAt');
    const quoteId = string(fee.quoteId, 'quoteId');
    if (quoteId.length === 0) bad('quoteId', 'is empty');
    return {
        operation: oneOf(fee.operation, ['transfer'] as const, 'operation'),
        token: address(fee.token, 'token'),
        authMode: oneOf(fee.authMode, AUTH_MODES, 'authMode'),
        fee: uint(fee.fee, 'fee'),
        relay: address(fee.relay, 'relay'),
        gasUnits: uint(fee.gasUnits, 'gasUnits'),
        gasPrice: uint(fee.gasPrice, 'gasPrice'),
        polUsd,
        issuedAt,
        expiresAt,
        quoteId,
    };
}

export function parseSubmit(json: unknown): SubmitResponse {
    const res = object(json, 'submit');
    return { id: bytes32(res.id, 'id'), status: oneOf(res.status, REQUEST_STATUSES, 'status') };
}

function errorCode(value: unknown): ErrorCode | null {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_HTTP_STATUS, value) ? (value as ErrorCode) : null;
}

export function parseRequestState(json: unknown): RequestState {
    const state = object(json, 'request state');
    if (!Array.isArray(state.transactions)) bad('transactions', 'expected an array');
    return {
        id: bytes32(state.id, 'id'),
        operation: oneOf(state.operation, ['transfer'] as const, 'operation'),
        status: oneOf(state.status, REQUEST_STATUSES, 'status'),
        request: transferRequest(state.request, 'request'),
        authHash: bytes32(state.authHash, 'authHash'),
        transactions: state.transactions.map((raw: unknown, i: number) => {
            const tx = object(raw, `transactions[${i}]`);
            return {
                hash: bytes32(tx.hash, `transactions[${i}].hash`),
                txNonce: integer(tx.txNonce, `transactions[${i}].txNonce`),
                maxFeePerGas: uint(tx.maxFeePerGas, `transactions[${i}].maxFeePerGas`),
                status: oneOf(tx.status, TX_STATUSES, `transactions[${i}].status`),
            };
        }),
        txHash: nullable(state.txHash, (v) => bytes32(v, 'txHash')),
        blockNumber: nullable(state.blockNumber, (v) => uint(v, 'blockNumber')),
        error: nullable(state.error, (v) => {
            const e = object(v, 'error');
            const code = errorCode(e.code);
            if (code === null) bad('error.code', 'unknown error code');
            return { code, message: sanitizeRelayMessage(e.message) };
        }),
    };
}

/** The `{"error": {"code", "message"}}` body of an error response, or null if it is not one. */
export function parseErrorBody(json: unknown): { code: ErrorCode; message: string } | null {
    if (!isPlainObject(json) || !isPlainObject(json.error)) return null;
    const code = errorCode(json.error.code);
    return code === null ? null : { code, message: sanitizeRelayMessage(json.error.message) };
}
