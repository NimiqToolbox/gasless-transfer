import type { Address } from 'viem';
import {
    LEGACY_NIMIQ_CONTRACTS_POLYGON,
    MAX_DEADLINE_SECONDS,
    MIN_DEADLINE_SECONDS,
    POLYGON_CHAIN_ID,
    POLYGON_TOKENS,
    QUOTE_TTL_SECONDS,
    transferDomain,
} from '@nimiq/gasless-sdk/core';
import type { InfoResponse } from '@nimiq/gasless-sdk/relay';
import { readContractDomainSeparator, readDecimals, readTokenConfig, readTokenDomainSeparator } from './chain/reads.js';
import type { ChainClient } from './chain/types.js';
import type { Deployment } from './config.js';
import { hashDomain } from './eip712.js';
import type { Logger } from './logger.js';
import type { RelayContext } from './operations/types.js';
import type { TokenDomainReading } from './ops/tokenDomainMonitor.js';
import { ZERO_ADDRESS, sameAddress } from './util/validation.js';
import { RELAY_VERSION } from './version.js';

export class StartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StartupError';
    }
}

function hasCode(code: string | undefined): boolean {
    return code !== undefined && code !== '0x';
}

/**
 * Reads fail over from one RPC to the next, so every configured RPC must serve the
 * deployment chain, not only the one that answers first. An RPC that cannot be asked counts as a
 * mismatch: it could serve another chain once the relay fails over to it. RPCs are named by their
 * position in RELAY_RPC_URLS because URLs often contain API keys.
 */
async function verifyEveryRpc(chain: ChainClient, expected: number): Promise<void> {
    if (!chain.rpcChainIds) return;
    const problems: string[] = [];
    for (const rpc of await chain.rpcChainIds()) {
        if (rpc.chainId === undefined) problems.push(`RPC #${rpc.index + 1} did not answer eth_chainId (${rpc.error ?? 'error'})`);
        else if (rpc.chainId !== expected) problems.push(`RPC #${rpc.index + 1} serves chain ${rpc.chainId}, not ${expected}`);
    }
    if (problems.length > 0) {
        throw new StartupError(`every RPC in RELAY_RPC_URLS must serve chain ${expected}:\n - ${problems.join('\n - ')}`);
    }
}

/** What startup verification read that the relay keeps using. */
export interface DeploymentVerification {
    /**
     * Every token's on-chain `DOMAIN_SEPARATOR()`. One that differs from the deployment file (a USDT0 rename)
     * does not stop startup: the token domain monitor takes these readings, and the relay starts degraded,
     * with that token's permit and meta-tx refused, as a running relay is after the rename.
     */
    readonly tokenDomains: readonly TokenDomainReading[];
    /** Symbols of the tokens whose domain differs. */
    readonly tokenDomainMismatches: readonly string[];
}

/**
 * Refuses to start unless the chain matches the deployment file: chain id (of every configured RPC), contract
 * code, the contract's own EIP-712 domain (version "3"), and for every token its code, `decimals()` and the
 * contract's `tokenConfig` (its modes; the owner can change them, so after a `TokenConfigSet` the deployment file
 * must follow). On Polygon the tokens in the deployment file must also match the SDK pins.
 *
 * A token whose `DOMAIN_SEPARATOR()` differs from the configured domain is the one exception: it is reported
 * in the result (and applied by the token domain monitor), not refused. Its admin can change the domain at
 * any time (USDT0 `changeName`); refusing to start would also take down mode `none` and every other token.
 */
