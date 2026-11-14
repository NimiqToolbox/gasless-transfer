// Chain reorganizations against the relay's request states (anvil evm_snapshot / evm_revert). A revert removes
// the blocks after the snapshot and their transactions; the test then decides what the "new" chain contains.
import { afterEach, describe, expect, it } from 'vitest';
import { parseGwei, type Hex } from 'viem';
import { confirmOnChain } from '@nimiq/gasless-sdk/viem';
import {
    RECIPIENT,
    anvilAccount,
    dropAllTransactions,
    inMempool,
    intentNonceUsed,
    lastBlockOrder,
    mineAndTick,
    mockTokenAbi,
    relayNonces,
    sendFrom,
    sendRaw,
    signTransfer,
    startFaultEnv,
    status,
    submit,
    tick,
    type FaultEnv,
    type SignedTransfer,
} from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

/** The intent nonce of `t` is used (executed or invalidated). */
const nonceUsed = (e: FaultEnv, t: SignedTransfer): Promise<boolean> => intentNonceUsed(e.stack, t);

describe('reorg after mined, before confirmed', () => {
    it('a mined request whose block is reorged away is re-broadcast from the stored raw transaction once the new chain has a block made after the relay recorded the outcome, and mined again', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const a = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        const snapshot = await stack.testClient.snapshot();
        await stack.mine();
        await tick(relay);
        expect(await status(relay, a.id)).toBe('mined');

        await stack.testClient.revert({ id: snapshot }); // the block and its transaction are gone
        expect(await nonceUsed(env, a)).toBe(false);
        const [x] = relay.server.store.listAttempts(a.id);
        // The node's head is now the block before the outcome, made before the relay recorded the outcome. Undoing
        // a mined outcome needs every RPC's head made after the moment the relay recorded the outcome, by the head's
        // timestamp against the relay's clock (an RPC whose head is older may not have seen the inclusion yet, like
        // a lagging one), so the request stays mined and nothing is sent.
        await tick(relay);
        expect(await status(relay, a.id)).toBe('mined');
        expect(await inMempool(stack, x!.hash)).toBe(false);
        // The new chain's next block, without the transaction, made after the recording: two seconds past the relay's
        // clock now (block timestamps are whole seconds, and the removed block may have had the next one).
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000) + 2) });
        await stack.mine();
        await tick(relay); // reorg confirmed: back to submitted, stored raw re-sent
        expect(await status(relay, a.id)).toBe('submitted');
        expect(await inMempool(stack, x!.hash)).toBe(true);
        await mineAndTick(env, 2);
        const state = await relay.state(a.id);
        expect(state.status).toBe('mined');
        expect(state.txHash).toBe(x!.hash);
        expect(await nonceUsed(env, a)).toBe(true);
        await mineAndTick(env, 65);
        expect(await status(relay, a.id)).toBe('confirmed');
    });
});

