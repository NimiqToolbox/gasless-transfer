// A local chain with the production contract, for tests that must not depend on the TransferHarness test double:
// anvil (chain id 137) with the SDK's USDC and USDT0 doubles at the real token addresses and the PRODUCTION
// GaslessTransfer (contracts/src, compiled here). Only available inside the toolchain container (anvil, forge and
// the vendored OpenZeppelin); outside of it the tests using it are skipped.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createPublicClient,
    createTestClient,
    createWalletClient,
    defineChain,
    getAddress,
    http,
    type Abi,
    type Address,
    type Chain,
    type Hex,
    type PublicClient,
    type TestClient,
    type TransactionReceipt,
    type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../src/core/abi.js';
import { POLYGON_TOKENS } from '../../src/core/constants.js';
import { definePins, type ChainPins } from '../../src/core/pins.js';
import type { SubmitTransferBody } from '../../src/relay/types.js';
import { compileFixtures, relayTransferArgs, startAnvil, transferConstructorArgs, type Anvil, type Artifact, type FixtureName } from './anvil.js';
import { ADDR, KEYS, USDC, USDT0 } from './fixtures.js';

export { chainToolsAvailable, relayTransferArgs } from './anvil.js';

const POLL_MS = 25;

/** The production GaslessTransfer from contracts/src (tests and scripts are not compiled). */
function compileProductionContract(): Artifact {
    const contractsRoot = fileURLToPath(new URL('../../../contracts', import.meta.url));
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'sdk-production-'));
    try {
        execFileSync(
            'forge',
            ['build', '--root', contractsRoot, '--out', path.join(tmp, 'out'), '--cache-path', path.join(tmp, 'cache'), '--skip', 'test', '--skip', 'script'],
            { stdio: 'pipe' },
        );
        const json = JSON.parse(readFileSync(path.join(tmp, 'out', 'GaslessTransfer.sol', 'GaslessTransfer.json'), 'utf8')) as {
            abi: Abi;
            bytecode: { object: Hex };
            deployedBytecode: { object: Hex };
        };
        return { abi: json.abi, bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

export interface ProductionChain {
    readonly anvil: Anvil;
    readonly chain: Chain;
    readonly publicClient: PublicClient<Transport, Chain>;
    readonly testClient: TestClient<'anvil', Transport, Chain>;
    /** The production GaslessTransfer. */
    readonly transfer: Address;
    /** Block of its deployment. */
    readonly deployBlock: bigint;
    /** Pins for it: the relay ADDR.relay, the Polygon token set, deployBlock as deployed. */
    readonly pins: ChainPins;
    /** The compiled test fixtures (sdk/test/fixtures/solidity). */
    readonly fixtures: Record<FixtureName, Artifact>;
    send(key: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt>;
    /** What a relay does with a submit body: relayTransfer from the relay account (ADDR.relay). */
    relayExecute(body: SubmitTransferBody): Promise<TransactionReceipt>;
    /** The timestamp of the latest block. */
    now(): Promise<number>;
    balanceOf(token: Address, account: Address): Promise<bigint>;
    stop(): Promise<void>;
}

/** Starts anvil, installs the token doubles, deploys the production contract and funds ADDR.user and ADDR.other. */
export async function startProductionChain(): Promise<ProductionChain> {
    const fixtures: Record<FixtureName, Artifact> = compileFixtures();
    const production = compileProductionContract();
    const anvil = await startAnvil(137);
    const chain = defineChain({ id: 137, name: 'anvil-137', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
    const publicClient = createPublicClient({ chain, transport: http(anvil.url), pollingInterval: POLL_MS });
    const testClient = createTestClient({ chain, mode: 'anvil', transport: http(anvil.url), pollingInterval: POLL_MS });
    const wallet = (key: Hex) => createWalletClient({ chain, transport: http(anvil.url), account: privateKeyToAccount(key) });

    async function send(key: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
        const hash = await wallet(key).writeContract({ address, abi, functionName, args } as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
        return receipt;
    }

    await testClient.setCode({ address: USDC, bytecode: fixtures.MockUSDC.deployedBytecode });
    await testClient.setCode({ address: USDT0, bytecode: fixtures.MockUSDT0.deployedBytecode });
    await send(KEYS.deployer, USDC, fixtures.MockUSDC.abi, 'initialize', ['USD Coin']);
    await send(KEYS.deployer, USDT0, fixtures.MockUSDT0.abi, 'initialize', ['USDT0']);
    const deployHash = await wallet(KEYS.deployer).deployContract({
        abi: production.abi,
        bytecode: production.bytecode,
        args: transferConstructorArgs(),
    } as never);
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const transfer = getAddress(deployReceipt.contractAddress as Address);
    for (const token of [USDC, USDT0]) {
        for (const holder of [ADDR.user, ADDR.other]) await send(KEYS.deployer, token, fixtures.MockUSDC.abi, 'mint', [holder, 1_000_000_000n]);
    }
    const pins = definePins({
        chainId: 137,
        transfer,
        relays: [ADDR.relay],
        tokens: POLYGON_TOKENS,
        deployBlock: Number(deployReceipt.blockNumber),
    });

    return {
        anvil,
        chain,
        publicClient,
        testClient,
        transfer,
        deployBlock: deployReceipt.blockNumber,
        pins,
        fixtures,
        send,
        relayExecute: (body) => send(KEYS.relay, transfer, gaslessTransferAbi, 'relayTransfer', relayTransferArgs(body)),
        now: async () => Number((await publicClient.getBlock()).timestamp),
        balanceOf: (token, account) => publicClient.readContract({ address: token, abi: usdcAbi, functionName: 'balanceOf', args: [account] }),
        stop: () => anvil.stop(),
    };
}
