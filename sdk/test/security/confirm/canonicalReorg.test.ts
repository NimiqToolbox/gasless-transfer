// The outcome check after a real local reorg (anvil, production GaslessTransfer, test keys and token doubles): what
// an orphaned branch showed must never decide a payment. Cached evidence (receipt and logs) is captured from the
// orphaned branch and served again by a stale RPC; all state/block reads use the replacement branch.
// Each case runs twice: with the state of older blocks (the check finds the replacement block from nonces(from) and
// reads its transactions, so a replacement execution is found without logs), and on a node without that state (the log
// search, where the stale logs are the only evidence a case may offer).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, custom, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi } from '../../../src/core/abi.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { confirmOnChain, prepareTransfer, signPrepared } from '../../../src/viem/index.js';
import { ADDR, KEYS, USDC } from '../../helpers/fixtures.js';
import { chainToolsAvailable, startProductionChain, type ProductionChain } from '../../helpers/productionChain.js';

type CachedLog = { address: string; topics: Hex[]; blockHash: Hex; transactionHash: Hex; blockNumber: Hex };
type Filter = { address?: string | string[]; topics?: (Hex | Hex[] | null)[]; fromBlock?: Hex; toBlock?: Hex };

function matches(log: CachedLog, filter: Filter): boolean {
    return (!filter.address || (Array.isArray(filter.address) ? filter.address : [filter.address]).some(a => a.toLowerCase() === log.address.toLowerCase())) &&
        (!filter.fromBlock || BigInt(log.blockNumber) >= BigInt(filter.fromBlock)) &&
        (!filter.toBlock || BigInt(log.blockNumber) <= BigInt(filter.toBlock)) &&
        (filter.topics ?? []).every((topic, i) => topic === null ||
            (Array.isArray(topic) ? topic : [topic]).some(t => t.toLowerCase() === log.topics[i]?.toLowerCase()));
}

