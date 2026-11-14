// On Polygon PoS the configuration cannot put `confirmed`, and the purge of the secrets that comes with it, less than
// 16 blocks below the head.
//
// docs/STEP-1-GAS-ABSTRACTION.md §6.5: `confirmed` means the block is at or below min(finalized, head − 16) and still
// canonical. loadConfig() is chain-agnostic: it accepts RELAY_MIN_FINALITY_DEPTH from 0 (TX_POLICY_ENV in
// relay/src/tx/settings.ts) and RELAY_FINALITY_FALLBACK_DEPTH from 1, because local chains may use less. Applied on
// Polygon, such values would undercut the rule:
// - with RELAY_MIN_FINALITY_DEPTH=0, a node that answers `finalized` with its head block would make a request
//   `confirmed` in its inclusion block, and its secrets and raw transactions would be purged;
// - with RELAY_FINALITY_FALLBACK_DEPTH=1 and a node without the `finalized` tag, `confirmed` would come one block
//   after the inclusion.
// A reorg after that would leave a `confirmed` request that did not execute on the canonical chain, and the relay
// could not re-send it: the raw transaction is purged.
//
// So on Polygon PoS (137) and Amoy (80002) startup refuses RELAY_MIN_FINALITY_DEPTH or RELAY_FINALITY_FALLBACK_DEPTH
// below 16 (checkChainSettings), the transaction manager never applies less than 16 there whatever it is given, and
// without the `finalized` tag it uses head − max(RELAY_FINALITY_FALLBACK_DEPTH, RELAY_MIN_FINALITY_DEPTH). The
// harness chain is 137.
import { afterEach, describe, expect, it } from 'vitest';
import { checkChainSettings, loadConfig } from '../../../src/config.js';
import { createHarness, type Harness } from '../../helpers/harness.js';
import { BASE_ENV, queue, stateOf, tick } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** Mines the call, then `blocks` more blocks with a pass after each one; returns what the relay reports. */
async function includeAndWait(harness: Harness, blocks: number, finalizedAtHead: boolean) {
    const t = await queue(harness);
    await tick(harness);
    harness.chain.mine();
    const included = harness.chain.head.number;
    if (finalizedAtHead) harness.chain.finalized = harness.chain.head.number;
    await tick(harness);
    for (let i = 0; i < blocks; i++) {
        harness.chain.mine();
        if (finalizedAtHead) harness.chain.finalized = harness.chain.head.number;
        await tick(harness);
    }
    const record = harness.store.getRequest(t.id)!;
    const [call] = harness.store.listAttempts(t.id);
    return { t, included, call: call!, depth: harness.chain.head.number - included, status: stateOf(harness, t.id).status, purged: record.signature === null };
}

describe('the finality floor of 16 blocks holds on Polygon PoS whatever the configuration says', () => {
    it('RELAY_MIN_FINALITY_DEPTH=0 is refused on chain 137, and a node answering "finalized" with its head does not confirm a request in its inclusion block', async () => {
        const config = loadConfig({ ...BASE_ENV, RELAY_MIN_FINALITY_DEPTH: '0' });
        expect(config.tx.minFinalityDepth).toBe(0); // loadConfig is chain-agnostic (TX_POLICY_ENV allows 0–10000) ...
        expect(() => checkChainSettings(config, 137)).toThrow(/RELAY_MIN_FINALITY_DEPTH must be at least 16/); // ... the startup refuses it
        // Settings handed to the transaction manager directly: it applies the floor itself.
        h = await createHarness({ settings: { tx: config.tx } });
        await h.relay.txManager.recover();
        const seen = await includeAndWait(h, 0, true);
        // A one-block reorg removes the call; the node forgets it. The relay did not confirm it, so it still has
        // the raw transaction and puts the request back in flight.
        h.chain.reorg(seen.call.hash);
        h.chain.dropMempool();
        h.chain.mine();
        h.chain.finalized = h.chain.head.number;
        await tick(h);
        const afterReorg = {
            status: stateOf(h, seen.t.id).status,
            executedOnChain: h.chain.intentNonce(seen.t.request.from) > BigInt(seen.t.request.nonce),
            rawKept: h.store.listAttempts(seen.t.id).some((a) => a.raw !== null),
        };
        // Not final before head − 16: mined (not confirmed) at depth 0, secrets kept; after the reorg the request is
        // in flight again with its raw transaction.
        expect({ depthAtConfirmed: seen.depth, status: seen.status, purged: seen.purged, afterReorg }).toEqual({
            depthAtConfirmed: 0n,
            status: 'mined',
            purged: false,
            afterReorg: { status: 'submitted', executedOnChain: false, rawKept: true },
        });
    });

    it('RELAY_FINALITY_FALLBACK_DEPTH=1 is refused on chain 137, and without the finalized tag a request is not confirmed one block after its inclusion', async () => {
        const config = loadConfig({ ...BASE_ENV, RELAY_FINALITY_FALLBACK_DEPTH: '1' });
        expect(config.tx.finalityFallbackDepth).toBe(1);
        expect(config.tx.minFinalityDepth).toBe(16);
        expect(() => checkChainSettings(config, 137)).toThrow(/RELAY_FINALITY_FALLBACK_DEPTH must be at least 16/);
        h = await createHarness({ settings: { tx: config.tx } });
        h.chain.finalized = 'unsupported'; // a node or gateway without the `finalized` tag (or an RPC error on it)
        await h.relay.txManager.recover();
        const seen = await includeAndWait(h, 1, false);
        expect({ depth: seen.depth, status: seen.status, purged: seen.purged }).toEqual({ depth: 1n, status: 'mined', purged: false });
        // head − max(fallback 1, min depth 16): confirmed once the inclusion is 16 blocks deep, not before.
        for (let i = 0; i < 14; i++) {
            h.chain.mine();
            await tick(h);
        }
        expect({ depth: h.chain.head.number - seen.included, status: stateOf(h, seen.t.id).status }).toEqual({ depth: 15n, status: 'mined' });
        h.chain.mine();
        await tick(h);
        expect({ depth: h.chain.head.number - seen.included, status: stateOf(h, seen.t.id).status }).toEqual({ depth: 16n, status: 'confirmed' });
    });
});
