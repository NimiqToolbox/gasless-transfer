import type { Address, Hex } from 'viem';
import { readTokenDomainSeparator } from '../chain/reads.js';
import type { ChainClient } from '../chain/types.js';
import { monotonicMs, type Clock } from '../clock.js';
import type { DeploymentToken } from '../config.js';
import { hashDomain } from '../eip712.js';
import { serializeError, type Logger } from '../logger.js';
import type { RelayMetrics } from '../metrics.js';
import type { TokenDomainStatus } from '../operations/types.js';

/** Minimum interval between repeated ALERT lines while a mismatch persists (monotonic clock). */
const ALERT_REPEAT_MS = 300_000;

interface TokenState {
    readonly symbol: string;
    readonly address: Address;
    /** keccak256 of the configured domain (what startup verification compared with). */
    readonly expected: Hex;
    mismatch: boolean;
    /** Monotonic time of the last ALERT line: a step of the system clock neither silences nor repeats it early. */
    lastAlertMonoMs: number;
}

export interface TokenDomainReport {
    /** False while any token's on-chain domain differs from the configuration. */
    readonly ok: boolean;
    /** Symbols of those tokens. */
    readonly mismatched: string[];
    readonly lastCheckAtMs: number | null;
    readonly lastError: string | null;
}

export interface TokenDomainMonitorOptions {
    readonly chain: ChainClient;
    readonly tokens: readonly Pick<DeploymentToken, 'symbol' | 'address' | 'domain'>[];
    readonly clock: Clock;
    readonly logger: Logger;
    readonly metrics?: RelayMetrics | undefined;
}

/** A token's on-chain `DOMAIN_SEPARATOR()`, as startup verification read it. */
export interface TokenDomainReading {
    readonly address: Address;
    readonly domainSeparator: Hex;
}

/**
 * Re-reads every configured token's `DOMAIN_SEPARATOR()` while the relay runs. USDT0's admin can
 * rename the token (`changeName`), which replaces its EIP-712 domain: from then on no permit or
 * meta-transaction signed for the configured domain can succeed on-chain. While the domains differ, the
 * relay refuses that token's PERMIT and META_TX_APPROVE requests and quotes with `unsupported_auth_mode`
 * and a clear message (NONE mode keeps working), reports itself degraded in /readyz, sets
 * `relay_token_domain_mismatch{token}` to 1 and logs an ALERT. A later check that matches again clears the
 * state. A failed read keeps the last state.
 *
 * Startup verification reads the same values once; `record()` applies them, so a relay that
 * restarts after a rename starts in exactly this state instead of refusing to start.
 */
export class TokenDomainMonitor implements TokenDomainStatus {
    private readonly states: Map<string, TokenState>;
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    private checking: Promise<void> | undefined;
    private lastCheckAtMs: number | null = null;
    private lastError: string | null = null;

    constructor(private readonly options: TokenDomainMonitorOptions) {
        this.states = new Map(
            options.tokens.map((t): [string, TokenState] => [
                t.address.toLowerCase(),
                { symbol: t.symbol, address: t.address, expected: hashDomain(t.domain), mismatch: false, lastAlertMonoMs: Number.NEGATIVE_INFINITY },
            ]),
        );
        for (const state of this.states.values()) options.metrics?.tokenDomainMismatch.set({ token: state.symbol }, 0);
    }

    tokenSignaturesUnavailable(token: Address): string | undefined {
        const state = this.states.get(token.toLowerCase());
        if (!state?.mismatch) return undefined;
        return (
            `${state.symbol} permit and meta-transaction authorizations are unavailable: the token's EIP-712 domain ` +
            `(DOMAIN_SEPARATOR) changed on-chain and no longer matches this relay's configuration. ` +
            'Use authorization mode "none", or try again once the relay has been updated.'
        );
    }

    status(): TokenDomainReport {
        const mismatched = [...this.states.values()].filter((s) => s.mismatch).map((s) => s.symbol);
        return { ok: mismatched.length === 0, mismatched, lastCheckAtMs: this.lastCheckAtMs, lastError: this.lastError };
    }

    /**
     * Applies readings taken elsewhere, as a check would: startup verification's reads of every token's
     * `DOMAIN_SEPARATOR()`. Readings of unknown tokens are ignored.
     */
    record(readings: readonly TokenDomainReading[]): void {
        const { clock } = this.options;
        const mono = monotonicMs(clock);
        for (const reading of readings) {
            const state = this.states.get(reading.address.toLowerCase());
            if (state) this.apply(state, reading.domainSeparator, mono);
        }
        this.lastCheckAtMs = clock.nowMs();
    }

    /** `monoNow`: the monotonic time of the reading (for the ALERT repeat interval). */
    private apply(state: TokenState, domainSeparator: Hex, monoNow: number): void {
        const { logger, metrics } = this.options;
        const onchain = domainSeparator.toLowerCase();
        const mismatch = onchain !== state.expected.toLowerCase();
        if (mismatch && (!state.mismatch || monoNow - state.lastAlertMonoMs >= ALERT_REPEAT_MS)) {
            state.lastAlertMonoMs = monoNow;
            logger.error(
                { alert: 'token_domain_mismatch', token: state.symbol, address: state.address, configured: state.expected, onchain },
                'ALERT: token DOMAIN_SEPARATOR() no longer matches the configured domain; its permit and meta-tx requests are refused until the deployment file is updated',
            );
        } else if (!mismatch && state.mismatch) {
            logger.warn({ token: state.symbol, address: state.address }, 'token DOMAIN_SEPARATOR() matches the configured domain again');
        }
        state.mismatch = mismatch;
        metrics?.tokenDomainMismatch.set({ token: state.symbol }, mismatch ? 1 : 0);
    }

    /** Checks every `intervalMs` (the first check after one interval: startup verification just ran). */
    start(intervalMs: number): void {
        if (this.running || intervalMs <= 0) return;
        this.running = true;
        const loop = (): void => {
            if (!this.running) return;
            this.timer = setTimeout(() => {
                void this.check().finally(loop);
            }, intervalMs);
        };
        loop();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        await this.checking;
    }

    /** One pass over all tokens; never rejects. Concurrent calls share the running pass. */
    check(): Promise<void> {
        this.checking ??= this.run().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }

    private async run(): Promise<void> {
        const { chain, clock, logger, metrics } = this.options;
        const states = [...this.states.values()];
        const reads = await Promise.allSettled(states.map((s) => readTokenDomainSeparator(chain, s.address)));
        const mono = monotonicMs(clock);
        const failed: string[] = [];
        reads.forEach((read, i) => {
            const state = states[i]!;
            if (read.status === 'rejected') {
                failed.push(state.symbol);
                this.lastError = String(serializeError(read.reason).message ?? 'error').slice(0, 200);
                metrics?.monitorErrors.inc({ monitor: 'token_domain' });
                return;
            }
            this.apply(state, read.value, mono);
        });
        if (failed.length === 0) this.lastError = null;
        else logger.warn({ tokens: failed, error: this.lastError }, 'token DOMAIN_SEPARATOR() check failed; keeping the last state');
        this.lastCheckAtMs = clock.nowMs();
    }
}
