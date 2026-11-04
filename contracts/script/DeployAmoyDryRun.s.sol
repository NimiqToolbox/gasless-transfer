// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {GaslessTransfer} from "../src/GaslessTransfer.sol";
import {TokenInit} from "../src/interfaces/IGaslessBase.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {MockUSDT0} from "../test/mocks/MockUSDT0.sol";
import {TestnetPriceFeed} from "../test/mocks/TestnetPriceFeed.sol";
import {DeploymentWriter} from "./DeploymentWriter.sol";

/// @notice The Amoy (chain 80002) test deployment: GaslessTransfer with the mainnet configuration (USDC {permit,
///         allowance}, USDT0 {permit, metaTxApprove, allowance}) owned by GASLESS_TRANSFER_OWNER (required), then
///         deployments/80002.json, which is committed like the mainnet record. Each token is one of:
///         - With AMOY_USDC or AMOY_USDT0, an existing token contract on Amoy (Circle's testnet USDC for AMOY_USDC).
///           As on mainnet, the script refuses a token whose DOMAIN_SEPARATOR() is not the domain written to the file:
///           (name(), "2", 80002, token) for USDC and ("USDT0", "1", token, salt 80002) for USDT0.
///         - Without it, MockUSDC or MockUSDT0 (test/mocks). They reproduce FiatTokenV2_2 and UChildUSDT0, including
///           their EIP-712 domains, permit and meta-transaction. The broadcaster becomes the mock's admin and receives
///           1,000,000.
///         The script also deploys TestnetPriceFeed, a fixed-price POL/USD test feed, and writes its address to
///         deployments/80002.feed.
///         GASLESS_TRANSFER_OWNER=<owner> forge script script/DeployAmoyDryRun.s.sol --rpc-url <Amoy RPC> --broadcast
///         (plus a signer option)
contract DeployAmoyDryRun is DeploymentWriter {
    uint256 internal constant CHAIN_ID = 80_002;
    uint256 internal constant TEST_BALANCE = 1_000_000e6;

    function run() external returns (GaslessTransfer gasless, address usdc, address usdt0, address feed) {
        return deploy(vm.envOr("AMOY_USDC", address(0)), vm.envOr("AMOY_USDT0", address(0)), _ownerFromEnv());
    }

    /// @notice Deploys with the given tokens; a zero address deploys a mock token in its place.
    function deploy(address usdc, address usdt0, address owner)
        public
        returns (GaslessTransfer gasless, address, address, address)
    {
        require(block.chainid == CHAIN_ID, "DeployAmoyDryRun: Amoy (80002) only");
        if (usdc != address(0)) _requireUsdcDomain(usdc);
        if (usdt0 != address(0)) _requireUsdt0Domain(usdt0);
        uint256 deployBlock = block.number;

        vm.startBroadcast();
        if (usdc == address(0)) {
            MockUSDC mockUsdc = new MockUSDC();
            mockUsdc.mint(mockUsdc.admin(), TEST_BALANCE);
            usdc = address(mockUsdc);
        }
        if (usdt0 == address(0)) {
            MockUSDT0 mockUsdt0 = new MockUSDT0();
            mockUsdt0.mint(mockUsdt0.admin(), TEST_BALANCE);
            usdt0 = address(mockUsdt0);
        }
        TestnetPriceFeed feed = new TestnetPriceFeed();
        TokenInit[] memory tokens = _stablecoinTokens(usdc, usdt0);
        gasless = new GaslessTransfer(owner, tokens);
        vm.stopBroadcast();

        _requireTokenDomains(usdc, usdt0);
        _writeDeployment(address(gasless), owner, deployBlock, tokens);
        vm.writeFile(string.concat(_deploymentsDir(), "/80002.feed"), vm.toString(address(feed)));
        return (gasless, usdc, usdt0, address(feed));
    }

    /// @dev Circle's Amoy USDC is "USDC", the mock is "USD Coin"; FiatToken signs with its name().
    function _usdcDomainName(address usdc) internal view override returns (string memory) {
        return IERC20Metadata(usdc).name();
    }
}
