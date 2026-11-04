// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal ERC-20 bookkeeping shared by the edge-case tokens below. Test hooks are open to anyone.
abstract contract MockTokenBase {
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _approve(address owner, address spender, uint256 value) internal {
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _move(address from, address to, uint256 value) internal {
        require(to != address(0), "transfer to zero");
        require(balanceOf[from] >= value, "insufficient balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _spend(address from, uint256 value) internal {
        require(allowance[from][msg.sender] >= value, "insufficient allowance");
        allowance[from][msg.sender] -= value;
    }
}

/// @notice T23: an ERC-20 whose `transfer`, `transferFrom` and `approve` return no data (like Tether on Ethereum).
contract MockNoReturnToken is MockTokenBase {
    function approve(address spender, uint256 value) external {
        _approve(msg.sender, spender, value);
    }

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        _spend(from, value);
        _move(from, to, value);
    }
}

/// @notice T23: an ERC-20 that signals failure by returning `false` instead of reverting. When `failTransfers` is set,
///         `transferFrom` moves nothing and returns false.
contract MockFalseReturnToken is MockTokenBase {
    bool public failTransfers;

    function setFailTransfers(bool fail) external {
        failTransfers = fail;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (failTransfers) return false;
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (failTransfers) return false;
        _spend(from, value);
        _move(from, to, value);
        return true;
    }
}

/// @notice T22: an ERC-20 that, once armed, calls `target` with `data` from inside `transferFrom` (before moving any
///         tokens) and records the outcome of that nested call instead of bubbling it.
contract MockReentrantToken is MockTokenBase {
    address public target;
    bytes public data;
    bool public armed;
    bool public reentered;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (armed) {
            armed = false;
            reentered = true;
            (reentrySucceeded, reentryReturnData) = target.call(data);
        }
        _spend(from, value);
        _move(from, to, value);
        return true;
    }
}
