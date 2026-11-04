// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Oracle fixture for the isolated local stack, never a production price feed.
contract MockPriceFeed {
    uint256 public immutable updatedAt = block.timestamp;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "Test POL / USD";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 20_000_000, updatedAt, updatedAt, 1);
    }
}
