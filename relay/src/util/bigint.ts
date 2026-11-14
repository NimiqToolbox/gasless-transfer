/** Integer division rounding up; both operands must be non-negative and the divisor positive. */
export function ceilDiv(a: bigint, b: bigint): bigint {
    if (b <= 0n) throw new RangeError('ceilDiv: divisor must be positive');
    if (a < 0n) throw new RangeError('ceilDiv: dividend must not be negative');
    return (a + b - 1n) / b;
}

/** Rounds `value` up to the next multiple of `step`. */
export function roundUpTo(value: bigint, step: bigint): bigint {
    return ceilDiv(value, step) * step;
}

export function maxBig(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
}

/** Formats a non-negative fixed-point integer: `formatFixed(11210000n, 8) === "0.1121"`. */
export function formatFixed(value: bigint, decimals: number): string {
    if (value < 0n) throw new RangeError('formatFixed: value must not be negative');
    const base = 10n ** BigInt(decimals);
    const integer = (value / base).toString();
    const fraction = value % base;
    if (decimals === 0 || fraction === 0n) return integer;
    return `${integer}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

/**
 * Parses a non-negative decimal number such as "0.1121" into a fixed-point integer with `decimals`
 * decimals. Returns undefined for malformed input or more fractional digits than `decimals`.
 */
export function parseFixed(text: string, decimals: number): bigint | undefined {
    const match = /^(0|[1-9][0-9]{0,30})(?:\.([0-9]+))?$/.exec(text);
    if (!match) return undefined;
    const fraction = match[2] ?? '';
    if (fraction.length > decimals) return undefined;
    return BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
