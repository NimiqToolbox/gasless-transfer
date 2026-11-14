// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST HELPER for the SDK tests: a relay that is a contract. It calls relayTransfer internally, so the
///         transaction's `to` is this contract, not GaslessTransfer (as a smart account or a bundler would).
contract CallForwarder {
    function forward(address target, bytes calldata data) external {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
