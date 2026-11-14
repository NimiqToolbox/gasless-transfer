// Chain pins: everything a client trusts about a deployment (§7). Clients compare the relay's
// /v1/info, relay-supplied fees and every request they sign against these values.

import { isAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from './address.js';
import { deepFreeze, isPlainObject } from './bytes.js';
import { LEGACY_NIMIQ_CONTRACTS_POLYGON, POLYGON_CHAIN_ID, POLYGON_TOKENS } from './constants.js';
import { FEE_TOKEN_DECIMALS } from './defaults.js';
import { hashDomain } from './eip712.js';
import { InvalidPinsError } from './errors.js';
import { TRANSFER_DOMAIN_VERSION, transferDomain } from './typedData.js';
import { AUTH_MODE_ID, type Address, type AuthModeName, type Hex, type TypedDataDomain } from './types.js';

export interface PinnedToken {
    readonly symbol: string;
    /** Checksummed. */
    readonly address: Address;
    readonly decimals: number;
    readonly authModes: readonly AuthModeName[];
    /** EIP-712 domain of the token's permit / meta-tx signatures. */
    readonly domain: TypedDataDomain;
    /** `hashDomain(domain)`: the value the token's `DOMAIN_SEPARATOR()` must return (see `checkTokenDomain`). */
    readonly domainSeparator: Hex;
}

export interface ChainPins {
    readonly chainId: number;
    /** The GaslessTransfer contract and its EIP-712 domain ("Nimiq Gasless Transfer", "3", chainId, address). */
    readonly transfer: { readonly address: Address; readonly domain: TypedDataDomain };
    /** Relay addresses clients may sign for (`request.relay`). Several allow a key rotation (D5). */
    readonly relays: readonly Address[];
    /** The tokens clients may sign for. Nothing caps the fee: only the fee `from` signs bounds it. */
    readonly tokens: readonly PinnedToken[];
    /**
     * A block at or below the one that created the contract (the deploy scripts record the block before their
     * broadcast); null if unknown. The viem adapter's `confirmOnChain` searches no state and no log below it, so a
     * block above the creation is a wrong pin, never a safe estimate: what used a nonce below it is not found.
     */
    readonly deployBlock: number | null;
    /** Further recipients to reject besides the built-in denylist. */
    readonly extraDeniedRecipients: readonly Address[];
}

export interface TokenPinInput {
    readonly symbol: string;
    readonly address: string;
    readonly decimals: number;
    readonly authModes: readonly AuthModeName[];
    readonly domain: TypedDataDomain;
    /** Optional expected separator; if given it must equal `hashDomain(domain)`. */
    readonly domainSeparator?: string;
}

export interface ChainPinsInput {
    readonly chainId: number;
    /** Address of the GaslessTransfer contract. */
    readonly transfer: string;
    readonly relays: readonly string[];
    readonly tokens: readonly TokenPinInput[];
    readonly deployBlock?: number | null;
    readonly extraDeniedRecipients?: readonly string[];
}

/**
 * The most tokens pins hold and a relay's /v1/info may list (`parseInfo`), far above any real deployment (two tokens
 * today): it bounds the work a relay's answer can cause, and pins with more tokens could match no relay.
 */
export const MAX_PINNED_TOKENS = 32;

const AUTH_MODE_NAMES: readonly AuthModeName[] = ['none', 'permit', 'metaTxApprove'];
const DOMAIN_KEYS: readonly string[] = ['name', 'version', 'chainId', 'verifyingContract', 'salt'];
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SYMBOL_RE = /^[\x21-\x7e]{1,32}$/;

function fail(field: string, message: string): never {
    throw new InvalidPinsError(field, message);
}

function pinAddress(value: unknown, field: string): Address {
    if (typeof value !== 'string') fail(field, 'expected an address string');
    let address: Address;
    try {
        address = toChecksumAddress(value, field);
    } catch (error) {
        fail(field, error instanceof Error ? error.message : 'invalid address');
    }
    if (address === ZERO_ADDRESS) fail(field, 'must not be the zero address');
    return address;
}

function positiveSafeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(field, 'expected a positive integer');
    return value;
}

/** bytes32(chainId), the salt of salt-based token domains such as USDT0's. */
export function chainIdSalt(chainId: number): Hex {
    return `0x${chainId.toString(16).padStart(64, '0')}`;
}

