// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";

import {AuthMode, IGaslessBase, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice Sequential per-signer nonces and invalidateNonces: T26, TI3 and D2. The nonce is not part of the call data:
///         relayTransfer signs over nonces(from) and raises it by exactly one; invalidateNonces raises the caller's own
///         nonce by 1 to 2^32 - 1, which invalidates every request signed for a nonce below the new one.
contract NoncesTest is GaslessTestBase {
    using stdStorage for StdStorage;

    // --- relayTransfer ------------------------------------------------------------------------------

    /// @dev Every mode reads the nonce from storage and raises it by exactly one; nothing else changes it.
    function test_T26_nonceFromStorage_incrementsByOne() public {
        AuthMode[5] memory modes =
            [AuthMode.PERMIT, AuthMode.NONE, AuthMode.PERMIT, AuthMode.META_TX_APPROVE, AuthMode.NONE];
        address[5] memory tokens = [address(usdc), address(usdc), address(usdt0), address(usdt0), address(usdt0)];
        for (uint256 i = 0; i < modes.length; ++i) {
            TransferRequest memory r = _request(tokens[i], 1e6, 10_000);
            TokenAuth memory auth = _authFor(alicePk, r, modes[i]);
            bytes memory sig = _signTransfer(alicePk, r, auth);
            assertEq(gasless.nonces(alice), i, "nonce before");
            _submit(r, sig, auth);
            assertEq(gasless.nonces(alice), i + 1, "nonce after");
        }
        assertEq(gasless.nonces(bob), 0, "other signers untouched");
    }

    /// @dev A signature for nonce n is invalid once n is consumed, and one for n + 1 is invalid until then.
    function test_T26_signatureBoundToCurrentNonce() public {
        _approve(address(usdc), alice, type(uint256).max);
        TransferRequest memory first = _request(address(usdc), 1e6, 0);
        TransferRequest memory second = _request(address(usdc), 2e6, 0);
        bytes memory sig0 = _signTransferAt(alicePk, first, 0, _noneAuth());
        bytes memory sig1 = _signTransferAt(alicePk, second, 1, _noneAuth());

        _expectRevert(second, sig1, _noneAuth(), _errInvalidSignature());
        _submit(first, sig0, _noneAuth());
        _expectRevert(first, sig0, _noneAuth(), _errInvalidSignature());
        _submit(second, sig1, _noneAuth());
        _expectRevert(second, sig1, _noneAuth(), _errInvalidSignature());
        assertEq(usdc.balanceOf(bob), 3e6, "each request exactly once");
        assertEq(gasless.nonces(alice), 2);
    }

    /// @dev Two versions of one payment (a correction) share the nonce: only one of them can ever execute.
    function test_T26_correctionsShareTheNonce() public {
        _approve(address(usdc), alice, type(uint256).max);
        TransferRequest memory original = _request(address(usdc), 10e6, 1e6);
        TransferRequest memory correction = _copy(original);
        correction.fee = 2e6;
        bytes memory sig1 = _signTransfer(alicePk, original, _noneAuth());
        bytes memory sig2 = _signTransfer(alicePk, correction, _noneAuth());

        _submit(correction, sig2, _noneAuth());
        _expectRevert(original, sig1, _noneAuth(), _errInvalidSignature());
        assertEq(usdc.balanceOf(bob), 10e6, "paid once");
    }

    /// @dev A failed relayTransfer never spends the nonce (the whole call reverts).
    function test_TI3_failedTransfer_keepsNonce() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _expectRevert(r, sig, _noneAuth(), _errInsufficientAllowance(0, 11e6));
        assertEq(gasless.nonces(alice), 0, "unchanged after a failed call");
        _approve(address(usdc), alice, 11e6);
        _submit(r, sig, _noneAuth());
        assertEq(gasless.nonces(alice), 1, "used after success");
    }

    /// @dev The same nonce value is independent per signer.
    function test_T26_sameNonceDifferentSigners() public {
        (address carol, uint256 carolPk) = makeAddrAndKey("carol");
        usdc.mint(carol, 100e6);

        TransferRequest memory a = _request(address(usdc), 1e6, 0);
        TransferRequest memory c = _request(address(usdc), 2e6, 0);
        c.from = carol;
        TokenAuth memory aAuth = _permitFor(alicePk, a);
        TokenAuth memory cAuth = _permitFor(carolPk, c);
        bytes memory aSig = _signTransfer(alicePk, a, aAuth);
        bytes memory cSig = _signTransfer(carolPk, c, cAuth);

        _submit(a, aSig, aAuth);
        _submit(c, cSig, cAuth);
        assertEq(usdc.balanceOf(bob), 3e6, "both executed at nonce 0");
        assertEq(gasless.nonces(alice), 1);
        assertEq(gasless.nonces(carol), 1);
    }

    // --- invalidateNonces -----------------------------------------------------------------------------

    /// @dev One call invalidates every signed request below the new nonce; the request at the new nonce executes.
    function test_T26_invalidateNonces_cancelsSeveralRequests() public {
        _approve(address(usdc), alice, type(uint256).max);
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes[3] memory sigs;
        for (uint256 n = 0; n < 3; ++n) {
            sigs[n] = _signTransferAt(alicePk, r, n, _noneAuth());
        }
        bytes memory next = _signTransferAt(alicePk, r, 3, _noneAuth());

        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.NonceInvalidated(alice, 0, 3);
        vm.prank(alice);
        gasless.invalidateNonces(3);
        assertEq(gasless.nonces(alice), 3, "raised");

        for (uint256 n = 0; n < 3; ++n) {
            _expectRevert(r, sigs[n], _noneAuth(), _errInvalidSignature());
        }
        assertEq(usdc.balanceOf(bob), 0, "nothing moved");
        _submit(r, next, _noneAuth());
        assertEq(usdc.balanceOf(bob), 10e6, "the request at the new nonce executes");
        assertEq(gasless.nonces(alice), 4);
    }

    /// @dev The new nonce must be above the current one by 1 to 2^32 - 1; anything else changes nothing.
    function test_T26_invalidateNonces_bounds() public {
        vm.startPrank(alice);
        vm.expectRevert(_errInvalidNonceIncrease(0, 0));
        gasless.invalidateNonces(0);
        vm.expectRevert(_errInvalidNonceIncrease(0, MAX_NONCE_INCREASE + 1));
        gasless.invalidateNonces(MAX_NONCE_INCREASE + 1);
        vm.expectRevert(_errInvalidNonceIncrease(0, type(uint256).max));
        gasless.invalidateNonces(type(uint256).max);

        gasless.invalidateNonces(1);
        vm.expectRevert(_errInvalidNonceIncrease(1, 1));
        gasless.invalidateNonces(1);
        vm.expectRevert(_errInvalidNonceIncrease(1, 0));
        gasless.invalidateNonces(0);

        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.NonceInvalidated(alice, 1, 1 + MAX_NONCE_INCREASE);
        gasless.invalidateNonces(1 + MAX_NONCE_INCREASE);
        vm.expectRevert(_errInvalidNonceIncrease(1 + MAX_NONCE_INCREASE, 1 + 2 * MAX_NONCE_INCREASE + 1));
        gasless.invalidateNonces(1 + 2 * MAX_NONCE_INCREASE + 1);
        vm.stopPrank();
        assertEq(gasless.nonces(alice), 1 + MAX_NONCE_INCREASE, "only the valid increases count");
    }

    /// @dev Near the top of the range the bound is computed without overflow: the nonce can reach 2^256 - 1 but
    ///      never wraps.
    function test_T26_invalidateNonces_topOfRange() public {
        uint256 high = type(uint256).max - 10;
        stdstore.target(address(gasless)).sig(gasless.nonces.selector).with_key(alice).checked_write(high);
        assertEq(gasless.nonces(alice), high, "stored");
        vm.startPrank(alice);
        vm.expectRevert(_errInvalidNonceIncrease(high, high - 1));
        gasless.invalidateNonces(high - 1);
        gasless.invalidateNonces(type(uint256).max);
        vm.expectRevert(_errInvalidNonceIncrease(type(uint256).max, type(uint256).max));
        gasless.invalidateNonces(type(uint256).max);
        vm.stopPrank();
        assertEq(gasless.nonces(alice), type(uint256).max);
    }

    /// @dev invalidateNonces only ever raises the caller's own nonce.
    function test_T26_invalidateNonces_onlyRaisesOwnNonce() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, permit);
        vm.prank(attacker);
        gasless.invalidateNonces(1);
        assertEq(gasless.nonces(attacker), 1, "attacker's own nonce");
        assertEq(gasless.nonces(alice), 0, "alice's nonce untouched");
        _submit(r, sig, permit);
        assertEq(usdc.balanceOf(bob), 10e6, "alice's request still executes");
    }

    /// @dev After an execution, invalidating the executed nonce is no longer possible: the current nonce is already
    ///      past it, and only higher values are accepted.
    function test_T26_invalidateNonces_afterExecution() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, permit), permit);
        vm.prank(alice);
        vm.expectRevert(_errInvalidNonceIncrease(1, 1));
        gasless.invalidateNonces(1);
    }

    /// @dev TI3: nonces only increase, and raising one signer's nonce never affects another signer's.
    function testFuzz_TI3_invalidateIsIsolated(address signer, address otherSigner, uint256 step, uint256 bad) public {
        vm.assume(signer != otherSigner && signer != address(vm));
        step = bound(step, 1, MAX_NONCE_INCREASE);
        vm.prank(signer);
        gasless.invalidateNonces(step);
        assertEq(gasless.nonces(signer), step, "raised");
        assertEq(gasless.nonces(otherSigner), 0, "other signer");

        // Any value that is not above the current one, or too far above it, reverts and changes nothing.
        if (bad > step && bad - step <= MAX_NONCE_INCREASE) bad = step;
        vm.prank(signer);
        vm.expectRevert(_errInvalidNonceIncrease(step, bad));
        gasless.invalidateNonces(bad);
        assertEq(gasless.nonces(signer), step, "never decreases");
    }

    /// @dev invalidateNonces is not payable and moves no tokens.
    function test_T26_invalidateNonces_movesNothing() public {
        uint256[] memory before = _balances();
        vm.prank(alice);
        gasless.invalidateNonces(7);
        _assertBalancesUnchanged(before);
    }
}
