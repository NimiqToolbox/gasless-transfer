import { describe, expect, it } from 'vitest';
import { ZERO_ADDRESS } from '../../src/core/address.js';
import { LEGACY_NIMIQ_CONTRACTS_POLYGON, POLYGON_TOKENS, POLYGON_USDC, POLYGON_USDT0 } from '../../src/core/constants.js';
import { isDeniedRecipient, recipientDenylist } from '../../src/core/denylist.js';
import { hashDomain } from '../../src/core/eip712.js';
import { InvalidPinsError } from '../../src/core/errors.js';
import { chainIdSalt, definePins, findPinnedToken, pinsFromDeployment, type TokenPinInput } from '../../src/core/pins.js';
import { transferDomain } from '../../src/core/typedData.js';
import { ADDR, polygonPins, polygonPinsInput, TRANSFER_CONTRACT, USDC, USDT0 } from '../helpers/fixtures.js';

function pinsError(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        if (error instanceof InvalidPinsError) return error.field;
        throw error;
    }
    throw new Error('expected InvalidPinsError');
}

/** A generic 6-decimal test token on a non-Polygon chain (no mainnet cross-check). */
function testToken(chainId: number, address: string, overrides: Partial<TokenPinInput> = {}): TokenPinInput {
    return {
        symbol: 'TST',
        address,
        decimals: 6,
        authModes: ['permit', 'none'],
        domain: { name: 'Test', version: '1', chainId, verifyingContract: address as `0x${string}` },
        ...overrides,
    };
}

const TOKEN_A = '0x1000000000000000000000000000000000000001';
const { domainSeparator: _usdcSeparator, ...USDC_WITHOUT_SEPARATOR } = POLYGON_USDC;

