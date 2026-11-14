import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Fault injection against the relay and contracts on local Anvil.
// Polygon gas calibration and the forkE2E fixture require VER_FORK=true and POLYGON_RPC_URL.
export default defineConfig({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    test: {
        include: ['test/fault/**/*.fault.ts'],
        environment: 'node',
        // Compiles the contracts (including contracts/test/fork-verify, whose 7702 delegates are deployed
        // here) and the relay's dist/ once.
        globalSetup: ['test/integration/globalSetup.ts'],
        // Every file starts its own anvil and runs forge script, which writes contracts/deployments/31337.json.
        fileParallelism: false,
        testTimeout: 120_000,
        hookTimeout: 180_000,
    },
});
