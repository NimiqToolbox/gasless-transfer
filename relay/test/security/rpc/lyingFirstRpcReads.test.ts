// A lying RPC that is first in RELAY_RPC_URLS cannot make the relay send an executed request a second time.
//
// Ordinary reads follow the first RPC that answers (viem `fallback`), while broadcasts go to every RPC. A malicious or
// broken first RPC therefore controls the relay's ordinary view of the chain, although the honest RPCs execute the
// broadcast. It can claim that a call that DID execute never did: a foreign transaction "took" the tx nonce (`latest`
// advanced, no receipt of the relay's call) and the request's own intent nonce is "still unused". A relay that
// believed it would requeue the request at a new tx nonce, report the executed transfer as `failed`, and pay for a
// second, reverted call.
//
// So the decisions that cannot be undone or that cost a transaction ask every configured RPC on its own
// (ChainClient.rpcClients) and need a positive answer from each of them in the same pass
// (relay/docs/transaction-lifecycle.md, "Decisions requiring every provider"). A request gets a new tx nonce only if
// every RPC shows its intent nonce unused, the tx nonce used, and no receipt of any of its transactions, and only once
// each RPC's own observation block is final by that RPC's own `finalized` tag. Any RPC that shows a receipt (or the
// intent nonce used, or the tx nonce unused) holds the requeue back, and so does an RPC that does not answer. Settling
// (the purge of the secrets) needs the same agreement. The trust model: at least one configured RPC is honest; a dead
// RPC delays these decisions. With a single RPC a lying node cannot be detected (last test below), which is why
// production needs at least two independent providers (relay/README.md, RELAY_RPC_URLS).
//
// The relay here has the liar first and one honest RPC, and the chain's finalized block advances, so that only the
// agreement of the RPCs stops the requeue. The lies are exactly what one node returns: `latest` advanced past the
// nonce, no receipt for the relay's call, nonces(victim) still at the request's nonce, and eth_call reports the nonce
// as free (all consistent with a node that claims a foreign transaction consumed the tx nonce).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import type { CallOutcome, ReadContractCall, ReceiptInfo } from '../../../src/chain/types.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { buildTransfer, createHarness, type BuiltTransfer, type Harness } from '../../helpers/harness.js';
import { RECIPIENT_ADDRESS, USER_ADDRESS } from '../../helpers/keys.js';
import { USDC } from '../../helpers/harness.js';
import { isRelayTransferFor } from '../helpers/relayObservations.js';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
    await h.relay.txManager.recover();
});

afterEach(async () => {
    await h.close();
});

function contractAddress(chain: Harness['chain']): string {
    return (chain as unknown as { contract: { address: string } }).contract.address;
}

/** True once `nonces(USER)` passed the intent nonce on the honest chain (the request executed, or the nonce was invalidated). */
function intentNonceUsed(chain: Harness['chain'], nonce: string): boolean {
    return chain.intentNonce(USER_ADDRESS) > BigInt(nonce);
}

/** Relay `relayTransfer` calls that were broadcast to the chain for the request with this signature. */
function relayCallBroadcasts(chain: Harness['chain'], signature: Hex): number {
    const contract = contractAddress(chain).toLowerCase();
    return chain.broadcasts.filter((raw) => {
        const tx = parseTransaction(raw);
        return tx.to?.toLowerCase() === contract && isRelayTransferFor(tx.data ?? '0x', signature);
    }).length;
}

/**
 * A relayed USDC transfer whose call the honest chain executes at tx nonce 0; afterwards the relay's own client
 * (h.chain, the first RPC) lies: it hides the call's receipt and says the intent nonce is unused (nonces(from) still
 * at it) and the call would still succeed. getTransactionCount, block reads, logs and broadcasts stay honest.
 */
