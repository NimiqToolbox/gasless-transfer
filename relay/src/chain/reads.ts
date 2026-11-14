// Typed contract reads. Transfer and token ABIs come from @nimiq/gasless-sdk/core; the only ABI
// defined here is the standard Chainlink AggregatorV3 subset, which the SDK does not ship.
import { parseAbi, type Address, type Hex } from 'viem';
import { gaslessTransferAbi, usdcAbi, usdt0Abi } from '@nimiq/gasless-sdk/core';
import type { ChainClient } from './types.js';

/** GaslessBase `TokenConfig`: all zero for a token that is not supported. */
export interface OnchainTokenConfig {
    permit: boolean;
    metaTxApprove: boolean;
    allowance: boolean;
}

export const chainlinkAggregatorAbi = parseAbi([
    'function decimals() view returns (uint8)',
    'function description() view returns (string)',
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

// GaslessTransfer intent-nonce state: `nonces(signer)`, the nonce of the signer's next request. Every nonce below it is
// used (executed or invalidated); nonces only rise.
export const readIntentNonce = (chain: ChainClient, contract: Address, signer: Address, blockNumber?: bigint) =>
    chain.readContract<bigint>({
        address: contract,
        abi: gaslessTransferAbi,
        functionName: 'nonces',
        args: [signer],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
    });

/** Whether intent nonce `nonce` of `signer` is used: `nonces(signer) > nonce`. */
export const readIntentNonceUsed = async (chain: ChainClient, contract: Address, signer: Address, nonce: bigint, blockNumber?: bigint) =>
    (await readIntentNonce(chain, contract, signer, blockNumber)) > nonce;

export const readContractDomainSeparator = (chain: ChainClient, contract: Address) =>
    chain.readContract<Hex>({ address: contract, abi: gaslessTransferAbi, functionName: 'DOMAIN_SEPARATOR' });

export const readTokenConfig = (chain: ChainClient, contract: Address, token: Address) =>
    chain.readContract<OnchainTokenConfig>({
        address: contract,
        abi: gaslessTransferAbi,
        functionName: 'tokenConfig',
        args: [token],
    });

// Tokens (both ABIs share these selectors; the USDC ABI is used unless a USDT0-only function is read)
export const readTokenDomainSeparator = (chain: ChainClient, token: Address) =>
    chain.readContract<Hex>({ address: token, abi: usdcAbi, functionName: 'DOMAIN_SEPARATOR' });

export const readDecimals = (chain: ChainClient, token: Address) =>
    chain.readContract<number>({ address: token, abi: usdcAbi, functionName: 'decimals' });

export const readBalanceOf = (chain: ChainClient, token: Address, account: Address) =>
    chain.readContract<bigint>({ address: token, abi: usdcAbi, functionName: 'balanceOf', args: [account] });

export const readAllowance = (chain: ChainClient, token: Address, owner: Address, spender: Address) =>
    chain.readContract<bigint>({ address: token, abi: usdcAbi, functionName: 'allowance', args: [owner, spender] });

/** EIP-2612 `nonces(owner)`: USDC's permit nonce, USDT0's shared permit/meta-tx nonce. */
export const readPermitNonce = (chain: ChainClient, token: Address, owner: Address) =>
    chain.readContract<bigint>({ address: token, abi: usdcAbi, functionName: 'nonces', args: [owner] });

export const readUsdcPaused = (chain: ChainClient, token: Address) =>
    chain.readContract<boolean>({ address: token, abi: usdcAbi, functionName: 'paused' });

export const readUsdcBlacklisted = (chain: ChainClient, token: Address, account: Address) =>
    chain.readContract<boolean>({ address: token, abi: usdcAbi, functionName: 'isBlacklisted', args: [account] });

export const readUsdt0Blocked = (chain: ChainClient, token: Address, account: Address) =>
    chain.readContract<boolean>({ address: token, abi: usdt0Abi, functionName: 'isBlocked', args: [account] });

/** USDT0 meta-transaction nonce (`getNonce(user)`), the same counter as `nonces(user)`. */
export const readUsdt0MetaNonce = (chain: ChainClient, token: Address, owner: Address) =>
    chain.readContract<bigint>({ address: token, abi: usdt0Abi, functionName: 'getNonce', args: [owner] });

// Chainlink
export const readFeedDecimals = (chain: ChainClient, feed: Address) =>
    chain.readContract<number>({ address: feed, abi: chainlinkAggregatorAbi, functionName: 'decimals' });

export const readFeedDescription = (chain: ChainClient, feed: Address) =>
    chain.readContract<string>({ address: feed, abi: chainlinkAggregatorAbi, functionName: 'description' });

export const readLatestRoundData = (chain: ChainClient, feed: Address) =>
    chain.readContract<readonly [bigint, bigint, bigint, bigint, bigint]>({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: 'latestRoundData',
    });
