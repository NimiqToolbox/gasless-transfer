// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdError} from "forge-std/StdError.sol";
import {Vm} from "forge-std/Vm.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, IGaslessBase, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice The checks of relayTransfer, one revert path at a time and in the exact order of §4.3: signature (at the
///         current nonce, over the token authorization), then token/mode, relay, deadline, amount/recipient, and
///         finally the allowance. No check bounds the fee: any signed fee is paid exactly.
contract GaslessTransferChecksTest is GaslessTestBase {
    address internal constant ECRECOVER = address(1);

    // --- Order -----------------------------------------------------------------------------------

    /// @dev Starts with a request that violates every check and fixes one check at a time: each step must report
    ///      the next error of §4.3, which proves the order. Every fix needs a new signature, since the signature
    ///      covers every field.
    function test_checkOrder_followsSpec() public {
        address unsupported = makeAddr("unsupportedToken");
        TransferRequest memory r = TransferRequest({
            token: unsupported,
            from: alice,
            to: address(0),
            amount: 0,
            fee: 1e6,
            relay: makeAddr("someoneElse"),
            deadline: vm.getBlockTimestamp() - 1
        });
        TokenAuth memory none = _noneAuth();

        // 1. signature
        _expectRevertFrom(relay, r, new bytes(65), none, _errInvalidSignature());
        // A signature for the next nonce is not valid yet.
        _expectRevertFrom(relay, r, _signTransferAt(alicePk, r, 1, none), none, _errInvalidSignature());
        // 2. token / auth mode
        _expectRevertFrom(
            relay,
            r,
            _signTransfer(alicePk, r, none),
            none,
            abi.encodeWithSelector(IGaslessBase.TokenNotSupported.selector, unsupported)
        );
        r.token = address(usdc);
        // 3. relay
        _expectRevertFrom(
            relay,
            r,
            _signTransfer(alicePk, r, none),
            none,
            abi.encodeWithSelector(IGaslessBase.NotRelay.selector, relay, r.relay)
        );
        r.relay = relay;
        // 4. deadline
        _expectRevert(
            r,
            _signTransfer(alicePk, r, none),
            none,
            abi.encodeWithSelector(IGaslessBase.DeadlineExpired.selector, r.deadline)
        );
        r.deadline = vm.getBlockTimestamp();
        // 5a. amount (before the recipient check)
        _expectRevert(
            r, _signTransfer(alicePk, r, none), none, abi.encodeWithSelector(IGaslessBase.ZeroAmount.selector)
        );
        r.amount = 10e6;
        // 5b. recipient
        _expectRevert(
            r,
            _signTransfer(alicePk, r, none),
            none,
            abi.encodeWithSelector(IGaslessBase.InvalidRecipient.selector, address(0))
        );
        r.to = bob;
        // 6. allowance
        bytes memory sig = _signTransfer(alicePk, r, none);
        _expectRevert(r, sig, none, _errInsufficientAllowance(0, 11e6));
        _approve(address(usdc), alice, 11e6);
        assertEq(gasless.nonces(alice), 0, "no failed call used the nonce");
        // All checks pass.
        _submit(r, sig, none);
        assertEq(usdc.balanceOf(bob), 10e6, "transferred");
        assertEq(gasless.nonces(alice), 1, "nonce used");
    }

    /// @dev Defense in depth: a request that fails any other check still reports InvalidSignature first when it is
    ///      not signed by `from` (at its current nonce, with this token authorization).
    function test_checkOrder_signatureBeforeEveryOtherCheck() public {
        TransferRequest[] memory bad = _requestsFailingOneCheck();
        TokenAuth memory metaTx =
            TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 27, r: keccak256("r"), s: keccak256("s")});
        for (uint256 i = 0; i < bad.length; ++i) {
            TransferRequest memory r = bad[i];
            bytes memory foreign = _signTransfer(attackerPk, r, _noneAuth());
            bytes memory stale = _signTransferAt(alicePk, r, 1, _noneAuth());
            _expectRevertFrom(relay, r, "", _noneAuth(), _errInvalidSignature());
            _expectRevertFrom(relay, r, new bytes(65), _noneAuth(), _errInvalidSignature());
            _expectRevertFrom(relay, r, foreign, _noneAuth(), _errInvalidSignature());
            _expectRevertFrom(relay, r, stale, _noneAuth(), _errInvalidSignature());
            // alice's signature over another token authorization (USDC has no META_TX mode either).
            _expectRevertFrom(relay, r, _signTransfer(alicePk, r, _noneAuth()), metaTx, _errInvalidSignature());
        }
    }

    /// @dev Nothing is called before the signature is verified: a request with a bad signature touches no account
    ///      other than this contract and the ecrecover precompile, also when every other check would pass and
    ///      tokens and allowances are in place.
    function test_checkOrder_noExternalCallBeforeVerification() public {
        _approve(address(usdc), alice, type(uint256).max);
        _approve(address(usdt0), alice, type(uint256).max);
        TransferRequest[] memory bad = _requestsFailingOneCheck();
        TransferRequest[] memory all = new TransferRequest[](bad.length + 2);
        for (uint256 i = 0; i < bad.length; ++i) {
            all[i] = bad[i];
        }
        all[bad.length] = _request(address(usdc), 10e6, 1e6);
        all[bad.length + 1] = _request(address(usdt0), 10e6, 1e6);

        TokenAuth[3] memory auths =
            [_noneAuth(), _permitFor(alicePk, all[bad.length]), _metaTxFor(alicePk, all[bad.length + 1])];
        for (uint256 i = 0; i < all.length; ++i) {
            for (uint256 k = 0; k < auths.length; ++k) {
                bytes memory data = abi.encodeCall(
                    gasless.relayTransfer, (all[i], _signTransfer(attackerPk, all[i], auths[k]), auths[k])
                );
                vm.startStateDiffRecording();
                vm.prank(relay);
                (bool success, bytes memory ret) = address(gasless).call(data);
                Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
                assertFalse(success, "bad signature accepted");
                assertEq(ret, _errInvalidSignature(), "InvalidSignature");
                bool recovered;
                for (uint256 j = 0; j < accesses.length; ++j) {
                    address account = accesses[j].account;
                    if (account == address(vm)) continue; // the prank above
                    recovered = recovered || account == ECRECOVER;
                    assertTrue(
                        account == address(gasless) || account == ECRECOVER,
                        string.concat("account accessed before verification: ", vm.toString(account))
                    );
                }
                assertTrue(recovered, "the signature was checked");
            }
        }
        assertEq(usdc.balanceOf(bob) + usdt0.balanceOf(bob), 0, "nothing moved");
    }

    function test_checkOrder_authModeBeforeRelay() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        r.relay = makeAddr("someoneElse");
        TokenAuth memory metaTx = TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 0, r: 0, s: 0});
        _expectRevertFrom(
            relay,
            r,
            _signTransfer(alicePk, r, metaTx),
            metaTx,
            abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, address(usdc), AuthMode.META_TX_APPROVE)
        );
    }

    /// @dev from = 0 is refused first of all, before the signature is even recovered.
    function test_checkOrder_invalidSignerFirst() public {
        TransferRequest memory r = _request(makeAddr("unsupportedToken"), 0, type(uint256).max);
        r.from = address(0);
        r.deadline = 0;
        _expectRevertFrom(attacker, r, "", _noneAuth(), abi.encodeWithSelector(IGaslessBase.InvalidSigner.selector));
    }

    /// @dev Replaying an executed request fails at the signature, whatever token authorization comes with it.
    function test_checkOrder_replayFailsAtSignature() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, permit);
        _submit(r, sig, permit);
        TokenAuth memory garbage = TokenAuth({mode: AuthMode.PERMIT, v: 27, r: bytes32(uint256(1)), s: bytes32(0)});
        _expectRevert(r, sig, permit, _errInvalidSignature());
        _expectRevert(r, sig, garbage, _errInvalidSignature());
    }

    // --- Token and auth mode ---------------------------------------------------------------------

    function test_revert_tokenNotSupported() public {
        address[3] memory tokens = [address(0), makeAddr("randomToken"), address(gasless)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TransferRequest memory r = _request(tokens[i], 10e6, 1e6);
            _expectRevert(
                r,
                _signTransfer(alicePk, r, _noneAuth()),
                _noneAuth(),
                abi.encodeWithSelector(IGaslessBase.TokenNotSupported.selector, tokens[i])
            );
        }
    }

    function test_revert_authModeNotSupported_usdcMetaTx() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory metaTx = TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 0, r: 0, s: 0});
        _expectRevert(
            r,
            _signTransfer(alicePk, r, metaTx),
            metaTx,
            abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, address(usdc), AuthMode.META_TX_APPROVE)
        );
    }

    /// @dev Each mode flag gates exactly its own mode; NONE needs `allowance`.
    function test_revert_authModeNotSupported_perFlag() public {
        for (uint256 flags = 1; flags < 8; ++flags) {
            GaslessTransfer g = new GaslessTransfer(
                owner, _single(address(usdc), _config(flags & 1 != 0, flags & 2 != 0, flags & 4 != 0))
            );
            _assertModeGate(g, AuthMode.PERMIT, flags & 1 != 0);
            _assertModeGate(g, AuthMode.META_TX_APPROVE, flags & 2 != 0);
            _assertModeGate(g, AuthMode.NONE, flags & 4 != 0);
        }
    }

    /// @dev An out-of-range mode cannot even be decoded, so it never reaches the token. The same call data with a valid
    ///      mode then fails only at the signature (which covers the mode).
    function test_revert_invalidAuthModeValue() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory data =
            abi.encodeCall(gasless.relayTransfer, (r, _signTransfer(alicePk, r, _noneAuth()), _noneAuth()));
        // TokenAuth.mode is the first word after the head of (r, signature offset); set it to 3.
        uint256 modeOffset = 4 + 7 * 32 + 32;
        data[modeOffset + 31] = 0x03;
        vm.prank(relay);
        (bool success, bytes memory ret) = address(gasless).call(data);
        assertFalse(success, "out-of-range enum must revert");
        assertEq(ret.length, 0, "rejected by the ABI decoder");
        data[modeOffset + 31] = 0x01;
        vm.prank(relay);
        (success, ret) = address(gasless).call(data);
        assertFalse(success, "PERMIT was not signed");
        assertEq(ret, _errInvalidSignature());
        data[modeOffset + 31] = 0x00;
        _approve(address(usdc), alice, 11e6);
        vm.prank(relay);
        (success,) = address(gasless).call(data);
        assertTrue(success, "the signed call data with mode NONE succeeds");
    }

    // --- Relay (D5) ------------------------------------------------------------------------------

    function testFuzz_revert_notRelay(address caller) public {
        vm.assume(caller != relay);
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        _expectRevertFrom(
            caller,
            r,
            _signTransfer(alicePk, r, _noneAuth()),
            _noneAuth(),
            abi.encodeWithSelector(IGaslessBase.NotRelay.selector, caller, relay)
        );
    }

    // --- Deadline (T12, D3) ----------------------------------------------------------------------

    function test_T12_deadlineEqualToNow_passes() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _approve(address(usdc), alice, 11e6);
        vm.warp(r.deadline);
        _submit(r, sig, _noneAuth());
        assertEq(usdc.balanceOf(bob), 10e6, "valid at the deadline");
    }

    function test_T12_deadlinePlusOne_reverts() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _approve(address(usdc), alice, 11e6);
        vm.warp(r.deadline + 1);
        _expectRevert(r, sig, _noneAuth(), abi.encodeWithSelector(IGaslessBase.DeadlineExpired.selector, r.deadline));
    }

    function testFuzz_T12_deadline(uint256 deadline, uint256 nowTs) public {
        nowTs = bound(nowTs, 1, type(uint64).max);
        vm.warp(nowTs);
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        r.deadline = deadline;
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _approve(address(usdc), alice, 11e6);
        if (nowTs <= deadline) {
            _submit(r, sig, _noneAuth());
            assertEq(gasless.nonces(alice), 1);
        } else {
            _expectRevert(r, sig, _noneAuth(), abi.encodeWithSelector(IGaslessBase.DeadlineExpired.selector, deadline));
        }
    }

    // --- Amount and recipient (T25, D11) ---------------------------------------------------------

    function test_revert_zeroAmount() public {
        TransferRequest memory r = _request(address(usdc), 0, 1e6);
        _expectRevert(
            r,
            _signTransfer(alicePk, r, _noneAuth()),
            _noneAuth(),
            abi.encodeWithSelector(IGaslessBase.ZeroAmount.selector)
        );
    }

    function test_T25_invalidRecipients() public {
        address[2] memory tokens = [address(usdc), address(usdt0)];
        for (uint256 t = 0; t < tokens.length; ++t) {
            address[3] memory denied = [address(0), tokens[t], address(gasless)];
            for (uint256 i = 0; i < denied.length; ++i) {
                TransferRequest memory r = _request(tokens[t], 10e6, 1e6);
                r.to = denied[i];
                _approve(tokens[t], alice, 11e6);
                _expectRevert(
                    r,
                    _signTransfer(alicePk, r, _noneAuth()),
                    _noneAuth(),
                    abi.encodeWithSelector(IGaslessBase.InvalidRecipient.selector, denied[i])
                );
            }
        }
    }

    /// @dev Only the request's own token is denied by the contract; another token contract is an allowed recipient.
    function test_D11_otherTokenAsRecipient_allowed() public {
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        r.to = address(usdc);
        TokenAuth memory metaTx = _metaTxFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, metaTx), metaTx);
        assertEq(usdt0.balanceOf(address(usdc)), 10e6);
    }

    // --- Fee (A11): bounded only by the signature ---------------------------------------------------

    /// @dev No configuration bounds the fee: a fee just above 5.00 (MAX_TEST_FEE), a thousand times that, and
    ///      2^256 - 2 with amount 1 are each paid exactly as signed, in every (token, mode) route. Only `from`'s
    ///      signature bounds the fee; clients check the fee a relay quotes before they sign it.
    function test_fee_anySignedFee_isPaidExactly() public {
        _mintRest(address(usdc), alice);
        _mintRest(address(usdt0), alice);
        uint256[3] memory fees = [MAX_TEST_FEE + 1, 1000 * MAX_TEST_FEE, type(uint256).max - 1];
        for (uint256 c = 0; c < 5; ++c) {
            (address token, AuthMode mode) = _route(c);
            for (uint256 i = 0; i < fees.length; ++i) {
                uint256 snapshot = vm.snapshotState();
                _assertPaidExactly(_request(token, i == 2 ? 1 : 10e6, fees[i]), mode);
                vm.revertToState(snapshot);
            }
        }
    }

    function testFuzz_fee_anySignedFee_isPaidExactly(uint256 amount, uint256 fee, uint256 route) public {
        (address token, AuthMode mode) = _route(route);
        _mintRest(token, alice);
        fee = bound(fee, 0, type(uint256).max - 1);
        amount = bound(amount, 1, type(uint256).max - fee);
        _assertPaidExactly(_request(token, amount, fee), mode);
    }

    // --- Allowance and token failures ------------------------------------------------------------

    function test_revert_insufficientAllowance_none() public {
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _expectRevert(r, sig, _noneAuth(), _errInsufficientAllowance(0, 11e6));
        _approve(address(usdt0), alice, 11e6 - 1);
        _expectRevert(r, sig, _noneAuth(), _errInsufficientAllowance(11e6 - 1, 11e6));
        assertEq(gasless.nonces(alice), 0, "nonce not spent by a failed call");
        _approve(address(usdt0), alice, 11e6);
        _submit(r, sig, _noneAuth());
    }

    /// @dev amount + fee above 2^256 - 1 reverts with the arithmetic panic in every route, before any token call: no
    ///      balance, allowance or nonce changes, even with unlimited allowances in place.
    function test_revert_amountPlusFeeOverflow() public {
        _approve(address(usdc), alice, type(uint256).max);
        _approve(address(usdt0), alice, type(uint256).max);
        uint256 max = type(uint256).max;
        uint256[2][4] memory amountFee = [[max, uint256(1)], [uint256(1), max], [max, max], [max / 2 + 1, max / 2 + 1]];
        for (uint256 c = 0; c < 5; ++c) {
            (address token, AuthMode mode) = _route(c);
            TokenAuth memory auth = mode == AuthMode.NONE
                ? _noneAuth()
                : TokenAuth({mode: mode, v: 27, r: keccak256("overflow r"), s: keccak256("overflow s")});
            for (uint256 i = 0; i < amountFee.length; ++i) {
                TransferRequest memory r = _request(token, amountFee[i][0], amountFee[i][1]);
                uint256[] memory before = _balances();
                _expectRevert(r, _signTransfer(alicePk, r, auth), auth, stdError.arithmeticError);
                _assertBalancesUnchanged(before);
            }
        }
        assertEq(usdc.allowance(alice, address(gasless)), type(uint256).max, "USDC allowance untouched");
        assertEq(usdt0.allowance(alice, address(gasless)), type(uint256).max, "USDT0 allowance untouched");
        assertEq(gasless.nonces(alice), 0, "nonce unused");
    }

    function test_revert_insufficientBalance_bubblesTokenError() public {
        TransferRequest memory r = _request(address(usdc), INITIAL_BALANCE, 1);
        _approve(address(usdc), alice, type(uint256).max);
        _expectRevert(
            r, _signTransfer(alicePk, r, _noneAuth()), _noneAuth(), bytes("ERC20: transfer amount exceeds balance")
        );
        assertEq(gasless.nonces(alice), 0, "nonce not spent by a failed call");
    }

    // --- Helpers ---------------------------------------------------------------------------------

    /// @dev Requests of alice that each fail exactly one of the checks after the signature: unsupported token,
    ///      unsupported mode is covered by the callers, wrong relay, expired deadline, zero amount, bad recipient.
    function _requestsFailingOneCheck() internal returns (TransferRequest[] memory bad) {
        bad = new TransferRequest[](5);
        for (uint256 i = 0; i < bad.length; ++i) {
            bad[i] = _request(address(usdc), 10e6, 1e6);
        }
        bad[0].token = makeAddr("unsupportedToken");
        bad[1].relay = makeAddr("someoneElse");
        bad[2].deadline = vm.getBlockTimestamp() - 1;
        bad[3].amount = 0;
        bad[4].to = address(usdc);
    }

    /// @dev The five (token, mode) routes of §11: USDC {PERMIT, NONE}, USDT0 {PERMIT, META_TX_APPROVE, NONE}.
    function _route(uint256 seed) internal view returns (address token, AuthMode mode) {
        uint256 c = seed % 5;
        if (c == 0) return (address(usdc), AuthMode.PERMIT);
        if (c == 1) return (address(usdc), AuthMode.NONE);
        if (c == 2) return (address(usdt0), AuthMode.PERMIT);
        if (c == 3) return (address(usdt0), AuthMode.META_TX_APPROVE);
        return (address(usdt0), AuthMode.NONE);
    }

    /// @dev Mints every unit of `token` that is left to `account`, so that the total supply is 2^256 - 1.
    function _mintRest(address token, address account) internal {
        uint256 rest = type(uint256).max - (token == address(usdc) ? usdc.totalSupply() : usdt0.totalSupply());
        if (token == address(usdc)) usdc.mint(account, rest);
        else usdt0.mint(account, rest);
    }

    /// @dev Submits `r` with the token authorization a client makes in `mode` (NONE: an exact approval) and checks
    ///      TI1: the relay gets exactly the signed fee, `to` exactly the amount, nothing stays with the contract and no
    ///      allowance is left.
    function _assertPaidExactly(TransferRequest memory r, AuthMode mode) internal {
        IERC20 token = IERC20(r.token);
        uint256 fromBefore = token.balanceOf(r.from);
        uint256 nonce = gasless.nonces(r.from);
        TokenAuth memory auth = _authFor(alicePk, r, mode);
        _submit(r, _signTransfer(alicePk, r, auth), auth);
        assertEq(token.balanceOf(r.relay), r.fee, "the relay gets exactly the signed fee");
        assertEq(token.balanceOf(r.to), r.amount, "the recipient gets exactly the amount");
        assertEq(token.balanceOf(r.from), fromBefore - r.amount - r.fee, "from pays amount + fee");
        assertEq(token.balanceOf(address(gasless)), 0, "no custody");
        assertEq(token.allowance(r.from, address(gasless)), 0, "no allowance left");
        assertEq(gasless.nonces(r.from), nonce + 1, "nonce used");
    }

    function _assertModeGate(GaslessTransfer g, AuthMode mode, bool enabled) internal {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory auth = TokenAuth({mode: mode, v: 0, r: 0, s: 0});
        bytes memory sig = _signTransferFor(alicePk, r, auth, g);
        vm.prank(relay);
        if (!enabled) {
            vm.expectRevert(abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, address(usdc), mode));
        } else {
            // The mode gate passes; the next check that fails is the allowance (no token authorization in place).
            vm.expectRevert(_errInsufficientAllowance(0, 11e6));
        }
        g.relayTransfer(r, sig, auth);
    }
}
