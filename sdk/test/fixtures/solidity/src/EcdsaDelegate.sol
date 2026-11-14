// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice TEST DOUBLE for the SDK tests: an EIP-7702 delegate that implements ERC-1271 by checking an ECDSA
///         signature of the account's own key (the usual 7702 wallet design; same as contracts/test/mocks
///         EcdsaDelegate). USDC verifies permits of accounts with code through this function.
contract EcdsaDelegate is IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == address(this)) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
