import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { encodeFunctionData, hashTypedData, keccak256, parseSignature, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
    META_TRANSACTION_TYPES,
    PERMIT_TYPES,
    POLYGON_USDC,
    POLYGON_USDT0,
    gaslessTransferAbi,
    usdt0Abi,
    type AuthModeName,
    type TokenAuthorization,
    type TransferRequest,
    type TypedDataDomain,
} from '@nimiq/gasless-sdk/core';
import type { SubmitTransferBody } from '@nimiq/gasless-sdk/relay';
import { createLocalSigner } from '../../src/chain/signer.js';
import type { Clock } from '../../src/clock.js';
import { parseDeployment, type Deployment, type GasTable, type TxManagerSettings } from '../../src/config.js';
import { SECP256K1_N } from '../../src/eip712.js';
import type { PriceSource } from '../../src/fees/priceSource.js';
import { TestPriceSource } from './priceSource.js';
import { createLogger, type Logger } from '../../src/logger.js';
import { createMetrics, type RelayMetrics } from '../../src/metrics.js';
import { createRelay, type Relay, type RelaySettings } from '../../src/relay.js';
import { SqliteStore } from '../../src/store/sqliteStore.js';
import { FakeChain, GWEI } from './fakeChain.js';
import { OTHER_ADDRESS, OTHER_KEY, RECIPIENT_ADDRESS, RELAY_ADDRESS, RELAY_KEY, USER_ADDRESS, USER_KEY } from './keys.js';

export const START_TIME = 1_790_000_000;
export const CONTRACT: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const USDC: Address = POLYGON_USDC.address;
export const USDT0: Address = POLYGON_USDT0.address;
export const TOKEN_DOMAINS: Readonly<Record<string, TypedDataDomain>> = {
    [USDC.toLowerCase()]: POLYGON_USDC.domain,
    [USDT0.toLowerCase()]: POLYGON_USDT0.domain,
};

export function deploymentJson(): Record<string, unknown> {
    return {
        version: '3',
        chainId: 137,
        gaslessTransfer: CONTRACT,
        // The fake chain's first block (FakeChain's head starts there).
        deployBlock: '1000',
        tokens: [
            { symbol: 'USDC', address: USDC, decimals: 6, authModes: ['permit', 'none'], domain: { ...POLYGON_USDC.domain } },
            {
                symbol: 'USDT0',
                address: USDT0,
                decimals: 6,
                authModes: ['permit', 'metaTxApprove', 'none'],
                domain: { ...POLYGON_USDT0.domain },
            },
        ],
    };
}

export function testDeployment(): Deployment {
    return parseDeployment(deploymentJson());
}

export const TEST_GAS_TABLE: GasTable = {
    source: 'test',
    margin: 0.1,
    operations: { transfer: { permit: 250_000, metaTxApprove: 260_000, none: 200_000 } },
};

export const TEST_TX_SETTINGS: TxManagerSettings = {
    pollIntervalMs: 1000,
    speedUpAfterBlocks: 10,
    speedUpPercent: 20,
    maxFeePerGas: 3000n * GWEI,
    minTip: 30n * GWEI,
    maxInFlight: 4,
    reservedPrioritySlots: 1,
    maxGasLimit: 1_000_000n,
    gasLimitMarginPercent: 30,
    minSecondsToBroadcast: 10,
    deadlineSafetySeconds: 2,
    finalityFallbackDepth: 256,
    unknownNonceGraceBlocks: 12,
};

/**
 * The relay's clock in tests. `ms` is the wall clock. The monotonic clock (Clock.monotonicMs) moves forward with it,
 * but not back: a negative `advance` (or a lower `ms`) is a step of the wall clock, as an NTP correction makes it,
 * while time itself goes on.
 */
export class TestClock implements Clock {
    private wallMs: number;
    private monoMs: number;
    constructor(ms: number) {
        this.wallMs = ms;
        this.monoMs = ms;
    }
    get ms(): number {
        return this.wallMs;
    }
    set ms(value: number) {
        if (value > this.wallMs) this.monoMs += value - this.wallMs;
        this.wallMs = value;
    }
    nowMs(): number {
        return this.wallMs;
    }
    monotonicMs(): number {
        return this.monoMs;
    }
    advance(seconds: number): void {
        this.ms = this.wallMs + seconds * 1000;
    }
    seconds(): number {
        return Math.floor(this.wallMs / 1000);
    }
}

