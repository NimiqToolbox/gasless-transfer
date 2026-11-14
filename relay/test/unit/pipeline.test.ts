import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, getAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LEGACY_NIMIQ_CONTRACTS_POLYGON, POLYGON_USDT0, gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { ErrorCode } from '@nimiq/gasless-sdk/relay';
import type { CallParams, ReadContractCall } from '../../src/chain/types.js';
import { DEFAULT_HTTP_LIMITS } from '../../src/config.js';
import { RelayError } from '../../src/errors.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { GWEI } from '../helpers/fakeChain.js';
import {
    CONTRACT,
    NO_AUTH,
    USDC,
    USDT0,
    buildTransfer,
    createHarness,
    senderKey,
    signTransferRequest,
    toHighS,
    transferDomainLiteral,
    type Harness,
    type TransferOptions,
} from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, RECIPIENT_ADDRESS, RELAY_ADDRESS, USER_ADDRESS, USER_KEY } from '../helpers/keys.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
});

afterEach(async () => {
    await h.close();
});

const submit = (body: unknown) => h.relay.pipeline.submit(transferOperation, body);

async function rejection(body: unknown): Promise<RelayError> {
    try {
        await submit(body);
    } catch (err) {
        if (err instanceof RelayError) return err;
        throw err;
    }
    throw new Error('expected the submission to be rejected');
}

async function expectCode(body: unknown, code: ErrorCode): Promise<RelayError> {
    const err = await rejection(body);
    expect(err.code).toBe(code);
    return err;
}

async function transfer(o: TransferOptions = {}) {
    return buildTransfer(h, o);
}

const FAILED = { status: 'failed', error: { code: 'simulation_failed', message: 'x' } } as const;
/** Ends a queued request (failed, settled at once): its sender may submit at its nonce again. */
const end = (id: Hex) => h.store.finalize(id, FAILED, undefined, h.clock.nowMs());

