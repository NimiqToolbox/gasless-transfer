import { hashTypedData } from 'viem';
import { buildTransferTypedData } from '../core/typedData.js';
import type { Address, Hex, TokenAuthorization, TransferRequest } from '../core/types.js';
import { toViemTypedData } from './typedData.js';

/**
 * EIP-712 digest of a transfer request at its nonce with its token authorization, with viem's `hashTypedData`:
 * equal to the contract's `hashTransfer(r, nonce, auth)`, the relay request id, and the core's `transferDigest`.
 */
export function hashTransfer(chainId: number, contract: Address, request: TransferRequest, authorization: TokenAuthorization): Hex {
    return hashTypedData(toViemTypedData(buildTransferTypedData(chainId, contract, request, authorization)));
}
