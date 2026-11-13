// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";

import {AuthMode, IGaslessBase, TokenAuth, TokenConfig, TokenInit} from "../../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../../src/interfaces/IGaslessTransfer.sol";

import {SpecDigests} from "../SpecDigests.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockUSDT0} from "../mocks/MockUSDT0.sol";

interface IHandlerToken {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function nonces(address owner) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function mint(address to, uint256 amount) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @notice OpenZeppelin Ownable2Step, which the frozen interfaces do not repeat (§4.2).
interface IHandlerOwnable {
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OwnableUnauthorizedAccount(address account);

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function renounceOwnership() external;
}

/// @notice Stateful fuzzing handler for the invariants TI1-TI5 (docs/STEP-1-GAS-ABSTRACTION.md §3) and the owner's
///         token configuration (D6, §4.2).
///         Honest users sign transfers in every (token, mode) route at their current nonce, sometimes front-run by an
///         attacker; an attacker with its own relay tries to spend a max-approved victim that never signs, replays
///         executed requests, alters signed fields (including the nonce and the token authorization), submits
///         through the wrong relay or after the deadline, and raises nonces. Users also donate tokens to the
///         contract, hold standing allowances to it, sign requests with token authorizations that do not authorize
///         them, and time moves on.
///         In between, the owner adds, replaces and removes token configurations (also of two tokens outside the
///         initial set), sometimes between a request's signature and its submission, and hands ownership on in two
///         steps or, rarely, renounces it; other accounts and invalid configurations try the same. The handler keeps a
///         ghost copy of what the owner set and judges every validly signed request against it, never against the
///         contract's own tokenConfig(): such a request executes exactly when the ghost configuration at call time
///         allows its token and mode, whatever its fee, and is otherwise refused with that configuration's error.
///         Forged, altered, replayed, misrouted and expired submissions only have to revert.
///         The owner makes three of four calls of setTokenConfig, of the reconfiguration between signature and
///         submission and of transferOwnership; while a transfer is pending, the pending owner makes five of eight
///         calls of acceptOwnership; the owner renounces in one renounceOwnership call of RENOUNCE_ODDS. ownerCalls
///         counts the calls that took effect (the ghost followed them: a configuration set, an ownership step); the
///         rate self-tests require the rates these give for seeds over the whole uint256 range and of every bit length,
///         and the variety self-tests the rates of the modes of the configurations set.
///         The handler keeps the expected balance of every account: it changes only when a request signed by the
///         debited account is consumed (or the account itself sends a donation). It keeps the expected nonce of every
///         account: +1 per executed request, raised only by the account itself. It never reverts; anything that
///         contradicts the spec is counted in a violation counter that the invariant functions assert to be 0.
contract GaslessHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant USERS = 4;
    uint256 internal constant TOKENS = 4;
    uint256 internal constant INITIAL = 100_000e6;
    /// @dev The largest fee of seven requests in eight (5.00 of a 6-decimal token).
    uint256 internal constant MAX_TEST_FEE = 5_000_000;
    /// @dev The largest fee a user signs (one request in eight signs a fee above MAX_TEST_FEE): above 2^32, where a fee
    ///      truncated to 32 bits differs, and less than a fifth of a user's initial balance.
    uint256 internal constant MAX_LARGE_FEE = 2 ** 34;
    /// @dev The owner renounces in one renounceOwnership call in this many (see renounces).
    uint256 internal constant RENOUNCE_ODDS = 16;
    uint256 internal constant POLYGON = 137;
    uint256 internal constant MAX_NONCE_INCREASE = type(uint32).max;
    bytes32 internal constant TRANSFER_EVENT = keccak256("Transfer(address,address,uint256)");

    IGaslessTransfer public gasless;
    MockUSDC public usdc;
    MockUSDT0 public usdt;
    /// @dev usdc, usdt, then a USDC and a USDT0 mock outside the initial configuration, which only the owner can add.
    address[TOKENS] public tokens;
    /// @dev The tokens, an address without code and the contract itself: everything setTokenConfig is called for.
    address[TOKENS + 2] public configTargets;

    address[] public users;
    uint256[] internal userKeys;
    address[2] public relays;
    address public victim;
    address public attacker;
    uint256 internal attackerKey;
    address public outsider;
    address[] public tracked;
    /// @dev The initial owner and the two accounts ownership can move to; the attacker never owns.
    address[3] public ownerCandidates;

    struct Executed {
        TransferRequest r;
        bytes sig;
        TokenAuth auth;
    }

    /// @dev What a relayTransfer may change, read before the call.
    struct Observed {
        uint256 from;
        uint256 to;
        uint256 relay;
        uint256 held;
        uint256 allowance;
        uint256 nonce;
    }

    mapping(address token => mapping(address account => uint256)) public expectedBalance;
    /// @dev A user's allowance to the contract between calls: its standing approval, 0 after any successful call.
    mapping(address token => mapping(address account => uint256)) public expectedAllowance;
    mapping(address token => uint256) public donated;
    mapping(address account => uint256) public expectedNonce;
    Executed[] internal executed;

    /// @dev Ghost copy of what the owner set: the initial configuration, then every setTokenConfig that had to succeed.
    mapping(address token => TokenConfig) internal ghostConfigs;
    address public ghostOwner;
    address public ghostPendingOwner;

    // Violation counters (must stay 0) and activity counters.
    uint256 public forgedSuccesses;
    uint256 public validFailures;
    uint256 public ti1Violations;
    uint256 public ti3Violations;
    uint256 public ti5Violations;
    /// @dev A request executed although the ghost configuration refuses it, or was refused otherwise than it.
    uint256 public configMismatches;
    /// @dev An owner action ended otherwise than Ownable2Step and §4.2 define for the ghost owner and configuration.
    uint256 public ownerViolations;
    /// @dev An owner action changed a balance, an allowance, a token nonce or an intent nonce.
    uint256 public ownerSideEffects;
    /// @dev The contract's events differ from the action: exactly one TransferRelayed, after every token log, for an
    ///      executed relayTransfer (D13), none for a failed call, exactly one NonceInvalidated, TokenConfigSet,
    ///      OwnershipTransferStarted or OwnershipTransferred otherwise.
    uint256 public eventViolations;
    bytes public lastValidFailure;
    uint256 public validSuccesses;
    uint256 public frontRuns;
    uint256 public forgedAttempts;
    uint256 public invalidations;
    uint256 public donations;
    uint256 public standingRefusals; // PERMIT / META_TX calls refused over a standing allowance other than amount + fee
    uint256 public configRefusals;
    uint256 public reconfigurations;
    uint256 public ownerRefusals;
    uint256 public ownershipMoves;
    /// @dev Calls of the owner actions (setTokenConfig, transferAcrossReconfiguration and the three Ownable2Step steps).
    uint256 public ownerActions;
    /// @dev Calls of the contract's owner functions by the account allowed to make them (the owner, or the pending
    ///      owner accepting) that took effect: the ghost followed them.
    uint256 public ownerCalls;
    /// @dev The target of the last configuration the owner set (the ghost followed it); the variety self-tests read its
    ///      tokenConfig().
    address public lastConfigured;

