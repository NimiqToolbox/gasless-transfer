// What griefing costs the relay: can a sender make the relay pay gas without earning a fee, and can one sender
// block another?
//
// - A sender who burns its intent nonce in the block of the relay's call makes the relay pay for one reverted call.
//   The loss is bounded: the relay spends exactly one call transaction on the request and does not retry.
// - A nonce burned before the broadcast costs the relay nothing: the simulation before the broadcast fails.
// - A sender's pending request never blocks another sender (sender_busy is keyed on the signer).
//
// Runs the real relay (production wiring) against anvil, with automine off and the transaction manager's loop
// stopped, so every transaction and every relay pass is observable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { signTransfer, startRelay, type RunningRelay, type SignedTransfer } from './helpers/relay.js';
import { anvilAccount, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;

beforeAll(async () => {
    stack = await startStack();
    // One test makes a request fail before its broadcast on purpose (its sender burns the nonce), which starts that
    // sender's cool-down (RELAY_PREFLIGHT_COOLDOWN_SECONDS). The cool-down is off and the per-signer limit raised, so
    // that only the rules under test (the check before the broadcast, sender_busy) decide the outcomes.
    relay = await startRelay(stack, { env: { RELAY_RATE_LIMIT_SIGNER_MAX: '100', RELAY_PREFLIGHT_COOLDOWN_SECONDS: '0' } });
    await relay.server.relay.txManager.stop();
    await stack.setAutomine(false);
});

afterAll(async () => {
    await relay?.stop();
    await stack?.stop();
});

const RECIPIENT: Address = anvilAccount(11).address;

async function relayPol(): Promise<bigint> {
    return stack.publicClient.getBalance({ address: relay.address });
}

/**
 * Sends a tx from an anvil account with an explicit priority fee AND an explicit gas limit, so we
 * control mempool ordering without triggering gas estimation against the pending block (which already
 * contains the relay's queued transaction).
 */
async function sendWithTip(fromIndex: number, call: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }, tipGwei: bigint): Promise<Hex> {
    const wallet = createWalletClient({ account: anvilAccount(fromIndex), chain: foundry, transport: http(stack.rpcUrl) });
    return wallet.writeContract({
        ...(call as Record<string, unknown>),
        gas: 120_000n,
        maxPriorityFeePerGas: tipGwei * 10n ** 9n,
        maxFeePerGas: tipGwei * 10n ** 9n + 200n * 10n ** 9n,
    } as never);
}

async function gasSpent(hash: Hex): Promise<bigint> {
    const r = await stack.publicClient.getTransactionReceipt({ hash });
    return r.gasUsed * r.effectiveGasPrice;
}

async function gasUsed(hash: Hex): Promise<bigint> {
    return (await stack.publicClient.getTransactionReceipt({ hash })).gasUsed;
}