async function executedThenLie(): Promise<{ built: BuiltTransfer; signature: Hex; call1: Hex }> {
    h.chain.setAllowance(USDC, USER_ADDRESS, contractAddress(h.chain), 2_000_000n);
    const built = await buildTransfer(h, { mode: 'none', amount: 1_000_000n, fee: 10_000n });
    const intentNonce = built.request.nonce;
    const signature = built.body.signature;
    expect((await h.relay.pipeline.submit(transferOperation, built.body)).statusCode).toBe(202);

    // Pass 1: broadcast the call at tx nonce 0.
    await h.relay.txManager.tick();
    const call1 = h.store.listAttempts(built.id).find((a) => a.kind === 'call')!;
    expect(call1.txNonce).toBe(0);

    // The honest chain mines and EXECUTES the call: funds move, nonces(victim) passes the intent nonce.
    h.chain.mine();
    expect(h.chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase()) ?? 0n).toBe(1_000_000n); // happened once
    expect(intentNonceUsed(h.chain, intentNonce)).toBe(true);

    const realReceipt = h.chain.getTransactionReceipt.bind(h.chain);
    h.chain.getTransactionReceipt = async (hash: Hex): Promise<ReceiptInfo | null> =>
        hash.toLowerCase() === call1.hash.toLowerCase() ? null : realReceipt(hash);
    const realRead = h.chain.readContract.bind(h.chain);
    h.chain.readContract = (async <T>(c: ReadContractCall): Promise<T> => {
        if (c.functionName === 'nonces' && String(c.args?.[0]).toLowerCase() === USER_ADDRESS.toLowerCase()) return BigInt(intentNonce) as T;
        return realRead<T>(c);
    }) as typeof h.chain.readContract;
    const realSimulate = h.chain.simulate;
    h.chain.simulate = (c): CallOutcome => (isRelayTransferFor(c.data, signature) ? { ok: true, data: '0x' } : realSimulate(c));
    // The honest chain reverts a second call at the already-used intent nonce (as the real contract would).
    h.chain.executor = (tx) => (isRelayTransferFor(tx.data, signature) && intentNonceUsed(h.chain, intentNonce) ? 'reverted' : 'success');
    return { built, signature, call1: call1.hash };
}

/** Well past RELAY_UNKNOWN_NONCE_GRACE_BLOCKS (12) and RELAY_MIN_FINALITY_DEPTH (16), the finalized tag at head. */
async function drive(blocks: number): Promise<void> {
    for (let i = 0; i < blocks; i++) {
        h.chain.mine();
        h.chain.finalized = h.chain.head.number;
        await h.relay.txManager.tick();
    }
}

describe('a lying first RPC cannot make the relay requeue an executed request', () => {
    it('with the liar first and one honest RPC, the executed transfer is never reported failed and no second call is sent', async () => {
        const { built, signature } = await executedThenLie();
        const honest = h.chain.rpcView();
        h.chain.rpcClients = () => [h.chain, honest]; // RELAY_RPC_URLS=<liar>,<honest>

        await drive(40);

        const record = h.store.getRequest(built.id)!;
        const calls = relayCallBroadcasts(h.chain, signature);
        // Safety (relay/docs/transaction-lifecycle.md): a request is never reported wrong and never gets a second tx
        // nonce while one of its transactions executed.
        expect(calls).toBe(1); // only one relay call should ever exist for one request
        expect(record.status).not.toBe('failed'); // it executed on-chain; reporting `failed` is wrong
        expect(await h.metrics.registry.metrics()).not.toContain('event="requeued"');
        // The request waits (its tx nonce is used, so it holds no in-flight slot); an ALERT follows after
        // RELAY_STUCK_AFTER_BLOCKS. The operator removes the lying RPC; then it resolves by the honest receipt.
        expect(record.status).toBe('submitted');
        h.chain.getTransactionReceipt = h.chain.rpcView().getTransactionReceipt; // the liar is gone
        await drive(1);
        // Mined at the honest receipt; its block is long final on both RPCs, so it is confirmed in the same pass.
        expect(h.store.getRequest(built.id)!.status).toBe('confirmed');
    });

    it('the ALERT after RELAY_STUCK_AFTER_BLOCKS names the waiting decision', async () => {
        await executedThenLie();
        const honest = h.chain.rpcView();
        h.chain.rpcClients = () => [h.chain, honest];
        await drive(170); // the first observation is 12 blocks after the lie; the ALERT 150 blocks later
        expect(await h.metrics.registry.metrics()).toContain('relay_decision_waits_total{decision="requeue"} 1');
        expect(h.logs.text()).toMatch(/ALERT: request 0x[0-9a-f]{64} has waited 150 blocks for a decision \(requeue\)/);
    });

    it('trust model: with a single RPC, a lying RPC cannot be detected; production needs at least two independent providers', async () => {
        const { built, signature } = await executedThenLie();
        await drive(40);
        // The only RPC agrees with itself: after the grace period and finality the request gets a new nonce, and the
        // second call reverts on the honest chain. relay/README.md (RELAY_RPC_URLS) documents this limit.
        expect(relayCallBroadcasts(h.chain, signature)).toBe(2);
        expect(h.store.getRequest(built.id)!.status).not.toBe('queued');
    });
});
