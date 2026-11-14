// A call the relay decided to cancel is never broadcast again, also when the cancel cannot be priced and the node
// drops the call.
//
// The checks before a call leaves the relay (re-simulation pinned to the head, sender code of USDC permits) run
// before every re-broadcast of a call, and a request that can no longer succeed is cancelled
// (docs/STEP-1-GAS-ABSTRACTION.md §6.5 and relay/docs/transaction-lifecycle.md, "Checks before a call leaves the
// relay"). A cancel replaces the call, so it must outbid it by at least 10 %. During a gas spike the call may already
// pay close to RELAY_MAX_FEE_PER_GAS_GWEI: then no replacement can be priced, and the relay stores the decided outcome
// (pendingFinal) and waits. If the node then drops the call (a restart, an eviction), re-sending it would put a
// transaction back into the mempool that the relay knows can only revert (here: the user invalidated the intent
// nonce) or burn its gas limit (a USDC permit sender that added an EIP-7702 delegation), at the relay's cost.
//
// So the call is not sent again. With nothing left at the nonce, nothing needs to be outbid: the cancel goes out at
// market fees and fills the nonce.
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { GWEI } from '../../helpers/fakeChain.js';
import { USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('a call the relay decided to cancel is never re-broadcast', () => {
    it('with the cancel unpriceable and the call dropped, the call is not re-sent; a cancel at market fees fills the nonce', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        // A gas spike: base fee 1500 gwei. Market maxFeePerGas = 2 × 1500 + 30 → capped at RELAY_MAX_FEE_PER_GAS_GWEI (3000).
        h.chain.mine({ baseFee: 1500n * GWEI });
        const t = await queue(h, { token: USDC, mode: 'permit', fee: 100_000n }); // 0.10 USD covers break-even (0.0765)
        h.chain.includeFilter = () => false; // congested: the call is not picked up yet
        await tick(h);
        const [call] = h.store.listAttempts(t.id);
        expect(call!.maxFeePerGas).toBe(3000n * GWEI);

        // The user invalidates the intent nonce (front-running): the call can no longer succeed.
        h.chain.invalidateNonces(t.request.from, BigInt(t.request.nonce) + 1n);
        h.chain.executor = (tx) => (tx.hash === call!.hash ? 'reverted' : 'success');
        for (let i = 0; i < 10; i++) {
            h.chain.mine({ baseFee: 1500n * GWEI });
            await tick(h); // due: re-simulation reverts → cancel, which cannot outbid 3000 gwei within 3000 gwei
        }
        expect(h.store.getRequest(t.id)!.pendingFinal?.error.code).toBe('nonce_used');
        expect(h.logs.text()).toContain('cannot outbid the pending transaction');

        // The node drops its pool (restart, eviction). The relay knows the call can only revert.
        h.chain.dropMempool();
        const broadcastsBefore = h.chain.broadcasts.length;
        await tick(h);
        const sent = h.chain.broadcasts.slice(broadcastsBefore);
        const callResent = sent.some((raw: Hex) => keccak256(raw) === call!.hash);
        h.chain.includeFilter = () => true;
        h.chain.mine({ baseFee: 1500n * GWEI });
        await tick(h);
        const receipt = h.chain.receipts.get(call!.hash);
        // No unchecked re-broadcast of the failing call: re-sent, it would be mined and revert, and the relay would pay
        // for a full reverted call. The nonce is filled with a cancel instead.
        expect({ callResent, callMined: receipt?.status ?? null, status: stateOf(h, t.id).status }).toEqual({
            callResent: false,
            callMined: null,
            status: 'failed',
        });
        const cancel = parseTransaction(sent[0]!);
        expect({ to: cancel.to?.toLowerCase(), nonce: cancel.nonce, maxFeePerGas: cancel.maxFeePerGas }).toEqual({
            to: RELAY_ADDRESS.toLowerCase(),
            nonce: 0,
            maxFeePerGas: 3000n * GWEI, // market fees (2 × 1500 + 30, capped at RELAY_MAX_FEE_PER_GAS_GWEI)
        });
        expect(stateOf(h, t.id).error?.code).toBe('nonce_used');
    });
});
