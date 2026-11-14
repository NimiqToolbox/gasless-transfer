// A first broadcast that is answered "nonce too low" although the chain has NOT used that nonce must not leave a gap
// in the relay's tx nonces.
//
// The relay's next tx nonce only ever moves forward: the first attempt of a request at nonce N advances it to N+1
// (recordFirstAttempt). A broadcast can be classified `nonce_too_low` without the nonce being used: one RPC that
// misreports, or an error text that matches the broad pattern in classifyBroadcastError ("invalid nonce", "nonce has
// already been used", …). If the relay then gave up N and re-sent the request at N+1, nothing would ever use N: every
// later relay transaction (calls, speed-ups, cancels) would wait behind the gap, and a restart would not heal it.
//
// So "nonce too low" is no proof that the nonce is used: the attempt stays at its nonce and is re-sent while the chain
// has not used it (relay/docs/transaction-lifecycle.md, "Nonces").

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTransfer, createHarness, restartHarness, type Harness } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
});

afterEach(async () => {
    await h.close();
});

const post = (payload: unknown) => h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object });

describe('relay tx nonce gap', () => {
    it('one misreported "nonce too low" on a fresh nonce does not stall the relay (also not after a restart)', async () => {
        const first = await buildTransfer(h, { mode: 'permit' });
        expect((await post(first.body)).statusCode).toBe(202);
        await h.relay.txManager.recover();
        expect(h.store.getNextNonce()).toBe(0);

        // The node answers "nonce too low" once, although nonce 0 is unused on-chain.
        h.chain.forcedBroadcasts.push({ kind: 'nonce_too_low' });
        await h.relay.txManager.tick();
        // "nonce too low" is not proof that the nonce is used, so the request is not re-queued for another nonce:
        // the attempt stays at its nonce and is re-sent while the chain has not used it.
        expect(h.store.getRequest(first.id)?.status).toBe('submitted');
        const chainNonce = await h.chain.getTransactionCount(RELAY_ADDRESS, 'latest');
        expect(chainNonce).toBe(0);

        // Another user's request arrives meanwhile.
        const second = await buildTransfer(h, { mode: 'none', token: h.deployment.tokens[1]!.address, sender: 1 });
        h.chain.setAllowance(second.request.token, second.request.from, h.deployment.gaslessTransfer, 10n ** 12n);
        expect((await post(second.body)).statusCode).toBe(202);

        for (let i = 0; i < 30; i++) {
            await h.relay.txManager.tick();
            h.chain.mine();
        }
        expect.soft(h.store.getNextNonce(), 'stored next nonce vs. chain nonce').toBeLessThanOrEqual((await h.chain.getTransactionCount(RELAY_ADDRESS, 'latest')) + 2);

        // A restart must heal it at the latest.
        h = await restartHarness(h);
        await h.relay.txManager.recover();
        for (let i = 0; i < 30; i++) {
            await h.relay.txManager.tick();
            h.chain.mine();
        }
        const statuses = [first.id, second.id].map((id) => h.store.getRequest(id)?.status);
        expect(statuses, `next_tx_nonce=${h.store.getNextNonce()}, chain nonce=${await h.chain.getTransactionCount(RELAY_ADDRESS, 'latest')}`).toEqual([
            'mined',
            'mined',
        ]);
    });
});
