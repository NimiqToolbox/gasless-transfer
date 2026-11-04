// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, Vm} from "forge-std/Test.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

/// @notice FiatTokenV2_2 (native USDC on Polygon, implementation 0x235AE97b…82cb) as observed on-chain.
interface IVfUsdc {
    function masterMinter() external view returns (address);
    function configureMinter(address minter, uint256 minterAllowedAmount) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
    function pauser() external view returns (address);
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @notice UChildUSDT0 (implementation 0x90040487…4229 behind 0xc213…8e8F) as observed on-chain.
interface IVfUsdt0 {
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
    function mint(address destination, uint256 amount) external;
    function addToBlockedList(address user) external;
    function removeFromBlockedList(address user) external;
    function isBlocked(address user) external view returns (bool);
    function changeName(string calldata name) external;
    function name() external view returns (string memory);
    function getNonce(address user) external view returns (uint256);
    function nonces(address user) external view returns (uint256);
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

/// @notice Fork verification base: forks Polygon PoS with the real USDC and USDT0 and deploys GaslessTransfer with the
///         mainnet configuration. Written independently of test/fork/ForkTestBase.sol: own typed-data code (from the
///         spec strings), funding through the tokens' real admin roles, no `deal`.
///         Opt-in only, so the default `forge test`  never touches the network:
///           VER_FORK=true POLYGON_RPC_URL=<archive rpc> forge test --match-path 'test/fork-verify/*'
abstract contract VerForkBase is Test {
    address internal constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address internal constant USDT0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    uint256 internal constant RECENT_BLOCK = 94_421_000;

    // The tokens' DOMAIN_SEPARATOR() on Polygon, pinned.
    bytes32 internal constant PIN_USDC_DOMAIN = 0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca;
    bytes32 internal constant PIN_USDT0_DOMAIN = 0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05;

    bytes32 internal constant EV_TRANSFER = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant EV_APPROVAL = keccak256("Approval(address,address,uint256)");

    bool internal enabled;
    GaslessTransfer internal gasless;
    address internal relay;

    modifier onlyEnabled() {
        if (!enabled) vm.skip(true);
        _;
    }

    /// @dev True only with VER_FORK=true and a POLYGON_RPC_URL; then forks at `blockNumber` and deploys.
    function _setUpFork(uint256 blockNumber) internal returns (bool) {
        if (!vm.envOr("VER_FORK", false)) return false;
        if (bytes(vm.envOr("POLYGON_RPC_URL", string(""))).length == 0) return false;
        vm.createSelectFork("polygon", blockNumber);
        assertEq(block.chainid, 137, "Polygon PoS");
        assertEq(block.number, blockNumber, "fork block");
        TokenInit[] memory tokens = new TokenInit[](2);
        tokens[0] = TokenInit({token: USDC, config: TokenConfig({permit: true, metaTxApprove: false, allowance: true})});
        tokens[1] = TokenInit({token: USDT0, config: TokenConfig({permit: true, metaTxApprove: true, allowance: true})});
        gasless = new GaslessTransfer(makeAddr("verfork-owner"), tokens);
        relay = makeAddr("verfork-relay");
        return true;
    }

    // --- Funding through the tokens' own roles ------------------------------------------------------

    function _mint(address token, address to, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(to);
        if (token == USDC) {
            IVfUsdc usdc = IVfUsdc(USDC);
            address minter = makeAddr("verfork-usdc-minter");
            vm.prank(usdc.masterMinter());
            usdc.configureMinter(minter, amount);
            vm.prank(minter);
            usdc.mint(to, amount);
        } else {
            IVfUsdt0 usdt0 = IVfUsdt0(USDT0);
            vm.prank(usdt0.getRoleMember(bytes32(0), 0));
            usdt0.mint(to, amount);
        }
        assertEq(IERC20(token).balanceOf(to), before + amount, "minted");
    }

    function _usdt0Admin() internal view returns (address) {
        return IVfUsdt0(USDT0).getRoleMember(bytes32(0), 0);
    }

    // --- Typed data, built from the §4.3 / §5 strings -------------------------------------------------

    function _transferDomain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Nimiq Gasless Transfer")),
                keccak256(bytes("3")),
                block.chainid,
                address(gasless)
            )
        );
    }

    function _transferDigest(TransferRequest memory r, uint256 nonce, TokenAuth memory auth)
        internal
        view
        returns (bytes32)
    {
        bytes32 typeHash = keccak256(
            "GaslessTransfer(address token,address from,address to,uint256 amount,uint256 fee,address relay,uint256 nonce,uint256 deadline,TokenAuth auth)TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)"
        );
        bytes32 authHash = keccak256(
            abi.encode(
                keccak256("TokenAuth(uint8 mode,uint8 v,bytes32 r,bytes32 s)"), auth.mode, auth.v, auth.r, auth.s
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(typeHash, r.token, r.from, r.to, r.amount, r.fee, r.relay, nonce, r.deadline, authHash)
        );
        return keccak256(abi.encodePacked("\x19\x01", _transferDomain(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The intent signature over `r` and `auth` at the sender's current nonce.
    function _signTransfer(uint256 pk, TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, _transferDigest(r, gasless.nonces(r.from), auth));
    }

    /// @dev USDC: ("USD Coin", "2", chainId, token). USDT0: salt domain ("USDT0", "1", token, bytes32(chainId)).
    function _specTokenDomain(address token, string memory usdt0Name) internal view returns (bytes32) {
        if (token == USDC) {
            return keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256(bytes("USD Coin")),
                    keccak256(bytes("2")),
                    block.chainid,
                    USDC
                )
            );
        }
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)"),
                keccak256(bytes(usdt0Name)),
                keccak256(bytes("1")),
                USDT0,
                bytes32(block.chainid)
            )
        );
    }

    function _tokenNonce(address token, address owner) internal view returns (uint256) {
        return token == USDC ? IVfUsdc(USDC).nonces(owner) : IVfUsdt0(USDT0).getNonce(owner);
    }

    function _permitDigest(bytes32 domain, address owner, address spender, uint256 value, uint256 nonce, uint256 dl)
        internal
        pure
        returns (bytes32)
    {
        bytes32 typeHash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        return keccak256(
            abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typeHash, owner, spender, value, nonce, dl)))
        );
    }

    function _metaTxDigest(bytes32 domain, address owner, bytes memory functionSignature, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        bytes32 typeHash = keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domain, keccak256(abi.encode(typeHash, nonce, owner, keccak256(functionSignature)))
            )
        );
    }

    function _auth(AuthMode mode, bytes32 digest, uint256 pk) internal pure returns (TokenAuth memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return TokenAuth({mode: mode, v: v, r: r, s: s});
    }

    /// @dev What a wallet signs for `req` in `mode`: spender = gasless, value = amount + fee, permit deadline =
    ///      intent deadline, the live token nonce, the spec domain (USDT0 name "USDT0").
    function _tokenAuth(uint256 pk, TransferRequest memory req, AuthMode mode)
        internal
        view
        returns (TokenAuth memory)
    {
        return _tokenAuthWithName(pk, req, mode, "USDT0");
    }

    function _tokenAuthWithName(uint256 pk, TransferRequest memory req, AuthMode mode, string memory usdt0Name)
        internal
        view
        returns (TokenAuth memory)
    {
        if (mode == AuthMode.NONE) return TokenAuth({mode: AuthMode.NONE, v: 0, r: bytes32(0), s: bytes32(0)});
        bytes32 domain = _specTokenDomain(req.token, usdt0Name);
        uint256 nonce = _tokenNonce(req.token, req.from);
        if (mode == AuthMode.PERMIT) {
            return _auth(
                mode, _permitDigest(domain, req.from, address(gasless), req.amount + req.fee, nonce, req.deadline), pk
            );
        }
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (address(gasless), req.amount + req.fee));
        return _auth(mode, _metaTxDigest(domain, req.from, approveCall, nonce), pk);
    }

    function _noAuth() internal pure returns (TokenAuth memory) {
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    function _request(address token, address from, address to, uint256 amount, uint256 fee)
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
            deadline: block.timestamp + 30 minutes
        });
    }

    /// @dev Memory structs are references; tests that mutate a field work on a copy.
    function _copy(TransferRequest memory r) internal pure returns (TransferRequest memory) {
        return TransferRequest({
            token: r.token, from: r.from, to: r.to, amount: r.amount, fee: r.fee, relay: r.relay, deadline: r.deadline
        });
    }

    // --- Submission and invariants ---------------------------------------------------------------------

    struct Snapshot {
        uint256 from;
        uint256 to;
        uint256 relay;
        uint256 contractBalance;
        uint256 tokenNonce;
        uint256 intentNonce;
    }

    function _snap(TransferRequest memory r) internal view returns (Snapshot memory s) {
        IERC20 t = IERC20(r.token);
        s = Snapshot({
            from: t.balanceOf(r.from),
            to: t.balanceOf(r.to),
            relay: t.balanceOf(r.relay),
            contractBalance: t.balanceOf(address(gasless)),
            tokenNonce: _tokenNonce(r.token, r.from),
            intentNonce: gasless.nonces(r.from)
        });
    }

    /// @dev Nothing moved, the intent nonce is unused and the token nonce did not advance (a clean revert).
    function _assertUntouched(TransferRequest memory r, Snapshot memory s) internal view {
        IERC20 t = IERC20(r.token);
        assertEq(t.balanceOf(r.from), s.from, "from unchanged");
        assertEq(t.balanceOf(r.to), s.to, "to unchanged");
        assertEq(t.balanceOf(r.relay), s.relay, "relay unchanged");
        assertEq(t.balanceOf(address(gasless)), s.contractBalance, "contract unchanged");
        assertEq(_tokenNonce(r.token, r.from), s.tokenNonce, "token nonce unchanged");
        assertEq(gasless.nonces(r.from), s.intentNonce, "intent nonce unused");
    }

    /// @dev TI1, TI4, TI5 after a successful call (to != relay, to != from).
    function _assertTransferred(TransferRequest memory r, Snapshot memory s) internal view {
        IERC20 t = IERC20(r.token);
        assertEq(t.balanceOf(r.from), s.from - r.amount - r.fee, "TI1 from pays amount + fee");
        assertEq(t.balanceOf(r.to), s.to + r.amount, "TI1 to gets amount");
        assertEq(t.balanceOf(r.relay), s.relay + r.fee, "TI1 relay gets fee");
        assertEq(t.balanceOf(address(gasless)), s.contractBalance, "TI4 no custody");
        assertEq(t.allowance(r.from, address(gasless)), 0, "TI5 no leftover allowance");
        assertEq(gasless.nonces(r.from), s.intentNonce + 1, "TI1 nonce used");
    }

    function _relay(TransferRequest memory r, bytes memory sig, TokenAuth memory auth) internal {
        vm.prank(r.relay, r.relay);
        gasless.relayTransfer(r, sig, auth);
    }

    function _relayExpectRevert(TransferRequest memory r, bytes memory sig, TokenAuth memory auth, bytes memory err)
        internal
    {
        vm.prank(r.relay, r.relay);
        vm.expectRevert(err);
        gasless.relayTransfer(r, sig, auth);
    }

    /// @dev Topic-0 sequence of the logs, restricted to the token and the contract.
    function _eventSequence(Vm.Log[] memory logs, address token) internal view returns (bytes32[] memory seq) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == token || logs[i].emitter == address(gasless)) ++n;
        }
        seq = new bytes32[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == token || logs[i].emitter == address(gasless)) seq[n++] = logs[i].topics[0];
        }
    }
}
