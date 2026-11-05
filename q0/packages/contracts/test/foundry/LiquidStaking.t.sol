// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/staking/QuaiLiquidStaking.sol";
import "../../contracts/staking/StQuai.sol";
import "../../contracts/mocks/MockQuaiYieldStrategy.sol";
import "../../contracts/mocks/AmmMocks.sol";

contract LiquidStakingFuzzTest is Test {
    uint256 internal constant SEED = 1e12;
    uint64 internal constant DELAY = 1 days;

    MockWQUAI internal wquai;
    MockQuaiYieldStrategy internal strategy;
    QuaiLiquidStaking internal vault;
    StQuai internal token;
    address internal user = makeAddr("user");

    function setUp() public {
        wquai = new MockWQUAI();
        strategy = new MockQuaiYieldStrategy(IWQUAI(address(wquai)));
        vault = new QuaiLiquidStaking{value: SEED}(IWQUAI(address(wquai)), strategy, DELAY, address(this));
        token = vault.stQUAI();
    }

    function testFuzz_nativeDepositMatchesPreview(uint256 assets) public {
        assets = bound(assets, 1e6, 1_000_000 ether);
        uint256 expected = vault.previewDeposit(assets);
        vm.deal(user, assets);
        vm.prank(user);
        uint256 shares = vault.depositNative{value: assets}(expected, block.timestamp);
        assertEq(shares, expected);
        assertEq(token.balanceOf(user), expected);
        assertEq(vault.totalManagedAssets(), SEED + assets);
        assertEq(wquai.balanceOf(address(vault)), SEED + assets);
    }

    function testFuzz_wquaiDepositUsesExactAssets(uint256 assets) public {
        assets = bound(assets, 1e6, 1_000_000 ether);
        vm.deal(user, assets);
        vm.startPrank(user);
        wquai.deposit{value: assets}();
        wquai.approve(address(vault), assets);
        uint256 expected = vault.previewDeposit(assets);
        uint256 shares = vault.depositWquai(assets, expected, block.timestamp);
        vm.stopPrank();
        assertEq(shares, expected);
        assertEq(wquai.balanceOf(user), 0);
        assertEq(wquai.allowance(user, address(vault)), 0);
        assertEq(vault.totalManagedAssets(), SEED + assets);
    }

    function testFuzz_requestProcessClaimPaysFixedValue(uint256 assets, uint256 shareNumerator) public {
        assets = bound(assets, 1e6, 1_000_000 ether);
        shareNumerator = bound(shareNumerator, 1, 100);
        vm.deal(user, assets);
        vm.prank(user);
        uint256 shares = vault.depositNative{value: assets}(0, block.timestamp);
        uint256 burning = shares * shareNumerator / 100;
        vm.assume(burning > 0 && vault.previewRedeem(burning) > 0);

        vm.prank(user);
        (uint256 id, uint256 fixedAssets) = vault.requestWithdrawal(burning, 0, user);
        assertEq(token.balanceOf(user), shares - burning);
        assertEq(vault.claimLiabilities(), fixedAssets);

        vm.warp(block.timestamp + DELAY);
        vault.processWithdrawals(1);
        uint256 before = user.balance;
        uint256 paid = vault.claimWithdrawal(id);
        assertEq(paid, fixedAssets);
        assertEq(user.balance, before + fixedAssets);
        assertEq(vault.claimLiabilities(), 0);
        assertEq(vault.processedLiabilities(), 0);
    }

    function testFuzz_minimumSharesAndAssetsAreEnforced(uint256 assets) public {
        assets = bound(assets, 1e6, 1_000_000 ether);
        uint256 shares = vault.previewDeposit(assets);
        vm.deal(user, assets * 2);
        vm.prank(user);
        vm.expectRevert(QuaiLiquidStaking.InsufficientShares.selector);
        vault.depositNative{value: assets}(shares + 1, block.timestamp);

        vm.prank(user);
        uint256 minted = vault.depositNative{value: assets}(shares, block.timestamp);
        uint256 redeem = vault.previewRedeem(minted);
        vm.prank(user);
        vm.expectRevert(QuaiLiquidStaking.InsufficientAssets.selector);
        vault.requestWithdrawal(minted, redeem + 1, user);
    }
}
