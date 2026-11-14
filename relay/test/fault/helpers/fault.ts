// Fault-injection fixture: anvil with the real contracts (DeployLocalStack), the fault-injecting
// JSON-RPC proxy between the relay and anvil, and the relay itself with the production wiring
// (src/server.ts) or the production entrypoint (dist/main.js). The tests talk to anvil directly; only the
// relay goes through the proxy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
    decodeFunctionData,
    encodeFunctionData,
    keccak256,
    parseTransaction,
    type Address,
    type Hash,
    type Hex,
    type PrivateKeyAccount,
    type TransactionReceipt,
} from 'viem';
import { foundry } from 'viem/chains';
import { gaslessTransferAbi, type ChainPins } from '@nimiq/gasless-sdk/core';
import { RelayClient, type RequestState, type RequestStatus } from '@nimiq/gasless-sdk/relay';
import { postRaw, relayEnv, signTransfer, spawnRelay, startRelay, waitFor, type RelayProcess, type RunningRelay, type SignedTransfer, type TransferParams } from '../../integration/helpers/relay.js';
import { CONTRACTS_DIR, PORT_ATTEMPTS, anvilAccount, freePort, mockTokenAbi, startStack, type Stack } from '../../integration/helpers/stack.js';
import { RpcProxy } from './rpcProxy.js';

export { RpcProxy };
export { anvilAccount, mockTokenAbi, postRaw, signTransfer, spawnRelay, waitFor };
export type { RunningRelay, SignedTransfer, Stack, TransferParams };

export interface FaultEnv {
    readonly stack: Stack;
    readonly proxy: RpcProxy;
    readonly relay: RunningRelay;
    stop(): Promise<void>;
}

export interface FaultEnvOptions {
    /** Extra RELAY_* variables (the RPC URL is always the proxy). */
    readonly env?: Readonly<Record<string, string>>;
    readonly accountIndex?: number;
    /** Stop the relay's polling loop so the test drives every pass (default true). */
    readonly manualTicks?: boolean;
    /** Automine off (default true): the test mines. */
    readonly manualMining?: boolean;
    /** Runs after anvil and the proxy are up and before the relay starts (and recovers). */
    readonly beforeRelay?: (stack: Stack, proxy: RpcProxy) => Promise<void>;
    /** RELAY_RPC_URLS from the proxy's and anvil's URLs (default: the proxy only). */
    readonly rpcUrls?: (proxyUrl: string, anvilUrl: string) => string;
}

export async function startFaultEnv(options: FaultEnvOptions = {}): Promise<FaultEnv> {
    const stack = await startStack();
    const proxy = await new RpcProxy(stack.rpcUrl).start();
    if (options.beforeRelay) await options.beforeRelay(stack, proxy);
    const rpcUrls = options.rpcUrls ? options.rpcUrls(proxy.url, stack.rpcUrl) : proxy.url;
    const relay = await startRelay(stack, {
        ...(options.accountIndex !== undefined ? { accountIndex: options.accountIndex } : {}),
        env: { RELAY_RPC_URLS: rpcUrls, RELAY_RPC_TIMEOUT_MS: '1000', RELAY_RATE_LIMIT_SIGNER_MAX: '1000', ...options.env },
    });
    if (options.manualTicks ?? true) await relay.server.relay.txManager.stop();
    if (options.manualMining ?? true) await stack.setAutomine(false);
    return {
        stack,
        proxy,
        relay,
        async stop() {
            await relay.stop().catch(() => undefined);
            await proxy.stop();
            await stack.stop();
        },
    };
}

/** One transaction-manager pass; returns the tick error (if any) instead of throwing. */
export async function tick(relay: RunningRelay): Promise<string | undefined> {
    await relay.server.relay.txManager.tick();
    return relay.server.relay.txManager.lastTickError;
}

/** Mines `blocks` blocks, each with base fee `baseFee` (if given), and runs one pass after each. */
export async function mineAndTick(e: FaultEnv, blocks: number, baseFee?: bigint): Promise<void> {
    for (let i = 0; i < blocks; i++) {
        if (baseFee !== undefined) await e.stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: baseFee });
        await e.stack.mine();
        await tick(e.relay);
    }
}

