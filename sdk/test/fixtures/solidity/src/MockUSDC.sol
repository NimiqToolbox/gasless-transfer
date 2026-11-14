// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST DOUBLE for the SDK tests. Reproduces what the SDK signs for on Polygon native USDC
///         (FiatTokenV2_2, following the verified source of its implementation):
///         the EIP-712 domain ("USD Coin", "2", chainId, this) and EIP-2612 `permit` with its checks
///         (deadline == max or >= now, ECRecover low-s and v in {27, 28}, ERC-1271 for accounts with code).
///         Installed with anvil_setCode at the real USDC address, hence `initialize` instead of a constructor.
contract MockUSDC {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) private _permitNonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function initialize(string calldata name_) external {
        require(bytes(name).length == 0, "initialized");
        name = name_;
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function version() external pure returns (string memory) {
        return "2";
    }

    /// @dev Test helper; the real token restricts minting.
    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function nonces(address owner) external view returns (uint256) {
        return _permitNonces[owner];
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("2"), block.chainid, address(this)));
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(deadline == type(uint256).max || deadline >= block.timestamp, "FiatTokenV2: permit is expired");
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _permitNonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(_isValidSignatureNow(owner, digest, v, r, s), "EIP2612: invalid signature");
        _approve(owner, spender, value);
    }

    function _isValidSignatureNow(address signer, bytes32 digest, uint8 v, bytes32 r, bytes32 s)
        private
        view
        returns (bool)
    {
        if (signer.code.length == 0) {
            require(
                uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
                "ECRecover: invalid signature 's' value"
            );
            require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
            address recovered = ecrecover(digest, v, r, s);
            require(recovered != address(0), "ECRecover: invalid signature");
            return recovered == signer;
        }
        (bool ok, bytes memory result) =
            signer.staticcall(abi.encodeWithSelector(bytes4(0x1626ba7e), digest, abi.encodePacked(r, s, v)));
        return ok && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(bytes4(0x1626ba7e));
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
