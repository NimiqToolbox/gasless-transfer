import type { Client } from 'viem';
import { getChainId, getCode, readContract } from 'viem/actions';
import { gaslessTransferAbi, usdcAbi } from '../core/abi.js';
import { toUint256 } from '../core/amounts.js';
import { DEFAULT_DEADLINE_SECONDS } from '../core/defaults.js';
import { GaslessValidationError } from '../core/errors.js';
import { createTransferIntent, normalizeCorrectedRequest, type TransferIntent } from '../core/intent.js';
import { findPinnedToken, type ChainPins, type PinnedToken } from '../core/pins.js';
import { normalizeTransferRequest } from '../core/submit.js';
import type { Address, AuthModeName, DecimalString, TransferRequest } from '../core/types.js';
import { assertUnixSeconds, checkAcceptableFee, checkCorrection, checkTransferPolicy, parseMaxAcceptableFee } from '../core/validate.js';
import { withoutCcipRead } from './ccipRead.js';
import { assertTokenDomain, readTokenNonce, requirePinnedToken } from './tokens.js';

/** A validated, deep-frozen transfer ready for `signPrepared`. */
export type PreparedTransfer = TransferIntent;

export interface PrepareTransferParams {
    readonly token: Address;
    readonly from: Address;
    readonly to: Address;
    readonly amount: bigint | DecimalString;
    /** The relay's quote (`RelayClient.fee()`). It must cover the auth mode that is used (see `authMode`). */
    readonly fee: bigint | DecimalString;
    /** The most the caller accepts to pay; a higher `fee` throws `fee_above_limit`. Nothing else caps the fee, neither the pins nor the contract. */
    readonly maxAcceptableFee?: bigint | DecimalString;
    /** The relay address of the quote; must be pinned. */
    readonly relay: Address;
    /**
     * Forces a token authorization mode. If omitted, prepareTransfer uses "none" when the token allows
     * it and allowance(from, contract) >= amount + fee (a permit would overwrite that allowance), and
     * otherwise "permit", or "metaTxApprove" only for a token without permit. For USDT0 this means
     * PERMIT: a META_TX approval never expires, and once broadcast it is public, also if the
     * transaction reverts. The chosen mode is `prepared.authMode`. Forcing "metaTxApprove" is the
     * caller's explicit choice and needs no further opt-in (the core's `allowMetaTxApprove`).
     */
    readonly authMode?: AuthModeName;
    /**
     * Opt-in for a USDC permit from an EIP-7702 account (default false: refused with
     * `eip7702_permit_unsupported`). USDC checks such permits through ERC-1271 of the account's
     * delegate, not ECDSA; see `prepareTransfer`.
     */
    readonly allowEip7702Permit?: boolean;
    /** Absolute deadline in unix seconds. Mutually exclusive with `deadlineSeconds`. */
    readonly deadline?: bigint | DecimalString | number;
    /**
     * Lifetime from `now` in seconds (default 600; the relay accepts 60–7200). With `corrects` the default deadline
     * is the later of now + 600 and the corrected version's deadline.
     */
    readonly deadlineSeconds?: number;
    /**
     * Only together with `corrects`, where it must equal the corrected version's nonce (which is taken over when this
     * is omitted). Without `corrects` it is refused before any RPC call (`invalid_request`, field `nonce`): a new
     * payment takes the sender's on-chain `nonces(from)`, and a later version of a payment is prepared with
     * `corrects`, which enforces the correction rules. A nonce passed alone could be an earlier version's, and
     * prepareTransfer could not tell: that version could keep a later deadline than the new one, and `expired` of the
     * new one would then say nothing about it. A wallet records the nonce of a new payment from
     * `prepared.request.nonce` (sdk/README.md, "Corrections").
     */
    readonly nonce?: bigint | DecimalString | number;
    /**
     * For a new payment: the lowest intent nonce it may take, from the outcome of the sender's previous payment. Its
     * nonce + 1 after `executed`, `other_version_executed`, `other_payment_executed` or `nonce_consumed` (the nonce is
     * used), its nonce after `expired`. A lower `nonces(from)` comes from an RPC node behind the chain, and the new
     * payment would share a used nonce with an earlier one: refused with `nonce_used` (field `minNonce`); read again
     * from an up-to-date node. Ignored with `corrects`.
     */
    readonly minNonce?: bigint | DecimalString | number;
    /**
     * The request of the payment's latest signed version, when this transfer corrects it (after a refusal, a key
     * rotation, or a relay that does not execute). The correction keeps the intent nonce, so the contract
     * executes at most one version, and it keeps `from`, `token`, `to` and a deadline at least as late
     * (`checkCorrection`; otherwise `correction_mismatch`). `amount`, `fee`, `relay` and the auth mode may change.
     * prepareTransfer also reads `nonces(from)`: once it is above the payment's nonce, a version executed or the
     * nonce was invalidated, and it throws `nonce_used`; `waitForTransferOutcome` with the latest version tells which.
     */
    readonly corrects?: TransferRequest;
    /** Unix seconds (default: system clock). */
    readonly now?: number;
}

