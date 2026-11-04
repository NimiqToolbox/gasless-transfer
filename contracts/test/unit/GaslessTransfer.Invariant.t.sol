// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Test, Vm} from "forge-std/Test.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, IGaslessBase, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockUSDT0} from "../mocks/MockUSDT0.sol";

/// @notice Drives GaslessTransfer with honest transfers in every (token, mode) and with attacks: unsigned pulls from
///         max-approved victims, signatures bound to another relay, replays, signatures for a past or future nonce,
///         and a relay that swaps the signed token authorization. Users also raise their nonces, hold standing
///         allowances, and sign requests with token authorizations that do not authorize them, also against a
///         deployment whose tokens have NONE mode disabled. The owner reconfigures the tokens and moves or, rarely,
///         renounces ownership in between; the attacker, the pending owner and invalid configurations try
///         the same. Ghost state records what must have happened, including a copy of what the owner set, against
///         which every validly signed request is judged (never against the contract's tokenConfig()); attacks only
///         have to revert. Violations are flagged (not reverted, since the invariant runner ignores reverting handler
///         calls) and checked by the invariants below.
///         The owner makes seven of eight reconfigure calls, one of them with an invalid configuration, and every
///         moveOwnership call before the renounce has one step of the account allowed to take it: the owner renounces
///         in one of RENOUNCE_ODDS, and while a transfer is pending the pending owner accepts in about half of the
///         others. ownerCalls counts the calls that took effect (a configuration set, an ownership step); the rate
///         self-tests require the rates these give for seeds over the whole uint256 range and of every bit length,
///         and the variety self-test the rates of the modes of the configurations set.
contract GaslessHandler is Test {
    /// @dev The largest fee of seven requests in eight (5.00 of a 6-decimal token).
    uint256 internal constant MAX_TEST_FEE = 5_000_000;
    /// @dev The largest fee a user signs (one request in eight signs a fee above MAX_TEST_FEE): above 2^32, where a fee
    ///      truncated to 32 bits differs.
    uint256 internal constant MAX_LARGE_FEE = 2 ** 34;
    /// @dev The owner renounces in one moveOwnership call in this many (see renounces).
    uint256 internal constant RENOUNCE_ODDS = 16;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant META_TRANSACTION_TYPEHASH =
        keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");

    struct Executed {
        TransferRequest r;
        bytes sig;
        TokenAuth auth;
    }

    GaslessTransfer internal immutable gasless;
    /// @dev Same tokens with TokenConfig.allowance = false: NONE mode disabled.
    GaslessTransfer internal immutable permitOnly;
    MockUSDC internal immutable usdc;
    MockUSDT0 internal immutable usdt0;
    address public immutable relay;
    address public immutable attacker;
    uint256 internal immutable attackerPk;

    address[] public users;
    uint256[] internal userPks;
    address[] public victims;
    address[] public recipients;

    mapping(address token => mapping(address account => uint256)) public expectedBalance;
    /// @dev The nonce each signer must have on each deployment: +1 per executed request, raised by invalidateNonces.
    mapping(address g => mapping(address signer => uint256)) public expectedNonce;
    Executed[] internal executed;

    bool public ti1Violated;
    bool public attackSucceeded;
    bool public validCallFailed;
    bool public leftoverAllowance;
    /// @dev A nonce changed in another way than +1 per executed request or the caller's own valid increase (TI3).
    bool public nonceViolated;
    /// @dev A PERMIT / META_TX call was paid from a standing allowance other than exactly amount + fee, or it reverted
    ///      with another error than InsufficientAllowance(standing, amount + fee) (TI5, T18).
    bool public standingAllowanceSpent;
    /// @dev A NONE call left another allowance than standing - (amount + fee).
    bool public noneAllowanceWrong;
    /// @dev The NONE-disabled deployment moved tokens through a standing allowance (TokenConfig.allowance).
    bool public allowanceFlagBypassed;
    /// @dev A request the owner's current configuration refuses executed or failed with another error, or one it
    ///      allows was refused with a configuration error (D6).
    bool public configBypassed;
    /// @dev An owner action ended otherwise than Ownable2Step and §4.2 define (another account accepted ownership,
    ///      something changed after the renounce, TokenConfigSet differs from the configuration set), or it moved a
    ///      balance, an allowance or a nonce.
    bool public ownerActionWrong;
    /// @dev Ghost copy of what the owner set on `gasless`: the deployed configuration, then every reconfiguration.
    mapping(address token => TokenConfig) internal ghostConfigs;
    /// @dev The configuration of `permitOnly`, which is never reconfigured.
    mapping(address token => TokenConfig) internal permitOnlyConfigs;
    /// @dev The owner of `gasless`; address(0) once renounced.
    address public owner;
    /// @dev The pending owner of `gasless` (Ownable2Step); address(0) for none.
    address public pendingOwner;
    /// @dev The owner that renounced, and the transfer it left pending.
    address public formerOwner;
    address public formerPendingOwner;
    /// @dev Targets of invalid configurations: an address without code, and the contract itself.
    address public immutable noCode;
    uint256 public reconfigurations;
    /// @dev Owner actions that had to revert: by another account, with an invalid configuration, after the renounce.
    uint256 public ownerRefusals;
    /// @dev Calls of `gasless`'s owner functions by the account allowed to make them (the owner, or the pending owner
    ///      accepting) that took effect.
    uint256 public ownerCalls;
    /// @dev The token of the last configuration the owner set; the variety self-test reads its tokenConfig().
    address public lastConfigured;
    uint256 public configRefusals;
    uint256 public transfers;
    uint256 public attacks;
    uint256 public invalidations;
    uint256 public standingRefusals;
    uint256 public exactAllowanceSuccesses;
    uint256 public noneOverStanding;
    uint256 public permitOnlyRefusals;

    /// @param deployed The configuration `gasless_` was deployed with.
    constructor(
        GaslessTransfer gasless_,
        GaslessTransfer permitOnly_,
        MockUSDC usdc_,
        MockUSDT0 usdt0_,
        TokenInit[] memory deployed
    ) {
        gasless = gasless_;
        permitOnly = permitOnly_;
        usdc = usdc_;
        usdt0 = usdt0_;
        for (uint256 i = 0; i < deployed.length; ++i) {
            ghostConfigs[deployed[i].token] = deployed[i].config;
            TokenConfig memory c = deployed[i].config;
            c.allowance = false;
            permitOnlyConfigs[deployed[i].token] = c;
        }
        noCode = makeAddr("inv-no-code");
        relay = makeAddr("inv-relay");
        owner = makeAddr("inv-owner");
        (attacker, attackerPk) = makeAddrAndKey("inv-attacker");
        for (uint256 i = 0; i < 3; ++i) {
            (address user, uint256 pk) = makeAddrAndKey(string.concat("inv-user-", vm.toString(i)));
            users.push(user);
            userPks.push(pk);
            victims.push(makeAddr(string.concat("inv-victim-", vm.toString(i))));
            recipients.push(makeAddr(string.concat("inv-recipient-", vm.toString(i))));
        }
    }

    // --- Setup helpers (called by the test contract) ------------------------------------------------

    function trackedAccounts() public view returns (address[] memory accounts) {
        accounts = new address[](users.length + victims.length + recipients.length + 3);
        uint256 k;
        for (uint256 i = 0; i < users.length; ++i) {
            accounts[k++] = users[i];
            accounts[k++] = victims[i];
            accounts[k++] = recipients[i];
        }
        accounts[k++] = relay;
        accounts[k++] = attacker;
        accounts[k++] = address(gasless);
    }

    function syncExpectedBalances() external {
        address[] memory accounts = trackedAccounts();
        for (uint256 i = 0; i < accounts.length; ++i) {
            expectedBalance[address(usdc)][accounts[i]] = usdc.balanceOf(accounts[i]);
            expectedBalance[address(usdt0)][accounts[i]] = usdt0.balanceOf(accounts[i]);
        }
    }

    function victimCount() external view returns (uint256) {
        return victims.length;
    }

    function userCount() external view returns (uint256) {
        return users.length;
    }

    /// @notice What the owner set for `token` on `gasless` (the ghost copy).
    function ghostConfig(address token) external view returns (TokenConfig memory) {
        return ghostConfigs[token];
    }

    /// @notice Whether the owner renounces on moveOwnership(seed): for one seed in RENOUNCE_ODDS. A hash of the seed
    ///         decides, not the seed modulo a power of two, which the fuzzer's dictionary and edge values hit far more
    ///         often than that rate; a renounce freezes the rest of the run.
    function renounces(uint256 seed) public pure returns (bool) {
        return uint256(keccak256(abi.encode("renounce", seed))) % RENOUNCE_ODDS == 0;
    }

    // --- Honest actions -------------------------------------------------------------------------------

    function transfer(uint256 userSeed, uint256 toSeed, uint256 comboSeed, uint256 amount, uint256 fee) external {
        (TransferRequest memory r, uint256 pk, AuthMode mode, bool ok) =
            _freshRequest([userSeed, toSeed, comboSeed, amount, fee]);
        if (!ok) return;
        TokenAuth memory auth = _auth(pk, r, mode);
        bytes memory refusal = _configRefusal(gasless, r, mode);
        (bool success, bytes memory err) = _submit(gasless, r, _signNow(gasless, pk, r, auth), auth);
        if (refusal.length != 0) {
            _judgeConfigRefusal(success, err, refusal);
            _clearAllowance(r.token, r.from);
            return;
        }
        if (!success) {
            _validCallFailed(err);
            _clearAllowance(r.token, r.from);
            return;
        }
        if (IERC20(r.token).allowance(r.from, address(gasless)) != 0) leftoverAllowance = true;
    }

    /// @dev The owner adds, replaces or removes a token's configuration (random modes; none: removed), or
    ///      restores the deployed one. Whatever it does, balances change only through signed requests (TI2) and nonces
    ///      only as signed (TI3); a request the configuration refuses reverts with its error (_configRefusal). In one
    ///      call in eight the owner tries an invalid configuration instead (InvalidConfig), and in one in eight the
    ///      pending owner or the attacker tries (OwnableUnauthorizedAccount); after the renounce the former owner tries,
    ///      which must fail too.
    function reconfigure(uint256 tokenSeed, uint256 configSeed) external {
        address token = tokenSeed % 2 == 0 ? address(usdc) : address(usdt0);
        TokenConfig memory c;
        if (configSeed % 4 == 0) {
            c = TokenConfig({permit: true, metaTxApprove: token == address(usdt0), allowance: true});
        } else {
            c.permit = (configSeed >> 2) & 1 == 1;
            c.metaTxApprove = (configSeed >> 3) & 1 == 1;
            c.allowance = (configSeed >> 4) & 1 == 1;
        }
        address caller = owner == address(0) ? formerOwner : owner;
        bytes memory refusal = owner == address(0) ? _unauthorized(caller) : bytes("");
        uint256 kind = (tokenSeed >> 1) % 8;
        if (owner != address(0) && kind == 6) {
            (token, c) = _invalidConfig(tokenSeed >> 4, configSeed);
            refusal = abi.encodeWithSelector(IGaslessBase.InvalidConfig.selector);
        } else if (owner != address(0) && kind == 7) {
            caller = pendingOwner != address(0) && (tokenSeed >> 4) % 2 == 0 ? pendingOwner : attacker;
            refusal = _unauthorized(caller);
        }
        bytes32 fundsBefore = _funds();
        vm.recordLogs();
        vm.prank(caller);
        try gasless.setTokenConfig(token, c) {
            if (refusal.length != 0) {
                ownerActionWrong = true; // another account, an invalid configuration, or after the renounce
            } else {
                if (!_loggedTokenConfigSet(token, c)) ownerActionWrong = true;
                ghostConfigs[token] = c;
                ++reconfigurations;
                ++ownerCalls;
                lastConfigured = token;
            }
        } catch (bytes memory err) {
            if (keccak256(err) != keccak256(refusal)) ownerActionWrong = true;
            if (refusal.length != 0) ++ownerRefusals;
        }
        if (_funds() != fundsBefore) ownerActionWrong = true;
    }

    /// @dev Ownable2Step on `gasless`: the owner names a candidate, which the transfer can leave pending across calls,
    ///      or cancels with address(0); the attacker, then the pending owner accepts (one call in two while a transfer
    ///      is pending); or (one call in RENOUNCE_ODDS, see renounces) the owner renounces, which freezes the
    ///      configuration and the ownership for the rest of the run. Before an owner's step, the pending owner tries
    ///      the owner's functions; after the renounce, the former owner and the pending owner it left try every step.
    ///      A step that must succeed and reverts, or one that must fail with OwnableUnauthorizedAccount and does not,
    ///      is flagged.
    function moveOwnership(uint256 seed) external {
        bytes32 fundsBefore = _funds();
        if (owner == address(0)) {
            _ownerStep(formerOwner, abi.encodeCall(gasless.transferOwnership, (formerOwner)), false);
            _ownerStep(formerOwner, abi.encodeCall(gasless.acceptOwnership, ()), false);
            _ownerStep(formerOwner, abi.encodeCall(gasless.renounceOwnership, ()), false);
            if (formerPendingOwner != address(0)) {
                _ownerStep(formerPendingOwner, abi.encodeCall(gasless.acceptOwnership, ()), false);
            }
        } else if (renounces(seed)) {
            _ownerStep(owner, abi.encodeCall(gasless.renounceOwnership, ()), true);
            (formerOwner, formerPendingOwner) = (owner, pendingOwner);
            (owner, pendingOwner) = (address(0), address(0));
        } else if (pendingOwner != address(0) && seed % 2 == 0) {
            _ownerStep(attacker, abi.encodeCall(gasless.acceptOwnership, ()), false);
            _ownerStep(pendingOwner, abi.encodeCall(gasless.acceptOwnership, ()), true);
            (owner, pendingOwner) = (pendingOwner, address(0));
        } else {
            if (pendingOwner != address(0)) {
                _ownerStep(
                    pendingOwner,
                    abi.encodeCall(gasless.setTokenConfig, (address(usdc), ghostConfigs[address(usdc)])),
                    false
                );
                _ownerStep(pendingOwner, abi.encodeCall(gasless.transferOwnership, (pendingOwner)), false);
                _ownerStep(pendingOwner, abi.encodeCall(gasless.renounceOwnership, ()), false);
            }
            // A candidate other than the owner, or address(0).
            address next = seed % 5 == 4 ? address(0) : _candidate(seed);
            if (next == owner) next = _candidate(seed % 4 + 1);
            _ownerStep(owner, abi.encodeCall(gasless.transferOwnership, (next)), true);
            pendingOwner = next;
        }
        if (_funds() != fundsBefore) ownerActionWrong = true;
    }

    /// @dev A user raises its own nonce by 1 to 2^32 - 1, or tries an invalid value (not above the current nonce, or
    ///      too far above it), which must change nothing.
    function invalidate(uint256 userSeed, uint256 step, bool valid) external {
        address user = users[userSeed % users.length];
        uint256 current = gasless.nonces(user);
        uint256 newNonce;
        if (valid) {
            newNonce = current + (step % 3 == 0 ? bound(step, 1, type(uint32).max) : bound(step, 1, 5));
        } else {
            newNonce = step % 2 == 0 ? bound(step, 0, current) : current + uint256(type(uint32).max) + 1 + step % 1000;
        }
        vm.prank(user);
        try gasless.invalidateNonces(newNonce) {
            if (!valid) nonceViolated = true;
            expectedNonce[address(gasless)][user] = newNonce;
            ++invalidations;
        } catch {
            if (valid) validCallFailed = true;
        }
        _checkNonce(gasless, user);
    }

    function warp(uint256 secondsForward) external {
        vm.warp(vm.getBlockTimestamp() + bound(secondsForward, 0, 12 hours));
    }

    // --- standing allowances and token authorizations that do not authorize the request --------------

    /// @dev A user approves one of the contracts directly (a standing allowance, as NONE mode uses): unlimited, some
    ///      amount, or 0.
    function approveStanding(uint256 userSeed, uint256 comboSeed, uint256 amountSeed, bool onPermitOnly) external {
        (address token,) = _combo(comboSeed);
        uint256 k = amountSeed % 3;
        uint256 amount = k == 0 ? type(uint256).max : (k == 1 ? bound(amountSeed, 1, 10_000e6) : 0);
        vm.prank(users[userSeed % users.length]);
        IERC20(token).approve(onPermitOnly ? address(permitOnly) : address(gasless), amount);
    }

    /// @dev A user signs a request in PERMIT or META_TX mode with a token authorization that does not authorize it
    ///      (junk; another value, spender, signer or deadline; a token nonce used up first), over a standing allowance
    ///      of exactly amount + fee, one unit less or more, unlimited, or none. Only exactly amount + fee may pay for
    ///      it (what a front-run of the request's own authorization leaves), and then nothing is left (TI5); any
    ///      other standing allowance stays untouched and the call reverts InsufficientAllowance(standing, amount +
    ///      fee) (T18).
    function transferRejectedAuth(
        uint256 userSeed,
        uint256 toSeed,
        uint256 comboSeed,
        uint256 amount,
        uint256 fee,
        uint256 kindSeed
    ) external {
        _rejectedAuthAttempt(gasless, [userSeed, toSeed, comboSeed, amount, fee], kindSeed);
    }

    /// @dev NONE mode over a standing allowance of at least amount + fee: it pays exactly amount + fee and leaves the
    ///      rest (NONE keeps allowance >= amount + fee; TI5 concerns PERMIT and META_TX only).
    function transferNoneOverStanding(
        uint256 userSeed,
        uint256 toSeed,
        uint256 comboSeed,
        uint256 amount,
        uint256 fee,
        uint256 surplusSeed
    ) external {
        (TransferRequest memory r, uint256 pk,, bool ok) = _freshRequest([userSeed, toSeed, comboSeed, amount, fee]);
        if (!ok) return;
        uint256 required = r.amount + r.fee;
        uint256 standing = surplusSeed % 4 == 0 ? type(uint256).max : required + bound(surplusSeed, 0, 10_000e6);
        vm.prank(r.from);
        IERC20(r.token).approve(address(gasless), standing);
        bytes memory refusal = _configRefusal(gasless, r, AuthMode.NONE);
        (bool success, bytes memory err) = _submit(gasless, r, _signNow(gasless, pk, r, _noneAuth()), _noneAuth());
        if (refusal.length != 0) {
            _judgeConfigRefusal(success, err, refusal);
            if (IERC20(r.token).allowance(r.from, address(gasless)) != standing) configBypassed = true;
            return;
        }
        if (!success) {
            _validCallFailed(err);
            return;
        }
        ++noneOverStanding;
        if (IERC20(r.token).allowance(r.from, address(gasless)) != standing - required) noneAllowanceWrong = true;
    }

    /// @dev The same attempts against the deployment whose tokens have NONE mode disabled (TokenConfig.allowance =
    ///      false): NONE always reverts AuthModeNotSupported, and PERMIT / META_TX with a rejected token authorization
    ///      are paid by exactly amount + fee only. No other standing allowance is ever spent.
    function pullViaPermitOnly(
        uint256 userSeed,
        uint256 toSeed,
        uint256 comboSeed,
        uint256 amount,
        uint256 fee,
        uint256 kindSeed
    ) external {
        if (kindSeed % 4 != 0) {
            _rejectedAuthAttempt(permitOnly, [userSeed, toSeed, comboSeed, amount, fee], kindSeed / 4);
            return;
        }
        (TransferRequest memory r, uint256 pk,, bool ok) = _freshRequest([userSeed, toSeed, comboSeed, amount, fee]);
        if (!ok) return;
        vm.prank(r.from);
        IERC20(r.token).approve(address(permitOnly), _standing(r.amount + r.fee, kindSeed / 4));
        (bool success, bytes memory err) = _submit(permitOnly, r, _signNow(permitOnly, pk, r, _noneAuth()), _noneAuth());
        bytes memory expected =
            abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, r.token, AuthMode.NONE);
        if (success || keccak256(err) != keccak256(expected)) allowanceFlagBypassed = true;
        ++permitOnlyRefusals;
    }

    // --- Attacks --------------------------------------------------------------------------------------

    /// @dev An unsigned-pull attempt: the attacker is the relay and pulls from a max-approved victim without its signature.
    function attackUnsigned(uint256 victimSeed, uint256 comboSeed, uint256 amount, uint256 sigKind, bytes32 salt)
        external
    {
        address victim = victims[victimSeed % victims.length];
        (address token, AuthMode mode) = _combo(comboSeed);
        amount = bound(amount, 1, IERC20(token).balanceOf(victim) + 1);
        TransferRequest memory r = TransferRequest({
            token: token,
            from: victim,
            to: attacker,
            amount: amount,
            fee: 0,
            relay: attacker,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
        TokenAuth memory auth = TokenAuth({mode: mode, v: 27, r: salt, s: bytes32(amount)});
        bytes memory sig;
        uint256 kind = sigKind % 4;
        if (kind == 1) sig = _signNow(gasless, attackerPk, r, auth);
        if (kind == 2) sig = abi.encodePacked(keccak256(abi.encode(sigKind)), salt, uint8(27));
        if (kind == 3 && executed.length > 0) sig = executed[sigKind % executed.length].sig;
        _attack(r, sig, auth);
    }

    /// @dev A user's genuine signature for `relay`, submitted by the attacker as is or with the relay field rewritten.
    function attackForeignRelay(uint256 userSeed, uint256 comboSeed, uint256 amount) external {
        uint256 u = userSeed % users.length;
        (address token, AuthMode mode) = _combo(comboSeed);
        uint256 balance = IERC20(token).balanceOf(users[u]);
        if (balance == 0) return;
        TransferRequest memory r = TransferRequest({
            token: token,
            from: users[u],
            to: attacker,
            amount: bound(amount, 1, balance),
            fee: 0,
            relay: relay,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
        TokenAuth memory auth = _auth(userPks[u], r, mode);
        bytes memory sig = _signNow(gasless, userPks[u], r, auth);
        _attack(r, sig, auth);
        r.relay = attacker;
        _attack(r, sig, auth);
        _clearAllowance(r.token, r.from);
    }

    function attackReplay(uint256 index, bool viaAttacker) external {
        if (executed.length == 0) return;
        Executed memory e = executed[index % executed.length];
        vm.prank(viaAttacker ? attacker : e.r.relay);
        try gasless.relayTransfer(e.r, e.sig, e.auth) {
            attackSucceeded = true;
        } catch {}
        ++attacks;
        _checkNonce(gasless, e.r.from);
    }

    /// @dev A request the user really signed, but for a nonce that is not the current one: an earlier (used or
    ///      invalidated) nonce, or one ahead. It must fail, and the request at the current nonce must still work.
    function attackWrongNonce(uint256 userSeed, uint256 comboSeed, uint256 offset, bool ahead) external {
        uint256 u = userSeed % users.length;
        (address token, AuthMode mode) = _combo(comboSeed);
        if (IERC20(token).balanceOf(users[u]) == 0) return;
        uint256 current = gasless.nonces(users[u]);
        if (!ahead && current == 0) return;
        uint256 nonce = ahead ? current + bound(offset, 1, 3) : current - bound(offset, 1, current);
        TransferRequest memory r = TransferRequest({
            token: token,
            from: users[u],
            to: recipients[0],
            amount: 1,
            fee: 0,
            relay: relay,
            deadline: vm.getBlockTimestamp() + 1 hours
        });
        TokenAuth memory auth = _auth(userPks[u], r, mode);
        bytes memory sig = _sign(userPks[u], gasless.hashTransfer(r, nonce, auth));
        vm.prank(relay);
        try gasless.relayTransfer(r, sig, auth) {
            attackSucceeded = true;
        } catch {}
        ++attacks;
        _clearAllowance(r.token, r.from);
        _checkNonce(gasless, users[u]);
    }

    /// @dev The relay submits a user's signed request with another token authorization than the signed one.
    function attackSwapAuth(uint256 userSeed, uint256 comboSeed, uint256 amount, uint256 swapSeed) external {
        (TransferRequest memory r, uint256 pk, AuthMode mode, bool ok) =
            _freshRequest([userSeed, 0, comboSeed, amount, 0]);
        if (!ok) return;
        TokenAuth memory signed = _auth(pk, r, mode);
        bytes memory sig = _signNow(gasless, pk, r, signed);
        TokenAuth memory swapped = TokenAuth({mode: signed.mode, v: signed.v, r: signed.r, s: signed.s});
        uint256 k = swapSeed % 4;
        if (k == 0) swapped.mode = AuthMode(uint8((uint8(signed.mode) + 1 + swapSeed % 2) % 3));
        if (k == 1) swapped.v ^= 1;
        if (k == 2) swapped.r = keccak256(abi.encode(signed.r));
        if (k == 3) swapped.s = keccak256(abi.encode(signed.s));
        vm.prank(relay);
        try gasless.relayTransfer(r, sig, swapped) {
            attackSucceeded = true;
        } catch {}
        ++attacks;
        _clearAllowance(r.token, r.from);
        _checkNonce(gasless, r.from);
    }

    // --- Internals --------------------------------------------------------------------------------------

    function _attack(TransferRequest memory r, bytes memory sig, TokenAuth memory auth) internal {
        vm.prank(attacker);
        try gasless.relayTransfer(r, sig, auth) {
            attackSucceeded = true;
        } catch {}
        ++attacks;
        _checkNonce(gasless, r.from);
    }

    /// @dev seeds: user, recipient, (token, mode), amount, fee.
    function _rejectedAuthAttempt(GaslessTransfer g, uint256[5] memory seeds, uint256 kindSeed) internal {
        (TransferRequest memory r, uint256 pk, AuthMode mode, bool ok) = _freshRequest(seeds);
        if (!ok) return;
        if (mode == AuthMode.NONE) mode = AuthMode.PERMIT;
        TokenAuth memory auth = _rejectedAuth(pk, r, mode, kindSeed, address(g));
        uint256 standing = _standing(r.amount + r.fee, kindSeed / 6);
        vm.prank(r.from);
        IERC20(r.token).approve(address(g), standing);
        // The configuration's checks come before the token authorization.
        bytes memory refusal = _configRefusal(g, r, mode);
        (bool success, bytes memory err) = _submit(g, r, _signNow(g, pk, r, auth), auth);
        if (refusal.length != 0) {
            _judgeConfigRefusal(success, err, refusal);
            if (IERC20(r.token).allowance(r.from, address(g)) != standing) configBypassed = true;
            return;
        }
        _judgeRejectedAuth(g, r, standing, success, err);
    }

    /// @dev The error the current configuration of `g` refuses `r` in `mode` with (GaslessBase._requireToken), or empty
    ///      if it accepts them, whatever the fee. For `gasless` it reads the ghost copy of what the owner set, never
    ///      gasless.tokenConfig(), so that a configuration the contract stored wrongly cannot fool the oracle.
    function _configRefusal(GaslessTransfer g, TransferRequest memory r, AuthMode mode)
        internal
        view
        returns (bytes memory)
    {
        TokenConfig memory c = address(g) == address(gasless) ? ghostConfigs[r.token] : permitOnlyConfigs[r.token];
        bool enabled =
            mode == AuthMode.PERMIT ? c.permit : mode == AuthMode.META_TX_APPROVE ? c.metaTxApprove : c.allowance;
        if (!enabled) {
            if (!c.permit && !c.metaTxApprove && !c.allowance) {
                return abi.encodeWithSelector(IGaslessBase.TokenNotSupported.selector, r.token);
            }
            return abi.encodeWithSelector(IGaslessBase.AuthModeNotSupported.selector, r.token, mode);
        }
        return "";
    }

    function _judgeConfigRefusal(bool success, bytes memory err, bytes memory expected) internal {
        if (success || keccak256(err) != keccak256(expected)) configBypassed = true;
        ++configRefusals;
    }

    /// @dev Up to MAX_TEST_FEE, or (one seed in eight, if the balance allows) above it, up to MAX_LARGE_FEE: no
    ///      configuration bounds the fee, so every signed fee must be paid exactly.
    function _pickFee(uint256 balance, uint256 feeSeed) internal pure returns (uint256) {
        if (feeSeed % 8 != 7 || balance <= MAX_TEST_FEE + 1) return bound(feeSeed, 0, MAX_TEST_FEE);
        uint256 cap = balance - 1 < MAX_LARGE_FEE ? balance - 1 : MAX_LARGE_FEE;
        return bound(feeSeed >> 3, MAX_TEST_FEE + 1, cap);
    }

    /// @dev An invalid configuration (§4.2): one to three modes for an address without code or for the contract itself.
    function _invalidConfig(uint256 seed, uint256 configSeed)
        internal
        view
        returns (address target, TokenConfig memory c)
    {
        target = seed % 2 == 0 ? noCode : address(gasless);
        uint256 modes = 1 + configSeed % 7;
        c = TokenConfig({permit: modes & 1 != 0, metaTxApprove: modes & 2 != 0, allowance: modes & 4 != 0});
    }

    /// @dev One of four accounts ownership moves to.
    function _candidate(uint256 seed) internal returns (address) {
        return makeAddr(string.concat("inv-owner-", vm.toString(seed % 4)));
    }

    function _unauthorized(address caller) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);
    }

    /// @dev `caller` calls `gasless` with `data` (an Ownable2Step step, or setTokenConfig): it must succeed, or else
    ///      revert OwnableUnauthorizedAccount(caller); anything else is flagged.
    function _ownerStep(address caller, bytes memory data, bool mustSucceed) internal {
        vm.prank(caller);
        (bool ok, bytes memory err) = address(gasless).call(data);
        if (mustSucceed ? !ok : (ok || keccak256(err) != keccak256(_unauthorized(caller)))) ownerActionWrong = true;
        if (!mustSucceed) ++ownerRefusals;
        else if (ok) ++ownerCalls;
    }

    /// @dev A call the configuration allows failed; refused with a configuration error, it also breaks D6.
    function _validCallFailed(bytes memory err) internal {
        validCallFailed = true;
        if (_isConfigError(err)) configBypassed = true;
    }

    function _isConfigError(bytes memory err) internal pure returns (bool) {
        if (err.length < 4) return false;
        bytes4 selector = bytes4(err);
        return
            selector == IGaslessBase.TokenNotSupported.selector
                || selector == IGaslessBase.AuthModeNotSupported.selector;
    }

    /// @dev Only exactly amount + fee may pay (and is then used up); any other standing allowance stays untouched and
    ///      the call reverts InsufficientAllowance(standing, amount + fee).
    function _judgeRejectedAuth(
        GaslessTransfer g,
        TransferRequest memory r,
        uint256 standing,
        bool success,
        bytes memory err
    ) internal {
        uint256 required = r.amount + r.fee;
        if (success) {
            if (standing != required) {
                standingAllowanceSpent = true;
                if (address(g) == address(permitOnly)) allowanceFlagBypassed = true;
            }
            if (IERC20(r.token).allowance(r.from, address(g)) != 0) leftoverAllowance = true;
            ++exactAllowanceSuccesses;
        } else if (standing == required) {
            _validCallFailed(err); // exactly what a front-run of the request's own authorization leaves
        } else {
            bytes memory expected =
                abi.encodeWithSelector(IGaslessBase.InsufficientAllowance.selector, standing, required);
            if (_isConfigError(err)) configBypassed = true;
            else if (keccak256(err) != keccak256(expected)) standingAllowanceSpent = true;
            if (IERC20(r.token).allowance(r.from, address(g)) != standing) standingAllowanceSpent = true;
            if (standing > required) ++standingRefusals;
            if (address(g) == address(permitOnly)) ++permitOnlyRefusals;
        }
    }

    /// @dev A fresh request of a user, submitted by `relay` within the hour; false if the balance is too low.
    ///      seeds: user, recipient, (token, mode), amount, fee.
    function _freshRequest(uint256[5] memory seeds)
        internal
        view
        returns (TransferRequest memory r, uint256 pk, AuthMode mode, bool ok)
    {
        uint256 u = seeds[0] % users.length;
        (r.token, mode) = _combo(seeds[2]);
        uint256 balance = IERC20(r.token).balanceOf(users[u]);
        r.fee = _pickFee(balance, seeds[4]);
        if (balance <= r.fee) return (r, 0, mode, false);
        pk = userPks[u];
        r.from = users[u];
        r.to = _recipient(seeds[1]);
        r.amount = bound(seeds[3], 1, balance - r.fee);
        r.relay = relay;
        r.deadline = vm.getBlockTimestamp() + 1 hours;
        ok = true;
    }

    /// @dev Submits `r` to `g` as the relay. On success: TI1 around the call (the nonce goes up by exactly one), and
    ///      the ghost state books the transfer. On failure the nonce must not move.
    function _submit(GaslessTransfer g, TransferRequest memory r, bytes memory sig, TokenAuth memory auth)
        internal
        returns (bool success, bytes memory err)
    {
        IERC20 token = IERC20(r.token);
        uint256 fromBefore = token.balanceOf(r.from);
        uint256 toBefore = token.balanceOf(r.to);
        uint256 relayBefore = token.balanceOf(relay);
        vm.prank(relay);
        try g.relayTransfer(r, sig, auth) {
            success = true;
        } catch (bytes memory e) {
            err = e;
        }
        if (!success) {
            _checkNonce(g, r.from);
            return (false, err);
        }
        ++transfers;
        uint256 fromExpected = fromBefore - r.amount - r.fee + (r.to == r.from ? r.amount : 0);
        if (token.balanceOf(r.from) != fromExpected) ti1Violated = true;
        if (r.to != r.from && token.balanceOf(r.to) != toBefore + r.amount) ti1Violated = true;
        if (token.balanceOf(relay) != relayBefore + r.fee) ti1Violated = true;
        ++expectedNonce[address(g)][r.from];
        _checkNonce(g, r.from);
        expectedBalance[r.token][r.from] -= r.amount + r.fee;
        expectedBalance[r.token][r.to] += r.amount;
        expectedBalance[r.token][relay] += r.fee;
        if (address(g) == address(gasless)) executed.push(Executed(r, sig, auth));
    }

    function _checkNonce(GaslessTransfer g, address signer) internal {
        if (g.nonces(signer) != expectedNonce[address(g)][signer]) nonceViolated = true;
    }

    /// @dev Since vm.recordLogs(), exactly one log: `gasless`'s TokenConfigSet(token, c).
    function _loggedTokenConfigSet(address token, TokenConfig memory c) internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        return logs.length == 1 && logs[0].emitter == address(gasless) && logs[0].topics.length == 2
            && logs[0].topics[0] == IGaslessBase.TokenConfigSet.selector
            && logs[0].topics[1] == bytes32(uint256(uint160(token)))
            && keccak256(logs[0].data) == keccak256(abi.encode(c));
    }

    /// @dev Every tracked balance and allowance to `gasless`, and every tracked nonce on it, hashed.
    function _funds() internal view returns (bytes32 h) {
        address[] memory accounts = trackedAccounts();
        for (uint256 i = 0; i < accounts.length; ++i) {
            address a = accounts[i];
            h = keccak256(
                abi.encode(
                    h,
                    usdc.balanceOf(a),
                    usdt0.balanceOf(a),
                    usdc.allowance(a, address(gasless)),
                    usdt0.allowance(a, address(gasless)),
                    gasless.nonces(a)
                )
            );
        }
    }

    /// @dev Removes an exact approval that an attack's NONE authorization left, so it cannot pay a later request.
    function _clearAllowance(address token, address holder) internal {
        vm.prank(holder);
        IERC20(token).approve(address(gasless), 0);
    }

    /// @dev A token authorization in `mode` that does not authorize `r` on contract `g`: junk; a permit / meta-tx for
    ///      another value (T18) or another spender; one signed by the attacker; one whose token nonce the user's next
    ///      permit (to someone else) uses up first; a permit with another deadline (submitted as a meta-tx in
    ///      META_TX mode).
    function _rejectedAuth(uint256 pk, TransferRequest memory r, AuthMode mode, uint256 kind, address g)
        internal
        returns (TokenAuth memory auth)
    {
        uint256 value = r.amount + r.fee;
        uint256 tokenNonce = IERC20Permit(r.token).nonces(r.from);
        uint256 k = kind % 6;
        if (k == 0) return TokenAuth({mode: mode, v: 27, r: keccak256(abi.encode(kind)), s: bytes32(value)});
        if (k == 1) return _tokenAuth(pk, r, mode, g, value + 1, r.deadline, tokenNonce);
        if (k == 2) return _tokenAuth(pk, r, mode, attacker, value, r.deadline, tokenNonce);
        if (k == 3) return _tokenAuth(attackerPk, r, mode, g, value, r.deadline, tokenNonce);
        if (k == 4) {
            auth = _tokenAuth(pk, r, mode, g, value, r.deadline, tokenNonce);
            TokenAuth memory next = _tokenAuth(pk, r, AuthMode.PERMIT, attacker, 1, r.deadline, tokenNonce);
            IERC20Permit(r.token).permit(r.from, attacker, 1, r.deadline, next.v, next.r, next.s);
            return auth;
        }
        auth = _tokenAuth(pk, r, AuthMode.PERMIT, g, value, r.deadline + 1, tokenNonce);
        auth.mode = mode;
    }

    function _tokenAuth(
        uint256 pk,
        TransferRequest memory r,
        AuthMode mode,
        address spender,
        uint256 value,
        uint256 deadline,
        uint256 tokenNonce
    ) internal view returns (TokenAuth memory) {
        bytes32 structHash = mode == AuthMode.PERMIT
            ? keccak256(abi.encode(PERMIT_TYPEHASH, r.from, spender, value, tokenNonce, deadline))
            : keccak256(
                abi.encode(
                    META_TRANSACTION_TYPEHASH,
                    tokenNonce,
                    r.from,
                    keccak256(abi.encodeCall(IERC20.approve, (spender, value)))
                )
            );
        return _tokenSig(pk, r.token, structHash, mode);
    }

    /// @dev Exactly amount + fee (what a front-run token authorization leaves), one unit less or more, unlimited, or
    ///      none.
    function _standing(uint256 required, uint256 seed) internal pure returns (uint256) {
        uint256 k = seed % 5;
        if (k == 0) return required;
        if (k == 1) return required - 1;
        if (k == 2) return required + 1 + seed % 1000e6;
        if (k == 3) return type(uint256).max;
        return 0;
    }

    function _noneAuth() internal pure returns (TokenAuth memory) {
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: 0, s: 0});
    }

    function _combo(uint256 seed) internal view returns (address token, AuthMode mode) {
        uint256 c = seed % 5;
        if (c == 0) return (address(usdc), AuthMode.PERMIT);
        if (c == 1) return (address(usdc), AuthMode.NONE);
        if (c == 2) return (address(usdt0), AuthMode.PERMIT);
        if (c == 3) return (address(usdt0), AuthMode.META_TX_APPROVE);
        return (address(usdt0), AuthMode.NONE);
    }

    function _recipient(uint256 seed) internal view returns (address) {
        uint256 k = seed % (recipients.length + users.length);
        return k < recipients.length ? recipients[k] : users[k - recipients.length];
    }

    function _auth(uint256 pk, TransferRequest memory r, AuthMode mode) internal returns (TokenAuth memory) {
        uint256 value = r.amount + r.fee;
        if (mode == AuthMode.PERMIT) {
            bytes32 structHash = keccak256(
                abi.encode(
                    PERMIT_TYPEHASH, r.from, address(gasless), value, IERC20Permit(r.token).nonces(r.from), r.deadline
                )
            );
            return _tokenSig(pk, r.token, structHash, AuthMode.PERMIT);
        }
        if (mode == AuthMode.META_TX_APPROVE) {
            bytes memory approveCall = abi.encodeCall(IERC20.approve, (address(gasless), value));
            bytes32 structHash = keccak256(
                abi.encode(META_TRANSACTION_TYPEHASH, usdt0.getNonce(r.from), r.from, keccak256(approveCall))
            );
            return _tokenSig(pk, r.token, structHash, AuthMode.META_TX_APPROVE);
        }
        vm.prank(r.from);
        IERC20(r.token).approve(address(gasless), value);
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: 0, s: 0});
    }

    function _tokenSig(uint256 pk, address token, bytes32 structHash, AuthMode mode)
        internal
        view
        returns (TokenAuth memory)
    {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return TokenAuth({mode: mode, v: v, r: r, s: s});
    }

    /// @dev The intent signature at the signer's current nonce on `g`.
    function _signNow(GaslessTransfer g, uint256 pk, TransferRequest memory r, TokenAuth memory auth)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, g.hashTransfer(r, g.nonces(r.from), auth));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

