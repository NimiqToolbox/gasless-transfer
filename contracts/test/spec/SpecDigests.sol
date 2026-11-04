// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

/// @notice EIP-712 digests exactly as docs/STEP-1-GAS-ABSTRACTION.md §4.3 and §5 define them, computed without the
///         contract under test. Shared by the spec tests and the invariant handler.
library SpecDigests {
    string internal constant DOMAIN_NAME = "Nimiq Gasless Transfer";
    string internal constant DOMAIN_VERSION = "3";

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant SALT_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");
    string internal constant TRANSFER_TYPE =
        "GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)";
    string internal constant TOKEN_AUTH_TYPE = "TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)";
    bytes32 internal constant TRANSFER_TYPEHASH = keccak256(bytes(TRANSFER_TYPE));
    bytes32 internal constant TOKEN_AUTH_TYPEHASH = keccak256(bytes(TOKEN_AUTH_TYPE));
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant META_TX_TYPEHASH =
        keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");
    bytes4 internal constant APPROVE_SELECTOR = 0x095ea7b3;

    /// @dev ("Nimiq Gasless Transfer", "3", chainId, verifyingContract)
    function transferDomain(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                chainId,
                verifyingContract
            )
        );
    }

    function tokenAuthStructHash(TokenAuth memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(TOKEN_AUTH_TYPEHASH, uint8(a.mode), a.v, a.r, a.s));
    }

    function transferStructHash(TransferRequest memory r, uint256 nonce, TokenAuth memory a)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                TRANSFER_TYPEHASH,
                r.token,
                r.from,
                r.to,
                r.amount,
                r.fee,
                r.relay,
                nonce,
                r.deadline,
                tokenAuthStructHash(a)
            )
        );
    }

    function transferDigest(
        TransferRequest memory r,
        uint256 nonce,
        TokenAuth memory a,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return typedDataHash(transferDomain(chainId, verifyingContract), transferStructHash(r, nonce, a));
    }

    /// @dev USDC (FiatTokenV2_2): ("USD Coin", "2", chainId, token)
    function usdcDomain(uint256 chainId, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("USD Coin"), keccak256("2"), chainId, token));
    }

    /// @dev USDT0 (UChildUSDT0): ("USDT0", "1", token, bytes32(chainId)), salt domain without a chainId field
    function usdt0Domain(uint256 saltChainId, address token) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(SALT_DOMAIN_TYPEHASH, keccak256("USDT0"), keccak256("1"), token, bytes32(saltChainId)));
    }

    function permitDigest(
        bytes32 tokenDomain,
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return typedDataHash(
            tokenDomain, keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline))
        );
    }

    function approveCalldata(address spender, uint256 value) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(APPROVE_SELECTOR, spender, value);
    }

    function metaTxDigest(bytes32 tokenDomain, address owner, bytes memory functionSignature, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return typedDataHash(
            tokenDomain, keccak256(abi.encode(META_TX_TYPEHASH, nonce, owner, keccak256(functionSignature)))
        );
    }

    function typedDataHash(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
