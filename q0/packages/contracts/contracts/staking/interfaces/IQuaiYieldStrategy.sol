// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice WQUAI-denominated yield strategy used by QuaiLiquidStaking.
/// @dev Implementations must hold only assets attributable to the calling vault and report their current redeemable value.
interface IQuaiYieldStrategy {
    function totalAssets() external view returns (uint256 assets);

    /// @dev Pulls exactly `assets` WQUAI from the vault after its explicit approval.
    function deposit(uint256 assets) external;

    /// @dev Transfers up to `assets` WQUAI to the vault and returns the amount actually delivered.
    function withdraw(uint256 assets) external returns (uint256 received);
}
