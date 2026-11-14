import { getAddress } from 'viem';

export const MAX_UINT256 = (1n << 256n) - 1n;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;

const CANONICAL_DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
export const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Canonical uint256 decimal string ("0", "10000"; no sign, no leading zeros, no exponent) → bigint. */
export function parseCanonicalUint256(value: string): bigint | undefined {
    if (value.length > 78 || !CANONICAL_DECIMAL_RE.test(value)) return undefined;
    const n = BigInt(value);
    return n <= MAX_UINT256 ? n : undefined;
}

/** True only for EIP-55 checksummed addresses (all-lowercase or all-uppercase hex is rejected unless it is its own checksum). */
export function isChecksummedAddress(value: string): boolean {
    if (!ADDRESS_RE.test(value)) return false;
    try {
        return getAddress(value) === value;
    } catch {
        return false;
    }
}

export function sameAddress(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}
