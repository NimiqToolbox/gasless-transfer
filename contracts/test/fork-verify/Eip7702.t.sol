// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AuthMode, IGaslessBase, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {VerForkBase} from "./VerForkBase.sol";

/// @notice A 7702 delegate without ERC-1271 (e.g. a plain batch executor).
contract VfBatchDelegate {
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(this), "only self");
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "call failed");
        return ret;
    }
}

/// @notice A 7702 smart-account delegate with the usual ERC-1271: ECDSA by the EOA's own key.
contract VfEcdsa1271Delegate {
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s) == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @notice A (buggy or malicious) delegate that accepts any signature.
contract VfAcceptAllDelegate {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// @notice Delegated-account token authorization against real USDC and USDT0 at block 94,421,000.
///         USDC uses delegate ERC-1271 checks; USDT0 uses ecrecover. Tests use the Prague EVM rules.
contract Eip7702Test is VerForkBase {
    address internal user;
    uint256 internal userPk;
    address internal merchant;

    modifier prague() {
        vm.setEvmVersion("prague");
        _;
    }

    function setUp() public {
        enabled = _setUpFork(RECENT_BLOCK);
        if (!enabled) return;
        vm.setEvmVersion("prague");
        (user, userPk) = makeAddrAndKey("verfork-7702-user");
        merchant = makeAddr("verfork-7702-merchant");
        _mint(USDC, user, 1000e6);
        _mint(USDT0, user, 1000e6);
    }

    function _delegate(address delegate) internal {
        vm.etch(user, abi.encodePacked(hex"ef0100", delegate));
        assertEq(user.code.length, 23, "delegation designator");
    }

    /// @dev A delegate without ERC-1271: the real USDC rejects the (valid ECDSA) permit, the contract's allowance
    ///      check reverts, nothing moves and the permit nonce is not consumed.
    function test_usdcPermit_delegateWithout1271_failsClosed() public onlyEnabled prague {
        _delegate(address(new VfBatchDelegate()));
        TransferRequest memory r = _request(USDC, user, merchant, 10e6, 20_000);
        Snapshot memory s = _snap(r);
        TokenAuth memory auth = _tokenAuth(userPk, r, AuthMode.PERMIT);
        _relayExpectRevert(
            r,
            _signTransfer(userPk, r, auth),
            auth,
            abi.encodeWithSelector(IGaslessBase.InsufficientAllowance.selector, 0, r.amount + r.fee)
        );
        _assertUntouched(r, s);
    }

    /// @dev With the common smart-account delegate (ERC-1271 = ECDSA by the EOA key) the same permit is accepted
    ///      by USDC: failing closed is a property of the delegate, not of the token (§5). Either outcome is safe
    ///      for the user, because the intent is still ECDSA-verified by the contract.
    function test_usdcPermit_ecdsa1271Delegate_succeeds() public onlyEnabled prague {
        _delegate(address(new VfEcdsa1271Delegate()));
        TransferRequest memory r = _request(USDC, user, merchant, 10e6, 20_000);
        Snapshot memory s = _snap(r);
        TokenAuth memory auth = _tokenAuth(userPk, r, AuthMode.PERMIT);
        _relay(r, _signTransfer(userPk, r, auth), auth);
        _assertTransferred(r, s);
    }

    /// @dev A delegate that accepts anything makes any USDC permit of this account valid, but P1 still holds: the
    ///      intent must be an ECDSA signature of the EOA key (no ERC-1271 in the contract).
    function test_acceptAllDelegate_intentStillNeedsEcdsa() public onlyEnabled prague {
        _delegate(address(new VfAcceptAllDelegate()));
        address attacker = makeAddr("verfork-7702-attacker");
        TransferRequest memory r = _request(USDC, user, attacker, 900e6, 0);
        r.relay = attacker;
        TokenAuth memory garbagePermit =
            TokenAuth({mode: AuthMode.PERMIT, v: 27, r: bytes32(uint256(1)), s: bytes32(uint256(2))});
        Snapshot memory s = _snap(r);
        bytes[3] memory sigs =
            [bytes(""), abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27)), new bytes(65)];
        for (uint256 i = 0; i < sigs.length; ++i) {
            vm.prank(attacker, attacker);
            vm.expectRevert(IGaslessBase.InvalidSignature.selector);
            gasless.relayTransfer(r, sigs[i], garbagePermit);
        }
        assertEq(IERC20(USDC).balanceOf(user), s.from, "nothing moved");
    }

    function test_noneMode_worksFor7702Sender() public onlyEnabled prague {
        _delegate(address(new VfBatchDelegate()));
        address[2] memory tokens = [USDC, USDT0];
        for (uint256 i = 0; i < 2; ++i) {
            TransferRequest memory r = _request(tokens[i], user, merchant, 10e6, 20_000);
            vm.prank(user);
            IERC20(tokens[i]).approve(address(gasless), r.amount + r.fee);
            Snapshot memory s = _snap(r);
            _relay(r, _signTransfer(userPk, r, _noAuth()), _noAuth());
            _assertTransferred(r, s);
        }
    }

    /// @dev USDT0 verifies permits and meta-transactions with ecrecover: 7702 senders work in both modes.
    function test_usdt0PermitAndMetaTx_workFor7702Sender() public onlyEnabled prague {
        _delegate(address(new VfBatchDelegate()));
        AuthMode[2] memory modes = [AuthMode.PERMIT, AuthMode.META_TX_APPROVE];
        for (uint256 i = 0; i < 2; ++i) {
            TransferRequest memory r = _request(USDT0, user, merchant, 10e6, 20_000);
            Snapshot memory s = _snap(r);
            TokenAuth memory auth = _tokenAuth(userPk, r, modes[i]);
            _relay(r, _signTransfer(userPk, r, auth), auth);
            _assertTransferred(r, s);
        }
    }
}