describe('accepted submissions', () => {
    it.each([
        ['USDC', 'permit'],
        ['USDC', 'none'],
        ['USDT0', 'permit'],
        ['USDT0', 'metaTxApprove'],
        ['USDT0', 'none'],
    ] as const)('%s with %s is queued with id = EIP-712 digest', async (symbol, mode) => {
        const token = symbol === 'USDC' ? USDC : USDT0;
        if (mode === 'none') h.chain.setAllowance(token, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const { body, id } = await transfer({ token, mode });
        const result = await submit(body);
        expect(result).toEqual({ statusCode: 202, body: { id, status: 'queued' } });
        const stored = h.store.getRequest(id);
        expect(stored?.status).toBe('queued');
        expect(stored?.request).toEqual(body.request);
    });

    it('never takes a target, calldata or gas from the client: it encodes relayTransfer itself', async () => {
        const { body } = await transfer({ mode: 'permit' });
        for (const extra of [{ to: OTHER_ADDRESS }, { data: '0x1234' }, { gas: '1000000' }, { target: OTHER_ADDRESS }]) {
            await expectCode({ ...body, ...extra }, 'invalid_request');
        }
        await submit(body);
        expect(h.chain.calls).toHaveLength(1);
        const call = h.chain.calls[0]!;
        expect(call.from).toBe(RELAY_ADDRESS);
        expect(call.to).toBe(CONTRACT);
        const decoded = decodeFunctionData({ abi: gaslessTransferAbi, data: call.data });
        expect(decoded.functionName).toBe('relayTransfer');
        const [request, signature, auth] = decoded.args as unknown as [
            Record<string, unknown>,
            Hex,
            { mode: number; v: number; r: Hex; s: Hex },
        ];
        // The 7 call-data fields: the contract takes the intent nonce from nonces(from).
        expect(request).toEqual({
            token: body.request.token,
            from: body.request.from,
            to: body.request.to,
            amount: BigInt(body.request.amount),
            fee: BigInt(body.request.fee),
            relay: body.request.relay,
            deadline: BigInt(body.request.deadline),
        });
        expect(signature).toBe(body.signature.toLowerCase());
        expect(auth).toEqual({ mode: 1, v: body.authorization.v, r: body.authorization.r, s: body.authorization.s });
    });

    it('encodes mode NONE with zero v/r/s', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const { body } = await transfer({ mode: 'none' });
        await submit(body);
        const decoded = decodeFunctionData({ abi: gaslessTransferAbi, data: h.chain.calls[0]!.data });
        expect(decoded.args[2]).toEqual({ mode: 0, v: 0, r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}` });
    });
});

describe('T31: step 1: strict schema → invalid_request', () => {
    it('rejects non-object bodies', async () => {
        for (const body of [null, [], 'x', 1, true, undefined]) await expectCode(body, 'invalid_request');
    });

    it('rejects unknown fields at every level', async () => {
        const { body } = await transfer();
        await expectCode({ ...body, extra: 1 }, 'invalid_request');
        await expectCode({ ...body, request: { ...body.request, extra: 1 } }, 'invalid_request');
        await expectCode({ ...body, authorization: { ...body.authorization, extra: 1 } }, 'invalid_request');
        const none = await transfer({ mode: 'none' });
        await expectCode({ ...none.body, authorization: { mode: 'none', v: 27 } }, 'invalid_request');
        await expectCode({ ...none.body, authorization: { mode: 'none' } }, 'invalid_request');
    });

    it('mode "none" must carry v 0 and zero r, s (the values the intent signs)', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const nonzero: Array<Partial<typeof NO_AUTH>> = [{ v: 27 }, { r: `0x${'00'.repeat(31)}01` }, { s: `0x${'00'.repeat(31)}01` }];
        for (const change of nonzero) {
            // Signed over exactly these values: refused by the schema, not by the signature check.
            const t = await transfer({ mode: 'none', authorization: { ...NO_AUTH, ...change } });
            const err = await expectCode(t.body, 'invalid_request');
            expect(err.message).toContain('mode "none" must have v 0 and r, s zero');
        }
        expect((await submit((await transfer({ mode: 'none' })).body)).statusCode).toBe(202);
    });

    it('rejects missing fields', async () => {
        const { body } = await transfer();
        for (const field of Object.keys(body.request)) {
            const request: Record<string, unknown> = { ...body.request };
            delete request[field];
            await expectCode({ ...body, request }, 'invalid_request');
        }
        for (const field of ['request', 'signature', 'authorization']) {
            const b: Record<string, unknown> = { ...body };
            delete b[field];
            await expectCode(b, 'invalid_request');
        }
        await expectCode({ ...body, authorization: { mode: 'permit', v: 27, r: body.authorization.r } }, 'invalid_request');
    });

    it('requires canonical decimal strings for uint256 fields', async () => {
        const { body } = await transfer();
        const bad = ['01', '1e6', '-1', '1.0', ' 1', '1 ', '', '0x10', '+1', (2n ** 256n).toString()];
        for (const field of ['amount', 'fee', 'nonce', 'deadline']) {
            for (const value of bad) await expectCode({ ...body, request: { ...body.request, [field]: value } }, 'invalid_request');
            await expectCode({ ...body, request: { ...body.request, [field]: 1_000_000 } }, 'invalid_request');
        }
    });

    it('requires EIP-55 checksummed addresses', async () => {
        const { body } = await transfer();
        for (const field of ['token', 'from', 'to', 'relay']) {
            const value = (body.request as unknown as Record<string, string>)[field]!;
            await expectCode({ ...body, request: { ...body.request, [field]: value.toLowerCase() } }, 'invalid_request');
            await expectCode({ ...body, request: { ...body.request, [field]: value.slice(0, 41) } }, 'invalid_request');
        }
    });

    it('rejects a hex nonce, malformed signature hex, authorization and quoteId', async () => {
        const { body } = await transfer();
        // A bytes32 hex nonce is not a uint256 decimal string.
        await expectCode({ ...body, request: { ...body.request, nonce: `0x${'42'.repeat(32)}` } }, 'invalid_request');
        await expectCode({ ...body, request: { ...body.request, nonce: 0 } }, 'invalid_request');
        await expectCode({ ...body, authorization: { ...body.authorization, r: '0x1234' } }, 'invalid_request');
        await expectCode({ ...body, signature: '0x123' }, 'invalid_request');
        await expectCode({ ...body, signature: 'deadbeef' }, 'invalid_request');
        await expectCode({ ...body, authorization: { ...body.authorization, mode: 'PERMIT' } }, 'invalid_request');
        await expectCode({ ...body, authorization: { ...body.authorization, v: 256 } }, 'invalid_request');
        await expectCode({ ...body, authorization: { ...body.authorization, v: '27' } }, 'invalid_request');
        // quoteId: the SDK's rule (a non-empty string of at most 256 characters); it is only a hint.
        await expectCode({ ...body, quoteId: 'a'.repeat(257) }, 'invalid_request');
        await expectCode({ ...body, quoteId: '' }, 'invalid_request');
        await expectCode({ ...body, quoteId: 7 }, 'invalid_request');
        await expectCode({ ...body, quoteId: null }, 'invalid_request');
        const ok = await submit({ ...body, quoteId: '9b2f7c1e-1c1a-4c43-9a8e-6c4d9b7a1f00' });
        expect(ok.statusCode).toBe(202);
        // Any content up to 256 characters passes the schema (these then stop at step 4: another request holds the nonce).
        const other = await transfer({ amount: 2_000_000n });
        await expectCode({ ...other.body, quoteId: `${'q'.repeat(250)} x/y+` }, 'conflict');
        await expectCode({ ...other.body, quoteId: 'q'.repeat(256) }, 'conflict');
    });

    it('takes any uint256 nonce and stores it as its canonical decimal string', async () => {
        const max = 2n ** 256n - 1n;
        h.chain.setIntentNonce(USER_ADDRESS, max);
        const built = await transfer({ nonce: max });
        expect(built.body.request.nonce).toBe(max.toString());
        expect((await submit(built.body)).statusCode).toBe(202);
        expect(h.store.getRequest(built.id)?.nonce).toBe(max.toString());
    });
});

describe('T31: step 2: policy', () => {
    it('wrong_relay', async () => {
        const { body } = await transfer({ relay: OTHER_ADDRESS });
        await expectCode(body, 'wrong_relay');
    });

    it('unsupported_token', async () => {
        const { body } = await transfer({ token: getAddress('0x2791bca1f2de4661ed88a30c99a7a9449aa84174'), mode: 'none' });
        await expectCode(body, 'unsupported_token');
    });

    it('unsupported_auth_mode (USDC has no meta-transactions)', async () => {
        const usdc = await transfer({ token: USDC, mode: 'none' });
        const meta = await transfer({ token: USDT0, mode: 'metaTxApprove' });
        await expectCode({ ...usdc.body, authorization: meta.body.authorization }, 'unsupported_auth_mode');
    });

    it('invalid_amount for 0 and when amount + fee overflows uint256 (same rule as the SDK)', async () => {
        await expectCode((await transfer({ amount: 0n })).body, 'invalid_amount');
        await expectCode((await transfer({ amount: 2n ** 256n - 1n, mode: 'none' })).body, 'invalid_amount');
        await expectCode((await transfer({ amount: 2n ** 256n - 10_000n, fee: 10_000n, mode: 'none' })).body, 'invalid_amount');
        // amount + fee = 2^256 − 1 passes the policy (and then fails on the balance).
        await expectCode((await transfer({ amount: 2n ** 256n - 1n - 10_000n, fee: 10_000n, mode: 'none' })).body, 'insufficient_balance');
    });

    it('invalid_recipient for every D11 denylist entry', async () => {
        const denied: Address[] = ['0x0000000000000000000000000000000000000000', USDC, USDT0, CONTRACT, ...LEGACY_NIMIQ_CONTRACTS_POLYGON];
        for (const to of denied) await expectCode((await transfer({ to })).body, 'invalid_recipient');
        // The superseded GaslessTransfer deployments: tokens sent to them are locked.
        for (const to of ['0xbfbE31E6c57B09A8130d427B9E3E23ed5aB6cd1D', '0xA0df3CdF124d7101a67ebE5b1b97D222505De9D6'] as const) {
            await expectCode((await transfer({ to })).body, 'invalid_recipient');
        }
    });

    it('invalid_recipient for configured extra denylist entries', async () => {
        await h.close();
        h = await createHarness({ settings: { recipientDenylist: [OTHER_ADDRESS] } });
        await expectCode((await transfer({ to: OTHER_ADDRESS })).body, 'invalid_recipient');
    });

    it('deadline_out_of_range outside [now+60, now+7200], boundaries accepted', async () => {
        const now = BigInt(h.clock.seconds());
        await expectCode((await transfer({ deadline: now + 59n })).body, 'deadline_out_of_range');
        await expectCode((await transfer({ deadline: now + 7201n })).body, 'deadline_out_of_range');
        await expectCode((await transfer({ deadline: now - 1n })).body, 'deadline_out_of_range');
        expect((await submit((await transfer({ deadline: now + 60n })).body)).statusCode).toBe(202);
        expect((await submit((await transfer({ deadline: now + 7200n, sender: 1 })).body)).statusCode).toBe(202);
    });

    // Nothing but the sender's signature bounds the fee.
    it('no fee cap: fees above 5.00 and far above 2^53 and 2^128 are accepted and stored exactly, for each token and mode', async () => {
        const fees = [5_000_001n, 50_000_000n, 2n ** 53n + 10_000n, 2n ** 128n + 10_000n, 2n ** 255n];
        const cases = [
            [USDC, 'permit'],
            [USDC, 'none'],
            [USDT0, 'permit'],
            [USDT0, 'metaTxApprove'],
            [USDT0, 'none'],
        ] as const;
        let sender = 1;
        for (const fee of fees) {
            for (const [token, mode] of cases) {
                const key = senderKey(sender);
                const from = privateKeyToAccount(key).address;
                const t = await transfer({ token, mode, fee, sender });
                h.chain.setBalance(token, from, 1_000_000n + fee);
                if (mode === 'none') h.chain.setAllowance(token, from, CONTRACT, 1_000_000n + fee);
                expect(await submit(t.body)).toEqual({ statusCode: 202, body: { id: t.id, status: 'queued' } });
                const stored = h.store.getRequest(t.id)!;
                expect(stored.fee).toBe(fee);
                expect(stored.debit).toBe(1_000_000n + fee);
                expect((stored.request as { fee: string }).fee).toBe(fee.toString());
                sender += 1;
            }
        }
    });
});

describe('step 3: intent signature → invalid_signature', () => {
    it('rejects a signature by another key', async () => {
        await expectCode((await transfer({ signWith: OTHER_KEY })).body, 'invalid_signature');
    });

    it('rejects a signature over any other value of each signed field', async () => {
        const overrides = [
            { amount: '999999' },
            { fee: '10001' },
            { to: OTHER_ADDRESS },
            { nonce: '1' },
            { deadline: String(h.clock.seconds() + 601) },
            { token: USDT0 },
            { relay: OTHER_ADDRESS },
            { from: OTHER_ADDRESS },
        ];
        for (const signedOverrides of overrides) {
            await expectCode((await transfer({ signedOverrides })).body, 'invalid_signature');
        }
    });

    it('rejects signatures for another chain or another verifying contract', async () => {
        const { body } = await transfer();
        for (const domain of [
            { ...transferDomainLiteral(), chainId: 80002 },
            { ...transferDomainLiteral(), verifyingContract: OTHER_ADDRESS },
            { ...transferDomainLiteral(), name: 'Nimiq Gasless Other' },
            // Another domain version.
            { ...transferDomainLiteral(), version: '1' },
        ]) {
            const signature = await signTransferRequest(USER_KEY, body.request, body.authorization, domain);
            await expectCode({ ...body, signature }, 'invalid_signature');
        }
        // Control: the same request signed for this domain.
        const signature = await signTransferRequest(USER_KEY, body.request, body.authorization, transferDomainLiteral());
        expect((await submit({ ...body, signature })).statusCode).toBe(202);
    });

    it('the intent signs the token authorization: a changed or swapped authorization is invalid_signature', async () => {
        const { body } = await transfer();
        const auth = body.authorization;
        const flip = (hex: Hex): Hex => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}` as Hex;
        // Another token signature of the same mode, as the relay or a man in the middle could substitute.
        for (const tampered of [{ ...auth, r: flip(auth.r) }, { ...auth, s: flip(auth.s) }, { ...auth, v: auth.v === 27 ? 28 : 27 }]) {
            await expectCode({ ...body, authorization: tampered }, 'invalid_signature');
        }
        // Another valid permit of the sender (another token nonce).
        const other = await transfer({ authNonce: 7n });
        await expectCode({ ...body, authorization: other.body.authorization }, 'invalid_signature');
        // A different mode: signed with the permit, submitted as "none" (with an allowance in place), and the reverse.
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        await expectCode({ ...body, authorization: NO_AUTH }, 'invalid_signature');
        await expectCode((await transfer({ signedAuthorization: NO_AUTH })).body, 'invalid_signature');
        const none = await transfer({ mode: 'none' });
        await expectCode({ ...none.body, authorization: auth }, 'invalid_signature');
        // Nothing was stored, and nothing was simulated: the signature is checked before any RPC read.
        expect(h.store.countRequests()).toBe(0);
        expect(h.chain.calls).toHaveLength(0);
        expect((await submit(body)).statusCode).toBe(202);
    });

    it('requires exactly 65 bytes, v ∈ {27, 28} and low s', async () => {
        const { body } = await transfer();
        const sig = body.signature;
        await expectCode({ ...body, signature: sig.slice(0, 130) }, 'invalid_signature');
        await expectCode({ ...body, signature: `${sig}00` }, 'invalid_signature');
        await expectCode({ ...body, signature: '0x' }, 'invalid_signature');
        await expectCode({ ...body, signature: toHighS(sig) }, 'invalid_signature');
        const v = Number.parseInt(sig.slice(130), 16);
        await expectCode({ ...body, signature: `${sig.slice(0, 130)}${(v - 27).toString(16).padStart(2, '0')}` }, 'invalid_signature');
        await expectCode({ ...body, signature: `${sig.slice(0, 130)}1d` }, 'invalid_signature');
        await expectCode({ ...body, signature: `0x${'00'.repeat(65)}` }, 'invalid_signature');
    });
});

describe('step 4: nonce', () => {
    it('nonce_used below the sender\'s next nonce: used by a transfer or invalidated on-chain (a range)', async () => {
        const at0 = await transfer({ nonce: 0n });
        const at4 = await transfer({ nonce: 4n });
        // invalidateNonces(5): every nonce in [0, 5) is used.
        h.chain.invalidateNonces(USER_ADDRESS, 5n);
        for (const t of [at0, at4]) {
            const err = await expectCode(t.body, 'nonce_used');
            expect(err.statusCode).toBe(409);
            expect(err.message).toContain("the sender's next nonce is 5");
        }
        expect((await submit((await transfer({ nonce: 5n })).body)).statusCode).toBe(202);
    });

    it('nonce_too_high above the next nonce (retryable 409): a request cannot wait in the relay for the ones before it', async () => {
        for (const nonce of [1n, 2n, 2n ** 256n - 1n]) {
            const t = await transfer({ nonce });
            const err = await expectCode(t.body, 'nonce_too_high');
            expect(err.statusCode).toBe(409);
            expect(err.message).toMatch(/^the sender's next nonce is 0: /);
            expect(h.store.getRequest(t.id)).toBeUndefined();
        }
        // The next request of a sender whose request is queued (not mined yet) is too high as well.
        expect((await submit((await transfer({ nonce: 0n })).body)).statusCode).toBe(202);
        await expectCode((await transfer({ nonce: 1n })).body, 'nonce_too_high');
        expect(h.chain.calls).toHaveLength(1);
    });

    it("the next nonce counts the sender's requests the relay recorded as included after block B: sender_busy until the reads show them", async () => {
        await h.relay.txManager.recover();
        const first = await transfer();
        expect((await submit(first.body)).statusCode).toBe(202);
        await h.relay.txManager.tick();
        // Included in the next block. The relay's client still reports the block before as its head while the receipt is
        // visible (another RPC answered it): it records the inclusion after its view head, and a submission reads there (B).
        const stale = h.chain.head;
        h.chain.mine();
        const getBlock = h.chain.getBlock;
        h.chain.getBlock = async (tag) => (tag === 'latest' ? stale : getBlock.call(h.chain, tag));
        await h.relay.txManager.tick();
        expect(h.store.getRequest(first.id)).toMatchObject({ status: 'mined', blockNumber: stale.number + 1n });
        expect(h.chain.intentNonce(USER_ADDRESS, stale.number)).toBe(0n);
        // nonces(from) at B is 0, but the relay knows nonce 0 is used: 0 is nonce_used (not a conflict, not accepted).
        await expectCode((await transfer({ nonce: 0n, amount: 2_000_000n })).body, 'nonce_used');
        await expectCode((await transfer({ nonce: 2n })).body, 'nonce_too_high');
        // Nonce 1 is the next one, but its reads and simulation at B would not show the inclusion: retryable.
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const next = await transfer({ nonce: 1n, mode: 'none' });
        const busy = await expectCode(next.body, 'sender_busy');
        expect(busy.message).toMatch(/previous request was just mined/);
        // Once the reads reach the inclusion, the same body is accepted.
        h.chain.getBlock = getBlock;
        await h.relay.txManager.tick();
        expect((await submit(next.body)).statusCode).toBe(202);
    });

    it('conflict for the same (contract, from, nonce) with a different payload; identical re-post is 200', async () => {
        const first = await transfer();
        expect((await submit(first.body)).statusCode).toBe(202);
        expect(await submit(first.body)).toEqual({ statusCode: 200, body: { id: first.id, status: 'queued' } });
        const second = await transfer({ amount: 2_000_000n });
        expect(second.body.request.nonce).toBe(first.body.request.nonce);
        const err = await expectCode(second.body, 'conflict');
        expect(err.statusCode).toBe(409);
        expect(err.message).toContain(first.id);
        // A different token authorization for the same request is a different payload, too (and a different id).
        const otherAuth = await transfer({ authNonce: 7n });
        expect(otherAuth.id).not.toBe(first.id);
        await expectCode(otherAuth.body, 'conflict');
        // Another token, or mode "none", at the same nonce: the same.
        h.chain.setAllowance(USDT0, USER_ADDRESS, CONTRACT, 10n ** 12n);
        await expectCode((await transfer({ token: USDT0, mode: 'none' })).body, 'conflict');
    });

    it('nonce_used (not conflict) for a different payload once the nonce is used on-chain, e.g. after mining', async () => {
        const first = await transfer();
        expect((await submit(first.body)).statusCode).toBe(202);
        h.chain.setIntentNonce(USER_ADDRESS, 1n); // used on-chain (by this request or an invalidation)
        const second = await transfer({ nonce: 0n, amount: 2_000_000n });
        const err = await expectCode(second.body, 'nonce_used');
        expect(err.statusCode).toBe(409);
        // The identical request still reports its state.
        expect(await submit(first.body)).toEqual({ statusCode: 200, body: { id: first.id, status: 'queued' } });
    });

    it('a failed or expired request holds its nonce until its outcome settles: sender_busy, then the sender may sign the nonce again', async () => {
        await h.relay.txManager.recover();
        const first = await transfer();
        expect((await submit(first.body)).statusCode).toBe(202);
        await h.relay.txManager.tick();
        // The call is included and reverts: failed, provisional until its block is final. The nonce is still unused.
        h.chain.executor = () => 'reverted';
        h.chain.mine();
        await h.relay.txManager.tick();
        expect(h.store.getRequest(first.id)).toMatchObject({ status: 'failed', settledAtMs: null });
        expect(h.chain.intentNonce(USER_ADDRESS)).toBe(0n);
        h.chain.executor = (tx) => h.chain.defaultExecute(tx);
        const correction = await transfer({ fee: 20_000n });
        const busy = await expectCode(correction.body, 'sender_busy');
        expect(busy.message).toMatch(/at this nonce ended \(failed or expired\), but its outcome is not final yet/);
        expect(h.store.getRequest(correction.id)).toBeUndefined();
        // Final (RELAY_MIN_FINALITY_DEPTH blocks on top, and the finalized tag): the correction at the same nonce is accepted.
        h.chain.mineBlocks(16);
        h.chain.finalized = h.chain.head.number;
        await h.relay.txManager.tick();
        expect(h.store.getRequest(first.id)?.settledAtMs).not.toBeNull();
        expect((await submit(correction.body)).statusCode).toBe(202);
        // The ended request is still answered by its id.
        expect(await submit(first.body)).toEqual({ statusCode: 200, body: { id: first.id, status: 'failed' } });
    });

    it('one queued or in-flight request per sender: sender_busy when the chain moved past a pending request', async () => {
        const first = await transfer();
        expect((await submit(first.body)).statusCode).toBe(202);
        // The sender invalidated nonce 0 on-chain while its request waits: nonce 1 is next, but nonce 0 is still pending here.
        h.chain.invalidateNonces(USER_ADDRESS, 1n);
        const second = await transfer({ token: USDT0, mode: 'metaTxApprove' });
        expect(second.body.request.nonce).toBe('1');
        const err = await expectCode(second.body, 'sender_busy');
        expect(err.message).toBe('another request of this sender is queued or in flight, and the relay takes one request per sender at a time; retry when it is mined');
        expect(h.store.getRequest(second.id)).toBeUndefined();
        // Other senders are not affected; once the first leaves the queue, the same request is accepted.
        expect((await submit((await transfer({ sender: 1 })).body)).statusCode).toBe(202);
        end(first.id);
        expect((await submit(second.body)).statusCode).toBe(202);
    });

    it('an identical re-post returns the current state even after the policy window moved', async () => {
        const first = await transfer();
        await submit(first.body);
        h.clock.advance(7200);
        expect(await submit(first.body)).toEqual({ statusCode: 200, body: { id: first.id, status: 'queued' } });
    });
});

describe('step 5: fee acceptance', () => {
    it('fee_too_low below breakEven(now), breakEven itself accepted (quotes are only hints)', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        // A base fee at which break-even is above MIN_FEE (0.01).
        h.chain.head = { ...h.chain.head, baseFeePerGas: 270n * 1_000_000_000n };
        const context = await h.relay.fees.context();
        const breakEven = h.relay.fees.breakEven('transfer', 'none', context);
        expect(breakEven).toBe(12_000n); // 200000 gas × (270 + 30) gwei × 0.2 USD
        const err = await expectCode((await transfer({ mode: 'none', fee: breakEven - 1n })).body, 'fee_too_low');
        expect(err.statusCode).toBe(402);
        expect((await submit((await transfer({ mode: 'none', fee: breakEven })).body)).statusCode).toBe(202);
    });

    it('fee_too_low below MIN_FEE although break-even is lower; MIN_FEE itself accepted', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const context = await h.relay.fees.context();
        expect(h.relay.fees.breakEven('transfer', 'none', context)).toBe(2400n); // 200000 gas × 60 gwei × 0.2 USD
        expect(h.relay.fees.minFee).toBe(10_000n);
        const err = await expectCode((await transfer({ mode: 'none', fee: 9_999n })).body, 'fee_too_low');
        expect(err.statusCode).toBe(402);
        expect(err.message).toBe(
            'fee 9999 is below 10000, the larger of the minimum fee 10000 and the current break-even fee; request a new quote',
        );
        expect((await submit((await transfer({ mode: 'none', fee: 10_000n })).body)).statusCode).toBe(202);
        expect(h.store.countRequests()).toBe(1);
    });

    it('uses the gas price at submit time', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const { body } = await transfer({ mode: 'none', fee: 10_000n });
        h.chain.head = { ...h.chain.head, baseFeePerGas: 1000n * 1_000_000_000n };
        await expectCode(body, 'fee_too_low');
    });
});

