// Relay entrypoint: `node dist/main.js`. Configuration is read from environment variables and files
// (relay/README.md); the private key comes from RELAY_PRIVATE_KEY_FILE (a Docker secret).
import { loadConfig, privateKeyFileToRemove, removePrivateKeyFile, type RelayConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';

/** Plain message only: configuration errors never contain secret values. */
function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

let config: RelayConfig;
// Known before the rest of the configuration is loaded: a temporary key copy (RELAY_PRIVATE_KEY_FILE_REMOVE) must not
// outlive a start that stopped before startServer read and removed it.
let keyFileToRemove: string | undefined;
try {
    keyFileToRemove = privateKeyFileToRemove(process.env);
    config = loadConfig(process.env);
} catch (err) {
    console.error(`relay configuration error: ${messageOf(err)}`);
    if (keyFileToRemove !== undefined) {
        try {
            removePrivateKeyFile(keyFileToRemove);
        } catch (removeErr) {
            console.error(`relay configuration error: ${messageOf(removeErr)}`);
        }
    }
    process.exit(1);
}
const logger = createLogger({ level: config.logLevel });

startServer(config, logger).then(
    (server) => {
        let stopping = false;
        const shutdown = (signal: string): void => {
            if (stopping) return;
            stopping = true;
            logger.info({ signal }, 'shutting down');
            server
                .close()
                .catch((err: unknown) => logger.error({ err }, 'error during shutdown'))
                .finally(() => process.exit(0));
        };
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        process.once('SIGINT', () => shutdown('SIGINT'));
    },
    (err: unknown) => {
        logger.fatal({ err }, 'relay failed to start');
        process.exit(1);
    },
);
