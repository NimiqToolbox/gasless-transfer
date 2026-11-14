// Operational evidence: actual top-level transactions, not an in-process gasleft() model.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, encodeFunctionData, http, parseEther, parseEventLogs, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AUTH_MODE_ID, gaslessTransferAbi, usdcAbi, type AuthModeName } from '@nimiq/gasless-sdk/core';
import { prepareTransfer, signPrepared } from '@nimiq/gasless-sdk/viem';
import { callGasLimit } from '../../src/tx/policy.js';
import { CONTRACTS_DIR, RELAY_DIR, anvilAccount } from '../integration/helpers/stack.js';
import { forkEnabled, startForkStack, receiptOf, realUsdt0Abi, type ForkStack } from './helpers/forkStack.js';

const table = JSON.parse(readFileSync(join(RELAY_DIR, 'config/gasTable.json'), 'utf8')).operations.transfer as Record<AuthModeName, number>;
const zero = `0x${'00'.repeat(32)}` as Hex;
// Tools run without blocking this process: ForkUpstream, which serves anvil's reads of the fork RPC, runs in it. A
// synchronous run leaves anvil without answers, and the deployment verifier's calls to the fork time out.
const execFileAsync = promisify(execFile);
let stack: ForkStack;
const deployed = process.env.DEPLOYMENT_ADDRESS as Address | undefined;
function existingDeployment(): Record<string, unknown> | undefined {
    if (!deployed) return undefined;
    return { chainId: 137, version: '3', gaslessTransfer: deployed, deployBlock: process.env.FORK_BLOCK,
        tokens: [
            { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, authModes: ['permit', 'none'], domain: { name: 'USD Coin', version: '2', chainId: 137, verifyingContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' } },
            { symbol: 'USDT0', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, authModes: ['permit', 'metaTxApprove', 'none'], domain: { name: 'USDT0', version: '1', salt: toHex(137n, { size: 32 }), verifyingContract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' } },
        ] };
}
describe.skipIf(!forkEnabled() || !process.env.FORK_BLOCK)('top-level transaction gas and deployment attestation', () => {
    beforeAll(async () => {
        if (!process.env.FORK_BLOCK) throw new Error('FORK_BLOCK must record the chosen finalized block');
        stack = await startForkStack(BigInt(process.env.FORK_BLOCK), existingDeployment());
    }, 900_000);
    afterAll(async () => { await stack?.stop(); });

    it('attests the selected deployment against full runtime including every immutable', async () => {
        await execFileAsync('forge', ['build', '--ast'], { cwd: CONTRACTS_DIR, maxBuffer: 64 * 1024 * 1024 });
        if (deployed) {
            expect(process.env.DEPLOYMENT_TX_HASH).toMatch(/^0x[0-9a-f]{64}$/i);
            const { stdout: output } = await execFileAsync(process.execPath, ['scripts/verify-deployment.mjs', deployed, process.env.DEPLOYMENT_TX_HASH!, '../contracts/out', process.env.FORK_BLOCK!], {
                cwd: RELAY_DIR, env: { ...process.env, POLYGON_VERIFY_RPC_URL: '' }, encoding: 'utf8', timeout: 180_000,
            });
            expect(JSON.parse(output).verified).toBe(true);
            expect(JSON.parse(output).address).toBe(stack.transfer);
            console.log('MAINNET_ATTESTATION', JSON.stringify(JSON.parse(output)));
            return;
        }
        const broadcast = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'broadcast/DeployGaslessTransfer.s.sol/137/run-latest.json'), 'utf8'));
        const creation = broadcast.transactions.find((tx: { transactionType: string }) => tx.transactionType === 'CREATE');
        expect(creation).toBeDefined();
        await stack.mine(64);
        // The fork stack deploys with its admin account (anvil account 0) as the initial owner.
        const { stdout: output } = await execFileAsync(process.execPath, ['scripts/verify-deployment.mjs', stack.transfer, creation.hash], {
            cwd: RELAY_DIR, env: { ...process.env, POLYGON_RPC_URL: stack.rpcUrl, POLYGON_VERIFY_RPC_URL: '', GASLESS_TRANSFER_OWNER: anvilAccount(0).address, GASLESS_TRANSFER_CURRENT_OWNER: '' },
            encoding: 'utf8', timeout: 120_000,
        });
        expect(JSON.parse(output).verified).toBe(true);
        console.log('LOCAL_ATTESTATION', JSON.stringify(JSON.parse(output)));
    }, 180_000);

    it('measures all five routes with fresh, reused, and front-run authorization state', async () => {
        const routes: Array<{ token: Address; mode: AuthModeName; name: string }> = [
            { token: stack.usdc, mode: 'permit', name: 'USDC permit' }, { token: stack.usdc, mode: 'none', name: 'USDC allowance' },
            { token: stack.usdt0, mode: 'permit', name: 'USDT0 permit' }, { token: stack.usdt0, mode: 'metaTxApprove', name: 'USDT0 meta-approval' },
            { token: stack.usdt0, mode: 'none', name: 'USDT0 allowance' },
        ];
        for (const route of routes) {
            const user = privateKeyToAccount(generatePrivateKey());
            const relay = privateKeyToAccount(generatePrivateKey());
            const recipient = privateKeyToAccount(generatePrivateKey()).address;
            await stack.fund(route.token, user.address, 1000_000_000n);
            await stack.testClient.setBalance({ address: relay.address, value: parseEther('100') });
            const wallet = createWalletClient({ account: relay, chain: stack.chain, transport: http(stack.rpcUrl, { timeout: 120_000 }) });
            const pins = stack.pins([relay.address]);
            for (const phase of ['fresh', 'reused', 'front-run'] as const) {
                if (phase === 'front-run' && route.mode === 'none') continue;
                const amount = 100_000_000n; const fee = 20_000n;
                if (route.mode === 'none') await stack.sendAs(user.address, { address: route.token, abi: usdcAbi, functionName: 'approve', args: [stack.transfer, amount + fee] });
                const now = Number((await stack.latestBlock()).timestamp);
                const prepared = await prepareTransfer(stack.publicClient, pins, { token: route.token, from: user.address, to: recipient, amount, fee, relay: relay.address, authMode: route.mode, now });
                const signed = await signPrepared(user, prepared, pins, { now });
                const r = signed.request; const a = signed.authorization;
                // The call carries no intent nonce (the contract signs over nonces(from)), and the
                // signed token authorization is part of the digest.
                const call = { token: r.token, from: r.from, to: r.to, amount: BigInt(r.amount), fee: BigInt(r.fee), relay: r.relay, deadline: BigInt(r.deadline) };
                const auth = { mode: AUTH_MODE_ID[a.mode], v: a.v, r: a.r, s: a.s };
                const nonces = () => stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'nonces', args: [user.address] });
                if (a.mode === 'none') expect(auth).toEqual({ mode: 0, v: 0, r: zero, s: zero });
                if (phase === 'front-run' && a.mode !== 'none') {
                    if (a.mode === 'permit') await stack.sendAs(relay.address, { address: route.token, abi: usdcAbi, functionName: 'permit', args: [user.address, stack.transfer, amount + fee, BigInt(r.deadline), a.v, a.r, a.s] });
                    else await stack.sendAs(relay.address, { address: route.token, abi: realUsdt0Abi, functionName: 'executeMetaTransaction', args: [user.address, encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [stack.transfer, amount + fee] }), a.r, a.s, a.v] });
                }
                const data = encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'relayTransfer', args: [call, signed.signature, auth] });
                const before = await Promise.all([user.address, recipient, relay.address].map(owner => stack.balanceOf(route.token, owner)));
                expect(await stack.publicClient.readContract({ address: stack.transfer, abi: gaslessTransferAbi, functionName: 'hashTransfer', args: [call, BigInt(r.nonce), auth] })).toBe(signed.id);
                await expect(stack.publicClient.call({ account: recipient, to: stack.transfer, data })).rejects.toThrow();
                const tampered = encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'relayTransfer', args: [{ ...call, fee: call.fee + 1n }, signed.signature, auth] });
                await expect(stack.publicClient.call({ account: relay.address, to: stack.transfer, data: tampered })).rejects.toThrow();
                expect(await nonces()).toBe(BigInt(r.nonce));
                const estimate = await stack.publicClient.estimateGas({ account: relay.address, to: stack.transfer, data });
                // Optional Polygon-native gas schedule, with only ephemeral state overrides. No live writes.
                // The local deployment and token-admin preparation above provide the storage, instead of
                // guessing token mapping slots. Token code and issuer implementation slots remain unchanged.
                if (process.env.POLYGON_NATIVE_GAS === 'true') {
                    const block = toHex(BigInt(process.env.FORK_BLOCK!));
                    const remote = async (method: 'eth_call' | 'eth_estimateGas' | 'eth_getBlockByNumber' | 'eth_getCode', params: unknown[]) => {
                        let response;
                        try {
                            response = await fetch(process.env.POLYGON_RPC_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
                        } catch { throw new Error(`Polygon transport failed: ${method}`); }
                        if (!response.ok) throw new Error(`Polygon HTTP ${response.status}`);
                        const body = await response.json() as { id: number; result?: unknown; error?: unknown };
                        expect(body.id).toBe(1);
                        if (body.error || body.result === undefined) throw new Error(`Polygon rejected ${method}`);
                        return body.result;
                    };
                    const finalized = await remote('eth_getBlockByNumber', ['finalized', false]) as { number: Hex };
                    expect(BigInt(block)).toBeLessThanOrEqual(BigInt(finalized.number));
                    const anchor = await remote('eth_getBlockByNumber', [block, false]) as { hash: Hex };
                    const originalCode = await remote('eth_getCode', [stack.transfer, block]);
                    if (!deployed) expect(originalCode).toBe('0x');
                    else expect(originalCode).toBe(await stack.publicClient.getCode({ address: stack.transfer }));
                    expect(await remote('eth_getCode', [user.address, block])).toBe('0x');
                    const dump = Buffer.from((await stack.testClient.dumpState()).slice(2), 'hex');
                    const state = JSON.parse((dump[0] === 0x1f && dump[1] === 0x8b ? gunzipSync(dump) : dump).toString()) as { accounts: Record<string, { code: Hex; storage: Record<Hex, Hex> }> };
                    const contractState = state.accounts[stack.transfer.toLowerCase()];
                    const tokenState = state.accounts[route.token.toLowerCase()];
                    // A pre-existing deployment with no local writes is absent from Anvil's dump.
                    // Keep its actual chain code/configuration; override only locally changed nonce state.
                    if (!deployed) expect(contractState).toBeDefined();
                    expect(tokenState).toBeDefined();
                    const overrides = {
                        ...(!deployed ? { [stack.transfer]: { code: contractState!.code, stateDiff: contractState!.storage } }
                            : contractState ? { [stack.transfer]: { stateDiff: contractState.storage } } : {}),
                        [route.token]: { stateDiff: tokenState!.storage },
                        [relay.address]: { balance: toHex(parseEther('100')) },
                    };
                    // Same exposed token state and intent nonce as the locally prepared operation.
                    const queries = [
                        ...[user.address, recipient, relay.address].map(owner => ({ to: route.token, data: encodeFunctionData({ abi: usdcAbi, functionName: 'balanceOf', args: [owner] }) })),
                        { to: route.token, data: encodeFunctionData({ abi: usdcAbi, functionName: 'allowance', args: [user.address, stack.transfer] }) },
                        { to: stack.transfer, data: encodeFunctionData({ abi: gaslessTransferAbi, functionName: 'nonces', args: [user.address] }) },
                    ];
                    for (const query of queries) {
                        const local = await stack.publicClient.call(query);
                        expect(await remote('eth_call', [query, block, overrides])).toBe(local.data);
                    }
                    const tx = { from: relay.address, to: stack.transfer, data, value: '0x0' };
                    const polygonEstimate = BigInt(await remote('eth_estimateGas', [tx, block, overrides]) as Hex);
                    const recommended = (polygonEstimate * 110n + 99n) / 100n;
                    expect(recommended).toBeLessThanOrEqual(300_000n);
                    expect(BigInt(table[route.mode])).toBeGreaterThanOrEqual(recommended);
                    expect(await remote('eth_call', [{ ...tx, gas: toHex(recommended) }, block, overrides])).toBe('0x');
                    expect(await remote('eth_call', [{ ...tx, gas: toHex(BigInt(table[route.mode])) }, block, overrides])).toBe('0x');
                    expect((await remote('eth_getBlockByNumber', [block, false]) as { hash: Hex }).hash).toBe(anchor.hash);
                    console.log('POLYGON_GAS_EVIDENCE', JSON.stringify({ route: route.name, mode: route.mode, phase, block, blockHash: anchor.hash, localEstimate: String(estimate), polygonEstimate: String(polygonEstimate), recommended: String(recommended), providerCount: 1, stateOverrideSimulation: true, call: tx, overrides }));
                }
                const decision = callGasLimit({ estimate, table: BigInt(table[route.mode]), maxGasLimit: 300_000n, marginPercent: 30 });
                const snapshot = await stack.testClient.snapshot();
                const run = async (gas: bigint) => {
                    const hash = await wallet.sendTransaction({ to: stack.transfer, data, gas, maxFeePerGas: 5_000_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
                    return receiptOf(stack.publicClient, hash);
                };
                const capped = await run(BigInt(table[route.mode]));
                expect(capped.status).toBe('success');
                if (capped.status === 'reverted') {
                    expect(await Promise.all([user.address, recipient, relay.address].map(owner => stack.balanceOf(route.token, owner)))).toEqual(before);
                    expect(await nonces()).toBe(BigInt(r.nonce));
                }
                await stack.testClient.revert({ id: snapshot });
                const bounded = await run(300_000n);
                expect(bounded.status).toBe('success');
                expect(await Promise.all([user.address, recipient, relay.address].map(owner => stack.balanceOf(route.token, owner)))).toEqual([before[0]! - amount - fee, before[1]! + amount, before[2]! + fee]);
                expect(await stack.allowance(route.token, user.address, stack.transfer)).toBe(0n);
                expect(await nonces()).toBe(BigInt(r.nonce) + 1n);
                await expect(stack.publicClient.call({ account: relay.address, to: stack.transfer, data })).rejects.toThrow();
                const transfers = parseEventLogs({ abi: usdcAbi, eventName: 'Transfer', logs: bounded.logs, strict: true });
                expect(transfers.map(log => [log.args.from.toLowerCase(), log.args.to.toLowerCase(), log.args.value])).toEqual([
                    [user.address.toLowerCase(), relay.address.toLowerCase(), fee], [user.address.toLowerCase(), recipient.toLowerCase(), amount],
                ]);
                // No event of GaslessTransfer: the relay recognizes an execution by the token's Transfer(from, to, amount)
                // in its call (USDT0 also logs an Approval after it).
                expect(bounded.logs.filter(log => log.address.toLowerCase() === stack.transfer.toLowerCase())).toEqual([]);
                console.log('GAS_EVIDENCE', JSON.stringify({ route: route.name, phase, contract: stack.transfer, existingMainnetDeployment: Boolean(deployed), forkBlock: process.env.FORK_BLOCK, digestVerified: true, balanceDeltasVerified: true, feeFirstTransferVerified: true, noContractEvent: true, replayRejected: true, wrongRelayRejected: true, changedFeeRejected: true, estimate: String(estimate), tableCap: table[route.mode], admitted: decision.ok, cappedStatus: capped.status, cappedGasUsed: String(capped.gasUsed), boundedGasUsed: String(bounded.gasUsed), boundedLimit: 300_000 }));
            }
        }
    }, 1_800_000);
});
