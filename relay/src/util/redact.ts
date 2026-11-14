// Defence in depth for logs. The relay never logs signatures, token authorizations (v/r/s), raw
// transactions or keys on purpose; these helpers reduce accidental disclosure of recognizable values:
// signatures (65 bytes = 130 hex characters), calldata and raw transactions are all long hex runs.

const LONG_HEX_RE = /(?:0x)?[0-9a-fA-F]{128,}/g;
// Providers may echo their request URL in error details. Credentials can occur in any part of a
// URL, including the path, so removing only userinfo or known query parameters is insufficient.
// Also recognize escaped slashes in JSON embedded in a provider's diagnostic string.
const RPC_URL_RE = /(?:https?|wss?):\\?\/\\?\/[^\s<>"]+/gi;

export const REDACTED_HEX = '[REDACTED_HEX]';
export const REDACTED_URL = '[REDACTED_URL]';

/** Removes web/socket URLs and hex runs of 64 bytes or more, preserving surrounding diagnostics. */
export function scrubString(value: string): string {
    return value.replace(RPC_URL_RE, REDACTED_URL).replace(LONG_HEX_RE, REDACTED_HEX);
}

function isPlainObject(value: object): boolean {
    const proto = Object.getPrototypeOf(value) as unknown;
    return proto === Object.prototype || proto === null;
}

/**
 * Scrubs strings inside plain objects and arrays and turns bigints into decimal strings (pino cannot
 * serialize bigints). Class instances (errors, requests) are left to their serializers.
 */
export function scrubDeep(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return scrubString(value);
    if (typeof value === 'bigint') return value.toString();
    if (value === null || typeof value !== 'object' || depth > 8) return value;
    if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, depth + 1);
    return out;
}
