// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {GaslessTransfer} from "../../src/GaslessTransfer.sol";
import {AuthMode, TokenAuth, TokenConfig, TokenInit} from "../../src/interfaces/IGaslessBase.sol";
import {TransferRequest} from "../../src/interfaces/IGaslessTransfer.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockUSDT0} from "../mocks/MockUSDT0.sol";

/// @notice The EIP-712 getters that USDC (FiatTokenV2_2), USDT0 (UChildUSDT0) and their mocks share.
interface IPermitToken {
    function PERMIT_TYPEHASH() external view returns (bytes32);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
}

/// @notice T30 golden vectors (docs/STEP-1-GAS-ABSTRACTION.md §8; regeneration: docs/DEVELOPMENT.md).
///         Builds test/vectors/data/gasless-transfer-<chainId>.json from the real GaslessTransfer and the token mocks
///         of test/mocks, installed at fixed addresses (constructors run there) so that the files are stable:
///         - chain 137: the mocks at the Polygon USDC and USDT0 addresses, where their DOMAIN_SEPARATOR() equals the
///           pinned mainnet value, and GaslessTransfer at a placeholder address (not the deployed contract);
///         - chain 31337: the addresses script/DeployLocalStack.s.sol gets on a fresh anvil (account 0, nonces 0-2).
///         Transfer digests are GaslessTransfer.hashTransfer(r, nonce, auth). Token authorization digests are the
///         token's DOMAIN_SEPARATOR() with the message's struct hash (the token's own PERMIT_TYPEHASH and nonce;
///         UChildUSDT0 keeps its MetaTransaction type hash private, so that one is taken from §5). Each token
///         authorization is signed first, then the transfer over it, and both are submitted through relayTransfer;
///         the call succeeds only if the contract recovers the signer from the transfer digest (at the signer's
///         current nonce) and the token grants the allowance from its own digest.
abstract contract GoldenVectorsBase is Test {
    struct Deployment {
        string file; // relative to contracts/
        string description;
        uint256 chainId;
        address usdc;
        address usdt0;
        address gasless;
    }

    string internal constant GENERATED_BY =
        "WRITE_GOLDEN_VECTORS=true GOLDEN_VECTORS_COMMIT=<commit> forge test --match-contract GoldenVectorsWriter";

    /// @dev 5.00 of a 6-decimal token: the largest fee of the pseudo-random requests. The contract bounds no fee.
    uint256 internal constant FEE_5 = 5_000_000;
    /// @dev 50.00 of a 6-decimal token, ten times FEE_5: executed like any other fee.
    uint256 internal constant FEE_50 = 50_000_000;
    uint256 internal constant MAX_UINT = type(uint256).max;
    /// @dev The fixed "now" of the vectors.
    uint256 internal constant NOW = 1_790_000_000;

    address internal constant POLYGON_USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address internal constant POLYGON_USDT0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    // The tokens' DOMAIN_SEPARATOR() on Polygon, pinned.
    bytes32 internal constant PINNED_USDC_DOMAIN = 0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca;
    bytes32 internal constant PINNED_USDT0_DOMAIN = 0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05;
    /// @dev A placeholder, not the deployed contract; its leading zero bytes exercise the domain encoding.
    address internal constant POLYGON_GASLESS = 0x0000000000C0DE00000000000000000000000137;

    // Well-known anvil accounts (mnemonic "test test test test test test test test test test test junk"):
    // #0 deploys the local stack and owns it, #1 signs, #2 receives, #9 relays.
    address internal constant ANVIL_DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 internal constant USER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address internal constant USER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant RECIPIENT = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant RELAY = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant SALT_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");
    bytes32 internal constant META_TRANSACTION_TYPEHASH =
        keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");

    GaslessTransfer internal gasless;
    MockUSDC internal usdc;
    MockUSDT0 internal usdt0;

    string[] private _transferVectors;
    string[] private _authorizationVectors;

    // --- Deployments --------------------------------------------------------------------------

    function _polygon() internal pure returns (Deployment memory) {
        return Deployment({
            file: "test/vectors/data/gasless-transfer-137.json",
            description: string.concat(
                "T30 golden vectors, Polygon PoS (chain 137): GaslessTransfer v3 at a placeholder address with the ",
                "mainnet token configuration; the token mocks at the USDC and USDT0 addresses have the pinned mainnet ",
                "domain separators"
            ),
            chainId: 137,
            usdc: POLYGON_USDC,
            usdt0: POLYGON_USDT0,
            gasless: POLYGON_GASLESS
        });
    }

    function _anvil() internal pure returns (Deployment memory) {
        return Deployment({
            file: "test/vectors/data/gasless-transfer-31337.json",
            description: string.concat(
                "T30 golden vectors, anvil (chain 31337): MockUSDC, MockUSDT0 and GaslessTransfer v3 at the addresses ",
                "script/DeployLocalStack.s.sol gets on a fresh anvil (account 0, nonces 0-2)"
            ),
            chainId: 31_337,
            usdc: vm.computeCreateAddress(ANVIL_DEPLOYER, 0),
            usdt0: vm.computeCreateAddress(ANVIL_DEPLOYER, 1),
            gasless: vm.computeCreateAddress(ANVIL_DEPLOYER, 2)
        });
    }

    /// @dev Runs the constructors of the tokens and GaslessTransfer at the fixed addresses of `d`, so their domains
    ///      bind these addresses and `d.chainId`. Token modes are the mainnet configuration of
    ///      script/DeployGaslessTransfer.s.sol; the owner is anvil account #0 (it does not affect any digest).
    function _deploy(Deployment memory d) internal {
        vm.chainId(d.chainId);
        vm.warp(NOW);
        deployCodeTo("test/mocks/MockUSDC.sol:MockUSDC", d.usdc);
        deployCodeTo("test/mocks/MockUSDT0.sol:MockUSDT0", d.usdt0);
        TokenInit[] memory tokens = new TokenInit[](2);
        tokens[0] =
            TokenInit({token: d.usdc, config: TokenConfig({permit: true, metaTxApprove: false, allowance: true})});
        tokens[1] =
            TokenInit({token: d.usdt0, config: TokenConfig({permit: true, metaTxApprove: true, allowance: true})});
        deployCodeTo("src/GaslessTransfer.sol:GaslessTransfer", abi.encode(ANVIL_DEPLOYER, tokens), d.gasless);
        gasless = GaslessTransfer(d.gasless);
        usdc = MockUSDC(d.usdc);
        usdt0 = MockUSDT0(d.usdt0);

        if (d.chainId == 137) {
            assertEq(usdc.DOMAIN_SEPARATOR(), PINNED_USDC_DOMAIN, "USDC domain == mainnet pin");
            assertEq(usdt0.DOMAIN_SEPARATOR(), PINNED_USDT0_DOMAIN, "USDT0 domain == mainnet pin");
        }
        assertEq(vm.addr(USER_KEY), USER, "anvil account #1");
        usdc.mint(USER, 1_000_000e6);
        usdt0.mint(USER, 1_000_000e6);
    }

    // --- The vector file ------------------------------------------------------------------------

    /// @dev Deploys `d` and returns its vector file, byte for byte as committed.
    function _vectorFile(Deployment memory d, string memory commit) internal returns (string memory) {
        _deploy(d);
        delete _transferVectors;
        delete _authorizationVectors;
        _addVectors();

        string[] memory source = new string[](3);
        source[0] = _jsonMember("contract", _jsonString("contracts/src/GaslessTransfer.sol"));
        source[1] = _jsonMember("commit", _jsonString(commit));
        source[2] = _jsonMember("generatedBy", _jsonString(GENERATED_BY));

        string[] memory root = new string[](9);
        root[0] = _jsonMember("description", _jsonString(d.description));
        root[1] = _jsonMember("source", _jsonObject(source, 1));
        root[2] = _jsonMember("chainId", vm.toString(block.chainid));
        root[3] = _jsonMember("verifyingContract", _jsonAddress(address(gasless), false));
        root[4] = _jsonMember("typeHash", _jsonBytes32(gasless.TRANSFER_TYPEHASH()));
        root[5] = _jsonMember("tokenAuthTypeHash", _jsonBytes32(gasless.TOKEN_AUTH_TYPEHASH()));
        root[6] = _jsonMember("domainSeparator", _jsonBytes32(gasless.DOMAIN_SEPARATOR()));
        root[7] = _jsonMember("transfers", _jsonArray(_transferVectors, 1));
        root[8] = _jsonMember("tokenAuthorizations", _jsonArray(_authorizationVectors, 1));
        return string.concat(_jsonObject(root, 0), "\n");
    }

    /// @dev The vectors of one file. The first five are signed by USER and executed in this order at intent nonces 0
    ///      to 4, so the token nonces they carry advance too (USDT0 shares one nonce between permit and meta-tx). The
    ///      others are digests only.
    function _addVectors() private {
        address a = address(usdc);
        address b = address(usdt0);

        _executed("USDC via permit: amount 1, fee 0, nonce 0", _request(a, 1, 0, NOW + 10 minutes), AuthMode.PERMIT);
        _executed(
            "USDC via permit: fee 10000, deadline 2^256 - 1, nonce 1",
            _request(a, 10_000_000, 10_000, MAX_UINT),
            AuthMode.PERMIT
        );
        _executed(
            "USDT0 via permit: fee 50000000, nonce 2", _request(b, 250_000_000, FEE_50, NOW + 2 hours), AuthMode.PERMIT
        );
        TransferRequest memory metaTx = _request(b, 10_000_000, 50_000, NOW + 30 minutes);
        TokenAuth memory metaTxAuth = _executed(
            "USDT0 via meta-tx approve: amount 10000000, fee 50000, nonce 3", metaTx, AuthMode.META_TX_APPROVE
        );
        _executed(
            "USDC via none (approved beforehand): nonce 4", _request(a, 3_000_000, 20_000, NOW + 1 hours), AuthMode.NONE
        );

        TokenAuth memory none = _none();
        TokenAuth memory permit = TokenAuth({mode: AuthMode.PERMIT, v: 27, r: _word("permit r"), s: _word("permit s")});
        _digestOnly(
            "USDC: amount 2^256 - 1 - 5000000, fee 5000000, nonce 0",
            _request(a, MAX_UINT - FEE_5, FEE_5, NOW + 1 hours),
            0,
            none,
            false
        );
        _digestOnly(
            "USDT0: amount 2^256 - 1, fee 0, nonce 2^256 - 1",
            _request(b, MAX_UINT, 0, NOW + 1 hours),
            MAX_UINT,
            none,
            false
        );
        _digestOnly(
            "USDC: fee 2^256 - 1 (hashed as signed; relayTransfer reverts on amount + fee above 2^256 - 1)",
            _request(a, 1, MAX_UINT, NOW + 1 hours),
            7,
            permit,
            false
        );
        _digestOnly("USDC: deadline 0", _request(a, 5_000_000, 20_000, 0), 1, none, false);
        _digestOnly(
            "USDT0 via meta-tx approve, v 28, nonce 2^32 - 1",
            _request(b, 5_000_000, 20_000, NOW + 1 hours),
            type(uint32).max,
            TokenAuth({mode: AuthMode.META_TX_APPROVE, v: 28, r: _word("meta-tx r"), s: _word("meta-tx s")}),
            false
        );
        _digestOnly(
            "NONE with non-zero v, r, s: hashed as given",
            _request(a, 5_000_000, 20_000, NOW + 1 hours),
            0,
            TokenAuth({mode: AuthMode.NONE, v: 27, r: _word("none r"), s: _word("none s")}),
            false
        );

        TransferRequest memory toToken = _request(a, 3_000_000, 20_000, NOW + 1 hours);
        toToken.to = b;
        _digestOnly("USDC to the USDT0 token contract", toToken, 5, none, false);
        toToken = _request(b, 3_000_000, 20_000, NOW + 1 hours);
        toToken.to = a;
        _digestOnly("USDT0 to the USDC token contract", toToken, 5, none, false);

        _digestOnly(
            "USDT0: from, to and relay with leading zero bytes",
            TransferRequest({
                token: b,
                from: address(0xdEaD),
                to: address(0xA11cE),
                amount: 1_234_567,
                fee: 10_000,
                relay: address(0xB0b),
                deadline: NOW + 1 hours
            }),
            9,
            permit,
            false
        );
        _digestOnly(
            "USDT0 via meta-tx approve: amount 10000000, fee 50000, nonce 3, all addresses lowercase",
            metaTx,
            3,
            metaTxAuth,
            true
        );

        for (uint256 i = 1; i <= 3; ++i) {
            bytes32 seed = keccak256(abi.encode("golden vector", i));
            _digestOnly(
                string.concat("pseudo-random #", vm.toString(i)),
                _pseudoRandomRequest(seed),
                uint256(keccak256(abi.encode(seed, "nonce"))),
                _pseudoRandomAuth(seed),
                false
            );
        }
    }

    function _request(address token, uint256 amount, uint256 fee, uint256 deadline)
        private
        pure
        returns (TransferRequest memory)
    {
        return TransferRequest({
            token: token, from: USER, to: RECIPIENT, amount: amount, fee: fee, relay: RELAY, deadline: deadline
        });
    }

    function _none() private pure returns (TokenAuth memory) {
        return TokenAuth({mode: AuthMode.NONE, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    function _word(string memory label) private pure returns (bytes32) {
        return keccak256(abi.encode("golden vector word", label));
    }

    /// @dev Fields derived from keccak256, so the set also contains requests without any structure.
    function _pseudoRandomRequest(bytes32 seed) private view returns (TransferRequest memory) {
        return TransferRequest({
            token: uint256(seed) % 2 == 1 ? address(usdc) : address(usdt0),
            from: _pseudoRandomAddress(seed, "from"),
            to: _pseudoRandomAddress(seed, "to"),
            amount: uint256(keccak256(abi.encode(seed, "amount"))) % 1e15 + 1,
            fee: uint256(keccak256(abi.encode(seed, "fee"))) % (FEE_5 + 1),
            relay: _pseudoRandomAddress(seed, "relay"),
            deadline: NOW + uint256(keccak256(abi.encode(seed, "deadline"))) % 2 hours
        });
    }

    function _pseudoRandomAuth(bytes32 seed) private pure returns (TokenAuth memory) {
        return TokenAuth({
            mode: AuthMode(uint256(keccak256(abi.encode(seed, "mode"))) % 3),
            v: uint8(uint256(keccak256(abi.encode(seed, "v")))),
            r: keccak256(abi.encode(seed, "r")),
            s: keccak256(abi.encode(seed, "s"))
        });
    }

    function _pseudoRandomAddress(bytes32 seed, string memory field) private pure returns (address) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(keccak256(abi.encode(seed, field)))));
    }

    // --- Vectors ------------------------------------------------------------------------------

    function _digestOnly(
        string memory name,
        TransferRequest memory r,
        uint256 nonce,
        TokenAuth memory auth,
        bool lowercase
    ) private {
        _transferVectors.push(_transferVector(name, r, nonce, auth, gasless.hashTransfer(r, nonce, auth), lowercase));
    }

    /// @dev A transfer with the token authorization a client signs for it (§5: spender = the contract, value = amount +
    ///      fee, deadline = the intent deadline, the token's current nonce; NONE: an exact approval beforehand) at
    ///      USER's current intent nonce. Both vectors are recorded, then proven by submitting them (`_submit`).
    function _executed(string memory name, TransferRequest memory r, AuthMode mode)
        private
        returns (TokenAuth memory auth)
    {
        auth = _none();
        if (mode == AuthMode.NONE) {
            vm.prank(r.from);
            IERC20(r.token).approve(address(gasless), r.amount + r.fee);
        } else {
            bytes32 authDigest = mode == AuthMode.PERMIT ? _permitVector(name, r) : _metaTxApproveVector(name, r);
            (auth.v, auth.r, auth.s) = vm.sign(USER_KEY, authDigest);
            auth.mode = mode;
        }
        uint256 nonce = gasless.nonces(r.from);
        bytes32 digest = gasless.hashTransfer(r, nonce, auth);
        _transferVectors.push(_transferVector(name, r, nonce, auth, digest, false));
        _submit(r, digest, auth);
    }

    /// @dev USER signed both digests and RELAY submits them. Without a prior allowance (PERMIT, META_TX), relayTransfer
    ///      succeeds only if the contract recovers USER from `digest` and the token accepts the signature in `auth`.
    function _submit(TransferRequest memory r, bytes32 digest, TokenAuth memory auth) private {
        IERC20 token = IERC20(r.token);
        if (auth.mode != AuthMode.NONE) assertEq(token.allowance(r.from, address(gasless)), 0, "no allowance before");
        (uint8 v, bytes32 sigR, bytes32 sigS) = vm.sign(USER_KEY, digest);
        uint256 nonce = gasless.nonces(r.from);
        uint256 recipientBalance = token.balanceOf(r.to);

        vm.prank(r.relay);
        gasless.relayTransfer(r, abi.encodePacked(sigR, sigS, v), auth);

        assertEq(gasless.nonces(r.from), nonce + 1, "nonce used");
        assertEq(token.allowance(r.from, address(gasless)), 0, "allowance of exactly amount + fee, used up");
        assertEq(token.balanceOf(r.to), recipientBalance + r.amount, "recipient received the amount");
    }

    function _permitVector(string memory transferName, TransferRequest memory r) private returns (bytes32 digest) {
        IPermitToken token = IPermitToken(r.token);
        uint256 nonce = token.nonces(r.from);
        uint256 value = r.amount + r.fee;
        digest = _tokenDigest(
            r.token, keccak256(abi.encode(token.PERMIT_TYPEHASH(), r.from, address(gasless), value, nonce, r.deadline))
        );

        string[] memory message = new string[](5);
        message[0] = _jsonMember("owner", _jsonAddress(r.from, false));
        message[1] = _jsonMember("spender", _jsonAddress(address(gasless), false));
        message[2] = _jsonMember("value", _jsonUint(value));
        message[3] = _jsonMember("nonce", _jsonUint(nonce));
        message[4] = _jsonMember("deadline", _jsonUint(r.deadline));
        string memory name = string.concat(
            r.token == address(usdc) ? "USDC" : "USDT0",
            " permit, nonce ",
            vm.toString(nonce),
            ", for '",
            transferName,
            "'"
        );
        _authorizationVectors.push(_authorizationVector(name, "permit", r.token, message, digest));
    }

    function _metaTxApproveVector(string memory transferName, TransferRequest memory r)
        private
        returns (bytes32 digest)
    {
        assertEq(r.token, address(usdt0), "meta-tx approve is USDT0 only");
        uint256 nonce = usdt0.getNonce(r.from);
        // The call TokenAuthLib builds: approve(this contract, amount + fee).
        bytes memory approveCall = abi.encodeCall(IERC20.approve, (address(gasless), r.amount + r.fee));
        digest = _tokenDigest(
            r.token, keccak256(abi.encode(META_TRANSACTION_TYPEHASH, nonce, r.from, keccak256(approveCall)))
        );

        string[] memory message = new string[](3);
        message[0] = _jsonMember("nonce", _jsonUint(nonce));
        message[1] = _jsonMember("from", _jsonAddress(r.from, false));
        message[2] = _jsonMember("functionSignature", _jsonString(vm.toString(approveCall)));
        string memory name =
            string.concat("USDT0 meta-tx approve, nonce ", vm.toString(nonce), ", for '", transferName, "'");
        _authorizationVectors.push(_authorizationVector(name, "metaTxApprove", r.token, message, digest));
    }

    /// @dev The digest the token verifies: its own DOMAIN_SEPARATOR() and the message's struct hash.
    function _tokenDigest(address token, bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", IPermitToken(token).DOMAIN_SEPARATOR(), structHash));
    }

    function _transferVector(
        string memory name,
        TransferRequest memory r,
        uint256 nonce,
        TokenAuth memory auth,
        bytes32 digest,
        bool lowercase
    ) private pure returns (string memory) {
        string[] memory request = new string[](8);
        request[0] = _jsonMember("token", _jsonAddress(r.token, lowercase));
        request[1] = _jsonMember("from", _jsonAddress(r.from, lowercase));
        request[2] = _jsonMember("to", _jsonAddress(r.to, lowercase));
        request[3] = _jsonMember("amount", _jsonUint(r.amount));
        request[4] = _jsonMember("fee", _jsonUint(r.fee));
        request[5] = _jsonMember("relay", _jsonAddress(r.relay, lowercase));
        request[6] = _jsonMember("nonce", _jsonUint(nonce));
        request[7] = _jsonMember("deadline", _jsonUint(r.deadline));

        string[] memory authorization = new string[](4);
        authorization[0] = _jsonMember("mode", _jsonString(_modeName(auth.mode)));
        authorization[1] = _jsonMember("v", vm.toString(uint256(auth.v)));
        authorization[2] = _jsonMember("r", _jsonBytes32(auth.r));
        authorization[3] = _jsonMember("s", _jsonBytes32(auth.s));

        string[] memory members = new string[](4);
        members[0] = _jsonMember("name", _jsonString(name));
        members[1] = _jsonMember("request", _jsonObject(request, 3));
        members[2] = _jsonMember("authorization", _jsonObject(authorization, 3));
        members[3] = _jsonMember("digest", _jsonBytes32(digest));
        return _jsonObject(members, 2);
    }

    /// @dev The mode name in the vector files; the signed `TokenAuth.mode` is the enum value (none 0, permit 1,
    ///      metaTxApprove 2).
    function _modeName(AuthMode mode) internal pure returns (string memory) {
        if (mode == AuthMode.PERMIT) return "permit";
        if (mode == AuthMode.META_TX_APPROVE) return "metaTxApprove";
        return "none";
    }

    function _authorizationVector(
        string memory name,
        string memory kind,
        address token,
        string[] memory message,
        bytes32 digest
    ) private view returns (string memory) {
        string[] memory members = new string[](5);
        members[0] = _jsonMember("name", _jsonString(name));
        members[1] = _jsonMember("kind", _jsonString(kind));
        members[2] = _jsonMember("domain", _tokenDomain(token));
        members[3] = _jsonMember("message", _jsonObject(message, 3));
        members[4] = _jsonMember("digest", _jsonBytes32(digest));
        return _jsonObject(members, 2);
    }

    /// @dev The token's EIP-712 domain as §5 pins it, from the token's own getters. Its hash must be the token's
    ///      DOMAIN_SEPARATOR(), so a client rebuilds exactly the domain the token uses.
    function _tokenDomain(address token) private view returns (string memory) {
        string[] memory members = new string[](4);
        bytes32 separator;
        if (token == address(usdc)) {
            // FiatTokenV2_2: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
            string memory name = usdc.name();
            string memory version = usdc.version();
            members[0] = _jsonMember("name", _jsonString(name));
            members[1] = _jsonMember("version", _jsonString(version));
            members[2] = _jsonMember("chainId", vm.toString(block.chainid));
            members[3] = _jsonMember("verifyingContract", _jsonAddress(token, false));
            separator = keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, token
                )
            );
        } else {
            // UChildUSDT0: EIP712Domain(string name,string version,address verifyingContract,bytes32 salt), the salt
            // being bytes32(chainId).
            string memory name = usdt0.name();
            string memory version = usdt0.ERC712_VERSION();
            members[0] = _jsonMember("name", _jsonString(name));
            members[1] = _jsonMember("version", _jsonString(version));
            members[2] = _jsonMember("verifyingContract", _jsonAddress(token, false));
            members[3] = _jsonMember("salt", _jsonBytes32(bytes32(block.chainid)));
            separator = keccak256(
                abi.encode(
                    SALT_DOMAIN_TYPEHASH,
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    token,
                    bytes32(block.chainid)
                )
            );
        }
        assertEq(separator, IPermitToken(token).DOMAIN_SEPARATOR(), "domain fields hash to the token's separator");
        return _jsonObject(members, 3);
    }

    // --- JSON, laid out like JSON.stringify(value, null, 2) -------------------------------------

    function _jsonMember(string memory key, string memory value) private pure returns (string memory) {
        return string.concat('"', key, '": ', value);
    }

    /// @dev All strings here are printable ASCII without quotes or backslashes, so nothing needs escaping; anything
    ///      else is rejected.
    function _jsonString(string memory value) private pure returns (string memory) {
        bytes memory b = bytes(value);
        for (uint256 i = 0; i < b.length; ++i) {
            require(b[i] >= 0x20 && b[i] < 0x7f && b[i] != '"' && b[i] != "\\", "JSON string needs escaping");
        }
        return string.concat('"', value, '"');
    }

    /// @dev Checksummed (EIP-55 mixed case), or all lowercase.
    function _jsonAddress(address value, bool lowercase) private pure returns (string memory) {
        return _jsonString(lowercase ? vm.toLowercase(vm.toString(value)) : vm.toString(value));
    }

    /// @dev Canonical decimal string.
    function _jsonUint(uint256 value) private pure returns (string memory) {
        return _jsonString(vm.toString(value));
    }

    /// @dev 0x + 64 lowercase hex digits.
    function _jsonBytes32(bytes32 value) private pure returns (string memory) {
        return _jsonString(vm.toString(value));
    }

    function _jsonObject(string[] memory members, uint256 depth) private pure returns (string memory) {
        return _jsonBlock("{", members, "}", depth);
    }

    function _jsonArray(string[] memory items, uint256 depth) private pure returns (string memory) {
        return _jsonBlock("[", items, "]", depth);
    }

    /// @dev One entry per line, indented by two spaces per level of `depth`.
    function _jsonBlock(string memory open, string[] memory entries, string memory close, uint256 depth)
        private
        pure
        returns (string memory out)
    {
        out = string.concat(open, "\n");
        for (uint256 i = 0; i < entries.length; ++i) {
            out = string.concat(out, _indent(depth + 1), entries[i], i + 1 < entries.length ? ",\n" : "\n");
        }
        out = string.concat(out, _indent(depth), close);
    }

    function _indent(uint256 depth) private pure returns (string memory out) {
        for (uint256 i = 0; i < depth; ++i) {
            out = string.concat(out, "  ");
        }
    }
}

