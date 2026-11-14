// The re-check at the insert (docs/STEP-1-GAS-ABSTRACTION.md §6.3, step 9) and a mined request whose inclusion a reorg
// removed before the relay noticed.
//
// The atomic insert counts the sender's pending requests plus those included after the block B that the validation
// steps read (block_number > B). A request included at or below B is taken to be in the balance read. That does not
// hold when a reorg removed its inclusion and the relay has not processed the reorg yet (it does so at its next pass,
// within RELAY_POLL_INTERVAL_MS): the balance read on the new chain contains the funds again. A second request of the
// same sender whose debit, together with the first one (re-sent after the reorg), exceeds the balance would then cost
// the relay one reverted call.
//
// Sequential intent nonces close that window: the contract checks the signature over the signer's current nonce. A
// second request of the sender is at the first one's nonce (the reorg made it unused again: the relay refuses it as a
// conflict with the first, which still holds that nonce) or at the next one (not valid before the first executes:
// nonce_too_high, since the reorg removed the inclusion the relay counted). Either way the relay sends no second call;
// the first one is re-sent after the reorg and executes once.
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, parseTransaction, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { transferOperation } from '../../../src/operations/transfer.js';
import { RelayError } from '../../../src/errors.js';
import { CONTRACT, USDC, buildTransfer, createHarness, type BuiltTransfer, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';
import { MutablePrice, queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

const FEE = 10_000n; // 0.01
const DEBIT = 1_000_000n + FEE; // amount 1.00 + fee 0.01
const PRICE = 20_000_000n; // 0.20 USD per POL (8 decimals)

describe('step-9 re-check and a reorged inclusion', () => {
    it('while the relay has not processed a reorg, a second request of the sender is refused at either nonce; the first executes once', async () => {
        h = await createHarness({ priceSource: () => new MutablePrice(PRICE) });
        const chain = h.chain;
        await h.relay.txManager.recover();
        chain.setBalance(USDC, USER_ADDRESS, 1_500_000n); // covers one transfer, not two
        chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        // The chain reverts a transfer whose sender cannot pay (the fake does not check balances by itself).
        chain.executor = (tx) => {
            if (tx.to?.toLowerCase() !== CONTRACT.toLowerCase()) return 'success';
            const { args } = decodeFunctionData({ abi: gaslessTransferAbi, data: tx.data });
            const r = args[0] as { from: string; amount: bigint; fee: bigint };
            return (chain.token(USDC).balances.get(r.from.toLowerCase()) ?? 0n) >= r.amount + r.fee ? 'success' : 'reverted';
        };

        const first = await queue(h, { token: USDC, mode: 'none', fee: FEE });
        await tick(h);
        chain.mine();
        await tick(h);
        expect(stateOf(h, first.id).status).toBe('mined');
        const [firstCall] = h.store.listAttempts(first.id);

        // A reorg removes the block (the transfer is back in the mempool, the sender's balance and nonce are as before);
        // the relay notices at its next pass, two seconds later.
        chain.reorg(firstCall!.hash);
        chain.setBalance(USDC, USER_ADDRESS, 1_500_000n);
        h.clock.advance(2);
        expect(chain.intentNonce(USER_ADDRESS)).toBe(0n);
        // Meanwhile the same sender submits a second transfer, at its nonce on the new chain and at the next one.
        const sameNonce = await buildTransfer(h, { token: USDC, mode: 'none', fee: FEE, amount: 1_000_001n });
        const nextNonce = await buildTransfer(h, { token: USDC, mode: 'none', fee: FEE, nonce: 1n });
        const secondCalls = new Set<Hex>();
        const seconds = [sameNonce, nextNonce].map((t) => t.body.signature.toLowerCase());
        chain.broadcastHook = (raw) => {
            const tx = parseTransaction(raw);
            if (tx.to?.toLowerCase() !== CONTRACT.toLowerCase() || !tx.data) return;
            const { args } = decodeFunctionData({ abi: gaslessTransferAbi, data: tx.data });
            if (seconds.includes((args[1] as Hex).toLowerCase())) secondCalls.add(keccak256(raw));
        };
        const submit = async (t: BuiltTransfer): Promise<string> => {
            try {
                return String((await h!.relay.pipeline.submit(transferOperation, t.body)).statusCode);
            } catch (err) {
                if (!(err instanceof RelayError)) throw err;
                return err.code;
            }
        };
        const answers = { sameNonce: await submit(sameNonce), nextNonce: await submit(nextNonce) };
        await tick(h); // reorg seen: the first request is back in flight and re-sent
        chain.mine();
        await tick(h);
        expect({ answers, first: stateOf(h, first.id).status }).toEqual({ answers: { sameNonce: 'conflict', nextNonce: 'nonce_too_high' }, first: 'mined' });
        expect(chain.token(USDC).balances.get(USER_ADDRESS.toLowerCase())).toBe(1_500_000n - DEBIT); // the first transfer executed once
        expect(secondCalls.size).toBe(0); // no call of a second request
    });
});
