// What one sender may do with the queue (src/pipeline/senderAdmission.ts): after a failure it caused, one request
// queued or in flight at a time for RELAY_PREFLIGHT_COOLDOWN_SECONDS; and the right to make a request held at its
// spend cap give way in a full queue: one at a time per sender, and none while it cools down. The pipeline tests
// (pipeline.test.ts) show both rules end to end.
//
// The rules key on the sender (the signed `from`), never on a network address. Whether a cooling sender has a request
// queued or in flight is the pipeline's check (store.admissionCounts); SenderAdmission only reports the rest of the
// cool-down.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { SenderAdmission } from '../../src/pipeline/senderAdmission.js';
import { TestClock } from '../helpers/harness.js';

const id = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const sender = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
const A = sender(0xa1);
const B = sender(0xb2);

function setup(settings: { preflightCooldownMs?: number } = {}, maxTracked = 1000) {
    const clock = new TestClock(1_000_000);
    const queued = new Set<string>();
    /** Requests of which a transaction was stored (sent at least once). */
    const sent = new Set<string>();
    const admission = new SenderAdmission(
        { preflightCooldownMs: settings.preflightCooldownMs ?? 600_000 },
        clock,
        { awaitsFirstBroadcast: (requestId) => queued.has(requestId.toLowerCase()) && !sent.has(requestId.toLowerCase()) },
        maxTracked,
    );
    let next = 0;
    /** Stores a queued request of `from` that took the place of a held request (as the pipeline does). */
    const admitEvicting = (from: string): Hex => {
        const requestId = id(++next);
        queued.add(requestId);
        admission.evicted(from, requestId);
        return requestId;
    };
    /** The request left the queue (sent, failed or expired). */
    const leave = (requestId: Hex): void => void queued.delete(requestId.toLowerCase());
    /** The request was sent: its first transaction is stored, and it is in flight. */
    const send = (requestId: Hex): void => {
        sent.add(requestId.toLowerCase());
        leave(requestId);
    };
    /** A sent request is queued again (another transaction took its tx nonce: requeued). */
    const requeue = (requestId: Hex): void => void queued.add(requestId.toLowerCase());
    return { clock, admission, admitEvicting, leave, send, requeue };
}

describe('SenderAdmission: the cool-down after a failure its sender caused (RELAY_PREFLIGHT_COOLDOWN_SECONDS)', () => {
    it('puts the sender on the cool-down for the configured period, in whole seconds; other senders are not affected', () => {
        const { clock, admission } = setup({ preflightCooldownMs: 600_000 });
        expect(admission.cooldownSeconds(A)).toBe(0);
        expect(admission.senderFailed(A)).toBe(true);
        expect(admission.cooldownSeconds(A)).toBe(600);
        clock.advance(100);
        expect(admission.cooldownSeconds(A)).toBe(500);
        // Another sender keeps its rights.
        expect(admission.cooldownSeconds(B)).toBe(0);
        // After the period, none.
        clock.advance(500);
        expect(admission.cooldownSeconds(A)).toBe(0);
    });

    it('keys on the address, whatever its case', () => {
        const { admission } = setup();
        admission.senderFailed(A.toUpperCase().replace('0X', '0x'));
        expect(admission.cooldownSeconds(A.toLowerCase())).toBe(600);
    });

    it('a later failure restarts the period', () => {
        const { clock, admission } = setup({ preflightCooldownMs: 600_000 });
        admission.senderFailed(A);
        clock.advance(500);
        admission.senderFailed(A);
        clock.advance(500);
        expect(admission.cooldownSeconds(A)).toBe(100);
    });

    it('runs on the monotonic clock: a backward step of the wall clock does not make it longer', () => {
        const { clock, admission } = setup({ preflightCooldownMs: 60_000 });
        admission.senderFailed(A);
        clock.advance(-3600); // the wall clock steps back one hour
        clock.advance(61);
        expect(admission.cooldownSeconds(A)).toBe(0);
    });

    it('does nothing when turned off (0)', () => {
        const off = setup({ preflightCooldownMs: 0 });
        expect(off.admission.senderFailed(A)).toBe(false);
        expect(off.admission.cooldownSeconds(A)).toBe(0);
        expect(off.admission.mayEvict(A)).toBe(true);
    });
});

