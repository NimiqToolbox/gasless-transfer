// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

/// @notice The parts of FiatTokenV2_2 (native USDC on Polygon) the fork tests use.
interface IFiatTokenV2_2 {
    function masterMinter() external view returns (address);
    function configureMinter(address minter, uint256 minterAllowedAmount) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function pauser() external view returns (address);
    function pause() external;
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @notice The parts of UChildUSDT0 the fork tests use.
interface IUChildUSDT0 {
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
    function grantRole(bytes32 role, address account) external;
    function BLOCK_ROLE() external view returns (bytes32);
    function mint(address destination, uint256 amount) external;
    function addToBlockedList(address user) external;
    function getNonce(address user) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function executeMetaTransaction(
        address userAddress,
        bytes calldata functionSignature,
        bytes32 sigR,
        bytes32 sigS,
        uint8 sigV
    ) external payable returns (bytes memory);
}

/// @notice Fork fixture on Polygon PoS with the real USDC and USDT0 (docs/DEVELOPMENT.md: FOUNDRY_PROFILE=fork).
///         Every test skips itself when POLYGON_RPC_URL is not set.
abstract contract ForkTestBase is Test {
    address internal constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address internal constant USDT0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    uint256 internal constant DEFAULT_FORK_BLOCK = 94_421_000;

    // The tokens' DOMAIN_SEPARATOR() on Polygon, pinned.
    bytes32 internal constant PINNED_USDC_DOMAIN = 0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca;
    bytes32 internal constant PINNED_USDT0_DOMAIN = 0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05;

    bytes32 internal constant TRANSFER_TYPEHASH = keccak256(
        "GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)"
    );
    bytes32 internal constant TOKEN_AUTH_TYPEHASH = keccak256("TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant SALT_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant META_TRANSACTION_TYPEHASH =
        keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");

    bool internal forked;
    GaslessTransfer internal gasless;

    modifier onlyForked() {
        if (!forked) vm.skip(true);
        _;
    }

    /// @dev Forks Polygon at `blockNumber` and deploys GaslessTransfer with the mainnet configuration of
    ///      script/DeployGaslessTransfer.s.sol. Returns false (nothing forked) without POLYGON_RPC_URL.
    function _fork(uint256 blockNumber) internal returns (bool) {
        if (bytes(vm.envOr("POLYGON_RPC_URL", string(""))).length == 0) return false;
        vm.createSelectFork("polygon", blockNumber);
        assertEq(block.chainid, 137, "Polygon PoS");
        TokenInit[] memory tokens = new TokenInit[](2);
        tokens[0] = TokenInit({token: USDC, config: TokenConfig({permit: true, metaTxApprove: false, allowance: true})});
        tokens[1] = TokenInit({token: USDT0, config: TokenConfig({permit: true, metaTxApprove: true, allowance: true})});
        gasless = new GaslessTransfer(makeAddr("fork-owner"), tokens);
        return true;
    }

    // --- Balances ---------------------------------------------------------------------------------

    /// @dev forge-std deal; if its storage search fails for a token, mint through the token's own roles instead.
    function _fund(address token, address to, uint256 amount) internal {
        try this.dealTokens(token, to, amount) {}
        catch {
            if (token == USDC) {
                IFiatTokenV2_2 usdc = IFiatTokenV2_2(USDC);
                vm.prank(usdc.masterMinter());
                usdc.configureMinter(address(this), amount);
                usdc.mint(to, amount);
            } else {
                IUChildUSDT0 usdt0 = IUChildUSDT0(USDT0);
                vm.prank(usdt0.getRoleMember(bytes32(0), 0));
                usdt0.mint(to, amount);
            }
        }
        assertEq(IERC20(token).balanceOf(to), amount, "funded");
    }

    function dealTokens(address token, address to, uint256 amount) external {
        require(msg.sender == address(this), "only self");
        deal(token, to, amount);
    }

    // --- Requests and signatures (independent of the contract under test) --------------------------

    function _request(address token, address from, address to, uint256 amount, uint256 fee, address relay)
        internal
        view
        returns (TransferRequest memory)
    {
        return TransferRequest({
            token: token,
            from: from,
            to: to,
            amount: amount,
            fee: fee,
            relay: relay,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
    }

    /// @dev The intent signature over `r` and `auth` at the sender's current nonce.
    function _signTransfer(uint256 pk, TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("Nimiq Gasless Transfer"), keccak256("3"), vm.getChainId(), address(gasless)
            )
        );
        bytes32 authHash = keccak256(abi.encode(TOKEN_AUTH_TYPEHASH, uint8(auth.mode), auth.v, auth.r, auth.s));
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_TYPEHASH,
                r.token,
                r.from,
                r.to,
                r.amount,
                r.fee,
                r.relay,
                gasless.nonces(r.from),
                r.deadline,
                authHash
            )
        );
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(rr, s, v);
    }

    /// @dev §5: USDC ("USD Coin", "2", chainId, token); USDT0 salt domain ("USDT0", "1", token, bytes32(chainId)).
    function _tokenDomain(address token) internal view returns (bytes32) {
        if (token == USDC) {
            return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("USD Coin"), keccak256("2"), vm.getChainId(), USDC));
        }
        return keccak256(
            abi.encode(SALT_DOMAIN_TYPEHASH, keccak256("USDT0"), keccak256("1"), USDT0, bytes32(vm.getChainId()))
        );
    }

    function _signPermitWithDomain(
        uint256 pk,
        bytes32 domain,
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (TokenAuth memory) {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return TokenAuth({mode: AuthMode.PERMIT, v: v, r: r, s: s});
    }

    /// @dev The permit a client signs for `req`: this contract, amount + fee, the intent deadline, current nonce.
    function _permitFor(uint256 pk, TransferRequest memory req) internal view returns (TokenAuth memory) {
        uint256 nonce =
            req.token == USDC ? IFiatTokenV2_2(USDC).nonces(req.from) : IUChildUSDT0(USDT0).getNonce(req.from);
        return _signPermitWithDomain(
            pk, _tokenDomain(req.token), req.from, address(gasless), req.amount + req.fee, nonce, req.deadline
        );
    }

    function _metaTxFor(uint256 pk, TransferRequest memory req) internal view returns (TokenAuth memory) {
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (address(gasless), req.amount + req.fee));
        bytes32 structHash = keccak256(
            abi.encode(
                META_TRANSACTION_TYPEHASH, IUChildUSDT0(USDT0).getNonce(req.from), req.from, keccak256(approveCall)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _tokenDomain(USDT0), structHash)));
        return TokenAuth({mode: AuthMode.META_TX_APPROVE, v: v, r: r, s: s});
    }

    function _noneAuth() internal pure returns (TokenAuth memory) {
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: bytes32(0), s: bytes32(0)});
    }
}
