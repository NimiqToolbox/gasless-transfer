// Protocol types (docs/STEP-1-GAS-ABSTRACTION.md §4, §6.1).

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** A uint256 as a canonical decimal string ("0", "10000"; no sign, no leading zeros, no exponent). */
export type DecimalString = string;

/** Token authorization mode. Numeric values match the Solidity `enum AuthMode`. */
export type AuthModeName = 'none' | 'permit' | 'metaTxApprove';

export const AUTH_MODE_ID = Object.freeze({ none: 0, permit: 1, metaTxApprove: 2 } as const);

/**
 * The signed request fields: Solidity `TransferRequest` plus the intent nonce. The contract reads the nonce from
 * `nonces(from)`; it is signed, but not part of the call data.
 */
export interface TransferRequest {
    token: Address;
    from: Address;
    to: Address;
    amount: DecimalString;
    fee: DecimalString;
    relay: Address;
    /** The intent nonce: `nonces(from)` when the request executes. */
    nonce: DecimalString;
    deadline: DecimalString;
}

/**
 * Mirrors Solidity `TokenAuth`, which the intent signs: the relay submits exactly these values. For mode "none"
 * v is 0 and r and s are zero; otherwise v is 27 or 28 and r, s are the owner's token signature.
 */
export interface TokenAuthorization {
    mode: AuthModeName;
    v: number;
    r: Hex;
    s: Hex;
}

/** POST /v1/transfer. The relay never accepts calldata or target addresses from clients. */
export interface SubmitTransferBody {
    /** The signed request fields. `request.nonce` is the intent nonce; the contract call does not carry it. */
    request: TransferRequest;
    /** 65-byte ECDSA signature (r, s, v) over the GaslessTransfer typed data, low-s, v 27 or 28. */
    signature: Hex;
    /** The signed token authorization; the relay submits exactly it. Mode "none": v 0, r and s zero. */
    authorization: TokenAuthorization;
    quoteId?: string;
}

/**
 * A signed version of a payment without its signatures: the request and `tokenAuthHash` of its token
 * authorization. It identifies the version (`transferDigestFromAuthHash` gives its id) and holds nothing secret,
 * so a wallet can store it as a payment's latest version and pass it to the outcome checks.
 */
export interface TransferVersion {
    readonly request: TransferRequest;
    readonly authHash: Hex;
}

export interface TypedDataField {
    readonly name: string;
    readonly type: string;
}

/**
 * EIP-712 domain. Only the fields that are present become part of `EIP712Domain`, in the order
 * name, version, chainId, verifyingContract, salt (the rule used by viem and ethers v5/v6).
 */
export interface TypedDataDomain {
    readonly name: string;
    readonly version: string;
    readonly chainId?: number;
    readonly verifyingContract: Address;
    readonly salt?: Hex;
}

/** Signable payload for viem `signTypedData`, ethers v5 `_signTypedData` and ethers v6 `signTypedData`. */
export interface TypedDataPayload<
    Types extends Record<string, readonly TypedDataField[]>,
    PrimaryType extends keyof Types & string,
    Message,
> {
    domain: TypedDataDomain;
    /** Does not contain `EIP712Domain`. */
    types: Types;
    primaryType: PrimaryType;
    message: Message;
}