export async function inMempool(stack: Stack, hash: Hex): Promise<boolean> {
    try {
        return (await stack.publicClient.getTransaction({ hash })).blockNumber === null;
    } catch {
        return false;
    }
}

export async function status(relay: RunningRelay, id: Hex): Promise<RequestStatus> {
    return (await relay.state(id)).status;
}

export async function reaches(relay: { state(id: Hex): Promise<RequestState> }, id: Hex, want: RequestStatus, timeoutMs = 30_000): Promise<RequestState> {
    return waitFor(`${id} → ${want}`, async () => {
        const s = await relay.state(id);
        return s.status === want ? s : undefined;
    }, timeoutMs);
}

export async function submit(relay: RunningRelay, t: SignedTransfer): Promise<void> {
    const res = await relay.client.submitTransfer(t.body);
    if (res.id !== t.id || res.status !== 'queued') throw new Error(`unexpected submit answer ${JSON.stringify(res)}`);
}

/** Relay transactions that are on-chain (every block from `fromBlock`), in order. */
export async function relayTxsOnChain(stack: Stack, relay: Address, fromBlock = 0n): Promise<Array<{ hash: Hash; nonce: number; to: Address | null; input: Hex; receipt: TransactionReceipt }>> {
    const head = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
    const out: Array<{ hash: Hash; nonce: number; to: Address | null; input: Hex; receipt: TransactionReceipt }> = [];
    for (let n = fromBlock; n <= head; n++) {
        const block = await stack.publicClient.getBlock({ blockNumber: n, includeTransactions: true });
        for (const tx of block.transactions) {
            if (tx.from.toLowerCase() !== relay.toLowerCase()) continue;
            const receipt = await stack.publicClient.getTransactionReceipt({ hash: tx.hash });
            out.push({ hash: tx.hash, nonce: tx.nonce, to: tx.to, input: tx.input, receipt });
        }
    }
    return out;
}

/**
 * The (from, signature) a relayTransfer calldata carries (to detect two calls for one request). GaslessTransfer
 * calldata has no intent nonce (the contract signs over nonces(from)); the signature identifies the signed version.
 */
export function requestKeyOf(input: Hex): string | undefined {
    try {
        const decoded = decodeFunctionData({ abi: gaslessTransferAbi, data: input });
        if (decoded.functionName !== 'relayTransfer') return undefined;
        const [request, signature] = decoded.args as unknown as [{ from: Address }, Hex];
        return `${request.from.toLowerCase()}:${signature.toLowerCase()}`;
    } catch {
        return undefined;
    }
}

/**
 * Sends a contract call from an anvil test account with explicit fees, nonce and gas: signed locally and sent raw,
 * so nothing is estimated against the pending block (which already contains the relay's call).
 */
