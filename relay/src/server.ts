// Process wiring, shared by the entrypoint (main.ts) and the integration tests: files → on-chain
// verification → database → relay → transaction manager → monitors → HTTP. Every failure is thrown;
// main.ts turns it into exit status 1.
import type { Hex } from 'viem';
import { POLYGON_CHAIN_ID } from '@nimiq/gasless-sdk/core';
import { readFeedDescription } from './chain/reads.js';
import { createLocalSigner } from './chain/signer.js';
import { createViemChainClient } from './chain/viemChainClient.js';
import { systemClock } from './clock.js';
import {
    checkChainSettings,
    checkGasTableCoverage,
    loadDeploymentFile,
    loadGasTableFile,
    privateKeyFileMode,
    readPrivateKeyFile,
    removePrivateKeyFile,
    type Deployment,
    type RelayConfig,
} from './config.js';
import type { Logger } from './logger.js';
import { createMetrics } from './metrics.js';
import { historyWindowOf, verifyRpcHistory } from './ops/rpcHistory.js';
import { RpcUsage } from './ops/rpcUsage.js';
import { loadTokenImplementationPins } from './ops/tokenImplementationMonitor.js';
import { createPriceSource, createRelay, type Relay } from './relay.js';
import { verifyDeployment } from './startup.js';
import { SqliteStore } from './store/sqliteStore.js';

export interface RelayServer {
    readonly relay: Relay;
    readonly store: SqliteStore;
    readonly deployment: Deployment;
    /** Public listen address, e.g. `http://127.0.0.1:8080`. */
    readonly address: string;
    /** Internal listener for /healthz, /readyz and /metrics, e.g. `http://127.0.0.1:9464`; null if RELAY_OPS_PORT=off. */
    readonly opsAddress: string | null;
    /** Stops HTTP (new requests get 503), the monitors and the transaction manager (after its tick), then closes the database. */
    close(): Promise<void>;
}

/**
 * A key file that group or others may read is accepted (Docker Swarm mounts secrets with
 * mode 0444 by default), but logged as a warning; the file should be 0400 or 0600.
 */
export function warnIfKeyFileExposed(path: string, logger: Logger): void {
    const mode = privateKeyFileMode(path);
    if (mode !== undefined && (mode & 0o077) !== 0) {
        logger.warn({ mode: `0${mode.toString(8)}` }, 'RELAY_PRIVATE_KEY_FILE is readable by other users; restrict it to mode 0400 or 0600');
    }
}

/**
 * Reads the key. A temporary copy (RELAY_PRIVATE_KEY_FILE_REMOVE) is deleted whether its content was accepted or
 * refused: a refused file can hold a key with a typing error, or most of one.
 */
function readSigningKey(config: Pick<RelayConfig, 'privateKeyFile' | 'privateKeyFileRemove'>, logger: Logger): Hex {
    let key: Hex;
    try {
        key = readPrivateKeyFile(config.privateKeyFile);
    } catch (err) {
        if (config.privateKeyFileRemove) {
            try {
                removePrivateKeyFile(config.privateKeyFile);
            } catch (removeErr) {
                // The start fails with the reason the file was refused; that the file is still there is logged before it.
                logger.error({ err: removeErr }, 'the key file of this failed start was not removed');
            }
        }
        throw err;
    }
    warnIfKeyFileExposed(config.privateKeyFile, logger);
    if (config.privateKeyFileRemove) removePrivateKeyFile(config.privateKeyFile);
    return key;
}

