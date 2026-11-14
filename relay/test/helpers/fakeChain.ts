// In-memory chain for unit tests. Contract reads are encoded and decoded with the real ABIs (so a
// wrong function name or argument fails like it would on a node); a single mempool with geth's
// replacement rule, explicit mining, finality and reorgs drive the transaction manager tests.
//
// GaslessTransfer is modelled where the relay depends on it: `nonces(signer)` (with history, for reads at a
// block), relayTransfer verifying the signature first over the signer's current nonce and the signed TokenAuth
// (InvalidSignature otherwise), then the token's mode and the deadline, and on success incrementing the
// nonce; `invalidateNonces` emitting NonceInvalidated(signer, previousNonce, newNonce). There is no transfer event.
import {
    ContractFunctionZeroDataError,
    decodeFunctionData,
    decodeFunctionResult,
    encodeAbiParameters,
    encodeErrorResult,
    encodeEventTopics,
    encodeFunctionData,
    encodeFunctionResult,
    hashTypedData,
    keccak256,
    parseTransaction,
    recoverAddress,
    recoverTransactionAddress,
    RpcRequestError,
    toHex,
    type Abi,
    type Address,
    type Hex,
} from 'viem';
import { TRANSFER_TYPES, gaslessTransferAbi, transferDomain, usdcAbi } from '@nimiq/gasless-sdk/core';
import type {
    BlockInfo,
    BlockTransaction,
    BlockWithTransactions,
    BroadcastOutcome,
    CallOutcome,
    CallParams,
    ChainClient,
    ChainLog,
    LogFilter,
    LogInfo,
    ReadContractCall,
    ReceiptInfo,
} from '../../src/chain/types.js';
import { hashDomain } from '../../src/eip712.js';
import type { Deployment } from '../../src/config.js';

export const GWEI = 1_000_000_000n;

export interface FakeToken {
    readonly kind: 'usdc' | 'usdt0';
    readonly address: Address;
    balances: Map<string, bigint>;
    allowances: Map<string, bigint>;
    paused: boolean;
    blacklisted: Set<string>;
    blocked: Set<string>;
    nonces: Map<string, bigint>;
    domainSeparator: Hex;
    decimals: number;
}

export interface PoolTx {
    readonly hash: Hex;
    readonly raw: Hex;
    readonly sender: string;
    readonly nonce: number;
    readonly to: Address | null;
    readonly data: Hex;
    readonly value: bigint;
    readonly gas: bigint;
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
}

export class RpcDownError extends Error {
    constructor(method: string) {
        super(`fake RPC unavailable (${method})`);
        this.name = 'RpcDownError';
    }
}

const lc = (a: string) => a.toLowerCase();

/** GaslessBase `TokenConfig`: all zero for a token that is not supported. */
export interface FakeTokenConfig {
    permit: boolean;
    metaTxApprove: boolean;
    allowance: boolean;
}

/** A change of `nonces(signer)` in block `block` (by transaction `tx`): for reads at earlier blocks and reorgs. */
interface NonceChange {
    readonly block: bigint;
    readonly signer: string;
    readonly previous: bigint;
    readonly tx: Hex;
}

/** GaslessBase.MAX_NONCE_INCREASE */
export const MAX_NONCE_INCREASE = 2n ** 32n - 1n;
/** How far from the signer's nonce the fake looks for the nonce a relayTransfer signature was made for. */
const SIGNED_NONCE_WINDOW = 8n;

