// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test double of USDT0 on Polygon (UChildUSDT0 behind UChildERC20Proxy, see
///         verified Polygon UChildUSDT0 source), reduced to what the gasless
///         contracts touch. Behaviour copied from the real implementation:
///         - Salt domain `EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)` =
///           ("USDT0", "1", token, bytes32(chainId)), stored once at initialization (EIP712Base), not recomputed.
///         - ONE nonce counter `nonces(owner)` (= `getNonce(owner)`) shared by `permit` and
///           `executeMetaTransaction`.
///         - `permit`: raw ecrecover (no low-s or v check), `deadline == 0 || now <= deadline`, and
///           `msg.sender != address(this)` (no permit through a meta-tx).
///         - `executeMetaTransaction` verifies `MetaTransaction(uint256 nonce,address from,bytes functionSignature)`,
///           bumps the nonce, emits MetaTransactionExecuted, then calls itself with the user address appended
///           (ContextMixin), so `approve` inside it runs for `userAddress`.
///         - `transferFrom` is `onlyNotBlocked` (for the spender) and re-approves the reduced allowance, so it emits
///           an Approval event after its Transfer. `_beforeTokenTransfer` rejects a blocked `from` and transfers to
///           the token itself. The blocked-list admin exemption is left out.
///         Test hooks (`mint`, `addToBlockedList`, `removeFromBlockedList`) are open to anyone: tests only.
contract MockUSDT0 {
    string public constant name = "USDT0";
    string public constant symbol = "USDT0";
    uint8 public constant decimals = 6;
    string public constant ERC712_VERSION = "1";

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant _META_TRANSACTION_TYPEHASH =
        keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");

    bytes32 private immutable _domainSeparator;

    uint256 public totalSupply;
    mapping(address user => uint256) public nonces;
    mapping(address user => bool) public isBlocked;
    mapping(address account => uint256) private _balances;
    mapping(address owner => mapping(address spender => uint256)) private _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MetaTransactionExecuted(
        address indexed userAddress, address payable indexed relayerAddress, bytes functionSignature
    );

    modifier onlyNotBlocked() {
        require(!isBlocked[_msgSender()], "Blocked: msg.sender is blocked");
        _;
    }

    constructor() {
        _domainSeparator = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(ERC712_VERSION)),
                address(this),
                bytes32(block.chainid)
            )
        );
    }

    // ---------------------------------------------------------------- test hooks

    function mint(address to, uint256 amount) external {
        require(to != address(0), "ERC20: mint to the zero address");
        require(to != address(this), "USDT0: transfer to the contract address");
        totalSupply += amount;
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function addToBlockedList(address user) external {
        isBlocked[user] = true;
    }

    function removeFromBlockedList(address user) external {
        isBlocked[user] = false;
    }

    // ---------------------------------------------------------------- views

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator;
    }

    function getDomainSeperator() external view returns (bytes32) {
        return _domainSeparator;
    }

    function getChainId() external view returns (uint256) {
        return block.chainid;
    }

    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    // ---------------------------------------------------------------- ERC-20

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(_msgSender(), spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(_msgSender(), recipient, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external onlyNotBlocked returns (bool) {
        _transfer(sender, recipient, amount);
        address spender = _msgSender();
        uint256 current = _allowances[sender][spender];
        require(current >= amount, "ERC20: transfer amount exceeds allowance");
        _approve(sender, spender, current - amount);
        return true;
    }

    // ---------------------------------------------------------------- permit and meta-tx

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(owner != address(0), "USDT0: HOLDER-ZERO");
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        require(owner == ecrecover(digest, v, r, s), "USDT0: INVALID-PERMIT");
        require(deadline == 0 || block.timestamp <= deadline, "USDT0: PERMIT-EXPIRED");
        require(msg.sender != address(this), "USDT0: PERMIT_META_TX_DISABLED");
        _approve(owner, spender, value);
    }

    function executeMetaTransaction(
        address userAddress,
        bytes calldata functionSignature,
        bytes32 sigR,
        bytes32 sigS,
        uint8 sigV
    ) external payable returns (bytes memory) {
        require(userAddress != address(0), "NativeMetaTransaction: INVALID_SIGNER");
        bytes32 structHash = keccak256(
            abi.encode(_META_TRANSACTION_TYPEHASH, nonces[userAddress], userAddress, keccak256(functionSignature))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        require(userAddress == ecrecover(digest, sigV, sigR, sigS), "Signer and signature do not match");
        ++nonces[userAddress];
        emit MetaTransactionExecuted(userAddress, payable(msg.sender), functionSignature);
        (bool success, bytes memory returnData) = address(this).call(abi.encodePacked(functionSignature, userAddress));
        require(success, "Function call not successful");
        return returnData;
    }

    // ---------------------------------------------------------------- internals

    /// @dev ContextMixin.msgSender: inside a meta-tx self-call the user address is the last 20 bytes of calldata.
    function _msgSender() private view returns (address sender) {
        if (msg.sender == address(this)) {
            assembly ("memory-safe") {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    function _transfer(address sender, address recipient, uint256 amount) private {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");
        require(!isBlocked[sender], "USDT0: from is blocked");
        require(recipient != address(this), "USDT0: transfer to the contract address");
        uint256 balance = _balances[sender];
        require(balance >= amount, "ERC20: transfer amount exceeds balance");
        _balances[sender] = balance - amount;
        _balances[recipient] += amount;
        emit Transfer(sender, recipient, amount);
    }

    function _approve(address owner, address spender, uint256 amount) private {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");
        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }
}