export async function sendFrom(
    stack: Stack,
    account: PrivateKeyAccount,
    call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    gas = 300_000n,
): Promise<Hash> {
    const nonce = await stack.publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const data = (encodeFunctionData as (p: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Hex)({
        abi: call.abi,
        functionName: call.functionName,
        args: call.args ?? [],
    });
    const raw = await account.signTransaction({
        type: 'eip1559',
        chainId: foundry.id,
        nonce,
        to: call.address,
        data,
        value: 0n,
        gas,
        ...fees,
    });
    return sendRaw(stack, raw);
}

/** Transactions of the latest block in execution order (for ordering diagnostics). */
export async function lastBlockOrder(stack: Stack): Promise<Array<{ from: Address; nonce: number; tip: bigint | undefined; hash: Hash }>> {
    const block = await stack.publicClient.getBlock({ blockTag: 'latest', includeTransactions: true });
    return block.transactions.map((t) => ({ from: t.from, nonce: t.nonce, tip: t.maxPriorityFeePerGas, hash: t.hash }));
}

export async function relayNonces(stack: Stack, relay: Address): Promise<{ latest: number; pending: number }> {
    const [latest, pending] = await Promise.all([
        stack.publicClient.getTransactionCount({ address: relay, blockTag: 'latest' }),
        stack.publicClient.getTransactionCount({ address: relay, blockTag: 'pending' }),
    ]);
    return { latest, pending };
}

/** The relay's transactions since `fromBlock` use consecutive nonces without a gap, and none is still pending. */
export async function expectCleanNonces(e: FaultEnv, fromBlock: bigint): Promise<void> {
    const txs = await relayTxsOnChain(e.stack, e.relay.address, fromBlock);
    const nonces = await relayNonces(e.stack, e.relay.address);
    const first = txs[0]?.nonce ?? nonces.latest;
    expect(txs.map((t) => t.nonce)).toEqual(Array.from({ length: nonces.latest - first }, (_, i) => first + i));
    expect(nonces.pending).toBe(nonces.latest);
}

/** Bytecode of a contract compiled by `forge build` (globalSetup), e.g. the EIP-7702 delegates of test/fork-verify. */
export function artifactBytecode(file: string, contract: string): Hex {
    const json = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'out', file, `${contract}.json`), 'utf8')) as { bytecode: { object: Hex } };
    return json.bytecode.object;
}

export const RECIPIENT: Address = anvilAccount(11).address;

