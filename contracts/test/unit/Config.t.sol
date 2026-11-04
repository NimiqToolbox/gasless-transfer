// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, IGaslessBase, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice Constructor validation and read-only surface: D6 (initial token set and modes), the type strings and hashes
///         (§4.2, §4.3), P2 (own EIP-712 domain) and the transfer digest (T30 golden vector).
contract ConfigTest is GaslessTestBase {
    // --- D6: constructor ---------------------------------------------------------------------------

    function test_D6_constructor_rejectsInvalidConfig() public {
        _expectInvalidConfig(new TokenInit[](0));

        TokenInit[] memory one = _single(address(0), _config(true, false, true));
        _expectInvalidConfig(one);
        one[0].token = makeAddr("eoa");
        _expectInvalidConfig(one);
        // An entry without any mode enables nothing.
        one = _single(address(usdc), _config(false, false, false));
        _expectInvalidConfig(one);
        one = _single(makeAddr("eoa"), _config(false, false, false));
        _expectInvalidConfig(one);
    }

    /// @dev A repeated token is refused because an earlier entry already enabled it, whatever modes either entry has;
    ///      a repeated entry without any mode is refused as one that enables nothing.
    function test_D6_constructor_rejectsRepeatedToken() public {
        TokenInit[] memory dup = stablecoinInits(address(usdc), address(usdc));
        _expectInvalidConfig(dup);
        dup = new TokenInit[](3);
        dup[0] = TokenInit({token: address(usdc), config: _config(true, false, false)});
        dup[1] = TokenInit({token: address(usdt0), config: _config(true, false, false)});
        dup[2] = TokenInit({token: address(usdc), config: _config(false, false, true)});
        _expectInvalidConfig(dup);
        dup[2].config = _config(true, false, false);
        _expectInvalidConfig(dup);
        dup[2].config = _config(true, true, true);
        _expectInvalidConfig(dup);
        dup[2].config = _config(false, false, false);
        _expectInvalidConfig(dup);

        // Every mode set of the first entry, with every mode set of the second.
        for (uint256 first = 1; first < 8; ++first) {
            for (uint256 second = 1; second < 8; ++second) {
                dup = new TokenInit[](2);
                dup[0] = TokenInit({token: address(usdt0), config: _flags(first)});
                dup[1] = TokenInit({token: address(usdt0), config: _flags(second)});
                _expectInvalidConfig(dup);
            }
        }

        // Distinct tokens are accepted, in any order.
        dup = stablecoinInits(address(usdt0), address(usdc));
        GaslessTransfer g = new GaslessTransfer(owner, dup);
        _assertConfig(g.tokenConfig(address(usdt0)), true, false, true);
        _assertConfig(g.tokenConfig(address(usdc)), true, true, true);
    }

    function test_D6_constructor_rejectsZeroOwner() public {
        TokenInit[] memory ok = stablecoinInits(address(usdc), address(usdt0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new GaslessTransfer(address(0), ok);
    }

    function test_D6_constructor_boundaries() public {
        TokenInit[] memory single = _single(address(usdt0), _config(false, true, false));
        GaslessTransfer g = new GaslessTransfer(owner, single);
        _assertConfig(g.tokenConfig(address(usdt0)), false, true, false);
        _assertConfig(g.tokenConfig(address(usdc)), false, false, false);
        assertEq(g.owner(), owner, "initial owner");
        assertEq(g.pendingOwner(), address(0), "no pending owner");
    }

    /// @dev The constructor announces every initial token like setTokenConfig does.
    function test_D6_constructor_emitsTokenConfigSet() public {
        TokenInit[] memory inits = stablecoinInits(address(usdc), address(usdt0));
        vm.expectEmit(true, true, true, true);
        emit IGaslessBase.TokenConfigSet(address(usdc), inits[0].config);
        vm.expectEmit(true, true, true, true);
        emit IGaslessBase.TokenConfigSet(address(usdt0), inits[1].config);
        new GaslessTransfer(owner, inits);
    }

    function test_D6_tokenConfigAndConstants() public view {
        _assertConfig(gasless.tokenConfig(address(usdc)), true, false, true);
        _assertConfig(gasless.tokenConfig(address(usdt0)), true, true, true);
        _assertConfig(gasless.tokenConfig(address(0)), false, false, false);
        _assertConfig(gasless.tokenConfig(bob), false, false, false);
        assertEq(gasless.TRANSFER_TYPEHASH(), TRANSFER_TYPEHASH, "TRANSFER_TYPEHASH");
        assertEq(gasless.TOKEN_AUTH_TYPEHASH(), TOKEN_AUTH_TYPEHASH, "TOKEN_AUTH_TYPEHASH");
        assertEq(gasless.owner(), owner, "owner");
        assertEq(gasless.nonces(alice), 0, "fresh signer starts at nonce 0");
    }

    /// @dev GaslessBase's TOKEN_AUTH_TYPE and the GaslessTransfer type built from it are, string and hash, exactly the
    ///      spec's types (§4.3, §5): the literal strings, and the hashes in the golden vectors.
    function test_typeStringsAndHashes_equalSpec() public view {
        assertEq(gasless.TOKEN_AUTH_TYPE(), "TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)", "TOKEN_AUTH_TYPE");
        assertEq(
            gasless.TRANSFER_TYPE(),
            "GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)",
            "TRANSFER_TYPE"
        );
        assertEq(gasless.TOKEN_AUTH_TYPEHASH(), SPEC_TOKEN_AUTH_TYPEHASH, "TOKEN_AUTH_TYPEHASH of the spec");
        assertEq(gasless.TRANSFER_TYPEHASH(), SPEC_TRANSFER_TYPEHASH, "TRANSFER_TYPEHASH of the spec");
        assertEq(gasless.TOKEN_AUTH_TYPEHASH(), keccak256(bytes(gasless.TOKEN_AUTH_TYPE())), "hash of TOKEN_AUTH_TYPE");
        assertEq(gasless.TRANSFER_TYPEHASH(), keccak256(bytes(gasless.TRANSFER_TYPE())), "hash of TRANSFER_TYPE");
        assertEq(TOKEN_AUTH_TYPEHASH, SPEC_TOKEN_AUTH_TYPEHASH, "the test base's copy");
        assertEq(TRANSFER_TYPEHASH, SPEC_TRANSFER_TYPEHASH, "the test base's copy");
    }

    /// @dev hashTransfer builds the struct hash from the contract's own getters: TRANSFER_TYPEHASH for the request and
    ///      GaslessBase's TOKEN_AUTH_TYPEHASH for the nested TokenAuth (testFuzz_hashTransfer_matchesIndependentDigest
    ///      checks the same digest against the literal type strings).
    function test_hashTransfer_usesTokenAuthTypeHash() public view {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory auth = TokenAuth({mode: AuthMode.PERMIT, v: 27, r: keccak256("r"), s: keccak256("s")});
        bytes32 authHash =
            keccak256(abi.encode(gasless.TOKEN_AUTH_TYPEHASH(), uint8(auth.mode), auth.v, auth.r, auth.s));
        bytes32 structHash = keccak256(
            abi.encode(
                gasless.TRANSFER_TYPEHASH(),
                r.token,
                r.from,
                r.to,
                r.amount,
                r.fee,
                r.relay,
                uint256(3),
                r.deadline,
                authHash
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", gasless.DOMAIN_SEPARATOR(), structHash));
        assertEq(gasless.hashTransfer(r, 3, auth), digest, "digest from the contract's own type hashes");
    }

    /// @dev A token's configuration is one storage slot, and relayTransfer reads it once, in every mode.
    function test_D6_tokenConfig_oneSlotReadOnce() public {
        bytes32 usdcSlot = _configSlot(address(usdc));
        assertEq(
            uint256(vm.load(address(gasless), usdcSlot)),
            1 | (1 << 16),
            "permit, metaTxApprove and allowance in one word"
        );
        bytes32 usdt0Slot = _configSlot(address(usdt0));

        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _assertConfigReadOnce(r, permit, usdcSlot);
        r = _request(address(usdc), 10e6, 1e6);
        _approve(address(usdc), alice, 11e6);
        _assertConfigReadOnce(r, _noneAuth(), usdcSlot);
        r = _request(address(usdt0), 10e6, 1e6);
        TokenAuth memory metaTx = _metaTxFor(alicePk, r);
        _assertConfigReadOnce(r, metaTx, usdt0Slot);
    }

    // --- P2: EIP-712 domain ------------------------------------------------------------------------

    function test_P2_domainSeparator() public {
        assertEq(gasless.DOMAIN_SEPARATOR(), _transferDomainSeparator(address(gasless)), "domain separator");
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = gasless.eip712Domain();
        assertEq(fields, hex"0f", "name, version, chainId, verifyingContract");
        assertEq(name, "Nimiq Gasless Transfer");
        assertEq(version, "3", "GaslessTransfer v3");
        assertEq(chainId, vm.getChainId());
        assertEq(verifyingContract, address(gasless));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);

        vm.chainId(137);
        assertEq(gasless.DOMAIN_SEPARATOR(), _transferDomainSeparator(address(gasless)), "recomputed for 137");
        (,,, chainId,,,) = gasless.eip712Domain();
        assertEq(chainId, 137);
    }

    function testFuzz_hashTransfer_matchesIndependentDigest(
        TransferRequest memory r,
        uint256 nonce,
        uint8 mode,
        uint8 v,
        bytes32 sigR,
        bytes32 sigS
    ) public view {
        TokenAuth memory auth = TokenAuth({mode: AuthMode(bound(mode, 0, 2)), v: v, r: sigR, s: sigS});
        assertEq(gasless.hashTransfer(r, nonce, auth), _transferDigest(r, nonce, auth, address(gasless)));
    }

    /// @dev T30 golden vector: the contract digest equals forge's own EIP-712 implementation over the JSON typed data
    ///      of a client (decimal strings, nested TokenAuth, no EIP712Domain entry in `types`), and a fixed value.
    function test_T30_goldenVector() public {
        vm.chainId(137);
        address verifyingContract = 0x1000000000000000000000000000000000000001;
        vm.etch(0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, hex"00");
        TokenInit[] memory inits = _single(0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, _config(true, false, true));
        deployCodeTo("GaslessTransfer.sol:GaslessTransfer", abi.encode(owner, inits), verifyingContract);

        TransferRequest memory r = TransferRequest({
            token: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359,
            from: 0x2000000000000000000000000000000000000002,
            to: 0x3000000000000000000000000000000000000003,
            amount: 250_000_000,
            fee: 20_000,
            relay: 0x4000000000000000000000000000000000000004,
            deadline: 1_790_000_000
        });
        TokenAuth memory auth = TokenAuth({
            mode: AuthMode.PERMIT,
            v: 27,
            r: 0x0101010101010101010101010101010101010101010101010101010101010101,
            s: 0x0202020202020202020202020202020202020202020202020202020202020202
        });
        string memory typedData = string.concat(
            '{"types":{"GaslessTransfer":[{"name":"token","type":"address"},{"name":"from","type":"address"},',
            '{"name":"to","type":"address"},{"name":"amount","type":"uint256"},{"name":"fee","type":"uint256"},',
            '{"name":"relay","type":"address"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"},',
            '{"name":"auth","type":"TokenAuth"}],',
            '"TokenAuth":[{"name":"mode","type":"uint8"},{"name":"v","type":"uint8"},{"name":"r","type":"bytes32"},',
            '{"name":"s","type":"bytes32"}]},',
            '"primaryType":"GaslessTransfer",',
            '"domain":{"name":"Nimiq Gasless Transfer","version":"3","chainId":137,',
            '"verifyingContract":"0x1000000000000000000000000000000000000001"},',
            '"message":{"token":"0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",',
            '"from":"0x2000000000000000000000000000000000000002","to":"0x3000000000000000000000000000000000000003",',
            '"amount":"250000000","fee":"20000","relay":"0x4000000000000000000000000000000000000004",',
            '"nonce":"7","deadline":"1790000000","auth":{"mode":1,"v":27,',
            '"r":"0x0101010101010101010101010101010101010101010101010101010101010101",',
            '"s":"0x0202020202020202020202020202020202020202020202020202020202020202"}}}'
        );

        bytes32 digest = GaslessTransfer(verifyingContract).hashTransfer(r, 7, auth);
        assertEq(digest, vm.eip712HashTypedData(typedData), "contract digest == forge EIP-712 digest");
        assertEq(digest, _transferDigest(r, 7, auth, verifyingContract), "contract digest == test helper digest");
        assertEq(digest, GOLDEN_DIGEST, "golden digest");
        assertEq(
            GaslessTransfer(verifyingContract).DOMAIN_SEPARATOR(), GOLDEN_DOMAIN_SEPARATOR, "golden domain separator"
        );
    }

    bytes32 internal constant GOLDEN_DIGEST = 0x9648bc257717069e3c477bfa718892deaf7ac75c4466ae3aa80350922b621ab7;
    bytes32 internal constant GOLDEN_DOMAIN_SEPARATOR =
        0x03db845517913f4867fd5147fed3b13e71422ab18322688dcea57f997fe94623;
    /// @dev The spec's type hashes (typeHash and tokenAuthTypeHash of the golden vectors).
    bytes32 internal constant SPEC_TRANSFER_TYPEHASH =
        0x7ab85ade3e686e1c69984c37565b73a20f3bea60cd9870d043cac7acb2d10273;
    bytes32 internal constant SPEC_TOKEN_AUTH_TYPEHASH =
        0xd2c6df1fc0c41180a4ec92ee33b18dac8247c79ed4d0a933db3cb5a9338acabe;

    // --- Helpers -------------------------------------------------------------------------------------

    /// @dev The one slot tokenConfig(token) reads.
    function _configSlot(address token) internal returns (bytes32) {
        vm.record();
        gasless.tokenConfig(token);
        (bytes32[] memory reads,) = vm.accesses(address(gasless));
        assertEq(reads.length, 1, "tokenConfig() reads one slot");
        return reads[0];
    }

    function _assertConfigReadOnce(TransferRequest memory r, TokenAuth memory auth, bytes32 slot) internal {
        bytes memory sig = _signTransfer(alicePk, r, auth);
        vm.record();
        _submit(r, sig, auth);
        (bytes32[] memory reads,) = vm.accesses(address(gasless));
        uint256 n;
        for (uint256 i = 0; i < reads.length; ++i) {
            if (reads[i] == slot) ++n;
        }
        assertEq(n, 1, "relayTransfer reads the token configuration once");
    }

    function _expectInvalidConfig(TokenInit[] memory tokens) internal {
        vm.expectRevert(IGaslessBase.InvalidConfig.selector);
        new GaslessTransfer(owner, tokens);
    }

    function _assertConfig(TokenConfig memory c, bool permit, bool metaTx, bool allowance) internal pure {
        assertEq(c.permit, permit, "permit");
        assertEq(c.metaTxApprove, metaTx, "metaTxApprove");
        assertEq(c.allowance, allowance, "allowance");
    }

    /// @dev Bit 0 permit, bit 1 metaTxApprove, bit 2 allowance.
    function _flags(uint256 flags) internal pure returns (TokenConfig memory) {
        return _config(flags & 1 != 0, flags & 2 != 0, flags & 4 != 0);
    }
}
