// `pins.deployBlock` must be at or below the contract's creation block: the check does not search below it. A pin
// above the creation block hides a use below it, so the check must notice the wrong pin and never answer `expired`
// from it.

import { beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { confirmOnChain } from '../../src/viem/confirm.js';
import { NOW, polygonPins, sampleRequest } from '../helpers/fixtures.js';
import { relayTransferInput, scriptedRpc, versionOf, type RpcRequest } from './scriptedRpc.js';

// Deadline NOW + 50: block 40 is before it, block 70 and later after it.
const target = versionOf(sampleRequest({ deadline: String(NOW + 50) }));
const nonce = BigInt(target.request.nonce);
const txHash: Hex = `0x${'c'.repeat(64)}`;
// The request executed in block 40.
const USE = 40;

let input: Hex;
beforeAll(async () => {
    input = await relayTransferInput(target.request);
});

const rpc = (head: number) => scriptedRpc({ head, nonce, usedFrom: USE, call: { block: USE, txHash, input } });
const stateReads = (requests: readonly RpcRequest[]) => requests.filter((r) => r.method === 'eth_call').map((r) => Number(BigInt(r.params[1] as Hex)));

describe('confirmOnChain: a wrong pins.deployBlock', () => {
    it('a pin above the block that used the nonce is an InvalidPinsError, not expired', async () => {
        const { client, requests } = rpc(100);
        await expect(confirmOnChain(client, polygonPins({ deployBlock: 80 }), target)).rejects.toMatchObject({ code: 'invalid_pins', field: 'deployBlock' });
        // The state search ended at the pin; the block below it shows the nonce already used.
        expect(stateReads(requests)).toContain(79);
    });

    it('a pin above the block read, with the nonce used there, is an InvalidPinsError, not expired', async () => {
        const { client } = rpc(70);
        await expect(confirmOnChain(client, polygonPins({ deployBlock: 80 }), target)).rejects.toMatchObject({ code: 'invalid_pins', field: 'deployBlock' });
    });

    it('a block read below the pin with the nonce unused: nothing executed (expired past the deadline)', async () => {
        // The contract is created at the pin: at the block read it has no code, and eth_call answers no data.
        const { client } = scriptedRpc({ head: 70, nonce, createdAt: 80 });
        expect((await confirmOnChain(client, polygonPins({ deployBlock: 80 }), target)).status).toBe('expired');
    });

    it('a use in the pinned block itself is found: the nonce is unused in the block below the pin', async () => {
        const { client, requests } = rpc(100);
        expect(await confirmOnChain(client, polygonPins({ deployBlock: USE }), target)).toMatchObject({ status: 'executed', txHash, blockNumber: BigInt(USE) });
        expect(stateReads(requests)).toContain(USE - 1);
    });

    it('a pin below the use needs no read below the pin', async () => {
        const { client, requests } = rpc(100);
        expect((await confirmOnChain(client, polygonPins({ deployBlock: 10 }), target)).status).toBe('executed');
        expect(stateReads(requests).every((block) => block >= 10)).toBe(true);
    });
});

// A node without the state of older blocks cannot read the nonce under the pin, so the log search cannot notice a pin
// above the use. Every block from the pin (80) on is after the deadline: that alone is no evidence of an unused nonce.
describe('confirmOnChain: a wrong pins.deployBlock on a node without the state of older blocks', () => {
    it.each([
        ['below the block read', 100],
        ['at the pin', 84],
    ])('a pin above the use, with the state %s refused: no answer, not expired', async (_name, stateFrom) => {
        const { client } = scriptedRpc({ head: 100, nonce, usedFrom: USE, call: { block: USE, txHash, input }, stateFrom });
        expect(await confirmOnChain(client, polygonPins({ deployBlock: 80 }), target)).toMatchObject({ status: 'unresolved', reason: 'no_history' });
    });

    it('a pin at or below the creation: the nonce unused at the last block before the deadline is expired', async () => {
        // The nonce is used in block 60, after the deadline; the node serves the state of block 50, the last one before it.
        const { client, requests } = scriptedRpc({ head: 100, nonce, usedFrom: 60, stateFrom: 45 });
        expect((await confirmOnChain(client, polygonPins({ deployBlock: 10 }), target)).status).toBe('expired');
        // The state search was refused block 37, so the answer is the log search's.
        expect(stateReads(requests)).toEqual(expect.arrayContaining([37, 50]));
    });
});
