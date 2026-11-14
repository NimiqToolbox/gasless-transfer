// anvil + forge helpers for the viem adapter tests. Both tools and the vendored OpenZeppelin only
// exist in the toolchain container; outside of it the chain tests are skipped (and reported as such), except in CI,
// where their absence is an error.

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi, Hex } from 'viem';
import { AUTH_MODE_ID } from '../../src/core/types.js';
import type { SubmitTransferBody } from '../../src/relay/types.js';
import { ADDR, USDC, USDT0 } from './fixtures.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/solidity', import.meta.url));

/**
 * Constructor arguments of GaslessTransfer and TransferHarness (`initialOwner`, `TokenInit[]`): ADDR.deployer owns
 * it; USDC with permit and allowance, USDT0 with all three modes (the mainnet configuration).
 */
export function transferConstructorArgs() {
    return [
        ADDR.deployer,
        [
            { token: USDC, config: { permit: true, metaTxApprove: false, allowance: true } },
            { token: USDT0, config: { permit: true, metaTxApprove: true, allowance: true } },
        ],
    ] as const;
}

/** The relayTransfer arguments a relay encodes from a submit body: the request without its nonce, the signature, the signed authorization as is. */
export function relayTransferArgs(body: SubmitTransferBody) {
    const r = body.request;
    const a = body.authorization;
    return [
        { token: r.token, from: r.from, to: r.to, amount: BigInt(r.amount), fee: BigInt(r.fee), relay: r.relay, deadline: BigInt(r.deadline) },
        body.signature,
        { mode: AUTH_MODE_ID[a.mode], v: a.v, r: a.r, s: a.s },
    ] as const;
}

/** True when the environment variable CI is set to anything but an empty string, `0` or `false`. */
export function inCI(): boolean {
    const ci = process.env.CI;
    return ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false';
}

function chainToolsInstalled(): boolean {
    try {
        execFileSync('anvil', ['--version'], { stdio: 'ignore' });
        execFileSync('forge', ['--version'], { stdio: 'ignore' });
    } catch {
        return false;
    }
    return existsSync('/deps/openzeppelin-contracts/contracts');
}

/**
 * Whether the chain tests can run here: anvil, forge and the Solidity libraries at /deps, where the toolchain image
 * puts them. Without them the chain tests are skipped. A CI run must not skip them unnoticed, so there it is an error.
 */
export function chainToolsAvailable(): boolean {
    const available = chainToolsInstalled();
    if (!available && inCI()) {
        throw new Error('The chain tests need anvil, forge and /deps/openzeppelin-contracts: run the SDK tests in the toolchain image');
    }
    return available;
}

export interface Artifact {
    readonly abi: Abi;
    readonly bytecode: Hex;
    readonly deployedBytecode: Hex;
}

export type FixtureName = 'MockUSDC' | 'MockUSDT0' | 'TransferHarness' | 'EcdsaDelegate' | 'LogFlooder' | 'CallForwarder';

/** Compiles sdk/test/fixtures/solidity into a temp dir (the fixture folder stays untouched). */
export function compileFixtures(): Record<FixtureName, Artifact> {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gasless-sdk-fixtures-'));
    try {
        execFileSync('forge', ['build', '--root', FIXTURES_DIR, '--out', path.join(tmp, 'out'), '--cache-path', path.join(tmp, 'cache')], {
            stdio: 'pipe',
        });
        const load = (name: FixtureName): Artifact => {
            const json = JSON.parse(readFileSync(path.join(tmp, 'out', `${name}.sol`, `${name}.json`), 'utf8')) as {
                abi: Abi;
                bytecode: { object: Hex };
                deployedBytecode: { object: Hex };
            };
            return { abi: json.abi, bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
        };
        return {
            MockUSDC: load('MockUSDC'),
            MockUSDT0: load('MockUSDT0'),
            TransferHarness: load('TransferHarness'),
            EcdsaDelegate: load('EcdsaDelegate'),
            LogFlooder: load('LogFlooder'),
            CallForwarder: load('CallForwarder'),
        };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

async function freePort(): Promise<number> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    server.close();
    await once(server, 'close');
    return port;
}

export interface Anvil {
    readonly url: string;
    stop(): Promise<void>;
}

/** Starts anvil on 127.0.0.1 inside the container (no port is published to the host). */
export async function startAnvil(chainId: number): Promise<Anvil> {
    const port = await freePort();
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
        if (child.exitCode !== null) throw new Error(`anvil exited with code ${child.exitCode}`);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
            });
            if (response.ok) break;
        } catch {
            // not listening yet
        }
        if (attempt > 100) {
            child.kill('SIGKILL');
            throw new Error('anvil did not start');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
        url,
        async stop() {
            if (child.exitCode !== null) return;
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await exited;
        },
    };
}
