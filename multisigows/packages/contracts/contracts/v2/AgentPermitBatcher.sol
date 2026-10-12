// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title AgentPermitBatcher
 * @notice Redeems a batch of off-chain ERC-2612 permits, signed independently by agents that
 * hold a permit-capable token, and sweeps every authorized amount into one fixed vault in a
 * single call.
 *
 * @dev The problem this solves: N agents each holding tokens they want under multisig custody
 * would otherwise need N separate approve()+transfer() transactions (N gas payers, no single
 * point of review). Instead each agent signs a free EIP-2612 permit off-chain; this contract is
 * proposed once as a DarkSafeVault v2 transaction (see `packages/contracts/contracts/v2/
 * DarkSafeVault.sol`), so the owners review and approve the whole batch as one line item, and
 * `executeTransaction` calls this contract exactly once to redeem all of it atomically.
 *
 * Design notes:
 *  - `vault` is immutable and is the ONLY possible destination for swept funds: nothing here can
 *    redirect a pull anywhere else, so this contract holds no funds and needs no admin surface.
 *  - Only `vault` may call `batchPermitTransfer`, matching how v2 vault transactions work (the
 *    vault is always `msg.sender` for a call it executes).
 *  - Each entry is isolated behind an internal try/catch (via a self-call, so both a reverting
 *    permit/transferFrom AND a return-data decode failure are caught the same way): one agent's
 *    stale, already-consumed, or forged-looking signature cannot block anyone else's sweep. This
 *    mirrors the tolerated-permit-failure pattern already used by `CircleswapRouter._permit`
 *    (q0/packages/contracts/contracts/amm/CircleswapRouter.sol).
 *  - `permit()` is itself allowed to fail (an agent may have approved this contract directly, or
 *    a permit already used) — what actually gates the sweep is whether `transferFrom` succeeds.
 *  - No DELEGATECALL, no upgrade path, no owner: matches the v2 vault's minimal-attack-surface
 *    invariant set.
 *  - Scope: only tokens that implement ERC-2612 (`permit`, `nonces`, `DOMAIN_SEPARATOR`) can be
 *    swept this way. Most third-party Quai tokens (WQUAI, USDT) do not; AgentPermit2Batcher.sol
 *    (this directory) covers those via Uniswap Permit2's SignatureTransfer instead.
 */
contract AgentPermitBatcher {
    /// @notice The only address swept funds can ever land in.
    address public immutable vault;

    struct BatchEntry {
        address token;
        address agent;
        uint256 amount;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Emitted once per entry, whether or not the pull succeeded.
    event AgentSwept(address indexed token, address indexed agent, uint256 amount, bool ok);

    error ZeroVault();
    error OnlyVault();
    error OnlySelf();

    constructor(address vault_) {
        if (vault_ == address(0)) revert ZeroVault();
        vault = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /**
     * @notice Redeems every entry's permit and pulls its tokens into `vault`.
     * @dev Reverts as a whole only if the CALL that reached this function ran out of the gas the
     * proposer committed to it (an ordinary EVM property, not special-cased here): a batch sized
     * larger than its committed gasLimit fails atomically, never partially. Within that budget,
     * each entry either succeeds or is recorded as failed; none can block the others.
     * @return ok Per-entry success, in the same order as `entries`.
     */
    function batchPermitTransfer(BatchEntry[] calldata entries) external onlyVault returns (bool[] memory ok) {
        uint256 len = entries.length;
        ok = new bool[](len);
        for (uint256 i = 0; i < len; i++) {
            BatchEntry calldata e = entries[i];
            // Deliberately one external call per entry: isolating each agent's permit is the
            // entire purpose of this function, not an oversight. `sweepOne` is onlySelf and does
            // all its own state changes atomically, so there is nothing here for a reentrant
            // callback to corrupt between iterations.
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
     * @notice Redeems a single entry. External-only so `batchPermitTransfer` can isolate its
     * failure via try/catch (a self-call is the only way Solidity lets a caller catch a callee's
     * return-data decode failure, not just an explicit revert); calling it any other way reverts.
     */
    function sweepOne(BatchEntry calldata e) external returns (bool) {
        if (msg.sender != address(this)) revert OnlySelf();

        try IERC20Permit(e.token).permit(e.agent, address(this), e.amount, e.deadline, e.v, e.r, e.s) {} catch {}

        // The "arbitrary" from is exactly the point: `e.agent` is authorized by the permit
        // signature just checked above, not by msg.sender or an approval this contract holds.
        // forge-lint: disable-next-item(arbitrary-send-erc20)
        // slither-disable-next-line arbitrary-send-erc20,arbitrary-send-erc20-permit
        bool success = IERC20(e.token).transferFrom(e.agent, vault, e.amount);
        // Reports the call's own outcome, so it can only follow the call; see the loop in
        // batchPermitTransfer for why no reentrant call can reach sweepOne with a spoofed sender.
        // forge-lint: disable-next-item(reentrancy-events)
        // slither-disable-next-line reentrancy-events
        emit AgentSwept(e.token, e.agent, e.amount, success);
        return success;
    }
}
