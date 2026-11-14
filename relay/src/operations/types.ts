import type { Address, Hex } from 'viem';
import type { z } from 'zod';
import type { AuthModeName, DecimalString } from '@nimiq/gasless-sdk/core';
import type { OperationName } from '@nimiq/gasless-sdk/relay';
import type { ChainClient } from '../chain/types.js';
import type { DeploymentToken } from '../config.js';
import type { SdkTypedData } from '../eip712.js';
import type { StoredAuthorization, TokenReservation, TokenUsage } from '../store/types.js';

/** The signed token authorization `{mode, v, r, s}` (lowercase r and s; zeros for mode "none"). */
export type NormalizedAuthorization = StoredAuthorization;

/** A validated submission: the operation's request plus the intent signature and token authorization. */
export interface Submission<Request = unknown> {
    readonly request: Request;
    /** Lowercase 0x-hex; its length is checked in step 3. */
    readonly signature: Hex;
    /** Signed by the intent: the relay submits exactly it. */
    readonly authorization: NormalizedAuthorization;
    readonly quoteId?: string | undefined;
}

/** A configured token: its modes and token domain. No fee cap: only the fee the sender signs bounds it. */
export type TokenSettings = DeploymentToken;

/** Static relay facts shared by the pipeline, the operations and the transaction manager. */
export interface RelayContext {
    readonly chainId: number;
    /** This relay's address; requests must name it in `relay` (D5). */
    readonly relay: Address;
    readonly contracts: { readonly transfer: Address };
    /**
     * The deployment record's `deployBlock`: at or below the block that created the transfer contract (the deploy
     * scripts record the block before the broadcast). The search for the use of an intent nonce reads no state below it.
     */
    readonly deployBlock: bigint;
    /** Supported tokens by lowercase address. */
    readonly tokens: ReadonlyMap<string, TokenSettings>;
    /** D11 recipient denylist, lowercase addresses. */
    readonly denylist: ReadonlySet<string>;
    readonly policy: { readonly minDeadlineSeconds: number; readonly maxDeadlineSeconds: number };
    readonly chain: ChainClient;
}

/**
 * Runtime state of the configured tokens, kept by `ops/tokenDomainMonitor.ts`. Token signatures
 * (PERMIT, META_TX_APPROVE) are built on the configured token domain; once the token's on-chain
 * `DOMAIN_SEPARATOR()` differs (for example after a USDT0 rename), none of them can succeed.
 */
export interface TokenDomainStatus {
    /** Why PERMIT and META_TX_APPROVE authorizations for `token` cannot succeed right now, or undefined. */
    tokenSignaturesUnavailable(token: Address): string | undefined;
}

export interface EncodedCall {
    readonly to: Address;
    readonly data: Hex;
}

/** Values observed on-chain, re-checked atomically against pending requests when persisting (step 9). */
export interface StateFacts {
    readonly balance?: bigint | undefined;
}

export interface AuthFacts {
    readonly allowance?: bigint | undefined;
}

/**
 * Operation registry entry. The generic pipeline drives these hooks in a fixed order.
 * Hooks throw `RelayError` to reject a request.
 * (Declared with method syntax so specific operations can be stored in the registry.)
 */
export interface OperationDefinition<S extends Submission = Submission> {
    readonly name: OperationName;
    /** Higher is served first; priority operations can use reserved in-flight slots. */
    readonly priority: number;
    /** Step 1: strict body schema (unknown fields rejected, canonical values normalized). */
    readonly schema: z.ZodType<S>;
    /** The EIP-712 payload the signer signed (with its nonce and token authorization); its digest is the request id. */
    typedData(ctx: RelayContext, sub: S): SdkTypedData;
    /** Who must have signed the payload. */
    signer(sub: S): Address;
    /**
     * The signer's sequential intent nonce. Requests that hold it are unique on (contract, signer, nonce): a database
     * constraint.
     */
    nonceKey(ctx: RelayContext, sub: S): { contract: Address; signer: Address; nonce: DecimalString };
    /** Optional local policy checks. */
    policy(ctx: RelayContext, sub: S, nowSeconds: number): void;
    /** Step 5 inputs: the signed fee and the gas-table mode. */
    fee(sub: S): { fee: bigint; mode: AuthModeName };
    deadline(sub: S): bigint;
    /** Tokens pulled from the signer (for pending-debit accounting and sender_busy). */
    reservation(ctx: RelayContext, sub: S): TokenReservation | undefined;
    /** hashStruct of the signed token authorization (`RequestState.authHash`): with the request it hashes to the id. */
    authHash(sub: S): Hex;
    /**
     * The request that a call of the contract executes when its signer's intent nonce is `nonce`: its id (the digest at
     * that nonce, as `typedData` gives it), the signer its signature recovers to there, and the relay it names (the
     * contract requires that relay as the caller). Undefined if the call is no call of this operation or its signature
     * does not recover. The contract verifies the signature at the signer's current nonce, and an ECDSA signature
     * recovers to the signer for one digest only: a successful call that recovers to the signer at `nonce` used exactly
     * that nonce. The transaction manager tells with it what used a request's nonce when no RPC shows the request's
     * receipt (quorum.findNonceUse).
     */
    executionOf(ctx: RelayContext, call: EncodedCall, nonce: bigint): Promise<{ id: Hex; signer: Address; relay: Address } | undefined>;
    readonly onchainChecks: {
        /** Step 4 (on-chain part): the signer's next intent nonce in the contract (`nonces(signer)`). */
        nextNonce(ctx: RelayContext, sub: S): Promise<bigint>;
        /** Step 6: balance and token state. */
        state(ctx: RelayContext, sub: S, usage: TokenUsage): Promise<StateFacts>;
        /** Step 7: token authorization (permit / meta-tx signature or allowance). */
        authorization(ctx: RelayContext, sub: S, usage: TokenUsage): Promise<AuthFacts>;
    };
    /**
     * Steps 8 and later broadcasts: the relay builds the call itself from validated fields. A successful receipt of a
     * relay transaction with this call proves that this request executed: the contract verifies the signature over the
     * signer's current nonce first, and the call carries exactly the signed fields and token authorization.
     */
    encodeCall(ctx: RelayContext, sub: S): EncodedCall;
    /** Public request fields for storage and `GET /v1/requests/:id`. */
    publicRequest(sub: S): unknown;
    /** Rebuilds a submission from storage (re-validated with `schema`). */
    restore(stored: { request: unknown; signature: Hex; authorization: NormalizedAuthorization }): S;
}

export class OperationRegistry {
    private readonly operations = new Map<string, OperationDefinition>();

    register<S extends Submission>(operation: OperationDefinition<S>): this {
        if (this.operations.has(operation.name)) throw new Error(`operation ${operation.name} registered twice`);
        this.operations.set(operation.name, operation as unknown as OperationDefinition);
        return this;
    }

    get(name: string): OperationDefinition | undefined {
        return this.operations.get(name);
    }

    names(): string[] {
        return [...this.operations.keys()];
    }
}

export const PRIORITY_NORMAL = 0;
/** Priority tier with reserved in-flight capacity. */
export const PRIORITY_EXIT = 10;
