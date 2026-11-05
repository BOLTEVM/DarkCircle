// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/staking/DanteQuaiStrategy.sol";
import "../../contracts/mocks/AmmMocks.sol";

contract DanteQuaiStrategyTest is Test {
    address internal dante = makeAddr("dante");

    function testDeploysOnQuaiMainnetChainId() public {
        vm.chainId(9);
        MockWQUAI wquai = new MockWQUAI();
        DanteQuaiStrategy strategy = new DanteQuaiStrategy(IWQUAI(address(wquai)), address(this), dante);
        assertEq(address(strategy.WQUAI()), address(wquai));
        assertEq(strategy.facilitator(), dante);
        assertEq(strategy.owner(), address(this));
    }

    function testFuzz_revenueIsFullyBacked(uint256 nativeRevenue, uint256 wquaiRevenue) public {
        nativeRevenue = bound(nativeRevenue, 1, 1_000_000 ether);
        wquaiRevenue = bound(wquaiRevenue, 1, 1_000_000 ether);
        MockWQUAI wquai = new MockWQUAI();
        DanteQuaiStrategy strategy = new DanteQuaiStrategy(IWQUAI(address(wquai)), address(this), dante);
        vm.deal(dante, nativeRevenue + wquaiRevenue);

        vm.startPrank(dante);
        strategy.fundNativeRevenue{value: nativeRevenue}();
        wquai.deposit{value: wquaiRevenue}();
        wquai.approve(address(strategy), wquaiRevenue);
        strategy.fundWquaiRevenue(wquaiRevenue);
        vm.stopPrank();

        assertEq(strategy.totalAssets(), nativeRevenue + wquaiRevenue);
        assertEq(wquai.balanceOf(address(strategy)), strategy.totalAssets());
        assertEq(wquai.allowance(dante, address(strategy)), 0);
    }
}
