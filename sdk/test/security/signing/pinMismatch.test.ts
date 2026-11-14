// Whatever deviates from the pins in a single field is refused, and the browser bundle computes what the ESM core
// computes:
//   1. validateTransferRequest: every single-field mutation of the token authorization typed data is
//      refused (except the token nonce, which only the chain can check).
//   2. RelayClient: a /v1/info that differs from the pins in any single field makes the client refuse,
//      and nothing signed is ever POSTed to such a relay.
//   3. The IIFE bundle: no prototype pollution of built-ins, no extra globals, and the same
//      digests as the ESM core on random input.

import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getAddress, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { POLYGON_USDC, POLYGON_USDT0 } from '../../../src/core/constants.js';
import { tokenAuthHash, transferDigest } from '../../../src/core/eip712.js';
import { createTransferIntent, tokenAuthSigningPayload, transferSigningPayload, type TransferIntent } from '../../../src/core/intent.js';
import { toTokenAuthorization } from '../../../src/core/signature.js';
import { buildSubmitTransferBody } from '../../../src/core/submit.js';
import { validateTransferRequest } from '../../../src/core/validate.js';
import { RelayClient } from '../../../src/relay/client.js';
import { ADDR, hex, KEYS, NOW, polygonPins, prng, TRANSFER_CONTRACT } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';

const pins = polygonPins();

function intent(token: string, authMode: 'permit' | 'metaTxApprove' | 'none'): TransferIntent {
    return createTransferIntent(
        pins,
        { token, from: ADDR.user, to: ADDR.recipient, amount: 10_000_000n, fee: 50_000n, relay: ADDR.relay, authMode, deadline: NOW + 600, nonce: 0n, tokenNonce: 3n },
        NOW,
        { allowMetaTxApprove: true },
    );
}

type Mutable = Record<string, unknown>;
// Deliberately untyped: the tests write wrong types into relay responses.
type Loose = any;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('validateTransferRequest: single-field mutations of the token authorization', () => {
    const cases: Array<[string, TransferIntent]> = [
        ['USDC permit', intent(POLYGON_USDC.address, 'permit')],
        ['USDT0 permit', intent(POLYGON_USDT0.address, 'permit')],
        ['USDT0 meta-tx', intent(POLYGON_USDT0.address, 'metaTxApprove')],
    ];
    for (const [name, base] of cases) {
        it(`${name}: every mutation except the token nonce is refused`, () => {
            const input = () => clone({ chainId: base.chainId, contract: base.contract, request: base.request, authMode: base.authMode, tokenAuth: base.tokenAuth }) as unknown as Mutable & { tokenAuth: Mutable & { domain: Mutable; message: Mutable; types: Mutable } };
            expect(validateTransferRequest(input() as never, pins, NOW)).toEqual({ ok: true });
            const other = getAddress(hex(prng(5)(20)));
            const mutations: Array<[string, (i: ReturnType<typeof input>) => void]> = [
                ['domain.name', (i) => (i.tokenAuth.domain.name = `${String(i.tokenAuth.domain.name)} `)],
                ['domain.version', (i) => (i.tokenAuth.domain.version = '9')],
                ['domain.chainId add/change', (i) => (i.tokenAuth.domain.chainId = 80002)],
                ['domain.salt add/change', (i) => (i.tokenAuth.domain.salt = `0x${'00'.repeat(31)}01`)],
                [
                    'domain: remove whichever of chainId / salt binds the chain',
                    (i) => (i.tokenAuth.domain.chainId !== undefined ? delete i.tokenAuth.domain.chainId : delete i.tokenAuth.domain.salt),
                ],
                ['domain.verifyingContract', (i) => (i.tokenAuth.domain.verifyingContract = other)],
                ['domain extra key', (i) => (i.tokenAuth.domain.extra = 'x')],
                ['types extra EIP712Domain', (i) => (i.tokenAuth.types.EIP712Domain = [{ name: 'name', type: 'string' }])],
                ['types field type', (i) => ((Object.values(i.tokenAuth.types)[0] as Mutable[])[0]!.type = 'bytes32')],
                ['types field name', (i) => ((Object.values(i.tokenAuth.types)[0] as Mutable[])[0]!.name = 'x')],
                ['types field order', (i) => (Object.values(i.tokenAuth.types)[0] as Mutable[]).reverse()],
                ['primaryType', (i) => (i.tokenAuth.primaryType = 'Other')],
                ['message extra key', (i) => (i.tokenAuth.message.extra = '1')],
            ];
            if (base.authMode === 'permit') {
                mutations.push(
                    ['owner', (i) => (i.tokenAuth.message.owner = other)],
                    ['spender', (i) => (i.tokenAuth.message.spender = other)],
                    ['spender = relay', (i) => (i.tokenAuth.message.spender = ADDR.relay)],
                    ['value + 1', (i) => (i.tokenAuth.message.value = String(BigInt(String(i.tokenAuth.message.value)) + 1n))],
                    ['value - 1', (i) => (i.tokenAuth.message.value = String(BigInt(String(i.tokenAuth.message.value)) - 1n))],
                    ['value max', (i) => (i.tokenAuth.message.value = ((1n << 256n) - 1n).toString())],
                    ['deadline 0', (i) => (i.tokenAuth.message.deadline = '0')],
                    ['deadline max', (i) => (i.tokenAuth.message.deadline = ((1n << 256n) - 1n).toString())],
                    ['deadline + 1', (i) => (i.tokenAuth.message.deadline = String(BigInt(String(i.tokenAuth.message.deadline)) + 1n))],
                    ['deadline as number', (i) => (i.tokenAuth.message.deadline = Number(i.tokenAuth.message.deadline))],
                    ['value padded', (i) => (i.tokenAuth.message.value = `0${String(i.tokenAuth.message.value)}`)],
                );
            } else {
                const call = () => String((base.tokenAuth!.message as unknown as Mutable).functionSignature);
                mutations.push(
                    ['from', (i) => (i.tokenAuth.message.from = other)],
                    ['selector', (i) => (i.tokenAuth.message.functionSignature = `0xa9059cbb${call().slice(10)}`)],
                    ['approve spender', (i) => (i.tokenAuth.message.functionSignature = `${call().slice(0, 34)}${other.slice(2).toLowerCase()}${call().slice(74)}`)],
                    ['approve value + 1', (i) => (i.tokenAuth.message.functionSignature = `${call().slice(0, 74)}${(BigInt(`0x${call().slice(74)}`) + 1n).toString(16).padStart(64, '0')}`)],
                    ['approve value max', (i) => (i.tokenAuth.message.functionSignature = `${call().slice(0, 74)}${'f'.repeat(64)}`)],
                    ['trailing bytes', (i) => (i.tokenAuth.message.functionSignature = `${call()}00`)],
                    ['dirty spender padding', (i) => (i.tokenAuth.message.functionSignature = `${call().slice(0, 10)}01${call().slice(12)}`)],
                );
            }
            for (const [label, mutate] of mutations) {
                const i = input();
                mutate(i);
                const result = validateTransferRequest(i as never, pins, NOW);
                expect(result.ok, label).toBe(false);
            }
            // The nonce is the one field the SDK cannot check (the token does, on-chain).
            const i = input();
            i.tokenAuth.message.nonce = '4';
            expect(validateTransferRequest(i as never, pins, NOW)).toEqual({ ok: true });
        });
    }
});

