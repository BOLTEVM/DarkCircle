// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {OrderTestBase, Sink} from "../Base.sol";
import {Guild} from "../../../contracts/Guild.sol";
import {CouncilMultisig} from "../../../contracts/CouncilMultisig.sol";

bytes32 constant ROOT_ROLE = keccak256("ROOT_ROLE");
bytes32 constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
bytes32 constant SET_METADATA_ROLE = keccak256("SET_METADATA_ROLE");

/**
 * Stateful campaign over Council Hall. Five members, three approvals needed; members propose
 * and approve in any order while outsiders hammer the same entry points. Whatever happens:
 * approvals equal the distinct member approvals the handler tracked, an executed proposal
 * had the quorum when it executed, and no outsider call ever succeeded.
 */
contract CouncilHandler is Test {
    Guild public guild;
    CouncilMultisig public council;
    address[] public membersList;
    address[] public outsidersList;

    uint256 public violations;
    string public firstViolation;

    mapping(uint256 => uint256) public ghostApprovals;
    mapping(uint256 => mapping(address => bool)) public ghostApproved;

    constructor(Guild guild_, CouncilMultisig council_, address[] memory members_, address[] memory outsiders_) {
        guild = guild_;
        council = council_;
        membersList = members_;
        outsidersList = outsiders_;
    }

    function _violation(string memory what) internal {
        violations++;
        if (bytes(firstViolation).length == 0) firstViolation = what;
    }

    function propose(uint8 memberSeed) public {
        address m = membersList[memberSeed % membersList.length];
        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.prank(m);
        try council.createProposal("", acts) {} catch {
            _violation("a member could not open a proposal");
        }
    }

    function approve(uint8 memberSeed, uint256 pidSeed) public {
        uint256 count = council.proposalCount();
        if (count == 0) return;
        uint256 pid = pidSeed % count;
        if (council.getProposal(pid).executed) return;
        address m = membersList[memberSeed % membersList.length];
        if (ghostApproved[pid][m]) return;
        vm.prank(m);
        try council.approve(pid, false) {
            ghostApproved[pid][m] = true;
            ghostApprovals[pid] += 1;
        } catch {
            _violation("a lawful approval reverted");
        }
    }

    function outsiderPropose(uint8 seed) public {
        address o = outsidersList[seed % outsidersList.length];
        Guild.Action[] memory acts = new Guild.Action[](0);
        vm.prank(o);
        try council.createProposal("", acts) returns (uint256) {
            _violation("an outsider opened a proposal");
        } catch {}
    }

    function outsiderApprove(uint8 seed, uint256 pidSeed) public {
        uint256 count = council.proposalCount();
        if (count == 0) return;
        uint256 pid = pidSeed % count;
        address o = outsidersList[seed % outsidersList.length];
        vm.prank(o);
        try council.approve(pid, false) {
            _violation("an outsider approved");
        } catch {}
    }

    function execute(uint8 whoSeed, uint256 pidSeed) public {
        uint256 count = council.proposalCount();
        if (count == 0) return;
        uint256 pid = pidSeed % count;
        if (council.getProposal(pid).executed) return;
        bool lawful = council.canExecute(pid);
        address who = whoSeed % 2 == 0 ? membersList[whoSeed % membersList.length] : outsidersList[whoSeed % outsidersList.length];
        vm.prank(who);
        try council.execute(pid) {
            if (!lawful) _violation("a proposal executed below quorum");
        } catch {
            if (lawful) _violation("a lawful execution reverted");
        }
    }
}

contract CouncilMultisigInvariantTest is OrderTestBase {
    Guild internal guild;
    CouncilMultisig internal council;
    CouncilHandler internal handler;
    uint256 internal constant MIN_A = 3;

    function setUp() public {
        guild = Guild(payable(deployCode_(abi.encodePacked(artifactBytecode("Guild"), abi.encode(address(this))))));
        address[] memory members = actors(5, 3000);
        council = CouncilMultisig(
            deployCode_(abi.encodePacked(artifactBytecode("CouncilMultisig"), abi.encode(address(guild), members, MIN_A)))
        );
        guild.grant(EXECUTE_ROLE, address(council));

        handler = new CouncilHandler(guild, council, members, actors(4, 4000));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = CouncilHandler.propose.selector;
        selectors[1] = CouncilHandler.approve.selector;
        selectors[2] = CouncilHandler.approve.selector; // approvals are the common case
        selectors[3] = CouncilHandler.outsiderPropose.selector;
        selectors[4] = CouncilHandler.outsiderApprove.selector;
        selectors[5] = CouncilHandler.execute.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Contract approvals equal the handler's distinct-approval count, for every proposal.
    function invariant_approvalsMatchGhost() public view {
        uint256 count = council.proposalCount();
        for (uint256 pid = 0; pid < count; pid++) {
            assertEq(council.getProposal(pid).approvals, handler.ghostApprovals(pid));
        }
    }

    /// An executed proposal had quorum, and approvals never exceed the council size.
    function invariant_quorumAndBounds() public view {
        uint256 count = council.proposalCount();
        for (uint256 pid = 0; pid < count; pid++) {
            CouncilMultisig.ProposalView memory v = council.getProposal(pid);
            assertLe(v.approvals, council.memberCount());
            if (v.executed) assertGe(v.approvals, MIN_A);
        }
    }

    /// The membership wall held through every random sequence.
    function invariant_membershipWall() public view {
        assertEq(handler.violations(), 0, handler.firstViolation());
    }
}
