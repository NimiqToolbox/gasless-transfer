import { describe, expect, it } from 'vitest';
import { monotonicMs } from '../../src/clock.js';
import { FixedWindowLimiter } from '../../src/limiter.js';
import { ceilDiv, formatFixed, maxBig, minBig, parseFixed, roundUpTo } from '../../src/util/bigint.js';
import { scrubDeep, scrubString } from '../../src/util/redact.js';
import { MAX_UINT256, isChecksummedAddress, parseCanonicalUint256, sameAddress } from '../../src/util/validation.js';
import { TestClock } from '../helpers/harness.js';

describe('bigint helpers', () => {
    it('rounding', () => {
        expect(ceilDiv(0n, 3n)).toBe(0n);
        expect(ceilDiv(7n, 3n)).toBe(3n);
        expect(ceilDiv(9n, 3n)).toBe(3n);
        expect(() => ceilDiv(1n, 0n)).toThrow(RangeError);
        expect(() => ceilDiv(-1n, 2n)).toThrow(RangeError);
        expect(roundUpTo(1n, 10_000n)).toBe(10_000n);
        expect(roundUpTo(10_000n, 10_000n)).toBe(10_000n);
        expect(roundUpTo(10_001n, 10_000n)).toBe(20_000n);
        expect(maxBig(1n, 2n)).toBe(2n);
        expect(minBig(1n, 2n)).toBe(1n);
    });

    it('fixed-point formatting and parsing', () => {
        expect(formatFixed(11_210_000n, 8)).toBe('0.1121');
        expect(formatFixed(100_000_000n, 8)).toBe('1');
        expect(formatFixed(1n, 8)).toBe('0.00000001');
        expect(formatFixed(5n, 0)).toBe('5');
        expect(parseFixed('0.1121', 8)).toBe(11_210_000n);
        expect(parseFixed('10', 8)).toBe(1_000_000_000n);
        expect(parseFixed('0.123456789', 8)).toBeUndefined();
        for (const bad of ['', '.1', '1.', '01', '-1', '1e2', ' 1', 'abc']) expect(parseFixed(bad, 8)).toBeUndefined();
    });
});

describe('validation helpers', () => {
    it('canonical uint256 decimals', () => {
        expect(parseCanonicalUint256('0')).toBe(0n);
        expect(parseCanonicalUint256(MAX_UINT256.toString())).toBe(MAX_UINT256);
        for (const bad of ['', '00', '01', '-0', '+1', '1.0', '1e3', ' 1', '0x1', (MAX_UINT256 + 1n).toString(), '9'.repeat(79)]) {
            expect(parseCanonicalUint256(bad)).toBeUndefined();
        }
    });

    it('EIP-55 checksums', () => {
        expect(isChecksummedAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toBe(true);
        expect(isChecksummedAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8')).toBe(false);
        expect(isChecksummedAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79c8')).toBe(false);
        expect(isChecksummedAddress('0x0000000000000000000000000000000000000000')).toBe(true);
        expect(isChecksummedAddress('0x123')).toBe(false);
        expect(sameAddress('0xAbC0000000000000000000000000000000000000', '0xabc0000000000000000000000000000000000000')).toBe(true);
    });
});

describe('T36: redaction helpers', () => {
    it('scrubs hex runs of 64 bytes or more, keeps hashes and addresses', () => {
        const hash = `0x${'ab'.repeat(32)}`;
        expect(scrubString(hash)).toBe(hash);
        expect(scrubString(`a ${'ab'.repeat(64)} b`)).toBe('a [REDACTED_HEX] b');
        expect(scrubString(`0x${'ab'.repeat(65)}`)).toBe('[REDACTED_HEX]');
        expect(scrubDeep({ a: [`0x${'cd'.repeat(70)}`], b: 5n, c: { d: 'ok' } })).toEqual({ a: ['[REDACTED_HEX]'], b: '5', c: { d: 'ok' } });
        const err = new Error('x');
        expect((scrubDeep({ err }) as { err: unknown }).err).toBe(err);
    });
});

describe('T36: per-signer limiter', () => {
    it('allows max hits per window and key, case-insensitively', () => {
        const clock = new TestClock(0);
        const limiter = new FixedWindowLimiter(2, 60_000, clock);
        expect(limiter.hit('0xAbC')).toBe(true);
        expect(limiter.hit('0xabc')).toBe(true);
        expect(limiter.hit('0xABC')).toBe(false);
        expect(limiter.hit('0xdef')).toBe(true);
        expect(limiter.retryAfterSeconds('0xabc')).toBe(60);
        clock.advance(60);
        expect(limiter.hit('0xabc')).toBe(true);
    });

    it('isLimited reports a used-up window without counting (the pipeline checks the limit before its nonce check, step 4, and charges it after)', () => {
        const clock = new TestClock(0);
        const limiter = new FixedWindowLimiter(2, 60_000, clock);
        for (let i = 0; i < 5; i++) expect(limiter.isLimited('0xAbC')).toBe(false);
        expect(limiter.hit('0xabc')).toBe(true);
        expect(limiter.isLimited('0xabc')).toBe(false);
        expect(limiter.hit('0xabc')).toBe(true);
        expect(limiter.isLimited('0xABC')).toBe(true);
        expect(limiter.isLimited('0xdef')).toBe(false);
        clock.advance(60);
        expect(limiter.isLimited('0xabc')).toBe(false);
        expect(limiter.hit('0xabc')).toBe(true);
    });

    it('bounds its memory', () => {
        const clock = new TestClock(0);
        const limiter = new FixedWindowLimiter(1, 60_000, clock, 10);
        for (let i = 0; i < 100; i++) limiter.hit(`k${i}`);
        expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(11);
    });

    it('runs on the monotonic clock: a backward step of the wall clock does not keep a signer limited', () => {
        const clock = new TestClock(0);
        const limiter = new FixedWindowLimiter(1, 60_000, clock);
        expect(limiter.hit('0xabc')).toBe(true);
        expect(limiter.isLimited('0xabc')).toBe(true);
        clock.advance(-3600); // the wall clock steps back one hour
        expect(limiter.retryAfterSeconds('0xabc')).toBe(60);
        clock.advance(60);
        expect(limiter.isLimited('0xabc')).toBe(false);
        expect(limiter.hit('0xabc')).toBe(true);
    });
});

describe('monotonicMs', () => {
    it('reads the monotonic time: a backward step of the wall clock does not move it back (the caches, alert intervals and budgets measure on it)', () => {
        const clock = new TestClock(1_000_000);
        const start = monotonicMs(clock);
        clock.advance(-3600); // the wall clock steps back one hour
        expect(monotonicMs(clock)).toBe(start);
        clock.advance(2);
        expect(monotonicMs(clock)).toBe(start + 2000);
        expect(clock.nowMs()).toBe(1_000_000 - 3_598_000);
    });

    it('a clock without its own monotonic time falls back to performance.now, which never goes back', () => {
        let wall = 5_000_000;
        const plain = { nowMs: () => wall };
        const first = monotonicMs(plain);
        wall -= 3_600_000;
        expect(monotonicMs(plain)).toBeGreaterThanOrEqual(first);
    });
});