describe('definePins', () => {
    it('normalizes and derives domains and separators', () => {
        const pins = polygonPins({ transfer: TRANSFER_CONTRACT.toLowerCase(), relays: [ADDR.relay.toLowerCase()] });
        expect(pins.chainId).toBe(137);
        expect(pins.transfer.address).toBe(TRANSFER_CONTRACT);
        expect(pins.transfer.domain).toEqual(transferDomain(137, TRANSFER_CONTRACT));
        expect(pins.transfer.domain.version).toBe('3');
        expect(pins.relays).toEqual([ADDR.relay]);
        expect(pins.deployBlock).toBe(0);
        expect(pins.tokens.map((t) => t.address)).toEqual([USDC, USDT0]);
        expect(pins.tokens[0]?.domainSeparator).toBe(POLYGON_USDC.domainSeparator);
        expect(pins.tokens[1]?.domainSeparator).toBe(POLYGON_USDT0.domainSeparator);
        expect(findPinnedToken(pins, USDT0.toLowerCase())?.symbol).toBe('USDT0');
        expect(findPinnedToken(pins, ADDR.user)).toBeUndefined();
    });

    it('is deep-frozen and detached from its input', () => {
        const relays: string[] = [ADDR.relay];
        const pins = polygonPins({ relays });
        relays.push(ADDR.other);
        expect(pins.relays).toEqual([ADDR.relay]);
        for (const value of [pins, pins.transfer, pins.transfer.domain, pins.relays, pins.tokens, pins.tokens[0], pins.tokens[0]?.domain, pins.tokens[0]?.authModes, pins.extraDeniedRecipients]) {
            expect(Object.isFrozen(value)).toBe(true);
        }
        expect(() => {
            (pins.tokens[0] as { symbol: string }).symbol = 'USDC.e';
        }).toThrow(TypeError);
        expect(() => (pins.relays as string[]).push(ADDR.other)).toThrow(TypeError);
    });

    it('accepts generic tokens on other chains, with a chainId or a salt domain', () => {
        const pins = definePins({
            chainId: 31337,
            transfer: TRANSFER_CONTRACT,
            relays: [ADDR.relay],
            tokens: [
                testToken(31337, TOKEN_A),
                testToken(31337, '0x1000000000000000000000000000000000000002', {
                    symbol: 'TST2',
                    authModes: ['metaTxApprove'],
                    domain: { name: 'T2', version: '1', verifyingContract: '0x1000000000000000000000000000000000000002', salt: chainIdSalt(31337) },
                }),
            ],
        });
        expect(pins.tokens[1]?.domain.salt).toBe(`0x${'0'.repeat(60)}7a69`);
        expect(pins.deployBlock).toBeNull();
    });

    it.each([
        ['chainId', { chainId: 0 }],
        ['chainId', { chainId: 1.5 }],
        ['transfer', { transfer: '0x1234' }],
        ['transfer', { transfer: ZERO_ADDRESS }],
        ['transfer', { transfer: '0x5FbDB2315678afecb367f032d93F642f64180aA3' }], // wrong checksum
        ['transfer', { transfer: LEGACY_NIMIQ_CONTRACTS_POLYGON[0] }],
        ['relays', { relays: [] }],
        ['relays[0]', { relays: [ZERO_ADDRESS] }],
        ['relays[1]', { relays: [ADDR.relay, ADDR.relay.toLowerCase()] }],
        ['relays[0]', { relays: [TRANSFER_CONTRACT] }],
        ['relays[0]', { relays: [USDC] }],
        ['tokens', { tokens: [] }],
        ['tokens[1].address', { tokens: [POLYGON_USDC, POLYGON_USDC] }],
        ['tokens[0].address', { tokens: [{ ...USDC_WITHOUT_SEPARATOR, address: TRANSFER_CONTRACT, domain: { ...POLYGON_USDC.domain, verifyingContract: TRANSFER_CONTRACT } }] }],
        ['deployBlock', { deployBlock: -1 }],
        ['extraDeniedRecipients[0]', { extraDeniedRecipients: ['0x12'] }],
    ])('rejects a bad %s', (field, overrides) => {
        expect(pinsError(() => definePins(polygonPinsInput(overrides as never)))).toBe(field);
    });

    it.each([
        ['tokens[0].symbol', { symbol: '' }],
        ['tokens[0].symbol', { symbol: 'US DC' }],
        ['tokens[0].decimals', { decimals: 18 }],
        ['tokens[0].authModes', { authModes: [] }],
        ['tokens[0].authModes[0]', { authModes: ['approve'] }],
        ['tokens[0].authModes[1]', { authModes: ['permit', 'permit'] }],
        ['tokens[0].domain', { domain: 'USD Coin' }],
        ['tokens[0].domain.name', { domain: { version: '1', chainId: 31337, verifyingContract: TOKEN_A } }],
        ['tokens[0].domain.chainId', { domain: { name: 'T', version: '1', chainId: 1, verifyingContract: TOKEN_A } }],
        ['tokens[0].domain.verifyingContract', { domain: { name: 'T', version: '1', chainId: 31337, verifyingContract: ADDR.user } }],
        ['tokens[0].domain.salt', { domain: { name: 'T', version: '1', verifyingContract: TOKEN_A, salt: chainIdSalt(137) } }],
        ['tokens[0].domain', { domain: { name: 'T', version: '1', verifyingContract: TOKEN_A } }],
        ['tokens[0].domain.extensions', { domain: { name: 'T', version: '1', chainId: 31337, verifyingContract: TOKEN_A, extensions: [] } }],
        ['tokens[0].domainSeparator', { domainSeparator: POLYGON_USDC.domainSeparator }],
    ])('rejects a bad token field %s', (field, overrides) => {
        const input = { chainId: 31337, transfer: TRANSFER_CONTRACT, relays: [ADDR.relay], tokens: [testToken(31337, TOKEN_A, overrides as never)] };
        expect(pinsError(() => definePins(input))).toBe(field);
    });

    it('accepts a matching explicit domainSeparator', () => {
        const token = testToken(31337, TOKEN_A);
        const input = { chainId: 31337, transfer: TRANSFER_CONTRACT, relays: [ADDR.relay], tokens: [{ ...token, domainSeparator: hashDomain(token.domain).toUpperCase().replace('0X', '0x') }] };
        expect(definePins(input).tokens[0]?.domainSeparator).toBe(hashDomain(token.domain));
    });

    it('refuses more than 32 tokens, the most a relay may list in /v1/info', () => {
        const tokens = (count: number) =>
            Array.from({ length: count }, (_unused, i) => testToken(31337, `0x${(i + 1).toString(16).padStart(40, '0')}`, { symbol: `T${i}` }));
        const input = (count: number) => ({ chainId: 31337, transfer: TRANSFER_CONTRACT, relays: [ADDR.relay], tokens: tokens(count) });
        expect(definePins(input(32)).tokens).toHaveLength(32);
        expect(pinsError(() => definePins(input(33)))).toBe('tokens');
        expect(() => definePins(input(33))).toThrow('tokens: expected at most 32 tokens');
    });

    it('on Polygon (137) requires the frozen, mainnet-verified token definitions', () => {
        expect(pinsError(() => polygonPins({ tokens: [testToken(137, TOKEN_A)] }))).toBe('tokens[0].address');
        expect(pinsError(() => polygonPins({ tokens: [{ ...POLYGON_USDC, symbol: 'USDC.e' }] }))).toBe('tokens[0].symbol');
        expect(pinsError(() => polygonPins({ tokens: [{ ...POLYGON_USDC, authModes: ['permit'] }] }))).toBe('tokens[0].authModes');
        expect(pinsError(() => polygonPins({ tokens: [{ ...POLYGON_USDT0, authModes: ['permit', 'none', 'none'] as never }] }))).toBe('tokens[0].authModes[2]');
        // USDT0 with the standard (chainId) domain instead of its salt domain (cf. T17).
        const standardDomain = { name: 'USDT0', version: '1', chainId: 137, verifyingContract: USDT0 } as const;
        const { domainSeparator: _unused, ...usdt0WithoutSeparator } = POLYGON_USDT0;
        expect(pinsError(() => polygonPins({ tokens: [{ ...usdt0WithoutSeparator, domain: standardDomain }] }))).toBe('tokens[0].domain');
        // A renamed USDT0 (admin changeName) is not the pinned token.
        expect(pinsError(() => polygonPins({ tokens: [{ ...usdt0WithoutSeparator, domain: { ...POLYGON_USDT0.domain, name: 'Tether USD' } }] }))).toBe('tokens[0].domain');
        // Order of authModes does not matter; a subset of the tokens is allowed.
        expect(polygonPins({ tokens: [{ ...POLYGON_USDT0, authModes: ['none', 'metaTxApprove', 'permit'] }] }).tokens).toHaveLength(1);
    });
});

