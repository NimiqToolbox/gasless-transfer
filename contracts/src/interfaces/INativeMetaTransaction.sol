// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Meta-transaction entry point of Polygon's NativeMetaTransaction, as implemented by USDT0 (UChildUSDT0
///         0x9004…4229 behind 0xc213…8e8F). The token checks `MetaTransaction(uint256 nonce,address from,bytes
///         functionSignature)` signed by `userAddress` (nonce shared with its permit), then calls itself with
///         `functionSignature ++ userAddress`, so the inner call runs with `userAddress` as the sender.
/// @dev The token's function returns `bytes` (the inner call's return data). It is declared here without a return
///      value on purpose (VER-SOL-5): TokenAuthLib ignores the outcome of this call and lets only the allowance read
///      afterwards decide, so the success data must be neither copied nor ABI-decoded (a decoding failure would not be
///      caught by the try/catch). The selector does not depend on the return type.
interface INativeMetaTransaction {
    function executeMetaTransaction(
        address userAddress,
        bytes calldata functionSignature,
        bytes32 sigR,
        bytes32 sigS,
        uint8 sigV
    ) external payable;
}
