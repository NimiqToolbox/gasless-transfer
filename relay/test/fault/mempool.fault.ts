// Mempool faults against the transaction manager: dropped cancels and speed-ups, a stuck lower nonce, a broadcast
// that every node rejects, the deadline race between a call and its cancel, a fee cap that prevents the cancel, and
// the relay's cost under base-fee and tip spikes (what one accepted request can cost at most).
import { afterEach, describe, expect, it } from 'vitest';
import { formatEther, formatGwei, parseGwei, parseTransaction, type Hex } from 'viem';
import { method } from './helpers/rpcProxy.js';
import {
    RECIPIENT,
    callsPerRequest,
    expectCleanNonces,
    inMempool,
    intentNonceUsed,
    keyOf,
    mineAndTick,
    relayNonces,
    relayTxsOnChain,
    requestKeyOf,
    sendRaw,
    signTransfer,
    startFaultEnv,
    status,
    submit,
    tick,
    type FaultEnv,
    type SignedTransfer,
} from './helpers/fault.js';

let env: FaultEnv | undefined;

afterEach(async () => {
    await env?.stop();
    env = undefined;
});

/** The intent nonce of `t` is used (executed or invalidated). */
const nonceUsed = (e: FaultEnv, t: SignedTransfer): Promise<boolean> => intentNonceUsed(e.stack, t);

describe('dropped transactions', () => {
    it('a dropped cancel is re-sent; the request ends expired and the cancel takes the nonce', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const a = await signTransfer(stack, relay, { from: 1, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n, deadlineSeconds: 90 });
        await submit(relay, a);
        await tick(relay);
        const [call] = relay.server.store.listAttempts(a.id);
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: call!.maxFeePerGas * 3n });
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(a.body.request.deadline) - 2n });
        await stack.mine();
        await tick(relay);
        const [, cancel] = relay.server.store.listAttempts(a.id);
        expect(cancel?.kind).toBe('cancel');
        await stack.testClient.dropTransaction({ hash: cancel!.hash });
        await tick(relay);
        const resent = await inMempool(stack, cancel!.hash);
        await mineAndTick(env, 2, parseGwei('1'));
        const txs = await relayTxsOnChain(stack, relay.address, block0 + 1n);
        const result = { resent, status: await status(relay, a.id), atNonce: txs.find((t) => t.nonce === call!.txNonce)?.to?.toLowerCase(), executed: await nonceUsed(env, a) };
        console.log('dropped cancel', result);
        expect(result).toEqual({ resent: true, status: 'expired', atNonce: relay.address.toLowerCase(), executed: false });
        await expectCleanNonces(env, block0 + 1n);
    });

    it('a dropped speed-up is re-sent (the latest attempt, not the original call)', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const a = await signTransfer(stack, relay, { from: 2, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        const [call] = relay.server.store.listAttempts(a.id);
        const high = call!.maxFeePerGas * 2n;
        // Priced out for 10 blocks → speed-up (stop right after it is sent, before a block includes it).
        for (let i = 0; i < 15 && relay.server.store.listAttempts(a.id).length < 2; i++) await mineAndTick(env, 1, high);
        const attempts = relay.server.store.listAttempts(a.id);
        const speedUp = attempts.at(-1)!;
        expect(speedUp.hash).not.toBe(call!.hash);
        const before = { speedUpInPool: await inMempool(stack, speedUp.hash), sends: env.proxy.rawTransactions().filter((r) => r === speedUp.raw).length };
        await stack.testClient.dropTransaction({ hash: speedUp.hash });
        const dropped = { speedUpInPool: await inMempool(stack, speedUp.hash), chain: await relayNonces(stack, relay.address) };
        const tickError = await tick(relay);
        const resent = {
            speedUp: await inMempool(stack, speedUp.hash),
            original: await inMempool(stack, call!.hash),
            sends: env.proxy.rawTransactions().filter((r) => r === speedUp.raw).length,
            tickError,
        };
        console.log('dropped speed-up (diagnostics)', { before, dropped, resent });
        await mineAndTick(env, 2, high);
        const state = await relay.state(a.id);
        const calls = callsPerRequest(await relayTxsOnChain(stack, relay.address, block0 + 1n)).get(keyOf(a));
        console.log('dropped speed-up', { attempts: attempts.map((x) => ({ kind: x.kind, maxFee: formatGwei(x.maxFeePerGas) })), resent, status: state.status, calls });
        expect({ resent: resent.speedUp, status: state.status, txHash: state.txHash, calls }).toEqual({ resent: true, status: 'mined', txHash: speedUp.hash, calls: ['success'] });
        await expectCleanNonces(env, block0 + 1n);
    });
});

