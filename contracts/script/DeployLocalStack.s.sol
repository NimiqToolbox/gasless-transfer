// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GaslessTransfer} from "../src/GaslessTransfer.sol";
import {TokenInit} from "../src/interfaces/IGaslessBase.sol";
import {MockPriceFeed} from "../test/mocks/MockPriceFeed.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {MockUSDT0} from "../test/mocks/MockUSDT0.sol";
import {DeploymentWriter} from "./DeploymentWriter.sol";

/// @notice Local stack for a plain anvil (chain 31337): MockUSDC, MockUSDT0 and a GaslessTransfer configured like on
///         mainnet and owned by anvil account 0, 1,000,000 of each token for the first ten anvil accounts, and
///         deployments/31337.json. The broadcaster becomes the mocks' admin (mint, blacklist/pause, blocked list).
///         With anvil's default account 0 (well-known test key, unlocked in anvil):
///         forge script script/DeployLocalStack.s.sol --rpc-url http://<anvil>:8545 --broadcast \
///             --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
contract DeployLocalStack is DeploymentWriter {
    uint256 internal constant CHAIN_ID = 31_337;
    uint256 internal constant TEST_BALANCE = 1_000_000e6;

    function run() external returns (GaslessTransfer gasless, MockUSDC usdc, MockUSDT0 usdt0) {
        require(block.chainid == CHAIN_ID, "DeployLocalStack: local anvil (31337) only");
        uint256 deployBlock = block.number;
        address[10] memory accounts = anvilAccounts();

        vm.startBroadcast();
        usdc = new MockUSDC();
        usdt0 = new MockUSDT0();
        TokenInit[] memory tokens = _stablecoinTokens(address(usdc), address(usdt0));
        gasless = new GaslessTransfer(accounts[0], tokens);
        for (uint256 i = 0; i < accounts.length; ++i) {
            usdc.mint(accounts[i], TEST_BALANCE);
            usdt0.mint(accounts[i], TEST_BALANCE);
        }
        MockPriceFeed feed = new MockPriceFeed();
        vm.stopBroadcast();

        _requireTokenDomains(address(usdc), address(usdt0));
        _writeDeployment(address(gasless), accounts[0], deployBlock, tokens);
        vm.writeFile("deployments/31337.feed", vm.toString(address(feed)));
    }

    /// @notice The first ten accounts of anvil's default mnemonic "test test test test test test test test test test
    ///         test junk".
    function anvilAccounts() public pure returns (address[10] memory) {
        return [
            0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
            0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
            0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,
            0x976EA74026E726554dB657fA54763abd0C3a0aa9,
            0x14dC79964da2C08b23698B3D3cc7Ca32193d9955,
            0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f,
            0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
        ];
    }
}
