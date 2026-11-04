// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthMode, TokenAuth, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

import {SpecBase} from "./SpecBase.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Fee, relay binding, deadline, recipient and check order: T10-T12, T25 and §4.3 "relayTransfer order"
///         (docs/STEP-1-GAS-ABSTRACTION.md §2 D3/D5/D11/D13, §4.2, §4.3, §8).
contract RelayFeeDeadlineSpecTest is SpecBase {
    // ================================================================ T10

    /// @notice T10 (fuzz): exact amounts in every route: `from` pays amount + fee, `to` gets exactly amount, the
    ///         signed relay gets exactly fee, the contract keeps nothing, and PERMIT / META_TX / exact NONE approvals
    ///         leave no allowance (TI5). `to` may also be the relay or `from` itself.
    function testFuzz_T10_exactAmounts(uint256 routeSeed, uint256 amount, uint256 fee, uint256 toSeed, uint256 ttl)
        public
    {
        (address token, AuthMode mode) = route(routeSeed);
        address[4] memory recipients = [carol, bob, relay, alice];
        TransferRequest memory r = request(token, alice);
        r.to = recipients[toSeed % recipients.length];
        // Any fee the balance covers: no configuration bounds it (§4.2).
        r.fee = bound(fee, 0, FUNDS - 1);
        r.amount = bound(amount, 1, FUNDS - r.fee);
        r.deadline = vm.getBlockTimestamp() + bound(ttl, 0, 2 hours);
        TokenAuth memory auth = authorize(aliceKey, r, mode);
        bytes memory sig = signRequest(aliceKey, r, auth);

        State memory before = observe(r);
        submit(r, sig, auth);
        assertTransferred(r, before);
        assertEq(IERC20Balance(token).balanceOf(address(gasless)), 0, "contract holds tokens");
        assertEq(IERC20Balance(token).allowance(alice, address(gasless)), 0, "allowance left over (TI5)");
    }

    /// @notice T10 / §4.5: an ephemeral signer key sends its whole balance minus the fee and ends at exactly zero.
    function test_T10_ephemeralSignerSendsBalanceMinusFee() public {
        (address ephemeral, uint256 ephemeralKey) = makeAddrAndKey("ephemeral");
        uint256 balance = 12_345_678;
        usdc.mint(ephemeral, balance);

        TransferRequest memory r = request(address(usdc), ephemeral);
        r.fee = 20_000;
        r.amount = balance - r.fee;
        TokenAuth memory auth = authorize(ephemeralKey, r, AuthMode.PERMIT);
        State memory before = observe(r);
        submit(r, signRequest(ephemeralKey, r, auth), auth);
        assertTransferred(r, before);
        assertEq(usdc.balanceOf(ephemeral), 0);
    }

    /// @notice T10 / A11: the contract bounds no fee (§4.2). Fee 0 pays nothing; a fee above 5.00 (MAX_TEST_FEE) and
    ///         one of all but one unit of the sender's balance are paid exactly; only amount + fee above 2^256 - 1
    ///         reverts (arithmetic panic) and changes nothing.
    function test_T10_anySignedFeeIsPaid() public {
        TransferRequest memory free = request(address(usdc), victim);
        free.fee = 0;
        State memory before = observe(free);
        submit(free, signRequest(victimKey, free, noAuth()), noAuth());
        assertTransferred(free, before);

        TransferRequest memory aboveTestFee = request(address(usdt), victim);
        aboveTestFee.fee = MAX_TEST_FEE + 1;
        before = observe(aboveTestFee);
        submit(aboveTestFee, signRequest(victimKey, aboveTestFee, noAuth()), noAuth());
        assertTransferred(aboveTestFee, before);

        TransferRequest memory large = request(address(usdt), victim);
        large.amount = 1;
        large.fee = usdt.balanceOf(victim) - 1;
        before = observe(large);
        submit(large, signRequest(victimKey, large, noAuth()), noAuth());
        assertTransferred(large, before);
        assertEq(usdt.balanceOf(victim), 0, "the whole balance, almost all of it as the fee");

        TransferRequest memory overflow = request(address(usdc), victim);
        overflow.fee = type(uint256).max;
        expectRevertNoChange(
            relay,
            overflow,
            signRequest(victimKey, overflow, noAuth()),
            noAuth(),
            abi.encodeWithSignature("Panic(uint256)", 0x11)
        );
    }

    /// @notice amount == 0 reverts ZeroAmount (§4.3).
    function test_T10_zeroAmountReverts() public {
        TransferRequest memory r = request(address(usdc), victim);
        r.amount = 0;
        expectRevertNoChange(relay, r, signRequest(victimKey, r, noAuth()), noAuth(), errZeroAmount());
    }

    // ================================================================ T11

    /// @notice T11: a caller other than the signed relay reverts NotRelay(caller, relay) in every route, even with
    ///         a valid signature and token authorization; the fee can therefore never be redirected to the caller.
    function test_T11_callerOtherThanSignedRelayReverts() public {
        address[4] memory callers = [otherRelay, attacker, alice, carol];
        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            bytes memory sig = signRequest(aliceKey, r, auth);
            for (uint256 j = 0; j < callers.length; ++j) {
                expectRevertNoChange(callers[j], r, sig, auth, errNotRelay(callers[j], relay));
            }
            State memory before = observe(r);
            submit(r, sig, auth);
            assertTransferred(r, before);
        }
    }

    /// @notice T11 (fuzz): any caller other than the signed relay is rejected.
    function testFuzz_T11_anyOtherCallerReverts(address caller) public {
        assumeNotForgeAddress(caller);
        vm.assume(caller != relay);
        TransferRequest memory r = request(address(usdt), victim);
        expectRevertNoChange(caller, r, signRequest(victimKey, r, noAuth()), noAuth(), errNotRelay(caller, relay));
    }

    /// @notice T11: rewriting the relay field (and sending from that new relay) gives InvalidSignature.
    function test_T11_tamperedRelayFieldGivesInvalidSignature() public {
        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            bytes memory sig = signRequest(aliceKey, r, auth);
            TransferRequest memory tampered = copy(r);
            tampered.relay = attacker;
            expectRevertNoChange(attacker, tampered, sig, auth, errInvalidSignature());
            tampered.relay = otherRelay;
            expectRevertNoChange(otherRelay, tampered, sig, auth, errInvalidSignature());
        }
    }

    // ================================================================ T12

    /// @notice T12: `block.timestamp == deadline` passes in every route (the permit deadline equals the intent
    ///         deadline, so the token accepts it too).
    function test_T12_deadlineEqualToNowPasses() public {
        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            bytes memory sig = signRequest(aliceKey, r, auth);
            vm.warp(r.deadline);
            State memory before = observe(r);
            submit(r, sig, auth);
            assertTransferred(r, before);
        }
    }

    /// @notice T12: `block.timestamp == deadline + 1` reverts DeadlineExpired(deadline) in every route.
    function test_T12_deadlinePlusOneReverts() public {
        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            bytes memory sig = signRequest(aliceKey, r, auth);
            vm.warp(r.deadline + 1);
            expectRevertNoChange(relay, r, sig, auth, errDeadlineExpired(r.deadline));
            vm.warp(START);
        }
    }

    /// @notice T12 (fuzz): the request is valid exactly while `block.timestamp <= deadline`.
    function testFuzz_T12_deadlineBoundary(uint256 deadline, uint256 timestamp) public {
        deadline = bound(deadline, START, START + 365 days);
        timestamp = bound(timestamp, START, START + 366 days);
        TransferRequest memory r = request(address(usdc), victim);
        r.deadline = deadline;
        bytes memory sig = signRequest(victimKey, r, noAuth());
        vm.warp(timestamp);
        if (timestamp <= deadline) {
            State memory before = observe(r);
            submit(r, sig, noAuth());
            assertTransferred(r, before);
        } else {
            expectRevertNoChange(relay, r, sig, noAuth(), errDeadlineExpired(deadline));
        }
    }

    // ================================================================ T25 (recipients, D11 on-chain part)

    /// @notice T25: `to` in {0, token, this} reverts InvalidRecipient(to), for both tokens.
    function test_T25_deniedRecipientsRevert() public {
        address[2] memory tokens = [address(usdc), address(usdt)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            address[3] memory denied = [address(0), tokens[i], address(gasless)];
            for (uint256 j = 0; j < denied.length; ++j) {
                TransferRequest memory r = request(tokens[i], victim);
                r.to = denied[j];
                expectRevertNoChange(
                    relay, r, signRequest(victimKey, r, noAuth()), noAuth(), errInvalidRecipient(denied[j])
                );
            }
        }
    }

    /// @notice T25: the on-chain denylist is exactly {0, token, this}; the contract accepts every other recipient.
    ///         Here: USDC sent to the USDT0 address is not blocked.
    function test_T25_onChainDenylistIsExactlyZeroTokenThis() public {
        TransferRequest memory r = request(address(usdc), victim);
        r.to = address(usdt);
        State memory before = observe(r);
        submit(r, signRequest(victimKey, r, noAuth()), noAuth());
        assertTransferred(r, before);
    }

    /// @notice T25 (fuzz): every recipient outside {0, token, this} is accepted.
    function testFuzz_T25_otherRecipientsAccepted(address to) public {
        vm.assume(to != address(0) && to != address(usdc) && to != address(gasless));
        TransferRequest memory r = request(address(usdc), victim);
        r.to = to;
        State memory before = observe(r);
        submit(r, signRequest(victimKey, r, noAuth()), noAuth());
        assertTransferred(r, before);
    }

    // ================================================================ token and mode (§4.2 _requireToken, D6)

    /// @notice Unsupported tokens revert TokenNotSupported; unsupported modes revert AuthModeNotSupported.
    function test_tokenAndModeChecks() public {
        MockUSDC unknown = new MockUSDC();
        unknown.mint(victim, FUNDS);
        vm.prank(victim);
        unknown.approve(address(gasless), type(uint256).max);
        TransferRequest memory r = request(address(unknown), victim);
        expectRevertNoChange(
            relay, r, signRequest(victimKey, r, noAuth()), noAuth(), errTokenNotSupported(address(unknown))
        );

        TransferRequest memory u = request(address(usdc), alice);
        TokenAuth memory metaTx = signMetaTxApprove(aliceKey, alice, address(gasless), u.amount + u.fee);
        expectRevertNoChange(
            relay,
            u,
            signRequest(aliceKey, u, metaTx),
            metaTx,
            errAuthModeNotSupported(address(usdc), AuthMode.META_TX_APPROVE)
        );
    }

    /// @notice D6/§4.2: every per-token mode flag is enforced, including `allowance` for NONE ("NONE mode requires
    ///         TokenConfig.allowance").
    function test_modeFlagsAreEnforcedPerToken() public {
        TokenInit[] memory tokens = new TokenInit[](3);
        tokens[0] = TokenInit({token: address(usdc), config: config(true, false, false)});
        tokens[1] = TokenInit({token: address(usdt), config: config(false, true, false)});
        MockUSDC third = new MockUSDC();
        tokens[2] = TokenInit({token: address(third), config: config(false, false, true)});
        IGaslessTransfer g = deployGasless(tokens);

        _expectModeRejected(g, address(usdc), AuthMode.NONE);
        _expectModeRejected(g, address(usdc), AuthMode.META_TX_APPROVE);
        _expectModeRejected(g, address(usdt), AuthMode.NONE);
        _expectModeRejected(g, address(usdt), AuthMode.PERMIT);
        _expectModeRejected(g, address(third), AuthMode.PERMIT);
        _expectModeRejected(g, address(third), AuthMode.META_TX_APPROVE);
    }

    function _expectModeRejected(IGaslessTransfer g, address token, AuthMode mode) internal {
        vm.startPrank(victim);
        IERC20Balance(token).approve(address(g), type(uint256).max);
        vm.stopPrank();
        TransferRequest memory r = request(token, victim);
        TokenAuth memory auth = TokenAuth({mode: mode, v: 0, r: bytes32(0), s: bytes32(0)});
        bytes memory sig = signRequestFor(g, victimKey, r, auth);
        vm.expectRevert(errAuthModeNotSupported(token, mode));
        vm.prank(relay);
        g.relayTransfer(r, sig, auth);
    }

    // ================================================================ §4.3 check order

    /// @notice §4.3 "relayTransfer order": the signature (at `from`'s current nonce, over the token authorization)
    ///         comes first. Starting from a request that fails every check, fixing one violation at a time (and
    ///         signing it again) surfaces the errors in the specified order: signature, token/mode, relay, deadline,
    ///         amount/recipient, then token authorization; no check bounds the fee. A failure never consumes the nonce.
    function test_checksRunInSpecifiedOrder() public {
        MockUSDC unknown = new MockUSDC();
        vm.prank(alice);
        gasless.invalidateNonces(3);

        TransferRequest memory r = TransferRequest({
            token: address(unknown),
            from: alice,
            to: address(0),
            amount: 0,
            fee: FEE,
            relay: relay,
            deadline: vm.getBlockTimestamp() - 1
        });
        TokenAuth memory auth = TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 0, r: bytes32(0), s: bytes32(0)});

        _expectExactRevert(attacker, r, new bytes(65), auth, errInvalidSignature());
        // Signed for an invalidated nonce, or for the next one: still the signature.
        _expectExactRevert(attacker, r, signRequestAt(aliceKey, r, 2, auth), auth, errInvalidSignature());
        _expectExactRevert(attacker, r, signRequestAt(aliceKey, r, 4, auth), auth, errInvalidSignature());
        _expectExactRevert(attacker, r, signRequest(aliceKey, r, auth), auth, errTokenNotSupported(address(unknown)));
        r.token = address(usdc);
        _expectExactRevert(
            attacker,
            r,
            signRequest(aliceKey, r, auth),
            auth,
            errAuthModeNotSupported(address(usdc), AuthMode.META_TX_APPROVE)
        );
        auth.mode = AuthMode.NONE;
        _expectExactRevert(attacker, r, signRequest(aliceKey, r, auth), auth, errNotRelay(attacker, relay));
        _expectExactRevert(relay, r, signRequest(aliceKey, r, auth), auth, errDeadlineExpired(r.deadline));
        r.deadline = vm.getBlockTimestamp() + TTL;
        // Amount and recipient are both checked here; their relative order is not specified.
        _expectOneOfReverts(
            relay, r, signRequest(aliceKey, r, auth), auth, errZeroAmount(), errInvalidRecipient(address(0))
        );
        r.amount = AMOUNT;
        _expectExactRevert(relay, r, signRequest(aliceKey, r, auth), auth, errInvalidRecipient(address(0)));
        r.to = carol;
        bytes memory sig = signRequest(aliceKey, r, auth);
        _expectExactRevert(relay, r, sig, auth, errInsufficientAllowance(0, AMOUNT + FEE));
        assertEq(gasless.nonces(alice), 3, "a failed call consumed the nonce");

        vm.prank(alice);
        usdc.approve(address(gasless), AMOUNT + FEE - 1);
        _expectExactRevert(relay, r, sig, auth, errInsufficientAllowance(AMOUNT + FEE - 1, AMOUNT + FEE));

        vm.prank(alice);
        usdc.approve(address(gasless), AMOUNT + FEE);
        State memory before = observe(r);
        submit(r, sig, auth);
        assertTransferred(r, before);
        assertEq(gasless.nonces(alice), 4);
    }

    /// @notice §4.3: a request that fails any later check reports InvalidSignature when it is not signed by `from`;
    ///         the relay learns nothing else about it.
    function test_signatureIsCheckedFirst() public {
        MockUSDC unknown = new MockUSDC();
        TransferRequest[] memory bad = new TransferRequest[](6);
        for (uint256 i = 0; i < bad.length; ++i) {
            bad[i] = request(address(usdc), alice);
        }
        bad[0].token = address(unknown);
        bad[1].relay = otherRelay;
        bad[2].deadline = vm.getBlockTimestamp() - 1;
        bad[3].amount = 0;
        bad[4].to = address(gasless);
        bad[5].fee = type(uint256).max; // amount + fee overflows

        TokenAuth memory metaTx =
            TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 27, r: keccak256("r"), s: keccak256("s")});
        for (uint256 i = 0; i < bad.length; ++i) {
            _expectExactRevert(relay, bad[i], "", noAuth(), errInvalidSignature());
            _expectExactRevert(
                relay, bad[i], signRequest(attackerKey, bad[i], noAuth()), noAuth(), errInvalidSignature()
            );
            _expectExactRevert(relay, bad[i], signRequest(aliceKey, bad[i], noAuth()), metaTx, errInvalidSignature());
        }
    }

    function _expectExactRevert(
        address caller,
        TransferRequest memory r,
        bytes memory sig,
        TokenAuth memory auth,
        bytes memory err
    ) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) =
            address(gasless).call(abi.encodeCall(IGaslessTransfer.relayTransfer, (r, sig, auth)));
        assertFalse(ok, "call succeeded");
        assertEq(ret, err, "unexpected error (check order)");
    }

    function _expectOneOfReverts(
        address caller,
        TransferRequest memory r,
        bytes memory sig,
        TokenAuth memory auth,
        bytes memory errA,
        bytes memory errB
    ) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) =
            address(gasless).call(abi.encodeCall(IGaslessTransfer.relayTransfer, (r, sig, auth)));
        assertFalse(ok, "call succeeded");
        assertTrue(keccak256(ret) == keccak256(errA) || keccak256(ret) == keccak256(errB), "unexpected error");
    }
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}
