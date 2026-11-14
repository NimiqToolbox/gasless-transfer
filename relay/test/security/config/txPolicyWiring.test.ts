// Every policy variable of relay/src/tx/settings.ts reaches the transaction manager through relay/src/config.ts. A
// variable that is parsed but not passed on would leave the relay on a default (the spend cap, the finality depth)
// that the operator believes to have changed. loadConfig() spreads parseTxPolicyEnv() into config.tx; src/server.ts
// passes config.tx to createRelay(); createRelay() passes settings.tx to the TxManager, whose txPolicy() picks the
// six policy fields. The bounds of the values are covered by finalityFloor.test.ts and deadlineSettings.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { TxPolicySettings } from '../../../src/tx/settings.js';
import { createHarness, type Harness } from '../../helpers/harness.js';
import { BASE_ENV } from '../../helpers/txManagerDriver.js';

let h: Harness | undefined;

afterEach(async () => {
    await h?.close();
    h = undefined;
});

describe('transaction-manager policy settings reach the TxManager', () => {
    it('non-default values of all six RELAY_* policy variables arrive in the TxManager policy', async () => {
        const config = loadConfig({
            ...BASE_ENV,
            RELAY_MAX_COST_PERCENT_OF_FEE: '150',
            RELAY_MIN_FINALITY_DEPTH: '32',
            RELAY_NONCE_GAP_BLOCKS: '7',
            RELAY_REQUEST_RETENTION_DAYS: '3',
            RELAY_STUCK_AFTER_BLOCKS: '77',
            RELAY_MAX_FINALITY_LAG_BLOCKS: '900',
        });
        h = await createHarness({ settings: { tx: config.tx } });
        const policy = (h.relay.txManager as unknown as { policy: TxPolicySettings }).policy;
        expect(policy).toEqual({
            maxCostPercentOfFee: 150,
            minFinalityDepth: 32,
            nonceGapBlocks: 7,
            requestRetentionMs: 3 * 24 * 3600 * 1000,
            stuckAfterBlocks: 77,
            maxFinalityLagBlocks: 900,
        });
    });
});
