// The log search's progress (SearchProgress) from one check of a payment to the next, on an RPC without the state of
// older blocks, when an earlier check's reads contradict this one's: what the earlier check found is dropped, and what this
// check then searches must still count for the next one.

import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { confirmWithProgress, LOG_INDEX_LAG_BLOCKS, newSearchProgress } from '../../src/viem/confirm.js';
import { NOW, polygonPins, sampleRequest } from '../helpers/fixtures.js';
import { blockHash, scriptedRpc, versionOf } from './scriptedRpc.js';

const pins = polygonPins();
const HEAD = 1000;
// The deadline is after the block read: the search covers the blocks from `fromBlock` up to the use.
const target = versionOf(sampleRequest({ deadline: String(NOW + 5000) }));
const options = { fromBlock: 500n } as const;

describe('confirmWithProgress: an earlier check that contradicts this one', () => {
    it('the blocks this check searched are not searched again by the next one', async () => {
        // The node reads the nonce used at block 993 and refuses state below block 990; no log shows the use.
        const { client, requests } = scriptedRpc({ head: HEAD, nonce: BigInt(target.request.nonce), usedFrom: 10, stateFrom: 990 });
        const logRanges = () => requests.filter((r) => r.method === 'eth_getLogs').map((r) => BigInt((r.params[0] as { fromBlock: Hex }).fromBlock));
        // An earlier check of the same block read the nonce still unused at block 993 (another node behind the same URL).
        const progress = newSearchProgress();
        progress.anchor = { number: BigInt(HEAD), hash: blockHash(HEAD) };
        progress.used = 997n;
        progress.unused = 993n;

        expect(await confirmWithProgress(client, pins, target, options, progress)).toMatchObject({ status: 'unresolved', reason: 'no_history' });
        expect(progress.anchor).toEqual({ number: BigInt(HEAD), hash: blockHash(HEAD) });
        expect(logRanges()).toContain(500n);

        requests.length = 0;
        expect(await confirmWithProgress(client, pins, target, options, progress)).toMatchObject({ status: 'unresolved', reason: 'no_history' });
        // Only the blocks within LOG_INDEX_LAG_BLOCKS of the block read are asked again.
        expect(logRanges().length).toBeGreaterThan(0);
        expect(logRanges().every((from) => from > BigInt(HEAD) - LOG_INDEX_LAG_BLOCKS)).toBe(true);
    });
});
