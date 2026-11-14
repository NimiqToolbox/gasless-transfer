// The harness's ports: freePort (integration/helpers/stack.ts) answers a port that was free a moment ago, and another
// socket can take it before the relay listens on it, which fails the start with EADDRINUSE. Here
// freePort's next answer is a port this test holds: the in-process relay (startRelay) and the relay process
// (startProcessEnv) start on another port instead, and a RELAY_PORT the caller chose still fails.
import { once } from 'node:events';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as StackModule from '../integration/helpers/stack.js';
import { startRelay } from '../integration/helpers/relay.js';
import { startStack, type Stack } from '../integration/helpers/stack.js';
import { startProcessEnv } from './helpers/fault.js';

const taken = vi.hoisted(() => [] as number[]);
vi.mock('../integration/helpers/stack.js', async (importOriginal) => {
    const actual = await importOriginal<typeof StackModule>();
    return { ...actual, freePort: vi.fn(async () => taken.shift() ?? actual.freePort()) };
});

let holder: Server;
let port: number;
let stack: Stack;

describe('a port from freePort that is taken before the relay listens on it', () => {
    beforeAll(async () => {
        holder = createServer();
        holder.listen(0, '127.0.0.1');
        await once(holder, 'listening');
        port = (holder.address() as AddressInfo).port;
        stack = await startStack();
    });

    afterAll(async () => {
        await stack?.stop();
        holder?.close();
    });

    it('startRelay: EADDRINUSE on the first port, started on the next one', async () => {
        taken.push(port);
        const relay = await startRelay(stack);
        try {
            expect(taken).toEqual([]);
            expect(new URL(relay.url).port).not.toBe(String(port));
            expect((await relay.client.info()).relay).toBe(relay.address);
        } finally {
            await relay.stop();
        }
    });

    it('startRelay with a RELAY_PORT the caller chose: EADDRINUSE fails it', async () => {
        const error = await startRelay(stack, { env: { RELAY_PORT: String(port) } }).catch((err: unknown) => err);
        expect((error as { code?: string }).code).toBe('EADDRINUSE');
    });

    it('startProcessEnv: the relay process exits with EADDRINUSE on the first port and starts on the next one', async () => {
        // startProcessEnv starts its own stack (anvil on a port of its own) and then asks freePort for RELAY_PORT.
        taken.push(port);
        const e = await startProcessEnv();
        try {
            expect(taken).toEqual([]);
            expect(new URL(e.proc.url).port).not.toBe(String(port));
            expect((await e.client.info()).relay).toBe(e.relayAddress);
        } finally {
            await e.stop();
        }
    }, 120_000);
});
