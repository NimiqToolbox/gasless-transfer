// The real relay (src/server.ts) against an anvil fork of a recent Polygon PoS block with the real USDC and USDT0 and a
// GaslessTransfer deployed by the mainnet deploy script: every auth mode end to end with the SDK signing over the real
// token domains, gas used vs relay/config/gasTable.json (fresh recipients, fresh relay fee slot), and the token admins
// acting on accepted requests (USDC pause and blacklist, USDT0 block list and changeName), an EIP-7702-delegated
// sender, and post-broadcast griefing with a delegation. Opt-in: VER_FORK=true and POLYGON_RPC_URL (read-only use of
// the fork RPC; no transaction leaves anvil). Quotes need a POL/USD round at most 3600 s older than the wall clock, so the
// fork block is the RPC's head minus 200 (recentForkBlock); FORK_BLOCK replaces it with a recorded block of the last hour.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, encodeFunctionData, formatEther, http, parseGwei, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { usdcAbi } from '@nimiq/gasless-sdk/core';
import { RelayClient } from '@nimiq/gasless-sdk/relay';
import { RELAY_DIR, anvilAccount } from '../integration/helpers/stack.js';
import { signTransfer, startRelay, type RunningRelay, type SignedTransfer, type TransferParams } from '../integration/helpers/relay.js';
import { artifactBytecode, callsPerRequest, keyOf, relayTxsOnChain, tick, waitFor } from './helpers/fault.js';
import {
    FORK_RECEIPT_TIMEOUT_MS,
    FORK_RPC_TIMEOUT_MS,
    POLYGON_USDC,
    POLYGON_USDT0,
    forkEnabled,
    realUsdcAbi,
    realUsdt0Abi,
    receiptOf,
    recentForkBlock,
    startForkStack,
    type ForkStack,
} from './helpers/forkStack.js';

const gasTable = JSON.parse(readFileSync(join(RELAY_DIR, 'config', 'gasTable.json'), 'utf8')) as {
    source: string;
    operations: { transfer: Record<string, number> };
};

let stack: ForkStack;
let relay: RunningRelay;

const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;
const HIGH_TIP = { maxFeePerGas: parseGwei('5000'), maxPriorityFeePerGas: parseGwei('2000') };
/** Per test: with a cold RPC cache every new account, slot and block is fetched from the public RPC through anvil. */
const FORK_TEST_TIMEOUT_MS = 900_000;
/** A transport to the fork that waits as long as the fork may need (viem's default is 10 s). */
const forkTransport = () => http(stack.rpcUrl, { timeout: FORK_RPC_TIMEOUT_MS });

function sign(p: Omit<TransferParams, 'to' | 'amount'> & Partial<Pick<TransferParams, 'to' | 'amount'>>): Promise<SignedTransfer> {
    return signTransfer(stack, relay, { to: fresh(), amount: 1_000_000n, ...p });
}

async function submitCode(t: SignedTransfer): Promise<string> {
    try {
        const res = await relay.client.submitTransfer(t.body);
        return res.status;
    } catch (err) {
        return (err as { code?: string }).code ?? String(err);
    }
}

/**
 * Broadcast, wait until anvil has mined it (fork mining fetches remote state, so automine is not instantaneous), then
 * reconcile; prints the pass errors and relay warnings if any.
 */
async function settle(t: SignedTransfer): Promise<void> {
    const errors = [await tick(relay)];
    const latest = relay.server.store.listAttempts(t.id).at(-1);
    if (latest) {
        await waitFor('receipt', () => stack.publicClient.getTransactionReceipt({ hash: latest.hash }).then(() => true, () => undefined), FORK_RECEIPT_TIMEOUT_MS, 200);
    }
    errors.push(await tick(relay));
    const failed = errors.filter((e) => e !== undefined);
    const warnings = relay.logs.lines.filter((l) => /"level":(40|50)/.test(l)).slice(-5);
    if (failed.length > 0) console.log('settle: pass errors', failed, warnings.map((w) => w.slice(0, 400)));
}