describe('RelayClient refuses any single-field /v1/info mismatch and sends nothing signed', () => {
    it('31 mutations of /v1/info', async () => {
        const account = privateKeyToAccount(KEYS.user);
        const i = intent(POLYGON_USDT0.address, 'metaTxApprove');
        const tokenAuth = tokenAuthSigningPayload(pins, i, NOW);
        const authorization = toTokenAuthorization('metaTxApprove', await account.signTypedData(tokenAuth as unknown as TypedDataDefinition));
        const body = buildSubmitTransferBody({
            request: i.request,
            signature: await account.signTypedData(transferSigningPayload(pins, i, authorization, NOW) as unknown as TypedDataDefinition),
            authorization,
        });
        const id = transferDigest(137, TRANSFER_CONTRACT, body.request, body.authorization);
        const other = getAddress(hex(prng(6)(20)));
        const mutations: Array<[string, (info: Loose) => void]> = [
            ['chainId', (x) => (x.chainId = 80002)],
            ['relay', (x) => (x.relay = other)],
            ['contract address', (x) => (x.contracts.transfer.address = other)],
            ['contract domain name', (x) => (x.contracts.transfer.domain.name = 'Nimiq Gasless Transfer ')],
            ['contract domain version', (x) => (x.contracts.transfer.domain.version = '1')],
            ['contract domain chainId', (x) => (x.contracts.transfer.domain.chainId = 1)],
            ['contract domain verifyingContract', (x) => (x.contracts.transfer.domain.verifyingContract = other)],
            ['contract domain salt', (x) => (x.contracts.transfer.domain.salt = `0x${'00'.repeat(32)}`)],
            ['contract domain version missing', (x) => delete x.contracts.transfer.domain.version],
            ['token removed', (x) => x.tokens.pop()],
            ['token added', (x) => x.tokens.push({ ...x.tokens[0]!, address: other })],
            ['token duplicated', (x) => (x.tokens[1] = x.tokens[0]!)],
            ['token symbol', (x) => (x.tokens[0]!.symbol = 'USDC.e')],
            ['token decimals', (x) => (x.tokens[0]!.decimals = 18)],
            ['token address', (x) => (x.tokens[1]!.address = other)],
            ['token mode removed', (x) => x.tokens[1]!.authModes.pop()],
            ['token mode added', (x) => x.tokens[0]!.authModes.push('metaTxApprove')],
            ['token mode swapped', (x) => (x.tokens[0]!.authModes = ['permit', 'metaTxApprove'])],
            ['token domain name', (x) => (x.tokens[1]!.tokenDomain.name = 'Tether USD')],
            ['token domain version', (x) => (x.tokens[1]!.tokenDomain.version = '2')],
            ['token domain chainId added', (x) => (x.tokens[1]!.tokenDomain.chainId = 137)],
            ['token domain salt removed', (x) => delete x.tokens[1]!.tokenDomain.salt],
            ['token domain salt changed', (x) => (x.tokens[1]!.tokenDomain.salt = `0x${'00'.repeat(31)}01`)],
            ['token domain verifyingContract', (x) => (x.tokens[0]!.tokenDomain.verifyingContract = other)],
            ['token domain chainId changed', (x) => (x.tokens[0]!.tokenDomain.chainId = 80002)],
            ['token domain chainId removed', (x) => delete x.tokens[0]!.tokenDomain.chainId],
            ['token domain extra field', (x) => (x.tokens[0]!.tokenDomain.extra = 'x')],
            ['contract domain extra field', (x) => (x.contracts.transfer.domain.extra = 'x')],
            ['relay zero', (x) => (x.relay = '0x0000000000000000000000000000000000000000')],
            ['tokens not an array', (x) => (x.tokens = {})],
            ['info not an object', (x) => (x.contracts = null)],
        ];
        expect(mutations).toHaveLength(31);
        for (const [label, mutate] of mutations) {
            const info = clone(infoFor(pins)) as unknown as Loose;
            mutate(info);
            const posts: unknown[] = [];
            const fetch = vi.fn(async (url: string, init: RequestInit) => {
                if (init.method === 'POST') posts.push(init.body);
                if (url.endsWith('/v1/info')) return new Response(JSON.stringify(info), { status: 200 });
                return new Response(JSON.stringify({ id, status: 'queued' }), { status: 202 });
            });
            const client = new RelayClient('https://relay.test', { pins, fetch, now: () => NOW });
            await expect(client.submitTransfer(body), label).rejects.toThrow();
            expect(posts, label).toEqual([]);
        }
    });
});

