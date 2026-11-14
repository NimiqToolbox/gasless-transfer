// Calldata construction. Every transaction the relay key ever signs must be either
//   (a) GaslessTransfer.relayTransfer(r, signature, auth) to the configured contract, value 0, where
//       (r, signature, auth) is exactly an accepted, signature-verified submission, or
//   (b) a 0-value, empty-data, 21000-gas self-transfer (cancel).
// No client-controlled target, calldata, value or gas may reach a transaction: the relay key pays for whatever it
// signs, so a field a client could set would let that client spend the relay's POL or have the key call another
// contract. These tests drive the relay through acceptance, broadcast, speed-up, cancel, expiry, reorg and restart
// and then decode every raw transaction that left the process.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { gaslessTransferAbi, AUTH_MODE_ID } from '@nimiq/gasless-sdk/core';
import type { SubmitTransferBody } from '@nimiq/gasless-sdk/relay';
import {
    buildTransfer,
    CONTRACT,
    createHarness,
    fundedSender,
    restartHarness,
    TEST_TX_SETTINGS,
    USDC,
    USDT0,
    type Harness,
} from '../../helpers/harness.js';
import { OTHER_KEY, RELAY_ADDRESS, USER3_KEY, USER_KEY } from '../../helpers/keys.js';
import { privateKeyToAccount } from 'viem/accounts';

let h: Harness;

beforeEach(async () => {
    h = await createHarness();
    for (const key of [OTHER_KEY, USER3_KEY]) {
        const a = privateKeyToAccount(key).address;
        h.chain.setBalance(USDC, a, 100_000_000n);
        h.chain.setBalance(USDT0, a, 100_000_000n);
    }
    for (const key of [USER_KEY, OTHER_KEY, USER3_KEY]) {
        const a = privateKeyToAccount(key).address;
        h.chain.setAllowance(USDC, a, CONTRACT, 10n ** 15n);
        h.chain.setAllowance(USDT0, a, CONTRACT, 10n ** 15n);
    }
});

afterEach(async () => {
    await h.close();
});

const post = (payload: unknown) => h.relay.app.inject({ method: 'POST', url: '/v1/transfer', payload: payload as object });

interface Accepted {
    readonly id: Hex;
    readonly body: SubmitTransferBody;
}