describe.skipIf(!forkEnabled())('relay E2E on a Polygon fork with the real USDC and USDT0', { timeout: FORK_TEST_TIMEOUT_MS }, () => {
    beforeAll(async () => {
        // The relay refuses a POL/USD round older than 3600 s by the wall clock, so quotes need a recent block.
        const block = await recentForkBlock();
        console.log(`forkE2E: fork block ${block}`);
        stack = await startForkStack(block);
        const started = await startRelay(stack, {
            env: {
                RELAY_RATE_LIMIT_SIGNER_MAX: '1000',
                RELAY_MAX_IN_FLIGHT: '16',
                // The fork answers from the public RPC for state it has not cached yet.
                RELAY_RPC_TIMEOUT_MS: String(FORK_RPC_TIMEOUT_MS),
            },
        });
        // The relay's quote and submit handlers read the fork too: give the client the same patience (default 15 s).
        const client = new RelayClient(started.url, { pins: started.pins, requestTimeoutMs: FORK_RPC_TIMEOUT_MS + 30_000 });
        relay = { ...started, client, state: (id) => client.getRequest(id) };
        await relay.server.relay.txManager.stop();
        for (let i = 1; i <= 9; i++) {
            await stack.fund(POLYGON_USDC, anvilAccount(i).address, 1_000_000_000n);
            await stack.fund(POLYGON_USDT0, anvilAccount(i).address, 1_000_000_000n);
        }
        console.log('fork', { block: (await stack.latestBlock()).number, transfer: stack.transfer, clearedCode: stack.clearedCode.map((c) => ({ index: c.index, code: c.code.slice(0, 48) })), gasTable });
    }, 1_800_000);

    afterAll(async () => {
        await relay?.stop().catch(() => undefined);
        await stack?.stop();
        // Evidence of the fork RPC's behaviour in this run: requests, retries by reason, give-ups (ForkUpstream).
        if (stack) console.log('fork upstream', JSON.stringify(stack.upstream));
    });

    it('every auth mode end to end on the real tokens: exact balances, allowance 0 after, gas used vs the gas table', async () => {
        const modes: Array<{ name: string; from: number; token: Address; authMode: TransferParams['authMode']; approve?: boolean }> = [
            { name: 'USDC permit', from: 1, token: POLYGON_USDC, authMode: 'permit' },
            { name: 'USDC none', from: 2, token: POLYGON_USDC, authMode: 'none', approve: true },
            { name: 'USDT0 permit', from: 3, token: POLYGON_USDT0, authMode: 'permit' },
            { name: 'USDT0 metaTxApprove', from: 4, token: POLYGON_USDT0, authMode: 'metaTxApprove' },
            { name: 'USDT0 none', from: 5, token: POLYGON_USDT0, authMode: 'none', approve: true },
        ];
        const rows: Array<Record<string, unknown>> = [];
        for (let round = 0; round < 2; round++) {
            for (const m of modes) {
                const user = anvilAccount(m.from);
                const t = await sign({ from: m.from, token: m.token, authMode: m.authMode });
                const amount = BigInt(t.body.request.amount);
                const fee = BigInt(t.body.request.fee);
                if (m.approve) await stack.send(user, { address: m.token, abi: usdcAbi as Abi, functionName: 'approve', args: [stack.transfer, amount + fee] });
                const before = await Promise.all([user.address, t.body.request.to as Address, relay.address].map((a) => stack.balanceOf(m.token, a)));
                expect(await submitCode(t)).toBe('queued');
                await settle(t);
                const state = await relay.state(t.id);
                if (state.status !== 'mined') {
                    const attempts = relay.server.store.listAttempts(t.id);
                    const onChain = await Promise.all(attempts.map((a) => stack.publicClient.getTransactionReceipt({ hash: a.hash }).then((r) => r.status, (e: unknown) => String(e).slice(0, 60))));
                    console.log('not mined', { mode: m.name, status: state.status, attempts: attempts.map((a) => ({ hash: a.hash, nonce: a.txNonce, maxFee: a.maxFeePerGas })), onChain, base: (await stack.latestBlock()).baseFeePerGas, logs: relay.logs.lines.slice(-10).map((l) => l.slice(0, 300)) });
                }
                expect(state.status).toBe('mined');
                const receipt = await stack.publicClient.getTransactionReceipt({ hash: state.txHash! });
                const after = await Promise.all([user.address, t.body.request.to as Address, relay.address].map((a) => stack.balanceOf(m.token, a)));
                expect(after).toEqual([before[0]! - amount - fee, before[1]! + amount, before[2]! + fee]);
                expect(await stack.allowance(m.token, user.address, stack.transfer)).toBe(0n);
                const table = gasTable.operations.transfer[m.authMode]!;
                const [attempt] = relay.server.store.listAttempts(t.id);
                rows.push({
                    round,
                    mode: m.name,
                    relayFeeSlotFresh: before[2] === 0n,
                    gasUsed: Number(receipt.gasUsed),
                    gasTable: table,
                    headroom: table - Number(receipt.gasUsed),
                    gasLimit: Number(attempt!.gasLimit),
                    fee: t.body.request.fee,
                });
            }
        }
        console.table(rows);
        for (const r of rows) expect(r.gasUsed as number).toBeLessThanOrEqual(r.gasTable as number);
    });

    it('USDC paused: refused at submit (token_paused); paused after acceptance → failed before any broadcast', async () => {
        const { pauser } = await stack.usdcAdmin();
        const t = await sign({ from: 6, token: POLYGON_USDC, authMode: 'permit' });
        expect(await submitCode(t)).toBe('queued');
        await stack.sendAs(pauser, { address: POLYGON_USDC, abi: realUsdcAbi as Abi, functionName: 'pause' });
        await tickUntilRevertIsFinal();
        const failed = await relay.state(t.id);
        const t2 = await sign({ from: 7, token: POLYGON_USDC, authMode: 'permit' }).catch((err: unknown) => err as Error);
        const atSubmit = t2 instanceof Error ? `prepare: ${t2.message.slice(0, 80)}` : await submitCode(t2);
        await stack.sendAs(pauser, { address: POLYGON_USDC, abi: realUsdcAbi as Abi, functionName: 'unpause' });
        const result = { afterAcceptance: failed.status, code: failed.error?.code, message: failed.error?.message, attempts: relay.server.store.listAttempts(t.id).length, atSubmit };
        console.log('USDC pause', result);
        expect(result).toMatchObject({ afterAcceptance: 'failed', attempts: 0, atSubmit: 'token_paused' });
    });

    it('a USDC permit request that fails because USDC was paused after acceptance is reported as token_paused', async () => {
        const { pauser } = await stack.usdcAdmin();
        const t = await sign({ from: 6, token: POLYGON_USDC, authMode: 'permit' });
        expect(await submitCode(t)).toBe('queued');
        await stack.sendAs(pauser, { address: POLYGON_USDC, abi: realUsdcAbi as Abi, functionName: 'pause' });
        await tickUntilRevertIsFinal();
        const state = await relay.state(t.id);
        await stack.sendAs(pauser, { address: POLYGON_USDC, abi: realUsdcAbi as Abi, functionName: 'unpause' });
        console.log('USDC paused after acceptance', { status: state.status, code: state.error?.code, message: state.error?.message });
        expect({ status: state.status, code: state.error?.code }).toEqual({ status: 'failed', code: 'token_paused' });
    });

    it('USDC blacklist: recipient refused at submit; sender blacklisted after acceptance → failed before broadcast; after broadcast → reverted on-chain', async () => {
        const { blacklister } = await stack.usdcAdmin();
        const bl = (fn: 'blacklist' | 'unBlacklist', who: Address, fees?: typeof HIGH_TIP) =>
            stack.sendAs(blacklister, { address: POLYGON_USDC, abi: realUsdcAbi as Abi, functionName: fn, args: [who] }, fees);

        const badTo = fresh();
        await bl('blacklist', badTo);
        const toBlocked = await submitCode(await sign({ from: 6, token: POLYGON_USDC, authMode: 'permit', to: badTo }));
        await bl('unBlacklist', badTo);

        const t = await sign({ from: 7, token: POLYGON_USDC, authMode: 'permit' });
        expect(await submitCode(t)).toBe('queued');
        await bl('blacklist', anvilAccount(7).address);
        await tickUntilRevertIsFinal();
        const beforeBroadcast = await relay.state(t.id);
        await bl('unBlacklist', anvilAccount(7).address);

        // After the broadcast: the blacklister's transaction is ordered first (higher tip).
        const u = await sign({ from: 8, token: POLYGON_USDC, authMode: 'permit' });
        expect(await submitCode(u)).toBe('queued');
        await stack.setAutomine(false);
        await tick(relay);
        await bl('blacklist', anvilAccount(8).address, HIGH_TIP);
        await stack.mine();
        await stack.setAutomine(true);
        await tick(relay);
        const afterBroadcast = await relay.state(u.id);
        const [call] = relay.server.store.listAttempts(u.id);
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: call!.hash });
        await bl('unBlacklist', anvilAccount(8).address);
        const result = {
            toBlocked,
            beforeBroadcast: { status: beforeBroadcast.status, code: beforeBroadcast.error?.code, attempts: relay.server.store.listAttempts(t.id).length },
            afterBroadcast: { status: afterBroadcast.status, code: afterBroadcast.error?.code, onChain: receipt.status, relayGasUsed: receipt.gasUsed, relayCostPol: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) },
        };
        console.log('USDC blacklist', result);
        expect(result.toBlocked).toBe('blocked_address');
        expect(result.beforeBroadcast).toMatchObject({ status: 'failed', attempts: 0 });
        expect(result.afterBroadcast).toMatchObject({ status: 'failed', onChain: 'reverted' });
    });

    it('USDT0 block list: sender refused at submit; blocked after acceptance → failed before broadcast; a blocked recipient is not checked by USDT0', async () => {
        const admin = await stack.usdt0Admin();
        const blk = (fn: 'addToBlockedList' | 'removeFromBlockedList', who: Address) =>
            stack.sendAs(admin, { address: POLYGON_USDT0, abi: realUsdt0Abi as Abi, functionName: fn, args: [who] });

        await blk('addToBlockedList', anvilAccount(6).address);
        const senderAtSubmit = await submitCode(await sign({ from: 6, token: POLYGON_USDT0, authMode: 'permit' }));
        await blk('removeFromBlockedList', anvilAccount(6).address);

        const t = await sign({ from: 7, token: POLYGON_USDT0, authMode: 'metaTxApprove' });
        expect(await submitCode(t)).toBe('queued');
        await blk('addToBlockedList', anvilAccount(7).address);
        await tickUntilRevertIsFinal();
        const afterAcceptance = await relay.state(t.id);
        await blk('removeFromBlockedList', anvilAccount(7).address);

        const blockedTo = fresh();
        await blk('addToBlockedList', blockedTo);
        const r = await sign({ from: 9, token: POLYGON_USDT0, authMode: 'permit', to: blockedTo });
        const recipientAtSubmit = await submitCode(r);
        if (recipientAtSubmit === 'queued') await settle(r);
        const recipientFinal = recipientAtSubmit === 'queued' ? (await relay.state(r.id)).status : null;
        const blockedToBalance = await stack.balanceOf(POLYGON_USDT0, blockedTo);
        await blk('removeFromBlockedList', blockedTo);
        const result = {
            senderAtSubmit,
            afterAcceptance: { status: afterAcceptance.status, code: afterAcceptance.error?.code, attempts: relay.server.store.listAttempts(t.id).length },
            recipientAtSubmit,
            recipientFinal,
            blockedToBalance,
        };
        console.log('USDT0 block list', result);
        expect(result.senderAtSubmit).toBe('blocked_address');
        expect(result.afterAcceptance).toMatchObject({ status: 'failed', attempts: 0 });
        // USDT0 does not check the recipient against its block list: the transfer to a blocked recipient is mined.
        expect({ recipientAtSubmit, recipientFinal, blockedToBalance }).toEqual({ recipientAtSubmit: 'queued', recipientFinal: 'mined', blockedToBalance: BigInt(r.body.request.amount) });
    });

    it('USDT0 changeName after acceptance: the META_TX request fails; renaming back revives the purged META_TX approval for anyone holding it', async () => {
        const admin = await stack.usdt0Admin();
        const user = anvilAccount(5);
        const t = await sign({ from: 5, token: POLYGON_USDT0, authMode: 'metaTxApprove', amount: 3_000_000n });
        const auth = t.body.authorization as { mode: 'metaTxApprove'; v: number; r: Hex; s: Hex };
        expect(await submitCode(t)).toBe('queued');
        await stack.sendAs(admin, { address: POLYGON_USDT0, abi: realUsdt0Abi as Abi, functionName: 'changeName', args: ['USDT0 v2'] });
        await tickUntilRevertIsFinal();
        const afterRename = await relay.state(t.id);
        const record = relay.server.store.getRequest(t.id)!;
        const newRequest = await sign({ from: 6, token: POLYGON_USDT0, authMode: 'metaTxApprove' }).catch((err: unknown) => err as Error);
        const newAtSubmit = newRequest instanceof Error ? `prepare: ${newRequest.message.slice(0, 100)}` : await submitCode(newRequest);
        await stack.sendAs(admin, { address: POLYGON_USDT0, abi: realUsdt0Abi as Abi, functionName: 'changeName', args: ['USDT0'] });

        // The request is "failed" and its authorization purged (from the SQLite files too); a copy
        // taken before the purge (a backup, a volume snapshot) still executes.
        const functionSignature = encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [stack.transfer, BigInt(t.body.request.amount) + BigInt(t.body.request.fee)] });
        const outsider = anvilAccount(15);
        const wallet = createWalletClient({ account: outsider, chain: stack.chain, transport: forkTransport() });
        const replay = await wallet
            .writeContract({ address: POLYGON_USDT0, abi: realUsdt0Abi, functionName: 'executeMetaTransaction', args: [user.address, functionSignature, auth.r, auth.s, auth.v] })
            .then(async (hash) => (await receiptOf(stack.publicClient, hash)).status)
            .catch((err: unknown) => `error: ${String(err).slice(0, 80)}`);
        const result = {
            afterRename: { status: afterRename.status, code: afterRename.error?.code, message: afterRename.error?.message?.slice(0, 100), purged: record.authorization === null },
            newAtSubmit,
            replayAfterRestore: replay,
            allowanceAfterReplay: await stack.allowance(POLYGON_USDT0, user.address, stack.transfer),
        };
        console.log('USDT0 changeName', result);
        expect(result.afterRename).toMatchObject({ status: 'failed', purged: true });
        expect(result.replayAfterRestore).toBe('success');
        expect(result.allowanceAfterReplay).toBe(BigInt(t.body.request.amount) + BigInt(t.body.request.fee));
        await stack.send(user, { address: POLYGON_USDT0, abi: usdcAbi as Abi, functionName: 'approve', args: [stack.transfer, 0n] });
    });

    it('EIP-7702-delegated sender: the relay refuses a USDC permit signed before the delegation, the SDK refuses to build one; NONE mode is relayed and mined', async () => {
        const user = anvilAccount(9);
        // Signed while the account is a plain EOA, submitted after it delegated (the relay's own check).
        const signedBefore = await sign({ from: 9, token: POLYGON_USDC, authMode: 'permit' });
        const deployer = createWalletClient({ account: anvilAccount(0), chain: stack.chain, transport: forkTransport() });
        const hash = await deployer.deployContract({ abi: [], bytecode: artifactBytecode('Eip7702.t.sol', 'VfBatchDelegate') });
        const delegate = (await receiptOf(stack.publicClient, hash)).contractAddress!;
        const wallet = createWalletClient({ account: user, chain: stack.chain, transport: forkTransport() });
        const authorization = await wallet.signAuthorization({ account: user, contractAddress: delegate, executor: 'self' });
        await receiptOf(stack.publicClient, await wallet.sendTransaction({ authorizationList: [authorization], to: anvilAccount(15).address, value: 0n, gas: 100_000n }));
        const code = await stack.publicClient.getCode({ address: user.address });

        const permitAtSubmit = await submitCode(signedBefore);
        const sdkPermit = await sign({ from: 9, token: POLYGON_USDC, authMode: 'permit' }).catch((err: unknown) => err as Error);
        const sdkAnswer = sdkPermit instanceof Error ? `sdk: ${(sdkPermit as { code?: string }).code ?? sdkPermit.message.slice(0, 80)}` : 'built';
        const none = await sign({ from: 9, token: POLYGON_USDC, authMode: 'none' });
        await stack.send(user, { address: POLYGON_USDC, abi: usdcAbi as Abi, functionName: 'approve', args: [stack.transfer, BigInt(none.body.request.amount) + BigInt(none.body.request.fee)] });
        const noneAtSubmit = await submitCode(none);
        await settle(none);
        const result = { code: code?.slice(0, 8), permitAtSubmit, sdkAnswer, noneAtSubmit, noneFinal: (await relay.state(none.id)).status };
        console.log('EIP-7702 sender', result);
        expect(result.code).toBe('0xef0100');
        expect(result.noneFinal).toBe('mined');
        expect(result.permitAtSubmit).not.toBe('queued');
        expect(result.sdkAnswer).not.toBe('built');
        expect({ permitAtSubmit: result.permitAtSubmit, sdkAnswer: result.sdkAnswer, noneAtSubmit: result.noneAtSubmit }).toEqual({
            permitAtSubmit: 'invalid_token_authorization',
            sdkAnswer: 'sdk: eip7702_permit_unsupported',
            noneAtSubmit: 'queued',
        });
    });

    it('on the real USDC: after a delegation to a gas burner following the broadcast, the call fails on-chain within a gas limit the gas table caps, and is counted', async () => {
        // A sender of its own: account 8's request of the blacklist test reverted on-chain and holds its intent nonce
        // until that outcome is final (one pending request per sender; sender_busy nonce_unsettled).
        const user = anvilAccount(12);
        await stack.fund(POLYGON_USDC, user.address, 1_000_000_000n);
        const deployer = createWalletClient({ account: anvilAccount(0), chain: stack.chain, transport: forkTransport() });
        const deployHash = await deployer.deployContract({ abi: [], bytecode: artifactBytecode('Eip7702.t.sol', 'VfGasBurnerDelegate') });
        const burner = (await receiptOf(stack.publicClient, deployHash)).contractAddress!;
        const t = await sign({ from: 12, token: POLYGON_USDC, authMode: 'permit' });
        expect(await submitCode(t)).toBe('queued');
        const revertedBefore = await revertedCalls();
        await stack.setAutomine(false);
        await tick(relay);
        const [call] = relay.server.store.listAttempts(t.id);
        const wallet = createWalletClient({ account: user, chain: stack.chain, transport: forkTransport() });
        const authorization = await wallet.signAuthorization({ account: user, contractAddress: burner, executor: 'self' });
        const attackHash = await wallet.sendTransaction({ authorizationList: [authorization], to: anvilAccount(15).address, value: 0n, gas: 100_000n, ...HIGH_TIP });
        await stack.mine();
        await stack.setAutomine(true);
        await tick(relay);
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: call!.hash });
        const attack = await stack.publicClient.getTransactionReceipt({ hash: attackHash });
        const perRequest = callsPerRequest(await relayTxsOnChain(stack, relay.address, receipt.blockNumber));
        const result = {
            status: (await relay.state(t.id)).status,
            gasTable: gasTable.operations.transfer.permit,
            gasLimit: call!.gasLimit,
            relayGasUsed: receipt.gasUsed,
            attackerGasUsed: attack.gasUsed,
            ratio: Number(receipt.gasUsed) / Number(attack.gasUsed),
            calls: perRequest.get(keyOf(t)),
        };
        console.log('gas burner delegation (real USDC via relay)', result);
        // After the broadcast the relay cannot stop the delegation. What bounds the loss: the gas limit is
        // min(estimate × 1.3, gas table), gas limit × maxFeePerGas stays within the request's spend cap, and the
        // reverted call is counted.
        expect(result.status).toBe('failed');
        expect(call!.gasLimit).toBeLessThanOrEqual(BigInt(gasTable.operations.transfer.permit!));
        expect(receipt.gasUsed).toBeLessThanOrEqual(call!.gasLimit);
        expect(await revertedCalls()).toBe(revertedBefore + 1);
    });
});

/**
 * One pass, then two more blocks with a pass each. A revert in the checks before
 * the broadcast fails a request only when it is simulated on a head at least as new as the acceptance (block
 * timestamp vs the relay's clock) or when it is still there two blocks later. The fork's block timestamps are far
 * behind the wall clock, so here the second rule applies: the request still fails before any broadcast, two blocks
 * later.
 */
async function tickUntilRevertIsFinal(): Promise<void> {
    await tick(relay);
    for (let i = 0; i < 2; i++) {
        await stack.mine();
        await tick(relay);
    }
}

/** relay_requests_reverted_onchain_total{operation="transfer"} of the running relay. */
async function revertedCalls(): Promise<number> {
    const text = await relay.server.relay.metrics.registry.metrics();
    const match = /^relay_requests_reverted_onchain_total\{operation="transfer"\} (\d+)$/m.exec(text);
    return match ? Number(match[1]) : 0;
}
