// eth_call answers no data ("0x") for nonces(from) where the pinned contract has no code: at a block before its
// creation, where the nonce is 0. An RPC can also answer no data where the contract has code (a wrong answer of a
// node or a proxy). Read as nonce 0, that would make a payment that executed look unused, and past its deadline
// `expired`. So the check asks eth_getCode at that block: only no code there is nonce 0.

import { beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, custom, type Hex, type PublicClient } from 'viem';
import { confirmOnChain } from '../../src/viem/confirm.js';
import { counted, readNonce, RequestsUsedUp } from '../../src/viem/confirmRpc.js';
import { waitForTransferOutcome } from '../../src/viem/outcome.js';
import { NOW, polygonPins, sampleRequest } from '../helpers/fixtures.js';
import { relayTransferInput, scriptedRpc, versionOf, type RpcRequest } from './scriptedRpc.js';

// Deadline NOW + 50: block 40 is before it, block 99 and the head (100) after it.
const target = versionOf(sampleRequest({ deadline: String(NOW + 50) }));
const nonce = BigInt(target.request.nonce);
const txHash: Hex = `0x${'c'.repeat(64)}`;
// The request executed in block 40.
const USE = 40;
const HEAD = 100;
const pins = polygonPins();

let input: Hex;
beforeAll(async () => {
    input = await relayTransferInput(target.request);
});

const executedNode = () => scriptedRpc({ head: HEAD, nonce, usedFrom: USE, call: { block: USE, txHash, input } });
const codeReads = (requests: readonly RpcRequest[]) => requests.filter((r) => r.method === 'eth_getCode').map((r) => Number(BigInt(r.params[1] as Hex)));

/**
 * The scripted node behind an RPC that answers eth_call with no data where `noData` says so, although the contract
 * has code there; with `codeRead: 'fails'` it also refuses eth_getCode.
 */
function wrongAnswers(inner: PublicClient, noData: (block: number) => boolean, codeRead?: 'fails'): PublicClient {
    return createPublicClient({
        transport: custom(
            {
                async request({ method, params }: { method: string; params?: readonly unknown[] }) {
                    if (method === 'eth_call' && noData(Number(BigInt((params ?? [])[1] as Hex)))) return '0x';
                    if (method === 'eth_getCode' && codeRead === 'fails') throw new Error('code read failed');
                    return inner.request({ method, params } as never);
                },
            },
            { retryCount: 0 },
        ),
    });
}

/** `noData` for one answer at `block`: the RPC answers that block rightly from then on. */
function once(block: number): (at: number) => boolean {
    let left = 1;
    return (at) => at === block && left-- > 0;
}

describe('confirmOnChain: eth_call answers no data where the pinned contract has code', () => {
    it('at the block read: the read fails, it is not nonce 0 (never expired)', async () => {
        const { client, requests } = executedNode();
        await expect(confirmOnChain(wrongAnswers(client, (at) => at === HEAD), pins, target)).rejects.toMatchObject({ name: 'ContractFunctionExecutionError' });
        expect(codeReads(requests)).toEqual([HEAD]);
    });

    it('at a probe of the state search after the deadline: a read the node cannot serve (never expired)', async () => {
        const { client, requests } = executedNode();
        expect(await confirmOnChain(wrongAnswers(client, (at) => at === HEAD - 1), pins, target)).toMatchObject({ status: 'unresolved', reason: 'no_history' });
        expect(codeReads(requests)).toEqual([HEAD - 1]);
    });

    it('with eth_getCode refused too, no data is no answer either', async () => {
        const atHead = executedNode();
        await expect(confirmOnChain(wrongAnswers(atHead.client, (at) => at === HEAD, 'fails'), pins, target)).rejects.toThrow(/code read failed/);
        const atProbe = executedNode();
        expect((await confirmOnChain(wrongAnswers(atProbe.client, (at) => at === HEAD - 1, 'fails'), pins, target)).status).toBe('unresolved');
    });

});

describe('confirmOnChain: no data where the pinned contract has no code is nonce 0', () => {
    it('a block read below the creation of the contract: pending before the deadline', async () => {
        const { client, requests } = scriptedRpc({ head: 30, nonce, createdAt: 35 });
        expect((await confirmOnChain(client, polygonPins({ deployBlock: 20 }), target)).status).toBe('pending');
        expect(codeReads(requests)).toEqual([30]);
    });

    it('the state search reads the blocks below the creation as unused and finds the execution', async () => {
        const { client, requests } = scriptedRpc({ head: HEAD, nonce, usedFrom: USE, call: { block: USE, txHash, input }, createdAt: USE - 2 });
        expect(await confirmOnChain(client, polygonPins({ deployBlock: USE - 10 }), target)).toMatchObject({ status: 'executed', txHash, blockNumber: BigInt(USE) });
        expect(codeReads(requests).length).toBeGreaterThan(0);
        expect(codeReads(requests).every((block) => block < USE - 2)).toBe(true);
        expect(requests.some((r) => r.method === 'eth_getLogs')).toBe(false);
    });

    it('the code read counts against the requests of the check', async () => {
        const { client } = scriptedRpc({ head: 30, nonce, createdAt: 35 });
        const budget = { left: 2 };
        expect(await readNonce(counted(client, budget), pins, target.request.from, 30n)).toBe(0n);
        expect(budget.left).toBe(0);
        await expect(readNonce(counted(client, { left: 1 }), pins, target.request.from, 30n)).rejects.toBeInstanceOf(RequestsUsedUp);
    });
});

describe('waitForTransferOutcome: one eth_call answer with no data where the contract has code', () => {
    const options = { pollIntervalMs: 1, timeoutMs: 5_000, now: () => NOW + 200 };
    const executed = { status: 'executed', txHash, blockNumber: BigInt(USE) };

    it('in the state search: the wait goes on, and the next poll finds the execution', async () => {
        const { client, requests } = executedNode();
        expect(await waitForTransferOutcome(wrongAnswers(client, once(HEAD - 1)), pins, target, options)).toMatchObject(executed);
        // Two checks: the first one ended without an answer.
        expect(requests.filter((r) => r.method === 'eth_chainId')).toHaveLength(2);
    });

    it('at the block read: the wait rejects with the read error, as with any RPC error of that read, and a new wait finds the execution', async () => {
        const { client } = executedNode();
        const flaky = wrongAnswers(client, once(HEAD));
        await expect(waitForTransferOutcome(flaky, pins, target, options)).rejects.toMatchObject({ name: 'ContractFunctionExecutionError' });
        expect(await waitForTransferOutcome(flaky, pins, target, options)).toMatchObject(executed);
    });
});
