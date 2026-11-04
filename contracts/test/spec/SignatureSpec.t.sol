// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthMode, IGaslessBase, TokenAuth} from "../../src/interfaces/IGaslessBase.sol";
import {IGaslessTransfer, TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";

import {SpecBase} from "./SpecBase.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";

/// @notice P1 "only signed pulls": T02, T03, T08-T09, T19, T28 (docs/STEP-1-GAS-ABSTRACTION.md §3, §8).
contract SignatureSpecTest is SpecBase {
    // ================================================================ T02

    /// @notice T02 with the T01 attempt list, on mocks: an attacker who runs its own relay tries to spend the
    ///         max-approved victim in every (token, mode) with an empty signature, its own signature, a tampered
    ///         victim signature, 65 zero bytes, and victim signatures that were made for other requests, another
    ///         relay or another token authorization. Nothing may move.
    function test_T02_forgedRequestsAgainstMaxApprovedVictimMoveNothing() public {
        // The only intent the victim ever signed: 25 USDC to carol through the legitimate relay.
        TransferRequest memory signedByVictim = request(address(usdc), victim);
        bytes memory victimSig = signRequest(victimKey, signedByVictim, noAuth());
        VictimState memory before = observeVictim();

        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, victim);
            r.to = attacker;
            r.relay = attacker;
            r.amount = FUNDS - MAX_TEST_FEE;
            r.fee = MAX_TEST_FEE;
            TokenAuth memory garbageAuth = TokenAuth({mode: mode, v: 27, r: keccak256("r"), s: keccak256("s")});

            expectRevertNoChange(attacker, r, "", garbageAuth, errInvalidSignature());
            expectRevertNoChange(attacker, r, new bytes(65), garbageAuth, errInvalidSignature());
            expectRevertNoChange(
                attacker, r, signRequest(attackerKey, r, garbageAuth), garbageAuth, errInvalidSignature()
            );

            bytes memory tampered = signRequest(victimKey, r, garbageAuth);
            tampered[10] ^= 0x01;
            expectRevertNoChange(attacker, r, tampered, garbageAuth, errInvalidSignature());

            // A genuine victim signature, but for another request.
            expectRevertNoChange(attacker, r, victimSig, garbageAuth, errInvalidSignature());
        }

        // The victim's real request, rebound to the attacker's relay (same fields otherwise).
        TransferRequest memory rebound = copy(signedByVictim);
        rebound.relay = attacker;
        expectRevertNoChange(attacker, rebound, victimSig, noAuth(), errInvalidSignature());
        // ... or submitted unchanged by the attacker instead of the relay it is bound to.
        expectRevertNoChange(attacker, signedByVictim, victimSig, noAuth(), errNotRelay(attacker, relay));
        // ... or redirected by the relay it is bound to.
        TransferRequest memory redirected = copy(signedByVictim);
        redirected.to = attacker;
        expectRevertNoChange(relay, redirected, victimSig, noAuth(), errInvalidSignature());
        // ... or with a token authorization the victim did not sign.
        TokenAuth memory permit = TokenAuth({mode: AuthMode.PERMIT, v: 27, r: keccak256("r"), s: keccak256("s")});
        expectRevertNoChange(relay, signedByVictim, victimSig, permit, errInvalidSignature());

        assertVictimUntouched(before);
    }

    /// @notice T02: every function of the §4.4 surface, called by the attacker with victim-related arguments,
    ///         leaves the victim's balances, allowances, token nonces and intent nonce unchanged.
    function test_T02_everyAllowlistedFunctionMovesNothing() public {
        VictimState memory before = observeVictim();
        TransferRequest memory r = request(address(usdc), victim);
        r.to = attacker;
        r.relay = attacker;

        bytes[] memory calls = new bytes[](17);
        calls[0] = abi.encodeCall(IGaslessTransfer.relayTransfer, (r, new bytes(65), noAuth()));
        calls[1] = abi.encodeCall(IGaslessTransfer.hashTransfer, (r, 0, noAuth()));
        calls[2] = abi.encodeCall(IGaslessTransfer.TRANSFER_TYPE, ());
        calls[3] = abi.encodeCall(IGaslessTransfer.TRANSFER_TYPEHASH, ());
        calls[4] = abi.encodeCall(IGaslessBase.TOKEN_AUTH_TYPE, ());
        calls[5] = abi.encodeCall(IGaslessBase.TOKEN_AUTH_TYPEHASH, ());
        calls[6] = abi.encodeCall(IGaslessBase.nonces, (victim));
        calls[7] = abi.encodeCall(IGaslessBase.invalidateNonces, (1));
        calls[8] = abi.encodeCall(IGaslessBase.tokenConfig, (address(usdc)));
        calls[9] = abi.encodeCall(IGaslessBase.DOMAIN_SEPARATOR, ());
        calls[10] = abi.encodeWithSignature("eip712Domain()");
        calls[11] = abi.encodeCall(IGaslessBase.setTokenConfig, (address(usdc), config(false, false, true)));
        calls[12] = abi.encodeWithSignature("owner()");
        calls[13] = abi.encodeWithSignature("pendingOwner()");
        calls[14] = abi.encodeWithSignature("transferOwnership(address)", attacker);
        calls[15] = abi.encodeWithSignature("acceptOwnership()");
        calls[16] = abi.encodeWithSignature("renounceOwnership()");

        for (uint256 i = 0; i < calls.length; ++i) {
            vm.prank(attacker);
            (bool ok,) = address(gasless).call(calls[i]);
            if (i == 0) assertFalse(ok, "relayTransfer without a victim signature succeeded");
            if (i >= 11 && i != 12 && i != 13) assertFalse(ok, "an owner function accepted the attacker");
            assertVictimUntouched(before);
        }
        // The attacker's invalidateNonces raised the attacker's own nonce, not the victim's.
        assertEq(gasless.nonces(attacker), 1);
        assertEq(gasless.nonces(victim), 0);
    }

    /// @notice T02: foreign token, swap, administration and generic-call selectors revert without moving tokens.
    function test_T02_foreignAndAdminSelectorsRevertAndMoveNothing() public {
        VictimState memory before = observeVictim();
        string[] memory sigs = _foreignSignatures();
        for (uint256 i = 0; i < sigs.length; ++i) {
            bytes memory data = abi.encodePacked(
                bytes4(keccak256(bytes(sigs[i]))),
                abi.encode(victim, address(usdc), FUNDS, attacker, bytes32(0), uint256(0), attacker, uint256(0))
            );
            vm.prank(attacker);
            (bool ok,) = address(gasless).call(data);
            assertFalse(ok, string.concat("call did not revert: ", sigs[i]));
            assertVictimUntouched(before);
        }
    }

    /// @notice T02 (fuzz): arbitrary calldata from an arbitrary caller never moves the victim's funds.
    function testFuzz_T02_arbitraryCalldataMovesNothing(address caller, bytes calldata data) public {
        assumeNotForgeAddress(caller);
        VictimState memory before = observeVictim();
        vm.prank(caller);
        (bool ok,) = address(gasless).call(data);
        ok;
        assertVictimUntouched(before);
    }

    /// @notice T02 (fuzz): each allowlisted selector with fuzzed arguments never moves the victim's funds.
    function testFuzz_T02_allowlistedSelectorWithFuzzedArgumentsMovesNothing(
        uint256 which,
        address caller,
        bytes calldata args
    ) public {
        bytes4[17] memory selectors = [
            IGaslessTransfer.relayTransfer.selector,
            IGaslessTransfer.hashTransfer.selector,
            IGaslessTransfer.TRANSFER_TYPE.selector,
            IGaslessTransfer.TRANSFER_TYPEHASH.selector,
            IGaslessBase.TOKEN_AUTH_TYPE.selector,
            IGaslessBase.TOKEN_AUTH_TYPEHASH.selector,
            IGaslessBase.nonces.selector,
            IGaslessBase.invalidateNonces.selector,
            IGaslessBase.tokenConfig.selector,
            IGaslessBase.DOMAIN_SEPARATOR.selector,
            IGaslessBase.setTokenConfig.selector,
            bytes4(keccak256("eip712Domain()")),
            bytes4(keccak256("owner()")),
            bytes4(keccak256("pendingOwner()")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("acceptOwnership()")),
            bytes4(keccak256("renounceOwnership()"))
        ];
        assumeNotForgeAddress(caller);
        VictimState memory before = observeVictim();
        vm.prank(caller);
        (bool ok,) = address(gasless).call(abi.encodePacked(selectors[which % selectors.length], args));
        ok;
        assertVictimUntouched(before);
    }

    /// @notice T02 (fuzz): a well-formed relayTransfer for the victim, from any caller that is also the bound relay,
    ///         with any signature bytes and any token authorization, reverts and moves nothing.
    function testFuzz_T02_relayTransferForVictimWithArbitrarySignatureReverts(
        uint256 routeSeed,
        address caller,
        uint256 amount,
        uint256 fee,
        uint256 ttl,
        bytes memory signature,
        uint8 v,
        bytes32 permitR,
        bytes32 permitS
    ) public {
        (address token, AuthMode mode) = route(routeSeed);
        assumeNotForgeAddress(caller);
        vm.assume(caller != address(0) && caller != victim);
        TransferRequest memory r = TransferRequest({
            token: token,
            from: victim,
            to: caller,
            amount: bound(amount, 1, FUNDS - MAX_TEST_FEE),
            fee: bound(fee, 0, MAX_TEST_FEE),
            relay: caller,
            deadline: vm.getBlockTimestamp() + bound(ttl, 0, 2 hours)
        });
        vm.assume(r.to != token && r.to != address(gasless));
        TokenAuth memory auth = TokenAuth({mode: mode, v: v, r: permitR, s: permitS});

        VictimState memory before = observeVictim();
        vm.prank(caller);
        (bool ok,) = address(gasless).call(abi.encodeCall(IGaslessTransfer.relayTransfer, (r, signature, auth)));
        assertFalse(ok, "unsigned request for the victim succeeded");
        assertVictimUntouched(before);
    }

    // ================================================================ T03 (fuzz)

    struct Signed {
        TransferRequest request;
        bytes signature;
        TokenAuth auth;
        uint256 key;
        AuthMode mode;
    }

    struct Mutation {
        TransferRequest request;
        TokenAuth auth;
        bytes signature;
        address caller;
    }

    /// @notice T03: sign a valid request, then change exactly one signed input: one of the 7 request fields, the nonce
    ///         (signed for another one), the token authorization's mode, v, r or s, or sign it for another chain id
    ///         or another verifying contract. The call reverts InvalidSignature, because the signature is checked
    ///         first, and changes nothing (neither for the signer nor for the max-approved victim). The unmodified
    ///         request then succeeds. Covers every (token, mode) route and random signer keys.
    function testFuzz_T03_mutatingAnySignedFieldReverts(
        uint256 keySeed,
        uint256 routeSeed,
        uint256 amount,
        uint256 fee,
        uint256 ttl,
        uint256 field,
        uint256 mutation
    ) public {
        Signed memory s = _signedRequest(bound(keySeed, 1, SECP256K1_N - 1), routeSeed, amount, fee, ttl);
        Mutation memory m = _mutate(s, field % 14, mutation);

        State memory before = observe(s.request);
        VictimState memory victimBefore = observeVictim();
        vm.expectRevert(errInvalidSignature());
        vm.prank(m.caller);
        gasless.relayTransfer(m.request, m.signature, m.auth);
        assertUnchanged(s.request, before);
        assertVictimUntouched(victimBefore);

        submit(s.request, s.signature, s.auth);
        assertTransferred(s.request, before);
    }

    /// @dev A funded fresh signer, a valid request of it in the chosen route, its token authorization and signature.
    function _signedRequest(uint256 key, uint256 routeSeed, uint256 amount, uint256 fee, uint256 ttl)
        internal
        returns (Signed memory s)
    {
        address signer = vm.addr(key);
        vm.assume(signer.code.length == 0);
        vm.assume(signer != relay && signer != carol && signer != victim && signer != attacker);
        vm.assume(signer != alice && signer != bob);

        s.key = key;
        (s.request.token, s.mode) = route(routeSeed);
        s.request.from = signer;
        s.request.to = carol;
        s.request.amount = bound(amount, 1, FUNDS);
        s.request.fee = bound(fee, 0, MAX_TEST_FEE);
        s.request.relay = relay;
        s.request.deadline = vm.getBlockTimestamp() + bound(ttl, 0, 2 hours);
        usdc.mint(signer, s.request.amount + s.request.fee);
        usdt.mint(signer, s.request.amount + s.request.fee);
        s.auth = authorize(key, s.request, s.mode);
        s.signature = signRequest(key, s.request, s.auth);
    }

    /// @dev Changes exactly one signed input and returns what to submit and from whom.
    function _mutate(Signed memory s, uint256 field, uint256 mutation) internal view returns (Mutation memory m) {
        TransferRequest memory r = s.request;
        m.request = copy(r);
        m.auth = TokenAuth({mode: s.auth.mode, v: s.auth.v, r: s.auth.r, s: s.auth.s});
        m.signature = s.signature;
        m.caller = r.relay;
        address randomAddress = address(uint160(uint256(keccak256(abi.encode("mutation", mutation)))));

        if (field == 0) {
            // token: the other supported token
            m.request.token = r.token == address(usdc) ? address(usdt) : address(usdc);
        } else if (field == 1) {
            // from: the max-approved victim (an unsigned-pull attempt) or any other address
            m.request.from = mutation % 2 == 0 ? victim : randomAddress;
        } else if (field == 2) {
            m.request.to = mutation % 2 == 0 ? attacker : randomAddress;
        } else if (field == 3) {
            m.request.amount = bound(mutation, 1, FUNDS);
            if (m.request.amount == r.amount) m.request.amount = r.amount == FUNDS ? 1 : r.amount + 1;
        } else if (field == 4) {
            m.request.fee = bound(mutation, 0, MAX_TEST_FEE);
            if (m.request.fee == r.fee) m.request.fee = r.fee == MAX_TEST_FEE ? 0 : r.fee + 1;
        } else if (field == 5) {
            // relay: the tampered relay submits (so a relay check could not tell them apart either)
            m.request.relay = mutation % 2 == 0 ? attacker : randomAddress;
            m.caller = m.request.relay;
        } else if (field == 6) {
            // the nonce: signed for any other nonce than the current one (0 for this fresh signer)
            m.signature = signRequestAt(s.key, r, mutation == 0 ? 1 : mutation, s.auth);
        } else if (field == 7) {
            m.request.deadline = vm.getBlockTimestamp() + bound(mutation, 0, 30 days);
            if (m.request.deadline == r.deadline) m.request.deadline = r.deadline + 1;
        } else if (field == 8) {
            m.auth.mode = AuthMode((uint8(s.auth.mode) + 1 + mutation % 2) % 3);
        } else if (field == 9) {
            m.auth.v = uint8(s.auth.v + 1 + mutation % 255);
        } else if (field == 10) {
            m.auth.r = bytes32(uint256(s.auth.r) ^ (mutation | 1));
        } else if (field == 11) {
            m.auth.s = bytes32(uint256(s.auth.s) ^ (mutation | 1));
        } else if (field == 12) {
            uint256 otherChain = bound(mutation, 1, type(uint64).max);
            if (otherChain == block.chainid) otherChain += 1;
            m.signature = signDigest(s.key, digestFor(r, 0, s.auth, otherChain, address(gasless)));
        } else {
            address otherContract = randomAddress == address(gasless) ? attacker : randomAddress;
            m.signature = signDigest(s.key, digestFor(r, 0, s.auth, block.chainid, otherContract));
        }
        vm.assume(m.request.from != address(0) && m.caller != address(0));
    }

    // ================================================================ T08-T09

    /// @notice T08: the malleable twin (n - s, flipped v) of a valid signature is rejected (high s); the original
    ///         signature still works afterwards.
    function test_T08_highSTwinReverts() public {
        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, alice);
            TokenAuth memory auth = authorize(aliceKey, r, mode);
            bytes32 hash = digest(r, gasless.nonces(alice), auth);
            (uint8 v, bytes32 rr, bytes32 s) = vm.sign(aliceKey, hash);

            uint8 twinV = v == 27 ? uint8(28) : uint8(27);
            bytes32 twinS = bytes32(SECP256K1_N - uint256(s));
            assertEq(ecrecover(hash, twinV, rr, twinS), alice, "not the malleable twin");
            bytes memory twin = abi.encodePacked(rr, twinS, twinV);
            expectRevertNoChange(relay, r, twin, auth, errInvalidSignature());

            State memory before = observe(r);
            submit(r, abi.encodePacked(rr, s, v), auth);
            assertTransferred(r, before);
        }
    }

    /// @notice T08: flipping v (27 <-> 28) without touching s recovers another key and is rejected.
    function test_T08_flippedVReverts() public {
        TransferRequest memory r = request(address(usdc), victim);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(victimKey, digest(r, 0, noAuth()));
        bytes memory flipped = abi.encodePacked(rr, s, v == 27 ? uint8(28) : uint8(27));
        expectRevertNoChange(relay, r, flipped, noAuth(), errInvalidSignature());
    }

    /// @notice T08: only v in {27, 28} is accepted (OpenZeppelin tryRecover does not map 0/1 to 27/28, D1).
    function test_T08_nonCanonicalVReverts() public {
        TransferRequest memory r = request(address(usdc), victim);
        (, bytes32 rr, bytes32 s) = vm.sign(victimKey, digest(r, 0, noAuth()));
        uint8[5] memory badV = [uint8(0), 1, 26, 29, 255];
        for (uint256 i = 0; i < badV.length; ++i) {
            expectRevertNoChange(relay, r, abi.encodePacked(rr, s, badV[i]), noAuth(), errInvalidSignature());
        }
    }

    /// @notice T09: signature lengths other than 65 bytes are rejected, including a genuine 64-byte ERC-2098 compact
    ///         signature and a genuine 65-byte signature with a trailing byte. All-zero signatures are rejected.
    function test_T09_badSignatureLengthsRevert() public {
        TransferRequest memory r = request(address(usdc), victim);
        bytes32 hash = digest(r, 0, noAuth());
        bytes memory valid = signDigest(victimKey, hash);
        (bytes32 cr, bytes32 vs) = vm.signCompact(victimKey, hash);

        bytes[] memory bad = new bytes[](7);
        bad[0] = "";
        bad[1] = abi.encodePacked(cr, vs);
        bad[2] = abi.encodePacked(valid, uint8(0));
        bad[3] = abi.encodePacked(valid, valid);
        bad[4] = new bytes(65);
        bad[5] = new bytes(64);
        bad[6] = new bytes(66);
        for (uint256 i = 0; i < bad.length; ++i) {
            expectRevertNoChange(relay, r, bad[i], noAuth(), errInvalidSignature());
        }

        // Control: the same request with the proper 65-byte signature works.
        State memory before = observe(r);
        submit(r, valid, noAuth());
        assertTransferred(r, before);
    }

    /// @notice T09: `from = 0` reverts with InvalidSigner whatever the signature, including one for which ecrecover
    ///         returns address(0).
    function test_T09_zeroFromRevertsInvalidSigner() public {
        TransferRequest memory r = request(address(usdc), address(0));
        bytes[] memory sigs = new bytes[](5);
        sigs[0] = "";
        sigs[1] = new bytes(65);
        sigs[2] = signRequest(aliceKey, r, noAuth());
        sigs[3] = abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27));
        sigs[4] = abi.encodePacked(keccak256("r"), keccak256("s"), uint8(29));
        for (uint256 i = 0; i < sigs.length; ++i) {
            vm.expectRevert(errInvalidSigner());
            vm.prank(relay);
            gasless.relayTransfer(r, sigs[i], noAuth());
        }
    }

    /// @notice T08/T09 (fuzz): random signature bytes never authorize a request of the victim.
    function testFuzz_T08_randomSignatureBytesRevert(bytes memory signature) public {
        TransferRequest memory r = request(address(usdc), victim);
        expectRevertNoChange(relay, r, signature, noAuth(), errInvalidSignature());
    }

    /// @notice T08 (fuzz): a valid signature made by any other key is rejected.
    function testFuzz_T08_signatureOfAnotherKeyReverts(uint256 keySeed) public {
        uint256 key = bound(keySeed, 1, SECP256K1_N - 1);
        vm.assume(key != victimKey);
        TransferRequest memory r = request(address(usdt), victim);
        expectRevertNoChange(relay, r, signRequest(key, r, noAuth()), noAuth(), errInvalidSignature());
    }

    // ================================================================ T19

    /// @notice T19: NONE mode against an existing (unlimited) allowance still needs the intent signature of `from`.
    function test_T19_noneModeWithExistingAllowanceStillRequiresIntentSignature() public {
        address[2] memory tokens = [address(usdc), address(usdt)];
        for (uint256 i = 0; i < tokens.length; ++i) {
            TransferRequest memory r = request(tokens[i], victim);
            expectRevertNoChange(relay, r, "", noAuth(), errInvalidSignature());
            expectRevertNoChange(relay, r, signRequest(aliceKey, r, noAuth()), noAuth(), errInvalidSignature());
            expectRevertNoChange(relay, r, signRequest(attackerKey, r, noAuth()), noAuth(), errInvalidSignature());

            r.relay = attacker;
            r.to = attacker;
            expectRevertNoChange(attacker, r, signRequest(attackerKey, r, noAuth()), noAuth(), errInvalidSignature());
        }

        // With the victim's own intent signature the same NONE-mode transfer works: the allowance alone never did.
        TransferRequest memory own = request(address(usdt), victim);
        State memory before = observe(own);
        submit(own, signRequest(victimKey, own, noAuth()), noAuth());
        assertTransferred(own, before);
    }

    // ================================================================ T28

    /// @notice T28: a contract signer is rejected. The wallet's ERC-1271 check accepts everything and it has an
    ///         unlimited allowance, yet no signature (its owner's ECDSA signature included) authorizes a request
    ///         from it: the contract verifies ECDSA only (D1). The USDC mock would even accept its ERC-1271 permit.
    function test_T28_contractSignerIsRejected() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(alice);
        usdc.mint(address(wallet), FUNDS);
        usdt.mint(address(wallet), FUNDS);
        vm.startPrank(alice);
        wallet.approveToken(address(usdc), address(gasless), type(uint256).max);
        wallet.approveToken(address(usdt), address(gasless), type(uint256).max);
        vm.stopPrank();

        for (uint256 i = 0; i < ROUTES; ++i) {
            (address token, AuthMode mode) = route(i);
            TransferRequest memory r = request(token, address(wallet));
            TokenAuth memory auth = TokenAuth({mode: mode, v: 27, r: keccak256("r"), s: keccak256("s")});
            bytes[] memory sigs = new bytes[](4);
            sigs[0] = "";
            sigs[1] = new bytes(65);
            sigs[2] = signRequest(aliceKey, r, auth);
            sigs[3] = abi.encode(keccak256("any"), uint256(1), uint256(2));
            for (uint256 j = 0; j < sigs.length; ++j) {
                expectRevertNoChange(relay, r, sigs[j], auth, errInvalidSignature());
            }
        }
    }

    // ================================================================ helpers

    /// @dev Selectors outside the §4.4 surface: token, swap, administration and generic-call functions.
    function _foreignSignatures() internal pure returns (string[] memory s) {
        s = new string[](38);
        s[0] = "unpause()";
        s[1] = "setFee(uint256)";
        s[2] = "withdraw(address,uint256)";
        s[3] = "upgradeTo(address)";
        s[4] = "setOwner(address)";
        s[5] = "initialize(address)";
        s[6] = "grantRole(bytes32,address)";
        s[7] = "sweep(address)";
        s[8] = "mint(address,uint256)";
        s[9] = "burn(address,uint256)";
        s[10] = "emergencyWithdraw(address,uint256)";
        s[11] = "transfer(address,uint256,address,uint256)";
        s[12] = "transferAndCall(address,uint256,bytes)";
        s[13] = "safeTransferFrom(address,address,uint256)";
        s[14] = "withdraw(uint256,address)";
        s[15] = "withdrawToken(address,uint256,address)";
        s[16] = "increaseAllowance(address,uint256)";
        s[17] = "registerToken(address,address)";
        s[18] = "flashLoan(address,address,uint256,bytes)";
        s[19] = "invalidateNonce(bytes32)";
        s[20] = "nonceUsed(address,bytes32)";
        s[21] = "setNonce(address,uint256)";
        s[22] = "uniswapV3SwapCallback(int256,int256,bytes)";
        s[23] = "transferFrom(address,address,uint256)";
        s[24] = "transfer(address,uint256)";
        s[25] = "approve(address,uint256)";
        s[26] = "multicall(bytes[])";
        s[27] = "execute(address,uint256,bytes)";
        s[28] = "rescue(address,address,uint256)";
        s[29] = "upgradeToAndCall(address,bytes)";
        s[30] = "pause()";
        s[31] = "deposit(address,uint256)";
        s[32] = "addToken(address,bool,bool,bool)";
        s[33] = "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)";
        s[34] = "executeMetaTransaction(address,bytes,bytes32,bytes32,uint8)";
        s[35] = "executeBatch(address[],uint256[],bytes[])";
        s[36] = "MAX_FEE()";
        s[37] = "aggregate((address,bytes)[])";
    }
}
