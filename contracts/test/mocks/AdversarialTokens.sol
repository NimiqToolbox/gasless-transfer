// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @notice Token that calls back into an armed target from inside permit and transferFrom, like tokens with transfer
///         hooks. One callback per arm(). With `bubble`, a failed callback reverts the token call with the callback's
///         revert data; otherwise the outcome is recorded and the token call proceeds normally.
contract ReentrantToken is ERC20Permit {
    address public target;
    bytes public callbackData;
    bool public bubble;

    bool public lastCallbackSuccess;
    bytes public lastCallbackResult;
    uint256 public callbacks;

    constructor() ERC20("Reentrant Token", "REENT") ERC20Permit("Reentrant Token") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_, bool bubble_) external {
        target = target_;
        callbackData = data_;
        bubble = bubble_;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        public
        override
    {
        _callback();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _callback();
        return super.transferFrom(from, to, value);
    }

    function _callback() private {
        address t = target;
        if (t == address(0)) return;
        target = address(0);
        (bool success, bytes memory result) = t.call(callbackData);
        lastCallbackSuccess = success;
        lastCallbackResult = result;
        ++callbacks;
        if (bubble) Address.verifyCallResult(success, result);
    }
}

/// @notice Token whose transfer, transferFrom and approve return nothing (like USDT on Ethereum mainnet).
contract NoReturnToken {
    string public constant name = "No Return Token";
    string public constant symbol = "NORET";
    uint8 public constant decimals = 6;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function transfer(address to, uint256 value) external {
        _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        require(allowance[from][msg.sender] >= value, "NoReturnToken: allowance");
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "NoReturnToken: balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @notice Token whose transfer and transferFrom return false instead of reverting, without moving anything.
contract FalseReturnToken is ERC20 {
    constructor() ERC20("False Return Token", "FALSE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @notice Token whose permit and executeMetaTransaction always revert. Plain approve works.
contract RevertingPermitToken is ERC20 {
    constructor() ERC20("Reverting Permit Token", "REVP") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external pure {
        revert("RevertingPermitToken: permit");
    }

    function executeMetaTransaction(address, bytes calldata, bytes32, bytes32, uint8)
        external
        payable
        returns (bytes memory)
    {
        revert("RevertingPermitToken: meta-tx");
    }
}

/// @notice Token whose permit burns all the gas it is given: the token call runs out of gas, as when a relay starves
///         it with a tight gas limit. Plain approve works.
contract GasBurningPermitToken is ERC20 {
    constructor() ERC20("Gas Burning Permit Token", "BURN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external pure {
        while (true) {}
    }
}

/// @notice Token whose permit and executeMetaTransaction succeed without approving anything ("phantom permit",
///         like tokens that accept unknown selectors in a fallback). Plain approve works.
contract PhantomPermitToken is ERC20 {
    constructor() ERC20("Phantom Permit Token", "PHANT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external pure {}

    function executeMetaTransaction(address, bytes calldata, bytes32, bytes32, uint8)
        external
        payable
        returns (bytes memory)
    {
        return "";
    }
}
