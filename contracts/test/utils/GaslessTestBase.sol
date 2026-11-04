// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Test} from "forge-std/Test.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, IGaslessBase, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockUSDT0} from "../mocks/MockUSDT0.sol";

/// @notice Shared fixture: GaslessTransfer owned by `owner` for MockUSDC {permit, allowance} and MockUSDT0 {permit,
///         metaTxApprove, allowance}, a funded signer, and EIP-712 helpers written independently of the contract under
///         test (the type strings are copied from docs/STEP-1-GAS-ABSTRACTION.md §4.3 and §5).
abstract contract GaslessTestBase is Test {
    /// @dev The largest fee most tests sign: 5.00 of a 6-decimal token. The contract itself bounds no fee.
    uint256 internal constant MAX_TEST_FEE = 5_000_000;
    uint256 internal constant INITIAL_BALANCE = 1_000_000e6;
    uint256 internal constant START_TIME = 1_790_000_000;
    uint256 internal constant MAX_NONCE_INCREASE = type(uint32).max;

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
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    GaslessTransfer internal gasless;
    MockUSDC internal usdc;
    MockUSDT0 internal usdt0;

    address internal owner;
    address internal alice;
    uint256 internal alicePk;
    address internal attacker;
    uint256 internal attackerPk;
    address internal bob;
    address internal relay;

    function setUp() public virtual {
        vm.warp(START_TIME);
        usdc = new MockUSDC();
        usdt0 = new MockUSDT0();
        owner = makeAddr("owner");
        gasless = new GaslessTransfer(owner, stablecoinInits(address(usdc), address(usdt0)));

        (alice, alicePk) = makeAddrAndKey("alice");
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        bob = makeAddr("bob");
        relay = makeAddr("relay");

        usdc.mint(alice, INITIAL_BALANCE);
        usdt0.mint(alice, INITIAL_BALANCE);
    }

    /// @dev The mainnet configuration: USDC {PERMIT, NONE}; USDT0 {PERMIT, META_TX_APPROVE, NONE}.
    function stablecoinInits(address usdc_, address usdt0_) internal pure returns (TokenInit[] memory tokens) {
        tokens = new TokenInit[](2);
        tokens[0] = TokenInit({token: usdc_, config: _config(true, false, true)});
        tokens[1] = TokenInit({token: usdt0_, config: _config(true, true, true)});
    }

    function _config(bool permit, bool metaTxApprove, bool allowance) internal pure returns (TokenConfig memory) {
        return TokenConfig({permit: permit, metaTxApprove: metaTxApprove, allowance: allowance});
    }

    function _single(address token, TokenConfig memory config) internal pure returns (TokenInit[] memory tokens) {
        tokens = new TokenInit[](1);
        tokens[0] = TokenInit({token: token, config: config});
    }

    // --- Requests -------------------------------------------------------------------------------

    /// @dev alice -> bob, submitted by `relay`, valid for one hour.
    function _request(address token, uint256 amount, uint256 fee) internal view returns (TransferRequest memory) {
        return TransferRequest({
            token: token,
            from: alice,
            to: bob,
            amount: amount,
            fee: fee,
            relay: relay,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
    }

    function _copy(TransferRequest memory r) internal pure returns (TransferRequest memory) {
        return TransferRequest(r.token, r.from, r.to, r.amount, r.fee, r.relay, r.deadline);
    }

    // --- EIP-712 of GaslessTransfer (independent implementation) --------------------------------

    function _transferDomainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("Nimiq Gasless Transfer"), keccak256("3"), vm.getChainId(), verifyingContract
            )
        );
    }

    function _authStructHash(TokenAuth memory auth) internal pure returns (bytes32) {
        return keccak256(abi.encode(TOKEN_AUTH_TYPEHASH, uint8(auth.mode), auth.v, auth.r, auth.s));
    }

    function _transferStructHash(TransferRequest memory r, uint256 nonce, TokenAuth memory auth)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                TRANSFER_TYPEHASH,
                r.token,
                r.from,
                r.to,
                r.amount,
                r.fee,
                r.relay,
                nonce,
                r.deadline,
                _authStructHash(auth)
            )
        );
    }

    function _transferDigest(TransferRequest memory r, uint256 nonce, TokenAuth memory auth, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", _transferDomainSeparator(verifyingContract), _transferStructHash(r, nonce, auth)
            )
        );
    }

    /// @dev The signature a client makes for `r` with `auth` at the sender's current nonce on `gasless`.
    function _signTransfer(uint256 pk, TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return _signTransferAt(pk, r, gasless.nonces(r.from), auth);
    }

    function _signTransferAt(uint256 pk, TransferRequest memory r, uint256 nonce, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, _transferDigest(r, nonce, auth, address(gasless)));
    }

    /// @dev The same for another deployment `g`, at the sender's current nonce there.
    function _signTransferFor(uint256 pk, TransferRequest memory r, TokenAuth memory auth, GaslessTransfer g)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, _transferDigest(r, g.nonces(r.from), auth, address(g)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- Token authorizations (§5) --------------------------------------------------------------

    function _usdcDomainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, keccak256("USD Coin"), keccak256("2"), vm.getChainId(), address(usdc))
            );
    }

    function _usdt0DomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                SALT_DOMAIN_TYPEHASH, keccak256("USDT0"), keccak256("1"), address(usdt0), bytes32(vm.getChainId())
            )
        );
    }

    function _tokenDomainSeparator(address token) internal view returns (bytes32) {
        if (token == address(usdc)) return _usdcDomainSeparator();
        if (token == address(usdt0)) return _usdt0DomainSeparator();
        return IERC20Permit(token).DOMAIN_SEPARATOR();
    }

    function _signPermit(
        uint256 pk,
        address token,
        address owner_,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (TokenAuth memory) {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _tokenDomainSeparator(token), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return TokenAuth({mode: AuthMode.PERMIT, v: v, r: r, s: s});
    }

    /// @dev The permit a client signs for `req`: spender = this contract, value = amount + fee, deadline = the
    ///      intent deadline, nonce = the token's current nonce.
    function _permitFor(uint256 pk, TransferRequest memory req) internal view returns (TokenAuth memory) {
        return _signPermit(
            pk,
            req.token,
            req.from,
            address(gasless),
            req.amount + req.fee,
            IERC20Permit(req.token).nonces(req.from),
            req.deadline
        );
    }

    function _signMetaTxApprove(uint256 pk, address from, address spender, uint256 value, uint256 nonce)
        internal
        view
        returns (TokenAuth memory)
    {
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (spender, value));
        bytes32 structHash = keccak256(abi.encode(META_TRANSACTION_TYPEHASH, nonce, from, keccak256(approveCall)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _usdt0DomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return TokenAuth({mode: AuthMode.META_TX_APPROVE, v: v, r: r, s: s});
    }

    /// @dev USDT0 meta-transaction for `approve(this contract, amount + fee)` at the current USDT0 nonce.
    function _metaTxFor(uint256 pk, TransferRequest memory req) internal view returns (TokenAuth memory) {
        return _signMetaTxApprove(pk, req.from, address(gasless), req.amount + req.fee, usdt0.getNonce(req.from));
    }

    function _noneAuth() internal pure returns (TokenAuth memory) {
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    function _approve(address token, address owner_, uint256 amount) internal {
        vm.prank(owner_);
        IERC20(token).approve(address(gasless), amount);
    }

    /// @dev The token authorization a client would produce for `req` in `mode` (NONE approves exactly amount + fee).
    function _authFor(uint256 pk, TransferRequest memory req, AuthMode mode) internal returns (TokenAuth memory) {
        if (mode == AuthMode.PERMIT) return _permitFor(pk, req);
        if (mode == AuthMode.META_TX_APPROVE) return _metaTxFor(pk, req);
        _approve(req.token, req.from, req.amount + req.fee);
        return _noneAuth();
    }

    // --- Submission -----------------------------------------------------------------------------

    function _submit(TransferRequest memory r, bytes memory sig, TokenAuth memory auth) internal {
        vm.prank(r.relay);
        gasless.relayTransfer(r, sig, auth);
    }

    function _expectRevert(TransferRequest memory r, bytes memory sig, TokenAuth memory auth, bytes memory err)
        internal
    {
        _expectRevertFrom(r.relay, r, sig, auth, err);
    }

    function _expectRevertFrom(
        address caller,
        TransferRequest memory r,
        bytes memory sig,
        TokenAuth memory auth,
        bytes memory err
    ) internal {
        vm.prank(caller);
        vm.expectRevert(err);
        gasless.relayTransfer(r, sig, auth);
    }

    // --- Error data -----------------------------------------------------------------------------

    function _errInvalidSignature() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InvalidSignature.selector);
    }

    function _errInsufficientAllowance(uint256 current, uint256 required) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InsufficientAllowance.selector, current, required);
    }

    function _errInvalidNonceIncrease(uint256 current, uint256 newNonce) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InvalidNonceIncrease.selector, current, newNonce);
    }

    // --- Balance watch for "nothing moved" assertions -------------------------------------------

    function _watched() internal view virtual returns (address[] memory accounts) {
        accounts = new address[](5);
        accounts[0] = alice;
        accounts[1] = bob;
        accounts[2] = relay;
        accounts[3] = attacker;
        accounts[4] = address(gasless);
    }

    function _balances() internal view returns (uint256[] memory snapshot) {
        address[] memory accounts = _watched();
        snapshot = new uint256[](accounts.length * 2);
        for (uint256 i = 0; i < accounts.length; ++i) {
            snapshot[2 * i] = usdc.balanceOf(accounts[i]);
            snapshot[2 * i + 1] = usdt0.balanceOf(accounts[i]);
        }
    }

    function _assertBalancesUnchanged(uint256[] memory before) internal view {
        uint256[] memory current = _balances();
        for (uint256 i = 0; i < before.length; ++i) {
            assertEq(current[i], before[i], "token balance changed");
        }
    }
}
