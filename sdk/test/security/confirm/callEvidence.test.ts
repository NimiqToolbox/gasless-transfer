// Only a successful call of the pinned contract executes a request. The outcome check decodes the request from a
// transaction's call data, so two checks keep other transactions with the same call data out:
//
// - The receipt's status. The relay reports the hash of its call for every failed request, also when the call
//   reverted. Taken for an execution, a reverted call at nonce n would make confirmOnChain and waitForTransferOutcome
//   answer `executed` for a payment that the sender then invalidated, or that lost n to another payment. The paths:
//   the relay's txHash, and the transactions that the log search's Transfer logs name (an RPC can serve logs of a
//   branch where the call succeeded).
// - The transaction's `to` and its receipt's. The relay a request names can send the sender's signed call data to
//   a contract whose runtime is STOP: the call succeeds and moves nothing. The paths: the relay's txHash, the block
//   that used the nonce (state search), the transactions that Transfer logs name, and a block the log search reads
//   through its transactions.
//
// Production GaslessTransfer on anvil with the token doubles (test/helpers/productionChain.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, http, numberToHex, pad, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../../src/core/abi.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { TransferVersion } from '../../../src/core/types.js';
import type { RequestState } from '../../../src/relay/types.js';
import { confirmOnChain, prepareTransfer, signPrepared, waitForTransferOutcome, type PrepareTransferParams, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC, USDT0 } from '../../helpers/fixtures.js';
import { chainToolsAvailable, relayTransferArgs, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';
import { modelClient } from '../../helpers/rpcModel.js';

const user = privateKeyToAccount(KEYS.user);
const relayAccount = privateKeyToAccount(KEYS.relay);
/** Creation code of a contract whose runtime is STOP: every call succeeds and does nothing. */
const STOP_CONTRACT: Hex = '0x6001600c60003960016000f300';
const TRANSFER = encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer' })[0] as Hex;
const AMOUNT = 1_000_000n;
const FEE = 10_000n;
const FEES = { maxFeePerGas: 10n ** 12n, maxPriorityFeePerGas: 10n ** 9n } as const;
const finalized = { blockTag: 'finalized' } as const;

interface RawLog {
    readonly address: Hex;
    readonly topics: readonly Hex[];
    readonly blockNumber: Hex;
    readonly transactionHash: Hex;
}

function version(signed: SignedTransfer): TransferVersion {
    return { request: signed.request, authHash: signed.authHash };
}

function consumed(receipt: TransactionReceipt) {
    return { status: 'nonce_consumed', txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, executedTransfer: null };
}

function otherPayment(signed: SignedTransfer, receipt: TransactionReceipt) {
    return { status: 'other_payment_executed', txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, executedTransfer: version(signed) };
}

/** A relay that reports `failed` for `signed`, with the hash of its call. */
function failedRelay(signed: SignedTransfer, txHash: Hex) {
    const state: RequestState = {
        id: signed.id,
        operation: 'transfer',
        status: 'failed',
        request: signed.request,
        authHash: signed.authHash,
        transactions: [{ hash: txHash, txNonce: 0, maxFeePerGas: FEES.maxFeePerGas.toString(), status: 'mined' }],
        txHash,
        blockNumber: null,
        error: { code: 'nonce_used', message: 'the intent nonce was used' },
    };
    return { getRequest: async () => state };
}

/** eth_getLogs answers with `extra` in front, where they match the query's addresses, sender topic and range. */
function withLogs(extra: readonly RawLog[]) {
    return (method: string, params: readonly unknown[], result: unknown) => {
        if (method !== 'eth_getLogs') return result;
        const filter = params[0] as { address: Hex | Hex[]; topics: Hex[]; fromBlock: Hex; toBlock: Hex };
        const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
        const matching = extra.filter(
            (log) =>
                addresses.includes(log.address.toLowerCase()) &&
                log.topics[0] === filter.topics[0] &&
                log.topics[1]?.toLowerCase() === filter.topics[1]?.toLowerCase() &&
                BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
                BigInt(log.blockNumber) <= BigInt(filter.toBlock),
        );
        return [...matching, ...(result as unknown[])];
    };
}

describe.skipIf(!chainToolsAvailable())('only a successful call of the pinned contract executes a request', () => {
    let ctx: ProductionChain;
    let stop: Address;
    let flooder: Address;
    let snapshot: Hex;

    const wallet = (key: Hex) => createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url), account: privateKeyToAccount(key) });

    beforeAll(async () => {
        ctx = await startProductionChain();
        const deploy = async (bytecode: Hex) => {
            const hash = await wallet(KEYS.other).deployContract({ abi: [], bytecode } as never);
            return getAddress((await ctx.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address);
        };
        stop = await deploy(STOP_CONTRACT);
        flooder = await deploy(ctx.fixtures.LogFlooder.bytecode);
    }, 240_000);

    afterAll(async () => {
        await ctx?.stop();
    });

    beforeEach(async () => {
        snapshot = await ctx.testClient.snapshot();
    });

    afterEach(async () => {
        await ctx.testClient.revert({ id: snapshot });
    });

    async function signedTransfer(overrides: Partial<PrepareTransferParams> = {}): Promise<SignedTransfer> {
        const now = await ctx.now();
        const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: FEE, relay: ADDR.relay, now, ...overrides });
        return signPrepared(user, prepared, ctx.pins, { now });
    }

    const receiptOf = (hash: Hex) => ctx.publicClient.waitForTransactionReceipt({ hash });
    const finalize = () => ctx.testClient.mine({ blocks: 70 });
    const approve = (value: bigint) => ctx.send(KEYS.user, USDC, ctx.fixtures.MockUSDC.abi, 'approve', [ctx.transfer, value]);
    const invalidateCall = (signed: SignedTransfer, extra: object = {}) =>
        wallet(KEYS.user).writeContract({ address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(signed.request.nonce) + 1n], gas: 100_000n, ...FEES, ...extra } as never);
    /** The relay sends the call data of `signed` to `to` (the pinned contract, or another one). */
    const relayCall = (signed: SignedTransfer, to: Address, extra: object = {}) =>
        wallet(KEYS.relay).writeContract({ address: to, abi: gaslessTransferAbi, functionName: 'relayTransfer', args: relayTransferArgs(buildSubmitTransferBody(signed)), gas: 300_000n, ...FEES, ...extra } as never);

    /** Sends the transactions `send` makes into one block, in the order of their tips. */
    async function oneBlock(send: () => Promise<Hex[]>): Promise<TransactionReceipt[]> {
        await ctx.testClient.setAutomine(false);
        let hashes: Hex[];
        try {
            hashes = await send();
            await ctx.testClient.mine({ blocks: 1 });
        } finally {
            await ctx.testClient.setAutomine(true);
        }
        const receipts = await Promise.all(hashes.map(receiptOf));
        expect(new Set(receipts.map((r) => r.blockNumber)).size).toBe(1);
        return receipts;
    }

    describe('a reverted relayTransfer at the nonce is no execution', () => {
        /**
         * The relay's call T of `ours` (mode none, over the sender's allowance) succeeds on a branch that is then dropped;
         * the logs of its block are kept, as a cache serves them. On the canonical branch the sender revokes the allowance,
         * T reverts, and then the nonce is used: by the sender's invalidation, or by another payment at the nonce.
         */
        async function revertedCallThen(use: 'invalidation' | 'other payment') {
            await approve(AMOUNT + FEE);
            const ours = await signedTransfer({ authMode: 'none' });
            const other = await signedTransfer({ to: ADDR.other, amount: 2_000_000n, authMode: 'permit' });
            expect(other.request.nonce).toBe(ours.request.nonce);
            const raw = await relayAccount.signTransaction({
                chainId: 137,
                type: 'eip1559',
                to: ctx.transfer,
                data: encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'relayTransfer', args: relayTransferArgs(buildSubmitTransferBody(ours)) }),
                gas: 300_000n,
                nonce: await ctx.publicClient.getTransactionCount({ address: ADDR.relay, blockTag: 'pending' }),
                ...FEES,
            });
            const send = async () => receiptOf((await ctx.publicClient.request({ method: 'eth_sendRawTransaction', params: [raw] })) as Hex);
            const fork = await ctx.testClient.snapshot();
            const orphan = await send();
            expect(orphan.status).toBe('success');
            const orphanLogs = (await ctx.publicClient.request({
                method: 'eth_getLogs',
                params: [{ fromBlock: numberToHex(orphan.blockNumber), toBlock: numberToHex(orphan.blockNumber) }],
            })) as unknown as RawLog[];
            expect(orphanLogs.some((log) => log.topics[0] === TRANSFER)).toBe(true);
            await ctx.testClient.revert({ id: fork });

            await approve(0n);
            const reverted = await send();
            expect({ hash: reverted.transactionHash, status: reverted.status }).toEqual({ hash: orphan.transactionHash, status: 'reverted' });
            let answer;
            if (use === 'invalidation') {
                answer = consumed(await receiptOf(await invalidateCall(ours)));
            } else {
                answer = otherPayment(other, await ctx.relayExecute(buildSubmitTransferBody(other)));
            }
            await finalize();
            return { ours, reverted, orphanLogs, answer };
        }

        it.each(['invalidation', 'other payment'] as const)('the relay call reverted, then the nonce was used by an %s: that use, on every path', async (use) => {
            const { ours, reverted, orphanLogs, answer } = await revertedCallThen(use);
            const txHash = reverted.transactionHash;
            // The relay's txHash: confirmOnChain, and waitForTransferOutcome with a relay that reports failed.
            expect(await confirmOnChain(ctx.publicClient, ctx.pins, version(ours), { ...finalized, txHash })).toEqual(answer);
            const waited = await waitForTransferOutcome(ctx.publicClient, ctx.pins, version(ours), { relay: failedRelay(ours, txHash), pollIntervalMs: 20, timeoutMs: 10_000 });
            expect({ ...waited, relayState: null }).toEqual({ ...answer, relayState: null });
            // Without the state of older blocks: the log search, whose Transfer logs (from the dropped branch) name the call.
            const stale = modelClient(ctx, { history: false, rewrite: withLogs(orphanLogs) });
            expect(await confirmOnChain(stale.client, ctx.pins, version(ours), finalized)).toEqual(answer);
            expect(stale.seen.byMethod.eth_getTransactionReceipt).toBeGreaterThan(0);
            const waitedStale = await waitForTransferOutcome(modelClient(ctx, { history: false, rewrite: withLogs(orphanLogs) }).client, ctx.pins, version(ours), {
                relay: failedRelay(ours, txHash),
                pollIntervalMs: 20,
                timeoutMs: 10_000,
            });
            expect({ ...waitedStale, relayState: null }).toEqual({ ...answer, relayState: null });
        }, 60_000);
    });

    describe("the request's call data sent to a contract that is not the pinned one is no execution", () => {
        it("the relay's txHash names a successful call of a STOP contract, then the sender invalidated the nonce: nonce_consumed", async () => {
            const ours = await signedTransfer();
            const fake = await receiptOf(await relayCall(ours, stop));
            expect({ status: fake.status, to: fake.to }).toEqual({ status: 'success', to: stop.toLowerCase() });
            const invalidation = await receiptOf(await invalidateCall(ours));
            await finalize();
            for (const client of [ctx.publicClient, modelClient(ctx, { history: false }).client]) {
                expect(await confirmOnChain(client, ctx.pins, version(ours), { ...finalized, txHash: fake.transactionHash })).toEqual(consumed(invalidation));
            }
            const waited = await waitForTransferOutcome(ctx.publicClient, ctx.pins, version(ours), { relay: failedRelay(ours, fake.transactionHash), pollIntervalMs: 20, timeoutMs: 10_000 });
            expect(waited.status).toBe('nonce_consumed');
        });

        it('the call to the STOP contract and the invalidation in the block that used the nonce: nonce_consumed, with and without eth_getBlockReceipts', async () => {
            const ours = await signedTransfer();
            const [fake, invalidation] = await oneBlock(async () => [
                await relayCall(ours, stop, { maxPriorityFeePerGas: 10n ** 11n }),
                await invalidateCall(ours),
            ]);
            expect(fake?.status).toBe('success');
            expect(fake!.transactionIndex).toBeLessThan(invalidation!.transactionIndex);
            await finalize();
            for (const blockReceipts of [true, false]) {
                const rpc = modelClient(ctx, { blockReceipts });
                expect(await confirmOnChain(rpc.client, ctx.pins, version(ours), finalized), `eth_getBlockReceipts ${blockReceipts}`).toEqual(consumed(invalidation!));
            }
        });

        it('without the state of older blocks, Transfer logs that name the call to the STOP contract: nonce_consumed', async () => {
            const ours = await signedTransfer();
            const fake = await receiptOf(await relayCall(ours, stop));
            const invalidation = await receiptOf(await invalidateCall(ours));
            await finalize();
            // An RPC whose logs attribute a transfer from the sender to that transaction (a cache, or a node on another fork).
            const named: RawLog = {
                address: USDC,
                topics: [TRANSFER, pad(ADDR.user.toLowerCase() as Hex, { size: 32 }), pad(ADDR.recipient.toLowerCase() as Hex, { size: 32 })],
                blockNumber: numberToHex(fake.blockNumber),
                transactionHash: fake.transactionHash,
            };
            const log = { ...named, blockHash: fake.blockHash, data: pad(numberToHex(AMOUNT), { size: 32 }), logIndex: '0x0', transactionIndex: numberToHex(fake.transactionIndex), removed: false };
            const rpc = modelClient(ctx, { history: false, rewrite: withLogs([log]) });
            expect(await confirmOnChain(rpc.client, ctx.pins, version(ours), finalized)).toEqual(consumed(invalidation));
            expect(rpc.seen.byMethod.eth_getTransactionReceipt).toBe(1);
        });

        it('without the state of older blocks, a block read through its transactions (its Transfer logs refused) holds the call to the STOP contract and the invalidation: nonce_consumed', async () => {
            const ours = await signedTransfer();
            const [fake, flood, invalidation] = await oneBlock(async () => [
                await relayCall(ours, stop, { maxPriorityFeePerGas: 10n ** 11n }),
                // A zero-amount Transfer log of the sender, which anyone can emit, puts the block's Transfer logs over the cap.
                await wallet(KEYS.other).writeContract({ address: flooder, abi: ctx.fixtures.LogFlooder.abi, functionName: 'flood', args: [[USDC, USDT0], ADDR.user, ADDR.recipient, 1n], gas: 200_000n, ...FEES, maxPriorityFeePerGas: 10n ** 10n } as never),
                await invalidateCall(ours),
            ]);
            expect([fake?.status, flood?.status]).toEqual(['success', 'success']);
            await finalize();
            for (const blockReceipts of [true, false]) {
                // The block's two zero-amount Transfer logs are over the cap; its one NonceInvalidated log is not.
                const rpc = modelClient(ctx, { history: false, maxLogs: 1, blockReceipts });
                expect(await confirmOnChain(rpc.client, ctx.pins, version(ours), finalized), `eth_getBlockReceipts ${blockReceipts}`).toEqual(consumed(invalidation!));
                expect(rpc.seen.blocksRead).toContain(fake!.blockNumber);
            }
        });
    });

    // Past MAX_RECEIPT_READS candidate calls read one by one the block gives no execution, and its NonceInvalidated
    // events still decide: a covering invalidation proves that no call used the nonce.
    it("more than MAX_RECEIPT_READS reverted copies of the relay's call and the sender's invalidation in the block that used the nonce, without eth_getBlockReceipts: nonce_consumed, also through the log search", async () => {
        const ours = await signedTransfer();
        const base = await ctx.publicClient.getTransactionCount({ address: ADDR.relay, blockTag: 'pending' });
        const receipts = await oneBlock(async () => {
            const hashes: Hex[] = [];
            // Each copy runs out of gas.
            for (let i = 0; i < 17; i++) hashes.push(await relayCall(ours, ctx.transfer, { gas: 35_000n, nonce: base + i }));
            hashes.push(await wallet(KEYS.other).writeContract({ address: flooder, abi: ctx.fixtures.LogFlooder.abi, functionName: 'flood', args: [[USDC, USDT0], ADDR.user, ADDR.recipient, 1n], gas: 200_000n, ...FEES } as never));
            hashes.push(await invalidateCall(ours));
            return hashes;
        });
        expect(receipts.slice(0, 17).every((r) => r.status === 'reverted')).toBe(true);
        const invalidation = receipts.at(-1)!;
        await finalize();
        for (const model of [{ blockReceipts: false }, { blockReceipts: false, history: false, maxLogs: 1 }] as const) {
            const rpc = modelClient(ctx, model);
            expect(await confirmOnChain(rpc.client, ctx.pins, version(ours), finalized), JSON.stringify(model)).toEqual(consumed(invalidation));
            expect(rpc.seen.byMethod.eth_getTransactionReceipt, JSON.stringify(model)).toBe(16);
        }
    }, 60_000);

    // A receipt above the block read is no evidence at that block. An RPC whose state read at the finalized block is
    // ahead of it (an inconsistent backend) shows the nonce used there, while the relay's call is in a later block.
    it("the relay's txHash names its call in a block above the block read: not executed", async () => {
        await finalize();
        const ours = await signedTransfer();
        const executed = await ctx.relayExecute(buildSubmitTransferBody(ours));
        const read = (await ctx.publicClient.getBlock({ blockTag: 'finalized' })).number;
        expect(executed.blockNumber).toBeGreaterThan(read);
        const ahead = modelClient(ctx, {
            rewrite: (method, params, result) =>
                method === 'eth_call' && params[1] === numberToHex(read) ? encodeAbiParameters([{ type: 'uint256' }], [BigInt(ours.request.nonce) + 1n]) : result,
        });
        expect(await confirmOnChain(ahead.client, ctx.pins, version(ours), { ...finalized, txHash: executed.transactionHash })).toEqual({
            status: 'unresolved',
            txHash: null,
            blockNumber: null,
            executedTransfer: null,
            reason: 'not_found',
        });
    });
});
