// Shared test fixtures. Keys are the well-known anvil/forge dev keys (mnemonic "test test … junk");
// they hold nothing of value and are public.

import { POLYGON_TOKENS, POLYGON_USDC, POLYGON_USDT0 } from '../../src/core/constants.js';
import { definePins, type ChainPins, type ChainPinsInput } from '../../src/core/pins.js';
import type { Address, Hex, TokenAuthorization, TransferRequest } from '../../src/core/types.js';

export const KEYS = {
    deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // anvil #0
    user: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // anvil #1
    recipient: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // anvil #2
    other: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // anvil #3
    relay: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', // anvil #9
} as const satisfies Record<string, Hex>;

export const ADDR = {
    deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    user: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    other: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    relay: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
} as const satisfies Record<string, Address>;

/** Address of the first contract anvil account #0 deploys (nonce 0). */
export const TRANSFER_CONTRACT: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

export const USDC = POLYGON_USDC.address;
export const USDT0 = POLYGON_USDT0.address;

/** A fixed "now" (unix seconds) for deterministic deadline checks. */
export const NOW = 1_790_000_000;

export function polygonPinsInput(overrides: Partial<ChainPinsInput> = {}): ChainPinsInput {
    return {
        chainId: 137,
        transfer: TRANSFER_CONTRACT,
        relays: [ADDR.relay],
        tokens: POLYGON_TOKENS,
        deployBlock: 0,
        ...overrides,
    };
}

export function polygonPins(overrides: Partial<ChainPinsInput> = {}): ChainPins {
    return definePins(polygonPinsInput(overrides));
}

export function sampleRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
    return {
        token: USDC,
        from: ADDR.user,
        to: ADDR.recipient,
        amount: '10000000',
        fee: '50000',
        relay: ADDR.relay,
        nonce: '7',
        deadline: String(NOW + 600),
        ...overrides,
    };
}

export const ZERO32: Hex = `0x${'00'.repeat(32)}`;

/** The signed token authorization of mode "none". */
export const NONE_AUTH: TokenAuthorization = Object.freeze({ mode: 'none', v: 0, r: ZERO32, s: ZERO32 });

/** A well-formed permit authorization (not a valid signature of anything). */
export const SAMPLE_PERMIT_AUTH: TokenAuthorization = Object.freeze({ mode: 'permit', v: 27, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}` });

/** Deterministic pseudo-random bytes (mulberry32), so that failures are reproducible. */
export function prng(seed: number): (length: number) => Uint8Array {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return (length) => Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

export function hex(bytes: Uint8Array): Hex {
    return `0x${Buffer.from(bytes).toString('hex')}`;
}