describe('reorg after a failure state decided by an inclusion (provisional until that block is final)', () => {
    it('a reorg that includes the original call instead of the cancel turns the provisional "expired" into "mined" with that call', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const a = await signTransfer(stack, relay, { from: 2, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 5_000_000n, deadlineSeconds: 90 });
        const deadline = BigInt(a.body.request.deadline);
        await submit(relay, a);
        await tick(relay);
        const [call] = relay.server.store.listAttempts(a.id);
        const callRaw = call!.raw!;

        // The call is not included (congestion); two seconds before the deadline the relay cancels it.
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: call!.maxFeePerGas * 3n });
        await stack.testClient.setNextBlockTimestamp({ timestamp: deadline - 2n });
        await stack.mine();
        await tick(relay);
        const [, cancel] = relay.server.store.listAttempts(a.id);
        expect(cancel?.kind).toBe('cancel');

        // Branch 1: the cancel is mined; the request is expired, provisionally (it keeps what a re-send needs until
        // that block is final).
        const fork = await stack.testClient.snapshot();
        await stack.testClient.setNextBlockTimestamp({ timestamp: deadline - 1n });
        await stack.mine();
        await tick(relay);
        expect(await status(relay, a.id)).toBe('expired');

        // Branch 2 wins: its proposer had the original call (not the cancel) in its pool.
        await stack.testClient.revert({ id: fork });
        await dropAllTransactions(stack);
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('1') });
        await sendRaw(stack, callRaw as Hex);
        await stack.testClient.setNextBlockTimestamp({ timestamp: deadline - 1n });
        await stack.mine();
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: call!.hash });
        expect(receipt.status).toBe('success');
        expect(await nonceUsed(env, a)).toBe(true); // the transfer executed, the relay was paid
        await mineAndTick(env, 3);

        const state = await relay.state(a.id);
        // What a wallet following sdk/README sees: waitForRequest and the on-chain check agree.
        const waited = await relay.client.waitForRequest(a.id, { until: 'mined', timeoutMs: 2_000 }).then(
            (s) => s.status,
            (err: unknown) => (err as { code?: string }).code ?? String(err),
        );
        const onChain = await confirmOnChain(stack.publicClient, relay.pins, { request: a.body.request }, { txHash: call!.hash });
        console.log('reorg includes the call instead of the cancel', { status: state.status, error: state.error, txHash: state.txHash, executedTx: call!.hash, sdkWaitForRequest: waited, sdkConfirmOnChain: onChain.status });
        // Whichever transaction takes the nonce decides the final state (relay/docs/transaction-lifecycle.md): mined.
        expect({ status: state.status, txHash: state.txHash }).toEqual({ status: 'mined', txHash: call!.hash });
        expect({ waited, onChain: onChain.status }).toEqual({ waited: 'mined', onChain: 'executed' });
    });

    it('a reorg that removes the reverted call of a failed request puts it back in flight ("failed" is provisional): no nonce gap, the later requests are mined', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const user = anvilAccount(3);
        const f = await signTransfer(stack, relay, { from: 3, token: stack.usdt0, authMode: 'none', to: RECIPIENT, amount: 1_000_000n });
        await sendFrom(stack, user, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 1_000_000n + BigInt(f.body.request.fee)] }, { maxFeePerGas: parseGwei('100'), maxPriorityFeePerGas: parseGwei('1') });
        await stack.mine();
        await submit(relay, f);
        await tick(relay);
        const start = await relayNonces(stack, relay.address);

        // The user revokes the allowance ahead of the relay's call: the call reverts, f is finalized as failed.
        await sendFrom(stack, user, { address: stack.usdt0, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 0n] }, { maxFeePerGas: parseGwei('500'), maxPriorityFeePerGas: parseGwei('200') });
        const fork = await stack.testClient.snapshot();
        await stack.mine();
        console.log('reverted call reorged away: block order', (await lastBlockOrder(stack)).map((x) => ({ from: x.from.slice(0, 8), nonce: x.nonce, tip: x.tip })));
        await tick(relay);
        expect(await status(relay, f.id)).toBe('failed');

        // A later request gets the next relay nonce.
        const g = await signTransfer(stack, relay, { from: 4, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n, deadlineSeconds: 120 });
        await submit(relay, g);
        await tick(relay);
        expect(relay.server.store.getRequest(g.id)!.txNonce).toBe(start.pending); // nonce after f's

        // Reorg: the block with f's reverted call (and the user's revoke) is gone. g's transaction stays in the pool;
        // the node does not re-include the call of f. "failed" is provisional until final, so the relay still has
        // the raw transaction of f and re-sends it; without it nothing would fill the nonce.
        const [fCall] = relay.server.store.listAttempts(f.id);
        const [gCall] = relay.server.store.listAttempts(g.id);
        await stack.testClient.revert({ id: fork });
        const pool = { fCallInPool: await inMempool(stack, fCall!.hash), gCallInPool: await inMempool(stack, gCall!.hash) };
        if (pool.fCallInPool) await stack.testClient.dropTransaction({ hash: fCall!.hash });
        if (!pool.gCallInPool) await sendRaw(stack, gCall!.raw as Hex); // what the network still has
        await mineAndTick(env, 15);

        const record = relay.server.store.getRequest(g.id)!;
        const after = await relayNonces(stack, relay.address);
        console.log('reverted call reorged away', { ...pool, fRawAfterFailed: fCall!.raw, gStatus: record.status, gTxNonce: record.txNonce, chainNonce: after, fStatus: (await relay.state(f.id)).status });

        // The deadline of g passes. (With a gap left at the nonce of f, a cancel at the nonce of g could not be mined
        // either.)
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(g.body.request.deadline) + 1n });
        await mineAndTick(env, 12);
        const h = await signTransfer(stack, relay, { from: 5, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, h);
        await mineAndTick(env, 12);
        const final = {
            g: (await relay.state(g.id)).status,
            gAttempts: relay.server.store.listAttempts(g.id).map((x) => x.kind),
            h: (await relay.state(h.id)).status,
            hTxNonce: relay.server.store.getRequest(h.id)!.txNonce,
            chainNonce: await relayNonces(stack, relay.address),
        };
        console.log('reverted call reorged away: after the deadline', final);
        expect(record.status).toBe('mined');
        // f is back in flight after the reorg; the reorg also removed the revoke, so its re-sent call succeeds.
        expect((await relay.state(f.id)).status).toBe('mined');
        expect(final).toMatchObject({ g: 'mined', h: 'mined', hTxNonce: start.pending + 1 });
    });
});
