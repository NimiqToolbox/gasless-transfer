// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {AuthMode, TokenAuth, TokenConfig, TokenInit} from "@gasless/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "@gasless/interfaces/IGaslessTransfer.sol";

interface INativeMetaTransaction {
    function executeMetaTransaction(address user, bytes calldata functionSignature, bytes32 r, bytes32 s, uint8 v)
        external
        payable
        returns (bytes memory);
}

/// @notice TEST DOUBLE for the SDK tests, NOT the production contract (contracts/src/GaslessTransfer.sol).
///         It implements the IGaslessTransfer interface along §4.2/§4.3 so that the SDK
///         (typed data, signatures, token authorizations, nonces, confirmOnChain) can be exercised end to end on
///         anvil. The T30 golden vectors (contracts/test/vectors/data) check the SDK against the real contract; no production
///         code depends on this file. Its check order (signature first), nonce handling and allowance check (§4.1
///         step 3) follow GaslessTransfer and TokenAuthLib.
contract TransferHarness is IGaslessTransfer, EIP712, Ownable2Step {
    using SafeERC20 for IERC20;

    string public constant TOKEN_AUTH_TYPE = "TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)";
    bytes32 public constant TOKEN_AUTH_TYPEHASH = keccak256(bytes(TOKEN_AUTH_TYPE));
    string public constant TRANSFER_TYPE = string(
        abi.encodePacked(
            "GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)",
            TOKEN_AUTH_TYPE
        )
    );
    bytes32 public constant TRANSFER_TYPEHASH = keccak256(bytes(TRANSFER_TYPE));

    mapping(address signer => uint256) public nonces;
    mapping(address token => TokenConfig) private _tokens;

    constructor(address initialOwner, TokenInit[] memory tokens)
        EIP712("Nimiq Gasless Transfer", "3")
        Ownable(initialOwner)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            _setTokenConfig(tokens[i].token, tokens[i].config);
        }
    }

    function tokenConfig(address token) external view returns (TokenConfig memory) {
        return _tokens[token];
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function setTokenConfig(address token, TokenConfig calldata config) external onlyOwner {
        _setTokenConfig(token, config);
    }

    function invalidateNonces(uint256 newNonce) external {
        uint256 current = nonces[msg.sender];
        if (newNonce <= current || newNonce - current > type(uint32).max) {
            revert InvalidNonceIncrease(current, newNonce);
        }
        nonces[msg.sender] = newNonce;
        emit NonceInvalidated(msg.sender, current, newNonce);
    }

    function hashTransfer(TransferRequest calldata r, uint256 nonce, TokenAuth calldata auth)
        public
        view
        returns (bytes32)
    {
        bytes32 authHash = keccak256(abi.encode(TOKEN_AUTH_TYPEHASH, auth.mode, auth.v, auth.r, auth.s));
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSFER_TYPEHASH, r.token, r.from, r.to, r.amount, r.fee, r.relay, nonce, r.deadline, authHash
                )
            )
        );
    }

    function relayTransfer(TransferRequest calldata r, bytes calldata signature, TokenAuth calldata auth) external {
        uint256 nonce = nonces[r.from];
        _verify(r, nonce, auth, signature);
        _checkRequest(r, auth.mode);
        nonces[r.from] = nonce + 1;
        _collect(r, auth);
    }

    function _setTokenConfig(address token, TokenConfig memory config) private {
        _tokens[token] = config;
        emit TokenConfigSet(token, config);
    }

    function _checkRequest(TransferRequest calldata r, AuthMode mode) private view {
        TokenConfig memory config = _tokens[r.token];
        bool modeAllowed =
            mode == AuthMode.PERMIT ? config.permit : mode == AuthMode.META_TX_APPROVE ? config.metaTxApprove : config.allowance;
        if (!modeAllowed) {
            if (!config.permit && !config.metaTxApprove && !config.allowance) revert TokenNotSupported(r.token);
            revert AuthModeNotSupported(r.token, mode);
        }
        if (msg.sender != r.relay) revert NotRelay(msg.sender, r.relay);
        if (block.timestamp > r.deadline) revert DeadlineExpired(r.deadline);
        if (r.amount == 0) revert ZeroAmount();
        if (r.to == address(0) || r.to == r.token || r.to == address(this)) revert InvalidRecipient(r.to);
    }

    function _verify(TransferRequest calldata r, uint256 nonce, TokenAuth calldata auth, bytes calldata signature)
        private
        view
    {
        if (r.from == address(0)) revert InvalidSigner();
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(hashTransfer(r, nonce, auth), signature);
        if (error != ECDSA.RecoverError.NoError || signer != r.from) revert InvalidSignature();
    }

    function _collect(TransferRequest calldata r, TokenAuth calldata auth) private {
        uint256 required = r.amount + r.fee;
        if (auth.mode == AuthMode.PERMIT) {
            try IERC20Permit(r.token).permit(r.from, address(this), required, r.deadline, auth.v, auth.r, auth.s) {} catch {}
        } else if (auth.mode == AuthMode.META_TX_APPROVE) {
            try INativeMetaTransaction(r.token).executeMetaTransaction(
                r.from, abi.encodeCall(IERC20.approve, (address(this), required)), auth.r, auth.s, auth.v
            ) {} catch {}
        }
        // §4.1 step 3, as in TokenAuthLib.ensureAllowance: NONE needs at least `required`; PERMIT and
        // META_TX_APPROVE need exactly `required`, so a standing allowance of any other value is never spent in
        // place of a missing or unusable token signature, and nothing is left after the pulls (TI5).
        uint256 allowed = IERC20(r.token).allowance(r.from, address(this));
        if (auth.mode == AuthMode.NONE ? allowed < required : allowed != required) {
            revert InsufficientAllowance(allowed, required);
        }
        if (r.fee > 0) IERC20(r.token).safeTransferFrom(r.from, r.relay, r.fee);
        IERC20(r.token).safeTransferFrom(r.from, r.to, r.amount);
    }
}
