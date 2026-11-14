// A lying RPC that is first in RELAY_RPC_URLS reports block numbers higher than the real ones. It must not decide alone
// whether an executed request gets a second call, or whether it failed because its sender invalidated its nonce.
//
// Both decisions concern a request whose tx nonce is used while no receipt of its call is visible
// (TxManager.nonceUsedWithoutReceipt, observeNonce, usedIntentNonce), and both need every configured RPC in the same
// pass. The lie aims at leaving the honest RPC out: the liar reports its head (and its `finalized` tag) a million
// blocks ahead, so that the honest RPC, at the real head, looks older than the relay's observation. If an RPC with a
// lower head did not count, only the liar would answer:
// - (requeue) it shows the intent nonce unused and the observation final, so the request would get a new tx nonce. The
//   second call reverts on the honest chain (the intent nonce is used), the relay pays for it, and a transfer that
//   executed once would end `failed`.
// - (nonce_used) it shows the intent nonce used and answers a forged NonceInvalidated log covering it, so the request
//   would fail with nonce_used although the honest RPC shows its execution.
//
// No RPC's block numbers decide for another (relay/docs/transaction-lifecycle.md, "Decisions requiring every
// provider"). Evidence against a decision (a receipt of one of the request's transactions, the intent nonce used on one
// RPC and unused on another) counts from any RPC, whatever its head; the evidence for it is judged on each RPC against
// its own head and `finalized` tag. Here the honest RPC answers the whole time and shows the receipt of the executed
// call in every pass, so the request waits. The controls tell the same lies with the real block numbers.
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem';
import { gaslessTransferAbi, usdcAbi } from '@nimiq/gasless-sdk/core';
import type { BlockInfo, CallOutcome, ChainLog, ReadContractCall, ReceiptInfo } from '../../../src/chain/types.js';
import { CONTRACT, USDC, createHarness, type Harness } from '../../helpers/harness.js';
import { RECIPIENT_ADDRESS, USER_ADDRESS } from '../../helpers/keys.js';
import { queue, stateOf, tick } from '../../helpers/txManagerDriver.js';
import { counter, intentNonceUsed, isRelayTransferFor, relayCallNonces } from '../helpers/relayObservations.js';
import { drive } from '../helpers/finalizedChain.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** How far ahead the liar reports block numbers. */
const OFFSET = 1_000_000n;
/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value): the token transfer of an execution. */
const ERC20_TRANSFER_TOPIC = encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer' })[0];

/**
 * A NONE transfer that the honest chain executes at tx nonce 0; then the relay's own client (the chain object, the
 * first RPC) starts lying: block numbers + OFFSET, no receipt for the executed call. `rpcClients` lists the liar
 * first and an honest RPC (the chain's true state) second.
 */
async function executedThenLiarFirst(harness: Harness, offset = OFFSET): Promise<{ intentNonce: string; signature: Hex; id: Hex; call1: Hex }> {
    const { chain } = harness;
    chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 2_000_000n);
    const t = await queue(harness, { token: USDC, mode: 'none', amount: 1_000_000n, fee: 10_000n });
    await tick(harness);
    const [call1] = harness.store.listAttempts(t.id);
    expect(call1).toMatchObject({ kind: 'call', txNonce: 0 });
    chain.mine();
    expect(chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase())).toBe(1_000_000n); // executed once
    expect(intentNonceUsed(harness, USER_ADDRESS, t.request.nonce)).toBe(true);

    const honest = chain.rpcView();
    chain.rpcClients = () => [chain, honest]; // RELAY_RPC_URLS=<liar>,<honest>
    const realBlock = chain.getBlock.bind(chain);
    chain.getBlock = async (tag): Promise<BlockInfo> => {
        const block = await realBlock(tag);
        return { ...block, number: block.number + offset };
    };
    const realReceipt = chain.getTransactionReceipt.bind(chain);
    chain.getTransactionReceipt = async (hash: Hex): Promise<ReceiptInfo | null> =>
        hash.toLowerCase() === call1!.hash.toLowerCase() ? null : realReceipt(hash);
    return { intentNonce: t.request.nonce, signature: t.body.signature, id: t.id, call1: call1!.hash };
}

/**
 * The liar also says that the request never executed: the intent nonce unused (nonces(from) still at it), the call
 * would still succeed. The honest chain reverts a second call.
 */
