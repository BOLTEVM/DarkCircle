import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import type { Wallet } from "ethers";
import type { RpcLike, VaultDeployment } from "@safebuddy/core";
import { isCyprus1QuaiAddress } from "@safebuddy/core";

const { ethers, network } = hre;

/**
 * Lets the Quai-only code in @safebuddy/core run against the in-process Hardhat chain:
 * quai_* methods map to eth_*, and blocks are reshaped into Quai's format (number and
 * timestamp under woHeader), so core never learns about Ethereum-shaped blocks.
 */
export function hardhatQuaiRpc(tamper?: (method: string, params: unknown[], result: any) => any): RpcLike {
  return {
    rawRequest: async <T = any>(method: string, params: unknown[] = []): Promise<T> => {
      const eth = method.replace(/^quai_/, "eth_");
      let result: any = await network.provider.request({ method: eth, params: params as any[] });
      if (eth === "eth_getBlockByNumber" && result) {
        result = { hash: result.hash, woHeader: { number: result.number, timestamp: result.timestamp }, header: { number: [] } };
      }
      return (tamper ? tamper(method, params, result) : result) as T;
    },
  };
}

/** Random funded wallets on the Cyprus-1 Quai ledger (0x00 prefix, second byte below 0x80). */
export async function quaiWallets(count: number): Promise<Wallet[]> {
  const out: Wallet[] = [];
  while (out.length < count) {
    const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), ethers.provider);
    if (!isCyprus1QuaiAddress(w.address)) continue;
    await network.provider.send("hardhat_setBalance", [w.address, "0x21E19E0C9BAB2400000"]);
    out.push(w);
  }
  return out;
}

/** A funded wallet whose first CREATE lands on a Cyprus-1 Quai address, as on Quai itself. */
export async function cyprusDeployer(): Promise<Wallet> {
  for (;;) {
    const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), ethers.provider);
    if (!isCyprus1QuaiAddress(ethers.getCreateAddress({ from: w.address, nonce: 0 }))) continue;
    await network.provider.send("hardhat_setBalance", [w.address, "0x21E19E0C9BAB2400000"]);
    return w;
  }
}

export async function deployAtCyprus(name: string, args: unknown[] = []) {
  const deployer = await cyprusDeployer();
  const factory = await ethers.getContractFactory(name, deployer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract as any;
}

/** Implementation and factory at Cyprus-1 addresses, described the way core expects. */
export async function deployCyprusV2(): Promise<{ implementation: any; factory: any; deployment: VaultDeployment }> {
  const implementation = await deployAtCyprus("SafeBuddyVault");
  const factory = await deployAtCyprus("SafeBuddyVaultFactory", [await implementation.getAddress()]);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  return {
    implementation,
    factory,
    deployment: {
      chainId,
      factory: await factory.getAddress(),
      implementation: await implementation.getAddress(),
      factoryBlock: null,
      source: "override",
    },
  };
}