/** A raw JSON-RPC call to anvil (for anvil_* methods viem's test client does not wrap). */
export async function rpc(stack: Stack, method: string, params: readonly unknown[] = []): Promise<unknown> {
    const res = await fetch(stack.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
}

/** A raw JSON-RPC call to anvil that returns the answer (result or error with revert data) instead of throwing. */
export async function rpcAnswer(stack: Stack, method: string, params: readonly unknown[]): Promise<{ result: unknown } | { error: { code: number; message: string; data?: unknown } }> {
    const res = await fetch(stack.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    return json.error ? { error: json.error } : { result: json.result ?? null };
}

export async function dropAllTransactions(stack: Stack): Promise<void> {
    await rpc(stack, 'anvil_dropAllTransactions');
}

export async function sendRaw(stack: Stack, raw: Hex): Promise<Hash> {
    return (await rpc(stack, 'eth_sendRawTransaction', [raw])) as Hash;
}

// ---------------------------------------------------------------------------------------------------
// The production entrypoint (node dist/main.js) as a child process behind the proxy, for SIGKILL tests
// ---------------------------------------------------------------------------------------------------

export interface ProcessEnv {
    readonly stack: Stack;
    readonly proxy: RpcProxy;
    readonly env: Record<string, string>;
    readonly relayAddress: Address;
    readonly pins: ChainPins;
    readonly client: RelayClient;
    /** The current relay process (replaced by `restart`). */
    readonly proc: RelayProcess;
    readonly processes: readonly RelayProcess[];
    /** Everything the processes printed so far (JSON log lines). */
    logs(): Array<Record<string, unknown>>;
    state(id: Hex): Promise<RequestState>;
    kill(): Promise<void>;
    /** Starts a new process on the same key, database and port (after `kill`). */
    restart(): Promise<void>;
    stop(): Promise<void>;
}

/**
 * The first relay process. Its RELAY_PORT comes from freePort; a port taken before the process listened (it exits with
 * EADDRINUSE) is replaced by a new one in `env`, PORT_ATTEMPTS starts in all. Restarts keep the port.
 */
async function spawnStarted(env: Record<string, string>): Promise<RelayProcess> {
    for (let start = 1; ; start++) {
        const p = spawnRelay(env);
        try {
            await p.started();
            return p;
        } catch (err) {
            if (!p.output().includes('EADDRINUSE') || start >= PORT_ATTEMPTS) throw err;
            env.RELAY_PORT = String(await freePort());
        }
    }
}

async function killProcess(p: RelayProcess, signal: NodeJS.Signals): Promise<void> {
    if (p.child.exitCode === null && p.child.signalCode === null) {
        p.child.kill(signal);
        await p.exited;
    }
}

export async function startProcessEnv(options: { env?: Readonly<Record<string, string>>; accountIndex?: number } = {}): Promise<ProcessEnv> {
    const stack = await startStack();
    await stack.setAutomine(false);
    const proxy = await new RpcProxy(stack.rpcUrl).start();
    const index = options.accountIndex ?? 10;
    const env = await relayEnv(stack, {
        accountIndex: index,
        env: {
            RELAY_RPC_URLS: proxy.url,
            RELAY_POLL_INTERVAL_MS: '100',
            RELAY_LOG_LEVEL: 'info',
            RELAY_RATE_LIMIT_SIGNER_MAX: '1000',
            ...options.env,
        },
    });
    const relayAddress = anvilAccount(index).address;
    const pins = stack.pins([relayAddress]);
    const processes: RelayProcess[] = [await spawnStarted(env)];
    const client = new RelayClient(processes[0]!.url, { pins });
    const current = (): RelayProcess => processes[processes.length - 1]!;
    return {
        stack,
        proxy,
        env,
        relayAddress,
        pins,
        client,
        get proc() {
            return current();
        },
        processes,
        logs: () => processes.flatMap((p) => p.logs()),
        state: (id) => client.getRequest(id),
        kill: () => killProcess(current(), 'SIGKILL'),
        async restart() {
            await killProcess(current(), 'SIGKILL');
            const next = spawnRelay(env);
            processes.push(next);
            await next.started();
        },
        async stop() {
            for (const p of processes) await killProcess(p, 'SIGKILL');
            await proxy.stop();
            await stack.stop();
        },
    };
}

/** Mines one block at a time (waiting `delayMs` for the relay's polling loop) until `done` or `maxBlocks`. */
export async function mineUntil(stack: Stack, done: () => Promise<boolean>, maxBlocks: number, delayMs = 300): Promise<number> {
    for (let i = 0; i < maxBlocks; i++) {
        if (await done()) return i;
        await stack.mine();
        await sleep(delayMs);
    }
    return (await done()) ? maxBlocks : -1;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The relay transactions the proxy saw (every broadcast, including repeats), decoded. */
export function decodedBroadcasts(
    proxy: RpcProxy,
    relay: Address,
): Array<{ hash: Hash; nonce: number; kind: 'call' | 'cancel' | 'other'; key: string | undefined }> {
    return proxy.rawTransactions().map((raw) => {
        const tx = parseTransaction(raw as Hex);
        const kind = tx.to?.toLowerCase() === relay.toLowerCase() ? 'cancel' : tx.data && tx.data !== '0x' ? 'call' : 'other';
        return { hash: keccak256(raw as Hex), nonce: tx.nonce ?? -1, kind, key: tx.data ? requestKeyOf(tx.data) : undefined };
    });
}

/** One entry per request key: the relay transactions on-chain that call relayTransfer for it. */
export function callsPerRequest(txs: ReadonlyArray<{ input: Hex; receipt: TransactionReceipt }>): Map<string, Array<'success' | 'reverted'>> {
    const out = new Map<string, Array<'success' | 'reverted'>>();
    for (const t of txs) {
        const key = requestKeyOf(t.input);
        if (!key) continue;
        out.set(key, [...(out.get(key) ?? []), t.receipt.status]);
    }
    return out;
}

/** The key `requestKeyOf` gives the relayTransfer calls of `t`. */
export const keyOf = (t: SignedTransfer): string => `${t.body.request.from.toLowerCase()}:${t.body.signature.toLowerCase()}`;

/** The sender's next intent nonce (GaslessTransfer.nonces) at the latest block. */
export function intentNonce(stack: Pick<Stack, 'publicClient' | 'transfer'>, from: Address): Promise<bigint> {
    return stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [from] });
}

/** True once the intent nonce of `t` is used (executed or invalidated): the sender's next nonce is above it. */
export async function intentNonceUsed(stack: Pick<Stack, 'publicClient' | 'transfer'>, t: SignedTransfer): Promise<boolean> {
    return (await intentNonce(stack, t.body.request.from)) > BigInt(t.body.request.nonce);
}