describe('SenderAdmission: making a held request give way, one at a time per sender', () => {
    it('a sender whose request took a held place may make another give way only once that request was sent', () => {
        const { admission, admitEvicting, send } = setup();
        expect(admission.mayEvict(A)).toBe(true);
        const first = admitEvicting(A);
        expect(admission.mayEvict(A)).toBe(false);
        // Control: other senders are not affected.
        expect(admission.mayEvict(B)).toBe(true);
        send(first);
        expect(admission.mayEvict(A)).toBe(true);
        const second = admitEvicting(A);
        expect(admission.mayEvict(A)).toBe(false);
        send(second);
        expect(admission.mayEvict(A)).toBe(true);
    });

    it('also once that request left the queue unsent (failed or expired for a reason its sender does not control, or it gave way itself)', () => {
        const { admission, admitEvicting, leave } = setup();
        const evicting = admitEvicting(A);
        expect(admission.mayEvict(A)).toBe(false);
        leave(evicting);
        expect(admission.mayEvict(A)).toBe(true);
    });

    it('a request that was sent and then requeued (another transaction took its tx nonce) does not withhold it: it was sent', () => {
        const { admission, admitEvicting, send, requeue } = setup();
        const evicting = admitEvicting(A);
        send(evicting);
        requeue(evicting);
        expect(admission.mayEvict(A)).toBe(true);
    });

    it('not at all while the sender cools down, even without a queued request; again after the period', () => {
        const { clock, admission, admitEvicting, leave } = setup({ preflightCooldownMs: 600_000 });
        const evicting = admitEvicting(A);
        leave(evicting); // its check failed: its sender moved the funds away
        expect(admission.senderFailed(A)).toBe(true);
        expect(admission.mayEvict(A)).toBe(false);
        clock.advance(599);
        expect(admission.mayEvict(A)).toBe(false);
        clock.advance(1);
        expect(admission.mayEvict(A)).toBe(true);
        // A cool-down started by a request that took no held place withholds it too.
        const C = sender(0xc3);
        admission.senderFailed(C);
        expect(admission.mayEvict(C)).toBe(false);
        // Control: another sender may.
        expect(admission.mayEvict(B)).toBe(true);
    });

    it('the cool-down runs on the monotonic clock here too: a backward step of the wall clock does not extend it', () => {
        const { clock, admission } = setup({ preflightCooldownMs: 60_000 });
        admission.senderFailed(A);
        clock.advance(-3600);
        expect(admission.mayEvict(A)).toBe(false);
        clock.advance(61);
        expect(admission.mayEvict(A)).toBe(true);
    });

    it('with the cool-down off (0), the right comes back once the request that took a held place left the queue', () => {
        const { admission, admitEvicting, leave } = setup({ preflightCooldownMs: 0 });
        const evicting = admitEvicting(A);
        leave(evicting);
        expect(admission.senderFailed(A)).toBe(false);
        expect(admission.mayEvict(A)).toBe(true);
    });
});

describe('SenderAdmission: memory', () => {
    it('forgets ended cool-downs once it tracks more than its bound; keeps those that run', () => {
        const { clock, admission } = setup({ preflightCooldownMs: 60_000 }, 10);
        const cooling = (admission as unknown as { cooldownUntil: Map<string, number> }).cooldownUntil;
        for (let i = 0; i < 100; i++) {
            admission.senderFailed(sender(i + 1));
            clock.advance(61);
        }
        expect(cooling.size).toBeLessThanOrEqual(11);
        // A running cool-down is kept.
        admission.senderFailed(A);
        for (let i = 0; i < 30; i++) admission.senderFailed(sender(1000 + i));
        expect(cooling.has(A.toLowerCase())).toBe(true);
        expect(admission.cooldownSeconds(A)).toBe(60);
    });

    it('forgets the requests that took a held place once they were sent or left the queue; keeps those that wait', () => {
        const { admission, admitEvicting, send } = setup({}, 10);
        for (let i = 0; i < 100; i++) send(admitEvicting(sender(i + 1)));
        const evictors = (admission as unknown as { evictorOf: Map<string, string> }).evictorOf;
        expect(evictors.size).toBeLessThanOrEqual(11);
        const waiting = admitEvicting(A);
        for (let i = 0; i < 30; i++) send(admitEvicting(sender(200 + i)));
        expect(evictors.get(A.toLowerCase())).toBe(waiting);
        expect(admission.mayEvict(A)).toBe(false);
    });
});
