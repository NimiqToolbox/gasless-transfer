import { decodeErrorResult, type Abi, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { ErrorCode } from '@nimiq/gasless-sdk/relay';

export interface DecodedRevert {
    /** Custom error name, `Error` (revert string), `Panic`, or `unknown`. */
    readonly name: string;
    readonly args: readonly unknown[];
    /** Human-readable form, e.g. `InsufficientAllowance(0, 1010000)`. Never contains secrets. */
    readonly description: string;
}

function formatArg(value: unknown): string {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    return String(value);
}

/** Decodes revert data with the contract ABI (custom errors) plus `Error(string)` and `Panic(uint256)`. */
export function decodeRevert(data: Hex | undefined, abi: Abi = gaslessTransferAbi): DecodedRevert {
    if (data === undefined || data === '0x') {
        return { name: 'unknown', args: [], description: 'reverted without reason' };
    }
    try {
        const decoded = decodeErrorResult({ abi, data });
        const args = (decoded.args ?? []) as readonly unknown[];
        return { name: decoded.errorName, args, description: `${decoded.errorName}(${args.map(formatArg).join(', ')})` };
    } catch {
        return { name: 'unknown', args: [], description: `reverted with unknown error ${data.slice(0, 10)}` };
    }
}

// GaslessTransfer verifies the signature first, over the sender's current nonce: a request whose nonce was used reverts
// with InvalidSignature, which the transaction manager tells apart by reading the nonce (TxManager.preflight).
const REVERT_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
    InsufficientAllowance: 'insufficient_allowance',
    DeadlineExpired: 'deadline_out_of_range',
    InvalidSignature: 'invalid_signature',
    InvalidSigner: 'invalid_signature',
    TokenNotSupported: 'unsupported_token',
    AuthModeNotSupported: 'unsupported_auth_mode',
    ZeroAmount: 'invalid_amount',
    InvalidRecipient: 'invalid_recipient',
    NotRelay: 'wrong_relay',
};

/** Error code for a request that failed its re-simulation in the transaction manager. */
export function errorCodeForRevert(revert: DecodedRevert): ErrorCode {
    return REVERT_ERROR_CODES[revert.name] ?? 'simulation_failed';
}
