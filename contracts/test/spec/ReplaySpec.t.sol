// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthMode, IGaslessBase, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

import {SpecBase} from "./SpecBase.sol";

/// @notice Replay protection (D2, P2): T04, T05-T07 and T26 (docs/STEP-1-GAS-ABSTRACTION.md §2, §3, §8). The intent
///         nonce is sequential per signer, read from storage and signed; it is not part of the call data.
contract ReplaySpecTest is SpecBase {
    // ================================================================ T04

    /// @notice T04: the same request submitted twice fails the second time, in every route: its signature was for the
    ///         nonce that the first call used. NONE mode gets a double allowance first, so that only the nonce can stop
    ///         the second transfer.
    function test_T04_sameRequestTwiceReverts() public {
        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            bytes memory sig = signRequest(aliceKey, r, auth);
            if (mode == AuthMode.NONE) {
                vm.prank(alice);
                IERC20Approve(token).approve(address(gasless), 2 * (r.amount + r.fee));
            }

            State memory before = observe(r);
            submit(r, sig, auth);
            assertTransferred(r, before);

            expectRevertNoChange(relay, r, sig, auth, errInvalidSignature());
        }
    }

    /// @notice T04 (fuzz): any executed request of a max-approved signer fails on resubmission, from any relay path.
    function testFuzz_T04_replayAlwaysReverts(uint256 startNonce, uint256 amount, uint256 fee, bool viaUsdt) public {
        startNonce = bound(startNonce, 0, MAX_NONCE_INCREASE);
        if (startNonce > 0) {
            vm.prank(victim);
            gasless.invalidateNonces(startNonce);
        }
        TransferRequest memory r = request(viaUsdt ? address(usdt) : address(usdc), victim);
        r.amount = bound(amount, 1, FUNDS / 2);
        r.fee = bound(fee, 0, MAX_TEST_FEE);
        bytes memory sig = signRequest(victimKey, r, noAuth());

        submit(r, sig, noAuth());
        assertEq(gasless.nonces(victim), startNonce + 1);
        expectRevertNoChange(relay, r, sig, noAuth(), errInvalidSignature());
        expectRevertNoChange(otherRelay, r, sig, noAuth(), errInvalidSignature());
    }

    // ================================================================ T05

    /// @notice T05: a request signed for one GaslessTransfer deployment is invalid on another deployment with the
    ///         same configuration (where the signer has the same nonce), before and after it was executed on the
    ///         first one.
    function test_T05_replayAgainstAnotherContractReverts() public {
        IGaslessTransfer other = deployGasless(defaultTokens());
        assertTrue(address(other) != address(gasless));
        vm.startPrank(alice);
        usdc.approve(address(gasless), type(uint256).max);
        usdc.approve(address(other), type(uint256).max);
        usdt.approve(address(gasless), type(uint256).max);
        usdt.approve(address(other), type(uint256).max);
        // Same nonce on both deployments before the first execution.
        other.invalidateNonces(1);
        gasless.invalidateNonces(1);
        vm.stopPrank();

        address[2] memory tokens = [address(usdc), address(usdt)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TransferRequest memory r = request(tokens[i], alice);
            bytes memory sig = signRequest(aliceKey, r, noAuth());
            State memory before = observe(r);

            vm.expectRevert(errInvalidSignature());
            vm.prank(relay);
            other.relayTransfer(r, sig, noAuth());

            submit(r, sig, noAuth());
            assertTransferred(r, before);

            vm.expectRevert(errInvalidSignature());
            vm.prank(relay);
            other.relayTransfer(r, sig, noAuth());
            assertEq(other.nonces(alice), 1, "other deployment untouched");
        }
    }

    // ================================================================ T06

    /// @notice T06: after a chain id change the domain separator is recomputed, a Polygon signature is rejected on the
    ///         other chain, an Amoy signature is rejected on Polygon, and the Polygon signature still works on Polygon.
    function test_T06_replayOnAnotherChainReverts() public {
        vm.prank(alice);
        usdc.approve(address(gasless), type(uint256).max);
        TransferRequest memory r = request(address(usdc), alice);
        bytes memory polygonSig = signRequest(aliceKey, r, noAuth());
        bytes memory amoySig = signDigest(aliceKey, digestFor(r, 0, noAuth(), AMOY, address(gasless)));

        vm.chainId(AMOY);
        assertEq(gasless.DOMAIN_SEPARATOR(), domainSeparator(AMOY, address(gasless)), "separator not recomputed");
        (,,, uint256 chainId,,,) = gasless.eip712Domain();
        assertEq(chainId, AMOY);
        expectRevertNoChange(relay, r, polygonSig, noAuth(), errInvalidSignature());

        vm.chainId(POLYGON);
        assertEq(gasless.DOMAIN_SEPARATOR(), domainSeparator(POLYGON, address(gasless)));
        expectRevertNoChange(relay, r, amoySig, noAuth(), errInvalidSignature());

        State memory before = observe(r);
        submit(r, polygonSig, noAuth());
        assertTransferred(r, before);
    }

    /// @notice T06 (fuzz): a Polygon signature is rejected on any other chain id.
    function testFuzz_T06_anyOtherChainReverts(uint64 chainId) public {
        vm.assume(chainId != POLYGON && chainId != 0);
        TransferRequest memory r = request(address(usdt), victim);
        bytes memory sig = signRequest(victimKey, r, noAuth());
        vm.chainId(chainId);
        expectRevertNoChange(relay, r, sig, noAuth(), errInvalidSignature());
    }

    // ================================================================ T07

    /// @notice T07: a signature for a USDC request does not authorize the same request for USDT0 (the token is a
    ///         signed field), before or after the USDC request was executed, and vice versa.
    function test_T07_replayWithAnotherTokenReverts() public {
        vm.startPrank(alice);
        usdc.approve(address(gasless), type(uint256).max);
        usdt.approve(address(gasless), type(uint256).max);
        vm.stopPrank();

        TransferRequest memory r = request(address(usdc), alice);
        bytes memory sig = signRequest(aliceKey, r, noAuth());
        TransferRequest memory swapped = copy(r);
        swapped.token = address(usdt);

        expectRevertNoChange(relay, swapped, sig, noAuth(), errInvalidSignature());
        State memory before = observe(r);
        submit(r, sig, noAuth());
        assertTransferred(r, before);
        expectRevertNoChange(relay, swapped, sig, noAuth(), errInvalidSignature());

        TransferRequest memory r2 = request(address(usdt), alice);
        bytes memory sig2 = signRequest(aliceKey, r2, noAuth());
        TransferRequest memory swapped2 = copy(r2);
        swapped2.token = address(usdc);
        expectRevertNoChange(relay, swapped2, sig2, noAuth(), errInvalidSignature());
    }

    // ================================================================ T26

    /// @notice T26: nonces are sequential: requests signed for nonces 0 to 3 execute only in that order, each exactly
    ///         once; a request for a later nonce is invalid until every earlier one is used.
    function test_T26_sequentialNoncesExecuteInOrder() public {
        vm.prank(alice);
        usdc.approve(address(gasless), type(uint256).max);
        TransferRequest[4] memory rs;
        bytes[4] memory sigs;
        for (uint256 i = 0; i < 4; ++i) {
            rs[i] = request(address(usdc), alice);
            rs[i].amount = AMOUNT + i;
            sigs[i] = signRequestAt(aliceKey, rs[i], i, noAuth());
        }

        for (uint256 k = 0; k < 4; ++k) {
            for (uint256 later = k + 1; later < 4; ++later) {
                expectRevertNoChange(relay, rs[later], sigs[later], noAuth(), errInvalidSignature());
            }
            State memory before = observe(rs[k]);
            submit(rs[k], sigs[k], noAuth());
            assertTransferred(rs[k], before);
        }
        for (uint256 i = 0; i < 4; ++i) {
            expectRevertNoChange(relay, rs[i], sigs[i], noAuth(), errInvalidSignature());
        }
        assertEq(gasless.nonces(alice), 4);
    }

    /// @notice T26: invalidateNonces raises only the caller's nonce, emits NonceInvalidated(signer, previous, new),
    ///         makes every request signed below the new nonce unexecutable, and affects no other signer.
    function test_T26_invalidateNoncesRaisesOnlyTheCallersNonce() public {
        vm.prank(alice);
        usdc.approve(address(gasless), type(uint256).max);
        TransferRequest memory pending = request(address(usdc), alice);
        bytes memory sig0 = signRequestAt(aliceKey, pending, 0, noAuth());
        bytes memory sig1 = signRequestAt(aliceKey, pending, 1, noAuth());
        bytes memory sig2 = signRequestAt(aliceKey, pending, 2, noAuth());
        VictimState memory victimBefore = observeVictim();
        uint256 aliceBalance = usdc.balanceOf(alice);

        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.NonceInvalidated(alice, 0, 2);
        vm.prank(alice);
        gasless.invalidateNonces(2);

        assertEq(gasless.nonces(alice), 2);
        assertEq(gasless.nonces(bob), 0);
        assertEq(usdc.balanceOf(alice), aliceBalance, "invalidateNonces moved funds");
        assertVictimUntouched(victimBefore);

        expectRevertNoChange(relay, pending, sig0, noAuth(), errInvalidSignature());
        expectRevertNoChange(relay, pending, sig1, noAuth(), errInvalidSignature());
        State memory before = observe(pending);
        submit(pending, sig2, noAuth());
        assertTransferred(pending, before);

        // Bob can still use nonce 0.
        TransferRequest memory bobs = request(address(usdt), bob);
        TokenAuth memory auth = authorize(bobKey, bobs, AuthMode.NONE);
        before = observe(bobs);
        submit(bobs, signRequestAt(bobKey, bobs, 0, auth), auth);
        assertTransferred(bobs, before);
    }

    /// @notice T26: a third party calling invalidateNonces raises only its own nonce; the signer's request still
    ///         executes.
    function test_T26_thirdPartyCannotInvalidateSomeoneElsesNonce() public {
        TransferRequest memory r = request(address(usdc), victim);
        bytes memory sig = signRequest(victimKey, r, noAuth());

        vm.prank(attacker);
        gasless.invalidateNonces(1);
        vm.prank(relay);
        gasless.invalidateNonces(MAX_NONCE_INCREASE);
        assertEq(gasless.nonces(victim), 0);

        State memory before = observe(r);
        submit(r, sig, noAuth());
        assertTransferred(r, before);
    }

    /// @notice T26: the increase is bounded to [1, 2^32 - 1] per call; other values revert InvalidNonceIncrease.
    function test_T26_invalidateNoncesBounds() public {
        vm.startPrank(alice);
        vm.expectRevert(errInvalidNonceIncrease(0, 0));
        gasless.invalidateNonces(0);
        vm.expectRevert(errInvalidNonceIncrease(0, MAX_NONCE_INCREASE + 1));
        gasless.invalidateNonces(MAX_NONCE_INCREASE + 1);
        gasless.invalidateNonces(MAX_NONCE_INCREASE);
        vm.expectRevert(errInvalidNonceIncrease(MAX_NONCE_INCREASE, MAX_NONCE_INCREASE));
        gasless.invalidateNonces(MAX_NONCE_INCREASE);
        vm.expectRevert(errInvalidNonceIncrease(MAX_NONCE_INCREASE, 1));
        gasless.invalidateNonces(1);
        vm.stopPrank();
        assertEq(gasless.nonces(alice), MAX_NONCE_INCREASE);
    }

    /// @notice T26 / TI3 (fuzz): raising one signer's nonce sets exactly that nonce and nothing else.
    function testFuzz_T26_invalidateNoncesIsolation(address caller, uint256 newNonce, address other) public {
        assumeNotForgeAddress(caller);
        vm.assume(caller != other);
        newNonce = bound(newNonce, 1, MAX_NONCE_INCREASE);
        assertEq(gasless.nonces(caller), 0);

        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.NonceInvalidated(caller, 0, newNonce);
        vm.prank(caller);
        gasless.invalidateNonces(newNonce);

        assertEq(gasless.nonces(caller), newNonce);
        assertEq(gasless.nonces(other), 0);
        assertEq(usdc.balanceOf(address(gasless)), 0);
        assertEq(usdt.balanceOf(address(gasless)), 0);
    }
}

interface IERC20Approve {
    function approve(address spender, uint256 value) external returns (bool);
}
