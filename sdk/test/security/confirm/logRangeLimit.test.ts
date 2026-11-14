// The outcome check on RPCs that limit the block range of one eth_getLogs call, as public RPC providers do (some
// refuse a query of a few hundred blocks). The check is needed exactly when such a limit would hurt most: the relay
// does not answer or gives no usable txHash, or the sender ended the intent with invalidateNonces. A search that
// asked for every block since the deployment in one query would throw 'eth_getLogs is limited to a 10000 block
// range' there, and the wallet would get no answer.
//
// The log search reads the token's Transfer logs and the sender's NonceInvalidated events. It is bounded to the
// blocks where a version of the payment can have used the nonce (from deadline − 7800 s, the longest lifetime the
// SDK signs plus a margin, not below pins.deployBlock, up to the block read), runs in ranges of at most 1000 blocks,
// and halves the range whenever the RPC refuses one. These tests pin that, with RPCs that refuse more than 10 000
// and more than 100 blocks.
//
// The log search runs only on an RPC without the state of older blocks, which the limited RPCs here model by
// refusing eth_call below the finalized block. With that state, the check finds the block that used the nonce from
// nonces(from) and asks eth_getLogs for one block at most.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, custom, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '../../../src/core/abi.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { prepareTransfer, signPrepared, waitForTransferOutcome, type SignedTransfer } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC } from '../../helpers/fixtures.js';
import { chainToolsAvailable, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';

/** A common provider limit for one eth_getLogs call. */
const MAX_LOG_RANGE = 10_000n;
const AMOUNT = 10_000_000n;

describe.skipIf(!chainToolsAvailable())('the outcome check on an RPC that limits the eth_getLogs range', () => {
    let ctx: ProductionChain;
    let snapshot: Hex;

    beforeAll(async () => {
        ctx = await startProductionChain();
        // The deployment is older than one query may span (about 6.7 hours of Polygon blocks).
        await ctx.testClient.mine({ blocks: Number(MAX_LOG_RANGE) + 2_000 });
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

    /**
     * The same anvil behind an RPC that refuses eth_getLogs calls spanning more than `limit` blocks (or every call), and,
     * without `history`, eth_call below the finalized block (no state of older blocks).
     */
    function rangeLimitedClient(limit: bigint | 'none', history = false) {
        const log = { refused: 0, widest: 0n, lowest: undefined as bigint | undefined };
        const upstream = http(ctx.anvil.url)({ chain: ctx.chain, retryCount: 0 });
        const transport = custom(
            {
                async request({ method, params }: { method: string; params?: unknown }) {
                    if (!history && method === 'eth_call') {
                        const at = (params as unknown[])[1];
                        const finalized = await ctx.publicClient.getBlock({ blockTag: 'finalized' });
                        if (typeof at === 'string' && at.startsWith('0x') && BigInt(at) < finalized.number) throw new Error('missing trie node');
                    }
                    if (method === 'eth_getLogs') {
                        const [filter] = params as [{ fromBlock?: Hex; toBlock?: Hex }];
                        const from = BigInt(filter.fromBlock ?? '0x0');
                        const to = filter.toBlock !== undefined && filter.toBlock.startsWith('0x') ? BigInt(filter.toBlock) : await ctx.publicClient.getBlockNumber();
                        if (log.lowest === undefined || from < log.lowest) log.lowest = from;
                        if (limit === 'none' || to - from + 1n > limit) {
                            log.refused += 1;
                            throw Object.assign(new Error(`eth_getLogs is limited to a ${String(limit)} block range`), { code: -32602 });
                        }
                        if (to - from + 1n > log.widest) log.widest = to - from + 1n;
                    }
                    return upstream.request({ method, params } as never);
                },
            },
            { retryCount: 0 },
        );
        return { client: createPublicClient({ chain: ctx.chain, transport, pollingInterval: 25 }), log };
    }

    async function signed(): Promise<SignedTransfer> {
        const now = await ctx.now();
        const p = await prepareTransfer(ctx.publicClient, ctx.pins, { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: 50_000n, relay: ADDR.relay, now });
        return signPrepared(privateKeyToAccount(KEYS.user), p, ctx.pins, { now });
    }

    async function outcomeOf(target: SignedTransfer, client: ReturnType<typeof rangeLimitedClient>['client'] | ProductionChain['publicClient']): Promise<string> {
        // No relay: it is down, or its answers are not usable (the chain decides, as the README says).
        return waitForTransferOutcome(client, ctx.pins, target, { pollIntervalMs: 20, timeoutMs: 5_000 }).then(
            (outcome) => outcome.status,
            (error: unknown) => `threw: ${String((error as { details?: string }).details ?? (error as { shortMessage?: string }).shortMessage ?? error).slice(0, 120)}`,
        );
    }

    /** An executed transfer and the next payment, which the sender ended with invalidateNonces, both final. */
    async function executedAndInvalidated(): Promise<{ executed: SignedTransfer; ended: SignedTransfer }> {
        const executed = await signed();
        await ctx.relayExecute(buildSubmitTransferBody(executed));
        // sdk/README.md: a user with POL can end a payment earlier by calling invalidateNonces.
        const ended = await signed();
        await ctx.send(KEYS.user, ctx.transfer, gaslessTransferAbi, 'invalidateNonces', [BigInt(ended.request.nonce) + 1n]);
        await ctx.testClient.mine({ blocks: 70 }); // anvil finalizes 64 blocks behind the head
        return { executed, ended };
    }

    it('waitForTransferOutcome answers executed and nonce_consumed (invalidateNonces) on an RPC that limits eth_getLogs to 10 000 blocks, in queries of at most 1000 blocks', async () => {
        const { executed, ended } = await executedAndInvalidated();
        // Control: the same chain without the range limit gives both answers.
        expect({ executed: await outcomeOf(executed, ctx.publicClient), invalidated: await outcomeOf(ended, ctx.publicClient) }).toEqual({
            executed: 'executed',
            invalidated: 'nonce_consumed',
        });
        const limited = rangeLimitedClient(MAX_LOG_RANGE);
        const result = { executed: await outcomeOf(executed, limited.client), invalidated: await outcomeOf(ended, limited.client) };
        // One query spanning every block since the deployment would be refused, and both checks would throw.
        expect(result, `refused eth_getLogs calls: ${limited.log.refused}, widest query: ${limited.log.widest} blocks`).toEqual({
            executed: 'executed',
            invalidated: 'nonce_consumed',
        });
        expect({ refused: limited.log.refused, widestAtMost1000: limited.log.widest <= 1_000n }).toEqual({ refused: 0, widestAtMost1000: true });
        // With the state of older blocks: the same answers, eth_getLogs for one block at most.
        const archive = rangeLimitedClient(MAX_LOG_RANGE, true);
        expect({ executed: await outcomeOf(executed, archive.client), invalidated: await outcomeOf(ended, archive.client) }).toEqual({
            executed: 'executed',
            invalidated: 'nonce_consumed',
        });
        expect({ refused: archive.log.refused, widest: archive.log.widest }).toEqual({ refused: 0, widest: 1n });
    });

    it('on an RPC that refuses more than 100 blocks per query, the range is halved until it is accepted, and the smaller range is kept', async () => {
        const { executed, ended } = await executedAndInvalidated();
        // The events are about 500 blocks below the finalized block: several ranges per search.
        await ctx.testClient.mine({ blocks: 500 });
        const strict = rangeLimitedClient(100n);
        expect({ executed: await outcomeOf(executed, strict.client), invalidated: await outcomeOf(ended, strict.client) }).toEqual({
            executed: 'executed',
            invalidated: 'nonce_consumed',
        });
        // Per search 1000 → 500 → 250 → 125 are refused, then 62-block ranges for the rest of the search.
        expect(strict.log.refused).toBeGreaterThan(0);
        expect(strict.log.refused).toBeLessThanOrEqual(8);
        expect(strict.log.widest).toBeLessThanOrEqual(100n);
    });

    it('an RPC that refuses every eth_getLogs call gives no answer (the RPC error is thrown), never a status', async () => {
        const { executed, ended } = await executedAndInvalidated();
        const broken = rangeLimitedClient('none');
        expect(await outcomeOf(executed, broken.client)).toMatch(/^threw: /);
        expect(await outcomeOf(ended, broken.client)).toMatch(/^threw: /);
        // With the state of older blocks, the execution is found in its block's transactions without eth_getLogs; the
        // invalidation needs the sender's NonceInvalidated events of its block, and the RPC's error is thrown.
        const archive = rangeLimitedClient('none', true);
        expect(await outcomeOf(executed, archive.client)).toBe('executed');
        expect(await outcomeOf(ended, archive.client)).toMatch(/^threw: /);
    });

    it('the search starts at the first block of the deadline − 7800 s window, not at the deployment', async () => {
        // Three hours after the old blocks: an intent signed now cannot have executed in them.
        await ctx.testClient.increaseTime({ seconds: 3 * 3_600 });
        await ctx.testClient.mine({ blocks: 5 });
        const windowStart = (await ctx.publicClient.getBlockNumber()) - 4n; // the first block after the jump
        const { executed, ended } = await executedAndInvalidated();
        const watched = rangeLimitedClient(MAX_LOG_RANGE);
        expect({ executed: await outcomeOf(executed, watched.client), invalidated: await outcomeOf(ended, watched.client) }).toEqual({
            executed: 'executed',
            invalidated: 'nonce_consumed',
        });
        expect(watched.log.lowest).toBeGreaterThanOrEqual(windowStart);
    });
});
