// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../amm/interfaces/IWQUAI.sol";
import "./interfaces/IQuaiYieldStrategy.sol";

interface IDanteVault {
    function WQUAI() external view returns (IWQUAI);
    function strategy() external view returns (IQuaiYieldStrategy);
}

/// @title Dante QUAI revenue strategy
/// @notice Non-upgradeable WQUAI strategy for QuaiLiquidStaking, with revenue supplied by a designated facilitator.
/// @dev There is no endogenous APY: share value increases only when actual WQUAI enters this contract. Neither the
///      owner nor the facilitator can withdraw WQUAI. Only the permanently bound vault can invest or divest it.
///      Production deployment requires reviewed WQUAI, owner, facilitator and vault configuration and a security audit.
contract DanteQuaiStrategy is IQuaiYieldStrategy, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IWQUAI;

    IWQUAI public immutable WQUAI;
    address public facilitator;
    address public vault;

    event FacilitatorUpdated(address indexed previousFacilitator, address indexed newFacilitator);
    event VaultBound(address indexed vault);
    event NativeRevenueFunded(address indexed facilitator, uint256 assets);
    event WquaiRevenueFunded(address indexed facilitator, uint256 assets);

    error InvalidAddress();
    error InvalidVault();
    error VaultAlreadyBound();
    error OnlyFacilitator();
    error OnlyVault();
    error ZeroAmount();
    error AssetIsVaultAsset();
    error UnexpectedNativeTransfer();

    modifier onlyFacilitator() {
        if (msg.sender != facilitator) revert OnlyFacilitator();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(IWQUAI wquai_, address initialOwner_, address facilitator_) Ownable(initialOwner_) {
        if (address(wquai_).code.length == 0 || facilitator_ == address(0)) revert InvalidAddress();
        WQUAI = wquai_;
        facilitator = facilitator_;
        emit FacilitatorUpdated(address(0), facilitator_);
    }

    /// @notice Changes the revenue facilitator. Administration should use a reviewed multisig in production.
    function setFacilitator(address facilitator_) external onlyOwner {
        if (facilitator_ == address(0)) revert InvalidAddress();
        address previous = facilitator;
        facilitator = facilitator_;
        emit FacilitatorUpdated(previous, facilitator_);
    }

    /// @notice Permanently binds a vault declaring both this strategy and the same WQUAI token.
    function bindVault(address vault_) external onlyOwner {
        if (vault != address(0)) revert VaultAlreadyBound();
        if (vault_ == address(0) || vault_.code.length == 0) revert InvalidAddress();
        if (IDanteVault(vault_).WQUAI() != WQUAI || IDanteVault(vault_).strategy() != IQuaiYieldStrategy(address(this))) {
            revert InvalidVault();
        }
        vault = vault_;
        emit VaultBound(vault_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Reports actual WQUAI held, including revenue and any direct donations attributable to the vault.
    function totalAssets() external view returns (uint256) {
        return WQUAI.balanceOf(address(this));
    }

    /// @dev Pulls exactly `assets` WQUAI from the bound vault after its explicit, transaction-scoped approval.
    function deposit(uint256 assets) external onlyVault nonReentrant whenNotPaused {
        WQUAI.safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @dev Delivers up to `assets` WQUAI exclusively to the bound vault. Pausing never blocks exits.
    function withdraw(uint256 assets) external onlyVault nonReentrant returns (uint256 received) {
        uint256 balance = WQUAI.balanceOf(address(this));
        received = assets < balance ? assets : balance;
        if (received != 0) WQUAI.safeTransfer(msg.sender, received);
    }

    /// @notice Wraps actual native QUAI revenue into WQUAI, increasing the vault's fully backed asset value.
    function fundNativeRevenue() external payable onlyFacilitator nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        WQUAI.deposit{value: msg.value}();
        emit NativeRevenueFunded(msg.sender, msg.value);
    }

    /// @notice Supplies actual WQUAI revenue, increasing the vault's fully backed asset value.
    function fundWquaiRevenue(uint256 assets) external onlyFacilitator nonReentrant whenNotPaused {
        if (assets == 0) revert ZeroAmount();
        WQUAI.safeTransferFrom(msg.sender, address(this), assets);
        emit WquaiRevenueFunded(msg.sender, assets);
    }

    /// @notice Recovers tokens other than WQUAI sent here accidentally. Vault assets can never be rescued.
    function rescueToken(IERC20 token, address to, uint256 assets) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (address(token) == address(WQUAI)) revert AssetIsVaultAsset();
        token.safeTransfer(to, assets);
    }

    receive() external payable {
        revert UnexpectedNativeTransfer();
    }
}
