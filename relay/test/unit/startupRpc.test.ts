// Startup checks eth_chainId on every configured RPC, not only on the one the fallback transport asks first: after a
// failover the relay would otherwise read from another chain. An RPC that does not answer counts as a mismatch (fail
// closed). The error names RPCs by their position, never by URL (URLs often contain API keys).
import { afterEach, describe, expect, it } from 'vitest';
import { createViemChainClient } from '../../src/chain/viemChainClient.js';
import { StartupError, verifyDeployment } from '../../src/startup.js';
import { FakeChain } from '../helpers/fakeChain.js';
import { START_TIME, testDeployment } from '../helpers/harness.js';
import { RELAY_ADDRESS } from '../helpers/keys.js';
import { serveFakeChain, type RpcAdapter } from '../helpers/rpcAdapter.js';

const adapters: RpcAdapter[] = [];

afterEach(async () => {
    await Promise.all(adapters.splice(0).map((a) => a.close()));
});

async function serve(configure: (chain: FakeChain) => void = () => {}): Promise<RpcAdapter> {
    const chain = new FakeChain({ deployment: testDeployment(), timestamp: START_TIME, relay: RELAY_ADDRESS });
    configure(chain);
    const adapter = await serveFakeChain(chain);
    adapters.push(adapter);
    return adapter;
}

async function startupError(urls: readonly string[]): Promise<StartupError | undefined> {
    const chain = createViemChainClient({ rpcUrls: urls, timeoutMs: 1000 });
    try {
        await verifyDeployment(chain, testDeployment());
        return undefined;
    } catch (err) {
        expect(err).toBeInstanceOf(StartupError);
        return err as StartupError;
    }
}

describe('eth_chainId of every configured RPC', () => {
    it('passes when every RPC serves the deployment chain', async () => {
        const a = await serve();
        const b = await serve();
        expect(await startupError([a.url, b.url])).toBeUndefined();
    });

    it('refuses a secondary RPC on another chain, naming it by position only', async () => {
        const a = await serve();
        const b = await serve((c) => {
            c.chainId = 80002;
        });
        const err = await startupError([a.url, b.url]);
        expect(err?.message).toContain('RPC #2 serves chain 80002, not 137');
        expect(err?.message).not.toContain(b.url);
    });

    it('fails closed when a configured RPC does not answer (it could serve another chain after a failover)', async () => {
        const a = await serve();
        const b = await serve((c) => {
            c.rpcDown = true;
        });
        const err = await startupError([a.url, b.url]);
        expect(err?.message).toMatch(/RPC #2 did not answer eth_chainId/);
        expect(err?.message).not.toContain(b.url);
    });
});
