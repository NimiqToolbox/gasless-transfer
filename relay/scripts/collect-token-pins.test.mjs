import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTokenPins, REVIEWED_PROXIES } from './collect-token-pins.mjs';
const hash = `0x${'12'.repeat(32)}`;
const word = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
function rpc(change = {}) {
    return async (method, args) => {
        if (change[method]) return change[method](args);
        if (method === 'eth_chainId') return '0x89';
        if (method === 'eth_getBlockByNumber') return { number: '0x100', hash };
        if (method === 'eth_getCode') return '0x6000';
        const spec = REVIEWED_PROXIES.find((item) => item.address === (method === 'eth_call' ? args[0].to : args[0]));
        if (method === 'eth_getStorageAt' || method === 'eth_call') return word(spec.expectedImplementation);
        throw new Error('unexpected RPC');
    };
}
const source = async (url) => `${REVIEWED_PROXIES.find((p) => p.source === url).slotLabel} IMPLEMENTATION_SLOT sload`;
test('collects an explicitly unapproved candidate from two providers', async () => {
    const result = await collectTokenPins([rpc(), rpc()], source);
    assert.equal(result.status, 'candidate-requires-review'); assert.equal(result.pins.tokens.length, 2);
    assert.equal(result.pins.reviewedBlock, '256'); assert.equal(result.providerCount, 2);
});
test('rejects wrong chain, differing code, changed implementation, contradictory getter and missing source evidence', async () => {
    for (const change of [
        { eth_chainId: () => '0x1' }, { eth_getCode: () => '0x6001' },
        { eth_getStorageAt: () => word('0x1111111111111111111111111111111111111111') },
        { eth_call: () => word('0x1111111111111111111111111111111111111111') },
        { eth_getBlockByNumber: () => ({ number: '0x100', hash: `0x${'34'.repeat(32)}` }) },
    ]) await assert.rejects(collectTokenPins([rpc(), rpc(change)], source));
    await assert.rejects(collectTokenPins([rpc(), rpc()], async () => 'unknown proxy'));
    await assert.rejects(collectTokenPins([rpc()], source));
});
