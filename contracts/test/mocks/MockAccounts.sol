// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Smart-contract wallet that accepts every ERC-1271 signature: the worst case for a contract `from`.
contract PermissiveERC1271Wallet is IERC1271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }

    function approve(IERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }
}

/// @notice EIP-7702 delegate without ERC-1271 support (a minimal batch-executor style account).
contract PlainDelegate {
    function ping() external pure returns (bool) {
        return true;
    }
}

/// @notice EIP-7702 delegate that implements ERC-1271 by checking an ECDSA signature of the account's own key.
contract EcdsaDelegate is IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == address(this)) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
