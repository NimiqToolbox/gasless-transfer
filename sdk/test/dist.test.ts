// The build output: tsup produces every file of the package.json exports map, and the IIFE global
// NimiqGaslessCore works in a bare script context with only Web APIs.

import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { transferDigest, transferDigestFromAuthHash } from '../src/core/eip712.js';
import type { Hex, TokenAuthorization } from '../src/core/types.js';
import { ADDR, KEYS, NOW, polygonPinsInput, SAMPLE_PERMIT_AUTH, TRANSFER_CONTRACT } from './helpers/fixtures.js';

const sdkRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = (file: string) => path.join(sdkRoot, 'dist', file);

beforeAll(() => {
    // The contained verification image builds this exact snapshot before making source/dist read-only.
    // Assertions below still check those artifacts; ordinary runs exercise the build here.
    if (process.env.GASLESS_PREBUILT_SDK === 'true') return;
    // Exactly what `pnpm build` runs.
    execFileSync(path.join(sdkRoot, 'node_modules', '.bin', 'tsup'), [], { cwd: sdkRoot, stdio: 'pipe' });
}, 180_000);

function loadGlobal(): { context: vm.Context; core: Record<string, unknown> } {
    // A browser-like scope: no require, process, Buffer, console or setTimeout.
    const context = vm.createContext({ crypto: webcrypto, TextEncoder });
    vm.runInContext(readFileSync(dist('core/index.global.js'), 'utf8'), context, { filename: 'core/index.global.js' });
    return { context, core: context.NimiqGaslessCore as Record<string, unknown> };
}

