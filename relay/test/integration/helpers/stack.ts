// Local chain for the integration tests, inside the toolchain container: a plain anvil (chain 31337)
// on 127.0.0.1, the real contracts deployed by contracts/script/DeployLocalStack.s.sol (MockUSDC,
// MockUSDT0, GaslessTransfer), and viem clients. No port leaves the container.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createPublicClient,
    createTestClient,
    createWalletClient,
    http,
    parseAbi,
    toHex,
    type Abi,
    type Address,
    type Hash,
    type Hex,
    type PrivateKeyAccount,
    type PublicClient,
    type TestClient,
    type TransactionReceipt,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { pinsFromDeployment, usdcAbi, type ChainPins } from '@nimiq/gasless-sdk/core';
import { parseDeployment, type Deployment } from '../../../src/config.js';
import { addressInUse, freePort } from '../../helpers/ports.js';

export const RELAY_DIR = fileURLToPath(new URL('../../..', import.meta.url));
export const CONTRACTS_DIR = fileURLToPath(new URL('../../../../contracts', import.meta.url));
export const CHAIN_ID = 31_337;

/** anvil's default mnemonic: every key derived from it is a well-known test key. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

/**
 * Accounts of the default mnemonic (anvil runs with 20). DeployLocalStack deploys from 0 (which also
 * administers the mock tokens) and mints 1,000,000 USDC and USDT0 to 0–9; 10–19 only hold ETH.
 */
export const ADMIN_INDEX = 0;
export const RELAY_INDEX = 10;

export function anvilKey(index: number): Hex {
    const privateKey = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
    if (!privateKey) throw new Error('no private key');
    return toHex(privateKey);
}

export function anvilAccount(index: number): PrivateKeyAccount {
    return privateKeyToAccount(anvilKey(index));
}

/** Test-only ABI of the mocks' admin functions and plain ERC-20 calls (not part of the SDK ABIs). */
export const mockTokenAbi = parseAbi([
    'function transfer(address to, uint256 value) returns (bool)',
    'function approve(address spender, uint256 value) returns (bool)',
    'function pause()',
    'function unpause()',
    'function blacklist(address account)',
    'function unBlacklist(address account)',
    'function addToBlockedList(address user)',
    'function removeFromBlockedList(address user)',
    'function changeName(string newName)',
]);

/** A port that was free a moment ago; callers retry with a new one: PORT_ATTEMPTS starts. */
export { freePort };

/** Starts on a port from freePort, each with a new port, before a taken port fails the test. */
export const PORT_ATTEMPTS = 3;

/** True for a listen error of a port that is taken (EADDRINUSE). */
export { addressInUse };

/**
 * A synchronous child blocks the event loop, so no test or hook timeout can fire while it runs: a stalled forge
 * would hang the whole run. The child is killed after RUN_TIMEOUT_MS and the start fails with its output.
 */
const RUN_TIMEOUT_MS = 120_000;

function run(file: string, args: readonly string[], cwd: string): string {
    try {
        return execFileSync(file, args, { cwd, stdio: 'pipe', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' }).toString();
    } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer; signal?: string | null };
        const killed = e.signal === 'SIGKILL' ? ` (killed after ${RUN_TIMEOUT_MS} ms)` : '';
        throw new Error(`${file} ${args.join(' ')} failed${killed}:\n${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`);
    }
}

export interface ContractWrite {
    readonly address: Address;
    readonly abi: Abi;
    readonly functionName: string;
    readonly args?: readonly unknown[];
}

export interface Stack {
    readonly rpcUrl: string;
    readonly dir: string;
    /** A copy of contracts/deployments/31337.json in `dir` (later deploys cannot change it). */
    readonly deploymentFile: string;
    readonly deploymentJson: Record<string, unknown>;
    readonly deployment: Deployment;
    readonly usdc: Address;
    readonly usdt0: Address;
    readonly transfer: Address;
    readonly publicClient: PublicClient;
    readonly testClient: TestClient<'anvil'>;
    /** SDK pins from the deployment file, with the relay address(es) clients may sign for. */
    pins(relays: readonly Address[]): ChainPins;
    /** Sends a transaction from `account` and waits for its receipt (mining a block if automine is off). */
    send(account: PrivateKeyAccount, call: ContractWrite): Promise<TransactionReceipt>;
    setAutomine(enabled: boolean): Promise<void>;
    mine(blocks?: number): Promise<void>;
    balanceOf(token: Address, owner: Address): Promise<bigint>;
    allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
    latestBlock(): Promise<{ number: bigint; timestamp: bigint; baseFeePerGas: bigint }>;
    /** Kills anvil (the chain becomes unreachable). */
    stopChain(): Promise<void>;
    stop(): Promise<void>;
}

