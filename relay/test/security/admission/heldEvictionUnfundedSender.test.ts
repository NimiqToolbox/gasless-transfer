// During a gas spike, held requests of other users must not give way to requests that are then never sent.
//
// In a full queue, a new request that pays the current price takes the place of a queued request held at its spend cap
// (failed, fee_too_low, final). A party can try to use that without paying: each of its requests covers the current
// price at acceptance and takes a held request's place; right after, the party moves its funds away, so its own request
// fails its check before the broadcast, unpaid. Unbounded, that would end every held payment in the queue for requests
// that pay nothing (a liveness problem: held payments of other users fail instead of waiting; no funds are at risk).
//
// The bound is per sender, the signed `from` (src/pipeline/senderAdmission.ts): a sender may have at most one queued
// request that took a held request's place. It may make another held request give way only once that request was sent
// or left the queue, and not at all while it cools down after a failed check before the broadcast
// (RELAY_PREFLIGHT_COOLDOWN_SECONDS). Without that right a full queue answers it 503 `unavailable`, as when nothing is
// held, before any RPC read and again at the insert (src/pipeline/pipeline.ts). The state is in memory.
//
// The scenario: a spike holds a whole queue of 100 requests of other users. The party has four senders with five
// requests each, 20 in all; it posts every request not stored yet again after each block, for 30 blocks.
// - A party that moves the funds away right after each acceptance: each sender's first request takes one held place
//   and fails its check unpaid; the sender then cools down and makes no other held request give way. The first
//   eviction of a sender is decided at the insert, before anyone can see that its request will not be sent, so the
//   bound is `gave way <= sent by the party + senders of the party`: at most four here.
// - Control, a party that keeps its funds: all twenty of its requests are stored, sent, and pay. Those that took a
//   held request's place did so one at a time per sender, each after the sender's previous one had been sent (the
//   others took places that sent requests had freed), so every held request that gave way gave way to a request that
//   was then sent. The posts in between that needed a held place get 503 (retryable, nothing stored).
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { RelayError } from '../../../src/errors.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { CONTRACT, USDC, buildTransfer, createHarness, TEST_TX_SETTINGS, type BuiltTransfer, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { queue } from '../../helpers/txManagerDriver.js';
import { SPIKE, blocksAt, label } from '../helpers/gasSpike.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** RELAY_MAX_QUEUED with its default (100); the party posts 20 requests. */
const QUEUE = 100;
const SHARE = 20;
const PARTY_KEYS: readonly Hex[] = Array.from({ length: 4 }, (_, i) => keccak256(stringToHex(`party ${i}`)));
const PARTY_FEE = 200_000n; // 0.20 USD: break-even at 600 gwei is 0.0252 USD, so it fits its cap
/** Blocks of the spike during which the party posts (2 s each). */
const BLOCKS = 30;
const ERROR_STRING = parseAbi(['error Error(string)']);

const count = (labels: readonly string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const l of labels) out[l] = (out[l] ?? 0) + 1;
    return out;
};

const SENT = ['submitted', 'mined', 'confirmed'];

