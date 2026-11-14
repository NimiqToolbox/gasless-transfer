import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { encodeDeployData, encodeFunctionData, encodeFunctionResult, getContractAddress, hashDomain, parseAbi } from 'viem';
import { loadArtifacts, expectedCreation, expectedRuntime, TOKENS, verifyDeployment, readOnlyRpc } from './verify-deployment.mjs';

const artifacts = loadArtifacts('../contracts/out');
const from = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const address = getContractAddress({ from, nonce: 0n });
const hash = `0x${'12'.repeat(32)}`;
const blockHash = `0x${'34'.repeat(32)}`;
const zero = '0x0000000000000000000000000000000000000000';
const domain = hashDomain({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] }, domain: { name: 'Nimiq Gasless Transfer', version: '3', chainId: 137, verifyingContract: address } });
const abi = parseAbi([
    'function DOMAIN_SEPARATOR() view returns (bytes32)',
    'function decimals() view returns (uint8)',
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function tokenConfig(address) view returns ((bool permit, bool metaTxApprove, bool allowance))',
]);
const tokenDomains = ['0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca', '0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05'];
function fixture(mutate = () => undefined) {
    const receipt = { transactionHash: hash, contractAddress: address, status: '0x1', blockNumber: '0xa', blockHash, transactionIndex: '0x0' };
    const tx = { hash, from, nonce: '0x0', to: null, chainId: '0x89', value: '0x0', input: expectedCreation(artifacts, owner), blockHash };
    const state = {
        receipt, tx, runtime: expectedRuntime(artifacts, address), chain: '0x89', finalized: '0x14', snapshotHash: blockHash, domain,
        owner, pendingOwner: zero, configs: TOKENS.map((t) => ({ ...t.config })),
    };
    mutate(state);
    const rpc = async (method, params) => {
        if (method === 'eth_chainId') return state.chain;
        if (method === 'eth_getTransactionReceipt') return state.receipt;
        if (method === 'eth_getTransactionByHash') return state.tx;
        if (method === 'eth_getBlockByNumber') return { number: params[0] === 'finalized' ? state.finalized : params[0], hash: params[0] === '0xa' ? blockHash : state.snapshotHash, transactions: [hash] };
        if (method === 'eth_getCode') return params[0] === address ? state.runtime : '0x1234';
        if (method === 'eth_call') {
            const { to, data } = params[0];
            for (const functionName of ['DOMAIN_SEPARATOR', 'decimals', 'owner', 'pendingOwner']) {
                if (data !== encodeFunctionData({ abi, functionName })) continue;
                const token = TOKENS.findIndex((t) => t.token === to);
                const result = {
                    DOMAIN_SEPARATOR: token < 0 ? state.domain : tokenDomains[token],
                    decimals: 6,
                    owner: state.owner,
                    pendingOwner: state.pendingOwner,
                }[functionName];
                return encodeFunctionResult({ abi, functionName, result });
            }
            const index = TOKENS.findIndex((t) => data === encodeFunctionData({ abi, functionName: 'tokenConfig', args: [t.token] }));
            assert.ok(index >= 0);
            return encodeFunctionResult({ abi, functionName: 'tokenConfig', result: state.configs[index] });
        }
        throw new Error(`unexpected RPC ${method}`);
    };
    return { rpc, address, transactionHash: hash, artifacts, expectedOwner: owner };
}
test('accepts canonical finalized exact-build evidence and reports the owner', async () => {
    const result = await verifyDeployment(fixture());
    assert.equal(result.verified, true);
    assert.equal(result.version, '3');
    assert.equal(result.initialOwner.toLowerCase(), owner);
    assert.equal(result.owner.toLowerCase(), owner);
    assert.deepEqual(result.tokens.map((t) => t.config), [{ permit: true, metaTxApprove: false, allowance: true }, { permit: true, metaTxApprove: true, allowance: true }]);
});
test('accepts a later owner when it is named', async () => {
    const later = '0x3333333333333333333333333333333333333333';
    assert.equal((await verifyDeployment({ ...fixture((s) => { s.owner = later; }), expectedCurrentOwner: later })).verified, true);
});
// The creation bytes are rebuilt with the owner the deployment itself names, so only the expected owner tells a
// deployment of this build owned by someone else apart. Without it, nothing is verified.
test('requires the expected initial owner (GASLESS_TRANSFER_OWNER)', async () => {
    await assert.rejects(verifyDeployment({ ...fixture(), expectedOwner: undefined }), /GASLESS_TRANSFER_OWNER/);
    await assert.rejects(verifyDeployment({ ...fixture(), expectedOwner: '' }), /GASLESS_TRANSFER_OWNER/);
});
// The relay and the SDK read no state below the record's deployBlock when they look for what used an intent
// nonce (the nonce counts as unused there), so it must be at or below the deployment's block (10 here).
test("checks the record's deployBlock (DEPLOY_BLOCK) against the deployment block and reports it", async () => {
    for (const deployBlock of ['0', '9', '10']) assert.equal((await verifyDeployment({ ...fixture(), deployBlock })).deployBlock, deployBlock);
    assert.equal((await verifyDeployment(fixture())).deployBlock, undefined);
    await assert.rejects(verifyDeployment({ ...fixture(), deployBlock: '11' }), /deployBlock is above the deployment block/);
    for (const deployBlock of ['0xa', '-1', '1e1', '010', '']) await assert.rejects(verifyDeployment({ ...fixture(), deployBlock }), /DEPLOY_BLOCK/);
});
test('the command line refuses to run without GASLESS_TRANSFER_OWNER, before any network access', () => {
    const env = { PATH: process.env.PATH, POLYGON_RPC_URL: 'http://127.0.0.1:1' };
    const run = spawnSync(process.execPath, ['scripts/verify-deployment.mjs', address, hash], { env, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /GASLESS_TRANSFER_OWNER is required/);
    assert.doesNotMatch(run.stderr, /RPC transport failed/);
});
/** `rpc` served as JSON-RPC over HTTP on 127.0.0.1 (a random port). */
async function serveRpc(rpc) {
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
            const { id, method, params } = JSON.parse(body);
            let reply;
            try {
                reply = { jsonrpc: '2.0', id, result: await rpc(method, params) };
            } catch (error) {
                reply = { jsonrpc: '2.0', id, error: { code: -32000, message: String(error.message) } };
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(reply));
        });
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(resolveClose); }) };
}
/** The command line as an operator runs it (`node scripts/verify-deployment.mjs ADDRESS TX_HASH`), with `env` only. */
function runCli(env) {
    return new Promise((resolveRun) => {
        const child = spawn(process.execPath, ['scripts/verify-deployment.mjs', address, hash], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (status) => resolveRun({ status, stdout, stderr }));
    });
}
// The command line reads DEPLOY_BLOCK and passes it to the check, which reports it or refuses it.
test('the command line checks and reports DEPLOY_BLOCK', async () => {
    const server = await serveRpc(fixture().rpc);
    try {
        const env = { POLYGON_RPC_URL: server.url, GASLESS_TRANSFER_OWNER: owner };
        const below = await runCli({ ...env, DEPLOY_BLOCK: '9' });
        assert.equal(below.status, 0, below.stderr);
        assert.equal(JSON.parse(below.stdout).deployBlock, '9');
        const above = await runCli({ ...env, DEPLOY_BLOCK: '11' });
        assert.equal(above.status, 1);
        assert.match(above.stderr, /deployBlock is above the deployment block/);
        const hex = await runCli({ ...env, DEPLOY_BLOCK: '0xa' });
        assert.equal(hex.status, 1);
        assert.match(hex.stderr, /DEPLOY_BLOCK/);
        const none = await runCli(env);
        assert.equal(none.status, 0, none.stderr);
        assert.equal(Object.hasOwn(JSON.parse(none.stdout), 'deployBlock'), false);
    } finally {
        await server.close();
    }
});
// Every provider that is given must answer and agree: one that does not stops the verification, and the message names
// it by its position and variable. Its URL can carry an API key, and so can a reply that echoes the URL.
test('the command line names the provider that does not answer or disagrees, and never prints its URL', async () => {
    const secret = 'cli-secret-api-key';
    const withKey = (server) => `${server.url}/v2/${secret}`;
    const answering = await serveRpc(fixture().rpc);
    const agreeing = await serveRpc(fixture().rpc);
    const otherSnapshot = await serveRpc(fixture((s) => { s.snapshotHash = hash; }).rpc);
    const otherOwner = await serveRpc(fixture((s) => { s.owner = from; }).rpc);
    // Answers every request with the path it was asked on, as text.
    const echo = createServer((req, res) => { req.resume(); req.on('end', () => res.end(req.url)); });
    await new Promise((resolveListen) => echo.listen(0, '127.0.0.1', resolveListen));
    const echoing = { url: `http://127.0.0.1:${echo.address().port}`, close: () => new Promise((resolveClose) => { echo.closeAllConnections(); echo.close(resolveClose); }) };
    // Nothing listens on its port any more.
    const silent = await serveRpc(fixture().rpc);
    await silent.close();
    const servers = [answering, agreeing, otherSnapshot, otherOwner, echoing];
    try {
        const run = (first, second) => runCli({ GASLESS_TRANSFER_OWNER: owner, POLYGON_RPC_URL: withKey(first), POLYGON_VERIFY_RPC_URL: withKey(second) });
        const both = await run(answering, agreeing);
        assert.equal(both.status, 0, both.stderr);
        assert.equal(JSON.parse(both.stdout).providerCount, 2);
        for (const [first, second, message] of [
            [answering, silent, 'provider #2 (POLYGON_VERIFY_RPC_URL): RPC transport failed for eth_chainId'],
            [silent, answering, 'provider #1 (POLYGON_RPC_URL): RPC transport failed for eth_chainId'],
            [answering, echoing, 'provider #2 (POLYGON_VERIFY_RPC_URL): RPC response is not JSON for eth_chainId'],
            [answering, otherOwner, 'provider #2 (POLYGON_VERIFY_RPC_URL): owner at the snapshot differs'],
            [answering, otherSnapshot, 'provider #2 (POLYGON_VERIFY_RPC_URL) disagrees with provider #1 (POLYGON_RPC_URL)'],
        ]) {
            const failed = await run(first, second);
            assert.equal(failed.status, 1, message);
            assert.equal(failed.stdout, '', message);
            // The first line; after a disagreement, the differing fields of the two results follow.
            assert.equal(failed.stderr.split('\n')[0], `Deployment verification failed: ${message}`);
            assert.ok(!failed.stderr.includes(secret) && !failed.stderr.includes('127.0.0.1'), message);
        }
    } finally {
        await Promise.all(servers.map((server) => server.close()));
    }
});
for (const [name, mutate, options = {}] of [
    ['missing receipt (simulation file is insufficient)', (s) => { s.receipt = null; }],
    ['failed deployment', (s) => { s.receipt.status = '0x0'; }],
    ['unfinalized deployment', (s) => { s.finalized = '0x9'; }],
    ['wrong chain', (s) => { s.chain = '0x1'; }],
    ['wrong address', (s) => { s.receipt.contractAddress = from; }],
    ['noncanonical receipt', (s) => { s.receipt.blockHash = hash; }],
    ['wrong constructor', (s) => { s.tx.input += '00'; }],
    ['other constructor tokens (modes)', (s) => {
        const tokens = TOKENS.map((t, i) => ({ ...t, config: { ...t.config, allowance: i !== 0 } }));
        s.tx.input = encodeDeployData({ abi: artifacts.contract.abi, bytecode: artifacts.contract.bytecode.object, args: [owner, tokens] });
    }],
    ['zero initial owner', (s) => { s.tx.input = expectedCreation(artifacts, zero); }],
    ['factory deployment', (s) => { s.tx.to = from; }],
    ['different runtime', (s) => { s.runtime += '00'; }],
    ['a mode added after the deployment (setTokenConfig)', (s) => { s.configs[0].metaTxApprove = true; }],
    ['incorrect modes', (s) => { s.configs[0].permit = false; }],
    ['a removed token', (s) => { s.configs[0] = { permit: false, metaTxApprove: false, allowance: false }; }],
    ['incorrect domain', (s) => { s.domain = hash; }],
    ['another owner at the snapshot', (s) => { s.owner = from; }],
    ['a pending ownership transfer', (s) => { s.pendingOwner = from; }],
    ['an initial owner other than GASLESS_TRANSFER_OWNER', () => undefined, { expectedOwner: from }],
    ['a deployment of this build owned by someone else', (s) => { s.tx.input = expectedCreation(artifacts, from); s.owner = from; }],
]) test(`rejects ${name}`, async () => assert.rejects(verifyDeployment({ ...fixture(mutate), ...options })));
test('rejects a changed immutable rather than masking it', async () => {
    const start = Object.values(artifacts.contract.deployedBytecode.immutableReferences)[0][0].start * 2 + 2;
    await assert.rejects(verifyDeployment(fixture((s) => { s.runtime = s.runtime.slice(0, start) + (s.runtime.slice(start, start + 2) === 'ff' ? '00' : 'ff') + s.runtime.slice(start + 2); })));
});
test("the verifier's tokenConfig and constructor tuples are this build's: three modes", () => {
    const components = (params) => params.components.map((c) => [c.name, c.type]);
    const modes = [['permit', 'bool'], ['metaTxApprove', 'bool'], ['allowance', 'bool']];
    const tokenConfig = artifacts.contract.abi.find((item) => item.type === 'function' && item.name === 'tokenConfig');
    assert.deepEqual(components(tokenConfig.outputs[0]), modes);
    const constructor = artifacts.contract.abi.find((item) => item.type === 'constructor');
    assert.deepEqual(components(constructor.inputs[1].components.find((c) => c.name === 'config')), modes);
    assert.deepEqual(TOKENS.map((t) => Object.keys(t.config)), [modes.map(([name]) => name), modes.map(([name]) => name)]);
});
test('unknown immutable IDs fail closed', () => {
    const other = structuredClone(artifacts);
    other.contract.deployedBytecode.immutableReferences['999999999'] = [{ start: 0, length: 32 }];
    assert.throws(() => expectedRuntime(other, address), /unknown immutable/);
});
test('refuses transaction-sending RPC methods before network access', async () => {
    await assert.rejects(readOnlyRpc('http://127.0.0.1:1')('eth_sendRawTransaction', ['0x']), /not read-only/);
});
test('rejects snapshot hash changing during reads', async () => {
    const f = fixture(); const original = f.rpc; let count = 0;
    f.rpc = async (method, params) => {
        const result = await original(method, params);
        if (method === 'eth_getBlockByNumber' && params[0] === '0x14' && ++count > 1) result.hash = hash;
        return result;
    };
    await assert.rejects(verifyDeployment(f), /snapshot changed/);
});