export class FakeChain implements ChainClient {
    chainId = 137;
    head: BlockInfo;
    /** Finalized block number, or 'unsupported' to make the tag fail. */
    finalized: bigint | 'unsupported';
    maxPriorityFee = 30n * GWEI;
    readonly nativeBalances = new Map<string, bigint>();
    readonly codes = new Map<string, Hex>();
    readonly storage = new Map<string, Hex>();
    readonly tokens = new Map<string, FakeToken>();
    contract: {
        address: Address;
        domainSeparator: Hex;
        /** `nonces(signer)` now, by lower-case signer (0 when absent). Change it with setIntentNonce to keep history. */
        nonces: Map<string, bigint>;
        tokenConfig: Map<string, FakeTokenConfig>;
    };
    /** Changes of `nonces`, oldest first (reads at a block before a change answer its previous value). */
    readonly nonceChanges: NonceChange[] = [];
    /**
     * The block that created the contract (undefined: it always existed). A read of the contract at an earlier block
     * fails as viem's readContract does for an address without code (eth_call answers "0x").
     */
    contractCreatedAt: bigint | undefined;
    /**
     * The oldest block whose state the node keeps (undefined: every block). A read pinned to an older block fails as a
     * pruned node answers it: JSON-RPC error -32000 "missing trie node".
     */
    stateFrom: bigint | undefined;
    /**
     * By keccak256 of relayTransfer call data: the intent nonce its signature is valid for (null: none within
     * SIGNED_NONCE_WINDOW of the signer's nonce when it was checked). Learned where call data reaches the chain
     * (eth_call, eth_sendRawTransaction), since recovery is asynchronous and execution is not.
     */
    private readonly signedNonces = new Map<string, { nonce: bigint | null; around: bigint }>();
    feed: { address: Address; decimals: number; answer: bigint; updatedAt: bigint; description: string } | undefined;

    rpcDown = false;
    readonly failing = new Set<string>();
    readonly reads: string[] = [];
    readonly calls: Array<{ from: Address; to: Address; data: Hex }> = [];
    /** eth_call behaviour; the default executes relayTransfer checks against this fake state. */
    simulate: (call: { from: Address; to: Address; data: Hex }) => CallOutcome;
    estimate: (call: { from: Address; to: Address; data: Hex }) => bigint = () => 150_000n;

    readonly mempool = new Map<string, PoolTx>();
    readonly accountNonces = new Map<string, number>();
    readonly receipts = new Map<string, ReceiptInfo>();
    readonly mined = new Map<string, PoolTx>();
    /** The transactions of each block, in their order (eth_getBlockByNumber with transactions). */
    readonly blockTransactions = new Map<bigint, PoolTx[]>();
    /** Logs of the canonical chain (eth_getLogs): those of mined transactions, and NonceInvalidated events. */
    readonly logs: ChainLog[] = [];
    /**
     * The relay's per-RPC read clients (ChainClient.rpcClients). Unset: the relay has one RPC, this chain. Tests of
     * several RPCs set it, e.g. to `() => [chain, chain.rpcView()]`.
     */
    rpcClients: (() => readonly ChainClient[]) | undefined;
    readonly broadcasts: Hex[] = [];
    broadcastHook: ((raw: Hex) => void) | undefined;
    readonly forcedBroadcasts: BroadcastOutcome[] = [];
    /** Execution result of a mined transaction; the default reverts a relayTransfer the contract would revert. */
    executor: (tx: PoolTx) => 'success' | 'reverted' = (tx) => this.defaultExecute(tx);
    /** Whether a mempool transaction is picked up by the next block (e.g. to simulate a too-low tip). */
    includeFilter: (tx: PoolTx) => boolean = () => true;

    constructor(options: { deployment: Deployment; timestamp: number; relay: Address }) {
        const { deployment } = options;
        this.chainId = deployment.chainId;
        this.head = { number: 1000n, timestamp: BigInt(options.timestamp), baseFeePerGas: 30n * GWEI, hash: toHex(1000n, { size: 32 }) };
        this.finalized = 990n;
        this.contract = {
            address: deployment.gaslessTransfer,
            domainSeparator: hashDomain(transferDomain(deployment.chainId, deployment.gaslessTransfer)),
            nonces: new Map(),
            tokenConfig: new Map(),
        };
        this.codes.set(lc(deployment.gaslessTransfer), '0x6080');
        for (const t of deployment.tokens) {
            this.codes.set(lc(t.address), '0x6080');
            this.tokens.set(lc(t.address), {
                kind: t.kind,
                address: t.address,
                balances: new Map(),
                allowances: new Map(),
                paused: false,
                blacklisted: new Set(),
                blocked: new Set(),
                nonces: new Map(),
                domainSeparator: hashDomain(t.domain),
                decimals: 6,
            });
            this.contract.tokenConfig.set(lc(t.address), {
                permit: t.authModes.includes('permit'),
                metaTxApprove: t.authModes.includes('metaTxApprove'),
                allowance: t.authModes.includes('none'),
            });
        }
        this.nativeBalances.set(lc(options.relay), 10n ** 20n);
        this.simulate = (call) => this.defaultSimulate(call);
    }