async function checkEveryBroadcast(accepted: readonly Accepted[]): Promise<{ calls: number; cancels: number }> {
    let calls = 0;
    let cancels = 0;
    for (const raw of h.chain.broadcasts) {
        const tx = parseTransaction(raw);
        expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(RELAY_ADDRESS);
        expect(tx.type).toBe('eip1559');
        expect(tx.chainId).toBe(137);
        expect(tx.value ?? 0n).toBe(0n);
        expect(tx.gas).toBeDefined();
        expect(tx.gas!).toBeLessThanOrEqual(TEST_TX_SETTINGS.maxGasLimit);
        expect(tx.maxFeePerGas!).toBeLessThanOrEqual(TEST_TX_SETTINGS.maxFeePerGas);
        expect(tx.accessList ?? []).toEqual([]);
        if (tx.to?.toLowerCase() === RELAY_ADDRESS.toLowerCase()) {
            // (b) cancel
            expect(tx.data ?? '0x').toBe('0x');
            expect(tx.gas).toBe(21_000n);
            cancels += 1;
            continue;
        }
        // (a) relayTransfer to the configured contract with exactly an accepted submission.
        expect(tx.to?.toLowerCase()).toBe(CONTRACT.toLowerCase());
        const { functionName, args } = decodeFunctionData({ abi: gaslessTransferAbi, data: tx.data! });
        expect(functionName).toBe('relayTransfer');
        const [r, signature, auth] = args as unknown as [
            { token: string; from: string; to: string; amount: bigint; fee: bigint; relay: string; deadline: bigint },
            Hex,
            { mode: number; v: number; r: Hex; s: Hex },
        ];
        // GaslessTransfer calldata carries no intent nonce (the contract signs over nonces(from)): the signature
        // identifies the submission.
        const match = accepted.find((a) => a.body.signature.toLowerCase() === signature.toLowerCase());
        expect(match, `broadcast for an unknown request signature ${signature}`).toBeDefined();
        const b = match!.body;
        const { nonce: _nonce, ...signedFields } = b.request;
        expect({
            token: r.token,
            from: r.from,
            to: r.to,
            amount: r.amount.toString(),
            fee: r.fee.toString(),
            relay: r.relay,
            deadline: r.deadline.toString(),
        }).toEqual(signedFields);
        expect(signature.toLowerCase()).toBe(b.signature.toLowerCase());
        const a = b.authorization;
        expect(auth.mode).toBe(AUTH_MODE_ID[a.mode]);
        if (a.mode === 'none') {
            expect({ v: auth.v, r: auth.r, s: auth.s }).toEqual({ v: 0, r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}` });
        } else {
            expect({ v: auth.v, r: auth.r.toLowerCase(), s: auth.s.toLowerCase() }).toEqual({ v: a.v, r: a.r!.toLowerCase(), s: a.s!.toLowerCase() });
        }
        calls += 1;
    }
    return { calls, cancels };
}

describe('calldata construction', () => {
    it('client-controlled call fields are rejected at every level and nothing is stored', async () => {
        const t = await buildTransfer(h, { mode: 'none' });
        const smuggled: Record<string, unknown> = { to: CONTRACT, data: '0xdeadbeef', gas: '5000000', gasLimit: '1', value: '1', target: CONTRACT, calldata: '0x', maxFeePerGas: '1', nonce: 0, chainId: 1 };
        for (const [key, value] of Object.entries(smuggled)) {
            for (const body of [
                { ...t.body, [key]: value },
                { ...t.body, request: { ...t.body.request, [key]: value } },
                { ...t.body, authorization: { ...t.body.authorization, [key]: value } },
            ]) {
                const res = await post(body);
                // request.to / request.nonce exist legitimately: overriding them breaks the signature instead.
                expect(res.statusCode, `${key}`).toBeGreaterThanOrEqual(400);
            }
        }
        expect(h.store.countByStatus('queued')).toBe(0);
        // The untouched body is accepted.
        expect((await post(t.body)).statusCode).toBe(202);
    });

    it('every transaction signed through acceptance, broadcast, speed-up, cancel, expiry, reorg and restart is relayTransfer(accepted) or a self-cancel', async () => {
        const accepted: Accepted[] = [];
        // Six senders (one pending request per sender).
        const [fourth, fifth, sixth] = [1, 2, 3].map((i) => fundedSender(h.chain, i).key);
        for (const key of [fourth!, sixth!]) h.chain.setAllowance(USDC, privateKeyToAccount(key).address, CONTRACT, 10n ** 15n);
        const plan: Array<{ key: Hex; token: typeof USDC; mode: 'none' | 'permit' | 'metaTxApprove'; deadline?: number }> = [
            { key: USER3_KEY, token: USDT0, mode: 'none', deadline: 70 }, // broadcast first, expires in flight
            { key: USER_KEY, token: USDC, mode: 'permit' },
            { key: OTHER_KEY, token: USDT0, mode: 'metaTxApprove' },
            { key: fourth!, token: USDC, mode: 'none' },
            { key: fifth!, token: USDT0, mode: 'permit' },
            { key: sixth!, token: USDC, mode: 'none' },
        ];
        for (const p of plan) {
            const t = await buildTransfer(h, {
                key: p.key,
                token: p.token,
                mode: p.mode,
                ...(p.deadline !== undefined ? { deadline: BigInt(h.clock.seconds() + p.deadline) } : {}),
            });
            const res = await post(t.body);
            expect(res.statusCode, JSON.stringify(res.json())).toBe(202);
            accepted.push({ id: t.id, body: t.body });
        }
        await h.relay.txManager.recover();
        // Nothing is included for 12 blocks: speed-ups, then the short-deadline request is cancelled.
        h.chain.includeFilter = () => false;
        for (let i = 0; i < 14; i++) {
            await h.relay.txManager.tick();
            h.chain.mine({ timestampDelta: 5 });
        }
        h.chain.includeFilter = () => true;
        h.chain.mine();
        await h.relay.txManager.tick();
        // Reorg the first mined call, drop the mempool, restart: re-broadcasts must be byte-identical or re-encoded.
        const firstMined = [...h.chain.mined.values()].find((tx) => tx.to?.toLowerCase() === CONTRACT.toLowerCase());
        if (firstMined) h.chain.reorg(firstMined.hash);
        h.chain.dropMempool();
        h = await restartHarness(h);
        await h.relay.txManager.recover();
        for (let i = 0; i < 4; i++) {
            await h.relay.txManager.tick();
            h.chain.mine();
        }
        const { calls, cancels } = await checkEveryBroadcast(accepted);
        expect(calls).toBeGreaterThanOrEqual(accepted.length);
        expect(cancels).toBeGreaterThanOrEqual(1);
        const statuses = accepted.map((a) => h.store.getRequest(a.id)?.status);
        expect(statuses).toContain('expired');
    });

    it('tampering with any signed field after signing is never relayed', async () => {
        const base = await buildTransfer(h, { mode: 'none' });
        const tampered: Array<Partial<SubmitTransferBody['request']>> = [
            { amount: '1000001' },
            { fee: '10001' },
            { to: privateKeyToAccount(OTHER_KEY).address },
            { deadline: String(Number(base.body.request.deadline) + 1) },
            { nonce: String(BigInt(base.body.request.nonce) + 1n) },
            { token: USDT0 },
            { from: privateKeyToAccount(OTHER_KEY).address },
        ];
        for (const change of tampered) {
            const res = await post({ ...base.body, request: { ...base.body.request, ...change } });
            expect((res.json() as { error: { code: string } }).error.code, JSON.stringify(change)).toBe('invalid_signature');
        }
        expect(h.store.countByStatus('queued')).toBe(0);
    });
});
