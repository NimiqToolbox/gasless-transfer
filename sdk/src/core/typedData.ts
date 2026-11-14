// EIP-712 definitions (docs/STEP-1-GAS-ABSTRACTION.md §4.3, §5). Must match contracts/src/interfaces/*.sol
// and the token contracts; the golden vectors compare these digests with the contract.

import { deepFreeze } from './bytes.js';
import {
    AUTH_MODE_ID,
    type Address,
    type AuthModeName,
    type DecimalString,
    type Hex,
    type TokenAuthorization,
    type TransferRequest,
    type TypedDataDomain,
    type TypedDataPayload,
} from './types.js';

export const TRANSFER_DOMAIN_NAME = 'Nimiq Gasless Transfer';
/** The contract's EIP-712 domain version. */
export const TRANSFER_DOMAIN_VERSION = '3';

export const TOKEN_AUTH_TYPE = 'TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)';

/** The EIP-712 type string: the primary type, then the referenced TokenAuth. */
export const TRANSFER_TYPE =
    'GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)' +
    TOKEN_AUTH_TYPE;

/**
 * The type definitions are frozen: the builders below return them by reference, and an edit of a payload's `types`
 * (adding `EIP712Domain` for a wallet API, say) would otherwise change what every later payload signs and hashes.
 */
export const TRANSFER_TYPES = deepFreeze({
    GaslessTransfer: [
        { name: 'token', type: 'address' },
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint256' },
        { name: 'relay', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'auth', type: 'TokenAuth' },
    ],
    TokenAuth: [
        { name: 'mode', type: 'uint8' },
        { name: 'v', type: 'uint8' },
        { name: 'r', type: 'bytes32' },
        { name: 's', type: 'bytes32' },
    ],
} as const);

/** The `auth` member of the signed message: Solidity `TokenAuth` with the numeric `AuthMode`. */
export interface TokenAuthMessage {
    readonly mode: 0 | 1 | 2;
    readonly v: number;
    readonly r: Hex;
    readonly s: Hex;
}

/** The signed `GaslessTransfer` message: the request fields and the token authorization. */
export interface TransferMessage extends TransferRequest {
    auth: TokenAuthMessage;
}

/** EIP-2612 permit, identical for USDC (FiatTokenV2_2) and USDT0 (UChildUSDT0). */
export const PERMIT_TYPES = deepFreeze({
    Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
} as const);

/** USDT0 NativeMetaTransaction. */
export const META_TRANSACTION_TYPES = deepFreeze({
    MetaTransaction: [
        { name: 'nonce', type: 'uint256' },
        { name: 'from', type: 'address' },
        { name: 'functionSignature', type: 'bytes' },
    ],
} as const);

export type TransferTypedData = TypedDataPayload<typeof TRANSFER_TYPES, 'GaslessTransfer', TransferMessage>;
export type PermitTypedData = TypedDataPayload<
    typeof PERMIT_TYPES,
    'Permit',
    { owner: Address; spender: Address; value: DecimalString; nonce: DecimalString; deadline: DecimalString }
>;
export type MetaTxApproveTypedData = TypedDataPayload<
    typeof META_TRANSACTION_TYPES,
    'MetaTransaction',
    { nonce: DecimalString; from: Address; functionSignature: Hex }
>;

const MAX_UINT256 = (1n << 256n) - 1n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/** Canonical decimal string of a uint256 given as bigint or decimal string; throws TypeError otherwise. */
export function toUint256String(value: bigint | DecimalString, field = 'value'): DecimalString {
    let n: bigint;
    if (typeof value === 'bigint') {
        n = value;
    } else if (typeof value === 'string' && /^[0-9]{1,78}$/.test(value)) {
        n = BigInt(value);
    } else {
        throw new TypeError(`${field}: expected a uint256 as bigint or decimal string`);
    }
    if (n < 0n || n > MAX_UINT256) throw new TypeError(`${field}: out of uint256 range`);
    return n.toString(10);
}

function assertAddress(value: string, field: string): Address {
    if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw new TypeError(`${field}: expected a 20-byte hex address`);
    return value as Address;
}

function assertBytes32(value: string, field: string): Hex {
    if (typeof value !== 'string' || !BYTES32_RE.test(value)) throw new TypeError(`${field}: expected 0x + 64 hex characters`);
    return value.toLowerCase() as Hex;
}

/**
 * The `auth` member of the signed message for a token authorization: the mode as its enum value, v (any uint8)
 * and r, s as given. Checks the format only; which values a client signs and a relay accepts is checked by
 * `normalizeTokenAuthorization`. Throws TypeError otherwise.
 */