describe('pinsFromDeployment', () => {
    // The format contracts/script/DeploymentWriter.sol writes (version "3"), with the alternative spellings the parser
    // accepts.
    const deployment = {
        chainId: 137,
        version: '3',
        gaslessTransfer: TRANSFER_CONTRACT.toLowerCase(),
        initialOwner: ADDR.deployer,
        deployBlock: 94421000,
        tokens: [
            { symbol: 'USDC', address: USDC, decimals: 6, authModes: ['PERMIT', 'NONE'], domain: { ...POLYGON_USDC.domain, salt: null } },
            { symbol: 'USDT0', address: USDT0, decimals: '6', authModes: [1, 2, 0], domain: { ...POLYGON_USDT0.domain, chainId: null } },
        ],
    };

    it('loads the deployment file format', () => {
        const pins = pinsFromDeployment(JSON.parse(JSON.stringify(deployment)), { relays: [ADDR.relay] });
        expect(pins).toEqual(polygonPins({ deployBlock: 94421000 }));
        expect(pins.transfer.domain.version).toBe('3');
        expect(Object.isFrozen(pins.tokens[1]?.domain)).toBe(true);
    });

    it('accepts integers as numbers or decimal strings, SDK auth mode names and an expected domainSeparator', () => {
        const token = { ...deployment.tokens[0], authModes: ['permit', 'none'], domainSeparator: POLYGON_USDC.domainSeparator };
        const pins = pinsFromDeployment(
            { ...deployment, chainId: '137', deployBlock: '94421000', tokens: [token] },
            { relays: [ADDR.relay], extraDeniedRecipients: [ADDR.other] },
        );
        expect(pins.tokens[0]?.domainSeparator).toBe(POLYGON_USDC.domainSeparator);
        expect(pins.deployBlock).toBe(94421000);
        expect(pins.extraDeniedRecipients).toEqual([ADDR.other]);
        const { initialOwner: _owner, ...withoutOwner } = deployment;
        expect(pinsFromDeployment(withoutOwner, { relays: [ADDR.relay] }).transfer.address).toBe(TRANSFER_CONTRACT);
    });

    it('fails closed on a record of any other version or without one', () => {
        for (const version of ['1', '2', 2, 3, '3.0', ' 3', '4', null]) {
            expect(pinsError(() => pinsFromDeployment({ ...deployment, version }, { relays: [ADDR.relay] })), String(version)).toBe('version');
        }
        const { version: _version, ...withoutVersion } = deployment;
        expect(pinsError(() => pinsFromDeployment(withoutVersion, { relays: [ADDR.relay] }))).toBe('version');
        expect(() => pinsFromDeployment({ ...deployment, version: '4' }, { relays: [ADDR.relay] })).toThrow(/expected "3", the GaslessTransfer domain version this SDK signs/);
    });

    // Wallets and the relay must agree on a record: the relay's parseDeployment (relay/test/unit/config.test.ts) refuses
    // the same values. A token domainSeparator that is present is checked whatever its type.
    it('refuses a malformed token domainSeparator or initialOwner, as the relay does', () => {
        const separators = [null, 0, 12345, true, {}, [POLYGON_USDC.domainSeparator], '', POLYGON_USDC.domainSeparator.replace('0x', '0X')];
        for (const domainSeparator of separators) {
            const file = { ...deployment, tokens: [{ ...deployment.tokens[0], domainSeparator }, deployment.tokens[1]] };
            expect(pinsError(() => pinsFromDeployment(file, { relays: [ADDR.relay] })), JSON.stringify(domainSeparator)).toBe('tokens[0].domainSeparator');
        }
        for (const initialOwner of [null, 7, '', 'not-an-address', {}, [ADDR.deployer], '0x5fbdb2315678afecb367f032d93F642f64180aa3']) {
            expect(pinsError(() => pinsFromDeployment({ ...deployment, initialOwner }, { relays: [ADDR.relay] })), JSON.stringify(initialOwner)).toBe('initialOwner');
        }
        // Accepted by both: an owner in lowercase, a separator in upper-case hex digits.
        const upper = `0x${POLYGON_USDC.domainSeparator.slice(2).toUpperCase()}`;
        const file = { ...deployment, initialOwner: ADDR.deployer.toLowerCase(), tokens: [{ ...deployment.tokens[0], domainSeparator: upper }] };
        expect(pinsFromDeployment(file, { relays: [ADDR.relay] }).tokens[0]?.domainSeparator).toBe(POLYGON_USDC.domainSeparator);
    });

    it('takes exact keys in the record and its token entries', () => {
        expect(pinsError(() => pinsFromDeployment({ ...deployment, deployer: ADDR.deployer }, { relays: [ADDR.relay] }))).toBe('deployer');
        expect(pinsError(() => pinsFromDeployment({ ...deployment, maxFeePerGas: '1' }, { relays: [ADDR.relay] }))).toBe('maxFeePerGas');
        for (const maxFee of ['5000000', 0, null, undefined]) {
            expect(pinsError(() => pinsFromDeployment({ ...deployment, maxFee }, { relays: [ADDR.relay] })), String(maxFee)).toBe('maxFee');
        }
        const extra = { ...deployment, tokens: [deployment.tokens[0], { ...deployment.tokens[1], permit: true }] };
        expect(pinsError(() => pinsFromDeployment(extra, { relays: [ADDR.relay] }))).toBe('tokens[1].permit');
        expect(() => pinsFromDeployment(extra, { relays: [ADDR.relay] })).toThrow(/unexpected key in a version 3 record/);
        const capped = { ...deployment, tokens: [deployment.tokens[0], { ...deployment.tokens[1], maxFee: '5000000' }] };
        expect(pinsError(() => pinsFromDeployment(capped, { relays: [ADDR.relay] }))).toBe('tokens[1].maxFee');
    });

    it.each([
        ['deployment', null],
        ['chainId', { ...deployment, chainId: 'polygon' }],
        ['gaslessTransfer', { ...deployment, gaslessTransfer: undefined }],
        ['deployBlock', { ...deployment, deployBlock: undefined }],
        ['tokens', { ...deployment, tokens: 'USDC' }],
        ['tokens[0]', { ...deployment, tokens: [null] }],
        ['tokens[0].authModes', { ...deployment, tokens: [{ ...deployment.tokens[0], authModes: 'PERMIT' }] }],
        ['tokens[0].authModes[0]', { ...deployment, tokens: [{ ...deployment.tokens[0], authModes: [7] }] }],
        ['tokens[0].authModes[0]', { ...deployment, tokens: [{ ...deployment.tokens[0], authModes: ['Permit'] }] }],
        ['tokens[0].decimals', { ...deployment, tokens: [{ ...deployment.tokens[0], decimals: 'six' }] }],
        ['tokens[0].domain', { ...deployment, tokens: [{ ...deployment.tokens[0], domain: null }] }],
        ['tokens[0].domain.chainId', { ...deployment, tokens: [{ ...deployment.tokens[0], domain: { ...POLYGON_USDC.domain, chainId: 'x' } }] }],
        ['tokens[0].domainSeparator', { ...deployment, tokens: [{ ...deployment.tokens[0], domainSeparator: POLYGON_USDT0.domainSeparator }] }],
    ])('rejects a bad %s', (field, file) => {
        expect(pinsError(() => pinsFromDeployment(file, { relays: [ADDR.relay] }))).toBe(field);
    });

    it('requires relay addresses', () => {
        expect(pinsError(() => pinsFromDeployment(deployment, { relays: [] }))).toBe('relays');
        expect(pinsError(() => pinsFromDeployment(deployment, undefined as never))).toBe('options');
    });
});