describe('step 6: balance and token state', () => {
    it('insufficient_balance below amount + fee, exact balance accepted', async () => {
        h.chain.setBalance(USDC, USER_ADDRESS, 1_009_999n);
        await expectCode((await transfer()).body, 'insufficient_balance');
        h.chain.setBalance(USDC, USER_ADDRESS, 1_010_000n);
        expect((await submit((await transfer()).body)).statusCode).toBe(202);
    });

    // A sender has one queued or in-flight request (a second one is refused at step 4 or 7); the store still counts
    // several (a reorg can put an included request back in flight), see the store tests.

    it('token_paused (USDC)', async () => {
        h.chain.token(USDC).paused = true;
        await expectCode((await transfer()).body, 'token_paused');
    });

    it('blocked_address for USDC-blacklisted from, to, relay and contract', async () => {
        for (const who of [USER_ADDRESS, RECIPIENT_ADDRESS, RELAY_ADDRESS, CONTRACT]) {
            h.chain.token(USDC).blacklisted.clear();
            h.chain.token(USDC).blacklisted.add(who.toLowerCase());
            await expectCode((await transfer()).body, 'blocked_address');
        }
    });

    it('blocked_address for USDT0-blocked from, relay and contract (the recipient is not checked by USDT0)', async () => {
        for (const who of [USER_ADDRESS, RELAY_ADDRESS, CONTRACT]) {
            h.chain.token(USDT0).blocked.clear();
            h.chain.token(USDT0).blocked.add(who.toLowerCase());
            await expectCode((await transfer({ token: USDT0 })).body, 'blocked_address');
        }
        h.chain.token(USDT0).blocked.clear();
        h.chain.token(USDT0).blocked.add(RECIPIENT_ADDRESS.toLowerCase());
        expect((await submit((await transfer({ token: USDT0 })).body)).statusCode).toBe(202);
    });

    it('checks in the order balance, paused, blocked', async () => {
        h.chain.token(USDC).paused = true;
        h.chain.token(USDC).blacklisted.add(USER_ADDRESS.toLowerCase());
        h.chain.setBalance(USDC, USER_ADDRESS, 0n);
        await expectCode((await transfer()).body, 'insufficient_balance');
        h.chain.setBalance(USDC, USER_ADDRESS, 10n ** 9n);
        await expectCode((await transfer()).body, 'token_paused');
        h.chain.token(USDC).paused = false;
        await expectCode((await transfer()).body, 'blocked_address');
    });
});