export function tokenAuthMessage(authorization: TokenAuthorization, field = 'authorization'): TokenAuthMessage {
    if (authorization === null || typeof authorization !== 'object') throw new TypeError(`${field}: expected an object`);
    const { mode, v, r, s } = authorization;
    if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(AUTH_MODE_ID, mode)) {
        throw new TypeError(`${field}.mode: expected "none", "permit" or "metaTxApprove"`);
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) throw new TypeError(`${field}.v: expected a uint8`);
    return { mode: AUTH_MODE_ID[mode as AuthModeName], v, r: assertBytes32(r, `${field}.r`), s: assertBytes32(s, `${field}.s`) };
}

function copyDomain(domain: TypedDataDomain): TypedDataDomain {
    return {
        name: domain.name,
        version: domain.version,
        ...(domain.chainId !== undefined ? { chainId: domain.chainId } : {}),
        verifyingContract: domain.verifyingContract,
        ...(domain.salt !== undefined ? { salt: domain.salt } : {}),
    };
}

export function transferDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError('chainId: expected a positive integer');
    return {
        name: TRANSFER_DOMAIN_NAME,
        version: TRANSFER_DOMAIN_VERSION,
        chainId,
        verifyingContract: assertAddress(verifyingContract, 'verifyingContract'),
    };
}

/**
 * The `GaslessTransfer` payload the sender signs: exactly the 8 request fields and the token authorization,
 * which the sender has signed before (the permit or meta-tx; zeros for mode "none").
 */
export function buildTransferTypedData(
    chainId: number,
    verifyingContract: Address,
    request: TransferRequest,
    authorization: TokenAuthorization,
): TransferTypedData {
    return {
        domain: transferDomain(chainId, verifyingContract),
        types: TRANSFER_TYPES,
        primaryType: 'GaslessTransfer',
        message: {
            token: assertAddress(request.token, 'token'),
            from: assertAddress(request.from, 'from'),
            to: assertAddress(request.to, 'to'),
            amount: toUint256String(request.amount, 'amount'),
            fee: toUint256String(request.fee, 'fee'),
            relay: assertAddress(request.relay, 'relay'),
            nonce: toUint256String(request.nonce, 'nonce'),
            deadline: toUint256String(request.deadline, 'deadline'),
            auth: tokenAuthMessage(authorization),
        },
    };
}

/** EIP-2612 permit for `spender` (always the gasless contract) over `value` (always amount + fee). */
export function buildPermitTypedData(params: {
    tokenDomain: TypedDataDomain;
    owner: Address;
    spender: Address;
    value: bigint | DecimalString;
    nonce: bigint | DecimalString;
    deadline: bigint | DecimalString;
}): PermitTypedData {
    return {
        domain: copyDomain(params.tokenDomain),
        types: PERMIT_TYPES,
        primaryType: 'Permit',
        message: {
            owner: assertAddress(params.owner, 'owner'),
            spender: assertAddress(params.spender, 'spender'),
            value: toUint256String(params.value, 'value'),
            nonce: toUint256String(params.nonce, 'nonce'),
            deadline: toUint256String(params.deadline, 'deadline'),
        },
    };
}

export const APPROVE_SELECTOR = '0x095ea7b3';

/** `approve(spender, value)` calldata, byte-identical to the contract's `abi.encodeCall(IERC20.approve, ...)`. */
export function encodeApproveCalldata(spender: Address, value: bigint | DecimalString): Hex {
    const s = assertAddress(spender, 'spender').slice(2).toLowerCase().padStart(64, '0');
    const v = BigInt(toUint256String(value, 'value')).toString(16).padStart(64, '0');
    return `${APPROVE_SELECTOR}${s}${v}`;
}

/** USDT0 meta-transaction that executes `approve(spender, value)` for `from`. Never expires once signed. */
export function buildMetaTxApproveTypedData(params: {
    tokenDomain: TypedDataDomain;
    from: Address;
    spender: Address;
    value: bigint | DecimalString;
    nonce: bigint | DecimalString;
}): MetaTxApproveTypedData {
    return {
        domain: copyDomain(params.tokenDomain),
        types: META_TRANSACTION_TYPES,
        primaryType: 'MetaTransaction',
        message: {
            nonce: toUint256String(params.nonce, 'nonce'),
            from: assertAddress(params.from, 'from'),
            functionSignature: encodeApproveCalldata(params.spender, params.value),
        },
    };
}
