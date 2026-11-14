// During a gas spike, a queued request that pays the current price but cannot be sent does not make the relay cancel
// the requests held in flight at their spend cap.
//
// A held in-flight request is cancelled with fee_too_low when a request that could go waits behind it. The spend-cap
// pre-check looks at the fee and the gas limit only; whether a request could be sent (its funds, its allowance, its
// nonce) is known only from its full check. A sender can submit a request at the spike price and move its funds away
// right after acceptance. If that request counted as waiting, the relay would cancel every held request for it: one
// cancel each (21000 gas at spike prices), and each of those users gets failed/fee_too_low where the held call would
// have gone through once the spike passed. The request itself would never be sent and its fee never paid, so the
// sender pays only the gas of one token transfer per repetition, for as long as the spike lasts.
//
// So before a held in-flight request is cancelled for a queued one, the queued request gets its full check at the
// pass's head (TxManager.queuedCanGo: simulation and estimate, within the pass's budget of full checks); only one that
// passes and fits its spend cap counts as waiting. Here the newcomer fails that check (its funds are gone): it ends
// failed, unpaid, and nobody is cancelled. What the check cannot see is a sender that moves its funds away after it:
// the relay decides on the chain state of the pass's head.
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, parseAbi, type Address, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { transferOperation } from '../../../src/operations/transfer.js';
import { CONTRACT, USDC, buildTransfer, createHarness, type Harness } from '../../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER_ADDRESS } from '../../helpers/keys.js';
import { queue, tick } from '../../helpers/txManagerDriver.js';
import { counter } from '../helpers/relayObservations.js';
import { SPIKE, blocksAt, label } from '../helpers/gasSpike.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const ERROR_STRING = parseAbi(['error Error(string)']);

/**
 * Three 0.01 USD requests of a wallet sent at 30 gwei and held at their caps during a 600 gwei spike; then another
 * sender submits a 0.20 USD request (break-even at 600 gwei is 0.0252 USD: it fits its cap) and, if `moveFunds`, moves
 * its USDC away right after acceptance. Then `spikeBlocks` (30) more blocks of the spike.
 */
async function run(moveFunds: boolean, spikeBlocks = 30) {
    h = await createHarness();
    await h.relay.txManager.recover();
    h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
    h.chain.setAllowance(USDC, OTHER_ADDRESS, CONTRACT, 10n ** 12n);
    h.chain.setBalance(USDC, OTHER_ADDRESS, 1_000_000n);
    // USDC's transferFrom reverts when the balance is short (the fake chain's simulation does not check it).
    const simulate = h.chain.simulate;
    h.chain.simulate = (call) => {
        const outcome = simulate(call);
        if (!outcome.ok || call.to.toLowerCase() !== CONTRACT.toLowerCase()) return outcome;
        const { args } = decodeFunctionData({ abi: gaslessTransferAbi, data: call.data });
        const r = args[0] as { token: Address; from: Address; amount: bigint; fee: bigint };
        if ((h!.chain.token(r.token).balances.get(r.from.toLowerCase()) ?? 0n) >= r.amount + r.fee) return outcome;
        return { ok: false, revertData: encodeErrorResult({ abi: ERROR_STRING, errorName: 'Error', args: ['ERC20: transfer amount exceeds balance'] }), message: 'execution reverted' };
    };
    const deadline = BigInt(h.clock.seconds() + 7000);
    const held: Hex[] = [];
    for (let i = 0; i < 3; i++) held.push((await queue(h, { token: USDC, mode: 'none', amount: 1n, fee: 10_000n, deadline })).id);
    await tick(h);
    await blocksAt(h, 20, SPIKE);
    expect(held.map((id) => label(h!, id))).toEqual(['submitted', 'submitted', 'submitted']);
    expect(await counter(h, 'relay_spend_cap_holds_total', 'kind="cancel"')).toBe(0);

    const t = await buildTransfer(h, { key: OTHER_KEY, token: USDC, mode: 'none', amount: 1n, fee: 200_000n });
    expect((await h.relay.pipeline.submit(transferOperation, t.body)).statusCode).toBe(202);
    if (moveFunds) h.chain.setBalance(USDC, OTHER_ADDRESS, 0n);
    await blocksAt(h, spikeBlocks, SPIKE);
    return {
        held: held.map((id) => label(h!, id)),
        newcomer: label(h, t.id),
        cancelledAtCap: await counter(h, 'relay_spend_cap_holds_total', 'kind="cancel"'),
    };
}

describe('held in-flight requests and a waiting request that cannot be sent', () => {
    it('control: a request that pays the spike price and keeps its funds makes the relay cancel the held ones, and it is sent and mined', async () => {
        // 50 blocks of the spike, more than the default 30: a held call behind a lower nonce keeps its fees until its
        // nonce is next, then gets one speed-up at once and is cancelled only at the next speed-up interval, so the
        // three give way one after the other.
        const facts = await run(false, 50);
        expect(facts.cancelledAtCap).toBe(3);
        expect(facts.held).toEqual(['failed/fee_too_low', 'failed/fee_too_low', 'failed/fee_too_low']);
        expect(['mined', 'confirmed']).toContain(facts.newcomer);
    });

    it('a waiting request whose sender moved its funds away does not make the relay cancel the held in-flight requests', async () => {
        const facts = await run(true);
        console.log('a waiting request without funds:', facts);
        expect(facts).toEqual({ held: ['submitted', 'submitted', 'submitted'], newcomer: 'failed/simulation_failed', cancelledAtCap: 0 });
    });
});