export function captureLogger(level = 'debug'): { logger: Logger; lines: string[]; text: () => string } {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
        },
    });
    return { logger: createLogger({ level }, stream), lines, text: () => lines.join('') };
}

export interface Harness {
    readonly dir: string;
    readonly dbPath: string;
    readonly chain: FakeChain;
    readonly clock: TestClock;
    readonly store: SqliteStore;
    readonly logs: ReturnType<typeof captureLogger>;
    readonly metrics: RelayMetrics;
    readonly relay: Relay;
    readonly deployment: Deployment;
    close(): Promise<void>;
}

export interface HarnessOptions {
    readonly settings?: Partial<RelaySettings>;
    readonly price?: string;
    /** Replaces the fixed test price source, e.g. with a Chainlink source that reads the fake chain's feed. */
    readonly priceSource?: (deps: { chain: FakeChain; clock: TestClock; metrics: RelayMetrics }) => PriceSource;
    /** Changes the deployment file (deploymentJson()) of a new harness; the fake chain is deployed to match it. */
    readonly deployment?: (json: Record<string, unknown> & { tokens: Array<Record<string, unknown>> }) => void;
}

export const DEFAULT_SETTINGS: RelaySettings = {
    rateLimit: { signerMax: 10_000, signerWindowMs: 60_000 },
    feeMarginBps: 1000,
    feeCacheMs: 0,
    minPolBalanceWei: 10n ** 18n,
    recipientDenylist: [],
    tx: TEST_TX_SETTINGS,
    readinessIncludesTxManager: false,
    // The attempts of a token implementation check without their waits.
    tokenImplementationRetryDelaysMs: [0, 0],
};

async function assemble(
    base: { dir: string; dbPath: string; chain: FakeChain; clock: TestClock; deployment: Deployment },
    options: HarnessOptions,
): Promise<Harness> {
    const store = SqliteStore.open(base.dbPath, { lockTimeoutMs: 100 });
    store.bindIdentity({ chainId: 137, relay: RELAY_ADDRESS, gaslessTransfer: base.deployment.gaslessTransfer });
    const logs = captureLogger();
    const metrics = createMetrics();
    const priceSource =
        options.priceSource?.({ chain: base.chain, clock: base.clock, metrics }) ?? new TestPriceSource(options.price ?? '0.2', metrics);
    const relay = await createRelay({
        deployment: base.deployment,
        gasTable: TEST_GAS_TABLE,
        chain: base.chain,
        signer: createLocalSigner(RELAY_KEY),
        store,
        priceSource,
        logger: logs.logger,
        clock: base.clock,
        metrics,
        settings: { ...DEFAULT_SETTINGS, ...options.settings },
    });
    return {
        ...base,
        store,
        logs,
        metrics,
        relay,
        async close() {
            await relay.close();
            store.close();
            rmSync(base.dir, { recursive: true, force: true });
        },
    };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
    const dbPath = join(dir, 'relay.sqlite');
    const clock = new TestClock(START_TIME * 1000);
    const json = deploymentJson() as Record<string, unknown> & { tokens: Array<Record<string, unknown>> };
    options.deployment?.(json);
    const deployment = parseDeployment(json);
    const chain = new FakeChain({ deployment, timestamp: START_TIME, relay: RELAY_ADDRESS });
    chain.setBalance(USDC, USER_ADDRESS, 100_000_000n);
    chain.setBalance(USDT0, USER_ADDRESS, 100_000_000n);
    return assemble({ dir, dbPath, chain, clock, deployment }, options);
}

/** Simulates a process restart: closes relay and database and reopens them on the same chain. */
export async function restartHarness(h: Harness, options: HarnessOptions = {}): Promise<Harness> {
    await h.relay.close();
    h.store.close();
    return assemble({ dir: h.dir, dbPath: h.dbPath, chain: h.chain, clock: h.clock, deployment: h.deployment }, options);
}

