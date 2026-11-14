// What one lagging or lying RPC of two does to readiness and to the relay's availability.
//
// Readiness, health and the ordinary reads follow the first RPC that answers, while settling an outcome needs every
// configured RPC (relay/docs/transaction-lifecycle.md, "Several RPCs"). When one RPC lies or lags, the trust model
// promises safety, not availability. These tests pin the availability side:
// - a first RPC whose `finalized` tag lags makes the relay unready (finality_lag) and holds settlement back, although
//   the second RPC shows the inclusion final; the relay recovers by itself once the first RPC catches up;
// - the same lag on the second RPC leaves the relay ready, but settlement still waits for that RPC;
// - a first RPC that lies on an ordinary validation read gets submissions refused that the honest RPC would let pass.
// An operator therefore lists the most reliable provider first and replaces an RPC that holds decisions back.
import { toHex, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { usdcAbi } from '@nimiq/gasless-sdk/core';
import type { BlockInfo, ChainClient, ReadContractCall } from '../../../src/chain/types.js';
import { toRequestState } from '../../../src/http/app.js';
import { transferOperation } from '../../../src/operations/transfer.js';
import { TEST_TX_SETTINGS, buildTransfer, createHarness, type Harness } from '../../helpers/harness.js';
import { USER_ADDRESS } from '../../helpers/keys.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

/** Another RPC in front of the same chain whose `finalized` tag is `lag` blocks behind head. */
function rpcWithFinalizedLag(chain: Harness['chain'], lag: () => bigint): ChainClient {
    const base = chain.rpcView();
    return {
        ...base,
        async getBlock(tag: 'latest' | 'finalized'): Promise<BlockInfo> {
            if (tag === 'finalized') {
                const number = chain.head.number - lag();
                return { number, timestamp: 0n, baseFeePerGas: null, hash: toHex(number, { size: 32 }) };
            }
            return base.getBlock(tag);
        },
    };
}

async function setup(): Promise<Harness> {
    h = await createHarness({ settings: { readinessIncludesTxManager: true, tx: { ...TEST_TX_SETTINGS, stuckAfterBlocks: 10 } } });
    await h.relay.txManager.recover();
    return h;
}

async function minedRequest(x: Harness): Promise<Hex> {
    const built = await buildTransfer(x);
    const result = await x.relay.pipeline.submit(transferOperation, built.body);
    expect(result.statusCode).toBe(202);
    await x.relay.txManager.tick();
    x.chain.mine();
    await x.relay.txManager.tick();
    expect(toRequestState(x.store.getRequest(built.id)!, x.store.listAttempts(built.id)).status).toBe('mined');
    return built.id;
}

describe('what one lagging or lying RPC of two does to readiness and to the relay', () => {
    it('first RPC lags on `finalized` by 601: unready (finality_lag), and the relay cannot confirm, although the second RPC shows the inclusion final', async () => {
        const x = await setup();
        let firstLag = 601n;
        const honest = rpcWithFinalizedLag(x.chain, () => 16n);
        x.chain.rpcClients = () => [x.chain, honest];
        const id = await minedRequest(x);
        for (let i = 0; i < 30; i++) {
            x.chain.mine();
            x.chain.finalized = x.chain.head.number - firstLag;
            await x.relay.txManager.tick();
        }
        // The honest RPC shows the inclusion final (30 blocks deep, its tag at head - 16), yet nothing settles: the
        // relay's own view (the first RPC) gates settlement, and settling asks every RPC, the lagging one included.
        expect(x.store.getRequest(id)!.settledAtMs).toBeNull();
        expect(toRequestState(x.store.getRequest(id)!, x.store.listAttempts(id)).status).toBe('mined');
        x.clock.advance(6);
        const report = await x.relay.readiness();
        expect(report.ready).toBe(false);
        expect(report.checks.txManager?.reasons).toContainEqual(expect.stringMatching(/^finality_lag: /));
        // Once the first RPC catches up, the request confirms and the relay is ready again (self-healing).
        firstLag = 16n;
        x.chain.finalized = x.chain.head.number - firstLag;
        await x.relay.txManager.tick();
        expect(toRequestState(x.store.getRequest(id)!, x.store.listAttempts(id)).status).toBe('confirmed');
        x.clock.advance(6);
        expect((await x.relay.readiness()).ready).toBe(true);
    });

    it('the same lag on the second RPC: the relay stays ready, but settlement still waits for it (a decision wait, settle ALERT)', async () => {
        const x = await setup();
        const lagging = rpcWithFinalizedLag(x.chain, () => 601n);
        x.chain.rpcClients = () => [x.chain, lagging];
        const id = await minedRequest(x);
        for (let i = 0; i < 30; i++) {
            x.chain.mine();
            x.chain.finalized = x.chain.head.number - 16n;
            await x.relay.txManager.tick();
        }
        expect(x.store.getRequest(id)!.settledAtMs).toBeNull();
        x.clock.advance(6);
        const report = await x.relay.readiness();
        expect(report.ready).toBe(true);
        expect(await x.metrics.registry.metrics()).toContain('relay_decision_waits_total{decision="settle"} 1');
    });

    it('a lying first RPC denies every submission through the ordinary validation reads as well (readiness is not the only fail-over read)', async () => {
        const x = await setup();
        x.chain.rpcClients = () => [x.chain, x.chain.rpcView()];
        const honest = x.chain.rpcClients()[1]!;
        const real = x.chain.readContract.bind(x.chain);
        x.chain.readContract = (async <T,>(call: ReadContractCall): Promise<T> =>
            (call.functionName === 'balanceOf' ? 0n : await real<T>(call)) as T) as typeof x.chain.readContract;
        const built = await buildTransfer(x);
        await expect(x.relay.pipeline.submit(transferOperation, built.body)).rejects.toMatchObject({ code: 'insufficient_balance' });
        // The honest second RPC still shows the funds.
        const balance = await honest.readContract<bigint>({
            address: built.request.token,
            abi: usdcAbi,
            functionName: 'balanceOf',
            args: [USER_ADDRESS],
        });
        expect(balance).toBeGreaterThan(0n);
    });
});
