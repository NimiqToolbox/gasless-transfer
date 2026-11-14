// viem answers an OffchainLookup revert of an eth_call (EIP-3668, CCIP-Read) by fetching the URLs in the revert data,
// unless the client has `ccipRead: false`. The RPC chooses that data, so an RPC could make the wallet send HTTP
// requests to hosts of its choice. The SDK's reads run with CCIP-Read off, whatever the caller's client says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, encodeErrorResult, parseAbi, toHex, type Address, type PublicClient } from 'viem';
import { confirmOnChain } from '../../src/viem/confirm.js';
import { prepareTransfer } from '../../src/viem/prepare.js';
import { checkTokenDomain, readTokenNonce } from '../../src/viem/tokens.js';
import { ADDR, NOW, polygonPins, sampleRequest, USDC } from '../helpers/fixtures.js';
import { blockHash, versionOf } from './scriptedRpc.js';

const pins = polygonPins();
const offchainLookup = parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']);

/**
 * A node that answers every eth_call with an OffchainLookup revert whose sender is the called contract, as EIP-3668
 * requires, behind a client with viem's default `ccipRead` or with the caller's own gateway request.
 */
function lookupNode(ccipRead?: { request: () => Promise<never> }): PublicClient {
    return createPublicClient({
        ...(ccipRead !== undefined ? { ccipRead } : {}),
        transport: custom(
            {
                async request({ method, params }: { method: string; params?: readonly unknown[] }) {
                    if (method === 'eth_chainId') return '0x89';
                    if (method === 'eth_getBlockByNumber') {
                        return { number: toHex(100), timestamp: toHex(NOW), hash: blockHash(100), parentHash: blockHash(99), transactions: [] };
                    }
                    if (method === 'eth_call') {
                        const { to } = (params ?? [])[0] as { to: Address };
                        const data = encodeErrorResult({
                            abi: offchainLookup,
                            errorName: 'OffchainLookup',
                            args: [to, ['https://gateway.invalid/{sender}/{data}'], '0x1234', '0x12345678', '0x'],
                        });
                        throw Object.assign(new Error('execution reverted'), { code: 3, data });
                    }
                    throw new Error(`unexpected RPC ${method}`);
                },
            },
            { retryCount: 0 },
        ),
    });
}

const reads: ReadonlyArray<readonly [string, (client: PublicClient) => Promise<unknown>]> = [
    ['confirmOnChain', (client) => confirmOnChain(client, pins, versionOf(sampleRequest()))],
    ['prepareTransfer', (client) => prepareTransfer(client, pins, { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: 10_000_000n, fee: 50_000n, relay: ADDR.relay, now: NOW })],
    ['checkTokenDomain', (client) => checkTokenDomain(client, pins, USDC)],
    ['readTokenNonce', (client) => readTokenNonce(client, pins, { token: USDC, owner: ADDR.user, authMode: 'permit' })],
];

describe('the SDK reads with CCIP-Read off', () => {
    const fetched = vi.fn(async () => {
        throw new Error('no HTTP request is expected');
    });

    beforeEach(() => {
        vi.stubGlobal('fetch', fetched);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        fetched.mockClear();
    });

    it.each(reads)('%s: an OffchainLookup revert is an ordinary read error, and nothing is fetched', async (_name, read) => {
        const client = lookupNode();
        await expect(read(client)).rejects.toMatchObject({ name: 'ContractFunctionExecutionError' });
        expect(fetched).not.toHaveBeenCalled();
        // The caller's client keeps its own setting.
        expect(client.ccipRead).toBeUndefined();
    });

    it.each(reads)("%s: the caller's own gateway request is not used either", async (_name, read) => {
        const ccipRead = { request: vi.fn(async () => { throw new Error('no gateway request is expected'); }) };
        const client = lookupNode(ccipRead);
        await expect(read(client)).rejects.toMatchObject({ name: 'ContractFunctionExecutionError' });
        expect(ccipRead.request).not.toHaveBeenCalled();
        expect(fetched).not.toHaveBeenCalled();
        expect(client.ccipRead).toBe(ccipRead);
    });
});
