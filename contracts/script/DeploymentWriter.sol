// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Script} from "forge-std/Script.sol";

import {TokenConfig, TokenInit} from "../src/interfaces/IGaslessBase.sol";

/// @notice Shared token configuration and the deployments/<chainId>.json writer of the deploy scripts. Off-chain
///         clients read that file; its format is fixed:
///         {"chainId":137,"version":"3","gaslessTransfer":"0x…","initialOwner":"0x…","deployBlock":"<decimal>",
///          "tokens":[
///           {"symbol":"USDC","address":"0x…","decimals":6,"authModes":["permit","none"],
///            "domain":{"name":"USD Coin","version":"2","chainId":137,"verifyingContract":"0x…"}},
///           {"symbol":"USDT0","address":"0x…","decimals":6,"authModes":["permit","metaTxApprove","none"],
///            "domain":{"name":"USDT0","version":"1","verifyingContract":"0x…","salt":"0x<bytes32(chainId)>"}}]}
///         `version` is the contract's EIP-712 domain version; readers reject a record without "3". Addresses are
///         checksummed. `deployBlock` is the block number the script saw before broadcasting, so it is a lower bound
///         of the actual deployment block. Token entries are the constructor's configuration; the owner may change it
///         later (TokenConfigSet), so `tokenConfig(token)` on-chain is authoritative.
abstract contract DeploymentWriter is Script {
    string internal constant USDC_DOMAIN_NAME = "USD Coin";
    string internal constant USDC_DOMAIN_VERSION = "2";
    string internal constant USDT0_DOMAIN_NAME = "USDT0";
    string internal constant USDT0_DOMAIN_VERSION = "1";

    /// @dev USDC {PERMIT, NONE}; USDT0 {PERMIT, META_TX_APPROVE, NONE} (D4, §11).
    function _stablecoinTokens(address usdc, address usdt0) internal pure returns (TokenInit[] memory tokens) {
        tokens = new TokenInit[](2);
        tokens[0] = TokenInit({token: usdc, config: TokenConfig({permit: true, metaTxApprove: false, allowance: true})});
        tokens[1] = TokenInit({token: usdt0, config: TokenConfig({permit: true, metaTxApprove: true, allowance: true})});
    }

    /// @dev The initial owner (Ownable2Step) from GASLESS_TRANSFER_OWNER; there is no default. The constructor sets it in
    ///      one step, so a mistyped owner would be permanent: only the EIP-55 checksummed form is accepted.
    function _ownerFromEnv() internal view returns (address owner) {
        string memory value = vm.envString("GASLESS_TRANSFER_OWNER");
        owner = vm.parseAddress(value);
        require(owner != address(0), "GASLESS_TRANSFER_OWNER: the zero address");
        require(
            keccak256(bytes(value)) == keccak256(bytes(vm.toString(owner))),
            "GASLESS_TRANSFER_OWNER: not an EIP-55 checksummed address"
        );
    }

    /// @dev Refuses to write a file whose token domains differ from the tokens' on-chain DOMAIN_SEPARATOR().
    function _requireTokenDomains(address usdc, address usdt0) internal view {
        _requireUsdcDomain(usdc);
        _requireUsdt0Domain(usdt0);
    }

    function _requireUsdcDomain(address usdc) internal view {
        require(IERC20Permit(usdc).DOMAIN_SEPARATOR() == _usdcDomainSeparator(usdc), "USDC domain mismatch");
    }

    function _requireUsdt0Domain(address usdt0) internal view {
        require(IERC20Permit(usdt0).DOMAIN_SEPARATOR() == _usdt0DomainSeparator(usdt0), "USDT0 domain mismatch");
    }

    /// @dev The EIP-712 domain name of the USDC token: Polygon's native USDC is "USD Coin". A testnet USDC may differ
    ///      (Circle's on Amoy is "USDC"); _requireUsdcDomain still checks the whole domain against the token.
    function _usdcDomainName(address) internal view virtual returns (string memory) {
        return USDC_DOMAIN_NAME;
    }

    /// @dev Writes <_deploymentsDir()>/<block.chainid>.json (relative to contracts/) and returns its path.
    function _writeDeployment(
        address gaslessTransfer,
        address initialOwner,
        uint256 deployBlock,
        TokenInit[] memory tokens
    ) internal returns (string memory path) {
        string memory json = _deploymentJson(gaslessTransfer, initialOwner, deployBlock, tokens);
        string memory dir = _deploymentsDir();
        path = string.concat(dir, "/", vm.toString(block.chainid), ".json");
        vm.createDir(dir, true);
        vm.writeFile(path, json);
    }

    /// @dev deployments/: the records of public chains (137, and the Amoy test deployment 80002) are committed; only
    ///      the local anvil stack's 31337.json is ignored. Tests of the scripts override this with a directory under
    ///      deployments/test/, so that they never overwrite a committed record.
    function _deploymentsDir() internal view virtual returns (string memory) {
        return "deployments";
    }

    function _deploymentJson(
        address gaslessTransfer,
        address initialOwner,
        uint256 deployBlock,
        TokenInit[] memory tokens
    ) internal view returns (string memory) {
        return string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"version":"3","gaslessTransfer":"',
            vm.toString(gaslessTransfer),
            '","initialOwner":"',
            vm.toString(initialOwner),
            '","deployBlock":"',
            vm.toString(deployBlock),
            '","tokens":[',
            _usdcJson(tokens[0]),
            ",",
            _usdt0Json(tokens[1]),
            "]}"
        );
    }

    /// @dev FiatTokenV2_2: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract).
    function _usdcDomainSeparator(address token) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(_usdcDomainName(token))),
                keccak256(bytes(USDC_DOMAIN_VERSION)),
                block.chainid,
                token
            )
        );
    }

    /// @dev UChildUSDT0: EIP712Domain(string name,string version,address verifyingContract,bytes32 salt).
    function _usdt0DomainSeparator(address token) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)"),
                keccak256(bytes(USDT0_DOMAIN_NAME)),
                keccak256(bytes(USDT0_DOMAIN_VERSION)),
                token,
                bytes32(block.chainid)
            )
        );
    }

    function _usdcJson(TokenInit memory t) private view returns (string memory) {
        return string.concat(
            _tokenHead("USDC", t),
            '"domain":{"name":"',
            _usdcDomainName(t.token),
            '","version":"',
            USDC_DOMAIN_VERSION,
            '","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(t.token),
            '"}}'
        );
    }

    function _usdt0Json(TokenInit memory t) private view returns (string memory) {
        return string.concat(
            _tokenHead("USDT0", t),
            '"domain":{"name":"',
            USDT0_DOMAIN_NAME,
            '","version":"',
            USDT0_DOMAIN_VERSION,
            '","verifyingContract":"',
            vm.toString(t.token),
            '","salt":"',
            vm.toString(bytes32(block.chainid)),
            '"}}'
        );
    }

    function _tokenHead(string memory symbol, TokenInit memory t) private pure returns (string memory) {
        return string.concat(
            '{"symbol":"',
            symbol,
            '","address":"',
            vm.toString(t.token),
            '","decimals":6,"authModes":',
            _authModes(t.config),
            ","
        );
    }

    /// @dev Mode names in the order permit, metaTxApprove, none.
    function _authModes(TokenConfig memory c) private pure returns (string memory modes) {
        if (c.permit) modes = '"permit"';
        if (c.metaTxApprove) modes = _append(modes, '"metaTxApprove"');
        if (c.allowance) modes = _append(modes, '"none"');
        return string.concat("[", modes, "]");
    }

    function _append(string memory list, string memory item) private pure returns (string memory) {
        return bytes(list).length == 0 ? item : string.concat(list, ",", item);
    }
}
