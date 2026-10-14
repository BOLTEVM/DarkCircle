import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";

const { ethers } = hre;

export const BPS = (n: number) => BigInt(n);
export const HOUR = 3600;
export const DAY = 24 * HOUR;
export const SUPPLY = ethers.parseEther("1000000");

export const ROOT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ROOT_ROLE"));
export const EXECUTE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EXECUTE_ROLE"));
export const SET_METADATA_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SET_METADATA_ROLE"));

export interface Founded {
  guild: any;
  token: any | null;
  module: any;
  mode: 0 | 1;
  name: string;
}

/** Deploys registry + token stack + factory, then wires the registry to the factory. */
export async function deployProtocol() {
  const [founder, alice, bob, carol, stranger] = await ethers.getSigners();
  const registry: any = await (await ethers.getContractFactory("GuildNameRegistry")).deploy();
  await registry.waitForDeployment();
  const tokenStack: any = await (await ethers.getContractFactory("TokenStackDeployer")).deploy();
  await tokenStack.waitForDeployment();
  const factory: any = await (
    await ethers.getContractFactory("GuildFactory")
  ).deploy(await registry.getAddress(), await tokenStack.getAddress());
  await factory.waitForDeployment();
  await registry.wire(await factory.getAddress());
  return { registry, factory, tokenStack, founder, alice, bob, carol, stranger };
}

export function tokenParams(overrides: Record<string, unknown> = {}) {
  return {
    name: "emberhold",
    metadata: "The Emberhold: keepers of the crimson flame.",
    mode: 0,
    tokenName: "Emberhold Mark",
    tokenSymbol: "EMBER",
    initialSupply: SUPPLY,
    supportThreshold: BPS(5000),
    minParticipation: BPS(2000),
    minDuration: BigInt(DAY),
    members: [],
    minApprovals: 0n,
    ...overrides,
  };
}

export function councilParams(members: string[], minApprovals: bigint, overrides: Record<string, unknown> = {}) {
  return {
    name: "ironcouncil",
    metadata: "The Iron Council: five keys, three to turn.",
    mode: 1,
    tokenName: "",
    tokenSymbol: "",
    initialSupply: 0n,
    supportThreshold: 0n,
    minParticipation: 0n,
    minDuration: 0n,
    members,
    minApprovals,
    ...overrides,
  };
}

/** Founds a guild and reads the addresses back from the GuildFounded event. */
export async function found(factory: any, params: Record<string, unknown>): Promise<Founded> {
  const tx = await factory.foundGuild(params);
  const receipt = await tx.wait();
  const ev = receipt.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: any) => e && e.name === "GuildFounded");
  const guild: any = await ethers.getContractAt("Guild", ev.args.guild);
  const token: any = ev.args.token === ethers.ZeroAddress ? null : await ethers.getContractAt("GovernanceToken", ev.args.token);
  const moduleName = params.mode === 0 ? "MajorityVoting" : "CouncilMultisig";
  const module_: any = await ethers.getContractAt(moduleName, ev.args.module);
  return { guild, token, module: module_, mode: params.mode as 0 | 1, name: ev.args.name };
}

/** A guild with the founder holding (and self-delegating) the whole supply. */
export async function foundedTokenGuild() {
  const ctx = await deployProtocol();
  const g = await found(ctx.factory, tokenParams());
  await g.token.connect(ctx.founder).delegate(ctx.founder.address);
  return { ...ctx, ...g };
}
