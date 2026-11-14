// The per-signer rate limit (relay/src/pipeline/pipeline.ts) cannot be used up by someone who has seen one of the
// victim's signed intents.
//
// A relayed transfer makes the intent and its signature public: anyone can copy them from the mempool or the chain
// (relayTransfer calldata). If a third party could re-post that intent in a form that the relay counts against the
// signer's quota, the victim's next, fresh submission would be refused with 429 rate_limited: a lock-out that needs no
// key of the victim.
//
// GaslessTransfer signs the token authorization with the intent (the nested TokenAuth): a re-post with another
// authorization fails the signature check (invalid_signature, before any chain read or count), and the re-post with
// the authorization from the calldata is the identical request (answered from the store). The per-signer limit is
// checked after the signature check and charged only after the nonce step (docs/STEP-1-GAS-ABSTRACTION.md §6.3). The
// tests below assert that neither re-post counts, with the production defaults (10 submissions/min per signer, 120/min
// relay-wide).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, parseTransaction, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { SubmitTransferBody } from '@nimiq/gasless-sdk/relay';
import { buildTransfer, createHarness, USDC, USDT0, type Harness } from '../../helpers/harness.js';

// The production defaults: a limit per signer, and a relay-wide one for submissions that read the chain
// (RELAY_RATE_LIMIT_SUBMIT_MAX, 120 per minute). The client addresses below only name the parties; the relay ignores them.
const PRODUCTION_LIMITS = { signerMax: 10, signerWindowMs: 60_000, submitMax: 120, submitWindowMs: 60_000 };
const VICTIM_IP = '198.51.100.7';
const ATTACKER_IP = '203.0.113.66';
const MODE_NAMES = ['none', 'permit', 'metaTxApprove'] as const;

let h: Harness;

beforeEach(async () => {
    h = await createHarness({ settings: { rateLimit: PRODUCTION_LIMITS } });
});

afterEach(async () => {
    await h.close();
});

const post = (payload: unknown, remoteAddress: string) =>
    h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object, remoteAddress });

/**
 * What any observer of the relay's transaction sees: the relayTransfer calldata (the request without its intent nonce,
 * the signature and the signed token authorization), and the signer's nonce from the chain (`nonces(from)` while the
 * call is pending).
 */
function intentFromBroadcast(raw: Hex, nonce: bigint): SubmitTransferBody {
    const tx = parseTransaction(raw);
    const { functionName, args } = decodeFunctionData({ abi: gaslessTransferAbi, data: tx.data! });
    if (functionName !== 'relayTransfer') throw new Error('not a relayTransfer');
    const [r, signature, auth] = args;
    return {
        request: {
            token: r.token,
            from: r.from,
            to: r.to,
            amount: r.amount.toString(),
            fee: r.fee.toString(),
            relay: r.relay,
            nonce: nonce.toString(),
            deadline: r.deadline.toString(),
        },
        signature,
        authorization: { mode: MODE_NAMES[auth.mode]!, v: auth.v, r: auth.r, s: auth.s },
    };
}

/** A different, syntactically valid authorization each time (not the one the intent signature covers). */
function junkAuthorization(i: number): SubmitTransferBody['authorization'] {
    const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
    return { mode: 'permit', v: 27, r: word(1000 + i), s: word(2000 + i) };
}

const codeOf = (res: Awaited<ReturnType<typeof post>>): string => (res.json() as { error?: { code: string } }).error?.code ?? String(res.statusCode);

describe('per-signer quota vs. replayed public intents', () => {
    it("a third party cannot lock a victim out by replaying the victim's broadcast intent", async () => {
        // 1. The victim sends a transfer; the relay broadcasts it, which makes intent + signature public.
        const first = await buildTransfer(h, { mode: 'permit' });
        expect((await post(first.body, VICTIM_IP)).statusCode).toBe(202);
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(1);
        const observed = intentFromBroadcast(h.chain.broadcasts[0]!, h.chain.intentNonce(first.request.from));
        expect(observed).toEqual(first.body);

        // 2. The attacker (own IP, no key of the victim) re-posts the public intent with junk authorizations: the
        //    intent signature covers the authorization, so each fails the signature check; the exact copy is the
        //    victim's own request, answered from the store.
        const attackerCodes = new Set<string>();
        for (let i = 0; i < 3 * PRODUCTION_LIMITS.signerMax; i++) {
            attackerCodes.add(codeOf(await post({ ...observed, authorization: junkAuthorization(i) }, ATTACKER_IP)));
        }
        expect(attackerCodes).toEqual(new Set(['invalid_signature']));
        expect((await post(observed, ATTACKER_IP)).statusCode).toBe(200);

        // 3. None of it counted against the victim's per-signer quota: once the first transfer is mined, the victim's
        //    next one (its next nonce, correctly signed, from its own IP) is accepted.
        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(first.id)?.status).toBe('mined');
        const second = await buildTransfer(h, { mode: 'none', token: USDT0 });
        h.chain.setAllowance(USDT0, second.body.request.from, h.relay.ctx.contracts.transfer, 10n ** 12n);
        const res = await post(second.body, VICTIM_IP);
        expect(res.json()).toEqual({ id: second.id, status: 'queued' });
        expect(res.statusCode).toBe(202);
    });

    it('no lock-out lever for the whole deadline window, also after the intent was mined', async () => {
        const first = await buildTransfer(h, { mode: 'permit', deadline: BigInt(h.clock.seconds() + 7200) });
        expect((await post(first.body, VICTIM_IP)).statusCode).toBe(202);
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        const observed = intentFromBroadcast(h.chain.broadcasts[0]!, h.chain.intentNonce(first.request.from));
        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(first.id)?.status).toBe('mined');

        // One hour later (new rate-limit window) the attacker replays: every junk authorization fails the signature
        // check, and the exact copy is answered from the store.
        h.clock.advance(3600);
        // The relay kept running meanwhile: a pass on a current head (without one for an hour, it would refuse every
        // new request).
        h.chain.mine({ timestampDelta: 3600 });
        await h.relay.txManager.tick();
        const codes = new Set<string>();
        for (let i = 0; i < PRODUCTION_LIMITS.signerMax; i++) codes.add(codeOf(await post({ ...observed, authorization: junkAuthorization(i) }, ATTACKER_IP)));
        expect(codes).toEqual(new Set(['invalid_signature']));
        expect((await post(observed, ATTACKER_IP)).statusCode).toBe(200);

        const next = await buildTransfer(h, { mode: 'permit' });
        const res = await post(next.body, VICTIM_IP);
        expect((res.json() as { error?: { code: string } }).error?.code).toBeUndefined();
        expect(res.statusCode).toBe(202);
    });

    it('control: identical re-posts (same authorization) are answered idempotently and do not count', async () => {
        const first = await buildTransfer(h, { mode: 'permit' });
        expect((await post(first.body, VICTIM_IP)).statusCode).toBe(202);
        for (let i = 0; i < 3 * PRODUCTION_LIMITS.signerMax; i++) {
            expect((await post(first.body, ATTACKER_IP)).statusCode).toBe(200);
        }
        const second = await buildTransfer(h, { mode: 'none' });
        h.chain.setAllowance(USDC, second.body.request.from, h.relay.ctx.contracts.transfer, 10n ** 12n);
        // conflict (another version at the pending request's nonce) is the expected answer here, not rate_limited.
        const res = await post(second.body, VICTIM_IP);
        expect((res.json() as { error: { code: string } }).error.code).toBe('conflict');
    });
});
