// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DarkSafeVault} from "../../contracts/v2/DarkSafeVault.sol";
import {DarkSafeVaultFactory} from "../../contracts/v2/DarkSafeVaultFactory.sol";
import {DarkSafeVaultProxy} from "../../contracts/v2/DarkSafeVaultProxy.sol";

/**
 * Shared setup for the Foundry suites.
 *
 * The vault, proxy and factory are deployed from the Hardhat artifacts, i.e. the exact
 * bytecode whose hashes are pinned in packages/core/src/pinned.ts and that deploy-v2.mjs
 * ships. Foundry's own compile of those contracts is used only for their ABIs.
 */
abstract contract VaultTestBase is Test {
    uint256 internal constant DAY = 1 days;
    uint32 internal constant MAX_DELAY = 30 days;
    uint64 internal constant MAX_WINDOW = 30 days;

    DarkSafeVault internal implementation;
    DarkSafeVaultFactory internal factory;

    function artifactBytecode(string memory name) internal view returns (bytes memory) {
        string memory json = vm.readFile(string.concat("artifacts/contracts/v2/", name, ".sol/", name, ".json"));
        return vm.parseJsonBytes(json, ".bytecode");
    }

    function artifactRuntime(string memory name) internal view returns (bytes memory) {
        string memory json = vm.readFile(string.concat("artifacts/contracts/v2/", name, ".sol/", name, ".json"));
        return vm.parseJsonBytes(json, ".deployedBytecode");
    }

    function deployCode_(bytes memory initCode) internal returns (address deployed) {
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0), "deployment failed");
    }

    function deployShipped() internal {
        implementation = DarkSafeVault(deployCode_(artifactBytecode("DarkSafeVault")));
        factory = DarkSafeVaultFactory(
            deployCode_(abi.encodePacked(artifactBytecode("DarkSafeVaultFactory"), abi.encode(address(implementation))))
        );
    }

    /// @dev Deterministic Cyprus-1 Quai-ledger address: first byte 0x00, second byte below 0x80.
    function cyprus(uint256 seed) internal pure returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encode("darksafe.owner", seed)))) >> 9);
        if (uint160(a) <= 1) a = address(uint160(0x0000_1000));
    }

    function owners(uint256 count, uint256 seedBase) internal pure returns (address[] memory list) {
        list = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            unchecked {
                list[i] = cyprus(seedBase + i);
            }
        }
    }

    uint256 private saltNonce;

    function createVault(address[] memory owners_, uint256 threshold, uint32 delay) internal returns (DarkSafeVault vault) {
        bytes32 salt = keccak256(abi.encode(owners_, threshold, delay, ++saltNonce));
        vault = DarkSafeVault(payable(factory.createWallet(owners_, threshold, delay, salt)));
    }

    /// @dev Proposes as `proposer`; expiration defaults to delay + 7 days from now.
    function propose(DarkSafeVault vault, address proposer, address to, uint256 value, bytes memory data, uint64 gasLimit)
        internal
        returns (bytes32 txHash)
    {
        bool self = to == address(vault);
        uint32 delay = self ? 0 : vault.minExecutionDelay();
        vm.prank(proposer);
        txHash = vault.proposeTransaction(to, value, data, self ? 0 : gasLimit, uint64(block.timestamp + delay + 7 days), 0);
    }

    function approveAll(DarkSafeVault vault, bytes32 txHash, address[] memory approvers) internal {
        for (uint256 i = 0; i < approvers.length; i++) {
            if (vault.hasApproved(txHash, approvers[i])) continue;
            vm.prank(approvers[i]);
            vault.approveTransaction(txHash);
        }
    }
}

/// Records how much gas it was given, so tests can prove a call got its full committed gas.
contract GasProbe {
    uint256 public seenGas;
    uint256 public calls;

    function probe(uint256 burnIterations) external payable {
        seenGas = gasleft();
        calls += 1;
        for (uint256 i = 0; i < burnIterations; i++) {
            assembly {
                pop(keccak256(0, 32))
            }
        }
    }

    receive() external payable {}
}
