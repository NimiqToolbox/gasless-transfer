// A backlog of cheap, valid requests of one sender must not starve every other sender.
//
// The relay keeps at most RELAY_MAX_IN_FLIGHT − RELAY_RESERVED_PRIORITY_SLOTS (default 3) transfers in flight. A slot
// turns over about once per block, so the relay moves about 3 transfers per block. If the queue were served strictly
// in insertion order and nothing bounded what one sender may queue, a party that kept the queue fed above that rate
// with cheap requests (break-even fees paid to the relay, amounts sent to itself) would push every other request
// behind its backlog: wallets' requests would expire in the queue (`expired`, deadline_out_of_range) although they
// paid a normal quoted fee.
//
// Two rules prevent that. Within a priority the queue is served round-robin across senders (src/tx/policy.ts
// fairOrder), so one sender's backlog delays another sender's request by at most one round. And with sequential intent
// nonces a sender has at most one request queued or in flight (a second one is refused: its next nonce is not valid
// before the first executes, the same nonce conflicts), so one sender cannot build a backlog at all. The test asserts
// the second rule, and that a wallet's request is then mined before its deadline. What a party may queue across many
// senders is bounded by the queue bound and the sender rules of admission (heldEvictionUnfundedSender.test.ts,
// heldQueueFullPipeline.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { transferOperation } from '../../../src/operations/transfer.js';
import { RelayError } from '../../../src/errors.js';
import { CONTRACT, USDC, buildTransfer, createHarness, type Harness } from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('one sender cannot queue a backlog in front of other senders', () => {
    it('a second request of a sender is refused while its first is pending, and a wallet request with a 2-minute deadline is mined', { timeout: 60_000 }, async () => {
        h = await createHarness({ settings: { admission: { maxQueued: 1000 } } });
        await h.relay.txManager.recover();
        h.chain.setBalance(USDC, OTHER_ADDRESS, 10_000_000n);
        h.chain.setAllowance(USDC, OTHER_ADDRESS, CONTRACT, 10n ** 12n);
        const backlog = { key: OTHER_KEY, token: USDC, mode: 'none', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 7000) } as const;
        await queue(h, { ...backlog, amount: 1n });
        const refused: string[] = [];
        for (let i = 0; i < 20; i++) {
            // At the sender's next nonces (not valid before the first executes), and other versions at its nonce.
            const t = await buildTransfer(h, { ...backlog, amount: 2n + BigInt(i), ...(i % 2 === 0 ? { nonce: BigInt(1 + i / 2) } : {}) });
            refused.push(await h.relay.pipeline.submit(transferOperation, t.body).then((r) => String(r.statusCode), (err: unknown) => (err instanceof RelayError ? err.code : String(err))));
        }
        expect(new Set(refused)).toEqual(new Set(['nonce_too_high', 'conflict']));
        expect(h.store.countByStatus('queued')).toBe(1);
        // A wallet's transfer with a normal quote (0.01 USD) and a two-minute deadline.
        const wallet = await queue(h, { token: USDC, mode: 'permit', fee: 10_000n, deadline: BigInt(h.clock.seconds() + 120) });
        for (let block = 0; block < 90 && ['queued', 'submitted'].includes(stateOf(h, wallet.id).status); block++) {
            await tick(h);
            h.chain.mine(); // every transaction in flight is included in the next block
            h.clock.advance(2);
        }
        await tick(h);
        expect(stateOf(h, wallet.id).status).toBe('mined');
    });
});