describe('step 7: token authorization', () => {
    it('USDC permit is rebuilt with the live nonce, value = amount + fee, spender = contract, deadline = intent deadline', async () => {
        h.chain.setTokenNonce(USDC, USER_ADDRESS, 3n);
        // The rejected variants first: once the valid permit is pending, sender_busy comes first.
        const cases: TransferOptions[] = [
            { authNonce: 2n },
            { authNonce: 4n },
            { authValue: 1_010_001n },
            { authValue: 1_000_000n },
            { authSpender: OTHER_ADDRESS },
            { authDeadline: BigInt(h.clock.seconds() + 601) },
            { authDomain: POLYGON_USDT0.domain },
            { authDomain: { name: 'USD Coin', version: '1', chainId: 137, verifyingContract: USDC } },
            { authKey: OTHER_KEY },
        ];
        for (const c of cases) {
            await expectCode((await transfer({ ...c, authNonce: c.authNonce ?? 3n })).body, 'invalid_token_authorization');
        }
        expect((await submit((await transfer({ authNonce: 3n })).body)).statusCode).toBe(202);
    });

    it('USDT0 permit uses the salt domain and the shared nonce', async () => {
        h.chain.setTokenNonce(USDT0, USER_ADDRESS, 5n);
        // T17: a permit signed with the standard (chainId) domain does not verify.
        const standard = { name: 'USDT0', version: '1', chainId: 137, verifyingContract: USDT0 };
        await expectCode((await transfer({ token: USDT0, authNonce: 5n, authDomain: standard })).body, 'invalid_token_authorization');
        expect((await submit((await transfer({ token: USDT0, authNonce: 5n })).body)).statusCode).toBe(202);
    });

    it('USDT0 meta-tx approve: getNonce, approve(contract, amount + fee), salt domain', async () => {
        h.chain.setTokenNonce(USDT0, USER_ADDRESS, 2n);
        const cases: TransferOptions[] = [
            { authNonce: 1n },
            { authNonce: 3n },
            { authValue: 1_010_001n },
            { authSpender: OTHER_ADDRESS },
            { authDomain: { name: 'USDT0', version: '1', chainId: 137, verifyingContract: USDT0 } },
            { authKey: OTHER_KEY },
        ];
        for (const c of cases) {
            await expectCode(
                (await transfer({ token: USDT0, mode: 'metaTxApprove', ...c, authNonce: c.authNonce ?? 2n })).body,
                'invalid_token_authorization',
            );
        }
        expect((await submit((await transfer({ token: USDT0, mode: 'metaTxApprove', authNonce: 2n })).body)).statusCode).toBe(202);
    });

    it('rejects high-s and v ∉ {27, 28} token signatures (signed by the intent as they are)', async () => {
        const { body } = await transfer();
        const auth = body.authorization;
        const highS = `0x${(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n - BigInt(auth.s)).toString(16).padStart(64, '0')}` as Hex;
        for (const authorization of [{ ...auth, s: highS, v: auth.v === 27 ? 28 : 27 }, { ...auth, v: auth.v - 27 }, { ...auth, v: 29 }]) {
            await expectCode((await transfer({ authorization })).body, 'invalid_token_authorization');
        }
        expect((await submit(body)).statusCode).toBe(202);
    });

    it('USDC permit from an account with code (EIP-7702) fails closed', async () => {
        h.chain.codes.set(USER_ADDRESS.toLowerCase(), `0xef0100${'12'.repeat(20)}`);
        const err = await expectCode((await transfer()).body, 'invalid_token_authorization');
        expect(err.message).toContain('none');
        // NONE mode still works (the intent signature is plain ECDSA).
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        expect((await submit((await transfer({ mode: 'none' })).body)).statusCode).toBe(202);
    });

    it('insufficient_allowance in NONE mode, exact allowance accepted', async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 1_009_999n);
        await expectCode((await transfer({ mode: 'none' })).body, 'insufficient_allowance');
        // An allowance to another spender does not count.
        h.chain.setAllowance(USDC, USER_ADDRESS, OTHER_ADDRESS, 10n ** 12n);
        await expectCode((await transfer({ mode: 'none' })).body, 'insufficient_allowance');
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 1_010_000n);
        expect((await submit((await transfer({ mode: 'none' })).body)).statusCode).toBe(202);
    });

    // With one queued or in-flight request per sender, a sender's further request is refused at step 4 before the token
    // checks (conflict at the pending request's nonce, nonce_too_high after it), and with sender_busy when the chain
    // moved past the pending request (step 7). The store keeps the token rules for the requests a reorg puts back in
    // flight (store tests).
    it("a sender's further request while one is pending: conflict or nonce_too_high whatever its token and mode; other senders are not affected", async () => {
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        h.chain.setAllowance(USDT0, USER_ADDRESS, CONTRACT, 10n ** 12n);
        const none = await transfer({ mode: 'none' });
        expect((await submit(none.body)).statusCode).toBe(202);
        for (const o of [{}, { mode: 'none', amount: 2_000_000n }, { token: USDT0, mode: 'metaTxApprove' }, { token: USDT0, mode: 'none' }] as const) {
            await expectCode((await transfer(o)).body, 'conflict');
            await expectCode((await transfer({ ...o, nonce: 1n })).body, 'nonce_too_high');
        }
        h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
        expect((await submit((await transfer({ key: OTHER_KEY })).body)).statusCode).toBe(202);
        // Once the request left the queue, the sender may sign its nonce again, in any mode.
        end(none.id);
        expect((await submit((await transfer({ token: USDT0, mode: 'metaTxApprove' })).body)).statusCode).toBe(202);
    });

    it('checks the nonce before the authorization: a permit for the next token nonce is retryable', async () => {
        expect((await submit((await transfer()).body)).statusCode).toBe(202);
        const err = await expectCode((await transfer({ authNonce: 1n, nonce: 1n })).body, 'nonce_too_high');
        expect(err.statusCode).toBe(409);
    });
});