const AUTH_MODES: readonly AuthModeName[] = ['none', 'permit', 'metaTxApprove'];

/** Signed modes by preference: a permit expires with the intent, a META_TX approval never does. */
const SIGNED_MODES: readonly AuthModeName[] = ['permit', 'metaTxApprove'];

const NONCE_WITHOUT_CORRECTS =
    'a nonce is only accepted together with corrects: a later version of a payment is prepared with corrects (its ' +
    'latest signed version), which keeps the intent nonce and checks the correction rules; a new payment takes the ' +
    "sender's on-chain nonce (read it from prepared.request.nonce)";

const EIP7702_USDC_PERMIT =
    'USDC checks permits of accounts with code through ERC-1271 of the EIP-7702 delegate, not ECDSA. That fails ' +
    'for delegates without ERC-1271, the SDK cannot check whether this delegate accepts the signature, and the ' +
    'Nimiq relay refuses such permits (invalid_token_authorization). Approve the transfer contract once and use ' +
    'authMode "none", or opt in with allowEip7702Permit';

/** EIP-7702 delegation designator: code = 0xef0100 ‖ delegate address (23 bytes). */
function isEip7702Delegation(code: string): boolean {
    return /^0xef0100[0-9a-fA-F]{40}$/.test(code);
}

function preferredSignedMode(token: PinnedToken): AuthModeName | undefined {
    return SIGNED_MODES.find((mode) => token.authModes.includes(mode));
}

/** now + `deadlineSeconds` (default 600); a correction without `deadlineSeconds` keeps at least the corrected deadline. */
function defaultDeadline(now: number, deadlineSeconds: number | undefined, corrected: TransferRequest | undefined): bigint {
    const fresh = BigInt(now + (deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS));
    if (corrected === undefined || deadlineSeconds !== undefined) return fresh;
    const previous = BigInt(corrected.deadline);
    return previous > fresh ? previous : fresh;
}

/**
 * The mode used when the caller does not force one: "none" if the token allows it and the standing
 * allowance covers amount + fee, else the preferred signed mode.
 */
async function chooseAuthMode(client: Client, pins: ChainPins, token: PinnedToken, request: TransferRequest): Promise<AuthModeName> {
    if (token.authModes.includes('none')) {
        const allowance = await readContract(withoutCcipRead(client), {
            address: token.address,
            abi: usdcAbi,
            functionName: 'allowance',
            args: [request.from, pins.transfer.address],
        });
        if (allowance >= BigInt(request.amount) + BigInt(request.fee)) return 'none';
    }
    return preferredSignedMode(token) ?? 'none';
}

/**
 * Builds and validates a transfer and its token authorization typed data (§5, §7): checks the fee
 * against the caller's `maxAcceptableFee`, the client's chain against the pins, reads the sender's intent nonce,
 * rejects contract senders (no ERC-1271, D1), chooses the auth mode unless one is forced (see `authMode`), compares
 * the token's DOMAIN_SEPARATOR() with the pinned domain, and reads the token nonce. The permit
 * deadline is the intent deadline.
 *
 * A new payment takes the sender's current `nonces(from)` at the latest block, never a higher nonce. Prepare it only
 * once the sender has no other open payment (sdk/README.md, "One payment, one nonce"): while an earlier payment's
 * nonce is unused, the new one would get the same nonce, and at most one of them could execute. `minNonce` refuses a
 * nonce that an RPC node behind the chain reports below the previous payment's outcome. A new version of a
 * payment (a correction) is prepared with `corrects`: it keeps the intent nonce, so at most one version executes, and
 * the rules of `checkCorrection`; prepareTransfer refuses it with `nonce_used` once `nonces(from)` is above that nonce.
 * A `nonce` without `corrects` is refused with `invalid_request` (field `nonce`), so no second version of a payment is
 * prepared outside those rules.
 *
 * USDC permits from EIP-7702 accounts are refused unless `allowEip7702Permit` is set: USDC verifies
 * permits of accounts with code through ERC-1271 of the delegate. That fails for delegates without
 * ERC-1271 and succeeds for delegates that accept the account's signature, which the SDK cannot
 * check, and the Nimiq relay refuses such permits. Such accounts approve the contract once and use
 * mode "none" (chosen automatically once the allowance covers the transfer).
 */
