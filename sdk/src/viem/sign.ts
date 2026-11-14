import { recoverTypedDataAddress, type Account, type LocalAccount, type WalletClient } from 'viem';
import { sameAddress } from '../core/address.js';
import { deepFreeze, isPlainObject } from '../core/bytes.js';
import { tokenAuthHash, transferDigest } from '../core/eip712.js';
import { GaslessError, GaslessValidationError } from '../core/errors.js';
import { tokenAuthSigningPayload, transferSigningPayload, type TransferIntent } from '../core/intent.js';
import type { ChainPins } from '../core/pins.js';
import { normalizeSignature, toTokenAuthorization } from '../core/signature.js';
import type { Address, Hex, TokenAuthorization, TransferRequest, TransferVersion, TypedDataDomain, TypedDataField } from '../core/types.js';
import type { TransferValidationOptions } from '../core/validate.js';
import { hashTransfer } from './hash.js';
import { toViemTypedData } from './typedData.js';

/** A viem local account (privateKeyToAccount, mnemonicToAccount, …) or a WalletClient with an account. */
export type TransferSigner = LocalAccount | WalletClient;

/**
 * Options of `signPrepared`. `maxAcceptableFee` (`TransferValidationOptions`) and `allowMetaTxApprove` are the
 * signing app's own bounds: an app that signs a transfer prepared by another application passes both.
 */
export interface SignPreparedOptions extends TransferValidationOptions {
    /** For a WalletClient without a hoisted account. */
    readonly account?: Account | Address;
    /** Unix seconds (default: system clock); the deadline window is re-checked before signing. */
    readonly now?: number;
    /**
     * False: an intent of mode "metaTxApprove" is refused with `meta_tx_approve_not_allowed` before anything is
     * signed. A META_TX approval never expires: once broadcast it stays executable by anyone until the owner's token
     * nonce moves on (spec §5). Omitted or true: the intent is signed in the mode it names, which is the choice of
     * whoever prepared it.
     */
    readonly allowMetaTxApprove?: boolean;
}

/**
 * Everything the relay needs, in the shape of `buildSubmitTransferBody`'s parameters. Contains the
 * token signature: a META_TX approval never expires, so do not persist or log this object. Persist the
 * version instead (`{ request, authHash }`, a `TransferVersion`), which holds no signature.
 */
export interface SignedTransfer extends TransferVersion {
    /** The transfer digest: the contract's `hashTransfer(r, nonce, auth)` and the relay request id. */
    readonly id: Hex;
    readonly request: TransferRequest;
    readonly signature: Hex;
    readonly authorization: TokenAuthorization;
    /** `tokenAuthHash(authorization)`. */
    readonly authHash: Hex;
}

interface Payload {
    readonly domain: TypedDataDomain;
    readonly types: Readonly<Record<string, readonly TypedDataField[]>>;
    readonly primaryType: string;
    readonly message: unknown;
}

function isLocalAccount(signer: TransferSigner): signer is LocalAccount {
    return (signer as { type?: unknown }).type === 'local' && typeof (signer as LocalAccount).signTypedData === 'function';
}

function signerAddress(signer: TransferSigner, options: SignPreparedOptions): Address {
    if (isLocalAccount(signer)) return signer.address;
    const account = options.account ?? signer.account;
    if (account === undefined) throw new TypeError('signPrepared: the WalletClient has no account; pass options.account');
    return typeof account === 'string' ? account : account.address;
}

async function sign(signer: TransferSigner, options: SignPreparedOptions, payload: Payload): Promise<Hex> {
    const typedData = toViemTypedData(payload);
    if (isLocalAccount(signer)) return signer.signTypedData(typedData);
    if (typeof (signer as WalletClient).signTypedData !== 'function') throw new TypeError('signPrepared: expected a LocalAccount or a WalletClient');
    const account = options.account ?? signer.account;
    if (account === undefined) throw new TypeError('signPrepared: the WalletClient has no account; pass options.account');
    return signer.signTypedData({ ...typedData, account });
}

async function signAndVerify(signer: TransferSigner, options: SignPreparedOptions, payload: Payload, expected: Address, field: string): Promise<Hex> {
    const signature = normalizeSignature(await sign(signer, options, payload), field);
    const recovered = await recoverTypedDataAddress({ ...toViemTypedData(payload), signature });
    if (!sameAddress(recovered, expected)) {
        throw new GaslessValidationError('invalid_signature', field, 'the wallet signed with a different key or different data');
    }
    return signature;
}

/** What stands for the token signature where an error held it. */
const WITHHELD = '[token signature]';

