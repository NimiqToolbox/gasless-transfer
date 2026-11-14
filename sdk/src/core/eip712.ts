// Zero-dependency EIP-712 hashing for the SDK's typed data (GaslessTransfer with its nested TokenAuth,
// Permit, MetaTransaction). Used by the core to compute request ids and token domain separators without
// viem or ethers; tests compare every result with viem and ethers v5/v6, and the T30 golden vectors
// compare it with the contract's `hashTransfer`.

import { bytesToHex, concatBytes, hexToBytes, uint256Word, utf8Bytes } from './bytes.js';
import { keccak256 } from './keccak.js';
import { buildTransferTypedData, tokenAuthMessage, TRANSFER_TYPES } from './typedData.js';
import type { Address, Hex, TokenAuthorization, TransferRequest, TypedDataDomain, TypedDataField } from './types.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^[0-9]{1,78}$/;
const UINT_TYPE_RE = /^uint(8|16|32|64|128|256)$/;

type Types = Readonly<Record<string, readonly TypedDataField[]>>;

function keccakText(text: string): Uint8Array {
    return keccak256(utf8Bytes(text));
}

function addressWord(value: unknown, field: string): Uint8Array {
    if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw new TypeError(`${field}: expected an address`);
    return concatBytes(new Uint8Array(12), hexToBytes(value, field));
}

function uintWord(value: unknown, field: string, bits = 256): Uint8Array {
    let n: bigint;
    if (typeof value === 'bigint') n = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
    else if (typeof value === 'string' && UINT_RE.test(value)) n = BigInt(value);
    else throw new TypeError(`${field}: expected a uint${bits}`);
    if (n < 0n || n >> BigInt(bits) !== 0n) throw new TypeError(`${field}: out of uint${bits} range`);
    return uint256Word(n);
}

function bytes32Word(value: unknown, field: string): Uint8Array {
    if (typeof value !== 'string' || !BYTES32_RE.test(value)) throw new TypeError(`${field}: expected bytes32`);
    return hexToBytes(value, field);
}

/** The struct types `type` references, directly or indirectly (EIP-712 `encodeType` dependencies). */
function dependencies(types: Types, type: string, found: Set<string> = new Set()): Set<string> {
    if (found.has(type)) return found;
    const fields = types[type];
    if (fields === undefined) return found;
    found.add(type);
    for (const field of fields) dependencies(types, field.type, found);
    return found;
}

/** EIP-712 `encodeType`: the primary type, then its dependencies sorted by name. */
function encodeType(types: Types, primaryType: string): string {
    const deps = [...dependencies(types, primaryType)].filter((name) => name !== primaryType).sort();
    return [primaryType, ...deps]
        .map((name) => `${name}(${(types[name] ?? []).map((f) => `${f.type} ${f.name}`).join(',')})`)
        .join('');
}

/** EIP-712 `encodeData` word of one field: an atomic value, or the hashStruct of a nested struct. */
function encodeField(types: Types, type: string, value: unknown, field: string): Uint8Array {
    if (types[type] !== undefined) return hashStruct(types, type, value, field);
    const uint = UINT_TYPE_RE.exec(type);
    if (uint !== null) return uintWord(value, field, Number(uint[1]));
    switch (type) {
        case 'address':
            return addressWord(value, field);
        case 'bytes32':
            return bytes32Word(value, field);
        case 'bytes':
            if (typeof value !== 'string') throw new TypeError(`${field}: expected hex bytes`);
            return keccak256(hexToBytes(value, field));
        case 'string':
            if (typeof value !== 'string') throw new TypeError(`${field}: expected a string`);
            return keccakText(value);
        default:
            throw new TypeError(`${field}: unsupported EIP-712 type ${type}`);
    }
}

