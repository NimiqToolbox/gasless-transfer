// A false but in-bounds POL/USD price from one RPC must not lift the per-request spend cap.
//
// The spend cap (RELAY_MAX_COST_PERCENT_OF_FEE) is denominated through the POL/USD price, and the only bound on a
// single reading is the wide band of [0.01, 10] USD (docs/STEP-1-GAS-ABSTRACTION.md §6.4). If the relay took the price
// from one RPC, a malicious or broken RPC that is first in RELAY_RPC_URLS could report an in-bounds but false price.
// A low price inflates the cap in POL above RELAY_MAX_FEE_PER_GAS_GWEI, so a request could cost up to gas limit ×
// RELAY_MAX_FEE_PER_GAS_GWEI, unbounded by its fee. The same price lowers break-even, so the relay would accept fees
// far below the real gas cost and lose on ordinary, successful transfers.
//
// So the Chainlink feed is read through every configured RPC. A reading is taken only when every RPC answers and the
// readings agree within 10 % (the relay then uses the highest). While they disagree, pricing is unavailable
// (relay_price_unavailable_total{reason="rpc_disagreement"}, relay_price_source{source="chainlink"} 0): new requests
// are refused and queued ones are held. Trust model: at least one configured RPC is honest; with a single RPC a wrong
// but plausible price cannot be detected (relay/docs/transaction-lifecycle.md, "Several RPCs").
//
// The test gives the relay the liar first and one honest RPC. The request is accepted while the RPCs agree and held
// while the liar lies (through a gas spike and after it); the call the relay sends once the readings agree again
// costs at most 200 % of the fee at the honest price.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transferOperation } from '../../../src/operations/transfer.js';
import { ChainlinkPriceSource, type PriceReading } from '../../../src/fees/priceSource.js';
import { feeInWei } from '../../../src/tx/policy.js';
import { GWEI } from '../../helpers/fakeChain.js';
import { buildTransfer, createHarness, START_TIME, type Harness } from '../../helpers/harness.js';

const FEED = '0x0000000000000000000000000000000000000FEE0' as const;
// A single malicious/broken RPC returns 0.01 USD/POL -- the minimum the relay accepts ([0.01,10]).
const MALICIOUS_ANSWER = 1_000_000n; // 0.01 * 1e8
// A realistic POL/USD price. The honest RPC reports it; it values the relay's real spend.
const HONEST_ANSWER = 11_210_000n;
const HONEST_PRICE: PriceReading = { value: HONEST_ANSWER, decimals: 8, source: 'chainlink', updatedAt: null, reason: null };
const SPEND_CAP_PERCENT = 200n;

let h: Harness;

beforeEach(async () => {
    h = await createHarness({
        priceSource: ({ chain, clock, metrics }) => {
            chain.feed = { address: FEED, decimals: 8, answer: MALICIOUS_ANSWER, updatedAt: BigInt(START_TIME), description: 'MATIC / USD' };
            // RELAY_RPC_URLS=<liar>,<honest>: the relay's own client is the liar.
            const honest = chain.rpcView({ feedAnswer: HONEST_ANSWER });
            chain.rpcClients = () => [chain, honest];
            return new ChainlinkPriceSource({ chain, feed: FEED, clock, cacheMs: 0, metrics });
        },
    });
    await h.relay.txManager.recover();
});

afterEach(async () => {
    await h.close();
});

describe('a lying in-bounds POL/USD price from one RPC does not lift the per-request spend cap', () => {
    it('while the RPCs disagree nothing is priced, and no call costs more than 200 % of the fee at the honest price', async () => {
        // A normal 0.01 USDC fee.
        const fee = 10_000n;
        const built = await buildTransfer(h, { mode: 'permit', amount: 1_000_000n, fee });
        // The liar reports 0.01 USD/POL: the readings disagree, pricing is unavailable and the request is refused.
        const refused = await h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: built.body });
        expect(refused.statusCode).toBe(503);
        expect((refused.json() as { error: { code: string } }).error.code).toBe('unavailable');
        expect(h.store.getRequest(built.id)).toBeUndefined();
        let text = await h.metrics.registry.metrics();
        expect(text).toContain('relay_price_unavailable_total{reason="rpc_disagreement"}');
        expect(text).toContain('relay_price_source{source="chainlink"} 0');

        // While the liar reports the honest price, the request is accepted (the base fee is low).
        h.chain.feed!.answer = HONEST_ANSWER;
        expect((await h.relay.pipeline.submit(transferOperation, built.body)).statusCode).toBe(202);
        const honestBound = (SPEND_CAP_PERCENT * feeInWei(fee, HONEST_PRICE)) / 100n;
        const realSpend = () =>
            h.store
                .listAttempts(built.id)
                .filter((a) => a.kind === 'call')
                .reduce((max, a) => (a.gasLimit * a.maxFeePerGas > max ? a.gasLimit * a.maxFeePerGas : max), 0n);

        // Gas spikes after acceptance (base fee 2000 gwei) and the liar lies again: no price, so the request is held
        // (at the liar's price it would be sent at RELAY_MAX_FEE_PER_GAS_GWEI, far above the honest bound).
        h.chain.feed!.answer = MALICIOUS_ANSWER;
        h.chain.head = { ...h.chain.head, baseFeePerGas: 2000n * GWEI };
        await h.relay.txManager.tick();
        expect(h.store.getRequest(built.id)!.status).toBe('queued');
        expect(realSpend()).toBe(0n);

        // The gas price falls to 300 gwei, the liar still lies: still held, nothing is sent at the liar's price.
        h.chain.mine({ baseFee: 300n * GWEI });
        await h.relay.txManager.tick();
        expect(h.store.getRequest(built.id)!.status).toBe('queued');
        expect(h.chain.broadcasts).toHaveLength(0);
        text = await h.metrics.registry.metrics();
        expect(text).not.toContain('relay_price_source{source="chainlink"} 1');

        // The readings agree again: sent within the cap at the price every RPC reports.
        h.chain.feed!.answer = HONEST_ANSWER;
        await h.relay.txManager.tick();
        expect(h.relay.txManager.lastTickError).toBeUndefined();
        expect(h.store.getRequest(built.id)!.status).toBe('submitted');
        console.error(`realSpend=${realSpend()} wei, honest 200%-of-fee bound=${honestBound} wei`);
        // The relay never commits more than RELAY_MAX_COST_PERCENT_OF_FEE of the fee to one call
        // (relay/docs/transaction-lifecycle.md, "Gas limit and spend cap"), valued at the honest price.
        expect(realSpend()).toBeGreaterThan(0n);
        expect(realSpend()).toBeLessThanOrEqual(honestBound);
    });
});
