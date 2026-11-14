import { performance } from 'node:perf_hooks';

/**
 * Wall clock, injectable for tests. Deadlines of pending transactions use chain time instead.
 *
 * `monotonicMs` is a clock that only moves forward (performance.now in production): intervals that decide
 * something (the readiness cache, the liveness of the transaction manager, rate-limit windows, cool-downs, the fee
 * engine's cache, the Chainlink price source's cache and its alert intervals, the token domain ALERT repetition, the
 * read budget of a pass) are measured on it, so that a step of the wall clock (an NTP correction) neither freezes nor
 * shortens them. Its origin is arbitrary: only differences mean something. The wall clock
 * stays where its value matters: deadline policy, the staleness of a price round (its `updatedAt`), stored times and
 * freshness bars that compare with block timestamps.
 */
export interface Clock {
    nowMs(): number;
    monotonicMs?(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now(), monotonicMs: () => performance.now() };

export function nowSeconds(clock: Clock): number {
    return Math.floor(clock.nowMs() / 1000);
}

/** The clock's monotonic time; performance.now for a clock without one. */
export function monotonicMs(clock: Clock): number {
    return clock.monotonicMs ? clock.monotonicMs() : performance.now();
}