    // ------------------------------------------------------------------------------------------
    // helpers for tests
    // ------------------------------------------------------------------------------------------

    token(address: string): FakeToken {
        const t = this.tokens.get(lc(address));
        if (!t) throw new Error(`fake: unknown token ${address}`);
        return t;
    }

    setBalance(token: string, owner: string, value: bigint): void {
        this.token(token).balances.set(lc(owner), value);
    }

    setAllowance(token: string, owner: string, spender: string, value: bigint): void {
        this.token(token).allowances.set(`${lc(owner)}:${lc(spender)}`, value);
    }

    setTokenNonce(token: string, owner: string, value: bigint): void {
        this.token(token).nonces.set(lc(owner), value);
    }

    /** GaslessTransfer `nonces(signer)` at the head (or, with `block`, at that block). */
    intentNonce(signer: string, block?: bigint): bigint {
        const who = lc(signer);
        if (block !== undefined) {
            const later = this.nonceChanges.find((c) => c.signer === who && c.block > block);
            if (later) return later.previous;
        }
        return this.contract.nonces.get(who) ?? 0n;
    }

    /** Sets `nonces(signer)` in the head block (by `tx`, for reorgs). */
    setIntentNonce(signer: string, value: bigint, tx: Hex = keccak256(toHex(`setIntentNonce:${lc(signer)}:${value}`))): void {
        const who = lc(signer);
        this.nonceChanges.push({ block: this.head.number, signer: who, previous: this.intentNonce(who), tx });
        this.contract.nonces.set(who, value);
    }

    /** The owner's `setTokenConfig(token, config)` (TokenConfigSet is not modelled: the relay does not read it). */
    setTokenConfig(token: string, config: Partial<FakeTokenConfig>): void {
        const current = this.contract.tokenConfig.get(lc(token)) ?? { permit: false, metaTxApprove: false, allowance: false };
        this.contract.tokenConfig.set(lc(token), { ...current, ...config });
    }

    private check(method: string): void {
        if (this.rpcDown || this.failing.has(method)) throw new RpcDownError(method);
    }

    /** When set, every RPC yields to the event loop like a network round trip, so requests interleave. */
    latency = false;

    private async rpc(method: string): Promise<void> {
        if (this.latency) await new Promise<void>((resolve) => setImmediate(resolve));
        this.check(method);
    }

    /** Advances one block and includes executable mempool transactions in nonce order. */
    mine(options: { timestampDelta?: number; baseFee?: bigint; include?: boolean } = {}): Hex[] {
        const number = this.head.number + 1n;
        const baseFee = options.baseFee ?? this.head.baseFeePerGas ?? 0n;
        this.head = {
            number,
            timestamp: this.head.timestamp + BigInt(options.timestampDelta ?? 2),
            baseFeePerGas: baseFee,
            hash: toHex(number, { size: 32 }),
        };
        const included: Hex[] = [];
        if (options.include === false) return included;
        const senders = new Set([...this.mempool.values()].map((t) => t.sender));
        for (const sender of senders) {
            let nonce = this.accountNonces.get(sender) ?? 0;
            for (;;) {
                const tx = this.mempool.get(`${sender}:${nonce}`);
                if (!tx || tx.maxFeePerGas < baseFee || !this.includeFilter(tx)) break;
                this.mempool.delete(`${sender}:${nonce}`);
                const status = this.executor(tx);
                const tip = tx.maxPriorityFeePerGas < tx.maxFeePerGas - baseFee ? tx.maxPriorityFeePerGas : tx.maxFeePerGas - baseFee;
                const logs = status === 'success' ? this.applyEffects(tx) : [];
                for (const log of logs) this.logs.push({ ...log, blockNumber: number, blockHash: this.head.hash, transactionHash: tx.hash });
                this.receipts.set(tx.hash, {
                    transactionHash: tx.hash,
                    blockNumber: number,
                    blockHash: this.head.hash,
                    status,
                    gasUsed: tx.gas < 120_000n ? tx.gas : 120_000n,
                    effectiveGasPrice: baseFee + tip,
                    logs,
                });
                this.mined.set(tx.hash, tx);
                this.blockTransactions.set(number, [...(this.blockTransactions.get(number) ?? []), tx]);
                nonce += 1;
                this.accountNonces.set(sender, nonce);
                included.push(tx.hash);
            }
        }
        return included;
    }

