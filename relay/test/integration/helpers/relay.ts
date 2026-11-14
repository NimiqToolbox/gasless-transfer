// The relay under test (production wiring: config → deployment file → on-chain verification → SQLite
// → relay → transaction manager → HTTP) and the wallet side, which only uses the SDK: fee quote,
// prepareTransfer (or, for an intent nonce the test chooses, the core's createTransferIntent), signing
// with viem (signPrepared), ethers v5 (_signTypedData) or ethers v6 (signTypedData), submitTransfer.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Address, Hex, PrivateKeyAccount } from 'viem';
import {
    AUTH_MODE_ID,
    NO_TOKEN_AUTHORIZATION,
    TRANSFER_TYPES,
    buildSubmitTransferBody,
    createTransferIntent,
    toTokenAuthorization,
    tokenAuthSigningPayload,
    transferDigest,
    transferSigningPayload,
    type AuthModeName,
    type ChainPins,
    type TokenAuthorization,
    type TransferRequest,
} from '@nimiq/gasless-sdk/core';
import { RelayClient, type FeeResponse, type RequestState, type SubmitTransferBody } from '@nimiq/gasless-sdk/relay';
import { prepareTransfer, readTokenNonce, signPrepared, type PreparedTransfer } from '@nimiq/gasless-sdk/viem';
import { loadConfig } from '../../../src/config.js';
import { startServer, type RelayServer } from '../../../src/server.js';
import { captureLogger } from '../../helpers/harness.js';
import { CHAIN_ID, PORT_ATTEMPTS, RELAY_DIR, RELAY_INDEX, addressInUse, anvilAccount, anvilKey, freePort, type Stack } from './stack.js';

export interface RelayOptions {
    /** Anvil account index of the relay key (default 10). */
    readonly accountIndex?: number;
    /** Extra or overriding RELAY_* variables. */
    readonly env?: Readonly<Record<string, string>>;
}

/** Environment for a relay on this stack; the key file and database live in the stack's temp dir. */
export async function relayEnv(stack: Stack, options: RelayOptions = {}): Promise<Record<string, string>> {
    const index = options.accountIndex ?? RELAY_INDEX;
    const keyFile = join(stack.dir, `relay-${index}.key`);
    writeFileSync(keyFile, `${anvilKey(index)}\n`, { mode: 0o600 });
    return {
        RELAY_RPC_URLS: stack.rpcUrl,
        RELAY_DEPLOYMENT_FILE: stack.deploymentFile,
        ...(stack.deployment.chainId === 137 ? { RELAY_TOKEN_PINS_FILE: join(stack.dir, 'token-pins.json') } : {}),
        RELAY_PRIVATE_KEY_FILE: keyFile,
        RELAY_POLUSD_FEED: stack.deployment.chainId === 137 ? 'default' : readFileSync(join(stack.dir, 'price-feed'), 'utf8').trim(),
        RELAY_DB_PATH: join(stack.dir, `relay-${index}.sqlite`),
        RELAY_GAS_TABLE_FILE: join(RELAY_DIR, 'config', 'gasTable.json'),
        RELAY_HOST: '127.0.0.1',
        RELAY_PORT: String(await freePort()),
        // Internal listener (/metrics, /readyz) on any free port: several relays run side by side.
        RELAY_OPS_PORT: '0',
        RELAY_POLL_INTERVAL_MS: '100',
        RELAY_LOG_LEVEL: 'debug',
        ...options.env,
    };
}

export interface RunningRelay {
    readonly server: RelayServer;
    readonly url: string;
    readonly address: Address;
    readonly pins: ChainPins;
    readonly client: RelayClient;
    readonly logs: ReturnType<typeof captureLogger>;
    /** One transaction manager pass; fails the test if the pass failed. */
    tick(): Promise<void>;
    state(id: Hex): Promise<RequestState>;
    stop(): Promise<void>;
}

/**
 * Starts the relay in this process with the production startup code (src/server.ts). A RELAY_PORT from freePort that
 * was taken before the relay listened (EADDRINUSE; startServer then closes everything it opened) is replaced by a new
 * one, PORT_ATTEMPTS starts in all.
 */
export async function startRelay(stack: Stack, options: RelayOptions = {}): Promise<RunningRelay> {
    let logs: ReturnType<typeof captureLogger>;
    let server: RelayServer;
    for (let start = 1; ; start++) {
        const env = await relayEnv(stack, options);
        logs = captureLogger('debug');
        try {
            server = await startServer(loadConfig(env), logs.logger);
            break;
        } catch (err) {
            if (!addressInUse(err) || options.env?.RELAY_PORT !== undefined || start >= PORT_ATTEMPTS) throw err;
        }
    }
    const address = anvilAccount(options.accountIndex ?? RELAY_INDEX).address;
    const pins = stack.pins([address]);
    const client = new RelayClient(server.address, { pins });
    return {
        server,
        url: server.address,
        address,
        pins,
        client,
        logs,
        async tick() {
            await server.relay.txManager.tick();
            const error = server.relay.txManager.lastTickError;
            if (error !== undefined) throw new Error(`transaction manager tick failed: ${error}`);
        },
        state: (id) => client.getRequest(id),
        stop: () => server.close(),
    };
}

