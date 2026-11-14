// zod building blocks for request bodies (§6.1 conventions, step 1 of §6.3).
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { BYTES32_RE, HEX_BYTES_RE, ZERO_BYTES32, isChecksummedAddress, parseCanonicalUint256 } from '../util/validation.js';
import type { NormalizedAuthorization } from './types.js';

/** EIP-55 checksummed address. */
export const zAddress = z
    .string()
    .max(42)
    .refine(isChecksummedAddress, 'expected an EIP-55 checksummed address')
    .transform((s) => s as Address);

/** uint256 as a canonical decimal string (no sign, leading zeros, exponent or whitespace). */
export const zUint256 = z
    .string()
    .max(78)
    .refine((s) => parseCanonicalUint256(s) !== undefined, 'expected a canonical uint256 decimal string');

/** bytes32 as 0x + 64 hex characters; normalized to lowercase. */
const zBytes32 = z
    .string()
    .regex(BYTES32_RE, 'expected 0x + 64 hex characters')
    .transform((s) => s.toLowerCase() as Hex);

/** Hex bytes (length is checked by the signature step); normalized to lowercase. */
export const zSignatureHex = z
    .string()
    .max(2 + 2 * 256)
    .regex(HEX_BYTES_RE, 'expected 0x-prefixed hex bytes')
    .transform((s) => s.toLowerCase() as Hex);

const zUint8 = z.number().int().min(0).max(255);

/**
 * Mirrors `TokenAuthorization`, which the intent signs: always exactly mode, v, r and s, submitted as given. Mode "none"
 * carries no token signature and must be v = 0, r = s = 0, as the SDK builds it. The token signature of the other
 * modes is checked in step 7.
 */
export const zAuthorization = z
    .strictObject({ mode: z.enum(['none', 'permit', 'metaTxApprove']), v: zUint8, r: zBytes32, s: zBytes32 })
    .refine((a) => a.mode !== 'none' || (a.v === 0 && a.r === ZERO_BYTES32 && a.s === ZERO_BYTES32), {
        message: 'mode "none" must have v 0 and r, s zero',
    })
    .transform((a): NormalizedAuthorization => ({ mode: a.mode, v: a.v, r: a.r, s: a.s }));

/**
 * Opaque quote id echoed from `GET /v1/fee`: a hint only, never used for acceptance, stored or logged.
 * Same rule as the SDK (`validateSubmitTransferBody`): a non-empty string of at most 256 characters.
 */
export const zQuoteId = z.string().min(1).max(256);

export function formatZodError(error: z.ZodError): string {
    const issue = error.issues[0];
    if (!issue) return 'invalid request';
    const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
    return `${path}: ${issue.message}`.slice(0, 300);
}
