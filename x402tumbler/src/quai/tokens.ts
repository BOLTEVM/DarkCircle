/**
 * DarkCircle: Quai settlement asset registry
 * File: src/quai/tokens.ts
 *
 * DarkCircle settles x402 payments in the two wrapped assets of the Quai account ledger:
 *   WQUAI  Wrapped Quai  - WETH9-style wrapper of native QUAI (deposit()/withdraw(uint256)).
 *   WQI    Wrapped Qi    - ERC-20 representation of Qi (EIP-2612 permit, no deposit/withdraw).
 *
 * Both were read back from Cyprus-1 (https://rpc.quai.network/cyprus1) on 2026-09-20:
 *   WQUAI 0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB  name "Wrapped Quai" symbol WQUAI decimals 18
 *   WQI   0x002b2596EcF05C93a31ff916E8b456DF6C77c750  name "Wrapped Qi"   symbol WQI   decimals 18
 * `pnpm verify:quai` re-checks them against a live zone endpoint.
 *
 * Token identity is decided by ADDRESS, never by symbol: Quai has unrelated contracts that share
 * symbols (several "USDT"/"POOP"/"TEST" tokens across its two DEXes), so a symbol is only ever a
 * lookup key into this registry, and any address outside the registry is treated as unknown.
 */

import { getAddress } from "ethers";
import { DEFAULT_QUAI_NETWORK, type QuaiNetwork } from "./networks.ts";

export interface QuaiToken {
  symbol: string;
  name: string;
  decimals: number;
  /** EIP-55 checksummed contract address. */
  address: string;
  networkId: string;
  /** WETH9-style deposit()/withdraw(uint256) that wraps the native asset. */
  wrapsNative: boolean;
  /** EIP-2612 permit()/nonces()/DOMAIN_SEPARATOR(). */
  permit: boolean;
  /** EIP-712 name and version of the permit domain (chain id and address come from the network and token). */
  permitDomain?: { name: string; version: string };
}

export const WQUAI_ADDRESS = getAddress("0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb");
export const WQI_ADDRESS = getAddress("0x002b2596ecf05c93a31ff916e8b456df6c77c750");
export const WQUAI_DECIMALS = 18;
export const WQI_DECIMALS = 18;

export const WQUAI: QuaiToken = {
  symbol: "WQUAI",
  name: "Wrapped Quai",
  decimals: WQUAI_DECIMALS,
  address: WQUAI_ADDRESS,
  networkId: "quai-cyprus1",
  wrapsNative: true,
  permit: false
};

export const WQI: QuaiToken = {
  symbol: "WQI",
  name: "Wrapped Qi",
  decimals: WQI_DECIMALS,
  address: WQI_ADDRESS,
  networkId: "quai-cyprus1",
  wrapsNative: false,
  permit: true,
  // Verified 2026-09-21: keccak of {name "Wrapped Qi", version "1", chain 9, WQI address} equals the
  // contract's DOMAIN_SEPARATOR() 0xd2b1836a50194d1efa6aba84257c050eed7b08e6354c4414ddfda829e3a4fdc0.
  permitDomain: { name: "Wrapped Qi", version: "1" }
};

/** The assets DarkCircle is willing to settle in by default. */
export const DEFAULT_QUAI_TOKENS: readonly QuaiToken[] = [WQUAI, WQI];

export class QuaiTokenRegistry {
  private readonly byNetwork = new Map<string, Map<string, QuaiToken>>();

  constructor(tokens: readonly QuaiToken[] = DEFAULT_QUAI_TOKENS) {
    for (const t of tokens) this.register(t);
  }

  /** Adds a token (e.g. an Orchard testnet deployment). Its address is checksummed and validated. */
  public register(token: QuaiToken): QuaiToken {
    const normalized: QuaiToken = { ...token, address: getAddress(token.address) };
    let bucket = this.byNetwork.get(normalized.networkId);
    if (!bucket) {
      bucket = new Map();
      this.byNetwork.set(normalized.networkId, bucket);
    }
    bucket.set(normalized.address.toLowerCase(), normalized);
    return normalized;
  }

  public list(network: QuaiNetwork = DEFAULT_QUAI_NETWORK): QuaiToken[] {
    return Array.from(this.byNetwork.get(network.id)?.values() ?? []);
  }

  public getByAddress(
    address: string,
    network: QuaiNetwork = DEFAULT_QUAI_NETWORK
  ): QuaiToken | undefined {
    return this.byNetwork.get(network.id)?.get(String(address).toLowerCase());
  }

  public getBySymbol(
    symbol: string,
    network: QuaiNetwork = DEFAULT_QUAI_NETWORK
  ): QuaiToken | undefined {
    const want = String(symbol).trim().toUpperCase();
    return this.list(network).find((t) => t.symbol.toUpperCase() === want);
  }

  /** Accepts a registry symbol ("wqi") or a contract address in any case. */
  public resolve(
    symbolOrAddress: string,
    network: QuaiNetwork = DEFAULT_QUAI_NETWORK
  ): QuaiToken | undefined {
    const v = String(symbolOrAddress ?? "").trim();
    if (!v) return undefined;
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? this.getByAddress(v, network) : this.getBySymbol(v, network);
  }

  public require(
    symbolOrAddress: string,
    network: QuaiNetwork = DEFAULT_QUAI_NETWORK
  ): QuaiToken {
    const token = this.resolve(symbolOrAddress, network);
    if (!token) {
      throw new Error(
        `ERR_QUAI_TOKEN_UNKNOWN: '${symbolOrAddress}' is not a registered asset on ${network.id} ` +
          `(supported: ${this.list(network).map((t) => t.symbol).join(", ") || "none"})`
      );
    }
    return token;
  }
}

export const defaultQuaiTokenRegistry = new QuaiTokenRegistry();

/** Formats atomic units as a decimal string with trailing zeros trimmed (keeps one fractional digit). */
export function formatTokenAmount(amount: bigint, decimals: number = WQUAI_DECIMALS): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${frac || "0"}`;
}

/** Parses a decimal string ("1.5") into atomic units. Rejects more fractional digits than `decimals`. */
export function parseTokenAmount(value: string, decimals: number = WQUAI_DECIMALS): bigint {
  const trimmed = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`ERR_QUAI_AMOUNT_INVALID: '${value}' is not a non-negative decimal amount`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`ERR_QUAI_AMOUNT_INVALID: '${value}' has more than ${decimals} fractional digits`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
