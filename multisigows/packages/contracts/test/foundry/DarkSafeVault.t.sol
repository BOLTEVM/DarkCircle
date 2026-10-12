// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {VaultTestBase, GasProbe} from "./Base.sol";
import {DarkSafeVault} from "../../contracts/v2/DarkSafeVault.sol";

contract TransferSender {
    function sendWithStipend(address payable to) external payable {
        to.transfer(msg.value);
    }
}

contract DarkSafeVaultFuzzTest is VaultTestBase {
    DarkSafeVault internal vault;
    address[] internal team;
    GasProbe internal probe;

    function setUp() public {
        deployShipped();
        team = owners(3, 1);
        vault = createVault(team, 2, 0);
        probe = new GasProbe();
        vm.deal(address(vault), 100 ether);
    }

    function _pair() internal view returns (address[] memory two) {
        two = new address[](2);
        two[0] = team[0];
        two[1] = team[1];
    }

    // ------------------------------------------------------------------ hashing

    /// The hash the vault computes is exactly the documented encoding (core/src/vault/hash.ts mirrors it).
    function testFuzz_transactionHashMatchesSpec(
        address to,
        uint256 value,
        bytes calldata data,
        uint64 gasLimit,
        uint64 expiration,
        uint32 delay,
        uint256 nonce
    ) public view {
        bytes32 expected = keccak256(
            abi.encode(address(vault), block.chainid, to, value, keccak256(data), gasLimit, expiration, delay, nonce)
        );
        assertEq(vault.getTransactionHash(to, value, data, gasLimit, expiration, delay, nonce), expected);
    }

    /// A proposal's hash uses its position in the list as the nonce, which is how clients re-derive it.
    function testFuzz_proposalHashUsesListPosition(uint8 before, uint96 value, bytes32 dataSeed) public {
        before = uint8(bound(before, 0, 5));
        for (uint256 i = 0; i < before; i++) propose(vault, team[0], address(probe), i, "", 50_000);
        bytes memory data = abi.encodePacked(dataSeed, value);
        vm.prank(team[1]);
        bytes32 h = vault.proposeTransaction(address(probe), value, data, 90_000, uint64(block.timestamp + 7 days), 0);
        assertEq(vault.getTransactionHashes(before, 1)[0], h);
        assertEq(h, vault.getTransactionHash(address(probe), value, data, 90_000, uint64(block.timestamp + 7 days), 0, before));
    }

    // ------------------------------------------------------------------ expiry and delay bounds

    function testFuzz_expiryWindowIsEnforced(uint32 floor, uint32 requested, uint256 offset) public {
        floor = uint32(bound(floor, 0, MAX_DELAY));
        requested = uint32(bound(requested, 0, MAX_DELAY));
        DarkSafeVault v = createVault(team, 2, floor);
        uint256 delay = requested > floor ? requested : floor;
        uint256 executableFrom = block.timestamp + delay;
        offset = bound(offset, 0, MAX_WINDOW + 10);
        uint64 expiration = uint64(executableFrom + offset);

        vm.prank(team[0]);
        if (offset == 0) {
            vm.expectRevert(DarkSafeVault.ExpirationTooSoon.selector);
        } else if (offset > MAX_WINDOW) {
            vm.expectRevert(DarkSafeVault.ExpirationTooFar.selector);
        }
        v.proposeTransaction(address(probe), 0, "", 50_000, expiration, requested);
    }

    function testFuzz_selfCallsAreRestrictedToAdminSelectors(bytes4 selector, bytes calldata tail) public {
        bool isAdmin = selector == DarkSafeVault.addOwner.selector || selector == DarkSafeVault.removeOwner.selector
            || selector == DarkSafeVault.changeThreshold.selector || selector == DarkSafeVault.setMinExecutionDelay.selector
            || selector == DarkSafeVault.cancelByConsensus.selector;
        vm.prank(team[0]);
        if (!isAdmin) vm.expectRevert(abi.encodeWithSelector(DarkSafeVault.UnrecognizedSelfCall.selector, selector));
        vault.proposeTransaction(address(vault), 0, abi.encodePacked(selector, tail), 0, uint64(block.timestamp + 1 days), 0);
    }

    function testFuzz_nonOwnersCannotAct(address stranger) public {
        vm.assume(!vault.isOwner(stranger));
        bytes32 h = propose(vault, team[0], address(probe), 0, "", 50_000);
        vm.startPrank(stranger);
        vm.expectRevert(DarkSafeVault.NotAnOwner.selector);
        vault.approveTransaction(h);
        vm.expectRevert(DarkSafeVault.NotAnOwner.selector);
        vault.executeTransaction(h);
        vm.expectRevert(DarkSafeVault.NotAnOwner.selector);
        vault.revokeApproval(h);
        vm.expectRevert(DarkSafeVault.NotAnOwner.selector);
        vault.cancelTransaction(h);
        vm.expectRevert(DarkSafeVault.NotAnOwner.selector);
        vault.proposeTransaction(address(probe), 0, "", 50_000, uint64(block.timestamp + 1 days), 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ gas griefing (invariant I6)

    /**
     * Whatever gas an executor supplies, either the call runs with its full committed gas,
     * or the execute reverts and the transaction stays approved and executable. The vault
     * records a failure only when the callee fails even when given exactly its committed gas.
     */
    function testFuzz_starvedExecuteNeverBurnsTheTransaction(uint256 supplied, uint64 callGas, uint256 burn, bool withValue) public {
        callGas = uint64(bound(callGas, 25_000, 2_000_000));
        burn = bound(burn, 0, 3_000);
        uint256 value = withValue ? 1 ether : 0;
        bytes memory data = abi.encodeCall(GasProbe.probe, (burn));
        bytes32 h = propose(vault, team[0], address(probe), value, data, callGas);
        approveAll(vault, h, _pair());
        supplied = bound(supplied, 21_000, uint256(callGas) + 400_000);

        uint256 before = vm.snapshotState();
        vm.prank(team[0]);
        (bool ok,) = address(vault).call{gas: supplied}(abi.encodeCall(DarkSafeVault.executeTransaction, (h)));

        DarkSafeVault.Transaction memory t = vault.getTransaction(h);
        if (ok && t.failed) {
            // Terminal failure is only legitimate if the callee cannot succeed with its committed gas.
            vm.revertToState(before);
            vm.prank(address(vault));
            (bool calleeOk,) = address(probe).call{gas: callGas, value: value}(data);
            assertFalse(calleeOk, "recorded as failed although the callee succeeds with its committed gas");
        } else if (ok) {
            assertTrue(t.executed, "ran");
            assertEq(probe.calls(), 1);
            assertGe(probe.seenGas() + 1_000, callGas, "callee got less than its committed gas");
        } else {
            assertFalse(t.executed, "a reverted execute must leave the transaction open");
            assertEq(probe.calls(), 0);
            assertEq(vault.getApprovalCount(h), 2, "approvals survive");
            vm.prank(team[1]);
            assertTrue(vault.executeTransaction{gas: 5_000_000}(h), "still executable with enough gas");
        }
    }

    /// Finds the least gas at which execute succeeds and shows the callee still got its full gas there.
    function test_gasBoundaryForwardsFullCommittedGas() public {
        uint64 callGas = 500_000;
        bytes32 h = propose(vault, team[0], address(probe), 1 ether, abi.encodeCall(GasProbe.probe, (0)), callGas);
        approveAll(vault, h, _pair());
        uint256 lo = 21_000;
        uint256 hi = 2_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            vm.prank(team[0]);
            (bool ok,) = address(vault).call{gas: mid}(abi.encodeCall(DarkSafeVault.executeTransaction, (h)));
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        vm.prank(team[0]);
        (bool ok2,) = address(vault).call{gas: hi}(abi.encodeCall(DarkSafeVault.executeTransaction, (h)));
        assertTrue(ok2);
        assertGe(probe.seenGas() + 1_000, callGas);
        uint256 required = (uint256(callGas) * 64) / 63;
        console2.log("minimum gas to execute", hi, "slack over callGas*64/63", hi - required);
    }

    // ------------------------------------------------------------------ epochs, proxy, receive

    function testFuzz_removedOwnersApprovalsNeverCountAgain(uint256 whichSeed) public {
        address leaving = team[whichSeed % team.length];
        address[] memory others = new address[](2);
        uint256 k;
        for (uint256 i = 0; i < team.length; i++) if (team[i] != leaving) others[k++] = team[i];

        bytes32 target = propose(vault, others[0], address(probe), 0, "", 50_000);
        vm.prank(leaving);
        vault.approveTransaction(target);
        assertEq(vault.getApprovalCount(target), 2);

        bytes32 rm = propose(vault, others[0], address(vault), 0, abi.encodeCall(DarkSafeVault.removeOwner, (leaving, 2)), 0);
        approveAll(vault, rm, others);
        vm.prank(others[0]);
        vault.executeTransaction{gas: 5_000_000}(rm);
        assertEq(vault.getApprovalCount(target), 1, "removed owner's approval dropped");

        bytes32 add = propose(vault, others[0], address(vault), 0, abi.encodeCall(DarkSafeVault.addOwner, (leaving, 2)), 0);
        approveAll(vault, add, others);
        vm.prank(others[0]);
        vault.executeTransaction{gas: 5_000_000}(add);
        assertTrue(vault.isOwner(leaving));
        assertFalse(vault.hasApproved(target, leaving), "re-added owner's old approval must not revive");
        assertEq(vault.getApprovalCount(target), 1);
    }

    function test_plainTransferWithStipendReachesVault() public {
        TransferSender sender = new TransferSender();
        uint256 before = address(vault).balance;
        vm.expectEmit(true, false, false, true, address(vault));
        emit DarkSafeVault.Received(address(sender), 1 ether);
        sender.sendWithStipend{value: 1 ether}(payable(address(vault)));
        assertEq(address(vault).balance, before + 1 ether);
    }

    function test_proxyHasNoUpgradeOrReinitialisePath() public {
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        bytes32 implBefore = vm.load(address(vault), slot);
        vm.prank(team[0]);
        (bool ok,) = address(vault).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(probe), ""));
        assertFalse(ok);
        vm.expectRevert(DarkSafeVault.AlreadyInitialized.selector);
        vault.initialize(team, 1, 0);
        vm.expectRevert(DarkSafeVault.AlreadyInitialized.selector);
        implementation.initialize(team, 1, 0);
        assertEq(vm.load(address(vault), slot), implBefore);
    }

    function test_implementationRefusesPlainTransfers() public {
        (bool ok,) = address(implementation).call{value: 1}("");
        assertFalse(ok);
    }
}
