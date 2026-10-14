// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OrderTestBase, Sink} from "./Base.sol";
import {Guild} from "../../contracts/Guild.sol";
import {CouncilMultisig} from "../../contracts/CouncilMultisig.sol";

/// Council Hall: a fixed-membership multisig. The member set is sealed at construction, so
/// the fuzzing targets the approval arithmetic: distinct member approvals, execution at
/// exactly the threshold, and a hard wall for non-members.
contract CouncilMultisigFuzzTest is OrderTestBase {
    Guild internal guild; // this test contract is ROOT
    Sink internal sink;

    function setUp() public {
        guild = Guild(payable(deployCode_(abi.encodePacked(artifactBytecode("Guild"), abi.encode(address(this))))));
        sink = new Sink();
    }

    function _council(address[] memory members, uint256 minApprovals) internal returns (CouncilMultisig c) {
        c = CouncilMultisig(
            deployCode_(abi.encodePacked(artifactBytecode("CouncilMultisig"), abi.encode(address(guild), members, minApprovals)))
        );
        guild.grant(guild.EXECUTE_ROLE(), address(c));
    }

    // --- construction --------------------------------------------------------

    function testFuzz_minApprovalsBounds(uint8 n, uint256 minA) public {
        n = uint8(bound(n, 1, 16));
        address[] memory members = actors(n, 100);
        if (minA == 0 || minA > n) {
            vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.MinApprovalsInvalid.selector, minA, uint256(n)));
            deployCode_(abi.encodePacked(artifactBytecode("CouncilMultisig"), abi.encode(address(guild), members, minA)));
        } else {
            CouncilMultisig c = _council(members, minA);
            assertEq(c.memberCount(), n);
            assertEq(c.minApprovals(), minA);
        }
    }

    function testFuzz_duplicateMemberReverts(uint8 dup) public {
        address[] memory members = actors(4, 200);
        members[bound(dup, 1, 3)] = members[0];
        vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.MemberDuplicate.selector, members[0]));
        deployCode_(abi.encodePacked(artifactBytecode("CouncilMultisig"), abi.encode(address(guild), members, uint256(2))));
    }

    function testFuzz_zeroMemberReverts(uint8 at) public {
        address[] memory members = actors(4, 300);
        members[bound(at, 0, 3)] = address(0);
        vm.expectRevert(CouncilMultisig.MemberZero.selector);
        deployCode_(abi.encodePacked(artifactBytecode("CouncilMultisig"), abi.encode(address(guild), members, uint256(2))));
    }

    function test_emptyMemberListReverts() public {
        address[] memory members = new address[](0);
        vm.expectRevert(CouncilMultisig.NoMembers.selector);
        deployCode_(abi.encodePacked(artifactBytecode("CouncilMultisig"), abi.encode(address(guild), members, uint256(1))));
    }

    // --- membership wall ------------------------------------------------------

    function testFuzz_onlyMembersProposeAndApprove(address outsider, uint8 memberSeed) public {
        address[] memory members = actors(5, 400);
        CouncilMultisig c = _council(members, 3);
        vm.assume(!c.isMember(outsider));

        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.NotMember.selector, outsider));
        vm.prank(outsider);
        c.createProposal("", acts);

        address member = members[bound(memberSeed, 0, 4)];
        vm.prank(member);
        uint256 pid = c.createProposal("", acts);

        vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.NotMember.selector, outsider));
        vm.prank(outsider);
        c.approve(pid, false);
    }

    // --- approval arithmetic ---------------------------------------------------

    function testFuzz_approvalsCountDistinctMembers(uint8 k) public {
        address[] memory members = actors(6, 500);
        CouncilMultisig c = _council(members, 6); // never reaches the threshold here
        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.prank(members[0]);
        uint256 pid = c.createProposal("", acts);

        k = uint8(bound(k, 1, 6));
        for (uint256 i = 0; i < k; i++) {
            vm.prank(members[i]);
            c.approve(pid, false);
        }
        CouncilMultisig.ProposalView memory v = c.getProposal(pid);
        assertEq(v.approvals, k);
        assertFalse(v.executed);

        // Approving twice from the same member must revert, not double-count.
        vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.AlreadyApproved.selector, pid, members[0]));
        vm.prank(members[0]);
        c.approve(pid, false);
        assertEq(c.getProposal(pid).approvals, k);
    }

    function testFuzz_executesAtExactlyTheThreshold(uint8 n, uint8 minAseed, address caller) public {
        n = uint8(bound(n, 1, 8));
        uint256 minA = bound(minAseed, 1, n);
        address[] memory members = actors(n, 600);
        CouncilMultisig c = _council(members, minA);
        vm.assume(!c.isMember(caller));

        Guild.Action[] memory acts = new Guild.Action[](1);
        acts[0] = Guild.Action({to: address(sink), value: 0, data: abi.encodeCall(Sink.poke, (42))});
        vm.prank(members[0]);
        uint256 pid = c.createProposal("", acts);

        for (uint256 i = 0; i + 1 < minA; i++) {
            vm.prank(members[i]);
            c.approve(pid, false);
        }
        if (minA > 1) {
            assertFalse(c.canExecute(pid));
            vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.CannotExecute.selector, pid));
            c.execute(pid);
        }

        vm.prank(members[minA - 1]);
        c.approve(pid, false);
        assertTrue(c.canExecute(pid));

        // Once the threshold stands, ANY address may execute.
        vm.prank(caller);
        c.execute(pid);
        assertEq(sink.calls(), 1);
        assertTrue(c.getProposal(pid).executed);

        // No re-execution, no further approvals.
        vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.CannotExecute.selector, pid));
        c.execute(pid);
        if (minA < n) {
            vm.expectRevert(abi.encodeWithSelector(CouncilMultisig.CannotExecute.selector, pid));
            vm.prank(members[minA]);
            c.approve(pid, false);
        }
    }

    function testFuzz_executedProposalSpendsExactly(uint96 tribute, uint96 spend) public {
        vm.assume(spend <= tribute);
        address[] memory members = actors(3, 700);
        CouncilMultisig c = _council(members, 2);
        vm.deal(address(this), tribute);
        guild.payTribute{value: tribute}(bytes32(uint256(9)));

        Guild.Action[] memory acts = new Guild.Action[](1);
        acts[0] = Guild.Action({to: address(sink), value: spend, data: abi.encodeCall(Sink.poke, (1))});
        vm.prank(members[0]);
        uint256 pid = c.createProposal("", acts);
        vm.prank(members[0]);
        c.approve(pid, false);
        vm.prank(members[1]);
        c.approve(pid, true); // execution inside approve

        assertEq(sink.received(), spend);
        assertEq(address(guild).balance, uint256(tribute) - spend);
    }
}