describe('nonce order', () => {
    it('a stuck lower nonce (priced out) holds the two later transactions until it is sped up; then all three are mined once', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const a = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        const [aCall] = relay.server.store.listAttempts(a.id);
        const high = aCall!.maxFeePerGas * 2n;
        await mineAndTick(env, 1, high);
        // b and c are priced at the new market (2 × base + tip) but wait behind a's nonce.
        const b = await signTransfer(stack, relay, { from: 4, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        const c = await signTransfer(stack, relay, { from: 5, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, b);
        await submit(relay, c);
        await tick(relay);
        let blocksUntilMined = 0;
        for (; blocksUntilMined < 20; blocksUntilMined++) {
            const s = [await status(relay, a.id), await status(relay, b.id), await status(relay, c.id)];
            if (s.every((x) => x === 'mined')) break;
            await mineAndTick(env, 1, high);
        }
        const perRequest = callsPerRequest(await relayTxsOnChain(stack, relay.address, block0 + 1n));
        const result = {
            blocksUntilMined,
            statuses: [await status(relay, a.id), await status(relay, b.id), await status(relay, c.id)],
            calls: [perRequest.get(keyOf(a)), perRequest.get(keyOf(b)), perRequest.get(keyOf(c))],
            attempts: [a, b, c].map((t) => relay.server.store.listAttempts(t.id).length),
        };
        console.log('stuck lower nonce', result);
        expect(result.statuses).toEqual(['mined', 'mined', 'mined']);
        expect(result.calls).toEqual([['success'], ['success'], ['success']]);
        await expectCleanNonces(env, block0 + 1n);
    });

    it('a call every node rejects holds the later nonces until its deadline; its cancel fills the nonce and the later requests are mined', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const a = await signTransfer(stack, relay, { from: 6, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n, deadlineSeconds: 120 });
        proxy.add({
            name: 'reject-a',
            match: method('eth_sendRawTransaction', (p) => {
                const tx = parseTransaction(p[0] as Hex);
                return tx.data !== undefined && requestKeyOf(tx.data) === keyOf(a);
            }),
            before: () => ({ kind: 'answer', answer: { error: { code: -32000, message: 'exceeds block gas limit' } } }),
        });
        await submit(relay, a);
        await tick(relay);
        const b = await signTransfer(stack, relay, { from: 7, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n });
        const c = await signTransfer(stack, relay, { from: 8, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, b);
        await submit(relay, c);
        await tick(relay);
        await mineAndTick(env, 12);
        const beforeDeadline = { a: await status(relay, a.id), b: await status(relay, b.id), c: await status(relay, c.id), chain: await relayNonces(stack, relay.address) };
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(a.body.request.deadline) - 2n });
        await mineAndTick(env, 3);
        const perRequest = callsPerRequest(await relayTxsOnChain(stack, relay.address, block0 + 1n));
        const after = {
            a: await status(relay, a.id),
            b: await status(relay, b.id),
            c: await status(relay, c.id),
            bCalls: perRequest.get(keyOf(b)),
            cCalls: perRequest.get(keyOf(c)),
            rejectedBroadcasts: proxy.calls.filter((x) => x.rule === 'reject-a').length,
        };
        console.log('rejected broadcast', { beforeDeadline, after });
        expect(beforeDeadline).toMatchObject({ a: 'submitted', b: 'submitted', c: 'submitted' });
        expect(after).toMatchObject({ a: 'expired', b: 'mined', c: 'mined', bCalls: ['success'], cCalls: ['success'] });
        await expectCleanNonces(env, block0 + 1n);
    });
});

