// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {AuthMode, IGaslessBase, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

import {SpecDigests} from "./SpecDigests.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockUSDT0} from "./mocks/MockUSDT0.sol";

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}

/// @title Black-box spec tests for GaslessTransfer, shared fixture
/// @notice Independent verifier of docs/STEP-1-GAS-ABSTRACTION.md §2-§4 and §8, written without the implementation.
///         - The contract under test is only deployed from its artifact:
///           `vm.deployCode("GaslessTransfer.sol:GaslessTransfer", abi.encode(owner, tokens))`, and only used
///           through the frozen interfaces IGaslessBase / IGaslessTransfer (plus Ownable2Step's functions).
///         - Every EIP-712 digest (intent, USDC permit, USDT0 permit and meta-tx) is recomputed here from the spec and
///           never read from the contract, so a wrong domain, type string or field order fails these tests.
///         - The tokens are local mocks of FiatTokenV2_2 (USDC) and UChildUSDT0 (USDT0); the real-token behaviour
///           on a Polygon fork (T01, T13-T17) is covered by the fork suite, not here.
///         - Names carry the §8 test IDs (T02, ...) or the §3 invariant IDs (TI1-TI5).
abstract contract SpecBase is Test {
    // ---------------------------------------------------------------- spec constants (§4.2, §4.3, §5, §11)

    string internal constant ARTIFACT = "GaslessTransfer.sol:GaslessTransfer";
    string internal constant ARTIFACT_JSON = "out/GaslessTransfer.sol/GaslessTransfer.json";
    string internal constant DOMAIN_NAME = SpecDigests.DOMAIN_NAME;
    string internal constant DOMAIN_VERSION = SpecDigests.DOMAIN_VERSION;
    string internal constant TRANSFER_TYPE = SpecDigests.TRANSFER_TYPE;
    string internal constant TOKEN_AUTH_TYPE = SpecDigests.TOKEN_AUTH_TYPE;
    bytes32 internal constant TRANSFER_TYPEHASH = SpecDigests.TRANSFER_TYPEHASH;
    bytes32 internal constant TOKEN_AUTH_TYPEHASH = SpecDigests.TOKEN_AUTH_TYPEHASH;

    uint256 internal constant POLYGON = 137;
    uint256 internal constant AMOY = 80_002;
    /// @dev The largest fee most tests sign (5 units at 6 decimals). The contract bounds no fee (§4.2).
    uint256 internal constant MAX_TEST_FEE = 5_000_000;
    uint256 internal constant MAX_NONCE_INCREASE = type(uint32).max;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ---------------------------------------------------------------- fixture

    uint256 internal constant START = 1_790_000_000;
    uint256 internal constant FUNDS = 1_000_000e6;
    uint256 internal constant AMOUNT = 25_000_000;
    uint256 internal constant FEE = 50_000;
    uint256 internal constant TTL = 10 minutes;
    uint256 internal constant ROUTES = 5;

    IGaslessTransfer internal gasless;
    MockUSDC internal usdc;
    MockUSDT0 internal usdt;

    address internal owner;
    address internal alice;
    uint256 internal aliceKey;
    address internal bob;
    uint256 internal bobKey;
    address internal victim;
    uint256 internal victimKey;
    address internal attacker;
    uint256 internal attackerKey;
    address internal relay;
    address internal otherRelay;
    address internal carol;

    struct State {
        uint256 fromBalance;
        uint256 toBalance;
        uint256 relayBalance;
        uint256 contractBalance;
        uint256 allowance;
        uint256 tokenNonce;
        uint256 supply;
        uint256 nonce;
    }

    struct VictimState {
        uint256 usdcBalance;
        uint256 usdtBalance;
        uint256 usdcAllowance;
        uint256 usdtAllowance;
        uint256 usdcNonce;
        uint256 usdtNonce;
        uint256 contractUsdc;
        uint256 contractUsdt;
        uint256 nonce;
    }

    function setUp() public virtual {
        vm.chainId(POLYGON);
        vm.warp(START);

        owner = makeAddr("owner");
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        (victim, victimKey) = makeAddrAndKey("victim");
        (attacker, attackerKey) = makeAddrAndKey("attacker");
        relay = makeAddr("relay");
        otherRelay = makeAddr("otherRelay");
        carol = makeAddr("carol");

        usdc = new MockUSDC();
        usdt = new MockUSDT0();
        gasless = deployGasless(defaultTokens());

        address[4] memory holders = [alice, bob, victim, attacker];
        for (uint256 i = 0; i < holders.length; ++i) {
            usdc.mint(holders[i], FUNDS);
            usdt.mint(holders[i], FUNDS);
        }

        // The maximum-approved account: unlimited allowances to the contract, and no request ever signed for this contract.
        vm.startPrank(victim);
        usdc.approve(address(gasless), type(uint256).max);
        usdt.approve(address(gasless), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- deployment

    /// @dev The production configuration of §11: USDC {PERMIT, NONE}, USDT0 {PERMIT, META_TX_APPROVE, NONE}.
    function defaultTokens() internal view returns (TokenInit[] memory tokens) {
        tokens = new TokenInit[](2);
        tokens[0] = TokenInit({token: address(usdc), config: config(true, false, true)});
        tokens[1] = TokenInit({token: address(usdt), config: config(true, true, true)});
    }

    function config(bool permit, bool metaTxApprove, bool allowance) internal pure returns (TokenConfig memory) {
        return TokenConfig({permit: permit, metaTxApprove: metaTxApprove, allowance: allowance});
    }

    function deployGasless(TokenInit[] memory tokens) internal returns (IGaslessTransfer) {
        return IGaslessTransfer(vm.deployCode(ARTIFACT, abi.encode(owner, tokens)));
    }

    // ---------------------------------------------------------------- the five (token, mode) routes of §11

    function route(uint256 i) internal view returns (address token, AuthMode mode) {
        i %= ROUTES;
        if (i == 0) return (address(usdc), AuthMode.PERMIT);
        if (i == 1) return (address(usdc), AuthMode.NONE);
        if (i == 2) return (address(usdt), AuthMode.PERMIT);
        if (i == 3) return (address(usdt), AuthMode.META_TX_APPROVE);
        return (address(usdt), AuthMode.NONE);
    }

    function routeName(uint256 i) internal pure returns (string memory) {
        i %= ROUTES;
        if (i == 0) return "USDC/PERMIT";
        if (i == 1) return "USDC/NONE";
        if (i == 2) return "USDT0/PERMIT";
        if (i == 3) return "USDT0/META_TX_APPROVE";
        return "USDT0/NONE";
    }

    // ---------------------------------------------------------------- EIP-712 intent, computed from §4.3 only

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return SpecDigests.transferDomain(chainId, verifyingContract);
    }

    function digestFor(
        TransferRequest memory r,
        uint256 nonce,
        TokenAuth memory auth,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return SpecDigests.transferDigest(r, nonce, auth, chainId, verifyingContract);
    }

    function digest(TransferRequest memory r, uint256 nonce, TokenAuth memory auth) internal view returns (bytes32) {
        return digestFor(r, nonce, auth, block.chainid, address(gasless));
    }

    function signDigest(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    /// @dev `from`'s signature over `r` and `auth` at its current nonce, as a client signs a new request.
    function signRequest(uint256 key, TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return signDigest(key, digest(r, gasless.nonces(r.from), auth));
    }

    function signRequestAt(uint256 key, TransferRequest memory r, uint256 nonce, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return signDigest(key, digest(r, nonce, auth));
    }

    /// @dev The same for another deployment `g`.
    function signRequestFor(IGaslessTransfer g, uint256 key, TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return signDigest(key, digestFor(r, g.nonces(r.from), auth, block.chainid, address(g)));
    }

    // ---------------------------------------------------------------- requests

    /// @dev A valid-looking request of AMOUNT + FEE from `from` to carol, bound to `relay`, valid for TTL.
    function request(address token, address from) internal view returns (TransferRequest memory) {
        return TransferRequest({
            token: token,
            from: from,
            to: carol,
            amount: AMOUNT,
            fee: FEE,
            relay: relay,
            deadline: vm.getBlockTimestamp() + TTL
        });
    }

    function copy(TransferRequest memory r) internal pure returns (TransferRequest memory) {
        return TransferRequest(r.token, r.from, r.to, r.amount, r.fee, r.relay, r.deadline);
    }

    // ---------------------------------------------------------------- token authorization, computed from §5 only

    function usdcDomainSeparator() internal view returns (bytes32) {
        return SpecDigests.usdcDomain(block.chainid, address(usdc));
    }

    /// @dev The USDT0 salt domain; the salt is the chain id at token initialization (Polygon in this fixture).
    function usdtDomainSeparator() internal view returns (bytes32) {
        return SpecDigests.usdt0Domain(POLYGON, address(usdt));
    }

    function tokenNonce(address token, address tokenOwner) internal view returns (uint256) {
        if (token == address(usdc)) return usdc.nonces(tokenOwner);
        if (token == address(usdt)) return usdt.nonces(tokenOwner);
        return 0;
    }

    function permitDigest(
        address token,
        address tokenOwner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 separator = token == address(usdc) ? usdcDomainSeparator() : usdtDomainSeparator();
        return SpecDigests.permitDigest(separator, tokenOwner, spender, value, nonce, deadline);
    }

    function signPermit(
        uint256 key,
        address token,
        address tokenOwner,
        address spender,
        uint256 value,
        uint256 deadline
    ) internal view returns (TokenAuth memory) {
        bytes32 hash = permitDigest(token, tokenOwner, spender, value, tokenNonce(token, tokenOwner), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return TokenAuth({mode: AuthMode.PERMIT, v: v, r: r, s: s});
    }

    function approveCalldata(address spender, uint256 value) internal pure returns (bytes memory) {
        return SpecDigests.approveCalldata(spender, value);
    }

    function metaTxDigest(address tokenOwner, bytes memory functionSignature, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        return SpecDigests.metaTxDigest(usdtDomainSeparator(), tokenOwner, functionSignature, nonce);
    }

    function signMetaTxApprove(uint256 key, address tokenOwner, address spender, uint256 value)
        internal
        view
        returns (TokenAuth memory)
    {
        bytes32 hash = metaTxDigest(tokenOwner, approveCalldata(spender, value), usdt.getNonce(tokenOwner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return TokenAuth({mode: AuthMode.META_TX_APPROVE, v: v, r: r, s: s});
    }

    function noAuth() internal pure returns (TokenAuth memory) {
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    /// @dev The token authorization exactly as §5 prescribes it: spender = the gasless contract, value = amount + fee,
    ///      permit deadline = intent deadline. For NONE the owner approves exactly amount + fee itself.
    function authorize(uint256 key, TransferRequest memory r, AuthMode mode) internal returns (TokenAuth memory) {
        if (mode == AuthMode.PERMIT) {
            return signPermit(key, r.token, r.from, address(gasless), r.amount + r.fee, r.deadline);
        }
        if (mode == AuthMode.META_TX_APPROVE) {
            return signMetaTxApprove(key, r.from, address(gasless), r.amount + r.fee);
        }
        vm.prank(r.from);
        IERC20Like(r.token).approve(address(gasless), r.amount + r.fee);
        return noAuth();
    }

    // ---------------------------------------------------------------- submission

    function submit(TransferRequest memory r, bytes memory sig, TokenAuth memory auth) internal {
        vm.prank(r.relay);
        gasless.relayTransfer(r, sig, auth);
    }

    /// @dev Expects `relayTransfer` sent by `caller` to revert with exactly `err`, and nothing observable to change.
    function expectRevertNoChange(
        address caller,
        TransferRequest memory r,
        bytes memory sig,
        TokenAuth memory auth,
        bytes memory err
    ) internal {
        State memory before = observe(r);
        VictimState memory victimBefore = observeVictim();
        vm.expectRevert(err);
        vm.prank(caller);
        gasless.relayTransfer(r, sig, auth);
        assertUnchanged(r, before);
        assertVictimUntouched(victimBefore);
    }

    // ---------------------------------------------------------------- observation

    function observe(TransferRequest memory r) internal view returns (State memory s) {
        s.nonce = gasless.nonces(r.from);
        if (r.token.code.length == 0) return s;
        IERC20Like token = IERC20Like(r.token);
        s.fromBalance = token.balanceOf(r.from);
        s.toBalance = token.balanceOf(r.to);
        s.relayBalance = token.balanceOf(r.relay);
        s.contractBalance = token.balanceOf(address(gasless));
        s.allowance = token.allowance(r.from, address(gasless));
        s.tokenNonce = tokenNonce(r.token, r.from);
        s.supply = token.totalSupply();
    }

    function assertUnchanged(TransferRequest memory r, State memory before) internal view {
        State memory a = observe(r);
        assertEq(a.fromBalance, before.fromBalance, "from balance changed");
        assertEq(a.toBalance, before.toBalance, "to balance changed");
        assertEq(a.relayBalance, before.relayBalance, "relay balance changed");
        assertEq(a.contractBalance, before.contractBalance, "contract balance changed");
        assertEq(a.allowance, before.allowance, "allowance changed");
        assertEq(a.tokenNonce, before.tokenNonce, "token permit/meta-tx nonce changed");
        assertEq(a.supply, before.supply, "supply changed");
        assertEq(a.nonce, before.nonce, "intent nonce changed");
    }

    /// @dev TI1 for one successful call: `from` pays exactly amount + fee, `to` receives exactly amount, `relay`
    ///      receives exactly fee, the contract keeps nothing and the intent nonce goes up by exactly one.
    function assertTransferred(TransferRequest memory r, State memory before) internal view {
        State memory a = observe(r);
        assertEq(a.fromBalance, expectedBalance(r, r.from, before.fromBalance), "from balance");
        assertEq(a.toBalance, expectedBalance(r, r.to, before.toBalance), "to balance");
        assertEq(a.relayBalance, expectedBalance(r, r.relay, before.relayBalance), "relay balance");
        assertEq(a.contractBalance, before.contractBalance, "contract balance");
        assertEq(a.supply, before.supply, "supply");
        assertEq(a.nonce, before.nonce + 1, "nonce not raised by exactly one");
    }

    function expectedBalance(TransferRequest memory r, address account, uint256 balanceBefore)
        internal
        pure
        returns (uint256 balance)
    {
        balance = balanceBefore;
        if (account == r.from) balance -= r.amount + r.fee;
        if (account == r.to) balance += r.amount;
        if (account == r.relay) balance += r.fee;
    }

    function observeVictim() internal view returns (VictimState memory s) {
        s.usdcBalance = usdc.balanceOf(victim);
        s.usdtBalance = usdt.balanceOf(victim);
        s.usdcAllowance = usdc.allowance(victim, address(gasless));
        s.usdtAllowance = usdt.allowance(victim, address(gasless));
        s.usdcNonce = usdc.nonces(victim);
        s.usdtNonce = usdt.nonces(victim);
        s.contractUsdc = usdc.balanceOf(address(gasless));
        s.contractUsdt = usdt.balanceOf(address(gasless));
        s.nonce = gasless.nonces(victim);
    }

    function assertVictimUntouched(VictimState memory before) internal view {
        VictimState memory a = observeVictim();
        assertEq(a.usdcBalance, before.usdcBalance, "victim USDC balance changed");
        assertEq(a.usdtBalance, before.usdtBalance, "victim USDT0 balance changed");
        assertEq(a.usdcAllowance, before.usdcAllowance, "victim USDC allowance changed");
        assertEq(a.usdtAllowance, before.usdtAllowance, "victim USDT0 allowance changed");
        assertEq(a.usdcNonce, before.usdcNonce, "victim USDC permit nonce changed");
        assertEq(a.usdtNonce, before.usdtNonce, "victim USDT0 nonce changed");
        assertEq(a.contractUsdc, before.contractUsdc, "contract USDC balance changed");
        assertEq(a.contractUsdt, before.contractUsdt, "contract USDT0 balance changed");
        assertEq(a.nonce, before.nonce, "victim intent nonce changed");
    }

    // ---------------------------------------------------------------- expected errors (IGaslessBase)

    function errInvalidSignature() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InvalidSignature.selector);
    }

    function errInvalidSigner() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InvalidSigner.selector);
    }

    function errNotRelay(address caller, address signedRelay) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.NotRelay.selector, caller, signedRelay);
    }

    function errDeadlineExpired(uint256 deadline) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.DeadlineExpired.selector, deadline);
    }

    function errInvalidNonceIncrease(uint256 current, uint256 newNonce) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InvalidNonceIncrease.selector, current, newNonce);
    }

    function errTokenNotSupported(address token) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.TokenNotSupported.selector, token);
    }

    function errAuthModeNotSupported(address token, AuthMode mode) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, token, mode);
    }

    function errInsufficientAllowance(uint256 current, uint256 required) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InsufficientAllowance.selector, current, required);
    }

    function errZeroAmount() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.ZeroAmount.selector);
    }

    function errInvalidRecipient(address to) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InvalidRecipient.selector, to);
    }

    function errInvalidConfig() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IGaslessBase.InvalidConfig.selector);
    }
}
