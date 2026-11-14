import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseError, encodeErrorResult, encodeFunctionData, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import { readBalanceOf, readIntentNonce, readIntentNonceUsed } from '../../src/chain/reads.js';
import { decodeRevert, errorCodeForRevert } from '../../src/chain/revert.js';
import { aggregateBroadcast, classifyBroadcastError, createViemChainClient, extractRevert } from '../../src/chain/viemChainClient.js';
import { CONTRACT, USDC } from '../helpers/harness.js';
import { RELAY_ADDRESS, USER_ADDRESS } from '../helpers/keys.js';

type RpcReply = { result?: unknown; error?: { code: number; message: string; data?: string } } | 'http500';

interface RpcServer {
    url: string;
    calls: Array<{ method: string; params: unknown[] }>;
    close(): Promise<void>;
}

const servers: RpcServer[] = [];

async function rpcServer(handler: (method: string, params: unknown[]) => RpcReply): Promise<RpcServer> {
    const calls: RpcServer['calls'] = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
            const message = JSON.parse(body) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
            const handle = (m: { id: number; method: string; params: unknown[] }) => {
                calls.push({ method: m.method, params: m.params });
                const reply = handler(m.method, m.params);
                return reply === 'http500' ? reply : { jsonrpc: '2.0', id: m.id, ...reply };
            };
            const replies = Array.isArray(message) ? message.map(handle) : handle(message);
            if (replies === 'http500' || (Array.isArray(replies) && replies.includes('http500'))) {
                res.statusCode = 500;
                res.end('internal error');
                return;
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(replies));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const s: RpcServer = {
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
    servers.push(s);
    return s;
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

const RAW = `0x02f86b${'11'.repeat(100)}` as Hex;
const HASH = `0x${'ab'.repeat(32)}`;

describe('viem chain client against a JSON-RPC server', () => {
    it('reports reverts with their data and throws on transport errors', async () => {
        const revertData = encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'AuthModeNotSupported', args: [USDC, 2] });
        let mode: 'custom' | 'plain' | 'down' | 'ok' = 'custom';
        const server = await rpcServer((method) => {
            if (method !== 'eth_call') return { result: '0x' };
            if (mode === 'custom') return { error: { code: 3, message: 'execution reverted: custom error', data: revertData } };
            if (mode === 'plain') return { error: { code: -32000, message: 'execution reverted' } };
            if (mode === 'down') return 'http500';
            return { result: '0x1234' };
        });
        const chain = createViemChainClient({ rpcUrls: [server.url], timeoutMs: 2000 });
        const call = { from: RELAY_ADDRESS, to: CONTRACT, data: '0x12345678' as Hex };
        const custom = await chain.call(call);
        expect(custom).toEqual({ ok: false, revertData, message: 'execution reverted' });
        expect(decodeRevert(custom.ok ? undefined : custom.revertData).name).toBe('AuthModeNotSupported');
        mode = 'plain';
        expect(await chain.call(call)).toMatchObject({ ok: false, revertData: undefined });
        mode = 'ok';
        expect(await chain.call(call)).toEqual({ ok: true, data: '0x1234' });
        mode = 'down';
        await expect(chain.call(call)).rejects.toBeInstanceOf(BaseError);
    });

    it('broadcasts raw transactions to every RPC and aggregates the answers', async () => {
        let a: RpcReply = { error: { code: -32000, message: 'already known' } };
        let b: RpcReply = { result: HASH };
        const serverA = await rpcServer((method) => (method === 'eth_sendRawTransaction' ? a : { result: '0x' }));
        const serverB = await rpcServer((method) => (method === 'eth_sendRawTransaction' ? b : { result: '0x' }));
        const chain = createViemChainClient({ rpcUrls: [serverA.url, serverB.url], timeoutMs: 2000 });
        expect(await chain.sendRawTransaction(RAW)).toEqual({ kind: 'accepted' });
        expect(serverA.calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => c.params[0])).toEqual([RAW]);
        expect(serverB.calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => c.params[0])).toEqual([RAW]);

        b = { error: { code: -32000, message: 'already known' } };
        expect(await chain.sendRawTransaction(RAW)).toEqual({ kind: 'known' });
        a = { error: { code: -32000, message: 'nonce too low: next nonce 5, tx nonce 4' } };
        b = { error: { code: -32000, message: 'nonce too low' } };
        expect(await chain.sendRawTransaction(RAW)).toEqual({ kind: 'nonce_too_low' });
        b = 'http500';
        expect((await chain.sendRawTransaction(RAW)).kind).toBe('error'); // ambiguous: retry later
        a = { error: { code: -32000, message: 'insufficient funds for gas * price + value' } };
        expect(await chain.sendRawTransaction(RAW)).toEqual({ kind: 'insufficient_funds' });
        a = { error: { code: -32000, message: 'replacement transaction underpriced' } };
        expect(await chain.sendRawTransaction(RAW)).toEqual({ kind: 'underpriced' });
    });

    it('reads through the fallback transport when the first RPC is down', async () => {
        const dead = await rpcServer(() => 'http500');
        const live = await rpcServer((method, params) => {
            if (method === 'eth_chainId') return { result: '0x89' };
            if (method === 'eth_call') {
                const data = (params[0] as { data: Hex }).data;
                const balanceOf = encodeFunctionData({
                    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }],
                    args: [USER_ADDRESS],
                });
                if (data === balanceOf) return { result: `0x${(1234n).toString(16).padStart(64, '0')}` };
                return { result: `0x${'0'.repeat(63)}1` };
            }
            if (method === 'eth_maxPriorityFeePerGas') return { result: '0x6fc23ac00' };
            if (method === 'eth_getTransactionReceipt') return { result: null };
            return { result: '0x' };
        });
        const chain = createViemChainClient({ rpcUrls: [dead.url, live.url], timeoutMs: 2000 });
        expect(await chain.getChainId()).toBe(137);
        expect(await readBalanceOf(chain, USDC, USER_ADDRESS)).toBe(1234n);
        // nonces(USER) = 1: nonce 0 is used, 1 is not.
        expect(await readIntentNonce(chain, CONTRACT, USER_ADDRESS)).toBe(1n);
        expect(await readIntentNonceUsed(chain, CONTRACT, USER_ADDRESS, 0n)).toBe(true);
        expect(await readIntentNonceUsed(chain, CONTRACT, USER_ADDRESS, 1n)).toBe(false);
        expect(await chain.getMaxPriorityFeePerGas()).toBe(30_000_000_000n);
        expect(await chain.getTransactionReceipt(HASH as Hex)).toBeNull();
    });

    it('maps receipts', async () => {
        const server = await rpcServer((method) => {
            if (method !== 'eth_getTransactionReceipt') return { result: '0x' };
            return {
                result: {
                    transactionHash: HASH,
                    transactionIndex: '0x0',
                    blockHash: `0x${'cd'.repeat(32)}`,
                    blockNumber: '0x10',
                    from: RELAY_ADDRESS.toLowerCase(),
                    to: CONTRACT.toLowerCase(),
                    cumulativeGasUsed: '0x5208',
                    gasUsed: '0x5208',
                    effectiveGasPrice: '0x3b9aca00',
                    contractAddress: null,
                    logs: [{ address: CONTRACT.toLowerCase(), topics: [`0x${'ee'.repeat(32)}`], data: '0x', blockNumber: '0x10', transactionHash: HASH, logIndex: '0x0', blockHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', removed: false }],
                    logsBloom: `0x${'00'.repeat(256)}`,
                    status: '0x0',
                    type: '0x2',
                },
            };
        });
        const chain = createViemChainClient({ rpcUrls: [server.url], timeoutMs: 2000 });
        expect(await chain.getTransactionReceipt(HASH as Hex)).toEqual({
            transactionHash: HASH,
            blockNumber: 16n,
            blockHash: `0x${'cd'.repeat(32)}`,
            status: 'reverted',
            gasUsed: 21_000n,
            effectiveGasPrice: 1_000_000_000n,
            logs: [{ address: CONTRACT.toLowerCase(), topics: [`0x${'ee'.repeat(32)}`], data: '0x' }],
        });
    });

    it('rpcClients(): one client per RPC, each reading from its own RPC only; the client itself with a single RPC', async () => {
        const answer = (value: bigint) => (method: string): RpcReply =>
            method === 'eth_call' ? { result: `0x${value.toString(16).padStart(64, '0')}` } : { result: '0x89' };
        const a = await rpcServer(answer(1n));
        const b = await rpcServer(answer(2n));
        const chain = createViemChainClient({ rpcUrls: [a.url, b.url], timeoutMs: 2000 });
        const rpcs = chain.rpcClients!();
        expect(rpcs).toHaveLength(2);
        expect(chain.rpcClients!()).toBe(rpcs); // created once
        expect(await readBalanceOf(rpcs[0]!, USDC, USER_ADDRESS)).toBe(1n);
        expect(await readBalanceOf(rpcs[1]!, USDC, USER_ADDRESS)).toBe(2n);
        expect(await readBalanceOf(chain, USDC, USER_ADDRESS)).toBe(1n); // the fail-over client asks the first
        const single = createViemChainClient({ rpcUrls: [a.url], timeoutMs: 2000 });
        expect(single.rpcClients!()).toEqual([single]);
    });

    it('getLogs(): eth_getLogs with topic lists and hex block numbers; pending and removed logs are left out', async () => {
        const log = (n: number, extra: Record<string, unknown> = {}) => ({
            address: CONTRACT.toLowerCase(),
            topics: [`0x${'ee'.repeat(32)}`, `0x${'0a'.repeat(32)}`],
            data: '0x01',
            blockNumber: `0x${n.toString(16)}`,
            blockHash: `0x${'cd'.repeat(32)}`,
            transactionHash: HASH,
            logIndex: '0x0',
            transactionIndex: '0x0',
            removed: false,
            ...extra,
        });
        const server = await rpcServer((method) =>
            method === 'eth_getLogs' ? { result: [log(16), log(17, { removed: true }), log(18, { blockNumber: null, blockHash: null })] } : { result: '0x89' },
        );
        const chain = createViemChainClient({ rpcUrls: [server.url], timeoutMs: 2000 });
        const topic0 = `0x${'ee'.repeat(32)}` as Hex;
        const alt = `0x${'ff'.repeat(32)}` as Hex;
        const logs = await chain.getLogs!({ address: CONTRACT, topics: [[topic0, alt], null, topic0], fromBlock: 10n, toBlock: 1000n });
        expect(logs).toEqual([
            {
                address: CONTRACT.toLowerCase(),
                topics: [`0x${'ee'.repeat(32)}`, `0x${'0a'.repeat(32)}`],
                data: '0x01',
                blockNumber: 16n,
                blockHash: `0x${'cd'.repeat(32)}`,
                transactionHash: HASH,
            },
        ]);
        const call = server.calls.find((c) => c.method === 'eth_getLogs')!;
        expect(call.params).toEqual([{ address: CONTRACT, topics: [[topic0, alt], null, topic0], fromBlock: '0xa', toBlock: '0x3e8' }]);
    });

    it('getBlockWithTransactions(): eth_getBlockByNumber with full transactions (EIP-1559 and legacy fees); a block the RPC does not have is null', async () => {
        const blockHash = `0x${'cd'.repeat(32)}`;
        const tx = (hash: string, fees: Record<string, string>, extra: Record<string, unknown> = {}) => ({
            hash,
            from: RELAY_ADDRESS.toLowerCase(),
            to: CONTRACT.toLowerCase(),
            input: '0x12345678',
            blockHash,
            blockNumber: '0x10',
            transactionIndex: '0x0',
            nonce: '0x7',
            value: '0x0',
            gas: '0x493e0',
            chainId: '0x89',
            v: '0x1',
            r: `0x${'01'.repeat(32)}`,
            s: `0x${'02'.repeat(32)}`,
            ...fees,
            ...extra,
        });
        const server = await rpcServer((method, params) => {
            if (method !== 'eth_getBlockByNumber') return { result: '0x89' };
            if (params[0] !== '0x10') return { result: null };
            return {
                result: {
                    number: '0x10',
                    hash: blockHash,
                    parentHash: `0x${'00'.repeat(32)}`,
                    timestamp: '0x64',
                    baseFeePerGas: '0x3b9aca00',
                    gasLimit: '0x1c9c380',
                    gasUsed: '0x0',
                    transactions: [
                        tx(HASH, { type: '0x2', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', gasPrice: '0x77359400' }),
                        tx(`0x${'ef'.repeat(32)}`, { type: '0x0', gasPrice: '0x4a817c800' }, { to: null, v: '0x135' }),
                    ],
                },
            };
        });
        const chain = createViemChainClient({ rpcUrls: [server.url], timeoutMs: 2000 });
        expect(await chain.getBlockWithTransactions!(16n)).toEqual({
            number: 16n,
            timestamp: 100n,
            baseFeePerGas: 1_000_000_000n,
            hash: blockHash,
            transactions: [
                { hash: HASH, from: RELAY_ADDRESS.toLowerCase(), to: CONTRACT.toLowerCase(), input: '0x12345678', blockHash, gas: 300_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
                { hash: `0x${'ef'.repeat(32)}`, from: RELAY_ADDRESS.toLowerCase(), to: null, input: '0x12345678', blockHash, gas: 300_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 20_000_000_000n },
            ],
        });
        expect(server.calls.find((c) => c.method === 'eth_getBlockByNumber')!.params).toEqual(['0x10', true]);
        expect(await chain.getBlockWithTransactions!(17n)).toBeNull();
    });
});

describe('what an RPC provider cannot make the relay do', () => {
    /** An HTTP server that answers every request with `status` and `headers`, counting the requests. */
    async function httpServer(status: number, headers: Record<string, string> = {}): Promise<{ url: string; requests: () => number }> {
        let requests = 0;
        const server = createServer((req, res) => {
            requests += 1;
            req.resume();
            req.on('end', () => res.writeHead(status, headers).end());
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        servers.push({ url: '', calls: [], close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
        return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests };
    }

    it('an OffchainLookup revert (CCIP-Read) is a revert: no URL from the answer is fetched', async () => {
        const witness = await httpServer(200);
        // ERC-3668: with CCIP-Read on, viem fetches `urls` when `sender` is the called contract.
        const lookup = encodeErrorResult({
            abi: [
                {
                    type: 'error',
                    name: 'OffchainLookup',
                    inputs: [
                        { name: 'sender', type: 'address' },
                        { name: 'urls', type: 'string[]' },
                        { name: 'callData', type: 'bytes' },
                        { name: 'callbackFunction', type: 'bytes4' },
                        { name: 'extraData', type: 'bytes' },
                    ],
                },
            ],
            args: [CONTRACT, [`${witness.url}/{sender}/{data}`], '0x1234', '0x12345678', '0x'],
        });
        const server = await rpcServer((method) =>
            method === 'eth_call' ? { error: { code: 3, message: 'execution reverted', data: lookup } } : { result: '0x' },
        );
        const chain = createViemChainClient({ rpcUrls: [server.url, server.url], timeoutMs: 2000 });
        for (const client of [chain, ...chain.rpcClients!()]) {
            expect(await client.call({ from: RELAY_ADDRESS, to: CONTRACT, data: '0x12345678' })).toEqual({
                ok: false,
                revertData: lookup,
                message: 'execution reverted',
            });
            await expect(readBalanceOf(client, CONTRACT, USER_ADDRESS)).rejects.toBeInstanceOf(BaseError);
        }
        expect(witness.requests()).toBe(0);
    });

    it('a Retry-After header does not set how long a read waits', async () => {
        const limited = await httpServer(429, { 'retry-after': '3600' });
        const chain = createViemChainClient({ rpcUrls: [limited.url], timeoutMs: 2000 });
        const start = Date.now();
        await expect(chain.getChainId()).rejects.toBeInstanceOf(BaseError);
        // Two tries with viem's own short back-off in between, not the hour the provider asked for.
        expect(limited.requests()).toBe(2);
        expect(Date.now() - start).toBeLessThan(2000);
    });

    /** An HTTP server that sends the headers of a JSON answer, then `write`s its body, counting the requests. */
    async function bodyServer(write: (res: ServerResponse) => void): Promise<{ url: string; requests: () => number }> {
        let requests = 0;
        const server = createServer((req, res) => {
            requests += 1;
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                write(res);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const close = () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        servers.push({ url: '', calls: [], close });
        return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests };
    }

    it('an answer whose body never ends is over when the request timeout is', async () => {
        const stalled = await bodyServer((res) => res.write('{"jsonrpc":"2.0","id":1,"result":"0x'));
        const chain = createViemChainClient({ rpcUrls: [stalled.url], timeoutMs: 200 });
        const start = Date.now();
        await expect(chain.getChainId()).rejects.toBeInstanceOf(BaseError);
        // Two tries of 200 ms each, not Node's five minutes between two chunks of a body.
        expect(stalled.requests()).toBe(2);
        expect(Date.now() - start).toBeLessThan(2000);
    });

    it('a stalled body on the first RPC fails over to the next one', async () => {
        const stalled = await bodyServer((res) => res.write('{"jsonrpc":"2.0","id":1,"result":"0x'));
        const healthy = await rpcServer(() => ({ result: '0x89' }));
        const chain = createViemChainClient({ rpcUrls: [stalled.url, healthy.url], timeoutMs: 200 });
        expect(await chain.getChainId()).toBe(137);
    });

    it('an answer larger than the relay reads is refused, not buffered', async () => {
        const chunk = 'a'.repeat(1024 * 1024);
        const endless = await bodyServer((res) => {
            const more = (): void => {
                while (!res.destroyed && res.write(chunk));
                if (!res.destroyed) res.once('drain', more);
            };
            more();
        });
        const chain = createViemChainClient({ rpcUrls: [endless.url], timeoutMs: 10_000 });
        const start = Date.now();
        await expect(chain.getChainId()).rejects.toThrow('exceeded the size limit');
        // Refused at the size limit, long before the timeout.
        expect(Date.now() - start).toBeLessThan(10_000);
    });

    it('a read that fails on every RPC asks each RPC twice and does not repeat the sweep', async () => {
        const first = await httpServer(503);
        const second = await httpServer(503);
        const chain = createViemChainClient({ rpcUrls: [first.url, second.url], timeoutMs: 2000 });
        await expect(chain.getChainId()).rejects.toBeInstanceOf(BaseError);
        expect([first.requests(), second.requests()]).toEqual([2, 2]);
    });

    it('a receipt without gasUsed is refused as incomplete', async () => {
        const server = await rpcServer((method) => {
            if (method !== 'eth_getTransactionReceipt') return { result: '0x' };
            return {
                result: {
                    transactionHash: HASH,
                    transactionIndex: '0x0',
                    blockHash: `0x${'cd'.repeat(32)}`,
                    blockNumber: '0x10',
                    from: RELAY_ADDRESS.toLowerCase(),
                    to: CONTRACT.toLowerCase(),
                    cumulativeGasUsed: '0x5208',
                    effectiveGasPrice: '0x3b9aca00',
                    contractAddress: null,
                    logs: [],
                    logsBloom: `0x${'00'.repeat(256)}`,
                    status: '0x1',
                    type: '0x2',
                },
            };
        });
        const chain = createViemChainClient({ rpcUrls: [server.url], timeoutMs: 2000 });
        await expect(chain.getTransactionReceipt(HASH as Hex)).rejects.toThrow('incomplete receipt');
    });
});

describe('error helpers', () => {
    it('extractRevert ignores non-revert errors', () => {
        expect(extractRevert(new Error('x'))).toBeUndefined();
        expect(extractRevert(new BaseError('HTTP request failed.'))).toBeUndefined();
    });

    it('classifies node messages', () => {
        const e = (message: string) => new Error(message);
        expect(classifyBroadcastError(e('already known'))).toEqual({ kind: 'known' });
        expect(classifyBroadcastError(e('Known transaction: abc'))).toEqual({ kind: 'known' });
        expect(classifyBroadcastError(e('nonce too low'))).toEqual({ kind: 'nonce_too_low' });
        expect(classifyBroadcastError(e('insufficient funds for gas * price + value'))).toEqual({ kind: 'insufficient_funds' });
        expect(classifyBroadcastError(e('transaction underpriced'))).toEqual({ kind: 'underpriced' });
        expect(classifyBroadcastError(e(`weird ${'ab'.repeat(100)}`))).toEqual({ kind: 'error', message: 'weird [REDACTED_HEX]' });
    });

    it('aggregates: any acceptance wins, nonce_too_low only if unanimous', () => {
        expect(aggregateBroadcast([{ kind: 'error', message: 'x' }, { kind: 'accepted' }])).toEqual({ kind: 'accepted' });
        expect(aggregateBroadcast([{ kind: 'nonce_too_low' }, { kind: 'known' }])).toEqual({ kind: 'known' });
        expect(aggregateBroadcast([{ kind: 'nonce_too_low' }, { kind: 'nonce_too_low' }])).toEqual({ kind: 'nonce_too_low' });
        expect(aggregateBroadcast([{ kind: 'nonce_too_low' }, { kind: 'error', message: 'timeout' }])).toEqual({ kind: 'error', message: 'timeout' });
        expect(aggregateBroadcast([])).toEqual({ kind: 'error', message: 'broadcast failed' });
    });

    it('decodes reverts and maps them to request error codes', () => {
        const custom = decodeRevert(encodeErrorResult({ abi: gaslessTransferAbi, errorName: 'AuthModeNotSupported', args: [USDC, 2] }));
        expect(custom).toMatchObject({ name: 'AuthModeNotSupported', description: `AuthModeNotSupported(${USDC}, 2)` });
        expect(errorCodeForRevert(custom)).toBe('unsupported_auth_mode');
        const reason = decodeRevert(
            encodeErrorResult({
                abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }],
                errorName: 'Error',
                args: ['USDT0: from is blocked'],
            }),
        );
        expect(reason.description).toBe('Error(USDT0: from is blocked)');
        expect(errorCodeForRevert(reason)).toBe('simulation_failed');
        const panic = decodeRevert(
            encodeErrorResult({ abi: [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'code' }] }], errorName: 'Panic', args: [0x11n] }),
        );
        expect(panic.name).toBe('Panic');
        expect(decodeRevert('0xdeadbeef').description).toBe('reverted with unknown error 0xdeadbeef');
        expect(decodeRevert(undefined).description).toBe('reverted without reason');
        // A used intent nonce reverts with InvalidSignature, which the transaction manager tells apart by reading
        // nonces() (TxManager.preflight).
        for (const [name, code] of [
            ['InsufficientAllowance', 'insufficient_allowance'],
            ['DeadlineExpired', 'deadline_out_of_range'],
            ['InvalidSignature', 'invalid_signature'],
            ['InvalidSigner', 'invalid_signature'],
            ['NotRelay', 'wrong_relay'],
            ['InvalidRecipient', 'invalid_recipient'],
            ['ZeroAmount', 'invalid_amount'],
            ['TokenNotSupported', 'unsupported_token'],
            ['AuthModeNotSupported', 'unsupported_auth_mode'],
        ] as const) {
            expect(errorCodeForRevert({ name, args: [], description: '' })).toBe(code);
        }
    });

    it('decodes the OpenZeppelin errors of the compiled contract ABI (simulation_failed)', () => {
        const cases = [
            { errorName: 'SafeERC20FailedOperation', args: [USDC], description: `SafeERC20FailedOperation(${USDC})` },
            { errorName: 'ReentrancyGuardReentrantCall', args: [], description: 'ReentrancyGuardReentrantCall()' },
            { errorName: 'InvalidShortString', args: [], description: 'InvalidShortString()' },
            { errorName: 'StringTooLong', args: ['x'], description: 'StringTooLong(x)' },
        ] as const;
        for (const c of cases) {
            const decoded = decodeRevert(encodeErrorResult({ abi: gaslessTransferAbi, errorName: c.errorName, args: c.args } as never));
            expect(decoded).toMatchObject({ name: c.errorName, description: c.description });
            expect(errorCodeForRevert(decoded)).toBe('simulation_failed');
        }
    });
});
