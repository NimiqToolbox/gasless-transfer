import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';
import { z } from 'zod';
import {
    AUTH_MODE_ID,
    buildMetaTxApproveTypedData,
    buildPermitTypedData,
    buildTransferTypedData,
    gaslessTransferAbi,
    tokenAuthHash,
    type AuthModeName,
    type TokenAuthorization,
    type TransferRequest,
} from '@nimiq/gasless-sdk/core';
import {
    readAllowance,
    readBalanceOf,
    readIntentNonce,
    readPermitNonce,
    readUsdcBlacklisted,
    readUsdcPaused,
    readUsdt0Blocked,
    readUsdt0MetaNonce,
} from '../chain/reads.js';
import { hashSdkTypedData, isCanonicalEcdsa, recoverCanonical, splitSignature65 } from '../eip712.js';
import { RelayError } from '../errors.js';
import { MAX_UINT256, sameAddress } from '../util/validation.js';
import { zAddress, zAuthorization, zQuoteId, zSignatureHex, zUint256 } from './schemas.js';
import {
    PRIORITY_NORMAL,
    type OperationDefinition,
    type RelayContext,
    type Submission,
    type TokenSettings,
} from './types.js';

export type TransferSubmission = Submission<TransferRequest>;

/** The 8 signed request fields. `nonce` is the intent nonce: signed, but not part of the call (the contract reads it). */
const zTransferRequest = z.strictObject({
    token: zAddress,
    from: zAddress,
    to: zAddress,
    amount: zUint256,
    fee: zUint256,
    relay: zAddress,
    nonce: zUint256,
    deadline: zUint256,
});

/** `POST /v1/transfer` body (`SubmitTransferBody`), strict at every level. */
export const zSubmitTransferBody = z.strictObject({
    request: zTransferRequest,
    signature: zSignatureHex,
    authorization: zAuthorization,
    quoteId: zQuoteId.optional(),
});

/** The token authorization modes by their id in TokenAuth.mode. */
const AUTH_MODE_NAMES = Object.fromEntries(Object.entries(AUTH_MODE_ID).map(([name, id]) => [id, name])) as Readonly<Record<number, AuthModeName>>;

function tokenOf(ctx: RelayContext, sub: TransferSubmission): TokenSettings {
    const token = ctx.tokens.get(sub.request.token.toLowerCase());
    if (!token) throw new RelayError('unsupported_token', `token ${sub.request.token} is not supported`);
    return token;
}

/** amount + fee: what the contract pulls from `from` (and the permit / approve value). */
function debitOf(sub: TransferSubmission): bigint {
    return BigInt(sub.request.amount) + BigInt(sub.request.fee);
}

function blockedMessage(symbol: string, party: string, verb: string): string {
    return `${party} is ${verb} by ${symbol}`;
}

