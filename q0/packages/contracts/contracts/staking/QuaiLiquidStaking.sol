// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../amm/interfaces/IWQUAI.sol";
import "./interfaces/IQuaiYieldStrategy.sol";
import "./StQuai.sol";

/// @title QUAI liquid staking vault
/// @notice Accepts native QUAI or WQUAI, issues stQUAI shares, and settles fixed-value native-QUAI withdrawal claims.
/// @dev This is a DeFi yield vault, not validator staking. The immutable strategy defines the source and risk of yield.
///      The deployment seed is minted to the dead address and cannot be redeemed. There is no admin asset-recovery function.
contract QuaiLiquidStaking is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IWQUAI;

    uint256 public constant MINIMUM_SEED = 1e12;
    address public constant SEED_RECEIVER = 0x000000000000000000000000000000000000dEaD;

    IWQUAI public immutable WQUAI;
    IQuaiYieldStrategy public immutable strategy;
    StQuai public immutable stQUAI;
    uint64 public immutable withdrawalDelay;

    struct WithdrawalRequest {
        address receiver;
        uint256 assets;
        uint64 claimableAt;
        bool processed;
        bool claimed;
    }

    WithdrawalRequest[] public withdrawalRequests;
    uint256 public processCursor;
    uint256 public claimLiabilities;
    uint256 public processedLiabilities;

    event Deposited(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event WithdrawalRequested(uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares, uint256 assets, uint64 claimableAt);
    event WithdrawalsProcessed(uint256 indexed throughRequestId, uint256 requestedLiquidity, uint256 receivedLiquidity);
    event WithdrawalClaimed(uint256 indexed requestId, address indexed receiver, uint256 assets);
    event StrategyInvested(uint256 assets);
    event StrategyDivested(uint256 requestedAssets, uint256 receivedAssets);

    error InvalidAddress();
    error InvalidDelay();
    error SeedTooSmall();
    error Expired();
    error ZeroAmount();
    error InsufficientShares();
    error InsufficientAssets();
    error VaultHasNoShareAssets();
    error InvalidRequest();
    error ClaimNotReady();
    error RequestAlreadyClaimed();
    error InsufficientIdleAssets();
    error NativeSenderNotWquai();

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    constructor(IWQUAI wquai_, IQuaiYieldStrategy strategy_, uint64 withdrawalDelay_, address initialOwner)
        payable
        Ownable(initialOwner)
    {
        if (address(wquai_).code.length == 0 || address(strategy_).code.length == 0 || initialOwner == address(0)) {
            revert InvalidAddress();
        }
        if (address(wquai_) == address(strategy_)) revert InvalidAddress();
        if (withdrawalDelay_ == 0) revert InvalidDelay();
        if (msg.value < MINIMUM_SEED) revert SeedTooSmall();

        WQUAI = wquai_;
        strategy = strategy_;
        withdrawalDelay = withdrawalDelay_;
        stQUAI = new StQuai(address(this));

        wquai_.deposit{value: msg.value}();
        stQUAI.mint(SEED_RECEIVER, msg.value);
    }

    /// @dev Native QUAI is accepted by depositNative or as the result of WQUAI.withdraw only.
    receive() external payable {
        if (msg.sender != address(WQUAI)) revert NativeSenderNotWquai();
    }

    function withdrawalRequestCount() external view returns (uint256) {
        return withdrawalRequests.length;
    }

    /// @notice Assets backing outstanding stQUAI shares; fixed claims are excluded.
    function totalManagedAssets() public view returns (uint256) {
        uint256 gross = WQUAI.balanceOf(address(this)) + strategy.totalAssets();
        uint256 claims = claimLiabilities;
        return gross > claims ? gross - claims : 0;
    }

    function previewDeposit(uint256 assets) public view returns (uint256 shares) {
        if (assets == 0) return 0;
        uint256 managed = totalManagedAssets();
        // slither-disable-next-line incorrect-equality
        if (managed == 0) return 0;
        uint256 supply = stQUAI.totalSupply();
        return Math.mulDiv(assets, supply + 1, managed + 1, Math.Rounding.Floor);
    }

    function previewRedeem(uint256 shares) public view returns (uint256 assets) {
        if (shares == 0) return 0;
        uint256 managed = totalManagedAssets();
        uint256 supply = stQUAI.totalSupply();
        // slither-disable-next-line incorrect-equality
        if (managed == 0 || supply == 0) return 0;
        return Math.mulDiv(shares, managed + 1, supply + 1, Math.Rounding.Floor);
    }

    function depositNative(uint256 minShares, uint256 deadline)
        external
        payable
        nonReentrant
        whenNotPaused
        ensure(deadline)
        returns (uint256 shares)
    {
        if (msg.value == 0) revert ZeroAmount();
        shares = previewDeposit(msg.value);
        // slither-disable-next-line incorrect-equality
        if (shares == 0) revert InsufficientShares();
        if (shares < minShares) revert InsufficientShares();
        WQUAI.deposit{value: msg.value}();
        stQUAI.mint(msg.sender, shares);
        emit Deposited(msg.sender, msg.sender, msg.value, shares);
    }

    function depositWquai(uint256 assets, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        ensure(deadline)
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        shares = previewDeposit(assets);
        // slither-disable-next-line incorrect-equality
        if (shares == 0) revert InsufficientShares();
        if (shares < minShares) revert InsufficientShares();
        WQUAI.safeTransferFrom(msg.sender, address(this), assets);
        stQUAI.mint(msg.sender, shares);
        emit Deposited(msg.sender, msg.sender, assets, shares);
    }

    /// @notice Burns stQUAI immediately and fixes the claim's QUAI value at the current share rate.
    function requestWithdrawal(uint256 shares, uint256 minAssets, address receiver)
        external
        nonReentrant
        returns (uint256 requestId, uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0) || receiver == address(this)) revert InvalidAddress();
        // slither-disable-next-line incorrect-equality
        if (totalManagedAssets() == 0) revert VaultHasNoShareAssets();
        assets = previewRedeem(shares);
        // slither-disable-next-line incorrect-equality
        if (assets == 0 || assets < minAssets) revert InsufficientAssets();

        requestId = withdrawalRequests.length;
        uint64 claimableAt = uint64(block.timestamp + withdrawalDelay);
        withdrawalRequests.push(WithdrawalRequest({
            receiver: receiver,
            assets: assets,
            claimableAt: claimableAt,
            processed: false,
            claimed: false
        }));
        claimLiabilities += assets;
        stQUAI.burn(msg.sender, shares);
        emit WithdrawalRequested(requestId, msg.sender, receiver, shares, assets, claimableAt);
    }

    /// @notice Marks due requests for liquidity processing and pulls any aggregate shortfall from the strategy.
    /// @dev Claims can still be paid before processing when the vault already has enough idle WQUAI.
    function processWithdrawals(uint256 maxRequests) external nonReentrant {
        uint256 cursor = processCursor;
        uint256 length = withdrawalRequests.length;
        uint256 end = cursor + maxRequests;
        if (end > length || end < cursor) end = length;

        uint256 newlyProcessed = 0;
        uint256 i = cursor;
        while (i < end) {
            WithdrawalRequest storage request = withdrawalRequests[i];
            if (request.claimed) {
                i++;
                continue;
            }
            if (request.claimableAt > block.timestamp) break;
            if (!request.processed) {
                request.processed = true;
                newlyProcessed += request.assets;
            }
            i++;
        }
        processCursor = i;
        if (newlyProcessed != 0) processedLiabilities += newlyProcessed;

        uint256 idle = WQUAI.balanceOf(address(this));
        uint256 required = processedLiabilities;
        uint256 received = 0;
        if (idle < required) {
            received = strategy.withdraw(required - idle);
        }
        emit WithdrawalsProcessed(i == 0 ? 0 : i - 1, required > idle ? required - idle : 0, received);
    }

    /// @notice Anyone may trigger payment, but native QUAI always goes to the request's immutable receiver.
    function claimWithdrawal(uint256 requestId) external nonReentrant returns (uint256 assets) {
        if (requestId >= withdrawalRequests.length) revert InvalidRequest();
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        if (request.claimed) revert RequestAlreadyClaimed();
        if (request.claimableAt > block.timestamp) revert ClaimNotReady();

        assets = request.assets;
        request.claimed = true;
        claimLiabilities -= assets;
        if (request.processed) processedLiabilities -= assets;

        WQUAI.withdraw(assets);
        Address.sendValue(payable(request.receiver), assets);
        emit WithdrawalClaimed(requestId, request.receiver, assets);
    }

    /// @notice Moves idle share-backing WQUAI into the immutable strategy without risking processed claim liquidity.
    function invest(uint256 assets) external onlyOwner nonReentrant whenNotPaused {
        if (assets == 0) revert ZeroAmount();
        uint256 idle = WQUAI.balanceOf(address(this));
        if (assets > idle || idle - assets < processedLiabilities) revert InsufficientIdleAssets();
        WQUAI.forceApprove(address(strategy), assets);
        strategy.deposit(assets);
        WQUAI.forceApprove(address(strategy), 0);
        emit StrategyInvested(assets);
    }

    /// @notice Returns WQUAI from the strategy to the idle buffer. Withdrawal processing uses the same path.
    function divest(uint256 assets) external onlyOwner nonReentrant returns (uint256 received) {
        if (assets == 0) revert ZeroAmount();
        received = strategy.withdraw(assets);
        emit StrategyDivested(assets, received);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
