import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { deployProtocol, found, councilParams } from "./fixtures.ts";

const { ethers } = hre;

describe("CouncilMultisig (Council Hall)", function () {
  async function foundedCouncil() {
    const ctx = await deployProtocol();
    const members = [ctx.founder.address, ctx.alice.address, ctx.bob.address, ctx.carol.address];
    const g = await found(ctx.factory, councilParams(members, 3n));
    return { ...ctx, ...g, members };
  }

  it("executes once the third approval lands, with tryExecution on the approving call", async function () {
    const { guild, module: council, founder, alice, bob, stranger } = await foundedCouncil();
    const guildAddr = await guild.getAddress();
    await founder.sendTransaction({ to: guildAddr, value: ethers.parseEther("4") });

    const actions = [{ to: stranger.address, value: ethers.parseEther("1.5"), data: "0x" }];
    await expect(council.connect(founder).createProposal("Pay the smith", actions))
      .to.emit(council, "ProposalCreated")
      .withArgs(0n, founder.address, "Pay the smith", 1n);

    const before = await ethers.provider.getBalance(stranger.address);
    await council.connect(founder).approve(0, false);
    expect(await council.canExecute(0)).to.equal(false);
    await council.connect(alice).approve(0, false);
    expect(await council.canExecute(0)).to.equal(false);

    // Third of four: quorum reached, execution fires inside the approve call.
    await expect(council.connect(bob).approve(0, true)).to.emit(council, "ProposalExecuted").withArgs(0n);
    expect(await ethers.provider.getBalance(stranger.address)).to.equal(before + ethers.parseEther("1.5"));
    expect((await council.getProposal(0)).executed).to.equal(true);
  });

  it("keeps non-members out of proposing and approving", async function () {
    const { module: council, founder, stranger } = await foundedCouncil();
    await expect(council.connect(stranger).createProposal("Intrusion", [])).to.be.revertedWithCustomError(council, "NotMember");
    await council.connect(founder).createProposal("Real", []);
    await expect(council.connect(stranger).approve(0, false)).to.be.revertedWithCustomError(council, "NotMember");
  });

  it("refuses a second approval from the same member", async function () {
    const { module: council, founder } = await foundedCouncil();
    await council.connect(founder).createProposal("Real", []);
    await council.connect(founder).approve(0, false);
    await expect(council.connect(founder).approve(0, false)).to.be.revertedWithCustomError(council, "AlreadyApproved");
  });

  it("rejects a bad council at founding: empty list, zero approvals, duplicates", async function () {
    const ctx = await deployProtocol();
    await expect(found(ctx.factory, councilParams([], 0n))).to.be.revertedWithCustomError(
      await ethers.getContractFactory("CouncilMultisig"),
      "NoMembers"
    );
    await expect(
      found(ctx.factory, councilParams([ctx.alice.address, ctx.bob.address], 3n))
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("CouncilMultisig"), "MinApprovalsInvalid");
    await expect(
      found(ctx.factory, councilParams([ctx.alice.address, ctx.alice.address], 2n))
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("CouncilMultisig"), "MemberDuplicate");
  });

  it("lists its members and tracks approval state", async function () {
    const { module: council, founder, alice, members } = await foundedCouncil();
    expect(await council.members()).to.deep.equal(members);
    expect(await council.memberCount()).to.equal(4n);

    await council.connect(founder).createProposal("Roll call", []);
    await council.connect(alice).approve(0, false);
    expect(await council.hasApproved(0, alice.address)).to.equal(true);
    expect(await council.hasApproved(0, founder.address)).to.equal(false);
    expect((await council.getProposal(0)).approvals).to.equal(1n);
  });
});
