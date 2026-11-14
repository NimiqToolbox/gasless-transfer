import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createViemChainClient } from '../../src/chain/viemChainClient.js';
import { captureLogger } from '../helpers/harness.js';

it('redacts a configured RPC URL echoed through the real transport error path', async () => {
    const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const payload = JSON.parse(raw) as { id: number };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: {
            code: -32000, message: `Authentication refused for http://${request.headers.host}${request.url}`,
        } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing local listener');
        const chain = createViemChainClient({ rpcUrls: [`http://127.0.0.1:${address.port}/v2/FAKE_PATH_CREDENTIAL?token=FAKE_QUERY_CREDENTIAL`], timeoutMs: 100 });
        const log = captureLogger();
        let failed = false;
        try { await chain.getBlock('latest'); }
        catch (err) { failed = true; log.logger.warn({ err }, 'RPC error during validation'); }
        expect(failed).toBe(true);
        expect(log.text()).toContain('RPC error during validation');
        expect(log.text()).not.toContain('FAKE_PATH_CREDENTIAL');
        expect(log.text()).not.toContain('FAKE_QUERY_CREDENTIAL');
    } finally {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
    }
});
