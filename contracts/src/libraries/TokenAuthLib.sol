// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {AuthMode, IGaslessBase, TokenAuth} from "../interfaces/IGaslessBase.sol";
import {INativeMetaTransaction} from "../interfaces/INativeMetaTransaction.sol";

/// @notice Obtains the token allowance for a request from the owner's own token signature
///         (docs/STEP-1-GAS-ABSTRACTION.md §4.1, §5).
library TokenAuthLib {
    /// @notice Ensures that this contract may pull `required` from `owner`, and reverts
    ///         InsufficientAllowance(allowance, required) otherwise:
    ///         - PERMIT and META_TX_APPROVE: allowance(owner, this) must be exactly `required`, the value that the
    ///           owner's token signature sets. A larger allowance reverts too.
    ///         - NONE: allowance(owner, this) must be at least `required`, granted by the owner beforehand.
    /// @dev Callers must pull exactly `required` from `owner` after this call (GaslessTransfer._collect: fee + amount),
    ///      and must have verified that `owner` signed `auth` with the request (GaslessTransfer signs it into the
    ///      intent).
    ///
    ///      The token call: spender (this contract), value (`required`) and permit deadline are set here, never taken
    ///      from the caller. Anyone can submit the same permit or meta-transaction to the token first (front-running).
    ///      Our token call then fails, but the allowance it would have set, exactly `required`, is already in place.
    ///      That is why the token call is wrapped in try/catch, its outcome is ignored, and only the allowance read
    ///      afterwards decides. Neither revert data nor return data of the token call is copied or decoded (neither
    ///      interface declares a return value; VER-SOL-5).
    ///
    ///      The allowance check: in PERMIT and META_TX_APPROVE mode it is for equality, so a standing allowance of any
    ///      other value is never spent in place of a missing, invalid or mismatching token signature (T18), and a token
    ///      whose TokenConfig.allowance is false is never pulled through one. The caller's transfers then lower the
    ///      allowance by exactly `required`, so none is left after the call (TI5). An allowance of exactly `required`
    ///      that the owner granted directly cannot be told apart from a front-run token signature; it is accepted and
    ///      used up in the same way. The check runs before the transfers (not as "allowance == 0" after them), so a
    ///      refused call moves nothing and the whole rule stays in this library. Apart from that exact value, only
    ///      NONE mode spends a standing allowance, and it leaves the rest of it (TI5 does not cover NONE).
    /// @param token The token to obtain the allowance for.
    /// @param owner The sender of the request, whose tokens the caller pulls.
    /// @param required The allowance the request needs: its amount plus its fee. The token call sets exactly this
    ///        value.
    /// @param deadline The request deadline. PERMIT mode uses it as the permit deadline.
    /// @param auth The token authorization signed into the request: the mode and, for PERMIT and META_TX_APPROVE, the
    ///        owner's token signature (v, r, s).
    function ensureAllowance(address token, address owner, uint256 required, uint256 deadline, TokenAuth calldata auth)
        internal
    {
        if (auth.mode == AuthMode.PERMIT) {
            try IERC20Permit(token).permit(owner, address(this), required, deadline, auth.v, auth.r, auth.s) {} catch {}
        } else if (auth.mode == AuthMode.META_TX_APPROVE) {
            bytes memory approveCall = abi.encodeCall(IERC20.approve, (address(this), required));
            try INativeMetaTransaction(token).executeMetaTransaction(owner, approveCall, auth.r, auth.s, auth.v) {}
                catch {}
        }
        // AuthMode.NONE: no token call; the owner approved this contract beforehand.

        uint256 current = IERC20(token).allowance(owner, address(this));
        if (auth.mode == AuthMode.NONE ? current < required : current != required) {
            revert IGaslessBase.InsufficientAllowance(current, required);
        }
    }
}
