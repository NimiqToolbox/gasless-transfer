// Synthetic implementation pins for fake-chain tests. Never deploy or use as production configuration.
import { keccak256, type Address, type Hex } from 'viem';
import { parseTokenImplementationPins } from '../../src/ops/tokenImplementationMonitor.js';
import type { FakeChain } from './fakeChain.js';
import { testDeployment } from './harness.js';

export const TEST_IMPLEMENTATION = '0x1111111111111111111111111111111111111111' as Address;
export const TEST_IMPLEMENTATION_CODE = '0x60016000' as Hex;
export const TEST_IMPLEMENTATION_SLOT = `0x${'01'.repeat(32)}` as Hex;
export const implementationWord = `0x${'0'.repeat(24)}${TEST_IMPLEMENTATION.slice(2)}` as Hex;
export function testTokenPinsJson() {
    return { chainId: 137, reviewedBlock: '990', tokens: testDeployment().tokens.map((token) => ({
        address: token.address, proxyCodeHash: keccak256('0x6000'), implementationSlot: TEST_IMPLEMENTATION_SLOT,
        implementationAddress: TEST_IMPLEMENTATION, implementationCodeHash: keccak256(TEST_IMPLEMENTATION_CODE),
    })) };
}
export function testTokenPins() { return parseTokenImplementationPins(testTokenPinsJson(), testDeployment()); }
export function installTokenPins(chain: FakeChain): void {
    chain.codes.set(TEST_IMPLEMENTATION.toLowerCase(), TEST_IMPLEMENTATION_CODE);
    for (const token of testDeployment().tokens) {
        chain.codes.set(token.address.toLowerCase(), '0x6000');
        chain.storage.set(`${token.address.toLowerCase()}:${TEST_IMPLEMENTATION_SLOT}`, implementationWord);
    }
}
