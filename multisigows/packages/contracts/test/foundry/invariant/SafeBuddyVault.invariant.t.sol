// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console2} from "forge-std/console2.sol";
import {VaultTestBase} from "../Base.sol";
import {VaultHandler, Sink} from "./VaultHandler.sol";
import {SafeBuddyVault} from "../../../contracts/v2/SafeBuddyVault.sol";

/**
 * Stateful invariant campaign over the shipped vault bytecode. The numbered invariants refer
 * to the security plan (I2 quorum/timelock/expiry, I3 approvedAt, I4 epochs, I6 gas, I9 bounds,
 * I11 delay cap, I12 enumeration).
 */
contract SafeBuddyVaultInvariantTest is VaultTestBase {
    VaultHandler internal handler;
    SafeBuddyVault internal vault;
    Sink internal sink;

    function setUp() public {
        deployShipped();
        address[] memory actors = owners(7, 100);
        address[] memory initial = new address[](3);
        for (uint256 i = 0; i < 3; i++) initial[i] = actors[i];
        vault = createVault(initial, 2, 1 hours);
        sink = new Sink();
        handler = new VaultHandler(vault, sink, actors);

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.proposeExternal.selector;
        selectors[2] = VaultHandler.proposeAdmin.selector;
        selectors[3] = VaultHandler.approve.selector;
        selectors[4] = VaultHandler.approve.selector; // approvals are needed often
        selectors[5] = VaultHandler.revoke.selector;
        selectors[6] = VaultHandler.cancel.selector;
        selectors[7] = VaultHandler.expire.selector;
        selectors[8] = VaultHandler.execute.selector;
        selectors[9] = VaultHandler.execute.selector; // executes are where the rules bite
        selectors[10] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// I2, I6, I7: every execute, cancel, revoke and expiry obeyed the rules when it happened.
    function invariant_noUnsafeExecution() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    /// I9, I11: governance always within bounds; the owner list and isOwner agree.
    function invariant_governanceBounds() public view {
        address[] memory o = vault.getOwners();
        uint256 t = vault.threshold();
        assertGe(o.length, 1);
        assertLe(o.length, 20);
        assertGe(t, 1);
        assertLe(t, o.length);
        assertLe(vault.minExecutionDelay(), MAX_DELAY);
        for (uint256 i = 0; i < o.length; i++) {
            assertTrue(vault.isOwner(o[i]));
            for (uint256 j = i + 1; j < o.length; j++) assertTrue(o[i] != o[j], "duplicate owner");
        }
        uint256 flagged;
        for (uint256 i = 0; i < handler.actorCount(); i++) if (vault.isOwner(handler.actors(i))) flagged++;
        assertEq(flagged, o.length, "isOwner set differs from the owner list");
    }

    /// I4: only current owners' approvals count, and the count matches the list.
    function invariant_approvalsOnlyFromCurrentOwners() public view {
        for (uint256 k = 0; k < handler.hashCount(); k++) {
            bytes32 h = handler.hashes(k);
            address[] memory approvers = vault.getApprovals(h);
            assertEq(vault.getApprovalCount(h), approvers.length);
            for (uint256 i = 0; i < approvers.length; i++) assertTrue(vault.isOwner(approvers[i]));
            for (uint256 i = 0; i < handler.actorCount(); i++) {
                address actor = handler.actors(i);
                if (!vault.isOwner(actor)) assertFalse(vault.hasApproved(h, actor), "non-owner approval counts");
            }
        }
    }

    /// I3: approvedAt is set once and never changes (the handler checks after every action).
    function invariant_approvedAtNeverChanges() public view {
        for (uint256 k = 0; k < handler.hashCount(); k++) {
            bytes32 h = handler.hashes(k);
            uint64 seen = handler.seenApprovedAt(h);
            if (seen != 0) assertEq(vault.getTransaction(h).approvedAt, seen, "approvedAt changed");
        }
    }

    /// Terminal flags are consistent and status() agrees with them.
    function invariant_terminalStatesConsistent() public view {
        for (uint256 k = 0; k < handler.hashCount(); k++) {
            bytes32 h = handler.hashes(k);
            SafeBuddyVault.Transaction memory t = vault.getTransaction(h);
            assertFalse(t.executed && t.cancelled, "executed and cancelled");
            if (t.failed) assertTrue(t.executed);
            if (t.to == address(vault)) assertFalse(t.failed, "admin calls never fail terminally");
            SafeBuddyVault.TxStatus s = vault.status(h);
            if (t.executed) assertTrue(s == (t.failed ? SafeBuddyVault.TxStatus.Failed : SafeBuddyVault.TxStatus.Executed));
            else if (t.cancelled) assertTrue(s == SafeBuddyVault.TxStatus.Cancelled);
            else if (t.expired || block.timestamp > t.expiration) assertTrue(s == SafeBuddyVault.TxStatus.Expired);
        }
    }

    /// Value only leaves the vault through successful calls, in exactly the committed amount.
    function invariant_balanceAccounting() public view {
        assertEq(address(vault).balance, handler.deposits() - sink.received());
    }

    /// I12: the list is complete and every hash re-derives from its stored fields and position.
    /// The TypeScript verifier (core/src/vault/verifier.ts) relies on exactly this.
    function invariant_everyHashRederivesFromStoredFields() public view {
        uint256 count = vault.getTransactionCount();
        assertEq(count, vault.txNonce());
        assertEq(count, handler.hashCount());
        for (uint256 i = 0; i < count; i++) {
            bytes32 h = vault.getTransactionHashes(i, 1)[0];
            assertEq(h, handler.hashes(i));
            SafeBuddyVault.Transaction memory t = vault.getTransaction(h);
            bytes32 expected = keccak256(
                abi.encode(address(vault), block.chainid, t.to, t.value, keccak256(t.data), t.gasLimit, t.expiration, t.executionDelay, i)
            );
            assertEq(h, expected);
        }
    }

    function afterInvariant() external view {
        console2.log("proposed ext/admin", handler.proposedExternal(), handler.proposedAdmin());
        console2.log("approvals/revokes", handler.approvals(), handler.revokes());
        console2.log("cancels/expiries", handler.cancels(), handler.expiries());
        console2.log("executed ok/failed/admin", handler.executedOk(), handler.executedFailed(), handler.executedAdmin());
        console2.log("clock starts/starved reverts", handler.clockStarts(), handler.starvedReverts());
    }
}
