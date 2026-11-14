// An anvil fork of Polygon PoS (real USDC FiatTokenV2_2 and USDT0) at a given block, with GaslessTransfer
// deployed by contracts/script/DeployGaslessTransfer.s.sol (the mainnet script, which also checks the token domains),
// shaped like the integration Stack so the relay (src/server.ts) and the SDK helpers run unchanged against the real
// tokens. Opt-in only (VER_FORK=true and POLYGON_RPC_URL); anvil reads the fork state lazily, through ForkUpstream
// (which retries a stalled or rate-limited read), and caches it under ~/.foundry/cache/rpc. Tokens are funded through
// their real admin roles (impersonated), never with storage writes.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    TransactionReceiptNotFoundError,
    createPublicClient,
    createTestClient,
    createWalletClient,
    defineChain,
    http,
    keccak256,
    stringToHex,
    parseAbi,
    parseEther,
    type Abi,
    type Address,
    type Chain,
    type Hash,
    type PublicClient,
    type TestClient,
    type TransactionReceipt,
} from 'viem';
import { pinsFromDeployment, usdcAbi } from '@nimiq/gasless-sdk/core';
import { parseDeployment } from '../../../src/config.js';
import { CONTRACTS_DIR, anvilAccount, freePort, type ContractWrite, type Stack } from '../../integration/helpers/stack.js';
import { ForkUpstream, type ForkUpstreamOptions, type ForkUpstreamStats } from './forkUpstream.js';

export const FORK_BLOCK = 94_421_000n;
export const POLYGON_USDC: Address = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const POLYGON_USDT0: Address = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';

export function forkEnabled(): boolean {
    return process.env.VER_FORK === 'true' && (process.env.POLYGON_RPC_URL ?? '') !== '';
}

/** Blocks below the fork RPC's head that `recentForkBlock` stays (about 7 minutes), so the block is final. */
export const RECENT_FORK_BLOCK_DEPTH = 200n;

/**
 * FORK_BLOCK if set, else the fork RPC's head minus RECENT_FORK_BLOCK_DEPTH: a fork whose POL/USD round the relay
 * still accepts for quotes (at most 3600 s older than the wall clock). A fixed block goes stale within the hour.
 */
export async function recentForkBlock(): Promise<bigint> {
    if (process.env.FORK_BLOCK) return BigInt(process.env.FORK_BLOCK);
    // A stalled request is retried after 20 s (viem retries a timeout), not after FORK_RPC_TIMEOUT_MS.
    const remote = createPublicClient({ transport: http(process.env.POLYGON_RPC_URL!, { timeout: FORK_UPSTREAM_ATTEMPT_MS, retryCount: 5 }) });
    return (await remote.getBlockNumber()) - RECENT_FORK_BLOCK_DEPTH;
}

/** ForkUpstream's timeout of one attempt (the public RPC answers within about a second). */
const FORK_UPSTREAM_ATTEMPT_MS = 20_000;

/**
 * Fork settings for a slow or rate-limited public RPC. anvil fetches fork state lazily, so any request (including
 * mining a block) can wait for the remote RPC. anvil reads it through ForkUpstream, which retries a read that gets no
 * answer within 20 s or a rate-limit answer for up to 90 s; anvil's own fork timeout (2 minutes) only ends a request
 * that ForkUpstream gave up on. anvil retries HTTP 429 itself (10 times, backoff from 3 s) and throttles its requests
 * to 150 compute units per second. Nothing here changes what the tests assert, only how long they wait for the fork.
 */
export const ANVIL_FORK_OPTIONS: readonly string[] = [
    '--retries', '10',
    '--fork-retry-backoff', '3000',
    '--timeout', '120000',
    '--compute-units-per-second', '150',
];
/** Timeout of one JSON-RPC request of the tests (and of the relay under test) to the local fork. */
export const FORK_RPC_TIMEOUT_MS = 120_000;
/** How long the tests wait for a receipt on the fork. */
export const FORK_RECEIPT_TIMEOUT_MS = 600_000;
/** How often receiptOf asks the fork for a receipt. */
const RECEIPT_POLL_MS = 100;

/** `work`, or an error once `ms` have passed. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(what)), Math.max(0, ms));
    });
    try {
        return await Promise.race([work, late]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The receipt of `hash` on the fork: eth_getTransactionReceipt every RECEIPT_POLL_MS until the transaction is mined,
 * for at most `timeoutMs` in all (FORK_RECEIPT_TIMEOUT_MS, the tests' wait for a receipt). viem's
 * waitForTransactionReceipt looks again only when a new block appears. Under anvil's automine the transaction is mined
 * in a block of its own, and on a fork that can take a while (mining fetches remote state): if its first look comes
 * before that block, no further block follows, and the wait runs into its timeout although the transaction is mined.
 */