async function run(moveFunds: boolean) {
    h = await createHarness({ settings: { admission: { maxQueued: QUEUE }, tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: 100n * 10n ** 18n } } });
    const x = h;
    await x.relay.txManager.recover();
    // USDC's transferFrom reverts when the balance is short (the fake chain's simulation does not check it).
    const simulate = x.chain.simulate;
    x.chain.simulate = (call) => {
        const outcome = simulate(call);
        if (!outcome.ok || call.to.toLowerCase() !== CONTRACT.toLowerCase()) return outcome;
        const { args } = decodeFunctionData({ abi: gaslessTransferAbi, data: call.data });
        const r = args[0] as { token: Address; from: Address; amount: bigint; fee: bigint };
        if ((x.chain.token(r.token).balances.get(r.from.toLowerCase()) ?? 0n) >= r.amount + r.fee) return outcome;
        return { ok: false, revertData: encodeErrorResult({ abi: ERROR_STRING, errorName: 'Error', args: ['ERC20: transfer amount exceeds balance'] }), message: 'execution reverted' };
    };
    x.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    // A full queue of 0.01 USD transfers accepted at 30 gwei; the base fee rises to 600 gwei before they are sent.
    const deadline = BigInt(x.clock.seconds() + 7000);
    const honest: Hex[] = [];
    for (let i = 0; i < QUEUE; i++) honest.push((await queue(x, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id);
    await blocksAt(x, 3, SPIKE);
    expect(x.relay.txManager.heldInQueue()).toHaveLength(QUEUE);

    // The party: four senders, five requests each (at their intent nonces 0 to 4: one pending at a time, each valid
    // once the previous one executed), each paying the spike price.
    const funds = 5n * (1n + PARTY_FEE);
    const pending: Array<{ sender: Address; t: BuiltTransfer }> = [];
    for (const key of PARTY_KEYS) {
        const sender = privateKeyToAccount(key).address;
        x.chain.setAllowance(USDC, sender, CONTRACT, 10n ** 12n);
        x.chain.setBalance(USDC, sender, moveFunds ? 0n : funds);
        for (let i = 0; i < 5; i++) {
            pending.push({ sender, t: await buildTransfer(x, { key, token: USDC, mode: 'none', amount: 1n, fee: PARTY_FEE, nonce: BigInt(i) }) });
        }
    }
    const party: Hex[] = [];
    const answers: string[] = [];
    /** For each request of the party that took a held place: whether the previous one of its sender had been sent. */
    const previousSent: boolean[] = [];
    const lastEvictor = new Map<string, Hex>();
    for (let block = 0; block < BLOCKS; block++) {
        // The party posts every request that is not stored yet, the refused ones again.
        for (const p of [...pending]) {
            // With moveFunds, the funds are there for the checks at acceptance and moved away right after the answer.
            if (moveFunds) x.chain.setBalance(USDC, p.sender, funds);
            const evictedBefore = await evictions(x);
            let answer: string;
            try {
                answer = String((await x.relay.pipeline.submit(transferOperation, p.t.body)).statusCode);
            } catch (err) {
                if (!(err instanceof RelayError)) throw err;
                answer = err.code;
            }
            if (moveFunds) x.chain.setBalance(USDC, p.sender, 0n);
            answers.push(answer);
            if (answer !== '202') continue;
            pending.splice(pending.indexOf(p), 1);
            party.push(p.t.id);
            if ((await evictions(x)) > evictedBefore) {
                const previous = lastEvictor.get(p.sender);
                previousSent.push(previous === undefined || SENT.includes(x.store.getRequest(previous)!.status));
                lastEvictor.set(p.sender, p.t.id);
            }
        }
        await blocksAt(x, 1, SPIKE);
    }
    const partyLabels = party.map((id) => label(x, id));
    return {
        honest: count(honest.map((id) => label(x, id))),
        party: count(partyLabels),
        sentByParty: partyLabels.filter((l) => SENT.includes(l)).length,
        answers: count(answers),
        evicted: await evictions(x),
        withheld: await admissionEvents(x, 'sender_eviction'),
        previousSent,
    };
}

async function admissionEvents(x: Harness, event: string): Promise<number> {
    const line = (await x.metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`relay_admission_events_total{event="${event}"}`));
    return line ? Number(line.split(' ').at(-1)) : 0;
}

const evictions = (x: Harness): Promise<number> => admissionEvents(x, 'evicted');

describe('held requests giving way to requests that are never sent', () => {
    it('control: a party that keeps its funds makes held requests give way one at a time per sender, each after its previous one was sent; every one of them gave way to a request that is then sent and pays', async () => {
        const facts = await run(false);
        console.log('[control] four senders, funds kept:', JSON.stringify(facts));
        // All twenty were stored and sent, and pay. Some took a place that a sent one had freed; the others took a held
        // request's place (the oldest ones: all caps are equal), and those held requests are the ones that gave way.
        expect(facts.sentByParty, JSON.stringify(facts)).toBe(SHARE);
        expect(facts.answers['202']).toBe(SHARE);
        expect(facts.evicted).toBeGreaterThanOrEqual(2);
        expect(facts.honest).toEqual({ 'failed/fee_too_low': facts.evicted, queued: QUEUE - facts.evicted });
        // One at a time: each took its held place only after the previous one of its sender had been sent;
        // the posts in between that needed a held place got 503 (retryable, nothing stored).
        expect(facts.previousSent).toEqual(Array(facts.evicted).fill(true));
        expect(facts.answers.unavailable).toBeGreaterThan(0);
        expect(facts.withheld).toBe(facts.answers.unavailable);
    });

    it('held requests of other users give way to requests whose senders move their funds away before they are sent only one at a time per sender, and not while the sender cools down (four senders: at most four)', async () => {
        const facts = await run(true);
        console.log('four senders, funds moved after acceptance:', JSON.stringify(facts));
        // Without the bound, twenty payments of other users would fail for twenty requests that are never sent and pay
        // nothing. Each sender's first request took one held place; after its failure the sender cooled down, and made
        // no other held request give way.
        expect(facts.honest['failed/fee_too_low'] ?? 0, JSON.stringify(facts)).toBeLessThanOrEqual(facts.sentByParty + PARTY_KEYS.length);
        expect(facts.honest.queued).toBeGreaterThanOrEqual(QUEUE - PARTY_KEYS.length);
        // Its posts that needed a held place were refused with 503 (the right was withheld, counted), nothing stored.
        expect(facts.answers.unavailable).toBeGreaterThan(0);
        expect(facts.withheld).toBe(facts.answers.unavailable);
    });
});
