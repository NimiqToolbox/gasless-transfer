// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenConfig} from "../../src/interfaces/IGaslessBase.sol";

import {IERC20Like, SpecBase} from "./SpecBase.sol";
import {GaslessHandler, IHandlerOwnable} from "./handlers/GaslessHandler.sol";

/// @notice Stateful invariants TI1-TI5 of docs/STEP-1-GAS-ABSTRACTION.md §3 and the owner's configuration (D6, §4.2),
///         driven by GaslessHandler: transfers, attacks and nonce increases interleaved with the owner's
///         setTokenConfig and Ownable2Step actions.
contract InvariantSpecTest is SpecBase {
    /// @dev Fixed seeds per family in the rate self-tests.
    uint256 internal constant RATE_SEEDS = 128;
    /// @dev Fixed seeds per family in the variety self-tests: enough that a class of at least 1 in 32 calls that never
    ///      occurs lies outside four standard deviations.
    uint256 internal constant VARIETY_SEEDS = 4 * RATE_SEEDS;

    GaslessHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new GaslessHandler(gasless, usdc, usdt, owner, defaultTokens());

        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = GaslessHandler.transferValid.selector;
        selectors[1] = GaslessHandler.transferMutated.selector;
        selectors[2] = GaslessHandler.forgeAgainstVictim.selector;
        selectors[3] = GaslessHandler.replay.selector;
        selectors[4] = GaslessHandler.wrongRelayOrExpired.selector;
        selectors[5] = GaslessHandler.invalidate.selector;
        selectors[6] = GaslessHandler.donate.selector;
        selectors[7] = GaslessHandler.warp.selector;
        selectors[8] = GaslessHandler.approveStanding.selector;
        selectors[9] = GaslessHandler.transferRejectedAuth.selector;
        selectors[10] = GaslessHandler.setTokenConfig.selector;
        selectors[11] = GaslessHandler.transferAcrossReconfiguration.selector;
        selectors[12] = GaslessHandler.transferOwnership.selector;
        selectors[13] = GaslessHandler.acceptOwnership.selector;
        selectors[14] = GaslessHandler.renounceOwnership.selector;
        selectors[15] = GaslessHandler.transferValid.selector; // more honest transfers: the owner refuses some
        selectors[16] = GaslessHandler.transferRejectedAuth.selector; // standing allowances (T18, TI5), weighted alike
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ================================================================ invariants

    /// @notice TI1 + TI2: every tracked balance equals its expected value, which only changes when a request signed
    ///         by the debited account was consumed (from pays amount + fee, to gets amount, relay gets fee) or the
    ///         account donated itself. A debit without a consumed signature breaks the equality.
    function invariant_TI1_TI2_balancesMoveOnlyThroughSignedRequests() public view {
        uint256 n = handler.trackedCount();
        for (uint256 t = 0; t < handler.tokenCount(); ++t) {
            address token = handler.tokens(t);
            for (uint256 i = 0; i < n; ++i) {
                address account = handler.tracked(i);
                assertEq(
                    IERC20Like(token).balanceOf(account),
                    handler.expectedBalance(token, account),
                    "balance differs from the signed requests consumed"
                );
            }
        }
    }

    /// @notice TI1: each successful call moved exactly amount + fee / amount / fee, raised the nonce by exactly one
    ///         and left the contract balance unchanged (checked by the handler around every call).
    function invariant_TI1_everySuccessfulTransferWasExact() public view {
        assertEq(handler.ti1Violations(), 0, "a successful transfer broke TI1");
    }

    /// @notice TI2: no unsigned, altered, replayed, misrouted or expired request ever succeeded, and the victim's
    ///         unlimited allowances were never touched.
    function invariant_TI2_noUnsignedRequestEverSucceeded() public view {
        assertEq(handler.forgedSuccesses(), 0, "an unsigned or altered request succeeded");
        for (uint256 t = 0; t < handler.tokenCount(); ++t) {
            assertEq(
                IERC20Like(handler.tokens(t)).allowance(handler.victim(), address(gasless)),
                type(uint256).max,
                "victim allowance used"
            );
        }
    }

    /// @notice TI3: nonces only increase: each account's nonce is the number of its executed requests plus its own
    ///         valid increases, and nobody else (the attacker, the owner, a failed call) ever moved it. The victim and
    ///         the outsider, who never sign, stay at 0.
    function invariant_TI3_noncesOnlyIncreaseAsSigned() public view {
        assertEq(handler.ti3Violations(), 0, "a nonce moved otherwise than by its signer");
        uint256 n = handler.trackedCount();
        for (uint256 i = 0; i < n; ++i) {
            address account = handler.tracked(i);
            assertEq(gasless.nonces(account), handler.expectedNonce(account), "nonce");
        }
        assertEq(gasless.nonces(handler.victim()), 0, "victim nonce");
        assertEq(gasless.nonces(handler.outsider()), 0, "outsider nonce");
    }

    /// @notice TI4: the contract's token balance is exactly what was donated to it directly.
    function invariant_TI4_contractHoldsOnlyDonations() public view {
        for (uint256 t = 0; t < handler.tokenCount(); ++t) {
            address token = handler.tokens(t);
            assertEq(IERC20Like(token).balanceOf(address(gasless)), handler.donated(token), "contract holds tokens");
        }
    }

    /// @notice TI5: no allowance to the contract is left after any PERMIT or META_TX call, and such a call never spends
    ///         a standing allowance other than exactly amount + fee (checked around every call by the handler). Users
    ///         also hold standing allowances so between calls every user's allowance equals its standing
    ///         approval, or 0 once a call of that user succeeded or was refused by the configuration.
    function invariant_TI5_noLeftoverAllowance() public view {
        assertEq(handler.ti5Violations(), 0, "allowance left after a PERMIT / META_TX call");
        uint256 n = handler.userCount();
        for (uint256 t = 0; t < handler.tokenCount(); ++t) {
            address token = handler.tokens(t);
            for (uint256 i = 0; i < n; ++i) {
                address user = handler.users(i);
                assertEq(
                    IERC20Like(token).allowance(user, address(gasless)),
                    handler.expectedAllowance(token, user),
                    "allowance"
                );
            }
        }
    }

    /// @notice Liveness (keeps the other invariants from passing vacuously): every validly signed and authorized
    ///         request that the owner's configuration allows succeeded, including after front-running of its token
    ///         authorization, and every valid nonce increase succeeded.
    function invariant_validRequestsAlwaysSucceed() public view {
        assertEq(handler.validFailures(), 0, "a valid request failed");
    }

    /// @notice D6: a request executes only if the configuration the owner set (the handler's ghost copy, not the
    ///         contract's tokenConfig()) allows its token and mode at call time, whatever its fee, and it is refused
    ///         exactly when that configuration refuses it, with that configuration's error (TokenNotSupported,
    ///         AuthModeNotSupported).
    function invariant_D6_requestsFollowTheOwnersConfiguration() public view {
        assertEq(handler.configMismatches(), 0, "a request's outcome differs from the owner's configuration");
    }

    /// @notice §4.2: tokenConfig() of every token (also the ones outside the initial set), of an address without code
    ///         and of the contract itself equals what the owner set; owner() and pendingOwner() follow Ownable2Step;
    ///         every owner action by another account, an invalid configuration, and everything after a renounce
    ///         reverted and changed nothing.
    function invariant_D6_configurationIsWhatTheOwnerSet() public view {
        assertEq(
            handler.ownerViolations(), 0, "an owner action ended otherwise than Ownable2Step and section 4.2 define"
        );
        uint256 n = handler.configTargetCount();
        for (uint256 i = 0; i < n; ++i) {
            address target = handler.configTargets(i);
            TokenConfig memory actual = gasless.tokenConfig(target);
            TokenConfig memory ghost = handler.ghostConfig(target);
            assertEq(actual.permit, ghost.permit, "tokenConfig().permit differs from the owner's");
            assertEq(actual.metaTxApprove, ghost.metaTxApprove, "tokenConfig().metaTxApprove differs from the owner's");
            assertEq(actual.allowance, ghost.allowance, "tokenConfig().allowance differs from the owner's");
        }
        assertEq(IHandlerOwnable(address(gasless)).owner(), handler.ghostOwner(), "owner");
        assertEq(IHandlerOwnable(address(gasless)).pendingOwner(), handler.ghostPendingOwner(), "pending owner");
    }

    /// @notice D6: the owner's actions (successful or not) never change a balance, an allowance, a token nonce or an
    ///         intent nonce.
    function invariant_D6_ownerActionsMoveNothing() public view {
        assertEq(handler.ownerSideEffects(), 0, "an owner action changed a balance, an allowance or a nonce");
    }

    /// @notice The contract's events match the actions: NonceInvalidated for a valid increase, TokenConfigSet for a
    ///         configuration change, Ownable2Step's events for ownership steps, exactly one TransferRelayed, after
    ///         every token log, for an executed transfer (D13), nothing for a failed call; an executed transfer's token
    ///         logs are the fee, then the principal (§4.3).
    function invariant_eventsMatchActions() public view {
        assertEq(handler.eventViolations(), 0, "the contract's events differ from the actions");
    }

    /// @notice Every run is not vacuous: it judged validly signed requests against the owner's configuration,
    ///         attacked, and the owner changed a configuration (the first owner action of a run starts with one,
    ///         whoever the fuzzer picks as callers). In a run of 64 calls each of these is missing with a chance below
    ///         10^-8. That the owner acts at its designed rate in the calls after the first, whatever the seeds, is up
    ///         to the rate self-tests below.
    function afterInvariant() external view {
        assertGt(
            handler.validSuccesses() + handler.configRefusals() + handler.standingRefusals(), 0, "no request judged"
        );
        assertGt(handler.forgedAttempts(), 0, "no attack");
        assertGt(handler.reconfigurations(), 0, "the owner set no configuration");
    }

    // ================================================================ handler self-tests

    /// @notice Drives every handler action once with fixed inputs and checks that the handler really exercises what
    ///         the invariants rely on: valid transfers succeed in all routes (also front-run), every forgery attempt
    ///         fails, and all invariants hold afterwards.
    function test_invariantHandlerIsNotVacuous() public {
        for (uint256 i = 0; i < 10; ++i) {
            handler.transferValid(i, i + 3, i, i % 5, 12_345_678 + i, 50_000 * i, 600, i % 2 == 0);
        }
        for (uint256 field = 0; field < 11; ++field) {
            // The value is also the fee seed (never 7 modulo 8: a fee up to MAX_TEST_FEE) and the relay seed (both
            // relays).
            handler.transferMutated(field, field % 5, field, 1000 + 8 * field + field % 2, 777_777 + field);
        }
        for (uint256 v = 0; v < 5; ++v) {
            handler.forgeAgainstVictim(v, v, 1e6 + v, keccak256("r"), keccak256("s"), 27);
        }
        handler.replay(0, false);
        handler.replay(3, true);
        handler.wrongRelayOrExpired(0, 1, 5e6, true);
        handler.wrongRelayOrExpired(1, 4, 5e6, false);
        handler.invalidate(0, 1, false);
        handler.invalidate(0, 2, true);
        handler.invalidate(1, 4, false);
        handler.invalidate(2, 3, false); // more than 2^32 - 1 above the current nonce
        handler.donate(2, 0, 3e6);
        handler.donate(1, 2, 4e6);
        handler.warp(1 hours);
        handler.transferValid(1, 2, 1, 3, 8, 0, 60, true);

        assertEq(handler.validFailures(), 0, string(handler.lastValidFailure()));
        assertEq(handler.validSuccesses(), 22);
        assertEq(handler.forgedSuccesses(), 0);
        assertGe(handler.forgedAttempts(), 20);
        assertGe(handler.frontRuns(), 3);
        assertEq(handler.donations(), 2);
        assertEq(handler.invalidations(), 4);
        assertEq(gasless.nonces(handler.users(2)), handler.expectedNonce(handler.users(2)), "too far is refused");

        // standing allowances, then every rejected token authorization over every standing shape (exactly
        // amount + fee, one unit less, more, unlimited, none) in all five routes.
        for (uint256 i = 0; i < 4; ++i) {
            handler.approveStanding(i, i, i);
        }
        for (uint256 i = 0; i < 30; ++i) {
            // Route i % 5, standing shape i / 5 % 5, rejected authorization i % 6, by user 0 (the calls above spent
            // some other users' whole balances). An odd amount seed never picks the whole balance, so every attempt
            // has a request to submit. The upper bits of the kind seed (a multiple of 6, so the kind stays i % 6)
            // vary the fee (kindSeed >> 16) and the recipient (kindSeed >> 8).
            handler.transferRejectedAuth(0, i % 5, 1001 + 2 * i, i / 5, i % 6 + 6 * 65_536 * (1 + 997 * i));
        }
        assertEq(handler.validFailures(), 0, string(handler.lastValidFailure()));
        assertEq(handler.forgedSuccesses(), 0, "a standing allowance other than amount + fee was spent");
        assertEq(handler.validSuccesses(), 22 + 10, "exactly amount + fee in place is accepted");
        assertEq(handler.standingRefusals(), 20, "every other standing allowance is refused");
        assertEq(handler.configRefusals(), 0, "the initial configuration refuses nothing here");

        _assertAllInvariants();
    }

    /// @notice The owner's actions are not vacuous. Requests on the tokens outside the initial set are refused until
    ///         the owner adds them; a narrowed mode set and a removal refuse requests with exactly their error, and a
    ///         fee far above the usual ones still passes; a request signed while refused executes once the owner allows
    ///         it. Other accounts and invalid configurations are refused. Ownership moves in two steps; a wrong
    ///         acceptance, the former owner and a cancelled transfer are refused; after a renounce no account changes
    ///         the configuration or the ownership again, and transfers go on under the frozen configuration.
    function test_ownerActionsAreNotVacuous() public {
        // Routes 20-24: the five routes on the USDC and USDT0 mocks outside the initial configuration.
        for (uint256 i = 5; i < 10; ++i) {
            handler.transferValid(i, i + 3, i, 15 + i, 12_345_678 + i, 50_000 * i, 600, false);
        }
        assertEq(handler.configRefusals(), 5, "TokenNotSupported before the owner adds a token");
        assertEq(handler.validSuccesses(), 0);

        // The first owner action starts with the owner's own setTokenConfig (seed 12 >> 4 = 0: USDC with its modes,
        // its initial configuration); then the attacker's call.
        handler.setTokenConfig(12, 2, 0);
        assertEq(handler.reconfigurations(), 1, "the owner acts first in a run");
        assertEq(handler.ownerRefusals(), 1, "only the owner configures");
        handler.setTokenConfig(1, 2, 0); // the owner adds both tokens with all their modes
        handler.setTokenConfig(1, 3, 0);
        assertEq(handler.reconfigurations(), 1 + 2);
        for (uint256 i = 5; i < 10; ++i) {
            handler.transferValid(i, i + 3, i, 15 + i, 12_345_678 + i, 50_000 * i, 600, i % 2 == 0);
        }
        assertEq(handler.validSuccesses(), 5, "the added tokens are served in every route");

        // USDT0: PERMIT only (kind 4 with the permit bit).
        handler.setTokenConfig(1, 1, 4 + 8);
        handler.transferValid(0, 3, 0, 3, 1e6 + 1, 0, 600, false); // AuthModeNotSupported (META_TX)
        handler.transferValid(0, 3, 0, 4, 1e6 + 1, 0, 600, false); // AuthModeNotSupported (NONE)
        handler.transferValid(0, 3, 0, 2, 1e6 + 1, 7 + 8 * 100e6, 600, true); // PERMIT with a fee of 100.00 passes
        // USDC removed.
        handler.setTokenConfig(1, 0, 7);
        handler.transferValid(1, 3, 0, 0, 1e6 + 1, 0, 600, false); // TokenNotSupported
        handler.transferValid(1, 3, 0, 1, 1e6 + 1, 0, 600, false);
        assertEq(handler.configRefusals(), 5 + 4);
        assertEq(handler.validSuccesses(), 6);

        // Invalid configurations: modes for a target without code or for the contract itself.
        handler.setTokenConfig(1, 8, 0);
        handler.setTokenConfig(1, 9, 0);
        handler.setTokenConfig(1, 8, 4 + 32); // random modes: allowance only
        assertEq(handler.ownerRefusals(), 1 + 3, "InvalidConfig");
        // Removing a target without code, or the contract itself (random modes, none), is valid.
        handler.setTokenConfig(1, 8, 7);
        handler.setTokenConfig(1, 9, 4);
        assertEq(handler.reconfigurations(), 1 + 6);

        // D6: a USDC request signed while USDC is removed executes once the owner restores USDC before submission;
        // one signed while the extra USDC mock is served is refused once the owner removes it.
        handler.transferAcrossReconfiguration(2, 0, 2e6 + 1, 30_000, 256);
        handler.transferAcrossReconfiguration(3, 20, 2e6 + 1, 30_000, 256 + 7);
        assertEq(handler.validSuccesses(), 7, "revived by the owner");
        assertEq(handler.configRefusals(), 10, "refused after the owner removed the token");

        // Ownership: the attacker cannot start a transfer; the owner names inv-owner-1; neither the current owner nor
        // the attacker can accept; the pending owner does.
        handler.transferOwnership(12, 1);
        handler.transferOwnership(1, 1);
        handler.acceptOwnership(1);
        handler.acceptOwnership(7);
        handler.acceptOwnership(0);
        assertEq(handler.ownershipMoves(), 1);
        assertEq(handler.ghostOwner(), handler.ownerCandidates(1));
        handler.setTokenConfig(0, 0, 0); // the former owner
        handler.transferOwnership(1, 3); // the new owner cancels a transfer (pending owner 0) ...
        handler.acceptOwnership(0); // ... so nobody can accept
        handler.setTokenConfig(1, 0, 0); // the new owner restores USDC
        assertEq(handler.ownerRefusals(), 4 + 5);
        assertEq(handler.reconfigurations(), 1 + 8 + 1);

        // Renounce with a transfer pending: afterwards nobody, not even the former pending owner, changes anything.
        handler.transferOwnership(1, 2);
        handler.renounceOwnership(_renounceSeed(1, false)); // another account
        handler.renounceOwnership(_renounceSeed(0, true)); // the owner
        assertEq(handler.ghostOwner(), address(0));
        assertEq(IHandlerOwnable(address(gasless)).pendingOwner(), address(0), "renounce clears the pending owner");
        uint256 refusalsBefore = handler.ownerRefusals();
        for (uint256 i = 0; i < 4; ++i) {
            handler.setTokenConfig(4 * i, i, 0);
            handler.setTokenConfig(4 * i, i, 7);
            handler.transferOwnership(4 * i, i);
            handler.acceptOwnership(2 * i + 1);
            handler.renounceOwnership(8 * i + 1);
            handler.transferAcrossReconfiguration(i, i, 1e6 + 1, 10_000, 4 * i << 8);
        }
        assertEq(handler.ownerRefusals(), refusalsBefore + 4 * 6, "nothing changes after a renounce");
        assertEq(handler.reconfigurations(), 1 + 9);
        for (uint256 i = 0; i < 10; ++i) {
            handler.transferValid(i, i + 3, i, i < 5 ? i : 15 + i, 1e6 + i, 50_000 * i, 600, false);
        }

        assertEq(handler.validFailures(), 0, string(handler.lastValidFailure()));
        assertGt(handler.configRefusals(), 10);
        _assertAllInvariants();
    }

    /// @dev The first seed from `from` on which the owner renounces (`renounce`), or does not.
    function _renounceSeed(uint256 from, bool renounce) internal view returns (uint256 seed) {
        for (seed = from; handler.renounces(seed) != renounce; ++seed) {}
    }

    function _assertAllInvariants() internal view {
        invariant_TI1_TI2_balancesMoveOnlyThroughSignedRequests();
        invariant_TI1_everySuccessfulTransferWasExact();
        invariant_TI2_noUnsignedRequestEverSucceeded();
        invariant_TI3_noncesOnlyIncreaseAsSigned();
        invariant_TI4_contractHoldsOnlyDonations();
        invariant_TI5_noLeftoverAllowance();
        invariant_validRequestsAlwaysSucceed();
        invariant_D6_requestsFollowTheOwnersConfiguration();
        invariant_D6_configurationIsWhatTheOwnerSet();
        invariant_D6_ownerActionsMoveNothing();
        invariant_eventsMatchActions();
    }

    // ================================================================ owner rates

    /// @notice The owner's actions take effect at their designed rate for seeds over the whole uint256 range. The owner
    ///         makes three of four calls of setTokenConfig, of transferAcrossReconfiguration's reconfiguration and of
    ///         transferOwnership; a configuration it sets for a token is always valid, and one for an address without
    ///         code or the contract itself (two targets of ten) only if it removes (kind 7, or kind 4-6 without modes:
    ///         11 of 64). So it sets a configuration in 3/4 * (8/10 + 2/10 * 11/64) = 801/1280 setTokenConfig calls and
    ///         in 3/4 of the reconfigurations, and names a candidate in 3/4 transferOwnership calls. The fixed-input
    ///         self-tests use small seeds, and the first owner action of a run is the owner's whatever the seeds
    ///         (afterInvariant): a handler that let the owner act, or set a valid configuration, only for small seeds
    ///         or only for odd seeds would pass them and every invariant (the ghost follows a refusal) while the
    ///         fuzzer's calls changed the configuration far less often.
    function test_ownerActsAtTheDesignedRate_wholeRange() public {
        _assertOwnerRates(0);
    }

    /// @notice The same for seeds of every bit length, as the fuzzer draws uint256 values (most of them far below
    ///         2^256): a handler that let the owner act only for large seeds fails here.
    function test_ownerActsAtTheDesignedRate_everyBitLength() public {
        _assertOwnerRates(1);
    }

    /// @notice While a transfer is pending, the pending owner makes five of eight calls of acceptOwnership, for seeds of
    ///         both families.
    function test_pendingOwnerAcceptsAtTheDesignedRate() public {
        handler.transferOwnership(1, 1); // the run's first owner action, then the owner's transfer to inv-owner-1
        assertEq(IHandlerOwnable(address(gasless)).pendingOwner(), handler.ownerCandidates(1), "a transfer is pending");
        for (uint256 family = 0; family < 2; ++family) {
            uint256 accepted;
            for (uint256 i = 0; i < RATE_SEEDS; ++i) {
                accepted += _ownerCallsOf(abi.encodeCall(GaslessHandler.acceptOwnership, (_rateSeed(family, i, 12))));
            }
            _assertRate(accepted, RATE_SEEDS, 5, 8, "acceptOwnership");
        }
    }

    /// @notice The owner renounces in one renounceOwnership call of 16, for seeds of both families.
    function test_ownerRenouncesAtTheDesignedRate() public {
        handler.acceptOwnership(0); // the run's first owner action (then the owner tries to accept, with none pending)
        uint256 renounced;
        for (uint256 family = 0; family < 2; ++family) {
            for (uint256 i = 0; i < 2 * RATE_SEEDS; ++i) {
                renounced += _ownerCallsOf(abi.encodeCall(GaslessHandler.renounceOwnership, (_rateSeed(family, i, 13))));
            }
        }
        _assertRate(renounced, 4 * RATE_SEEDS, 1, 16, "renounceOwnership");
    }

    /// @dev setTokenConfig, transferAcrossReconfiguration and transferOwnership, each called for RATE_SEEDS seeds of
    ///      `family` from one state: the calls in which the owner's action took effect.
    function _assertOwnerRates(uint256 family) internal {
        handler.acceptOwnership(0); // the run's first owner action, so that no measured call starts with it
        uint256 configured;
        uint256 reconfigured;
        uint256 transferred;
        uint256[10] memory s;
        for (uint256 i = 0; i < RATE_SEEDS; ++i) {
            for (uint256 k = 0; k < s.length; ++k) {
                s[k] = _rateSeed(family, i, k);
            }
            configured += _ownerCallsOf(abi.encodeCall(GaslessHandler.setTokenConfig, (s[0], s[1], s[2])));
            reconfigured += _ownerCallsOf(
                abi.encodeCall(GaslessHandler.transferAcrossReconfiguration, (s[3], s[4], s[5], s[6], s[7]))
            );
            transferred += _ownerCallsOf(abi.encodeCall(GaslessHandler.transferOwnership, (s[8], s[9])));
        }
        _assertRate(configured, RATE_SEEDS, 801, 1280, "setTokenConfig");
        _assertRate(reconfigured, RATE_SEEDS, 3, 4, "transferAcrossReconfiguration");
        _assertRate(transferred, RATE_SEEDS, 3, 4, "transferOwnership");
    }

    /// @dev Argument `arg` of the `i`-th measured call: a hash over the whole uint256 range (family 0), or one shifted
    ///      right by a hashed amount (family 1), so of every bit length from 1 to 256, also small.
    function _rateSeed(uint256 family, uint256 i, uint256 arg) internal pure returns (uint256 seed) {
        seed = uint256(keccak256(abi.encode("owner rate", i, arg)));
        if (family == 1) seed >>= uint256(keccak256(abi.encode("bit length", i, arg))) % 256;
    }

    /// @dev The handler `call`ed, then the state reverted: the calls of the account allowed to act it made that took
    ///      effect (ownerCalls).
    function _ownerCallsOf(bytes memory call) internal returns (uint256 calls) {
        uint256 snapshot = vm.snapshotState();
        uint256 before = handler.ownerCalls();
        (bool ok,) = address(handler).call(call);
        assertTrue(ok, "the handler reverted");
        calls = handler.ownerCalls() - before;
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

    // ================================================================ configuration variety

    /// @notice The configurations the owner sets vary at their designed rates for seeds over the whole uint256
    ///         range. Of 1280 setTokenConfig calls it removes a configuration in 165 (3/4 * 11/64), sets permit and
    ///         allowance in 456 (every mode the token supports, kinds 0-3, or random modes with both: 3/4 * 8/10 *
    ///         38/64) and other random modes in 180 (3/4 * 8/10 * 15/64). Of 512 reconfigurations between signature and
    ///         submission it removes in 66, sets permit and allowance in 228 and other modes in 90 (3/4 * 11/64, 38/64
    ///         and 15/64). The rate self-tests count the configurations set, whatever they are: a handler that set one
    ///         fixed valid configuration for large seeds would pass them, every invariant and the fixed-input
    ///         self-tests while the fuzzer's calls hardly varied the modes.
    function test_ownerConfigurationsVaryAtTheDesignedRate_wholeRange() public {
        _assertConfigurationRates(0);
    }

    /// @notice The same for seeds of every bit length.
    function test_ownerConfigurationsVaryAtTheDesignedRate_everyBitLength() public {
        _assertConfigurationRates(1);
    }

    /// @dev setTokenConfig and transferAcrossReconfiguration, each called for VARIETY_SEEDS seeds of `family` from one
    ///      state: the classes of the configurations the owner set.
    function _assertConfigurationRates(uint256 family) internal {
        handler.acceptOwnership(0); // the run's first owner action, so that no measured call starts with it
        uint256[3] memory configured;
        uint256[3] memory reconfigured;
        uint256[8] memory s;
        for (uint256 i = 0; i < VARIETY_SEEDS; ++i) {
            for (uint256 k = 0; k < s.length; ++k) {
                s[k] = _rateSeed(family, i, k);
            }
            _countConfiguration(configured, abi.encodeCall(GaslessHandler.setTokenConfig, (s[0], s[1], s[2])));
            _countConfiguration(
                reconfigured,
                abi.encodeCall(GaslessHandler.transferAcrossReconfiguration, (s[3], s[4], s[5], s[6], s[7]))
            );
        }
        _assertClassRates(configured, [uint256(165), 456, 180], 1280, "setTokenConfig");
        _assertClassRates(reconfigured, [uint256(66), 228, 90], 512, "transferAcrossReconfiguration");
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

    /// @dev Every class occurs at its designed rate num[k] / den in the VARIETY_SEEDS calls.
    function _assertClassRates(uint256[3] memory counts, uint256[3] memory num, uint256 den, string memory action)
        internal
        pure
    {
        for (uint256 k = 0; k < counts.length; ++k) {
            _assertRate(counts[k], VARIETY_SEEDS, num[k], den, string.concat(action, _className(k)));
        }
    }

    function _className(uint256 k) internal pure returns (string memory) {
        if (k == 0) return ", removed";
        if (k == 1) return ", permit and allowance";
        return ", other modes";
    }
}
