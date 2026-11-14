// The search for the block that used an intent nonce right after the contract's creation, on anvil (which serves the
// state of every block) with the production GaslessTransfer deployed 2000 blocks into the chain. The
// deployment record's deployBlock is the block before the broadcast, a lower bound; between it and the creation the
// address has no code and eth_call answers no data. quorum.findNonceUse reads no state below deployBlock, takes no data
// for nonce 0 (unused), and finds the relay's call from every head; the SDK's confirmOnChain answers from state too,
// without the log search.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, custom, http, toHex, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { foundry } from 'viem/chains';
import { AUTH_MODE_ID, NO_TOKEN_AUTHORIZATION, gaslessTransferAbi, pinsFromDeployment, tokenAuthHash, transferDigest, type TransferRequest } from '@nimiq/gasless-sdk/core';
import { confirmOnChain } from '@nimiq/gasless-sdk/viem';
import type { ChainClient, ReadContractCall } from '../../src/chain/types.js';
import { createViemChainClient } from '../../src/chain/viemChainClient.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { buildRelayContext } from '../../src/startup.js';
import { findNonceUse, type UseQuery } from '../../src/tx/quorum.js';
import { signRawRequest } from './helpers/relay.js';
import { CHAIN_ID, CONTRACTS_DIR, RELAY_INDEX, anvilAccount, mockTokenAbi, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
/** The second GaslessTransfer, the block the deploy scripts would record for it, and the block that created it. */
let contract: Address;
let deployBlock: bigint;
let created: bigint;
/** A request executed two blocks after the creation, and the receipt of the relay's call. */
let request: TransferRequest;
let executed: TransactionReceipt;

const relayKey = anvilAccount(RELAY_INDEX);
const sender = anvilAccount(2);
const HEADS = 160n;

beforeAll(async () => {
    stack = await startStack();
    await stack.mine(2000);
    const artifact = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'out', 'GaslessTransfer.sol', 'GaslessTransfer.json'), 'utf8')) as {
        abi: Abi;
        bytecode: { object: Hex };
    };
    const admin = anvilAccount(0);
    deployBlock = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
    await stack.mine(3); // the broadcast is included a few blocks after the block the script saw
    const deployer = createWalletClient({ account: admin, chain: foundry, transport: http(stack.rpcUrl) });
    const hash = await deployer.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: [admin.address, [{ token: stack.usdc, config: { permit: false, metaTxApprove: false, allowance: true } }]],
    });
    const deployed = await stack.publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    contract = deployed.contractAddress!;
    created = deployed.blockNumber;

    await stack.send(sender, { address: stack.usdc, abi: mockTokenAbi, functionName: 'approve', args: [contract, 10n ** 12n] });
    const now = (await stack.latestBlock()).timestamp;
    request = {
        token: stack.usdc,
        from: sender.address,
        to: anvilAccount(11).address,
        amount: '1000000',
        fee: '10000',
        relay: relayKey.address,
        nonce: '0',
        deadline: String(now + 3600n),
    };
    const a = NO_TOKEN_AUTHORIZATION;
    executed = await stack.send(relayKey, {
        address: contract,
        abi: gaslessTransferAbi,
        functionName: 'relayTransfer',
        args: [
            { token: request.token, from: request.from, to: request.to, amount: 1_000_000n, fee: 10_000n, relay: request.relay, deadline: BigInt(request.deadline) },
            await signRawRequest(sender, contract, request),
            { mode: AUTH_MODE_ID[a.mode], v: a.v, r: a.r, s: a.s },
        ],
    });
    await stack.mine(Number(HEADS));
});

afterAll(async () => {
    await stack?.stop();
});