// ---------------------------------------------------------------------------------------------
// Signing (independent of the relay code: viem typed-data signing with literal domains)
// ---------------------------------------------------------------------------------------------

export const ZERO_WORD: Hex = `0x${'00'.repeat(32)}`;
/** The token authorization of mode "none": v 0, r and s zero. */
export const NO_AUTH: TokenAuthorization = Object.freeze({ mode: 'none', v: 0, r: ZERO_WORD, s: ZERO_WORD });

export function transferDomainLiteral(): TypedDataDomain {
    return { name: 'Nimiq Gasless Transfer', version: '3', chainId: 137, verifyingContract: CONTRACT };
}

const TRANSFER_TYPES_LITERAL = {
    GaslessTransfer: [
        { name: 'token', type: 'address' },
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint256' },
        { name: 'relay', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'auth', type: 'TokenAuth' },
    ],
    TokenAuth: [
        { name: 'mode', type: 'uint8' },
        { name: 'v', type: 'uint8' },
        { name: 'r', type: 'bytes32' },
        { name: 's', type: 'bytes32' },
    ],
} as const;

const MODE_ID: Readonly<Record<AuthModeName, number>> = { none: 0, permit: 1, metaTxApprove: 2 };

function transferMessage(r: TransferRequest, a: TokenAuthorization) {
    return {
        token: r.token,
        from: r.from,
        to: r.to,
        amount: BigInt(r.amount),
        fee: BigInt(r.fee),
        relay: r.relay,
        nonce: BigInt(r.nonce),
        deadline: BigInt(r.deadline),
        auth: { mode: MODE_ID[a.mode], v: a.v, r: a.r, s: a.s },
    };
}

/** The request id computed independently (must equal the relay's id and the contract's hashTransfer). */
export function expectedRequestId(request: TransferRequest, authorization: TokenAuthorization): Hex {
    return hashTypedData({
        domain: transferDomainLiteral(),
        types: TRANSFER_TYPES_LITERAL,
        primaryType: 'GaslessTransfer',
        message: transferMessage(request, authorization),
    });
}

export async function signTransferRequest(
    key: Hex,
    request: TransferRequest,
    authorization: TokenAuthorization,
    domain = transferDomainLiteral(),
): Promise<Hex> {
    return privateKeyToAccount(key).signTypedData({
        domain,
        types: TRANSFER_TYPES_LITERAL,
        primaryType: 'GaslessTransfer',
        message: transferMessage(request, authorization),
    });
}

/** A deterministic test key for sender `index` (distinct from the well-known keys). */
export function senderKey(index: number): Hex {
    return keccak256(toHex(`relay test sender ${index}`));
}

/** A funded sender: `senderKey(index)` with 100 USDC and 100 USDT0 on the chain. */
export function fundedSender(chain: FakeChain, index: number): { key: Hex; address: Address } {
    const key = senderKey(index);
    const address = privateKeyToAccount(key).address;
    chain.setBalance(USDC, address, 100_000_000n);
    chain.setBalance(USDT0, address, 100_000_000n);
    return { key, address };
}

const funded = new WeakMap<FakeChain, Set<number>>();
/** The key of sender `index`, funded on this chain the first time it is used. */
function senderOn(chain: FakeChain, index: number): Hex {
    let seen = funded.get(chain);
    if (!seen) funded.set(chain, (seen = new Set()));
    if (!seen.has(index)) {
        seen.add(index);
        return fundedSender(chain, index).key;
    }
    return senderKey(index);
}

/** The address of sender `index` (see senderKey). */
export function senderAddress(index: number): Address {
    return privateKeyToAccount(senderKey(index)).address;
}

const autoSenders = new WeakMap<FakeChain, number>();
/**
 * For tests that queue several requests (the relay keeps one queued or in-flight request per sender): `o` itself when it
 * names its signer or USER may submit now (no request of USER holds its next nonce), else `o` for a new funded sender
 * that has USER's allowances to the contract (mode "none").
 */