describe('build output', () => {
    it('contains every file referenced by the package.json exports map', () => {
        const pkg = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')) as {
            exports: Record<string, Record<string, Record<string, string>>>;
        };
        const targets = Object.values(pkg.exports).flatMap((conditions) => Object.values(conditions).flatMap((c) => Object.values(c)));
        expect(targets.length).toBe(12);
        for (const target of targets) expect(existsSync(path.join(sdkRoot, target)), target).toBe(true);
        expect(existsSync(dist('core/index.global.js'))).toBe(true);
    });

    it('the ESM and CJS core entries load and agree', async () => {
        const esm = (await import(pathToFileURL(dist('core/index.js')).href)) as typeof import('../src/core/index.js');
        const cjs = createRequire(import.meta.url)(dist('core/index.cjs')) as typeof import('../src/core/index.js');
        const request = { token: esm.POLYGON_USDC.address, from: ADDR.user, to: ADDR.recipient, amount: '1', fee: '0', relay: ADDR.relay, nonce: '1', deadline: '2' } as const;
        expect(esm.transferDigest(137, TRANSFER_CONTRACT, request, SAMPLE_PERMIT_AUTH)).toBe(transferDigest(137, TRANSFER_CONTRACT, request, SAMPLE_PERMIT_AUTH));
        expect(cjs.transferDigest(137, TRANSFER_CONTRACT, request, SAMPLE_PERMIT_AUTH)).toBe(transferDigest(137, TRANSFER_CONTRACT, request, SAMPLE_PERMIT_AUTH));
    });

    it('the relay and viem entries load (viem stays external)', async () => {
        const relay = (await import(pathToFileURL(dist('relay/index.js')).href)) as Record<string, unknown>;
        const viemEntry = (await import(pathToFileURL(dist('viem/index.js')).href)) as Record<string, unknown>;
        expect(typeof relay.RelayClient).toBe('function');
        expect(typeof viemEntry.prepareTransfer).toBe('function');
        expect(readFileSync(dist('viem/index.js'), 'utf8')).toMatch(/from ["']viem["']/);
    });

    it('the core bundles import nothing and use no Node or storage APIs', () => {
        const iife = readFileSync(dist('core/index.global.js'), 'utf8');
        expect(iife).not.toMatch(/\brequire\(|\bimport\s*\(|\bprocess\.|\bBuffer\b|localStorage|sessionStorage|indexedDB|console\./);
        const esm = readFileSync(dist('core/index.js'), 'utf8');
        for (const [, specifier] of esm.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*["']([^"']+)["']/g)) {
            expect(specifier, 'the ESM core may only import its own chunks').toMatch(/^\.\//);
        }
    });
});

describe('IIFE global NimiqGaslessCore', () => {
    it('defines exactly one global', () => {
        const { context } = loadGlobal();
        expect(Object.keys(context).sort()).toEqual(['NimiqGaslessCore', 'TextEncoder', 'crypto']);
    });

    it('runs the full client-side flow inside the script context', async () => {
        const { context } = loadGlobal();
        const run = (code: string): unknown => JSON.parse(vm.runInContext(code, context) as string);
        const setup = `
            const C = NimiqGaslessCore;
            const pins = C.definePins({ chainId: 137, transfer: '${TRANSFER_CONTRACT}', relays: ['${ADDR.relay}'], tokens: C.POLYGON_TOKENS });
            const intent = C.createTransferIntent(pins, {
                token: C.POLYGON_USDC.address, from: '${ADDR.user}', to: '${ADDR.recipient}', amount: '10000000', fee: '50000',
                relay: '${ADDR.relay}', authMode: 'permit', deadline: ${NOW + 600}, nonce: '3', tokenNonce: '0',
            }, ${NOW});
            const tokenAuth = C.tokenAuthSigningPayload(pins, intent, ${NOW});`;
        const out = run(`(() => { ${setup}
            const denied = C.validateTransferRequest({ chainId: 137, contract: '${TRANSFER_CONTRACT}', request: { ...intent.request, to: C.LEGACY_NIMIQ_CONTRACTS_POLYGON[0] }, authMode: 'permit', tokenAuth: intent.tokenAuth }, pins, ${NOW});
            let thrown;
            try { C.createTransferIntent(pins, { ...intent.request, authMode: 'none', fee: String(2n ** 256n - 1n) }, ${NOW}); } catch (e) { thrown = { name: e.name, code: e.code, field: e.field }; }
            return JSON.stringify({ intent, tokenAuth, denied, thrown, frozen: Object.isFrozen(pins.tokens[0].domain), maxSendable: String(C.maxSendable('100', '30')) });
        })()`) as {
            intent: { request: Parameters<typeof transferDigest>[2] };
            tokenAuth: unknown;
            denied: unknown;
            thrown: unknown;
            frozen: boolean;
            maxSendable: string;
        };
        expect(out.intent.request.nonce).toBe('3');
        expect(out.denied).toMatchObject({ ok: false, code: 'invalid_recipient', field: 'request.to' });
        expect(out.thrown).toEqual({ name: 'GaslessValidationError', code: 'invalid_amount', field: 'request.amount' });
        expect(out.frozen).toBe(true);
        expect(out.maxSendable).toBe('70');

        // Sign outside with viem: the permit first, then the transfer typed data the script builds over it; assemble the
        // body inside the script context.
        const account = privateKeyToAccount(KEYS.user);
        const permitSignature = await account.signTypedData(out.tokenAuth as TypedDataDefinition);
        const signed = run(`(() => { ${setup}
            const authorization = C.toTokenAuthorization('permit', '${permitSignature}');
            return JSON.stringify({ authorization, transfer: C.transferSigningPayload(pins, intent, authorization, ${NOW}) });
        })()`) as { authorization: TokenAuthorization; transfer: unknown };
        const signature = await account.signTypedData(signed.transfer as TypedDataDefinition);
        const body = run(`(() => { ${setup}
            const authorization = C.toTokenAuthorization('permit', '${permitSignature}');
            const body = C.buildSubmitTransferBody({ request: intent.request, signature: '${signature}', authorization, quoteId: 'q' });
            return JSON.stringify({ body, check: C.validateSubmitTransferBody(body, pins, ${NOW}), id: C.transferDigest(137, '${TRANSFER_CONTRACT}', body.request, authorization), authHash: C.tokenAuthHash(authorization) });
        })()`) as { body: { signature: string; authorization: TokenAuthorization }; check: unknown; id: string; authHash: Hex };
        expect(body.check).toEqual({ ok: true });
        expect(body.body.signature).toBe(signature.toLowerCase());
        expect(body.body.authorization).toEqual(signed.authorization);
        expect([27, 28]).toContain(body.body.authorization.v);
        expect(body.id).toBe(transferDigest(137, TRANSFER_CONTRACT, out.intent.request, signed.authorization));
        expect(body.id).toBe(transferDigestFromAuthHash(137, TRANSFER_CONTRACT, out.intent.request, body.authHash));
    });

    it("carries the caller's fee ceiling and the META_TX opt-in to the browser bundle", () => {
        const { context } = loadGlobal();
        const out = JSON.parse(
            vm.runInContext(
                `(() => {
                    const C = NimiqGaslessCore;
                    const pins = C.definePins({ chainId: 137, transfer: '${TRANSFER_CONTRACT}', relays: ['${ADDR.relay}'], tokens: C.POLYGON_TOKENS });
                    const fields = { token: C.POLYGON_USDT0.address, from: '${ADDR.user}', to: '${ADDR.recipient}', amount: '10000000', fee: '50000', relay: '${ADDR.relay}', deadline: ${NOW + 600}, nonce: 0, tokenNonce: '0' };
                    const codeOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
                    const intent = C.createTransferIntent(pins, { ...fields, authMode: 'permit' }, ${NOW});
                    return JSON.stringify({
                        exported: [typeof C.checkAcceptableFee, typeof C.parseMaxAcceptableFee],
                        parsed: String(C.parseMaxAcceptableFee('50000')),
                        check: [C.checkAcceptableFee(50000n, 50000n, 'fee').ok, C.checkAcceptableFee(50001n, 50000n, 'fee').code],
                        metaTxRefused: codeOf(() => C.createTransferIntent(pins, { ...fields, authMode: 'metaTxApprove' }, ${NOW})),
                        metaTxAllowed: codeOf(() => C.createTransferIntent(pins, { ...fields, authMode: 'metaTxApprove' }, ${NOW}, { allowMetaTxApprove: true })),
                        aboveCeiling: codeOf(() => C.createTransferIntent(pins, { ...fields, authMode: 'permit' }, ${NOW}, { maxAcceptableFee: 40000 })),
                        atCeiling: codeOf(() => C.createTransferIntent(pins, { ...fields, authMode: 'permit' }, ${NOW}, { maxAcceptableFee: '50000' })),
                        signing: codeOf(() => C.tokenAuthSigningPayload(pins, intent, ${NOW}, { maxAcceptableFee: '40000' })),
                        signingTransfer: codeOf(() => C.transferSigningPayload(pins, intent, { mode: 'permit', v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) }, ${NOW}, { maxAcceptableFee: '40000' })),
                        validate: C.validateTransferRequest(intent, pins, ${NOW}, { maxAcceptableFee: '40000' }).code,
                        // No fee cap in the pins: without a ceiling any fee is taken.
                        uncapped: codeOf(() => C.createTransferIntent(pins, { ...fields, fee: '50000000', authMode: 'permit' }, ${NOW})),
                    });
                })()`,
                context,
            ) as string,
        ) as Record<string, unknown>;
        expect(out).toEqual({
            exported: ['function', 'function'],
            parsed: '50000',
            check: [true, 'fee_above_limit'],
            metaTxRefused: 'meta_tx_approve_not_allowed',
            metaTxAllowed: 'ok',
            aboveCeiling: 'fee_above_limit',
            atCeiling: 'ok',
            signing: 'fee_above_limit',
            signingTransfer: 'fee_above_limit',
            validate: 'fee_above_limit',
            uncapped: 'ok',
        });
    });

    it('carries correction rules, the caller-supplied nonce and the re-post option to the browser bundle', () => {
        const { context } = loadGlobal();
        const out = JSON.parse(
            vm.runInContext(
                `(() => {
                    const C = NimiqGaslessCore;
                    const pins = C.definePins({ chainId: 137, transfer: '${TRANSFER_CONTRACT}', relays: ['${ADDR.relay}'], tokens: C.POLYGON_TOKENS });
                    const fields = { token: C.POLYGON_USDC.address, from: '${ADDR.user}', to: '${ADDR.recipient}', amount: '10000000', fee: '50000', relay: '${ADDR.relay}', authMode: 'permit', deadline: ${NOW + 1200}, tokenNonce: '0' };
                    const codeOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code + ' ' + e.field; } };
                    const first = C.createTransferIntent(pins, { ...fields, nonce: '12' }, ${NOW});
                    const corrected = C.createTransferIntent(pins, { ...fields, fee: '60000', corrects: first.request }, ${NOW});
                    const none = { mode: 'none', v: 0, r: '0x' + '00'.repeat(32), s: '0x' + '00'.repeat(32) };
                    const body = { request: first.request, signature: '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b', authorization: none };
                    return JSON.stringify({
                        exported: typeof C.checkCorrection,
                        sameNonce: corrected.request.nonce === first.request.nonce,
                        earlier: codeOf(() => C.createTransferIntent(pins, { ...fields, deadline: ${NOW + 600}, corrects: first.request }, ${NOW})),
                        otherRecipient: codeOf(() => C.createTransferIntent(pins, { ...fields, to: '${ADDR.other}', corrects: first.request }, ${NOW})),
                        otherNonce: codeOf(() => C.createTransferIntent(pins, { ...fields, nonce: 13, corrects: first.request }, ${NOW})),
                        check: C.checkCorrection(first.request, corrected.request).ok,
                        // The core takes the nonce the client read on-chain; prepareTransfer (viem) reads it itself.
                        givenNonce: first.request.nonce,
                        noNonce: codeOf(() => C.createTransferIntent(pins, fields, ${NOW})),
                        prepareTransfer: typeof C.prepareTransfer,
                        repostWindow: [
                            C.validateSubmitTransferBody(body, pins, ${NOW + 3600}).code,
                            C.validateSubmitTransferBody(body, pins, ${NOW + 3600}, { repost: true }).ok,
                        ],
                    });
                })()`,
                context,
            ) as string,
        ) as Record<string, unknown>;
        expect(out).toEqual({
            exported: 'function',
            sameNonce: true,
            earlier: 'correction_mismatch request.deadline',
            otherRecipient: 'correction_mismatch request.to',
            otherNonce: 'correction_mismatch request.nonce',
            check: true,
            givenNonce: '12',
            noNonce: 'invalid_request nonce',
            prepareTransfer: 'undefined',
            repostWindow: ['deadline_out_of_range', true],
        });
    });

    it('accepts objects from another realm (e.g. an iframe) as input', () => {
        const { core } = loadGlobal();
        const pins = (core.definePins as (input: unknown) => { chainId: number })(polygonPinsInput());
        expect(pins.chainId).toBe(137);
    });
});
