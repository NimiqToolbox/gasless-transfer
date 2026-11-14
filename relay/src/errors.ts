import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorResponse } from '@nimiq/gasless-sdk/relay';

/**
 * An error that is reported to the client as `{"error": {"code", "message"}}` with the HTTP status
 * of the frozen `ERROR_HTTP_STATUS` mapping. Messages must never contain secrets (signatures, token
 * authorizations, raw transactions, keys).
 */
export class RelayError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string) {
        super(message);
        this.name = 'RelayError';
        this.code = code;
    }

    get statusCode(): number {
        return ERROR_HTTP_STATUS[this.code];
    }
}

export function errorResponse(code: ErrorCode, message: string): ErrorResponse {
    return { error: { code, message } };
}
