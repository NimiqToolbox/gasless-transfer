import { describe, expect, it } from 'vitest';
import { BaseError, CallExecutionError, HttpRequestError } from 'viem';
import { serializeError } from '../../src/logger.js';
import { captureLogger } from '../helpers/harness.js';
import { scrubString } from '../../src/util/redact.js';

const SIGNATURE = `0x${'5a'.repeat(32)}${'6b'.repeat(32)}1b`;
const R = `0x${'7c'.repeat(32)}`;
const S = `0x${'8d'.repeat(32)}`;
const RAW_TX = `0x02f8${'9e'.repeat(180)}`;
const PRIVATE_KEY = `0x${'af'.repeat(32)}`;
const CALLDATA = `0x7f5e1c3a${'00'.repeat(12)}${'ab'.repeat(300)}`;

function secretsIn(text: string): string[] {
    const lower = text.toLowerCase();
    return [SIGNATURE, R, S, RAW_TX, PRIVATE_KEY, CALLDATA].filter((s) => lower.includes(s.slice(2).toLowerCase()));
}

describe('T36: log redaction', () => {
    it.each(['http', 'https', 'ws', 'wss', 'HTTPS', 'WSS'])('scrubs %s URL credentials while retaining diagnostics and public hashes', (scheme) => {
        const hash = `0x${'12'.repeat(32)}`;
        const url = `${scheme}://user:FAKE_PASSWORD@rpc.example/FAKE_PATH?key=FAKE_QUERY#FAKE_FRAGMENT`;
        expect(scrubString(`failed "${url}" request ${hash}`)).toBe(`failed "[REDACTED_URL]" request ${hash}`);
        expect(scrubString(`upstream ${url}\nretry scheduled`)).toBe('upstream [REDACTED_URL]\nretry scheduled');
    });

    it('removes the whole URL before hex scrubbing, including escaped diagnostic URLs', () => {
        const url = `https://rpc.example/${'ab'.repeat(100)}?key=FAKE_SHORT_KEY`;
        expect(scrubString(`upstream=${url} timeout`)).toBe('upstream=[REDACTED_URL] timeout');
        const escaped = url.replaceAll('/', '\\/');
        expect(scrubString(`{"url":"${escaped}"}`)).toBe('{"url":"[REDACTED_URL]"}');
        expect(scrubString(`url${url}`)).toBe('url[REDACTED_URL]');
        // Apostrophes are legal URL characters, including before a credential in the path.
        expect(scrubString("failed https://rpc.example/'/v2/FAKE_API_KEY timeout")).toBe('failed [REDACTED_URL] timeout');
        expect(scrubString('failed https://rpc.example/`/v2/FAKE_API_KEY timeout')).toBe('failed [REDACTED_URL] timeout');
    });

    it('censors signatures, token authorizations, raw transactions, keys and bodies at any of the first levels', () => {
        const { logger, text } = captureLogger();
        logger.info({ signature: SIGNATURE, authorization: { mode: 'permit', v: 27, r: R, s: S }, raw: RAW_TX, privateKey: PRIVATE_KEY }, 'top level');
        logger.info({ submission: { signature: SIGNATURE, authorization: { v: 27, r: R, s: S } }, tx: { raw: RAW_TX } }, 'nested');
        logger.info({ a: { b: { signature: SIGNATURE, authorization: { r: R } } } }, 'deeper');
        logger.info({ a: { b: { c: { signature: SIGNATURE, authorization: { s: S } } } } }, 'deepest');
        logger.info({ req: { body: { signature: SIGNATURE } }, body: { request: {} } }, 'bodies');
        logger.info({ serializedTransaction: RAW_TX, rawTransaction: RAW_TX }, 'viem names');
        const out = text();
        expect(secretsIn(out)).toEqual([]);
        expect(out).toContain('[REDACTED]');
    });

    it('scrubs long hex runs (calldata, raw txs, signatures) from messages and unknown fields', () => {
        const { logger, text } = captureLogger();
        logger.info({ note: `calldata ${CALLDATA}`, list: [RAW_TX, SIGNATURE] }, `message with ${RAW_TX} inside`);
        logger.warn(`format ${SIGNATURE}`);
        const out = text();
        expect(secretsIn(out)).toEqual([]);
        expect(out).toContain('[REDACTED_HEX]');
    });

    it('keeps public values: addresses, hashes, request ids', () => {
        const { logger, text } = captureLogger();
        const hash = `0x${'12'.repeat(32)}`;
        logger.info({ requestId: hash, txHash: hash, signer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'public');
        expect(text()).toContain(hash);
        expect(text()).toContain('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    });

    it('writes the level as its name, which log platforms map to a severity', () => {
        const { logger, lines } = captureLogger();
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        logger.fatal('f');
        expect(lines.map((l) => (JSON.parse(l) as { level: unknown }).level)).toEqual(['info', 'warn', 'error', 'fatal']);
    });

    it('serializes viem errors without call data, raw transactions or RPC URLs', () => {
        const { logger, text } = captureLogger();
        const cause = new BaseError('execution reverted', { details: `execution reverted: custom error ${CALLDATA}` });
        const callError = new CallExecutionError(cause, {
            account: undefined,
            data: CALLDATA as `0x${string}`,
            to: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        });
        const httpError = new HttpRequestError({
            url: 'https://polygon-mainnet.example/v3/SECRET_API_KEY',
            body: { method: 'eth_sendRawTransaction', params: [RAW_TX] },
            details: 'timeout',
        });
        logger.error({ err: callError }, 'call failed');
        logger.error({ err: httpError }, 'broadcast failed');
        const out = text();
        expect(secretsIn(out)).toEqual([]);
        expect(out).not.toContain('SECRET_API_KEY');
        expect(out).toContain('CallExecutionError');
        expect(serializeError(httpError)).toEqual({ type: 'HttpRequestError', message: 'HTTP request failed.', details: 'timeout' });
    });

    it('serializes plain errors and non-errors, and bigints as strings', () => {
        const { logger, text } = captureLogger();
        logger.error({ err: new Error(`failed for ${RAW_TX}`), amount: 10n ** 30n }, 'plain');
        expect(secretsIn(text())).toEqual([]);
        expect(text()).toContain('"amount":"1000000000000000000000000000000"');
        expect(serializeError('oops')).toEqual({ message: 'oops' });
    });

    it('removes credential-bearing URLs echoed in provider details, plain errors and log fields', () => {
        const { logger, text } = captureLogger();
        const url = 'https://operator:FAKE_PASSWORD@rpc.example/v2/FAKE_API_KEY?access_token=FAKE_QUERY_TOKEN#FAKE_FRAGMENT';
        logger.error({ err: new HttpRequestError({ url, details: `upstream rejected ${url}` }) }, 'provider failure');
        logger.error({ err: new Error(`connection failed for ${url}`) }, 'plain failure');
        logger.warn({ nested: { endpoints: [url] } }, `retrying ${url}`);
        logger.warn({ err: `unexpected upstream ${url}` }, 'non-error failure');
        const out = text();
        for (const secret of ['FAKE_PASSWORD', 'FAKE_API_KEY', 'FAKE_QUERY_TOKEN', 'FAKE_FRAGMENT']) {
            expect(out).not.toContain(secret);
        }
        expect(out).toContain('provider failure');
        expect(out).toContain('connection failed');
    });
});
