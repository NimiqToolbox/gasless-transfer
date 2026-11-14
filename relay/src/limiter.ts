import { monotonicMs, type Clock } from './clock.js';

/**
 * Fixed-window counter per key (used per signer). In-memory: the relay is a single process.
 * Also used relay-wide under one key (the submission limit). The windows run on the monotonic clock: a step of the wall
 * clock neither ends a window early nor keeps a signer limited longer.
 */
export class FixedWindowLimiter {
    private readonly windows = new Map<string, { start: number; count: number }>();

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly clock: Clock,
        private readonly maxKeys = 100_000,
    ) {}

    private now(): number {
        return monotonicMs(this.clock);
    }

    /** True while `key` has used up its window. Counts nothing. */
    isLimited(key: string): boolean {
        const window = this.windows.get(key.toLowerCase());
        if (!window || this.now() - window.start >= this.windowMs) return false;
        return window.count >= this.max;
    }

    /** Counts one hit for `key`; false once the key exceeded `max` hits in the current window. */
    hit(key: string): boolean {
        const now = this.now();
        const k = key.toLowerCase();
        let window = this.windows.get(k);
        if (!window || now - window.start >= this.windowMs) {
            window = { start: now, count: 0 };
            this.windows.set(k, window);
            if (this.windows.size > this.maxKeys) this.prune(now);
        }
        window.count += 1;
        return window.count <= this.max;
    }

    retryAfterSeconds(key: string): number {
        const window = this.windows.get(key.toLowerCase());
        if (!window) return 0;
        return Math.max(0, Math.ceil((window.start + this.windowMs - this.now()) / 1000));
    }

    private prune(now: number): void {
        for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
        // Still too many live keys: drop the oldest (Map keeps insertion order).
        for (const k of this.windows.keys()) {
            if (this.windows.size <= this.maxKeys) break;
            this.windows.delete(k);
        }
    }
}