function hashStruct(types: Types, type: string, value: unknown, field: string): Uint8Array {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field}: expected an object`);
    const record = value as Record<string, unknown>;
    const fields = types[type] ?? [];
    return keccak256(
        concatBytes(keccakText(encodeType(types, type)), ...fields.map((f) => encodeField(types, f.type, record[f.name], `${field}.${f.name}`))),
    );
}

/**
 * EIP-712 domain separator. The `EIP712Domain` type contains exactly the fields present, in the
 * order name, version, chainId, verifyingContract, salt (as in viem and ethers).
 */
export function hashDomain(domain: TypedDataDomain): Hex {
    const fields: string[] = ['string name', 'string version'];
    const words: Uint8Array[] = [keccakText(stringField(domain.name, 'domain.name')), keccakText(stringField(domain.version, 'domain.version'))];
    if (domain.chainId !== undefined) {
        fields.push('uint256 chainId');
        words.push(uintWord(domain.chainId, 'domain.chainId'));
    }
    fields.push('address verifyingContract');
    words.push(addressWord(domain.verifyingContract, 'domain.verifyingContract'));
    if (domain.salt !== undefined) {
        fields.push('bytes32 salt');
        words.push(bytes32Word(domain.salt, 'domain.salt'));
    }
    const typeHash = keccakText(`EIP712Domain(${fields.join(',')})`);
    return bytesToHex(keccak256(concatBytes(typeHash, ...words)));
}

function stringField(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new TypeError(`${field}: expected a string`);
    return value;
}

/**
 * EIP-712 digest (`keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`) of a payload whose types are
 * structs of atomic fields (address, uintN, bytes32, bytes, string) and of other structs in `types`. This covers
 * every payload the SDK builds; arrays and other types are rejected.
 */
export function typedDataDigest(payload: {
    readonly domain: TypedDataDomain;
    readonly types: Types;
    readonly primaryType: string;
    readonly message: unknown;
}): Hex {
    if (payload.types[payload.primaryType] === undefined || Object.prototype.hasOwnProperty.call(payload.types, 'EIP712Domain')) {
        throw new TypeError('typedDataDigest: the primary type must be in types, and EIP712Domain must not');
    }
    const used = dependencies(payload.types, payload.primaryType);
    if (Object.keys(payload.types).some((name) => !used.has(name))) {
        throw new TypeError('typedDataDigest: every type must be the primary type or one it references');
    }
    const structHash = hashStruct(payload.types, payload.primaryType, payload.message, 'message');
    return bytesToHex(keccak256(concatBytes(new Uint8Array([0x19, 0x01]), hexToBytes(hashDomain(payload.domain)), structHash)));
}

/**
 * `hashStruct(TokenAuth)` of a token authorization: the `auth` word of the signed message. It identifies the
 * authorization without revealing its signature (`TransferVersion.authHash`, the relay's `RequestState.authHash`).
 */
export function tokenAuthHash(authorization: TokenAuthorization): Hex {
    return bytesToHex(hashStruct(TRANSFER_TYPES, 'TokenAuth', tokenAuthMessage(authorization), 'authorization'));
}

/**
 * The EIP-712 digest of a `GaslessTransfer` request at its nonce with its token authorization: equal to the
 * contract's `hashTransfer(r, nonce, auth)` and to the relay request id.
 */
export function transferDigest(chainId: number, verifyingContract: Address, request: TransferRequest, authorization: TokenAuthorization): Hex {
    return typedDataDigest(buildTransferTypedData(chainId, verifyingContract, request, authorization));
}

/**
 * `transferDigest` from the request and `tokenAuthHash` of its token authorization: the id of a version without
 * its token signature (`TransferVersion`).
 */
export function transferDigestFromAuthHash(chainId: number, verifyingContract: Address, request: TransferRequest, authHash: Hex): Hex {
    // Built with a placeholder authorization, which checks and normalizes the other fields; its word is replaced.
    const { domain, message } = buildTransferTypedData(chainId, verifyingContract, request, PLACEHOLDER_AUTH);
    const fields = message as unknown as Record<string, unknown>;
    const words = TRANSFER_TYPES.GaslessTransfer.map((f) =>
        f.type === 'TokenAuth' ? bytes32Word(authHash, 'authHash') : encodeField(TRANSFER_TYPES, f.type, fields[f.name], `message.${f.name}`),
    );
    const structHash = keccak256(concatBytes(keccakText(encodeType(TRANSFER_TYPES, 'GaslessTransfer')), ...words));
    return bytesToHex(keccak256(concatBytes(new Uint8Array([0x19, 0x01]), hexToBytes(hashDomain(domain)), structHash)));
}

const PLACEHOLDER_AUTH: TokenAuthorization = { mode: 'none', v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };
