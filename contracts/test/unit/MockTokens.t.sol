// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {PermissiveERC1271Wallet} from "../mocks/MockAccounts.sol";
import {MockUSDT0} from "../mocks/MockUSDT0.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice The mocks behave like the real tokens where the gasless contracts and their clients depend on it
///         (FiatTokenV2_2 and UChildUSDT0 verified sources).
contract MockUSDCTest is GaslessTestBase {
    address internal spender = makeAddr("spender");

    function test_metadataAndDomain() public {
        assertEq(usdc.name(), "USD Coin");
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.version(), "2");
        assertEq(usdc.DOMAIN_SEPARATOR(), _usdcDomainSeparator());
        vm.chainId(137);
        assertEq(usdc.DOMAIN_SEPARATOR(), _usdcDomainSeparator(), "recomputed per chain id");
    }

    function test_permit() public {
        TokenAuth memory p = _signPermit(alicePk, address(usdc), alice, spender, 5e6, 0, vm.getBlockTimestamp());
        vm.expectEmit(address(usdc));
        emit IERC20.Approval(alice, spender, 5e6);
        usdc.permit(alice, spender, 5e6, vm.getBlockTimestamp(), p.v, p.r, p.s);
        assertEq(usdc.allowance(alice, spender), 5e6);
        assertEq(usdc.nonces(alice), 1);
        vm.expectRevert("EIP2612: invalid signature");
        usdc.permit(alice, spender, 5e6, vm.getBlockTimestamp(), p.v, p.r, p.s);
    }

    function test_permit_deadline() public {
        uint256 deadline = vm.getBlockTimestamp();
        TokenAuth memory p = _signPermit(alicePk, address(usdc), alice, spender, 5e6, 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert("FiatTokenV2: permit is expired");
        usdc.permit(alice, spender, 5e6, deadline, p.v, p.r, p.s);

        p = _signPermit(alicePk, address(usdc), alice, spender, 5e6, 0, type(uint256).max);
        vm.warp(type(uint64).max);
        usdc.permit(alice, spender, 5e6, type(uint256).max, p.v, p.r, p.s);
        assertEq(usdc.allowance(alice, spender), 5e6, "max deadline never expires");
    }

    function test_permit_rejectsMalleableAndBadV() public {
        uint256 deadline = vm.getBlockTimestamp();
        TokenAuth memory p = _signPermit(alicePk, address(usdc), alice, spender, 5e6, 0, deadline);
        bytes32 highS = bytes32(SECP256K1_N - uint256(p.s));
        uint8 flippedV = p.v == 27 ? 28 : 27;
        vm.expectRevert("ECRecover: invalid signature 's' value");
        usdc.permit(alice, spender, 5e6, deadline, flippedV, p.r, highS);
        vm.expectRevert("ECRecover: invalid signature 'v' value");
        usdc.permit(alice, spender, 5e6, deadline, p.v - 27, p.r, p.s);
        vm.expectRevert("EIP2612: invalid signature");
        usdc.permit(alice, spender, 5e6 + 1, deadline, p.v, p.r, p.s);
    }

    function test_permit_erc1271PathForAccountsWithCode() public {
        PermissiveERC1271Wallet wallet = new PermissiveERC1271Wallet();
        usdc.permit(address(wallet), spender, 7e6, vm.getBlockTimestamp(), 27, bytes32(0), bytes32(0));
        assertEq(usdc.allowance(address(wallet), spender), 7e6, "ERC-1271 wallet approved via permit");
    }

    function test_pause() public {
        usdc.pause();
        TokenAuth memory p = _signPermit(alicePk, address(usdc), alice, spender, 5e6, 0, vm.getBlockTimestamp());
        vm.expectRevert("Pausable: paused");
        usdc.permit(alice, spender, 5e6, vm.getBlockTimestamp(), p.v, p.r, p.s);
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        usdc.approve(spender, 1);
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        usdc.transfer(bob, 1);
        usdc.unpause();
        assertFalse(usdc.paused());
    }

    function test_blacklist_msgSenderFromTo_andSelf() public {
        assertTrue(usdc.isBlacklisted(address(usdc)), "the token blacklists itself");
        vm.prank(alice);
        vm.expectRevert("Blacklistable: account is blacklisted");
        usdc.transfer(address(usdc), 1);

        vm.prank(alice);
        usdc.approve(spender, 10e6);
        address[3] memory parties = [spender, alice, bob];
        for (uint256 i = 0; i < parties.length; ++i) {
            usdc.blacklist(parties[i]);
            vm.prank(spender);
            vm.expectRevert("Blacklistable: account is blacklisted");
            usdc.transferFrom(alice, bob, 1);
            usdc.unBlacklist(parties[i]);
        }
        vm.prank(spender);
        usdc.transferFrom(alice, bob, 1);
    }

    function test_transferFrom_decrementsEvenMaxAllowance() public {
        vm.prank(alice);
        usdc.approve(spender, type(uint256).max);
        vm.prank(spender);
        usdc.transferFrom(alice, bob, 3);
        assertEq(usdc.allowance(alice, spender), type(uint256).max - 3);
        vm.prank(spender);
        vm.expectRevert("ERC20: transfer amount exceeds allowance");
        usdc.transferFrom(bob, alice, 1);
    }

    function test_adminOnly() public {
        vm.startPrank(attacker);
        vm.expectRevert("MockUSDC: caller is not the admin");
        usdc.mint(attacker, 1);
        vm.expectRevert("MockUSDC: caller is not the admin");
        usdc.blacklist(alice);
        vm.expectRevert("MockUSDC: caller is not the admin");
        usdc.pause();
        vm.stopPrank();
    }
}

