import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError, RpcRequestError, TimeoutError, keccak256, type Address, type Hex } from 'viem';
import type { ChainClient } from '../../src/chain/types.js';
import { TokenImplementationMonitor, loadTokenImplementationPins, nextCheckDelayMs, parseTokenImplementationPins } from '../../src/ops/tokenImplementationMonitor.js';
import { transferOperation } from '../../src/operations/transfer.js';
import { buildTransfer, createHarness, testDeployment, USDC, USDT0, type Harness } from '../helpers/harness.js';
import { installTokenPins, TEST_IMPLEMENTATION, TEST_IMPLEMENTATION_SLOT, testTokenPins, testTokenPinsJson } from '../helpers/tokenPins.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
async function setup() {
    h = await createHarness({ settings: { tokenImplementationPins: testTokenPins(), readinessCacheMs: 0 } });
    installTokenPins(h.chain);
    const monitor = h.relay.tokenImplementations!;
    await monitor.check();
    expect(monitor.status().ok).toBe(true);
    // The relay's first check ran before the pins were installed; tests look at what follows.
    h.logs.lines.splice(0);
    return { h, monitor };
}

describe('reviewed token implementation pins', () => {
    it('loads the reviewed Polygon configuration shipped with the production image', () => {
        const pins = loadTokenImplementationPins('config/token-pins.polygon-137.json', testDeployment());
        expect(pins.chainId).toBe(137);
        expect(pins.tokens.map((pin) => pin.address.toLowerCase()).sort()).toEqual([USDC, USDT0].map((a) => a.toLowerCase()).sort());
        expect(pins.reviewedBlock).toBeGreaterThan(0n);
    });

    it('requires the exact chain and complete unique token set and rejects malformed pins', () => {
        const file = testTokenPinsJson();
        expect(() => parseTokenImplementationPins(file, testDeployment())).not.toThrow();
        for (const invalid of [
            { ...file, chainId: 1 }, { ...file, tokens: [file.tokens[0]] },
            { ...file, tokens: [file.tokens[0], file.tokens[0]] }, { ...file, reviewedBlock: '0' },
            { ...file, tokens: [{ ...file.tokens[0], proxyCodeHash: '0x' }, file.tokens[1]] },
        ]) expect(() => parseTokenImplementationPins(invalid, testDeployment())).toThrow();
    });

    it('rejects a same-domain implementation replacement across every authorization route, quotes and readiness', async () => {
        const { h, monitor } = await setup();
        const originalDomain = h.chain.token(USDT0).domainSeparator;
        h.chain.storage.set(`${USDT0.toLowerCase()}:${TEST_IMPLEMENTATION_SLOT}`, `0x${'00'.repeat(12)}${'22'.repeat(20)}`);
        await monitor.check();
        expect(h.chain.token(USDT0).domainSeparator).toBe(originalDomain);
        expect(monitor.status()).toMatchObject({ ok: false, unavailable: [USDT0] });
        for (const mode of ['permit', 'metaTxApprove', 'none'] as const) {
            const transfer = await buildTransfer(h, { token: USDT0, mode });
            await expect(h.relay.pipeline.submit(transferOperation, transfer.body)).rejects.toMatchObject({ code: 'unavailable' });
            expect((await h.relay.app.inject({ method: 'GET', url: `/v1/fee?operation=transfer&token=${USDT0}&authMode=${mode}` })).statusCode).toBe(503);
        }
        expect((await h.relay.readiness()).ready).toBe(false);
        expect(monitor.tokenUnavailable(USDC)).toBeUndefined();
        expect(h.logs.text()).toContain('token_implementation_unavailable');
    });

    it.each(['proxy', 'implementation', 'empty', 'storage', 'rpc'] as const)('fails closed on %s change/error and resumes only on matching reviewed values', async (kind) => {
        const { h, monitor } = await setup();
        if (kind === 'proxy') h.chain.codes.set(USDC.toLowerCase(), '0x6001');
        if (kind === 'implementation') h.chain.codes.set(TEST_IMPLEMENTATION.toLowerCase(), '0x6002');
        if (kind === 'empty') h.chain.codes.set(TEST_IMPLEMENTATION.toLowerCase(), '0x');
        if (kind === 'storage') h.chain.storage.clear();
        if (kind === 'rpc') h.chain.failing.add('getStorageAt');
        expect(await monitor.checkToken(USDC)).toBe(false);
        expect(monitor.tokenUnavailable(USDC)).toBeDefined();
        installTokenPins(h.chain); h.chain.failing.clear();
        expect(await monitor.checkToken(USDC)).toBe(true);
    });

    it('does not trust new code on restart and fails closed when observations age or a provider disagrees', async () => {
        const { h, monitor } = await setup();
        h.clock.advance(121);
        expect(await h.metrics.registry.metrics()).toContain(`relay_token_implementation_unavailable{token="${USDC}"} 1`);
        expect(monitor.tokenUnavailable(USDC)).toBeDefined();
        await monitor.check();
        expect(monitor.tokenUnavailable(USDC)).toBeUndefined();
        const other = h.chain.rpcView();
        other.getStorageAt = async () => `0x${'00'.repeat(32)}` as Hex;
        h.chain.rpcClients = () => [h!.chain, other];
        expect(await monitor.checkToken(USDC)).toBe(false);
        h.chain.rpcClients = undefined;
        h.chain.codes.set(TEST_IMPLEMENTATION.toLowerCase(), '0x6002');
        const restarted = new TokenImplementationMonitor({ chain: h.chain, pins: testTokenPins(), clock: h.clock, logger: h.logs.logger });
        expect(restarted.tokenUnavailable(USDC)).toBeDefined();
        expect(await restarted.checkToken(USDC)).toBe(false);
    });

    it('pins all reads to a block and rejects a reorg during checking or a head below the reviewed block', async () => {
        const { h, monitor } = await setup();
        const heights: bigint[] = [];
        const code = h.chain.getCode.bind(h.chain);
        h.chain.getCode = async (address, blockNumber?: bigint) => { heights.push(blockNumber!); return code(address); };
        expect(await monitor.checkToken(USDC)).toBe(true);
        expect(heights).toEqual([h.chain.head.number, h.chain.head.number]);
        h.chain.getBlockByNumber = async () => ({ ...h!.chain.head, hash: keccak256('0x1234') });
        expect(await monitor.checkToken(USDC)).toBe(false);
        h.chain.head = { ...h.chain.head, number: 989n };
        expect(await monitor.checkToken(USDC)).toBe(false);
    });

    it('holds an admitted allowance request when the implementation changes before broadcast', async () => {
        const { h } = await setup();
        const transfer = await buildTransfer(h, { token: USDC, mode: 'none' });
        h.chain.setAllowance(USDC, transfer.body.request.from, h.relay.ctx.contracts.transfer, 10n ** 12n);
        await h.relay.pipeline.submit(transferOperation, transfer.body);
        h.chain.codes.set(TEST_IMPLEMENTATION.toLowerCase(), '0x6002');
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(0);
        installTokenPins(h.chain);
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(1);
    });
});

