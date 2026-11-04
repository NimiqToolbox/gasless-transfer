// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test double of USDT0 on Polygon (UChildUSDT0, implementation 0x90040487A6C9F949C4F07CaDCFB0f3B8EEAb4229
///         behind 0xc2132D05D31c914a87C6611C10748AEb04B58e8F), reduced to what the gasless contracts and their
///         clients use. Behaviour and revert strings follow the verified source:
///         - EIP-712 salt domain ("USDT0", "1", this, bytes32(chainId)), stored like the real token: it is not
///           recomputed when the chain id changes, and the admin's changeName() replaces it.
///         - permit and executeMetaTransaction share one `nonces` counter. permit uses plain ecrecover (high-s is
///           accepted), treats deadline 0 as "no expiry" and cannot be called through a meta-transaction.
///         - executeMetaTransaction verifies `MetaTransaction(uint256 nonce,address from,bytes functionSignature)`,
///           then calls itself with `functionSignature ++ userAddress`; _msgSender() reads that appended address.
///         - Blocked list: a blocked `from` cannot send (unless the admin moves the funds) and a blocked msg.sender
///           cannot call transferFrom. Transfers to the token itself revert.
///         - transferFrom transfers first, then decrements the allowance and emits Approval (no infinite approval).
///         One `admin` (the deployer) stands in for the DEFAULT_ADMIN_ROLE and BLOCK_ROLE holders.
contract MockUSDT0 {
    string public constant symbol = "USDT0";
    uint8 public constant decimals = 6;
    string public constant ERC712_VERSION = "1";

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");
    bytes32 private constant META_TRANSACTION_TYPEHASH =
        keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");

    address public immutable admin;
    string public name;
    bytes32 private _domainSeparator;
    uint256 public totalSupply;

    /// @notice Shared by permit and executeMetaTransaction.
    mapping(address user => uint256) public nonces;
    mapping(address user => bool) public isBlocked;
    mapping(address account => uint256) private _balances;
    mapping(address owner => mapping(address spender => uint256)) private _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MetaTransactionExecuted(address indexed userAddress, address indexed relayerAddress, bytes functionSignature);
    event Mint(address indexed _destination, uint256 _amount);
    event BlockPlaced(address indexed _user);
    event BlockReleased(address indexed _user);

    modifier onlyAdmin() {
        require(_msgSender() == admin, "MockUSDT0: caller is not the admin");
        _;
    }

    modifier onlyNotBlocked() {
        require(!isBlocked[_msgSender()], "Blocked: msg.sender is blocked");
        _;
    }

    constructor() {
        admin = msg.sender;
        _setName("USDT0");
    }

    // --- ERC-20 ---------------------------------------------------------------------------------

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

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
        uint256 current = _allowances[sender][_msgSender()];
        require(current >= amount, "ERC20: transfer amount exceeds allowance");
        _approve(sender, _msgSender(), current - amount);
        return true;
    }

    // --- EIP-712, permit, meta-transactions -----------------------------------------------------

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
            abi.encode(META_TRANSACTION_TYPEHASH, nonces[userAddress], userAddress, keccak256(functionSignature))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        require(userAddress == ecrecover(digest, sigV, sigR, sigS), "Signer and signature do not match");

        ++nonces[userAddress];
        emit MetaTransactionExecuted(userAddress, msg.sender, functionSignature);

        (bool success, bytes memory returnData) = address(this).call(abi.encodePacked(functionSignature, userAddress));
        require(success, "Function call not successful");
        return returnData;
    }

    // --- Admin: name, blocked list, mint --------------------------------------------------------

    /// @notice UChildERC20.changeName: also replaces the EIP-712 domain separator (existing signatures break).
    function changeName(string calldata newName) external onlyAdmin {
        _setName(newName);
    }

    function addToBlockedList(address user) external onlyAdmin {
        isBlocked[user] = true;
        emit BlockPlaced(user);
    }

    function removeFromBlockedList(address user) external onlyAdmin {
        isBlocked[user] = false;
        emit BlockReleased(user);
    }

    function mint(address destination, uint256 amount) external onlyAdmin {
        require(destination != address(0), "ERC20: mint to the zero address");
        _beforeTokenTransfer(address(0), destination);
        totalSupply += amount;
        _balances[destination] += amount;
        emit Transfer(address(0), destination, amount);
        emit Mint(destination, amount);
    }

    // --- Internals ------------------------------------------------------------------------------

    function _setName(string memory newName) private {
        name = newName;
        _domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(newName)),
                keccak256(bytes(ERC712_VERSION)),
                address(this),
                bytes32(block.chainid)
            )
        );
    }

    /// @dev ContextMixin.msgSender(): inside the meta-transaction self-call, the sender is the address appended to
    ///      the call data.
    function _msgSender() private view returns (address) {
        if (msg.sender == address(this)) return address(bytes20(msg.data[msg.data.length - 20:]));
        return msg.sender;
    }

    function _beforeTokenTransfer(address from, address to) private view {
        require(!isBlocked[from] || _msgSender() == admin, "USDT0: from is blocked");
        require(to != address(this), "USDT0: transfer to the contract address");
    }

    function _approve(address owner, address spender, uint256 amount) private {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");
        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function _transfer(address sender, address recipient, uint256 amount) private {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");
        _beforeTokenTransfer(sender, recipient);
        require(_balances[sender] >= amount, "ERC20: transfer amount exceeds balance");
        _balances[sender] -= amount;
        _balances[recipient] += amount;
        emit Transfer(sender, recipient, amount);
    }
}
