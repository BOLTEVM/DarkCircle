// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SafeBuddyVault (v2)
 * @notice Multi-signature vault for Quai Cyprus-1 with on-chain approvals.
 *
 * Lifecycle: an owner proposes (and thereby approves) a transaction, other owners approve
 * on chain, and once quorum is reached and the timelock has elapsed, any owner executes it.
 *
 * Security properties (each is covered by tests in test/v2):
 *  - No DELEGATECALL, CALLCODE or SELFDESTRUCT anywhere in this contract, no modules,
 *    no upgrade path and no privileged key.
 *  - Transactions are identified by a content hash and never block each other.
 *  - Every transaction carries a required expiry; expiry is checked before the timelock.
 *  - approvedAt is set once, on first quorum, and never cleared (no clock gaming).
 *  - Removing an owner bumps their epoch, invalidating all their in-flight approvals,
 *    even if they are later re-added.
 *  - An external call that fails is terminal only when it was given its full committed
 *    gasLimit; an under-gassed execute reverts instead, so low gas cannot burn an
 *    approved transaction.
 *  - Self-calls (administration) are restricted to a fixed set of selectors, carry no
 *    value, skip the timelock (so honest owners can react quickly) and revert on failure.
 *
 * Instances are ERC1967 proxies (SafeBuddyVaultProxy) created by SafeBuddyVaultFactory;
 * this implementation contract locks itself in its constructor.
 */