    mineBlocks(n: number, options: { timestampDelta?: number; include?: boolean } = {}): void {
        for (let i = 0; i < n; i++) this.mine(options);
    }

    /** Removes a mined transaction from its block and puts it back into the mempool. */
    reorg(hash: Hex): void {
        const tx = this.mined.get(hash);
        if (!tx) throw new Error('fake: not mined');
        for (const [number, txs] of this.blockTransactions) {
            if (txs.includes(tx)) this.blockTransactions.set(number, txs.filter((t) => t !== tx));
        }
        this.receipts.delete(hash);
        this.mined.delete(hash);
        this.accountNonces.set(tx.sender, tx.nonce);
        this.mempool.set(`${tx.sender}:${tx.nonce}`, tx);
        this.undoNonceChanges(hash);
        for (let i = this.logs.length - 1; i >= 0; i--) if (this.logs[i]!.transactionHash === hash) this.logs.splice(i, 1);
    }

    /** Reverts the `nonces` changes of transaction `hash` (a reorg; also for a test that removes an invalidateNonces). */
    undoNonceChanges(hash: Hex): void {
        for (let i = this.nonceChanges.length - 1; i >= 0; i--) {
            const change = this.nonceChanges[i]!;
            if (change.tx !== hash) continue;
            this.contract.nonces.set(change.signer, change.previous);
            this.nonceChanges.splice(i, 1);
        }
    }

    dropMempool(): void {
        this.mempool.clear();
    }

    /** Includes a transaction from outside the relay (e.g. the key used elsewhere) at `nonce`. */
    consumeNonce(sender: string, nonce: number): void {
        this.accountNonces.set(lc(sender), nonce + 1);
        this.mempool.delete(`${lc(sender)}:${nonce}`);
    }

