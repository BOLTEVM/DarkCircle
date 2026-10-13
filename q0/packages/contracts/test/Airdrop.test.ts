import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { E18 } from "./helpers";
import { planAirdrop, buildDistribution, auditDistribution, type StakePosition } from "../../quai-service/src/airdrop";

// The claim contract and the TypeScript that builds its tree are two implementations of one rule. These tests hold the
// contract to the file the app publishes: every entry of a real distribution must claim, and nothing else may.

const DAY = 24 * 60 * 60;

describe("CircleswapAirdrop", function () {
  async function fixture() {
    const [owner, alice, bob, carol, stranger] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const q0 = await Mock.deploy("QBOLT", "Q0");
    const qaxe = await Mock.deploy("QuaiAxe", "QAXE");
    const other = await Mock.deploy("Other", "OTH");
    const Airdrop = await ethers.getContractFactory("CircleswapAirdrop");
    const airdrop = await Airdrop.deploy(owner.address, await q0.getAddress(), await qaxe.getAddress());
    await airdrop.waitForDeployment();

    // 37 accounts (an odd tree): the first three are signers, the rest are arbitrary addresses.
    const accounts: string[] = [alice.address, bob.address, carol.address];
    for (let i = 0; accounts.length < 37; i++) accounts.push(ethers.getAddress("0x" + (0xa000 + i).toString(16).padStart(40, "0")));
    const positions: StakePosition[] = accounts.map((account, i) => ({
      account,
      held: BigInt(1000 + i * 137) * E18,
      burned: i % 5 === 0 ? BigInt(200 + i) * E18 : 0n
    }));
    const plan = planAirdrop(positions);
    const dist = buildDistribution({
      plan,
      chainId: 9,
      contract: await airdrop.getAddress(),
      tokenA: { address: await q0.getAddress(), symbol: "Q0" },
      tokenB: { address: await qaxe.getAddress(), symbol: "QAXE" },
      snapshotBlock: 1
    });
    return { owner, alice, bob, carol, stranger, q0, qaxe, other, airdrop, plan, dist };
  }

  async function funded() {
    const f = await fixture();
    await f.q0.mint(await f.airdrop.getAddress(), BigInt(f.dist.totalA));
    await f.qaxe.mint(await f.airdrop.getAddress(), BigInt(f.dist.totalB));
    return f;
  }

  async function open() {
    const f = await funded();
    const deadline = (await time.latest()) + 30 * DAY;
    await f.airdrop.setMerkleRoot(f.dist.merkleRoot, f.dist.totalA, f.dist.totalB, deadline);
    return { ...f, deadline };
  }

  const claimArgs = (e: { index: number; account: string; amountA: string; amountB: string; proof: string[] }) =>
    [e.index, e.account, e.amountA, e.amountB, e.proof] as const;

  describe("the file the app publishes", () => {
    it("is internally consistent before it is ever sent to a contract", async () => {
      const { dist } = await loadFixture(fixture);
      expect(auditDistribution(dist)).to.deep.equal([]);
    });
  });

  describe("setMerkleRoot", () => {
    it("opens the window once the contract holds the totals", async () => {
      const { airdrop, dist, owner } = await loadFixture(funded);
      const deadline = (await time.latest()) + 20 * DAY;
      await expect(airdrop.connect(owner).setMerkleRoot(dist.merkleRoot, dist.totalA, dist.totalB, deadline))
        .to.emit(airdrop, "MerkleRootSet")
        .withArgs(dist.merkleRoot, dist.totalA, dist.totalB, deadline);
      expect(await airdrop.merkleRoot()).to.equal(dist.merkleRoot);
      expect(await airdrop.claimDeadline()).to.equal(deadline);
    });

    it("refuses while it is short of either token, saying by how much", async () => {
      const { airdrop, dist, q0, qaxe } = await loadFixture(fixture);
      const deadline = (await time.latest()) + 20 * DAY;
      await q0.mint(await airdrop.getAddress(), BigInt(dist.totalA));
      await expect(airdrop.setMerkleRoot(dist.merkleRoot, dist.totalA, dist.totalB, deadline)).to.be.revertedWithCustomError(airdrop, "NotFunded");
      await qaxe.mint(await airdrop.getAddress(), BigInt(dist.totalB) - 1n);
      await expect(airdrop.setMerkleRoot(dist.merkleRoot, dist.totalA, dist.totalB, deadline)).to.be.revertedWithCustomError(airdrop, "NotFunded");
      await qaxe.mint(await airdrop.getAddress(), 1n);
      await airdrop.setMerkleRoot(dist.merkleRoot, dist.totalA, dist.totalB, deadline);
    });

    it("cannot be set twice, so an allocation cannot move once people can see it", async () => {
      const { airdrop, dist, deadline } = await loadFixture(open);
      await expect(airdrop.setMerkleRoot(ethers.id("another tree"), dist.totalA, dist.totalB, deadline + DAY)).to.be.revertedWithCustomError(airdrop, "RootAlreadySet");
    });

    it("refuses an empty root and a claim window shorter than 14 days", async () => {
      const { airdrop, dist } = await loadFixture(funded);
      const soon = (await time.latest()) + 3 * DAY;
      await expect(airdrop.setMerkleRoot(ethers.ZeroHash, dist.totalA, dist.totalB, soon + 30 * DAY)).to.be.revertedWithCustomError(airdrop, "EmptyRoot");
      await expect(airdrop.setMerkleRoot(dist.merkleRoot, dist.totalA, dist.totalB, soon)).to.be.revertedWithCustomError(airdrop, "DeadlineTooSoon");
    });

    it("is for the owner only", async () => {
      const { airdrop, dist, stranger } = await loadFixture(funded);
      const deadline = (await time.latest()) + 20 * DAY;
      await expect(airdrop.connect(stranger).setMerkleRoot(dist.merkleRoot, dist.totalA, dist.totalB, deadline)).to.be.revertedWithCustomError(airdrop, "OwnableUnauthorizedAccount");
    });
  });

  describe("claim", () => {
    it("pays every entry of the published file exactly what it says, and the contract ends up holding nothing", async () => {
      const { airdrop, dist, q0, qaxe } = await loadFixture(open);
      let paidA = 0n;
      let paidB = 0n;
      for (const e of dist.entries) {
        await expect(airdrop.claim(...claimArgs(e))).to.emit(airdrop, "Claimed").withArgs(e.index, ethers.getAddress(e.account), e.amountA, e.amountB);
        expect(await airdrop.isClaimed(e.index)).to.equal(true);
        paidA += BigInt(e.amountA);
        paidB += BigInt(e.amountB);
      }
      expect(paidA).to.equal(BigInt(dist.totalA));
      expect(paidB).to.equal(BigInt(dist.totalB));
      expect(await q0.balanceOf(await airdrop.getAddress())).to.equal(0n);
      expect(await qaxe.balanceOf(await airdrop.getAddress())).to.equal(0n);
      const [a, b] = await airdrop.unclaimed();
      expect(a).to.equal(0n);
      expect(b).to.equal(0n);
    });

    it("sends the tokens to the account even when someone else submits the claim", async () => {
      const { airdrop, dist, q0, qaxe, stranger } = await loadFixture(open);
      const e = dist.entries[0];
      await airdrop.connect(stranger).claim(...claimArgs(e));
      expect(await q0.balanceOf(e.account)).to.equal(BigInt(e.amountA));
      expect(await qaxe.balanceOf(e.account)).to.equal(BigInt(e.amountB));
      expect(await q0.balanceOf(stranger.address)).to.equal(0n);
    });

    it("pays an index once", async () => {
      const { airdrop, dist } = await loadFixture(open);
      const e = dist.entries[4];
      await airdrop.claim(...claimArgs(e));
      await expect(airdrop.claim(...claimArgs(e))).to.be.revertedWithCustomError(airdrop, "AlreadyClaimed");
    });

    it("rejects a changed amount, another account, another index and a proof from another entry", async () => {
      const { airdrop, dist } = await loadFixture(open);
      const e = dist.entries[6];
      const other = dist.entries[7];
      await expect(airdrop.claim(e.index, e.account, BigInt(e.amountA) + 1n, e.amountB, e.proof)).to.be.revertedWithCustomError(airdrop, "InvalidProof");
      await expect(airdrop.claim(e.index, other.account, e.amountA, e.amountB, e.proof)).to.be.revertedWithCustomError(airdrop, "InvalidProof");
      await expect(airdrop.claim(e.index + 100, e.account, e.amountA, e.amountB, e.proof)).to.be.revertedWithCustomError(airdrop, "InvalidProof");
      await expect(airdrop.claim(e.index, e.account, e.amountA, e.amountB, other.proof)).to.be.revertedWithCustomError(airdrop, "InvalidProof");
    });

    it("rejects an inner node of the tree presented as a leaf", async () => {
      const { airdrop, dist } = await loadFixture(open);
      // the two children of the first inner node, as a 'proof' for a made-up leaf that hashes to that inner node
      const a = dist.entries[0];
      const b = dist.entries[1];
      await expect(airdrop.claim(0, a.account, b.amountA, b.amountB, b.proof)).to.be.revertedWithCustomError(airdrop, "InvalidProof");
    });

    it("is closed before the root is set and after the deadline", async () => {
      const { airdrop, dist } = await loadFixture(funded);
      const e = dist.entries[0];
      await expect(airdrop.claim(...claimArgs(e))).to.be.revertedWithCustomError(airdrop, "RootNotSet");
      const deadline = (await time.latest()) + 15 * DAY;
      await airdrop.setMerkleRoot(dist.merkleRoot, dist.totalA, dist.totalB, deadline);
      await airdrop.claim(...claimArgs(e));
      await time.increaseTo(deadline + 1);
      await expect(airdrop.claim(...claimArgs(dist.entries[1]))).to.be.revertedWithCustomError(airdrop, "ClaimWindowClosed");
    });
  });

  describe("sweep", () => {
    it("lets the owner take the deposit back before a root is set, and nobody else", async () => {
      const { airdrop, q0, qaxe, owner, stranger } = await loadFixture(funded);
      await expect(airdrop.connect(stranger).sweep(await q0.getAddress(), stranger.address)).to.be.revertedWithCustomError(airdrop, "OwnableUnauthorizedAccount");
      await airdrop.connect(owner).sweep(await q0.getAddress(), owner.address);
      await airdrop.connect(owner).sweep(await qaxe.getAddress(), owner.address);
      expect(await q0.balanceOf(await airdrop.getAddress())).to.equal(0n);
    });

    it("locks the two airdrop tokens until the window closes, then returns what was not claimed", async () => {
      const { airdrop, dist, q0, qaxe, owner, deadline } = await loadFixture(open);
      await airdrop.claim(...claimArgs(dist.entries[0]));
      await expect(airdrop.sweep(await q0.getAddress(), owner.address)).to.be.revertedWithCustomError(airdrop, "ClaimWindowOpen");
      await expect(airdrop.sweep(await qaxe.getAddress(), owner.address)).to.be.revertedWithCustomError(airdrop, "ClaimWindowOpen");
      await time.increaseTo(deadline + 1);
      const before = await q0.balanceOf(owner.address);
      await airdrop.sweep(await q0.getAddress(), owner.address);
      const expected = BigInt(dist.totalA) - BigInt(dist.entries[0].amountA);
      expect((await q0.balanceOf(owner.address)) - before).to.equal(expected);
    });

    it("returns any other token at any time, even while the window is open", async () => {
      const { airdrop, other, owner } = await loadFixture(open);
      await other.mint(await airdrop.getAddress(), 5n * E18);
      await airdrop.sweep(await other.getAddress(), owner.address);
      expect(await other.balanceOf(owner.address)).to.equal(5n * E18);
    });

    it("refuses the zero address", async () => {
      const { airdrop, q0 } = await loadFixture(fixture);
      await expect(airdrop.sweep(await q0.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(airdrop, "ZeroAddress");
    });
  });

  describe("construction and ownership", () => {
    it("refuses a zero or identical token", async () => {
      const [owner] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const t = await Mock.deploy("T", "T");
      const Airdrop = await ethers.getContractFactory("CircleswapAirdrop");
      await expect(Airdrop.deploy(owner.address, ethers.ZeroAddress, await t.getAddress())).to.be.revertedWithCustomError(Airdrop, "ZeroAddress");
      await expect(Airdrop.deploy(owner.address, await t.getAddress(), await t.getAddress())).to.be.revertedWithCustomError(Airdrop, "SameToken");
    });

    it("hands ownership over in two steps", async () => {
      const { airdrop, owner, alice, bob } = await loadFixture(fixture);
      await airdrop.connect(owner).transferOwnership(alice.address);
      expect(await airdrop.owner()).to.equal(owner.address);
      await expect(airdrop.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(airdrop, "OwnableUnauthorizedAccount");
      await airdrop.connect(alice).acceptOwnership();
      expect(await airdrop.owner()).to.equal(alice.address);
    });
  });
});
