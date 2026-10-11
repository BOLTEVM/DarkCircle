// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @notice Minimal surface of Uniswap Permit2's `ISignatureTransfer`, transcribed from its
 * widely-published, stable public interface. Permit2's own source is not vendored anywhere in
 * this workspace and this session has no network access to fetch it, so unlike
 * AgentPermitBatcher.sol's ERC-2612 interface (a real standard already implemented by real
 * tokens in this workspace, e.g. q0/packages/contracts/contracts/Qrb.sol) or quaivault.ts's ABI
 * (transcribed from that project's own vendored SDK source), this interface has not been
 * cross-checked against a locally-held copy of the real contract. Verify it against the actual
 * deployed Permit2 bytecode/ABI before this is relied on for real funds.
 */
interface IPermit2SignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/**
 * @title AgentPermit2Batcher
 * @notice The Permit2 sibling of AgentPermitBatcher.sol, for tokens that do not implement
 * ERC-2612 themselves (most real Quai assets: WQUAI, USDT). Same shape, same guarantees â€” see
 * AgentPermitBatcher.sol's doc comment for the full design rationale, which applies here
 * unchanged: `vault` is immutable and is the only possible destination, only `vault` may call
 * `batchPermit2Transfer`, each entry is isolated behind a self-call try/catch, no DELEGATECALL,
 * no upgrade path, no owner.
 *
 * @dev What's different from the ERC-2612 path:
 *  - One call, not two: Permit2's `permitTransferFrom` verifies the signature and pulls the
 *    tokens in a single call (there is no separate `permit()` step to tolerate failing).
 *  - Permit2 must actually be deployed on the target chain, at `permit2` (immutable, set at
 *    construction â€” never hardcoded to Ethereum's canonical Permit2 address, which is not
 *    meaningful on Quai: nothing deploys there just because an address is reachable elsewhere).
 *  - Each agent still needs exactly one ordinary `token.approve(permit2, amount)` per token,
 *    once, before any of its Permit2 signatures can move that token â€” Permit2 pulls through its
 *    OWN allowance from the agent, not one granted to this contract. That on-chain step cannot
 *    be skipped or batched away by this contract.
 *  - Permit2's nonce is an arbitrary, agent-chosen `uint256` (an "unordered nonce" bitmap â€”
 *    any value not already used by that agent works), not a sequential counter.
 */
contract AgentPermit2Batcher {
    /// @notice The only address swept funds can ever land in.
    address public immutable vault;
    /// @notice The Permit2 deployment this batcher redeems signatures through.
    IPermit2SignatureTransfer public immutable permit2;

    struct BatchEntry {
        address token;
        address agent;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /// @notice Emitted once per entry, whether or not the pull succeeded.
    event AgentSwept(address indexed token, address indexed agent, uint256 amount, bool ok);

    error ZeroVault();
    error ZeroPermit2();
    error OnlyVault();
    error OnlySelf();

    constructor(address vault_, address permit2_) {
        if (vault_ == address(0)) revert ZeroVault();
        if (permit2_ == address(0)) revert ZeroPermit2();
        vault = vault_;
        permit2 = IPermit2SignatureTransfer(permit2_);
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /**
     * @notice Redeems every entry's Permit2 signature and pulls its tokens into `vault`.
     * @dev Reverts as a whole only if the CALL that reached this function ran out of the gas the
     * proposer committed to it: a batch sized larger than its committed gasLimit fails
     * atomically, never partially. Within that budget, each entry either succeeds or is
     * recorded as failed; none can block the others.
     * @return ok Per-entry success, in the same order as `entries`.
     */
    function batchPermit2Transfer(BatchEntry[] calldata entries) external onlyVault returns (bool[] memory ok) {
        uint256 len = entries.length;
        ok = new bool[](len);
        for (uint256 i = 0; i < len; i++) {
            BatchEntry calldata e = entries[i];
            // Deliberately one external call per entry: isolating each agent's signature is the
            // entire purpose of this function. `sweepOne` is onlySelf and does all its own state
            // changes atomically, so there is nothing here for a reentrant callback to corrupt
            // between iterations.
            // forge-lint: disable-next-item(calls-loop)
            // slither-disable-next-line calls-loop
            try this.sweepOne(e) returns (bool success) {
                ok[i] = success;
            } catch {
                ok[i] = false;
                // Reports the call's own outcome, so it can only follow the call. onlyVault and
                // sweepOne's onlySelf guard mean no reentrant call can reach either function with
                // a spoofed msg.sender, so a reordered/fabricated log is not reachable here.
                // forge-lint: disable-next-item(reentrancy-events)
                // slither-disable-next-line reentrancy-events
                emit AgentSwept(e.token, e.agent, e.amount, false);
            }
        }
    }

    /**
     * @notice Redeems a single entry. External-only so `batchPermit2Transfer` can isolate its
     * failure via try/catch; calling it any other way reverts.
     */
    function sweepOne(BatchEntry calldata e) external returns (bool) {
        if (msg.sender != address(this)) revert OnlySelf();

        // The digest Permit2 recovers a signer from commits to `spender = msg.sender` here
        // (this contract), not a field in the struct below â€” see the SDK's permit2.ts for why
        // agents must sign against this contract's own address as the spender.
        permit2.permitTransferFrom(
            IPermit2SignatureTransfer.PermitTransferFrom({
                permitted: IPermit2SignatureTransfer.TokenPermissions({token: e.token, amount: e.amount}),
                nonce: e.nonce,
                deadline: e.deadline
            }),
            IPermit2SignatureTransfer.SignatureTransferDetails({to: vault, requestedAmount: e.amount}),
            e.agent,
            e.signature
        );

        // forge-lint: disable-next-item(reentrancy-events)
        // slither-disable-next-line reentrancy-events
        emit AgentSwept(e.token, e.agent, e.amount, true);
        return true;
    }
}