export async function receiptOf(publicClient: PublicClient, hash: Hash, timeoutMs = FORK_RECEIPT_TIMEOUT_MS): Promise<TransactionReceipt> {
    const deadline = Date.now() + timeoutMs;
    const timedOut = `no receipt for ${hash} within ${timeoutMs / 1000} s`;
    for (;;) {
        try {
            return await within(publicClient.getTransactionReceipt({ hash }), deadline - Date.now(), timedOut);
        } catch (err) {
            // Not mined yet; any other error (or the deadline) ends the wait.
            if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
        }
        if (Date.now() >= deadline) throw new Error(timedOut);
        await new Promise((resolve) => setTimeout(resolve, Math.min(RECEIPT_POLL_MS, deadline - Date.now())));
    }
}
/** How long anvil may take to fetch the fork block and start listening, per start attempt. */
const FORK_START_TIMEOUT_MS = 300_000;
const FORK_START_ATTEMPTS = 3;

async function answersChainId(rpcUrl: string): Promise<boolean> {
    return fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(10_000),
    }).then(
        (res) => res.ok,
        () => false,
    );
}

export interface AnvilFork {
    readonly child: ChildProcess;
    readonly rpcUrl: string;
    /** The proxy anvil forks (stop it after anvil). */
    readonly upstream: ForkUpstream;
}

/**
 * Starts anvil forking `forkRpcUrl` (POLYGON_RPC_URL) through a ForkUpstream at `block` with ANVIL_FORK_OPTIONS and
 * waits until it answers. Every retry of ForkUpstream is logged. anvil exits if it cannot fetch the fork block; that
 * is retried up to FORK_START_ATTEMPTS times, 10 s apart.
 */
