// A balance read from a lagging node cannot make admission accept more than the sender's balance covers.
//
// RPC providers balance their load over several nodes, which are often a block or two apart. A balance read that goes
// to whatever node answers `latest` would allow this:
//   1. R1 of the sender is mined, and the transaction manager records it.
//   2. R2 arrives; the balance read is served by a node one block behind, which still shows R1's funds. R1 is not
//      pending any more, so its debit is not counted either.
//   3. R2 is accepted although only the stale balance covers it.
// A call accepted that way reverts on-chain at the relay's expense.
//
// So the relay reads steps 4 to 8 at one block B = max(the transaction manager's newest head, the chain's latest
// block), and the atomic insert (step 9) counts the sender's pending requests and those included after B, by block
// number (docs/STEP-1-GAS-ABSTRACTION.md §6.3, "One block for steps 4 to 8"). A node that does not have block B
// answers with an error, and the submission gets 503 `unavailable`; a node that has it answers the state at B, and
// every inclusion after B is counted.
//
// The lagging node here is modelled on every read: `latest` is its head (one block behind), reads and calls at a newer
// block fail as a real node does ("header not found"), and the sender's balance it reports is the one before R1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { BlockInfo, CallOutcome, CallParams, ReadContractCall } from '../../../src/chain/types.js';
import { buildTransfer, CONTRACT, createHarness, USDC, type Harness } from '../../helpers/harness.js';
import { USER_KEY } from '../../helpers/keys.js';

const user: Address = privateKeyToAccount(USER_KEY).address;
const DEBIT = 1_010_000n; // amount 1.00 + fee 0.01

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
    h.chain.setBalance(USDC, user, 2n * DEBIT); // R1 plus exactly one more transfer
    h.chain.setAllowance(USDC, user, CONTRACT, 10n ** 12n);
    // Simulation and execution check the balance, as the real token does.
    const balanceOk = (data: Hex): boolean => {
        const { args } = decodeFunctionData({ abi: gaslessTransferAbi, data });
        const r = args[0] as { from: Address; amount: bigint; fee: bigint };
        return (h.chain.token(USDC).balances.get(r.from.toLowerCase()) ?? 0n) >= r.amount + r.fee;
    };
    const revert: CallOutcome = {
        ok: false,
        revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'InsufficientAllowance', args: [0n, DEBIT] }),
        message: 'execution reverted',
    };
    const baseSimulate = h.chain.simulate;
    h.chain.simulate = (call) => (call.to.toLowerCase() === CONTRACT.toLowerCase() && !balanceOk(call.data) ? revert : baseSimulate(call));
    h.chain.executor = (tx) => (tx.to?.toLowerCase() === CONTRACT.toLowerCase() && !balanceOk(tx.data) ? 'reverted' : 'success');
});

afterEach(async () => {
    await h.close();
});

const post = (payload: unknown) => h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object });

/** R1 accepted, broadcast, mined, and recorded as mined by the transaction manager. Returns R1's block. */
async function r1Mined(): Promise<bigint> {
    const r1 = await buildTransfer(h, { mode: 'none' });
    expect((await post(r1.body)).statusCode).toBe(202);
    await h.relay.txManager.recover();
    await h.relay.txManager.tick();
    h.chain.mine();
    await h.relay.txManager.tick();
    expect(h.store.getRequest(r1.id)?.status).toBe('mined');
    expect(h.chain.token(USDC).balances.get(user.toLowerCase())).toBe(DEBIT);
    h.clock.advance(1);
    return h.store.getRequest(r1.id)!.blockNumber!;
}

/** From now on, every read is served by a node one block behind the head (before R1's block). */
function lagReads(): { restore: () => void; head: bigint } {
    const chain = h.chain;
    const head = chain.head.number - 1n;
    const original = { readContract: chain.readContract, getBlock: chain.getBlock, call: chain.call };
    const readContract = chain.readContract.bind(chain);
    const getBlock = chain.getBlock.bind(chain);
    const call = chain.call.bind(chain);
    const unknownBlock = (blockNumber: bigint | undefined): boolean => blockNumber !== undefined && blockNumber > head;
    chain.getBlock = async (tag: 'latest' | 'finalized'): Promise<BlockInfo> => {
        const block = await getBlock(tag);
        return tag === 'latest' ? { ...block, number: head } : block;
    };
    chain.readContract = async <T>(c: ReadContractCall): Promise<T> => {
        if (unknownBlock(c.blockNumber)) throw new Error(`header not found (block ${c.blockNumber})`);
        if (c.functionName === 'balanceOf' && (c.args?.[0] as string)?.toLowerCase() === user.toLowerCase()) {
            await readContract<T>(c);
            return (2n * DEBIT) as T; // the balance before R1
        }
        return readContract<T>(c);
    };
    chain.call = async (params: CallParams): Promise<CallOutcome> => {
        if (unknownBlock(params.blockNumber)) throw new Error(`header not found (block ${params.blockNumber})`);
        return call(params);
    };
    return {
        head,
        // The overrides are own properties of the fake; without them its prototype methods answer again.
        restore: () => {
            for (const name of Object.keys(original)) delete (chain as unknown as Record<string, unknown>)[name];
        },
    };
}

