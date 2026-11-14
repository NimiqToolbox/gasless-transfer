// Keccak-256 as used by Ethereum (original Keccak padding 0x01…0x80, not SHA3-256's 0x06).
// Written for clarity, not speed: the core hashes a handful of short inputs per transfer (EIP-55
// checksums, EIP-712 digests). Tests compare it with viem and ethers on thousands of inputs.
//
// State: 25 lanes of 64 bits, lane (x, y) at index x + 5y. Step names follow FIPS 202 §3.2.

const MASK_64 = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1088-bit rate for a 256-bit output
const ROUNDS = 24;

/** ρ rotation offsets, derived as in FIPS 202 Algorithm 2. */
const RHO_OFFSETS: readonly number[] = (() => {
    const offsets = new Array<number>(25).fill(0);
    let x = 1;
    let y = 0;
    for (let t = 0; t < 24; t++) {
        offsets[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
        [x, y] = [y, (2 * x + 3 * y) % 5];
    }
    return offsets;
})();

/** ι round constants, derived from the rc(t) LFSR of FIPS 202 Algorithms 5 and 6. */
const ROUND_CONSTANTS: readonly bigint[] = (() => {
    const constants: bigint[] = [];
    let lfsr = 1; // 8-bit register; bit 0 is the current output rc(t)
    for (let round = 0; round < ROUNDS; round++) {
        let rc = 0n;
        for (let j = 0; j <= 6; j++) {
            if (lfsr & 1) rc |= 1n << BigInt((1 << j) - 1);
            // Galois form of x^8 + x^6 + x^5 + x^4 + 1
            lfsr = lfsr & 0x80 ? ((lfsr << 1) ^ 0x71) & 0xff : (lfsr << 1) & 0xff;
        }
        constants.push(rc);
    }
    return constants;
})();

function rotl64(value: bigint, shift: number): bigint {
    if (shift === 0) return value;
    const s = BigInt(shift);
    return ((value << s) | (value >> (64n - s))) & MASK_64;
}

/** Checked array read (the tsconfig uses noUncheckedIndexedAccess). */
function at<T>(values: readonly T[], index: number): T {
    const value = values[index];
    if (value === undefined) throw new RangeError('keccak: index out of range');
    return value;
}

function lane(values: readonly bigint[], index: number): bigint {
    return at(values, index);
}

function keccakF1600(state: bigint[]): void {
    const c = new Array<bigint>(5).fill(0n);
    const b = new Array<bigint>(25).fill(0n);
    for (let round = 0; round < ROUNDS; round++) {
        // θ
        for (let x = 0; x < 5; x++) {
            c[x] = lane(state, x) ^ lane(state, x + 5) ^ lane(state, x + 10) ^ lane(state, x + 15) ^ lane(state, x + 20);
        }
        for (let x = 0; x < 5; x++) {
            const d = lane(c, (x + 4) % 5) ^ rotl64(lane(c, (x + 1) % 5), 1);
            for (let y = 0; y < 5; y++) state[x + 5 * y] = lane(state, x + 5 * y) ^ d;
        }
        // ρ and π: B[y, 2x + 3y] = rot(A[x, y], r[x, y])
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(lane(state, x + 5 * y), at(RHO_OFFSETS, x + 5 * y));
            }
        }
        // χ
        for (let y = 0; y < 5; y++) {
            for (let x = 0; x < 5; x++) {
                const notNext = ~lane(b, ((x + 1) % 5) + 5 * y) & MASK_64;
                state[x + 5 * y] = lane(b, x + 5 * y) ^ (notNext & lane(b, ((x + 2) % 5) + 5 * y));
            }
        }
        // ι
        state[0] = lane(state, 0) ^ lane(ROUND_CONSTANTS, round);
    }
}

export function keccak256(data: Uint8Array): Uint8Array {
    // Pad with 0x01 … 0x80; the padding always adds at least one byte.
    const padded = new Uint8Array((Math.floor(data.length / RATE_BYTES) + 1) * RATE_BYTES);
    padded.set(data);
    padded[data.length] = (padded[data.length] ?? 0) ^ 0x01;
    padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) ^ 0x80;

    const state = new Array<bigint>(25).fill(0n);
    for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
        for (let i = 0; i < RATE_BYTES / 8; i++) {
            let word = 0n;
            for (let k = 7; k >= 0; k--) word = (word << 8n) | BigInt(padded[offset + 8 * i + k] ?? 0);
            state[i] = lane(state, i) ^ word; // lanes are little-endian
        }
        keccakF1600(state);
    }

    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
        let word = lane(state, i);
        for (let k = 0; k < 8; k++) {
            out[8 * i + k] = Number(word & 0xffn);
            word >>= 8n;
        }
    }
    return out;
}
