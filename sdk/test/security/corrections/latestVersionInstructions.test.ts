// The instructions a wallet follows before it signs again must name the payment's latest version. No chain is needed.
//
// With corrections a payment has several versions, and `expired` is safe only for the latest one. An instruction
// that sends the wallet to waitForTransferOutcome without saying which version to check reads as "the request that
// failed", which can be an older one. And a wallet that records a version as the latest only after the relay
// accepted it (202) loses it on a network error plus a restart, and then checks an older one.
//
// So every instruction that leads to waitForTransferOutcome before a new signature (the README table "What to do"
// and the RelayRequestFailedError message) names the payment's latest version, the message says so whether `final`
// is true or not, and the README says to record a version as the latest as soon as it is signed, before it is
// submitted.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { tokenAuthHash, transferDigest } from '../../../src/core/eip712.js';
import { RelayRequestFailedError } from '../../../src/relay/errors.js';
import type { RequestState } from '../../../src/relay/types.js';
import { ADDR, NONE_AUTH, NOW, TRANSFER_CONTRACT, USDC } from '../../helpers/fixtures.js';

const README = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');

function failedState(status: 'failed' | 'expired', broadcast: boolean): RequestState {
    const request = {
        token: USDC,
        from: ADDR.user,
        to: ADDR.recipient,
        amount: '10000000',
        fee: '50000',
        relay: ADDR.relay,
        nonce: '3',
        deadline: String(NOW + 600),
    } as RequestState['request'];
    return {
        id: transferDigest(137, TRANSFER_CONTRACT, request, NONE_AUTH),
        operation: 'transfer',
        status,
        request,
        authHash: tokenAuthHash(NONE_AUTH),
        transactions: broadcast ? [{ hash: `0x${'11'.repeat(32)}` as Hex, txNonce: 7, maxFeePerGas: '60000000000', status: 'mined' }] : [],
        txHash: null,
        blockNumber: null,
        error: status === 'failed' ? { code: 'simulation_failed', message: 'the call reverted on-chain' } : null,
    };
}

/** The rows of the README table under "### What to do": [what happened, what it means, what to do]. */
function whatToDoRows(): string[][] {
    const start = README.indexOf('### What to do');
    expect(start).toBeGreaterThan(0);
    const section = README.slice(start, README.indexOf('\n## ', start));
    return section
        .split('\n')
        .filter((line) => line.startsWith('| ') && !line.startsWith('| What happened'))
        .map((line) => line.split(' | ').map((cell) => cell.replace(/^\| |\s*\|$/g, '')));
}

describe("instructions that lead to the outcome check name the payment's latest version", () => {
    it("RelayRequestFailedError sends the wallet to waitForTransferOutcome (or confirmOnChain at the finalized block) with the payment's latest version, whether `final` is true or not", () => {
        const cases = [
            new RelayRequestFailedError(failedState('failed', true), { final: false }),
            new RelayRequestFailedError(failedState('failed', true), { final: true }),
            new RelayRequestFailedError(failedState('failed', false)),
            new RelayRequestFailedError(failedState('expired', false)),
        ];
        for (const error of cases) {
            expect(error.message, error.message).toMatch(/waitForTransferOutcome, or confirmOnChain with blockTag "finalized", with the payment's latest version/);
        }
        // Control: `final` still shows in the message only as "not final".
        expect(cases.map((error) => [error.final, /not final/.test(error.message)])).toEqual([
            [false, true],
            [true, false],
            [true, false],
            [true, false],
        ]);
    });

    it('every row of the README table "What to do" that runs waitForTransferOutcome names the latest version', () => {
        const rows = whatToDoRows();
        const leadingToTheCheck = rows.filter((cells) => cells[2]?.includes('waitForTransferOutcome'));
        // Control: the rows for a waitForRequest that threw timeout or RelayRequestFailedError are among them.
        expect(leadingToTheCheck.length).toBeGreaterThanOrEqual(6);
        expect(leadingToTheCheck.map((cells) => cells[0]).join('\n')).toMatch(/`waitForRequest` threw `timeout`[\s\S]*`waitForRequest` threw `RelayRequestFailedError`/);
        for (const cells of leadingToTheCheck) expect(cells[2], cells[0]).toMatch(/latest version/);
    });

    it('the README says to record a version as the latest as soon as it is signed, before it is submitted', () => {
        // Line breaks (and the `//` of code comments) read as spaces.
        const text = README.replace(/\n\s*(\/\/\s*)?/g, ' ');
        const says = (phrase: string) => text.includes(phrase);
        expect(says('Record a version as the latest as soon as it is signed, before it is submitted'), 'rule 2 "Track the latest version"').toBe(true);
        expect(says("Record `corrected` as the payment's latest version as soon as it is signed, before you submit it"), 'the correction example').toBe(true);
        // Control: the README does not say that `corrected` becomes the latest version only once it is submitted.
        expect(says('sign and submit; `corrected` is now the latest version'), 'the old wording').toBe(false);
    });
});
