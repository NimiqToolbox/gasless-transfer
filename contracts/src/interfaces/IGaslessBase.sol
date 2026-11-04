// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";

// Protocol types shared by the contract and SDK. Keep ABI and typed-data definitions synchronized.

/// @notice How the contract obtains the token allowance for a request.
enum AuthMode {
    NONE,
    PERMIT,
    META_TX_APPROVE
}

/// @notice The owner's token signature (EIP-2612 permit or USDT0 meta-tx approve), signed into the intent as the
///         EIP-712 struct `TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)`. v, r and s are unused for NONE; clients
///         sign zeros there.
struct TokenAuth {
    AuthMode mode;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

/// @notice Per-token configuration, one storage slot. `allowance` enables AuthMode.NONE. A token with no mode enabled
///         is not supported. There is no fee cap: the fee is what `from` signs.
struct TokenConfig {
    bool permit;
    bool metaTxApprove;
    bool allowance;
}

/// @notice Constructor input: a token and its configuration.
struct TokenInit {
    address token;
    TokenConfig config;
}

/// @notice Shared base of the gasless contracts: EIP-712 domain, sequential nonces, owner-managed token configuration.
///         The contract also exposes OpenZeppelin Ownable2Step (owner, pendingOwner, transferOwnership,
///         acceptOwnership, renounceOwnership and their events); they are not repeated here because the compiler
///         rejects an event that a base contract declares again.
interface IGaslessBase is IERC5267 {
    /// @notice Every nonce in [previousNonce, newNonce) of `signer` was invalidated.
    event NonceInvalidated(address indexed signer, uint256 previousNonce, uint256 newNonce);
    /// @notice The configuration of `token` was added, replaced or (no mode enabled) removed.
    event TokenConfigSet(address indexed token, TokenConfig config);

    error InvalidConfig();
    error NotRelay(address caller, address relay);
    error DeadlineExpired(uint256 deadline);
    error InvalidSigner();
    error InvalidSignature();
    error InvalidNonceIncrease(uint256 currentNonce, uint256 newNonce);
    error TokenNotSupported(address token);
    error AuthModeNotSupported(address token, AuthMode mode);
    error InsufficientAllowance(uint256 allowance, uint256 required);
    error ZeroAmount();
    error InvalidRecipient(address to);

    /// @notice The EIP-712 type of TokenAuth. A signed request type that contains a TokenAuth includes it among its
    ///         referenced struct types, which EIP-712 appends to the primary type sorted by name. It comes last only
    ///         if no other referenced struct name sorts after "TokenAuth" (GaslessTransfer references no other).
    function TOKEN_AUTH_TYPE() external view returns (string memory);

    function TOKEN_AUTH_TYPEHASH() external view returns (bytes32);

    /// @notice The nonce the next request of `signer` must be signed with.
    function nonces(address signer) external view returns (uint256);

    function tokenConfig(address token) external view returns (TokenConfig memory);

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice Raises msg.sender's next nonce to `newNonce`, so that no request signed for a lower nonce can execute.
    ///         `newNonce` must be above the current nonce by at least 1 and at most 2^32 - 1.
    function invalidateNonces(uint256 newNonce) external;

    /// @notice Owner only. Adds `token` or replaces its configuration; a configuration without any mode removes it. The
    ///         new configuration applies to every later call, also of requests signed and refused before. It sets no
    ///         fee bound: the fee of a request is the one `from` signed.
    function setTokenConfig(address token, TokenConfig calldata config) external;
}
