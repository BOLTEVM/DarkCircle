import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { DEAD, E18, deadline } from "./ammHelpers";

const DAY = 86_400n;
const SEED = 1_000_000_000_000n;

describe("DanteQuaiStrategy", function () {
  async function unboundFixture() {
    const [owner, dante, alice, bob, keeper, nextFacilitator] = await ethers.getSigners();
    const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
    const strategy = await (await ethers.getContractFactory("DanteQuaiStrategy")).deploy(
      await wquai.getAddress(),
      owner.address,
      dante.address
    );
    const vault = await (await ethers.getContractFactory("QuaiLiquidStaking")).deploy(
      await wquai.getAddress(),
      await strategy.getAddress(),
      DAY,
      owner.address,
      { value: SEED }
    );
    const token = await ethers.getContractAt("StQuai", await vault.stQUAI());
    return { owner, dante, alice, bob, keeper, nextFacilitator, wquai, strategy, vault, token };
  }

  async function fixture() {
    const deployed = await unboundFixture();
    await deployed.strategy.connect(deployed.owner).bindVault(await deployed.vault.getAddress());
    return deployed;
  }

  it("exposes immutable assets, two-step ownership, and the initial facilitator", async function () {
    const { owner, dante, wquai, strategy, vault, token } = await loadFixture(fixture);
    expect(await strategy.WQUAI()).to.equal(await wquai.getAddress());
    expect(await strategy.facilitator()).to.equal(dante.address);
    expect(await strategy.owner()).to.equal(owner.address);
    expect(await strategy.vault()).to.equal(await vault.getAddress());
    expect(await token.balanceOf(DEAD)).to.equal(SEED);
    expect(await strategy.totalAssets()).to.equal(0n);
  });

  it("requires ownership acceptance before administration and rotates the facilitator", async function () {
    const { owner, alice, nextFacilitator, strategy } = await loadFixture(fixture);
    await strategy.connect(owner).transferOwnership(alice.address);
    expect(await strategy.pendingOwner()).to.equal(alice.address);
    await expect(strategy.connect(alice).setFacilitator(nextFacilitator.address)).to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    await strategy.connect(alice).acceptOwnership();
    await expect(strategy.connect(alice).setFacilitator(nextFacilitator.address))
      .to.emit(strategy, "FacilitatorUpdated");
    expect(await strategy.facilitator()).to.equal(nextFacilitator.address);
    await expect(strategy.connect(alice).setFacilitator(ethers.ZeroAddress)).to.be.revertedWithCustomError(strategy, "InvalidAddress");
  });

  it("allows only the owner to bind and never permits rebinding", async function () {
    const { owner, dante, alice, strategy, vault } = await loadFixture(unboundFixture);
    await expect(strategy.connect(dante).bindVault(await vault.getAddress())).to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    await expect(strategy.connect(owner).bindVault(ethers.ZeroAddress)).to.be.revertedWithCustomError(strategy, "InvalidAddress");
    await expect(strategy.connect(owner).bindVault(alice.address)).to.be.revertedWithCustomError(strategy, "InvalidAddress");
    await strategy.connect(owner).bindVault(await vault.getAddress());
    await expect(strategy.connect(owner).bindVault(await vault.getAddress())).to.be.revertedWithCustomError(strategy, "VaultAlreadyBound");
  });

  it("rejects a vault that names another strategy", async function () {
    const { owner, wquai, strategy } = await loadFixture(unboundFixture);
    const other = await (await ethers.getContractFactory("MockQuaiYieldStrategy")).deploy(await wquai.getAddress());
    const wrongVault = await (await ethers.getContractFactory("QuaiLiquidStaking")).deploy(
      await wquai.getAddress(),
      await other.getAddress(),
      DAY,
      owner.address,
      { value: SEED }
    );
    await expect(strategy.connect(owner).bindVault(await wrongVault.getAddress())).to.be.revertedWithCustomError(strategy, "InvalidVault");
  });

  it("restricts asset movement to the vault and never lets rescue touch WQUAI", async function () {
    const { owner, dante, alice, strategy } = await loadFixture(fixture);
    await expect(strategy.connect(alice).deposit(E18)).to.be.revertedWithCustomError(strategy, "OnlyVault");
    await expect(strategy.connect(dante).withdraw(E18)).to.be.revertedWithCustomError(strategy, "OnlyVault");
    await expect(strategy.connect(owner).rescueToken(await strategy.WQUAI(), alice.address, E18))
      .to.be.revertedWithCustomError(strategy, "AssetIsVaultAsset");

    const otherToken = await (await ethers.getContractFactory("MockToken")).deploy("Other", "OTHER", 18);
    await otherToken.mint(await strategy.getAddress(), 5n * E18);
    await expect(strategy.connect(alice).rescueToken(await otherToken.getAddress(), alice.address, E18))
      .to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    await strategy.connect(owner).rescueToken(await otherToken.getAddress(), alice.address, 5n * E18);
    expect(await otherToken.balanceOf(alice.address)).to.equal(5n * E18);
  });

  it("accepts only the facilitator's actual native and WQUAI revenue", async function () {
    const { dante, alice, wquai, strategy, vault } = await loadFixture(fixture);
    await vault.invest(SEED);
    await expect(strategy.connect(alice).fundNativeRevenue({ value: E18 })).to.be.revertedWithCustomError(strategy, "OnlyFacilitator");
    await expect(strategy.connect(dante).fundNativeRevenue({ value: 0n })).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    await expect(strategy.connect(dante).fundNativeRevenue({ value: 2n * E18 }))
      .to.emit(strategy, "NativeRevenueFunded").withArgs(dante.address, 2n * E18);

    await wquai.connect(dante).deposit({ value: 3n * E18 });
    await wquai.connect(dante).approve(await strategy.getAddress(), 3n * E18);
    await expect(strategy.connect(dante).fundWquaiRevenue(3n * E18))
      .to.emit(strategy, "WquaiRevenueFunded").withArgs(dante.address, 3n * E18);
    await expect(strategy.connect(dante).fundWquaiRevenue(0n)).to.be.revertedWithCustomError(strategy, "ZeroAmount");

    expect(await strategy.totalAssets()).to.equal(SEED + 5n * E18);
    expect(await wquai.balanceOf(await strategy.getAddress())).to.equal(await strategy.totalAssets());
    expect(await wquai.allowance(dante.address, await strategy.getAddress())).to.equal(0n);
    await expect(strategy.connect(dante).fundWquaiRevenue(E18)).to.be.reverted;
  });

  it("pauses investment and revenue but never divestment, processing, or claims", async function () {
    const { alice, bob, keeper, strategy, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 100n * E18 });
    await vault.invest(90n * E18);
    await strategy.pause();

    await expect(vault.invest(E18)).to.be.revertedWithCustomError(strategy, "EnforcedPause");
    await expect(strategy.connect(keeper).fundNativeRevenue({ value: E18 })).to.be.revertedWithCustomError(strategy, "OnlyFacilitator");
    await vault.divest(E18);

    const shares = await token.balanceOf(alice.address);
    const assets = await vault.previewRedeem(shares);
    await vault.connect(alice).requestWithdrawal(shares, assets, bob.address);
    await time.increase(DAY);
    await vault.connect(keeper).processWithdrawals(1);
    const before = await ethers.provider.getBalance(bob.address);
    await vault.connect(keeper).claimWithdrawal(0);
    expect(await ethers.provider.getBalance(bob.address) - before).to.equal(assets);
  });

  it("raises redemption value only by the actual funded revenue and pays the fixed claim", async function () {
    const { alice, bob, keeper, dante, strategy, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 100n * E18 });
    await vault.invest(90n * E18);
    const shares = await token.balanceOf(alice.address);
    const beforeRevenue = await vault.previewRedeem(shares);
    await strategy.connect(dante).fundNativeRevenue({ value: 10n * E18 });
    const assets = await vault.previewRedeem(shares);
    expect(assets).to.be.gt(beforeRevenue);
    expect(await strategy.totalAssets()).to.equal(100n * E18);

    await vault.connect(alice).requestWithdrawal(shares, assets, bob.address);
    await time.increase(DAY);
    await vault.connect(keeper).processWithdrawals(1);
    const beforeClaim = await ethers.provider.getBalance(bob.address);
    await vault.connect(keeper).claimWithdrawal(0);
    expect(await ethers.provider.getBalance(bob.address) - beforeClaim).to.equal(assets);
    expect((await vault.withdrawalRequests(0)).claimed).to.equal(true);
  });

  it("rejects unexpected native transfers", async function () {
    const { alice, strategy } = await loadFixture(fixture);
    await expect(alice.sendTransaction({ to: await strategy.getAddress(), value: E18 }))
      .to.be.revertedWithCustomError(strategy, "UnexpectedNativeTransfer");
  });
});