describe('the use of an intent nonce right after the creation of the contract', () => {
    it('the deployment as the scripts record it: no code from deployBlock to the creation, nonce 0 at the creation', async () => {
        expect(created - deployBlock).toBe(4n);
        expect(executed.blockNumber - created).toBe(2n);
        expect(await stack.publicClient.getCode({ address: contract, blockNumber: created - 1n })).toBeUndefined();
        expect(await stack.publicClient.readContract({ address: contract, abi: gaslessTransferAbi, functionName: 'nonces', args: [sender.address], blockNumber: created })).toBe(0n);
    });

    it("findNonceUse: the relay's call from every head up to 160 blocks later, with no state read below deployBlock", async () => {
        const chain = createViemChainClient({ rpcUrls: [stack.rpcUrl], timeoutMs: 10_000 });
        const readAt: bigint[] = [];
        const counted: ChainClient = {
            ...chain,
            getBlockWithTransactions: chain.getBlockWithTransactions!.bind(chain),
            getLogs: chain.getLogs!.bind(chain),
            readContract: <T,>(call: ReadContractCall): Promise<T> => {
                if (call.blockNumber !== undefined) readAt.push(call.blockNumber);
                return chain.readContract<T>(call);
            },
        };
        const ctx = buildRelayContext({ ...stack.deployment, gaslessTransfer: contract, deployBlock }, relayKey.address, chain);
        const q: UseQuery = {
            contract,
            floor: deployBlock,
            signer: sender.address,
            nonce: 0n,
            deadline: BigInt(request.deadline),
            id: transferDigest(CHAIN_ID, contract, request, NO_TOKEN_AUTHORIZATION),
            executionOf: (call, nonce) => transferOperation.executionOf(ctx, call, nonce),
        };
        const answers = new Map<string, number>();
        for (let head = executed.blockNumber; head <= executed.blockNumber + HEADS; head++) {
            const use = await findNonceUse(counted, q, head);
            const key = use.kind === 'executed' && use.tx.hash === executed.transactionHash && use.block.number === executed.blockNumber ? 'executed' : JSON.stringify(use, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
            answers.set(key, (answers.get(key) ?? 0) + 1);
        }
        expect(Object.fromEntries(answers)).toEqual({ executed: Number(HEADS) + 1 });
        // The search read the blocks without code (nonce 0), and nothing below deployBlock.
        expect(readAt.some((n) => n < created)).toBe(true);
        expect(readAt.every((n) => n >= deployBlock)).toBe(true);
    });

    it('confirmOnChain with the recorded deployBlock, read at every one of those heads: executed from state, without eth_getLogs', async () => {
        const pins = pinsFromDeployment({ ...stack.deploymentJson, gaslessTransfer: contract, deployBlock: String(deployBlock) }, { relays: [relayKey.address] });
        const methods: Record<string, number> = {};
        const readAt: bigint[] = [];
        const upstream = http(stack.rpcUrl)({ chain: foundry });
        /** The node, as it answered when `head` was its latest block. */
        const at = (head: bigint) =>
            createPublicClient({
                chain: foundry,
                transport: custom({
                    request({ method, params }: { method: string; params?: unknown }) {
                        methods[method] = (methods[method] ?? 0) + 1;
                        const args = [...((params ?? []) as unknown[])];
                        if (method === 'eth_getBlockByNumber' && args[0] === 'latest') args[0] = toHex(head);
                        if (method === 'eth_call' && typeof args[1] === 'string') readAt.push(BigInt(args[1]));
                        return upstream.request({ method, params: args } as never);
                    },
                }),
            });
        const statuses = new Map<string, number>();
        for (let head = executed.blockNumber; head <= executed.blockNumber + HEADS; head++) {
            const answer = await confirmOnChain(at(head), pins, { request, authHash: tokenAuthHash(NO_TOKEN_AUTHORIZATION) });
            const key = answer.status === 'executed' && answer.txHash === executed.transactionHash && answer.blockNumber === executed.blockNumber ? 'executed' : answer.status;
            statuses.set(key, (statuses.get(key) ?? 0) + 1);
        }
        expect(Object.fromEntries(statuses)).toEqual({ executed: Number(HEADS) + 1 });
        expect(readAt.some((n) => n < created)).toBe(true);
        expect(readAt.every((n) => n >= deployBlock)).toBe(true);
        expect(methods.eth_getLogs).toBeUndefined();
    });
});
