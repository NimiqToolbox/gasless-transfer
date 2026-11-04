// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Stands in for the relay account: it is msg.sender of the measured call and measures it from its own,
///         fresh call frame (so the test contract's memory use does not leak into the number).
contract GasProbe {
    function measure(address target, bytes calldata data) external returns (uint256 gasUsed, bool success) {
        uint256 gasBefore = gasleft();
        (success,) = target.call(data);
        gasUsed = gasBefore - gasleft();
    }
}

/// @notice Diagnostic transaction gas under the local EVM schedule, not a Polygon execution bound.
///         A test runs inside one long transaction, so accounts and storage slots touched earlier are warm there
///         but cold in a real relay transaction. The meter therefore dry-runs the call once to learn every account
///         it touches, rolls back, marks all of them (and their storage) cold, and measures again. Only the target
///         itself is re-warmed, because it is the transaction's `to`. The result is
///         21000 + calldata gas (4 per zero byte, 16 per non-zero byte) + execution gas before refunds,
///         which pays one extra CALL and ignores refunds, but does not account for Polygon's gas repricing.
///         The request must name the probe as its relay. Callers must prepare balances, approvals and signatures in
///         setUp(): a storage slot written earlier in the same test transaction is "dirty" and a later SSTORE to it
///         is priced lower (EIP-2200) than in a real relay transaction; vm.cool() resets warmth, not that.
abstract contract GasMeter is CommonBase {
    function _measureTxGas(GasProbe probe, address target, bytes memory data)
        internal
        returns (uint256 txGas, uint256 executionGas)
    {
        uint256 snapshot = vm.snapshotState();
        vm.startStateDiffRecording();
        (, bool success) = probe.measure(target, data);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        require(success, "GasMeter: dry run failed");
        vm.revertToState(snapshot);

        for (uint256 i = 0; i < accesses.length; ++i) {
            address account = accesses[i].account;
            // Precompiles are always warm; the cheatcode account is not part of a real transaction.
            if (uint160(account) > 0x100 && account != address(vm)) vm.cool(account);
        }
        vm.cool(target);
        // The transaction's `to` is warm from the start (its storage is not).
        uint256 warm = target.balance;
        warm;

        (executionGas, success) = probe.measure(target, data);
        require(success, "GasMeter: measured call failed");
        txGas = 21_000 + _calldataGas(data) + executionGas;
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i = 0; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }
}
