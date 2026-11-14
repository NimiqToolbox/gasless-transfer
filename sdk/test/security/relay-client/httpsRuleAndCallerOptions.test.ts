// Inputs that decide where signed data goes and how much the user pays must not be settable by a crafted value:
//
// - RelayClient's https rule (spec §7): URL parser tricks (credentials, fragments, backslashes, trailing dots,
//   IPv4 shorthand, IPv6 forms, percent-encoding, Unicode that maps to ASCII, subdomains of localhost) never let a
//   remote host pass as loopback. The check reads the WHATWG-normalized hostname, and the client only ever sends
//   to that normalized URL, so a host that passes is the host fetch connects to.
// - maxAcceptableFee (core, also the IIFE global): bigint, decimal string or safe integer; anything else is
//   invalid_request (fail closed).
// - createTransferIntent's options argument: fields passed in by the client cannot set allowMetaTxApprove or
//   maxAcceptableFee, also not through a JSON "__proto__" key.

import { describe, expect, it } from 'vitest';
import { GaslessValidationError } from '../../../src/core/errors.js';
import { createTransferIntent } from '../../../src/core/intent.js';
import { parseMaxAcceptableFee } from '../../../src/core/validate.js';
import { RelayClient } from '../../../src/relay/client.js';
import { ADDR, NOW, polygonPins, USDT0 } from '../../helpers/fixtures.js';
import { infoFor } from '../../helpers/relay.js';

const pins = polygonPins();
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Constructs a client for `url` and returns the URL its first request goes to, or the constructor's error. */
async function firstRequestUrl(url: string): Promise<string> {
    let sent = '';
    const fetch = async (input: string): Promise<Response> => {
        sent = input;
        return new Response(JSON.stringify(infoFor(pins)), { status: 200 });
    };
    let client: RelayClient;
    try {
        client = new RelayClient(url, { pins, fetch });
    } catch (error) {
        return `refused: ${(error as Error).name}`;
    }
    await client.info();
    return sent;
}

describe('the https rule of the relay URL and the options only the signing app sets', () => {
    it('https only: no URL form lets a remote host pass as loopback, and an accepted http URL is sent to a loopback host', async () => {
        const loopback = [
            'http://localhost',
            'http://LOCALHOST:8080',
            'http://127.1',
            'http://0x7f.0.0.1',
            'http://0177.0.0.1',
            'http://2130706433',
            'http://127.0.0.1.',
            'http://127。0。0。1',
            'http://[0:0:0:0:0:0:0:1]',
            'http://%6c%6f%63%61%6c%68%6f%73%74',
            'http://ｌｏｃａｌｈｏｓｔ',
            'http:localhost',
            'http://localhost\\@evil.example',
            'http://localhost:8080\\@evil.example/',
        ];
        const remote = [
            'http://localhost@evil.example',
            'http://evil.example:80@127.0.0.1',
            'http://[::1]@evil.example',
            'http://evil.example#@localhost',
            'http://evil.example?@localhost',
            'http://evil.example\\@localhost',
            'http:/\\evil.example',
            'http://localhost.',
            'http://localhost%2e',
            'http://sub.localhost',
            'http://localhost.evil.example',
            'http://localhost%2eevil.example',
            'http://127.0.0.1。evil.example',
            'http://127.0.0.1.nip.io',
            'http://[::ffff:127.0.0.1]',
            'http://[::]',
            'http://0.0.0.0',
            'http://127.0.0.2',
            'http://127.0.0.1%00.evil.example',
            'http://[::1%25eth0]',
            'ftp://localhost',
        ];
        for (const url of loopback) {
            const sent = await firstRequestUrl(url);
            expect(sent, url).toMatch(/^http:\/\//);
            expect(LOOPBACK, `${url} -> ${sent}`).toContain(new URL(sent).hostname);
        }
        for (const url of remote) expect(await firstRequestUrl(url), url).toBe('refused: TypeError');
        // allowInsecureHttp is the only way around it, and only the literal true.
        for (const value of ['true', 1, {}, 'yes']) {
            expect(() => new RelayClient('http://relay.internal', { pins, allowInsecureHttp: value as never, fetch: async () => new Response() }), String(value)).toThrow(TypeError);
        }
    });

    it('maxAcceptableFee: bigint, decimal string and safe integer are accepted; everything else is invalid_request', () => {
        const accepted: Array<[unknown, bigint]> = [
            [100_000n, 100_000n],
            ['100000', 100_000n],
            ['000100000', 100_000n],
            [100_000, 100_000n],
            [0, 0n],
            [-0, 0n],
            [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
        ];
        for (const [value, parsed] of accepted) expect(parseMaxAcceptableFee(value as never), String(value)).toBe(parsed);
        expect(parseMaxAcceptableFee(undefined)).toBeUndefined();
        const refused = [-1n, -1, 0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '0.10', '1e5', '0x186a0', ' 100000', '100000 ', '+1', '-1', '', null, true, {}, [], 2n ** 256n];
        for (const value of refused) {
            let code: string | undefined;
            try {
                parseMaxAcceptableFee(value as never);
            } catch (error) {
                code = error instanceof GaslessValidationError ? error.code : `other: ${String(error)}`;
            }
            expect(code, String(value)).toBe('invalid_request');
        }
    });

    it('createTransferIntent: client-supplied fields cannot set allowMetaTxApprove or maxAcceptableFee (also not via a JSON "__proto__" key)', () => {
        const fields = JSON.parse(
            JSON.stringify({
                token: USDT0,
                from: ADDR.user,
                to: ADDR.recipient,
                amount: '10000000',
                fee: '4000000',
                relay: ADDR.relay,
                authMode: 'metaTxApprove',
                deadline: NOW + 600,
                nonce: '0',
                tokenNonce: '0',
                allowMetaTxApprove: true,
                maxAcceptableFee: '5000000',
            }),
        ) as Record<string, unknown>;
        const proto = JSON.parse('{"__proto__": {"allowMetaTxApprove": true, "maxAcceptableFee": "5000000"}}') as Record<string, unknown>;
        const codeOf = (fn: () => unknown): string => {
            try {
                fn();
                return 'ok';
            } catch (error) {
                return (error as { code?: string }).code ?? String(error);
            }
        };
        // The signing app's own options are the only source.
        expect(codeOf(() => createTransferIntent(pins, { ...fields, ...proto } as never, NOW, { maxAcceptableFee: 5_000_000 }))).toBe('meta_tx_approve_not_allowed');
        expect(codeOf(() => createTransferIntent(pins, { ...fields, ...proto, authMode: 'permit' } as never, NOW, { maxAcceptableFee: 100_000 }))).toBe('fee_above_limit');
        expect(codeOf(() => createTransferIntent(pins, { ...fields, ...proto } as never, NOW, { allowMetaTxApprove: true, maxAcceptableFee: 5_000_000 }))).toBe('ok');
        expect(Object.prototype).not.toHaveProperty('allowMetaTxApprove');
    });
});
