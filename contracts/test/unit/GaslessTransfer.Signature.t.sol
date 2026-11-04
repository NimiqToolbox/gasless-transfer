// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, IGaslessBase, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {PermissiveERC1271Wallet} from "../mocks/MockAccounts.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice Signature/domain binding: T01-T09, T11, T19, T28 and D1, with a maximum approved allowance. The signature
///         also covers the nonce (read from storage) and the token authorization.
contract GaslessTransferSignatureTest is GaslessTestBase {
    address internal victim;

    function setUp() public override {
        super.setUp();
        victim = alice;
        _approve(address(usdc), victim, type(uint256).max);
        _approve(address(usdt0), victim, type(uint256).max);
    }

    // --- T01 / A1: an unsigned-pull attempt ------------------------------------------------------------

    /// @dev The attacker is the relay of its own requests, so `msg.sender == r.relay` holds and only the signature
    ///      stands between the attacker and the victim's max allowance.
    function test_T01_A1_victimWithMaxAllowance_cannotBeDrained() public {
        uint256[] memory before = _balances();
        address[2] memory tokens = [address(usdc), address(usdt0)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TransferRequest memory r = _drainRequest(tokens[i]);

            // Empty signature.
            _expectRevertFrom(attacker, r, "", _noneAuth(), _errInvalidSignature());
            // The attacker's own signature.
            _expectRevertFrom(
                attacker, r, _signTransfer(attackerPk, r, _noneAuth()), _noneAuth(), _errInvalidSignature()
            );
            // A tampered victim signature (one bit of s flipped).
            bytes memory tampered = _signTransfer(alicePk, r, _noneAuth());
            tampered[40] ^= 0x01;
            _expectRevertFrom(attacker, r, tampered, _noneAuth(), _errInvalidSignature());

            // A genuine victim signature, but bound to another relay.
            TransferRequest memory honest = _drainRequest(tokens[i]);
            honest.relay = relay;
            bytes memory victimSig = _signTransfer(alicePk, honest, _noneAuth());
            // ... submitted by the attacker as is: the attacker is not that relay.
            _expectRevertFrom(
                attacker,
                honest,
                victimSig,
                _noneAuth(),
                abi.encodeWithSelector(IGaslessBase.NotRelay.selector, attacker, relay)
            );
            // ... or with the relay field rewritten to the attacker: the signature no longer matches.
            honest.relay = attacker;
            _expectRevertFrom(attacker, honest, victimSig, _noneAuth(), _errInvalidSignature());
            // ... and it cannot be combined with any other token authorization either.
            _expectRevertFrom(attacker, honest, victimSig, _garbagePermit(), _errInvalidSignature());

            assertEq(gasless.nonces(victim), 0, "nonce untouched");
        }
        _assertBalancesUnchanged(before);
        assertEq(usdc.allowance(victim, address(gasless)), type(uint256).max, "allowance untouched");
        assertEq(usdt0.allowance(victim, address(gasless)), type(uint256).max, "allowance untouched");
    }

    // --- T02: every selector against a max-approved victim ----------------------------------------

    function test_T02_everySelector_movesNothing() public {
        uint256[] memory before = _balances();
        TransferRequest memory r = _drainRequest(address(usdc));
        vm.startPrank(attacker);

        // The functions of the §4.4 surface, with attacker-chosen arguments.
        _callExpectRevert(abi.encodeCall(gasless.relayTransfer, (r, "", _noneAuth())));
        _callExpectRevert(
            abi.encodeCall(gasless.relayTransfer, (r, _signTransfer(attackerPk, r, _noneAuth()), _noneAuth()))
        );
        _callExpectRevert(abi.encodeCall(gasless.relayTransfer, (r, new bytes(65), _garbagePermit())));
        _callExpectSuccess(abi.encodeCall(gasless.hashTransfer, (r, 0, _noneAuth())));
        _callExpectSuccess(abi.encodeCall(gasless.invalidateNonces, (1)));
        _callExpectSuccess(abi.encodeCall(gasless.nonces, (victim)));
        _callExpectSuccess(abi.encodeCall(gasless.tokenConfig, (address(usdc))));
        _callExpectSuccess(abi.encodeCall(gasless.DOMAIN_SEPARATOR, ()));
        _callExpectSuccess(abi.encodeCall(gasless.eip712Domain, ()));
        _callExpectSuccess(abi.encodeCall(gasless.TRANSFER_TYPE, ()));
        _callExpectSuccess(abi.encodeCall(gasless.TRANSFER_TYPEHASH, ()));
        _callExpectSuccess(abi.encodeCall(gasless.TOKEN_AUTH_TYPE, ()));
        _callExpectSuccess(abi.encodeCall(gasless.TOKEN_AUTH_TYPEHASH, ()));
        _callExpectSuccess(abi.encodeCall(gasless.owner, ()));
        _callExpectSuccess(abi.encodeCall(gasless.pendingOwner, ()));
        // The owner functions refuse anyone else.
        _callExpectRevert(abi.encodeCall(gasless.setTokenConfig, (address(usdc), _config(false, false, true))));
        _callExpectRevert(abi.encodeCall(gasless.transferOwnership, (attacker)));
        _callExpectRevert(abi.encodeCall(gasless.acceptOwnership, ()));
        _callExpectRevert(abi.encodeCall(gasless.renounceOwnership, ()));

        // Unsupported ERC-20 pulls, a generic executor call, an administrative rescue, multicall and empty calldata.
        _callExpectRevert(abi.encodeCall(IERC20.transferFrom, (victim, attacker, 1)));
        _callExpectRevert(
            abi.encodeWithSignature(
                "transferFrom(address,address,address,uint256)", address(usdc), victim, attacker, uint256(1)
            )
        );
        _callExpectRevert(
            abi.encodeWithSignature(
                "execute(address,uint256,bytes)",
                address(usdc),
                uint256(0),
                abi.encodeCall(IERC20.transferFrom, (victim, attacker, 1))
            )
        );
        _callExpectRevert(
            abi.encodeWithSignature("rescue(address,address,uint256)", address(usdc), attacker, uint256(1))
        );
        _callExpectRevert(abi.encodeWithSignature("multicall(bytes[])", new bytes[](0)));
        _callExpectRevert("");
        vm.stopPrank();

        _assertBalancesUnchanged(before);
        assertEq(gasless.nonces(victim), 0, "victim nonce untouched");
        assertEq(gasless.nonces(attacker), 1, "invalidateNonces only raised the caller's own nonce");
        assertEq(gasless.owner(), owner, "owner unchanged");
    }

    /// @dev Arbitrary calldata from an arbitrary caller never debits the max-approved victim.
    function testFuzz_T02_arbitraryCalldata_movesNothing(address caller, bytes calldata data) public {
        uint256[] memory before = _balances();
        vm.prank(caller);
        (bool success,) = address(gasless).call(data);
        success; // either outcome is fine; only the balances matter
        _assertBalancesUnchanged(before);
    }

    // --- T03 / A2: every signed field, the nonce, the token authorization, the chain id and the contract ---

    /// forge-config: default.fuzz.runs = 3000
    function testFuzz_T03_mutatingAnySignedField_reverts(uint8 field, uint256 seed) public {
        field = uint8(bound(field, 0, 13));
        TransferRequest memory r = _request(address(usdc), 100e6, 1e6);
        TokenAuth memory auth = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);
        uint256[] memory before = _balances();

        TransferRequest memory m = _copy(r);
        TokenAuth memory a = TokenAuth({mode: auth.mode, v: auth.v, r: auth.r, s: auth.s});
        bytes memory s = sig;
        address caller = r.relay;
        address target = address(gasless);
        if (field == 0) {
            m.token = address(usdt0);
        } else if (field == 1) {
            m.from = _otherAddress(seed, r.from);
        } else if (field == 2) {
            m.to = _otherAddress(seed, r.to);
        } else if (field == 3) {
            m.amount = _otherUint(seed, r.amount, 1, INITIAL_BALANCE - MAX_TEST_FEE);
        } else if (field == 4) {
            m.fee = _otherUint(seed, r.fee, 0, MAX_TEST_FEE);
        } else if (field == 5) {
            m.relay = _otherAddress(seed, r.relay);
            caller = m.relay;
        } else if (field == 6) {
            // Signed for another nonce than the current one.
            s = _signTransferAt(alicePk, r, _otherUint(seed, 0, 0, type(uint256).max), auth);
        } else if (field == 7) {
            m.deadline = _otherUint(seed, r.deadline, vm.getBlockTimestamp(), vm.getBlockTimestamp() + 2 hours);
        } else if (field == 8) {
            a.mode = seed % 2 == 0 ? AuthMode.NONE : AuthMode.META_TX_APPROVE;
        } else if (field == 9) {
            a.v = uint8(_otherUint(seed, auth.v, 0, type(uint8).max));
        } else if (field == 10) {
            a.r = bytes32(_otherUint(seed, uint256(auth.r), 0, type(uint256).max));
        } else if (field == 11) {
            a.s = bytes32(_otherUint(seed, uint256(auth.s), 0, type(uint256).max));
        } else if (field == 12) {
            vm.chainId(_otherUint(seed, vm.getChainId(), 1, type(uint64).max));
        } else {
            target = address(new GaslessTransfer(owner, stablecoinInits(address(usdc), address(usdt0))));
        }

        vm.prank(caller);
        vm.expectRevert(_errInvalidSignature());
        GaslessTransfer(target).relayTransfer(m, s, a);
        _assertBalancesUnchanged(before);
        assertEq(gasless.nonces(alice), 0, "nonce untouched");

        // The unmodified request succeeds on the original chain and contract.
        vm.chainId(31_337);
        _submit(r, sig, auth);
        assertEq(usdc.balanceOf(bob), 100e6, "original request");
    }

    /// @dev A relay cannot swap the signed token authorization for another one, not even for a valid one the same
    ///      user signed for the same request, nor submit a NONE request with a token signature attached.
    function test_T03_tokenAuthorizationCannotBeReplaced() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        TokenAuth memory metaTx = _metaTxFor(alicePk, r);
        bytes memory permitSig = _signTransfer(alicePk, r, permit);
        bytes memory noneSig = _signTransfer(alicePk, r, _noneAuth());

        _expectRevert(r, permitSig, metaTx, _errInvalidSignature());
        _expectRevert(r, permitSig, _noneAuth(), _errInvalidSignature());
        _expectRevert(r, noneSig, permit, _errInvalidSignature());
        _expectRevert(r, noneSig, TokenAuth({mode: AuthMode.NONE, v: 27, r: 0, s: 0}), _errInvalidSignature());
        assertEq(gasless.nonces(alice), 0, "nonce untouched");

        _submit(r, permitSig, permit);
        assertEq(usdt0.balanceOf(bob), 100e6, "the signed authorization works");
    }

    // --- T04-T07 / A3: replay ---------------------------------------------------------------------

    function test_T04_sameRequestTwice_invalidSignature() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _submit(r, sig, _noneAuth());
        uint256[] memory before = _balances();

        // The signature was for nonce 0; the contract now expects nonce 1.
        _expectRevert(r, sig, _noneAuth(), _errInvalidSignature());
        // A fresh token authorization does not help: it is not what was signed.
        _expectRevert(r, sig, _permitFor(alicePk, r), _errInvalidSignature());
        _assertBalancesUnchanged(before);
    }

    function test_T05_replayOnAnotherContract_invalidSignature() public {
        GaslessTransfer other = new GaslessTransfer(owner, stablecoinInits(address(usdc), address(usdt0)));
        vm.prank(alice);
        usdc.approve(address(other), type(uint256).max);

        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        uint256[] memory before = _balances();

        vm.prank(relay);
        vm.expectRevert(_errInvalidSignature());
        other.relayTransfer(r, sig, _noneAuth());
        _assertBalancesUnchanged(before);
        assertTrue(other.DOMAIN_SEPARATOR() != gasless.DOMAIN_SEPARATOR(), "domains differ");

        // The same signature still works where it was meant to.
        _submit(r, sig, _noneAuth());
    }

    function test_T06_replayOnAnotherChain_invalidSignature() public {
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        bytes32 domainHere = gasless.DOMAIN_SEPARATOR();
        uint256[] memory before = _balances();

        vm.chainId(137);
        assertTrue(gasless.DOMAIN_SEPARATOR() != domainHere, "domain follows the chain id");
        assertEq(gasless.DOMAIN_SEPARATOR(), _transferDomainSeparator(address(gasless)), "recomputed domain");
        _expectRevert(r, sig, _noneAuth(), _errInvalidSignature());
        _assertBalancesUnchanged(before);

        vm.chainId(31_337);
        _submit(r, sig, _noneAuth());
    }

    function test_T07_replayWithAnotherToken_invalidSignature() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        uint256[] memory before = _balances();

        r.token = address(usdt0);
        _expectRevert(r, sig, _noneAuth(), _errInvalidSignature());
        _assertBalancesUnchanged(before);
    }

    /// @dev A signature under another domain version ("1"), over a type with a bytes32 nonce, never verifies here.
    function test_T05_domainVersion1SignatureRejected() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes32 domain1 = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("Nimiq Gasless Transfer"), keccak256("1"), vm.getChainId(), address(gasless)
            )
        );
        bytes32 typeHash1 = keccak256(
            "GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,bytes32 nonce,uint256 deadline)"
        );
        bytes32 struct1 =
            keccak256(abi.encode(typeHash1, r.token, r.from, r.to, r.amount, r.fee, r.relay, bytes32(0), r.deadline));
        bytes memory sig1 = _sign(alicePk, keccak256(abi.encodePacked("\x19\x01", domain1, struct1)));
        _expectRevert(r, sig1, _noneAuth(), _errInvalidSignature());
    }

    /// @dev A signature under another domain version ("2") over the same type and struct never verifies here. The
    ///      same request signed under version "3" executes.
    function test_T05_domainVersion2SignatureRejected() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        _approve(address(usdc), alice, 11e6);
        bytes32 domain2 = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("Nimiq Gasless Transfer"), keccak256("2"), vm.getChainId(), address(gasless)
            )
        );
        bytes32 structHash = _transferStructHash(r, 0, _noneAuth());
        bytes memory sig2 = _sign(alicePk, keccak256(abi.encodePacked("\x19\x01", domain2, structHash)));
        _expectRevert(r, sig2, _noneAuth(), _errInvalidSignature());
        assertEq(gasless.nonces(alice), 0, "nonce unused");

        _submit(r, _signTransfer(alicePk, r, _noneAuth()), _noneAuth());
        assertEq(usdc.balanceOf(bob), 10e6, "the version 3 signature executes");
    }

    // --- T08-T09 / D1: signature format -----------------------------------------------------------

    function test_T08_highS_invalidSignature() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes32 digest = _transferDigest(r, 0, _noneAuth(), address(gasless));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(alicePk, digest);
        // The malleable twin (n - s, flipped v) recovers the same address with plain ecrecover ...
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, rr, highS), alice, "malleable twin");
        // ... but is rejected.
        _expectRevert(r, abi.encodePacked(rr, highS, flippedV), _noneAuth(), _errInvalidSignature());
    }

    function test_T08_flippedV_invalidSignature() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(alicePk, _transferDigest(r, 0, _noneAuth(), address(gasless)));
        _expectRevert(r, abi.encodePacked(rr, s, v == 27 ? uint8(28) : uint8(27)), _noneAuth(), _errInvalidSignature());
        // Raw recovery ids (0/1) and other v values are rejected as well.
        _expectRevert(r, abi.encodePacked(rr, s, v - 27), _noneAuth(), _errInvalidSignature());
        _expectRevert(r, abi.encodePacked(rr, s, uint8(29)), _noneAuth(), _errInvalidSignature());
    }

    function test_T08_badLengths_invalidSignature() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        _approve(address(usdc), alice, 11e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(alicePk, _transferDigest(r, 0, _noneAuth(), address(gasless)));
        // EIP-2098 compact form (r, yParity|s): valid elsewhere, but only 65-byte signatures are accepted.
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));

        _expectRevert(r, "", _noneAuth(), _errInvalidSignature());
        _expectRevert(r, abi.encodePacked(rr, vs), _noneAuth(), _errInvalidSignature());
        _expectRevert(r, abi.encodePacked(sig, uint8(0)), _noneAuth(), _errInvalidSignature());
        _expectRevert(r, abi.encodePacked(sig, sig), _noneAuth(), _errInvalidSignature());
        _expectRevert(r, new bytes(65), _noneAuth(), _errInvalidSignature());

        _submit(r, sig, _noneAuth());
    }

    function test_T09_zeroFrom_invalidSigner() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        r.from = address(0);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _expectRevert(r, sig, _noneAuth(), abi.encodeWithSelector(IGaslessBase.InvalidSigner.selector));
        // A signature that recovers to nothing does not help either.
        _expectRevert(r, new bytes(65), _noneAuth(), abi.encodeWithSelector(IGaslessBase.InvalidSigner.selector));
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_D1_randomSignatures_invalidSignature(bytes memory sig) public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        vm.assume(keccak256(sig) != keccak256(_signTransfer(alicePk, r, _noneAuth())));
        _expectRevert(r, sig, _noneAuth(), _errInvalidSignature());
    }

    // --- T11: relay binding (D5) ------------------------------------------------------------------

    function test_T11_callerIsNotTheSignedRelay_notRelay() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        address otherRelay = makeAddr("otherRelay");
        _expectRevertFrom(
            otherRelay, r, sig, _noneAuth(), abi.encodeWithSelector(IGaslessBase.NotRelay.selector, otherRelay, relay)
        );
    }

    function test_T11_tamperedRelayField_invalidSignature() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        address otherRelay = makeAddr("otherRelay");
        r.relay = otherRelay;
        _expectRevertFrom(otherRelay, r, sig, _noneAuth(), _errInvalidSignature());
        assertEq(usdc.balanceOf(otherRelay), 0, "no fee for the impostor");
    }

    /// @dev A relay (even a compromised one) can only submit what was signed for it, with exactly those values.
    function test_T11_compromisedRelay_cannotChangeAmountFeeOrRecipient() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        uint256[] memory before = _balances();

        TransferRequest memory m = _copy(r);
        m.fee = MAX_TEST_FEE;
        _expectRevert(m, sig, _noneAuth(), _errInvalidSignature());
        m = _copy(r);
        m.to = relay;
        _expectRevert(m, sig, _noneAuth(), _errInvalidSignature());
        m = _copy(r);
        m.amount = 11e6;
        _expectRevert(m, sig, _noneAuth(), _errInvalidSignature());
        _assertBalancesUnchanged(before);
    }

    // --- T19: NONE mode still needs the intent signature ------------------------------------------

    function test_T19_noneModeWithAllowance_requiresIntentSignature() public {
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        uint256[] memory before = _balances();
        _expectRevert(r, "", _noneAuth(), _errInvalidSignature());
        _expectRevert(r, _signTransfer(attackerPk, r, _noneAuth()), _noneAuth(), _errInvalidSignature());
        _assertBalancesUnchanged(before);

        _submit(r, _signTransfer(alicePk, r, _noneAuth()), _noneAuth());
        assertEq(usdt0.balanceOf(bob), 10e6, "signed request executes");
    }

    // --- T28: contract signers (no ERC-1271) ------------------------------------------------------

    function test_T28_contractSigner_rejected() public {
        PermissiveERC1271Wallet wallet = new PermissiveERC1271Wallet();
        usdc.mint(address(wallet), 100e6);
        wallet.approve(IERC20(address(usdc)), address(gasless), type(uint256).max);

        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        r.from = address(wallet);
        // The wallet would accept any of these through ERC-1271; the contract only does ECDSA.
        _expectRevert(r, "", _noneAuth(), _errInvalidSignature());
        _expectRevert(r, new bytes(65), _noneAuth(), _errInvalidSignature());
        _expectRevert(r, _signTransfer(alicePk, r, _noneAuth()), _noneAuth(), _errInvalidSignature());
        assertEq(usdc.balanceOf(address(wallet)), 100e6, "wallet untouched");
    }

    // --- Helpers ----------------------------------------------------------------------------------

    function _drainRequest(address token) internal view returns (TransferRequest memory r) {
        r = _request(token, IERC20(token).balanceOf(victim), 0);
        r.from = victim;
        r.to = attacker;
        r.relay = attacker;
    }

    function _garbagePermit() internal pure returns (TokenAuth memory) {
        return TokenAuth({mode: AuthMode.PERMIT, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});
    }

    function _callExpectRevert(bytes memory data) internal {
        (bool success,) = address(gasless).call(data);
        assertFalse(success, "call should revert");
    }

    function _callExpectSuccess(bytes memory data) internal {
        (bool success,) = address(gasless).call(data);
        assertTrue(success, "call should succeed");
    }

    /// @dev A valid recipient/sender/relay address that differs from `current`.
    function _otherAddress(uint256 seed, address current) internal view returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode(seed, current)))));
        if (a == address(0) || a == current || a == address(usdc) || a == address(usdt0) || a == address(gasless)) {
            a = address(uint160(a) ^ 0x1234);
        }
    }

    /// @dev A value in [min, max] that differs from `current`.
    function _otherUint(uint256 seed, uint256 current, uint256 min, uint256 max) internal pure returns (uint256 v) {
        v = bound(seed, min, max);
        if (v == current) v = v == max ? v - 1 : v + 1;
    }
}
