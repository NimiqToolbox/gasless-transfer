// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {DeployAmoyDryRun} from "../../script/DeployAmoyDryRun.s.sol";
import {DeployGaslessTransfer} from "../../script/DeployGaslessTransfer.s.sol";
import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {TokenConfig} from "../../src/interfaces/IGaslessBase.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockUSDT0} from "../mocks/MockUSDT0.sol";
import {TestnetPriceFeed} from "../mocks/TestnetPriceFeed.sol";

contract TestDeployGaslessTransfer is DeployGaslessTransfer {
    function _deploymentsDir() internal pure override returns (string memory) {
        return "deployments/test/mainnet";
    }
}

/// @dev One directory per test: tests run in parallel and would otherwise read each other's record.
contract TestDeployAmoyDryRun is DeployAmoyDryRun {
    string internal dir;

    constructor(string memory dir_) {
        dir = dir_;
    }

    function _deploymentsDir() internal view override returns (string memory) {
        return dir;
    }
}

/// @notice The deploy scripts: owner, per-token configuration and the v3 record (format: script/DeploymentWriter.sol).
///         Records are written under deployments/test/, never over a committed one.
contract DeployScriptsTest is Test {
    address internal constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address internal constant USDT0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;

    /// @dev The only test that sets GASLESS_TRANSFER_OWNER, so parallel tests do not race on it.
    function test_mainnetScript_ownerFromEnvWithoutDefault_writesV3Record() public {
        vm.chainId(137);
        deployCodeTo("test/mocks/MockUSDC.sol:MockUSDC", USDC);
        deployCodeTo("test/mocks/MockUSDT0.sol:MockUSDT0", USDT0);
        TestDeployGaslessTransfer script = new TestDeployGaslessTransfer();

        vm.setEnv("GASLESS_TRANSFER_OWNER", "");
        vm.expectRevert();
        script.run();
        vm.setEnv("GASLESS_TRANSFER_OWNER", vm.toString(address(0)));
        vm.expectRevert(bytes("GASLESS_TRANSFER_OWNER: the zero address"));
        script.run();
        // The owner is set in one step, so only the checksummed form passes: anvil #0 with the case of one
        // letter flipped (a broken checksum), and all lowercase.
        string[2] memory notChecksummed =
            ["0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"];
        for (uint256 i = 0; i < notChecksummed.length; ++i) {
            vm.setEnv("GASLESS_TRANSFER_OWNER", notChecksummed[i]);
            vm.expectRevert(bytes("GASLESS_TRANSFER_OWNER: not an EIP-55 checksummed address"));
            script.run();
        }

        address owner = makeAddr("owner");
        vm.setEnv("GASLESS_TRANSFER_OWNER", vm.toString(owner));
        GaslessTransfer gasless = script.run();
        assertEq(gasless.owner(), owner, "owner");
        _assertConfig(gasless, USDC, false);
        _assertConfig(gasless, USDT0, true);
        _assertRecord(vm.readFile("deployments/test/mainnet/137.json"), gasless, owner, USDC, USDT0);
    }

    function test_mainnetScript_refusesOtherChains() public {
        vm.chainId(80_002);
        TestDeployGaslessTransfer script = new TestDeployGaslessTransfer();
        vm.expectRevert(bytes("DeployGaslessTransfer: Polygon PoS (137) only"));
        script.run();
    }

    function test_amoyScript_withMocks_writesV3Record() public {
        vm.chainId(80_002);
        TestDeployAmoyDryRun script = new TestDeployAmoyDryRun("deployments/test/amoy");
        address owner = makeAddr("amoy-owner");
        (GaslessTransfer gasless, address usdc, address usdt0, address feed) =
            script.deploy(address(0), address(0), owner);
        assertEq(gasless.owner(), owner, "owner");
        _assertConfig(gasless, usdc, false);
        _assertConfig(gasless, usdt0, true);
        string memory json = vm.readFile("deployments/test/amoy/80002.json");
        _assertRecord(json, gasless, owner, usdc, usdt0);
        assertEq(vm.parseJsonString(json, ".tokens[0].domain.name"), "USD Coin", "the mock's domain name");
        assertEq(MockUSDC(usdc).balanceOf(MockUSDC(usdc).admin()), 1_000_000e6, "mock USDC test balance");
        assertEq(MockUSDT0(usdt0).balanceOf(MockUSDT0(usdt0).admin()), 1_000_000e6, "mock USDT0 test balance");
        _assertFeed(feed, "deployments/test/amoy/80002.feed");
    }

    /// @dev Circle's Amoy USDC: an existing FiatToken whose name() and EIP-712 name are "USDC"; USDT0 is a mock.
    function test_amoyScript_existingUsdcAndMockUsdt0_writesTheTokensDomain() public {
        vm.chainId(80_002);
        address usdc = address(new MockUSDC());
        vm.mockCall(usdc, abi.encodeWithSignature("name()"), abi.encode("USDC"));
        vm.mockCall(usdc, abi.encodeWithSignature("DOMAIN_SEPARATOR()"), abi.encode(_fiatTokenDomain("USDC", usdc)));
        TestDeployAmoyDryRun script = new TestDeployAmoyDryRun("deployments/test/amoy-usdc");
        address owner = makeAddr("amoy-owner");
        (GaslessTransfer gasless, address usdcOut, address usdt0, address feed) = script.deploy(usdc, address(0), owner);
        assertEq(usdcOut, usdc, "the existing USDC");
        assertEq(MockUSDC(usdc).totalSupply(), 0, "nothing minted on the existing USDC");
        _assertConfig(gasless, usdc, false);
        _assertConfig(gasless, usdt0, true);
        string memory json = vm.readFile("deployments/test/amoy-usdc/80002.json");
        _assertRecord(json, gasless, owner, usdc, usdt0);
        assertEq(vm.parseJsonString(json, ".tokens[0].domain.name"), "USDC", "the token's domain name");
        assertEq(MockUSDT0(usdt0).balanceOf(MockUSDT0(usdt0).admin()), 1_000_000e6, "mock USDT0 test balance");
        _assertFeed(feed, "deployments/test/amoy-usdc/80002.feed");
    }

    function test_amoyScript_refusesUsdcWhoseDomainIsNotItsName() public {
        vm.chainId(80_002);
        address usdc = address(new MockUSDC());
        vm.mockCall(usdc, abi.encodeWithSignature("name()"), abi.encode("USDC"));
        TestDeployAmoyDryRun script = new TestDeployAmoyDryRun("deployments/test/amoy-mismatch");
        vm.expectRevert(bytes("USDC domain mismatch"));
        script.deploy(usdc, address(0), makeAddr("amoy-owner"));
    }

    /// @dev The file names the feed, and its round is the current block at any time.
    function _assertFeed(address feed, string memory path) private {
        assertEq(vm.parseAddress(vm.readFile(path)), feed, "feed file");
        vm.warp(block.timestamp + 2 days);
        (, int256 answer,, uint256 updatedAt,) = TestnetPriceFeed(feed).latestRoundData();
        assertEq(answer, 20_000_000, "answer");
        assertEq(updatedAt, block.timestamp, "updatedAt");
        assertEq(TestnetPriceFeed(feed).decimals(), 8, "decimals");
    }

    function _fiatTokenDomain(string memory name, address token) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("2"),
                block.chainid,
                token
            )
        );
    }

    function _assertConfig(GaslessTransfer gasless, address token, bool metaTx) private view {
        TokenConfig memory c = gasless.tokenConfig(token);
        assertTrue(c.permit && c.allowance, "permit, none");
        assertEq(c.metaTxApprove, metaTx, "metaTxApprove");
    }

    function _assertRecord(string memory json, GaslessTransfer gasless, address owner, address usdc, address usdt0)
        private
        view
    {
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid, "chainId");
        assertEq(vm.parseJsonString(json, ".version"), "3", "version");
        (,, string memory domainVersion,,,,) = gasless.eip712Domain();
        assertEq(vm.parseJsonString(json, ".version"), domainVersion, "version: the contract's EIP-712 domain version");
        assertEq(vm.parseJsonAddress(json, ".gaslessTransfer"), address(gasless), "gaslessTransfer");
        assertEq(vm.parseJsonAddress(json, ".initialOwner"), owner, "initialOwner");
        assertEq(vm.parseJsonString(json, ".deployBlock"), vm.toString(block.number), "deployBlock");
        assertFalse(vm.keyExistsJson(json, ".maxFee"), "no maxFee");

        assertEq(vm.parseJsonString(json, ".tokens[0].symbol"), "USDC");
        assertEq(vm.parseJsonAddress(json, ".tokens[0].address"), usdc);
        assertFalse(vm.keyExistsJson(json, ".tokens[0].maxFee"), "no token maxFee");
        string[] memory modes = vm.parseJsonStringArray(json, ".tokens[0].authModes");
        assertEq(modes.length, 2);
        assertEq(modes[0], "permit");
        assertEq(modes[1], "none");
        assertEq(vm.parseJsonAddress(json, ".tokens[0].domain.verifyingContract"), usdc);

        assertEq(vm.parseJsonString(json, ".tokens[1].symbol"), "USDT0");
        assertEq(vm.parseJsonAddress(json, ".tokens[1].address"), usdt0);
        assertFalse(vm.keyExistsJson(json, ".tokens[1].maxFee"), "no token maxFee");
        modes = vm.parseJsonStringArray(json, ".tokens[1].authModes");
        assertEq(modes.length, 3);
        assertEq(modes[0], "permit");
        assertEq(modes[1], "metaTxApprove");
        assertEq(modes[2], "none");
        assertEq(vm.parseJsonBytes32(json, ".tokens[1].domain.salt"), bytes32(block.chainid));
    }
}
