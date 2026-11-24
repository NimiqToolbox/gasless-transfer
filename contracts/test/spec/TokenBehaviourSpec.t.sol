// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

import {AuthMode, TokenAuth, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

import {SpecBase} from "./SpecBase.sol";
import {MockFalseReturnToken, MockNoReturnToken, MockReentrantToken} from "./mocks/MockEdgeTokens.sol";

/// @notice Token behaviour and events: T22-T24 on mocks and the exact log order of §4.3 (D13 "fee first"; the
///         contract's only event for a transfer, TransferRelayed, comes last).
contract TokenBehaviourSpecTest is SpecBase {
    bytes32 internal constant TRANSFER_EVENT = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant APPROVAL_EVENT = keccak256("Approval(address,address,uint256)");
    bytes32 internal constant META_TX_EVENT = keccak256("MetaTransactionExecuted(address,address,bytes)");
    bytes4 internal constant REENTRANCY_GUARD_ERROR = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    struct ExpectedLog {
        address emitter;
        bytes32[] topics;
        bytes data;
    }

    // ================================================================ T22

    /// @notice T22: a token that calls back into relayTransfer from inside transferFrom, with a request that is valid
    ///         in every other respect (signed by `from` for the nonce the outer call leaves, bound to the token as
    ///         relay), is stopped by the reentrancy guard (§4.3 `nonReentrant`). The outer transfer completes exactly;
    ///         the inner one moves nothing and keeps its nonce, and it is executable normally afterwards.
    function test_T22_reentrantTokenCannotReenterRelayTransfer() public {
        MockReentrantToken token = new MockReentrantToken();
        IGaslessTransfer g = deployGasless(_single(address(token)));
        token.mint(alice, FUNDS);
        vm.prank(alice);
        token.approve(address(g), type(uint256).max);

        TransferRequest memory inner = TransferRequest({
            token: address(token),
            from: alice,
            to: bob,
            amount: 7_000_000,
            fee: 1,
            relay: address(token),
            deadline: vm.getBlockTimestamp() + TTL
        });
        bytes memory innerSig = signDigest(aliceKey, digestFor(inner, 1, noAuth(), block.chainid, address(g)));
        token.arm(address(g), abi.encodeCall(IGaslessTransfer.relayTransfer, (inner, innerSig, noAuth())));

        TransferRequest memory outer = request(address(token), alice);
        bytes memory outerSig = signRequestFor(g, aliceKey, outer, noAuth());
        vm.prank(relay);
        g.relayTransfer(outer, outerSig, noAuth());

        assertTrue(token.reentered(), "the token never called back");
        assertFalse(token.reentrySucceeded(), "reentrant relayTransfer succeeded");
        assertEq(bytes4(token.reentryReturnData()), REENTRANCY_GUARD_ERROR, "reentry not stopped by the guard");
        assertEq(g.nonces(alice), 1, "only the outer request used a nonce");
        assertEq(token.balanceOf(alice), FUNDS - AMOUNT - FEE);
        assertEq(token.balanceOf(carol), AMOUNT);
        assertEq(token.balanceOf(relay), FEE);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(address(g)), 0);

        vm.prank(address(token));
        g.relayTransfer(inner, innerSig, noAuth());
        assertEq(token.balanceOf(bob), inner.amount);
        assertEq(g.nonces(alice), 2);
    }

    // ================================================================ T23

    /// @notice T23: a token whose transfer functions return no data works, with exact amounts and no leftover
    ///         allowance; without enough allowance it reverts InsufficientAllowance.
    function test_T23_tokenWithoutReturnValueWorks() public {
        MockNoReturnToken token = new MockNoReturnToken();
        IGaslessTransfer g = deployGasless(_single(address(token)));
        token.mint(alice, FUNDS);

        TransferRequest memory r = request(address(token), alice);
        bytes memory sig = signRequestFor(g, aliceKey, r, noAuth());

        vm.prank(alice);
        token.approve(address(g), r.amount + r.fee - 1);
        vm.expectRevert(errInsufficientAllowance(r.amount + r.fee - 1, r.amount + r.fee));
        vm.prank(relay);
        g.relayTransfer(r, sig, noAuth());

        vm.prank(alice);
        token.approve(address(g), r.amount + r.fee);
        vm.prank(relay);
        g.relayTransfer(r, sig, noAuth());
        assertEq(token.balanceOf(alice), FUNDS - r.amount - r.fee);
        assertEq(token.balanceOf(carol), r.amount);
        assertEq(token.balanceOf(relay), r.fee);
        assertEq(token.balanceOf(address(g)), 0);
        assertEq(token.allowance(alice, address(g)), 0);
        assertEq(g.nonces(alice), 1);
    }

    /// @notice T23: a token that returns false from transferFrom (instead of reverting) makes the call revert; the
    ///         nonce is not consumed and nothing moves.
    function test_T23_tokenReturningFalseReverts() public {
        MockFalseReturnToken token = new MockFalseReturnToken();
        IGaslessTransfer g = deployGasless(_single(address(token)));
        token.mint(alice, FUNDS);
        TransferRequest memory r = request(address(token), alice);
        bytes memory sig = signRequestFor(g, aliceKey, r, noAuth());
        vm.prank(alice);
        token.approve(address(g), type(uint256).max);
        token.setFailTransfers(true);

        vm.prank(relay);
        (bool ok,) = address(g).call(abi.encodeCall(IGaslessTransfer.relayTransfer, (r, sig, noAuth())));
        assertFalse(ok, "a false return value was accepted");
        assertEq(g.nonces(alice), 0);
        assertEq(token.balanceOf(alice), FUNDS);

        token.setFailTransfers(false);
        vm.prank(relay);
        g.relayTransfer(r, sig, noAuth());
        assertEq(token.balanceOf(carol), r.amount);
    }

    // ================================================================ T24 (mock part; the fork part is in test/fork)

    /// @notice T24: a paused USDC ends in a clean revert: PERMIT mode fails the permit (caught) and then the allowance
    ///         check; NONE mode bubbles the token's revert. Nothing changes; after unpausing the same request works.
    function test_T24_usdcPausedRevertsCleanly() public {
        TransferRequest memory p = request(address(usdc), alice);
        TokenAuth memory pAuth = authorize(aliceKey, p, AuthMode.PERMIT);
        bytes memory pSig = signRequest(aliceKey, p, pAuth);
        TransferRequest memory n = request(address(usdc), victim);
        bytes memory nSig = signRequest(victimKey, n, noAuth());

        usdc.pause();
        expectRevertNoChange(relay, p, pSig, pAuth, errInsufficientAllowance(0, p.amount + p.fee));
        expectRevertNoChange(relay, n, nSig, noAuth(), _reason("Pausable: paused"));
        usdc.unpause();

        State memory before = observe(p);
        submit(p, pSig, pAuth);
        assertTransferred(p, before);
        before = observe(n);
        submit(n, nSig, noAuth());
        assertTransferred(n, before);
    }

    /// @notice T24: USDC blacklisting of `from`, `to`, the relay (fee recipient) or the contract (spender) ends in a
    ///         clean revert in PERMIT and NONE mode; nothing changes.
    function test_T24_usdcBlacklistRevertsCleanly() public {
        address[4] memory parties = [victim, carol, relay, address(gasless)];
        for (uint256 i = 0; i < parties.length; ++i) {
            usdc.blacklist(parties[i]);

            TransferRequest memory n = request(address(usdc), victim);
            expectRevertNoChange(
                relay,
                n,
                signRequest(victimKey, n, noAuth()),
                noAuth(),
                _reason("Blacklistable: account is blacklisted")
            );

            TransferRequest memory p = request(address(usdc), alice);
            if (parties[i] == victim) p.from = victim;
            uint256 key = parties[i] == victim ? victimKey : aliceKey;
            TokenAuth memory auth =
                signPermit(key, address(usdc), p.from, address(gasless), p.amount + p.fee, p.deadline);
            expectRevertNoChange(
                relay, p, signRequest(key, p, auth), auth, _reason("Blacklistable: account is blacklisted")
            );

            usdc.unBlacklist(parties[i]);
        }
    }

    /// @notice T24 / §4.2: with fee == 0 no fee transfer happens at all (`if (fee > 0)`), so a blacklisted relay does
    ///         not block a zero-fee transfer.
    function test_T24_zeroFeeSkipsTheFeeTransfer() public {
        usdc.blacklist(relay);
        TransferRequest memory r = request(address(usdc), victim);
        r.fee = 0;
        State memory before = observe(r);
        submit(r, signRequest(victimKey, r, noAuth()), noAuth());
        assertTransferred(r, before);
    }

    /// @notice T24: USDT0 blocking of `from` or of the contract (the transferFrom caller) ends in a clean revert in
    ///         every USDT0 mode; nothing changes.
    function test_T24_usdt0BlockedRevertsCleanly() public {
        for (uint256 i = 2; i < ROUTES; ++i) {
            (, AuthMode mode) = route(i);

            usdt.addToBlockedList(alice);
            TransferRequest memory r = request(address(usdt), alice);
            TokenAuth memory auth = mode == AuthMode.NONE ? noAuth() : authorize(aliceKey, r, mode);
            if (mode == AuthMode.NONE) {
                vm.prank(alice);
                usdt.approve(address(gasless), r.amount + r.fee);
            }
            bytes memory sig = signRequest(aliceKey, r, auth);
            expectRevertNoChange(relay, r, sig, auth, _reason("USDT0: from is blocked"));
            usdt.removeFromBlockedList(alice);

            usdt.addToBlockedList(address(gasless));
            expectRevertNoChange(relay, r, sig, auth, _reason("Blocked: msg.sender is blocked"));
            usdt.removeFromBlockedList(address(gasless));

            State memory before = observe(r);
            submit(r, sig, auth);
            assertTransferred(r, before);
        }
    }

    // ================================================================ §4.3 log order (D13)

    /// @notice §4.3 log order, USDC PERMIT: permit Approval, Transfer(from -> relay, fee), Transfer(from -> to,
    ///         amount), TransferRelayed(from, nonce, digest). Nothing else is emitted.
    function test_logOrder_usdcPermit() public {
        TransferRequest memory r = request(address(usdc), alice);
        TokenAuth memory auth = authorize(aliceKey, r, AuthMode.PERMIT);
        ExpectedLog[] memory e = new ExpectedLog[](4);
        e[0] = _approval(address(usdc), alice, address(gasless), r.amount + r.fee);
        e[1] = _transfer(address(usdc), alice, relay, r.fee);
        e[2] = _transfer(address(usdc), alice, carol, r.amount);
        e[3] = _transferRelayed(r, auth);
        _submitAndCheckLogs(r, signRequest(aliceKey, r, auth), auth, e);
    }

    /// @notice §4.3 log order with fee == 0: no fee Transfer at all.
    function test_logOrder_usdcPermitZeroFee() public {
        TransferRequest memory r = request(address(usdc), alice);
        r.fee = 0;
        TokenAuth memory auth = authorize(aliceKey, r, AuthMode.PERMIT);
        ExpectedLog[] memory e = new ExpectedLog[](3);
        e[0] = _approval(address(usdc), alice, address(gasless), r.amount);
        e[1] = _transfer(address(usdc), alice, carol, r.amount);
        e[2] = _transferRelayed(r, auth);
        _submitAndCheckLogs(r, signRequest(aliceKey, r, auth), auth, e);
    }

    /// @notice §4.3 log order, USDC NONE: no Approval, fee Transfer first.
    function test_logOrder_usdcNone() public {
        TransferRequest memory r = request(address(usdc), alice);
        TokenAuth memory auth = authorize(aliceKey, r, AuthMode.NONE);
        ExpectedLog[] memory e = new ExpectedLog[](3);
        e[0] = _transfer(address(usdc), alice, relay, r.fee);
        e[1] = _transfer(address(usdc), alice, carol, r.amount);
        e[2] = _transferRelayed(r, auth);
        _submitAndCheckLogs(r, signRequest(aliceKey, r, auth), auth, e);
    }

    /// @notice §4.3 log order, USDT0 PERMIT. The real USDT0 re-approves the reduced allowance inside transferFrom, so
    ///         each Transfer is followed by the token's own Approval; the §4.3 order is unchanged.
    function test_logOrder_usdt0Permit() public {
        TransferRequest memory r = request(address(usdt), alice);
        TokenAuth memory auth = authorize(aliceKey, r, AuthMode.PERMIT);
        ExpectedLog[] memory e = new ExpectedLog[](6);
        e[0] = _approval(address(usdt), alice, address(gasless), r.amount + r.fee);
        e[1] = _transfer(address(usdt), alice, relay, r.fee);
        e[2] = _approval(address(usdt), alice, address(gasless), r.amount);
        e[3] = _transfer(address(usdt), alice, carol, r.amount);
        e[4] = _approval(address(usdt), alice, address(gasless), 0);
        e[5] = _transferRelayed(r, auth);
        _submitAndCheckLogs(r, signRequest(aliceKey, r, auth), auth, e);
    }

    /// @notice §4.3 log order, USDT0 META_TX_APPROVE: the meta-tx (spender = this contract, value = amount + fee)
    ///         and its Approval come first, then fee and principal, then TransferRelayed.
    function test_logOrder_usdt0MetaTx() public {
        TransferRequest memory r = request(address(usdt), alice);
        TokenAuth memory auth = authorize(aliceKey, r, AuthMode.META_TX_APPROVE);
        ExpectedLog[] memory e = new ExpectedLog[](7);
        e[0] = _metaTxExecuted(alice, address(gasless), approveCalldata(address(gasless), r.amount + r.fee));
        e[1] = _approval(address(usdt), alice, address(gasless), r.amount + r.fee);
        e[2] = _transfer(address(usdt), alice, relay, r.fee);
        e[3] = _approval(address(usdt), alice, address(gasless), r.amount);
        e[4] = _transfer(address(usdt), alice, carol, r.amount);
        e[5] = _approval(address(usdt), alice, address(gasless), 0);
        e[6] = _transferRelayed(r, auth);
        _submitAndCheckLogs(r, signRequest(aliceKey, r, auth), auth, e);
    }

    /// @notice §4.3 log order (fuzz), all routes: after dropping USDT0's own events (MetaTransactionExecuted, and the
    ///         allowance-bookkeeping Approval that follows each of its Transfers), the log sequence is exactly
    ///         [authorization Approval if not NONE] [fee Transfer if fee > 0] [principal Transfer] [TransferRelayed],
    ///         the principal Transfer is the last Transfer, and TransferRelayed, the contract's only event, is the last
    ///         log of the call.
    function testFuzz_logOrder_section43(uint256 routeSeed, uint256 amount, uint256 fee) public {
        (address token, AuthMode mode) = route(routeSeed);
        TransferRequest memory r = request(token, alice);
        r.amount = bound(amount, 1, FUNDS - MAX_TEST_FEE);
        r.fee = bound(fee, 0, MAX_TEST_FEE);
        TokenAuth memory auth = authorize(aliceKey, r, mode);
        bytes memory sig = signRequest(aliceKey, r, auth);
        ExpectedLog memory relayed = _transferRelayed(r, auth);

        vm.recordLogs();
        submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        ExpectedLog[] memory e = new ExpectedLog[](4);
        uint256 n;
        if (mode != AuthMode.NONE) e[n++] = _approval(token, alice, address(gasless), r.amount + r.fee);
        if (r.fee > 0) e[n++] = _transfer(token, alice, relay, r.fee);
        e[n++] = _transfer(token, alice, carol, r.amount);
        e[n++] = relayed;

        uint256 k;
        uint256 lastTransfer;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (_isUsdt0Bookkeeping(logs, i)) continue;
            assertLt(k, n, "unexpected extra log");
            _assertLog(logs[i], e[k], k);
            if (logs[i].topics[0] == TRANSFER_EVENT) lastTransfer = i;
            ++k;
        }
        assertEq(k, n, "missing log");
        assertEq(logs[logs.length - 1].emitter, address(gasless), "TransferRelayed is not the last log");
        assertEq(
            address(uint160(uint256(logs[lastTransfer].topics[2]))), carol, "the last Transfer is not the principal"
        );
    }

    // ================================================================ helpers

    function _single(address token) internal pure returns (TokenInit[] memory tokens) {
        tokens = new TokenInit[](1);
        tokens[0] = TokenInit({token: token, config: config(false, false, true)});
    }

    function _reason(string memory message) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("Error(string)", message);
    }

    function _submitAndCheckLogs(
        TransferRequest memory r,
        bytes memory sig,
        TokenAuth memory auth,
        ExpectedLog[] memory expected
    ) internal {
        vm.recordLogs();
        submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, expected.length, "log count");
        for (uint256 i = 0; i < logs.length; ++i) {
            _assertLog(logs[i], expected[i], i);
        }
    }

    function _assertLog(Vm.Log memory actual, ExpectedLog memory expected, uint256 index) internal pure {
        string memory at = string.concat("log #", vm.toString(index));
        assertEq(actual.emitter, expected.emitter, string.concat(at, ": emitter"));
        assertEq(actual.topics.length, expected.topics.length, string.concat(at, ": topic count"));
        for (uint256 t = 0; t < actual.topics.length; ++t) {
            assertEq(actual.topics[t], expected.topics[t], string.concat(at, ": topic"));
        }
        assertEq(actual.data, expected.data, string.concat(at, ": data"));
    }

    /// @dev USDT0 events that are not part of the §4.3 sequence: MetaTransactionExecuted, and the Approval that
    ///      USDT0's transferFrom emits right after each of its Transfers (it re-approves the reduced allowance).
    function _isUsdt0Bookkeeping(Vm.Log[] memory logs, uint256 i) internal view returns (bool) {
        if (logs[i].emitter != address(usdt)) return false;
        if (logs[i].topics[0] == META_TX_EVENT) return true;
        return logs[i].topics[0] == APPROVAL_EVENT && i > 0 && logs[i - 1].emitter == address(usdt)
            && logs[i - 1].topics[0] == TRANSFER_EVENT;
    }

    function _topics3(bytes32 a, address b, address c) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](3);
        t[0] = a;
        t[1] = bytes32(uint256(uint160(b)));
        t[2] = bytes32(uint256(uint160(c)));
    }

    /// @dev TransferRelayed(from, nonce, digest) for `r` at the current nonce of `r.from`, with the spec's digest; call
    ///      it before the submission uses that nonce.
    function _transferRelayed(TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (ExpectedLog memory)
    {
        uint256 nonce = gasless.nonces(r.from);
        bytes32[] memory t = new bytes32[](4);
        t[0] = IGaslessTransfer.TransferRelayed.selector;
        t[1] = bytes32(uint256(uint160(r.from)));
        t[2] = bytes32(nonce);
        t[3] = digest(r, nonce, auth);
        return ExpectedLog(address(gasless), t, "");
    }

    function _transfer(address token, address from, address to, uint256 value)
        internal
        pure
        returns (ExpectedLog memory)
    {
        return ExpectedLog(token, _topics3(TRANSFER_EVENT, from, to), abi.encode(value));
    }

    function _approval(address token, address tokenOwner, address spender, uint256 value)
        internal
        pure
        returns (ExpectedLog memory)
    {
        return ExpectedLog(token, _topics3(APPROVAL_EVENT, tokenOwner, spender), abi.encode(value));
    }

    function _metaTxExecuted(address user, address relayer, bytes memory functionSignature)
        internal
        view
        returns (ExpectedLog memory)
    {
        return ExpectedLog(address(usdt), _topics3(META_TX_EVENT, user, relayer), abi.encode(functionSignature));
    }
}
