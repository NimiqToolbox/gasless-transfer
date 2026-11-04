// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test double of native USDC on Polygon (FiatTokenV2_2 behind FiatTokenProxy, see
///         verified Polygon FiatTokenV2_2 source), reduced to what the gasless
///         contracts touch. Behaviour copied from the real implementation:
///         - EIP-2612 `permit` over the domain ("USD Coin", "2", block.chainid, token), recomputed on every call
///           (FiatTokenV2_2._domainSeparator), nonce from `nonces(owner)`, valid while `deadline >= now` or
///           `deadline == type(uint256).max`, and `whenNotPaused`.
///         - Signature check as in SignatureChecker.isValidSignatureNow: owners with code go through ERC-1271,
///           EOAs through ECRecover (65 bytes, low s, v in {27, 28}).
///         - `transferFrom` is `whenNotPaused` and checks the blacklist for msg.sender, from and to; `approve` is
///           only `whenNotPaused` (V2_2). The token itself is blacklisted (initializeV2_2), so transfers to it fail.
///         - `transferFrom` emits no Approval event.
///         Test hooks (`mint`, `pause`, `unpause`, `blacklist`, `unBlacklist`, `setPermitGasBurn`) are open to
///         anyone: this contract only exists in tests.
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    string public constant version = "2";

    /// @dev keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
    bytes32 public constant PERMIT_TYPEHASH = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant _HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 public totalSupply;
    bool public paused;
    /// @notice Test hook: gas burnt at the start of every permit (0 = off). Used by the gas starvation test (T29).
    uint256 public permitGasBurn;

    mapping(address account => uint256) private _balances;
    mapping(address owner => mapping(address spender => uint256)) private _allowed;
    mapping(address owner => uint256) private _permitNonces;
    mapping(address account => bool) private _blacklisted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    modifier whenNotPaused() {
        require(!paused, "Pausable: paused");
        _;
    }

    modifier notBlacklisted(address account) {
        require(!_blacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    constructor() {
        _blacklisted[address(this)] = true;
    }

    // ---------------------------------------------------------------- test hooks

    function mint(address to, uint256 amount) external {
        require(to != address(0), "FiatToken: mint to the zero address");
        totalSupply += amount;
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function pause() external {
        paused = true;
    }

    function unpause() external {
        paused = false;
    }

    function blacklist(address account) external {
        _blacklisted[account] = true;
    }

    function unBlacklist(address account) external {
        _blacklisted[account] = false;
    }

    function setPermitGasBurn(uint256 gasAmount) external {
        permitGasBurn = gasAmount;
    }

    // ---------------------------------------------------------------- views

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowed[owner][spender];
    }

    function nonces(address owner) external view returns (uint256) {
        return _permitNonces[owner];
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)
            )
        );
    }

    // ---------------------------------------------------------------- ERC-20

    function approve(address spender, uint256 value) external whenNotPaused returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(to)
        returns (bool)
    {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(from)
        notBlacklisted(to)
        returns (bool)
    {
        require(value <= _allowed[from][msg.sender], "ERC20: transfer amount exceeds allowance");
        _transfer(from, to, value);
        _allowed[from][msg.sender] -= value;
        return true;
    }

    // ---------------------------------------------------------------- EIP-2612

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
    {
        _permit(owner, spender, value, deadline, abi.encodePacked(r, s, v));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        _permit(owner, spender, value, deadline, signature);
    }

    // ---------------------------------------------------------------- internals

    function _permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) private {
        _burnGas(permitGasBurn);
        require(deadline == type(uint256).max || deadline >= block.timestamp, "FiatTokenV2: permit is expired");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _permitNonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_isValidSignatureNow(owner, digest, signature), "EIP2612: invalid signature");
        _approve(owner, spender, value);
    }

    function _isValidSignatureNow(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (signer.code.length == 0) return _recover(digest, signature) == signer;
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(_ERC1271_MAGIC, digest, signature));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(_ERC1271_MAGIC);
    }

    function _recover(bytes32 digest, bytes memory signature) private pure returns (address signer) {
        require(signature.length == 65, "ECRecover: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        require(uint256(s) <= _HALF_ORDER, "ECRecover: invalid signature 's' value");
        require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
        signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "ECRecover: invalid signature");
    }

    function _approve(address owner, address spender, uint256 value) private {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");
        _allowed[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(value <= _balances[from], "ERC20: transfer amount exceeds balance");
        _balances[from] -= value;
        _balances[to] += value;
        emit Transfer(from, to, value);
    }

    function _burnGas(uint256 amount) private view {
        uint256 start = gasleft();
        while (start - gasleft() < amount) {}
    }
}
