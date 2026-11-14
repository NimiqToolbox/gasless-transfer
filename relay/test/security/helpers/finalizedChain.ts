// Helpers for tests in which one RPC lies while the chain itself moves on honestly: a successful receipt a lying RPC
// can answer for any hash and block, and a chain that advances with every block final at once.
import { toHex, type Hex } from 'viem';
import type { ReceiptInfo } from '../../../src/chain/types.js';
import { GWEI } from '../../helpers/fakeChain.js';
import type { Harness } from '../../helpers/harness.js';
import { tick } from '../../helpers/txManagerDriver.js';

/**
 * A successful receipt of `hash` in block `blockNumber` (what a lying RPC can answer). GaslessTransfer emits no
 * success event: the status of the relay's own call decides.
 */
export function forgedSuccessReceipt(hash: Hex, blockNumber: bigint): ReceiptInfo {
    return {
        transactionHash: hash,
        blockNumber,
        blockHash: toHex(blockNumber, { size: 32 }),
        status: 'success',
        gasUsed: 100_000n,
        effectiveGasPrice: 30n * GWEI,
        logs: [],
    };
}

/** `n` blocks, each final at once on the (honest) chain, with a pass after each. */
export async function drive(h: Harness, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
        h.chain.mine();
        h.chain.finalized = h.chain.head.number;
        await tick(h);
    }
}
