// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {FalseReturnToken, NoReturnToken, ReentrantToken} from "../mocks/AdversarialTokens.sol";
import {EcdsaDelegate, PlainDelegate} from "../mocks/MockAccounts.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice Hostile or unusual tokens and accounts: T22 (reentrancy), T23 (no return value), T24 (USDC blacklist and
///         pause, USDT0 blocked list), T27 (EIP-7702 accounts), D2 (nonce used before any token call).
contract AdversarialTest is GaslessTestBase {
    // --- T22: reentrancy ---------------------------------------------------------------------------

    function test_T22_reentryFromTransferFrom_blocked() public {
        (ReentrantToken token, GaslessTransfer g) = _reentrantSetup();
        (, bytes memory innerCall) = _innerRequest(token, g);
        TransferRequest memory outer = _request(address(token), 10e6, 1e6);
        bytes memory outerSig = _signTransferFor(alicePk, outer, _noneAuth(), g);

        // The token bubbles the failed reentry: the whole call reverts with the guard's error.
        token.arm(address(g), innerCall, true);
        vm.prank(relay);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        g.relayTransfer(outer, outerSig, _noneAuth());

        // The token swallows it: the outer transfer completes, the inner one had no effect.
        token.arm(address(g), innerCall, false);
        vm.prank(relay);
        g.relayTransfer(outer, outerSig, _noneAuth());
        assertEq(token.callbacks(), 1, "one reentry attempt");
        assertFalse(token.lastCallbackSuccess(), "reentry failed");
        assertEq(
            token.lastCallbackResult(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(g.nonces(alice), 1, "only the outer request used a nonce");
        assertEq(token.balanceOf(bob), 10e6, "only the outer amount");
        assertEq(token.balanceOf(address(token)), 0, "no inner fee");
    }

    /// @dev A reentry from inside permit fails as well. If the token only records the failure, the valid permit
    ///      proceeds and only the outer, signed transfer happens. If it bubbles the failure, the try/catch swallows
    ///      the failed permit, but its rollback also re-arms the token, whose transferFrom then re-enters again and
    ///      reverts the whole call. Either way the inner request never executes. (For the bubbled case alice's
    ///      allowance is set to exactly amount + fee, the only allowance PERMIT mode accepts without the permit;
    ///      with the setup's unlimited allowance the call would stop at InsufficientAllowance before transferFrom.)
    function test_T22_reentryFromPermit_blocked() public {
        (ReentrantToken token, GaslessTransfer g) = _reentrantSetup();
        (, bytes memory innerCall) = _innerRequest(token, g);
        TransferRequest memory outer = _request(address(token), 10e6, 1e6);
        TokenAuth memory permit = _reentrantPermit(token, g, outer);
        bytes memory outerSig = _signTransferFor(alicePk, outer, permit, g);
        uint256 snapshot = vm.snapshotState();

        token.arm(address(g), innerCall, false);
        vm.prank(relay);
        g.relayTransfer(outer, outerSig, permit);
        assertEq(token.callbacks(), 1, "one reentry attempt");
        assertFalse(token.lastCallbackSuccess(), "reentry failed");
        assertEq(
            token.lastCallbackResult(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(g.nonces(alice), 1, "inner request not executed");
        assertEq(token.balanceOf(bob), 10e6, "only the outer amount");

        vm.revertToState(snapshot);
        vm.prank(alice);
        token.approve(address(g), outer.amount + outer.fee);
        token.arm(address(g), innerCall, true);
        vm.prank(relay);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        g.relayTransfer(outer, outerSig, permit);
        assertEq(g.nonces(alice), 0, "nothing executed");
        assertEq(token.balanceOf(bob), 0, "nothing moved");
    }

    // --- D2: the nonce is used before any external call ---------------------------------------------

    function test_D2_nonceAlreadyUsedWhenTokenIsCalled() public {
        (ReentrantToken token, GaslessTransfer g) = _reentrantSetup();
        TransferRequest memory r = _request(address(token), 10e6, 1e6);
        bytes memory probe = abi.encodeCall(g.nonces, (alice));
        uint256 snapshot = vm.snapshotState();

        // First external call in PERMIT mode: permit.
        TokenAuth memory permit = _reentrantPermit(token, g, r);
        bytes memory sig = _signTransferFor(alicePk, r, permit, g);
        token.arm(address(g), probe, true);
        vm.prank(relay);
        g.relayTransfer(r, sig, permit);
        assertEq(token.callbacks(), 1, "probed once");
        assertEq(token.lastCallbackResult(), abi.encode(uint256(1)), "nonce raised before permit");

        // First external call in NONE mode: the fee transferFrom.
        vm.revertToState(snapshot);
        sig = _signTransferFor(alicePk, r, _noneAuth(), g);
        token.arm(address(g), probe, true);
        vm.prank(relay);
        g.relayTransfer(r, sig, _noneAuth());
        assertEq(token.lastCallbackResult(), abi.encode(uint256(1)), "nonce raised before transferFrom");
    }

    // --- T23 and friends: non-standard return values --------------------------------------------------

    function test_T23_tokenWithoutReturnValue_works() public {
        NoReturnToken token = new NoReturnToken();
        GaslessTransfer g = _gaslessFor(address(token));
        token.mint(alice, 100e6);
        vm.prank(alice);
        token.approve(address(g), 11e6);

        TransferRequest memory r = _request(address(token), 10e6, 1e6);
        bytes memory sig = _signTransferFor(alicePk, r, _noneAuth(), g);
        vm.prank(relay);
        g.relayTransfer(r, sig, _noneAuth());
        assertEq(token.balanceOf(alice), 89e6, "sender");
        assertEq(token.balanceOf(bob), 10e6, "recipient");
        assertEq(token.balanceOf(relay), 1e6, "relay");
    }

    function test_T23_tokenReturningFalse_reverts() public {
        FalseReturnToken token = new FalseReturnToken();
        GaslessTransfer g = _gaslessFor(address(token));
        token.mint(alice, 100e6);
        vm.prank(alice);
        token.approve(address(g), 11e6);

        TransferRequest memory r = _request(address(token), 10e6, 1e6);
        bytes memory sig = _signTransferFor(alicePk, r, _noneAuth(), g);
        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        g.relayTransfer(r, sig, _noneAuth());
        assertEq(g.nonces(alice), 0, "nonce not spent");
        assertEq(token.balanceOf(alice), 100e6, "nothing moved");
    }

    // --- T24: USDC blacklist and pause, USDT0 blocked list (mocks; fork versions in test/fork) --------

    function test_T24_usdcBlacklist_everyParty() public {
        address[4] memory parties = [alice, bob, relay, address(gasless)];
        for (uint256 i = 0; i < parties.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            usdc.blacklist(parties[i]);
            TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
            _approve(address(usdc), alice, 11e6);
            _expectRevert(
                r, _signTransfer(alicePk, r, _noneAuth()), _noneAuth(), bytes("Blacklistable: account is blacklisted")
            );
            assertEq(gasless.nonces(alice), 0, "nonce not spent");
            vm.revertToState(snapshot);
        }
    }

    /// @dev FiatTokenV2_2.permit does not check the blacklist; the transfer does, so the whole call reverts.
    function test_T24_usdcBlacklistedSender_permitMode() public {
        usdc.blacklist(alice);
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _expectRevert(r, _signTransfer(alicePk, r, permit), permit, bytes("Blacklistable: account is blacklisted"));
        assertEq(usdc.allowance(alice, address(gasless)), 0, "permit rolled back");
    }

    function test_T24_usdcPaused() public {
        usdc.pause();
        // PERMIT: the paused permit is swallowed and the allowance check fails.
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _expectRevert(r, _signTransfer(alicePk, r, permit), permit, _errInsufficientAllowance(0, 11e6));
        // NONE: the paused transferFrom reverts.
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        usdc.unpause();
        _approve(address(usdc), alice, 11e6);
        usdc.pause();
        _expectRevert(r, sig, _noneAuth(), bytes("Pausable: paused"));
        usdc.unpause();
        _submit(r, sig, _noneAuth());
    }

    function test_T24_usdt0BlockedSender_reverts() public {
        usdt0.addToBlockedList(alice);
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        TokenAuth memory metaTx = _metaTxFor(alicePk, r);
        _expectRevert(r, _signTransfer(alicePk, r, metaTx), metaTx, bytes("USDT0: from is blocked"));
    }

    function test_T24_usdt0BlockedContract_reverts() public {
        usdt0.addToBlockedList(address(gasless));
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _expectRevert(r, _signTransfer(alicePk, r, permit), permit, bytes("Blocked: msg.sender is blocked"));
    }

    /// @dev USDT0 does not check the recipient or the fee receiver: blocked ones can still receive.
    function test_T24_usdt0BlockedRecipientAndRelay_stillReceive() public {
        usdt0.addToBlockedList(bob);
        usdt0.addToBlockedList(relay);
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, permit), permit);
        assertEq(usdt0.balanceOf(bob), 10e6, "blocked recipient received");
        assertEq(usdt0.balanceOf(relay), 1e6, "blocked relay received the fee");
    }

    // --- T27: EIP-7702 delegated EOAs -------------------------------------------------------------------

    /// @dev The intent signature is plain ECDSA, so a delegated EOA signs as before. USDC permit sees code at the
    ///      owner and takes the ERC-1271 path, which fails closed for a delegate without isValidSignature; USDT0
    ///      permit and meta-tx use ecrecover and keep working.
    function test_T27_eip7702Account_plainDelegate() public {
        (address eoa, uint256 eoaPk) = _delegatedEoa("eip7702-plain", address(new PlainDelegate()));

        // NONE mode.
        TransferRequest memory r = _requestFrom(eoa, address(usdc));
        _approve(address(usdc), eoa, 11e6);
        _submit(r, _signTransfer(eoaPk, r, _noneAuth()), _noneAuth());
        assertEq(usdc.balanceOf(eoa), 89e6, "NONE mode works");

        // USDC permit fails closed.
        r = _requestFrom(eoa, address(usdc));
        TokenAuth memory auth = _permitFor(eoaPk, r);
        _expectRevert(r, _signTransfer(eoaPk, r, auth), auth, _errInsufficientAllowance(0, 11e6));

        // USDT0 meta-tx and permit work.
        r = _requestFrom(eoa, address(usdt0));
        auth = _metaTxFor(eoaPk, r);
        _submit(r, _signTransfer(eoaPk, r, auth), auth);
        r = _requestFrom(eoa, address(usdt0));
        auth = _permitFor(eoaPk, r);
        _submit(r, _signTransfer(eoaPk, r, auth), auth);
        assertEq(usdt0.balanceOf(eoa), 78e6, "USDT0 modes work");
    }

    /// @dev With a delegate that validates the account's own ECDSA signature through ERC-1271, USDC permit works.
    function test_T27_eip7702Account_erc1271Delegate() public {
        (address eoa, uint256 eoaPk) = _delegatedEoa("eip7702-1271", address(new EcdsaDelegate()));
        TransferRequest memory r = _requestFrom(eoa, address(usdc));
        TokenAuth memory permit = _permitFor(eoaPk, r);
        _submit(r, _signTransfer(eoaPk, r, permit), permit);
        assertEq(usdc.balanceOf(bob), 10e6, "permit through ERC-1271");
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    function _reentrantSetup() internal returns (ReentrantToken token, GaslessTransfer g) {
        token = new ReentrantToken();
        g = _gaslessFor(address(token));
        token.mint(alice, 100e6);
        vm.prank(alice);
        token.approve(address(g), type(uint256).max);
    }

    /// @dev A valid EIP-2612 permit of the OpenZeppelin-based ReentrantToken for `g` over amount + fee.
    function _reentrantPermit(ReentrantToken token, GaslessTransfer g, TransferRequest memory r)
        internal
        view
        returns (TokenAuth memory)
    {
        return
            _signPermit(alicePk, address(token), alice, address(g), r.amount + r.fee, token.nonces(alice), r.deadline);
    }

    /// @dev A request alice signed with the token itself as relay, at nonce 1: the nonce the outer request leaves when
    ///      the token calls back. Without the guard, the reentrant call from the token would pass every check.
    function _innerRequest(ReentrantToken token, GaslessTransfer g)
        internal
        view
        returns (TransferRequest memory inner, bytes memory innerCall)
    {
        inner = _request(address(token), 5e6, 1e6);
        inner.relay = address(token);
        bytes memory innerSig = _sign(alicePk, _transferDigest(inner, 1, _noneAuth(), address(g)));
        innerCall = abi.encodeCall(g.relayTransfer, (inner, innerSig, _noneAuth()));
    }

    function _gaslessFor(address token) internal returns (GaslessTransfer) {
        return new GaslessTransfer(owner, _single(token, _config(true, false, true)));
    }

    function _delegatedEoa(string memory label, address delegate) internal returns (address eoa, uint256 pk) {
        (eoa, pk) = makeAddrAndKey(label);
        vm.signAndAttachDelegation(delegate, pk);
        usdc.mint(eoa, 100e6); // the next call carries the EIP-7702 authorization
        assertEq(eoa.code, abi.encodePacked(hex"ef0100", delegate), "delegation designator");
        usdt0.mint(eoa, 100e6);
    }

    function _requestFrom(address from, address token) internal view returns (TransferRequest memory r) {
        r = _request(token, 10e6, 1e6);
        r.from = from;
    }
}
