// prepareTransfer's automatic auth mode and the contract's exact-allowance rule (spec §4.1 step 3: PERMIT and
// META_TX_APPROVE need an allowance of exactly amount + fee, NONE at least that), against the PRODUCTION
// GaslessTransfer (contracts/src, compiled here) instead of the SDK's test double TransferHarness, on anvil
// (chain id 137) with the SDK's USDC / USDT0 token doubles at the real token addresses. Skipped only outside the
// toolchain container, where anvil, forge and the vendored OpenZeppelin are missing.
//
// The first tests show that the automatic mode, the EIP-7702 permit opt-in (allowEip7702Permit) and the viem /
// ethers v5 / ethers v6 signatures work with the production contract under that rule.
//
// The last two compare the test double with the production contract. The SDK's own end-to-end tests
// (test/viem/anvil.test.ts) run against sdk/test/fixtures/solidity/src/TransferHarness.sol. A double that accepted
// allowance >= amount + fee in every mode would hide an SDK change that makes PERMIT or META_TX requests revert on
// the production contract, so both must give the same result for every mode and allowance. The relay's integration
// tests run the automatic mode against the production contract and a real relay.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet as Ethers5Wallet } from 'ethers5';
import { Wallet as Ethers6Wallet } from 'ethers6';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    createPublicClient,
    createTestClient,
    createWalletClient,
    defineChain,
    getAddress,
    http,
    type Abi,
    type Address,
    type Chain,
    type Hex,
    type PublicClient,
    type TestClient,
    type TransactionReceipt,
    type Transport,
    type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gaslessTransferAbi, usdcAbi } from '../../../src/core/abi.js';
import { POLYGON_TOKENS } from '../../../src/core/constants.js';
import { tokenAuthSigningPayload, transferSigningPayload, type TransferIntent } from '../../../src/core/intent.js';
import { definePins, type ChainPins } from '../../../src/core/pins.js';
import { toTokenAuthorization } from '../../../src/core/signature.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import type { AuthModeName } from '../../../src/core/types.js';
import type { SubmitTransferBody } from '../../../src/relay/types.js';
import { prepareTransfer, signPrepared, type PrepareTransferParams } from '../../../src/viem/index.js';
import {
    chainToolsAvailable,
    compileFixtures,
    relayTransferArgs,
    startAnvil,
    transferConstructorArgs,
    type Anvil,
    type Artifact,
    type FixtureName,
} from '../../helpers/anvil.js';
import { ADDR, KEYS, USDC, USDT0 } from '../../helpers/fixtures.js';

const AMOUNT = 10_000_000n;
const FEE = 50_000n;
const VALUE = AMOUNT + FEE;
const POLL_MS = 25;