/// @notice T30, contract side: re-reads the committed vector files (test/vectors/data, which foundry.toml makes
///         readable), recomputes every digest in them with the contract (hashTransfer) and the tokens
///         (DOMAIN_SEPARATOR()), and requires each file to be exactly the generator's output for the current code.
contract GoldenVectorsTest is GoldenVectorsBase {
    function test_T30_polygonVectors_matchContract() public {
        _check(_polygon());
    }

    function test_T30_anvilVectors_matchContract() public {
        _check(_anvil());
    }

    function _check(Deployment memory d) private {
        string memory committed = vm.readFile(d.file);
        // The commit is metadata written at generation time; it cannot be derived here.
        string memory commit = vm.parseJsonString(committed, ".source.commit");
        assertEq(bytes(commit).length, 40, "source.commit: a git commit hash");

        // Deploys `d` and proves the executed vectors; the digests below are then recomputed on this deployment.
        string memory expected = _vectorFile(d, commit);
        _checkCommittedDigests(committed);
        assertEq(committed, expected, "committed file != generator output; regenerate (docs/DEVELOPMENT.md)");
    }

    function _checkCommittedDigests(string memory json) private view {
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid, "chainId");
        assertEq(vm.parseJsonAddress(json, ".verifyingContract"), address(gasless), "verifyingContract");
        assertEq(vm.parseJsonBytes32(json, ".typeHash"), gasless.TRANSFER_TYPEHASH(), "typeHash");
        assertEq(vm.parseJsonBytes32(json, ".tokenAuthTypeHash"), gasless.TOKEN_AUTH_TYPEHASH(), "tokenAuthTypeHash");
        assertEq(vm.parseJsonBytes32(json, ".domainSeparator"), gasless.DOMAIN_SEPARATOR(), "domainSeparator");

        uint256 i;
        for (; vm.keyExistsJson(json, _element(".transfers", i)); ++i) {
            string memory vector = _element(".transfers", i);
            (TransferRequest memory r, uint256 nonce) = _parseRequest(json, string.concat(vector, ".request"));
            assertEq(
                gasless.hashTransfer(r, nonce, _parseAuth(json, string.concat(vector, ".authorization"))),
                vm.parseJsonBytes32(json, string.concat(vector, ".digest")),
                vm.parseJsonString(json, string.concat(vector, ".name"))
            );
        }
        assertGt(i, 0, "transfers");

        for (i = 0; vm.keyExistsJson(json, _element(".tokenAuthorizations", i)); ++i) {
            _checkAuthorization(json, _element(".tokenAuthorizations", i));
        }
        assertGt(i, 0, "tokenAuthorizations");
    }

    function _checkAuthorization(string memory json, string memory vector) private view {
        address token = vm.parseJsonAddress(json, string.concat(vector, ".domain.verifyingContract"));
        string memory kind = vm.parseJsonString(json, string.concat(vector, ".kind"));
        string memory message = string.concat(vector, ".message");
        bytes32 structHash;
        if (keccak256(bytes(kind)) == keccak256("permit")) {
            structHash = keccak256(
                abi.encode(
                    IPermitToken(token).PERMIT_TYPEHASH(),
                    vm.parseJsonAddress(json, string.concat(message, ".owner")),
                    vm.parseJsonAddress(json, string.concat(message, ".spender")),
                    vm.parseJsonUint(json, string.concat(message, ".value")),
                    vm.parseJsonUint(json, string.concat(message, ".nonce")),
                    vm.parseJsonUint(json, string.concat(message, ".deadline"))
                )
            );
        } else {
            assertEq(kind, "metaTxApprove", "kind");
            structHash = keccak256(
                abi.encode(
                    META_TRANSACTION_TYPEHASH,
                    vm.parseJsonUint(json, string.concat(message, ".nonce")),
                    vm.parseJsonAddress(json, string.concat(message, ".from")),
                    keccak256(vm.parseJsonBytes(json, string.concat(message, ".functionSignature")))
                )
            );
        }
        assertEq(
            _tokenDigest(token, structHash),
            vm.parseJsonBytes32(json, string.concat(vector, ".digest")),
            vm.parseJsonString(json, string.concat(vector, ".name"))
        );
    }

    function _parseRequest(string memory json, string memory at)
        private
        pure
        returns (TransferRequest memory r, uint256 nonce)
    {
        r.token = vm.parseJsonAddress(json, string.concat(at, ".token"));
        r.from = vm.parseJsonAddress(json, string.concat(at, ".from"));
        r.to = vm.parseJsonAddress(json, string.concat(at, ".to"));
        r.amount = vm.parseJsonUint(json, string.concat(at, ".amount"));
        r.fee = vm.parseJsonUint(json, string.concat(at, ".fee"));
        r.relay = vm.parseJsonAddress(json, string.concat(at, ".relay"));
        nonce = vm.parseJsonUint(json, string.concat(at, ".nonce"));
        r.deadline = vm.parseJsonUint(json, string.concat(at, ".deadline"));
    }

    function _parseAuth(string memory json, string memory at) private pure returns (TokenAuth memory a) {
        bytes32 mode = keccak256(bytes(vm.parseJsonString(json, string.concat(at, ".mode"))));
        if (mode == keccak256("permit")) {
            a.mode = AuthMode.PERMIT;
        } else if (mode == keccak256("metaTxApprove")) {
            a.mode = AuthMode.META_TX_APPROVE;
        } else {
            assertEq(mode, keccak256("none"), "authorization.mode");
        }
        uint256 v = vm.parseJsonUint(json, string.concat(at, ".v"));
        assertLe(v, type(uint8).max, "authorization.v");
        // forge-lint: disable-next-line(unsafe-typecast)
        a.v = uint8(v);
        a.r = vm.parseJsonBytes32(json, string.concat(at, ".r"));
        a.s = vm.parseJsonBytes32(json, string.concat(at, ".s"));
    }

    function _element(string memory array, uint256 i) private pure returns (string memory) {
        return string.concat(array, "[", vm.toString(i), "]");
    }
}

/// @notice Writes the vector files. Run it alone, with the commit of contracts/src (docs/DEVELOPMENT.md):
///         WRITE_GOLDEN_VECTORS=true GOLDEN_VECTORS_COMMIT=<commit> forge test --match-contract GoldenVectorsWriter
///         It skips itself otherwise. The inline config gives this contract write access to test/vectors/data only.
/// forge-config: default.fs_permissions = [{ access = "read-write", path = "./test/vectors/data" }]
contract GoldenVectorsWriter is GoldenVectorsBase {
    function test_writeGoldenVectors() public {
        if (!vm.envOr("WRITE_GOLDEN_VECTORS", false)) {
            vm.skip(true, "writes test/vectors/data only with WRITE_GOLDEN_VECTORS=true");
            return;
        }
        string memory commit = vm.envOr("GOLDEN_VECTORS_COMMIT", string(""));
        require(bytes(commit).length == 40, "GOLDEN_VECTORS_COMMIT: the git commit of contracts/src");

        Deployment memory polygon = _polygon();
        vm.writeFile(polygon.file, _vectorFile(polygon, commit));
        Deployment memory anvil = _anvil();
        vm.writeFile(anvil.file, _vectorFile(anvil, commit));
    }
}
