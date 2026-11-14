// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST DOUBLE for the SDK tests. Reproduces what the SDK signs for on USDT0 (UChildUSDT0, following
///         the verified source of its implementation): the stored salt domain
///         ("USDT0", "1", this, bytes32(chainId)) that an admin `changeName` replaces, `permit` with the
///         raw ecrecover and `deadline == 0 || now <= deadline`, and NativeMetaTransaction's
///         `executeMetaTransaction` with the nonce shared with permit and the ContextMixin sender.
///         Installed with anvil_setCode at the real USDT0 address, hence `initialize`.
contract MockUSDT0 {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant META_TRANSACTION_TYPEHASH =
        keccak256("MetaTransaction(uint256 nonce,address from,bytes functionSignature)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)");

    string public name;
    bytes32 private _domainSeparator;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MetaTransactionExecuted(address indexed userAddress, address indexed relayerAddress, bytes functionSignature);

    function initialize(string calldata name_) external {
        require(_domainSeparator == bytes32(0), "initialized");
        _setName(name_);
    }

    /// @dev Admin-only on mainnet; replaces the stored domain separator.
    function changeName(string calldata name_) external {
        _setName(name_);
    }

    function _setName(string memory name_) private {
        name = name_;
        _domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name_)), keccak256("1"), address(this), bytes32(block.chainid))
        );
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    /// @dev Test helper; the real token restricts minting.
    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator;
    }

    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(_msgSender(), spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(_msgSender(), to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][_msgSender()];
        require(allowed >= value, "ERC20: transfer amount exceeds allowance");
        allowance[from][_msgSender()] = allowed - value;
        _transfer(from, to, value);
        return true;
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
        bytes32 structHash =
            keccak256(abi.encode(META_TRANSACTION_TYPEHASH, nonces[userAddress], userAddress, keccak256(functionSignature)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        require(userAddress == ecrecover(digest, sigV, sigR, sigS), "Signer and signature do not match");
        ++nonces[userAddress];
        emit MetaTransactionExecuted(userAddress, msg.sender, functionSignature);
        (bool success, bytes memory returnData) = address(this).call(abi.encodePacked(functionSignature, userAddress));
        require(success, "Function call not successful");
        return returnData;
    }

    /// @dev ContextMixin: for self-calls from executeMetaTransaction the sender is appended to calldata.
    function _msgSender() private view returns (address sender) {
        if (msg.sender == address(this)) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    function _approve(address owner, address spender, uint256 value) private {
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
