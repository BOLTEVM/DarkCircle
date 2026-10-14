import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { foundedTokenGuild, DAY } from "./fixtures.ts";

const { ethers } = hre;

const YES = 2;
const NO = 3;
const ABSTAIN = 1;

/** A proposal that sends 1 ether from the guild treasury to `to`. */
function treasuryAction(guildAddr: string, to: string, value: bigint) {
  return [{ to, value, data: "0x" }];
}

describe("MajorityVoting (Token Hall)", function () {
  it("runs the full rite: propose, vote, execute at the end date", async function () {
    const ctx = await foundedTokenGuild();
    const { guild, module: voting, founder, bob } = ctx;
    const guildAddr = await guild.getAddress();
    await founder.sendTransaction({ to: guildAddr, value: ethers.parseEther("5") });

    const actions = treasuryAction(guildAddr, bob.address, ethers.parseEther("1"));
    await expect(voting.connect(founder).createProposal("Grant bob a stipend", actions, 0, 0))
      .to.emit(voting, "ProposalCreated")
      .withArgs(0n, founder.address, await time.latest(), (await time.latest()) + DAY, "Grant bob a stipend", 1n);

    const before = await ethers.provider.getBalance(bob.address);
    await expect(voting.connect(founder).vote(0, YES, false))
      .to.emit(voting, "VoteCast")
      .withArgs(0n, founder.address, YES, ethers.parseEther("1000000"));

    // Founder holds 100%: support and participation are met, and early execution applies.
    expect(await voting.canExecute(0)).to.equal(true);
    await voting.connect(founder).execute(0);
    expect(await ethers.provider.getBalance(bob.address)).to.equal(before + ethers.parseEther("1"));
    const p = await voting.getProposal(0);
    expect(p.executed).to.equal(true);
  });

  it("blocks execution before the end date when yes does not beat the whole supply", async function () {
    const ctx = await foundedTokenGuild();
    const { module: voting, token, founder, alice, bob } = ctx;
    // Split power: founder 50%, alice 50%.
    await token.connect(founder).transfer(alice.address, ethers.parseEther("500000"));
    await token.connect(alice).delegate(alice.address);
    await hre.network.provider.send("evm_mine");

    const actions = treasuryAction(await ctx.guild.getAddress(), bob.address, 0n);
    await voting.connect(founder).createProposal("Empty signal vote", actions, 0, 0);
    await voting.connect(founder).vote(0, YES, false); // 50% of supply: not > 50% of total supply

    expect(await voting.canExecute(0)).to.equal(false);

    await time.increase(DAY + 1);
    // After the end: yes 100% of decided votes, participation 50% >= 20%.
    expect(await voting.canExecute(0)).to.equal(true);
    await voting.execute(0);
    expect((await voting.getProposal(0)).executed).to.equal(true);
  });

  it("fails when participation stays below the minimum", async function () {
    const ctx = await foundedTokenGuild();
    const { module: voting, token, founder, alice, bob } = ctx;
    await token.connect(founder).transfer(alice.address, ethers.parseEther("900000"));
    await token.connect(alice).delegate(alice.address);
    await hre.network.provider.send("evm_mine");

    await voting.connect(founder).createProposal("Low turnout", treasuryAction(await ctx.guild.getAddress(), bob.address, 0n), 0, 0);
    await voting.connect(founder).vote(0, YES, false); // 10% turnout, below the 20% floor

    await time.increase(DAY + 1);
    expect(await voting.canExecute(0)).to.equal(false);
    await expect(voting.execute(0)).to.be.revertedWithCustomError(voting, "CannotExecute");
  });

  it("fails when no outweighs yes past the threshold line", async function () {
    const ctx = await foundedTokenGuild();
    const { module: voting, token, founder, alice, bob } = ctx;
    await token.connect(founder).transfer(alice.address, ethers.parseEther("600000"));
    await token.connect(alice).delegate(alice.address);
    await hre.network.provider.send("evm_mine");

    await voting.connect(founder).createProposal("Contested", treasuryAction(await ctx.guild.getAddress(), bob.address, 0n), 0, 0);
    await voting.connect(founder).vote(0, YES, false); // 40%
    await voting.connect(alice).vote(0, NO, false); // 60%

    await time.increase(DAY + 1);
    expect(await voting.canExecute(0)).to.equal(false);
  });

  it("refuses double votes, votes without power, and votes after the end", async function () {
    const ctx = await foundedTokenGuild();
    const { module: voting, founder, stranger } = ctx;
    await voting.connect(founder).createProposal("Rules", [], 0, 0);

    await voting.connect(founder).vote(0, YES, false);
    await expect(voting.connect(founder).vote(0, NO, false)).to.be.revertedWithCustomError(voting, "AlreadyVoted");
    await expect(voting.connect(stranger).vote(0, NO, false)).to.be.revertedWithCustomError(voting, "NoVotingPower");

    await time.increase(DAY + 1);
    await expect(voting.connect(stranger).vote(0, NO, false)).to.be.revertedWithCustomError(voting, "VoteEnded");
  });

  it("only the guild may move the thresholds, through a passed proposal", async function () {
    const ctx = await foundedTokenGuild();
    const { guild, module: voting, founder } = ctx;
    await expect(voting.connect(founder).updateSettings(6000, 1000)).to.be.revertedWithCustomError(voting, "NotTheGuild");

    const data = voting.interface.encodeFunctionData("updateSettings", [6000, 1000]);
    const actions = [{ to: await voting.getAddress(), value: 0n, data }];
    await voting.connect(founder).createProposal("Tighten the threshold", actions, 0, 0);
    await voting.connect(founder).vote(0, YES, false);
    await voting.execute(0);

    expect(await voting.supportThreshold()).to.equal(6000n);
    expect(await voting.minParticipation()).to.equal(1000n);
    expect(await guild.hasPermission(await guild.EXECUTE_ROLE(), await voting.getAddress())).to.equal(true);
  });

  it("snapshots power at creation: tokens moved after do not weigh in", async function () {
    const ctx = await foundedTokenGuild();
    const { module: voting, token, founder, alice, bob } = ctx;
    const actions = treasuryAction(await ctx.guild.getAddress(), bob.address, 0n);
    await voting.connect(founder).createProposal("Snapshot", actions, 0, 0);

    // Alice receives and delegates AFTER the snapshot block.
    await token.connect(founder).transfer(alice.address, ethers.parseEther("400000"));
    await token.connect(alice).delegate(alice.address);
    await hre.network.provider.send("evm_mine");

    await expect(voting.connect(alice).vote(0, YES, false)).to.be.revertedWithCustomError(voting, "NoVotingPower");
    const p = await voting.getProposal(0);
    expect(p.snapshotBlock).to.be.gt(0n);
  });
});