describe('step 8: simulation', () => {
    it('simulation_failed with the decoded custom error', async () => {
        h.chain.simulate = () => ({
            ok: false,
            revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, 1_010_000n] }),
            message: 'execution reverted',
        });
        const err = await expectCode((await transfer()).body, 'simulation_failed');
        expect(err.statusCode).toBe(422);
        expect(err.message).toContain('InsufficientAllowance(0, 1010000)');
    });

    it('decodes revert strings and reverts without data', async () => {
        h.chain.simulate = () => ({
            ok: false,
            revertData: encodeErrorResult({
                abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }],
                errorName: 'Error',
                args: ['ERC20: transfer amount exceeds balance'],
            }),
            message: 'execution reverted',
        });
        expect((await expectCode((await transfer()).body, 'simulation_failed')).message).toContain('exceeds balance');
        h.chain.simulate = () => ({ ok: false, revertData: undefined, message: 'execution reverted' });
        await expectCode((await transfer()).body, 'simulation_failed');
    });

    it("the owner's setTokenConfig after startup: a disabled mode or a removed token on-chain fails the simulation", async () => {
        h.chain.setTokenConfig(USDT0, { metaTxApprove: false });
        const mode = await expectCode((await transfer({ token: USDT0, mode: 'metaTxApprove', sender: 1 })).body, 'simulation_failed');
        expect(mode.message).toBe(`simulation reverted: AuthModeNotSupported(${USDT0}, 2)`);
        expect((await submit((await transfer({ token: USDT0, mode: 'permit', sender: 1 })).body)).statusCode).toBe(202);
        h.chain.setTokenConfig(USDT0, { permit: false, metaTxApprove: false, allowance: false });
        const token = await expectCode((await transfer({ token: USDT0, sender: 2 })).body, 'simulation_failed');
        expect(token.message).toBe(`simulation reverted: TokenNotSupported(${USDT0})`);
    });

    it('a nonce that moved on between step 4 and the simulation is refused (InvalidSignature at the moved nonce); nothing stored', async () => {
        const t = await transfer();
        const call = h.chain.call.bind(h.chain);
        h.chain.call = async (params) => {
            h.chain.invalidateNonces(USER_ADDRESS, 1n);
            return call(params);
        };
        const err = await expectCode(t.body, 'simulation_failed');
        expect(err.message).toBe('simulation reverted: InvalidSignature()');
        expect(h.store.getRequest(t.id)).toBeUndefined();
    });
});

describe('ordering and availability', () => {
    it('returns the code of the first failing step', async () => {
        // 1 before 2
        await expectCode({ ...(await transfer({ relay: OTHER_ADDRESS })).body, extra: true }, 'invalid_request');
        // 2 before 3
        await expectCode((await transfer({ relay: OTHER_ADDRESS, signWith: OTHER_KEY })).body, 'wrong_relay');
        // 3 before 4
        const used = await transfer({ signWith: OTHER_KEY });
        h.chain.invalidateNonces(USER_ADDRESS, 1n);
        await expectCode(used.body, 'invalid_signature');
        // 4 before 5
        await expectCode((await transfer({ fee: 1n, nonce: 0n })).body, 'nonce_used');
        await expectCode((await transfer({ fee: 1n, nonce: 2n })).body, 'nonce_too_high');
        // 5 before 6
        h.chain.setBalance(USDC, USER_ADDRESS, 0n);
        await expectCode((await transfer({ fee: 1n })).body, 'fee_too_low');
        // 6 before 7
        await expectCode((await transfer({ authNonce: 9n })).body, 'insufficient_balance');
        // 7 before 8
        h.chain.setBalance(USDC, USER_ADDRESS, 10n ** 9n);
        h.chain.simulate = () => ({ ok: false, revertData: undefined, message: 'execution reverted' });
        await expectCode((await transfer({ authNonce: 9n })).body, 'invalid_token_authorization');
    });

    it('unavailable (503) when the RPC fails during validation', async () => {
        const { body, id } = await transfer();
        h.chain.rpcDown = true;
        const err = await expectCode(body, 'unavailable');
        expect(err.statusCode).toBe(503);
        expect(h.store.getRequest(id)).toBeUndefined();
    });

    it('per-signer rate limit applies only after the signature is verified', async () => {
        await h.close();
        h = await createHarness({ settings: { rateLimit: { signerMax: 2, signerWindowMs: 60_000 } } });
        // Forged requests claiming to be from USER do not consume USER's quota.
        for (let i = 0; i < 5; i++) await expectCode((await transfer({ signWith: OTHER_KEY })).body, 'invalid_signature');
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        // Each accepted request ends (failed, settled) before the next: the sender signs its nonce again.
        const accepted = async (amount: bigint) => {
            const t = await transfer({ mode: 'none', amount });
            expect((await submit(t.body)).statusCode).toBe(202);
            end(t.id);
        };
        await accepted(1_000_000n);
        // Requests answered at step 4 (nonce_used, nonce_too_high, conflict) are not charged.
        for (let i = 0; i < 3; i++) await expectCode((await transfer({ mode: 'none', nonce: 1n })).body, 'nonce_too_high');
        await accepted(2_000_000n);
        const limited = await expectCode((await transfer({ mode: 'none', amount: 3_000_000n })).body, 'rate_limited');
        expect(limited.statusCode).toBe(429);
        h.clock.advance(61);
        await accepted(3_000_000n);
    });

    it('counts outcomes in relay_submissions_total', async () => {
        await submit((await transfer()).body);
        await rejection((await transfer({ relay: OTHER_ADDRESS })).body);
        const text = await h.metrics.registry.metrics();
        expect(text).toContain('relay_submissions_total{operation="transfer",outcome="accepted"} 1');
        expect(text).toContain('relay_submissions_total{operation="transfer",outcome="wrong_relay"} 1');
    });
});