contract SafeBuddyVault is ReentrancyGuard {
    // ---------------------------------------------------------------- constants

    string public constant VERSION = "2.0.0";
    uint256 public constant MAX_OWNERS = 20;
    /// @notice Upper bound for the vault floor and for any per-transaction delay.
    uint32 public constant MAX_EXECUTION_DELAY = 30 days;
    /// @notice A transaction must expire within this window after it becomes executable.
    uint64 public constant MAX_EXECUTION_WINDOW = 30 days;
    uint64 public constant MAX_TX_GAS = 30_000_000;
    /// @notice Largest returndata kept from a failed call (bounds returndata-bomb griefing).
    uint256 public constant MAX_RETURNDATA = 256;
    /// @dev Gas kept back for the CALL itself and for the bookkeeping after it.
    uint256 private constant CALL_OVERHEAD_GAS = 40_000;
    uint256 private constant POST_CALL_GAS = 60_000;
    /// @dev Quai Cyprus-1 addresses start with 0x00.
    bytes1 private constant ZONE_PREFIX = 0x00;
    address private constant SENTINEL = address(0x1);

    // ---------------------------------------------------------------- types

    struct Transaction {
        address to;
        uint64 gasLimit;
        uint32 executionDelay;
        uint256 value;
        address proposer;
        uint64 proposedAt;
        uint64 expiration;
        uint64 approvedAt;
        bool executed;
        bool failed;
        bool cancelled;
        bool expired;
        bytes data;
    }

    enum TxStatus {
        None,
        Pending,
        Timelocked,
        Executable,
        Executed,
        Failed,
        Cancelled,
        Expired
    }

    // ---------------------------------------------------------------- storage

    bool private _initialized;
    address[] private _owners;
    mapping(address => bool) public isOwner;
    mapping(address => uint256) public ownerEpoch;
    uint256 public threshold;
    uint32 public minExecutionDelay;
    uint256 public txNonce;

    mapping(bytes32 => Transaction) private _txs;
    bytes32[] private _txHashes;
    /// @dev owner => (epoch + 1) at approval time; 0 means not approved.
    mapping(bytes32 => mapping(address => uint256)) private _approvals;

    // ---------------------------------------------------------------- events

    event VaultInitialized(address[] owners, uint256 threshold, uint32 minExecutionDelay);
    event TransactionProposed(
        bytes32 indexed txHash,
        address indexed proposer,
        address indexed to,
        uint256 value,
        bytes data,
        uint64 gasLimit,
        uint64 expiration,
        uint32 executionDelay
    );
    event TransactionApproved(bytes32 indexed txHash, address indexed owner);
    event ApprovalRevoked(bytes32 indexed txHash, address indexed owner);
    event ThresholdReached(bytes32 indexed txHash, uint64 approvedAt, uint64 executableAfter);
    event TransactionExecuted(bytes32 indexed txHash, address indexed executor);
    event TransactionFailed(bytes32 indexed txHash, address indexed executor, bytes returnData);
    event TransactionCancelled(bytes32 indexed txHash, address indexed canceller);
    event TransactionExpired(bytes32 indexed txHash);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);
    event MinExecutionDelayChanged(uint32 oldDelay, uint32 newDelay);
    /// @notice Emitted by SafeBuddyVaultProxy.receive(); declared here so the vault ABI decodes it.
    event Received(address indexed sender, uint256 value);

    // ---------------------------------------------------------------- errors

    error AlreadyInitialized();
    error NotAnOwner();
    error OnlySelf();
    error OwnersRequired();
    error TooManyOwners();
    error InvalidOwnerAddress(address owner);
    error DuplicateOwner(address owner);
    error InvalidThreshold();
    error ExecutionDelayTooLong();
    error InvalidDestination();
    error InvalidGasLimit();
    error SelfCallValueNotAllowed();
    error UnrecognizedSelfCall(bytes4 selector);
    error ExpirationTooSoon();
    error ExpirationTooFar();
    error TransactionNotFound();
    error TransactionAlreadyExecuted();
    error TransactionAlreadyCancelled();
    error TransactionAlreadyExpired();
    error TransactionIsExpired();
    error TransactionNotExpired();
    error AlreadyApproved();
    error NotApproved();
    error NotEnoughApprovals(uint256 approvals, uint256 required);
    error TimelockNotElapsed(uint256 executableAfter);
    error InsufficientGas(uint256 available, uint256 required);
    error InsufficientBalance(uint256 balance, uint256 value);
    error NotProposer();
    error CannotCancelApprovedTransaction();
    error SelfCallFailed(bytes returnData);
    error InvalidPagination();

    // ---------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotAnOwner();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    // ---------------------------------------------------------------- setup

    /// @dev Locks the implementation so it can never be initialized or used directly.
    constructor() {
        _initialized = true;
    }

    /**
     * @notice Called exactly once, atomically, by the proxy constructor. There is no
     *         window in which an uninitialized vault exists.
     */
    function initialize(address[] calldata owners_, uint256 threshold_, uint32 minExecutionDelay_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        uint256 count = owners_.length;
        if (count == 0) revert OwnersRequired();
        if (count > MAX_OWNERS) revert TooManyOwners();
        if (threshold_ == 0 || threshold_ > count) revert InvalidThreshold();
        if (minExecutionDelay_ > MAX_EXECUTION_DELAY) revert ExecutionDelayTooLong();

        for (uint256 i = 0; i < count; i++) {
            address owner = owners_[i];
            _validateNewOwner(owner);
            isOwner[owner] = true;
            _owners.push(owner);
        }
        threshold = threshold_;
        minExecutionDelay = minExecutionDelay_;
        emit VaultInitialized(owners_, threshold_, minExecutionDelay_);
    }

    // ---------------------------------------------------------------- lifecycle

    /**
     * @notice Proposes a transaction and records the proposer's approval.
     * @param gasLimit Gas committed to the external call (must be > 0). Must be 0 for self-calls.
     * @param expiration Required. Must be after the timelock ends and within MAX_EXECUTION_WINDOW of it.
     * @param requestedDelay Extra delay; the effective delay is max(minExecutionDelay, requestedDelay).
     */
    function proposeTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint64 gasLimit,
        uint64 expiration,
        uint32 requestedDelay
    ) external onlyOwner returns (bytes32 txHash) {
        if (to == address(0)) revert InvalidDestination();
        if (requestedDelay > MAX_EXECUTION_DELAY) revert ExecutionDelayTooLong();

        uint32 delay;
        if (to == address(this)) {
            if (value != 0) revert SelfCallValueNotAllowed();
            if (gasLimit != 0) revert InvalidGasLimit();
            _requireAdminSelector(data);
            delay = 0;
        } else {
            if (gasLimit == 0 || gasLimit > MAX_TX_GAS) revert InvalidGasLimit();
            delay = requestedDelay > minExecutionDelay ? requestedDelay : minExecutionDelay;
        }

        uint256 executableFrom = block.timestamp + delay;
        if (expiration <= executableFrom) revert ExpirationTooSoon();
        if (expiration > executableFrom + MAX_EXECUTION_WINDOW) revert ExpirationTooFar();

        uint256 nonce_ = txNonce++;
        txHash = getTransactionHash(to, value, data, gasLimit, expiration, delay, nonce_);

        Transaction storage t = _txs[txHash];
        t.to = to;
        t.value = value;
        t.data = data;
        t.gasLimit = gasLimit;
        t.expiration = expiration;
        t.executionDelay = delay;
        t.proposer = msg.sender;
        // Casting to uint64 is safe: block timestamps stay below 2^64 for billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        t.proposedAt = uint64(block.timestamp);
        _txHashes.push(txHash);

        emit TransactionProposed(txHash, msg.sender, to, value, data, gasLimit, expiration, delay);
        _approve(txHash, t);
    }

    function approveTransaction(bytes32 txHash) external onlyOwner {
        _approve(txHash, _openTransaction(txHash));
    }

    /// @notice Withdraws the caller's approval. Does not reset approvedAt once quorum was reached.
    function revokeApproval(bytes32 txHash) external onlyOwner {
        Transaction storage t = _existingTransaction(txHash);
        if (t.executed) revert TransactionAlreadyExecuted();
        if (t.cancelled) revert TransactionAlreadyCancelled();
        if (!_hasValidApproval(txHash, msg.sender)) revert NotApproved();
        delete _approvals[txHash][msg.sender];
        emit ApprovalRevoked(txHash, msg.sender);
    }

    /**
     * @notice Executes an approved transaction. If quorum exists but the clock was never
     *         started (the threshold was lowered after approvals), the first call starts it
     *         and, when a delay applies, returns false without executing.
     * @return ran True if the transaction was executed (successfully or terminally failed).
     */
    function executeTransaction(bytes32 txHash) external nonReentrant onlyOwner returns (bool ran) {
        Transaction storage t = _openTransaction(txHash);

        uint256 approvals = _countValidApprovals(txHash);
        if (approvals < threshold) revert NotEnoughApprovals(approvals, threshold);

        if (t.approvedAt == 0) {
            _startClock(txHash, t);
            if (t.executionDelay > 0) return false;
        }
        uint256 executableAfter = uint256(t.approvedAt) + t.executionDelay;
        if (block.timestamp < executableAfter) revert TimelockNotElapsed(executableAfter);

        if (t.to == address(this)) {
            t.executed = true;
            (bool ok, bytes memory ret) = address(this).call(t.data);
            if (!ok) revert SelfCallFailed(ret);
            // Emitted after the call because only now is the outcome known; the whole function
            // is nonReentrant, and a failed self-call reverts everything including this event.
            // forge-lint: disable-next-line(reentrancy-events)
            emit TransactionExecuted(txHash, msg.sender);
            return true;
        }

        if (address(this).balance < t.value) revert InsufficientBalance(address(this).balance, t.value);

        bytes memory data = t.data;
        address to = t.to;
        uint256 value = t.value;
        uint256 callGas = t.gasLimit;
        // Marked before the gas check so nothing but the CALL itself runs between the check and
        // the call. If the check reverts, so does this write.
        t.executed = true;
        uint256 required = (callGas * 64) / 63 + CALL_OVERHEAD_GAS + POST_CALL_GAS;
        if (gasleft() < required) revert InsufficientGas(gasleft(), required);

        bool success;
        assembly {
            success := call(callGas, to, value, add(data, 0x20), mload(data), 0, 0)
        }

        // Events follow the call because they report its outcome (see the self-call branch).
        if (success) {
            // forge-lint: disable-next-line(reentrancy-events)
            emit TransactionExecuted(txHash, msg.sender);
        } else {
            t.failed = true;
            // forge-lint: disable-next-line(reentrancy-events)
            emit TransactionFailed(txHash, msg.sender, _boundedReturnData());
        }
        return true;
    }

    /// @notice The proposer may cancel only before quorum was ever reached.
    function cancelTransaction(bytes32 txHash) external onlyOwner {
        Transaction storage t = _existingTransaction(txHash);
        if (t.proposer != msg.sender) revert NotProposer();
        if (t.approvedAt != 0) revert CannotCancelApprovedTransaction();
        _cancel(txHash, t);
    }

    /// @notice Anyone may formally close a transaction after its expiry.
    function expireTransaction(bytes32 txHash) external {
        Transaction storage t = _existingTransaction(txHash);
        if (t.executed) revert TransactionAlreadyExecuted();
        if (t.cancelled) revert TransactionAlreadyCancelled();
        if (t.expired) revert TransactionAlreadyExpired();
        if (block.timestamp <= t.expiration) revert TransactionNotExpired();
        t.expired = true;
        emit TransactionExpired(txHash);
    }

    // ---------------------------------------------------------------- administration (self-calls)

    function addOwner(address owner, uint256 newThreshold) external onlySelf {
        if (_owners.length >= MAX_OWNERS) revert TooManyOwners();
        _validateNewOwner(owner);
        isOwner[owner] = true;
        _owners.push(owner);
        emit OwnerAdded(owner);
        _setThreshold(newThreshold);
    }

    function removeOwner(address owner, uint256 newThreshold) external onlySelf {
        if (!isOwner[owner]) revert InvalidOwnerAddress(owner);
        uint256 len = _owners.length;
        if (len == 1) revert OwnersRequired();
        for (uint256 i = 0; i < len; i++) {
            if (_owners[i] == owner) {
                _owners[i] = _owners[len - 1];
                _owners.pop();
                break;
            }
        }
        isOwner[owner] = false;
        ownerEpoch[owner] += 1;
        emit OwnerRemoved(owner);
        _setThreshold(newThreshold);
    }

    function changeThreshold(uint256 newThreshold) external onlySelf {
        _setThreshold(newThreshold);
    }

    /// @notice Applies to transactions proposed afterwards; in-flight transactions keep their delay.
    function setMinExecutionDelay(uint32 newDelay) external onlySelf {
        if (newDelay > MAX_EXECUTION_DELAY) revert ExecutionDelayTooLong();
        emit MinExecutionDelayChanged(minExecutionDelay, newDelay);
        minExecutionDelay = newDelay;
    }

    /// @notice Cancels any open transaction, including one that already reached quorum.
    function cancelByConsensus(bytes32 txHash) external onlySelf {
        _cancel(txHash, _existingTransaction(txHash));
    }

    // ---------------------------------------------------------------- views

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint64 gasLimit,
        uint64 expiration,
        uint32 executionDelay,
        uint256 nonce_
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(this),
                block.chainid,
                to,
                value,
                keccak256(data),
                gasLimit,
                expiration,
                executionDelay,
                nonce_
            )
        );
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getTransaction(bytes32 txHash) external view returns (Transaction memory) {
        return _txs[txHash];
    }

    function getTransactionCount() external view returns (uint256) {
        return _txHashes.length;
    }

    function getTransactionHashes(uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        if (limit == 0 || limit > 100) revert InvalidPagination();
        uint256 total = _txHashes.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit > total ? total : offset + limit;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = _txHashes[i];
    }

    /// @notice Owners whose approval currently counts (epoch-checked).
    function getApprovals(bytes32 txHash) external view returns (address[] memory approvers) {
        uint256 len = _owners.length;
        address[] memory tmp = new address[](len);
        uint256 n = 0;
        for (uint256 i = 0; i < len; i++) {
            if (_hasValidApproval(txHash, _owners[i])) tmp[n++] = _owners[i];
        }
        approvers = new address[](n);
        for (uint256 i = 0; i < n; i++) approvers[i] = tmp[i];
    }

    function getApprovalCount(bytes32 txHash) external view returns (uint256) {
        return _countValidApprovals(txHash);
    }

    function hasApproved(bytes32 txHash, address owner) external view returns (bool) {
        return _hasValidApproval(txHash, owner);
    }

    /// @notice Computed status, including EXPIRED for transactions nobody has formally closed.
    function status(bytes32 txHash) external view returns (TxStatus) {
        Transaction storage t = _txs[txHash];
        if (t.proposedAt == 0) return TxStatus.None;
        if (t.executed) return t.failed ? TxStatus.Failed : TxStatus.Executed;
        if (t.cancelled) return TxStatus.Cancelled;
        if (t.expired || block.timestamp > t.expiration) return TxStatus.Expired;
        if (_countValidApprovals(txHash) < threshold) return TxStatus.Pending;
        if (t.approvedAt == 0) return t.executionDelay == 0 ? TxStatus.Executable : TxStatus.Timelocked;
        return block.timestamp < uint256(t.approvedAt) + t.executionDelay ? TxStatus.Timelocked : TxStatus.Executable;
    }

    // No receive()/fallback here on purpose: plain QUAI transfers are handled by the proxy's
    // own receive() (which emits Received), and anything sent straight to this ownerless
    // implementation contract must be refused rather than stranded.

    // ---------------------------------------------------------------- internals

    /// @dev Reverting inside initialize's loop is intended: one bad owner rejects the whole set.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _validateNewOwner(address owner) private view {
        if (owner == address(0) || owner == SENTINEL || owner == address(this)) revert InvalidOwnerAddress(owner);
        if (bytes20(owner)[0] != ZONE_PREFIX) revert InvalidOwnerAddress(owner);
        if (isOwner[owner]) revert DuplicateOwner(owner);
    }

    function _setThreshold(uint256 newThreshold) private {
        if (newThreshold == 0 || newThreshold > _owners.length) revert InvalidThreshold();
        if (newThreshold != threshold) {
            threshold = newThreshold;
            emit ThresholdChanged(newThreshold);
        }
    }

    function _requireAdminSelector(bytes calldata data) private pure {
        if (data.length < 4) revert UnrecognizedSelfCall(bytes4(0));
        bytes4 selector = bytes4(data[:4]);
        if (
            selector != SafeBuddyVault.addOwner.selector &&
            selector != SafeBuddyVault.removeOwner.selector &&
            selector != SafeBuddyVault.changeThreshold.selector &&
            selector != SafeBuddyVault.setMinExecutionDelay.selector &&
            selector != SafeBuddyVault.cancelByConsensus.selector
        ) revert UnrecognizedSelfCall(selector);
    }

    function _existingTransaction(bytes32 txHash) private view returns (Transaction storage t) {
        t = _txs[txHash];
        if (t.proposedAt == 0) revert TransactionNotFound();
    }

    /// @dev Existing, not executed, not cancelled, not expired (expiry checked before any timelock).
    function _openTransaction(bytes32 txHash) private view returns (Transaction storage t) {
        t = _existingTransaction(txHash);
        if (t.executed) revert TransactionAlreadyExecuted();
        if (t.cancelled) revert TransactionAlreadyCancelled();
        if (t.expired || block.timestamp > t.expiration) revert TransactionIsExpired();
    }

    function _approve(bytes32 txHash, Transaction storage t) private {
        if (_hasValidApproval(txHash, msg.sender)) revert AlreadyApproved();
        // TransactionApproved is emitted on the next line.
        // forge-lint: disable-next-line(missing-events-access-control)
        _approvals[txHash][msg.sender] = ownerEpoch[msg.sender] + 1;
        emit TransactionApproved(txHash, msg.sender);
        if (t.approvedAt == 0 && _countValidApprovals(txHash) >= threshold) {
            _startClock(txHash, t);
        }
    }

    function _startClock(bytes32 txHash, Transaction storage t) private {
        // Casting to uint64 is safe: block timestamps stay below 2^64 for billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        t.approvedAt = uint64(block.timestamp);
        emit ThresholdReached(txHash, t.approvedAt, t.approvedAt + t.executionDelay);
    }

    function _cancel(bytes32 txHash, Transaction storage t) private {
        if (t.executed) revert TransactionAlreadyExecuted();
        if (t.cancelled) revert TransactionAlreadyCancelled();
        t.cancelled = true;
        emit TransactionCancelled(txHash, msg.sender);
    }

    function _hasValidApproval(bytes32 txHash, address owner) private view returns (bool) {
        return isOwner[owner] && _approvals[txHash][owner] == ownerEpoch[owner] + 1;
    }

    function _countValidApprovals(bytes32 txHash) private view returns (uint256 n) {
        uint256 len = _owners.length;
        for (uint256 i = 0; i < len; i++) {
            if (_approvals[txHash][_owners[i]] == ownerEpoch[_owners[i]] + 1) n++;
        }
    }

    function _boundedReturnData() private pure returns (bytes memory ret) {
        uint256 size;
        assembly {
            size := returndatasize()
        }
        if (size > MAX_RETURNDATA) size = MAX_RETURNDATA;
        ret = new bytes(size);
        assembly {
            returndatacopy(add(ret, 0x20), 0, size)
        }
    }
}