describe('deadline passed while pending', () => {
    it('race: the relay cancels, but the original call takes the nonce first → mined (the transfer executed)', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const a = await signTransfer(stack, relay, { from: 1, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n, deadlineSeconds: 90 });
        await submit(relay, a);
        await tick(relay);
        const [call] = relay.server.store.listAttempts(a.id);
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: call!.maxFeePerGas * 3n });
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(a.body.request.deadline) - 2n });
        await stack.mine();
        await tick(relay);
        const [, cancel] = relay.server.store.listAttempts(a.id);
        expect(cancel?.kind).toBe('cancel');
        // Another node still had the call: it is included instead of the cancel.
        await stack.testClient.dropTransaction({ hash: cancel!.hash });
        await stack.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('1') });
        await sendRaw(stack, call!.raw as Hex);
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(a.body.request.deadline) - 1n });
        await stack.mine();
        await tick(relay);
        const state = await relay.state(a.id);
        console.log('call wins the race', { status: state.status, txHash: state.txHash, executed: await nonceUsed(env, a) });
        expect({ status: state.status, txHash: state.txHash, executed: await nonceUsed(env, a) }).toEqual({ status: 'mined', txHash: call!.hash, executed: true });
    });

    it('the fee cap prevents the cancel: the call is mined after the deadline and reverts; expired, the relay pays one reverted call', async () => {
        env = await startFaultEnv({ env: { RELAY_MAX_FEE_PER_GAS_GWEI: '40' } });
        const { stack, relay } = env;
        const block0 = await stack.publicClient.getBlockNumber({ cacheTime: 0 });
        const a = await signTransfer(stack, relay, { from: 2, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n, deadlineSeconds: 300 });
        await submit(relay, a);
        await tick(relay);
        // Base fee above the cap: speed-ups reach the cap, then nothing can outbid the pending call.
        await mineAndTick(env, 22, parseGwei('100'));
        const attempts = relay.server.store.listAttempts(a.id).map((x) => ({ kind: x.kind, maxFee: formatGwei(x.maxFeePerGas) }));
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(a.body.request.deadline) - 2n });
        await mineAndTick(env, 1, parseGwei('100'));
        const record = relay.server.store.getRequest(a.id)!;
        const waiting = { status: record.status, pendingFinal: record.pendingFinal?.status ?? null, attempts: relay.server.store.listAttempts(a.id).length };
        // The base fee falls after the deadline: the pending call is included and reverts (DeadlineExpired).
        await stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(a.body.request.deadline) + 5n });
        await mineAndTick(env, 2, parseGwei('1'));
        const txs = await relayTxsOnChain(stack, relay.address, block0 + 1n);
        const state = await relay.state(a.id);
        const result = {
            attempts,
            waiting,
            status: state.status,
            error: state.error?.code,
            onChain: txs.map((t) => ({ kind: t.to?.toLowerCase() === relay.address.toLowerCase() ? 'cancel' : 'call', status: t.receipt.status, gasUsed: t.receipt.gasUsed, cost: formatEther(t.receipt.gasUsed * t.receipt.effectiveGasPrice) })),
        };
        console.log('cap prevents the cancel', result);
        expect(waiting.pendingFinal).toBe('expired');
        expect(state.status).toBe('expired');
        expect(txs).toHaveLength(1);
        await expectCleanNonces(env, block0 + 1n);
    });
});

