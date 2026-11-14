// `txHash` is a hint: the transaction to look at first. confirmOnChain validates it like its other options; a status
// source's malformed hash must not end waitForTransferOutcome, which finds the use itself.

import { beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { RequestState } from '../../src/relay/types.js';
import { confirmOnChain } from '../../src/viem/confirm.js';
import { waitForTransferOutcome } from '../../src/viem/outcome.js';
import { NOW, polygonPins, sampleRequest } from '../helpers/fixtures.js';
import { relayTransferInput, scriptedRpc, versionOf } from './scriptedRpc.js';

const pins = polygonPins();
const target = versionOf(sampleRequest());
const txHash: Hex = `0x${'c'.repeat(64)}`;
const USE = 90;

let input: Hex;
beforeAll(async () => {
    input = await relayTransferInput(target.request);
});

const rpc = () => scriptedRpc({ head: 100, nonce: BigInt(target.request.nonce), usedFrom: USE, call: { block: USE, txHash, input } });

describe('the txHash hint', () => {
    it.each([['too short', '0x1234'], ['not hex', `0x${'g'.repeat(64)}`], ['not a string', 7], ['null', null]])(
        'confirmOnChain refuses a txHash that is not 32 bytes of hex, before any read: %s',
        async (_name, malformed) => {
            const { client, requests } = rpc();
            const check = confirmOnChain(client, pins, target, { txHash: malformed as unknown as Hex });
            await expect(check).rejects.toBeInstanceOf(TypeError);
            await expect(check).rejects.toThrow(/^txHash: /);
            expect(requests).toHaveLength(0);
        },
    );

    it('confirmOnChain takes a well-formed txHash in either case of hex', async () => {
        const { client } = rpc();
        expect(await confirmOnChain(client, pins, target, { txHash: `0x${'C'.repeat(64)}` })).toMatchObject({ status: 'executed', txHash });
    });

    it.each([['too short', '0x1234'], ['not a string', 7]])('waitForTransferOutcome drops a status source’s malformed txHash and finds the execution: %s', async (_name, malformed) => {
        const { client, requests } = rpc();
        const state = { status: 'mined', txHash: malformed } as unknown as RequestState;
        const outcome = await waitForTransferOutcome(client, pins, target, { relay: { getRequest: async () => state }, now: () => NOW, timeoutMs: 1000 });
        expect(outcome).toMatchObject({ status: 'executed', txHash, blockNumber: BigInt(USE), relayState: state });
        expect(requests.some((r) => r.method === 'eth_getTransactionReceipt' && r.params[0] === malformed)).toBe(false);
    });

    it.each([['undefined', undefined], ['null', null], ['a string', 'mined']])('waitForTransferOutcome reads the chain when a status source answers with no state object: %s', async (_name, answer) => {
        const { client } = rpc();
        const relay = { getRequest: async () => answer as unknown as RequestState };
        const outcome = await waitForTransferOutcome(client, pins, target, { relay, now: () => NOW, timeoutMs: 1000 });
        expect(outcome).toMatchObject({ status: 'executed', txHash, blockNumber: BigInt(USE), relayState: null });
    });
});