export async function startServer(config: RelayConfig, logger: Logger): Promise<RelayServer> {
    // The key first: a temporary copy (RELAY_PRIVATE_KEY_FILE_REMOVE) is gone before any other file or the chain can
    // stop the start. The key string is only passed to viem's account; it is never stored in config or logged.
    const signer = createLocalSigner(readSigningKey(config, logger));

    if (config.unreadVariables.length > 0) {
        logger.warn(
            { variables: config.unreadVariables },
            'these RELAY_ variables are set but not used: a misspelt or unsupported name leaves its setting at the default (relay/README.md, "Configuration")',
        );
    }
    const deployment = loadDeploymentFile(config.deploymentFile);
    checkChainSettings(config, deployment.chainId);
    if (deployment.chainId === POLYGON_CHAIN_ID && !config.tokenPinsFile) {
        throw new Error('RELAY_TOKEN_PINS_FILE with reviewed token implementation pins is required on Polygon mainnet');
    }
    const tokenImplementationPins = config.tokenPinsFile ? loadTokenImplementationPins(config.tokenPinsFile, deployment) : undefined;
    const gasTable = loadGasTableFile(config.gasTableFile);
    checkGasTableCoverage(gasTable, deployment);
    if (gasTable.source === 'placeholder') {
        logger.warn({ chainId: deployment.chainId }, 'gas table is a placeholder; replace it with a Polygon-native calibration (relay/README.md, "Gas table")');
    }

    const metrics = createMetrics({ defaultMetrics: true });
    const rpcUsage = new RpcUsage({ logger, metrics, rpcCount: config.rpcUrls.length });
    const chain = createViemChainClient({ rpcUrls: config.rpcUrls, timeoutMs: config.rpcTimeoutMs, onRequest: (event) => rpcUsage.record(event) });
    // A token whose EIP-712 domain changed on-chain does not stop startup: the relay starts degraded.
    const verified = await verifyDeployment(chain, deployment, logger);
    // Every RPC must serve the state of the blocks the search for the use of an intent nonce reads.
    const rpcHistory = await verifyRpcHistory(chain, deployment.gaslessTransfer, deployment.deployBlock, historyWindowOf(deployment.chainId, config.tx), logger);

    const store = SqliteStore.open(config.dbPath);
    try {
        store.bindIdentity({ chainId: deployment.chainId, relay: signer.address, gaslessTransfer: deployment.gaslessTransfer });

        const priceSource = createPriceSource({
            feed: config.priceFeed,
            chainId: deployment.chainId,
            chain,
            clock: systemClock,
            cacheMs: config.priceCacheMs,
            logger,
            metrics,
        });
        if (priceSource.feed) {
            const description = await readFeedDescription(chain, priceSource.feed).catch(() => 'unreadable');
            logger.info({ feed: priceSource.feed, description }, 'POL/USD price feed');
        }

        const relay = await createRelay({
            deployment,
            gasTable,
            chain,
            signer,
            store,
            priceSource,
            logger,
            metrics,
            tokenDomainReadings: verified.tokenDomains,
            rpcHistory,
            settings: {
                ...(tokenImplementationPins ? { tokenImplementationPins } : {}),
                rateLimit: config.rateLimit,
                maxConcurrentValidations: config.maxConcurrentValidations,
                admission: config.admission,
                validationTimeoutMs: config.validationTimeoutMs,
                feeMarginBps: config.feeMarginBps,
                feeCacheMs: config.feeCacheMs,
                minPolBalanceWei: config.minPolBalanceWei,
                recipientDenylist: config.recipientDenylist,
                tx: config.tx,
                readinessCacheMs: config.readinessCacheMs,
                httpLimits: config.http,
            },
        });
        const stop = async (): Promise<void> => {
            rpcUsage.stop();
            await relay.close();
        };
        try {
            await relay.txManager.recover();
            relay.txManager.start();
            relay.tokenDomains.start(config.tokenDomainCheckMs);
            relay.tokenImplementations?.start();
            relay.rpcHistory.start(config.rpcHistoryCheckMs);
            rpcUsage.start(config.rpcUsageLogMs);
            // The internal listener first: if its port is taken, the relay stops before it takes traffic.
            const opsAddress = config.ops ? await relay.opsApp.listen({ host: config.ops.host, port: config.ops.port }) : null;
            const address = await relay.app.listen({ host: config.host, port: config.port });
            logger.info({ relay: signer.address, chainId: deployment.chainId, address, opsAddress }, 'relay started');
            return {
                relay,
                store,
                deployment,
                address,
                opsAddress,
                async close() {
                    try {
                        await stop();
                    } finally {
                        store.close();
                    }
                },
            };
        } catch (err) {
            await stop();
            throw err;
        }
    } catch (err) {
        store.close();
        throw err;
    }
}
