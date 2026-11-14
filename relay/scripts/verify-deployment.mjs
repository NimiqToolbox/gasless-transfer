// Read-only, fail-closed attestation for a direct Polygon deployment of this exact build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
    decodeAbiParameters,
    decodeFunctionResult,
    encodeDeployData,
    encodeFunctionData,
    getAddress,
    getContractAddress,
    hashDomain,
    keccak256,
    parseAbi,
    stringToHex,
    toHex,
} from 'viem';

/** contracts/script/DeploymentWriter.sol `_stablecoinTokens`: the constructor's TokenInit[] of DeployGaslessTransfer. */
export const TOKENS = [
    { token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', config: { permit: true, metaTxApprove: false, allowance: true } },
    { token: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', config: { permit: true, metaTxApprove: true, allowance: true } },
];
const DOMAINS = [
    '0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca',
    '0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05',
];
const NAME = 'Nimiq Gasless Transfer';
const VERSION = '3';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const abi = parseAbi([
    'function DOMAIN_SEPARATOR() view returns (bytes32)',
    'function decimals() view returns (uint8)',
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function tokenConfig(address) view returns ((bool permit, bool metaTxApprove, bool allowance))',
]);
const same = (a, b, label) => assert.ok(typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(), label);
const shortString = (s) => `0x${Buffer.from(s).toString('hex').padEnd(62, '0')}${Buffer.byteLength(s).toString(16).padStart(2, '0')}`;
const transferDomain = (address) =>
    hashDomain({
        types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] },
        domain: { name: NAME, version: VERSION, chainId: 137, verifyingContract: address },
    });

export function loadArtifacts(outDir) {
    const read = (file) => JSON.parse(readFileSync(resolve(outDir, file), 'utf8'));
    return {
        contract: read('GaslessTransfer.sol/GaslessTransfer.json'),
        asts: [read('GaslessBase.sol/GaslessBase.json').ast, read('EIP712.sol/EIP712.json').ast],
    };
}

/** Fill every compiler-declared immutable with its independently expected value; never mask it. */
export function expectedRuntime(artifacts, address) {
    const names = new Map();
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') names.set(String(node.id), node.name);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    artifacts.asts.forEach(visit);
    // GaslessTransfer has only EIP712's immutables: the owner and the token configuration are storage.
    const values = {
        _cachedThis: toHex(BigInt(address), { size: 32 }),
        _cachedChainId: toHex(137n, { size: 32 }),
        _cachedDomainSeparator: transferDomain(address),
        _hashedName: keccak256(stringToHex(NAME)),
        _hashedVersion: keccak256(stringToHex(VERSION)),
        _name: shortString(NAME),
        _version: shortString(VERSION),
    };
    const { object, immutableReferences } = artifacts.contract.deployedBytecode;
    assert.match(object, /^0x(?:[a-fA-F0-9]{2})+$/, 'unlinked runtime');
    const bytes = Buffer.from(object.slice(2), 'hex');
    const written = new Set();
    const seen = new Set();
    for (const [id, refs] of Object.entries(immutableReferences)) {
        const name = names.get(id);
        assert.ok(name && Object.hasOwn(values, name), `unknown immutable ${id}; rebuild with forge build --ast`);
        seen.add(name);
        for (const { start, length } of refs) {
            assert.ok(Number.isSafeInteger(start) && start >= 0 && length === 32 && start + length <= bytes.length, 'invalid immutable range');
            for (let i = start; i < start + length; i++) {
                assert.ok(!written.has(i), 'overlapping immutable ranges');
                written.add(i);
            }
            Buffer.from(values[name].slice(2), 'hex').copy(bytes, start);
        }
    }
    assert.deepEqual([...seen].sort(), Object.keys(values).sort(), 'unexpected immutable set');
    return `0x${bytes.toString('hex')}`;
}

/** The exact creation input: this build's bytecode and the constructor arguments (initialOwner, TOKENS). */
export function expectedCreation(artifacts, initialOwner) {
    return encodeDeployData({ abi: artifacts.contract.abi, bytecode: artifacts.contract.bytecode.object, args: [initialOwner, TOKENS] });
}

/**
 * The initial owner a creation input passes to the constructor, if the input starts with this build's creation
 * bytecode; the full input is compared with `expectedCreation` afterwards, so the token arguments must match exactly.
 */
export function creationOwner(artifacts, input) {
    const bytecode = artifacts.contract.bytecode.object.toLowerCase();
    assert.ok(typeof input === 'string' && input.toLowerCase().startsWith(bytecode), 'creation bytecode or constructor arguments differ');
    const constructor = artifacts.contract.abi.find((item) => item.type === 'constructor');
    assert.ok(constructor, 'artifact has no constructor');
    let owner;
    try {
        [owner] = decodeAbiParameters(constructor.inputs, `0x${input.slice(bytecode.length)}`);
    } catch {
        throw new assert.AssertionError({ message: 'creation bytecode or constructor arguments differ' });
    }
    assert.ok(typeof owner === 'string' && owner !== ZERO_ADDRESS, 'zero initial owner');
    return getAddress(owner);
}

