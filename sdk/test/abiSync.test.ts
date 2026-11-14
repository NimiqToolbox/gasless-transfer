// The SDK's GaslessTransfer ABI (sdk/abi/GaslessTransfer.json and the generated sdk/src/core/abi.ts)
// must be the ABI solc produces for contracts/src/GaslessTransfer.sol, so that a contract change
// without regenerating the SDK ABI fails CI. The compile check needs forge, i.e. the toolchain
// container (`docker compose run --build --rm node-test 'pnpm --filter @nimiq/gasless-sdk test'`):
// it builds only src/GaslessTransfer.sol and its imports, with contracts/foundry.toml, into a temp
// dir. Without forge it is skipped, but never under CI (the toolchain image sets CI=1), where a
// missing forge fails it instead. Regenerate the ABI, in the container, with
//   bash sdk/scripts/gen-abi.sh src/GaslessTransfer.sol:GaslessTransfer

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gaslessTransferAbi, usdcAbi, usdt0Abi } from '../src/core/abi.js';
import { inCI } from './helpers/anvil.js';

interface AbiEntry {
    readonly type: string;
    readonly name?: string;
}

const sdkRoot = fileURLToPath(new URL('..', import.meta.url));
const contractsRoot = fileURLToPath(new URL('../../contracts', import.meta.url));

function readJson<T>(file: string): T {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function forgeAvailable(): boolean {
    try {
        execFileSync('forge', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const sdkAbi = readJson<AbiEntry[]>(path.join(sdkRoot, 'abi', 'GaslessTransfer.json'));

describe('generated ABI module', () => {
    it('sdk/src/core/abi.ts exports exactly the ABIs of sdk/abi/*.json', () => {
        expect(gaslessTransferAbi).toEqual(sdkAbi);
        expect(usdcAbi).toEqual(readJson(path.join(sdkRoot, 'abi', 'usdc.json')));
        expect(usdt0Abi).toEqual(readJson(path.join(sdkRoot, 'abi', 'usdt0.json')));
    });
});

describe.skipIf(!forgeAvailable() && !inCI())('sdk/abi/GaslessTransfer.json and the compiled contract', () => {
    let tmp = '';
    const compiledAbi = (source: string, contract: string): AbiEntry[] =>
        readJson<{ abi: AbiEntry[] }>(path.join(tmp, 'out', source, `${contract}.json`)).abi;

    beforeAll(() => {
        tmp = mkdtempSync(path.join(os.tmpdir(), 'gasless-abi-sync-'));
        execFileSync(
            'forge',
            ['build', 'src/GaslessTransfer.sol', '--root', contractsRoot, '--out', path.join(tmp, 'out'), '--cache-path', path.join(tmp, 'cache'), '--offline'],
            { cwd: contractsRoot, stdio: 'pipe' },
        );
    }, 180_000);

    afterAll(() => {
        if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
    });

    it('sdk/abi/GaslessTransfer.json equals the ABI solc produces for contracts/src/GaslessTransfer.sol', () => {
        expect(sdkAbi).toEqual(compiledAbi('GaslessTransfer.sol', 'GaslessTransfer'));
    });

    it('its functions and events are exactly those of the frozen IGaslessTransfer interface and Ownable2Step', () => {
        const surface = (abi: AbiEntry[]): AbiEntry[] =>
            abi
                .filter((entry) => entry.type === 'function' || entry.type === 'event')
                .sort((a, b) => `${a.type} ${a.name}`.localeCompare(`${b.type} ${b.name}`));
        // IGaslessBase does not repeat the owner functions and events: solc rejects an event declared again.
        const expected = [
            ...compiledAbi('IGaslessTransfer.sol', 'IGaslessTransfer'),
            ...compiledAbi('Ownable2Step.sol', 'Ownable2Step'),
        ];
        expect(surface(sdkAbi)).toEqual(surface(expected));
    });
});
