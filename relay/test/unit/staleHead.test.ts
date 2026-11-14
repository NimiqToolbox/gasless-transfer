// The head of the relay's RPC against the relay's clock. A head that stands still (the first RPC in RELAY_RPC_URLS
// stopped following the chain, or the chain halted) cannot be seen by the watchdogs that count blocks: they count the
// blocks of that head. The relay is unready then, and sends no queued request on that old state.
import { afterEach, describe, expect, it } from 'vitest';
import { transferOperation } from '../../src/operations/transfer.js';
import { buildTransfer, createHarness, type BuiltTransfer, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => {
    await h?.close();
    h = undefined;
});

async function started(): Promise<Harness> {
    h = await createHarness();
    await h.relay.txManager.recover();
    await h.relay.txManager.tick();
    expect(h.relay.txManager.health()).toMatchObject({ ok: true, reasons: [] });
    return h;
}

async function queue(x: Harness): Promise<BuiltTransfer> {
    const built = await buildTransfer(x);
    expect((await x.relay.pipeline.submit(transferOperation, built.body)).statusCode).toBe(202);
    return built;
}

const status = (x: Harness, t: BuiltTransfer) => x.store.getRequest(t.id)?.status;
const staleReason = expect.stringMatching(/^head_stale: /);

describe('a head block that stands still while the clock runs on', () => {
    it('makes the relay unready and holds the queue; both end when the head moves again', async () => {
        const x = await started();
        const t = await queue(x);

        x.clock.advance(61);
        await x.relay.txManager.tick();
        expect(x.relay.txManager.lastTickError).toBeUndefined();
        expect(x.relay.txManager.health()).toMatchObject({ ok: false, reasons: [staleReason] });
        expect(status(x, t)).toBe('queued');
        expect(x.chain.mempool.size).toBe(0);
        expect(x.logs.text()).toContain('ALERT: the head block of the relay');

        x.chain.mine({ timestampDelta: 61 });
        await x.relay.txManager.tick();
        expect(x.relay.txManager.health()).toMatchObject({ ok: true, reasons: [] });
        expect(status(x, t)).toBe('submitted');
        expect(x.logs.text()).toContain('is current again');
    });

    it('a request in flight is not reported as fine for as long as the head stands still', async () => {
        const x = await started();
        const t = await queue(x);
        await x.relay.txManager.tick();
        expect(status(x, t)).toBe('submitted');

        // Ten minutes without a new head: the request's deadline passes on the clock, never on that head.
        for (let minute = 0; minute < 10; minute++) {
            x.clock.advance(60);
            await x.relay.txManager.tick();
        }
        expect(status(x, t)).toBe('submitted');
        expect(x.relay.txManager.health()).toMatchObject({ ok: false, reasons: [staleReason] });
    });

    it('a head up to a minute behind the clock is current', async () => {
        const x = await started();
        const t = await queue(x);
        x.clock.advance(60);
        await x.relay.txManager.tick();
        expect(x.relay.txManager.health()).toMatchObject({ ok: true, reasons: [] });
        expect(status(x, t)).toBe('submitted');
    });

    it('a head ahead of the clock is current', async () => {
        const x = await started();
        x.chain.mineBlocks(200);
        await x.relay.txManager.tick();
        expect(x.relay.txManager.health()).toMatchObject({ ok: true, reasons: [] });
    });
});
