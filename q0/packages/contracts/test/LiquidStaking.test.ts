import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { DEAD, E18, deadline } from "./ammHelpers";

const DAY = 24n * 60n * 60n;
const SEED = 1_000_000_000_000n;

describe("QuaiLiquidStaking", function () {
  async function fixture() {
    const [owner, alice, bob, keeper] = await ethers.getSigners();
    const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
    const strategy = await (await ethers.getContractFactory("MockQuaiYieldStrategy")).deploy(await wquai.getAddress());
    const vault = await (await ethers.getContractFactory("QuaiLiquidStaking")).deploy(
      await wquai.getAddress(),
      await strategy.getAddress(),
      DAY,
      owner.address,
      { value: SEED }
    );
    const token = await ethers.getContractAt("StQuai", await vault.stQUAI());
    return { owner, alice, bob, keeper, wquai, strategy, vault, token };
  }

  it("locks a real deployment seed and exposes immutable dependencies", async function () {
    const { owner, wquai, strategy, vault, token } = await loadFixture(fixture);
    expect(await token.balanceOf(DEAD)).to.equal(SEED);
    expect(await token.totalSupply()).to.equal(SEED);
    expect(await token.vault()).to.equal(await vault.getAddress());
    expect(await vault.WQUAI()).to.equal(await wquai.getAddress());
    expect(await vault.strategy()).to.equal(await strategy.getAddress());
    expect(await vault.withdrawalDelay()).to.equal(DAY);
    expect(await vault.owner()).to.equal(owner.address);
    expect(await wquai.balanceOf(await vault.getAddress())).to.equal(SEED);
  });

  it("mints proportional shares for native and WQUAI deposits", async function () {
    const { alice, bob, wquai, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 10n * E18 });
    const aliceShares = await token.balanceOf(alice.address);
    expect(aliceShares).to.be.closeTo(10n * E18, 2n);

    await wquai.connect(bob).deposit({ value: 5n * E18 });
    await wquai.connect(bob).approve(await vault.getAddress(), 5n * E18);
    await vault.connect(bob).depositWquai(5n * E18, 0, await deadline());
    expect(await token.balanceOf(bob.address)).to.be.closeTo(5n * E18, 3n);
    expect(await vault.totalManagedAssets()).to.equal(SEED + 15n * E18);
  });

  it("enforces deposit limits and deadlines", async function () {
    const { alice, vault } = await loadFixture(fixture);
    await expect(vault.connect(alice).depositNative(0, await deadline(), { value: 0 })).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(alice).depositNative(11n * E18, await deadline(), { value: 10n * E18 })).to.be.revertedWithCustomError(vault, "InsufficientShares");
    await expect(vault.connect(alice).depositNative(0, 1, { value: E18 })).to.be.revertedWithCustomError(vault, "Expired");
  });

  it("raises and lowers redemption value with actual strategy yield and loss", async function () {
    const { owner, alice, wquai, strategy, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 100n * E18 });
    await vault.invest(90n * E18);
    const shares = await token.balanceOf(alice.address);
    const before = await vault.previewRedeem(shares);

    await wquai.deposit({ value: 10n * E18 });
    await wquai.transfer(await strategy.getAddress(), 10n * E18);
    expect(await vault.previewRedeem(shares)).to.be.gt(before);

    const afterYield = await vault.previewRedeem(shares);
    await strategy.loss(owner.address, 30n * E18);
    expect(await vault.previewRedeem(shares)).to.be.lt(afterYield);
  });

  it("requests, processes, and pays a fixed native-QUAI claim to its receiver", async function () {
    const { alice, bob, keeper, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 25n * E18 });
    const shares = await token.balanceOf(alice.address);
    const assets = await vault.previewRedeem(shares);
    const before = await ethers.provider.getBalance(bob.address);

    await expect(vault.connect(alice).requestWithdrawal(shares, assets, bob.address))
      .to.emit(vault, "WithdrawalRequested");
    const requested = await vault.withdrawalRequests(0);
    expect(requested.receiver).to.equal(bob.address);
    expect(requested.assets).to.equal(assets);
    expect(requested.claimableAt).to.equal(BigInt(await time.latest()) + DAY);
    expect(await token.balanceOf(alice.address)).to.equal(0n);
    expect(await vault.claimLiabilities()).to.equal(assets);

    await time.increase(DAY);
    await vault.connect(keeper).processWithdrawals(10);
    const request = await vault.withdrawalRequests(0);
    expect(request.processed).to.equal(true);

    await expect(vault.connect(keeper).claimWithdrawal(0))
      .to.emit(vault, "WithdrawalClaimed").withArgs(0n, bob.address, assets);
    expect(await ethers.provider.getBalance(bob.address) - before).to.equal(assets);
    expect(await vault.claimLiabilities()).to.equal(0n);
    expect((await vault.withdrawalRequests(0)).claimed).to.equal(true);
    await expect(vault.claimWithdrawal(0)).to.be.revertedWithCustomError(vault, "RequestAlreadyClaimed");
  });

  it("enforces cooldown and minimum assets", async function () {
    const { alice, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: E18 });
    const shares = await token.balanceOf(alice.address);
    await expect(vault.connect(alice).requestWithdrawal(shares, 2n * E18, alice.address)).to.be.revertedWithCustomError(vault, "InsufficientAssets");
    await vault.connect(alice).requestWithdrawal(shares, 0, alice.address);
    await expect(vault.claimWithdrawal(0)).to.be.revertedWithCustomError(vault, "ClaimNotReady");
  });

  it("pays a due claim directly when idle liquidity is sufficient", async function () {
    const { alice, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: E18 });
    await vault.connect(alice).requestWithdrawal(await token.balanceOf(alice.address), 0, alice.address);
    await time.increase(DAY);
    await vault.claimWithdrawal(0);
    expect((await vault.withdrawalRequests(0)).claimed).to.equal(true);
    expect((await vault.withdrawalRequests(0)).processed).to.equal(false);
  });

  it("pulls processed claim liquidity from the strategy", async function () {
    const { alice, strategy, wquai, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 100n * E18 });
    await vault.invest(95n * E18);
    await vault.connect(alice).requestWithdrawal(await token.balanceOf(alice.address), 0, alice.address);
    await time.increase(DAY);
    const idleBefore = await wquai.balanceOf(await vault.getAddress());
    await vault.processWithdrawals(1);
    const idleAfter = await wquai.balanceOf(await vault.getAddress());
    expect(idleAfter).to.be.gt(idleBefore);
    expect(idleAfter).to.equal(await vault.processedLiabilities());
    expect(await strategy.totalAssets()).to.equal(95n * E18 - (idleAfter - idleBefore));
    await vault.claimWithdrawal(0);
  });

  it("does not revalue fixed claims through later yield or loss", async function () {
    const { owner, alice, wquai, strategy, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 100n * E18 });
    await vault.invest(90n * E18);
    await vault.connect(alice).requestWithdrawal(await token.balanceOf(alice.address), 0, alice.address);
    const assets = (await vault.withdrawalRequests(0)).assets;

    await wquai.deposit({ value: 20n * E18 });
    await wquai.transfer(await strategy.getAddress(), 20n * E18);
    await strategy.loss(owner.address, 10n * E18);
    expect((await vault.withdrawalRequests(0)).assets).to.equal(assets);
  });

  it("bounds processing work and skips already claimed requests", async function () {
    const { alice, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 10n * E18 });
    const shares = await token.balanceOf(alice.address);
    await vault.connect(alice).requestWithdrawal(shares / 3n, 0, alice.address);
    await vault.connect(alice).requestWithdrawal(shares / 3n, 0, alice.address);
    await vault.connect(alice).requestWithdrawal(await token.balanceOf(alice.address), 0, alice.address);
    await time.increase(DAY);
    await vault.processWithdrawals(1);
    expect(await vault.processCursor()).to.equal(1n);
    expect((await vault.withdrawalRequests(0)).processed).to.equal(true);
    expect((await vault.withdrawalRequests(1)).processed).to.equal(false);
    await vault.claimWithdrawal(0);
    await vault.processWithdrawals(2);
    expect(await vault.processCursor()).to.equal(3n);
  });

  it("pause blocks new funds but never blocks exit or funded claims", async function () {
    const { alice, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 10n * E18 });
    await vault.pause();
    await expect(vault.connect(alice).depositNative(0, await deadline(), { value: E18 })).to.be.revertedWithCustomError(vault, "EnforcedPause");
    await expect(vault.invest(E18)).to.be.revertedWithCustomError(vault, "EnforcedPause");
    await vault.connect(alice).requestWithdrawal(await token.balanceOf(alice.address), 0, alice.address);
    await time.increase(DAY);
    await vault.processWithdrawals(1);
    await vault.claimWithdrawal(0);
  });

  it("restricts administration and receipt-token minting", async function () {
    const { alice, vault, token } = await loadFixture(fixture);
    await expect(vault.connect(alice).invest(E18)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await expect(vault.connect(alice).divest(E18)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await expect(vault.connect(alice).pause()).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await expect(token.connect(alice).mint(alice.address, E18)).to.be.revertedWithCustomError(token, "OnlyVault");
    await expect(token.connect(alice).burn(alice.address, E18)).to.be.revertedWithCustomError(token, "OnlyVault");
  });

  it("rejects unexpected native transfers", async function () {
    const { alice, vault } = await loadFixture(fixture);
    await expect(alice.sendTransaction({ to: await vault.getAddress(), value: E18 })).to.be.revertedWithCustomError(vault, "NativeSenderNotWquai");
  });
});
