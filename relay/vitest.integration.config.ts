import { defineConfig } from 'vitest/config';

// Integration tests against the real contracts on a local anvil (they need anvil, forge and contracts/lib):
//   pnpm --filter @nimiq/gasless-relay test:integration
export default defineConfig({
    test: {
        include: ['test/integration/**/*.test.ts'],
        environment: 'node',
        // Compiles the contracts and the relay's dist/ once.
        globalSetup: ['test/integration/globalSetup.ts'],
        // Every file starts its own anvil and deploys with forge script, which writes the one
        // contracts/deployments/31337.json: files run one after another.
        fileParallelism: false,
        testTimeout: 60_000,
        hookTimeout: 180_000,
    },
});