    constructor(
        IGaslessTransfer gasless_,
        MockUSDC usdc_,
        MockUSDT0 usdt_,
        address owner_,
        TokenInit[] memory initial
    ) {
        gasless = gasless_;
        usdc = usdc_;
        usdt = usdt_;
        tokens = [address(usdc_), address(usdt_), address(new MockUSDC()), address(new MockUSDT0())];
        configTargets = [tokens[0], tokens[1], tokens[2], tokens[3], makeAddr("inv-no-code"), address(gasless_)];
        for (uint256 i = 0; i < initial.length; ++i) {
            ghostConfigs[initial[i].token] = initial[i].config;
        }
        ghostOwner = owner_;
        ownerCandidates = [owner_, makeAddr("inv-owner-1"), makeAddr("inv-owner-2")];

        for (uint256 i = 0; i < USERS; ++i) {
            (address user, uint256 key) = makeAddrAndKey(string.concat("inv-user-", vm.toString(i)));
            users.push(user);
            userKeys.push(key);
            tracked.push(user);
            _fund(user);
        }
        relays[0] = makeAddr("inv-relay-0");
        relays[1] = makeAddr("inv-relay-1");
        tracked.push(relays[0]);
        tracked.push(relays[1]);

        address victim_ = makeAddr("inv-victim");
        victim = victim_;
        _fund(victim_);
        tracked.push(victim_);
        vm.startPrank(victim_);
        for (uint256 t = 0; t < TOKENS; ++t) {
            IHandlerToken(tokens[t]).approve(address(gasless_), type(uint256).max);
        }
        vm.stopPrank();

        (address attacker_, uint256 attackerKey_) = makeAddrAndKey("inv-attacker");
        attacker = attacker_;
        attackerKey = attackerKey_;
        _fund(attacker_);
        tracked.push(attacker_);

        address outsider_ = makeAddr("inv-outsider");
        outsider = outsider_;
        tracked.push(outsider_);
    }

    // ================================================================ actions (fuzzer entry points)

    /// @notice A user signs a valid request in any route; optionally the attacker front-runs its token authorization.
    function transferValid(
        uint256 userSeed,
        uint256 toSeed,
        uint256 relaySeed,
        uint256 routeSeed,
        uint256 amountSeed,
        uint256 feeSeed,
        uint256 ttlSeed,
        bool frontRun
    ) external {
        (TransferRequest memory r, uint256 key, AuthMode mode, bool ok) =
            _newRequest(userSeed, toSeed, relaySeed, routeSeed, amountSeed, feeSeed, ttlSeed);
        if (!ok) return;
        TokenAuth memory auth = _authorize(key, r, mode);
        bytes memory sig = _signNow(key, r, auth);
        if (frontRun && mode != AuthMode.NONE) _frontRun(r, auth);
        _executeValid(r, sig, auth);
    }

    /// @notice A signed request is submitted with exactly one signed input altered (a request field, the nonce, the
    ///         token authorization, or a relay rewriting itself into the request); it must revert. The original request
    ///         then executes normally.
    function transferMutated(uint256 userSeed, uint256 routeSeed, uint256 field, uint256 value, uint256 amountSeed)
        external
    {
        (TransferRequest memory r, uint256 key, AuthMode mode, bool ok) =
            _newRequest(userSeed, 0, value, routeSeed, amountSeed, value, value);
        if (!ok) return;
        TokenAuth memory auth = _authorize(key, r, mode);
        bytes memory sig = _signNow(key, r, auth);
        _expectMutationFails(field % 11, value, r, key, auth, sig);
        _executeValid(r, sig, auth);
    }

    function _expectMutationFails(
        uint256 field,
        uint256 value,
        TransferRequest memory r,
        uint256 key,
        TokenAuth memory auth,
        bytes memory sig
    ) private {
        TransferRequest memory m = _copy(r);
        TokenAuth memory a = TokenAuth({mode: auth.mode, v: auth.v, r: auth.r, s: auth.s});
        if (field == 6) sig = _sign(key, _digest(r, gasless.nonces(r.from) + 1 + value % 3, auth));
        else if (field == 8) a.mode = AuthMode((uint8(auth.mode) + 1 + value % 2) % 3);
        else if (field == 9) a.v = auth.v ^ uint8(1 + value % 255);
        else if (field == 10) a.r = bytes32(uint256(auth.r) ^ (value | 1));
        else _mutateRequest(m, field, value);
        _expectFailure(field == 5 ? attacker : r.relay, m, sig, a);
    }

    /// @dev One request field of `m` altered: 0 token, 1 from, 2 to, 3 amount, 4 fee, 5 relay, 7 deadline.
    function _mutateRequest(TransferRequest memory m, uint256 field, uint256 value) private view {
        if (field == 0) m.token = m.token == address(usdc) ? address(usdt) : address(usdc);
        else if (field == 1) m.from = victim;
        else if (field == 2) m.to = attacker == m.to ? outsider : attacker;
        else if (field == 3) m.amount += 1 + (value % 1000e6);
        else if (field == 4) m.fee = m.fee == MAX_TEST_FEE ? 0 : m.fee + 1;
        else if (field == 5) m.relay = attacker;
        else m.deadline += 1 + (value % 1 days);
    }

