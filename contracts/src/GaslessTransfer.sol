// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {GaslessBase} from "./base/GaslessBase.sol";
import {TokenAuth, TokenInit} from "./interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "./interfaces/IGaslessTransfer.sol";
import {TokenAuthLib} from "./libraries/TokenAuthLib.sol";

/// @notice Gasless ERC-20 transfers (docs/STEP-1-GAS-ABSTRACTION.md §4.3). `from` signs every field of the request,
///         including the relay that may submit it, the fee that relay receives and the token authorization, at its
///         next nonce. Nothing else bounds the fee: clients check the fee a relay quotes before they sign it. The owner
///         manages the token configuration only; there is no upgrade path.
contract GaslessTransfer is IGaslessTransfer, GaslessBase {
    using SafeERC20 for IERC20;

    string public constant TRANSFER_TYPE = string(
        abi.encodePacked(
            "GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)",
            TOKEN_AUTH_TYPE
        )
    );
    /// @inheritdoc IGaslessTransfer
    bytes32 public constant TRANSFER_TYPEHASH = keccak256(bytes(TRANSFER_TYPE));

    constructor(address initialOwner, TokenInit[] memory tokens)
        GaslessBase("Nimiq Gasless Transfer", initialOwner, tokens)
    {}

    function relayTransfer(TransferRequest calldata r, bytes calldata signature, TokenAuth calldata auth)
        external
        nonReentrant
    {
        // The signature first (§4.3): nothing else is checked or called for a request that `from` did not sign, with
        // this token authorization, at its current nonce.
        uint256 nonce = nonces[r.from];
        _verify(r.from, _hashStruct(r, nonce, auth), signature);

        // Checks.
        _requireToken(r.token, auth.mode);
        _requireRelay(r.relay);
        _checkDeadline(r.deadline);
        if (r.amount == 0) revert ZeroAmount();
        if (r.to == address(0) || r.to == r.token || r.to == address(this)) revert InvalidRecipient(r.to);

        // Effect: the nonce is used before any token call.
        nonces[r.from] = nonce + 1;

        // Interactions; nonReentrant guards the whole call.
        _collect(r.token, r.from, r.to, r.amount, r.fee, r.relay, r.deadline, auth);
    }

    function hashTransfer(TransferRequest calldata r, uint256 nonce, TokenAuth calldata auth)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_hashStruct(r, nonce, auth));
    }

    /// @dev The EIP-712 struct hash of `r` at `nonce` with `auth`, encoded as TRANSFER_TYPE defines it: the TokenAuth
    ///      member is encoded as the hash of its own struct (TOKEN_AUTH_TYPEHASH).
    /// @param r The transfer request.
    /// @param nonce The nonce the request is signed at; relayTransfer passes nonces(r.from).
    /// @param auth The token authorization signed into the request.
    /// @return The struct hash; _hashTypedDataV4 turns it into the digest that `from` signs.
    function _hashStruct(TransferRequest calldata r, uint256 nonce, TokenAuth calldata auth)
        private
        pure
        returns (bytes32)
    {
        bytes32 authHash = keccak256(abi.encode(TOKEN_AUTH_TYPEHASH, auth.mode, auth.v, auth.r, auth.s));
        return keccak256(
            abi.encode(TRANSFER_TYPEHASH, r.token, r.from, r.to, r.amount, r.fee, r.relay, nonce, r.deadline, authHash)
        );
    }

    /// @dev Callers must have verified `from`'s signature over token, to, amount, fee, relay and auth in the same call
    ///      (P1); that signature is what justifies both transferFrom calls below. The fee goes first (D13), which only
    ///      affects the order of the Transfer logs: the whole call is atomic.
    /// @param token The token to move.
    /// @param from The sender who signed the request; both transfers pull from it.
    /// @param to The recipient of `amount`.
    /// @param amount The amount that `to` receives.
    /// @param fee The fee that `relay` receives; 0 skips the fee transfer.
    /// @param relay The relay that the request names and that submits it.
    /// @param deadline The request deadline; PERMIT mode uses it as the permit deadline.
    /// @param auth The token authorization signed into the request.
    function _collect(
        address token,
        address from,
        address to,
        uint256 amount,
        uint256 fee,
        address relay,
        uint256 deadline,
        TokenAuth calldata auth
    ) private {
        TokenAuthLib.ensureAllowance(token, from, amount + fee, deadline, auth);
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        if (fee > 0) IERC20(token).safeTransferFrom(from, relay, fee);
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}
