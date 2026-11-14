import type { TypedDataDefinition } from 'viem';
import type { TypedDataDomain, TypedDataField } from '../core/types.js';

/**
 * The SDK payloads carry uint256 values as decimal strings (for ethers v5 and JSON transport).
 * viem accepts them at runtime (it converts with BigInt()); only its static types expect bigint.
 */
export function toViemTypedData(payload: {
    readonly domain: TypedDataDomain;
    readonly types: Readonly<Record<string, readonly TypedDataField[]>>;
    readonly primaryType: string;
    readonly message: unknown;
}): TypedDataDefinition {
    return {
        domain: payload.domain,
        types: payload.types,
        primaryType: payload.primaryType,
        message: payload.message,
    } as unknown as TypedDataDefinition;
}
