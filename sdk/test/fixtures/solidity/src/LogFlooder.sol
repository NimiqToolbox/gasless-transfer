// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ITransferFrom {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice TEST HELPER for the SDK's log flood tests: what any account can do on Polygon. transferFrom of 0 needs no
///         allowance, so one call emits `count` zero-amount Transfer(from, to, 0) logs of each token, for any `from`.
contract LogFlooder {
    function flood(address[] calldata tokens, address from, address to, uint256 count) external {
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = 0; j < tokens.length; j++) {
                ITransferFrom(tokens[j]).transferFrom(from, to, 0);
            }
        }
    }
}
