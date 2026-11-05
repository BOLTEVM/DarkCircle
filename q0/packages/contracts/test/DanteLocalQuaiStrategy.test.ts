import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { DEAD, E18, deadline } from "./ammHelpers";

const DAY = 86_400n;
const SEED = 1_000_000_000_000n;

describe("DanteLocalQuaiStrategy", function () {
  async function unboundFixture() {
    const [owner, dante, alice, bob, keeper] = await ethers.getSigners();
    const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
    const strategy = await (await ethers.getContractFactory("DanteLocalQuaiStrategy")).deploy(
      await wquai.getAddress(),
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
    return { owner, dante, alice, bob, keeper, wquai, strategy, vault, token };
  }

  async function fixture() {
    const deployed = await unboundFixture();
    await deployed.strategy.connect(deployed.dante).bindVault(await deployed.vault.getAddress());
    return deployed;
  }

  it("binds once to the matching vault and exposes its local configuration", async function () {
    const { dante, wquai, strategy, vault, token } = await loadFixture(fixture);
    expect(await strategy.LOCAL_CHAIN_ID()).to.equal(31_337n);
    expect(await strategy.WQUAI()).to.equal(await wquai.getAddress());
    expect(await strategy.DANTE()).to.equal(dante.address);
    expect(await strategy.vault()).to.equal(await vault.getAddress());
    expect(await token.balanceOf(DEAD)).to.equal(SEED);
    expect(await strategy.totalAssets()).to.equal(0n);
  });

  it("allows only Dante to bind and never allows rebinding", async function () {
    const { dante, alice, strategy, vault } = await loadFixture(unboundFixture);
    await expect(strategy.connect(alice).bindVault(await vault.getAddress())).to.be.revertedWithCustomError(strategy, "OnlyDante");
    await expect(strategy.connect(dante).bindVault(ethers.ZeroAddress)).to.be.revertedWithCustomError(strategy, "InvalidAddress");
    await expect(strategy.connect(dante).bindVault(alice.address)).to.be.revertedWithCustomError(strategy, "InvalidAddress");
    await strategy.connect(dante).bindVault(await vault.getAddress());
    await expect(strategy.connect(dante).bindVault(await vault.getAddress())).to.be.revertedWithCustomError(strategy, "VaultAlreadyBound");
  });

  it("refuses a vault that names another strategy", async function () {
    const { owner, dante, wquai, strategy } = await loadFixture(unboundFixture);
    const otherStrategy = await (await ethers.getContractFactory("MockQuaiYieldStrategy")).deploy(await wquai.getAddress());
    const wrongVault = await (await ethers.getContractFactory("QuaiLiquidStaking")).deploy(
      await wquai.getAddress(),
      await otherStrategy.getAddress(),
      DAY,
      owner.address,
      { value: SEED }
    );
    await expect(strategy.connect(dante).bindVault(await wrongVault.getAddress())).to.be.revertedWithCustomError(strategy, "InvalidVault");
  });

  it("lets only the bound vault move strategy assets", async function () {
    const { dante, alice, strategy } = await loadFixture(fixture);
    await expect(strategy.connect(alice).deposit(E18)).to.be.revertedWithCustomError(strategy, "OnlyVault");
    await expect(strategy.connect(dante).withdraw(E18)).to.be.revertedWithCustomError(strategy, "OnlyVault");
  });

  it("accepts only Dante's fully backed native and WQUAI yield", async function () {
    const { owner, dante, alice, wquai, strategy, vault } = await loadFixture(fixture);
    await vault.invest(SEED);
    expect(await strategy.totalAssets()).to.equal(SEED);

    await expect(strategy.connect(alice).fundNativeYield({ value: E18 })).to.be.revertedWithCustomError(strategy, "OnlyDante");
    await expect(strategy.connect(dante).fundNativeYield({ value: 0n })).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    await expect(strategy.connect(dante).fundNativeYield({ value: 2n * E18 }))
      .to.emit(strategy, "NativeYieldFunded").withArgs(dante.address, 2n * E18);

    await wquai.connect(dante).deposit({ value: 3n * E18 });
    await wquai.connect(dante).approve(await strategy.getAddress(), 3n * E18);
    await expect(strategy.connect(dante).fundWquaiYield(3n * E18))
      .to.emit(strategy, "WquaiYieldFunded").withArgs(dante.address, 3n * E18);
    await expect(strategy.connect(dante).fundWquaiYield(0n)).to.be.revertedWithCustomError(strategy, "ZeroAmount");

    expect(await strategy.totalAssets()).to.equal(SEED + 5n * E18);
    expect(await wquai.balanceOf(await strategy.getAddress())).to.equal(await strategy.totalAssets());
    expect(await wquai.allowance(dante.address, await strategy.getAddress())).to.equal(0n);
    await expect(strategy.connect(dante).fundWquaiYield(E18)).to.be.reverted;
    expect(await vault.owner()).to.equal(owner.address);
  });

  it("runs deposit, investment, Dante yield, cooldown, processing, and native claim end to end", async function () {
    const { alice, bob, keeper, dante, strategy, vault, token } = await loadFixture(fixture);
    await vault.connect(alice).depositNative(0, await deadline(), { value: 100n * E18 });
    await vault.invest(90n * E18);
    expect(await strategy.totalAssets()).to.equal(90n * E18);

    const shares = await token.balanceOf(alice.address);
    const beforeYield = await vault.previewRedeem(shares);
    await strategy.connect(dante).fundNativeYield({ value: 10n * E18 });
    const assets = await vault.previewRedeem(shares);
    expect(assets).to.be.gt(beforeYield);
    expect(await strategy.totalAssets()).to.equal(100n * E18);

    await vault.connect(alice).requestWithdrawal(shares, assets, bob.address);
    await expect(vault.connect(keeper).claimWithdrawal(0)).to.be.revertedWithCustomError(vault, "ClaimNotReady");
    await time.increase(DAY);
    await vault.connect(keeper).processWithdrawals(1);

    const beforeClaim = await ethers.provider.getBalance(bob.address);
    await vault.connect(keeper).claimWithdrawal(0);
    expect(await ethers.provider.getBalance(bob.address) - beforeClaim).to.equal(assets);
    expect((await vault.withdrawalRequests(0)).claimed).to.equal(true);
  });

});
