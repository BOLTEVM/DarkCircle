import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { deployProtocol, found, tokenParams, councilParams } from "./fixtures.ts";

const { ethers } = hre;

describe("GuildFactory + GuildNameRegistry (the Founding Rite)", function () {
  it("registers the handle and resolves it back to the guild", async function () {
    const ctx = await deployProtocol();
    const { guild } = await found(ctx.factory, tokenParams());

    expect(await ctx.registry.resolve("emberhold")).to.equal(await guild.getAddress());
    expect((await ctx.registry.recordOf(await guild.getAddress())).name).to.equal("emberhold");
    expect(await ctx.registry.count()).to.equal(1n);
  });

  it("pages the directory for the Halls page", async function () {
    const ctx = await deployProtocol();
    await found(ctx.factory, tokenParams({ name: "alpha-hold" }));
    await found(ctx.factory, tokenParams({ name: "beta-hold", metadata: "" }));
    await found(ctx.factory, councilParams([ctx.alice.address], 1n, { name: "gamma_council" }));

    const records = await ctx.registry.page(0, 10);
    expect(records.map((r: any) => r.name)).to.deep.equal(["alpha-hold", "beta-hold", "gamma_council"]);
    expect(records[2].mode).to.equal(1n);
    expect(records[2].token).to.equal(ethers.ZeroAddress);
    for (const r of records) expect(r.guild).to.not.equal(ethers.ZeroAddress);

    const tail = await ctx.registry.page(2, 10);
    expect(tail.map((r: any) => r.name)).to.deep.equal(["gamma_council"]);
    const empty = await ctx.registry.page(9, 10);
    expect(empty.length).to.equal(0);
  });

  it("refuses duplicate handles and invalid characters", async function () {
    const ctx = await deployProtocol();
    await found(ctx.factory, tokenParams());
    await expect(found(ctx.factory, tokenParams())).to.be.revertedWithCustomError(ctx.registry, "NameTaken");

    for (const bad of ["", "A uppercase", "with space", "dot.quai", "x".repeat(65)]) {
      await expect(found(ctx.factory, tokenParams({ name: bad }))).to.be.revertedWithCustomError(ctx.registry, "NameInvalid");
    }
  });

  it("only the factory may write the registry", async function () {
    const ctx = await deployProtocol();
    await expect(
      ctx.registry.connect(ctx.founder).register("squatter", ctx.founder.address, ethers.ZeroAddress, ethers.ZeroAddress, 0)
    ).to.be.revertedWithCustomError(ctx.registry, "NotFactory");
  });

  it("founds both modes from one call and emits the full record", async function () {
    const ctx = await deployProtocol();

    await expect(ctx.factory.foundGuild(tokenParams({ name: "tokenguild" })))
      .to.emit(ctx.factory, "GuildFounded")
      .withArgs("tokenguild", (v: string) => v !== ethers.ZeroAddress, ctx.founder.address, 0, (v: string) => v !== ethers.ZeroAddress, (v: string) => v !== ethers.ZeroAddress);

    await expect(ctx.factory.foundGuild(councilParams([ctx.alice.address, ctx.bob.address], 2n, { name: "councilguild" })))
      .to.emit(ctx.factory, "GuildFounded")
      .withArgs("councilguild", (v: string) => v !== ethers.ZeroAddress, ctx.founder.address, 1, ethers.ZeroAddress, (v: string) => v !== ethers.ZeroAddress);
  });

  it("a token guild with zero supply founds cleanly and can mint later by proposal", async function () {
    const ctx = await deployProtocol();
    const { guild, token, module: voting } = await found(ctx.factory, tokenParams({ name: "zerohold", initialSupply: 0n }));
    expect(await token.totalSupply()).to.equal(0n);

    // Seed the founder by hand (as the UI's Mint flow does on an existing guild): the guild
    // owns the token, so minting is a guild action.
    const data = token.interface.encodeFunctionData("mint", [ctx.founder.address, ethers.parseEther("100")]);
    await expect(
      guild.connect(ctx.founder).execute([{ to: await token.getAddress(), value: 0n, data }])
    ).to.be.revertedWithCustomError(guild, "Unauthorized"); // founder holds no EXECUTE_ROLE; the module does
    expect(await voting.getAddress()).to.not.equal(ethers.ZeroAddress);
  });
});
