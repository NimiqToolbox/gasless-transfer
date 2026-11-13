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
        bytes32 structHash = _hashStruct(r, nonce, auth);
        _verify(r.from, structHash, signature);

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

        // Logged after the token logs, with the request id of the executed request. nonReentrant guards the whole
        // call: during the token calls no other TransferRelayed can be emitted, so no log can be reordered or forged.
        // forge-lint: disable-next-line(reentrancy-events)
        emit TransferRelayed(r.from, nonce, _hashTypedDataV4(structHash));
    }

    function hashTransfer(TransferRequest calldata r, uint256 nonce, TokenAuth calldata auth)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_hashStruct(r, nonce, auth));
    }

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
