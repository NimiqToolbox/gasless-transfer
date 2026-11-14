import {
    domainSeparator,
    hashTypedData,
    recoverAddress,
    type Address,
    type HashTypedDataParameters,
    type Hex,
    type TypedDataDomain as ViemTypedDataDomain,
} from 'viem';
import type { TypedDataDomain, TypedDataField } from '@nimiq/gasless-sdk/core';

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** OpenZeppelin ECDSA (and FiatToken's ECRecover) reject s above n / 2. */
export const SECP256K1_HALF_N = SECP256K1_N / 2n;

/** Any SDK typed-data payload (`{domain, types, primaryType, message}` with decimal-string integers). */
export interface SdkTypedData {
    readonly domain: TypedDataDomain;
    readonly types: Readonly<Record<string, readonly TypedDataField[]>>;
    readonly primaryType: string;
    readonly message: object;
}

function toViemDomain(domain: TypedDataDomain): ViemTypedDataDomain {
    return {
        name: domain.name,
        version: domain.version,
        ...(domain.chainId !== undefined ? { chainId: domain.chainId } : {}),
        verifyingContract: domain.verifyingContract,
        ...(domain.salt !== undefined ? { salt: domain.salt } : {}),
    };
}

/** keccak256 of the encoded EIP-712 domain; equals the token's / contract's `DOMAIN_SEPARATOR()`. */
export function hashDomain(domain: TypedDataDomain): Hex {
    return domainSeparator({ domain: toViemDomain(domain) });
}

const INTEGER_TYPE_RE = /^u?int(?:[0-9]+)?$/;

function toViemMessage(
    types: Readonly<Record<string, readonly TypedDataField[]>>,
    typeName: string,
    message: Record<string, unknown>,
): Record<string, unknown> {
    const fields = types[typeName];
    if (!fields) throw new TypeError(`unknown EIP-712 type ${typeName}`);
    const out: Record<string, unknown> = {};
    for (const field of fields) {
        const value = message[field.name];
        if (INTEGER_TYPE_RE.test(field.type)) {
            if (typeof value === 'bigint') out[field.name] = value;
            else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) out[field.name] = BigInt(value);
            // Small integers (TokenAuth's uint8 mode and v) are numbers in the SDK payload.
            else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[field.name] = BigInt(value);
            else throw new TypeError(`${typeName}.${field.name}: expected a decimal integer`);
        } else if (types[field.type]) {
            out[field.name] = toViemMessage(types, field.type, value as Record<string, unknown>);
        } else if (field.type.endsWith(']')) {
            throw new TypeError(`${typeName}.${field.name}: array types are not supported`);
        } else {
            out[field.name] = value;
        }
    }
    return out;
}

/** EIP-712 digest of an SDK payload (integers given as decimal strings are converted to bigint). */
export function hashSdkTypedData(payload: SdkTypedData): Hex {
    const definition = {
        domain: toViemDomain(payload.domain),
        types: payload.types,
        primaryType: payload.primaryType,
        message: toViemMessage(payload.types, payload.primaryType, payload.message as Record<string, unknown>),
    } as unknown as HashTypedDataParameters;
    return hashTypedData(definition);
}

export interface EcdsaParts {
    readonly v: number;
    readonly r: Hex;
    readonly s: Hex;
}

/** Splits a 65-byte `r ‖ s ‖ v` signature; undefined for any other length. */
export function splitSignature65(signature: Hex): EcdsaParts | undefined {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return undefined;
    return {
        r: `0x${signature.slice(2, 66)}`,
        s: `0x${signature.slice(66, 130)}`,
        v: Number.parseInt(signature.slice(130, 132), 16),
    };
}

/**
 * The on-chain acceptance rules of OpenZeppelin `ECDSA.tryRecover` and `ecrecover`: v ∈ {27, 28},
 * 0 < r < n and 0 < s ≤ n/2 (low-s). High-s and v ∈ {0, 1} signatures are rejected.
 */
export function isCanonicalEcdsa(parts: EcdsaParts): boolean {
    if (parts.v !== 27 && parts.v !== 28) return false;
    if (!/^0x[0-9a-fA-F]{64}$/.test(parts.r) || !/^0x[0-9a-fA-F]{64}$/.test(parts.s)) return false;
    const r = BigInt(parts.r);
    const s = BigInt(parts.s);
    return r > 0n && r < SECP256K1_N && s > 0n && s <= SECP256K1_HALF_N;
}

/** Recovers the signer of `hash`, or undefined if the signature is not canonical or not recoverable. */
export async function recoverCanonical(hash: Hex, parts: EcdsaParts): Promise<Address | undefined> {
    if (!isCanonicalEcdsa(parts)) return undefined;
    try {
        return await recoverAddress({ hash, signature: { r: parts.r, s: parts.s, v: BigInt(parts.v) } });
    } catch {
        return undefined;
    }
}
