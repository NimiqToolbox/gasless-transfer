// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IGaslessBase, TokenAuth} from "./IGaslessBase.sol";

// Transfer interface shared by the contract and SDK. Keep ABI and typed-data definitions synchronized.

/// @notice The call data of a transfer. `from` signs it as EIP-712 `GaslessTransfer(address token,address from,
///         address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)
///         TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)`, with `nonce` = nonces(from) at execution and `auth` the
///         token authorization submitted with it.
struct TransferRequest {
    address token;
    address from;
    address to;
    uint256 amount;
    uint256 fee;
    address relay;
    uint256 deadline;
}

/// @notice Gasless ERC-20 transfers, submitted by the relay that the sender signed for.
interface IGaslessTransfer is IGaslessBase {
    /// @notice The EIP-712 type `from` signs: the GaslessTransfer struct type, then TOKEN_AUTH_TYPE().
    function TRANSFER_TYPE() external view returns (string memory);

    function TRANSFER_TYPEHASH() external view returns (bytes32);

    /// @notice Moves `amount` from `r.from` to `r.to` and `fee` to `r.relay` (== msg.sender), and uses nonce
    ///         nonces(r.from). Nothing but `from`'s signature bounds the fee.
    function relayTransfer(TransferRequest calldata r, bytes calldata signature, TokenAuth calldata auth) external;

    /// @notice The EIP-712 digest of `r` at `nonce` with `auth`; the relay uses it as the request id.
    function hashTransfer(TransferRequest calldata r, uint256 nonce, TokenAuth calldata auth)
        external
        view
        returns (bytes32);
}
