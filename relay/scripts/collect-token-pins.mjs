// Read-only candidate collector. Never writes production configuration or broadcasts transactions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { keccak256, stringToHex, toHex } from 'viem';

export const REVIEWED_PROXIES = [
    {
        symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        slotLabel: 'org.zeppelinos.proxy.implementation',
        source: 'https://raw.githubusercontent.com/circlefin/stablecoin-evm/master/contracts/upgradeability/UpgradeabilityProxy.sol',
        expectedImplementation: '0x235AE97b28466Db30469b89A9fe4cFf0659f82Cb',
    },
    {
        symbol: 'USDT0', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        slotLabel: 'matic.network.proxy.implementation',
        source: 'https://raw.githubusercontent.com/maticnetwork/pos-portal/master/contracts/common/Proxy/UpgradableProxy.sol',
        expectedImplementation: '0x90040487A6C9F949C4F07CaDCFB0f3B8EEAb4229',
    },
];
const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const codePattern = /^0x(?:[0-9a-fA-F]{2})+$/;
const same = (a, b, message) => assert.equal(a?.toLowerCase(), b?.toLowerCase(), message);

export async function collectTokenPins(rpcs, sourceLoader) {
    assert.ok(rpcs.length >= 2, 'at least two independent RPCs required');
    const finalized = await Promise.all(rpcs.map(async (rpc) => {
        assert.equal(BigInt(await rpc('eth_chainId', [])), 137n, 'wrong chain');
        const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
        assert.match(block.hash, bytes32);
        return BigInt(block.number);
    }));
    const block = finalized.reduce((a, b) => a < b ? a : b);
    assert.ok(block > 0n);
    const tag = toHex(block);
    const blocks = await Promise.all(rpcs.map((rpc) => rpc('eth_getBlockByNumber', [tag, false])));
    assert.match(blocks[0].hash, bytes32);
    blocks.forEach((b) => { same(b.hash, blocks[0].hash, 'providers disagree on block'); assert.equal(BigInt(b.number), block); });
    const tokens = [];
    const provenance = [];
    for (const spec of REVIEWED_PROXIES) {
        const source = await sourceLoader(spec.source);
        assert.ok(source.includes(spec.slotLabel) && source.includes('IMPLEMENTATION_SLOT') && source.includes('sload'), 'upstream proxy slot source changed; manual review required');
        const implementationSlot = keccak256(stringToHex(spec.slotLabel));
        const observations = await Promise.all(rpcs.map(async (rpc) => {
            const [proxyCode, value] = await Promise.all([
                rpc('eth_getCode', [spec.address, tag]), rpc('eth_getStorageAt', [spec.address, implementationSlot, tag]),
            ]);
            assert.match(proxyCode, codePattern, 'empty or malformed proxy code');
            assert.match(value, /^0x0{24}[0-9a-fA-F]{40}$/, 'invalid implementation slot word');
            const implementationAddress = `0x${value.slice(-40)}`;
            same(implementationAddress, spec.expectedImplementation, 'implementation changed since reviewed real-token fixtures; review before pinning');
            const implementationCode = await rpc('eth_getCode', [implementationAddress, tag]);
            assert.match(implementationCode, codePattern, 'empty or malformed implementation code');
            if (spec.symbol === 'USDT0') {
                same(await rpc('eth_call', [{ to: spec.address, data: '0x5c60da1b' }, tag]), value, 'implementation getter contradicts storage slot');
            }
            return { address: spec.address, proxyCodeHash: keccak256(proxyCode), implementationSlot, implementationAddress, implementationCodeHash: keccak256(implementationCode) };
        }));
        observations.forEach((observation) => assert.deepEqual(observation, observations[0], 'provider token evidence differs'));
        tokens.push(observations[0]);
        provenance.push({ symbol: spec.symbol, slotLabel: spec.slotLabel, source: spec.source, sourceSha256: createHash('sha256').update(source).digest('hex'), previousFixtureImplementation: spec.expectedImplementation });
    }
    for (const rpc of rpcs) {
        same((await rpc('eth_getBlockByNumber', [tag, false])).hash, blocks[0].hash, 'block changed while collecting evidence');
        assert.ok(BigInt((await rpc('eth_getBlockByNumber', ['finalized', false])).number) >= block, 'finality regressed');
    }
    return {
        status: 'candidate-requires-review', collectedAt: new Date().toISOString(), blockHash: blocks[0].hash,
        providerCount: rpcs.length, pins: { chainId: 137, reviewedBlock: block.toString(), tokens }, provenance,
        limitations: 'RPC consensus and unchanged implementation addresses do not prove source equivalence or absence of issuer-controlled storage changes. Review candidate and compatibility evidence before copying pins into production configuration.',
    };
}

async function main() {
    const urls = process.env.TOKEN_PINS_RPC_URLS.split(',').map((s) => s.trim());
    assert.equal(new Set(urls.map((url) => new URL(url).hostname)).size, urls.length, 'distinct provider hosts required');
    const rpcs = urls.map((url) => async (method, params) => {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
        assert.ok(response.ok, 'RPC HTTP failure');
        const body = await response.json();
        assert.ok(!body.error && body.result !== undefined, 'RPC result unavailable');
        return body.result;
    });
    const result = await collectTokenPins(rpcs, async (url) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        assert.ok(response.ok, 'upstream source unavailable');
        return response.text();
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!process.env.TOKEN_PINS_RPC_URLS) {
        console.error('Set TOKEN_PINS_RPC_URLS to the comma-separated Polygon RPC URLs of two or more independent providers.');
        process.exit(2);
    }
    main().catch(() => { console.error('Token pin candidate collection failed; no production pins were written. Check RPC access and review source, implementation and block evidence.'); process.exitCode = 1; });
}
