// Admission while the transaction manager cannot send: a request accepted then would only wait in the queue until its
// deadline, after its sender signed it. Such a submission is refused with 503 `unavailable` before any RPC read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transferOperation } from '../../src/operations/transfer.js';
import { buildTransfer, createHarness, TEST_TX_SETTINGS, USDC, type Harness, type HarnessOptions } from '../helpers/harness.js';
import { OTHER_ADDRESS, OTHER_KEY, USER3_ADDRESS, USER3_KEY } from '../helpers/keys.js';

let h: Harness | undefined;
afterEach(async () => {
    await h?.close();
    h = undefined;
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
    h = await createHarness(options);
    for (const address of [OTHER_ADDRESS, USER3_ADDRESS]) h.chain.setBalance(USDC, address, 100_000_000n);
    await h.relay.txManager.recover();
    return h;
}

const submit = async (x: Harness, options: Parameters<typeof buildTransfer>[1] = {}) => {
    const built = await buildTransfer(x, options);
    return { built, answer: x.relay.pipeline.submit(transferOperation, built.body) };
};

async function accepted(x: Harness, options: Parameters<typeof buildTransfer>[1] = {}) {
    const { built, answer } = await submit(x, options);
    expect((await answer).statusCode).toBe(202);
    return built;
}

async function refused(x: Harness, options: Parameters<typeof buildTransfer>[1] = {}) {
    const reads = vi.spyOn(x.chain, 'readContract');
    const { built, answer } = await submit(x, options);
    await expect(answer).rejects.toMatchObject({ code: 'unavailable' });
    expect(x.store.getRequest(built.id)).toBeUndefined();
    // Refused before the first read of the chain.
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
}

describe('a submission while the transaction manager cannot send', () => {
    it('is refused once the lifetime gas budget refuses the next transaction, and stored requests still answer', async () => {
        const x = await start({ settings: { tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: 1n } } });
        const first = await accepted(x);
        await x.relay.txManager.tick();
        expect(x.relay.txManager.health().reasons).toEqual([expect.stringMatching(/^gas_budget: /)]);
        expect(x.store.getRequest(first.id)?.status).toBe('queued');

        await refused(x, { key: OTHER_KEY });
        const answer = await x.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: (await buildTransfer(x, { key: USER3_KEY })).body });
        expect(answer.statusCode).toBe(503);
        expect(answer.json().error.code).toBe('unavailable');
        // The identical request is known: its state is answered as before.
        expect(await x.relay.pipeline.submit(transferOperation, first.body)).toMatchObject({ statusCode: 200, body: { status: 'queued' } });
        expect(await x.metrics.registry.metrics()).toContain('relay_admission_events_total{event="cannot_send"} 2');
    });

    it('is refused while the relay account cannot pay, and accepted again once a broadcast went through', async () => {
        const x = await start();
        const first = await accepted(x);
        x.chain.forcedBroadcasts.push({ kind: 'insufficient_funds' });
        await x.relay.txManager.tick();
        expect(x.relay.txManager.health().reasons).toEqual([expect.stringMatching(/^insufficient_funds: /)]);
        await refused(x, { key: OTHER_KEY });

        await x.relay.txManager.tick();
        expect(x.store.getRequest(first.id)?.status).toBe('submitted');
        await accepted(x, { key: OTHER_KEY });
    });

    it('is refused while the head block stands still, and accepted again once it moves', async () => {
        const x = await start();
        await x.relay.txManager.tick();
        x.clock.advance(61);
        await x.relay.txManager.tick();
        await refused(x);

        x.chain.mine({ timestampDelta: 61 });
        await x.relay.txManager.tick();
        await accepted(x);
    });

    it('is refused while no pass completes', async () => {
        const x = await start();
        await x.relay.txManager.tick();
        x.clock.advance(61);
        expect(x.relay.txManager.health().reasons).toEqual([expect.stringMatching(/^pass_stale: /)]);
        await refused(x);
    });

    it('is accepted before the first pass: that pass sends it', async () => {
        const x = await start();
        expect(x.relay.txManager.health().reasons).toEqual([expect.stringMatching(/^no_pass: /)]);
        const first = await accepted(x);
        await x.relay.txManager.tick();
        expect(x.store.getRequest(first.id)?.status).toBe('submitted');
    });

    it('is refused in the middle of a pass too: a pass finds out again whether it can send', async () => {
        const x = await start({ settings: { tx: { ...TEST_TX_SETTINGS, totalGasBudgetWei: 1n } } });
        await accepted(x);
        await x.relay.txManager.tick();
        // The next pass reads the tip before it tries to reserve gas for the queued request again.
        const tip = x.chain.getMaxPriorityFeePerGas.bind(x.chain);
        let during: string | undefined;
        vi.spyOn(x.chain, 'getMaxPriorityFeePerGas').mockImplementation(async () => {
            during = x.relay.txManager.cannotSend();
            return tip();
        });
        await x.relay.txManager.tick();
        expect(during).toMatch(/^gas_budget: /);
    });
});
