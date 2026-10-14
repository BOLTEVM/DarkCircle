// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {OrderTestBase} from "./Base.sol";
import {Guild} from "../../contracts/Guild.sol";
import {GovernanceToken} from "../../contracts/GovernanceToken.sol";
import {MajorityVoting} from "../../contracts/MajorityVoting.sol";

/// Token Hall: the threshold and participation arithmetic decides whether the treasury
/// moves, so it is fuzzed against an independent mirror of the spec, including the strict
/// inequalities at the early-execution boundary.
contract MajorityVotingFuzzTest is OrderTestBase {
    uint64 internal constant MIN_DURATION = 1 hours;
    uint256 internal constant BPS = 10_000;

    Guild internal guild; // this test contract is ROOT
    GovernanceToken internal token; // this test contract is the owner (mint for setup only)

    function _setupVoting(uint256 support, uint256 participation) internal returns (MajorityVoting voting) {
        guild = Guild(payable(deployCode_(abi.encodePacked(artifactBytecode("Guild"), abi.encode(address(this))))));
        token = GovernanceToken(
            deployCode_(abi.encodePacked(artifactBytecode("GovernanceToken"), abi.encode("Hall Token", "HALL", address(this), uint256(0))))
        );
        voting = MajorityVoting(
            deployCode_(
                abi.encodePacked(
                    artifactBytecode("MajorityVoting"), abi.encode(address(guild), address(token), support, participation, MIN_DURATION)
                )
            )
        );
        guild.grant(guild.EXECUTE_ROLE(), address(voting));
    }

    /// Mint + self-delegate, then seal the block so the next proposal snapshot sees the power.
    function _empower(address voter, uint256 power) internal {
        token.mint(voter, power);
        vm.prank(voter);
        token.delegate(voter);
    }

    function _open(MajorityVoting voting, address creator) internal returns (uint256 pid) {
        rollPastSnapshot();
        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.prank(creator);
        pid = voting.createProposal("", acts, 0, 0);
    }

    // --- construction --------------------------------------------------------

    function testFuzz_constructorBounds(uint256 s, uint256 p) public {
        Guild g = Guild(payable(deployCode_(abi.encodePacked(artifactBytecode("Guild"), abi.encode(address(this))))));
        GovernanceToken t = GovernanceToken(
            deployCode_(abi.encodePacked(artifactBytecode("GovernanceToken"), abi.encode("T", "T", address(this), uint256(0))))
        );
        bytes memory init = abi.encodePacked(
            artifactBytecode("MajorityVoting"), abi.encode(address(g), address(t), s, p, MIN_DURATION)
        );
        if (s > BPS || p > BPS) {
            uint256 bad = s > BPS ? s : p;
            vm.expectRevert(abi.encodeWithSelector(MajorityVoting.ThresholdInvalid.selector, bad));
            deployCode_(init);
        } else {
            deployCode_(init);
        }
    }

    // --- proposal window -----------------------------------------------------

    function testFuzz_startInPastReverts(uint64 start) public {
        vm.warp(1_000_000);
        start = uint64(bound(start, 1, 999_999));
        MajorityVoting voting = _setupVoting(5_000, 0);
        _empower(cyprus(1), 1 ether);
        rollPastSnapshot();
        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.StartInPast.selector, start));
        vm.prank(cyprus(1));
        voting.createProposal("", acts, start, 0);
    }

    function testFuzz_endTooEarlyReverts(uint64 short_) public {
        vm.warp(1_000_000);
        short_ = uint64(bound(short_, 0, MIN_DURATION - 1));
        MajorityVoting voting = _setupVoting(5_000, 0);
        _empower(cyprus(1), 1 ether);
        rollPastSnapshot();
        Guild.Action[] memory acts = new Guild.Action[](0);
        uint64 start = uint64(block.timestamp);
        uint64 end = start + short_;
        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.EndTooEarly.selector, end, start));
        vm.prank(cyprus(1));
        voting.createProposal("", acts, start, end);
    }

    function testFuzz_windowAccepted(uint64 extra) public {
        vm.warp(1_000_000);
        extra = uint64(bound(extra, 0, 365 days));
        MajorityVoting voting = _setupVoting(5_000, 0);
        _empower(cyprus(1), 1 ether);
        rollPastSnapshot();
        Guild.Action[] memory acts = new Guild.Action[](0);
        uint64 start = uint64(block.timestamp);
        uint64 end = start + MIN_DURATION + extra;
        vm.prank(cyprus(1));
        uint256 pid = voting.createProposal("", acts, start, end);
        MajorityVoting.ProposalView memory v = voting.getProposal(pid);
        assertEq(v.startDate, start);
        assertEq(v.endDate, end);
        assertEq(v.snapshotBlock, block.number - 1);
    }

    function testFuzz_createWithoutPowerReverts(address nobody) public {
        MajorityVoting voting = _setupVoting(5_000, 0);
        _empower(cyprus(1), 1 ether);
        vm.assume(nobody != cyprus(1));
        rollPastSnapshot();
        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.NoVotingPower.selector, nobody));
        vm.prank(nobody);
        voting.createProposal("", acts, 0, 0);
    }

    // --- voting --------------------------------------------------------------

    function testFuzz_oneVoteFinal(uint8 optSeed) public {
        MajorityVoting voting = _setupVoting(5_000, 0);
        MajorityVoting.VoteOption opt = MajorityVoting.VoteOption(bound(optSeed, 1, 3));
        _empower(cyprus(1), 1 ether);
        _empower(cyprus(2), 2 ether);
        uint256 pid = _open(voting, cyprus(1));

        vm.prank(cyprus(2));
        voting.vote(pid, opt, false);
        assertEq(uint256(voting.voteOf(pid, cyprus(2))), uint256(opt));

        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.AlreadyVoted.selector, pid, cyprus(2)));
        vm.prank(cyprus(2));
        voting.vote(pid, opt, false);
    }

    function testFuzz_tallyEqualsSnapshotPower(uint96 pYes, uint96 pNo, uint96 pAbstain) public {
        vm.assume(pYes > 0 && pNo > 0 && pAbstain > 0);
        MajorityVoting voting = _setupVoting(5_000, 0);
        _empower(cyprus(1), pYes);
        _empower(cyprus(2), pNo);
        _empower(cyprus(3), pAbstain);
        uint256 pid = _open(voting, cyprus(1));

        vm.prank(cyprus(1));
        voting.vote(pid, MajorityVoting.VoteOption.Yes, false);
        vm.prank(cyprus(2));
        voting.vote(pid, MajorityVoting.VoteOption.No, false);
        vm.prank(cyprus(3));
        voting.vote(pid, MajorityVoting.VoteOption.Abstain, false);

        MajorityVoting.ProposalView memory v = voting.getProposal(pid);
        assertEq(v.yes, pYes);
        assertEq(v.no, pNo);
        assertEq(v.abstain, pAbstain);
        assertLe(v.yes + v.no + v.abstain, token.getPastTotalSupply(v.snapshotBlock));
    }

    /// Voting power is the snapshot, not the wallet: tokens minted after creation do not count.
    function testFuzz_snapshotIsolation(uint96 late) public {
        vm.assume(late > 0);
        MajorityVoting voting = _setupVoting(5_000, 0);
        _empower(cyprus(1), 1 ether);
        uint256 pid = _open(voting, cyprus(1));

        _empower(cyprus(9), late);
        rollPastSnapshot();
        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.NoVotingPower.selector, cyprus(9)));
        vm.prank(cyprus(9));
        voting.vote(pid, MajorityVoting.VoteOption.Yes, false);
    }

    // --- the arithmetic that moves money: mirror the spec --------------------

    function _specCanExecute(
        uint256 yes,
        uint256 no,
        uint256 abstain,
        uint256 support,
        uint256 participation,
        bool afterEnd
    ) internal pure returns (bool) {
        uint256 total = yes + no + abstain;
        if (total == 0) return false;
        uint256 cast = total;
        if (cast * BPS < participation * total) return false;
        uint256 decided = yes + no;
        if (decided == 0 || yes * BPS <= support * decided) return false;
        if (afterEnd) return true;
        return yes * BPS > support * total;
    }

    function testFuzz_canExecuteMirrorsSpec(uint32 supportSeed, uint32 partSeed, uint96 a, uint96 b, uint96 c, bool afterEnd)
        public
    {
        vm.assume(a > 0 && b > 0 && c > 0);
        uint256 support = bound(supportSeed, 0, BPS);
        uint256 participation = bound(partSeed, 0, BPS);
        vm.warp(1_000_000);
        MajorityVoting voting = _setupVoting(support, participation);
        _empower(cyprus(1), a);
        _empower(cyprus(2), b);
        _empower(cyprus(3), c);
        uint256 pid = _open(voting, cyprus(1));

        vm.prank(cyprus(1));
        voting.vote(pid, MajorityVoting.VoteOption.Yes, false);
        vm.prank(cyprus(2));
        voting.vote(pid, MajorityVoting.VoteOption.No, false);
        vm.prank(cyprus(3));
        voting.vote(pid, MajorityVoting.VoteOption.Abstain, false);

        if (afterEnd) {
            MajorityVoting.ProposalView memory v = voting.getProposal(pid);
            vm.warp(uint256(v.endDate) + 1);
        }

        bool want = _specCanExecute(a, b, c, support, participation, afterEnd);
        assertEq(voting.canExecute(pid), want);
        if (want) {
            voting.execute(pid);
            assertTrue(voting.getProposal(pid).executed);
        } else {
            vm.expectRevert(abi.encodeWithSelector(MajorityVoting.CannotExecute.selector, pid));
            voting.execute(pid);
        }
    }

    /// Early execution turns on strictness: yes*10000 must be GREATER than support*supply.
    /// At exact equality the proposal must still wait for the end date. Total supply is
    /// pinned at 10_000 so the equality case is exact: yes == support hits it, yes == support+1
    /// crosses it.
    function testFuzz_earlyExecutionBoundary(uint32 s) public {
        uint256 support = bound(s, 1, BPS - 2);

        // Case 1: yes*10000 == support*total exactly -> not executable before the end.
        {
            vm.warp(1_000_000);
            MajorityVoting voting = _setupVoting(support, 0);
            _empower(cyprus(1), support);
            _empower(cyprus(2), BPS - support); // silent holder, pins total supply at 10_000
            uint256 pidEq = _open(voting, cyprus(1));
            vm.prank(cyprus(1));
            voting.vote(pidEq, MajorityVoting.VoteOption.Yes, true);
            assertEq(token.getPastTotalSupply(voting.getProposal(pidEq).snapshotBlock), BPS);
            assertFalse(voting.canExecute(pidEq));
            assertFalse(voting.getProposal(pidEq).executed);
        }

        // Case 2: one more wei of yes -> executable immediately.
        {
            vm.warp(1_000_000);
            MajorityVoting voting = _setupVoting(support, 0);
            _empower(cyprus(1), support + 1);
            _empower(cyprus(2), BPS - support - 1);
            uint256 pidOver = _open(voting, cyprus(1));
            vm.prank(cyprus(1));
            voting.vote(pidOver, MajorityVoting.VoteOption.Yes, true);
            assertTrue(voting.getProposal(pidOver).executed); // tryEarlyExecution fired inside vote
        }
    }

    function testFuzz_executeOnlyOnce() public {
        vm.warp(1_000_000);
        MajorityVoting voting = _setupVoting(5_000, 0);
        _empower(cyprus(1), 1 ether);
        uint256 pid = _open(voting, cyprus(1));
        vm.prank(cyprus(1));
        voting.vote(pid, MajorityVoting.VoteOption.Yes, false);
        MajorityVoting.ProposalView memory v = voting.getProposal(pid);
        vm.warp(uint256(v.endDate) + 1);

        voting.execute(pid);
        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.CannotExecute.selector, pid));
        voting.execute(pid);
    }

    // --- settings ------------------------------------------------------------

    function testFuzz_updateSettingsOnlyByGuild(address caller, uint32 s, uint32 p) public {
        MajorityVoting voting = _setupVoting(5_000, 0);
        vm.assume(caller != address(guild));
        vm.expectRevert(abi.encodeWithSelector(MajorityVoting.NotTheGuild.selector, caller));
        vm.prank(caller);
        voting.updateSettings(s, p);

        uint256 sB = bound(s, 0, BPS);
        uint256 pB = bound(p, 0, BPS);
        vm.prank(address(guild));
        voting.updateSettings(sB, pB);
        assertEq(voting.supportThreshold(), sB);
        assertEq(voting.minParticipation(), pB);
    }
}
