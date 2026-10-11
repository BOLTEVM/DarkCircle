// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IVaultExecute {
    function executeTransaction(bytes32 txHash) external returns (bool);
}

/// @dev Records every call so tests can assert exactly what the vault sent.
contract CallRecorder {
    uint256 public calls;
    uint256 public lastValue;
    bytes public lastData;
    address public lastSender;

    function record(bytes calldata payload) external payable {
        calls += 1;
        lastValue = msg.value;
        lastData = payload;
        lastSender = msg.sender;
    }

    receive() external payable {
        calls += 1;
        lastValue = msg.value;
        lastSender = msg.sender;
    }
}

/// @dev Succeeds only when given enough gas to write `slots` fresh storage slots.
contract GasHungry {
    mapping(uint256 => uint256) public store;
    uint256 public runs;

    function burn(uint256 slots) external {
        for (uint256 i = 0; i < slots; i++) store[runs * 1_000_000 + i] = i + 1;
        runs += 1;
    }
}

/// @dev Reverts with far more returndata than the vault is willing to copy.
contract ReturnBomb {
    function explode() external pure {
        assembly {
            revert(0, 100000)
        }
    }

    function plainRevert() external pure {
        revert("target said no");
    }
}

/**
 * @dev Placed (via hardhat_setCode) at a Cyprus-1 address and made a vault owner, then used
 *      as the target of a vault transaction. Its receive() tries to re-enter the vault.
 */
contract ReentrantAttacker {
    address public vault;
    bytes32 public reentryHash;
    bool public attempted;
    bool public attackSucceeded;

    function arm(address vault_, bytes32 reentryHash_) external {
        vault = vault_;
        reentryHash = reentryHash_;
    }

    function approveAs(bytes32 txHash) external {
        (bool ok, bytes memory ret) = vault.call(abi.encodeWithSignature("approveTransaction(bytes32)", txHash));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    receive() external payable {
        attempted = true;
        try IVaultExecute(vault).executeTransaction(reentryHash) {
            attackSucceeded = true;
        } catch {
            attackSucceeded = false;
        }
    }
}