describe('recipient denylist (D11)', () => {
    it('contains zero, the tokens, the contract, the legacy handlers on 137 and the extra entries', () => {
        const pins = polygonPins({ extraDeniedRecipients: [ADDR.other] });
        expect(recipientDenylist(pins)).toEqual([ZERO_ADDRESS, USDC, USDT0, TRANSFER_CONTRACT, ...LEGACY_NIMIQ_CONTRACTS_POLYGON, ADDR.other]);
        for (const denied of recipientDenylist(pins)) {
            expect(isDeniedRecipient(pins, denied)).toBe(true);
            expect(isDeniedRecipient(pins, denied.toLowerCase())).toBe(true);
        }
        expect(isDeniedRecipient(pins, ADDR.recipient)).toBe(false);
        expect(isDeniedRecipient(pins, ADDR.relay)).toBe(false);
        expect(Object.isFrozen(recipientDenylist(pins))).toBe(true);
    });

    it('does not add the Polygon legacy list on other chains', () => {
        const pins = definePins({ chainId: 80002, transfer: TRANSFER_CONTRACT, relays: [ADDR.relay], tokens: [testToken(80002, TOKEN_A)] });
        expect(recipientDenylist(pins)).toEqual([ZERO_ADDRESS, TOKEN_A, TRANSFER_CONTRACT]);
        expect(isDeniedRecipient(pins, LEGACY_NIMIQ_CONTRACTS_POLYGON[0] as string)).toBe(false);
    });

    it('derives the list from hand-built pins too', () => {
        const pins = { ...polygonPins(), extraDeniedRecipients: [], tokens: POLYGON_TOKENS.map((t) => ({ ...t })) };
        expect(isDeniedRecipient(pins, LEGACY_NIMIQ_CONTRACTS_POLYGON[5] as string)).toBe(true);
    });

    it('refuses every entry of the Polygon list as the pinned transfer contract on 137', () => {
        for (const listed of LEGACY_NIMIQ_CONTRACTS_POLYGON) {
            expect(pinsError(() => definePins(polygonPinsInput({ transfer: listed }))), listed).toBe('transfer');
            expect(() => definePins(polygonPinsInput({ transfer: listed.toLowerCase() })), listed).toThrow(/legacy Nimiq contract/);
            // Other chains do not use the Polygon list.
            const other = definePins({ chainId: 80002, transfer: listed, relays: [ADDR.relay], tokens: [testToken(80002, TOKEN_A)] });
            expect(recipientDenylist(other)).toEqual([ZERO_ADDRESS, TOKEN_A, listed]);
        }
    });
});