const READ_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getCode', 'eth_getBalance', 'eth_estimateGas', 'eth_call']);
export function readOnlyRpc(url) {
    const endpoint = new URL(url);
    assert.ok(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)), 'HTTPS or loopback RPC required');
    let id = 0;
    return async (method, params) => {
        assert.ok(READ_METHODS.has(method), 'RPC method is not read-only');
        const requestId = ++id;
        let response;
        try {
            response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(60_000) });
        } catch { throw new Error(`RPC transport failed for ${method}`); }
        assert.ok(response.ok, `RPC HTTP ${response.status} for ${method}`);
        // Never print provider error bodies: they can echo credentials in the endpoint URL. The message of a JSON syntax
        // error quotes the body.
        let body;
        try {
            body = await response.json();
        } catch { throw new Error(`RPC response is not JSON for ${method}`); }
        assert.equal(body.id, requestId, 'RPC response ID mismatch');
        assert.ok(!body.error && Object.hasOwn(body, 'result'), `RPC rejected ${method}`);
        return body.result;
    };
}

/**
 * `expectedOwner` (GASLESS_TRANSFER_OWNER, required) must be the constructor's initial owner: the creation bytes are
 * rebuilt with it, so a deployment owned by anyone else fails. The owner at the snapshot (`expectedCurrentOwner`,
 * default the initial owner) must hold the contract, with no ownership transfer pending: the owner can change every
 * token configuration (setTokenConfig). `deployBlock` (DEPLOY_BLOCK), the deployment record's, must be at or below the
 * deployment's block: the relay and the SDK read no state below it when they look for what used an intent nonce.
 */
export async function verifyDeployment({ rpc, address, transactionHash, artifacts, blockNumber, expectedOwner, expectedCurrentOwner, deployBlock }) {
    assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    assert.match(transactionHash, /^0x[0-9a-fA-F]{64}$/);
    assert.ok(typeof expectedOwner === 'string' && /^0x[0-9a-fA-F]{40}$/.test(expectedOwner), 'the expected initial owner (GASLESS_TRANSFER_OWNER) is required');
    if (deployBlock !== undefined) assert.match(String(deployBlock), /^(0|[1-9][0-9]*)$/, 'deployBlock (DEPLOY_BLOCK): expected a decimal block number');
    assert.equal(BigInt(await rpc('eth_chainId', [])), 137n, 'wrong chain');
    const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
    assert.ok(finalized?.hash && finalized?.number, 'finalized block unavailable');
    const tag = blockNumber === undefined ? finalized.number : toHex(BigInt(blockNumber));
    assert.ok(BigInt(tag) <= BigInt(finalized.number), 'requested block is not finalized');
    const snapshot = await rpc('eth_getBlockByNumber', [tag, false]);
    assert.ok(snapshot?.hash && BigInt(snapshot.number) === BigInt(tag), 'snapshot unavailable');
    const receipt = await rpc('eth_getTransactionReceipt', [transactionHash]);
    assert.ok(receipt, 'deployment receipt unavailable');
    same(receipt.transactionHash, transactionHash, 'receipt transaction mismatch');
    assert.equal(BigInt(receipt.status), 1n, 'deployment failed');
    assert.ok(BigInt(receipt.blockNumber) <= BigInt(tag), 'deployment not finalized at snapshot');
    same(receipt.contractAddress, address, 'receipt contract mismatch');
    assert.ok(deployBlock === undefined || BigInt(deployBlock) <= BigInt(receipt.blockNumber), 'deployBlock is above the deployment block');
    const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    same(block?.hash, receipt.blockHash, 'deployment receipt is not canonical');
    same(block?.transactions?.[Number(BigInt(receipt.transactionIndex))], transactionHash, 'transaction absent from canonical block');
    const tx = await rpc('eth_getTransactionByHash', [transactionHash]);
    assert.ok(tx && tx.to === null, 'only direct contract creation is supported');
    same(tx.hash, transactionHash, 'transaction hash mismatch');
    same(tx.blockHash, receipt.blockHash, 'transaction/receipt block mismatch');
    assert.equal(BigInt(tx.chainId), 137n, 'transaction chain mismatch');
    assert.equal(BigInt(tx.value), 0n, 'unexpected deployment value');
    same(getContractAddress({ from: tx.from, nonce: BigInt(tx.nonce) }), address, 'CREATE address mismatch');
    const initialOwner = creationOwner(artifacts, tx.input);
    same(initialOwner, expectedOwner, 'initial owner differs from GASLESS_TRANSFER_OWNER');
    const creation = expectedCreation(artifacts, initialOwner);
    same(tx.input, creation, 'creation bytecode or constructor arguments differ');
    const runtime = expectedRuntime(artifacts, address);
    for (const at of new Set([receipt.blockNumber, tag])) same(await rpc('eth_getCode', [address, at]), runtime, 'runtime differs, including immutables');
    const read = async (target, functionName, args = []) => decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to: target, data: encodeFunctionData({ abi, functionName, args }) }, tag]) });
    const domain = transferDomain(address);
    same(await read(address, 'DOMAIN_SEPARATOR'), domain, 'transfer domain mismatch');
    const owner = await read(address, 'owner');
    same(owner, expectedCurrentOwner ?? initialOwner, 'owner at the snapshot differs');
    same(await read(address, 'pendingOwner'), ZERO_ADDRESS, 'ownership transfer pending');
    for (const [index, token] of TOKENS.entries()) {
        assert.notEqual(await rpc('eth_getCode', [token.token, tag]), '0x', 'token has no code');
        // The owner can change it after the deployment: the configuration at the snapshot must still be the deployed one.
        assert.deepEqual(await read(address, 'tokenConfig', [token.token]), token.config, 'token configuration mismatch (modes)');
        assert.equal(await read(token.token, 'decimals'), 6, 'token decimals mismatch');
        same(await read(token.token, 'DOMAIN_SEPARATOR'), DOMAINS[index], 'token domain mismatch');
    }
    // Number-pinned reads are bracketed by canonical-hash checks; provider truth remains an assumption.
    same((await rpc('eth_getBlockByNumber', [tag, false]))?.hash, snapshot.hash, 'snapshot changed during verification');
    same((await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]))?.hash, receipt.blockHash, 'deployment block changed during verification');
    return {
        verified: true, chainId: 137, version: VERSION, address, transactionHash, deployer: tx.from,
        initialOwner, owner: getAddress(owner),
        deploymentBlock: BigInt(receipt.blockNumber).toString(), deploymentBlockHash: receipt.blockHash,
        ...(deployBlock === undefined ? {} : { deployBlock: String(deployBlock) }),
        snapshotBlock: BigInt(tag).toString(), snapshotBlockHash: snapshot.hash,
        runtimeKeccak256: keccak256(runtime), creationKeccak256: keccak256(creation),
        artifactSha256: createHash('sha256').update(JSON.stringify(artifacts.contract)).digest('hex'),
        tokens: TOKENS.map(({ token, config }) => ({ token, config: { ...config } })),
        domainSeparator: domain,
    };
}