/** Two versions of the sender's next payment (at its next intent nonce: one can be accepted). */
async function submitTwo(): Promise<number[]> {
    const r2 = await buildTransfer(h, { mode: 'none' });
    const r3 = await buildTransfer(h, { mode: 'none', amount: 999_999n });
    return [(await post(r2.body)).statusCode, (await post(r3.body)).statusCode];
}

async function revertedRelayCalls(): Promise<number> {
    await h.relay.txManager.tick();
    h.chain.mine();
    await h.relay.txManager.tick();
    return [...h.chain.receipts.values()].filter((r) => r.status === 'reverted').length;
}

const queuedDebits = () => h.store.listByStatus('queued').reduce((sum, r) => sum + (r.debit ?? 0n), 0n);

describe('control: an up-to-date read node', () => {
    it('after R1 is mined, only one more transfer is accepted and nothing reverts', async () => {
        await r1Mined();
        const codes = await submitTwo();
        expect(codes.filter((c) => c === 202)).toHaveLength(1);
        expect(await revertedRelayCalls()).toBe(0);
    });
});

describe('a balance read from a node one block behind', () => {
    it('does not accept more than the balance covers, and the relay pays for no reverted call', async () => {
        await r1Mined();
        const lag = lagReads();
        const codes = await submitTwo();
        lag.restore();
        const queued = queuedDebits();
        const reverted = await revertedRelayCalls();
        console.log(`answers ${JSON.stringify(codes)}, queued debits ${queued} for a balance of ${DEBIT}, relay-paid reverted calls ${reverted}`);
        expect.soft(queued, 'queued debits exceed the balance').toBeLessThanOrEqual(DEBIT);
        expect(reverted, 'relay-paid reverted calls').toBe(0);
    });

    // With sequential nonces the sender's next request is at R1's nonce + 1, which the reads at that head do not show
    // valid yet: the relay refuses it as sender_busy (just_mined, retryable) instead of simulating it at a stale nonce,
    // and accepts it once the node shows R1.
    it("read at the lagging node's head, which does not show R1 (included after that block): the sender's next request is just_mined (409, retryable), nothing stored", async () => {
        const r1Block = await r1Mined();
        // Without a transaction manager head (as before its first pass), B is the latest block the (lagging)
        // node reports.
        (h.relay.txManager as unknown as { viewHead: () => bigint | undefined }).viewHead = () => undefined;
        const lag = lagReads();
        expect(lag.head).toBeLessThan(r1Block);
        const r2 = await buildTransfer(h, { mode: 'none' });
        const r3 = await buildTransfer(h, { mode: 'none', amount: 999_999n });
        const answers = [await post(r2.body), await post(r3.body)];
        lag.restore();
        for (const res of answers) {
            expect(res.statusCode).toBe(409);
            expect(res.json()).toMatchObject({ error: { code: 'sender_busy', message: expect.stringContaining('just mined') } });
        }
        expect(queuedDebits()).toBe(0n);
        // The node caught up: one of the two is accepted, within the balance.
        expect([(await post(r2.body)).statusCode, (await post(r3.body)).statusCode]).toEqual([202, 409]);
        expect(queuedDebits()).toBe(DEBIT);
        expect(await revertedRelayCalls()).toBe(0);
    });

    it("reads are pinned at least to the transaction manager's newest head; a node without that block gives 503, nothing stored", async () => {
        const r1Block = await r1Mined();
        // The transaction manager's last pass saw R1's block (TxManager.viewHead()); set explicitly here.
        (h.relay.txManager as unknown as { viewHead: () => bigint }).viewHead = () => r1Block;
        const lag = lagReads();
        const codes = await submitTwo();
        lag.restore();
        expect(codes).toEqual([503, 503]);
        expect(queuedDebits()).toBe(0n);
        expect(await revertedRelayCalls()).toBe(0);
        // Once the node has caught up, the same sender is served, within its balance.
        expect((await submitTwo()).filter((c) => c === 202)).toHaveLength(1);
    });
});
