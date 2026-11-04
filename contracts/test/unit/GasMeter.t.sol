// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {AuthMode, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {GasMeter, GasProbe} from "../utils/GasMeter.sol";
import {GaslessTestBase} from "../utils/GaslessTestBase.sol";

/// @notice The gas meter, exercised on the mocks: diagnostic numbers for every auth mode, with and without a fee, for a
///         signer's first request (nonce slot 0 -> 1) and a later one (nonce slot already set), plus invalidateNonces.
///         The numbers are for the mocks only and are not Polygon execution bounds.
contract GasMeterTest is GaslessTestBase, GasMeter {
    struct Case {
        GasProbe probe;
        address user;
        address to;
        bytes data;
        string name;
    }

    uint256 internal constant FEE = 50_000;

    Case[] internal cases;

    /// @dev Everything is prepared here, in its own transaction, so the measured calls start from clean storage
    ///      (see GasMeter). Worst case on the token side: fresh sender (token nonce 0), fresh recipient, relay without
    ///      a balance. "first" signs at intent nonce 0, "later" at nonce 1 (raised in setUp, so the slot is not 0).
    function setUp() public override {
        super.setUp();
        address[5] memory tokens = [address(usdc), address(usdc), address(usdt0), address(usdt0), address(usdt0)];
        AuthMode[5] memory modes =
            [AuthMode.PERMIT, AuthMode.NONE, AuthMode.PERMIT, AuthMode.META_TX_APPROVE, AuthMode.NONE];
        string[5] memory names = ["usdc permit", "usdc none", "usdt0 permit", "usdt0 metaTxApprove", "usdt0 none"];
        for (uint256 i = 0; i < modes.length; ++i) {
            _prepare(tokens[i], modes[i], FEE, false, string.concat(names[i], ", fee, first"));
            _prepare(tokens[i], modes[i], 0, false, string.concat(names[i], ", no fee, first"));
            _prepare(tokens[i], modes[i], FEE, true, string.concat(names[i], ", fee, later"));
            _prepare(tokens[i], modes[i], 0, true, string.concat(names[i], ", no fee, later"));
        }
        GasProbe probe = new GasProbe();
        cases.push(
            Case({
                probe: probe,
                user: address(probe),
                to: address(0),
                data: abi.encodeCall(gasless.invalidateNonces, (1)),
                name: "invalidateNonces, first"
            })
        );
        probe = new GasProbe();
        vm.prank(address(probe));
        gasless.invalidateNonces(1);
        cases.push(
            Case({
                probe: probe,
                user: address(probe),
                to: address(0),
                data: abi.encodeCall(gasless.invalidateNonces, (6)),
                name: "invalidateNonces, later (5 nonces)"
            })
        );
    }

    function test_gasMeter_mocks_perAuthMode() public {
        uint256[] memory gas = new uint256[](cases.length);
        for (uint256 i = 0; i < cases.length; ++i) {
            (gas[i],) = _measureTxGas(cases[i].probe, address(gasless), cases[i].data);
            console2.log(string.concat("mock tx gas, ", cases[i].name), gas[i], cases[i].data.length);
        }
        // Index: 4 * mode + {fee first, no fee first, fee later, no fee later}.
        // Intrinsic gas plus at least three fresh storage writes (recipient, relay, nonce); far below a block.
        assertGt(gas[4], 21_000 + 3 * 20_000, "usdc none, fee, first");
        assertGt(gas[0], gas[4], "USDC permit costs more than none");
        assertGt(gas[12], gas[16], "USDT0 meta-tx costs more than none");
        assertLt(gas[12], 300_000, "upper bound");
        for (uint256 m = 0; m < 5; ++m) {
            assertLt(gas[4 * m + 1], gas[4 * m], "no fee costs less");
            // A later request writes a non-zero nonce slot instead of a zero one.
            assertGt(gas[4 * m] - gas[4 * m + 2], 15_000, "later request is cheaper");
        }
    }

    /// @dev Reading the touched accounts and slots first (warming them) must not change the result.
    function test_gasMeter_measuresColdState() public {
        Case memory c = cases[12]; // usdt0 metaTxApprove, fee, first
        uint256 snapshot = vm.snapshotState();
        (uint256 clean,) = _measureTxGas(c.probe, address(gasless), c.data);
        vm.revertToState(snapshot);

        usdt0.balanceOf(c.to);
        usdt0.balanceOf(c.user);
        usdt0.nonces(c.user);
        usdt0.allowance(c.user, address(gasless));
        gasless.nonces(c.user);
        (uint256 prewarmed,) = _measureTxGas(c.probe, address(gasless), c.data);
        assertEq(prewarmed, clean, "cold-state measurement");
    }

    function test_gasMeter_calldataGas() public pure {
        assertEq(_calldataGas(hex"00ff0001"), 4 + 16 + 4 + 16);
    }

    function _prepare(address token, AuthMode mode, uint256 fee, bool later, string memory name) internal {
        string memory label = vm.toString(cases.length);
        (address user, uint256 pk) = makeAddrAndKey(string.concat("gas-user-", label));
        usdc.mint(user, 1000e6);
        usdt0.mint(user, 1000e6);
        if (later) {
            vm.prank(user);
            gasless.invalidateNonces(1);
        }
        TransferRequest memory r = _request(token, 100e6, fee);
        r.from = user;
        r.to = makeAddr(string.concat("gas-recipient-", label));
        GasProbe probe = new GasProbe(); // the relay: msg.sender of the measured call, no token balance
        r.relay = address(probe);
        TokenAuth memory auth = _authFor(pk, r, mode);
        bytes memory data = abi.encodeCall(gasless.relayTransfer, (r, _signTransfer(pk, r, auth), auth));
        cases.push(Case({probe: probe, user: user, to: r.to, data: data, name: name}));
    }
}
