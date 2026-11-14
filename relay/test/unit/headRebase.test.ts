// Block numbers the transaction manager stores from its client's head are re-based on a lower head later: one head
// reported far above the chain cannot hold speed-ups, `stalled` or `backlog` back for good.
import { afterEach, describe, expect, it } from 'vitest';
import { transferOperation } from '../../src/operations/transfer.js';
import { DEFAULT_TX_POLICY } from '../../src/tx/settings.js';
import { GWEI } from '../helpers/fakeChain.js';
import { autoSender, buildTransfer, CONTRACT, createHarness, TEST_TX_SETTINGS, USDC, type Harness } from '../helpers/harness.js';
import { USER_ADDRESS } from '../helpers/keys.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const INTERVAL = TEST_TX_SETTINGS.speedUpAfterBlocks;
const ABOVE = 1_000_000n;

/** One pass in which the relay's client reports a head ABOVE blocks above the chain's (a lie, or another RPC). */
async function passAtInflatedHead(h: Harness): Promise<void> {
    const getBlock = h.chain.getBlock;
    h.chain.getBlock = async (tag) => {
        const block = await getBlock.call(h.chain, tag);
        return tag === 'latest' ? { ...block, number: block.number + ABOVE } : block;
    };
    try {
        await h.relay.txManager.tick();
    } finally {
        h.chain.getBlock = getBlock;
    }
}

describe('stored block numbers above the head', () => {
    it('re-bases the sent block of a transaction, so that it is sped up', async () => {
        h = await createHarness();
        await h.relay.txManager.recover();
        const t = await buildTransfer(h);
        await h.relay.pipeline.submit(transferOperation, t.body);
        await passAtInflatedHead(h);
        expect(h.store.listAttempts(t.id)).toMatchObject([{ sentBlock: h.chain.head.number + ABOVE }]);

        // Nothing is included. The next pass counts the attempt from today's head, and it is sped up an interval later
        // (without the re-base `head − sentBlock` would stay negative, and it would never be).
        h.chain.mineBlocks(INTERVAL, { include: false });
        await h.relay.txManager.tick();
        expect(h.store.listAttempts(t.id)).toMatchObject([{ sentBlock: h.chain.head.number }]);
        h.chain.mineBlocks(INTERVAL, { include: false });
        await h.relay.txManager.tick();
        expect(h.store.listAttempts(t.id)).toHaveLength(2);
    });

    it('re-bases the clocks of `stalled` and `backlog`', async () => {
        // RELAY_MAX_FEE_PER_GAS_GWEI at the market fee: no speed-up is possible, so no pass makes progress.
        h = await createHarness({ settings: { tx: { ...TEST_TX_SETTINGS, maxFeePerGas: 90n * GWEI } } });
        h.chain.setAllowance(USDC, USER_ADDRESS, CONTRACT, 10n ** 12n);
        await h.relay.txManager.recover();
        for (let i = 0; i < 4; i++) {
            const t = await buildTransfer(h, autoSender(h, { mode: 'none' })); // one pending request per sender
            await h.relay.pipeline.submit(transferOperation, t.body);
        }
        // Three in flight (RELAY_MAX_IN_FLIGHT 4, one slot reserved for higher priorities) and one queued, all first seen
        // at the inflated head.
        await passAtInflatedHead(h);
        expect(h.store.countByStatus('submitted')).toBe(3);
        expect(h.store.countByStatus('queued')).toBe(1);

        // Nothing is included, sped up or sent for more than RELAY_STUCK_AFTER_BLOCKS after the first pass at today's head
        // (without the re-base both clocks would stay ABOVE blocks ahead, and neither condition could ever show).
        const stuck = DEFAULT_TX_POLICY.stuckAfterBlocks;
        for (let blocks = 0; blocks <= stuck + INTERVAL; blocks += INTERVAL) {
            h.chain.mineBlocks(INTERVAL, { include: false });
            await h.relay.txManager.tick();
        }
        const health = h.relay.txManager.health();
        expect(health.reasons.some((r) => r.startsWith('stalled:'))).toBe(true);
        expect(health.degraded.some((r) => r.startsWith('backlog:'))).toBe(true);
        expect(await h.metrics.registry.metrics()).toContain(`relay_queue_backlog_blocks ${stuck + INTERVAL}\n`);
    });
});
