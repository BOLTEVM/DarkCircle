// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Staked QUAI receipt token
/// @notice A transferable, non-rebasing share of the QuaiLiquidStaking vault.
contract StQuai is ERC20Permit {
    address public immutable vault;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address vault_) ERC20("Staked QUAI", "stQUAI") ERC20Permit("Staked QUAI") {
        if (vault_ == address(0)) revert OnlyVault();
        vault = vault_;
    }

    function mint(address to, uint256 shares) external onlyVault {
        _mint(to, shares);
    }

    function burn(address from, uint256 shares) external onlyVault {
        _burn(from, shares);
    }
}
