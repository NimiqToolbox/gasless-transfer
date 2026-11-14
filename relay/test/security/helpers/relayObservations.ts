// Helpers that read what the relay did from the outside: the relayTransfer calls it broadcast for a request, whether an
// intent nonce is used on the fake chain, and the value of a metric counter.
import { decodeFunctionData, parseTransaction, type Hex } from 'viem';
import { gaslessTransferAbi } from '@nimiq/gasless-sdk/core';
import type { Harness } from '../../helpers/harness.js';

/**
 * True if `data` is a relayTransfer call of the request with this intent signature (the calldata of GaslessTransfer
 * carries no intent nonce; the signature identifies the request).
 */
export function isRelayTransferFor(data: Hex, signature: Hex): boolean {
    try {
        const { functionName, args } = decodeFunctionData({ abi: gaslessTransferAbi, data });
        return functionName === 'relayTransfer' && (args[1] as Hex).toLowerCase() === signature.toLowerCase();
    } catch {
        return false;
    }
}

/** relayTransfer calls the relay broadcast (to any RPC) for the request with this signature, counted by distinct tx nonce. */
export function relayCallNonces(h: Harness, signature: Hex): number[] {
    const contract = h.chain.contract.address.toLowerCase();
    const nonces = new Set<number>();
    for (const raw of h.chain.broadcasts) {
        const tx = parseTransaction(raw);
        if (tx.to?.toLowerCase() === contract && isRelayTransferFor(tx.data ?? '0x', signature)) nonces.add(tx.nonce ?? -1);
    }
    return [...nonces].sort((a, b) => a - b);
}

/** True if the intent nonce `nonce` of `signer` is used on the (fake) chain: nonces(signer) is above it. */
export function intentNonceUsed(h: Pick<Harness, 'chain'>, signer: Hex, nonce: string | bigint): boolean {
    return h.chain.intentNonce(signer) > BigInt(nonce);
}

/** Metric counter value (0 if absent) from the Prometheus text. */
export async function counter(h: Harness, name: string, labels: string): Promise<number> {
    const text = await h.metrics.registry.metrics();
    const line = text.split('\n').find((l) => l.startsWith(`${name}{${labels}}`));
    return line ? Number(line.split(' ').at(-1)) : 0;
}
