// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IApprovable {
    function approve(address spender, uint256 value) external returns (bool);
}

/// @notice T28: a smart-contract wallet whose ERC-1271 check accepts every signature. The gasless contract uses ECDSA
///         only (D1), so a request with `from` = this wallet must never pass, whatever the signature.
contract MockERC1271Wallet {
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return ERC1271_MAGIC;
    }

    function approveToken(address token, address spender, uint256 value) external {
        require(msg.sender == owner, "not owner");
        IApprovable(token).approve(spender, value);
    }
}