export function autoSender(h: { chain: FakeChain; store: SqliteStore }, o: TransferOptions = {}): TransferOptions {
    if (o.key !== undefined || o.sender !== undefined) return o;
    const next = h.chain.intentNonce(USER_ADDRESS).toString();
    if (h.store.admissionCounts(USER_ADDRESS).pendingOfSigner === 0 && !h.store.nonceHolder(CONTRACT, USER_ADDRESS, next)) return o;
    const index = (autoSenders.get(h.chain) ?? 1000) + 1;
    autoSenders.set(h.chain, index);
    const address = senderAddress(index);
    for (const token of [USDC, USDT0]) {
        const allowance = h.chain.token(token).allowances.get(`${USER_ADDRESS.toLowerCase()}:${CONTRACT.toLowerCase()}`);
        if (allowance !== undefined) h.chain.setAllowance(token, address, CONTRACT, allowance);
    }
    return { ...o, sender: index };
}

export async function signPermit(
    key: Hex,
    domain: TypedDataDomain,
    spender: Address,
    value: bigint,
    nonce: bigint,
    deadline: bigint,
): Promise<{ v: number; r: Hex; s: Hex }> {
    const account = privateKeyToAccount(key);
    const signature = await account.signTypedData({
        domain,
        types: PERMIT_TYPES,
        primaryType: 'Permit',
        message: { owner: account.address, spender, value, nonce, deadline },
    });
    const { r, s, v } = parseSignature(signature);
    return { v: Number(v), r, s };
}

export async function signMetaTxApprove(
    key: Hex,
    domain: TypedDataDomain,
    spender: Address,
    value: bigint,
    nonce: bigint,
): Promise<{ v: number; r: Hex; s: Hex }> {
    const account = privateKeyToAccount(key);
    const functionSignature = encodeFunctionData({ abi: usdt0Abi, functionName: 'approve', args: [spender, value] });
    const signature = await account.signTypedData({
        domain,
        types: META_TRANSACTION_TYPES,
        primaryType: 'MetaTransaction',
        message: { nonce, from: account.address, functionSignature },
    });
    const { r, s, v } = parseSignature(signature);
    return { v: Number(v), r, s };
}

/** Same signature with s' = n − s and flipped v (valid for plain ecrecover, rejected as high-s). */
export function toHighS(signature: Hex): Hex {
    const r = signature.slice(2, 66);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130, 132), 16);
    return `0x${r}${(SECP256K1_N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
}

export interface TransferOptions {
    token?: Address;
    mode?: AuthModeName;
    amount?: bigint;
    fee?: bigint;
    to?: Address;
    deadline?: bigint;
    /** The intent nonce; default: the sender's `nonces` on the fake chain. */
    nonce?: bigint;
    key?: Hex;
    /** Sign as `fundedSender(chain, sender)` (funded on first use) instead of `key`: the relay keeps one pending request per sender. */
    sender?: number;
    relay?: Address;
    /** Sign these fields instead of the submitted ones (tampering tests). */
    signedOverrides?: Partial<TransferRequest>;
    /** Sign and submit this token authorization instead of the one built for `mode` (e.g. a malformed token signature). */
    authorization?: TokenAuthorization;
    /** Sign this token authorization instead of the submitted one (tampering tests). */
    signedAuthorization?: TokenAuthorization;
    /** Submit this token authorization instead of the signed one (tampering tests). */
    submittedAuthorization?: TokenAuthorization;
    signWith?: Hex;
    authKey?: Hex;
    authNonce?: bigint;
    authValue?: bigint;
    authSpender?: Address;
    authDeadline?: bigint;
    authDomain?: TypedDataDomain;
}

export interface BuiltTransfer {
    readonly body: SubmitTransferBody;
    readonly id: Hex;
    readonly request: TransferRequest;
    readonly authorization: TokenAuthorization;
}

/**
 * Another request of a sender at an intent nonce (by default fee 20000 and mode "none"), signed for another relay (OTHER)
 * and sent by that relay's key to the fake chain's mempool: the next block executes it, as another version of a payment
 * that went through another relay would. With `copies`, that relay first sends that many copies of the call with too
 * little gas, which revert (out of gas) in the same block. Returns the request and the transactions' hashes.
 */
export async function sendThroughOtherRelay(
    h: { chain: FakeChain; clock: TestClock },
    o: TransferOptions = {},
    copies = 0,
): Promise<{ built: BuiltTransfer; hash: Hex; copies: Hex[] }> {
    const built = await buildTransfer(h, { fee: 20_000n, mode: 'none', ...o, relay: OTHER_ADDRESS });
    const r = built.request;
    const a = built.authorization;
    const data = encodeFunctionData({
        abi: gaslessTransferAbi,
        functionName: 'relayTransfer',
        args: [
            { token: r.token, from: r.from, to: r.to, amount: BigInt(r.amount), fee: BigInt(r.fee), relay: r.relay, deadline: BigInt(r.deadline) },
            built.body.signature,
            { mode: MODE_ID[a.mode], v: a.v, r: a.r, s: a.s },
        ],
    });
    const signer = createLocalSigner(OTHER_KEY);
    // Each transaction takes the next nonce of the other relay's account: they queue up in the mempool.
    const account = OTHER_ADDRESS.toLowerCase();
    let first = h.chain.accountNonces.get(account) ?? 0;
    while (h.chain.mempool.has(`${account}:${first}`)) first += 1;
    const send = async (gas: bigint, nonce: number): Promise<Hex> => {
        const raw = await signer.signTransaction({
            type: 'eip1559',
            chainId: h.chain.chainId,
            nonce,
            to: h.chain.contract.address,
            data,
            value: 0n,
            gas,
            maxFeePerGas: 100n * GWEI,
            maxPriorityFeePerGas: 30n * GWEI,
        });
        const outcome = await h.chain.sendRawTransaction(raw);
        if (outcome.kind !== 'accepted') throw new Error(`fake: the other relay's transaction was not accepted (${outcome.kind})`);
        return keccak256(raw);
    };
    const sent: Hex[] = [];
    for (let i = 0; i < copies; i++) sent.push(await send(30_000n, first + i));
    if (copies > 0) {
        const outOfGas = new Set(sent);
        const execute = h.chain.executor;
        h.chain.executor = (tx) => (outOfGas.has(tx.hash) ? 'reverted' : execute(tx));
    }
    return { built, hash: await send(300_000n, first + copies), copies: sent };
}

