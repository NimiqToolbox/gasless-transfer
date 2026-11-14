// Purged secrets are gone from every database file (relay/docs/storage.md, docs/STEP-1-GAS-ABSTRACTION.md §5), also
// under a realistic workload. purgedSecretsDatabaseFiles.test.ts follows single requests through the relay; this
// test runs a mix through the real store: hundreds of requests with random secrets and raw transactions of real
// size, rows that grow while they still hold their secrets (submitted, speed-ups, mined or reverted with error
// messages and hashes), page splits and rebalancing among them, retention deletes, and purges in random order.
// Afterwards every purged value is searched in relay.sqlite, -wal and -shm, also after a clean close.
//
// A copy of the database volume (a backup, a snapshot) must not hand out the signatures and raw transactions of
// requests that have ended: if this test fails, a purged secret survived in a database file. It takes a few seconds.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { SqliteStore } from '../../../src/store/sqliteStore.js';
import type { FinalFailure, NewAttempt, NewRequest } from '../../../src/store/types.js';
import { CONTRACT, USDC, USDT0 } from '../../helpers/harness.js';

let dir: string;
let path: string;
let store: SqliteStore;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-residue-'));
    path = join(dir, 'relay.sqlite');
    store = SqliteStore.open(path, { lockTimeoutMs: 50 });
});

afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** Deterministic pseudo-random choices (xorshift), so a failing run can be repeated. */
function rng(seed: number): () => number {
    let x = seed >>> 0 || 1;
    return () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) / 0x1_0000_0000;
    };
}

interface Live {
    readonly id: Hex;
    readonly secrets: string[];
    stage: 'queued' | 'submitted' | 'resolved';
    txNonce?: number;
    attempts: number;
    lastHash?: Hex;
}

function databaseText(): string {
    return [path, `${path}-wal`, `${path}-shm`]
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p).toString('latin1'))
        .join('\n');
}

const REVERTED: FinalFailure = {
    status: 'failed',
    error: { code: 'simulation_failed', message: 'The transaction reverted on-chain (InsufficientAllowance(0, 1010000)); the sender moved the funds' },
};
const EXPIRED: FinalFailure = { status: 'expired', error: { code: 'deadline_out_of_range', message: 'The deadline passed before the request could be submitted' } };

