// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @title DarkSafeVaultProxy
 * @notice One per vault. Stores the implementation address in the ERC-1967 slot and runs
 *         `initialize` in the same transaction that creates it.
 *
 * NOT upgradeable: neither this proxy nor DarkSafeVault contains any code path that writes
 * the implementation slot after construction, and the vault has no DELEGATECALL.
 *
 * Has its own receive() so plain QUAI transfers never DELEGATECALL. On Quai, wallets skip
 * the access list for value-only transfers, and a DELEGATECALL without the implementation
 * in the access list fails.
 *
 * No immutables: every instance has identical runtime code, so clients can recognise a
 * genuine vault by its code hash alone.
 */
contract DarkSafeVaultProxy is ERC1967Proxy {
    event Received(address indexed sender, uint256 value);

    constructor(address implementation, bytes memory initData) ERC1967Proxy(implementation, initData) {}

    function getImplementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