export async function verifyDeployment(chain: ChainClient, deployment: Deployment, logger?: Logger): Promise<DeploymentVerification> {
    const chainId = await chain.getChainId();
    if (chainId !== deployment.chainId) {
        throw new StartupError(`RPC chain id ${chainId} does not match the deployment chain id ${deployment.chainId}`);
    }
    await verifyEveryRpc(chain, deployment.chainId);
    const contract = deployment.gaslessTransfer;
    if (!hasCode(await chain.getCode(contract))) throw new StartupError(`no contract code at gaslessTransfer ${contract}`);

    const problems: string[] = [];
    const contractSeparator = await readContractDomainSeparator(chain, contract);
    const domain = transferDomain(deployment.chainId, contract);
    if (contractSeparator.toLowerCase() !== hashDomain(domain)) {
        problems.push(`GaslessTransfer DOMAIN_SEPARATOR() does not match ("${domain.name}", "${domain.version}", chainId, address)`);
    }

    const tokenDomains: TokenDomainReading[] = [];
    const tokenDomainMismatches: string[] = [];
    for (const token of deployment.tokens) {
        if (!hasCode(await chain.getCode(token.address))) {
            problems.push(`${token.symbol}: no code at ${token.address}`);
            continue;
        }
        const [separator, decimals, config] = await Promise.all([
            readTokenDomainSeparator(chain, token.address),
            readDecimals(chain, token.address),
            readTokenConfig(chain, contract, token.address),
        ]);
        tokenDomains.push({ address: token.address, domainSeparator: separator });
        if (separator.toLowerCase() !== hashDomain(token.domain)) tokenDomainMismatches.push(token.symbol);
        if (Number(decimals) !== token.decimals) problems.push(`${token.symbol}: decimals() is ${decimals}, expected ${token.decimals}`);
        const expected = {
            permit: token.authModes.includes('permit'),
            metaTxApprove: token.authModes.includes('metaTxApprove'),
            allowance: token.authModes.includes('none'),
        };
        if (config.permit !== expected.permit || config.metaTxApprove !== expected.metaTxApprove || config.allowance !== expected.allowance) {
            problems.push(
                `${token.symbol}: tokenConfig on-chain (permit ${config.permit}, metaTxApprove ${config.metaTxApprove}, allowance ${config.allowance}) ` +
                    `does not match authModes ${JSON.stringify(token.authModes)}`,
            );
        }
    }

    if (deployment.chainId === POLYGON_CHAIN_ID) {
        for (const token of deployment.tokens) {
            const pin = POLYGON_TOKENS.find((p) => sameAddress(p.address, token.address));
            if (!pin || pin.symbol !== token.symbol) {
                problems.push(`${token.symbol} ${token.address} is not a pinned Polygon token`);
            } else if (hashDomain(pin.domain) !== hashDomain(token.domain) || token.authModes.some((m) => !pin.authModes.includes(m))) {
                problems.push(`${token.symbol}: domain or auth modes differ from the SDK pins`);
            }
        }
    }

    if (problems.length > 0) throw new StartupError(`deployment verification failed:\n - ${problems.join('\n - ')}`);
    logger?.info({ chainId, contract, tokens: deployment.tokens.map((t) => t.symbol) }, 'deployment verified on-chain');
    if (tokenDomainMismatches.length > 0) {
        logger?.warn(
            { tokens: tokenDomainMismatches },
            "a token's DOMAIN_SEPARATOR() differs from the deployment file: starting degraded, with its permit and meta-tx refused",
        );
    }
    return { tokenDomains, tokenDomainMismatches };
}

/** D11: zero address, the contract, the tokens, all legacy Nimiq contracts and configured extras. */
export function buildDenylist(deployment: Deployment, extra: readonly Address[]): Set<string> {
    return new Set(
        [ZERO_ADDRESS, deployment.gaslessTransfer, ...deployment.tokens.map((t) => t.address), ...LEGACY_NIMIQ_CONTRACTS_POLYGON, ...extra].map(
            (a) => a.toLowerCase(),
        ),
    );
}

export function buildRelayContext(
    deployment: Deployment,
    relay: Address,
    chain: ChainClient,
    extraDenylist: readonly Address[] = [],
): RelayContext {
    return {
        chainId: deployment.chainId,
        relay,
        contracts: { transfer: deployment.gaslessTransfer },
        deployBlock: deployment.deployBlock,
        tokens: new Map(deployment.tokens.map((t) => [t.address.toLowerCase(), t])),
        denylist: buildDenylist(deployment, extraDenylist),
        policy: { minDeadlineSeconds: MIN_DEADLINE_SECONDS, maxDeadlineSeconds: MAX_DEADLINE_SECONDS },
        chain,
    };
}

export function buildInfo(ctx: RelayContext, deployment: Deployment): InfoResponse {
    return {
        version: RELAY_VERSION,
        chainId: ctx.chainId,
        relay: ctx.relay,
        contracts: { transfer: { address: ctx.contracts.transfer, domain: transferDomain(ctx.chainId, ctx.contracts.transfer) } },
        tokens: deployment.tokens.map((t) => ({
            symbol: t.symbol,
            address: t.address,
            decimals: t.decimals,
            authModes: [...t.authModes],
            tokenDomain: t.domain,
        })),
        policy: {
            minDeadlineSeconds: MIN_DEADLINE_SECONDS,
            maxDeadlineSeconds: MAX_DEADLINE_SECONDS,
            quoteTtlSeconds: QUOTE_TTL_SECONDS,
        },
    };
}