// A credential-bearing endpoint as providers echo it in errors; no log line may carry it.
const SECRET_URL = 'https://rpc.example/v2/secret-key-123';
const rateLimited = (): never => {
    throw new RpcRequestError({ body: { method: 'eth_getStorageAt' }, error: { code: -32029, message: `Too Many Requests, see ${SECRET_URL}` }, url: SECRET_URL });
};
const entries = (harness: Harness) => harness.logs.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const alerts = (harness: Harness) => entries(harness).filter((entry) => entry.alert === 'token_implementation_unavailable');

/** A second RPC in front of the fake chain; the test replaces its methods. */
function secondRpc(harness: Harness): ChainClient {
    const other = harness.chain.rpcView();
    harness.chain.rpcClients = () => [harness.chain, other];
    return other;
}

describe('token implementation check diagnostics and retries', () => {
    it('names the RPC, stage and classified reason of a failure without the RPC text, after the retries', async () => {
        const { h, monitor } = await setup();
        const other = secondRpc(h);
        let storageReads = 0;
        other.getStorageAt = async () => { storageReads += 1; return rateLimited(); };
        expect(await monitor.checkToken(USDC)).toBe(false);
        expect(storageReads).toBe(3);
        expect(alerts(h)).toHaveLength(1);
        expect(alerts(h)[0]!.failures).toEqual([{ rpc: 2, stage: 'implementation_slot', category: 'transport', reason: 'rate_limited', rpcCode: -32029, attempts: 3 }]);
        expect(h.logs.text()).not.toMatch(/rpc\.example|secret-key|Too Many/);
        expect(await h.metrics.registry.metrics()).toContain('relay_token_implementation_check_failures_total{rpc="2",stage="implementation_slot",reason="rate_limited"} 3');
    });

    it('absorbs a failure that passes within the check: the token stays verified and no alert is logged', async () => {
        const { h, monitor } = await setup();
        const other = secondRpc(h);
        const storage = other.getStorageAt!;
        let failures = 1;
        other.getStorageAt = async (address: Address, slot: Hex, blockNumber: bigint) => {
            if (failures-- > 0) throw new HttpRequestError({ url: SECRET_URL, status: 429 });
            return storage(address, slot, blockNumber);
        };
        expect(await monitor.checkToken(USDC)).toBe(true);
        expect(monitor.tokenUnavailable(USDC)).toBeUndefined();
        expect(alerts(h)).toHaveLength(0);
        expect(await h.metrics.registry.metrics()).toContain('relay_token_implementation_check_failures_total{rpc="2",stage="implementation_slot",reason="rate_limited"} 1');
    });

    it.each([
        ['another chain', (o: ChainClient) => { o.getChainId = async () => 1; }, { stage: 'chain_id', category: 'chain', reason: 'chain_mismatch', attempts: 1 }],
        ['a head below the freshness floor', (o: ChainClient, hh: Harness) => { o.getBlock = async () => ({ ...hh.chain.head, number: hh.chain.head.number - 1n }); }, { stage: 'head', category: 'chain', reason: 'head_behind', attempts: 3 }],
        ['a different implementation address', (o: ChainClient) => { o.getStorageAt = async () => `0x${'00'.repeat(12)}${'22'.repeat(20)}` as Hex; }, { stage: 'implementation_slot', category: 'pins', reason: 'mismatch', attempts: 1 }],
        ['different proxy code', (o: ChainClient) => { const code = o.getCode.bind(o); o.getCode = async (a: Address, n?: bigint) => (a.toLowerCase() === USDC.toLowerCase() ? '0x6001' : code(a, n)); }, { stage: 'proxy_code', category: 'pins', reason: 'mismatch', attempts: 1 }],
        ['no implementation code', (o: ChainClient) => { const code = o.getCode.bind(o); o.getCode = async (a: Address, n?: bigint) => (a.toLowerCase() === TEST_IMPLEMENTATION.toLowerCase() ? '0x' : code(a, n)); }, { stage: 'implementation_code', category: 'pins', reason: 'empty', attempts: 1 }],
        ['a block that changed during the check', (o: ChainClient, hh: Harness) => { o.getBlockByNumber = async () => ({ ...hh.chain.head, hash: keccak256('0x1234') }); }, { stage: 'block_hash', category: 'block', reason: 'block_changed', attempts: 3 }],
        ['a block the RPC no longer has', (o: ChainClient) => { o.getBlockByNumber = async () => null; }, { stage: 'block_hash', category: 'block', reason: 'block_missing', attempts: 3 }],
        ['a timeout', (o: ChainClient) => { o.getChainId = async () => { throw new TimeoutError({ body: {}, url: SECRET_URL }); }; }, { stage: 'chain_id', category: 'transport', reason: 'timeout', attempts: 3 }],
        ['an HTTP error', (o: ChainClient) => { o.getCode = async () => { throw new HttpRequestError({ url: SECRET_URL, status: 503 }); }; }, { category: 'transport', reason: 'http_status', httpStatus: 503, attempts: 3 }],
    ] as const)('classifies %s, retrying only what can pass by itself', async (_name, inject, expected) => {
        const { h, monitor } = await setup();
        inject(secondRpc(h), h);
        expect(await monitor.checkToken(USDC)).toBe(false);
        expect(alerts(h)[0]!.failures).toEqual([expect.objectContaining({ rpc: 2, ...expected })]);
        expect(h.logs.text()).not.toMatch(/rpc\.example|secret-key/);
    });

    it('reports every RPC that did not confirm the pins, without retrying once one failed for good', async () => {
        const { h, monitor } = await setup();
        const other = secondRpc(h);
        other.getStorageAt = async () => rateLimited();
        h.chain.codes.set(TEST_IMPLEMENTATION.toLowerCase(), '0x6002');
        expect(await monitor.checkToken(USDC)).toBe(false);
        expect(alerts(h)[0]!.failures).toEqual([
            { rpc: 1, stage: 'implementation_code', category: 'pins', reason: 'mismatch', attempts: 1 },
            { rpc: 2, stage: 'implementation_slot', category: 'transport', reason: 'rate_limited', rpcCode: -32029, attempts: 1 },
        ]);
    });

    it('holds the token as soon as one RPC shows a mismatch, while another RPC has not answered yet', async () => {
        const { h } = await setup();
        const other = secondRpc(h);
        // Waits long enough that a check waiting for RPC 2's retries would time the test out.
        const monitor = new TokenImplementationMonitor({ chain: h.chain, pins: testTokenPins(), clock: h.clock, logger: h.logs.logger, retryDelaysMs: [60_000, 60_000] });
        expect(await monitor.checkToken(USDC)).toBe(true);
        let release: (() => void) | undefined;
        other.getBlock = () => new Promise((_resolve, reject) => { release = () => reject(new HttpRequestError({ url: SECRET_URL, status: 429 })); });
        h.chain.codes.set(TEST_IMPLEMENTATION.toLowerCase(), '0x6002');
        const pending = monitor.checkToken(USDC);
        await vi.waitFor(() => expect(monitor.tokenUnavailable(USDC)).toBeDefined());
        release!();
        expect(await pending).toBe(false);
        expect(alerts(h)[0]!.failures).toEqual([
            { rpc: 1, stage: 'implementation_code', category: 'pins', reason: 'mismatch', attempts: 1 },
            { rpc: 2, stage: 'head', category: 'transport', reason: 'rate_limited', httpStatus: 429, attempts: 1 },
        ]);
    });

    it('raises the freshness floor only to the lowest head the RPCs confirmed: one inflated head cannot hold the others', async () => {
        const { h } = await setup();
        // No retries: a head below the floor fails at once.
        const monitor = new TokenImplementationMonitor({ chain: h.chain, pins: testTokenPins(), clock: h.clock, logger: h.logs.logger, retryDelaysMs: [] });
        const honest = h.chain.head.number;
        // RPC 2 reports a head far ahead of the chain, with a consistent block hash and the reviewed code.
        const inflated = { ...h.chain.head, number: honest + 1_000n, hash: keccak256('0xbeef') };
        const faulty = secondRpc(h);
        faulty.getBlock = async () => inflated;
        faulty.getBlockByNumber = async (n: bigint) => (n === inflated.number ? inflated : null);
        expect(await monitor.checkToken(USDC)).toBe(true);
        // Honest RPCs at the chain's head still confirm the pins.
        h.chain.rpcClients = () => [h!.chain, h!.chain.rpcView()];
        expect(await monitor.checkToken(USDC)).toBe(true);
        // The floor still rises with every confirmed check, and is never lowered.
        h.chain.mine();
        expect(await monitor.checkToken(USDC)).toBe(true);
        const lagging = h.chain.rpcView();
        lagging.getBlock = async () => ({ ...h!.chain.head, number: honest });
        h.chain.rpcClients = () => [h!.chain, lagging];
        expect(await monitor.checkToken(USDC)).toBe(false);
        expect(alerts(h)[0]!.failures).toEqual([{ rpc: 2, stage: 'head', category: 'chain', reason: 'head_behind', attempts: 1 }]);
    });

    it('counts the age of an observation from the start of its check', async () => {
        const { h, monitor } = await setup();
        const other = secondRpc(h);
        const block = other.getBlock.bind(other);
        // The check's reads take 100 s.
        other.getBlock = async (tag) => { h!.clock.advance(100); return block(tag); };
        expect(await monitor.checkToken(USDC)).toBe(true);
        h.clock.advance(21);
        expect(monitor.tokenUnavailable(USDC)).toBeDefined();
    });

    it('holds quotes, submissions and broadcasts while an RPC stays unavailable and resumes once every RPC matches', async () => {
        const { h, monitor } = await setup();
        const other = secondRpc(h);
        const storage = other.getStorageAt!;
        let outage: (() => never) | undefined;
        other.getStorageAt = async (address: Address, slot: Hex, blockNumber: bigint) => (outage ? outage() : storage(address, slot, blockNumber));
        const transfer = await buildTransfer(h, { token: USDC, mode: 'none' });
        h.chain.setAllowance(USDC, transfer.body.request.from, h.relay.ctx.contracts.transfer, 10n ** 12n);
        await h.relay.pipeline.submit(transferOperation, transfer.body);

        outage = rateLimited;
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(monitor.tokenUnavailable(USDC)).toBeDefined();
        expect((await h.relay.app.inject({ method: 'GET', url: `/v1/fee?operation=transfer&token=${USDC}&authMode=permit` })).statusCode).toBe(503);
        const held = await buildTransfer(h, { token: USDC, mode: 'permit' });
        await expect(h.relay.pipeline.submit(transferOperation, held.body)).rejects.toMatchObject({ code: 'unavailable' });
        expect((await h.relay.readiness()).ready).toBe(false);

        // The same diagnostics are not repeated; changed ones are logged.
        const warnings = () => entries(h).filter((entry) => entry.msg === 'token implementation verification still fails; all authorization modes remain held');
        await monitor.checkToken(USDC);
        expect(warnings()).toHaveLength(0);
        outage = () => { throw new TimeoutError({ body: {}, url: SECRET_URL }); };
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(0);
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]!.failures).toEqual([{ rpc: 2, stage: 'implementation_slot', category: 'transport', reason: 'timeout', attempts: 3 }]);
        expect(alerts(h)).toHaveLength(1);

        outage = undefined;
        await h.relay.txManager.tick();
        expect(h.chain.broadcasts).toHaveLength(1);
        expect(monitor.tokenUnavailable(USDC)).toBeUndefined();
        expect(entries(h).find((entry) => entry.msg === 'token implementation matches the reviewed pins again')).toMatchObject({ token: USDC, heldMs: expect.any(Number) });
        expect(h.logs.text()).not.toMatch(/rpc\.example|secret-key|Too Many/);
    });

    it('checks sooner while a token is held, backing off to the normal interval', () => {
        expect([0, 1, 2, 3, 4, 50].map(nextCheckDelayMs)).toEqual([30_000, 5_000, 10_000, 20_000, 30_000, 30_000]);
    });
});