export async function buildTransfer(h: { chain: FakeChain; clock: TestClock }, o: TransferOptions = {}): Promise<BuiltTransfer> {
    const key = o.sender !== undefined ? senderOn(h.chain, o.sender) : (o.key ?? USER_KEY);
    const from = privateKeyToAccount(key).address;
    const token = o.token ?? USDC;
    const request: TransferRequest = {
        token,
        from,
        to: o.to ?? RECIPIENT_ADDRESS,
        amount: (o.amount ?? 1_000_000n).toString(),
        fee: (o.fee ?? 10_000n).toString(),
        relay: o.relay ?? RELAY_ADDRESS,
        nonce: (o.nonce ?? h.chain.intentNonce(from)).toString(),
        deadline: (o.deadline ?? BigInt(h.clock.seconds() + 600)).toString(),
    };
    const mode = o.mode ?? 'permit';
    let authorization: TokenAuthorization = NO_AUTH;
    if (mode !== 'none') {
        const domain = o.authDomain ?? TOKEN_DOMAINS[token.toLowerCase()];
        if (!domain) throw new Error('unknown token domain');
        const value = o.authValue ?? BigInt(request.amount) + BigInt(request.fee);
        const nonce = o.authNonce ?? h.chain.token(token).nonces.get(from.toLowerCase()) ?? 0n;
        const spender = o.authSpender ?? CONTRACT;
        const parts =
            mode === 'permit'
                ? await signPermit(o.authKey ?? key, domain, spender, value, nonce, o.authDeadline ?? BigInt(request.deadline))
                : await signMetaTxApprove(o.authKey ?? key, domain, spender, value, nonce);
        authorization = { mode, ...parts };
    }
    if (o.authorization) authorization = o.authorization;
    // The intent signs the token authorization: sign it first, then the transfer over it.
    const signed = o.signedAuthorization ?? authorization;
    const signature = await signTransferRequest(o.signWith ?? key, { ...request, ...o.signedOverrides }, signed);
    const submitted = o.submittedAuthorization ?? authorization;
    return { body: { request, signature, authorization: submitted }, id: expectedRequestId(request, submitted), request, authorization: submitted };
}
