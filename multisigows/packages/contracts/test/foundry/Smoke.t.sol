// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultTestBase} from "./Base.sol";
import {DarkSafeVault} from "../../contracts/v2/DarkSafeVault.sol";

contract SmokeTest is VaultTestBase {
    function test_deploysShippedBytecode() public {
        deployShipped();
        assertEq(keccak256(address(implementation).code), keccak256(artifactRuntime("DarkSafeVault")));
        DarkSafeVault vault = createVault(owners(3, 1), 2, 1 days);
        assertEq(keccak256(address(vault).code), keccak256(artifactRuntime("DarkSafeVaultProxy")));
        assertEq(vault.getThreshold(), 2);
    }
}