contract MockUSDT0Test is GaslessTestBase {
    address internal spender = makeAddr("spender");

    function test_metadataAndSaltDomain() public {
        assertEq(usdt0.name(), "USDT0");
        assertEq(usdt0.symbol(), "USDT0");
        assertEq(usdt0.decimals(), 6);
        assertEq(usdt0.DOMAIN_SEPARATOR(), _usdt0DomainSeparator());
        assertEq(usdt0.getDomainSeperator(), _usdt0DomainSeparator());
        bytes32 stored = usdt0.DOMAIN_SEPARATOR();
        vm.chainId(137);
        assertEq(usdt0.DOMAIN_SEPARATOR(), stored, "stored at deployment, not recomputed");
        assertEq(usdt0.getChainId(), 137);
    }

    function test_changeName_replacesDomain() public {
        bytes32 before = usdt0.DOMAIN_SEPARATOR();
        usdt0.changeName("Tether USD");
        assertEq(usdt0.name(), "Tether USD");
        assertTrue(usdt0.DOMAIN_SEPARATOR() != before, "domain replaced");
        vm.prank(attacker);
        vm.expectRevert("MockUSDT0: caller is not the admin");
        usdt0.changeName("x");
    }

    function test_permit_andDeadlineZero() public {
        TokenAuth memory p = _signPermit(alicePk, address(usdt0), alice, spender, 5e6, 0, 0);
        vm.warp(type(uint64).max);
        usdt0.permit(alice, spender, 5e6, 0, p.v, p.r, p.s);
        assertEq(usdt0.allowance(alice, spender), 5e6, "deadline 0 never expires");
        assertEq(usdt0.nonces(alice), 1);
        assertEq(usdt0.getNonce(alice), 1);
    }

    function test_permit_reverts() public {
        uint256 deadline = vm.getBlockTimestamp();
        TokenAuth memory p = _signPermit(alicePk, address(usdt0), alice, spender, 5e6, 0, deadline);
        vm.expectRevert("USDT0: HOLDER-ZERO");
        usdt0.permit(address(0), spender, 5e6, deadline, p.v, p.r, p.s);
        vm.expectRevert("USDT0: INVALID-PERMIT");
        usdt0.permit(alice, spender, 5e6 + 1, deadline, p.v, p.r, p.s);
        vm.warp(deadline + 1);
        vm.expectRevert("USDT0: PERMIT-EXPIRED");
        usdt0.permit(alice, spender, 5e6, deadline, p.v, p.r, p.s);
    }

    /// @dev Plain ecrecover: the malleable twin of a permit signature is accepted, as on the real token.
    function test_permit_acceptsHighS() public {
        TokenAuth memory p = _signPermit(alicePk, address(usdt0), alice, spender, 5e6, 0, 0);
        usdt0.permit(alice, spender, 5e6, 0, p.v == 27 ? 28 : 27, p.r, bytes32(SECP256K1_N - uint256(p.s)));
        assertEq(usdt0.allowance(alice, spender), 5e6);
    }

    function test_metaTx_approveRunsAsUser_andSharesNonceWithPermit() public {
        TokenAuth memory m = _signMetaTxApprove(alicePk, alice, spender, 9e6, 0);
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (spender, 9e6));
        vm.expectEmit(address(usdt0));
        emit MockUSDT0.MetaTransactionExecuted(alice, relay, approveCall);
        vm.prank(relay);
        bytes memory ret = usdt0.executeMetaTransaction(alice, approveCall, m.r, m.s, m.v);
        assertEq(abi.decode(ret, (bool)), true, "returns the inner call's return data");
        assertEq(usdt0.allowance(alice, spender), 9e6, "approved for the user, not the relayer");
        assertEq(usdt0.getNonce(alice), 1);

        // A permit signed at nonce 0 is now stale.
        TokenAuth memory p = _signPermit(alicePk, address(usdt0), alice, spender, 1, 0, 0);
        vm.expectRevert("USDT0: INVALID-PERMIT");
        usdt0.permit(alice, spender, 1, 0, p.v, p.r, p.s);
        // Replaying the meta-tx fails as well.
        vm.expectRevert("Signer and signature do not match");
        usdt0.executeMetaTransaction(alice, approveCall, m.r, m.s, m.v);
    }

    function test_metaTx_transferMovesUserFunds() public {
        bytes memory transferCall = abi.encodeCall(IERC20.transfer, (bob, 4e6));
        bytes32 structHash = keccak256(abi.encode(META_TRANSACTION_TYPEHASH, 0, alice, keccak256(transferCall)));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", _usdt0DomainSeparator(), structHash)));
        usdt0.executeMetaTransaction(alice, transferCall, r, s, v);
        assertEq(usdt0.balanceOf(bob), 4e6);
    }

    function test_metaTx_reverts() public {
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (spender, 1));
        vm.expectRevert("NativeMetaTransaction: INVALID_SIGNER");
        usdt0.executeMetaTransaction(address(0), approveCall, bytes32(0), bytes32(0), 27);

        // permit cannot be wrapped in a meta-transaction.
        TokenAuth memory p = _signPermit(alicePk, address(usdt0), alice, spender, 1, 1, 0);
        bytes memory permitCall = abi.encodeCall(usdt0.permit, (alice, spender, 1, 0, p.v, p.r, p.s));
        bytes32 structHash = keccak256(abi.encode(META_TRANSACTION_TYPEHASH, 0, alice, keccak256(permitCall)));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", _usdt0DomainSeparator(), structHash)));
        vm.expectRevert("Function call not successful");
        usdt0.executeMetaTransaction(alice, permitCall, r, s, v);
    }

    function test_blockedList() public {
        vm.prank(alice);
        usdt0.approve(spender, 10e6);

        usdt0.addToBlockedList(alice);
        assertTrue(usdt0.isBlocked(alice));
        vm.prank(spender);
        vm.expectRevert("USDT0: from is blocked");
        usdt0.transferFrom(alice, bob, 1);
        vm.prank(alice);
        vm.expectRevert("USDT0: from is blocked");
        usdt0.transfer(bob, 1);
        usdt0.removeFromBlockedList(alice);

        usdt0.addToBlockedList(spender);
        vm.prank(spender);
        vm.expectRevert("Blocked: msg.sender is blocked");
        usdt0.transferFrom(alice, bob, 1);
        usdt0.removeFromBlockedList(spender);

        usdt0.addToBlockedList(bob);
        vm.prank(spender);
        usdt0.transferFrom(alice, bob, 1);
        assertEq(usdt0.balanceOf(bob), 1, "blocked recipients can receive");
    }

    function test_transferToTokenItself_reverts() public {
        vm.prank(alice);
        vm.expectRevert("USDT0: transfer to the contract address");
        usdt0.transfer(address(usdt0), 1);
    }

    function test_transferFrom_emitsApprovalAndDecrementsMax() public {
        vm.prank(alice);
        usdt0.approve(spender, type(uint256).max);
        vm.expectEmit(address(usdt0));
        emit IERC20.Approval(alice, spender, type(uint256).max - 2);
        vm.prank(spender);
        usdt0.transferFrom(alice, bob, 2);
        assertEq(usdt0.allowance(alice, spender), type(uint256).max - 2, "no infinite approval");
        vm.prank(spender);
        vm.expectRevert("ERC20: transfer amount exceeds allowance");
        usdt0.transferFrom(bob, alice, 1);
    }

    function test_adminOnly() public {
        vm.startPrank(attacker);
        vm.expectRevert("MockUSDT0: caller is not the admin");
        usdt0.mint(attacker, 1);
        vm.expectRevert("MockUSDT0: caller is not the admin");
        usdt0.addToBlockedList(alice);
        vm.stopPrank();
    }
}
