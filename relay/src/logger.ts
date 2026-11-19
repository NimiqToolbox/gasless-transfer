import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { BaseError } from 'viem';
import { scrubDeep, scrubString } from './util/redact.js';

export type { Logger } from 'pino';

/**
 * Keys that are always censored, at any of the first levels of a log object. The relay does not log
 * these values on purpose; this list is the second line of defence (see relay/README.md).
 */
const REDACT_PATHS: readonly string[] = [
    'privateKey',
    '*.privateKey',
    'signature',
    '*.signature',
    '*.*.signature',
    '*.*.*.signature',
    'authorization',
    '*.authorization',
    '*.*.authorization',
    '*.*.*.authorization',
    'raw',
    '*.raw',
    '*.*.raw',
    'rawTransaction',
    '*.rawTransaction',
    'serializedTransaction',
    '*.serializedTransaction',
    'body',
    '*.body',
    'req.headers.cookie',
];

export const REDACTED = '[REDACTED]';

/**
 * Error serializer that never includes request arguments. viem errors carry call data, raw
 * transactions and RPC URLs (which may embed API keys) in `message`, `metaMessages` and `stack`, so
 * only the short message and the node's details are kept, both scrubbed of URLs and long hex runs.
 */
export function serializeError(err: unknown): Record<string, unknown> {
    if (!(err instanceof Error)) return { message: scrubString(String(err)) };
    const out: Record<string, unknown> = { type: err.name };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.code = code;
    if (err instanceof BaseError) {
        out.message = scrubString(err.shortMessage);
        if (err.details) out.details = scrubString(err.details);
        return out;
    }
    out.message = scrubString(err.message);
    if (err.stack) out.stack = scrubString(err.stack);
    return out;
}

export interface LoggerSettings {
    level?: string;
}

export function createLogger(settings: LoggerSettings = {}, destination?: DestinationStream): Logger {
    const options: LoggerOptions = {
        level: settings.level ?? 'info',
        base: { service: 'gasless-relay' },
        redact: { paths: [...REDACT_PATHS], censor: REDACTED },
        serializers: { err: serializeError, error: serializeError },
        formatters: {
            // The level as its name ("warn", "error"): log platforms map a numeric pino level (40, 50) to info.
            level: (label) => ({ level: label }),
            log: (object) => scrubDeep(object) as Record<string, unknown>,
        },
        hooks: {
            logMethod(args, method) {
                const scrubbed = args.map((a) => (typeof a === 'string' ? scrubString(a) : a)) as typeof args;
                return method.apply(this, scrubbed);
            },
        },
    };
    return destination ? pino(options, destination) : pino(options);
}
