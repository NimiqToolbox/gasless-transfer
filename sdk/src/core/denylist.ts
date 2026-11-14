// Recipient denylist (D11): the contract rejects `to` in {0, token, this}; the relay and the SDK
// additionally reject every known Nimiq contract, legacy and new.

import { sameAddress, toChecksumAddress, ZERO_ADDRESS } from './address.js';
import { LEGACY_NIMIQ_CONTRACTS_POLYGON, POLYGON_CHAIN_ID } from './constants.js';
import type { ChainPins } from './pins.js';
import type { Address } from './types.js';

/** Derived from the pins on every call, so hand-built pins get the same list. */
function denylistEntries(pins: ChainPins): string[] {
    return [
        ZERO_ADDRESS,
        ...pins.tokens.map((token) => token.address),
        pins.transfer.address,
        ...(pins.chainId === POLYGON_CHAIN_ID ? LEGACY_NIMIQ_CONTRACTS_POLYGON : []),
        ...pins.extraDeniedRecipients,
    ];
}

/**
 * Every address `request.to` must not be: the zero address, the pinned tokens, the transfer
 * contract, the legacy Nimiq handlers on Polygon mainnet (chain 137), and `pins.extraDeniedRecipients`.
 */
export function recipientDenylist(pins: ChainPins): readonly Address[] {
    const list: Address[] = [];
    for (const entry of denylistEntries(pins)) {
        const address = toChecksumAddress(entry);
        if (!list.includes(address)) list.push(address);
    }
    return Object.freeze(list);
}

export function isDeniedRecipient(pins: ChainPins, address: string): boolean {
    return denylistEntries(pins).some((denied) => sameAddress(denied, address));
}
