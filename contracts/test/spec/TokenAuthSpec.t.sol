// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthMode, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

import {SpecBase} from "./SpecBase.sol";

/// @notice Token authorization obtained by the contract itself (D4, §4.1, §5): T18, T29, and the A10 front-running
///         cases on mocks (the real-token versions T13-T16 are fork tests and are not covered here). The token
///         authorization is part of the signed intent.
contract TokenAuthSpecTest is SpecBase {
    // ================================================================ T18

    /// @notice T18: a PERMIT signed for a value other than amount + fee (one less, one more, unlimited) cannot be used,
    ///         even when the user signed it into the intent: the contract always asks for exactly amount + fee, so
    ///         the permit fails and the call reverts InsufficientAllowance(0, amount + fee). The allowance stays 0.
    ///         USDC and USDT0.
    function test_T18_permitValueOtherThanAmountPlusFeeReverts() public {
        address[2] memory tokens = [address(usdc), address(usdt)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TransferRequest memory r = request(tokens[i], alice);
            uint256 required = r.amount + r.fee;
            uint256[3] memory values = [required - 1, required + 1, type(uint256).max];
            for (uint256 j = 0; j < values.length; ++j) {
                TokenAuth memory auth = signPermit(aliceKey, r.token, alice, address(gasless), values[j], r.deadline);
                expectRevertNoChange(
                    relay, r, signRequest(aliceKey, r, auth), auth, errInsufficientAllowance(0, required)
                );
                assertEq(IAllowance(r.token).allowance(alice, address(gasless)), 0);
            }
        }
    }

    /// @notice T18: the same for a USDT0 meta-tx approve signed for another value or another spender.
    function test_T18_metaTxApproveForOtherValueOrSpenderReverts() public {
        TransferRequest memory r = request(address(usdt), alice);
        uint256 required = r.amount + r.fee;

        TokenAuth[] memory auths = new TokenAuth[](4);
        auths[0] = signMetaTxApprove(aliceKey, alice, address(gasless), required - 1);
        auths[1] = signMetaTxApprove(aliceKey, alice, address(gasless), required + 1);
        auths[2] = signMetaTxApprove(aliceKey, alice, address(gasless), type(uint256).max);
        auths[3] = signMetaTxApprove(aliceKey, alice, attacker, required);
        for (uint256 j = 0; j < auths.length; ++j) {
            expectRevertNoChange(
                relay, r, signRequest(aliceKey, r, auths[j]), auths[j], errInsufficientAllowance(0, required)
            );
        }
        assertEq(usdt.allowance(alice, attacker), 0);
    }

    /// @notice T18 / §5: a permit is bound to spender = the contract and deadline = the intent deadline. A permit for
    ///         another spender, another deadline, from another key, or with a stale token nonce is useless.
    function test_T18_permitWithWrongSpenderDeadlineSignerOrNonceReverts() public {
        address[2] memory tokens = [address(usdc), address(usdt)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TransferRequest memory r = request(tokens[i], alice);
            uint256 required = r.amount + r.fee;
            uint256 nonce = tokenNonce(r.token, alice);

            TokenAuth[] memory auths = new TokenAuth[](5);
            auths[0] = signPermit(aliceKey, r.token, alice, attacker, required, r.deadline);
            auths[1] = signPermit(aliceKey, r.token, alice, address(gasless), required, r.deadline + 1);
            auths[2] = signPermit(aliceKey, r.token, alice, address(gasless), required, type(uint256).max);
            auths[3] = signPermit(attackerKey, r.token, alice, address(gasless), required, r.deadline);
            auths[4] = _permitWithNonce(aliceKey, r.token, required, r.deadline, nonce + 1);
            for (uint256 j = 0; j < auths.length; ++j) {
                expectRevertNoChange(
                    relay, r, signRequest(aliceKey, r, auths[j]), auths[j], errInsufficientAllowance(0, required)
                );
            }
        }
    }

    /// @notice T18 / TI5: after a successful PERMIT or META_TX call the allowance to the contract is exactly 0.
    function test_T18_noAllowanceLeftAfterPermitOrMetaTx() public {
        uint256[3] memory routes = [uint256(0), 2, 3];
        for (uint256 i = 0; i < routes.length; ++i) {
            (address token, AuthMode mode) = route(routes[i]);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            submit(r, signRequest(aliceKey, r, auth), auth);
            assertEq(IAllowance(token).allowance(alice, address(gasless)), 0, routeName(routes[i]));
        }
    }

    // ================================================================ A10 / D4: front-running (mock versions)

    /// @notice D4 / A10: someone submits the user's permit or meta-tx to the token first. The contract's own attempt
    ///         then fails inside try/catch, the allowance check passes, and the transfer still succeeds with exact
    ///         amounts and no allowance left (TI5).
    function test_A10_frontRunTokenAuthorizationDoesNotBlock() public {
        uint256[3] memory routes = [uint256(0), 2, 3];
        for (uint256 i = 0; i < routes.length; ++i) {
            (address token, AuthMode mode) = route(routes[i]);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            bytes memory sig = signRequest(aliceKey, r, auth);

            vm.prank(attacker);
            if (mode == AuthMode.PERMIT) {
                ITokenAuth(token).permit(alice, address(gasless), r.amount + r.fee, r.deadline, auth.v, auth.r, auth.s);
            } else {
                usdt.executeMetaTransaction(
                    alice, approveCalldata(address(gasless), r.amount + r.fee), auth.r, auth.s, auth.v
                );
            }
            assertEq(IAllowance(token).allowance(alice, address(gasless)), r.amount + r.fee);

            State memory before = observe(r);
            submit(r, sig, auth);
            assertTransferred(r, before);
            assertEq(IAllowance(token).allowance(alice, address(gasless)), 0, routeName(routes[i]));
        }
    }

    /// @notice A10 / §5 "USDT0 nonces are shared": the user signed a permit and a meta-tx with the same USDT0 nonce;
    ///         an attacker burns that nonce by submitting the meta-tx first. The permit-based request then ends in a
    ///         clean revert (not a partial transfer). The relay cannot swap in a fresh authorization on its own; the
    ///         user retries with one, signed into a new intent signature at the same nonce.
    function test_A10_usdt0SharedNonceDosEndsInCleanRevert() public {
        TransferRequest memory r = request(address(usdt), alice);
        TokenAuth memory permitAuth = authorize(aliceKey, r, AuthMode.PERMIT);
        bytes memory sig = signRequest(aliceKey, r, permitAuth);
        TokenAuth memory otherMetaTx = signMetaTxApprove(aliceKey, alice, bob, 1);

        vm.prank(attacker);
        usdt.executeMetaTransaction(alice, approveCalldata(bob, 1), otherMetaTx.r, otherMetaTx.s, otherMetaTx.v);

        expectRevertNoChange(relay, r, sig, permitAuth, errInsufficientAllowance(0, r.amount + r.fee));

        TokenAuth memory retry = authorize(aliceKey, r, AuthMode.META_TX_APPROVE);
        expectRevertNoChange(relay, r, sig, retry, errInvalidSignature());
        State memory before = observe(r);
        submit(r, signRequest(aliceKey, r, retry), retry);
        assertTransferred(r, before);
    }

    /// @notice D4: the contract builds the meta-tx call data itself; the approve inside the meta-tx always names the
    ///         contract as spender and amount + fee as value (checked through MetaTransactionExecuted).
    function test_D4_metaTxApproveSpenderIsAlwaysTheContract() public {
        TransferRequest memory r = request(address(usdt), alice);
        TokenAuth memory auth = authorize(aliceKey, r, AuthMode.META_TX_APPROVE);
        bytes memory sig = signRequest(aliceKey, r, auth);
        vm.expectEmit(true, true, true, true, address(usdt));
        emit MetaTransactionExecuted(
            alice, payable(address(gasless)), approveCalldata(address(gasless), r.amount + r.fee)
        );
        submit(r, sig, auth);
    }

    // ================================================================ T29

    /// @notice T29: permit gas starvation causes no partial state change. The USDC mock's permit is made expensive,
    ///         and the relay calls with every gas limit from far too little to plenty (4k steps up to 1.2M, so the
    ///         window stays inside the sweep even if the implementation spends a few 100k gas before the permit).
    ///         Each call either completes the whole transfer (exact amounts, nonce used, no allowance left) or reverts
    ///         with no state change; at least one limit exercises the "permit ran out of gas inside try/catch, then
    ///         the allowance check reverted" path, and at least one limit succeeds.
    function test_T29_permitGasStarvationCausesNoPartialStateChange() public {
        usdc.setPermitGasBurn(300_000);
        TransferRequest memory r = request(address(usdc), alice);
        TokenAuth memory auth = authorize(aliceKey, r, AuthMode.PERMIT);
        bytes memory sig = signRequest(aliceKey, r, auth);
        bytes memory data = abi.encodeCall(IGaslessTransfer.relayTransfer, (r, sig, auth));
        State memory before = observe(r);

        uint256 successes;
        uint256 starvedPermitReverts;
        for (uint256 gasLimit = 20_000; gasLimit <= 1_200_000; gasLimit += 4000) {
            uint256 snapshot = vm.snapshotState();
            vm.prank(relay);
            (bool ok, bytes memory ret) = address(gasless).call{gas: gasLimit}(data);
            if (ok) {
                ++successes;
                assertTransferred(r, before);
                assertEq(usdc.allowance(alice, address(gasless)), 0, "allowance left after success");
            } else {
                assertUnchanged(r, before);
                if (keccak256(ret) == keccak256(errInsufficientAllowance(0, r.amount + r.fee))) {
                    ++starvedPermitReverts;
                }
            }
            vm.revertToStateAndDelete(snapshot);
        }
        assertGt(successes, 0, "no gas limit succeeded");
        assertGt(starvedPermitReverts, 0, "the starved-permit path was never reached");
    }

    // ================================================================ helpers

    function _permitWithNonce(uint256 key, address token, uint256 value, uint256 deadline, uint256 nonce)
        internal
        view
        returns (TokenAuth memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, permitDigest(token, vm.addr(key), address(gasless), value, nonce, deadline));
        return TokenAuth({mode: AuthMode.PERMIT, v: v, r: r, s: s});
    }

    event MetaTransactionExecuted(
        address indexed userAddress, address payable indexed relayerAddress, bytes functionSignature
    );
}

interface IAllowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface ITokenAuth {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
