// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafeBuddyVault} from "../../../contracts/v2/SafeBuddyVault.sol";

/// Receives value from the vault; reverts on request so external-call failures are exercised.
contract Sink {
    uint256 public received;

    function pay(bool shouldRevert) external payable {
        if (shouldRevert) revert("sink refused");
        received += msg.value;
    }
}

/**
 * Drives a vault through random sequences of every lifecycle and admin action. Every
 * execute is checked against the rules it must obey at the moment it ran; a breach is
 * recorded in `violations` and fails invariant_noUnsafeExecution.
 */
contract VaultHandler is Test {
    SafeBuddyVault public immutable vault;
    Sink public immutable sink;
    address[] public actors;
    bytes32[] public hashes;

    uint256 public deposits;
    uint256 public violations;
    string public firstViolation;

    // Call counts, logged by the invariant suite to show what the campaign reached.
    uint256 public proposedExternal;
    uint256 public proposedAdmin;
    uint256 public approvals;
    uint256 public revokes;
    uint256 public cancels;
    uint256 public expiries;
    uint256 public executedOk;
    uint256 public executedFailed;
    uint256 public executedAdmin;
    uint256 public clockStarts;
    uint256 public starvedReverts;

    /// First non-zero approvedAt seen for each transaction (I3: it must never change).
    mapping(bytes32 => uint64) public seenApprovedAt;

    constructor(SafeBuddyVault vault_, Sink sink_, address[] memory actors_) {
        vault = vault_;
        sink = sink_;
        actors = actors_;
    }

    function hashCount() external view returns (uint256) {
        return hashes.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ---------------------------------------------------------------- selection helpers

    /// Mostly a current owner; one time in eight any actor (possibly not an owner).
    function _caller(uint256 seed) internal view returns (address) {
        if (seed % 8 == 0) return actors[(seed / 8) % actors.length];
        address[] memory o = vault.getOwners();
        return o[(seed / 8) % o.length];
    }

    function _tx(uint256 seed) internal view returns (bytes32) {
        if (hashes.length == 0) return bytes32(0);
        // Favour recent transactions, which are more likely to still be open.
        uint256 span = hashes.length < 6 ? hashes.length : 6;
        if (seed % 3 != 0) return hashes[hashes.length - 1 - (seed / 3) % span];
        return hashes[(seed / 3) % hashes.length];
    }

    /// A random transaction among the last 20 whose status is `wanted`, or zero. Random rather
    /// than newest, so one transaction the vault keeps refusing cannot stall the campaign.
    function _pickWithStatus(SafeBuddyVault.TxStatus wanted, uint256 seed) internal view returns (bytes32) {
        uint256 stop = hashes.length > 20 ? hashes.length - 20 : 0;
        bytes32[] memory found = new bytes32[](20);
        uint256 n;
        for (uint256 i = hashes.length; i > stop; i--) {
            if (vault.status(hashes[i - 1]) == wanted) found[n++] = hashes[i - 1];
        }
        return n == 0 ? bytes32(0) : found[seed % n];
    }

    /// An actor who is not currently an owner, or zero if all are.
    function _nonOwner(uint256 seed) internal view returns (address) {
        for (uint256 i = 0; i < actors.length; i++) {
            address candidate = actors[(seed % actors.length + i) % actors.length];
            if (!vault.isOwner(candidate)) return candidate;
        }
        return address(0);
    }

    /// An owner who has not approved `h` yet, or the first owner.
    function _ownerWithoutApproval(bytes32 h, uint256 seed) internal view returns (address) {
        address[] memory o = vault.getOwners();
        for (uint256 i = 0; i < o.length; i++) {
            address candidate = o[(seed % o.length + i) % o.length];
            if (!vault.hasApproved(h, candidate)) return candidate;
        }
        return o[0];
    }

    /// Runs after every action: approvedAt, once set, must never change.
    modifier recordsApprovedAt() {
        _;
        for (uint256 i = 0; i < hashes.length; i++) {
            uint64 at = vault.getTransaction(hashes[i]).approvedAt;
            uint64 seen = seenApprovedAt[hashes[i]];
            if (seen == 0) seenApprovedAt[hashes[i]] = at;
            else if (at != seen) _violate("approvedAt changed");
        }
    }

    function _violate(string memory why) internal {
        if (violations == 0) firstViolation = why;
        violations += 1;
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint96 amount) external {
        uint256 a = bound(amount, 1, 50 ether);
        vm.deal(address(this), a);
        (bool ok,) = address(vault).call{value: a}("");
        require(ok, "deposit failed");
        deposits += a;
    }

    function proposeExternal(uint256 callerSeed, uint96 value, bool shouldRevert, uint32 requestedDelay, uint256 window) external recordsApprovedAt {
        address proposer = _caller(callerSeed);
        uint256 v = bound(value, 0, 20 ether);
        // Mostly the vault floor; one time in four an extra delay of up to a day.
        uint32 req = requestedDelay % 4 == 0 ? uint32(bound(requestedDelay, 0, 1 days)) : 0;
        uint32 floor = vault.minExecutionDelay();
        uint256 delay = req > floor ? req : floor;
        uint64 exp = uint64(block.timestamp + delay + bound(window, 1 hours, 10 days));
        vm.prank(proposer);
        try vault.proposeTransaction(address(sink), v, abi.encodeCall(Sink.pay, (shouldRevert)), 200_000, exp, req) returns (bytes32 h) {
            hashes.push(h);
            proposedExternal++;
        } catch {}
    }

    function proposeAdmin(uint256 callerSeed, uint256 kind, uint256 argSeed, uint256 thresholdSeed, uint256 window) external recordsApprovedAt {
        uint256 ownerCount = vault.getOwners().length;
        bytes memory data;
        uint256 k = kind % 5;
        if (k == 0) {
            // Mostly someone who is not an owner yet; one time in six anyone (possibly a duplicate).
            address candidate = argSeed % 6 == 0 ? actors[argSeed % actors.length] : _nonOwner(argSeed);
            if (candidate == address(0)) return;
            data = abi.encodeCall(SafeBuddyVault.addOwner, (candidate, bound(thresholdSeed, 1, ownerCount + 1)));
        } else if (k == 1) {
            address[] memory o = vault.getOwners();
            uint256 maxT = ownerCount > 1 ? ownerCount - 1 : 1;
            data = abi.encodeCall(SafeBuddyVault.removeOwner, (o[argSeed % o.length], bound(thresholdSeed, 1, maxT)));
        } else if (k == 2) {
            data = abi.encodeCall(SafeBuddyVault.changeThreshold, (bound(thresholdSeed, 1, ownerCount)));
        } else if (k == 3) {
            // Occasionally over the 30-day cap, which must fail at execution and roll back.
            uint256 d = argSeed % 10 == 0 ? 31 days : bound(argSeed, 0, 3 days);
            data = abi.encodeCall(SafeBuddyVault.setMinExecutionDelay, (uint32(d)));
        } else {
            bytes32 target = _tx(argSeed);
            if (target == bytes32(0)) return;
            data = abi.encodeCall(SafeBuddyVault.cancelByConsensus, (target));
        }
        uint64 exp = uint64(block.timestamp + bound(window, 1 hours, 10 days));
        vm.prank(_caller(callerSeed));
        try vault.proposeTransaction(address(vault), 0, data, 0, exp, 0) returns (bytes32 h) {
            hashes.push(h);
            proposedAdmin++;
        } catch {}
    }

    function approve(uint256 callerSeed, uint256 txSeed) external recordsApprovedAt {
        // Three times in four, push the newest pending transaction towards quorum.
        bytes32 h = txSeed % 4 != 0 ? _pickWithStatus(SafeBuddyVault.TxStatus.Pending, txSeed / 4) : bytes32(0);
        address caller = h != bytes32(0) ? _ownerWithoutApproval(h, callerSeed) : _caller(callerSeed);
        if (h == bytes32(0)) h = _tx(txSeed);
        if (h == bytes32(0)) return;
        vm.prank(caller);
        try vault.approveTransaction(h) {
            approvals++;
        } catch {}
    }

    function revoke(uint256 callerSeed, uint256 txSeed) external recordsApprovedAt {
        bytes32 h = _tx(txSeed);
        if (h == bytes32(0)) return;
        uint64 approvedAtBefore = vault.getTransaction(h).approvedAt;
        vm.prank(_caller(callerSeed));
        try vault.revokeApproval(h) {
            revokes++;
            if (vault.getTransaction(h).approvedAt != approvedAtBefore) _violate("revoke changed approvedAt");
        } catch {}
    }

    function cancel(uint256 callerSeed, uint256 txSeed) external recordsApprovedAt {
        bytes32 h = _tx(txSeed);
        if (h == bytes32(0)) return;
        SafeBuddyVault.Transaction memory t = vault.getTransaction(h);
        address caller = _caller(callerSeed);
        vm.prank(caller);
        try vault.cancelTransaction(h) {
            cancels++;
            if (caller != t.proposer) _violate("non-proposer cancelled");
            if (t.approvedAt != 0) _violate("cancelled after quorum");
        } catch {}
    }

    function expire(uint256 txSeed) external recordsApprovedAt {
        bytes32 h = _tx(txSeed);
        if (h == bytes32(0)) return;
        uint64 exp = vault.getTransaction(h).expiration;
        try vault.expireTransaction(h) {
            expiries++;
            if (block.timestamp <= exp) _violate("expired early");
        } catch {}
    }

    function execute(uint256 callerSeed, uint256 txSeed, uint256 gasSeed) external recordsApprovedAt {
        // Three times in four, pick something that is executable (or whose clock needs starting).
        bytes32 h;
        if (txSeed % 4 != 0) {
            h = _pickWithStatus(SafeBuddyVault.TxStatus.Executable, txSeed / 4);
            if (h == bytes32(0)) h = _pickWithStatus(SafeBuddyVault.TxStatus.Timelocked, txSeed / 4);
        }
        if (h == bytes32(0)) h = _tx(txSeed);
        if (h == bytes32(0)) return;
        address caller = _caller(callerSeed);
        SafeBuddyVault.Transaction memory b = vault.getTransaction(h);
        uint256 approvalCount = vault.getApprovalCount(h);
        uint256 threshold = vault.threshold();
        bool callerIsOwner = vault.isOwner(caller);
        uint256 sinkBefore = sink.received();
        // One execute in four gets a random, possibly starving, amount of gas.
        uint256 gas = gasSeed % 4 == 0 ? bound(gasSeed, 30_000, 450_000) : 4_000_000;

        vm.prank(caller);
        (bool ok, bytes memory ret) = address(vault).call{gas: gas}(abi.encodeCall(SafeBuddyVault.executeTransaction, (h)));
        SafeBuddyVault.Transaction memory a = vault.getTransaction(h);

        if (!b.executed && a.executed) {
            if (!callerIsOwner) _violate("non-owner executed");
            if (approvalCount < threshold) _violate("executed without quorum");
            if (b.cancelled || b.expired || block.timestamp > b.expiration) _violate("executed a closed or expired transaction");
            if (b.approvedAt == 0 && b.executionDelay > 0) _violate("executed without running the timelock");
            if (b.approvedAt != 0 && block.timestamp < uint256(b.approvedAt) + b.executionDelay) _violate("timelock bypassed");
            if (a.to == address(vault)) {
                if (a.failed) _violate("admin call recorded as failed instead of reverting");
                executedAdmin++;
            } else {
                bool asked = abi.decode(_args(b.data), (bool));
                if (a.failed) {
                    executedFailed++;
                    if (!asked) _violate("call recorded as failed although the callee would succeed (gas griefing)");
                    if (sink.received() != sinkBefore) _violate("failed call moved value");
                } else {
                    executedOk++;
                    if (asked) _violate("a reverting call was recorded as successful");
                    if (sink.received() != sinkBefore + b.value) _violate("value not delivered exactly");
                }
            }
        } else if (ok) {
            // Returning without running is only allowed when it just started the timelock.
            bool ran = abi.decode(ret, (bool));
            if (ran) _violate("reported ran but did not execute");
            if (!(b.approvedAt == 0 && a.approvedAt != 0 && b.executionDelay > 0)) _violate("returned false without starting the clock");
            clockStarts++;
        } else if (gas < 4_000_000) {
            starvedReverts++;
        }
        if (b.executed && (a.executed != b.executed || a.failed != b.failed)) _violate("terminal transaction changed");
    }

    function warp(uint256 secondsForward) external recordsApprovedAt {
        // Mostly short steps (timelocks are hours), sometimes long enough to expire things.
        uint256 max = secondsForward % 4 == 0 ? 3 days : 2 hours;
        vm.warp(block.timestamp + bound(secondsForward, 1, max));
    }

    function _args(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) out[i] = data[i + 4];
    }
}
