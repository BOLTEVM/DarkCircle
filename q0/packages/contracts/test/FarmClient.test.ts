import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18, deployAmm, pairOf, seed } from "./ammHelpers";
import { deployQrb } from "./helpers";
import {
  FARM_SELECTORS,
  TOKEN_SELECTORS,
  farmTx,
  erc20Tx,
  readFarmState,
  readUserPositions,
  readPairs,
  checkAddPool,
  checkEmission,
  checkSetPool,
  sharesAfter,
  runwaySeconds,
  FarmReadError,
  type FarmBatch
} from "../../quai-service/src/farm";

// The Farms page and the admin dashboard talk to CircleswapMasterChef through quai-service/farm.ts and nothing
// else. These tests run that code against the real compiled contract, so an encoder or decoder that disagrees
// with Solidity (a wrong selector, a word in the wrong place) fails here and not in a user's wallet.

const RATE_A = 1_000_000_000_000_000n; // 0.001 / s
const RATE_B = 2_000_000_000_000_000n;

describe("farm client (quai-service/farm.ts) against the real CircleswapMasterChef", function () {
  async function fixture() {
    const amm = await deployAmm();
    const { A, B, alice, bob, owner } = amm;
    await seed(amm, alice, A, B, 10_000n * E18, 10_000n * E18);
    const pair = await pairOf(amm.factory, A, B);

    const Mock = await ethers.getContractFactory("MockERC20");
    const [bdelta, q0, single] = [await Mock.deploy("BoltDelta", "BDELTA"), await Mock.deploy("QBOLT", "Q0"), await Mock.deploy("Single", "ONE")];
    const qrb = await deployQrb(owner.address);
    await qrb.mintGenesis(owner.address);
    const chef = await (await ethers.getContractFactory("CircleswapMasterChef")).deploy(
      owner.address, await bdelta.getAddress(), await q0.getAddress(), await qrb.getAddress(), RATE_A, RATE_B
    );
    // the same "batch" function the app uses, backed by the in-process node
    const batch: FarmBatch = calls =>
      Promise.all(calls.map(async c => {
        try { return await ethers.provider.call({ to: c.to, data: c.data }); } catch { return undefined; }
      }));
    return { ...amm, pair, chef, bdelta, q0, single, qrb, batch };
  }

  it("every selector the client embeds is the contract's", async function () {
    const { chef, bdelta, pair } = await loadFixture(fixture);
    for (const [name, selector] of Object.entries(FARM_SELECTORS)) {
      expect(chef.interface.getFunction(name)!.selector, `farm.${name}`).to.equal(selector);
    }
    const erc20 = bdelta.interface;
    for (const name of ["balanceOf", "allowance", "approve", "transfer", "totalSupply", "symbol"] as const) {
      expect(erc20.getFunction(name)!.selector, `erc20.${name}`).to.equal(TOKEN_SELECTORS[name]);
    }
    for (const name of ["token0", "token1", "getReserves"] as const) {
      expect(pair.interface.getFunction(name)!.selector, `pair.${name}`).to.equal(TOKEN_SELECTORS[name]);
    }
  });

  it("every encoder produces exactly the calldata ethers would", async function () {
    const { chef, alice } = await loadFixture(fixture);
    const i = chef.interface;
    const who = alice.address;
    expect(farmTx.deposit(3, 12345n)).to.equal(i.encodeFunctionData("deposit", [3, 12345n]));
    expect(farmTx.withdraw(0, 1n)).to.equal(i.encodeFunctionData("withdraw", [0, 1n]));
    expect(farmTx.harvest(7)).to.equal(i.encodeFunctionData("harvest", [7]));
    expect(farmTx.emergencyWithdraw(2)).to.equal(i.encodeFunctionData("emergencyWithdraw", [2]));
    expect(farmTx.addPool(400n, who)).to.equal(i.encodeFunctionData("addPool", [400n, who]));
    expect(farmTx.setPool(1, 250n)).to.equal(i.encodeFunctionData("setPool", [1, 250n]));
    expect(farmTx.setEmissionRates(5n, 6n)).to.equal(i.encodeFunctionData("setEmissionRates", [5n, 6n]));
    expect(farmTx.pause()).to.equal(i.encodeFunctionData("pause"));
    expect(farmTx.unpause()).to.equal(i.encodeFunctionData("unpause"));
    expect(farmTx.transferOwnership(who)).to.equal(i.encodeFunctionData("transferOwnership", [who]));
    expect(farmTx.acceptOwnership()).to.equal(i.encodeFunctionData("acceptOwnership"));
    expect(farmTx.massUpdatePools()).to.equal(i.encodeFunctionData("massUpdatePools"));
    const erc20 = new ethers.Interface(["function approve(address,uint256)", "function transfer(address,uint256)"]);
    expect(erc20Tx.approve(who, 99n)).to.equal(erc20.encodeFunctionData("approve", [who, 99n]));
    expect(erc20Tx.transfer(who, 99n)).to.equal(erc20.encodeFunctionData("transfer", [who, 99n]));
  });

  it("rejects values that do not fit instead of encoding something else", async function () {
    expect(() => farmTx.deposit(0, -1n)).to.throw();
    expect(() => farmTx.deposit(0, 1n << 256n)).to.throw();
    expect(() => farmTx.addPool(1n, "0x1234")).to.throw(/Not an address/);
  });

  it("reads an empty farm: no pools, nothing staked, owner and rates as set", async function () {
    const { chef, owner, bdelta, q0, qrb, batch } = await loadFixture(fixture);
    const s = await readFarmState(batch, await chef.getAddress());
    expect(s.owner.toLowerCase()).to.equal(owner.address.toLowerCase());
    expect(s.pendingOwner).to.equal(null);
    expect(s.paused).to.equal(false);
    expect(s.rewardTokenA.toLowerCase()).to.equal((await bdelta.getAddress()).toLowerCase());
    expect(s.rewardTokenB.toLowerCase()).to.equal((await q0.getAddress()).toLowerCase());
    expect(s.qrb?.toLowerCase()).to.equal((await qrb.getAddress()).toLowerCase());
    expect(s.rewardAPerSecond).to.equal(RATE_A);
    expect(s.rewardBPerSecond).to.equal(RATE_B);
    expect(s.pools).to.deep.equal([]);
    expect(s.totalAllocPoint).to.equal(0n);
    expect(s.maxAllocPoint).to.equal(await chef.MAX_ALLOC_POINT());
    expect(s.maxEmissionPerSecond).to.equal(await chef.MAX_EMISSION_PER_SECOND());
    expect(s.inventoryA.available).to.equal(0n);
    // the boost the farm can really hand out is what the Qrb contract grants (+50%), not the farm's +100% clamp
    expect(s.maxBoostBps).to.equal(await chef.MAX_BOOST_BPS());
    expect(s.boostBps).to.equal(await qrb.BOOST_BPS());
    expect(s.boostBps).to.be.lessThan(s.maxBoostBps);
  });

  it("an addPool sent with the client's calldata is read back as a pool, with shares and inventory", async function () {
    const { chef, owner, pair, single, bdelta, batch } = await loadFixture(fixture);
    const farm = await chef.getAddress();
    await owner.sendTransaction({ to: farm, data: farmTx.addPool(300n, await pair.getAddress()) });
    await owner.sendTransaction({ to: farm, data: farmTx.addPool(100n, await single.getAddress()) });
    await bdelta.mint(farm, 5_000n * E18);

    const s = await readFarmState(batch, farm);
    expect(s.pools.map(p => p.lpToken)).to.deep.equal([(await pair.getAddress()).toLowerCase(), (await single.getAddress()).toLowerCase()]);
    expect(s.pools.map(p => p.allocPoint)).to.deep.equal([300n, 100n]);
    expect(s.pools.map(p => p.sharePct)).to.deep.equal([75, 25]);
    expect(s.totalAllocPoint).to.equal(400n);
    expect(s.inventoryA.balance).to.equal(5_000n * E18);
    expect(s.inventoryA.available).to.equal(5_000n * E18);
    expect(s.inventoryB.available).to.equal(0n);
  });

  it("positions: staked, pending (boost-free here) and wallet/allowance match the contract exactly", async function () {
    const { chef, owner, pair, bdelta, q0, alice, batch } = await loadFixture(fixture);
    const farm = await chef.getAddress();
    await bdelta.mint(farm, 1_000_000n * E18);
    await q0.mint(farm, 1_000_000n * E18);
    await chef.connect(owner).addPool(100, await pair.getAddress());

    const lp = await pair.balanceOf(alice.address);
    // before approving: allowance 0, wallet = everything
    let state = await readFarmState(batch, farm);
    let [pos] = await readUserPositions(batch, state, alice.address);
    expect(pos.walletBalance).to.equal(lp);
    expect(pos.allowance).to.equal(0n);
    expect(pos.staked).to.equal(0n);

    await alice.sendTransaction({ to: await pair.getAddress(), data: erc20Tx.approve(farm, lp) });
    await alice.sendTransaction({ to: farm, data: farmTx.deposit(0, lp / 2n) });
    await time.increase(3600);

    state = await readFarmState(batch, farm);
    [pos] = await readUserPositions(batch, state, alice.address);
    const [chainA, chainB] = await chef.pendingRewards(0, alice.address);
    expect(pos.staked).to.equal(lp / 2n);
    expect(pos.walletBalance).to.equal(lp - lp / 2n);
    expect(pos.allowance).to.equal(lp - lp / 2n);
    // view calls see the latest block timestamp; allow the one-second step between the two reads
    expect(pos.pendingA).to.be.closeTo(chainA, RATE_A * 2n);
    expect(pos.pendingB).to.be.closeTo(chainB, RATE_B * 2n);
    expect(pos.pendingA).to.be.gt(0n);
    expect(state.pools[0].totalStaked).to.equal(lp / 2n);
  });

  it("a pool that cannot be read is omitted from positions, never reported as zero", async function () {
    const { chef, owner, pair, alice, batch } = await loadFixture(fixture);
    const farm = await chef.getAddress();
    await chef.connect(owner).addPool(100, await pair.getAddress());
    const state = await readFarmState(batch, farm);
    const flaky: FarmBatch = async calls => {
      const out = await batch(calls);
      return out.map((v, i) => (i % 4 === 1 ? undefined : v)); // every pendingRewards read fails
    };
    expect(await readUserPositions(flaky, state, alice.address)).to.deep.equal([]);
  });

  it("refuses a partial farm read", async function () {
    const { chef, batch } = await loadFixture(fixture);
    const broken: FarmBatch = async calls => (await batch(calls)).map((v, i) => (i === 6 ? undefined : v));
    let error: unknown;
    try { await readFarmState(broken, await chef.getAddress()); } catch (e) { error = e; }
    expect(error).to.be.instanceOf(FarmReadError);
    expect((error as FarmReadError).missing).to.include("rewardAPerSecond");
  });

  it("reads pairs: a Circleswap pool has tokens and reserves, a plain token does not", async function () {
    const { pair, single, A, B, batch } = await loadFixture(fixture);
    const info = await readPairs(batch, [await pair.getAddress(), await single.getAddress()]);
    const p = info[(await pair.getAddress()).toLowerCase()];
    expect([p.token0, p.token1].sort()).to.deep.equal([(await A.getAddress()).toLowerCase(), (await B.getAddress()).toLowerCase()].sort());
    expect(p.reserve0).to.equal(10_000n * E18);
    expect(p.totalSupply).to.be.gt(0n);
    const s = info[(await single.getAddress()).toLowerCase()];
    expect(s.token0).to.equal(undefined);
    expect(s.reserve0).to.equal(undefined);
  });

  describe("admin checks agree with what the contract would do", function () {
    it("a duplicate pool is flagged (the contract would accept it, the dashboard must not)", async function () {
      const { chef, owner, pair, batch } = await loadFixture(fixture);
      const farm = await chef.getAddress();
      await chef.connect(owner).addPool(100, await pair.getAddress());
      const state = await readFarmState(batch, farm);
      const checks = checkAddPool({ lpToken: await pair.getAddress(), allocPoint: 50n, farm: state, isContract: true });
      expect(checks.find(c => c.code === "DUPLICATE")?.level).to.equal("error");
      // the contract itself does allow it, which is exactly why the client must catch it
      await expect(chef.connect(owner).addPool(50, await pair.getAddress())).to.not.be.reverted;
    });

    it("the fee-on-transfer warning applies to a single asset, not to the AMM's own LP tokens", async function () {
      const { chef, pair, single, batch } = await loadFixture(fixture);
      const state = await readFarmState(batch, await chef.getAddress());
      const lp = await pair.getAddress();
      const solo = await single.getAddress();
      const info = await readPairs(batch, [lp, solo]);
      const lpChecks = checkAddPool({ lpToken: lp, allocPoint: 100n, farm: state, isContract: true, pair: info[lp.toLowerCase()], isFactoryPool: true });
      const soloChecks = checkAddPool({ lpToken: solo, allocPoint: 100n, farm: state, isContract: true, pair: info[solo.toLowerCase()] });
      expect(lpChecks.map(c => c.code)).to.not.include("NO_FEE_ON_TRANSFER");
      expect(lpChecks.map(c => c.code)).to.include("CIRCLESWAP_POOL");
      expect(soloChecks.map(c => c.code)).to.include("NO_FEE_ON_TRANSFER");
      expect(soloChecks.map(c => c.code)).to.include("SINGLE_ASSET");
    });

    it("an allocation above the contract maximum is flagged and the contract does revert", async function () {
      const { chef, owner, pair, batch } = await loadFixture(fixture);
      const state = await readFarmState(batch, await chef.getAddress());
      const tooHigh = state.maxAllocPoint + 1n;
      expect(checkAddPool({ lpToken: await pair.getAddress(), allocPoint: tooHigh, farm: state, isContract: true }).some(c => c.code === "ALLOC_TOO_HIGH")).to.equal(true);
      await expect(chef.connect(owner).addPool(tooHigh, await pair.getAddress())).to.be.revertedWithCustomError(chef, "ValueTooHigh");
      expect(checkSetPool(0, tooHigh, state).some(c => c.code === "NO_SUCH_POOL")).to.equal(true);
    });

    it("an emission above the maximum is flagged and the contract does revert", async function () {
      const { chef, owner, batch } = await loadFixture(fixture);
      const state = await readFarmState(batch, await chef.getAddress());
      const bad = state.maxEmissionPerSecond + 1n;
      expect(checkEmission({ rateA: bad, rateB: 0n, farm: state }).some(c => c.code === "ABOVE_MAX" && c.level === "error")).to.equal(true);
      await expect(chef.connect(owner).setEmissionRates(bad, 0)).to.be.revertedWithCustomError(chef, "ValueTooHigh");
    });

    it("warns when the inventory cannot cover a week of the new rates, counting the boost", async function () {
      const { chef, bdelta, q0, batch } = await loadFixture(fixture);
      const farm = await chef.getAddress();
      // one day of rate A, nothing of B
      await bdelta.mint(farm, RATE_A * 86_400n);
      const state = await readFarmState(batch, farm);
      expect(runwaySeconds(state.inventoryA.available, RATE_A, state.boostBps)).to.be.lessThan(86_400);
      expect(checkEmission({ rateA: RATE_A, rateB: RATE_B, farm: state }).some(c => c.code === "SHORT_RUNWAY")).to.equal(true);
      void q0;
    });

    it("share previews add up to 100% and show the dilution of existing pools", async function () {
      const { chef, owner, pair, single, batch } = await loadFixture(fixture);
      await chef.connect(owner).addPool(300, await pair.getAddress());
      const state = await readFarmState(batch, await chef.getAddress());
      const after = sharesAfter(state, { pid: null, allocPoint: 100n });
      expect(after.map(a => a.sharePct)).to.deep.equal([75, 25]);
      expect(after.reduce((s, a) => s + a.sharePct, 0)).to.equal(100);
      void single;
    });
  });
});
