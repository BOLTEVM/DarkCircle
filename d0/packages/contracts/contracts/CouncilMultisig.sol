// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Guild} from "./Guild.sol";

/**
 * Council Hall: a multisig governance module in the spirit of Aragon's Multisig plugin.
 * Only listed members may propose and approve; once a proposal reaches `minApprovals`
 * anyone may execute it. The member list is fixed at founding: rotating the council is
 * done by governance (found or install a new module, move EXECUTE_ROLE by proposal),
 * never by the council editing itself mid-vote.
 */
contract CouncilMultisig {
    struct Proposal {
        string metadata;
        uint64 createdAt;
        bool executed;
        uint256 approvals;
        Guild.Action[] actions;
        mapping(address => bool) approved;
    }

    Guild public immutable guild;
    uint256 public immutable minApprovals;
    uint256 public proposalCount;

    address[] private _members;
    mapping(address => bool) public isMember;
    mapping(uint256 => Proposal) private _proposals;

    event ProposalCreated(uint256 indexed proposalId, address indexed creator, string metadata, uint256 actionCount);
    event Approved(uint256 indexed proposalId, address indexed member, uint256 approvals);
    event ProposalExecuted(uint256 indexed proposalId);

    error NoMembers();
    error MinApprovalsInvalid(uint256 minApprovals, uint256 memberCount);
    error MemberZero();
    error MemberDuplicate(address member);
    error NotMember(address caller);
    error ProposalUnknown(uint256 proposalId);
    error AlreadyApproved(uint256 proposalId, address member);
    error CannotExecute(uint256 proposalId);

    constructor(Guild guild_, address[] memory members_, uint256 minApprovals_) {
        if (members_.length == 0) revert NoMembers();
        if (minApprovals_ == 0 || minApprovals_ > members_.length) revert MinApprovalsInvalid(minApprovals_, members_.length);
        guild = guild_;
        minApprovals = minApprovals_;
        for (uint256 i = 0; i < members_.length; ++i) {
            address m = members_[i];
            if (m == address(0)) revert MemberZero();
            if (isMember[m]) revert MemberDuplicate(m);
            isMember[m] = true;
            _members.push(m);
        }
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    function createProposal(string calldata metadata_, Guild.Action[] calldata actions_) external returns (uint256 proposalId) {
        if (!isMember[msg.sender]) revert NotMember(msg.sender);
        proposalId = proposalCount++;
        Proposal storage p = _proposals[proposalId];
        p.metadata = metadata_;
        p.createdAt = uint64(block.timestamp);
        for (uint256 i = 0; i < actions_.length; ++i) {
            p.actions.push(actions_[i]);
        }
        emit ProposalCreated(proposalId, msg.sender, metadata_, actions_.length);
    }

    function approve(uint256 proposalId_, bool tryExecution_) external {
        if (!isMember[msg.sender]) revert NotMember(msg.sender);
        Proposal storage p = _open(proposalId_);
        if (p.executed) revert CannotExecute(proposalId_);
        if (p.approved[msg.sender]) revert AlreadyApproved(proposalId_, msg.sender);
        p.approved[msg.sender] = true;
        p.approvals += 1;
        emit Approved(proposalId_, msg.sender, p.approvals);
        if (tryExecution_ && canExecute(proposalId_)) _execute(proposalId_);
    }

    function canExecute(uint256 proposalId_) public view returns (bool) {
        if (proposalId_ >= proposalCount) return false;
        Proposal storage p = _proposals[proposalId_];
        return !p.executed && p.approvals >= minApprovals;
    }

    function execute(uint256 proposalId_) external {
        if (!canExecute(proposalId_)) revert CannotExecute(proposalId_);
        _execute(proposalId_);
    }

    function _execute(uint256 proposalId_) internal {
        Proposal storage p = _proposals[proposalId_];
        p.executed = true;
        emit ProposalExecuted(proposalId_);
        uint256 n = p.actions.length;
        Guild.Action[] memory acts = new Guild.Action[](n);
        for (uint256 i = 0; i < n; ++i) {
            acts[i] = p.actions[i];
        }
        guild.execute(acts);
    }

    function _open(uint256 proposalId_) internal view returns (Proposal storage p) {
        if (proposalId_ >= proposalCount) revert ProposalUnknown(proposalId_);
        p = _proposals[proposalId_];
    }

    struct ProposalView {
        string metadata;
        uint64 createdAt;
        bool executed;
        uint256 approvals;
    }

    function getProposal(uint256 proposalId_) external view returns (ProposalView memory v) {
        Proposal storage p = _open(proposalId_);
        v.metadata = p.metadata;
        v.createdAt = p.createdAt;
        v.executed = p.executed;
        v.approvals = p.approvals;
    }

    function getActions(uint256 proposalId_) external view returns (Guild.Action[] memory acts) {
        Proposal storage p = _open(proposalId_);
        acts = new Guild.Action[](p.actions.length);
        for (uint256 i = 0; i < p.actions.length; ++i) {
            acts[i] = p.actions[i];
        }
    }

    function hasApproved(uint256 proposalId_, address member_) external view returns (bool) {
        return _open(proposalId_).approved[member_];
    }
}
