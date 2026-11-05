// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../amm/interfaces/IWQUAI.sol";
import "../staking/interfaces/IQuaiYieldStrategy.sol";

/// @dev Test strategy whose actual WQUAI balance is its valuation. Donations model yield; loss() models impairment.
contract MockQuaiYieldStrategy is IQuaiYieldStrategy {
    using SafeERC20 for IWQUAI;

    IWQUAI public immutable WQUAI;

    constructor(IWQUAI wquai_) {
        WQUAI = wquai_;
    }

    function totalAssets() external view returns (uint256) {
        return WQUAI.balanceOf(address(this));
    }

    function deposit(uint256 assets) external {
        WQUAI.safeTransferFrom(msg.sender, address(this), assets);
    }

    function withdraw(uint256 assets) external returns (uint256 received) {
        uint256 balance = WQUAI.balanceOf(address(this));
        received = assets < balance ? assets : balance;
        if (received != 0) WQUAI.safeTransfer(msg.sender, received);
    }

    function loss(address to, uint256 assets) external {
        WQUAI.safeTransfer(to, assets);
    }
}
