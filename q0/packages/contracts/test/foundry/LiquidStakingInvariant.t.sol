// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../contracts/staking/QuaiLiquidStaking.sol";
import "../../contracts/staking/StQuai.sol";
import "../../contracts/mocks/MockQuaiYieldStrategy.sol";
import "../../contracts/mocks/AmmMocks.sol";

contract LiquidStakingHandler is Test {
    uint256 internal constant DELAY = 1 days;
    QuaiLiquidStaking internal immutable vault;
    StQuai internal immutable token;
    MockWQUAI internal immutable wquai;
    MockQuaiYieldStrategy internal immutable strategy;
    address internal immutable owner;
    address internal immutable user = makeAddr("invariant-user");

    constructor(QuaiLiquidStaking vault_, MockWQUAI wquai_, MockQuaiYieldStrategy strategy_, address owner_) {
        vault = vault_;
        token = vault_.stQUAI();
        wquai = wquai_;
        strategy = strategy_;
        owner = owner_;
    }

    function deposit(uint256 assets, uint256 warpBy) external {
        assets = bound(assets, 1e6, 1_000 ether);
        vm.deal(user, user.balance + assets);
        vm.prank(user);
        vault.depositNative{value: assets}(0, block.timestamp);
        vm.warp(block.timestamp + bound(warpBy, 0, 2 days));
    }

    function request(uint256 shares) external {
        uint256 balance = token.balanceOf(user);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        if (vault.previewRedeem(shares) == 0) return;
        vm.prank(user);
        vault.requestWithdrawal(shares, 0, user);
    }

    function process(uint256 maxRequests, uint256 warpBy) external {
        vm.warp(block.timestamp + bound(warpBy, 0, 2 days));
        vault.processWithdrawals(bound(maxRequests, 0, 50));
    }

    function claimLatest(uint256 warpBy) external {
        vm.warp(block.timestamp + bound(warpBy, 0, 2 days));
        uint256 count = vault.withdrawalRequestCount();
        for (uint256 i = count; i > 0; i--) {
            (,, uint64 claimableAt,, bool claimed) = vault.withdrawalRequests(i - 1);
            if (!claimed && claimableAt <= block.timestamp) {
                vault.processWithdrawals(50);
                vault.claimWithdrawal(i - 1);
                return;
            }
        }
    }

    function invest(uint256 assets) external {
        uint256 idle = wquai.balanceOf(address(vault));
        uint256 reserved = vault.processedLiabilities();
        if (idle <= reserved + 1) return;
        assets = bound(assets, 1, idle - reserved);
        vm.prank(owner);
        vault.invest(assets);
    }

    function divest(uint256 assets) external {
        uint256 invested = strategy.totalAssets();
        if (invested == 0) return;
        assets = bound(assets, 1, invested);
        vm.prank(owner);
        vault.divest(assets);
    }
}

contract LiquidStakingInvariantTest is Test {
    uint256 internal constant SEED = 1e12;
    MockWQUAI internal wquai;
    MockQuaiYieldStrategy internal strategy;
    QuaiLiquidStaking internal vault;
    StQuai internal token;

    function setUp() public {
        wquai = new MockWQUAI();
        strategy = new MockQuaiYieldStrategy(IWQUAI(address(wquai)));
        vault = new QuaiLiquidStaking{value: SEED}(IWQUAI(address(wquai)), strategy, 1 days, address(this));
        token = vault.stQUAI();
        LiquidStakingHandler handler = new LiquidStakingHandler(vault, wquai, strategy, address(this));
        targetContract(address(handler));
    }

    function invariant_claimLiabilitiesAlwaysBacked() public view {
        uint256 gross = wquai.balanceOf(address(vault)) + strategy.totalAssets();
        assertGe(gross, vault.claimLiabilities());
        assertLe(vault.processedLiabilities(), vault.claimLiabilities());
        assertLe(vault.processCursor(), vault.withdrawalRequestCount());
    }

    function invariant_seedAndTokenOwnershipCannotEscape() public view {
        assertGe(token.balanceOf(vault.SEED_RECEIVER()), SEED);
        assertEq(address(token.vault()), address(vault));
        assertEq(address(vault.stQUAI()), address(token));
    }
}
