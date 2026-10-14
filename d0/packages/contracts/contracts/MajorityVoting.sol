// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Guild} from "./Guild.sol";

/**
 * Token Hall: majority voting over the guild's GovernanceToken, modeled on Aragon OSx
 * MajorityVotingBase. A proposal passes when its yes share of decided votes exceeds the
 * support threshold AND participation (all cast votes over the snapshot total supply)
 * reaches the minimum. Before the end date it can only pass early when yes alone beats
 * the threshold applied to the whole supply, so no outstanding vote could flip it.
 *
 * One vote per address, no vote changing: what you cast is final.
 */
contract MajorityVoting {
    enum VoteOption {
        None,
        Abstain,
        Yes,
        No
    }

    struct Proposal {
        uint64 startDate;
        uint64 endDate;
        uint256 snapshotBlock;
        uint256 supportThreshold;
        uint256 minParticipation;
        uint256 yes;
        uint256 no;
        uint256 abstain;
        bool executed;
        string metadata;
        Guild.Action[] actions;
        mapping(address => VoteOption) votes;
    }

    uint256 public constant MAX_BPS = 10_000;

    Guild public immutable guild;
    IVotes public immutable token;
    uint64 public immutable minDuration;

    uint256 public supportThreshold;
    uint256 public minParticipation;
    uint256 public proposalCount;

    mapping(uint256 => Proposal) private _proposals;

    event ProposalCreated(uint256 indexed proposalId, address indexed creator, uint64 startDate, uint64 endDate, string metadata, uint256 actionCount);
    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteOption option, uint256 power);
    event ProposalExecuted(uint256 indexed proposalId);
    event SettingsUpdated(uint256 supportThreshold, uint256 minParticipation);

    error ProposalUnknown(uint256 proposalId);
    error NoVotingPower(address voter);
    error StartInPast(uint64 startDate);
    error EndTooEarly(uint64 endDate, uint64 startDate);
    error VoteNotStarted(uint256 proposalId);
    error VoteEnded(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error VoteNone();
    error CannotExecute(uint256 proposalId);
    error NotTheGuild(address caller);
    error ThresholdInvalid(uint256 bps);

    constructor(Guild guild_, IVotes token_, uint256 supportThreshold_, uint256 minParticipation_, uint64 minDuration_) {
        if (supportThreshold_ > MAX_BPS || minParticipation_ > MAX_BPS) revert ThresholdInvalid(supportThreshold_ > MAX_BPS ? supportThreshold_ : minParticipation_);
        guild = guild_;
        token = token_;
        supportThreshold = supportThreshold_;
        minParticipation = minParticipation_;
        minDuration = minDuration_;
    }

    /// Thresholds can move, but only by the guild itself, i.e. by a passed proposal.
    function updateSettings(uint256 supportThreshold_, uint256 minParticipation_) external {
        if (msg.sender != address(guild)) revert NotTheGuild(msg.sender);
        if (supportThreshold_ > MAX_BPS || minParticipation_ > MAX_BPS) revert ThresholdInvalid(supportThreshold_ > MAX_BPS ? supportThreshold_ : minParticipation_);
        supportThreshold = supportThreshold_;
        minParticipation = minParticipation_;
        emit SettingsUpdated(supportThreshold_, minParticipation_);
    }

    function createProposal(
        string calldata metadata_,
        Guild.Action[] calldata actions_,
        uint64 startDate_,
        uint64 endDate_
    ) external returns (uint256 proposalId) {
        uint256 snapshot = block.number - 1;
        if (token.getPastVotes(msg.sender, snapshot) == 0) revert NoVotingPower(msg.sender);
        uint64 start = startDate_ == 0 ? uint64(block.timestamp) : startDate_;
        if (start < block.timestamp) revert StartInPast(start);
        uint64 end = endDate_ == 0 ? start + minDuration : endDate_;
        if (end < start + minDuration) revert EndTooEarly(end, start);

        proposalId = proposalCount++;
        Proposal storage p = _proposals[proposalId];
        p.startDate = start;
        p.endDate = end;
        p.snapshotBlock = snapshot;
        p.supportThreshold = supportThreshold;
        p.minParticipation = minParticipation;
        p.metadata = metadata_;
        for (uint256 i = 0; i < actions_.length; ++i) {
            p.actions.push(actions_[i]);
        }
        emit ProposalCreated(proposalId, msg.sender, start, end, metadata_, actions_.length);
    }

    function vote(uint256 proposalId_, VoteOption option_, bool tryEarlyExecution_) external {
        Proposal storage p = _open(proposalId_);
        if (option_ == VoteOption.None) revert VoteNone();
        if (block.timestamp < p.startDate) revert VoteNotStarted(proposalId_);
        if (block.timestamp >= p.endDate) revert VoteEnded(proposalId_);
        if (p.votes[msg.sender] != VoteOption.None) revert AlreadyVoted(proposalId_, msg.sender);
        uint256 power = token.getPastVotes(msg.sender, p.snapshotBlock);
        if (power == 0) revert NoVotingPower(msg.sender);

        p.votes[msg.sender] = option_;
        if (option_ == VoteOption.Yes) p.yes += power;
        else if (option_ == VoteOption.No) p.no += power;
        else p.abstain += power;
        emit VoteCast(proposalId_, msg.sender, option_, power);

        if (tryEarlyExecution_ && canExecute(proposalId_)) _execute(proposalId_);
    }

    function canExecute(uint256 proposalId_) public view returns (bool) {
        if (proposalId_ >= proposalCount) return false;
        Proposal storage p = _proposals[proposalId_];
        if (p.executed || block.timestamp < p.startDate) return false;
        uint256 totalSupply = token.getPastTotalSupply(p.snapshotBlock);
        if (totalSupply == 0) return false;
        uint256 cast = p.yes + p.no + p.abstain;
        if (cast * MAX_BPS < p.minParticipation * totalSupply) return false;
        uint256 decided = p.yes + p.no;
        if (decided == 0 || p.yes * MAX_BPS <= p.supportThreshold * decided) return false;
        if (block.timestamp >= p.endDate) return true;
        // Early execution: yes alone must beat the threshold over the entire supply,
        // so even every outstanding vote going no could not change the outcome.
        return p.yes * MAX_BPS > p.supportThreshold * totalSupply;
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
        uint64 startDate;
        uint64 endDate;
        uint256 snapshotBlock;
        uint256 supportThreshold;
        uint256 minParticipation;
        uint256 yes;
        uint256 no;
        uint256 abstain;
        bool executed;
        string metadata;
    }

    function getProposal(uint256 proposalId_) external view returns (ProposalView memory v) {
        Proposal storage p = _open(proposalId_);
        v.startDate = p.startDate;
        v.endDate = p.endDate;
        v.snapshotBlock = p.snapshotBlock;
        v.supportThreshold = p.supportThreshold;
        v.minParticipation = p.minParticipation;
        v.yes = p.yes;
        v.no = p.no;
        v.abstain = p.abstain;
        v.executed = p.executed;
        v.metadata = p.metadata;
    }

    function getActions(uint256 proposalId_) external view returns (Guild.Action[] memory acts) {
        Proposal storage p = _open(proposalId_);
        acts = new Guild.Action[](p.actions.length);
        for (uint256 i = 0; i < p.actions.length; ++i) {
            acts[i] = p.actions[i];
        }
    }

    function voteOf(uint256 proposalId_, address voter_) external view returns (VoteOption) {
        return _open(proposalId_).votes[voter_];
    }
}