export const transferOperation: OperationDefinition<TransferSubmission> = {
    name: 'transfer',
    priority: PRIORITY_NORMAL,
    schema: zSubmitTransferBody,

    typedData(ctx, sub) {
        return buildTransferTypedData(ctx.chainId, ctx.contracts.transfer, sub.request, sub.authorization);
    },

    signer(sub) {
        return sub.request.from;
    },

    nonceKey(ctx, sub) {
        return { contract: ctx.contracts.transfer, signer: sub.request.from, nonce: sub.request.nonce };
    },

    policy(ctx, sub, now) {
        const r = sub.request;
        if (!sameAddress(r.relay, ctx.relay)) throw new RelayError('wrong_relay', `request.relay must be ${ctx.relay}`);
        const token = tokenOf(ctx, sub);
        if (!token.authModes.includes(sub.authorization.mode)) {
            throw new RelayError('unsupported_auth_mode', `${token.symbol} does not support authorization mode ${sub.authorization.mode}`);
        }
        const amount = BigInt(r.amount);
        // Same rule and code as the SDK's checkTransferPolicy: the contract pulls amount + fee.
        if (amount === 0n) throw new RelayError('invalid_amount', 'amount must be greater than 0');
        if (amount + BigInt(r.fee) > MAX_UINT256) throw new RelayError('invalid_amount', 'amount + fee exceeds uint256');
        if (ctx.denylist.has(r.to.toLowerCase())) throw new RelayError('invalid_recipient', `recipient ${r.to} is not allowed`);
        const deadline = BigInt(r.deadline);
        const min = BigInt(now + ctx.policy.minDeadlineSeconds);
        const max = BigInt(now + ctx.policy.maxDeadlineSeconds);
        if (deadline < min || deadline > max) {
            throw new RelayError(
                'deadline_out_of_range',
                `deadline must be between now+${ctx.policy.minDeadlineSeconds} and now+${ctx.policy.maxDeadlineSeconds} seconds`,
            );
        }
        // No upper bound on the fee: the contract has none, and the sender's signature fixes the fee. The lower bound
        // is pipeline step 5.
    },

    fee(sub) {
        return { fee: BigInt(sub.request.fee), mode: sub.authorization.mode };
    },

    deadline(sub) {
        return BigInt(sub.request.deadline);
    },

    reservation(ctx, sub) {
        return { token: tokenOf(ctx, sub).address, spender: ctx.contracts.transfer, debit: debitOf(sub) };
    },

    authHash(sub) {
        return tokenAuthHash(sub.authorization);
    },

    async executionOf(ctx, call, nonce) {
        if (!sameAddress(call.to, ctx.contracts.transfer)) return undefined;
        let decoded;
        try {
            decoded = decodeFunctionData({ abi: gaslessTransferAbi, data: call.data });
        } catch {
            return undefined;
        }
        if (decoded.functionName !== 'relayTransfer') return undefined;
        const [r, signature, auth] = decoded.args;
        const mode = AUTH_MODE_NAMES[auth.mode];
        const parts = splitSignature65(signature);
        if (mode === undefined || !parts) return undefined;
        const request: TransferRequest = {
            token: r.token,
            from: r.from,
            to: r.to,
            amount: r.amount.toString(),
            fee: r.fee.toString(),
            relay: r.relay,
            nonce: nonce.toString(),
            deadline: r.deadline.toString(),
        };
        const id = transferRequestId(ctx, request, { mode, v: auth.v, r: auth.r, s: auth.s });
        const signer = await recoverCanonical(id, parts);
        return signer ? { id, signer, relay: r.relay } : undefined;
    },

    onchainChecks: {
        nextNonce(ctx, sub) {
            return readIntentNonce(ctx.chain, ctx.contracts.transfer, sub.request.from);
        },

        async state(ctx, sub, usage) {
            const token = tokenOf(ctx, sub);
            const { from, to } = sub.request;
            const debit = debitOf(sub);
            if (token.kind === 'usdc') {
                const [balance, paused, blFrom, blTo, blRelay, blContract] = await Promise.all([
                    readBalanceOf(ctx.chain, token.address, from),
                    readUsdcPaused(ctx.chain, token.address),
                    readUsdcBlacklisted(ctx.chain, token.address, from),
                    readUsdcBlacklisted(ctx.chain, token.address, to),
                    readUsdcBlacklisted(ctx.chain, token.address, ctx.relay),
                    readUsdcBlacklisted(ctx.chain, token.address, ctx.contracts.transfer),
                ]);
                if (balance < usage.debits + debit) {
                    throw new RelayError('insufficient_balance', 'balance does not cover amount + fee (including pending requests)');
                }
                if (paused) throw new RelayError('token_paused', `${token.symbol} is paused`);
                if (blFrom) throw new RelayError('blocked_address', blockedMessage(token.symbol, 'the sender', 'blacklisted'));
                if (blTo) throw new RelayError('blocked_address', blockedMessage(token.symbol, 'the recipient', 'blacklisted'));
                if (blRelay) throw new RelayError('blocked_address', blockedMessage(token.symbol, 'the relay', 'blacklisted'));
                if (blContract) throw new RelayError('blocked_address', blockedMessage(token.symbol, 'the contract', 'blacklisted'));
                return { balance };
            }
            // USDT0: transferFrom checks the token sender (`from`) and msg.sender (the contract); a
            // blocked relay could not move the fees it receives.
            const [balance, bFrom, bRelay, bContract] = await Promise.all([
                readBalanceOf(ctx.chain, token.address, from),
                readUsdt0Blocked(ctx.chain, token.address, from),
                readUsdt0Blocked(ctx.chain, token.address, ctx.relay),
                readUsdt0Blocked(ctx.chain, token.address, ctx.contracts.transfer),
            ]);
            if (balance < usage.debits + debit) {
                throw new RelayError('insufficient_balance', 'balance does not cover amount + fee (including pending requests)');
            }
            if (bFrom) throw new RelayError('blocked_address', blockedMessage(token.symbol, 'the sender', 'blocked'));
            if (bRelay) throw new RelayError('blocked_address', blockedMessage(token.symbol, 'the relay', 'blocked'));
            if (bContract) throw new RelayError('blocked_address', blockedMessage(token.symbol, 'the contract', 'blocked'));
            return { balance };
        },

        async authorization(ctx, sub, usage) {
            const token = tokenOf(ctx, sub);
            const { from } = sub.request;
            const spender = ctx.contracts.transfer;
            const value = debitOf(sub);
            const auth = sub.authorization;

            if (auth.mode === 'none') {
                const allowance = await readAllowance(ctx.chain, token.address, from, spender);
                if (allowance < usage.noneDebits + value) {
                    throw new RelayError('insufficient_allowance', 'allowance to the contract does not cover amount + fee (including pending requests)');
                }
                return { allowance };
            }

            const invalid = (why: string) => new RelayError('invalid_token_authorization', why);
            if (!isCanonicalEcdsa(auth)) throw invalid('token authorization must have v 27 or 28 and a low-s signature');

            let digest: Hex;
            if (auth.mode === 'permit') {
                const [nonce, code] = await Promise.all([
                    readPermitNonce(ctx.chain, token.address, from),
                    token.kind === 'usdc' ? ctx.chain.getCode(from) : Promise.resolve(undefined),
                ]);
                if (code !== undefined && code !== '0x') {
                    // FiatToken verifies permits of accounts with code (e.g. EIP-7702 delegations) via ERC-1271.
                    throw invalid('USDC permits from accounts with code (e.g. EIP-7702 delegated) are not supported; use authorization mode "none"');
                }
                digest = hashSdkTypedData(
                    buildPermitTypedData({ tokenDomain: token.domain, owner: from, spender, value, nonce, deadline: sub.request.deadline }),
                );
            } else {
                if (token.kind !== 'usdt0') throw new RelayError('unsupported_auth_mode', `${token.symbol} has no meta-transactions`);
                const nonce = await readUsdt0MetaNonce(ctx.chain, token.address, from);
                digest = hashSdkTypedData(buildMetaTxApproveTypedData({ tokenDomain: token.domain, from, spender, value, nonce }));
            }
            const signer = await recoverCanonical(digest, auth);
            if (!signer || !sameAddress(signer, from)) {
                throw invalid(`the ${auth.mode} signature does not match the current token nonce, spender, value (amount + fee) or deadline`);
            }
            return {};
        },
    },

    encodeCall(ctx, sub) {
        const r = sub.request;
        const a = sub.authorization;
        const data = encodeFunctionData({
            abi: gaslessTransferAbi,
            functionName: 'relayTransfer',
            args: [
                // No nonce: the contract verifies the signature over nonces(from).
                {
                    token: r.token,
                    from: r.from,
                    to: r.to,
                    amount: BigInt(r.amount),
                    fee: BigInt(r.fee),
                    relay: r.relay,
                    deadline: BigInt(r.deadline),
                },
                sub.signature,
                // Exactly the signed token authorization; any other one fails with InvalidSignature.
                { mode: AUTH_MODE_ID[a.mode], v: a.v, r: a.r, s: a.s },
            ],
        });
        return { to: ctx.contracts.transfer, data };
    },

    publicRequest(sub) {
        return sub.request;
    },

    restore(stored) {
        return zSubmitTransferBody.parse({ request: stored.request, signature: stored.signature, authorization: stored.authorization });
    },
};

/**
 * The request id: the EIP-712 digest of the signed `GaslessTransfer` at its nonce with its token authorization (equals
 * the contract's `hashTransfer(r, nonce, auth)`).
 */
export function transferRequestId(ctx: RelayContext, request: TransferRequest, authorization: TokenAuthorization): Hex {
    return hashSdkTypedData(buildTransferTypedData(ctx.chainId, ctx.contracts.transfer, request, authorization));
}
