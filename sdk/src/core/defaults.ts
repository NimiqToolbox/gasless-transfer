// SDK defaults separate from the pinned protocol constants (constants.ts).

/**
 * Decimals every pinned token must have: MIN_FEE, FEE_GRANULARITY (0.01) and the relay's fee engine, which counts
 * USDC and USDT0 as $1 (§6.4), are in units of a 6-decimal USD token.
 */
export const FEE_TOKEN_DECIMALS = 6;

/**
 * Default lifetime of a transfer intent (and of its permit) when the caller gives no deadline:
 * 10 minutes, well inside the relay window of 60–7200 s (§6.3) and short enough that an unsent or
 * withheld request stops being executable soon.
 */
export const DEFAULT_DEADLINE_SECONDS = 600;
