// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {AuthMode, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {MockUSDT0} from "../mocks/MockUSDT0.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice Successful transfers: TI1, T10 (exact amounts), D4/D10 (every token and mode through one contract),
///         D5 (fee to the relay) and D13 (fee first, then the principal Transfer, then the contract's TransferRelayed).
contract GaslessTransferTransferTest is GaslessTestBase {
    bytes32 internal constant TRANSFER_EVENT = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant APPROVAL_EVENT = keccak256("Approval(address,address,uint256)");

    // --- TI1 for each configured (token, mode) ---------------------------------------------------

    function test_TI1_D10_usdcPermit() public {
        _assertSuccessfulTransfer(address(usdc), AuthMode.PERMIT, 250e6, 1e6);
    }

    function test_TI1_D10_usdcNone() public {
        _assertSuccessfulTransfer(address(usdc), AuthMode.NONE, 250e6, 1e6);
    }

    function test_TI1_D10_usdt0Permit() public {
        _assertSuccessfulTransfer(address(usdt0), AuthMode.PERMIT, 250e6, 1e6);
    }

    function test_TI1_D10_usdt0MetaTxApprove() public {
        _assertSuccessfulTransfer(address(usdt0), AuthMode.META_TX_APPROVE, 250e6, 1e6);
    }

    function test_TI1_D10_usdt0None() public {
        _assertSuccessfulTransfer(address(usdt0), AuthMode.NONE, 250e6, 1e6);
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_TI1_T10_exactAmounts(
        uint256 amount,
        uint256 fee,
        uint8 combo,
        address to,
        uint256 startNonce,
        uint256 validFor
    ) public {
        (address token, AuthMode mode) = _combo(combo);
        // Any fee the balance covers: no configuration bounds it.
        fee = bound(fee, 0, INITIAL_BALANCE - 1);
        amount = bound(amount, 1, INITIAL_BALANCE - fee);
        vm.assume(to != address(0) && to != token && to != address(gasless) && to != alice && to != relay);
        startNonce = bound(startNonce, 0, MAX_NONCE_INCREASE);
        if (startNonce > 0) {
            vm.prank(alice);
            gasless.invalidateNonces(startNonce);
        }

        TransferRequest memory r = _request(token, amount, fee);
        r.to = to;
        r.deadline = vm.getBlockTimestamp() + bound(validFor, 0, 2 hours);

        _submitAndAssertTI1(r, mode);
    }

    function test_T10_feeZero_onlyPrincipalMoves() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 0);
        TokenAuth memory auth = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);

        vm.recordLogs();
        _submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(usdc.balanceOf(relay), 0, "relay got a fee");
        assertEq(usdc.balanceOf(bob), 10e6, "recipient");
        assertEq(usdc.balanceOf(alice), INITIAL_BALANCE - 10e6, "sender");
        // Approval (permit), Transfer(alice -> bob), TransferRelayed: no fee Transfer.
        assertEq(logs.length, 3, "log count");
        _assertTransfer(logs[1], address(usdc), alice, bob, 10e6);
        _assertTransferRelayed(logs[2], r, 0, auth);
    }

    function test_T10_largeFeeAndWholeBalance() public {
        TransferRequest memory r = _request(address(usdt0), INITIAL_BALANCE - 100 * MAX_TEST_FEE, 100 * MAX_TEST_FEE);
        _submitAndAssertTI1(r, AuthMode.META_TX_APPROVE);
        assertEq(usdt0.balanceOf(alice), 0, "sender drained exactly");
        assertEq(usdt0.balanceOf(relay), 100 * MAX_TEST_FEE, "the signed fee");
    }

    /// @dev Ephemeral signer (§4.5): an ephemeral key sends its whole balance minus the fee.
    function test_ephemeralSigner_sendsBalanceMinusFee() public {
        (address ephemeral, uint256 ephemeralPk) = makeAddrAndKey("ephemeral");
        usdc.mint(ephemeral, 20e6);
        TransferRequest memory r = _request(address(usdc), 20e6 - 30_000, 30_000);
        r.from = ephemeral;
        TokenAuth memory permit = _permitFor(ephemeralPk, r);
        _submit(r, _signTransfer(ephemeralPk, r, permit), permit);
        assertEq(usdc.balanceOf(ephemeral), 0, "ephemeral signer emptied");
        assertEq(usdc.balanceOf(bob), 20e6 - 30_000, "claimer");
        assertEq(usdc.balanceOf(relay), 30_000, "relay fee");
    }

    /// @dev Consecutive payments of one sender use nonces 0, 1, 2, ... without any nonce in the call data.
    function test_consecutiveTransfers_sequentialNonces() public {
        for (uint256 i = 0; i < 5; ++i) {
            (address token, AuthMode mode) = _combo(uint8(i));
            _submitAndAssertTI1(_request(token, 1e6 + i, 10_000), mode);
            assertEq(gasless.nonces(alice), i + 1, "nonce");
        }
    }

    // --- Recipient and relay aliasing (allowed by D11) -------------------------------------------

    function test_selfTransfer_onlyFeeLeaves() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        r.to = alice;
        TokenAuth memory permit = _permitFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, permit), permit);
        assertEq(usdc.balanceOf(alice), INITIAL_BALANCE - 1e6, "sender pays the fee only");
        assertEq(usdc.balanceOf(relay), 1e6, "relay fee");
    }

    function test_senderAsOwnRelay() public {
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        r.relay = alice;
        TokenAuth memory metaTx = _metaTxFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, metaTx), metaTx);
        assertEq(usdt0.balanceOf(alice), INITIAL_BALANCE - 10e6, "fee paid to itself");
        assertEq(usdt0.balanceOf(bob), 10e6, "recipient");
    }

    function test_relayAsRecipient() public {
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        r.to = relay;
        TokenAuth memory permit = _permitFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, permit), permit);
        assertEq(usdc.balanceOf(relay), 11e6, "relay gets amount and fee");
    }

    // --- D13: log order --------------------------------------------------------------------------

    function test_D13_logOrder_usdcPermit() public {
        TransferRequest memory r = _request(address(usdc), 100e6, 2e6);
        TokenAuth memory auth = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);

        vm.recordLogs();
        _submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 4, "log count");
        _assertApproval(logs[0], address(usdc), alice, 102e6);
        _assertTransfer(logs[1], address(usdc), alice, relay, 2e6);
        _assertTransfer(logs[2], address(usdc), alice, bob, 100e6);
        _assertTransferRelayed(logs[3], r, 0, auth);
    }

    /// @dev USDT0 also emits Approval on every transferFrom (allowance decrease); the Transfer order is unchanged.
    function test_D13_logOrder_usdt0MetaTx() public {
        TransferRequest memory r = _request(address(usdt0), 100e6, 2e6);
        TokenAuth memory auth = _metaTxFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);

        vm.recordLogs();
        _submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 7, "log count");
        assertEq(logs[0].topics[0], MockUSDT0.MetaTransactionExecuted.selector, "meta-tx first");
        _assertApproval(logs[1], address(usdt0), alice, 102e6);
        _assertTransfer(logs[2], address(usdt0), alice, relay, 2e6);
        _assertApproval(logs[3], address(usdt0), alice, 100e6);
        _assertTransfer(logs[4], address(usdt0), alice, bob, 100e6);
        _assertApproval(logs[5], address(usdt0), alice, 0);
        _assertTransferRelayed(logs[6], r, 0, auth);
    }

    function test_D13_logOrder_none() public {
        TransferRequest memory r = _request(address(usdc), 100e6, 2e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _approve(address(usdc), alice, 102e6);

        vm.recordLogs();
        _submit(r, sig, _noneAuth());
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 3, "log count");
        _assertTransfer(logs[0], address(usdc), alice, relay, 2e6);
        _assertTransfer(logs[1], address(usdc), alice, bob, 100e6);
        _assertTransferRelayed(logs[2], r, 0, _noneAuth());
    }

    /// @dev Exactly amount + fee already approved does not skip a still valid permit: it executes and logs its
    ///      Approval (§4.3 "Log order"). The authorization's logs are absent only when it was used before.
    function test_D13_logOrder_permitWithExactAllowanceInPlace() public {
        TransferRequest memory r = _request(address(usdc), 100e6, 2e6);
        TokenAuth memory auth = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);
        _approve(address(usdc), alice, 102e6);

        vm.recordLogs();
        _submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 4, "log count");
        _assertApproval(logs[0], address(usdc), alice, 102e6);
        _assertTransfer(logs[1], address(usdc), alice, relay, 2e6);
        _assertTransfer(logs[2], address(usdc), alice, bob, 100e6);
        _assertTransferRelayed(logs[3], r, 0, auth);
        assertEq(usdc.nonces(alice), 1, "the permit executed");
    }

    /// @dev GaslessTransfer._collect with a fee larger than the amount (1000 * MAX_TEST_FEE): the token authorization
    ///      sets exactly amount + fee, the fee goes first, the principal last, and nothing is left of the allowance.
    function test_D13_logOrder_largeFeeFirst() public {
        uint256 fee = 1000 * MAX_TEST_FEE;
        TransferRequest memory r = _request(address(usdt0), 1e6, fee);
        TokenAuth memory auth = _metaTxFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, auth);

        vm.recordLogs();
        _submit(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 7, "log count");
        _assertApproval(logs[1], address(usdt0), alice, 1e6 + fee);
        _assertTransfer(logs[2], address(usdt0), alice, relay, fee);
        _assertApproval(logs[3], address(usdt0), alice, 1e6);
        _assertTransfer(logs[4], address(usdt0), alice, bob, 1e6);
        _assertApproval(logs[5], address(usdt0), alice, 0);
        _assertTransferRelayed(logs[6], r, 0, auth);
    }

    /// @dev The contract logs exactly one event for a transfer, as its last log, in every mode and at any nonce:
    ///      TransferRelayed(from, nonce, digest) with digest = hashTransfer(r, nonce, auth), the request id.
    function test_D13_transferRelayedEvent() public {
        vm.prank(alice);
        gasless.invalidateNonces(7);
        for (uint8 c = 0; c < 5; ++c) {
            (address token, AuthMode mode) = _combo(c);
            TransferRequest memory r = _request(token, 1e6, 10_000);
            TokenAuth memory auth = _authFor(alicePk, r, mode);
            bytes memory sig = _signTransfer(alicePk, r, auth);
            vm.recordLogs();
            _submit(r, sig, auth);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i = 0; i + 1 < logs.length; ++i) {
                assertTrue(logs[i].emitter != address(gasless), "GaslessTransfer logged before its last log");
            }
            _assertTransferRelayed(logs[logs.length - 1], r, 7 + c, auth);
        }
    }

    // --- Helpers ---------------------------------------------------------------------------------

    function _combo(uint8 seed) internal view returns (address token, AuthMode mode) {
        uint8 c = seed % 5;
        if (c == 0) return (address(usdc), AuthMode.PERMIT);
        if (c == 1) return (address(usdc), AuthMode.NONE);
        if (c == 2) return (address(usdt0), AuthMode.PERMIT);
        if (c == 3) return (address(usdt0), AuthMode.META_TX_APPROVE);
        return (address(usdt0), AuthMode.NONE);
    }

    function _assertSuccessfulTransfer(address token, AuthMode mode, uint256 amount, uint256 fee) internal {
        _submitAndAssertTI1(_request(token, amount, fee), mode);
    }

    /// @dev TI1: from pays amount + fee, to gets amount, relay (== msg.sender) gets fee, the nonce goes up by exactly
    ///      one, the contract keeps nothing and no allowance is left. The contract logs TransferRelayed for that nonce.
    function _submitAndAssertTI1(TransferRequest memory r, AuthMode mode) internal {
        IERC20 token = IERC20(r.token);
        TokenAuth memory auth = _authFor(alicePk, r, mode);
        bytes memory sig = _signTransfer(alicePk, r, auth);
        uint256 fromBefore = token.balanceOf(r.from);
        uint256 toBefore = token.balanceOf(r.to);
        uint256 relayBefore = token.balanceOf(r.relay);
        uint256 nonceBefore = gasless.nonces(r.from);
        bytes32 digest = gasless.hashTransfer(r, nonceBefore, auth);

        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessTransfer.TransferRelayed(r.from, nonceBefore, digest);
        _submit(r, sig, auth);

        assertEq(token.balanceOf(r.from), fromBefore - r.amount - r.fee, "from pays amount + fee");
        assertEq(token.balanceOf(r.to), toBefore + r.amount, "to receives amount");
        assertEq(token.balanceOf(r.relay), relayBefore + r.fee, "relay receives fee");
        assertEq(token.balanceOf(address(gasless)), 0, "no custody");
        assertEq(gasless.nonces(r.from), nonceBefore + 1, "nonce + 1");
        assertEq(token.allowance(r.from, address(gasless)), 0, "no leftover allowance");
    }

    /// @dev `log` is TransferRelayed(r.from, nonce, hashTransfer(r, nonce, auth)) by the contract, without data.
    function _assertTransferRelayed(Vm.Log memory log, TransferRequest memory r, uint256 nonce, TokenAuth memory auth)
        internal
        view
    {
        assertEq(log.emitter, address(gasless), "TransferRelayed emitter");
        assertEq(log.topics.length, 4, "TransferRelayed topics");
        assertEq(log.topics[0], IGaslessTransfer.TransferRelayed.selector, "TransferRelayed topic");
        assertEq(address(uint160(uint256(log.topics[1]))), r.from, "TransferRelayed from");
        assertEq(uint256(log.topics[2]), nonce, "TransferRelayed nonce");
        assertEq(log.topics[3], gasless.hashTransfer(r, nonce, auth), "TransferRelayed digest");
        assertEq(log.data.length, 0, "TransferRelayed data");
    }

    function _assertTransfer(Vm.Log memory log, address token, address from, address to, uint256 value) internal pure {
        assertEq(log.emitter, token, "Transfer emitter");
        assertEq(log.topics[0], TRANSFER_EVENT, "Transfer topic");
        assertEq(address(uint160(uint256(log.topics[1]))), from, "Transfer from");
        assertEq(address(uint160(uint256(log.topics[2]))), to, "Transfer to");
        assertEq(abi.decode(log.data, (uint256)), value, "Transfer value");
    }

    function _assertApproval(Vm.Log memory log, address token, address owner_, uint256 value) internal view {
        assertEq(log.emitter, token, "Approval emitter");
        assertEq(log.topics[0], APPROVAL_EVENT, "Approval topic");
        assertEq(address(uint160(uint256(log.topics[1]))), owner_, "Approval owner");
        assertEq(address(uint160(uint256(log.topics[2]))), address(gasless), "Approval spender is this contract");
        assertEq(abi.decode(log.data, (uint256)), value, "Approval value");
    }
}
