// Events of other accounts must not fill or redirect the event search of confirmOnChain. The first describe checks
// the eth_getLogs filters against a scripted RPC; the tests on the production contract need the toolchain container
// (anvil, forge and the vendored OpenZeppelin).
//
// Why the filters matter: anyone can call invalidateNonces for their own account. A search whose NonceInvalidated
// filter did not name the signer would get all of those events: an RPC that caps the logs per response would refuse
// the ranges, and a single block of such events would make the search throw on every poll, forever.
//
// The search asks for each kind of evidence with an exact filter: [NonceInvalidated, pad(from)] on the contract (only
// the sender emits it) and [Transfer, pad(from)] on the pinned tokens. Other accounts can still add
// Transfer(from, to, 0) logs (transferFrom of 0 needs no allowance); the search drops them before reading their
// transactions, and the contract never moves 0.
//
// With the state of older blocks, the check finds the block that used the nonce from nonces(from) and asks only for
// the sender's NonceInvalidated events of that block, never for Transfer logs. The filters above are those of the
// log search, which runs only on an RPC without that state (logFlood.test.ts has a flood of such Transfer logs).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, custom, encodeEventTopics, http, numberToHex, pad, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../../src/core/abi.js';
import { tokenAuthHash } from '../../../src/core/eip712.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { TransferRequest } from '../../../src/core/types.js';
import { confirmOnChain, prepareTransfer, signPrepared, waitForTransferOutcome, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, NONE_AUTH, NOW, polygonPins, TRANSFER_CONTRACT, USDC, USDT0 } from '../../helpers/fixtures.js';
import { chainToolsAvailable, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';

const AMOUNT = 10_000_000n;
const NONCE_INVALIDATED = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated' })[0] as Hex;
const TRANSFER = encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer' })[0] as Hex;
const USER_TOPIC = pad(ADDR.user.toLowerCase() as Hex, { size: 32 });
const TRANSFER_FROM_ABI = parseAbi(['function transferFrom(address from, address to, uint256 value) returns (bool)']);

describe('the eth_getLogs filters of the search (no chain needed)', () => {
    const pins = polygonPins();
    const request: TransferRequest = {
        token: USDC,
        from: ADDR.user,
        to: ADDR.recipient,
        amount: '10000000',
        fee: '50000',
        relay: ADDR.relay,
        nonce: '5',
        deadline: String(NOW),
    };
    const target = { request, authHash: tokenAuthHash(NONE_AUTH) };

    /**
     * A scripted RPC: block n has timestamp NOW − 10 000 + 2n and no transactions, the head is block 6000 (2000 s past
     * the deadline), and nonces(from) is 6 from block 3000 on (`used`), else 5. With `archive` false, a read below the
     * head fails as on a node without the state of older blocks. eth_getLogs finds nothing and records every filter.
     */
    function scriptedClient(used: boolean, archive = true) {
        const filters: Array<{ address: string | readonly string[]; topics: ReadonlyArray<Hex | null>; fromBlock?: Hex; toBlock?: Hex }> = [];
        const head = 6_000;
        const block = (n: number) => ({
            number: numberToHex(n),
            hash: pad(numberToHex(n), { size: 32 }),
            parentHash: pad(numberToHex(Math.max(n - 1, 0)), { size: 32 }),
            timestamp: numberToHex(NOW - 10_000 + 2 * n),
            transactions: [],
        });
        const transport = custom({
            async request({ method, params }: { method: string; params?: unknown }) {
                const args = (params ?? []) as unknown[];
                if (method === 'eth_chainId') return numberToHex(137);
                if (method === 'eth_getBlockByNumber') {
                    const tag = args[0] as string;
                    return block(tag.startsWith('0x') ? Math.min(Number(BigInt(tag)), head) : head);
                }
                if (method === 'eth_call') {
                    if (!archive && args[1] !== numberToHex(head)) throw new Error('missing trie node');
                    return pad(used && Number(BigInt(args[1] as Hex)) >= 3_000 ? '0x6' : '0x5', { size: 32 });
                }
                if (method === 'eth_getLogs') {
                    const [filter] = args as [{ address: string | readonly string[]; topics: ReadonlyArray<Hex | null>; fromBlock: Hex; toBlock: Hex }];
                    filters.push({ address: filter.address, topics: filter.topics, fromBlock: filter.fromBlock, toBlock: filter.toBlock });
                    return [];
                }
                throw new Error(`unexpected RPC call ${method}`);
            },
        });
        return { client: createPublicClient({ transport }), filters };
    }

    it("with the state of older blocks, the only query is the sender's own NonceInvalidated events of the block that used the nonce", async () => {
        const { client, filters } = scriptedClient(true);
        // The nonce is used in block 3000 and nothing there shows what used it: no final answer.
        expect((await confirmOnChain(client, pins, target)).status).toBe('unresolved');
        expect(filters).toEqual([{ address: TRANSFER_CONTRACT, topics: [NONCE_INVALIDATED, USER_TOPIC], fromBlock: numberToHex(3_000), toBlock: numberToHex(3_000) }]);
    });

    it("without that state, every query asks for the sender's own NonceInvalidated events or the pinned tokens' transfers from the sender", async () => {
        const { client, filters } = scriptedClient(true, false);
        expect((await confirmOnChain(client, pins, target)).status).toBe('unresolved');
        const distinct = [...new Set(filters.map(({ address, topics }) => JSON.stringify({ address, topics })))].map((json) => JSON.parse(json) as unknown);
        // Any recipient: an execution of another payment at the nonce is an answer too.
        expect(distinct).toEqual([
            { address: [USDC, USDT0], topics: [TRANSFER, USER_TOPIC] },
            { address: TRANSFER_CONTRACT, topics: [NONCE_INVALIDATED, USER_TOPIC] },
        ]);
        // Both filters for every range of blocks 1100 to 5000 (deadline − 7800 s to the deadline): four ranges of at most
        // 1000 blocks. The state at the deadline is unknown too, so invalidations after it are searched: one more range,
        // NonceInvalidated only.
        expect(filters.length).toBe(9);
        expect(filters[8]?.topics).toEqual([NONCE_INVALIDATED, USER_TOPIC]);
    });

    it('control: an unused nonce needs no search', async () => {
        const { client, filters } = scriptedClient(false);
        expect((await confirmOnChain(client, pins, target)).status).toBe('expired');
        expect(filters).toEqual([]);
    });
});

describe.skipIf(!chainToolsAvailable())("other accounts' events cannot fill or redirect the search", () => {
    let ctx: ProductionChain;
    let snapshot: Hex;

    beforeAll(async () => {
        ctx = await startProductionChain();
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

    async function signedTransfer(): Promise<SignedTransfer> {
        const now = await ctx.now();
        const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: 50_000n, relay: ADDR.relay, now });
        return signPrepared(privateKeyToAccount(KEYS.user), prepared, ctx.pins, { now });
    }

    /** A transfer of the user, executed by the relay; the check then gets no txHash (the relay does not answer). */
    async function executedTransfer(): Promise<SignedTransfer> {
        const signed = await signedTransfer();
        await ctx.relayExecute(buildSubmitTransferBody(signed));
        return signed;
    }

    /** `count` other accounts (no key of the user involved) each send the transaction `call` describes, all in one block. */
    async function others(count: number, call: () => { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<void> {
        const wallet = createWalletClient({ chain: ctx.chain, transport: http(ctx.anvil.url) });
        await ctx.testClient.setAutomine(false);
        try {
            for (let i = 0; i < count; i++) {
                const account = `0x${'5a'.repeat(18)}${(i + 1).toString(16).padStart(4, '0')}` as Address;
                await ctx.testClient.impersonateAccount({ address: account });
                await ctx.testClient.setBalance({ address: account, value: 10n ** 18n });
                await wallet.writeContract({ account, chain: ctx.chain, ...call(), gas: 200_000n } as never);
            }
            await ctx.testClient.mine({ blocks: 1 });
        } finally {
            await ctx.testClient.setAutomine(true);
        }
    }

    /**
     * The same anvil, counting what eth_getLogs returns and how many transactions and receipts the search reads. With
     * `maxLogs`, a response with more logs is refused, as providers with a result cap do. Without `history`, eth_call
     * below the finalized block is refused, as on a node without the state of older blocks.
     */
    function watchedClient(maxLogs?: number, history = true) {
        const seen = { queries: 0, logs: 0, foreignInvalidations: 0, zeroTransfers: 0, transactionsRead: 0, receiptsRead: 0, blockReceiptsRead: 0, refused: 0 };
        const upstream = http(ctx.anvil.url)({ chain: ctx.chain, retryCount: 0 });
        const transport = custom(
            {
                async request({ method, params }: { method: string; params?: unknown }) {
                    if (!history && method === 'eth_call') {
                        const at = (params as unknown[])[1];
                        const finalized = await ctx.publicClient.getBlock({ blockTag: 'finalized' });
                        if (typeof at === 'string' && at.startsWith('0x') && BigInt(at) < finalized.number) throw new Error('missing trie node');
                    }
                    const result = await upstream.request({ method, params } as never);
                    if (method === 'eth_getTransactionByHash') seen.transactionsRead += 1;
                    if (method === 'eth_getTransactionReceipt') seen.receiptsRead += 1;
                    if (method === 'eth_getBlockReceipts') seen.blockReceiptsRead += 1;
                    if (method === 'eth_getLogs') {
                        seen.queries += 1;
                        const logs = result as ReadonlyArray<{ topics: readonly Hex[]; data: Hex }>;
                        seen.logs += logs.length;
                        for (const log of logs) {
                            if (log.topics[0] === NONCE_INVALIDATED && log.topics[1]?.toLowerCase() !== USER_TOPIC) seen.foreignInvalidations += 1;
                            if (log.topics[0] === TRANSFER && BigInt(log.data) === 0n) seen.zeroTransfers += 1;
                        }
                        if (maxLogs !== undefined && logs.length > maxLogs) {
                            seen.refused += 1;
                            throw Object.assign(new Error(`query returned more than ${maxLogs} results`), { code: -32005 });
                        }
                    }
                    return result;
                },
            },
            { retryCount: 0 },
        );
        return { client: createPublicClient({ chain: ctx.chain, transport, pollingInterval: 25 }), seen };
    }

    function outcomeOf(client: ReturnType<typeof watchedClient>['client'], signed: SignedTransfer): Promise<string> {
        return waitForTransferOutcome(client, ctx.pins, signed, { pollIntervalMs: 20, timeoutMs: 3_000 }).then(
            (outcome) => outcome.status,
            (error: unknown) => `threw: ${(error as Error).message.split('\n')[0]}`,
        );
    }

    it("other accounts' invalidations never reach the search, also on an RPC that caps the logs per response", async () => {
        const signed = await executedTransfer();
        // Six other accounts invalidate their own nonces in one block (the cap below is five).
        await others(6, () => ({ address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(signed.request.nonce) + 1n] }));
        await ctx.testClient.mine({ blocks: 70 }); // anvil finalizes 64 blocks behind the head
        const capped = watchedClient(5);
        expect(await outcomeOf(capped.client, signed), `refused responses: ${capped.seen.refused}`).toBe('executed');
        expect({ foreign: capped.seen.foreignInvalidations, refused: capped.seen.refused }).toEqual({ foreign: 0, refused: 0 });
    });

    it("other accounts' zero-amount transfers from the sender to the recipient: the state search never asks for them; the log search gets them, but reads no transaction of theirs", async () => {
        const signed = await executedTransfer();
        // transferFrom(user, recipient, 0) needs no allowance: anyone can emit Transfer(user, recipient, 0).
        await others(4, () => ({ address: USDC, abi: TRANSFER_FROM_ABI, functionName: 'transferFrom', args: [ADDR.user, ADDR.recipient, 0n] }));
        await ctx.testClient.mine({ blocks: 70 });
        const read = async (history: boolean) => {
            const watched = watchedClient(undefined, history);
            const answer = await confirmOnChain(watched.client, ctx.pins, signed, { blockTag: 'finalized' });
            const { zeroTransfers, transactionsRead, receiptsRead, blockReceiptsRead } = watched.seen;
            return { status: answer.status, zeroTransfers, transactionsRead, receiptsRead, blockReceiptsRead };
        };
        // The block that used the nonce lists the execution, whose receipt comes with the block's receipts.
        expect(await read(true)).toEqual({ status: 'executed', zeroTransfers: 0, transactionsRead: 0, receiptsRead: 0, blockReceiptsRead: 1 });
        expect(await read(false)).toEqual({ status: 'executed', zeroTransfers: 4, transactionsRead: 1, receiptsRead: 1, blockReceiptsRead: 0 });
    });

    it("the sender's own invalidation is found among other accounts' invalidations: nonce_consumed, with the sender's transaction", async () => {
        const signed = await signedTransfer();
        await others(6, () => ({ address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'invalidateNonces', args: [BigInt(signed.request.nonce) + 1n] }));
        const invalidation = await ctx.send(KEYS.user, ctx.transfer, gaslessTransferAbi, 'invalidateNonces', [BigInt(signed.request.nonce) + 1n]);
        await ctx.testClient.mine({ blocks: 70 });
        const capped = watchedClient(5);
        expect(await outcomeOf(capped.client, signed)).toBe('nonce_consumed');
        const answer = await confirmOnChain(capped.client, ctx.pins, signed, { blockTag: 'finalized' });
        expect({ status: answer.status, txHash: answer.txHash, blockNumber: answer.blockNumber }).toEqual({
            status: 'nonce_consumed',
            txHash: invalidation.transactionHash,
            blockNumber: invalidation.blockNumber,
        });
        expect({ foreign: capped.seen.foreignInvalidations, refused: capped.seen.refused }).toEqual({ foreign: 0, refused: 0 });
    });

    it("control: without other accounts' transactions the same capped RPC answers executed, and only the receipts of the execution's block are read", async () => {
        const signed = await executedTransfer();
        await ctx.testClient.mine({ blocks: 70 });
        const capped = watchedClient(5);
        expect(await outcomeOf(capped.client, signed)).toBe('executed');
        const { refused, transactionsRead, receiptsRead, blockReceiptsRead } = capped.seen;
        expect({ refused, transactionsRead, receiptsRead, blockReceiptsRead }).toEqual({ refused: 0, transactionsRead: 0, receiptsRead: 0, blockReceiptsRead: 1 });
    });
});
