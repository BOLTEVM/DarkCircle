// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/staking/DanteLocalQuaiStrategy.sol";
import "../../contracts/mocks/AmmMocks.sol";

contract DanteLocalQuaiStrategyTest is Test {
    function testRefusesDeploymentOutsideHardhatLocalhost() public {
        MockWQUAI wquai = new MockWQUAI();
        vm.chainId(31_338);
        vm.expectRevert(DanteLocalQuaiStrategy.LocalhostOnly.selector);
        new DanteLocalQuaiStrategy(IWQUAI(address(wquai)), address(this));
    }
}
