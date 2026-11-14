// Chain actions interleaved with the SDK's awaits: between prepareTransfer's reads, and between the two wallet
// prompts of signPrepared (the token authorization, then the intent). Whatever another party does in between on the
// production contract, the recipient is paid at most once and the outcome check tells what used the nonce.
// Local anvil only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, custom, encodeFunctionData, type Hex, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../../src/core/abi.js';
import { definePins } from '../../../src/core/pins.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { confirmOnChain, prepareTransfer, signPrepared, type PreparedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC } from '../../helpers/fixtures.js';
import { chainToolsAvailable, relayTransferArgs, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';

const AMOUNT = 1_000_000n;
const FEE = 10_000n;
const user = privateKeyToAccount(KEYS.user);
const holders = [ADDR.user, ADDR.recipient, ADDR.relay, ADDR.other] as const;

describe.skipIf(!chainToolsAvailable())('production contract: composed SDK preparation and signing races', () => {
    let ctx: ProductionChain;
    let snapshot: Hex;
    beforeAll(async () => { ctx = await startProductionChain(); }, 240_000);
    afterAll(async () => { await ctx?.stop(); });
    beforeEach(async () => { snapshot = await ctx.testClient.snapshot(); });
    afterEach(async () => { await ctx.testClient.revert({ id: snapshot }); });

    const fields = (now: number) => ({
        token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: FEE,
        relay: ADDR.relay, authMode: 'permit' as const, now,
    });
    const balances = () => Promise.all(holders.map(a => ctx.balanceOf(USDC, a)));
    const tokenNonce = () => ctx.publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'nonces', args: [ADDR.user] });
    const intentUsed = async (p: PreparedTransfer) => (await ctx.publicClient.readContract({
        address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [ADDR.user],
    })) > BigInt(p.request.nonce);
    async function finalized(p: PreparedTransfer, txHash?: Hex) {
        await ctx.testClient.mine({ blocks: 70 });
        return confirmOnChain(ctx.publicClient, ctx.pins, p, {
            blockTag: 'finalized', fromBlock: ctx.deployBlock, ...(txHash ? { txHash } : {}),
        });
    }
    function expectPaidOnce(before: bigint[], after: bigint[], fee = FEE, alternateRelay = false) {
        expect(after).toEqual([
            before[0]! - AMOUNT - fee, before[1]! + AMOUNT,
            before[2]! + (alternateRelay ? 0n : fee), before[3]! + (alternateRelay ? fee : 0n),
        ]);
    }
    // The token signature exists, but signPrepared is still awaiting its first wallet response.
    // Run the competing chain action before it requests the intent signature over that authorization.
    function interleavedSigner(work: () => Promise<void>): LocalAccount {
        let prompts = 0;
        return { ...user, signTypedData: async payload => {
            const signature = await user.signTypedData(payload);
            if (++prompts === 1) {
                expect(payload.primaryType).toBe('Permit');
                await work();
            }
            return signature;
        } };
    }

    it('token nonce advances between signing prompts: stale authorization fails atomically, same-intent correction pays once', async () => {
        const now = await ctx.now();
        const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, fields(now));
        // A separately authorized token permit overwrites allowance with a different exact value.
        const other = await prepareTransfer(ctx.publicClient, ctx.pins, { ...fields(now), fee: FEE + 1n });
        const authorization = (await signPrepared(user, other, ctx.pins, { now })).authorization;
        if (authorization.mode !== 'permit') throw new Error('expected permit fixture');
        const before = await balances();
        let interleaved = false;
        const body = buildSubmitTransferBody(await signPrepared(interleavedSigner(async () => {
            await ctx.send(KEYS.other, USDC, usdcAbi, 'permit', [
                ADDR.user, ctx.transfer, AMOUNT + FEE + 1n, BigInt(other.request.deadline),
                authorization.v, authorization.r, authorization.s,
            ]);
            interleaved = true;
        }), prepared, ctx.pins, { now }));
        expect(interleaved).toBe(true);
        expect(await tokenNonce()).toBe(1n);
        await expect(ctx.relayExecute(body)).rejects.toThrow();
        expect(await balances()).toEqual(before);
        expect(await intentUsed(prepared)).toBe(false);
        expect(await tokenNonce()).toBe(1n);

        const corrected = await prepareTransfer(ctx.publicClient, ctx.pins, {
            ...fields(await ctx.now()), corrects: prepared.request,
        });
        expect(corrected.request.nonce).toBe(prepared.request.nonce);
        const correctedBody = buildSubmitTransferBody(await signPrepared(user, corrected, ctx.pins, { now: await ctx.now() }));
        const receipt = await ctx.relayExecute(correctedBody);
        expectPaidOnce(before, await balances());
        expect(await tokenNonce()).toBe(2n);
        expect(await ctx.publicClient.readContract({
            address: USDC, abi: usdcAbi, functionName: 'allowance', args: [ADDR.user, ctx.transfer],
        })).toBe(0n);
        await expect(ctx.relayExecute(body)).rejects.toThrow();
        const result = await finalized(corrected, receipt.transactionHash);
        expect(result).toMatchObject({ status: 'executed', txHash: receipt.transactionHash });
        expect(result.executedTransfer?.request.nonce).toBe(prepared.request.nonce);
        expectPaidOnce(before, await balances());
    });

    it('invalidation between wallet prompts blocks the completed signature bundle before consuming token authorization', async () => {
        const now = await ctx.now();
        const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, fields(now));
        const before = await balances();
        const nonceBefore = await tokenNonce();
        let invalidation: Hex | undefined;
        const body = buildSubmitTransferBody(await signPrepared(interleavedSigner(async () => {
            invalidation = (await ctx.send(KEYS.user, ctx.transfer, gaslessTransferAbi, 'invalidateNonces', [BigInt(prepared.request.nonce) + 1n])).transactionHash;
        }), prepared, ctx.pins, { now }));
        expect(invalidation).toBeDefined();
        // The signature is checked first: the request is refused before the permit is used.
        await expect(ctx.relayExecute(body)).rejects.toThrow();
        expect(await intentUsed(prepared)).toBe(true);
        expect(await tokenNonce()).toBe(nonceBefore);
        expect(await balances()).toEqual(before);
        await expect(prepareTransfer(ctx.publicClient, ctx.pins, {
            ...fields(await ctx.now()), corrects: prepared.request,
        })).rejects.toMatchObject({ code: 'nonce_used' });
        expect(await finalized(prepared, invalidation)).toMatchObject({
            status: 'nonce_consumed', txHash: invalidation, executedTransfer: null,
        });
        expect(await balances()).toEqual(before);
    });

    it('older version executes immediately after the correction nonce check: later preparation cannot authorize a second payment', async () => {
        const now = await ctx.now();
        const original = await prepareTransfer(ctx.publicClient, ctx.pins, fields(now));
        const originalBody = buildSubmitTransferBody(await signPrepared(user, original, ctx.pins, { now }));
        const before = await balances();
        const nonceRead = encodeFunctionData({
            abi: gaslessTransferAbi, functionName: 'nonces', args: [ADDR.user],
        });
        let raced = false;
        let winningTx: Hex | undefined;
        const client = createPublicClient({ chain: ctx.chain, transport: custom({
            async request({ method, params }) {
                const result = await ctx.publicClient.request({ method, params } as never);
                const call = (params as [{ to?: string; data?: string }] | undefined)?.[0];
                if (!raced && method === 'eth_call' && call?.to?.toLowerCase() === ctx.transfer.toLowerCase() &&
                    call.data?.toLowerCase() === nonceRead.toLowerCase()) {
                    expect(BigInt(result as Hex)).toBe(0n); // The checked observation was genuinely unused.
                    raced = true;
                    winningTx = (await ctx.relayExecute(originalBody)).transactionHash;
                }
                return result;
            },
        }, { retryCount: 0 }) });
        const corrected = await prepareTransfer(client, ctx.pins, {
            ...fields(now), fee: FEE + 1n, corrects: original.request,
        });
        expect(raced).toBe(true);
        expect(corrected.request.nonce).toBe(original.request.nonce);
        const body = buildSubmitTransferBody(await signPrepared(user, corrected, ctx.pins, { now }));
        const nonceAfterWinner = await tokenNonce();
        await expect(ctx.relayExecute(body)).rejects.toThrow();
        expect(await tokenNonce()).toBe(nonceAfterWinner);
        expectPaidOnce(before, await balances());
        const result = await finalized(corrected);
        expect(result).toMatchObject({ status: 'other_version_executed', txHash: winningTx });
        expect(result.executedTransfer?.request).toMatchObject({ nonce: original.request.nonce, fee: original.request.fee, relay: ADDR.relay });
        expectPaidOnce(before, await balances());
    });

    it('another authorized relay executes a correction while the original is still being signed: outcome identifies the sole winning payment', async () => {
        const pins = definePins({
            chainId: ctx.pins.chainId, transfer: ctx.transfer, tokens: ctx.pins.tokens,
            relays: [ADDR.relay, ADDR.other], deployBlock: ctx.pins.deployBlock,
        });
        const now = await ctx.now();
        const original = await prepareTransfer(ctx.publicClient, pins, fields(now));
        const before = await balances();
        let winner: PreparedTransfer | undefined;
        let winningTx: Hex | undefined;
        const body = buildSubmitTransferBody(await signPrepared(interleavedSigner(async () => {
            winner = await prepareTransfer(ctx.publicClient, pins, {
                ...fields(await ctx.now()), relay: ADDR.other, fee: FEE + 1n, corrects: original.request,
            });
            const correctedBody = buildSubmitTransferBody(await signPrepared(user, winner, pins, { now: await ctx.now() }));
            winningTx = (await ctx.send(KEYS.other, ctx.transfer, gaslessTransferAbi, 'relayTransfer', relayTransferArgs(correctedBody))).transactionHash;
        }), original, pins, { now }));
        expect(winner?.request.nonce).toBe(original.request.nonce);
        expect(winningTx).toBeDefined();
        const nonceAfterWinner = await tokenNonce();
        await expect(ctx.relayExecute(body)).rejects.toThrow();
        expect(await tokenNonce()).toBe(nonceAfterWinner);
        expectPaidOnce(before, await balances(), FEE + 1n, true);
        const result = await finalized(original);
        expect(result).toMatchObject({ status: 'other_version_executed', txHash: winningTx });
        expect(result.executedTransfer?.request).toMatchObject({ nonce: original.request.nonce, relay: ADDR.other, fee: (FEE + 1n).toString() });
        expectPaidOnce(before, await balances(), FEE + 1n, true);
    });
});
