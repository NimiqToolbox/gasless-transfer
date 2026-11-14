import { domainSeparator, type Client } from 'viem';
import { readContract } from 'viem/actions';
import { usdcAbi, usdt0Abi } from '../core/abi.js';
import { GaslessError, GaslessValidationError } from '../core/errors.js';
import { findPinnedToken, type ChainPins, type PinnedToken } from '../core/pins.js';
import type { Address, AuthModeName, Hex } from '../core/types.js';
import { withoutCcipRead } from './ccipRead.js';

/** The token's on-chain DOMAIN_SEPARATOR() differs from the hash of the pinned domain. */
export class TokenDomainMismatchError extends GaslessError {
    declare readonly code: 'token_domain_mismatch';
    readonly token: Address;
    readonly expected: Hex;
    readonly actual: Hex;

    constructor(token: Address, expected: Hex, actual: Hex) {
        super(
            'token_domain_mismatch',
            `DOMAIN_SEPARATOR() of ${token} is ${actual}, the pinned domain hashes to ${expected}; do not sign token authorizations`,
        );
        this.name = 'TokenDomainMismatchError';
        this.token = token;
        this.expected = expected;
        this.actual = actual;
    }
}

export function requirePinnedToken(pins: ChainPins, token: string): PinnedToken {
    const pinned = findPinnedToken(pins, token);
    if (pinned === undefined) throw new GaslessValidationError('unsupported_token', 'token', 'not a pinned token');
    return pinned;
}

/**
 * The owner's current token nonce for the given auth mode: `nonces(owner)` for permit and
 * `getNonce(owner)` for the USDT0 meta-tx (for USDT0 both read the same shared counter).
 */
export async function readTokenNonce(
    client: Client,
    pins: ChainPins,
    params: { readonly token: Address; readonly owner: Address; readonly authMode: Exclude<AuthModeName, 'none'> },
): Promise<bigint> {
    const token = requirePinnedToken(pins, params.token);
    if (!token.authModes.includes(params.authMode) || (params.authMode !== 'permit' && params.authMode !== 'metaTxApprove')) {
        throw new GaslessValidationError('unsupported_auth_mode', 'authMode', `${token.symbol} does not support auth mode "${params.authMode}"`);
    }
    if (params.authMode === 'permit') {
        return readContract(withoutCcipRead(client), { address: token.address, abi: usdcAbi, functionName: 'nonces', args: [params.owner] });
    }
    return readContract(withoutCcipRead(client), { address: token.address, abi: usdt0Abi, functionName: 'getNonce', args: [params.owner] });
}

export interface TokenDomainCheck {
    readonly ok: boolean;
    readonly token: Address;
    /** Hash of the pinned domain. */
    readonly expected: Hex;
    /** The token's DOMAIN_SEPARATOR(). */
    readonly actual: Hex;
}

/**
 * Compares the token's on-chain `DOMAIN_SEPARATOR()` with the hash of the pinned domain. USDT0
 * stores its separator and an admin `changeName()` replaces it, so permits and meta-tx approvals
 * signed with the pinned domain would fail (or, worse, match a domain the client did not pin).
 */
export async function checkTokenDomain(client: Client, pins: ChainPins, tokenAddress: Address): Promise<TokenDomainCheck> {
    const token = requirePinnedToken(pins, tokenAddress);
    const expected = domainSeparator({ domain: token.domain });
    if (expected.toLowerCase() !== token.domainSeparator.toLowerCase()) {
        // Two independent implementations (viem and the core) disagree: never sign on that basis.
        throw new GaslessError('internal_error', `domain separator mismatch between viem and the core for ${token.symbol}`);
    }
    const actual = await readContract(withoutCcipRead(client), { address: token.address, abi: usdcAbi, functionName: 'DOMAIN_SEPARATOR' });
    return { ok: actual.toLowerCase() === expected.toLowerCase(), token: token.address, expected, actual };
}

/** `checkTokenDomain` that throws `TokenDomainMismatchError` on a mismatch. */
export async function assertTokenDomain(client: Client, pins: ChainPins, tokenAddress: Address): Promise<void> {
    const check = await checkTokenDomain(client, pins, tokenAddress);
    if (!check.ok) throw new TokenDomainMismatchError(check.token, check.expected, check.actual);
}
