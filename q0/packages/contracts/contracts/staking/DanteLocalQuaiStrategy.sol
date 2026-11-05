// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../amm/interfaces/IWQUAI.sol";
import "./interfaces/IQuaiYieldStrategy.sol";

interface IDanteLocalVault {
    function WQUAI() external view returns (IWQUAI);
    function strategy() external view returns (IQuaiYieldStrategy);
}

/// @title Dante localhost QUAI strategy
/// @notice Development-only WQUAI strategy whose facilitator funds fully backed, explicitly simulated yield.
/// @dev The chain-ID guard prevents deployment outside Hardhat's default localhost chain. This contract does not
///      generate yield, connect to a validator, or claim to be audited. Dante can add assets but cannot remove them.
contract DanteLocalQuaiStrategy is IQuaiYieldStrategy {
    using SafeERC20 for IWQUAI;

    uint256 public constant LOCAL_CHAIN_ID = 31_337;

    IWQUAI public immutable WQUAI;
    address public immutable DANTE;
    address public vault;

    event VaultBound(address indexed vault);
    event NativeYieldFunded(address indexed facilitator, uint256 assets);
    event WquaiYieldFunded(address indexed facilitator, uint256 assets);

    error LocalhostOnly();
    error InvalidAddress();
    error InvalidVault();
    error VaultAlreadyBound();
    error OnlyDante();
    error OnlyVault();
    error ZeroAmount();

    modifier onlyDante() {
        if (msg.sender != DANTE) revert OnlyDante();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(IWQUAI wquai_, address dante_) {
        if (block.chainid != LOCAL_CHAIN_ID) revert LocalhostOnly();
        if (address(wquai_).code.length == 0 || dante_ == address(0)) revert InvalidAddress();
        WQUAI = wquai_;
        DANTE = dante_;
    }

    /// @notice Permanently binds the strategy to a vault that declares both this strategy and the same WQUAI token.
    function bindVault(address vault_) external onlyDante {
        if (vault != address(0)) revert VaultAlreadyBound();
        if (vault_ == address(0) || vault_.code.length == 0) revert InvalidAddress();
        if (IDanteLocalVault(vault_).WQUAI() != WQUAI || IDanteLocalVault(vault_).strategy() != IQuaiYieldStrategy(address(this))) {
            revert InvalidVault();
        }
        vault = vault_;
        emit VaultBound(vault_);
    }

    /// @notice Reports only WQUAI actually held by the strategy; no virtual or unbacked yield is included.
    function totalAssets() external view returns (uint256) {
        return WQUAI.balanceOf(address(this));
    }

    /// @dev Pulls exactly `assets` WQUAI from the bound vault after its explicit approval.
    function deposit(uint256 assets) external onlyVault {
        WQUAI.safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @dev Delivers up to `assets` WQUAI exclusively to the bound vault.
    function withdraw(uint256 assets) external onlyVault returns (uint256 received) {
        uint256 balance = WQUAI.balanceOf(address(this));
        received = assets < balance ? assets : balance;
        if (received != 0) WQUAI.safeTransfer(msg.sender, received);
    }

    /// @notice Wraps Dante's native QUAI into WQUAI and credits it as explicitly simulated, fully backed yield.
    function fundNativeYield() external payable onlyDante {
        if (msg.value == 0) revert ZeroAmount();
        WQUAI.deposit{value: msg.value}();
        emit NativeYieldFunded(DANTE, msg.value);
    }

    /// @notice Transfers Dante's WQUAI into the strategy as explicitly simulated, fully backed yield.
    function fundWquaiYield(uint256 assets) external onlyDante {
        if (assets == 0) revert ZeroAmount();
        WQUAI.safeTransferFrom(DANTE, address(this), assets);
        emit WquaiYieldFunded(DANTE, assets);
    }
}
