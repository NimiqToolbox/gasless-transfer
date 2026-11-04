// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A fixed-price POL/USD test feed for Amoy: its round is always the current block. Never a production price
///         feed.
contract TestnetPriceFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "Test POL / USD";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 20_000_000, block.timestamp, block.timestamp, 1);
    }
}
