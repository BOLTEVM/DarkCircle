import { SparseMerkleTree, BN254_PRIME } from "../crypto/smt.ts";
import { poseidon2, poseidon1 } from "../crypto/poseidon.ts";
import type { Hash2Fn, Hash1Fn } from "../types/smt.ts";
import type { SanctionedEntry, SanctionCategory } from "../types/ppoi.ts";

/**
 * Reference seed screened as deposit origins. These are Ethereum-mainnet OFAC SDN addresses, so none of
 * them can exist on Quai Cyprus-1 (their first byte is not 0x00); they matter because value reaches
 * Quai through bridges from other chains. The registry screens any 20-byte address whatever its zone,
 * and addSanctionedAddress() accepts Quai addresses. No Quai-specific designation list is bundled:
 * load your compliance provider's list into the registry at startup.
 */
export const OFAC_SANCTIONED_ADDRESSES = [
  { address: "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b", category: "OFAC_SDN", desc: "Tornado Cash Router" },
  { address: "0xA160A5E1e7e45f39122Ec4749ee785090C1F5291", category: "OFAC_SDN", desc: "Tornado Cash 100 ETH" },
  { address: "0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936", category: "OFAC_SDN", desc: "Tornado Cash 10 ETH" },
  { address: "0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc", category: "OFAC_SDN", desc: "Tornado Cash 1 ETH" },
  { address: "0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF", category: "OFAC_SDN", desc: "Tornado Cash 0.1 ETH" },
  { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", category: "OFAC_SDN", desc: "Ronin Exploiter (Lazarus)" },
  { address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", category: "OFAC_SDN", desc: "Horizon Exploiter (Lazarus)" },
] as const;

export const TESTNET_SANCTIONED_ADDRESSES = [
  { address: "0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E", category: "TESTNET_SANCTION", desc: "Lazarus Group Cluster" },
  { address: "0x888888b1328905B20BE7E6D74e2b02B3762F64a1", category: "EXPLOIT_CLUSTER", desc: "Sanctioned Exploit Cluster" },
  { address: "0x777777a45632E934eD52f41659728B5E86E2097e", category: "RANSOMWARE", desc: "Ransomware Cluster" },
  { address: "0x6666668B8e05E5177B43eD87d4a4Af1cfd80e1A4", category: "DARKNET_MARKET", desc: "Darknet Market" },
] as const;

/**
 * Sanctions List Registry for DarkCircle PPOI Engine.
 * Manages OFAC SDN list, exploit clusters, and test vectors backed by an SMT.
 */
export class SanctionsRegistry {
  private readonly smt: SparseMerkleTree;
  private readonly hashAddressFn: Hash1Fn;
  private readonly entries: Map<string, SanctionedEntry>;
  private readonly historicalRoots: Set<string>;
  private readonly maxHistoricalRoots: number;

  constructor(
    hash2Fn: Hash2Fn = poseidon2,
    hashAddressFn: Hash1Fn = (num: bigint) => num % BN254_PRIME,
    depth: number = 256,
    maxHistoricalRoots: number = 32
  ) {
    this.smt = new SparseMerkleTree(depth, hash2Fn);
    this.hashAddressFn = hashAddressFn;
    this.entries = new Map<string, SanctionedEntry>();
    this.historicalRoots = new Set<string>();
    this.maxHistoricalRoots = maxHistoricalRoots;

    // Record initial empty root
    this.recordRoot();
  }

  public normalizeAddress(address: string): string {
    const clean = address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(clean)) {
      throw new Error(`Invalid Ethereum address format: ${address}`);
    }
    return clean;
  }

  public addressToKey(address: string): bigint {
    const clean = this.normalizeAddress(address);
    const num = BigInt(clean);
    return this.hashAddressFn(num);
  }

  public addSanctionedAddress(
    address: string,
    category: SanctionCategory = "OFAC_SDN",
    desc: string = ""
  ): string {
    const clean = this.normalizeAddress(address);
    const key = this.addressToKey(clean);

    this.smt.insert(key, 1n);
    this.entries.set(clean, {
      addressOrCommitment: clean,
      key,
      category,
      description: desc,
      addedAt: Date.now(),
    });

    return this.recordRoot();
  }

  public addSanctionedCommitment(
    commitment: bigint,
    category: SanctionCategory = "EXPLOIT_CLUSTER",
    desc: string = ""
  ): string {
    const key = commitment % BN254_PRIME;
    this.smt.insert(key, 1n);
    const hex = "0x" + key.toString(16);
    this.entries.set(hex, {
      addressOrCommitment: hex,
      key,
      category,
      description: desc,
      addedAt: Date.now(),
    });

    return this.recordRoot();
  }

  public removeSanctionedAddress(address: string): string {
    const clean = this.normalizeAddress(address);
    const key = this.addressToKey(clean);

    this.smt.delete(key);
    this.entries.delete(clean);
    return this.recordRoot();
  }

  public isSanctioned(addressOrCommitment: string | bigint): boolean {
    if (
      typeof addressOrCommitment === "string" &&
      addressOrCommitment.startsWith("0x") &&
      addressOrCommitment.length === 42
    ) {
      const clean = this.normalizeAddress(addressOrCommitment);
      return this.entries.has(clean);
    }
    const key =
      typeof addressOrCommitment === "bigint"
        ? addressOrCommitment % BN254_PRIME
        : BigInt(addressOrCommitment) % BN254_PRIME;
    return this.smt.get(key) === 1n;
  }

  public getRoot(): string {
    return "0x" + this.smt.getRoot().toString(16);
  }

  public isKnownRoot(root: string): boolean {
    return this.historicalRoots.has(root.toLowerCase());
  }

  public loadDefaultSanctions(): void {
    for (const item of OFAC_SANCTIONED_ADDRESSES) {
      this.addSanctionedAddress(item.address, item.category as SanctionCategory, item.desc);
    }
    for (const item of TESTNET_SANCTIONED_ADDRESSES) {
      this.addSanctionedAddress(item.address, item.category as SanctionCategory, item.desc);
    }
  }

  public getTree(): SparseMerkleTree {
    return this.smt;
  }

  public getEntries(): Map<string, SanctionedEntry> {
    return new Map(this.entries);
  }

  private recordRoot(): string {
    const root = this.getRoot();
    this.historicalRoots.add(root.toLowerCase());
    if (this.historicalRoots.size > this.maxHistoricalRoots) {
      const oldest = this.historicalRoots.values().next().value;
      if (oldest) this.historicalRoots.delete(oldest);
    }
    return root;
  }
}