const optionalAddress = (name) => {
    const value = process.env[name];
    if (value === undefined || value === '') return undefined;
    assert.match(value, /^0x[0-9a-fA-F]{40}$/, `${name}: expected an address`);
    return value;
};

/** How a message names a provider: by its position and variable, never by its URL, which can carry an API key. */
const PROVIDERS = ['provider #1 (POLYGON_RPC_URL)', 'provider #2 (POLYGON_VERIFY_RPC_URL)'];

/** The result of `verify()` for one provider; a failure names that provider, whether it answered wrongly or not at all. */
async function withProvider(provider, verify) {
    try {
        return await verify();
    } catch (error) {
        throw new Error(`${provider}: ${error.message}`, { cause: error });
    }
}

async function main() {
    const [address, transactionHash, outDir = '../contracts/out', blockNumber] = process.argv.slice(2);
    const usage = 'usage: POLYGON_RPC_URL=... GASLESS_TRANSFER_OWNER=... [GASLESS_TRANSFER_CURRENT_OWNER=...] [DEPLOY_BLOCK=...] node scripts/verify-deployment.mjs ADDRESS TX_HASH [OUT_DIR] [BLOCK_NUMBER]';
    assert.ok(address && transactionHash && process.env.POLYGON_RPC_URL, usage);
    // Fail closed before any network access: without it, any owner would pass.
    const owners = { expectedOwner: optionalAddress('GASLESS_TRANSFER_OWNER'), expectedCurrentOwner: optionalAddress('GASLESS_TRANSFER_CURRENT_OWNER') };
    assert.ok(owners.expectedOwner !== undefined, `GASLESS_TRANSFER_OWNER is required: the initial owner the deployment must have. ${usage}`);
    const deployBlock = process.env.DEPLOY_BLOCK || undefined;
    const artifacts = loadArtifacts(outDir);
    const first = await withProvider(PROVIDERS[0], () => verifyDeployment({ rpc: readOnlyRpc(process.env.POLYGON_RPC_URL), address, transactionHash, artifacts, blockNumber, deployBlock, ...owners }));
    const secondUrl = process.env.POLYGON_VERIFY_RPC_URL;
    if (secondUrl) {
        assert.notEqual(secondUrl, process.env.POLYGON_RPC_URL, 'second provider must be distinct');
        const second = await withProvider(PROVIDERS[1], () => verifyDeployment({ rpc: readOnlyRpc(secondUrl), address, transactionHash, artifacts, blockNumber: first.snapshotBlock, deployBlock, ...owners }));
        assert.deepEqual(second, first, `${PROVIDERS[1]} disagrees with ${PROVIDERS[0]}`);
    }
    console.log(JSON.stringify({ ...first, providerCount: secondUrl ? 2 : 1 }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
    console.error(`Deployment verification failed: ${error.message}`);
    process.exitCode = 1;
});
