// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {AuthMode, IGaslessBase, TokenConfig, TokenInit} from "../interfaces/IGaslessBase.sol";

/// @notice Shared base of the gasless contracts (docs/STEP-1-GAS-ABSTRACTION.md §4.2): own EIP-712 domain, sequential
///         per-signer nonces and a per-token configuration that only the owner (Ownable2Step) can change. The owner
///         has no other power: it cannot move tokens, touch nonces or alter a signed request. A configuration change
///         can make a signed request fail, or executable if an earlier configuration refused it: a signed request
///         stays valid until its nonce is used or its deadline passes. There is no pause, upgrade or rescue. The
///         reentrancy guard keeps its flag in transient storage (EIP-1153, Cancun; Polygon PoS and Amoy have it).
abstract contract GaslessBase is IGaslessBase, EIP712, ReentrancyGuardTransient, Ownable2Step {
    /// @notice The EIP-712 type of the token authorization (TokenAuth). A signed request type that carries one lists it
    ///         among its referenced struct types, which EIP-712 appends to the primary type sorted by name.
    string public constant TOKEN_AUTH_TYPE = "TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)";
    bytes32 public constant TOKEN_AUTH_TYPEHASH = keccak256(bytes(TOKEN_AUTH_TYPE));

    /// @dev Upper bound of one nonce increase, so that a single mistaken call cannot use up the nonce space.
    uint256 internal constant MAX_NONCE_INCREASE = type(uint32).max;

    mapping(address signer => uint256) public nonces;

    mapping(address token => TokenConfig) private _tokenConfigs;

    // The loop validates the deployer's own configuration: any bad entry must abort the deployment.
    // forge-lint: disable-next-item(require-revert-in-loop)
    constructor(string memory name, address initialOwner, TokenInit[] memory tokens)
        EIP712(name, "3")
        Ownable(initialOwner)
    {
        if (tokens.length == 0) revert InvalidConfig();
        for (uint256 i = 0; i < tokens.length; ++i) {
            TokenInit memory t = tokens[i];
            // Each initial token is enabled once; a disabling or repeated entry is a deployment mistake.
            if (!_enabled(t.config) || _enabled(_tokenConfigs[t.token])) revert InvalidConfig();
            _setTokenConfig(t.token, t.config);
        }
    }

    function tokenConfig(address token) external view returns (TokenConfig memory) {
        return _tokenConfigs[token];
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function invalidateNonces(uint256 newNonce) external {
        uint256 current = nonces[msg.sender];
        if (newNonce <= current || newNonce - current > MAX_NONCE_INCREASE) {
            revert InvalidNonceIncrease(current, newNonce);
        }
        nonces[msg.sender] = newNonce;
        emit NonceInvalidated(msg.sender, current, newNonce);
    }

    function setTokenConfig(address token, TokenConfig calldata config) external onlyOwner {
        _setTokenConfig(token, config);
    }

    /// @dev An enabled configuration needs a token with code (which excludes address(0)) other than this contract. A
    ///      configuration without any mode removes the token, for any address.
    // Also called in the constructor's loop, where any bad entry must abort the deployment.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _setTokenConfig(address token, TokenConfig memory config) private {
        if (_enabled(config) && (token.code.length == 0 || token == address(this))) revert InvalidConfig();
        _tokenConfigs[token] = config;
        emit TokenConfigSet(token, config);
    }

    function _enabled(TokenConfig memory config) private pure returns (bool) {
        return config.permit || config.metaTxApprove || config.allowance;
    }

    /// @dev Reads the token's configuration once and checks that `mode` is enabled for it.
    function _requireToken(address token, AuthMode mode) internal view {
        TokenConfig memory config = _tokenConfigs[token];
        bool enabled;
        if (mode == AuthMode.PERMIT) {
            enabled = config.permit;
        } else if (mode == AuthMode.META_TX_APPROVE) {
            enabled = config.metaTxApprove;
        } else {
            enabled = config.allowance; // AuthMode.NONE uses an existing allowance
        }
        if (!enabled) {
            if (!_enabled(config)) revert TokenNotSupported(token);
            revert AuthModeNotSupported(token, mode);
        }
    }

    function _requireRelay(address relay) internal view {
        if (msg.sender != relay) revert NotRelay(msg.sender, relay);
    }

    /// @dev Deadlines are unix seconds (D3); validator timestamp drift is negligible against the 60 s to 2 h window.
    function _checkDeadline(uint256 deadline) internal view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
    }

    /// @dev ECDSA only (no ERC-1271): tryRecoverCalldata accepts only 65-byte signatures and rejects high-s values; it
    ///      reads the signature from calldata without copying it to memory.
    function _verify(address signer, bytes32 structHash, bytes calldata sig) internal view {
        if (signer == address(0)) revert InvalidSigner();
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(_hashTypedDataV4(structHash), sig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert InvalidSignature();
    }
}