describe('IIFE bundle integrity', () => {
    const sdkRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const iifePath = path.join(sdkRoot, 'dist', 'core', 'index.global.js');

    beforeAll(() => {
        if (!existsSync(iifePath)) execFileSync(path.join(sdkRoot, 'node_modules', '.bin', 'tsup'), [], { cwd: sdkRoot, stdio: 'pipe' });
    }, 180_000);

    it('does not modify built-in prototypes, defines one global, and matches the ESM core on 300 random requests', () => {
        const context = vm.createContext({ crypto: webcrypto, TextEncoder });
        const snapshot = () =>
            vm.runInContext(
                `JSON.stringify([Object, Array, String, Function, Number, BigInt, Uint8Array, JSON, Math, Promise].map((c) => [
                    Object.getOwnPropertyNames(c).sort(), c.prototype ? Object.getOwnPropertyNames(c.prototype).sort() : []]))`,
                context,
            ) as string;
        const before = snapshot();
        const globalsBefore = Object.keys(context).sort();
        vm.runInContext(readFileSync(iifePath, 'utf8'), context);
        expect(snapshot()).toBe(before);
        expect(Object.keys(context).sort()).toEqual([...globalsBefore, 'NimiqGaslessCore'].sort());

        const random = prng(9);
        const modes = ['none', 'permit', 'metaTxApprove'] as const;
        for (let n = 0; n < 300; n++) {
            const request = {
                token: getAddress(hex(random(20))),
                from: getAddress(hex(random(20))),
                to: getAddress(hex(random(20))),
                amount: BigInt(hex(random(1 + (n % 32)))).toString(),
                fee: BigInt(hex(random(1 + (n % 3)))).toString(),
                relay: getAddress(hex(random(20))),
                nonce: BigInt(hex(random(1 + (n % 32)))).toString(),
                deadline: BigInt(hex(random(1 + (n % 8)))).toString(),
            };
            const authorization = { mode: modes[n % 3] as (typeof modes)[number], v: random(1)[0] as number, r: hex(random(32)), s: hex(random(32)) };
            const args = `137, '${TRANSFER_CONTRACT}', ${JSON.stringify(request)}, ${JSON.stringify(authorization)}`;
            const inVm = vm.runInContext(`NimiqGaslessCore.transferDigest(${args})`, context) as string;
            expect(inVm).toBe(transferDigest(137, TRANSFER_CONTRACT, request as never, authorization));
            expect(vm.runInContext(`NimiqGaslessCore.tokenAuthHash(${JSON.stringify(authorization)})`, context)).toBe(tokenAuthHash(authorization));
        }
    });
});