function pinDomain(input: unknown, field: string, chainId: number, tokenAddress: Address): TypedDataDomain {
    if (!isPlainObject(input)) fail(field, 'expected an object');
    for (const key of Object.keys(input)) {
        if (!DOMAIN_KEYS.includes(key)) fail(`${field}.${key}`, 'unexpected EIP-712 domain field');
    }
    const { name, version, chainId: domainChainId, verifyingContract, salt } = input;
    if (typeof name !== 'string' || name.length === 0) fail(`${field}.name`, 'expected a non-empty string');
    if (typeof version !== 'string' || version.length === 0) fail(`${field}.version`, 'expected a non-empty string');
    if (domainChainId !== undefined && domainChainId !== chainId) fail(`${field}.chainId`, `must equal the pinned chainId ${chainId}`);
    if (!sameAddress(pinAddress(verifyingContract, `${field}.verifyingContract`), tokenAddress)) {
        fail(`${field}.verifyingContract`, 'must equal the token address');
    }
    if (salt !== undefined) {
        if (typeof salt !== 'string' || !BYTES32_RE.test(salt)) fail(`${field}.salt`, 'expected bytes32');
        if (salt.toLowerCase() !== chainIdSalt(chainId)) fail(`${field}.salt`, 'must be bytes32(chainId)');
    }
    // Without chainId or salt, a token signature would be valid on every chain.
    if (domainChainId === undefined && salt === undefined) fail(field, 'must bind the chain via chainId or salt');
    return {
        name,
        version,
        ...(domainChainId !== undefined ? { chainId } : {}),
        verifyingContract: tokenAddress,
        ...(salt !== undefined ? { salt: (salt as string).toLowerCase() as Hex } : {}),
    };
}

function pinToken(input: unknown, field: string, chainId: number): PinnedToken {
    if (!isPlainObject(input)) fail(field, 'expected an object');
    const { symbol, decimals, authModes, domainSeparator } = input;
    if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) fail(`${field}.symbol`, 'expected 1-32 printable characters without spaces');
    const address = pinAddress(input.address, `${field}.address`);
    if (decimals !== FEE_TOKEN_DECIMALS) {
        fail(`${field}.decimals`, `must be ${FEE_TOKEN_DECIMALS} (MIN_FEE, the fee granularity and the relay's fee engine assume it)`);
    }
    if (!Array.isArray(authModes) || authModes.length === 0) fail(`${field}.authModes`, 'expected a non-empty array');
    const modes: AuthModeName[] = [];
    for (const [i, mode] of authModes.entries()) {
        if (!AUTH_MODE_NAMES.includes(mode as AuthModeName)) fail(`${field}.authModes[${i}]`, 'unknown auth mode');
        if (modes.includes(mode as AuthModeName)) fail(`${field}.authModes[${i}]`, 'duplicate auth mode');
        modes.push(mode as AuthModeName);
    }
    const domain = pinDomain(input.domain, `${field}.domain`, chainId, address);
    const separator = hashDomain(domain);
    if (
        domainSeparator !== undefined &&
        (typeof domainSeparator !== 'string' || !BYTES32_RE.test(domainSeparator) || domainSeparator.toLowerCase() !== separator)
    ) {
        fail(`${field}.domainSeparator`, 'expected bytes32 equal to the hash of the domain');
    }
    return { symbol, address, decimals, authModes: modes, domain, domainSeparator: separator };
}

function sameAuthModes(a: readonly AuthModeName[], b: readonly AuthModeName[]): boolean {
    return a.length === b.length && a.every((mode) => b.includes(mode));
}

/**
 * Field-by-field domain equality: same fields present, addresses and salts compared
 * case-insensitively. Malformed values (e.g. from plain JS) compare unequal instead of throwing.
 */
export function sameDomain(a: TypedDataDomain, b: TypedDataDomain): boolean {
    const sameSalt =
        a.salt === undefined || b.salt === undefined
            ? a.salt === b.salt
            : typeof a.salt === 'string' && typeof b.salt === 'string' && a.salt.toLowerCase() === b.salt.toLowerCase();
    return (
        a.name === b.name &&
        a.version === b.version &&
        a.chainId === b.chainId &&
        sameAddress(a.verifyingContract, b.verifyingContract) &&
        sameSalt
    );
}

/** On Polygon mainnet every pinned token must equal the frozen, mainnet-verified constants. */
function checkPolygonToken(token: PinnedToken, field: string): void {
    const known = POLYGON_TOKENS.find((t) => sameAddress(t.address, token.address));
    if (known === undefined) fail(`${field}.address`, 'not a known Polygon token (USDC, USDT0)');
    if (token.symbol !== known.symbol) fail(`${field}.symbol`, `expected ${known.symbol}`);
    if (!sameAuthModes(token.authModes, known.authModes)) fail(`${field}.authModes`, `expected ${known.authModes.join(', ')}`);
    if (!sameDomain(token.domain, known.domain)) fail(`${field}.domain`, `does not match the ${known.symbol} domain`);
    if (token.domainSeparator !== known.domainSeparator.toLowerCase()) fail(`${field}.domain`, 'separator differs from the pinned mainnet value');
}

/**
 * Validates and normalizes pins (checksummed addresses, derived domains and separators) and returns a
 * deep-frozen copy. Throws `InvalidPinsError` on any inconsistency.
 */
