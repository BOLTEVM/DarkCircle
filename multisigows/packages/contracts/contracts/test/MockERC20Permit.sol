// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title MockERC20Permit
 * @notice A permit-capable ERC-20 for testing AgentPermitBatcher. Unlike MockERC20 (this
 * directory), it exposes the EIP-2612 `permit`/`nonces`/`DOMAIN_SEPARATOR` surface, matching the
 * shape of real permit-capable tokens in this workspace (Qrb, Circleswap LP — see
 * q0/packages/contracts/contracts/Qrb.sol).
 */
contract MockERC20Permit is ERC20, ERC20Permit {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Permit(name_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
