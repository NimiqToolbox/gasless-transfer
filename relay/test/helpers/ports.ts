import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';

/**
 * A port on 127.0.0.1 that was free a moment ago. Until the caller listens on it, another socket can take it (an
 * outgoing connection's local port is drawn from the same range), so callers that start a server on it retry with a
 * new port.
 */
export async function freePort(): Promise<number> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');
    return port;
}

/** True for a listen error of a port that is taken (EADDRINUSE). */
export function addressInUse(err: unknown): boolean {
    return (err as { code?: unknown } | null)?.code === 'EADDRINUSE';
}