export function definePins(input: ChainPinsInput): ChainPins {
    if (!isPlainObject(input)) fail('pins', 'expected an object');
    const chainId = positiveSafeInteger(input.chainId, 'chainId');
    const transferAddress = pinAddress(input.transfer, 'transfer');

    if (!Array.isArray(input.tokens) || input.tokens.length === 0) fail('tokens', 'expected a non-empty array');
    if (input.tokens.length > MAX_PINNED_TOKENS) fail('tokens', `expected at most ${MAX_PINNED_TOKENS} tokens`);
    const tokens: PinnedToken[] = [];
    for (const [i, raw] of input.tokens.entries()) {
        const token = pinToken(raw, `tokens[${i}]`, chainId);
        if (tokens.some((t) => t.address === token.address)) fail(`tokens[${i}].address`, 'duplicate token');
        if (tokens.some((t) => t.symbol === token.symbol)) fail(`tokens[${i}].symbol`, 'duplicate symbol');
        if (token.address === transferAddress) fail(`tokens[${i}].address`, 'must differ from the transfer contract');
        if (chainId === POLYGON_CHAIN_ID) checkPolygonToken(token, `tokens[${i}]`);
        tokens.push(token);
    }

    if (!Array.isArray(input.relays) || input.relays.length === 0) fail('relays', 'expected a non-empty array');
    const relays: Address[] = [];
    for (const [i, raw] of input.relays.entries()) {
        const relay = pinAddress(raw, `relays[${i}]`);
        if (relays.includes(relay)) fail(`relays[${i}]`, 'duplicate relay');
        if (relay === transferAddress || tokens.some((t) => t.address === relay)) {
            fail(`relays[${i}]`, 'must not be the transfer contract or a token');
        }
        relays.push(relay);
    }

    let deployBlock: number | null = null;
    if (input.deployBlock !== undefined && input.deployBlock !== null) {
        if (typeof input.deployBlock !== 'number' || !Number.isSafeInteger(input.deployBlock) || input.deployBlock < 0) {
            fail('deployBlock', 'expected a non-negative integer');
        }
        deployBlock = input.deployBlock;
    }

    const extraDeniedRecipients: Address[] = [];
    if (input.extraDeniedRecipients !== undefined) {
        if (!Array.isArray(input.extraDeniedRecipients)) fail('extraDeniedRecipients', 'expected an array');
        for (const [i, raw] of input.extraDeniedRecipients.entries()) {
            const address = pinAddress(raw, `extraDeniedRecipients[${i}]`);
            if (!extraDeniedRecipients.includes(address)) extraDeniedRecipients.push(address);
        }
    }

    if (chainId === POLYGON_CHAIN_ID && LEGACY_NIMIQ_CONTRACTS_POLYGON.some((a) => sameAddress(a, transferAddress))) {
        fail('transfer', 'is a legacy Nimiq contract');
    }

    return deepFreeze({
        chainId,
        transfer: { address: transferAddress, domain: transferDomain(chainId, transferAddress) },
        relays,
        tokens,
        deployBlock,
        extraDeniedRecipients,
    });
}

/** The pinned token with this address (case-insensitive), if any. */
export function findPinnedToken(pins: ChainPins, address: string): PinnedToken | undefined {
    return pins.tokens.find((token) => sameAddress(token.address, address));
}

// --- Deployment file -------------------------------------------------------------------------------

/**
 * Deployment file written by the deploy script (contracts/deployments/<chainId>.json):
 * `{"chainId","version":"3","gaslessTransfer","initialOwner","deployBlock","tokens":[{"symbol","address","decimals","authModes","domain"}]}`.
 * `version` is the contract's EIP-712 domain version; a record of another version, or without one, is refused.
 * Integers may be JSON numbers or decimal strings. `authModes` entries may be SDK names ("permit"), Solidity
 * enum names ("PERMIT") or enum values (1). The token entries are the constructor's configuration; a token
 * entry may also carry the expected `domainSeparator`. The record and its token entries have exact keys: an
 * unknown key is refused. Domain objects are strict too.
 */
export interface DeploymentFile {
    readonly chainId: number | string;
    readonly version: string;
    readonly gaslessTransfer: string;
    readonly initialOwner?: string;
    readonly deployBlock: number | string;
    readonly tokens: ReadonlyArray<{
        readonly symbol: string;
        readonly address: string;
        readonly decimals: number | string;
        readonly authModes: ReadonlyArray<string | number>;
        readonly domainSeparator?: string;
        readonly domain: {
            readonly name: string;
            readonly version: string;
            readonly chainId?: number | string | null;
            readonly verifyingContract: string;
            readonly salt?: string | null;
        };
    }>;
}