/** An array or a plain data object, of any realm: its prototype is a root prototype, or it has none. */
function isPlainData(value: object): boolean {
    if (Array.isArray(value)) return true;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * Removes the token signature (its r and s, in any case) from what the wallet threw for the intent signature, in
 * place: from the string fields of the error and of its causes, and from the arrays and plain objects they hold. With
 * a JSON-RPC account, viem's transport errors quote the request in `message`, `metaMessages`, `body` and `stack`; the
 * request is the intent's typed data, whose `auth` is the token signature. The error stays the wallet's own object, so
 * a caller still recognizes a user rejection by its class or code. False if something that holds the signature cannot
 * be changed (a frozen error, a thrown string) or read.
 */
function stripTokenSignature(thrown: unknown, authorization: TokenAuthorization): boolean {
    const signature = new RegExp(`${authorization.r.slice(2)}|${authorization.s.slice(2)}`, 'gi');
    const seen = new Set<object>();
    const strip = (holder: object): boolean => {
        if (seen.has(holder)) return true;
        seen.add(holder);
        let stripped = true;
        for (const key of Reflect.ownKeys(holder)) {
            const value: unknown = Reflect.get(holder, key);
            if (typeof value === 'string') {
                const clean = value.replace(signature, WITHHELD);
                if (clean !== value && !Reflect.set(holder, key, clean)) stripped = false;
            } else if (typeof value === 'object' && value !== null && (key === 'cause' || isPlainData(value))) {
                if (!strip(value)) stripped = false;
            }
        }
        return stripped;
    };
    try {
        if (typeof thrown === 'object' && thrown !== null) return strip(thrown);
        return typeof thrown !== 'string' || !signature.test(thrown);
    } catch {
        // A field whose getter throws: what it holds is not known.
        return false;
    }
}

/**
 * Signs a prepared transfer: re-validates it against the pins (deadline window at `now`), rebuilds
 * the typed data from its fields and checks that the signer is `request.from`. Then it signs, for permit /
 * meta-tx, the token authorization first, and the intent over that authorization second, and verifies that
 * both signatures recover to `from`.
 *
 * With `options.maxAcceptableFee`, a higher fee fails with `fee_above_limit` at the validation before each
 * signature; with `options.allowMetaTxApprove: false`, an intent of mode "metaTxApprove" fails with
 * `meta_tx_approve_not_allowed`. Neither is checked when omitted: the fee and the mode are then those of the
 * prepared transfer.
 *
 * When the wallet fails to sign the intent, its own error is thrown without the token signature
 * (`stripTokenSignature`); an error that cannot be changed is replaced by a `GaslessError` `signing_failed`.
 */
export async function signPrepared(
    signer: TransferSigner,
    prepared: TransferIntent,
    pins: ChainPins,
    options: SignPreparedOptions = {},
): Promise<SignedTransfer> {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    // Inputs crossing an iframe boundary can be mutable. Sign a snapshot, so that the intent signed after the
    // token authorization's wallet prompt has the fields that were validated before it.
    const intent: TransferIntent =
        isPlainObject(prepared) && isPlainObject(prepared.request)
            ? { chainId: prepared.chainId, contract: prepared.contract, request: { ...prepared.request }, authMode: prepared.authMode, tokenAuth: prepared.tokenAuth }
            : prepared;
    const tokenAuth = tokenAuthSigningPayload(pins, intent, now, options);
    if (options.allowMetaTxApprove === false && intent.authMode === 'metaTxApprove') {
        throw new GaslessValidationError(
            'meta_tx_approve_not_allowed',
            'authMode',
            'a META_TX approval never expires and stays executable once broadcast (spec §5), and options.allowMetaTxApprove is false',
        );
    }
    const from = intent.request.from;
    if (!sameAddress(signerAddress(signer, options), from)) {
        throw new GaslessValidationError('signer_mismatch', 'signer', 'the signer is not request.from');
    }
    let authorization = toTokenAuthorization('none');
    if (tokenAuth !== null) {
        const tokenSignature = await signAndVerify(signer, options, tokenAuth, from, 'tokenSignature');
        authorization = toTokenAuthorization(tokenAuth.primaryType === 'Permit' ? 'permit' : 'metaTxApprove', tokenSignature);
    }
    const transfer = transferSigningPayload(pins, { ...intent, tokenAuth }, authorization, now, options);
    let signature: Hex;
    try {
        signature = await signAndVerify(signer, options, transfer, from, 'signature');
    } catch (error) {
        // Errors never contain a signature (core/errors.ts), and this one can quote the token signature just made.
        if (tokenAuth !== null && !stripTokenSignature(error, authorization)) {
            throw new GaslessError('signing_failed', 'the wallet failed to sign the intent; its error holds the token signature and cannot be changed, so it is withheld');
        }
        throw error;
    }
    const { auth: _auth, ...request } = transfer.message;
    const id = transferDigest(pins.chainId, pins.transfer.address, request, authorization);
    // The core and viem hash independently; the relay client and the outcome checks rely on the core digest.
    if (hashTransfer(pins.chainId, pins.transfer.address, request, authorization) !== id) {
        throw new GaslessError('internal_error', 'viem and the core disagree on the transfer digest');
    }
    return deepFreeze({ id, request, signature, authorization, authHash: tokenAuthHash(authorization) });
}
