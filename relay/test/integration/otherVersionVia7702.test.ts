// The search for the use of an intent nonce when another version of the payment executes through code, with an
// externally owned relay: the relay named in the other version is an EOA with an EIP-7702 delegation.
// It sends a transaction to itself (`to` is the EOA, not GaslessTransfer), and its code calls relayTransfer, so
// msg.sender is the EOA the version names. Ordered before the relay's call in the same block, it executes that version,
// and the relay's own call reverts. Nothing direct in the block shows the use: the search answers `unknown` whether the
// relay's receipt is served (it reverted), served only in eth_getBlockReceipts, or hidden on every RPC (the call is
// listed without a receipt). The inclusion of the call alone never counts as its execution: otherwise the relay would
// report `mined` for a reverted call. Through the transaction manager, with every receipt of its call hidden, the
// request waits with the ALERT and is never mined; once the receipt shows, it fails (reverted). The SDK's on-chain
// check answers `unresolved`, never `executed`. Real anvil (Prague), the production contract.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concat, createWalletClient, encodeFunctionData, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { AUTH_MODE_ID, NO_TOKEN_AUTHORIZATION, gaslessTransferAbi, tokenAuthHash, type TransferRequest } from '@nimiq/gasless-sdk/core';
import { confirmOnChain } from '@nimiq/gasless-sdk/viem';
import type { ChainClient, ReceiptInfo } from '../../src/chain/types.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { findNonceUse, type UseQuery } from '../../src/tx/quorum.js';
import { signRawRequest, signTransfer, startRelay, type RunningRelay } from './helpers/relay.js';
import { anvilAccount, mockTokenAbi, startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let relay: RunningRelay;

beforeAll(async () => {
    stack = await startStack();
    relay = await startRelay(stack, { env: { RELAY_STUCK_AFTER_BLOCKS: '30' } });
    await relay.server.relay.txManager.stop(); // passes are driven by the test
});

afterAll(async () => {
    await relay?.stop();
    await stack?.stop();
});

/** Runtime: CALL(address = calldata[0:20], data = calldata[20:]); reverts if that call reverts. The init code returns it. */
const FORWARDER_RUNTIME: Hex = '0x6014360380601460003760006000826000600060003560601c5af115602057005b600080fd';
const FORWARDER_INIT: Hex = `0x6025600c60003960256000f3${FORWARDER_RUNTIME.slice(2)}`;

describe('another version executed through code (an EIP-7702 EOA relay calling itself) before the relay’s call, which reverts', () => {
    it('the search never answers executed for the reverted call, also with every receipt of it hidden; the relay never reports mined; the SDK answers unresolved', async () => {
        const sender = anvilAccount(1);
        const other = anvilAccount(12); // the relay of the other version: an EOA
        const otherWallet = createWalletClient({ account: other, chain: foundry, transport: http(stack.rpcUrl) });
        const deploy = await otherWallet.sendTransaction({ data: FORWARDER_INIT });
        const forwarder = (await stack.publicClient.waitForTransactionReceipt({ hash: deploy, pollingInterval: 50 })).contractAddress!;
        expect(await stack.publicClient.getCode({ address: forwarder })).toBe(FORWARDER_RUNTIME);
        await stack.send(sender, { address: stack.usdc, abi: mockTokenAbi, functionName: 'approve', args: [stack.transfer, 10n ** 12n] });

        // Version A for this relay (permit), version B of the same payment for the other relay (allowance), one nonce.
        const a = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: anvilAccount(11).address, amount: 1_000_000n });
        const reqA = a.body.request as TransferRequest;
        const reqB: TransferRequest = { ...reqA, fee: '20000', relay: other.address };
        const none = NO_TOKEN_AUTHORIZATION;
        const callB = encodeFunctionData({
            abi: gaslessTransferAbi,
            functionName: 'relayTransfer',
            args: [
                { token: reqB.token, from: reqB.from, to: reqB.to, amount: BigInt(reqB.amount), fee: BigInt(reqB.fee), relay: reqB.relay, deadline: BigInt(reqB.deadline) },
                await signRawRequest(sender, stack.transfer, reqB),
                { mode: AUTH_MODE_ID[none.mode], v: none.v, r: none.r, s: none.s },
            ],
        });

        await stack.setAutomine(false);
        expect(await relay.client.submitTransfer(a.body)).toEqual({ id: a.id, status: 'queued' });
        await relay.tick(); // the relay's call, in the mempool
        const [ours] = relay.server.store.listAttempts(a.id);
        // The other relay: a type-4 transaction to itself, delegating to the forwarder, which calls relayTransfer(B).
        const authorization = await otherWallet.signAuthorization({ contractAddress: forwarder, executor: 'self' });
        const theirs = await otherWallet.sendTransaction({
            authorizationList: [authorization],
            to: other.address,
            data: concat([stack.transfer, callB]),
            gas: 600_000n,
            maxFeePerGas: 3000n * 10n ** 9n,
            maxPriorityFeePerGas: 2000n * 10n ** 9n,
        });
        await stack.mine(1);
        await stack.setAutomine(true);
        const rOurs = await stack.publicClient.getTransactionReceipt({ hash: ours!.hash });
        const rTheirs = await stack.publicClient.getTransactionReceipt({ hash: theirs });
        expect((await stack.publicClient.getCode({ address: other.address }))?.startsWith('0xef0100')).toBe(true); // an EOA with a delegation
        expect(rTheirs).toMatchObject({ status: 'success', blockNumber: rOurs.blockNumber });
        expect(rTheirs.to?.toLowerCase()).toBe(other.address.toLowerCase());
        expect(rOurs).toMatchObject({ status: 'reverted' });
        expect(rTheirs.transactionIndex).toBeLessThan(rOurs.transactionIndex);

        const chain = relay.server.relay.ctx.chain;
        const q: UseQuery = {
            contract: stack.transfer,
            floor: relay.server.relay.ctx.deployBlock,
            signer: sender.address,
            nonce: BigInt(reqA.nonce),
            deadline: BigInt(reqA.deadline),
            id: a.id,
            executionOf: (call, nonce) => transferOperation.executionOf(relay.server.relay.ctx, call, nonce),
        };
        const head = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const B = rOurs.blockNumber;
        const isOurs = (hash: string) => hash.toLowerCase() === ours!.hash.toLowerCase();
        const real = { getTransactionReceipt: chain.getTransactionReceipt, getBlockReceipts: chain.getBlockReceipts };
        const getTransactionReceipt = chain.getTransactionReceipt.bind(chain);
        const getBlockReceipts = chain.getBlockReceipts!.bind(chain);
        const hiding = (inBlock: boolean): ChainClient => ({
            ...chain,
            getBlockWithTransactions: chain.getBlockWithTransactions!.bind(chain),
            getLogs: chain.getLogs!.bind(chain),
            getTransactionReceipt: (hash) => (isOurs(hash) ? Promise.resolve(null) : getTransactionReceipt(hash)),
            getBlockReceipts: async (n) => ((await getBlockReceipts(n)) ?? []).filter((r: ReceiptInfo) => !(inBlock && isOurs(r.transactionHash))),
        });
        // Served: the relay's call reverted, and nothing direct in the block used the nonce.
        expect(await findNonceUse(chain, q, head)).toMatchObject({ kind: 'unknown', why: expect.stringContaining(`nothing in block ${B}`) });
        // Only in eth_getBlockReceipts: the same.
        expect(await findNonceUse(hiding(false), q, head)).toMatchObject({ kind: 'unknown', why: expect.stringContaining(`nothing in block ${B}`) });
        // Hidden everywhere: the call is listed without a receipt, which shows nothing.
        expect(await findNonceUse(hiding(true), q, head)).toEqual({ kind: 'unknown', why: `the RPC shows the relay's call in block ${B} but serves no receipt of it`, listed: true });

        // The transaction manager, with every receipt of the call hidden on its RPC: it waits with the ALERT, never mined.
        const hidden = hiding(true);
        chain.getTransactionReceipt = hidden.getTransactionReceipt;
        chain.getBlockReceipts = hidden.getBlockReceipts;
        try {
            const statuses = new Set<string>();
            for (let i = 0; i < 12; i++) {
                await stack.mine(6);
                await relay.tick();
                statuses.add(relay.server.store.getRequest(a.id)!.status);
            }
            expect([...statuses]).toEqual(['submitted']);
            const metrics = await relay.server.relay.metrics.registry.metrics();
            expect(metrics).toContain('relay_decision_waits_total{decision="receipt"} 1');
            expect(metrics).not.toContain('event="mined_by_nonce_search"');
            expect(relay.logs.text()).toContain(`RPC #1 cannot tell how the request nonce was used: the RPC shows the relay's call in block ${B} but serves no receipt of it`);
        } finally {
            chain.getTransactionReceipt = real.getTransactionReceipt;
            chain.getBlockReceipts = real.getBlockReceipts;
        }
        // Its receipt shows again: the reverted call ends the request failed, never mined.
        await relay.tick();
        expect(await relay.state(a.id)).toMatchObject({ status: 'failed', txHash: ours!.hash });

        // The SDK reads the outcome from the chain: the nonce is used, and no direct call shows what used it.
        expect((await confirmOnChain(stack.publicClient, relay.pins, { request: reqA, authHash: tokenAuthHash(a.body.authorization as never) })).status).toBe('unresolved');
    });
});
