// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultTestBase} from "./Base.sol";
import {SafeBuddyVault} from "../../contracts/v2/SafeBuddyVault.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/**
 * One operation per test, on the shipped bytecode, recorded in .gas-snapshot
 * (`pnpm forge:snapshot`; CI runs `pnpm forge:snapshot:check`). Figures use Ethereum's gas
 * schedule: Quai prices storage by state size, so real Quai costs differ and deploy/execute
 * gas limits are still sized by packages/core/src/tx.ts, never from these numbers.
 */
contract GasTest is VaultTestBase {
    SafeBuddyVault internal vault;
    MockERC20 internal token;
    address[] internal team;
    address internal recipient;
    bytes32 internal nativeReady;
    bytes32 internal tokenReady;
    bytes32 internal adminReady;
    bytes32 internal awaitingApproval;

    function setUp() public {
        deployShipped();
        team = owners(3, 900);
        recipient = cyprus(999);
        vault = createVault(team, 2, 0);
        vm.deal(address(vault), 10 ether);
        token = new MockERC20("Token", "TKN", 18);
        token.mint(address(vault), 1_000 ether);

        address[] memory second = new address[](1);
        second[0] = team[1];
        nativeReady = propose(vault, team[0], recipient, 1 ether, "", 50_000);
        approveAll(vault, nativeReady, second);
        tokenReady = propose(vault, team[0], address(token), 0, abi.encodeCall(MockERC20.transfer, (recipient, 5 ether)), 100_000);
        approveAll(vault, tokenReady, second);
        adminReady = propose(vault, team[0], address(vault), 0, abi.encodeCall(SafeBuddyVault.addOwner, (cyprus(1000), 2)), 0);
        approveAll(vault, adminReady, second);
        awaitingApproval = propose(vault, team[0], recipient, 1, "", 50_000);
    }

    function test_gas_createWallet_threeOwners() public {
        factory.createWallet(owners(3, 5), 2, 1 days, bytes32(uint256(1)));
    }

    function test_gas_proposeNativeTransfer() public {
        vm.prank(team[2]);
        vault.proposeTransaction(recipient, 1 ether, "", 50_000, uint64(block.timestamp + 7 days), 0);
    }

    function test_gas_approveReachingQuorum() public {
        vm.prank(team[2]);
        vault.approveTransaction(awaitingApproval);
    }

    function test_gas_executeNativeTransfer() public {
        vm.prank(team[1]);
        vault.executeTransaction(nativeReady);
    }

    function test_gas_executeTokenTransfer() public {
        vm.prank(team[1]);
        vault.executeTransaction(tokenReady);
    }

    function test_gas_executeAddOwner() public {
        vm.prank(team[1]);
        vault.executeTransaction(adminReady);
    }

    function test_gas_revokeApproval() public {
        vm.prank(team[1]);
        vault.revokeApproval(nativeReady);
    }
}