    /**
     * GaslessBase.invalidateNonces(newNonce) sent by `signer`, included in the head block: every nonce from the signer's
     * current nonce up to `newNonce` (exclusive) is used, and the contract emits NonceInvalidated(signer, current,
     * newNonce). Reverts (throws) unless current < newNonce <= current + MAX_NONCE_INCREASE, like the contract.
     * `newNonce` defaults to current + 1.
     */
    invalidateNonces(signer: Address, newNonce?: bigint): Hex {
        const current = this.intentNonce(signer);
        const next = newNonce ?? current + 1n;
        if (next <= current || next - current > MAX_NONCE_INCREASE) throw new Error(`fake: InvalidNonceIncrease(${current}, ${next})`);
        const transactionHash = keccak256(toHex(`invalidateNonces:${lc(signer)}:${current}:${next}:${this.head.number}`));
        this.setIntentNonce(signer, next, transactionHash);
        const topics = encodeEventTopics({ abi: gaslessTransferAbi, eventName: 'NonceInvalidated', args: { signer } }) as Hex[];
        const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [current, next]);
        this.logs.push({ address: this.contract.address, topics, data, blockNumber: this.head.number, blockHash: this.head.hash, transactionHash });
        return transactionHash;
    }

    /**
     * Another RPC in front of the same chain (for the relay's per-RPC reads): it answers from the chain's true
     * state, ignoring methods a test replaced on this object (e.g. a lying `getTransactionReceipt`). `feedAnswer`
     * makes it report another POL/USD answer.
     */
    rpcView(options: { feedAnswer?: bigint } = {}): ChainClient {
        const proto = FakeChain.prototype;
        const self = this as FakeChain;
        return {
            getChainId: () => proto.getChainId.call(self),
            getBlock: (tag) => proto.getBlock.call(self, tag),
            getBlockByNumber: (number) => proto.getBlockByNumber.call(self, number),
            getBlockWithTransactions: (number) => proto.getBlockWithTransactions.call(self, number),
            getMaxPriorityFeePerGas: () => proto.getMaxPriorityFeePerGas.call(self),
            getBalance: (address) => proto.getBalance.call(self, address),
            getCode: (address) => proto.getCode.call(self, address),
            getStorageAt: (address, slot) => proto.getStorageAt.call(self, address, slot),
            getTransactionCount: (address, tag) => proto.getTransactionCount.call(self, address, tag),
            readContract: async <T>(call: ReadContractCall): Promise<T> => {
                const feed = self.feed;
                if (options.feedAnswer !== undefined && feed && lc(call.address) === lc(feed.address) && call.functionName === 'latestRoundData') {
                    await proto.getChainId.call(self); // same availability as the chain
                    return [1n, options.feedAnswer, feed.updatedAt, feed.updatedAt, 1n] as T;
                }
                return proto.readContract.call(self, call) as Promise<T>;
            },
            call: async (params: CallParams) => {
                await proto.getChainId.call(self);
                await self.learnSignature(params);
                return self.defaultSimulate(params);
            },
            estimateGas: (params) => proto.estimateGas.call(self, params),
            sendRawTransaction: (raw) => proto.sendRawTransaction.call(self, raw),
            getTransactionReceipt: (hash) => proto.getTransactionReceipt.call(self, hash),
            getBlockReceipts: (number) => proto.getBlockReceipts.call(self, number),
            getLogs: (filter) => proto.getLogs.call(self, filter),
        };
    }

    /** The arguments of a relayTransfer call to the contract: request (without nonce), signature, token authorization. */
    decodeRelayTransfer(tx: { to: Address | null; data: Hex }) {
        if (!tx.to || lc(tx.to) !== lc(this.contract.address)) return undefined;
        try {
            const { functionName, args } = decodeFunctionData({ abi: gaslessTransferAbi, data: tx.data });
            if (functionName !== 'relayTransfer') return undefined;
            const [request, signature, auth] = args;
            return { request, signature, auth };
        } catch {
            return undefined;
        }
    }

    /**
     * Learns which intent nonce the signature of relayTransfer call data is valid for (the contract's EIP-712 digest,
     * version "3", with the nested TokenAuth), trying the signer's current nonce first. Called where call data
     * reaches the chain, so that execution (synchronous) can check it.
     */
    async learnSignature(call: { to: Address | null; data: Hex }): Promise<void> {
        const decoded = this.decodeRelayTransfer(call);
        if (!decoded) return;
        const key = keccak256(call.data);
        const current = this.intentNonce(decoded.request.from);
        const known = this.signedNonces.get(key);
        if (known && (known.nonce !== null || known.around === current)) return;
        const recovers = async (nonce: bigint) => {
            const digest = hashTypedData({
                domain: transferDomain(this.chainId, this.contract.address) as never,
                types: TRANSFER_TYPES,
                primaryType: 'GaslessTransfer',
                message: { ...decoded.request, nonce, auth: decoded.auth },
            });
            try {
                return lc(await recoverAddress({ hash: digest, signature: decoded.signature })) === lc(decoded.request.from);
            } catch {
                return false;
            }
        };
        const low = current > SIGNED_NONCE_WINDOW ? current - SIGNED_NONCE_WINDOW : 0n;
        for (const nonce of [current, ...Array.from({ length: Number(2n * SIGNED_NONCE_WINDOW + 1n) }, (_, i) => low + BigInt(i))]) {
            if (await recovers(nonce)) {
                this.signedNonces.set(key, { nonce, around: current });
                return;
            }
        }
        this.signedNonces.set(key, { nonce: null, around: current });
    }

    /** The revert relayTransfer call data would cause at the head, or undefined (the contract's order of checks). */
    relayTransferRevert(data: Hex): { errorName: string; args: readonly unknown[] } | undefined {
        const decoded = this.decodeRelayTransfer({ to: this.contract.address, data });
        if (!decoded) return undefined;
        const { request: r, auth } = decoded;
        const signed = this.signedNonces.get(keccak256(data));
        if (!signed) throw new Error('fake: relayTransfer call data reached execution without learnSignature');
        if (signed.nonce === null || signed.nonce !== this.intentNonce(r.from)) return { errorName: 'InvalidSignature', args: [] };
        const config = this.contract.tokenConfig.get(lc(r.token)) ?? { permit: false, metaTxApprove: false, allowance: false };
        const enabled = auth.mode === 1 ? config.permit : auth.mode === 2 ? config.metaTxApprove : config.allowance;
        if (!enabled) {
            if (!config.permit && !config.metaTxApprove && !config.allowance) return { errorName: 'TokenNotSupported', args: [r.token] };
            return { errorName: 'AuthModeNotSupported', args: [r.token, auth.mode] };
        }
        if (this.head.timestamp > r.deadline) return { errorName: 'DeadlineExpired', args: [r.deadline] };
        return undefined;
    }

    /**
     * Execution of a mined transaction: a relayTransfer whose signature is not valid at the signer's current nonce,
     * or for a disabled mode, reverts (the deadline is not checked at inclusion).
     */
    defaultExecute(tx: PoolTx): 'success' | 'reverted' {
        const revert = this.relayTransferRevert(tx.to && lc(tx.to) === lc(this.contract.address) ? tx.data : '0x');
        return revert && revert.errorName !== 'DeadlineExpired' ? 'reverted' : 'success';
    }

    private applyEffects(tx: PoolTx): LogInfo[] {
        const decoded = this.decodeRelayTransfer(tx);
        if (!decoded) return [];
        const r = decoded.request;
        this.setIntentNonce(r.from, this.intentNonce(r.from) + 1n, tx.hash);
        const token = this.tokens.get(lc(r.token));
        if (!token) return [];
        const from = lc(r.from);
        token.balances.set(from, (token.balances.get(from) ?? 0n) - r.amount - r.fee);
        token.balances.set(lc(r.to), (token.balances.get(lc(r.to)) ?? 0n) + r.amount);
        token.balances.set(lc(r.relay), (token.balances.get(lc(r.relay)) ?? 0n) + r.fee);
        // The token's Transfer events, the fee first (D13); GaslessTransfer emits nothing.
        const transfer = (to: Address, value: bigint): LogInfo => ({
            address: token.address,
            topics: encodeEventTopics({ abi: usdcAbi, eventName: 'Transfer', args: { from: r.from, to } }) as Hex[],
            data: encodeAbiParameters([{ type: 'uint256' }], [value]),
        });
        return [transfer(r.relay, r.fee), transfer(r.to, r.amount)];
    }

    /** relayTransfer checks that matter for re-simulation: signature at the current nonce, token config, deadline. */
    defaultSimulate(call: { from: Address; to: Address; data: Hex }): CallOutcome {
        const revert = this.relayTransferRevert(lc(call.to) === lc(this.contract.address) ? call.data : '0x');
        if (!revert) return { ok: true, data: '0x' };
        return {
            ok: false,
            revertData: encodeErrorResult({ abi: gaslessTransferAbi, errorName: revert.errorName, args: revert.args } as never),
            message: 'execution reverted',
        };
    }

    // ------------------------------------------------------------------------------------------
    // ChainClient
    // ------------------------------------------------------------------------------------------

    async getChainId(): Promise<number> {
        await this.rpc('getChainId');
        return this.chainId;
    }

    async getBlockNumber(): Promise<bigint> {
        await this.rpc('getBlockNumber');
        return this.head.number;
    }

    async getBlock(tag: 'latest' | 'finalized'): Promise<BlockInfo> {
        await this.rpc('getBlock');
        if (tag === 'latest') return this.head;
        if (this.finalized === 'unsupported') throw new Error('unsupported block tag');
        return { number: this.finalized, timestamp: 0n, baseFeePerGas: null, hash: toHex(this.finalized, { size: 32 }) };
    }

    /** Block numbers whose canonical block is not the one the receipts name (a same-height reorg). */
    readonly nonCanonical = new Set<bigint>();

    async getBlockByNumber(number: bigint): Promise<BlockInfo | null> {
        await this.rpc('getBlockByNumber');
        if (number > this.head.number || number < 0n) return null;
        const hash = this.nonCanonical.has(number) ? keccak256(toHex(number, { size: 32 })) : toHex(number, { size: 32 });
        return { number, timestamp: this.head.timestamp - 2n * (this.head.number - number), baseFeePerGas: this.head.baseFeePerGas, hash };
    }

    async getBlockWithTransactions(number: bigint): Promise<BlockWithTransactions | null> {
        await this.rpc('getBlockWithTransactions');
        const block = await FakeChain.prototype.getBlockByNumber.call(this, number);
        if (!block) return null;
        const transactions = (this.blockTransactions.get(number) ?? []).map(
            (tx): BlockTransaction => ({
                hash: tx.hash,
                from: tx.sender as Address,
                to: tx.to,
                input: tx.data,
                blockHash: this.receipts.get(tx.hash)?.blockHash ?? toHex(number, { size: 32 }),
                gas: tx.gas,
                maxFeePerGas: tx.maxFeePerGas,
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            }),
        );
        return { ...block, transactions };
    }

    async getMaxPriorityFeePerGas(): Promise<bigint> {
        await this.rpc('getMaxPriorityFeePerGas');
        return this.maxPriorityFee;
    }

    async getBalance(address: Address): Promise<bigint> {
        await this.rpc('getBalance');
        return this.nativeBalances.get(lc(address)) ?? 0n;
    }

    async getCode(address: Address): Promise<Hex | undefined> {
        await this.rpc('getCode');
        return this.codes.get(lc(address));
    }

    async getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined> {
        await this.rpc('getStorageAt');
        return this.storage.get(`${lc(address)}:${slot.toLowerCase()}`);
    }

    async getTransactionCount(address: Address, blockTag: 'latest' | 'pending'): Promise<number> {
        await this.rpc('getTransactionCount');
        const sender = lc(address);
        const latest = this.accountNonces.get(sender) ?? 0;
        if (blockTag === 'latest') return latest;
        let pending = latest;
        while (this.mempool.has(`${sender}:${pending}`)) pending += 1;
        return pending;
    }

    async readContract<T>(call: ReadContractCall): Promise<T> {
        await this.rpc('readContract');
        this.check(`read:${call.functionName}`);
        const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);
        const decoded = decodeFunctionData({ abi: call.abi, data }) as { functionName: string; args?: readonly unknown[] };
        this.reads.push(`${lc(call.address)}:${decoded.functionName}`);
        if (call.blockNumber !== undefined && this.stateFrom !== undefined && call.blockNumber < this.stateFrom) {
            throw new RpcRequestError({ body: {}, url: 'fake', error: { code: -32000, message: `missing trie node (state of block ${call.blockNumber} pruned)` } });
        }
        if (lc(call.address) === lc(this.contract.address) && call.blockNumber !== undefined && this.contractCreatedAt !== undefined && call.blockNumber < this.contractCreatedAt) {
            throw new ContractFunctionZeroDataError({ functionName: decoded.functionName });
        }
        const result = this.readValue(call.address, decoded.functionName, decoded.args ?? [], call.blockNumber);
        const encoded = encodeFunctionResult({ abi: call.abi as Abi, functionName: decoded.functionName, result } as never);
        return decodeFunctionResult({ abi: call.abi as Abi, functionName: decoded.functionName, data: encoded } as never) as T;
    }

    private readValue(address: Address, fn: string, args: readonly unknown[], block?: bigint): unknown {
        const a = lc(address);
        if (a === lc(this.contract.address)) {
            switch (fn) {
                case 'nonces':
                    return this.intentNonce(args[0] as string, block);
                case 'DOMAIN_SEPARATOR':
                    return this.contract.domainSeparator;
                case 'tokenConfig':
                    return this.contract.tokenConfig.get(lc(args[0] as string)) ?? { permit: false, metaTxApprove: false, allowance: false };
                default:
                    throw new Error(`fake: contract.${fn} not implemented`);
            }
        }
        if (this.feed && a === lc(this.feed.address)) {
            switch (fn) {
                case 'decimals':
                    return this.feed.decimals;
                case 'description':
                    return this.feed.description;
                case 'latestRoundData':
                    return [1n, this.feed.answer, this.feed.updatedAt, this.feed.updatedAt, 1n];
                default:
                    throw new Error(`fake: feed.${fn} not implemented`);
            }
        }
        const token = this.tokens.get(a);
        if (!token) throw new Error(`fake: no contract at ${address}`);
        const who = (i: number) => lc(args[i] as string);
        switch (fn) {
            case 'balanceOf':
                return token.balances.get(who(0)) ?? 0n;
            case 'allowance':
                return token.allowances.get(`${who(0)}:${who(1)}`) ?? 0n;
            case 'nonces':
            case 'getNonce':
                return token.nonces.get(who(0)) ?? 0n;
            case 'paused':
                if (token.kind !== 'usdc') throw new Error('fake: USDT0 has no paused()');
                return token.paused;
            case 'isBlacklisted':
                if (token.kind !== 'usdc') throw new Error('fake: USDT0 has no isBlacklisted()');
                return token.blacklisted.has(who(0));
            case 'isBlocked':
                if (token.kind !== 'usdt0') throw new Error('fake: USDC has no isBlocked()');
                return token.blocked.has(who(0));
            case 'DOMAIN_SEPARATOR':
                return token.domainSeparator;
            case 'decimals':
                return token.decimals;
            default:
                throw new Error(`fake: token.${fn} not implemented`);
        }
    }

    async call(params: { from: Address; to: Address; data: Hex }): Promise<CallOutcome> {
        await this.rpc('call');
        this.calls.push(params);
        await this.learnSignature(params);
        return this.simulate(params);
    }

    async estimateGas(params: { from: Address; to: Address; data: Hex }): Promise<bigint> {
        await this.rpc('estimateGas');
        return this.estimate(params);
    }

    async sendRawTransaction(raw: Hex): Promise<BroadcastOutcome> {
        if (this.rpcDown) return { kind: 'error', message: 'fake RPC unavailable' };
        this.broadcasts.push(raw);
        this.broadcastHook?.(raw);
        const forced = this.forcedBroadcasts.shift();
        if (forced) return forced;
        const tx = parseTransaction(raw);
        const sender = lc(await recoverTransactionAddress({ serializedTransaction: raw as never }));
        await this.learnSignature({ to: tx.to ?? null, data: tx.data ?? '0x' });
        const hash = keccak256(raw);
        if (this.receipts.has(hash)) return { kind: 'known' };
        const nonce = tx.nonce ?? 0;
        if (nonce < (this.accountNonces.get(sender) ?? 0)) return { kind: 'nonce_too_low' };
        const key = `${sender}:${nonce}`;
        const existing = this.mempool.get(key);
        const maxFeePerGas = tx.maxFeePerGas ?? 0n;
        const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? 0n;
        if (existing) {
            if (existing.hash === hash) return { kind: 'known' };
            if (maxFeePerGas * 100n < existing.maxFeePerGas * 110n || maxPriorityFeePerGas * 100n < existing.maxPriorityFeePerGas * 110n) {
                return { kind: 'underpriced' };
            }
        }
        this.mempool.set(key, {
            hash,
            raw,
            sender,
            nonce,
            to: tx.to ?? null,
            data: tx.data ?? '0x',
            value: tx.value ?? 0n,
            gas: tx.gas ?? 0n,
            maxFeePerGas,
            maxPriorityFeePerGas,
        });
        return { kind: 'accepted' };
    }

    async getTransactionReceipt(hash: Hex): Promise<ReceiptInfo | null> {
        await this.rpc('getTransactionReceipt');
        if (this.unservedReceipts.has(hash)) return null;
        return this.receipts.get(hash) ?? null;
    }

    /**
     * Transactions whose receipt eth_getTransactionReceipt does not answer (a node whose transaction index lags), on this
     * chain and every rpcView; eth_getBlockReceipts still lists them. Deleting from `receipts` hides them from both.
     */
    readonly unservedReceipts = new Set<string>();

    /**
     * eth_getBlockReceipts: the receipts in `receipts` of the block's transactions, in block order (a receipt a test
     * deleted is missing here too). `failing.has('getBlockReceipts')` refuses the method.
     */
    async getBlockReceipts(number: bigint): Promise<readonly ReceiptInfo[] | null> {
        await this.rpc('getBlockReceipts');
        if (number > this.head.number || number < 0n) return null;
        return (this.blockTransactions.get(number) ?? []).flatMap((tx) => {
            const receipt = this.receipts.get(tx.hash);
            return receipt && receipt.blockNumber === number ? [receipt] : [];
        });
    }

    /** eth_getLogs over `logs` (topics by position: null matches anything, a list any of its values). */
    async getLogs(filter: LogFilter): Promise<readonly ChainLog[]> {
        await this.rpc('getLogs');
        const matches = (want: Hex | readonly Hex[] | null | undefined, have: Hex | undefined): boolean => {
            if (want === null || want === undefined) return true;
            if (have === undefined) return false;
            return (typeof want === 'string' ? [want] : want).some((w) => lc(w) === lc(have));
        };
        return this.logs.filter(
            (log) =>
                lc(log.address) === lc(filter.address) &&
                log.blockNumber >= filter.fromBlock &&
                log.blockNumber <= filter.toBlock &&
                filter.topics.every((want, i) => matches(want, log.topics[i])),
        );
    }
}
