import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Wallet, ContractTransactionResponse } from "ethers";
import type { SafeBuddyVault, SafeBuddyVaultFactory } from "../../typechain-types/index.ts";

const { ethers, network } = hre;

export const DAY = 24 * 60 * 60;
export const MAX_DELAY = 30 * DAY;

/**
 * Explicit gas for executeTransaction. The reentrancy guard earns a storage refund, which
 * pushes Hardhat's estimator into a binary search that probes above its transaction gas cap
 * (and solidity-coverage raises the block limit past it), so tests never rely on estimation here.
 */
export const EXEC_GAS = { gasLimit: 5_000_000 } as const;

/** Random wallets whose address falls in Cyprus-1 (first byte 0x00), funded on the local node. */
export async function cyprusWallets(count: number): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  while (wallets.length < count) {
    const w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), ethers.provider);
    if (!w.address.toLowerCase().startsWith("0x00")) continue;
    await network.provider.send("hardhat_setBalance", [w.address, "0x21E19E0C9BAB2400000"]); // 10,000 QUAI
    wallets.push(w);
  }
  return wallets;
}

/** A random Cyprus-1 address with no key (for code injection or as an unused owner). */
export function cyprusAddress(): string {
  return ethers.getAddress("0x00" + ethers.hexlify(ethers.randomBytes(19)).slice(2));
}

export async function deployV2() {
  const Vault = await ethers.getContractFactory("SafeBuddyVault");
  const implementation = (await Vault.deploy()) as unknown as SafeBuddyVault;
  await implementation.waitForDeployment();
  const Factory = await ethers.getContractFactory("SafeBuddyVaultFactory");
  const factory = (await Factory.deploy(await implementation.getAddress())) as unknown as SafeBuddyVaultFactory;
  await factory.waitForDeployment();
  return { implementation, factory, Vault };
}

export async function createVault(opts: {
  owners: string[];
  threshold: number;
  minDelay?: number;
  salt?: string;
  creator?: Wallet;
}) {
  const { implementation, factory } = await deployV2();
  const salt = opts.salt ?? ethers.hexlify(ethers.randomBytes(32));
  const f = opts.creator ? factory.connect(opts.creator) : factory;
  const tx = await f.createWallet(opts.owners, opts.threshold, opts.minDelay ?? 0, salt);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l: any) => l?.name === "WalletCreated");
  const address: string = log!.args.wallet;
  const vault = (await ethers.getContractAt("SafeBuddyVault", address)) as unknown as SafeBuddyVault;
  return { vault, factory, implementation, address, salt };
}

export async function now(): Promise<number> {
  return time.latest();
}

/** Sets the timestamp of the next mined block and returns it. */
export async function atNext(offsetSeconds = 1): Promise<number> {
  const t = (await time.latest()) + offsetSeconds;
  await time.setNextBlockTimestamp(t);
  return t;
}

export function txHashFrom(receipt: any, vault: any): string {
  for (const l of receipt.logs) {
    try {
      const parsed = vault.interface.parseLog(l);
      if (parsed?.name === "TransactionProposed") return parsed.args.txHash;
    } catch {
      // not a vault log
    }
  }
  throw new Error("no TransactionProposed event");
}

export interface ProposeOpts {
  to: string;
  value?: bigint;
  data?: string;
  gasLimit?: bigint;
  requestedDelay?: number;
  /** Seconds after the timelock ends; defaults to 7 days. */
  expiresAfter?: number;
  expiration?: number;
}

/** Proposes as `owner` and returns the tx hash. Expiration defaults to delay + 7 days. */
export async function propose(vault: any, owner: Wallet, o: ProposeOpts): Promise<string> {
  const isSelf = o.to.toLowerCase() === (await vault.getAddress()).toLowerCase();
  const floor = Number(await vault.minExecutionDelay());
  const delay = isSelf ? 0 : Math.max(floor, o.requestedDelay ?? 0);
  const t = await atNext(1);
  const expiration = o.expiration ?? t + delay + (o.expiresAfter ?? 7 * DAY);
  const tx: ContractTransactionResponse = await vault
    .connect(owner)
    .proposeTransaction(o.to, o.value ?? 0n, o.data ?? "0x", o.gasLimit ?? (isSelf ? 0n : 200_000n), expiration, o.requestedDelay ?? 0);
  return txHashFrom(await tx.wait(), vault);
}

/** Proposes a self-call, has `approvers` approve it, and executes it with the first approver. */
export async function runSelfCall(vault: any, approvers: Wallet[], data: string) {
  const hash = await propose(vault, approvers[0]!, { to: await vault.getAddress(), data });
  for (const a of approvers.slice(1)) await vault.connect(a).approveTransaction(hash);
  return vault.connect(approvers[0]!).executeTransaction(hash, EXEC_GAS);
}

export const TxStatus = {
  None: 0n,
  Pending: 1n,
  Timelocked: 2n,
  Executable: 3n,
  Executed: 4n,
  Failed: 5n,
  Cancelled: 6n,
  Expired: 7n,
} as const;
