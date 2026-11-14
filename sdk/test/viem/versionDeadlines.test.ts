// `expired` says that no version of a payment can execute only when the checked version has the payment's latest
// deadline. With `versions` the check knows every deadline, so it refuses a checked version that is not the latest
// instead of answering `expired` for it while a later version executed.

import { beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { confirmOnChain } from '../../src/viem/confirm.js';
import { waitForTransferOutcome } from '../../src/viem/outcome.js';
import { NOW, polygonPins, sampleRequest } from '../helpers/fixtures.js';
import { relayTransferInput, scriptedRpc, versionOf } from './scriptedRpc.js';

const pins = polygonPins();
// The first version, and its correction with a higher fee and a later deadline.
const first = versionOf(sampleRequest({ deadline: String(NOW + 50) }));
const latest = versionOf(sampleRequest({ fee: '60000', deadline: String(NOW + 600) }));
const txHash: Hex = `0x${'c'.repeat(64)}`;
// The correction executed in block 90 (timestamp NOW + 90): after the first version's deadline, before its own.
const USE = 90;

let input: Hex;
beforeAll(async () => {
    input = await relayTransferInput(latest.request);
});

const rpc = () => scriptedRpc({ head: 100, nonce: BigInt(latest.request.nonce), usedFrom: USE, call: { block: USE, txHash, input } });

describe('confirmOnChain: the deadlines of `versions`', () => {
    it('refuses a listed version with a later deadline than the checked one, before any read', async () => {
        const { client, requests } = rpc();
        await expect(confirmOnChain(client, pins, { ...first, versions: [first, latest] })).rejects.toMatchObject({
            code: 'invalid_request',
            field: 'versions[1].request.deadline',
        });
        expect(requests).toHaveLength(0);
    });

    it('waitForTransferOutcome refuses it too, before it waits', async () => {
        const { client, requests } = rpc();
        await expect(waitForTransferOutcome(client, pins, { ...first, versions: [latest] }, { now: () => NOW, timeoutMs: 1000 })).rejects.toMatchObject({
            code: 'invalid_request',
            field: 'versions[0].request.deadline',
        });
        expect(requests).toHaveLength(0);
    });

    it('the latest version, with earlier and equal deadlines listed: the execution is found', async () => {
        const sameDeadline = versionOf(sampleRequest({ fee: '70000', deadline: latest.request.deadline }));
        const { client } = rpc();
        expect(await confirmOnChain(client, pins, { ...latest, versions: [first, sameDeadline, latest] })).toMatchObject({
            status: 'executed',
            txHash,
            blockNumber: BigInt(USE),
        });
    });

    it('without `versions` the check cannot know of the later version: the earlier one alone is expired', async () => {
        const { client } = rpc();
        expect((await confirmOnChain(client, pins, first)).status).toBe('expired');
    });
});