/// @notice TI1-TI5 as invariants over random sequences of honest transfers, nonce increases, time jumps and attacks,
///         plus standing allowances under token authorizations that do not authorize the request, also against a
///         deployment whose tokens have NONE mode disabled.
contract GaslessTransferInvariantTest is Test {
    /// @dev Fixed seeds per family in the rate self-test.
    uint256 internal constant RATE_SEEDS = 256;
    /// @dev Fixed seeds per family in the variety self-test.
    uint256 internal constant VARIETY_SEEDS = 2 * RATE_SEEDS;

    GaslessTransfer internal gasless;
    GaslessTransfer internal permitOnly;
    MockUSDC internal usdc;
    MockUSDT0 internal usdt0;
    GaslessHandler internal handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new MockUSDC();
        usdt0 = new MockUSDT0();
        address owner = makeAddr("inv-owner");
        gasless = new GaslessTransfer(owner, _tokens(true));
        permitOnly = new GaslessTransfer(owner, _tokens(false));
        handler = new GaslessHandler(gasless, permitOnly, usdc, usdt0, _tokens(true));

        for (uint256 i = 0; i < 3; ++i) {
            address user = handler.users(i);
            address victim = handler.victims(i);
            usdc.mint(user, 1_000_000e6);
            usdt0.mint(user, 1_000_000e6);
            usdc.mint(victim, 1_000_000e6);
            usdt0.mint(victim, 1_000_000e6);
            // Standing-allowance precondition: standing max approvals to the contract.
            vm.startPrank(victim);
            usdc.approve(address(gasless), type(uint256).max);
            usdt0.approve(address(gasless), type(uint256).max);
            vm.stopPrank();
        }
        handler.syncExpectedBalances();

        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = GaslessHandler.transfer.selector;
        selectors[1] = GaslessHandler.transfer.selector; // weight honest transfers higher
        selectors[2] = GaslessHandler.invalidate.selector;
        selectors[3] = GaslessHandler.warp.selector;
        selectors[4] = GaslessHandler.attackUnsigned.selector;
        selectors[5] = GaslessHandler.attackForeignRelay.selector;
        selectors[6] = GaslessHandler.attackReplay.selector;
        selectors[7] = GaslessHandler.attackWrongNonce.selector;
        selectors[8] = GaslessHandler.attackSwapAuth.selector;
        selectors[9] = GaslessHandler.approveStanding.selector;
        selectors[10] = GaslessHandler.transferRejectedAuth.selector;
        selectors[11] = GaslessHandler.transferRejectedAuth.selector;
        selectors[12] = GaslessHandler.transferNoneOverStanding.selector;
        selectors[13] = GaslessHandler.pullViaPermitOnly.selector;
        selectors[14] = GaslessHandler.transfer.selector;
        selectors[15] = GaslessHandler.reconfigure.selector;
        selectors[16] = GaslessHandler.moveOwnership.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev USDC {PERMIT, NONE} and USDT0 {PERMIT, META_TX_APPROVE, NONE}; `allowance` = false disables NONE.
    function _tokens(bool allowance) internal view returns (TokenInit[] memory inits) {
        inits = new TokenInit[](2);
        inits[0] = TokenInit({
            token: address(usdc), config: TokenConfig({permit: true, metaTxApprove: false, allowance: allowance})
        });
        inits[1] = TokenInit({
            token: address(usdt0), config: TokenConfig({permit: true, metaTxApprove: true, allowance: allowance})
        });
    }

    function invariant_TI1_successfulTransfersAreExact() public view {
        assertFalse(handler.ti1Violated(), "TI1");
        assertFalse(handler.validCallFailed(), "a valid, signed call failed");
    }

    /// @dev TI2: every balance equals the ghost balance, which only changes through signed, executed requests.
    function invariant_TI2_noUnsignedDebits() public view {
        assertFalse(
            handler.attackSucceeded(), "an unsigned, foreign-relay, replayed or re-authorized request succeeded"
        );
        address[] memory accounts = handler.trackedAccounts();
        for (uint256 i = 0; i < accounts.length; ++i) {
            assertEq(usdc.balanceOf(accounts[i]), handler.expectedBalance(address(usdc), accounts[i]), "USDC");
            assertEq(usdt0.balanceOf(accounts[i]), handler.expectedBalance(address(usdt0), accounts[i]), "USDT0");
        }
        for (uint256 i = 0; i < handler.victimCount(); ++i) {
            assertEq(usdc.balanceOf(handler.victims(i)), 1_000_000e6, "victim USDC");
            assertEq(usdt0.balanceOf(handler.victims(i)), 1_000_000e6, "victim USDT0");
            assertEq(gasless.nonces(handler.victims(i)), 0, "victim nonce");
        }
    }

    /// @dev TI3: each nonce equals the executed requests plus the signer's own increases, on both deployments.
    function invariant_TI3_noncesOnlyMoveAsSigned() public view {
        assertFalse(handler.nonceViolated(), "a nonce moved otherwise than +1 per transfer or by its own signer");
        for (uint256 i = 0; i < handler.userCount(); ++i) {
            address user = handler.users(i);
            assertEq(gasless.nonces(user), handler.expectedNonce(address(gasless), user), "nonce");
            assertEq(permitOnly.nonces(user), handler.expectedNonce(address(permitOnly), user), "nonce (NONE disabled)");
        }
    }

    function invariant_TI4_noCustody() public view {
        assertEq(usdc.balanceOf(address(gasless)), 0, "USDC custody");
        assertEq(usdt0.balanceOf(address(gasless)), 0, "USDT0 custody");
        assertEq(usdc.balanceOf(address(permitOnly)), 0, "USDC custody (NONE disabled)");
        assertEq(usdt0.balanceOf(address(permitOnly)), 0, "USDT0 custody (NONE disabled)");
    }

    /// @dev TI5: no allowance is left after a PERMIT or META_TX call, and such a call is never paid from a standing
    ///      allowance other than exactly amount + fee (it reverts InsufficientAllowance(standing, amount + fee) and
    ///      leaves that allowance untouched). NONE leaves exactly standing - (amount + fee).
    function invariant_TI5_noLeftoverAllowance() public view {
        assertFalse(handler.leftoverAllowance(), "allowance left after a PERMIT / META_TX / NONE call");
        assertFalse(handler.standingAllowanceSpent(), "a PERMIT / META_TX call spent another standing allowance");
        assertFalse(handler.noneAllowanceWrong(), "NONE left another allowance than standing - (amount + fee)");
    }

    /// @dev D6 / §4.2: with TokenConfig.allowance = false, NONE is refused and no other standing allowance is spent.
    function invariant_allowanceFlagIsEnforced() public view {
        assertFalse(handler.allowanceFlagBypassed(), "a standing allowance was pulled although NONE is disabled");
    }

    /// @dev D6: the owner's current configuration (the handler's ghost copy, not tokenConfig()) decides which
    ///      requests execute, and nothing else; TI2 and TI3 above hold whatever it configures. tokenConfig() is what
    ///      the owner set (also nothing for an address without code and the contract itself); only the owner
    ///      configures, only the pending owner accepts ownership, and nothing changes after the renounce; owner
    ///      actions move no balance, allowance or nonce.
    function invariant_D6_configurationApplies() public view {
        assertFalse(handler.configBypassed(), "a request the configuration refuses executed or failed otherwise");
        assertFalse(handler.ownerActionWrong(), "an owner action ended otherwise than expected or moved funds");
        assertEq(gasless.owner(), handler.owner(), "owner");
        assertEq(gasless.pendingOwner(), handler.pendingOwner(), "pending owner");
        address[4] memory tokens = [address(usdc), address(usdt0), handler.noCode(), address(gasless)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TokenConfig memory actual = gasless.tokenConfig(tokens[i]);
            TokenConfig memory ghost = handler.ghostConfig(tokens[i]);
            assertEq(actual.permit, ghost.permit, "tokenConfig().permit differs from the owner's");
            assertEq(actual.metaTxApprove, ghost.metaTxApprove, "tokenConfig().metaTxApprove differs from the owner's");
            assertEq(actual.allowance, ghost.allowance, "tokenConfig().allowance differs from the owner's");
        }
    }

    /// @dev Every run is not vacuous: it judged validly signed requests (executed, or refused by the configuration) and
    ///      attacked. In a run of 64 calls each of these is missing with a chance below 10^-5. The owner's actions are
    ///      2 of the 17 selectors here, which some correct runs never call; the rate self-tests below guard them.
    function afterInvariant() external view {
        assertGt(handler.transfers() + handler.configRefusals(), 0, "no request judged");
        assertGt(handler.attacks(), 0, "no attack");
    }

    /// @dev The first moveOwnership seed from `from` of the given parity (odd: the owner names a candidate or cancels;
    ///      even: the pending owner accepts) that cancels (4 modulo 5) or not, and on which the owner does not renounce.
    function _moveSeed(uint256 from, uint256 parity, bool cancel) internal view returns (uint256 seed) {
        for (seed = from; seed % 2 != parity || (seed % 5 == 4) != cancel || handler.renounces(seed); ++seed) {}
    }

    /// @notice The handler is not vacuous: transfers in every route, nonce increases, every attack and every shape of
    ///         standing allowance against every kind of rejected token authorization, on both deployments; all
    ///         invariants hold afterwards.
    function test_handlerCoversStandingAllowances() public {
        for (uint256 i = 0; i < 10; ++i) {
            handler.transfer(i, i + 1, i, 1e6 + i, 10_000 * i);
            handler.invalidate(i, i + 1, i % 3 != 2);
        }
        for (uint256 i = 0; i < 12; ++i) {
            handler.attackUnsigned(i, i, 1e6, i, keccak256(abi.encode(i)));
            handler.attackForeignRelay(i, i, 1e6 + i);
            handler.attackReplay(i, i % 2 == 0);
            handler.attackWrongNonce(i, i, i + 1, i % 2 == 0);
            handler.attackSwapAuth(i, i, 1e6 + i, i);
        }
        for (uint256 i = 0; i < 60; ++i) {
            handler.approveStanding(i, i, i, i % 2 == 0);
            // kindSeed: the rejected authorization (i % 6) and the shape of the standing allowance (i / 6 % 5).
            handler.transferRejectedAuth(i, i + 1, i % 5, 1e6 + i, 10_000 * (i % 3), i % 6 + 6 * (i / 6 % 5));
            handler.pullViaPermitOnly(i, i + 2, i % 5, 2e6 + i, 20_000, i);
            handler.transferNoneOverStanding(i, i + 3, i % 5, 3e6 + i, 30_000, i);
        }
        assertGe(handler.transfers(), 10, "transfers");
        assertGt(handler.invalidations(), 0, "nonce increases");
        assertGe(handler.attacks(), 60, "attacks");
        assertGt(handler.standingRefusals(), 0, "standing allowance above amount + fee refused");
        assertGt(handler.exactAllowanceSuccesses(), 0, "exactly amount + fee accepted");
        assertGt(handler.permitOnlyRefusals(), 0, "NONE-disabled deployment refused");
        assertGt(handler.noneOverStanding(), 0, "NONE over a standing allowance");
        invariant_TI1_successfulTransfersAreExact();
        invariant_TI2_noUnsignedDebits();
        invariant_TI3_noncesOnlyMoveAsSigned();
        invariant_TI4_noCustody();
        invariant_TI5_noLeftoverAllowance();
        invariant_allowanceFlagIsEnforced();

        // The same under reconfiguration and ownership moves, until the owner renounces. Tokens seeds 12 to 15
        // and 28 to 31 are invalid configurations of the owner and attempts of other accounts.
        uint256 before = handler.transfers();
        for (uint256 i = 0; i < 40; ++i) {
            handler.reconfigure(i, i * 7 + 1);
            handler.transfer(i, i + 1, i, 1e6 + i, 1_000_000 * (i % 6));
            handler.transferNoneOverStanding(i, i + 3, i % 5, 3e6 + i, 30_000 * i, i);
            handler.transferRejectedAuth(i, i + 1, i % 5, 1e6 + i, 10_000 * (i % 3), i % 6);
            handler.attackUnsigned(i, i, 1e6, i, keccak256(abi.encode(i)));
            if (i % 10 == 9) {
                handler.moveOwnership(_moveSeed(i, 1, false)); // the owner names a candidate
                handler.moveOwnership(_moveSeed(i, 0, false)); // the attacker, then the candidate accepts
            }
        }
        assertGt(handler.reconfigurations(), 20, "reconfigurations");
        assertEq(handler.ownerRefusals(), 8 + 4, "invalid configurations, other accounts, the attacker accepting");
        assertGt(handler.configRefusals(), 0, "requests the configuration refused");
        assertGt(handler.transfers(), before, "transfers under other configurations");

        // A transfer stays pending: the pending owner's attempts at the owner's functions fail, and the owner cancels it.
        handler.moveOwnership(_moveSeed(0, 1, false));
        assertTrue(handler.pendingOwner() != address(0), "pending");
        assertEq(gasless.pendingOwner(), handler.pendingOwner(), "pending owner");
        handler.moveOwnership(_moveSeed(0, 1, true));
        assertEq(handler.ownerRefusals(), 12 + 3, "the pending owner configures, transfers or renounces");
        assertEq(gasless.pendingOwner(), address(0), "cancelled");

        // The owner renounces with a transfer pending: neither the former owner nor that pending owner changes anything.
        handler.moveOwnership(_moveSeed(0, 1, false));
        address pending = handler.pendingOwner();
        uint256 renounce;
        while (!handler.renounces(renounce)) ++renounce;
        handler.moveOwnership(renounce);
        assertEq(gasless.owner(), address(0), "renounced");
        assertEq(gasless.pendingOwner(), address(0), "the renounce clears the pending owner");
        assertEq(handler.formerPendingOwner(), pending);
        uint256 reconfigurations = handler.reconfigurations();
        handler.reconfigure(0, 0); // the former owner, refused
        handler.moveOwnership(1);
        assertEq(handler.reconfigurations(), reconfigurations, "nothing changes after the renounce");
        assertEq(handler.ownerRefusals(), 15 + 1 + 4, "the former owner and pending owner after the renounce");
        handler.transfer(1, 2, 1, 1e6, 10_000);
        invariant_TI1_successfulTransfersAreExact();
        invariant_TI2_noUnsignedDebits();
        invariant_TI3_noncesOnlyMoveAsSigned();
        invariant_TI4_noCustody();
        invariant_TI5_noLeftoverAllowance();
        invariant_D6_configurationApplies();
    }

    /// @notice The owner sets a configuration in six of eight reconfigure calls (it makes seven, one with an invalid
    ///         configuration), for seeds over the whole uint256 range and of every bit length (as the fuzzer draws
    ///         uint256 values). The fixed-input self-test uses small seeds: a handler that let the owner act, or set a
    ///         valid configuration, only for small seeds would pass it and every invariant (the ghost follows a
    ///         refusal) while the fuzzer's calls hardly ever changed the configuration.
    function test_ownerConfiguresAtTheDesignedRate() public {
        for (uint256 family = 0; family < 2; ++family) {
            uint256 configured;
            for (uint256 i = 0; i < RATE_SEEDS; ++i) {
                (uint256 calls,,) = _ownerCallsOf(
                    abi.encodeCall(GaslessHandler.reconfigure, (_rateSeed(family, i, 0), _rateSeed(family, i, 1)))
                );
                configured += calls;
            }
            _assertRate(configured, RATE_SEEDS, 6, 8, "reconfigure");
        }
    }

    /// @notice The configurations the owner sets vary at their designed rates, for seeds of both families. Of 512
    ///         reconfigure calls it removes a configuration in 36 (6/8 * 3/4 * 1/8), sets permit and allowance in 168
    ///         (the deployed modes in one call in four, or random modes with both: 6/8 * 7/16) and other random modes
    ///         in 180 (6/8 * 3/4 * 5/8). The rate self-test counts the configurations set, whatever they are: a handler
    ///         that set one fixed valid configuration for large seeds would pass it and every invariant while the
    ///         fuzzer's calls hardly varied the modes.
    function test_ownerConfigurationsVaryAtTheDesignedRate() public {
        // Classes as in _countConfiguration.
        uint256[3] memory num = [uint256(36), 168, 180];
        for (uint256 family = 0; family < 2; ++family) {
            uint256[3] memory counts;
            for (uint256 i = 0; i < VARIETY_SEEDS; ++i) {
                _countConfiguration(
                    counts,
                    abi.encodeCall(GaslessHandler.reconfigure, (_rateSeed(family, i, 0), _rateSeed(family, i, 1)))
                );
            }
            for (uint256 k = 0; k < counts.length; ++k) {
                _assertRate(counts[k], VARIETY_SEEDS, num[k], 512, string.concat("reconfigure", _className(k)));
            }
        }
    }

    /// @notice With a transfer pending, every moveOwnership call has one step of the account allowed to take it: the
    ///         pending owner accepts in 15 of 32, the owner renounces in one of 16 and names a candidate or cancels in
    ///         the others; for seeds of both families.
    function test_ownershipMovesAtTheDesignedRate() public {
        handler.moveOwnership(_moveSeed(0, 1, false)); // a transfer to a candidate, left pending
        assertTrue(gasless.pendingOwner() != address(0), "a transfer is pending");
        uint256 renounced;
        for (uint256 family = 0; family < 2; ++family) {
            uint256 stepped;
            uint256 accepted;
            for (uint256 i = 0; i < RATE_SEEDS; ++i) {
                (uint256 steps, bool renounce, bool accept) =
                    _ownerCallsOf(abi.encodeCall(GaslessHandler.moveOwnership, (_rateSeed(family, i, 3))));
                stepped += steps;
                if (renounce) ++renounced;
                if (accept) ++accepted;
            }
            assertEq(stepped, RATE_SEEDS, "moveOwnership: a step of the allowed account in every call");
            _assertRate(accepted, RATE_SEEDS, 15, 32, "moveOwnership: the pending owner accepts");
        }
        _assertRate(renounced, 2 * RATE_SEEDS, 1, 16, "moveOwnership: the owner renounces");
    }

    /// @dev Argument `arg` of the `i`-th measured call: a hash over the whole uint256 range (family 0), or one shifted
    ///      right by a hashed amount (family 1), so of every bit length from 1 to 256, also small.
    function _rateSeed(uint256 family, uint256 i, uint256 arg) internal pure returns (uint256 seed) {
        seed = uint256(keccak256(abi.encode("owner rate", i, arg)));
        if (family == 1) seed >>= uint256(keccak256(abi.encode("bit length", i, arg))) % 256;
    }

    /// @dev The handler `call`ed, then the state reverted: the calls of the account allowed to act it made that took
    ///      effect (ownerCalls), whether the owner renounced, and whether the pending owner accepted.
    function _ownerCallsOf(bytes memory call) internal returns (uint256 calls, bool renounced, bool accepted) {
        uint256 snapshot = vm.snapshotState();
        uint256 before = handler.ownerCalls();
        address pending = gasless.pendingOwner();
        (bool ok,) = address(handler).call(call);
        assertTrue(ok, "the handler reverted");
        calls = handler.ownerCalls() - before;
        renounced = gasless.owner() == address(0);
        accepted = gasless.owner() == pending;
        vm.revertToStateAndDelete(snapshot);
    }

    /// @dev `count` of `n` calls is within four standard deviations of the binomial count at the designed rate
    ///      `num` / `den`: |count - n * num / den| <= 4 * sqrt(n * num / den * (1 - num / den)).
    function _assertRate(uint256 count, uint256 n, uint256 num, uint256 den, string memory action) internal pure {
        uint256 d = count * den > n * num ? count * den - n * num : n * num - count * den;
        assertLe(
            d * d,
            16 * n * num * (den - num),
            string.concat(action, ": the action took effect in ", vm.toString(count), " of ", vm.toString(n))
        );
    }

    /// @dev The handler `call`ed, then the state reverted: the configuration the owner set, if any, read back with
    ///      tokenConfig(), counted in `counts` by its modes (0 none, 1 permit and allowance, 2 others).
    function _countConfiguration(uint256[3] memory counts, bytes memory call) internal {
        uint256 snapshot = vm.snapshotState();
        uint256 before = handler.ownerCalls();
        (bool ok,) = address(handler).call(call);
        assertTrue(ok, "the handler reverted");
        if (handler.ownerCalls() != before) {
            TokenConfig memory c = gasless.tokenConfig(handler.lastConfigured());
            if (!c.permit && !c.metaTxApprove && !c.allowance) ++counts[0];
            else ++counts[c.permit && c.allowance ? 1 : 2];
        }
        vm.revertToStateAndDelete(snapshot);
    }

    function _className(uint256 k) internal pure returns (string memory) {
        if (k == 0) return ", removed";
        if (k == 1) return ", permit and allowance";
        return ", other modes";
    }
}
