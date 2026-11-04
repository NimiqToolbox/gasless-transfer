// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {AuthMode, IGaslessBase, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {ForkTestBase, IFiatTokenV2_2, IUChildUSDT0} from "./ForkTestBase.sol";

/// @notice Token authorization against the real USDC (FiatTokenV2_2) and USDT0 (UChildUSDT0) on a recent block:
///         T13-T17, T24 and every (token, mode) end to end. Balances are dealt to a fresh key.
contract TokenAuthForkTest is ForkTestBase {
    bytes32 internal constant APPROVAL_EVENT = keccak256("Approval(address,address,uint256)");

    address internal user;
    uint256 internal userPk;
    address internal relay;
    address internal merchant;

    function setUp() public {
        forked = _fork(vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK));
        if (!forked) return;
        (user, userPk) = makeAddrAndKey("fork-user");
        relay = makeAddr("fork-relay");
        merchant = makeAddr("fork-merchant");
        _fund(USDC, user, 1000e6);
        _fund(USDT0, user, 1000e6);
    }

    /// @dev Standing allowances never authorize a transfer without the sender's valid intent signature.
    function test_unsignedRequestsCannotSpendStandingAllowances() public onlyForked {
        (address attacker, uint256 attackerPk) = makeAddrAndKey("fork-unauthorized-relay");
        address[2] memory tokens = [USDC, USDT0];
        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20 token = IERC20(tokens[i]);
            vm.prank(user);
            token.approve(address(gasless), type(uint256).max);
            uint256 balanceBefore = token.balanceOf(user);
            uint256 attackerBefore = token.balanceOf(attacker);
            TransferRequest memory r = _request(tokens[i], user, attacker, balanceBefore, 0, attacker);

            uint256 modes = tokens[i] == USDT0 ? 3 : 2;
            for (uint256 mode = 0; mode < modes; ++mode) {
                TokenAuth memory auth =
                    TokenAuth({mode: AuthMode(mode), v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});
                bytes[] memory signatures = new bytes[](5);
                signatures[0] = "";
                signatures[1] = new bytes(64);
                signatures[2] = new bytes(65);
                signatures[3] = _signTransfer(attackerPk, r, auth);
                signatures[4] = _signTransfer(userPk, r, auth);
                signatures[4][10] ^= 0x01;
                for (uint256 j = 0; j < signatures.length; ++j) {
                    vm.prank(attacker);
                    vm.expectRevert(IGaslessBase.InvalidSignature.selector);
                    gasless.relayTransfer(r, signatures[j], auth);
                }
            }
            assertEq(token.balanceOf(user), balanceBefore, "sender balance unchanged");
            assertEq(token.balanceOf(attacker), attackerBefore, "attacker balance unchanged");
            assertEq(token.allowance(user, address(gasless)), type(uint256).max, "allowance unchanged");
            assertEq(gasless.nonces(user), 0, "nonce unchanged");
        }
    }

    /// @dev The pinned §5 domains are the tokens' live domains.
    function test_forkTokenDomains_matchPins() public onlyForked {
        assertEq(IFiatTokenV2_2(USDC).DOMAIN_SEPARATOR(), PINNED_USDC_DOMAIN, "USDC live domain == pin");
        assertEq(IUChildUSDT0(USDT0).DOMAIN_SEPARATOR(), PINNED_USDT0_DOMAIN, "USDT0 live domain == pin");
        assertEq(_tokenDomain(USDC), PINNED_USDC_DOMAIN, "USDC domain fields");
        assertEq(_tokenDomain(USDT0), PINNED_USDT0_DOMAIN, "USDT0 domain fields");
    }

    function test_forkEveryMode_endToEnd() public onlyForked {
        _transferAndAssert(USDC, AuthMode.PERMIT);
        _transferAndAssert(USDC, AuthMode.NONE);
        _transferAndAssert(USDT0, AuthMode.PERMIT);
        _transferAndAssert(USDT0, AuthMode.META_TX_APPROVE);
        _transferAndAssert(USDT0, AuthMode.NONE);
    }

    // --- T13-T15: front-running the token authorization ------------------------------------------

    function test_T13_frontRunUsdcPermit_stillSucceeds() public onlyForked {
        TransferRequest memory r = _request(USDC, user, merchant, 100e6, 20_000, relay);
        TokenAuth memory auth = _permitFor(userPk, r);
        bytes memory sig = _signTransfer(userPk, r, auth);
        vm.prank(makeAddr("front-runner"));
        IFiatTokenV2_2(USDC).permit(user, address(gasless), r.amount + r.fee, r.deadline, auth.v, auth.r, auth.s);

        _submitAndAssert(r, sig, auth);
    }

    function test_T14_frontRunUsdt0Permit_stillSucceeds() public onlyForked {
        TransferRequest memory r = _request(USDT0, user, merchant, 100e6, 20_000, relay);
        TokenAuth memory auth = _permitFor(userPk, r);
        bytes memory sig = _signTransfer(userPk, r, auth);
        vm.prank(makeAddr("front-runner"));
        IUChildUSDT0(USDT0).permit(user, address(gasless), r.amount + r.fee, r.deadline, auth.v, auth.r, auth.s);

        _submitAndAssert(r, sig, auth);
    }

    function test_T15_frontRunUsdt0MetaTx_stillSucceeds() public onlyForked {
        TransferRequest memory r = _request(USDT0, user, merchant, 100e6, 20_000, relay);
        TokenAuth memory auth = _metaTxFor(userPk, r);
        bytes memory sig = _signTransfer(userPk, r, auth);
        vm.prank(makeAddr("front-runner"));
        IUChildUSDT0(USDT0)
            .executeMetaTransaction(
                user, abi.encodeCall(IERC20.approve, (address(gasless), r.amount + r.fee)), auth.r, auth.s, auth.v
            );
        assertEq(IERC20(USDT0).allowance(user, address(gasless)), r.amount + r.fee, "front-run approval");

        _submitAndAssert(r, sig, auth);
    }

    /// @dev The USDT0 meta-transaction always approves this contract, for exactly amount + fee.
    function test_T15_usdt0MetaTxSpenderIsThisContract() public onlyForked {
        TransferRequest memory r = _request(USDT0, user, merchant, 100e6, 20_000, relay);
        TokenAuth memory auth = _metaTxFor(userPk, r);
        bytes memory sig = _signTransfer(userPk, r, auth);
        vm.recordLogs();
        vm.prank(relay);
        gasless.relayTransfer(r, sig, auth);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length && !found; ++i) {
            if (logs[i].emitter == USDT0 && logs[i].topics[0] == APPROVAL_EVENT) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), user, "owner");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(gasless), "spender");
                assertEq(abi.decode(logs[i].data, (uint256)), r.amount + r.fee, "value");
                found = true;
            }
        }
        assertTrue(found, "meta-tx Approval");
    }

    // --- T16: the USDT0 shared nonce -------------------------------------------------------------

    /// @dev Another permit of the user consumes the shared USDT0 nonce first. The relayed call reverts cleanly
    ///      (intent nonce unused, nothing moved); with a meta-tx at the new token nonce and the intent re-signed over
    ///      it at the same intent nonce, the transfer succeeds.
    function test_T16_usdt0SharedNonceDoS_cleanRevertThenRetry() public onlyForked {
        TransferRequest memory r = _request(USDT0, user, merchant, 100e6, 20_000, relay);
        TokenAuth memory metaTx = _metaTxFor(userPk, r);
        bytes memory sig = _signTransfer(userPk, r, metaTx);

        address dApp = makeAddr("dApp");
        uint256 nonce = IUChildUSDT0(USDT0).getNonce(user);
        TokenAuth memory other =
            _signPermitWithDomain(userPk, _tokenDomain(USDT0), user, dApp, 1e6, nonce, vm.getBlockTimestamp() + 60);
        IUChildUSDT0(USDT0).permit(user, dApp, 1e6, vm.getBlockTimestamp() + 60, other.v, other.r, other.s);

        uint256 balanceBefore = IERC20(USDT0).balanceOf(user);
        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(IGaslessBase.InsufficientAllowance.selector, 0, r.amount + r.fee));
        gasless.relayTransfer(r, sig, metaTx);
        assertEq(IERC20(USDT0).balanceOf(user), balanceBefore, "nothing moved");
        assertEq(gasless.nonces(user), 0, "intent nonce unused");

        TokenAuth memory retry = _metaTxFor(userPk, r);
        _submitAndAssert(r, _signTransfer(userPk, r, retry), retry);
    }

    // --- T17: the USDT0 permit domain ------------------------------------------------------------

    function test_T17_usdt0PermitStandardDomainFails_saltDomainSucceeds() public onlyForked {
        TransferRequest memory r = _request(USDT0, user, merchant, 100e6, 20_000, relay);
        uint256 nonce = IUChildUSDT0(USDT0).getNonce(user);
        bytes32 standardDomain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("USDT0"), keccak256("1"), vm.getChainId(), USDT0));
        TokenAuth memory wrong =
            _signPermitWithDomain(userPk, standardDomain, user, address(gasless), r.amount + r.fee, nonce, r.deadline);
        bytes memory sig = _signTransfer(userPk, r, wrong);

        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(IGaslessBase.InsufficientAllowance.selector, 0, r.amount + r.fee));
        gasless.relayTransfer(r, sig, wrong);

        TokenAuth memory auth = _permitFor(userPk, r);
        _submitAndAssert(r, _signTransfer(userPk, r, auth), auth);
    }

    // --- T24: USDC blacklist and pause, USDT0 blocked list ------------------------------------------

    function test_T24_usdcBlacklistedSender_reverts() public onlyForked {
        TransferRequest memory r = _request(USDC, user, merchant, 100e6, 20_000, relay);
        TokenAuth memory auth = _permitFor(userPk, r);
        bytes memory sig = _signTransfer(userPk, r, auth);
        IFiatTokenV2_2 usdc = IFiatTokenV2_2(USDC);
        vm.prank(usdc.blacklister());
        usdc.blacklist(user);
        vm.prank(relay);
        vm.expectRevert("Blacklistable: account is blacklisted");
        gasless.relayTransfer(r, sig, auth);
    }

    function test_T24_usdcPaused_reverts() public onlyForked {
        TransferRequest memory r = _request(USDC, user, merchant, 100e6, 20_000, relay);
        bytes memory sig = _signTransfer(userPk, r, _noneAuth());
        vm.prank(user);
        IERC20(USDC).approve(address(gasless), r.amount + r.fee);
        IFiatTokenV2_2 usdc = IFiatTokenV2_2(USDC);
        vm.prank(usdc.pauser());
        usdc.pause();
        vm.prank(relay);
        vm.expectRevert("Pausable: paused");
        gasless.relayTransfer(r, sig, _noneAuth());
    }

    function test_T24_usdt0BlockedSender_reverts() public onlyForked {
        TransferRequest memory r = _request(USDT0, user, merchant, 100e6, 20_000, relay);
        TokenAuth memory auth = _metaTxFor(userPk, r);
        bytes memory sig = _signTransfer(userPk, r, auth);
        IUChildUSDT0 usdt0 = IUChildUSDT0(USDT0);
        bytes32 blockRole = usdt0.BLOCK_ROLE();
        vm.prank(usdt0.getRoleMember(bytes32(0), 0));
        usdt0.grantRole(blockRole, address(this));
        usdt0.addToBlockedList(user);
        vm.prank(relay);
        vm.expectRevert("USDT0: from is blocked");
        gasless.relayTransfer(r, sig, auth);
    }

    // --- Helpers ---------------------------------------------------------------------------------

    function _transferAndAssert(address token, AuthMode mode) internal {
        TransferRequest memory r = _request(token, user, merchant, 10e6, 20_000, relay);
        TokenAuth memory auth;
        if (mode == AuthMode.PERMIT) {
            auth = _permitFor(userPk, r);
        } else if (mode == AuthMode.META_TX_APPROVE) {
            auth = _metaTxFor(userPk, r);
        } else {
            vm.prank(user);
            IERC20(token).approve(address(gasless), r.amount + r.fee);
            auth = _noneAuth();
        }
        _submitAndAssert(r, _signTransfer(userPk, r, auth), auth);
    }

    function _submitAndAssert(TransferRequest memory r, bytes memory sig, TokenAuth memory auth) internal {
        IERC20 token = IERC20(r.token);
        uint256 fromBefore = token.balanceOf(r.from);
        uint256 toBefore = token.balanceOf(r.to);
        uint256 relayBefore = token.balanceOf(r.relay);
        uint256 nonceBefore = gasless.nonces(r.from);
        vm.prank(r.relay);
        gasless.relayTransfer(r, sig, auth);
        assertEq(token.balanceOf(r.from), fromBefore - r.amount - r.fee, "from");
        assertEq(token.balanceOf(r.to), toBefore + r.amount, "to");
        assertEq(token.balanceOf(r.relay), relayBefore + r.fee, "relay");
        assertEq(token.balanceOf(address(gasless)), 0, "no custody");
        assertEq(token.allowance(r.from, address(gasless)), 0, "no leftover allowance");
        assertEq(gasless.nonces(r.from), nonceBefore + 1, "nonce used");
    }
}
