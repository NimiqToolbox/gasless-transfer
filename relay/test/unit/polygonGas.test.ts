// Gas estimates observed on Polygon for every transfer route (external observations, not measurements made by the
// implementation under test). The gas table the relay ships must leave room for each of them: a cap below the gas a
// call needs on Polygon makes the relay refuse that call.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callGasLimit } from '../../src/tx/policy.js';

const evidence = JSON.parse(readFileSync(new URL('../fixtures/polygon-gas-estimates.json', import.meta.url), 'utf8')) as {
    cases: Array<{ route: string; mode: string; phase: string; polygonEstimate: string }>;
};
const table = JSON.parse(readFileSync(new URL('../../config/gasTable.json', import.meta.url), 'utf8')).operations.transfer as Record<string, number>;

describe('Polygon gas schedule regression', () => {
    it.each(evidence.cases)('$route / $phase fits the shipped cap with at least 10% headroom', row => {
        const estimate = BigInt(row.polygonEstimate);
        const minimum = (estimate * 110n + 99n) / 100n;
        const decision = callGasLimit({ estimate, table: BigInt(table[row.mode]!), maxGasLimit: 300_000n, marginPercent: 30 });
        expect(decision.ok).toBe(true);
        if (!decision.ok) throw new Error('Polygon estimate rejected by shipped cap');
        expect(decision.gas).toBeGreaterThanOrEqual(minimum);
        expect(decision.gas).toBeLessThanOrEqual(300_000n);
    });

    it('refuses a call whose Polygon estimate is above the cap of the gas table, reporting the gas it needs and the cap', () => {
        expect(callGasLimit({ estimate: 250_275n, table: 232_049n, maxGasLimit: 300_000n, marginPercent: 30 }))
            .toEqual({ ok: false, needed: 250_275n, cap: 232_049n });
    });
});
