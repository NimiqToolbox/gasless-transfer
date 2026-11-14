// Pinned protocol constants (docs/STEP-1-GAS-ABSTRACTION.md §5, §6.4, §11). Clients must verify
// live token domain separators before signing. Deployment-specific pins belong in other files.

import { deepFreeze } from './bytes.js';
import type { Address, AuthModeName, DecimalString, Hex, TypedDataDomain } from './types.js';

export const POLYGON_CHAIN_ID = 137;
export const AMOY_CHAIN_ID = 80002;

export interface TokenInfo {
    readonly symbol: 'USDC' | 'USDT0';
    readonly address: Address;
    readonly decimals: 6;
    readonly authModes: readonly AuthModeName[];
    /** EIP-712 domain of the token's own permit / meta-tx signatures. */
    readonly domain: TypedDataDomain;
    /**
     * On-chain `DOMAIN_SEPARATOR()` as of 2026-09-25. USDT0 stores its separator and an admin
     * `changeName()` replaces it, so clients must compare with the live value before signing.
     */
    readonly domainSeparator: Hex;
}

/** Native USDC (FiatTokenV2_2 behind FiatTokenProxy). */
export const POLYGON_USDC: TokenInfo = deepFreeze({
    symbol: 'USDC',
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    decimals: 6,
    authModes: ['permit', 'none'],
    domain: {
        name: 'USD Coin',
        version: '2',
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    },
    domainSeparator: '0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca',
});

/** USDT0 (UChildUSDT0 behind UChildERC20Proxy). Salt domain: no chainId field, salt = bytes32(chainId). */
export const POLYGON_USDT0: TokenInfo = deepFreeze({
    symbol: 'USDT0',
    address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    decimals: 6,
    authModes: ['permit', 'metaTxApprove', 'none'],
    domain: {
        name: 'USDT0',
        version: '1',
        verifyingContract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        salt: '0x0000000000000000000000000000000000000000000000000000000000000089',
    },
    domainSeparator: '0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05',
});

export const POLYGON_TOKENS: readonly TokenInfo[] = deepFreeze([POLYGON_USDC, POLYGON_USDT0]);

/** Relay policy defaults (§6.2, §6.4, §11). */
export const MIN_DEADLINE_SECONDS = 60;
export const MAX_DEADLINE_SECONDS = 7200;
export const QUOTE_TTL_SECONDS = 120;
/** Fees are multiples of 0.01 token. */
export const FEE_GRANULARITY: DecimalString = '10000';
export const MIN_FEE: DecimalString = '10000';

/** Chainlink POL/USD ("MATIC / USD", 8 decimals) on Polygon mainnet. */
export const CHAINLINK_POL_USD_POLYGON: Address = '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0';

/**
 * Blocked recipient contracts on Polygon mainnet.
 * Recipients on this list are rejected by the relay and the SDK, together with the zero
 * address, the pinned tokens and the gasless transfer contract.
 */
export const LEGACY_NIMIQ_CONTRACTS_POLYGON: readonly Address[] = deepFreeze([
    '0x98E69a6927747339d5E543586FC0262112eBe4BD',
    '0xF615bD7EA00C4Cc7F39Faad0895dB5f40891359f',
    '0x3157d422cd1be13AC4a7cb00957ed717e648DFf2',
    '0x0cFD862bE942846Cebad797d7c1BC6e47714959b',
    '0xfAbBed813017bF535b40013c13b8702638aC25CD',
    '0x3c870b039BF82D2F883b6E89D41d06d26b9F4486',
    // Superseded GaslessTransfer deployments. Neither can move tokens sent to it.
    '0xbfbE31E6c57B09A8130d427B9E3E23ed5aB6cd1D',
    '0xA0df3CdF124d7101a67ebE5b1b97D222505De9D6',
]);
