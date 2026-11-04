// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";

import {AuthMode, IGaslessBase, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

import {SpecBase} from "./SpecBase.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice The OpenZeppelin Ownable2Step functions, which the frozen interfaces do not repeat.
interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function renounceOwnership() external;
}

/// @notice External surface and configuration: T20 (surface lock of §4.4, P3), the EIP-712 views of P2 / §4.3, and
///         the constructor rules of §4.2 (InvalidConfig).
contract SurfaceSpecTest is SpecBase {
    // ================================================================ T20

    /// @notice The §4.4 allowlist as canonical ABI signatures ("Nothing else").
    function allowlist() internal pure returns (string[] memory s) {
        string memory request = "(address,address,address,uint256,uint256,address,uint256)";
        string memory auth = "(uint8,uint8,bytes32,bytes32)";
        s = new string[](17);
        s[0] = "DOMAIN_SEPARATOR()";
        s[1] = "TOKEN_AUTH_TYPE()";
        s[2] = "TOKEN_AUTH_TYPEHASH()";
        s[3] = "TRANSFER_TYPE()";
        s[4] = "TRANSFER_TYPEHASH()";
        s[5] = "acceptOwnership()";
        s[6] = "eip712Domain()";
        s[7] = string.concat("hashTransfer(", request, ",uint256,", auth, ")");
        s[8] = "invalidateNonces(uint256)";
        s[9] = "nonces(address)";
        s[10] = "owner()";
        s[11] = "pendingOwner()";
        s[12] = string.concat("relayTransfer(", request, ",bytes,", auth, ")");
        s[13] = "renounceOwnership()";
        s[14] = "setTokenConfig(address,(bool,bool,bool))";
        s[15] = "tokenConfig(address)";
        s[16] = "transferOwnership(address)";
    }

    /// @notice T20: the compiled artifact's methodIdentifiers are exactly the §4.4 allowlist, and each identifier is
    ///         the selector of that signature.
    function test_T20_methodIdentifiersEqualAllowlist() public view {
        string memory json = vm.readFile(ARTIFACT_JSON);
        string[] memory actual = vm.parseJsonKeys(json, ".methodIdentifiers");
        string[] memory expected = allowlist();
        for (uint256 i = 0; i < actual.length; ++i) {
            assertTrue(_contains(expected, actual[i]), string.concat("not in the section 4.4 allowlist: ", actual[i]));
        }
        for (uint256 i = 0; i < expected.length; ++i) {
            assertTrue(_contains(actual, expected[i]), string.concat("allowlisted function missing: ", expected[i]));
        }
        assertEq(actual.length, expected.length, "surface size");

        for (uint256 i = 0; i < actual.length; ++i) {
            string memory id = vm.parseJsonString(json, string.concat(".methodIdentifiers.['", actual[i], "']"));
            assertEq(id, _hex4(bytes4(keccak256(bytes(actual[i])))), string.concat("identifier of ", actual[i]));
        }
    }

    /// @notice T20: the allowlist signatures are the frozen interface's selectors (the ABI clients use),
    ///         plus Ownable2Step's.
    function test_T20_allowlistMatchesFrozenInterface() public pure {
        string[] memory s = allowlist();
        bytes4[17] memory selectors = [
            IGaslessBase.DOMAIN_SEPARATOR.selector,
            IGaslessBase.TOKEN_AUTH_TYPE.selector,
            IGaslessBase.TOKEN_AUTH_TYPEHASH.selector,
            IGaslessTransfer.TRANSFER_TYPE.selector,
            IGaslessTransfer.TRANSFER_TYPEHASH.selector,
            IOwnable2Step.acceptOwnership.selector,
            IERC5267.eip712Domain.selector,
            IGaslessTransfer.hashTransfer.selector,
            IGaslessBase.invalidateNonces.selector,
            IGaslessBase.nonces.selector,
            IOwnable2Step.owner.selector,
            IOwnable2Step.pendingOwner.selector,
            IGaslessTransfer.relayTransfer.selector,
            IOwnable2Step.renounceOwnership.selector,
            IGaslessBase.setTokenConfig.selector,
            IGaslessBase.tokenConfig.selector,
            IOwnable2Step.transferOwnership.selector
        ];
        for (uint256 i = 0; i < s.length; ++i) {
            assertEq(bytes4(keccak256(bytes(s[i]))), selectors[i], s[i]);
        }
    }

    /// @notice T20: the only privileged functions are setTokenConfig and Ownable2Step's; no admin, upgrade, rescue,
    ///         pause, generic-call or other setter function exists, neither in the artifact nor at runtime.
    function test_T20_noOtherPrivilegedFunctions() public {
        string[] memory actual = vm.parseJsonKeys(vm.readFile(ARTIFACT_JSON), ".methodIdentifiers");
        string[] memory forbidden = _privilegedSignatures();
        for (uint256 i = 0; i < forbidden.length; ++i) {
            assertFalse(_contains(actual, forbidden[i]), string.concat("privileged function exists: ", forbidden[i]));
            (bool ok,) = address(gasless).call(abi.encodeWithSignature(forbidden[i]));
            assertFalse(ok, string.concat("call did not revert: ", forbidden[i]));
        }
        for (uint256 i = 0; i < actual.length; ++i) {
            if (_startsWith(actual[i], "set")) {
                assertEq(actual[i], "setTokenConfig(address,(bool,bool,bool))", "other setter exists");
            }
        }
    }

    /// @notice T20: the owner functions refuse everyone but the owner (and the pending owner for acceptOwnership).
    function test_T20_ownerFunctionsAreRestricted() public {
        address[3] memory callers = [attacker, relay, alice];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", callers[i]));
            gasless.setTokenConfig(address(usdc), config(false, false, false));
            vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", callers[i]));
            IOwnable2Step(address(gasless)).transferOwnership(callers[i]);
            vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", callers[i]));
            IOwnable2Step(address(gasless)).acceptOwnership();
            vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", callers[i]));
            IOwnable2Step(address(gasless)).renounceOwnership();
            vm.stopPrank();
        }
        assertEq(IOwnable2Step(address(gasless)).owner(), owner);
        assertEq(IOwnable2Step(address(gasless)).pendingOwner(), address(0));
    }

    /// @notice T20 / P3: the ABI has no receive or fallback; plain ETH transfers, empty calldata and unknown selectors
    ///         revert.
    function test_T20_noReceiveOrFallback() public {
        string memory json = vm.readFile(ARTIFACT_JSON);
        for (uint256 i = 0;; ++i) {
            string memory key = string.concat(".abi[", vm.toString(i), "].type");
            if (!vm.keyExistsJson(json, key)) break;
            string memory kind = vm.parseJsonString(json, key);
            assertFalse(_eq(kind, "receive"), "receive() exists");
            assertFalse(_eq(kind, "fallback"), "fallback() exists");
        }

        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        (bool ok,) = address(gasless).call{value: 1}("");
        assertFalse(ok, "accepts plain ETH");
        (ok,) = address(gasless).call("");
        assertFalse(ok, "accepts empty calldata");
        (ok,) = address(gasless).call(hex"deadbeef");
        assertFalse(ok, "accepts an unknown selector");
        (ok,) = address(gasless).call(hex"00");
        assertFalse(ok, "accepts short calldata");
        vm.stopPrank();
        assertEq(address(gasless).balance, 0);
    }

    /// @notice T20 / P3: no function is payable (no ETH custody).
    function test_T20_noPayableFunction() public {
        vm.deal(relay, 1 ether);
        vm.deal(owner, 1 ether);
        TransferRequest memory r = request(address(usdc), victim);
        bytes memory sig = signRequest(victimKey, r, noAuth());
        vm.prank(relay);
        (bool ok,) = address(gasless).call{value: 1}(abi.encodeCall(IGaslessTransfer.relayTransfer, (r, sig, noAuth())));
        assertFalse(ok, "relayTransfer is payable");
        vm.prank(relay);
        (ok,) = address(gasless).call{value: 1}(abi.encodeCall(IGaslessBase.invalidateNonces, (1)));
        assertFalse(ok, "invalidateNonces is payable");
        vm.prank(owner);
        (ok,) = address(gasless).call{value: 1}(
            abi.encodeCall(IGaslessBase.setTokenConfig, (address(usdc), config(true, false, true)))
        );
        assertFalse(ok, "setTokenConfig is payable");
    }

    /// @notice T20 / P3: the runtime code contains no DELEGATECALL, CALLCODE or SELFDESTRUCT opcode (PUSH data and
    ///         the trailing CBOR metadata are skipped).
    function test_T20_runtimeHasNoDelegatecallCallcodeOrSelfdestruct() public view {
        bytes memory code = address(gasless).code;
        uint256 end = code.length;
        uint256 metadataLength = (uint256(uint8(code[end - 2])) << 8) | uint256(uint8(code[end - 1]));
        if (metadataLength + 2 <= end) end -= metadataLength + 2;

        bool delegatecall;
        bool callcode;
        bool selfdestruct_;
        for (uint256 i = 0; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
            } else if (op == 0xf4) {
                delegatecall = true;
            } else if (op == 0xf2) {
                callcode = true;
            } else if (op == 0xff) {
                selfdestruct_ = true;
            }
        }
        assertFalse(delegatecall, "DELEGATECALL in runtime code");
        assertFalse(callcode, "CALLCODE in runtime code");
        assertFalse(selfdestruct_, "SELFDESTRUCT in runtime code");
    }

    // ================================================================ P2 / §4.3 EIP-712 views

    function test_P2_domainSeparatorMatchesSpec() public view {
        assertEq(gasless.DOMAIN_SEPARATOR(), domainSeparator(POLYGON, address(gasless)));
    }

    function test_P2_eip712DomainMatchesSpec() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = gasless.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, DOMAIN_NAME);
        assertEq(version, DOMAIN_VERSION);
        assertEq(version, "3");
        assertEq(chainId, POLYGON);
        assertEq(verifyingContract, address(gasless));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    /// @notice §4.2, §4.3: the type strings and their hashes are the spec's.
    function test_P2_typesAndTypehashesMatchSpec() public view {
        assertEq(gasless.TRANSFER_TYPE(), TRANSFER_TYPE);
        assertEq(gasless.TOKEN_AUTH_TYPE(), TOKEN_AUTH_TYPE);
        assertEq(gasless.TRANSFER_TYPEHASH(), TRANSFER_TYPEHASH);
        assertEq(gasless.TOKEN_AUTH_TYPEHASH(), TOKEN_AUTH_TYPEHASH);
    }

    /// @notice §4.3: hashTransfer is the EIP-712 digest (the relay request id), computed independently here.
    function testFuzz_P2_hashTransferIsTheEip712Digest(
        TransferRequest memory r,
        uint256 nonce,
        uint8 mode,
        uint8 v,
        bytes32 sr,
        bytes32 ss
    ) public view {
        TokenAuth memory auth = TokenAuth({mode: AuthMode(bound(mode, 0, 2)), v: v, r: sr, s: ss});
        assertEq(gasless.hashTransfer(r, nonce, auth), digest(r, nonce, auth));
    }

    /// @notice P2: hashTransfer follows a chain id change like DOMAIN_SEPARATOR does.
    function testFuzz_P2_hashTransferFollowsChainId(TransferRequest memory r, uint256 nonce, uint64 chainId) public {
        vm.assume(chainId != 0);
        vm.chainId(chainId);
        assertEq(gasless.hashTransfer(r, nonce, noAuth()), digestFor(r, nonce, noAuth(), chainId, address(gasless)));
        assertEq(gasless.DOMAIN_SEPARATOR(), domainSeparator(chainId, address(gasless)));
    }

    // ================================================================ §4.2 constructor, D6

    function test_constructor_storesConfigAndOwner() public view {
        _assertConfig(gasless.tokenConfig(address(usdc)), true, false, true);
        _assertConfig(gasless.tokenConfig(address(usdt)), true, true, true);
        _assertConfig(gasless.tokenConfig(address(0)), false, false, false);
        _assertConfig(gasless.tokenConfig(attacker), false, false, false);
        _assertConfig(gasless.tokenConfig(address(gasless)), false, false, false);
        assertEq(IOwnable2Step(address(gasless)).owner(), owner);
    }

    function test_constructor_revertsWithoutTokens() public {
        vm.expectRevert(errInvalidConfig());
        deployGasless(new TokenInit[](0));
    }

    function test_constructor_revertsForZeroOwner() public {
        owner = address(0);
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        deployGasless(defaultTokens());
    }

    function test_constructor_revertsForTokenWithoutCode() public {
        address[2] memory codeless = [address(0), makeAddr("eoa")];
        for (uint256 i = 0; i < codeless.length; ++i) {
            TokenInit[] memory tokens = defaultTokens();
            tokens[1].token = codeless[i];
            vm.expectRevert(errInvalidConfig());
            deployGasless(tokens);
        }
    }

    /// @notice §4.2: a token listed twice is refused, whatever modes either entry has (the second finds it enabled).
    function test_constructor_revertsForDuplicateToken() public {
        TokenInit[] memory tokens = new TokenInit[](3);
        tokens[0] = TokenInit({token: address(usdc), config: config(true, false, false)});
        tokens[1] = TokenInit({token: address(usdt), config: config(true, true, true)});
        tokens[2] = TokenInit({token: address(usdc), config: config(false, false, true)});
        vm.expectRevert(errInvalidConfig());
        deployGasless(tokens);
        tokens[2].config = config(true, false, false);
        vm.expectRevert(errInvalidConfig());
        deployGasless(tokens);
        tokens[2].config = config(false, false, false);
        vm.expectRevert(errInvalidConfig());
        deployGasless(tokens);
    }

    /// @notice §4.2 (fuzz): any two entries of one token are refused; entries of distinct tokens are stored as given.
    function testFuzz_constructor_duplicateTokenWithAnyModes(uint8 first, uint8 second, bool sameToken) public {
        TokenInit[] memory tokens = new TokenInit[](2);
        tokens[0] = TokenInit({token: address(usdc), config: _modes(1 + first % 7)});
        tokens[1] = TokenInit({token: sameToken ? address(usdc) : address(usdt), config: _modes(1 + second % 7)});
        if (sameToken) {
            vm.expectRevert(errInvalidConfig());
            deployGasless(tokens);
        } else {
            IGaslessTransfer g = deployGasless(tokens);
            TokenConfig memory c = tokens[1].config;
            _assertConfig(g.tokenConfig(address(usdt)), c.permit, c.metaTxApprove, c.allowance);
            c = tokens[0].config;
            _assertConfig(g.tokenConfig(address(usdc)), c.permit, c.metaTxApprove, c.allowance);
        }
    }

    function test_constructor_revertsForTokenWithoutAnyMode() public {
        TokenInit[] memory tokens = defaultTokens();
        tokens[0].config = config(false, false, false);
        vm.expectRevert(errInvalidConfig());
        deployGasless(tokens);
        tokens[1].config = config(false, false, false);
        vm.expectRevert(errInvalidConfig());
        deployGasless(tokens);
    }

    /// @notice §4.2: a single token with a single mode is a valid configuration, stored as given.
    function test_constructor_acceptsMinimalConfig() public {
        MockUSDC token = new MockUSDC();
        TokenInit[] memory tokens = new TokenInit[](1);
        tokens[0] = TokenInit({token: address(token), config: config(false, true, false)});
        IGaslessTransfer g = deployGasless(tokens);
        _assertConfig(g.tokenConfig(address(token)), false, true, false);
        _assertConfig(g.tokenConfig(address(usdc)), false, false, false);
    }

    // ================================================================ §4.2 setTokenConfig, D6

    /// @notice D6: the owner adds a token, replaces a configuration and removes a token; each change emits
    ///         TokenConfigSet and takes effect for the next request.
    function test_setTokenConfig_addReplaceRemove() public {
        MockUSDC added = new MockUSDC();
        added.mint(victim, FUNDS);
        vm.prank(victim);
        added.approve(address(gasless), type(uint256).max);

        TransferRequest memory r = request(address(added), victim);
        expectRevertNoChange(
            relay, r, signRequest(victimKey, r, noAuth()), noAuth(), errTokenNotSupported(address(added))
        );

        TokenConfig memory c = config(false, false, true);
        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.TokenConfigSet(address(added), c);
        vm.prank(owner);
        gasless.setTokenConfig(address(added), c);
        State memory before = observe(r);
        submit(r, signRequest(victimKey, r, noAuth()), noAuth());
        assertTransferred(r, before);

        c = config(true, false, false);
        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.TokenConfigSet(address(added), c);
        vm.prank(owner);
        gasless.setTokenConfig(address(added), c);
        expectRevertNoChange(
            relay,
            r,
            signRequest(victimKey, r, noAuth()),
            noAuth(),
            errAuthModeNotSupported(address(added), AuthMode.NONE)
        );

        c = config(false, false, false);
        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.TokenConfigSet(address(added), c);
        vm.prank(owner);
        gasless.setTokenConfig(address(added), c);
        expectRevertNoChange(
            relay, r, signRequest(victimKey, r, noAuth()), noAuth(), errTokenNotSupported(address(added))
        );
    }

    /// @notice §4.2: setTokenConfig validates like the constructor: an enabled token needs code and may not be the
    ///         contract itself.
    function test_setTokenConfig_rejectsInvalidConfig() public {
        vm.startPrank(owner);
        vm.expectRevert(errInvalidConfig());
        gasless.setTokenConfig(address(0), config(false, false, true));
        vm.expectRevert(errInvalidConfig());
        gasless.setTokenConfig(makeAddr("eoa"), config(true, false, false));
        vm.expectRevert(errInvalidConfig());
        gasless.setTokenConfig(address(gasless), config(true, true, true));
        vm.stopPrank();
        _assertConfig(gasless.tokenConfig(address(usdc)), true, false, true);
    }

    /// @notice §4.2: a configuration without any mode removes the token, for any address (also one without code and
    ///         the contract itself), and emits TokenConfigSet.
    function test_setTokenConfig_allFalseRemovesForAnyAddress() public {
        address[4] memory targets = [address(usdt), address(0), makeAddr("eoa"), address(gasless)];
        vm.startPrank(owner);
        for (uint256 i = 0; i < targets.length; ++i) {
            vm.expectEmit(true, true, true, true, address(gasless));
            emit IGaslessBase.TokenConfigSet(targets[i], config(false, false, false));
            gasless.setTokenConfig(targets[i], config(false, false, false));
            _assertConfig(gasless.tokenConfig(targets[i]), false, false, false);
        }
        vm.stopPrank();
        _assertConfig(gasless.tokenConfig(address(usdc)), true, false, true);
    }

    // ================================================================ helpers

    function _assertConfig(TokenConfig memory c, bool permit, bool metaTxApprove, bool allowance) internal pure {
        assertEq(c.permit, permit, "permit");
        assertEq(c.metaTxApprove, metaTxApprove, "metaTxApprove");
        assertEq(c.allowance, allowance, "allowance");
    }

    /// @dev Bit 0 permit, bit 1 metaTxApprove, bit 2 allowance.
    function _modes(uint256 bits) internal pure returns (TokenConfig memory) {
        return config(bits & 1 != 0, bits & 2 != 0, bits & 4 != 0);
    }

    function _privilegedSignatures() internal pure returns (string[] memory s) {
        s = new string[](23);
        s[0] = "admin()";
        s[1] = "pause()";
        s[2] = "unpause()";
        s[3] = "paused()";
        s[4] = "upgradeTo(address)";
        s[5] = "upgradeToAndCall(address,bytes)";
        s[6] = "implementation()";
        s[7] = "rescue(address,address,uint256)";
        s[8] = "withdraw(address,address,uint256)";
        s[9] = "sweep(address)";
        s[10] = "setMaxFee(uint256)";
        s[11] = "setRelay(address)";
        s[12] = "setTokenConfig(address,bool,bool,bool)";
        s[13] = "setNonce(address,uint256)";
        s[14] = "grantRole(bytes32,address)";
        s[15] = "multicall(bytes[])";
        s[16] = "execute(address,uint256,bytes)";
        s[17] = "selfdestruct()";
        s[18] = "kill()";
        s[19] = "addToken(address)";
        s[20] = "invalidateNonce(bytes32)";
        s[21] = "MAX_FEE()";
        s[22] = "setTokenConfig(address,(bool,bool,bool,uint128))"; // a TokenConfig with a fee field
    }

    function _contains(string[] memory list, string memory item) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (_eq(list[i], item)) return true;
        }
        return false;
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory p = bytes(prefix);
        if (a.length < p.length) return false;
        for (uint256 i = 0; i < p.length; ++i) {
            if (a[i] != p[i]) return false;
        }
        return true;
    }

    /// @dev 4-byte selector as 8 lowercase hex characters without 0x (the methodIdentifiers format).
    function _hex4(bytes4 selector) internal pure returns (string memory) {
        bytes memory full = bytes(vm.toString(abi.encodePacked(selector)));
        bytes memory out = new bytes(8);
        for (uint256 i = 0; i < 8; ++i) {
            out[i] = full[i + 2];
        }
        return string(out);
    }
}