function liarSaysNotExecuted(harness: Harness, signature: Hex, intentNonce: string): void {
    const { chain } = harness;
    const realRead = chain.readContract.bind(chain);
    chain.readContract = (async <T>(c: ReadContractCall): Promise<T> =>
        c.functionName === 'nonces' && String(c.args?.[0]).toLowerCase() === USER_ADDRESS.toLowerCase() ? (BigInt(intentNonce) as T) : realRead<T>(c)) as typeof chain.readContract;
    const realSimulate = chain.simulate;
    chain.simulate = (c): CallOutcome => (isRelayTransferFor(c.data, signature) ? { ok: true, data: '0x' } : realSimulate(c));
    chain.executor = (tx) => (isRelayTransferFor(tx.data, signature) && intentNonceUsed(harness, USER_ADDRESS, intentNonce) ? 'reverted' : 'success');
}

/** The liar's logs: a forged NonceInvalidated(signer, nonce, nonce + 1), and no token transfer of the executed call. */
function liarForgesInvalidation(harness: Harness, intentNonce: string): Hex {
    const topics = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer: USER_ADDRESS } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(intentNonce), BigInt(intentNonce) + 1n]);
    harness.chain.getLogs = async (filter): Promise<readonly ChainLog[]> => [
        {
            address: CONTRACT,
            topics,
            data,
            blockNumber: filter.toBlock,
            blockHash: toHex(filter.toBlock, { size: 32 }),
            transactionHash: keccak256(toHex('forged invalidateNonces')),
        },
    ];
    return topics[0]!;
}

async function requeueFacts(harness: Harness, id: Hex, signature: Hex) {
    const record = harness.store.getRequest(id)!;
    return {
        relayCallTxNonces: relayCallNonces(harness, signature),
        requeued: await counter(harness, 'relay_nonce_events_total', 'event="requeued"'),
        status: stateOf(harness, id).status,
        settled: record.settledAtMs !== null,
        recipientReceived: harness.chain.token(USDC).balances.get(RECIPIENT_ADDRESS.toLowerCase()),
    };
}

async function invalidationFacts(harness: Harness, id: Hex, forgedTopic: Hex) {
    const state = stateOf(harness, id);
    return {
        status: state.status,
        code: state.error?.code ?? null,
        nonceInvalidatedEvents: await counter(harness, 'relay_nonce_events_total', 'event="nonce_invalidated"'),
        honestShowsExecutionTrace: harness.chain.logs.some((l) => l.topics[0] !== forgedTopic && l.topics[0] === ERC20_TRANSFER_TOPIC),
    };
}

/** While the honest RPC answers, the request waits: one call, no requeue, not failed. */
const WAITS = { relayCallTxNonces: [0], requeued: 0, status: 'submitted', settled: false, recipientReceived: 1_000_000n };
const NOT_INVALIDATED = { status: 'submitted', code: null, nonceInvalidatedEvents: 0, honestShowsExecutionTrace: true };

describe('a lying first RPC that reports higher block numbers cannot leave the honest RPC out', () => {
    it('an executed transfer gets no second call and is not reported failed (liar first, honest second, liar reports head + 1e6)', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { intentNonce, signature, id } = await executedThenLiarFirst(h);
        liarSaysNotExecuted(h, signature, intentNonce);
        await drive(h, 60);
        const facts = await requeueFacts(h, id, signature);
        // A second call at tx nonce 1 would revert on-chain at the relay's cost and end the request `failed`, settled.
        expect(facts).toEqual(WAITS);
    });

    it('an executed transfer is not failed with nonce_used on a forged NonceInvalidated log (liar first, honest second, liar reports head + 1e6)', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { intentNonce, id } = await executedThenLiarFirst(h);
        // nonces(from) is past the intent nonce on both RPCs (the truth); only the liar's logs lie.
        const forged = liarForgesInvalidation(h, intentNonce);
        await drive(h, 40);
        const facts = await invalidationFacts(h, id, forged);
        // The honest RPC shows the receipt of exactly this request's call (and its logs the call's token transfer): the
        // relay must keep waiting instead of failing the request with nonce_used.
        expect(facts).toEqual(NOT_INVALIDATED);
    });

    // Controls: the same lies with the real block numbers. The higher block numbers are the only difference to the
    // tests above, and the outcome is the same.
    it('control: the same lies with the real block numbers get no second call', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { intentNonce, signature, id } = await executedThenLiarFirst(h, 0n);
        liarSaysNotExecuted(h, signature, intentNonce);
        await drive(h, 60);
        expect(await requeueFacts(h, id, signature)).toEqual(WAITS);
    });

    it('control: the same forged log with the real block numbers does not fail the request', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const { intentNonce, id } = await executedThenLiarFirst(h, 0n);
        const forged = liarForgesInvalidation(h, intentNonce);
        await drive(h, 40);
        expect(await invalidationFacts(h, id, forged)).toEqual(NOT_INVALIDATED);
    });
});