describe('admission', () => {
    const noneTransfer = async (o: TransferOptions = {}) => {
        const key = o.sender !== undefined ? senderKey(o.sender) : (o.key ?? USER_KEY);
        const t = await transfer({ mode: 'none', ...o });
        h.chain.setAllowance(o.token ?? USDC, privateKeyToAccount(key).address, CONTRACT, 10n ** 12n);
        return t;
    };

    /** Holds every simulation (step 8) until `count` submissions have reached it. */
    function gateSimulations(count: number): void {
        const call = h.chain.call.bind(h.chain);
        let arrived = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        h.chain.call = async (params) => {
            arrived += 1;
            if (arrived === count) release();
            await gate;
            return call(params);
        };
    }

    const outcome = (r: PromiseSettledResult<{ statusCode: number }>): number | string =>
        r.status === 'fulfilled' ? r.value.statusCode : (r.reason as RelayError).code;

    // GaslessTransfer executes a sender's requests in nonce order, so the relay keeps one per sender and needs no
    // per-sender bound here (step 4 'one queued or in-flight request per sender', and the store tests).

    it('unavailable (503) once RELAY_MAX_QUEUED requests are queued, before any RPC read; nothing stored; retryable', async () => {
        await h.close();
        h = await createHarness({ settings: { admission: { maxQueued: 2 } } });
        h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
        expect((await submit((await noneTransfer()).body)).statusCode).toBe(202);
        expect((await submit((await noneTransfer({ key: OTHER_KEY })).body)).statusCode).toBe(202);
        const third = await noneTransfer({ sender: 1 });
        const reads = h.chain.reads.length;
        const err = await expectCode(third.body, 'unavailable');
        expect(err.statusCode).toBe(503);
        expect(err.message).toBe('The relay has too many requests queued right now; nothing was stored. Retry in a minute.');
        expect(h.chain.reads.length).toBe(reads);
        expect(h.store.getRequest(third.id)).toBeUndefined();
        // In flight does not count against the queue bound: the same request is accepted once one is broadcast.
        await h.relay.txManager.recover();
        await h.relay.txManager.tick();
        expect(h.store.countByStatus('queued')).toBeLessThan(2);
        expect((await submit(third.body)).statusCode).toBe(202);
    });

    it('one request per sender and nonce holds for concurrent submissions: step 9 re-checks it atomically', async () => {
        // Two versions of a payment at the same nonce, both past step 4 before either is stored.
        const [x, y] = [await noneTransfer(), await noneTransfer({ amount: 2_000_000n })];
        gateSimulations(2);
        const results = await Promise.allSettled([submit(x.body), submit(y.body)]);
        expect(results.map(outcome).sort()).toEqual([202, 'conflict']);
        expect(h.store.admissionCounts(USER_ADDRESS).pendingOfSigner).toBe(1);
        expect(h.store.countRequests()).toBe(1);
    });

    it('after the chain moved past a pending request: sender_busy while it is pending, then one of two concurrent versions at the next nonce', async () => {
        // Nonce 0 is pending; the sender invalidates nonces 0 and 1 on-chain.
        const pending = await noneTransfer();
        expect((await submit(pending.body)).statusCode).toBe(202);
        h.chain.invalidateNonces(USER_ADDRESS, 2n);
        const [x, y] = [await noneTransfer({ amount: 2_000_000n }), await noneTransfer({ amount: 3_000_000n })];
        expect([x.body.request.nonce, y.body.request.nonce]).toEqual(['2', '2']);
        await expectCode(x.body, 'sender_busy');
        end(pending.id);
        gateSimulations(2);
        const results = await Promise.allSettled([submit(x.body), submit(y.body)]);
        expect(results.map(outcome).sort()).toEqual([202, 'conflict']);
        expect(h.store.admissionCounts(USER_ADDRESS).pendingOfSigner).toBe(1);
    });

    it('concurrent submissions of many senders are all admitted (control)', async () => {
        const built = [];
        for (let i = 0; i < 6; i++) built.push(await noneTransfer({ sender: 10 + i }));
        // (RELAY_MAX_CONCURRENT_VALIDATIONS lets four validate at once.)
        gateSimulations(4);
        const results = await Promise.allSettled(built.map((t) => submit(t.body)));
        expect(results.map(outcome)).toEqual(Array(built.length).fill(202));
    });

    it('the queue bound holds for concurrent submissions: step 9 re-checks it atomically', async () => {
        await h.close();
        h = await createHarness({ settings: { admission: { maxQueued: 1 } } });
        h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
        const [x, y] = [await noneTransfer(), await noneTransfer({ key: OTHER_KEY })];
        gateSimulations(2);
        const results = await Promise.allSettled([submit(x.body), submit(y.body)]);
        expect(results.map(outcome).sort()).toEqual([202, 'unavailable']);
        expect(h.store.countByStatus('queued')).toBe(1);
    });

    it('a NONE and a PERMIT of one sender and token submitted concurrently: only one is stored', async () => {
        // Both at the sender's next nonce: one request per nonce decides first.
        const [x, y] = [await noneTransfer(), await transfer()];
        gateSimulations(2);
        const results = await Promise.allSettled([submit(x.body), submit(y.body)]);
        expect(results.map(outcome).sort()).toEqual([202, 'conflict']);
        expect(h.store.countByStatus('queued')).toBe(1);
    });

    // The cool-down keys on the sender (the signed `from`), never on a network address. While it runs, the relay spends
    // no RPC read on a further submission of a sender that already has a request queued or in flight.
    describe('the cool-down per sender', () => {
        const events = async (event: string): Promise<number> => {
            const line = (await h.metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`relay_admission_events_total{event="${event}"}`));
            return line ? Number(line.split(' ').at(-1)) : 0;
        };

        it('after a request failed before the broadcast because of its sender, a further submission while one is queued is refused before any RPC read for RELAY_PREFLIGHT_COOLDOWN_SECONDS', async () => {
            const t = await noneTransfer();
            expect((await submit(t.body)).statusCode).toBe(202);
            h.chain.invalidateNonces(USER_ADDRESS, 1n); // its sender burnt the nonce
            await h.relay.txManager.recover();
            await h.relay.txManager.tick();
            expect(h.store.getRequest(t.id)).toMatchObject({ status: 'failed', error: { code: 'nonce_used' } });
            expect(await events('cooldown_started')).toBe(1);
            // The first is stored; another version while it is queued is refused before any RPC read (after the cool-down,
            // step 4 refuses it, after its reads).
            // (Its deadline is far enough ahead to be in flight when the cool-down ends.)
            expect((await submit((await noneTransfer({ deadline: BigInt(h.clock.seconds() + 7000) })).body)).statusCode).toBe(202);
            const second = await noneTransfer({ amount: 2_000_000n, deadline: BigInt(h.clock.seconds() + 7000) });
            const reads = h.chain.reads.length;
            const err = await rejection(second.body);
            expect(err.code).toBe('rate_limited');
            expect(err.statusCode).toBe(429);
            expect(err.message).toMatch(/^A request of this sender failed before it was sent, .*For 600 s more, a further request of this sender is refused at once while one is queued or in flight/);
            expect(h.chain.reads.length).toBe(reads);
            expect(h.store.getRequest(second.id)).toBeUndefined();
            expect(await events('sender_cooldown')).toBe(1);
            // Another sender is not affected.
            h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
            expect((await submit((await noneTransfer({ key: OTHER_KEY })).body)).statusCode).toBe(202);
            // After the cool-down the submission reaches step 4 (its reads). The relay kept running meanwhile: a pass
            // on a current head (without one for that long, it would refuse every new request).
            h.clock.advance(601);
            h.chain.mine({ timestampDelta: 601 });
            await h.relay.txManager.tick();
            await expectCode(second.body, 'conflict');
            expect(h.chain.reads.length).toBeGreaterThan(reads);
        });
    });

    describe('a request held at its spend cap gives way in a full queue', () => {
        it('a request that passes every check takes the place of the held one; without a held request the full queue still answers 503', async () => {
            await h.close();
            h = await createHarness({ settings: { admission: { maxQueued: 2 } } });
            h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
            const held = await noneTransfer();
            expect((await submit(held.body)).statusCode).toBe(202);
            expect((await submit((await noneTransfer({ key: OTHER_KEY })).body)).statusCode).toBe(202);
            // Nothing held yet: 503.
            await expectCode((await noneTransfer({ sender: 1 })).body, 'unavailable');
            // The transaction manager holds `held` (the pipeline asks it through heldQueued).
            const txManager = h.relay.txManager as unknown as { heldInQueue: () => Array<{ id: Hex; capPerGas: bigint }> };
            txManager.heldInQueue = () => [{ id: held.id, capPerGas: 400n }];
            const payer = await noneTransfer({ fee: 20_000n, sender: 1 });
            expect((await submit(payer.body)).statusCode).toBe(202);
            expect(h.store.getRequest(held.id)).toMatchObject({
                status: 'failed',
                error: { code: 'fee_too_low', message: expect.stringContaining('it gave way to a request that pays the current price. Nothing was sent') },
                signature: null,
            });
            expect(h.store.countByStatus('queued')).toBe(2);
            const text = await h.metrics.registry.metrics();
            expect(text).toContain('relay_admission_events_total{event="evicted"} 1');
            expect(text).toContain('relay_request_status_total{operation="transfer",status="failed"} 1');
            // A submission that fails a check evicts nothing: the held request is gone, the others are not held. (Its sender
            // may sign the nonce again: the request that gave way is final at once.)
            txManager.heldInQueue = () => [{ id: held.id, capPerGas: 400n }];
            await expectCode((await noneTransfer({ fee: 20_000n })).body, 'unavailable');
        });
    });

    // The right to make a held request give way keys on the sender (the signed `from`): sender A is USER, B is OTHER,
    // and KEYS are further senders, each with its own right.
    describe('a held request gives way one at a time per sender', () => {
        /** Senders of the held requests and of the other submissions (funded, mode none). */
        const KEYS: readonly Hex[] = Array.from({ length: 12 }, (_, i) => keccak256(stringToHex(`pipeline ${i}`)));
        const codeOf = (p: Promise<{ statusCode: number }>): Promise<number | string> =>
            p.then(
                (r) => r.statusCode,
                (err: unknown) => (err instanceof RelayError ? err.code : String(err)),
            );
        const events = async (event: string): Promise<number> => {
            const line = (await h.metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`relay_admission_events_total{event="${event}"}`));
            return line ? Number(line.split(' ').at(-1)) : 0;
        };
        const statusOf = (id: Hex): string => {
            const r = h.store.getRequest(id);
            return r === undefined ? 'none' : r.error ? `${r.status}/${r.error.code}` : r.status;
        };

        /** A harness whose queue holds `maxQueued` requests at most, every sender funded. */
        async function relayWithQueue(maxQueued: number): Promise<void> {
            await h.close();
            h = await createHarness({ settings: { admission: { maxQueued } } });
            for (const key of KEYS) {
                const address = privateKeyToAccount(key).address;
                h.chain.setBalance(USDC, address, 10n ** 9n);
                h.chain.setAllowance(USDC, address, CONTRACT, 10n ** 12n);
            }
            h.chain.setBalance(USDC, OTHER_ADDRESS, 10n ** 9n);
        }

        /**
         * Fills the queue with `n` requests of other senders (KEYS) that the transaction manager holds at their spend cap
         * (the pipeline asks it through heldQueued); returns them, oldest first.
         */
        async function fillWithHeld(n: number): Promise<Hex[]> {
            const held: Hex[] = [];
            for (let i = 0; i < n; i++) {
                const t = await transfer({ key: KEYS[i % KEYS.length]!, mode: 'none', deadline: BigInt(h.clock.seconds() + 7000) });
                expect((await submit(t.body)).statusCode).toBe(202);
                held.push(t.id);
            }
            const txManager = h.relay.txManager as unknown as { heldInQueue: () => Array<{ id: Hex; capPerGas: bigint }> };
            txManager.heldInQueue = () => held.filter((id) => h.store.getRequest(id)?.status === 'queued').map((id) => ({ id, capPerGas: 400n }));
            return held;
        }

        /**
         * The transaction manager sent `id` and it was mined (in the block of the reads, so a submission's reads show it):
         * the sender's next nonce is the one after it.
         */
        function markMined(id: Hex): void {
            if (h.store.getNextNonce() === undefined) h.store.setNextNonce(0);
            const hash = keccak256(id);
            const attempt = { hash, raw: '0x02' as Hex, kind: 'call' as const, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI, gasLimit: 200_000n, sentBlock: h.chain.head.number };
            h.store.recordFirstAttempt(id, h.store.getNextNonce()!, attempt, h.clock.nowMs());
            h.store.markMined(id, { hash, blockNumber: h.chain.head.number, gasUsed: 1n, effectiveGasPrice: 1n }, h.clock.nowMs());
            const request = h.store.getRequest(id)!;
            h.chain.setIntentNonce(request.signer, BigInt(request.nonce) + 1n);
        }

        it('a sender may make one held request give way at a time: another version gets 503 before any RPC read until the first was sent or left the queue; other senders are not limited', async () => {
            await relayWithQueue(6);
            const held = await fillWithHeld(6);
            // A's first request takes the oldest held request's place.
            const a1 = await noneTransfer();
            expect((await submit(a1.body)).statusCode).toBe(202);
            expect(statusOf(held[0]!)).toBe('failed/fee_too_low');
            // Another version of A's request, while the first waits for its broadcast: 503 before any RPC read, nothing stored.
            const a2 = await noneTransfer({ amount: 2_000_000n });
            const reads = h.chain.reads.length;
            const refused = await codeOf(submit(a2.body));
            expect(refused).toBe('unavailable');
            expect(h.chain.reads.length).toBe(reads);
            expect(h.store.getRequest(a2.id)).toBeUndefined();
            expect(statusOf(held[1]!)).toBe('queued');
            expect(await events('sender_eviction')).toBe(1);
            // Control: other senders (B, and two more) are not limited.
            expect((await submit((await noneTransfer({ key: OTHER_KEY })).body)).statusCode).toBe(202);
            expect((await submit((await transfer({ key: KEYS[6]!, mode: 'none' })).body)).statusCode).toBe(202);
            expect((await submit((await transfer({ key: KEYS[7]!, mode: 'none' })).body)).statusCode).toBe(202);
            expect(held.slice(0, 4).map(statusOf)).toEqual(Array(4).fill('failed/fee_too_low'));
            // Once A's request was sent (and mined: A's next request is at the next nonce), A may make one more give way;
            // then again not until that one is sent. (The sent request freed its place in the queue: another sender takes it
            // first, without making anything give way.)
            markMined(a1.id);
            expect((await submit((await transfer({ key: KEYS[8]!, mode: 'none' })).body)).statusCode).toBe(202);
            expect(held.slice(4).map(statusOf)).toEqual(['queued', 'queued']);
            const a3 = await noneTransfer();
            expect(a3.body.request.nonce).toBe('1');
            expect((await submit(a3.body)).statusCode).toBe(202);
            expect(statusOf(held[4]!)).toBe('failed/fee_too_low');
            expect(await codeOf(submit((await noneTransfer({ amount: 2_000_000n })).body))).toBe('unavailable');
            // A request that left the queue unsent (it failed for a reason its sender does not control) gives it back too.
            h.store.finalize(a3.id, { status: 'failed', error: { code: 'token_paused', message: 'x' } }, undefined, h.clock.nowMs());
            expect((await submit((await transfer({ key: KEYS[9]!, mode: 'none' })).body)).statusCode).toBe(202);
            expect((await submit((await noneTransfer({ amount: 3_000_000n })).body)).statusCode).toBe(202);
            expect(held.map(statusOf)).toEqual(Array(6).fill('failed/fee_too_low'));
            expect(await events('evicted')).toBe(6);
            expect(await events('sender_eviction')).toBe(2);
        });

        it('control: a request that finds room in the queue does not use the right; it only matters in a full queue', async () => {
            await relayWithQueue(6);
            const held = await fillWithHeld(3);
            const a1 = await noneTransfer();
            expect((await submit(a1.body)).statusCode).toBe(202);
            for (const key of [KEYS[6]!, KEYS[7]!]) expect((await submit((await transfer({ key, mode: 'none' })).body)).statusCode).toBe(202);
            expect(held.map(statusOf)).toEqual(['queued', 'queued', 'queued']);
            expect(await events('sender_eviction')).toBe(0);
            // The queue is full now: A's next request (after the first was mined) takes a held place, another version 503.
            markMined(a1.id);
            expect((await submit((await transfer({ key: KEYS[8]!, mode: 'none' })).body)).statusCode).toBe(202);
            expect((await submit((await noneTransfer()).body)).statusCode).toBe(202);
            expect(await codeOf(submit((await noneTransfer({ amount: 2_000_000n })).body))).toBe('unavailable');
            expect(held.map(statusOf)).toEqual(['failed/fee_too_low', 'queued', 'queued']);
        });

        it('the right holds for concurrent submissions of one sender: step 9 checks it again, so only one takes a held place (control: two senders both do)', async () => {
            await relayWithQueue(4);
            const held = await fillWithHeld(4);
            const [x, y] = [await noneTransfer(), await noneTransfer({ amount: 2_000_000n })];
            gateSimulations(2);
            const same = await Promise.all([codeOf(submit(x.body)), codeOf(submit(y.body))]);
            // The second is a version at the same nonce: the nonce rule answers first (conflict), and it evicts nothing.
            expect(same.sort()).toEqual([202, 'conflict']);
            expect(held.filter((id) => statusOf(id) === 'failed/fee_too_low')).toHaveLength(1);
            expect(h.store.countByStatus('queued')).toBe(4);

            await relayWithQueue(4);
            const heldToo = await fillWithHeld(4);
            const [u, v] = [await noneTransfer(), await noneTransfer({ key: OTHER_KEY })];
            gateSimulations(2);
            const two = await Promise.all([codeOf(submit(u.body)), codeOf(submit(v.body))]);
            expect(two).toEqual([202, 202]);
            expect(heldToo.filter((id) => statusOf(id) === 'failed/fee_too_low')).toHaveLength(2);
        });

        it('not at all while the sender cools down, although it has no queued request (503); after RELAY_PREFLIGHT_COOLDOWN_SECONDS it may again', async () => {
            await relayWithQueue(3);
            // A's request fails its check before the broadcast because its sender burnt the intent nonce: A cools down.
            const burnt = await noneTransfer();
            expect((await submit(burnt.body)).statusCode).toBe(202);
            h.chain.invalidateNonces(USER_ADDRESS, 1n);
            await h.relay.txManager.recover();
            await h.relay.txManager.tick();
            expect(statusOf(burnt.id)).toBe('failed/nonce_used');
            expect(await events('cooldown_started')).toBe(1);
            const held = await fillWithHeld(3);
            const reads = h.chain.reads.length;
            expect(await codeOf(submit((await noneTransfer()).body))).toBe('unavailable');
            expect(h.chain.reads.length).toBe(reads);
            expect(held.map(statusOf)).toEqual(['queued', 'queued', 'queued']);
            expect(await events('sender_eviction')).toBe(1);
            // Control: another sender may.
            expect((await submit((await noneTransfer({ key: OTHER_KEY })).body)).statusCode).toBe(202);
            expect(statusOf(held[0]!)).toBe('failed/fee_too_low');
            // After the cool-down A may make one give way again.
            // This test's transaction manager makes no passes (its held requests are stubbed above), which would be a
            // reason to refuse every new request after that long: here it counts as able to send.
            (h.relay.txManager as unknown as { cannotSend: () => undefined }).cannotSend = () => undefined;
            h.clock.advance(601);
            expect((await submit((await noneTransfer()).body)).statusCode).toBe(202);
            expect(statusOf(held[1]!)).toBe('failed/fee_too_low');
        });
    });
});

