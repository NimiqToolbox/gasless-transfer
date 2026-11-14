import type { ChainPins } from '../../src/core/pins.js';
import type { InfoResponse } from '../../src/relay/types.js';

/** The /v1/info a correctly configured relay for these pins returns. */
export function infoFor(pins: ChainPins, relay: string = pins.relays[0] as string): InfoResponse {
    return {
        version: '2.0.0',
        chainId: pins.chainId,
        relay: relay as `0x${string}`,
        contracts: { transfer: { address: pins.transfer.address, domain: pins.transfer.domain } },
        tokens: pins.tokens.map((t) => ({
            symbol: t.symbol,
            address: t.address,
            decimals: t.decimals,
            authModes: [...t.authModes],
            tokenDomain: t.domain,
        })),
        policy: { minDeadlineSeconds: 60, maxDeadlineSeconds: 7200, quoteTtlSeconds: 120 },
    };
}
