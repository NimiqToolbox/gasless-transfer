import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        // The anvil tests send transactions; the dist test runs a full tsup build.
        testTimeout: 30_000,
        hookTimeout: 180_000,
    },
});