describe('concurrent identical submissions', () => {
    it('a copy that was not stored when it passed step 4, but whose twin is stored before its step 6, gets 200 with the stored state', async () => {
        const t = await transfer();
        // A waits in step 8 until B has passed step 4; B then waits in step 5 until A is stored.
        const signal = () => {
            let resolve!: () => void;
            const promise = new Promise<void>((r) => {
                resolve = r;
            });
            return { promise, resolve };
        };
        const [aAtSimulation, releaseA, bAtFee, releaseB] = [signal(), signal(), signal(), signal()];
        const call = h.chain.call.bind(h.chain);
        h.chain.call = async (params: CallParams) => {
            aAtSimulation.resolve();
            await releaseA.promise;
            return call(params);
        };
        const tip = h.chain.getMaxPriorityFeePerGas.bind(h.chain);
        let tips = 0;
        h.chain.getMaxPriorityFeePerGas = async () => {
            tips += 1;
            if (tips === 2) {
                bAtFee.resolve();
                await releaseB.promise;
            }
            return tip();
        };
        const a = submit(t.body);
        await aAtSimulation.promise;
        const b = submit(t.body);
        await bAtFee.promise;
        releaseA.resolve();
        expect(await a).toEqual({ statusCode: 202, body: { id: t.id, status: 'queued' } });
        releaseB.resolve();
        // B now sees its twin as a pending permit of the same sender and token (sender_busy): it is the twin.
        expect(await b).toEqual({ statusCode: 200, body: { id: t.id, status: 'queued' } });
        expect(await h.metrics.registry.metrics()).toContain('relay_submissions_total{operation="transfer",outcome="duplicate"} 1');
    });
});

