// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @dev A contract that has every function test_T20_noOtherAdminFunctions forbids, for the probe's own test.
contract HasAdminFunctions {
    /// @dev A TokenConfig with a fee field.
    struct TokenConfigWithFee {
        bool permit;
        bool metaTxApprove;
        bool allowance;
        uint128 maxFee;
    }

    uint256 public calls;

    function pause() external {
        ++calls;
    }

    function unpause() external {
        ++calls;
    }

    function setMaxFee(uint256) external {
        ++calls;
    }

    function addToken(address) external {
        ++calls;
    }

    function setTokenConfig(address, bool, bool, bool) external {
        ++calls;
    }

    function setTokenConfig(address, TokenConfigWithFee calldata) external {
        ++calls;
    }

    function withdraw(address, uint256) external {
        ++calls;
    }

    function rescue(address, address, uint256) external {
        ++calls;
    }

    function upgradeTo(address) external {
        ++calls;
    }

    function multicall(bytes[] calldata) external {
        ++calls;
    }

    function invalidateNonce(bytes32) external {
        ++calls;
    }
}

/// @notice T20 and P3: the external surface is exactly the §4.4 allowlist, the owner's only power is the token
///         configuration (plus Ownable2Step's own functions), there is no receive/fallback, and the runtime code
///         contains no DELEGATECALL, CALLCODE or SELFDESTRUCT.
contract SurfaceTest is GaslessTestBase {
    string internal constant ARTIFACT = "out/GaslessTransfer.sol/GaslessTransfer.json";

    function test_T20_methodIdentifiers_matchAllowlist() public view {
        string[17] memory allowlist = [
            "DOMAIN_SEPARATOR()",
            "TOKEN_AUTH_TYPE()",
            "TOKEN_AUTH_TYPEHASH()",
            "TRANSFER_TYPE()",
            "TRANSFER_TYPEHASH()",
            "acceptOwnership()",
            "eip712Domain()",
            "hashTransfer((address,address,address,uint256,uint256,address,uint256),uint256,(uint8,uint8,bytes32,bytes32))",
            "invalidateNonces(uint256)",
            "nonces(address)",
            "owner()",
            "pendingOwner()",
            "relayTransfer((address,address,address,uint256,uint256,address,uint256),bytes,(uint8,uint8,bytes32,bytes32))",
            "renounceOwnership()",
            "setTokenConfig(address,(bool,bool,bool))",
            "tokenConfig(address)",
            "transferOwnership(address)"
        ];
        string memory artifact = vm.readFile(ARTIFACT);
        string[] memory methods = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        assertEq(methods.length, allowlist.length, "number of external functions");
        for (uint256 i = 0; i < allowlist.length; ++i) {
            bool found;
            for (uint256 j = 0; j < methods.length; ++j) {
                if (keccak256(bytes(methods[j])) == keccak256(bytes(allowlist[i]))) found = true;
            }
            assertTrue(found, string.concat("missing from the surface: ", allowlist[i]));
        }
    }

    /// @dev None of these exists: it is not in the artifact's methodIdentifiers, and called by the owner it is an unknown
    ///      selector (_absentAtRuntime).
    function test_T20_noOtherAdminFunctions() public {
        string[] memory methods = vm.parseJsonKeys(vm.readFile(ARTIFACT), ".methodIdentifiers");
        string[11] memory forbidden = _forbidden();
        for (uint256 i = 0; i < forbidden.length; ++i) {
            for (uint256 j = 0; j < methods.length; ++j) {
                assertNotEq(keccak256(bytes(methods[j])), keccak256(bytes(forbidden[i])), forbidden[i]);
            }
            vm.prank(owner);
            assertTrue(
                _absentAtRuntime(address(gasless), forbidden[i]), string.concat("unexpected function: ", forbidden[i])
            );
        }
    }

    /// @dev The runtime probe sees functions with parameters. A selector alone (no arguments) would make every such
    ///      function look absent, because its ABI decoder reverts on the short call data.
    function test_T20_runtimeProbeDetectsFunctionsWithParameters() public {
        HasAdminFunctions admin = new HasAdminFunctions();
        string[11] memory forbidden = _forbidden();
        for (uint256 i = 0; i < forbidden.length; ++i) {
            assertFalse(_absentAtRuntime(address(admin), forbidden[i]), string.concat("probe missed: ", forbidden[i]));
            (bool success,) = address(admin).call(abi.encodeWithSignature(forbidden[i]));
            if (bytes(forbidden[i])[bytes(forbidden[i]).length - 2] != "(") {
                assertFalse(success, "control: a selector alone does not reach a function with parameters");
            }
        }
    }

    function _forbidden() internal pure returns (string[11] memory) {
        return [
            "pause()",
            "unpause()",
            "setMaxFee(uint256)",
            "addToken(address)",
            "setTokenConfig(address,bool,bool,bool)",
            "setTokenConfig(address,(bool,bool,bool,uint128))",
            "withdraw(address,uint256)",
            "rescue(address,address,uint256)",
            "upgradeTo(address)",
            "multicall(bytes[])",
            "invalidateNonce(bytes32)"
        ];
    }

    /// @dev Calls `signature` with eight zero words of arguments, which decode for every signature above (bytes[] as an
    ///      empty array). An existing function decodes them and either succeeds or reverts with its own error data; an
    ///      unknown selector of a contract without fallback reverts without data.
    function _absentAtRuntime(address target, string memory signature) internal returns (bool) {
        (bool success, bytes memory ret) =
            target.call(abi.encodePacked(bytes4(keccak256(bytes(signature))), new bytes(32 * 8)));
        return !success && ret.length == 0;
    }

    function test_T20_ownerFunctionsAreOwnerOnly() public {
        bytes[3] memory calls = [
            abi.encodeCall(gasless.setTokenConfig, (address(usdc), _config(true, false, false))),
            abi.encodeCall(gasless.transferOwnership, (address(this))),
            abi.encodeCall(gasless.renounceOwnership, ())
        ];
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool success, bytes memory ret) = address(gasless).call(calls[i]);
            assertFalse(success, "not the owner");
            assertEq(ret, abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        }
    }

    function test_P3_noReceiveOrFallback() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(gasless).call{value: 1}("");
        assertFalse(success, "plain ETH transfer");
        (success,) = address(gasless).call(hex"deadbeef");
        assertFalse(success, "unknown selector");
        (success,) = address(gasless).call("");
        assertFalse(success, "empty call data");
        (success,) = address(gasless).call{value: 1}(abi.encodeCall(gasless.invalidateNonces, (1)));
        assertFalse(success, "functions are not payable");
        assertEq(address(gasless).balance, 0);
    }

    function test_P3_noDelegatecallCallcodeOrSelfdestruct() public view {
        bytes memory code = address(gasless).code;
        // Strip the CBOR metadata: its length is stored in the last two bytes.
        uint256 metadataLength = (uint256(uint8(code[code.length - 2])) << 8) + uint256(uint8(code[code.length - 1]));
        uint256 end = code.length - metadataLength - 2;
        for (uint256 i = 0; i < end; ++i) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            assertTrue(op != 0xff, "SELFDESTRUCT");
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip PUSH1..PUSH32 immediates
        }
    }
}
