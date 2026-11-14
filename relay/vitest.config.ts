import { configDefaults, defineConfig } from 'vitest/config';

// Unit, HTTP, security and entrypoint tests (fake chain). The anvil suites have their own configs:
// vitest.integration.config.ts (pnpm test:integration) and vitest.stack.config.ts (pnpm test:stack).
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: [...configDefaults.exclude, 'test/integration/**', 'test/stack/**'],
        environment: 'node',
    },
});
