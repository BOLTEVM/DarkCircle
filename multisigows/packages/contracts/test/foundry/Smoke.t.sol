// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultTestBase} from "./Base.sol";
import {SafeBuddyVault} from "../../contracts/v2/SafeBuddyVault.sol";

contract SmokeTest is VaultTestBase {
    function test_deploysShippedBytecode() public {
        deployShipped();
        assertEq(keccak256(address(implementation).code), keccak256(artifactRuntime("SafeBuddyVault")));
        SafeBuddyVault vault = createVault(owners(3, 1), 2, 1 days);
        assertEq(keccak256(address(vault).code), keccak256(artifactRuntime("SafeBuddyVaultProxy")));
        assertEq(vault.getThreshold(), 2);
    }
}