describe('purged secrets in the database files under a realistic workload', () => {
    it('no purged intent signature, token authorization or raw transaction survives in relay.sqlite, -wal or -shm', { timeout: 60_000 }, () => {
        // SECRET_RESIDUE_SEED selects another sequence of operations (the secrets themselves are always random).
        const random = rng(Number(process.env.SECRET_RESIDUE_SEED ?? 0x6a3));
        const purged: string[] = [];
        const live: Live[] = [];
        let nextNonce = 0;
        let now = 1_000;
        let counter = 0;
        store.setNextNonce(0);

        const newRequest = (): Live => {
            counter += 1;
            const signature = hex(65);
            const r = hex(32);
            const s = hex(32);
            const token = random() < 0.5 ? USDC : USDT0;
            const signer = `0x${hex(20)}` as Address;
            const id = `0x${hex(32)}` as Hex;
            const req: NewRequest = {
                id,
                operation: 'transfer',
                contract: CONTRACT,
                signer,
                nonce: String(counter),
                fingerprint: `0x${hex(32)}` as Hex,
                request: {
                    token,
                    from: signer,
                    to: `0x${hex(20)}`,
                    amount: String(1_000_000 + counter),
                    fee: '10000',
                    relay: `0x${'f3'.repeat(20)}`,
                    nonce: String(counter),
                    deadline: String(1_790_000_000 + counter),
                },
                authHash: `0x${hex(32)}` as Hex,
                signature: `0x${signature}` as Hex,
                authorization: { mode: token === USDT0 ? 'metaTxApprove' : 'permit', v: 27, r: `0x${r}` as Hex, s: `0x${s}` as Hex },
                fee: 10_000n,
                deadline: BigInt(1_790_000_000 + counter),
                priority: 0,
                reservation: { token, spender: CONTRACT, debit: 1_010_000n },
                createdAtMs: now,
            };
            expect(store.insertRequest(req, {}).kind).toBe('inserted');
            const entry: Live = { id, secrets: [signature, r, s], stage: 'queued', attempts: 0 };
            live.push(entry);
            return entry;
        };

        const newAttempt = (entry: Live, kind: 'call' | 'cancel'): NewAttempt => {
            // A signed relayTransfer is about 650 bytes (the calldata embeds the intent and token signatures).
            const raw = kind === 'call' ? `02f9028a${hex(640)}` : `02f870${hex(110)}`;
            entry.secrets.push(raw.slice(40, 168));
            entry.attempts += 1;
            const hash = `0x${hex(32)}` as Hex;
            entry.lastHash = hash;
            return {
                hash,
                raw: `0x${raw}` as Hex,
                kind,
                maxFeePerGas: 90_000_000_000n + BigInt(entry.attempts),
                maxPriorityFeePerGas: 30_000_000_000n,
                gasLimit: kind === 'call' ? 195_000n : 21_000n,
                sentBlock: BigInt(1000 + entry.attempts),
            };
        };

        const purge = (entry: Live, how: 'settle' | 'finalize'): void => {
            if (how === 'finalize') store.finalize(entry.id, EXPIRED, undefined, now);
            else store.settle(entry.id, now);
            purged.push(...entry.secrets);
            live.splice(live.indexOf(entry), 1);
        };

        for (let step = 0; step < 3000; step++) {
            now += 1_000;
            const p = random();
            if (live.length < 40 || p < 0.25) {
                newRequest();
                continue;
            }
            const entry = live[Math.floor(random() * live.length)]!;
            if (entry.stage === 'queued') {
                if (random() < 0.1) {
                    purge(entry, 'finalize'); // failed or expired before any broadcast
                } else {
                    entry.txNonce = nextNonce;
                    store.recordFirstAttempt(entry.id, nextNonce, newAttempt(entry, 'call'), now);
                    nextNonce += 1;
                    entry.stage = 'submitted';
                }
            } else if (entry.stage === 'submitted') {
                const q = random();
                if (q < 0.3 && entry.attempts < 4) {
                    store.recordReplacement(entry.id, newAttempt(entry, q < 0.1 ? 'cancel' : 'call'), q < 0.1 ? EXPIRED : undefined, now);
                } else if (q < 0.7) {
                    store.markMined(entry.id, { hash: entry.lastHash!, blockNumber: BigInt(2000 + step), gasUsed: 120_000n, effectiveGasPrice: 60_000_000_000n }, now);
                    entry.stage = 'resolved';
                } else {
                    store.resolveFailed(
                        entry.id,
                        REVERTED,
                        { kind: 'receipt', mined: { hash: entry.lastHash!, blockNumber: BigInt(2000 + step), gasUsed: 43_000n, effectiveGasPrice: 60_000_000_000n }, attemptKind: 'call', callReverted: true },
                        now,
                    );
                    entry.stage = 'resolved';
                }
            } else if (random() < 0.5) {
                purge(entry, 'settle');
            } else {
                store.updateMinedBlock(entry.id, BigInt(3000 + step), now); // a reorg moved the inclusion
            }
            if (step % 500 === 499) store.pruneSettled(now - 200_000);
            if (step === 1500) {
                // Sanity check of the search: the secrets of pending requests are in the files.
                const text = databaseText();
                expect(live.every((entry) => entry.secrets.every((secret) => text.includes(secret)))).toBe(true);
            }
        }
        const fileBytes = readFileSync(path).length;
        expect(fileBytes).toBeGreaterThan(200_000); // at least 50 pages: splits and rebalancing happened
        // Everything ends: queued requests expire, in-flight ones are resolved, then everything settles.
        for (const entry of [...live]) {
            if (entry.stage === 'queued') {
                purge(entry, 'finalize');
                continue;
            }
            if (entry.stage === 'submitted') {
                store.markMined(entry.id, { hash: entry.lastHash!, blockNumber: 9_999n, gasUsed: 120_000n, effectiveGasPrice: 1n }, now);
            }
            purge(entry, 'settle');
        }
        expect(live).toEqual([]);
        expect(purged.length).toBeGreaterThan(1000);

        const leftover = (text: string) => purged.filter((secret) => text.includes(secret)).length;
        const open = leftover(databaseText());
        store.close();
        const closed = leftover(databaseText());
        store = SqliteStore.open(path, { lockTimeoutMs: 50 });
        expect({ purged: purged.length, leftWhileOpen: open, leftAfterClose: closed }).toEqual({ purged: purged.length, leftWhileOpen: 0, leftAfterClose: 0 });
    });
});
