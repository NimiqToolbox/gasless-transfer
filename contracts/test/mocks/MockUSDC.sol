// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Test double of native USDC on Polygon (FiatTokenV2_2, implementation 0x235AE97b28466Db30469b89A9fe4cFf0659f82Cb
///         behind 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359), reduced to what the gasless contracts and their
///         clients use. Behaviour and revert strings follow the verified source:
///         - EIP-2612 permit over the domain ("USD Coin", "2", chainId, this), recomputed on every call; deadline
///           `type(uint256).max` never expires. EOA signatures go through ECRecover (rejects high-s, v not in {27, 28}
///           and the zero signer); accounts with code (contracts, EIP-7702 EOAs) go through ERC-1271 instead.
///         - Blacklist checked on msg.sender, from and to for transfers; the token blacklists itself, as V2_2 does.
///         - Pause blocks approve, permit, transfer, transferFrom and mint.
///         - transferFrom always decrements the allowance (no infinite approval) and emits no Approval.
///         One `admin` (the deployer) stands in for the owner, masterMinter, pauser and blacklister roles.
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    string public constant currency = "USD";

    // keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
    bytes32 public constant PERMIT_TYPEHASH = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;
    // keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    bytes32 private constant DOMAIN_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable admin;
    bool public paused;
    uint256 public totalSupply;

    mapping(address account => uint256) private _balances;
    mapping(address owner => mapping(address spender => uint256)) private _allowed;
    mapping(address account => bool) private _blacklisted;
    mapping(address owner => uint256) private _permitNonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed minter, address indexed to, uint256 amount);
    event Blacklisted(address indexed _account);
    event UnBlacklisted(address indexed _account);
    event Pause();
    event Unpause();

    modifier onlyAdmin() {
        require(msg.sender == admin, "MockUSDC: caller is not the admin");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Pausable: paused");
        _;
    }

    modifier notBlacklisted(address account) {
        require(!_blacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    constructor() {
        admin = msg.sender;
        _blacklisted[address(this)] = true;
    }

    // --- ERC-20 ---------------------------------------------------------------------------------

    function version() external pure returns (string memory) {
        return "2";
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowed[owner][spender];
    }

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

    // --- EIP-2612 -------------------------------------------------------------------------------

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator();
    }

    function nonces(address owner) external view returns (uint256) {
        return _permitNonces[owner];
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
    {
        require(deadline == type(uint256).max || deadline >= block.timestamp, "FiatTokenV2: permit is expired");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _permitNonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        require(_isValidSignatureNow(owner, digest, v, r, s), "EIP2612: invalid signature");
        _approve(owner, spender, value);
    }

    // --- Blacklist, pause, mint (admin) ---------------------------------------------------------

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    function blacklist(address account) external onlyAdmin {
        _blacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unBlacklist(address account) external onlyAdmin {
        _blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    function pause() external onlyAdmin {
        paused = true;
        emit Pause();
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit Unpause();
    }

    function mint(address to, uint256 amount)
        external
        onlyAdmin
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(to)
        returns (bool)
    {
        require(to != address(0), "FiatToken: mint to the zero address");
        require(amount > 0, "FiatToken: mint amount not greater than 0");
        totalSupply += amount;
        _balances[to] += amount;
        emit Mint(msg.sender, to, amount);
        emit Transfer(address(0), to, amount);
        return true;
    }

    // --- Internals ------------------------------------------------------------------------------

    function _domainSeparator() private view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("2"), block.chainid, address(this)));
    }

    /// @dev SignatureChecker.isValidSignatureNow of the real token: ECRecover for accounts without code, ERC-1271
    ///      for accounts with code (this includes EIP-7702 delegated EOAs).
    function _isValidSignatureNow(address signer, bytes32 digest, uint8 v, bytes32 r, bytes32 s)
        private
        view
        returns (bool)
    {
        if (signer.code.length == 0) return _recover(digest, v, r, s) == signer;
        (bool success, bytes memory result) =
            signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, abi.encodePacked(r, s, v))));
        return
            success && result.length >= 32
                && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @dev ECRecover.recover of the real token.
    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) private pure returns (address) {
        require(uint256(s) <= HALF_ORDER, "ECRecover: invalid signature 's' value");
        require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "ECRecover: invalid signature");
        return signer;
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
}
