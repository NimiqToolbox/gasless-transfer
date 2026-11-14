// Helpers for tests of a gas spike, during which the relay holds requests at their spend cap: blocks at a chosen base
// fee with a pass after each, a base fee above the cap of a minimum-fee request, and a request's status as one label.
import type { Hex } from 'viem';
import { GWEI } from '../../helpers/fakeChain.js';
import type { Harness } from '../../helpers/harness.js';
import { stateOf, tick } from '../../helpers/txManagerDriver.js';

/** `n` blocks at `baseFee`, each with a pass (the finalized tag 64 blocks behind the head). */
export async function blocksAt(h: Harness, n: number, baseFee: bigint): Promise<void> {
    for (let i = 0; i < n; i++) {
        h.chain.mine({ baseFee });
        h.chain.finalized = h.chain.head.number - 64n;
        h.clock.advance(2);
        await tick(h);
    }
}

/** 600 gwei: above the spend cap of a 0.01 USD fee (0.1 POL over 195000 gas, about 513 gwei per gas) at 0.20 USD/POL. */
export const SPIKE = 600n * GWEI;

/** `status` or `status/code` of a request, as GET /v1/requests/:id reports it. */
export function label(h: Harness, id: Hex): string {
    const s = stateOf(h, id);
    return s.error ? `${s.status}/${s.error.code}` : s.status;
}