describe('front-running after acceptance', () => {
    // The transfer's sender (anvil account 6) sends the griefing transaction itself: a user griefing the relay.
    it('a nonce burned in the SAME block after broadcast makes the relay pay for one reverted call and earn no fee', async () => {
        const from = 6;
        const t: SignedTransfer = await signTransfer(stack, relay, { from, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 3_000_000n });
        await relay.client.submitTransfer(t.body);

        const relayPolBefore = await relayPol();
        const relayFeeBefore = await stack.balanceOf(stack.usdc, relay.address);

        // tick → the relay simulates (OK) and broadcasts relayTransfer at its nonce (into the mempool, not mined).
        await relay.tick();
        const submitted = relay.server.store.listAttempts(t.id).filter((a) => a.kind === 'call');
        expect(submitted).toHaveLength(1);
        const relayTxHash = submitted[0]!.hash;

        // Griefer front-runs with invalidateNonces at a priority fee just above the relay's (min tip 30 gwei),
        // so anvil orders it first in the block. A realistic winning bid, not an overpay.
        const griefHash = await sendWithTip(from, { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(t.body.request.nonce) + 1n] }, 40n);
        await stack.mine(); // one block: invalidateNonces (higher tip) then the relay's relayTransfer (reverts)

        // The relay's call was mined but reverted (nonce already used).
        const relayReceipt = await stack.publicClient.getTransactionReceipt({ hash: relayTxHash });
        expect(relayReceipt.status).toBe('reverted');

        await relay.tick(); // reconcile: request → failed
        const state = await relay.state(t.id);
        expect(state.status).toBe('failed');

        // The relay paid gas for the reverted call and earned no fee.
        const relayGas = await gasSpent(relayTxHash);
        const attackerGas = await gasSpent(griefHash);
        const relayPolAfter = await relayPol();
        const relayFeeAfter = await stack.balanceOf(stack.usdc, relay.address);
        expect(relayFeeAfter).toBe(relayFeeBefore); // no fee earned
        expect(relayPolBefore - relayPolAfter).toBeGreaterThanOrEqual(relayGas); // relay is out of pocket

        // The loss is bounded: exactly one relay call transaction was spent, with no retry after the revert.
        expect(relay.server.store.listAttempts(t.id).filter((a) => a.kind === 'call')).toHaveLength(1);

        // Compare what each side pays: the relay's call pays for a full signature verification before it reverts on
        // the used nonce (the signature over nonces(from) does not recover any more); the griefer's invalidateNonces
        // is a single SSTORE and an event.
        const relayGasUnits = await gasUsed(relayTxHash);
        const attackerGasUnits = await gasUsed(griefHash);
        console.error(
            `relay reverted call used ${relayGasUnits} gas (POL ${relayGas} wei); attacker invalidateNonces used ${attackerGasUnits} gas (POL ${attackerGas} wei); relay/attacker gasUsed ratio=${(Number(relayGasUnits) / Number(attackerGasUnits)).toFixed(2)}`,
        );
        // The costs are comparable (~1:1): the reverted call and invalidateNonces each burn ~44k gas. The griefing
        // is bounded and roughly symmetric — it drains gas, never a fee, but is not cheap for the attacker.
        expect(relayGasUnits).toBeGreaterThan(21_000n);
        expect(attackerGasUnits).toBeGreaterThan(21_000n);
        const ratio = Number(relayGasUnits) / Number(attackerGasUnits);
        expect(ratio).toBeGreaterThan(0.3);
        expect(ratio).toBeLessThan(3);
    });

    it('a nonce burned BEFORE the broadcast tick costs the relay nothing (pre-broadcast simulation)', async () => {
        const from = 7;
        const t = await signTransfer(stack, relay, { from, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 3_000_000n });
        await relay.client.submitTransfer(t.body);

        // Burn the nonce and MINE it before the relay ticks.
        await sendWithTip(from, { address: stack.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(t.body.request.nonce) + 1n] }, 50n);
        await stack.mine();

        const relayPolBefore = await relayPol();
        await relay.tick(); // broadcastQueued re-simulates → revert → failed, nothing broadcast
        const state = await relay.state(t.id);
        expect(state.status).toBe('failed');
        // No call transaction was ever broadcast, so no POL was spent.
        expect(relay.server.store.listAttempts(t.id).filter((a) => a.kind === 'call')).toHaveLength(0);
        expect(await relayPol()).toBe(relayPolBefore);
    });

});

describe('sender_busy cannot be weaponised against other users', () => {
    it('the pending-permit slot is keyed on the signer, so it never blocks a different sender', async () => {
        // Victim (index 3) and attacker (index 4) are independent. The attacker cannot occupy the victim's slot
        // because occupying it requires a valid intent signature by the victim (step 3 rejects otherwise).
        const victim = await signTransfer(stack, relay, { from: 3, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        const attacker = await signTransfer(stack, relay, { from: 4, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await relay.client.submitTransfer(attacker.body); // attacker occupies THEIR OWN slot
        // The victim's own permit for the same token still goes through: different signer, different slot.
        await expect(relay.client.submitTransfer(victim.body)).resolves.toMatchObject({ status: 'queued' });
    });
});
