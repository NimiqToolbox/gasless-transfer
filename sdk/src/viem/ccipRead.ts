import type { Client } from 'viem';

/**
 * A view of the client for the SDK's reads, with CCIP-Read off. viem answers an OffchainLookup revert of an eth_call
 * (EIP-3668) by fetching the URLs in the revert data, unless the client has `ccipRead: false`. The RPC chooses that
 * data, so with CCIP-Read on it could make the wallet send HTTP requests to hosts of its choice; no contract the SDK
 * reads needs it. The caller's client is not changed.
 *
 * The actions of an extended client (a PublicClient's `call`, which readContract would take, and which reads
 * `ccipRead` from the caller's client) are hidden, so that every read goes through `request` with this view.
 */
export function withoutCcipRead(client: Client): Client {
    return new Proxy(client, {
        get(target, property, receiver) {
            if (property === 'ccipRead') return false;
            if (property === 'request') return (...args: unknown[]) => Reflect.apply(target.request, target, args) as Promise<unknown>;
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? undefined : value;
        },
    });
}