/** The production GaslessTransfer from contracts/src (tests and scripts are not compiled). */
function compileProductionContract(): Artifact {
    const contractsRoot = fileURLToPath(new URL('../../../../contracts', import.meta.url));
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'sdk-production-'));
    try {
        execFileSync(
            'forge',
            ['build', '--root', contractsRoot, '--out', path.join(tmp, 'out'), '--cache-path', path.join(tmp, 'cache'), '--skip', 'test', '--skip', 'script'],
            { stdio: 'pipe' },
        );
        const json = JSON.parse(readFileSync(path.join(tmp, 'out', 'GaslessTransfer.sol', 'GaslessTransfer.json'), 'utf8')) as {
            abi: Abi;
            bytecode: { object: Hex };
            deployedBytecode: { object: Hex };
        };
        return { abi: json.abi, bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

describe.skipIf(!chainToolsAvailable())('automatic auth mode and the exact-allowance rule against the production GaslessTransfer', () => {
    let anvil: Anvil;
    let fixtures: Record<FixtureName, Artifact>;
    let chain: Chain;
    let publicClient: PublicClient<Transport, Chain>;
    let testClient: TestClient<'anvil', Transport, Chain>;
    let production: Address;
    let harness: Address;
    let pins: ChainPins;
    let harnessPins: ChainPins;
    let snapshot: Hex;

    const wallet = (key: Hex) => createWalletClient({ chain, transport: http(anvil.url), account: privateKeyToAccount(key) });

    async function send(key: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
        const hash = await wallet(key).writeContract({ address, abi, functionName, args } as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe('success');
        return receipt;
    }

    async function deploy(artifact: Artifact): Promise<Address> {
        const hash = await wallet(KEYS.deployer).deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode,
            args: transferConstructorArgs(),
        } as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return getAddress(receipt.contractAddress as Address);
    }

    async function now(): Promise<number> {
        return Number((await publicClient.getBlock()).timestamp);
    }

    function auto(overrides: Partial<PrepareTransferParams> & { now: number }): PrepareTransferParams {
        return { token: USDC, from: ADDR.user, to: ADDR.recipient, amount: AMOUNT, fee: FEE, relay: ADDR.relay, ...overrides };
    }

    /**
     * The body of `prepared` with a token signature that is well-formed but unusable (as after a front-run of its token
     * nonce, or a delegate that rejects it), which the user's intent signature covers: the contract accepts the intent
     * and then finds the token authorization unusable.
     */
    async function withUnusableTokenSignature(prepared: TransferIntent, contractPins: ChainPins, t: number): Promise<SubmitTransferBody> {
        const authorization = { mode: prepared.authMode as Exclude<AuthModeName, 'none'>, v: 27, r: `0x${'00'.repeat(31)}01` as Hex, s: `0x${'00'.repeat(31)}01` as Hex };
        const signature = await privateKeyToAccount(KEYS.user).signTypedData(transferSigningPayload(contractPins, prepared, authorization, t) as unknown as TypedDataDefinition);
        return buildSubmitTransferBody({ request: prepared.request, signature, authorization });
    }

    /** What the relay does with a submit body: relayTransfer from its own account. */
    async function relayExecute(contract: Address, body: SubmitTransferBody): Promise<TransactionReceipt> {
        return send(KEYS.relay, contract, gaslessTransferAbi, 'relayTransfer', relayTransferArgs(body));
    }

    /** "success", or the custom error name of the revert, of a relayTransfer simulated from the relay account. */
    async function simulate(contract: Address, body: SubmitTransferBody): Promise<string> {
        return publicClient
            .simulateContract({ account: ADDR.relay, address: contract, abi: gaslessTransferAbi, functionName: 'relayTransfer', args: relayTransferArgs(body) })
            .then(
                () => 'success',
                (error: unknown) => {
                    const match = /(InsufficientAllowance|InvalidSignature|DeadlineExpired|AuthModeNotSupported)\(?[^)]*\)?/.exec(String(error));
                    return match?.[0] ?? `reverted: ${String(error).slice(0, 120)}`;
                },
            );
    }

    const read = (token: Address, functionName: 'balanceOf' | 'allowance', args: readonly Address[]) =>
        publicClient.readContract({ address: token, abi: usdcAbi, functionName, args } as never) as Promise<bigint>;

    beforeAll(async () => {
        fixtures = compileFixtures();
        const productionArtifact = compileProductionContract();
        anvil = await startAnvil(137);
        chain = defineChain({ id: 137, name: 'anvil-137', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
        publicClient = createPublicClient({ chain, transport: http(anvil.url), pollingInterval: POLL_MS });
        testClient = createTestClient({ chain, mode: 'anvil', transport: http(anvil.url), pollingInterval: POLL_MS });
        await testClient.setCode({ address: USDC, bytecode: fixtures.MockUSDC.deployedBytecode });
        await testClient.setCode({ address: USDT0, bytecode: fixtures.MockUSDT0.deployedBytecode });
        await send(KEYS.deployer, USDC, fixtures.MockUSDC.abi, 'initialize', ['USD Coin']);
        await send(KEYS.deployer, USDT0, fixtures.MockUSDT0.abi, 'initialize', ['USDT0']);
        production = await deploy(productionArtifact);
        harness = await deploy(fixtures.TransferHarness);
        for (const token of [USDC, USDT0]) {
            for (const holder of [ADDR.user, ADDR.other]) await send(KEYS.deployer, token, fixtures.MockUSDC.abi, 'mint', [holder, 1_000_000_000n]);
        }
        const base = { chainId: 137, relays: [ADDR.relay], tokens: POLYGON_TOKENS, deployBlock: 0 };
        pins = definePins({ ...base, transfer: production });
        harnessPins = definePins({ ...base, transfer: harness });
    }, 240_000);

    afterAll(async () => {
        await anvil?.stop();
    });

    beforeEach(async () => {
        snapshot = await testClient.snapshot();
    });

    afterEach(async () => {
        await testClient.revert({ id: snapshot });
    });

    it('the production contract applies the exact-allowance rule (PERMIT with an unusable permit and a larger standing allowance reverts)', async () => {
        await send(KEYS.user, USDC, usdcAbi, 'approve', [production, 3n * VALUE]);
        const t = await now();
        const prepared = await prepareTransfer(publicClient, pins, auto({ authMode: 'permit', now: t }));
        const body = buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.user), prepared, pins, { now: t }));
        const junk = await withUnusableTokenSignature(prepared, pins, t);
        expect(await simulate(production, junk)).toMatch(/^InsufficientAllowance/);
        expect(await simulate(production, body)).toBe('success');
        // The token authorization is signed: swapped into the valid body, the intent signature no longer matches.
        expect(await simulate(production, { ...body, authorization: junk.authorization })).toMatch(/^InvalidSignature/);
    });

    it('without an allowance the automatic mode is PERMIT for USDC and USDT0; viem, ethers v5 and ethers v6 sign it identically; the production contract moves exactly amount + fee and leaves no allowance', async () => {
        const t = await now();
        const signers = [
            ['viem', async (p: { domain: object; types: object; message: object }) => privateKeyToAccount(KEYS.user).signTypedData(p as unknown as TypedDataDefinition)],
            ['ethers v5', async (p: { domain: object; types: object; message: object }) => new Ethers5Wallet(KEYS.user)._signTypedData(p.domain as never, p.types as never, p.message as never)],
            ['ethers v6', async (p: { domain: object; types: object; message: object }) => new Ethers6Wallet(KEYS.user).signTypedData(p.domain as never, p.types as never, p.message as never)],
        ] as const;
        for (const token of [USDC, USDT0]) {
            for (const [name, sign] of signers) {
                const prepared = await prepareTransfer(publicClient, pins, auto({ token, now: t }));
                expect(prepared.authMode, `${token} ${name}`).toBe('permit');
                const tokenAuth = tokenAuthSigningPayload(pins, prepared, t);
                const authorization = toTokenAuthorization('permit', await sign(tokenAuth as NonNullable<typeof tokenAuth>));
                const signature = await sign(transferSigningPayload(pins, prepared, authorization, t));
                // Byte-identical to the viem adapter's own signatures (RFC 6979).
                const reference = await signPrepared(privateKeyToAccount(KEYS.user), prepared, pins, { now: t });
                expect(authorization, `${token} ${name} permit`).toEqual(reference.authorization);
                expect(signature.toLowerCase(), `${token} ${name} intent`).toBe(reference.signature);

                const body = buildSubmitTransferBody({ request: prepared.request, signature, authorization });
                const before = { user: await read(token, 'balanceOf', [ADDR.user]), recipient: await read(token, 'balanceOf', [ADDR.recipient]), relay: await read(token, 'balanceOf', [ADDR.relay]) };
                await relayExecute(production, body);
                expect(await read(token, 'balanceOf', [ADDR.user])).toBe(before.user - VALUE);
                expect(await read(token, 'balanceOf', [ADDR.recipient])).toBe(before.recipient + AMOUNT);
                expect(await read(token, 'balanceOf', [ADDR.relay])).toBe(before.relay + FEE);
                expect(await read(token, 'allowance', [ADDR.user, production])).toBe(0n);
            }
        }
    });

    // The contract caps no fee: the fee `from` signs is paid as it is, and only the client bounds it.
    it('a fee of 50.00 prepared and signed by the SDK executes exactly on the production contract and on TransferHarness', async () => {
        const fee = 50_000_000n;
        for (const [name, contract, contractPins] of [
            ['production', production, pins],
            ['TransferHarness', harness, harnessPins],
        ] as const) {
            for (const [token, authMode] of [
                [USDC, 'permit'],
                [USDT0, 'metaTxApprove'],
            ] as const) {
                const t = await now();
                const prepared = await prepareTransfer(publicClient, contractPins, auto({ token, authMode, fee, now: t }));
                expect(prepared.request.fee, `${name} ${token}`).toBe(fee.toString());
                const body = buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.user), prepared, contractPins, { now: t }));
                const before = { user: await read(token, 'balanceOf', [ADDR.user]), recipient: await read(token, 'balanceOf', [ADDR.recipient]), relay: await read(token, 'balanceOf', [ADDR.relay]) };
                await relayExecute(contract, body);
                expect(await read(token, 'balanceOf', [ADDR.user]), `${name} ${token}`).toBe(before.user - AMOUNT - fee);
                expect(await read(token, 'balanceOf', [ADDR.recipient]), `${name} ${token}`).toBe(before.recipient + AMOUNT);
                expect(await read(token, 'balanceOf', [ADDR.relay]), `${name} ${token}`).toBe(before.relay + fee);
                expect(await read(token, 'allowance', [ADDR.user, contract]), `${name} ${token}`).toBe(0n);
            }
        }
    });

    it('with allowance > amount + fee the automatic mode is NONE, and the production contract leaves the rest of the allowance', async () => {
        for (const token of [USDC, USDT0]) {
            await send(KEYS.user, token, usdcAbi, 'approve', [production, 3n * VALUE]);
            const t = await now();
            const prepared = await prepareTransfer(publicClient, pins, auto({ token, now: t }));
            expect(prepared.authMode).toBe('none');
            await relayExecute(production, buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.user), prepared, pins, { now: t })));
            expect(await read(token, 'allowance', [ADDR.user, production])).toBe(2n * VALUE);
        }
    });

    it('allowance == amount + fee gives NONE (0 left); amount + fee - 1 gives PERMIT, which replaces the standing allowance (0 left)', async () => {
        for (const [standing, mode] of [
            [VALUE, 'none'],
            [VALUE - 1n, 'permit'],
            [1n, 'permit'],
        ] as const) {
            await send(KEYS.user, USDT0, usdcAbi, 'approve', [production, standing]);
            const t = await now();
            const prepared = await prepareTransfer(publicClient, pins, auto({ token: USDT0, now: t }));
            expect(prepared.authMode, `standing ${standing}`).toBe(mode);
            await relayExecute(production, buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.user), prepared, pins, { now: t })));
            expect(await read(USDT0, 'allowance', [ADDR.user, production]), `standing ${standing}`).toBe(0n);
        }
    });

    it('allowEip7702Permit: a USDC permit of an EIP-7702 account whose delegate checks the account key via ERC-1271 executes on the production contract', async () => {
        const deployed = await wallet(KEYS.deployer).deployContract({ abi: fixtures.EcdsaDelegate.abi, bytecode: fixtures.EcdsaDelegate.bytecode });
        const delegate = getAddress((await publicClient.waitForTransactionReceipt({ hash: deployed })).contractAddress as Address);
        await testClient.setCode({ address: ADDR.other, bytecode: `0xef0100${delegate.slice(2)}` as Hex });
        const t = await now();
        const refused = await prepareTransfer(publicClient, pins, auto({ from: ADDR.other, now: t })).catch((e: unknown) => (e as { code?: string }).code);
        expect(refused).toBe('eip7702_permit_unsupported');
        const prepared = await prepareTransfer(publicClient, pins, { ...auto({ from: ADDR.other, now: t }), allowEip7702Permit: true });
        expect(prepared.authMode).toBe('permit');
        const body = buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.other), prepared, pins, { now: t }));
        const before = await read(USDC, 'balanceOf', [ADDR.recipient]);
        await relayExecute(production, body);
        expect(await read(USDC, 'balanceOf', [ADDR.recipient])).toBe(before + AMOUNT);
        expect(await read(USDC, 'allowance', [ADDR.other, production])).toBe(0n);
    });

    it('the SDK test double TransferHarness applies the exact-allowance rule like the production contract (PERMIT mode never spends a standing allowance other than amount + fee)', async () => {
        const outcomes: Record<string, string> = {};
        for (const [name, contract, contractPins] of [
            ['production', production, pins],
            ['TransferHarness', harness, harnessPins],
        ] as const) {
            await send(KEYS.user, USDC, usdcAbi, 'approve', [contract, 3n * VALUE]);
            const t = await now();
            const prepared = await prepareTransfer(publicClient, contractPins, auto({ authMode: 'permit', now: t }));
            // The token signature is unusable (as after a front-run of the same nonce by another permit,
            // or a delegate that rejects it); only the standing allowance of 3 × (amount + fee) is left.
            const junk = await withUnusableTokenSignature(prepared, contractPins, t);
            outcomes[name] = (await simulate(contract, junk)).replace(/\(.*$/, '');
        }
        // A double that takes any covering allowance would give { production: 'InsufficientAllowance', TransferHarness: 'success' }.
        expect(outcomes).toEqual({ production: 'InsufficientAllowance', TransferHarness: 'InsufficientAllowance' });
    });

    it('TransferHarness and the production contract agree on every mode and allowance around amount + fee', async () => {
        const table: Record<string, Record<string, string>> = {};
        for (const [name, contract, contractPins] of [
            ['production', production, pins],
            ['TransferHarness', harness, harnessPins],
        ] as const) {
            for (const standing of [0n, VALUE - 1n, VALUE, VALUE + 1n, 3n * VALUE]) {
                await send(KEYS.user, USDT0, usdcAbi, 'approve', [contract, standing]);
                const t = await now();
                for (const authMode of ['none', 'permit', 'metaTxApprove'] as const) {
                    const prepared = await prepareTransfer(publicClient, contractPins, auto({ token: USDT0, authMode, now: t }));
                    const body = buildSubmitTransferBody(await signPrepared(privateKeyToAccount(KEYS.user), prepared, contractPins, { now: t }));
                    // A valid token signature, and an unusable one (as after a front-run of its token nonce).
                    const junk = authMode === 'none' ? body : await withUnusableTokenSignature(prepared, contractPins, t);
                    const key = `${authMode} standing=${standing === VALUE ? 'exact' : standing}`;
                    table[key] = table[key] ?? {};
                    (table[key] as Record<string, string>)[name] = `${(await simulate(contract, body)).replace(/\(.*$/, '')} / ${(await simulate(contract, junk)).replace(/\(.*$/, '')}`;
                }
            }
        }
        for (const [key, row] of Object.entries(table)) expect(row.TransferHarness, key).toBe(row.production);
        // Spot checks of the exact-allowance rule itself.
        expect(table['permit standing=exact']?.production).toBe('success / success');
        expect(table[`permit standing=${3n * VALUE}`]?.production).toBe('success / InsufficientAllowance');
        expect(table[`none standing=${VALUE - 1n}`]?.production).toBe('InsufficientAllowance / InsufficientAllowance');
        expect(table[`none standing=${3n * VALUE}`]?.production).toBe('success / success');
    });
});
