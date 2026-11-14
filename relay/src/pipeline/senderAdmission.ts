// Per-sender cool-down and held-request displacement.
// The relay does not tell clients apart by network address: it neither uses nor keeps IP addresses. These rules key
// on the sender, the signed `from` of a request.
// A request whose check before the broadcast failed for a reason its sender controls (funds, allowance, token
// authorization, intent nonce) puts that sender on a cool-down: until it ends, a further submission of the sender is
// refused before any RPC read while it has a request queued or in flight (every sender has at most one; without the
// cool-down step 7 refuses it after the reads). A sender can make only one held request give way at a time, and none
// during its cool-down; it becomes
// eligible again once the request that took the held place was broadcast or left the queue. Parties with many funded
// senders can still fill the global queue. State is in memory only; a restart resets it.
import type { Hex } from 'viem';
import { monotonicMs, type Clock } from '../clock.js';

export interface SenderAdmissionSettings {
    /** RELAY_PREFLIGHT_COOLDOWN_SECONDS in ms; 0 turns the cool-down off. */
    readonly preflightCooldownMs: number;
}

/** What SenderAdmission reads about the requests it tracks (the store's state; relay.ts wires it). */
export interface TrackedRequests {
    /** The request waits for its first broadcast: it is queued and nothing of it was ever sent. */
    awaitsFirstBroadcast(id: Hex): boolean;
}

export class SenderAdmission {
    /** End of each sender's cool-down (lowercase address), on the monotonic clock. */
    private readonly cooldownUntil = new Map<string, number>();
    /**
     * Each sender's last request that took the place of a held request (lowercase id). Forgotten once it no longer
     * waits for its first broadcast (it was sent, or it left the queue).
     */
    private readonly evictorOf = new Map<string, string>();

    /**
     * @param maxTracked tracked senders before a sweep forgets ended cool-downs and sent replacements.
     */
    constructor(
        private readonly settings: SenderAdmissionSettings,
        private readonly clock: Clock,
        private readonly requests: TrackedRequests,
        private readonly maxTracked: number,
    ) {}

    /** The rest of `sender`'s cool-down in whole seconds (0: none). */
    cooldownSeconds(sender: string): number {
        return Math.ceil(this.cooldownLeftMs(sender.toLowerCase()) / 1000);
    }

    /**
     * Whether a new request of `sender` may take the place of a queued request held at its spend cap in a full
     * queue. Not while `sender` cools down, and not while its last request that took a held request's place waits for
     * its first broadcast.
     */
    mayEvict(sender: string): boolean {
        const key = sender.toLowerCase();
        if (this.cooldownLeftMs(key) > 0) return false;
        const id = this.evictorOf.get(key);
        if (id === undefined) return true;
        if (this.requests.awaitsFirstBroadcast(id as Hex)) return false;
        this.evictorOf.delete(key);
        return true;
    }

    /** `sender`'s stored request `id` took the place of a queued request held at its spend cap. */
    evicted(sender: string, id: Hex): void {
        this.evictorOf.set(sender.toLowerCase(), id.toLowerCase());
        if (this.evictorOf.size > this.maxTracked) this.sweep();
    }

    /**
     * A request of `sender` failed its check before the broadcast for a reason its sender controls: the sender cools
     * down (a later failure restarts the period). False if the cool-down is off.
     */
    senderFailed(sender: string): boolean {
        if (this.settings.preflightCooldownMs === 0) return false;
        this.cooldownUntil.set(sender.toLowerCase(), monotonicMs(this.clock) + this.settings.preflightCooldownMs);
        if (this.cooldownUntil.size > this.maxTracked) this.sweep();
        return true;
    }

    /** The rest of the cool-down of `key` (lowercase) in ms (0: none); forgets one that ended. */
    private cooldownLeftMs(key: string): number {
        const until = this.cooldownUntil.get(key);
        if (until === undefined) return 0;
        const left = until - monotonicMs(this.clock);
        if (left > 0) return left;
        this.cooldownUntil.delete(key);
        return 0;
    }

    /** Forgets every ended cool-down and every replacement that no longer waits for its first broadcast. */
    private sweep(): void {
        const now = monotonicMs(this.clock);
        for (const [key, until] of [...this.cooldownUntil]) if (until <= now) this.cooldownUntil.delete(key);
        for (const [key, id] of [...this.evictorOf]) if (!this.requests.awaitsFirstBroadcast(id as Hex)) this.evictorOf.delete(key);
    }
}