describe('pinned reads', () => {
    /** The block number of every contract read and simulation, by function name ('call' for simulations). */
    function recordBlocks(): Array<[string, bigint | undefined]> {
        const seen: Array<[string, bigint | undefined]> = [];
        const readContract = h.chain.readContract.bind(h.chain);
        const call = h.chain.call.bind(h.chain);
        h.chain.readContract = async <T>(c: ReadContractCall): Promise<T> => {
            seen.push([c.functionName, c.blockNumber]);
            return readContract<T>(c);
        };
        h.chain.call = async (params: CallParams) => {
            seen.push(['call', params.blockNumber]);
            return call(params);
        };
        return seen;
    }

    it('steps 4 to 8 read at the latest block when the transaction manager has no newer head', async () => {
        const seen = recordBlocks();
        expect((await submit((await transfer()).body)).statusCode).toBe(202);
        const head = h.chain.head.number;
        // Step 4 reads the intent nonce (the contract's nonces), steps 6 and 7 the token state (the token's nonces): all at B.
        expect(seen.map(([fn]) => fn)).toEqual(expect.arrayContaining(['nonces', 'balanceOf', 'call']));
        expect(seen.filter(([fn]) => fn === 'nonces')).toHaveLength(2);
        expect(seen.every(([, block]) => block === head)).toBe(true);
    });

    it("B is the transaction manager's newest head when that is ahead of the node's latest block", async () => {
        const txManager = h.relay.txManager as unknown as { viewHead: () => bigint | undefined };
        const head = h.chain.head.number;
        txManager.viewHead = () => head + 5n;
        let seen = recordBlocks();
        expect((await submit((await transfer({ token: USDT0, mode: 'metaTxApprove' })).body)).statusCode).toBe(202);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every(([, block]) => block === head + 5n)).toBe(true);
        // An older head does not lower B below the latest block.
        txManager.viewHead = () => head - 5n;
        seen = recordBlocks();
        expect((await submit((await transfer({ sender: 1 })).body)).statusCode).toBe(202);
        expect(seen.every(([, block]) => block === head)).toBe(true);
    });

    it('a node that does not have block B makes the submission unavailable (503); nothing stored', async () => {
        const head = h.chain.head.number;
        (h.relay.txManager as unknown as { viewHead: () => bigint }).viewHead = () => head + 1n;
        const readContract = h.chain.readContract.bind(h.chain);
        h.chain.readContract = async <T>(c: ReadContractCall): Promise<T> => {
            if (c.blockNumber !== undefined && c.blockNumber > head) throw new Error('header not found');
            return readContract<T>(c);
        };
        const t = await transfer();
        const err = await expectCode(t.body, 'unavailable');
        expect(err.statusCode).toBe(503);
        expect(h.store.getRequest(t.id)).toBeUndefined();
    });
});

describe('validation deadline and client disconnects', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function slowReads(ms: number): void {
        const readContract = h.chain.readContract.bind(h.chain);
        h.chain.readContract = async <T>(c: ReadContractCall): Promise<T> => {
            await sleep(ms);
            return readContract<T>(c);
        };
    }

    it('unavailable (503) with "nothing was stored" once RELAY_VALIDATION_TIMEOUT_MS has passed; the request is not stored later either', async () => {
        await h.close();
        h = await createHarness({ settings: { validationTimeoutMs: 150 } });
        slowReads(100);
        const t = await transfer();
        const started = Date.now();
        const err = await expectCode(t.body, 'unavailable');
        expect(Date.now() - started).toBeLessThan(1000);
        expect(err.statusCode).toBe(503);
        expect(err.message).toBe('The chain answered too slowly to validate this request in time; nothing was stored. Retry the same request.');
        await sleep(600);
        expect(h.store.getRequest(t.id)).toBeUndefined();
        expect(h.logs.text()).toContain('validation deadline passed; nothing stored');
        expect(await h.metrics.registry.metrics()).toContain('relay_submissions_total{operation="transfer",outcome="unavailable"} 1');
    });

    it('the deadline is bounded by the idle timeout of the listeners', async () => {
        await h.close();
        // A 1.5 s idle timeout leaves at most 1 s for validation, whatever RELAY_VALIDATION_TIMEOUT_MS says.
        h = await createHarness({ settings: { validationTimeoutMs: 30_000, httpLimits: { ...DEFAULT_HTTP_LIMITS, idleTimeoutMs: 1500 } } });
        slowReads(400);
        const started = Date.now();
        await expectCode((await transfer()).body, 'unavailable');
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(1400);
    });

    it('a signal that is aborted (the client is gone) stops the submission before anything is stored', async () => {
        const t = await transfer();
        await expect(h.relay.pipeline.submit(transferOperation, t.body, { signal: AbortSignal.abort() })).rejects.toMatchObject({
            code: 'unavailable',
            message: 'The connection was closed before the request was validated; nothing was stored.',
        });
        expect(h.store.getRequest(t.id)).toBeUndefined();

        // Aborted while the simulation (the last RPC read) runs: still nothing stored.
        const gone = new AbortController();
        const call = h.chain.call.bind(h.chain);
        h.chain.call = async (params) => {
            gone.abort();
            return call(params);
        };
        await expect(h.relay.pipeline.submit(transferOperation, t.body, { signal: gone.signal })).rejects.toMatchObject({ code: 'unavailable' });
        expect(h.store.getRequest(t.id)).toBeUndefined();
        expect(h.store.countRequests()).toBe(0);
    });
});