/**
 * anvil on a port from freePort. anvil exits when it cannot bind the port (taken since freePort): that start is
 * repeated on a new port, PORT_ATTEMPTS starts in all.
 */
async function startAnvil(): Promise<{ child: ChildProcess; rpcUrl: string; exited: Promise<unknown> }> {
    for (let start = 1; ; start++) {
        const port = await freePort();
        const child: ChildProcess = spawn(
            'anvil',
            ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(CHAIN_ID), '--accounts', '20', '--silent'],
            { stdio: 'ignore' },
        );
        const exited = once(child, 'exit').catch(() => undefined);
        const rpcUrl = `http://127.0.0.1:${port}`;
        for (let attempt = 0; child.exitCode === null; attempt++) {
            try {
                const res = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
                });
                if (res.ok) return { child, rpcUrl, exited };
            } catch {
                // not listening yet
            }
            if (attempt > 200) {
                child.kill('SIGKILL');
                throw new Error('anvil did not start');
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (start >= PORT_ATTEMPTS) throw new Error(`anvil exited with code ${child.exitCode}`);
    }
}

/** Starts anvil and deploys the local stack with `forge script` (the contracts were built in globalSetup). */
export async function startStack(): Promise<Stack> {
    const { child, rpcUrl, exited } = await startAnvil();

    const admin = anvilAccount(ADMIN_INDEX);
    run('forge', ['script', 'script/DeployLocalStack.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', admin.address], CONTRACTS_DIR);
    const dir = mkdtempSync(join(tmpdir(), 'relay-integration-'));
    const deploymentFile = join(dir, 'deployment.json');
    copyFileSync(join(CONTRACTS_DIR, 'deployments', `${CHAIN_ID}.json`), deploymentFile);
    copyFileSync(join(CONTRACTS_DIR, 'deployments', `${CHAIN_ID}.feed`), join(dir, 'price-feed'));
    const deploymentJson = JSON.parse(readFileSync(deploymentFile, 'utf8')) as Record<string, unknown>;
    const deployment = parseDeployment(deploymentJson);
    const tokenAddress = (symbol: 'USDC' | 'USDT0') => {
        const token = deployment.tokens.find((t) => t.symbol === symbol);
        if (!token) throw new Error(`deployment has no ${symbol}`);
        return token.address;
    };

    const transport = http(rpcUrl);
    const publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient;
    const testClient = createTestClient({ mode: 'anvil', chain: foundry, transport });
    let automine = true;

    const stack: Stack = {
        rpcUrl,
        dir,
        deploymentFile,
        deploymentJson,
        deployment,
        usdc: tokenAddress('USDC'),
        usdt0: tokenAddress('USDT0'),
        transfer: deployment.gaslessTransfer,
        publicClient,
        testClient,
        pins: (relays) => pinsFromDeployment(deploymentJson, { relays }),
        async send(account, call) {
            const wallet = createWalletClient({ account, chain: foundry, transport });
            const hash: Hash = await wallet.writeContract(call as never);
            if (!automine) await testClient.mine({ blocks: 1 });
            const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
            if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted`);
            return receipt;
        },
        async setAutomine(enabled) {
            await testClient.setAutomine(enabled);
            automine = enabled;
        },
        mine: (blocks = 1) => testClient.mine({ blocks }),
        balanceOf: (token, owner) => publicClient.readContract({ address: token, abi: usdcAbi, functionName: 'balanceOf', args: [owner] }),
        allowance: (token, owner, spender) =>
            publicClient.readContract({ address: token, abi: usdcAbi, functionName: 'allowance', args: [owner, spender] }),
        async latestBlock() {
            const block = await publicClient.getBlock({ blockTag: 'latest' });
            return { number: block.number, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas ?? 0n };
        },
        async stopChain() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                await exited;
            }
        },
        async stop() {
            await stack.stopChain();
            rmSync(dir, { recursive: true, force: true });
        },
    };
    return stack;
}
