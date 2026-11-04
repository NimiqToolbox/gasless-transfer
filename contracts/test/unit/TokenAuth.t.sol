// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Vm} from "forge-std/Vm.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {INativeMetaTransaction} from "../../src/interfaces/INativeMetaTransaction.sol";
import {GasBurningPermitToken, PhantomPermitToken, RevertingPermitToken} from "../mocks/AdversarialTokens.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice TokenAuthLib through relayTransfer (§4.1, §5, D4): the contract builds the token call itself, a
///         front-run token authorization cannot block the request (A10), a wrong or missing one ends in a clean
///         InsufficientAllowance revert, and no allowance is left behind (TI5). The token authorization is signed
///         into the intent, so a new one needs a new intent signature (a correction at the same nonce).
contract TokenAuthTest is GaslessTestBase {
    bytes32 internal constant APPROVAL_EVENT = keccak256("Approval(address,address,uint256)");

    // --- T13-T15 / A10: front-running the token authorization -------------------------------------

    function test_T13_frontRunUsdcPermit_stillSucceeds() public {
        _assertFrontRunPermitSucceeds(address(usdc));
    }

    function test_T14_frontRunUsdt0Permit_stillSucceeds() public {
        _assertFrontRunPermitSucceeds(address(usdt0));
    }

    function test_T15_frontRunUsdt0MetaTx_stillSucceeds() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 1e6);
        TokenAuth memory auth = _metaTxFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);

        // The attacker submits the user's meta-transaction to the token directly. It can only execute the call
        // data that was signed: approve(this contract, amount + fee).
        vm.prank(attacker);
        usdt0.executeMetaTransaction(
            alice, abi.encodeCall(IERC20.approve, (address(gasless), 101e6)), auth.r, auth.s, auth.v
        );
        assertEq(usdt0.allowance(alice, address(gasless)), 101e6, "front-run approval");

        _submit(r, sig, auth);
        _assertDone(r);
    }

    /// @dev The meta-transaction always approves this contract for exactly amount + fee.
    function test_T15_metaTxSpenderIsAlwaysThisContract() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 1e6);
        TokenAuth memory auth = _metaTxFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);

        vm.recordLogs();
        _submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[1].topics[0], APPROVAL_EVENT, "meta-tx approval");
        assertEq(address(uint160(uint256(logs[1].topics[1]))), alice, "owner");
        assertEq(address(uint160(uint256(logs[1].topics[2]))), address(gasless), "spender");
        assertEq(abi.decode(logs[1].data, (uint256)), 101e6, "value");
    }

    /// @dev A meta-transaction signature for any other call data (here: approve for the attacker) is useless, even when
    ///      the user signed it into the intent.
    function test_T15_metaTxForOtherCallData_insufficientAllowance() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 1e6);
        TokenAuth memory auth = _signMetaTxApprove(alicePk, alice, attacker, 101e6, usdt0.getNonce(alice));
        _expectRevert(r, _signTransfer(alicePk, r, auth), auth, _errInsufficientAllowance(0, 101e6));
        assertEq(usdt0.allowance(alice, attacker), 0, "no approval for the attacker");
    }

    // --- T16: USDT0 shared-nonce DoS ---------------------------------------------------------------

    /// @dev Another USDT0 permit or meta-tx of the user consumes the shared nonce first: the relayed call reverts
    ///      cleanly (intent nonce unused, nothing moved) and the user can sign again, at the same intent nonce.
    function test_T16_usdt0SharedNonceConsumed_cleanRevertThenRetry() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 1e6);
        TokenAuth memory metaTx = _metaTxFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, metaTx);

        // The user's permit for some dApp lands first and consumes USDT0 nonce 0.
        TokenAuth memory otherPermit =
            _signPermit(alicePk, address(usdt0), alice, makeAddr("dApp"), 5e6, 0, vm.getBlockTimestamp() + 1 hours);
        usdt0.permit(
            alice, makeAddr("dApp"), 5e6, vm.getBlockTimestamp() + 1 hours, otherPermit.v, otherPermit.r, otherPermit.s
        );

        uint256[] memory before = _balances();
        _expectRevert(r, sig, metaTx, _errInsufficientAllowance(0, 101e6));
        _assertBalancesUnchanged(before);
        assertEq(gasless.nonces(alice), 0, "intent nonce still unused");

        // The relay cannot fix the token authorization on its own: a fresh one does not match the signature.
        TokenAuth memory fresh = _metaTxFor(alicePk, r);
        _expectRevert(r, sig, fresh, _errInvalidSignature());
        // Re-signed with the new token authorization (same intent nonce), the same transfer goes through.
        _submit(r, _signTransfer(alicePk, r, fresh), fresh);
        _assertDone(r);
    }

    function test_T16_usdt0PermitNonceConsumedByMetaTx_cleanRevert() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, permit);

        // An unrelated meta-transaction of the user (nonce 0) executes first.
        TokenAuth memory other = _signMetaTxApprove(alicePk, alice, makeAddr("dApp"), 1, 0);
        usdt0.executeMetaTransaction(
            alice, abi.encodeCall(IERC20.approve, (makeAddr("dApp"), 1)), other.r, other.s, other.v
        );

        _expectRevert(r, sig, permit, _errInsufficientAllowance(0, 101e6));
        assertEq(gasless.nonces(alice), 0, "intent nonce still unused");
    }

    // --- T17: the USDT0 permit domain --------------------------------------------------------------

    function test_T17_usdt0PermitWithStandardDomain_fails_saltDomainSucceeds() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 1e6);

        // Standard EIP-2612 domain (name, version, chainId, verifyingContract): wrong for USDT0.
        bytes32 standardDomain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("USDT0"), keccak256("1"), vm.getChainId(), address(usdt0)));
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, alice, address(gasless), 101e6, 0, r.deadline));
        (uint8 v, bytes32 rr, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", standardDomain, structHash)));
        TokenAuth memory wrong = TokenAuth({mode: AuthMode.PERMIT, v: v, r: rr, s: s});
        _expectRevert(r, _signTransfer(alicePk, r, wrong), wrong, _errInsufficientAllowance(0, 101e6));

        // Salt domain (name, version, verifyingContract, salt = chainId).
        assertEq(usdt0.DOMAIN_SEPARATOR(), _usdt0DomainSeparator(), "salt domain");
        TokenAuth memory permit = _permitFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, permit), permit);
        _assertDone(r);
    }

    // --- T18: the permit must match the request exactly --------------------------------------------

    function test_T18_permitValueNotAmountPlusFee_reverts() public {
        address[2] memory tokens = [address(usdc), address(usdt0)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TransferRequest memory r = _request(tokens[i], 100e6, 1e6);
            uint256 nonce = usdc.nonces(alice);
            if (tokens[i] == address(usdt0)) nonce = usdt0.nonces(alice);

            uint256[3] memory wrongValues = [uint256(100e6), 101e6 - 1, 101e6 + 1];
            for (uint256 j = 0; j < wrongValues.length; ++j) {
                TokenAuth memory permit =
                    _signPermit(alicePk, tokens[i], alice, address(gasless), wrongValues[j], nonce, r.deadline);
                _expectRevert(r, _signTransfer(alicePk, r, permit), permit, _errInsufficientAllowance(0, 101e6));
            }
            assertEq(IERC20(tokens[i]).allowance(alice, address(gasless)), 0, "no allowance after failures");
        }
    }

    function test_T18_permitDeadlineOrSpenderMismatch_reverts() public {
        TransferRequest memory r = _request(address(usdc), 100e6, 1e6);
        TokenAuth[4] memory permits = [
            // Permit deadline != intent deadline (the contract always passes the intent deadline).
            _signPermit(alicePk, address(usdc), alice, address(gasless), 101e6, 0, r.deadline + 1),
            // "No expiry" permits are not usable either.
            _signPermit(alicePk, address(usdc), alice, address(gasless), 101e6, 0, type(uint256).max),
            // Spender != this contract.
            _signPermit(alicePk, address(usdc), alice, relay, 101e6, 0, r.deadline),
            // Another owner's permit.
            _signPermit(attackerPk, address(usdc), attacker, address(gasless), 101e6, 0, r.deadline)
        ];
        for (uint256 i = 0; i < permits.length; ++i) {
            _expectRevert(r, _signTransfer(alicePk, r, permits[i]), permits[i], _errInsufficientAllowance(0, 101e6));
        }
    }

    // --- TI5: no leftover allowance ------------------------------------------------------------------

    function test_TI5_allowanceZeroAfterPermitAndMetaTx() public {
        _submitAndAssertNoAllowance(address(usdc), AuthMode.PERMIT);
        _submitAndAssertNoAllowance(address(usdt0), AuthMode.PERMIT);
        _submitAndAssertNoAllowance(address(usdt0), AuthMode.META_TX_APPROVE);
    }

    /// @dev A permit overwrites a larger standing allowance, so even then nothing is left.
    function test_TI5_permitOverwritesStandingAllowance() public {
        _approve(address(usdc), alice, type(uint256).max);
        _submitAndAssertNoAllowance(address(usdc), AuthMode.PERMIT);
    }

    // --- NONE: no token call -------------------------------------------------------------------------

    /// @dev AuthMode.NONE spends a standing allowance and calls neither permit nor executeMetaTransaction, even when
    ///      the signed v, r and s are a valid token signature for exactly amount + fee. The rest of the standing
    ///      allowance stays; such a token call would have set the allowance to amount + fee and left nothing.
    function test_noneMode_validUsdcPermitInAuth_noTokenCall() public {
        _assertNoneModeMakesNoTokenCall(address(usdc), AuthMode.PERMIT);
    }

    function test_noneMode_validUsdt0PermitInAuth_noTokenCall() public {
        _assertNoneModeMakesNoTokenCall(address(usdt0), AuthMode.PERMIT);
    }

    function test_noneMode_validUsdt0MetaTxInAuth_noTokenCall() public {
        _assertNoneModeMakesNoTokenCall(address(usdt0), AuthMode.META_TX_APPROVE);
    }

    // --- T29: gas starvation of the token call -------------------------------------------------------

    /// @dev Whatever gas the relay forwards, the call either completes in full or leaves no trace: intent nonce,
    ///      token nonce, allowance and balances are unchanged after any failure.
    function test_T29_permitGasStarvation_allOrNothing() public {
        _assertAllOrNothing(address(usdc), AuthMode.PERMIT);
        _assertAllOrNothing(address(usdt0), AuthMode.META_TX_APPROVE);
    }

    /// @dev The token call running out of gas is swallowed like any other failure. Without an allowance the whole call
    ///      reverts, and so it does with a standing allowance of another value: PERMIT mode only accepts the allowance
    ///      the permit sets. With exactly amount + fee in place (what a front-run permit leaves) it can only execute
    ///      exactly the signed transfer.
    function test_T29_tokenCallOutOfGas_noPartialState() public {
        GasBurningPermitToken token = new GasBurningPermitToken();
        GaslessTransfer g = _gaslessFor(address(token));
        token.mint(alice, 100e6);
        TransferRequest memory r = _request(address(token), 10e6, 1e6);
        TokenAuth memory permit =
            TokenAuth({mode: AuthMode.PERMIT, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});
        bytes memory data = abi.encodeCall(g.relayTransfer, (r, _signTransferFor(alicePk, r, permit, g), permit));

        vm.prank(relay);
        (bool success, bytes memory ret) = address(g).call{gas: 8_000_000}(data);
        assertFalse(success, "no allowance: reverts");
        assertEq(ret, _errInsufficientAllowance(0, 11e6), "out-of-gas permit caught, allowance check fails");
        assertEq(g.nonces(alice), 0, "nonce unchanged");
        assertEq(token.balanceOf(alice), 100e6, "nothing moved");

        vm.prank(alice);
        token.approve(address(g), type(uint256).max);
        vm.prank(relay);
        (success, ret) = address(g).call{gas: 8_000_000}(data);
        assertFalse(success, "standing max allowance: not spent in PERMIT mode");
        assertEq(ret, _errInsufficientAllowance(type(uint256).max, 11e6), "exact allowance required");
        assertEq(token.balanceOf(alice), 100e6, "nothing moved");

        vm.prank(alice);
        token.approve(address(g), 11e6);
        vm.prank(relay);
        (success,) = address(g).call{gas: 8_000_000}(data);
        assertTrue(success, "exactly amount + fee: proceeds");
        assertEq(token.allowance(alice, address(g)), 0, "TI5");
        assertEq(token.balanceOf(alice), 89e6, "exactly amount + fee");
        assertEq(token.balanceOf(bob), 10e6, "recipient");
        assertEq(token.balanceOf(relay), 1e6, "relay");
        assertEq(g.nonces(alice), 1, "nonce used");
    }

    /// @dev A token call that always fails (here: permit reverts) cannot be forced to "partially" succeed: without
    ///      a standing allowance the request reverts, with one it proceeds under the intent signature.
    function test_revertingPermitToken() public {
        RevertingPermitToken token = new RevertingPermitToken();
        GaslessTransfer g = _gaslessFor(address(token));
        token.mint(alice, 100e6);
        TransferRequest memory r = _request(address(token), 10e6, 1e6);
        TokenAuth memory permit =
            TokenAuth({mode: AuthMode.PERMIT, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});
        TokenAuth memory metaTx =
            TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});
        bytes memory permitSig = _signTransferFor(alicePk, r, permit, g);
        bytes memory metaTxSig = _signTransferFor(alicePk, r, metaTx, g);

        vm.startPrank(relay);
        vm.expectRevert(_errInsufficientAllowance(0, 11e6));
        g.relayTransfer(r, permitSig, permit);
        vm.expectRevert(_errInsufficientAllowance(0, 11e6));
        g.relayTransfer(r, metaTxSig, metaTx);
        vm.stopPrank();

        vm.prank(alice);
        token.approve(address(g), 11e6);
        vm.prank(relay);
        g.relayTransfer(r, permitSig, permit);
        assertEq(token.balanceOf(bob), 10e6, "standing allowance used");
    }

    /// @dev "Phantom permit": the token call succeeds without approving anything. The allowance check catches it.
    function test_phantomPermitToken_insufficientAllowance() public {
        PhantomPermitToken token = new PhantomPermitToken();
        GaslessTransfer g = _gaslessFor(address(token));
        token.mint(alice, 100e6);
        TransferRequest memory r = _request(address(token), 10e6, 1e6);
        TokenAuth memory permit = TokenAuth({mode: AuthMode.PERMIT, v: 0, r: 0, s: 0});
        TokenAuth memory metaTx = TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 0, r: 0, s: 0});
        bytes memory permitSig = _signTransferFor(alicePk, r, permit, g);
        bytes memory metaTxSig = _signTransferFor(alicePk, r, metaTx, g);

        vm.startPrank(relay);
        vm.expectRevert(_errInsufficientAllowance(0, 11e6));
        g.relayTransfer(r, permitSig, permit);
        vm.expectRevert(_errInsufficientAllowance(0, 11e6));
        g.relayTransfer(r, metaTxSig, metaTx);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 100e6, "nothing moved");
    }

    // --- Helpers -------------------------------------------------------------------------------------

    function _assertFrontRunPermitSucceeds(address token) internal {
        TransferRequest memory r = _request(token, 100e6, 1e6);
        TokenAuth memory auth = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);

        // Anyone can submit the permit to the token first.
        vm.prank(attacker);
        (bool success,) = token.call(
            abi.encodeWithSignature(
                "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
                alice,
                address(gasless),
                r.amount + r.fee,
                r.deadline,
                auth.v,
                auth.r,
                auth.s
            )
        );
        assertTrue(success, "front-run permit");
        assertEq(IERC20(token).allowance(alice, address(gasless)), 101e6, "front-run approval");

        _submit(r, sig, auth);
        _assertDone(r);
    }

    function _assertDone(TransferRequest memory r) internal view {
        IERC20 token = IERC20(r.token);
        assertEq(token.balanceOf(r.to), r.amount, "recipient");
        assertEq(token.balanceOf(r.relay), r.fee, "relay");
        assertEq(token.balanceOf(alice), INITIAL_BALANCE - r.amount - r.fee, "sender");
        assertEq(token.allowance(alice, address(gasless)), 0, "allowance used up");
        assertEq(gasless.nonces(alice), 1, "nonce used");
    }

    /// @dev A NONE-mode request whose v, r and s carry a valid `signedAs` token signature for amount + fee.
    function _assertNoneModeMakesNoTokenCall(address token, AuthMode signedAs) internal {
        TransferRequest memory r = _request(token, 10e6, 1e6);
        TokenAuth memory auth = signedAs == AuthMode.PERMIT ? _permitFor(alicePk, r) : _metaTxFor(alicePk, r);
        auth.mode = AuthMode.NONE;
        _approve(token, alice, 500e6);

        vm.expectCall(token, abi.encodeWithSelector(IERC20Permit.permit.selector), 0);
        vm.expectCall(token, abi.encodeWithSelector(INativeMetaTransaction.executeMetaTransaction.selector), 0);
        _submit(r, _signTransfer(alicePk, r, auth), auth);

        assertEq(IERC20(token).allowance(alice, address(gasless)), 500e6 - 11e6, "rest of the standing allowance");
        assertEq(IERC20(token).balanceOf(r.to), 10e6, "recipient");
        assertEq(IERC20(token).balanceOf(r.relay), 1e6, "relay");
        assertEq(gasless.nonces(alice), 1, "nonce used");
    }

    function _submitAndAssertNoAllowance(address token, AuthMode mode) internal {
        TransferRequest memory r = _request(token, 10e6, 1e6);
        TokenAuth memory auth = _authFor(alicePk, r, mode);
        _submit(r, _signTransfer(alicePk, r, auth), auth);
        assertEq(IERC20(token).allowance(alice, address(gasless)), 0, "no leftover allowance");
    }

    function _assertAllOrNothing(address token, AuthMode mode) internal {
        TransferRequest memory r = _request(token, 100e6, 1e6);
        TokenAuth memory auth = _authFor(alicePk, r, mode);
        bytes memory data = abi.encodeCall(gasless.relayTransfer, (r, _signTransfer(alicePk, r, auth), auth));
        uint256 tokenNonce = usdc.nonces(alice) + usdt0.nonces(alice);
        uint256 successes;
        uint256 failures;

        for (uint256 gasLimit = 10_000; gasLimit <= 250_000; gasLimit += 1000) {
            uint256 snapshot = vm.snapshotState();
            vm.prank(relay);
            (bool success,) = address(gasless).call{gas: gasLimit}(data);
            if (success) {
                ++successes;
                _assertDone(r);
            } else {
                ++failures;
                assertEq(gasless.nonces(alice), 0, "intent nonce unchanged");
                assertEq(usdc.nonces(alice) + usdt0.nonces(alice), tokenNonce, "token nonce unchanged");
                assertEq(IERC20(token).allowance(alice, address(gasless)), 0, "allowance unchanged");
                assertEq(IERC20(token).balanceOf(alice), INITIAL_BALANCE, "sender unchanged");
                assertEq(IERC20(token).balanceOf(relay), 0, "relay unchanged");
            }
            vm.revertToState(snapshot);
        }
        assertGt(successes, 0, "some gas limits succeed");
        assertGt(failures, 0, "some gas limits fail");
    }

    function _gaslessFor(address token) internal returns (GaslessTransfer) {
        return new GaslessTransfer(owner, _single(token, _config(true, true, true)));
    }
}