describe.skipIf(!chainToolsAvailable())('production contract: canonical confirmation after a real local reorg', () => {
    let ctx: ProductionChain;
    let initial: Hex;
    beforeAll(async () => { ctx = await startProductionChain(); }, 240_000);
    afterAll(async () => { await ctx?.stop(); });
    beforeEach(async () => { initial = await ctx.testClient.snapshot(); });
    afterEach(async () => { await ctx.testClient.revert({ id: initial }); });

    for (const history of [true, false]) for (const orphanWasTransfer of [false, true]) {
        for (const evidence of ['receipt', 'logs', 'logs-only-stale'] as const) {
            it(`${history ? 'state search' : 'log search'}: orphan ${orphanWasTransfer ? 'execution' : 'invalidation'} via ${evidence} cannot override the replacement branch`, async () => {
                const now = await ctx.now();
                const amount = 1_000_000n;
                const fee = 10_000n;
                const prepared = await prepareTransfer(ctx.publicClient, ctx.pins, {
                    token: USDC, from: ADDR.user, to: ADDR.recipient, relay: ADDR.relay,
                    amount, fee, authMode: 'permit', now,
                });
                const signed = await signPrepared(privateKeyToAccount(KEYS.user), prepared, ctx.pins, { now });
                const body = buildSubmitTransferBody(signed);
                const holders = [ADDR.user, ADDR.recipient, ADDR.relay] as const;
                const before = await Promise.all(holders.map(a => ctx.balanceOf(USDC, a)));
                const execute = () => ctx.relayExecute(body);
                const invalidate = () => ctx.send(KEYS.user, ctx.transfer, gaslessTransferAbi, 'invalidateNonces', [BigInt(prepared.request.nonce) + 1n]);
                const forkPoint = await ctx.testClient.snapshot();
                const orphan = await (orphanWasTransfer ? execute() : invalidate());
                // Capture raw JSON-RPC data, before Anvil forgets the orphaned block/receipt: the receipt and every log of
                // its block (the token's Approval and Transfer logs of an execution, or the contract's NonceInvalidated).
                const cachedReceipt = await ctx.publicClient.request({
                    method: 'eth_getTransactionReceipt', params: [orphan.transactionHash],
                });
                const cachedLogs = await ctx.publicClient.request({
                    method: 'eth_getLogs',
                    params: [{ fromBlock: toHex(orphan.blockNumber), toBlock: toHex(orphan.blockNumber) }],
                }) as CachedLog[];
                expect(cachedReceipt).not.toBeNull();
                expect(cachedLogs.length).toBeGreaterThan(0);
                for (const log of cachedLogs) expect(log.blockHash).toBe(orphan.blockHash);

                await ctx.testClient.revert({ id: forkPoint });
                const replacement = await (orphanWasTransfer ? invalidate() : execute());
                expect(replacement.blockNumber).toBe(orphan.blockNumber);
                expect(replacement.blockHash).not.toBe(orphan.blockHash);
                expect(replacement.transactionHash).not.toBe(orphan.transactionHash);
                await ctx.testClient.mine({ blocks: 70 });
                const finalized = await ctx.publicClient.getBlock({ blockTag: 'finalized' });
                expect(finalized.number).toBeGreaterThanOrEqual(replacement.blockNumber);
                expect((await ctx.publicClient.getBlock({ blockNumber: orphan.blockNumber })).hash).toBe(replacement.blockHash);
                expect(await ctx.publicClient.readContract({
                    address: ctx.transfer, abi: gaslessTransferAbi, functionName: 'nonces',
                    args: [ADDR.user], blockNumber: finalized.number,
                })).toBe(BigInt(prepared.request.nonce) + 1n);
                const after = await Promise.all(holders.map(a => ctx.balanceOf(USDC, a)));
                expect(after).toEqual(orphanWasTransfer ? before :
                    [before[0]! - amount - fee, before[1]! + amount, before[2]! + fee]);

                let staleResponses = 0;
                let canonicalBlockReads = 0;
                const client = createPublicClient({ chain: ctx.chain, transport: custom({
                    async request({ method, params }) {
                        // Without history: no state below the finalized block, which the check reads at.
                        if (!history && method === 'eth_call' && BigInt((params as [unknown, Hex])[1]) < finalized.number) {
                            throw new Error('missing trie node');
                        }
                        // A cache that still serves the orphan's receipt, in every case.
                        if (method === 'eth_getTransactionReceipt' && (params as Hex[])[0] === orphan.transactionHash) {
                            staleResponses++;
                            return cachedReceipt;
                        }
                        if (method === 'eth_getBlockByNumber' && (params as unknown[])[0] === toHex(orphan.blockNumber)) {
                            canonicalBlockReads++;
                        }
                        const fresh = await ctx.publicClient.request({ method, params } as never);
                        if (method === 'eth_getLogs' && evidence !== 'receipt') {
                            const stale = cachedLogs.filter(log => matches(log, (params as Filter[])[0]!));
                            staleResponses += stale.length;
                            // Preserve the requested filters/range; only the evidence's branch is stale. Without the
                            // replacement's logs, no canonical evidence is available, so only unresolved is safe.
                            return [...stale, ...(evidence === 'logs-only-stale' || !orphanWasTransfer ? [] : fresh as CachedLog[])];
                        }
                        return fresh;
                    },
                }, { retryCount: 0 }) });
                const result = await confirmOnChain(client, ctx.pins, signed, {
                    blockTag: 'finalized', fromBlock: ctx.deployBlock,
                    ...(evidence === 'receipt' ? { txHash: orphan.transactionHash } : {}),
                });
                // The state search reads no Transfer logs, and the orphan's logs never match the sender's
                // NonceInvalidated filter of the replacement block: only the cached receipt reaches it.
                if (!history || evidence === 'receipt') expect(staleResponses).toBeGreaterThan(0);
                expect(canonicalBlockReads).toBeGreaterThan(0);
                const unresolved = history
                    ? evidence === 'logs-only-stale' && orphanWasTransfer
                    : evidence === 'logs-only-stale' || (evidence === 'logs' && !orphanWasTransfer);
                if (unresolved) {
                    // Missing canonical evidence must never authorize a new payment.
                    expect(result).toMatchObject({ status: 'unresolved', txHash: null, executedTransfer: null });
                } else {
                    expect(result).toMatchObject({
                        status: orphanWasTransfer ? 'nonce_consumed' : 'executed',
                        txHash: replacement.transactionHash, blockNumber: replacement.blockNumber,
                    });
                    if (!orphanWasTransfer) {
                        expect(result.executedTransfer).toEqual({ request: signed.request, authHash: signed.authHash });
                    }
                }
                expect(await confirmOnChain(ctx.publicClient, ctx.pins, signed, { blockTag: 'finalized', fromBlock: ctx.deployBlock }))
                    .toMatchObject({ status: orphanWasTransfer ? 'nonce_consumed' : 'executed', txHash: replacement.transactionHash });
                expect(await Promise.all(holders.map(a => ctx.balanceOf(USDC, a)))).toEqual(after);
            });
        }
    }
});
