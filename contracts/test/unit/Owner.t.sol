// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, IGaslessBase, TokenAuth, TokenConfig} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice The owner (Ownable2Step) and setTokenConfig (D6): the owner adds, replaces and removes token configurations
///         and transfers ownership in two steps. It has no other power: it cannot move tokens, raise anyone's nonce or
///         change a signed request. A configuration change can make a signed request fail, or make one executable that
///         the previous configuration refused: a signed request stays valid until its nonce is used or its
///         deadline passes.
contract OwnerTest is GaslessTestBase {
    // --- setTokenConfig ------------------------------------------------------------------------------

    function test_D6_setTokenConfig_addsToken() public {
        MockUSDC added = new MockUSDC();
        added.mint(alice, 100e6);
        TokenConfig memory config = _config(false, false, true);

        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.TokenConfigSet(address(added), config);
        vm.prank(owner);
        gasless.setTokenConfig(address(added), config);
        _assertConfig(gasless.tokenConfig(address(added)), config);

        TransferRequest memory r = _request(address(added), 10e6, 1e6);
        vm.prank(alice);
        added.approve(address(gasless), 11e6);
        _submit(r, _signTransfer(alicePk, r, _noneAuth()), _noneAuth());
        assertEq(added.balanceOf(bob), 10e6, "the added token transfers");
        assertEq(added.balanceOf(relay), 1e6, "the signed fee");
    }

    function test_D6_setTokenConfig_replacesModes() public {
        TokenConfig memory config = _config(true, true, false);
        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.TokenConfigSet(address(usdc), config);
        vm.prank(owner);
        gasless.setTokenConfig(address(usdc), config);
        _assertConfig(gasless.tokenConfig(address(usdc)), config);

        // NONE is now disabled for USDC; PERMIT still works.
        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        _approve(address(usdc), alice, 11e6);
        _expectRevert(
            r,
            _signTransfer(alicePk, r, _noneAuth()),
            _noneAuth(),
            abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, address(usdc), AuthMode.NONE)
        );
        _approve(address(usdc), alice, 0);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, permit), permit);
        assertEq(usdc.balanceOf(bob), 10e6, "PERMIT executes");
        assertEq(usdc.balanceOf(relay), 1e6, "the signed fee");
    }

    function test_D6_setTokenConfig_removesToken() public {
        TransferRequest memory r = _request(address(usdt0), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        bytes memory sig = _signTransfer(alicePk, r, permit);

        TokenConfig memory removed = _config(false, false, false);
        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.TokenConfigSet(address(usdt0), removed);
        vm.prank(owner);
        gasless.setTokenConfig(address(usdt0), removed);
        _assertConfig(gasless.tokenConfig(address(usdt0)), removed);

        // A request signed before the removal can no longer execute ...
        _expectRevert(r, sig, permit, abi.encodeWithSelector(IGaslessBase.TokenNotSupported.selector, address(usdt0)));
        assertEq(gasless.nonces(alice), 0, "nonce unused");
        // ... until the token is enabled again; the signature is still valid then.
        vm.prank(owner);
        gasless.setTokenConfig(address(usdt0), _config(true, false, false));
        _submit(r, sig, permit);
        assertEq(usdt0.balanceOf(bob), 10e6, "executes after re-enabling");
    }

    /// @dev A request refused with TokenNotSupported or AuthModeNotSupported keeps its nonce; once the owner
    ///      adds the token or enables the mode, it executes as signed.
    function test_D6_setTokenConfig_addedTokenOrMode_revivesRefusedRequest() public {
        MockUSDC other = new MockUSDC();
        other.mint(alice, 100e6);
        vm.prank(alice);
        other.approve(address(gasless), type(uint256).max);
        TransferRequest memory r = _request(address(other), 10e6, 1e6);
        bytes memory sig = _signTransfer(alicePk, r, _noneAuth());
        _expectRevert(r, sig, _noneAuth(), abi.encodeWithSelector(IGaslessBase.TokenNotSupported.selector, r.token));
        vm.prank(owner);
        gasless.setTokenConfig(address(other), _config(false, false, true));
        _submit(r, sig, _noneAuth());
        assertEq(other.balanceOf(bob), 10e6, "executes once the token is added");

        // USDC has no META_TX_APPROVE mode; an allowance of exactly amount + fee is in place (T18).
        TransferRequest memory m = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory metaTx = TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 0, r: 0, s: 0});
        _approve(address(usdc), alice, 11e6);
        bytes memory mSig = _signTransfer(alicePk, m, metaTx);
        _expectRevert(
            m,
            mSig,
            metaTx,
            abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, address(usdc), AuthMode.META_TX_APPROVE)
        );
        vm.prank(owner);
        gasless.setTokenConfig(address(usdc), _config(true, true, true));
        _submit(m, mSig, metaTx);
        assertEq(usdc.balanceOf(bob), 10e6, "executes once the mode is enabled");
    }

    /// @dev Removing a token that was never configured is allowed and announced; nothing else changes.
    function test_D6_setTokenConfig_removingUnknownTokenIsANoOp() public {
        address unknown = makeAddr("unknown");
        vm.expectEmit(true, true, true, true, address(gasless));
        emit IGaslessBase.TokenConfigSet(unknown, _config(false, false, false));
        vm.prank(owner);
        gasless.setTokenConfig(unknown, _config(false, false, false));
        _assertConfig(gasless.tokenConfig(unknown), _config(false, false, false));
    }

    /// @dev A configuration without any mode is a removal, accepted for any address: also for address(0), an address
    ///      without code and the contract itself, which no enabled configuration may name.
    function test_D6_setTokenConfig_allFalseIsRemovalForAnyAddress() public {
        address[4] memory targets = [address(0), makeAddr("eoa"), address(gasless), address(usdt0)];
        vm.startPrank(owner);
        for (uint256 i = 0; i < targets.length; ++i) {
            vm.expectEmit(true, true, true, true, address(gasless));
            emit IGaslessBase.TokenConfigSet(targets[i], _config(false, false, false));
            gasless.setTokenConfig(targets[i], _config(false, false, false));
            _assertConfig(gasless.tokenConfig(targets[i]), _config(false, false, false));
        }
        vm.stopPrank();
        _assertConfig(gasless.tokenConfig(address(usdc)), _config(true, false, true));
    }

    function test_D6_setTokenConfig_rejectsInvalidConfig() public {
        vm.startPrank(owner);
        // Enabled: the token needs code and must not be this contract.
        for (uint256 flags = 1; flags < 8; ++flags) {
            TokenConfig memory c = _config(flags & 1 != 0, flags & 2 != 0, flags & 4 != 0);
            _expectInvalid(address(0), c);
            _expectInvalid(makeAddr("eoa"), c);
            _expectInvalid(address(gasless), c);
        }
        vm.stopPrank();
        _assertConfig(gasless.tokenConfig(address(usdc)), _config(true, false, true));
        _assertConfig(gasless.tokenConfig(address(gasless)), _config(false, false, false));
    }

    function testFuzz_D6_setTokenConfig_onlyOwner(address caller, bool permit, bool metaTx, bool allowance) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        gasless.setTokenConfig(address(usdc), _config(permit, metaTx, allowance));
        _assertConfig(gasless.tokenConfig(address(usdc)), _config(true, false, true));
    }

    function testFuzz_D6_setTokenConfig_storesExactly(bool permit, bool metaTx, bool allowance) public {
        TokenConfig memory config = _config(permit, metaTx, allowance);
        vm.prank(owner);
        gasless.setTokenConfig(address(usdt0), config);
        _assertConfig(gasless.tokenConfig(address(usdt0)), config);
        _assertConfig(gasless.tokenConfig(address(usdc)), _config(true, false, true));
    }

    // --- Ownable2Step --------------------------------------------------------------------------------

    function test_ownership_twoStepTransfer() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        gasless.transferOwnership(attacker);

        vm.expectEmit(true, true, true, true, address(gasless));
        emit Ownable2Step.OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        gasless.transferOwnership(newOwner);
        assertEq(gasless.owner(), owner, "unchanged until accepted");
        assertEq(gasless.pendingOwner(), newOwner, "pending");

        // The old owner keeps its power until the transfer is accepted; nobody else can accept.
        vm.prank(owner);
        gasless.setTokenConfig(address(usdc), _config(false, false, true));
        _assertConfig(gasless.tokenConfig(address(usdc)), _config(false, false, true));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        gasless.acceptOwnership();

        vm.expectEmit(true, true, true, true, address(gasless));
        emit Ownable.OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        gasless.acceptOwnership();
        assertEq(gasless.owner(), newOwner, "new owner");
        assertEq(gasless.pendingOwner(), address(0), "nothing pending");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        gasless.setTokenConfig(address(usdc), _config(true, false, true));
        vm.prank(newOwner);
        gasless.setTokenConfig(address(usdc), _config(true, false, true));
    }

    /// @dev Renouncing freezes the token configuration for good; transfers keep working.
    function test_ownership_renounceFreezesConfig() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        gasless.renounceOwnership();

        vm.prank(owner);
        gasless.renounceOwnership();
        assertEq(gasless.owner(), address(0), "no owner");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        gasless.setTokenConfig(address(usdc), _config(false, false, false));

        TransferRequest memory r = _request(address(usdc), 10e6, 1e6);
        TokenAuth memory permit = _permitFor(alicePk, r);
        _submit(r, _signTransfer(alicePk, r, permit), permit);
        assertEq(usdc.balanceOf(bob), 10e6, "transfers still work");
    }

    /// @dev The owner has no power over tokens, nonces or requests: with a max-approved victim, every function it can
    ///      call (including a reconfiguration of the token) moves nothing and leaves the victim's nonce untouched.
    function test_ownerCannotMoveFundsOrTouchNonces() public {
        _approve(address(usdc), alice, type(uint256).max);
        _approve(address(usdt0), alice, type(uint256).max);
        uint256[] memory before = _balances();

        // The owner relays a request of the victim that the victim never signed, as the relay of its own choice.
        TransferRequest memory r = _request(address(usdc), 100e6, 0);
        r.to = owner;
        r.relay = owner;
        bytes memory attackerSig = _signTransfer(attackerPk, r, _noneAuth());
        vm.startPrank(owner);
        gasless.setTokenConfig(address(usdc), _config(false, false, true));
        vm.expectRevert(_errInvalidSignature());
        gasless.relayTransfer(r, new bytes(65), _noneAuth());
        vm.expectRevert(_errInvalidSignature());
        gasless.relayTransfer(r, attackerSig, _noneAuth());
        // invalidateNonces only ever raises the caller's own nonce.
        gasless.invalidateNonces(5);
        gasless.transferOwnership(attacker);
        vm.stopPrank();
        vm.prank(attacker);
        gasless.acceptOwnership();

        _assertBalancesUnchanged(before);
        assertEq(gasless.nonces(alice), 0, "victim nonce untouched");
        assertEq(gasless.nonces(owner), 5, "the owner's own nonce");
        assertEq(usdc.allowance(alice, address(gasless)), type(uint256).max, "allowance untouched");
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    function _expectInvalid(address token, TokenConfig memory config) internal {
        vm.expectRevert(IGaslessBase.InvalidConfig.selector);
        gasless.setTokenConfig(token, config);
    }

    function _assertConfig(TokenConfig memory actual, TokenConfig memory expected) internal pure {
        assertEq(actual.permit, expected.permit, "permit");
        assertEq(actual.metaTxApprove, expected.metaTxApprove, "metaTxApprove");
        assertEq(actual.allowance, expected.allowance, "allowance");
    }
}
