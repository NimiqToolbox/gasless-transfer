import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { LEGACY_NIMIQ_CONTRACTS_POLYGON, POLYGON_USDC } from '@nimiq/gasless-sdk/core';
import { parseDeployment, type Deployment } from '../../src/config.js';
import { hashDomain } from '../../src/eip712.js';
import { buildDenylist, buildInfo, buildRelayContext, verifyDeployment, StartupError } from '../../src/startup.js';
import { FakeChain } from '../helpers/fakeChain.js';
import { CONTRACT, START_TIME, USDC, USDT0, captureLogger, deploymentJson, testDeployment } from '../helpers/harness.js';
import { OTHER_ADDRESS, RELAY_ADDRESS } from '../helpers/keys.js';

let deployment: Deployment;
let chain: FakeChain;

beforeEach(() => {
    deployment = testDeployment();
    chain = new FakeChain({ deployment, timestamp: START_TIME, relay: RELAY_ADDRESS });
});

async function failure(d: Deployment = deployment): Promise<string> {
    try {
        await verifyDeployment(chain, d);
    } catch (err) {
        expect(err).toBeInstanceOf(StartupError);
        return (err as Error).message;
    }
    throw new Error('expected verification to fail');
}

describe('verifyDeployment', () => {
    it('passes when chain, contract and tokens match the deployment file, and returns every token domain it read', async () => {
        const logs = captureLogger();
        const verified = await verifyDeployment(chain, deployment, logs.logger);
        expect(logs.text()).toContain('deployment verified');
        expect(verified.tokenDomainMismatches).toEqual([]);
        expect(verified.tokenDomains).toEqual(
            deployment.tokens.map((t) => ({ address: t.address, domainSeparator: chain.token(t.address).domainSeparator })),
        );
    });

    it('refuses a different chain id', async () => {
        chain.chainId = 80002;
        expect(await failure()).toMatch(/chain id 80002/);
    });

    it('refuses a missing contract', async () => {
        chain.codes.delete(CONTRACT.toLowerCase());
        expect(await failure()).toMatch(/no contract code/);
    });

    it("refuses a token whose modes on-chain differ from the deployment file (the owner's setTokenConfig removed or added one)", async () => {
        chain.setTokenConfig(USDT0, { metaTxApprove: false });
        expect(await failure()).toMatch(
            /USDT0: tokenConfig on-chain \(permit true, metaTxApprove false, allowance true\) does not match authModes \["permit","metaTxApprove","none"\]/,
        );
        chain.setTokenConfig(USDT0, { metaTxApprove: true });
        chain.setTokenConfig(USDC, { metaTxApprove: true });
        expect(await failure()).toMatch(/USDC: tokenConfig on-chain \(permit true, metaTxApprove true, allowance true\) does not match authModes \["permit","none"\]/);
    });

    it("refuses a contract whose EIP-712 domain differs from ('Nimiq Gasless Transfer', '3', chainId, address)", async () => {
        chain.contract.domainSeparator = `0x${'12'.repeat(32)}`;
        expect(await failure()).toMatch(/GaslessTransfer DOMAIN_SEPARATOR\(\) does not match \("Nimiq Gasless Transfer", "3"/);
        // A contract of another domain version at the address.
        for (const version of ['1', '2']) {
            chain.contract.domainSeparator = hashDomain({ name: 'Nimiq Gasless Transfer', version, chainId: 137, verifyingContract: CONTRACT });
            expect(await failure()).toMatch(/GaslessTransfer DOMAIN_SEPARATOR/);
        }
    });

    it('passes a token whose on-chain DOMAIN_SEPARATOR differs from the configured domain (USDT0 changeName), reporting it for a degraded start', async () => {
        const renamed = `0x${'34'.repeat(32)}` as const;
        chain.token(USDT0).domainSeparator = renamed;
        const logs = captureLogger();
        const verified = await verifyDeployment(chain, deployment, logs.logger);
        expect(verified.tokenDomainMismatches).toEqual(['USDT0']);
        expect(verified.tokenDomains).toContainEqual({ address: USDT0, domainSeparator: renamed });
        expect(logs.text()).toContain('deployment verified');
        expect(logs.text()).toContain('starting degraded, with its permit and meta-tx refused');
    });

    it('a token domain mismatch does not hide the problems that still stop startup', async () => {
        chain.token(USDT0).domainSeparator = `0x${'34'.repeat(32)}`;
        chain.contract.domainSeparator = `0x${'12'.repeat(32)}`;
        const message = await failure();
        expect(message).toMatch(/GaslessTransfer DOMAIN_SEPARATOR/);
        expect(message).not.toMatch(/USDT0/);
    });

    it('refuses a tokenConfig that does not match the auth modes', async () => {
        chain.setTokenConfig(USDC, { permit: true, metaTxApprove: false, allowance: false });
        expect(await failure()).toMatch(/USDC: tokenConfig/);
        chain.contract.tokenConfig.set(USDC.toLowerCase(), { permit: false, metaTxApprove: false, allowance: false });
        expect(await failure()).toMatch(/USDC: tokenConfig/);
    });

    it('refuses wrong decimals and tokens without code', async () => {
        chain.token(USDC).decimals = 18;
        expect(await failure()).toMatch(/decimals/);
        chain.token(USDC).decimals = 6;
        chain.codes.delete(USDT0.toLowerCase());
        expect(await failure()).toMatch(/USDT0: no code/);
    });

    it('on Polygon, tokens must match the SDK pins (the deployment file and the contract agree on another domain)', async () => {
        const json = deploymentJson() as { tokens: Array<Record<string, unknown>> };
        json.tokens[0]!.domain = { ...POLYGON_USDC.domain, version: '1' };
        const tampered = parseDeployment(json);
        chain = new FakeChain({ deployment: tampered, timestamp: START_TIME, relay: RELAY_ADDRESS });
        expect(await failure(tampered)).toMatch(/USDC: domain or auth modes differ from the SDK pins/);
    });

    it('off Polygon there are no pins: the deployment file and the contract decide', async () => {
        const json = deploymentJson() as { tokens: Array<Record<string, unknown>> };
        const [usdc, usdt0] = json.tokens;
        const amoy = parseDeployment({
            ...json,
            chainId: 80002,
            tokens: [
                { ...usdc, domain: { ...(usdc!.domain as object), chainId: 80002 } },
                { ...usdt0, domain: { ...(usdt0!.domain as object), salt: `0x${(80002).toString(16).padStart(64, '0')}` } },
            ],
        });
        chain = new FakeChain({ deployment: amoy, timestamp: START_TIME, relay: RELAY_ADDRESS });
        await expect(verifyDeployment(chain, amoy)).resolves.toMatchObject({ tokenDomainMismatches: [] });
    });

    it('lists every problem', async () => {
        chain.setTokenConfig(USDC, { permit: false });
        chain.token(USDC).decimals = 18;
        chain.contract.tokenConfig.set(USDT0.toLowerCase(), { permit: false, metaTxApprove: false, allowance: false });
        const message = await failure();
        expect(message).toMatch(/USDC: tokenConfig on-chain \(permit false/);
        expect(message).toMatch(/USDC: decimals\(\) is 18/);
        expect(message).toMatch(/USDT0: tokenConfig/);
    });
});

describe('context and info', () => {
    it('denylist: zero address, contract, tokens, legacy Nimiq contracts and extras', () => {
        const denylist = buildDenylist(deployment, [OTHER_ADDRESS]);
        for (const a of ['0x0000000000000000000000000000000000000000', CONTRACT, USDC, USDT0, OTHER_ADDRESS, ...LEGACY_NIMIQ_CONTRACTS_POLYGON]) {
            expect(denylist.has(a.toLowerCase())).toBe(true);
        }
        expect(denylist.size).toBe(5 + LEGACY_NIMIQ_CONTRACTS_POLYGON.length);
        // The superseded GaslessTransfer deployments are among them.
        expect(denylist.has('0xbfbe31e6c57b09a8130d427b9e3e23ed5ab6cd1d')).toBe(true);
        expect(denylist.has('0xa0df3cdf124d7101a67ebe5b1b97d222505de9d6')).toBe(true);
    });

    it('context holds tokens by lowercase address and the relay policy', () => {
        const ctx = buildRelayContext(deployment, RELAY_ADDRESS, chain);
        expect(ctx.tokens.get(USDC.toLowerCase())?.symbol).toBe('USDC');
        expect(ctx.tokens.get(getAddress(USDT0).toLowerCase())?.kind).toBe('usdt0');
        expect(ctx.policy).toEqual({ minDeadlineSeconds: 60, maxDeadlineSeconds: 7200 });
        const info = buildInfo(ctx, deployment);
        expect(info.tokens.map((t) => [t.symbol, Object.keys(t).sort()])).toEqual([
            ['USDC', ['address', 'authModes', 'decimals', 'symbol', 'tokenDomain']],
            ['USDT0', ['address', 'authModes', 'decimals', 'symbol', 'tokenDomain']],
        ]);
        expect(info.contracts.transfer.domain).toMatchObject({ name: 'Nimiq Gasless Transfer', version: '3', chainId: 137, verifyingContract: CONTRACT });
    });
});
