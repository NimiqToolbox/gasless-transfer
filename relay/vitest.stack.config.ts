import { defineConfig } from 'vitest/config';

// Smoke test against a running compose stack (make stack-test): the relay image, anvil and the
// deployment written by the deploy service. Configured by STACK_* environment variables.
export default defineConfig({
    test: {
        include: ['test/stack/**/*.test.ts'],
        environment: 'node',
        testTimeout: 120_000,
    },
});