describe('relay cost under base-fee and tip spikes (gas limit × maxFeePerGas of a call stays within its spend cap and RELAY_MAX_FEE_PER_GAS_GWEI)', () => {
    // Gas limit × maxFeePerGas of a call stays within RELAY_MAX_COST_PERCENT_OF_FEE (default 200 %) of the request's
    // fee, so the relay does not follow a spike up to RELAY_MAX_FEE_PER_GAS_GWEI: it holds the request while the spike
    // lasts, and the request is mined once the price is back within that cap.
    it('base fee ×1000 after acceptance: the relay holds the request at its spend cap (200 % of the fee); mined after the spike; cost ≤ 2 × fee', async () => {
        env = await startFaultEnv();
        const { stack, relay } = env;
        const cap = parseGwei('3000');
        const a = await signTransfer(stack, relay, { from: 3, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await tick(relay);
        const [call] = relay.server.store.listAttempts(a.id);
        // The fee in wei at the fixture's POL/USD 0.2 (6-decimal fee units → wei: × 10^12 / 0.2).
        const spendCapWei = BigInt(a.body.request.fee) * 5n * 10n ** 12n * 2n;
        const spike = parseGwei('1000');
        // RELAY_SPEEDUP_AFTER_BLOCKS 10: one speed-up up to the spend cap, then the next one is held at it.
        await mineAndTick(env, 25, spike);
        const during = await status(relay, a.id);
        const sentDuringSpike = relay.server.store.listAttempts(a.id);
        let blocks = 0;
        for (; blocks < 30 && (await status(relay, a.id)) !== 'mined'; blocks++) await mineAndTick(env, 1, parseGwei('1'));
        const metrics = await relay.server.relay.metrics.registry.metrics();
        console.log('base-fee spike: held', {
            during,
            sentDuringSpike: sentDuringSpike.map((x) => ({ maxFeePerGas: formatGwei(x.maxFeePerGas), worstCasePol: formatEther(x.gasLimit * x.maxFeePerGas) })),
            spendCapPol: formatEther(spendCapWei),
            blocksAfterSpike: blocks,
        });
        expect(during).toBe('submitted');
        for (const x of sentDuringSpike) expect(x.gasLimit * x.maxFeePerGas).toBeLessThanOrEqual(spendCapWei);
        expect(metrics).toMatch(/relay_spend_cap_holds_total\{kind="speedup"\} [1-9]/);
        const state = await relay.state(a.id);
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: state.txHash! });
        const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
        const polUsd = 0.2; // the fixture's MockPriceFeed
        const result = {
            fee: a.body.request.fee,
            blocks,
            initialMaxFee: formatGwei(call!.maxFeePerGas),
            attempts: relay.server.store.listAttempts(a.id).map((x) => formatGwei(x.maxFeePerGas)),
            effectiveGasPrice: formatGwei(receipt.effectiveGasPrice),
            gasUsed: receipt.gasUsed,
            gasLimit: call!.gasLimit,
            costPol: formatEther(costWei),
            costUsd: Number(formatEther(costWei)) * polUsd,
            feeUsd: Number(a.body.request.fee) / 1e6,
            boundPol: formatEther(call!.gasLimit * cap),
        };
        console.log('base-fee spike economics', result);
        expect(state.status).toBe('mined');
        expect(receipt.effectiveGasPrice).toBeLessThanOrEqual(cap);
        expect(costWei).toBeLessThanOrEqual(call!.gasLimit * cap);
        expect(costWei).toBeLessThanOrEqual(spendCapWei);
    });

    // The maxFeePerGas of a call is capped by RELAY_MAX_FEE_PER_GAS_GWEI and by the request's spend cap, so a tip
    // spike raises what the relay offers only up to the lower of the two; above the cap, queued requests are held.
    // The quote taken at a tip of 5000 gwei is only logged (quoteAtTip5000; the fee engine may still answer from its
    // cached gas price).
    it('eth_maxPriorityFeePerGas jumps (or lies) after acceptance: both requests are mined; the call is priced within its spend cap and RELAY_MAX_FEE_PER_GAS_GWEI', async () => {
        env = await startFaultEnv();
        const { stack, proxy, relay } = env;
        const cap = parseGwei('3000');
        const a = await signTransfer(stack, relay, { from: 4, token: stack.usdt0, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        const b = await signTransfer(stack, relay, { from: 5, token: stack.usdc, authMode: 'permit', to: RECIPIENT, amount: 1_000_000n });
        await submit(relay, a);
        await submit(relay, b);
        // Just below the cap: accepted as the market tip.
        const remove = proxy.add({ name: 'tip-2900', match: method('eth_maxPriorityFeePerGas'), before: () => ({ kind: 'answer', answer: { result: `0x${parseGwei('2900').toString(16)}` } }) });
        await tick(relay);
        await stack.mine();
        await tick(relay);
        remove();
        const aState = await relay.state(a.id);
        const receipt = await stack.publicClient.getTransactionReceipt({ hash: aState.txHash! });
        // Above the cap: queued requests are held.
        proxy.add({ name: 'tip-5000', match: method('eth_maxPriorityFeePerGas'), before: () => ({ kind: 'answer', answer: { result: `0x${parseGwei('5000').toString(16)}` } }) });
        const c = await signTransfer(stack, relay, { from: 6, token: stack.usdt0, authMode: 'metaTxApprove', to: RECIPIENT, amount: 1_000_000n }).catch((err: unknown) => err as Error);
        const result = {
            a: aState.status,
            b: await status(relay, b.id),
            effectiveGasPrice: formatGwei(receipt.effectiveGasPrice),
            costPol: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
            fee: a.body.request.fee,
            quoteAtTip5000: c instanceof Error ? c.message.slice(0, 120) : c.body.request.fee,
        };
        console.log('tip spike economics', result);
        expect(receipt.effectiveGasPrice).toBeLessThanOrEqual(cap);
        expect({ a: result.a, b: result.b }).toEqual({ a: 'mined', b: 'mined' });
        // The fee in wei at the fixture's POL/USD 0.2, × 200 % (RELAY_MAX_COST_PERCENT_OF_FEE default).
        const spendCapWei = BigInt(a.body.request.fee) * 5n * 10n ** 12n * 2n;
        for (const x of relay.server.store.listAttempts(a.id)) expect(x.gasLimit * x.maxFeePerGas).toBeLessThanOrEqual(spendCapWei);
        expect(receipt.gasUsed * receipt.effectiveGasPrice).toBeLessThanOrEqual(spendCapWei);
    });
});
