// A used intent nonce is not proof that the request executed: the sender can burn the nonce with invalidateNonces. A
// request whose tx nonce another transaction of the relay key took, and whose sender invalidated the intent nonce,
// must end instead of staying `submitted` for good.
//
// When the chain passed a request's tx nonce and no receipt of its transactions is visible (a lagging receipt node, or
// another transaction of the key took the nonce), the relay waits RELAY_UNKNOWN_NONCE_GRACE_BLOCKS and then asks every
// RPC whether the intent nonce was used (relay/docs/transaction-lifecycle.md, "Nonces"). The signer can raise its
// nonce above the intent nonce without any relay call: invalidateNonces emits NonceInvalidated(signer, previousNonce,
// newNonce). If the relay took the used nonce for its own call's execution and kept waiting for the receipt, then with
// a foreign transaction on the tx nonce no receipt would ever appear: the request would stay submitted forever (also
// long after its deadline), keep the sender `sender_busy`, and make health() report the relay stalled.
//
// So with the intent nonce used and no receipt visible, each RPC locates the block that used the nonce and shows what
// in it did. A NonceInvalidated covering the nonce on every configured RPC means that the signer burnt the nonce
// before any execution (an invalidation covers only unused nonces): the request fails with nonce_used, provisional
// until settled on every RPC. The successful receipt of the relay's own call executing the request there makes it
// `mined` instead. A request whose tx nonce is used holds no in-flight slot while the decision waits, and a wait
// longer than RELAY_STUCK_AFTER_BLOCKS raises an ALERT.
import { afterEach, describe, expect, it } from 'vitest';
import { transferOperation } from '../../../src/operations/transfer.js';
import { RelayError } from '../../../src/errors.js';
import { USDC, buildTransfer, createHarness, type Harness } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('invalidated intent nonce + foreign transaction on the tx nonce', () => {
    it('the request ends (failed, nonce_used) after its deadline, the sender can submit again and the relay stays ready', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const t = await queue(h, { token: USDC, mode: 'permit', deadline: BigInt(h.clock.seconds() + 120) });
        await tick(h);
        expect(stateOf(h, t.id).status).toBe('submitted');

        // Another transaction of the relay key takes nonce 0 (the relay's call is gone), and the sender burns the
        // intent nonce with invalidateNonces: the request can never execute.
        h.chain.consumeNonce(RELAY_ADDRESS, 0);
        h.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        for (let i = 0; i < 200; i++) {
            h.chain.mine(); // 2 s per block: the deadline (120 s) passes after 60 blocks
            h.chain.finalized = h.chain.head.number - 64n;
            h.clock.advance(2);
            await tick(h);
        }
        // The sender tries again with a new permit after the deadline of the first request.
        let retry: string;
        try {
            retry = String((await h.relay.pipeline.submit(transferOperation, (await buildTransfer(h, { token: USDC, mode: 'permit' })).body)).statusCode);
        } catch (err) {
            if (!(err instanceof RelayError)) throw err;
            retry = err.code;
        }
        const status = stateOf(h, t.id).status;
        const outcome = {
            status,
            ended: status === 'failed' || status === 'expired',
            pastDeadline: h.chain.head.timestamp > BigInt(t.request.deadline),
            retry,
            health: h.relay.txManager.health().reasons.map((r) => r.split(':')[0]),
        };
        // The request ends (its intent nonce is burned and its transaction can never be mined); the sender can
        // submit again (no sender_busy); the relay is healthy.
        expect(outcome).toMatchObject({ ended: true, pastDeadline: true, retry: '202', health: [] });
        expect(stateOf(h, t.id).error?.code).toBe('nonce_used');
        const record = h.store.getRequest(t.id)!;
        expect(record.settledAtMs).not.toBeNull(); // final: the observation and the invalidation are 64 blocks deep
        expect(record.signature).toBeNull();
    });
});
