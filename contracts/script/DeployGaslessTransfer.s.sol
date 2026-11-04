// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GaslessTransfer} from "../src/GaslessTransfer.sol";
import {TokenInit} from "../src/interfaces/IGaslessBase.sol";
import {DeploymentWriter} from "./DeploymentWriter.sol";

/// @notice Deploys GaslessTransfer on Polygon PoS mainnet (chain 137) for native USDC {permit, allowance} and USDT0
///         {permit, metaTxApprove, allowance}, owned by GASLESS_TRANSFER_OWNER (required), then writes
///         deployments/137.json. Supply your own signer; no deployment keys are distributed with this repository.
///         GASLESS_TRANSFER_OWNER=<owner> forge script script/DeployGaslessTransfer.s.sol --rpc-url polygon --broadcast
///         (plus a signer option)
contract DeployGaslessTransfer is DeploymentWriter {
    uint256 internal constant CHAIN_ID = 137;
    // The Polygon token addresses of docs/STEP-1-GAS-ABSTRACTION.md.
    address internal constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address internal constant USDT0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;

    function run() external returns (GaslessTransfer gasless) {
        require(block.chainid == CHAIN_ID, "DeployGaslessTransfer: Polygon PoS (137) only");
        address owner = _ownerFromEnv();
        _requireTokenDomains(USDC, USDT0);
        TokenInit[] memory tokens = _stablecoinTokens(USDC, USDT0);
        uint256 deployBlock = block.number;

        vm.startBroadcast();
        gasless = new GaslessTransfer(owner, tokens);
        vm.stopBroadcast();

        _writeDeployment(address(gasless), owner, deployBlock, tokens);
    }
}
