import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { 'core/index': 'src/core/index.ts', 'relay/index': 'src/relay/index.ts', 'viem/index': 'src/viem/index.ts' },
        format: ['esm', 'cjs'],
        dts: true,
        target: 'es2020',
        sourcemap: true,
        // tsup builds both configs concurrently; without the exclusions this clean could delete the
        // IIFE files the second config has already written (they are overwritten on every build).
        clean: ['!**/*.global.js', '!**/*.global.js.map'],
        external: ['viem'],
    },
    {
        // Browser bundle: <script src="core/index.global.js"> → window.NimiqGaslessCore
        entry: { 'core/index': 'src/core/index.ts' },
        format: ['iife'],
        globalName: 'NimiqGaslessCore',
        target: 'es2020',
        platform: 'browser',
        sourcemap: true,
        minify: false,
    },
]);
