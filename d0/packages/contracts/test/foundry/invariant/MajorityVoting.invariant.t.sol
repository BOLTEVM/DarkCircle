// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {OrderTestBase} from "../Base.sol";
import {Guild} from "../../../contracts/Guild.sol";
import {GovernanceToken} from "../../../contracts/GovernanceToken.sol";
import {MajorityVoting} from "../../../contracts/MajorityVoting.sol";

bytes32 constant ROOT_ROLE = keccak256("ROOT_ROLE");
bytes32 constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
bytes32 constant SET_METADATA_ROLE = keccak256("SET_METADATA_ROLE");

/**
 * Stateful campaign over Token Hall. The handler mints voting power (as token owner, a role
 * the guild would hold in production), holders delegate, proposals open, votes land and
 * time warps forward. Independently tracked ghost tallies must equal the contract's, and
 * an execution must have been lawful at the moment it happened.
 */
contract VotingHandler is Test {
    Guild public guild;
    GovernanceToken public token;
    MajorityVoting public voting;
    address[] public voters;

    uint256 public violations;
    string public firstViolation;

    mapping(uint256 => uint256) public ghostYes;
    mapping(uint256 => uint256) public ghostNo;
    mapping(uint256 => uint256) public ghostAbstain;
    mapping(uint256 => mapping(address => bool)) public ghostVoted;

    constructor(Guild guild_, GovernanceToken token_, MajorityVoting voting_, address[] memory voters_) {
        guild = guild_;
        token = token_;
        voting = voting_;
        voters = voters_;
    }

    function _violation(string memory what) internal {
        violations++;
        if (bytes(firstViolation).length == 0) firstViolation = what;
    }

    function _voter(uint8 seed) internal view returns (address) {
        return voters[seed % voters.length];
    }

    function mintDelegate(uint8 whoSeed, uint96 amount) public {
        address who = _voter(whoSeed);
        amount = uint96(bound(amount, 1, 1e24));
        token.mint(who, amount);
        vm.prank(who);
        token.delegate(who);
    }

    function create(uint8 whoSeed) public {
        vm.roll(block.number + 1); // seal earlier mints into the snapshot
        address who = _voter(whoSeed);
        if (token.getPastVotes(who, block.number - 1) == 0) return;
        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.prank(who);
        try voting.createProposal("", acts, 0, 0) {} catch {
            _violation("an empowered voter could not open a proposal");
        }
    }

    function vote(uint8 whoSeed, uint8 optSeed, uint256 pidSeed) public {
        uint256 count = voting.proposalCount();
        if (count == 0) return;
        uint256 pid = pidSeed % count;
        MajorityVoting.ProposalView memory v = voting.getProposal(pid);
        if (v.executed) return;
        if (block.timestamp < v.startDate || block.timestamp >= v.endDate) return;
        address who = _voter(whoSeed);
        if (ghostVoted[pid][who]) return;
        uint256 power = token.getPastVotes(who, v.snapshotBlock);
        if (power == 0) return;
        MajorityVoting.VoteOption opt = MajorityVoting.VoteOption(bound(optSeed, 1, 3));
        vm.prank(who);
        try voting.vote(pid, opt, false) {
            ghostVoted[pid][who] = true;
            if (opt == MajorityVoting.VoteOption.Yes) ghostYes[pid] += power;
            else if (opt == MajorityVoting.VoteOption.No) ghostNo[pid] += power;
            else ghostAbstain[pid] += power;
        } catch {
            _violation("a lawful vote reverted");
        }
    }

    function execute(uint256 pidSeed) public {
        uint256 count = voting.proposalCount();
        if (count == 0) return;
        uint256 pid = pidSeed % count;
        if (voting.getProposal(pid).executed) return;
        bool lawful = voting.canExecute(pid);
        try voting.execute(pid) {
            if (!lawful) _violation("an unlawful proposal executed");
        } catch {
            if (lawful) _violation("a lawful execution reverted");
        }
    }

    function warp(uint32 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }
}

contract MajorityVotingInvariantTest is OrderTestBase {
    Guild internal guild;
    GovernanceToken internal token;
    MajorityVoting internal voting;
    VotingHandler internal handler;

    function setUp() public {
        guild = Guild(payable(deployCode_(abi.encodePacked(artifactBytecode("Guild"), abi.encode(address(this))))));
        token = GovernanceToken(
            deployCode_(abi.encodePacked(artifactBytecode("GovernanceToken"), abi.encode("Hall Token", "HALL", address(this), uint256(0))))
        );
        voting = MajorityVoting(
            deployCode_(
                abi.encodePacked(
                    artifactBytecode("MajorityVoting"),
                    abi.encode(address(guild), address(token), uint256(5_000), uint256(1_000), uint64(1 hours))
                )
            )
        );
        guild.grant(EXECUTE_ROLE, address(voting));

        handler = new VotingHandler(guild, token, voting, actors(8, 2000));
        token.transferOwnership(address(handler)); // the handler mints for setup, as the guild would

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = VotingHandler.mintDelegate.selector;
        selectors[1] = VotingHandler.create.selector;
        selectors[2] = VotingHandler.vote.selector;
        selectors[3] = VotingHandler.vote.selector; // votes are the common case
        selectors[4] = VotingHandler.execute.selector;
        selectors[5] = VotingHandler.execute.selector; // executions are where the rules bite
        selectors[6] = VotingHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// The contract's tallies equal the independently tracked ghost tallies, for every proposal.
    function invariant_talliesMatchGhost() public view {
        uint256 count = voting.proposalCount();
        for (uint256 pid = 0; pid < count; pid++) {
            MajorityVoting.ProposalView memory v = voting.getProposal(pid);
            assertEq(v.yes, handler.ghostYes(pid));
            assertEq(v.no, handler.ghostNo(pid));
            assertEq(v.abstain, handler.ghostAbstain(pid));
        }
    }

    /// Cast votes never exceed the snapshot supply.
    function invariant_tallyBoundedBySupply() public view {
        uint256 count = voting.proposalCount();
        for (uint256 pid = 0; pid < count; pid++) {
            MajorityVoting.ProposalView memory v = voting.getProposal(pid);
            assertLe(v.yes + v.no + v.abstain, token.getPastTotalSupply(v.snapshotBlock));
        }
    }

    /// Every execution was lawful, and every lawful execution went through.
    function invariant_executionLegality() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }
}
