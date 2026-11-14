// Every configured RPC must serve the chain of the deployment.
//
// Scenario: a secondary entry of RELAY_RPC_URLS points to another network. Ordinary reads go through viem's
// `fallback` transport, i.e. to the first RPC that answers, so the mistake stays invisible while the primary is up.
// Once the primary fails, every read (intent and tx nonces, balances, simulation, receipts) would silently come from
// the wrong chain while transactions are still signed for the configured one: the transaction manager would treat
// nonces and receipts of the wrong chain as truth, and the pipeline would validate against foreign state.
//
// Expected: startup asks every configured RPC for eth_chainId (verifyDeployment) and refuses the list.

import { afterEach, describe, expect, it } from 'vitest';
import { createViemChainClient } from '../../../src/chain/viemChainClient.js';
import { verifyDeployment } from '../../../src/startup.js';
import { FakeChain } from '../../helpers/fakeChain.js';
import { START_TIME, testDeployment } from '../../helpers/harness.js';
import { RELAY_ADDRESS } from '../../helpers/keys.js';
import { serveFakeChain, type RpcAdapter } from '../../helpers/rpcAdapter.js';

const adapters: RpcAdapter[] = [];

afterEach(async () => {
    await Promise.all(adapters.splice(0).map((a) => a.close()));
});

describe('every configured RPC must serve the deployment chain', () => {
    it('startup refuses a secondary RPC on another chain', async () => {
        const deployment = testDeployment();
        const primary = new FakeChain({ deployment, timestamp: START_TIME, relay: RELAY_ADDRESS });
        const secondary = new FakeChain({ deployment, timestamp: START_TIME, relay: RELAY_ADDRESS });
        secondary.chainId = 80002; // e.g. an Amoy endpoint pasted into the mainnet list
        const a = await serveFakeChain(primary);
        const b = await serveFakeChain(secondary);
        adapters.push(a, b);

        const chain = createViemChainClient({ rpcUrls: [a.url, b.url], timeoutMs: 1000 });
        let startupError: unknown;
        try {
            await verifyDeployment(chain, deployment);
        } catch (err) {
            startupError = err;
        }

        // What a relay that started anyway would do: with the primary down, reads fail over to the other chain.
        primary.rpcDown = true;
        expect.soft(await chain.getChainId()).toBe(80002);

        expect(startupError, 'verifyDeployment accepted an RPC list that contains another chain').toBeInstanceOf(Error);
    });
});
