import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { deployProtocol, found, tokenParams, ROOT_ROLE, EXECUTE_ROLE, SET_METADATA_ROLE, SUPPLY } from "./fixtures.ts";

const { ethers } = hre;

/** A bare guild whose root also holds EXECUTE_ROLE, for testing the core in isolation. */
async function standaloneGuild() {
  const [root, alice, bob] = await ethers.getSigners();
  const guild: any = await (await ethers.getContractFactory("Guild")).deploy(root.address);
  await guild.waitForDeployment();
  await guild.connect(root).grant(EXECUTE_ROLE, root.address);
  return { guild, root, alice, bob };
}

describe("Guild", function () {
  it("holds every permission over itself and gates execute behind EXECUTE_ROLE", async function () {
    const ctx = await deployProtocol();
    const { guild } = await found(ctx.factory, tokenParams());

    expect(await guild.hasPermission(ROOT_ROLE, await guild.getAddress())).to.equal(true);
    await expect(guild.connect(ctx.stranger).execute([])).to.be.revertedWithCustomError(guild, "Unauthorized");
  });

  it("the founding factory retains nothing after the rite", async function () {
    const ctx = await deployProtocol();
    const { guild, module } = await found(ctx.factory, tokenParams());
    const factoryAddr = await ctx.factory.getAddress();

    expect(await guild.hasPermission(ROOT_ROLE, factoryAddr)).to.equal(false);
    expect(await guild.hasPermission(EXECUTE_ROLE, factoryAddr)).to.equal(false);
    expect(await guild.hasPermission(EXECUTE_ROLE, await module.getAddress())).to.equal(true);
  });

  it("mints the founder's voting power and records metadata during the rite", async function () {
    const ctx = await deployProtocol();
    const { guild, token } = await found(ctx.factory, tokenParams());

    expect(await token.balanceOf(ctx.founder.address)).to.equal(SUPPLY);
    expect(await token.owner()).to.equal(await guild.getAddress());
    expect(await guild.metadata()).to.equal("The Emberhold: keepers of the crimson flame.");
  });

  it("runs actions as the guild: grant, metadata and treasury moves", async function () {
    const { guild, root, alice, bob } = await standaloneGuild();
    const guildAddr = await guild.getAddress();

    await root.sendTransaction({ to: guildAddr, value: ethers.parseEther("5") });

    const guildIface = new ethers.Interface([
      "function grant(bytes32 role, address who)",
      "function setMetadata(string metadata)",
    ]);
    const actions = [
      { to: guildAddr, value: 0n, data: guildIface.encodeFunctionData("grant", [SET_METADATA_ROLE, alice.address]) },
      { to: guildAddr, value: 0n, data: guildIface.encodeFunctionData("setMetadata", ["Renamed by the hall."]) },
      { to: bob.address, value: ethers.parseEther("2"), data: "0x" },
    ];

    // Sub-calls run with the guild as msg.sender, which holds every permission implicitly.
    await expect(guild.connect(root).execute(actions)).to.emit(guild, "Executed").withArgs(root.address, 3n);

    expect(await guild.hasPermission(SET_METADATA_ROLE, alice.address)).to.equal(true);
    expect(await guild.metadata()).to.equal("Renamed by the hall.");
    expect(await ethers.provider.getBalance(guildAddr)).to.equal(ethers.parseEther("3"));
  });

  it("reverts the whole batch when one action fails", async function () {
    const { guild, root, bob } = await standaloneGuild();
    const guildAddr = await guild.getAddress();
    const guildIface = new ethers.Interface(["function setMetadata(string metadata)"]);
    const actions = [
      { to: guildAddr, value: 0n, data: guildIface.encodeFunctionData("setMetadata", ["never recorded"]) },
      { to: bob.address, value: ethers.parseEther("1"), data: "0x" }, // no funds: fails
    ];
    await expect(guild.connect(root).execute(actions)).to.be.revertedWithCustomError(guild, "ActionFailed").withArgs(1n);
    expect(await guild.metadata()).to.not.equal("never recorded");
  });

  it("records tribute with an invoice id, and plain receives with a zero id", async function () {
    const { guild, alice } = await standaloneGuild();
    const invoice = ethers.keccak256(ethers.toUtf8Bytes("invoice-001"));

    await expect(
      alice.sendTransaction({ to: await guild.getAddress(), value: 7n, data: guild.interface.encodeFunctionData("payTribute", [invoice]) })
    )
      .to.emit(guild, "TributeReceived")
      .withArgs(alice.address, 7n, invoice);

    await expect(alice.sendTransaction({ to: await guild.getAddress(), value: 3n }))
      .to.emit(guild, "TributeReceived")
      .withArgs(alice.address, 3n, ethers.ZeroHash);
  });

  it("grant and revoke round-trip with events and double-grant protection", async function () {
    const { guild, root, alice } = await standaloneGuild();
    const guildAddr = await guild.getAddress();
    const grantData = guild.interface.encodeFunctionData("grant", [EXECUTE_ROLE, alice.address]);
    await guild.connect(root).execute([{ to: guildAddr, value: 0n, data: grantData }]);
    expect(await guild.hasPermission(EXECUTE_ROLE, alice.address)).to.equal(true);

    await guild.connect(alice).execute([]); // alice now holds EXECUTE_ROLE

    const revokeData = guild.interface.encodeFunctionData("revoke", [EXECUTE_ROLE, alice.address]);
    await expect(guild.connect(root).execute([{ to: guildAddr, value: 0n, data: revokeData }])).to.emit(guild, "Revoked");
    expect(await guild.hasPermission(EXECUTE_ROLE, alice.address)).to.equal(false);

    await expect(guild.connect(root).grant(ROOT_ROLE, alice.address))
      .to.emit(guild, "Granted")
      .withArgs(ROOT_ROLE, alice.address);
    await expect(guild.connect(root).grant(ROOT_ROLE, alice.address)).to.be.revertedWithCustomError(guild, "AlreadyGranted");
  });
});