    /// @notice The attacker tries to spend the max-approved victim, who never signed anything, in any route.
    function forgeAgainstVictim(
        uint256 routeSeed,
        uint256 variant,
        uint256 amountSeed,
        bytes32 sigR,
        bytes32 sigS,
        uint8 sigV
    ) external {
        (address token, AuthMode mode) = _route(routeSeed);
        uint256 balance = IHandlerToken(token).balanceOf(victim);
        if (balance <= MAX_TEST_FEE) return;
        TransferRequest memory r = TransferRequest({
            token: token,
            from: victim,
            to: attacker,
            amount: bound(amountSeed, 1, balance - MAX_TEST_FEE),
            fee: MAX_TEST_FEE,
            relay: attacker,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
        TokenAuth memory auth = TokenAuth({mode: mode, v: sigV, r: sigR, s: sigS});
        bytes memory sig;
        uint256 k = variant % 5;
        if (k == 0) {
            sig = "";
        } else if (k == 1) {
            sig = abi.encodePacked(sigR, sigS, sigV);
        } else if (k == 2) {
            sig = _signNow(attackerKey, r, auth);
        } else if (k == 3) {
            sig = _signNow(userKeys[variant % USERS], r, auth);
        } else if (executed.length > 0) {
            // A genuine signature of some user, for another request.
            sig = executed[variant % executed.length].sig;
        }
        _expectFailure(attacker, r, sig, auth);
    }

    /// @notice An executed request is submitted again, by its relay or by the other relay.
    function replay(uint256 index, bool viaOtherRelay) external {
        if (executed.length == 0) return;
        Executed memory e = executed[index % executed.length];
        address caller = viaOtherRelay ? (e.r.relay == relays[0] ? relays[1] : relays[0]) : e.r.relay;
        _expectFailure(caller, e.r, e.sig, e.auth);
    }

    /// @notice A valid request goes through the wrong relay, or arrives after its deadline.
    function wrongRelayOrExpired(uint256 userSeed, uint256 routeSeed, uint256 amountSeed, bool expired) external {
        (TransferRequest memory r, uint256 key, AuthMode mode, bool ok) =
            _newRequest(userSeed, 0, 0, routeSeed, amountSeed, 0, 0);
        if (!ok) return;
        address caller = r.relay;
        if (expired) {
            vm.warp(vm.getBlockTimestamp() + 1);
            r.deadline = vm.getBlockTimestamp() - 1;
        } else {
            caller = relays[1];
        }
        TokenAuth memory auth = _authorize(key, r, mode);
        _expectFailure(caller, r, _signNow(key, r, auth), auth);
        if (mode == AuthMode.NONE) _approveStanding(r.from, r.token, 0);
    }

    /// @notice A user raises its own nonce; or the attacker raises its own nonce, which must not touch the user's.
    ///         A valid value emits NonceInvalidated; an invalid one (not above the current nonce, or more than 2^32 - 1
    ///         above it) reverts InvalidNonceIncrease and changes nothing.
    function invalidate(uint256 userSeed, uint256 step, bool byAttacker) external {
        address user = users[userSeed % USERS];
        address caller = byAttacker ? attacker : user;
        uint256 current = expectedNonce[caller];
        uint256 userBefore = gasless.nonces(user);
        bytes32 balancesBefore = _balances(caller);
        uint256 newNonce;
        if (step % 4 == 0) newNonce = current - (step / 4) % (current + 1);
        else if (step % 16 == 3) newNonce = current + MAX_NONCE_INCREASE + 1 + (step / 16) % 1000;
        else newNonce = current + bound(step, 1, MAX_NONCE_INCREASE);
        bool valid = newNonce > current && newNonce - current <= MAX_NONCE_INCREASE;

        vm.recordLogs();
        vm.prank(caller);
        try gasless.invalidateNonces(newNonce) {
            if (!valid) ++ti3Violations;
            expectedNonce[caller] = newNonce;
            _expectLog(_topics(IGaslessBase.NonceInvalidated.selector, caller), abi.encode(current, newNonce));
        } catch (bytes memory err) {
            _expectNoLog();
            if (valid) {
                ++validFailures;
                lastValidFailure = err;
            } else if (
                keccak256(err)
                    != keccak256(abi.encodeWithSelector(IGaslessBase.InvalidNonceIncrease.selector, current, newNonce))
            ) {
                ++ti3Violations;
            }
        }
        ++invalidations;

        if (gasless.nonces(caller) != expectedNonce[caller]) ++ti3Violations;
        if (byAttacker && gasless.nonces(user) != userBefore) ++ti3Violations;
        if (_balances(caller) != balancesBefore) ++ti1Violations;
    }

    /// @notice A user sends tokens straight to the contract (a donation; TI4 allows exactly these).
    function donate(uint256 userSeed, uint256 routeSeed, uint256 amountSeed) external {
        address user = users[userSeed % USERS];
        (address token,) = _route(routeSeed);
        uint256 balance = IHandlerToken(token).balanceOf(user);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance < 10e6 ? balance : 10e6);
        vm.prank(user);
        IHandlerToken(token).transfer(address(gasless), amount);
        expectedBalance[token][user] -= amount;
        donated[token] += amount;
        ++donations;
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 0, 1 days));
    }

    /// @notice A user approves the contract directly (a standing allowance, as NONE mode uses): unlimited, some amount
    ///         or 0.
    function approveStanding(uint256 userSeed, uint256 routeSeed, uint256 amountSeed) external {
        (address token,) = _route(routeSeed);
        uint256 k = amountSeed % 3;
        uint256 amount = k == 0 ? type(uint256).max : (k == 1 ? bound(amountSeed, 1, 5000e6) : 0);
        _approveStanding(users[userSeed % USERS], token, amount);
    }

    /// @notice A user holds a standing allowance (exactly amount + fee, one unit less or more, unlimited, or none) and
    ///         signs a request in PERMIT or META_TX mode with a token authorization that does not authorize it (junk;
    ///         another value, spender or signer; a token nonce the user's next permit uses up first). Only exactly
    ///         amount + fee pays for it (what a front-run of the request's own authorization leaves) and is used up
    ///         (TI5); any other standing allowance stays untouched and the call reverts InsufficientAllowance(standing,
    ///         amount + fee) (T18), or with the refusal of the owner's configuration, whose checks come first.
    function transferRejectedAuth(
        uint256 userSeed,
        uint256 routeSeed,
        uint256 amountSeed,
        uint256 standingSeed,
        uint256 kindSeed
    ) external {
        (TransferRequest memory r, uint256 key, AuthMode mode, bool ok) =
            _newRequest(userSeed, kindSeed >> 8, userSeed >> 8, routeSeed, amountSeed, kindSeed >> 16, 1 hours);
        if (!ok) return;
        if (mode == AuthMode.NONE) mode = AuthMode.PERMIT;
        TokenAuth memory auth = _rejectedAuth(key, r, mode, kindSeed);
        bytes memory sig = _signNow(key, r, auth);
        uint256 required = r.amount + r.fee;
        uint256 standing = _standingFor(required, standingSeed);
        _approveStanding(r.from, r.token, standing);
        if (standing == required) {
            _executeValid(r, sig, auth);
            return;
        }
        _expectRejected(r, sig, auth, standing);
    }

    // ================================================================ owner actions (§4.2, D6)

    /// @dev Counts a call of an owner action. The first one of a run starts with the owner's own setTokenConfig of one
    ///      of the four tokens, with a configuration from `seed` (every mode, random modes or none): every run reaches
    ///      the owner's paths, whichever callers the fuzzer picks (afterInvariant). That the owner acts at its rate in
    ///      the calls after it, whatever the seeds, is up to the rate self-tests.
    modifier ownerAction(uint256 seed) {
        if (ownerActions++ == 0) {
            address token = tokens[seed % TOKENS];
            _setTokenConfig(ghostOwner, token, _newConfig(token, seed >> 2));
        }
        _;
    }

    /// @notice The owner, or (one call in four, and every call after a renounce) another account, sets the
    ///         configuration of a token, also of one outside the initial set, of an address without code or of the
    ///         contract itself: every mode the token supports, random modes, or none (removed). Modes for the address
    ///         without code or the contract itself are an invalid configuration.
    function setTokenConfig(uint256 callerSeed, uint256 targetSeed, uint256 kindSeed)
        external
        ownerAction(callerSeed >> 4)
    {
        address target = targetSeed % 10 < 8 ? tokens[targetSeed % TOKENS] : configTargets[TOKENS + targetSeed % 2];
        _setTokenConfig(_ownerCaller(callerSeed), target, _newConfig(target, kindSeed));
    }

    /// @notice A user signs a valid request; before the relay submits it, the owner (or another account) reconfigures
    ///         its token. The configuration at call time decides (D6): a request signed while its token or mode was
    ///         refused executes once the owner allows it, and one signed while allowed is refused after a change.
    function transferAcrossReconfiguration(
        uint256 userSeed,
        uint256 routeSeed,
        uint256 amountSeed,
        uint256 feeSeed,
        uint256 kindSeed
    ) external ownerAction(kindSeed >> 12) {
        (TransferRequest memory r, uint256 key, AuthMode mode, bool ok) =
            _newRequest(userSeed, userSeed >> 8, feeSeed >> 8, routeSeed, amountSeed, feeSeed, 1 hours);
        if (!ok) return;
        TokenAuth memory auth = _authorize(key, r, mode);
        bytes memory sig = _signNow(key, r, auth);
        _setTokenConfig(_ownerCaller(kindSeed >> 8), r.token, _newConfig(r.token, kindSeed));
        _executeValid(r, sig, auth);
    }

    /// @notice Ownable2Step's first step, by the owner or another account: a candidate becomes the pending owner, or
    ///         address(0) cancels the pending transfer.
    function transferOwnership(uint256 callerSeed, uint256 newOwnerSeed) external ownerAction(newOwnerSeed >> 2) {
        address caller = _ownerCaller(callerSeed);
        address next = newOwnerSeed % 4 == 3 ? address(0) : ownerCandidates[newOwnerSeed % 4];
        bool allowed = ghostOwner != address(0) && caller == ghostOwner;
        bytes32 fundsBefore = _funds();
        vm.recordLogs();
        vm.prank(caller);
        try IHandlerOwnable(address(gasless)).transferOwnership(next) {
            if (allowed) {
                _expectLog(_topics(IHandlerOwnable.OwnershipTransferStarted.selector, caller, next), "");
                ghostPendingOwner = next;
                ++ownerCalls;
            } else {
                ++ownerViolations;
            }
        } catch (bytes memory err) {
            _expectOwnerRefusal(allowed, err, _unauthorized(caller));
        }
        _checkOwnerAction(fundsBefore);
    }

    /// @notice Ownable2Step's second step: the pending owner accepts, or another account (a former owner, a candidate,
    ///         the attacker) tries to. Only the pending owner can, and nobody after a renounce.
    function acceptOwnership(uint256 callerSeed) external ownerAction(callerSeed >> 8) {
        address caller =
            callerSeed % 2 == 0 && ghostPendingOwner != address(0) ? ghostPendingOwner : _anyone(callerSeed >> 1);
        bool allowed = ghostPendingOwner != address(0) && caller == ghostPendingOwner;
        bytes32 fundsBefore = _funds();
        vm.recordLogs();
        vm.prank(caller);
        try IHandlerOwnable(address(gasless)).acceptOwnership() {
            if (allowed) {
                _expectLog(_topics(IHandlerOwnable.OwnershipTransferred.selector, ghostOwner, caller), "");
                ghostOwner = caller;
                ghostPendingOwner = address(0);
                ++ownershipMoves;
                ++ownerCalls;
            } else {
                ++ownerViolations;
            }
        } catch (bytes memory err) {
            _expectOwnerRefusal(allowed, err, _unauthorized(caller));
        }
        _checkOwnerAction(fundsBefore);
    }

    /// @notice The owner renounces (one call in RENOUNCE_ODDS, see renounces), which fixes the configuration and the
    ///         ownership for the rest of the run; or another account tries to.
    function renounceOwnership(uint256 callerSeed) external ownerAction(callerSeed >> 8) {
        address caller = _anyone(callerSeed >> 3);
        if (renounces(callerSeed) && ghostOwner != address(0)) caller = ghostOwner;
        else if (caller == ghostOwner) caller = attacker;
        bool allowed = ghostOwner != address(0) && caller == ghostOwner;
        bytes32 fundsBefore = _funds();
        vm.recordLogs();
        vm.prank(caller);
        try IHandlerOwnable(address(gasless)).renounceOwnership() {
            if (allowed) {
                _expectLog(_topics(IHandlerOwnable.OwnershipTransferred.selector, caller, address(0)), "");
                ghostOwner = address(0);
                ghostPendingOwner = address(0);
                ++ownerCalls;
            } else {
                ++ownerViolations;
            }
        } catch (bytes memory err) {
            _expectOwnerRefusal(allowed, err, _unauthorized(caller));
        }
        _checkOwnerAction(fundsBefore);
    }

    // ================================================================ views for the invariant functions

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function userCount() external view returns (uint256) {
        return users.length;
    }

    function tokenCount() external pure returns (uint256) {
        return TOKENS;
    }

    function configTargetCount() external pure returns (uint256) {
        return TOKENS + 2;
    }

    /// @notice The configuration the owner set for `token` (the ghost copy).
    function ghostConfig(address token) external view returns (TokenConfig memory) {
        return ghostConfigs[token];
    }

    /// @notice Whether the owner renounces on renounceOwnership(seed): for one seed in RENOUNCE_ODDS. A hash of the
    ///         seed decides, not the seed modulo a power of two, which the fuzzer's dictionary and edge values hit far
    ///         more often than that rate; a renounce freezes the rest of the run.
    function renounces(uint256 seed) public pure returns (bool) {
        return uint256(keccak256(abi.encode("renounce", seed))) % RENOUNCE_ODDS == 0;
    }

    // ================================================================ internals

    function _newRequest(
        uint256 userSeed,
        uint256 toSeed,
        uint256 relaySeed,
        uint256 routeSeed,
        uint256 amountSeed,
        uint256 feeSeed,
        uint256 ttlSeed
    ) internal view returns (TransferRequest memory r, uint256 key, AuthMode mode, bool ok) {
        key = userKeys[userSeed % USERS];
        r.from = users[userSeed % USERS];
        (r.token, mode) = _route(routeSeed);
        r.fee = _pickFee(IHandlerToken(r.token).balanceOf(r.from), feeSeed);
        ok = _pickAmount(r, amountSeed);
        r.to = tracked[toSeed % tracked.length];
        r.relay = relays[relaySeed % 2];
        r.deadline = vm.getBlockTimestamp() + bound(ttlSeed, 0, 2 hours);
    }

    /// @dev Up to MAX_TEST_FEE, or (one call in eight, if the balance allows) above it, up to MAX_LARGE_FEE: no
    ///      configuration bounds the fee, so every signed fee must be paid exactly.
    function _pickFee(uint256 balance, uint256 feeSeed) internal pure returns (uint256) {
        if (feeSeed % 8 != 7 || balance <= MAX_TEST_FEE + 1) return bound(feeSeed, 0, MAX_TEST_FEE);
        return bound(feeSeed >> 3, MAX_TEST_FEE + 1, _min(balance - 1, MAX_LARGE_FEE));
    }

    /// @dev Up to 1,000 tokens, or (one call in eight) the whole balance minus the fee, like an ephemeral key (§4.5).
    function _pickAmount(TransferRequest memory r, uint256 amountSeed) internal view returns (bool) {
        uint256 balance = IHandlerToken(r.token).balanceOf(r.from);
        if (balance <= r.fee) return false;
        r.amount = amountSeed % 8 == 0 ? balance - r.fee : bound(amountSeed, 1, _min(balance - r.fee, 1000e6));
        return true;
    }

    /// @dev Submits a request `from` signed and authorized as §5 prescribes. The ghost configuration at call time
    ///      decides: if it allows the token and mode, the request executes exactly (TI1), whatever its fee; otherwise
    ///      it reverts with the configuration's error (§4.3 step 2) and changes nothing.
    function _executeValid(TransferRequest memory r, bytes memory sig, TokenAuth memory auth) internal {
        bytes memory refusal = _refusal(r.token, auth.mode);
        Observed memory before = _observe(r);

        vm.recordLogs();
        vm.prank(r.relay);
        try gasless.relayTransfer(r, sig, auth) {
            _checkTransferLogs(r, before.nonce, auth);
            if (refusal.length != 0) ++configMismatches; // executed although the owner's configuration refuses it
            _book(r, sig, auth, before);
        } catch (bytes memory err) {
            _expectNoLog();
            if (refusal.length == 0) {
                if (_isConfigError(err)) ++configMismatches; // refused although the configuration allows it
                ++validFailures;
                lastValidFailure = err;
            } else {
                if (keccak256(err) != keccak256(refusal)) ++configMismatches;
                ++configRefusals;
            }
            if (IHandlerToken(r.token).allowance(r.from, address(gasless)) != before.allowance) ++ti5Violations;
            if (gasless.nonces(r.from) != expectedNonce[r.from]) ++ti3Violations;
            // The request stays signed and valid until its nonce is used; clear the exact allowance it was authorized
            // with (NONE, or a front-run token authorization) so that the allowance cannot pay it later.
            _approveStanding(r.from, r.token, 0);
        }
    }

    /// @dev TI1 around an executed request, then the ghost state books it.
    function _book(TransferRequest memory r, bytes memory sig, TokenAuth memory auth, Observed memory before) internal {
        IHandlerToken token = IHandlerToken(r.token);
        ++validSuccesses;
        if (before.nonce != expectedNonce[r.from] || gasless.nonces(r.from) != before.nonce + 1) ++ti1Violations;
        if (token.balanceOf(r.from) != _after(r, r.from, before.from)) ++ti1Violations;
        if (token.balanceOf(r.to) != _after(r, r.to, before.to)) ++ti1Violations;
        if (token.balanceOf(r.relay) != _after(r, r.relay, before.relay)) ++ti1Violations;
        if (token.balanceOf(address(gasless)) != before.held) ++ti1Violations;
        if (token.allowance(r.from, address(gasless)) != 0) ++ti5Violations;
        expectedAllowance[r.token][r.from] = 0;
        expectedNonce[r.from] = before.nonce + 1;

        expectedBalance[r.token][r.from] -= r.amount + r.fee;
        expectedBalance[r.token][r.to] += r.amount;
        expectedBalance[r.token][r.relay] += r.fee;
        executed.push(Executed(r, sig, auth));
    }

    function _observe(TransferRequest memory r) internal view returns (Observed memory o) {
        IHandlerToken token = IHandlerToken(r.token);
        o.from = token.balanceOf(r.from);
        o.to = token.balanceOf(r.to);
        o.relay = token.balanceOf(r.relay);
        o.held = token.balanceOf(address(gasless));
        o.allowance = token.allowance(r.from, address(gasless));
        o.nonce = gasless.nonces(r.from);
    }

    function _expectFailure(address caller, TransferRequest memory r, bytes memory sig, TokenAuth memory auth)
        internal
    {
        ++forgedAttempts;
        vm.recordLogs();
        vm.prank(caller);
        try gasless.relayTransfer(r, sig, auth) {
            ++forgedSuccesses;
        } catch {}
        _expectNoLog();
        if (gasless.nonces(r.from) != expectedNonce[r.from]) ++ti3Violations;
    }

    /// @dev A PERMIT / META_TX request whose token authorization does not authorize it, over a standing allowance other
    ///      than amount + fee: it reverts with the refusal of the ghost configuration if there is one (its checks come
    ///      first, §4.3), otherwise InsufficientAllowance(standing, amount + fee); the allowance stays untouched.
    function _expectRejected(TransferRequest memory r, bytes memory sig, TokenAuth memory auth, uint256 standing)
        internal
    {
        bytes memory refusal = _refusal(r.token, auth.mode);
        bytes memory expected = refusal.length != 0
            ? refusal
            : abi.encodeWithSelector(IGaslessBase.InsufficientAllowance.selector, standing, r.amount + r.fee);
        ++forgedAttempts;
        vm.recordLogs();
        vm.prank(r.relay);
        try gasless.relayTransfer(r, sig, auth) {
            ++forgedSuccesses; // paid from a standing allowance other than amount + fee
            if (refusal.length != 0) ++configMismatches;
        } catch (bytes memory err) {
            if (keccak256(err) != keccak256(expected)) {
                if (refusal.length != 0 || _isConfigError(err)) ++configMismatches;
                else ++ti5Violations;
            }
        }
        _expectNoLog();
        if (IHandlerToken(r.token).allowance(r.from, address(gasless)) != standing) ++ti5Violations;
        if (gasless.nonces(r.from) != expectedNonce[r.from]) ++ti3Violations;
        if (refusal.length != 0) ++configRefusals;
        else ++standingRefusals;
    }

    /// @dev The error the owner's configuration at call time refuses `token` in `mode` with (§4.3 step 2), or empty if
    ///      it allows them. It reads the ghost copy of what the owner set, never the contract's tokenConfig(), so that a
    ///      configuration the contract stored wrongly cannot fool the oracle.
    function _refusal(address token, AuthMode mode) internal view returns (bytes memory) {
        TokenConfig memory c = ghostConfigs[token];
        bool enabled =
            mode == AuthMode.PERMIT ? c.permit : mode == AuthMode.META_TX_APPROVE ? c.metaTxApprove : c.allowance;
        if (!enabled) {
            if (!c.permit && !c.metaTxApprove && !c.allowance) {
                return abi.encodeWithSelector(IGaslessBase.TokenNotSupported.selector, token);
            }
            return abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, token, mode);
        }
        return "";
    }

    function _isConfigError(bytes memory err) internal pure returns (bool) {
        if (err.length < 4) return false;
        bytes4 selector = bytes4(err);
        return
            selector == IGaslessBase.TokenNotSupported.selector
                || selector == IGaslessBase.AuthModeNotSupported.selector;
    }

    /// @dev `caller` calls setTokenConfig(token, c); the ghost follows only a call that must succeed.
    function _setTokenConfig(address caller, address token, TokenConfig memory c) internal {
        bytes memory refusal = _configError(caller, token, c);
        bytes32 fundsBefore = _funds();
        vm.recordLogs();
        vm.prank(caller);
        try gasless.setTokenConfig(token, c) {
            if (refusal.length == 0) {
                _expectLog(_topics(IGaslessBase.TokenConfigSet.selector, token), abi.encode(c));
                ghostConfigs[token] = c;
                ++reconfigurations;
                ++ownerCalls;
                lastConfigured = token;
            } else {
                ++ownerViolations;
            }
        } catch (bytes memory err) {
            _expectOwnerRefusal(refusal.length == 0, err, refusal);
        }
        _checkOwnerAction(fundsBefore);
    }

    /// @dev kindSeed % 8: 0-3 every mode the token supports; 4-6 random modes (bits 3-5; none: removed); 7 removed.
    function _newConfig(address token, uint256 kindSeed) internal view returns (TokenConfig memory c) {
        uint256 kind = kindSeed % 8;
        if (kind < 4) return TokenConfig({permit: true, metaTxApprove: !_isUsdc(token), allowance: true});
        if (kind == 7) return c;
        c.permit = (kindSeed >> 3) & 1 == 1;
        c.metaTxApprove = (kindSeed >> 4) & 1 == 1;
        c.allowance = (kindSeed >> 5) & 1 == 1;
    }

    /// @dev The error setTokenConfig must revert with (Ownable, then §4.2), or empty if it must succeed. A
    ///      configuration without any mode is valid for every address.
    function _configError(address caller, address token, TokenConfig memory c) internal view returns (bytes memory) {
        if (ghostOwner == address(0) || caller != ghostOwner) return _unauthorized(caller);
        bool enabled = c.permit || c.metaTxApprove || c.allowance;
        bool invalid = enabled && (token.code.length == 0 || token == address(gasless));
        return invalid ? abi.encodeWithSelector(IGaslessBase.InvalidConfig.selector) : bytes("");
    }

    function _unauthorized(address caller) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IHandlerOwnable.OwnableUnauthorizedAccount.selector, caller);
    }

    /// @dev The owner, or (one seed in four, and always after a renounce) another account.
    function _ownerCaller(uint256 seed) internal view returns (address) {
        if (seed % 4 != 0 && ghostOwner != address(0)) return ghostOwner;
        address other = _anyone(seed >> 2);
        return other == ghostOwner ? attacker : other;
    }

    /// @dev An owner candidate (the initial, a former, the current or the pending owner) or the attacker.
    function _anyone(uint256 seed) internal view returns (address) {
        uint256 k = seed % 4;
        return k < 3 ? ownerCandidates[k] : attacker;
    }

    function _expectOwnerRefusal(bool allowed, bytes memory err, bytes memory expected) internal {
        _expectNoLog();
        if (allowed || keccak256(err) != keccak256(expected)) ++ownerViolations;
        ++ownerRefusals;
    }

    /// @dev After an owner action: no balance, allowance or nonce moved (`fundsBefore`), and the owner and pending
    ///      owner are the ghost's.
    function _checkOwnerAction(bytes32 fundsBefore) internal {
        if (_funds() != fundsBefore) ++ownerSideEffects;
        IHandlerOwnable g = IHandlerOwnable(address(gasless));
        if (g.owner() != ghostOwner || g.pendingOwner() != ghostPendingOwner) ++ownerViolations;
    }

    /// @dev Every tracked account's balance, allowance to the contract and token nonce in every token, the contract's
    ///      own balances, and every tracked intent nonce, hashed.
    function _funds() internal view returns (bytes32 h) {
        for (uint256 t = 0; t < TOKENS; ++t) {
            IHandlerToken token = IHandlerToken(tokens[t]);
            h = keccak256(abi.encode(h, token.balanceOf(address(gasless))));
            for (uint256 i = 0; i < tracked.length; ++i) {
                address a = tracked[i];
                h = keccak256(abi.encode(h, token.balanceOf(a), token.allowance(a, address(gasless)), token.nonces(a)));
            }
        }
        for (uint256 i = 0; i < tracked.length; ++i) {
            h = keccak256(abi.encode(h, gasless.nonces(tracked[i])));
        }
    }

    function _balances(address account) internal view returns (bytes32 h) {
        for (uint256 t = 0; t < TOKENS; ++t) {
            h = keccak256(abi.encode(h, IHandlerToken(tokens[t]).balanceOf(account)));
        }
    }

    // ---------------------------------------------------------------- events

    /// @dev The contract logged exactly one event since vm.recordLogs(), with `topics` and `data`.
    function _expectLog(bytes32[] memory topics, bytes memory data) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(gasless)) continue;
            ++n;
            if (keccak256(abi.encode(logs[i].topics, logs[i].data)) != keccak256(abi.encode(topics, data))) {
                ++eventViolations;
            }
        }
        if (n != 1) ++eventViolations;
    }

    /// @dev The contract logged nothing since vm.recordLogs().
    function _expectNoLog() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(gasless)) ++eventViolations;
        }
    }

    /// @dev An executed request (§4.3 log order): the token's Transfer logs are the fee to the relay (only if fee > 0),
    ///      then the principal to `to`, and the contract's only log is the last one, TransferRelayed(from, nonce,
    ///      digest) with the spec's digest of the request at `nonce`.
    function _checkTransferLogs(TransferRequest memory r, uint256 nonce, TokenAuth memory auth) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 digest = _digest(r, nonce, auth);
        uint256 expected = r.fee > 0 ? 2 : 1;
        uint256 k;
        uint256 own;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(gasless)) {
                ++own;
                if (i + 1 != logs.length || !_isTransferRelayed(logs[i], r.from, nonce, digest)) ++eventViolations;
                continue;
            }
            if (logs[i].emitter != r.token || logs[i].topics.length == 0 || logs[i].topics[0] != TRANSFER_EVENT) {
                continue;
            }
            bool isFee = k == 0 && r.fee > 0;
            if (k >= expected || !_isTransfer(logs[i], r.from, isFee ? r.relay : r.to, isFee ? r.fee : r.amount)) {
                ++eventViolations;
            }
            ++k;
        }
        if (own != 1 || k != expected) ++eventViolations;
    }

    function _isTransferRelayed(Vm.Log memory log, address from, uint256 nonce, bytes32 digest)
        internal
        pure
        returns (bool)
    {
        return log.topics.length == 4 && log.topics[0] == IGaslessTransfer.TransferRelayed.selector
            && log.topics[1] == bytes32(uint256(uint160(from))) && log.topics[2] == bytes32(nonce)
            && log.topics[3] == digest && log.data.length == 0;
    }

    function _isTransfer(Vm.Log memory log, address from, address to, uint256 value) internal pure returns (bool) {
        return log.topics.length == 3 && log.topics[1] == bytes32(uint256(uint160(from)))
            && log.topics[2] == bytes32(uint256(uint160(to))) && keccak256(log.data) == keccak256(abi.encode(value));
    }

    function _topics(bytes32 signature, address a) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](2);
        t[0] = signature;
        t[1] = bytes32(uint256(uint160(a)));
    }

    function _topics(bytes32 signature, address a, address b) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](3);
        t[0] = signature;
        t[1] = bytes32(uint256(uint160(a)));
        t[2] = bytes32(uint256(uint160(b)));
    }

    // ---------------------------------------------------------------- token authorization

    /// @dev §5: spender = the contract, value = amount + fee, permit deadline = intent deadline. NONE: exact approve.
    function _authorize(uint256 key, TransferRequest memory r, AuthMode mode) internal returns (TokenAuth memory) {
        if (mode == AuthMode.PERMIT) return _signPermit(key, r);
        if (mode == AuthMode.META_TX_APPROVE) return _signMetaTx(key, r);
        vm.prank(r.from);
        IHandlerToken(r.token).approve(address(gasless), r.amount + r.fee);
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    function _signPermit(uint256 key, TransferRequest memory r) internal view returns (TokenAuth memory a) {
        uint256 tokenNonce = IHandlerToken(r.token).nonces(r.from);
        bytes32 hash = SpecDigests.permitDigest(
            _tokenDomain(r.token), r.from, address(gasless), r.amount + r.fee, tokenNonce, r.deadline
        );
        a.mode = AuthMode.PERMIT;
        (a.v, a.r, a.s) = vm.sign(key, hash);
    }

    function _signMetaTx(uint256 key, TransferRequest memory r) internal view returns (TokenAuth memory a) {
        bytes memory approveCall = SpecDigests.approveCalldata(address(gasless), r.amount + r.fee);
        bytes32 hash =
            SpecDigests.metaTxDigest(_tokenDomain(r.token), r.from, approveCall, MockUSDT0(r.token).getNonce(r.from));
        a.mode = AuthMode.META_TX_APPROVE;
        (a.v, a.r, a.s) = vm.sign(key, hash);
    }

    function _isUsdc(address token) internal view returns (bool) {
        return token == tokens[0] || token == tokens[2];
    }

    function _tokenDomain(address token) internal view returns (bytes32) {
        if (_isUsdc(token)) return SpecDigests.usdcDomain(block.chainid, token);
        return SpecDigests.usdt0Domain(POLYGON, token);
    }

    function _approveStanding(address user, address token, uint256 amount) internal {
        vm.prank(user);
        IHandlerToken(token).approve(address(gasless), amount);
        expectedAllowance[token][user] = amount;
    }

    /// @dev Exactly amount + fee (what a front-run token authorization leaves), one unit less or more, unlimited, or
    ///      none.
    function _standingFor(uint256 required, uint256 seed) internal pure returns (uint256) {
        uint256 k = seed % 5;
        if (k == 0) return required;
        if (k == 1) return required - 1;
        if (k == 2) return required + 1 + seed % 1000e6;
        if (k == 3) return type(uint256).max;
        return 0;
    }

    /// @dev A token authorization in `mode` that does not authorize `r`: junk; a permit / meta-tx for another value
    ///      (T18) or another spender; one signed by the attacker; one whose token nonce the user's next permit (to the
    ///      outsider) uses up first; a permit with another deadline (submitted as a meta-tx in META_TX mode).
    function _rejectedAuth(uint256 key, TransferRequest memory r, AuthMode mode, uint256 kindSeed)
        internal
        returns (TokenAuth memory a)
    {
        uint256 value = r.amount + r.fee;
        uint256 k = kindSeed % 6;
        if (k == 0) return TokenAuth({mode: mode, v: 28, r: keccak256(abi.encode(kindSeed)), s: bytes32(value)});
        if (k == 1) return _tokenAuth(key, r, mode, address(gasless), value + 1, r.deadline);
        if (k == 2) return _tokenAuth(key, r, mode, outsider, value, r.deadline);
        if (k == 3) return _tokenAuth(attackerKey, r, mode, address(gasless), value, r.deadline);
        if (k == 4) {
            a = _tokenAuth(key, r, mode, address(gasless), value, r.deadline);
            TokenAuth memory next = _tokenAuth(key, r, AuthMode.PERMIT, outsider, 1, r.deadline);
            IHandlerToken(r.token).permit(r.from, outsider, 1, r.deadline, next.v, next.r, next.s);
            return a;
        }
        a = _tokenAuth(key, r, AuthMode.PERMIT, address(gasless), value, r.deadline + 1);
        a.mode = mode;
    }

    /// @dev `r.from`'s token nonce, signed by `key`: a permit (spender, value, deadline) or a USDT0 meta-tx approve.
    function _tokenAuth(
        uint256 key,
        TransferRequest memory r,
        AuthMode mode,
        address spender,
        uint256 value,
        uint256 deadline
    ) internal view returns (TokenAuth memory a) {
        uint256 tokenNonce = IHandlerToken(r.token).nonces(r.from);
        bytes32 hash = mode == AuthMode.PERMIT
            ? SpecDigests.permitDigest(_tokenDomain(r.token), r.from, spender, value, tokenNonce, deadline)
            : SpecDigests.metaTxDigest(
                _tokenDomain(r.token), r.from, SpecDigests.approveCalldata(spender, value), tokenNonce
            );
        a.mode = mode;
        (a.v, a.r, a.s) = vm.sign(key, hash);
    }

    function _frontRun(TransferRequest memory r, TokenAuth memory auth) internal {
        uint256 value = r.amount + r.fee;
        vm.prank(attacker);
        if (auth.mode == AuthMode.PERMIT) {
            try IHandlerToken(r.token).permit(r.from, address(gasless), value, r.deadline, auth.v, auth.r, auth.s) {
                ++frontRuns;
            } catch {}
        } else {
            try MockUSDT0(r.token)
                .executeMetaTransaction(
                    r.from, SpecDigests.approveCalldata(address(gasless), value), auth.r, auth.s, auth.v
                ) {
                ++frontRuns;
            } catch {}
        }
    }

    /// @dev The five (token, mode) routes of §11 (seed % 5) on the initial tokens, or, for one seed in five
    ///      (seed / 5 % 5 == 4, e.g. 20 to 24), on the USDC and USDT0 mocks outside the initial configuration, which
    ///      refuse every request until the owner adds them.
    function _route(uint256 seed) internal view returns (address token, AuthMode mode) {
        uint256 base = seed / 5 % 5 == 4 ? 2 : 0;
        uint256 i = seed % 5;
        if (i == 0) return (tokens[base], AuthMode.PERMIT);
        if (i == 1) return (tokens[base], AuthMode.NONE);
        if (i == 2) return (tokens[base + 1], AuthMode.PERMIT);
        if (i == 3) return (tokens[base + 1], AuthMode.META_TX_APPROVE);
        return (tokens[base + 1], AuthMode.NONE);
    }

    function _fund(address account) internal {
        for (uint256 t = 0; t < TOKENS; ++t) {
            IHandlerToken(tokens[t]).mint(account, INITIAL);
            expectedBalance[tokens[t]][account] += INITIAL;
        }
    }

    function _digest(TransferRequest memory r, uint256 nonce, TokenAuth memory auth) internal view returns (bytes32) {
        return SpecDigests.transferDigest(r, nonce, auth, block.chainid, address(gasless));
    }

    /// @dev `key`'s signature over `r` and `auth` at `r.from`'s current nonce.
    function _signNow(uint256 key, TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, _digest(r, gasless.nonces(r.from), auth));
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _copy(TransferRequest memory r) internal pure returns (TransferRequest memory) {
        return TransferRequest(r.token, r.from, r.to, r.amount, r.fee, r.relay, r.deadline);
    }

    function _after(TransferRequest memory r, address account, uint256 before) internal pure returns (uint256 b) {
        b = before;
        if (account == r.from) b -= r.amount + r.fee;
        if (account == r.to) b += r.amount;
        if (account == r.relay) b += r.fee;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