export interface PinsFromDeploymentOptions {
    /** The relay address(es) clients may sign for; they are not part of the deployment file. */
    readonly relays: readonly string[];
    readonly extraDeniedRecipients?: readonly string[];
}

const AUTH_MODE_ALIASES: Readonly<Record<string, AuthModeName>> = {
    none: 'none',
    permit: 'permit',
    metaTxApprove: 'metaTxApprove',
    NONE: 'none',
    PERMIT: 'permit',
    META_TX_APPROVE: 'metaTxApprove',
};

function fileInteger(value: unknown, field: string): number {
    const n =
        typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0) fail(field, 'expected a non-negative integer (number or decimal string)');
    return n;
}

function fileAuthMode(value: unknown, field: string): AuthModeName {
    if (typeof value === 'number') {
        const byId = AUTH_MODE_NAMES.find((name) => AUTH_MODE_ID[name] === value);
        if (byId !== undefined) return byId;
    } else if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUTH_MODE_ALIASES, value)) {
        return AUTH_MODE_ALIASES[value] as AuthModeName;
    }
    return fail(field, 'unknown auth mode');
}

function fileDomain(value: unknown, field: string): TypedDataDomain {
    if (!isPlainObject(value)) fail(field, 'expected an object');
    const domain: Record<string, unknown> = { ...value };
    if (domain.chainId === null) delete domain.chainId;
    else if (domain.chainId !== undefined) domain.chainId = fileInteger(domain.chainId, `${field}.chainId`);
    if (domain.salt === null) delete domain.salt;
    return domain as unknown as TypedDataDomain;
}

const DEPLOYMENT_KEYS: readonly string[] = ['chainId', 'version', 'gaslessTransfer', 'initialOwner', 'deployBlock', 'tokens'];
const DEPLOYMENT_TOKEN_KEYS: readonly string[] = ['symbol', 'address', 'decimals', 'authModes', 'domain', 'domainSeparator'];

/** Exact keys of a record object (`prefix` is its path, '' for the record itself). */
function fileKeys(value: Record<string, unknown>, keys: readonly string[], prefix: string): void {
    for (const key of Object.keys(value)) {
        if (!keys.includes(key)) fail(prefix === '' ? key : `${prefix}.${key}`, `unexpected key in a version ${TRANSFER_DOMAIN_VERSION} record`);
    }
}

/**
 * Pins from a parsed deployment file (see `DeploymentFile`) plus the relay addresses. Fails closed on a record
 * that is not version "3", the only domain version this SDK signs: its typed data must never be paired with the
 * address of a contract of another version.
 */
export function pinsFromDeployment(deployment: unknown, options: PinsFromDeploymentOptions): ChainPins {
    if (!isPlainObject(deployment)) fail('deployment', 'expected an object');
    if (!isPlainObject(options)) fail('options', 'expected { relays }');
    if (deployment.version !== TRANSFER_DOMAIN_VERSION) {
        fail('version', `expected "${TRANSFER_DOMAIN_VERSION}", the GaslessTransfer domain version this SDK signs`);
    }
    fileKeys(deployment, DEPLOYMENT_KEYS, '');
    // The pins do not use the owner, but a record that names one must name an address, as the relay requires.
    if (deployment.initialOwner !== undefined && !isAddress(deployment.initialOwner)) {
        fail('initialOwner', 'expected an address (mixed case must be a valid checksum)');
    }
    if (!Array.isArray(deployment.tokens)) fail('tokens', 'expected an array');
    return definePins({
        chainId: fileInteger(deployment.chainId, 'chainId'),
        transfer: pinAddress(deployment.gaslessTransfer, 'gaslessTransfer'),
        deployBlock: fileInteger(deployment.deployBlock, 'deployBlock'),
        relays: options.relays,
        ...(options.extraDeniedRecipients !== undefined ? { extraDeniedRecipients: options.extraDeniedRecipients } : {}),
        tokens: deployment.tokens.map((raw: unknown, i: number): TokenPinInput => {
            const field = `tokens[${i}]`;
            if (!isPlainObject(raw)) fail(field, 'expected an object');
            fileKeys(raw, DEPLOYMENT_TOKEN_KEYS, field);
            if (!Array.isArray(raw.authModes)) fail(`${field}.authModes`, 'expected an array');
            return {
                symbol: raw.symbol as string,
                address: raw.address as string,
                decimals: fileInteger(raw.decimals, `${field}.decimals`),
                authModes: raw.authModes.map((mode: unknown, j: number) => fileAuthMode(mode, `${field}.authModes[${j}]`)),
                domain: fileDomain(raw.domain, `${field}.domain`),
                // Passed on whenever present: definePins refuses a value that is not the domain's hash, also a non-string.
                ...(raw.domainSeparator !== undefined ? { domainSeparator: raw.domainSeparator as string } : {}),
            };
        }),
    });
}