export interface RelayProcess {
    readonly child: ChildProcess;
    readonly url: string;
    output(): string;
    logs(): Array<Record<string, unknown>>;
    readonly exited: Promise<number | null>;
    /** Resolves once the process logged "relay started". */
    started(timeoutMs?: number): Promise<void>;
}

/** Runs the production entrypoint (`node dist/main.js`, built in globalSetup) as a child process. */
export function spawnRelay(env: Record<string, string>): RelayProcess {
    let out = '';
    const child = spawn(process.execPath, [join(RELAY_DIR, 'dist', 'main.js')], { cwd: RELAY_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const exited = once(child, 'close').then(([code]) => code as number | null);
    const logs = () =>
        out
            .split('\n')
            .filter((l) => l.startsWith('{'))
            .flatMap((l) => {
                try {
                    return [JSON.parse(l) as Record<string, unknown>];
                } catch {
                    return [];
                }
            });
    return {
        child,
        url: `http://${env.RELAY_HOST}:${env.RELAY_PORT}`,
        output: () => out,
        logs,
        exited,
        async started(timeoutMs = 30_000) {
            const end = Date.now() + timeoutMs;
            while (!logs().some((l) => l.msg === 'relay started')) {
                if (child.exitCode !== null) throw new Error(`relay exited with ${child.exitCode}:\n${out}`);
                if (Date.now() > end) throw new Error(`relay did not start:\n${out}`);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        },
    };
}

/** Polls `probe` until it returns a value (not undefined). */
export async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000, intervalMs = 100): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

// ---------------------------------------------------------------------------------------------------
// Wallet side (SDK only)
// ---------------------------------------------------------------------------------------------------

interface Ethers5Wallet {
    _signTypedData(domain: object, types: object, value: object): Promise<string>;
}

interface Ethers6Wallet {
    signTypedData(domain: object, types: object, value: object): Promise<string>;
}

type TypedDataSigner = (domain: object, types: object, value: object) => Promise<string>;

/**
 * ethers v5 (`_signTypedData`) or ethers v6 (`signTypedData`) through the SDK's
 * `ethers5`/`ethers6` aliases (SDK devDependencies; nothing is added to the relay).
 */
function ethersSigner(version: 'ethers5' | 'ethers6', key: Hex): TypedDataSigner {
    const requireFromSdk = createRequire(join(RELAY_DIR, '..', 'sdk', 'package.json'));
    if (version === 'ethers5') {
        const { Wallet } = requireFromSdk('ethers5') as { Wallet: new (key: string) => Ethers5Wallet };
        const wallet = new Wallet(key);
        return (domain, types, value) => wallet._signTypedData(domain, types, value);
    }
    const { Wallet } = requireFromSdk('ethers6') as { Wallet: new (key: string) => Ethers6Wallet };
    const wallet = new Wallet(key);
    return (domain, types, value) => wallet.signTypedData(domain, types, value);
}

export interface TransferParams {
    /** Anvil account index of the sender (a well-known test key). */
    readonly from: number;
    readonly token: Address;
    readonly authMode: AuthModeName;
    readonly to: Address;
    readonly amount: bigint;
    /** Defaults to the relay's quote. */
    readonly fee?: bigint;
    /** Default 600; for a correction without it, prepareTransfer's default (the later of the corrected deadline and now + 600). */
    readonly deadlineSeconds?: number;
    /**
     * An intent nonce the test chooses, for a body that shares its nonce with another on purpose (conflict, nonce_used,
     * nonce_too_high, concurrency). prepareTransfer refuses a nonce without `corrects` (a later version of a
     * payment is prepared with `corrects`, a new payment takes the sender's `nonces(from)`), so this helper uses the
     * core's createTransferIntent with the live token nonce, then the SDK's typed-data signing.
     */
    readonly nonce?: bigint | string;
    /**
     * A correction: the request of the payment version this transfer corrects (prepareTransfer with `corrects`). It
     * keeps that version's intent nonce, `from`, `token` and `to`.
     */
    readonly corrects?: TransferRequest;
    readonly signer?: 'viem' | 'ethers5' | 'ethers6';
}

export interface SignedTransfer {
    readonly id: Hex;
    readonly body: SubmitTransferBody;
    readonly quote: FeeResponse;
    readonly prepared: PreparedTransfer;
}

/**
 * What a wallet does: quote, prepareTransfer (pins, chain id, token domain, live token nonce; a correction with
 * `corrects`), sign the intent and the token authorization, build the body. Nothing is submitted. With `nonce`, the
 * intent is built with the core instead (see `TransferParams.nonce`).
 */
export async function signTransfer(
    stack: Pick<Stack, 'publicClient'>,
    relay: Pick<RunningRelay, 'client' | 'pins'>,
    p: TransferParams,
): Promise<SignedTransfer> {
    if (p.nonce !== undefined && p.corrects !== undefined) throw new Error('signTransfer: pass either nonce or corrects');
    const account = anvilAccount(p.from);
    const quote = await relay.client.fee({ token: p.token, authMode: p.authMode });
    const fields = {
        token: p.token,
        from: account.address,
        to: p.to,
        amount: p.amount,
        fee: p.fee ?? BigInt(quote.fee),
        relay: quote.relay,
        authMode: p.authMode,
    };
    const prepared =
        p.nonce !== undefined
            ? await intentWithNonce(stack, relay.pins, fields, p.nonce, p.deadlineSeconds ?? 600)
            : await prepareTransfer(stack.publicClient, relay.pins, {
                  ...fields,
                  ...(p.corrects === undefined || p.deadlineSeconds !== undefined ? { deadlineSeconds: p.deadlineSeconds ?? 600 } : {}),
                  ...(p.corrects !== undefined ? { corrects: p.corrects } : {}),
              });
    let signed: { request: TransferRequest; signature: string; authorization: TokenAuthorization };
    if (p.signer === 'ethers5' || p.signer === 'ethers6') {
        // The token authorization first, then the intent over it (GaslessTransfer signs TokenAuth).
        const now = Math.floor(Date.now() / 1000);
        const sign = ethersSigner(p.signer, anvilKey(p.from));
        const tokenAuth = tokenAuthSigningPayload(relay.pins, prepared, now);
        const tokenSignature = tokenAuth ? await sign(tokenAuth.domain, tokenAuth.types, tokenAuth.message) : null;
        const authorization = toTokenAuthorization(prepared.authMode, tokenSignature);
        const transfer = transferSigningPayload(relay.pins, prepared, authorization, now);
        const signature = await sign(transfer.domain, transfer.types, transfer.message);
        const { auth: _auth, ...request } = transfer.message;
        signed = { request, signature, authorization };
    } else {
        signed = await signPrepared(account, prepared, relay.pins);
    }
    const body = buildSubmitTransferBody({
        request: signed.request,
        signature: signed.signature,
        authorization: signed.authorization,
        quoteId: quote.quoteId,
    });
    const id = transferDigest(relay.pins.chainId, relay.pins.transfer.address, signed.request, signed.authorization);
    return { id, body, quote, prepared };
}

/**
 * A transfer with an explicit test nonce, built with the core's createTransferIntent
 * with the live token nonce. The mode is the test's explicit choice, as a mode forced in prepareTransfer is (which
 * then also allows the META_TX approval).
 */
async function intentWithNonce(
    stack: Pick<Stack, 'publicClient'>,
    pins: ChainPins,
    fields: { token: Address; from: Address; to: Address; amount: bigint; fee: bigint; relay: Address; authMode: AuthModeName },
    nonce: bigint | string,
    deadlineSeconds: number,
): Promise<PreparedTransfer> {
    const now = Math.floor(Date.now() / 1000);
    const mode = fields.authMode;
    const tokenNonce = mode === 'none' ? undefined : await readTokenNonce(stack.publicClient, pins, { token: fields.token, owner: fields.from, authMode: mode });
    return createTransferIntent(
        pins,
        { ...fields, deadline: now + deadlineSeconds, nonce, ...(tokenNonce !== undefined ? { tokenNonce } : {}) },
        now,
        { allowMetaTxApprove: mode === 'metaTxApprove' },
    );
}

/**
 * Signs a GaslessTransfer with viem only, for requests the SDK refuses to build (policy violations):
 * literal domain values, independent of the relay and SDK code. Default authorization: mode none (all zero).
 */
export async function signRawRequest(
    account: PrivateKeyAccount,
    contract: Address,
    request: TransferRequest,
    authorization: TokenAuthorization = NO_TOKEN_AUTHORIZATION,
): Promise<Hex> {
    return account.signTypedData({
        domain: { name: 'Nimiq Gasless Transfer', version: '3', chainId: CHAIN_ID, verifyingContract: contract },
        types: TRANSFER_TYPES,
        primaryType: 'GaslessTransfer',
        message: {
            ...request,
            amount: BigInt(request.amount),
            fee: BigInt(request.fee),
            nonce: BigInt(request.nonce),
            deadline: BigInt(request.deadline),
            auth: { mode: AUTH_MODE_ID[authorization.mode], v: authorization.v, r: authorization.r, s: authorization.s },
        },
    });
}

/** POST /v1/transfer without the SDK client (which refuses invalid bodies before sending them). */
export async function postRaw(relay: RunningRelay | { url: string }, body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${relay.url}/v1/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as unknown };
}