export async function startAnvilFork(
    block: bigint,
    extraArgs: readonly string[] = [],
    forkRpcUrl: string = process.env.POLYGON_RPC_URL!,
    upstreamOptions: ForkUpstreamOptions = {},
): Promise<AnvilFork> {
    const upstream = await new ForkUpstream(forkRpcUrl, {
        attemptTimeoutMs: FORK_UPSTREAM_ATTEMPT_MS,
        onRetry: (r) => console.warn(`fork upstream: ${r.method} attempt ${r.attempt} failed (${r.reason}) after ${r.elapsedMs} ms; retrying`),
        ...upstreamOptions,
    }).start();
    for (let attempt = 1; ; attempt++) {
        const port = await freePort();
        const child = spawn(
            'anvil',
            [
                '--fork-url', upstream.url,
                '--fork-block-number', block.toString(),
                '--host', '127.0.0.1',
                '--port', String(port),
                '--silent',
                ...ANVIL_FORK_OPTIONS,
                ...extraArgs,
            ],
            { stdio: 'ignore' },
        );
        const exited = once(child, 'exit').catch(() => undefined);
        const rpcUrl = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + FORK_START_TIMEOUT_MS;
        let failure: string | undefined;
        while (failure === undefined) {
            if (child.exitCode !== null) failure = `exited with code ${child.exitCode}`;
            else if (await answersChainId(rpcUrl)) return { child, rpcUrl, upstream };
            else if (Date.now() > deadline) failure = `did not answer within ${FORK_START_TIMEOUT_MS / 1000} s`;
            else await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        if (attempt >= FORK_START_ATTEMPTS) {
            await upstream.stop();
            throw new Error(`anvil (fork at ${block}) ${failure} (attempt ${attempt} of ${FORK_START_ATTEMPTS})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
}

export const realUsdcAbi = parseAbi([
    'function masterMinter() view returns (address)',
    'function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)',
    'function mint(address to, uint256 amount) returns (bool)',
    'function blacklister() view returns (address)',
    'function blacklist(address account)',
    'function unBlacklist(address account)',
    'function pauser() view returns (address)',
    'function pause()',
    'function unpause()',
    'function approve(address spender, uint256 value) returns (bool)',
    'function transfer(address to, uint256 value) returns (bool)',
]);

export const realUsdt0Abi = parseAbi([
    'function getRoleMember(bytes32 role, uint256 index) view returns (address)',
    'function mint(address destination, uint256 amount)',
    'function addToBlockedList(address user)',
    'function removeFromBlockedList(address user)',
    'function changeName(string name)',
    'function name() view returns (string)',
    'function approve(address spender, uint256 value) returns (bool)',
    'function transfer(address to, uint256 value) returns (bool)',
    'function executeMetaTransaction(address userAddress, bytes functionSignature, bytes32 sigR, bytes32 sigS, uint8 sigV) payable returns (bytes)',
]);

export interface ForkStack extends Stack {
    readonly chain: Chain;
    /** Sends `call` from any address (anvil impersonation, POL for gas added) and waits for the receipt (receiptOf). */
    sendAs(from: Address, call: ContractWrite, fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hash>;
    usdcAdmin(): Promise<{ masterMinter: Address; pauser: Address; blacklister: Address }>;
    usdt0Admin(): Promise<Address>;
    /** Mints real tokens to `to` through the tokens' own roles. */
    fund(token: Address, to: Address, amount: bigint): Promise<void>;
    /** Accounts that had code on Polygon at the fork block (EIP-7702 delegations of well-known test keys) and were cleared. */
    readonly clearedCode: Array<{ index: number; code: string }>;
    /** The fork's reads of the fork RPC: requests, retries by reason, give-ups. */
    readonly upstream: ForkUpstreamStats;
}

/** How long `forge script` may take on the fork (each of its requests waits at most FORK_RPC_TIMEOUT_MS). */
const FORGE_TIMEOUT_MS = 900_000;
const execFileAsync = promisify(execFile);

/**
 * Runs a tool without blocking this process: ForkUpstream, which serves anvil's reads of the fork RPC while forge
 * deploys, runs in this process (a synchronous run would leave anvil without answers until its fork timeout).
 */
async function run(file: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>> = {}): Promise<string> {
    try {
        const { stdout } = await execFileAsync(file, args, { cwd, env: { ...process.env, ...env }, timeout: FORGE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        const e = err as { stderr?: string; stdout?: string; killed?: boolean };
        throw new Error(`${file} ${args.join(' ')} failed${e.killed ? ` (stopped after ${FORGE_TIMEOUT_MS / 1000} s)` : ''}:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
}

export async function startForkStack(block = FORK_BLOCK, existingDeployment?: Record<string, unknown>): Promise<ForkStack> {
    const fork = await startAnvilFork(block, ['--accounts', '20']);
    try {
        return await forkStackOn(fork, existingDeployment);
    } catch (err) {
        // A failed setup leaves neither anvil nor the proxy behind.
        if (fork.child.exitCode === null && fork.child.signalCode === null) fork.child.kill('SIGKILL');
        await fork.upstream.stop();
        throw err;
    }
}

async function forkStackOn({ child, rpcUrl, upstream }: AnvilFork, existingDeployment: Record<string, unknown> | undefined): Promise<ForkStack> {
    const exited = once(child, 'exit').catch(() => undefined);

    const chain = defineChain({
        id: 137,
        name: 'Polygon (anvil fork)',
        nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
    });
    const transport = http(rpcUrl, { timeout: FORK_RPC_TIMEOUT_MS });
    const publicClient = createPublicClient({ chain, transport }) as PublicClient;
    const testClient = createTestClient({ mode: 'anvil', chain, transport }) as unknown as TestClient<'anvil'>;

    // Well-known test keys may carry code on Polygon (EIP-7702 sweeper delegations): clear it for the test users.
    const clearedCode: Array<{ index: number; code: string }> = [];
    for (let index = 0; index < 20; index++) {
        const address = anvilAccount(index).address;
        const code = await publicClient.getCode({ address });
        if (code !== undefined && code !== '0x') {
            clearedCode.push({ index, code });
            await testClient.setCode({ address, bytecode: '0x' });
        }
    }

    const admin = anvilAccount(0);
    // Timeouts in seconds: one RPC request to the fork, and the wait for each receipt.
    const forgeTimeouts = ['--rpc-timeout', String(FORK_RPC_TIMEOUT_MS / 1000), '--timeout', String(FORK_RECEIPT_TIMEOUT_MS / 1000)];
    // GaslessTransfer requires its owner (setTokenConfig); the fork's admin account owns it.
    if (!existingDeployment) {
        await run('forge', ['script', 'script/DeployGaslessTransfer.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', admin.address, '--slow', ...forgeTimeouts], CONTRACTS_DIR, {
            GASLESS_TRANSFER_OWNER: admin.address,
        });
    }
    const dir = mkdtempSync(join(tmpdir(), 'relay-fork-'));
    const deploymentFile = join(dir, 'deployment.json');
    if (existingDeployment) writeFileSync(deploymentFile, JSON.stringify(existingDeployment));
    else copyFileSync(join(CONTRACTS_DIR, 'deployments', '137.json'), deploymentFile);
    const deploymentJson = JSON.parse(readFileSync(deploymentFile, 'utf8')) as Record<string, unknown>;
    const deployment = parseDeployment(deploymentJson);
    if (existingDeployment && !(await publicClient.getCode({ address: deployment.gaslessTransfer }))) throw new Error('Selected deployment has no code at the fork block');
    // Test-only snapshot pins: assert the independently recorded implementation identities before hashing
    // the historical fork. These are isolated test configuration, never production rollout approval.
    const pinBlock = await publicClient.getBlockNumber();
    const pinSpecs = [
        { address: POLYGON_USDC, label: 'org.zeppelinos.proxy.implementation', implementation: '0x235AE97b28466Db30469b89A9fe4cFf0659f82Cb' as Address },
        { address: POLYGON_USDT0, label: 'matic.network.proxy.implementation', implementation: '0x90040487A6C9F949C4F07CaDCFB0f3B8EEAb4229' as Address },
    ];
    const pins = await Promise.all(pinSpecs.map(async (spec) => {
        const slot = keccak256(stringToHex(spec.label));
        const [word, proxyCode, implementationCode] = await Promise.all([
            publicClient.getStorageAt({ address: spec.address, slot, blockNumber: pinBlock }),
            publicClient.getCode({ address: spec.address, blockNumber: pinBlock }),
            publicClient.getCode({ address: spec.implementation, blockNumber: pinBlock }),
        ]);
        if (word?.toLowerCase() !== `0x${'0'.repeat(24)}${spec.implementation.slice(2).toLowerCase()}` || !proxyCode || proxyCode === '0x' || !implementationCode || implementationCode === '0x') {
            throw new Error('real-token fork implementation differs from reviewed fixture');
        }
        return { address: spec.address, proxyCodeHash: keccak256(proxyCode), implementationSlot: slot, implementationAddress: spec.implementation, implementationCodeHash: keccak256(implementationCode) };
    }));
    writeFileSync(join(dir, 'token-pins.json'), JSON.stringify({ chainId: 137, reviewedBlock: pinBlock.toString(), tokens: pins }));
    let automine = true;

    const sendAs: ForkStack['sendAs'] = async (from, call, fees) => {
        await testClient.impersonateAccount({ address: from });
        await testClient.setBalance({ address: from, value: parseEther('100') });
        const wallet = createWalletClient({ account: from, chain, transport });
        const hash = await wallet.writeContract({ ...(call as object), ...(fees ?? {}), gas: 500_000n } as never);
        await testClient.stopImpersonatingAccount({ address: from });
        if (automine) await receiptOf(publicClient, hash);
        return hash;
    };

    const stack: ForkStack = {
        rpcUrl,
        dir,
        deploymentFile,
        deploymentJson,
        deployment,
        usdc: POLYGON_USDC,
        usdt0: POLYGON_USDT0,
        transfer: deployment.gaslessTransfer,
        publicClient,
        chain,
        testClient,
        clearedCode,
        upstream: upstream.stats,
        pins: (relays) => pinsFromDeployment(deploymentJson, { relays }),
        async send(account, call) {
            const wallet = createWalletClient({ account, chain, transport });
            const hash: Hash = await wallet.writeContract(call as never);
            if (!automine) await testClient.mine({ blocks: 1 });
            const receipt = await receiptOf(publicClient, hash);
            if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted`);
            return receipt;
        },
        sendAs,
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
        async usdcAdmin() {
            const read = (functionName: 'masterMinter' | 'pauser' | 'blacklister') =>
                publicClient.readContract({ address: POLYGON_USDC, abi: realUsdcAbi, functionName });
            return { masterMinter: await read('masterMinter'), pauser: await read('pauser'), blacklister: await read('blacklister') };
        },
        usdt0Admin: () =>
            publicClient.readContract({ address: POLYGON_USDT0, abi: realUsdt0Abi, functionName: 'getRoleMember', args: [`0x${'0'.repeat(64)}`, 0n] }),
        async fund(token, to, amount) {
            if (token.toLowerCase() === POLYGON_USDC.toLowerCase()) {
                const { masterMinter } = await stack.usdcAdmin();
                const minter = anvilAccount(19).address;
                await sendAs(masterMinter, { address: POLYGON_USDC, abi: realUsdcAbi as Abi, functionName: 'configureMinter', args: [minter, amount] });
                await sendAs(minter, { address: POLYGON_USDC, abi: realUsdcAbi as Abi, functionName: 'mint', args: [to, amount] });
            } else {
                await sendAs(await stack.usdt0Admin(), { address: POLYGON_USDT0, abi: realUsdt0Abi as Abi, functionName: 'mint', args: [to, amount] });
            }
        },
        async stopChain() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                await exited;
            }
            await upstream.stop();
        },
        async stop() {
            await stack.stopChain();
            rmSync(dir, { recursive: true, force: true });
        },
    };
    return stack;
}