export async function prepareTransfer(client: Client, pins: ChainPins, params: PrepareTransferParams): Promise<PreparedTransfer> {
    const now = params.now ?? Math.floor(Date.now() / 1000);
    assertUnixSeconds(now);
    if (params.deadline !== undefined && params.deadlineSeconds !== undefined) {
        throw new GaslessValidationError('invalid_request', 'deadline', 'pass either deadline or deadlineSeconds, not both');
    }
    if (params.deadlineSeconds !== undefined && !Number.isSafeInteger(params.deadlineSeconds)) {
        throw new GaslessValidationError('invalid_request', 'deadlineSeconds', 'expected an integer');
    }
    // A nonce passed alone may be an earlier version's, and no correction rule would apply to it.
    if (params.nonce !== undefined && params.corrects === undefined) {
        throw new GaslessValidationError('invalid_request', 'nonce', NONCE_WITHOUT_CORRECTS);
    }
    const maxAcceptableFee = parseMaxAcceptableFee(params.maxAcceptableFee);
    let minNonce: bigint | undefined;
    if (params.minNonce !== undefined) {
        try {
            minNonce = toUint256(params.minNonce, 'minNonce');
        } catch (error) {
            throw new GaslessValidationError('invalid_request', 'minNonce', (error as Error).message);
        }
    }
    const corrected = params.corrects === undefined ? undefined : normalizeCorrectedRequest(params.corrects);
    const deadline = params.deadline ?? defaultDeadline(now, params.deadlineSeconds, corrected);

    // Fail fast on everything that needs no RPC. A new payment's nonce is read below; the checks here do not depend
    // on it, so they run with a placeholder.
    const checked = normalizeTransferRequest({
        token: params.token,
        from: params.from,
        to: params.to,
        amount: params.amount,
        fee: params.fee,
        relay: params.relay,
        nonce: params.nonce ?? corrected?.nonce ?? 0,
        deadline,
    });
    if (params.authMode !== undefined && !AUTH_MODES.includes(params.authMode)) {
        throw new GaslessValidationError('invalid_request', 'authMode', 'unknown auth mode');
    }
    // Without a forced mode, the policy is checked with the signed mode the token falls back to; the
    // allowance can only switch it to "none", and only if the token supports it.
    const pinned = findPinnedToken(pins, checked.token);
    const policyMode = params.authMode ?? (pinned === undefined ? undefined : preferredSignedMode(pinned)) ?? 'none';
    const policy = checkTransferPolicy(checked, policyMode, pins, now);
    if (!policy.ok) throw GaslessValidationError.fromResult(policy);
    if (corrected !== undefined) {
        const correction = checkCorrection(corrected, checked);
        if (!correction.ok) throw GaslessValidationError.fromResult(correction);
    }
    const acceptable = checkAcceptableFee(BigInt(checked.fee), maxAcceptableFee, 'request.fee');
    if (!acceptable.ok) throw GaslessValidationError.fromResult(acceptable);
    const token = requirePinnedToken(pins, checked.token);

    const chainId = await getChainId(client);
    if (chainId !== pins.chainId) throw new GaslessValidationError('wrong_chain', 'client', `client is on chain ${chainId}, pins are for ${pins.chainId}`);

    const next = await readContract(withoutCcipRead(client), {
        address: pins.transfer.address,
        abi: gaslessTransferAbi,
        functionName: 'nonces',
        args: [checked.from],
        blockTag: 'latest',
    });
    if (corrected !== undefined && next > BigInt(corrected.nonce)) {
        // A correction of a payment whose nonce is used can never execute, and its own outcome check could miss the
        // use: the search for it starts at the correction's deadline − 7800 s, and the use may lie before that. The
        // payment's outcome is decided; waitForTransferOutcome with the latest version tells it.
        throw new GaslessValidationError(
            'nonce_used',
            'corrects',
            'the intent nonce of this payment is already used on-chain: a version of it executed, or the nonce was invalidated. ' +
                'Sign nothing new for it; waitForTransferOutcome with its latest version tells the outcome',
        );
    }
    if (corrected === undefined && minNonce !== undefined && next < minNonce) {
        throw new GaslessValidationError(
            'nonce_used',
            'minNonce',
            `the RPC node reports nonces(from) = ${next}, below minNonce ${minNonce}: it is behind the chain, and the nonce it ` +
                'reports is used. Read it again from an up-to-date node',
        );
    }
    const request = corrected === undefined ? { ...checked, nonce: next.toString(10) } : checked;

    const code = await getCode(client, { address: request.from });
    const hasCode = code !== undefined && code !== '0x';
    if (hasCode && !isEip7702Delegation(code)) {
        throw new GaslessValidationError('sender_is_contract', 'request.from', 'contract accounts cannot sign transfers (ECDSA only, no ERC-1271)');
    }
    const authMode = params.authMode ?? (await chooseAuthMode(client, pins, token, request));
    if (hasCode && authMode === 'permit' && token.symbol === 'USDC' && params.allowEip7702Permit !== true) {
        throw new GaslessValidationError('eip7702_permit_unsupported', 'authMode', EIP7702_USDC_PERMIT);
    }

    let tokenNonce: bigint | undefined;
    if (authMode !== 'none') {
        await assertTokenDomain(client, pins, token.address);
        tokenNonce = await readTokenNonce(client, pins, { token: token.address, owner: request.from, authMode });
    }

    // A mode forced by the caller of prepareTransfer is its own explicit choice, so it also allows the META_TX
    // approval; the automatic mode only picks that for a token without permit.
    return createTransferIntent(
        pins,
        { ...request, authMode, ...(tokenNonce !== undefined ? { tokenNonce } : {}), ...(corrected !== undefined ? { corrects: corrected } : {}) },
        now,
        {
            allowMetaTxApprove: params.authMode === 'metaTxApprove',
            ...(maxAcceptableFee !== undefined ? { maxAcceptableFee } : {}),
        },
    );
}
