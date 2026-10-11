/**
 * DarkCircle agent: from an intent to transactions the user's wallet signs
 * File: src/agent/planner.ts
 *
 * Reads the live chain (balances, gas price) and builds the exact transactions an intent needs, each one
 * simulated on the zone first (QuaiRpcClient.prepareContractCall: quai_createAccessList, then quai_estimateGas
 * with that list), so nothing that would revert is ever offered for signing: on Quai a reverted transaction
 * burns its whole gas limit. It never signs or sends. The x402 "buy" intent also asks the service for its
 * price (the 402 challenge) and checks it against what the user allowed for that service.
 *
 * Every check here runs again where it matters: the user confirms the plan, the wallet shows its own
 * approval screen, and the outcome is verified from the receipt (agent.ts).
 */

import crypto from "node:crypto";
import { Interface } from "ethers";
import type { QuaiRpcClient, QuaiAccessListEntry } from "../quai/rpc.ts";
import { assertQuaiPaymentAddress, toQuaiChecksum } from "../quai/address.ts";
import { challengeMatchesNetwork, type QuaiNetwork } from "../quai/networks.ts";
import { defaultQuaiTokenRegistry, formatTokenAmount, parseTokenAmount, type QuaiToken } from "../quai/tokens.ts";
import { ChallengeParser, type ParsedPaymentChallenge } from "../proxy/parser.ts";
import { NATIVE_KEY, type AgentBook, type Service } from "./book.ts";
import type { AssetSymbol, Intent } from "./grammar.ts";

export const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);
export const WRAPPER = new Interface(["function deposit() payable", "function withdraw(uint256 wad)"]);

/** A plan is offered for this long; after that the gas price and balances are re-read by planning again. */
export const PLAN_TTL_MS = 180_000;
/** An x402 invoice must stay valid at least this long: confirming, signing and confirmations take time. */
export const MIN_INVOICE_TTL_S = 180;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESOURCE_BYTES = 512 * 1024;

export interface PlannedTx {
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  accessList: QuaiAccessListEntry[];
  label: string;
  /** What the receipt must show for this transaction to count as done. */
  expect: { kind: "token-transfer"; token: string; to: string; amount: string } | { kind: "native"; to: string; value: string } | { kind: "call"; to: string };
}

export interface Plan {
  id: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  network: { id: string; chainId: number; title: string; explorerUrl: string };
  kind: "wrap" | "unwrap" | "send" | "buy";
  said: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  from: string;
  txs: PlannedTx[];
  gasPriceWei: string;
  maxFeeWei: string;
  spend?: { asset: AssetSymbol; trackerKey: string; amount: string };
  buy?: { service: string; url: string; invoiceId: string; token: string; recipient: string; amount: string; expiresAt: number };
  warnings: string[];
}

export interface Fetched {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  truncated: boolean;
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<Fetched>;

/** GET with a timeout and a size cap; never follows a redirect off the configured URL silently. */
export const httpFetcher: Fetcher = async (url, init) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5", ...(init?.headers ?? {}) }, redirect: "manual", signal: ctl.signal });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESOURCE_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    return { status: res.status, headers, contentType: headers["content-type"] ?? "", body: Buffer.concat(chunks).toString("utf8"), truncated };
  } catch (err) {
    throw new Error(`ERR_SERVICE_UNREACHABLE: ${(err as Error).name === "AbortError" ? "no answer within 15 s" : (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
};

const fmt = (v: bigint, symbol: string) => `${formatTokenAmount(v).replace(/\.0$/, "")} ${symbol}`;
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
/** A 3-digit code for spoken confirmation, digits 1-9 only (no "oh"/"zero" ambiguity). */
const confirmationCode = () => Array.from({ length: 3 }, () => String(1 + crypto.randomInt(9))).join("");

export class Refusal extends Error {
  public readonly code: string;
  public readonly nearby?: string[];
  constructor(code: string, message: string, nearby?: string[]) {
    super(message);
    this.code = code;
    this.nearby = nearby;
  }
}

export class Planner {
  private readonly rpc: QuaiRpcClient;
  private readonly network: QuaiNetwork;
  private readonly book: AgentBook;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;

  constructor(o: { rpc: QuaiRpcClient; book: AgentBook; fetcher?: Fetcher; now?: () => number }) {
    this.rpc = o.rpc;
    this.network = o.rpc.network;
    this.book = o.book;
    this.fetcher = o.fetcher ?? httpFetcher;
    this.now = o.now ?? Date.now;
  }

  private token(asset: AssetSymbol): QuaiToken {
    const t = defaultQuaiTokenRegistry.getBySymbol(asset, this.network);
    if (!t) throw new Refusal("ASSET_NOT_ON_NETWORK", `${asset} is not registered on ${this.network.title}.`);
    return t;
  }

  private async tokenBalance(token: QuaiToken, owner: string): Promise<bigint> {
    const raw = await this.rpc.call({ to: token.address, data: ERC20.encodeFunctionData("balanceOf", [toQuaiChecksum(owner)]) });
    return ERC20.decodeFunctionResult("balanceOf", raw)[0] as bigint;
  }

  /** Balances of the wallet: native QUAI and every registered token on this network. */
  public async balances(owner: string): Promise<Array<{ asset: string; amount: bigint }>> {
    const out: Array<{ asset: string; amount: bigint }> = [{ asset: "QUAI", amount: await this.rpc.getBalance(owner) }];
    for (const t of defaultQuaiTokenRegistry.list(this.network)) out.push({ asset: t.symbol, amount: await this.tokenBalance(t, owner) });
    return out;
  }

  private amount(decimal: string, asset: string): bigint {
    let v: bigint;
    try {
      v = parseTokenAmount(decimal, 18);
    } catch {
      throw new Refusal("AMOUNT_INVALID", `${decimal} ${asset} is not an amount I can send.`);
    }
    if (v <= 0n) throw new Refusal("AMOUNT_ZERO", "The amount must be more than zero.");
    return v;
  }

  /** Simulates one call and turns it into a transaction to sign. A node-reported failure becomes a refusal. */
  private async prepare(from: string, to: string, data: string, value: bigint, label: string, expect: PlannedTx["expect"]): Promise<PlannedTx> {
    try {
      const p = await this.rpc.prepareContractCall({ from, to, data, value });
      return { to: p.to, data: p.data, value: p.value, gasLimit: p.gasLimit, accessList: p.accessList, label, expect };
    } catch (err) {
      const m = (err as Error).message;
      throw new Refusal("SIMULATION_FAILED", `The network says this would fail, so it was not offered for signing: ${m.replace(/^ERR_[A-Z_]+:\s*/, "").slice(0, 200)}`);
    }
  }

  private plan(o: Omit<Plan, "id" | "code" | "createdAt" | "expiresAt" | "network" | "maxFeeWei" | "gasPriceWei">, gasPrice: bigint): Plan {
    const maxFee = o.txs.reduce((s, t) => s + BigInt(t.gasLimit) * gasPrice, 0n);
    const createdAt = this.now();
    return {
      ...o,
      id: crypto.randomBytes(9).toString("hex"),
      code: confirmationCode(),
      createdAt,
      expiresAt: createdAt + PLAN_TTL_MS,
      network: { id: this.network.id, chainId: this.network.chainId, title: this.network.title, explorerUrl: this.network.explorerUrl },
      gasPriceWei: gasPrice.toString(),
      maxFeeWei: maxFee.toString()
    };
  }

  private async gasPrice(): Promise<bigint> {
    return BigInt(await this.rpc.request<string>("quai_gasPrice"));
  }

  /** The native balance must cover what is sent plus the most the network fee can be. */
  private async assertNativeCovers(from: string, value: bigint, txs: PlannedTx[], gasPrice: bigint): Promise<void> {
    const fee = txs.reduce((s, t) => s + BigInt(t.gasLimit) * gasPrice, 0n);
    const bal = await this.rpc.getBalance(from);
    if (bal < value + fee) {
      throw new Refusal("INSUFFICIENT_QUAI", `You have ${fmt(bal, "QUAI")}; this needs ${fmt(value, "QUAI")}${value > 0n ? " plus " : ""}up to ${fmt(fee, "QUAI")} in network fees.`);
    }
  }

  public async build(intent: Intent, said: string, from: string): Promise<Plan> {
    const wallet = assertQuaiPaymentAddress(from, this.network);
    await this.rpc.assertZone();
    switch (intent.kind) {
      case "wrap":
        return this.wrap(intent.amount, said, wallet);
      case "unwrap":
        return this.unwrap(intent.amount, said, wallet);
      case "send":
        return this.send(intent.asset, intent.amount, intent.to, said, wallet);
      case "buy":
        throw new Error("ERR_INTERNAL: buy is planned through planBuy");
      default:
        throw new Error(`ERR_INTERNAL: ${intent.kind} is not a planned operation`);
    }
  }

  private async wrap(decimal: string, said: string, from: string): Promise<Plan> {
    const wquai = this.token("WQUAI");
    const value = this.amount(decimal, "QUAI");
    const gasPrice = await this.gasPrice();
    const tx = await this.prepare(from, wquai.address, WRAPPER.encodeFunctionData("deposit"), value, `Wrap ${fmt(value, "QUAI")}`, { kind: "call", to: wquai.address });
    await this.assertNativeCovers(from, value, [tx], gasPrice);
    return this.plan({
      kind: "wrap",
      said,
      summary: `Wrap ${fmt(value, "QUAI")} into ${fmt(value, "WQUAI")}.`,
      details: [{ label: "Contract", value: `WQUAI ${wquai.address}` }, { label: "Sends", value: fmt(value, "QUAI") }, { label: "You receive", value: fmt(value, "WQUAI") }],
      from,
      txs: [tx],
      warnings: []
    }, gasPrice);
  }

  private async unwrap(decimal: string, said: string, from: string): Promise<Plan> {
    const wquai = this.token("WQUAI");
    const amount = this.amount(decimal, "WQUAI");
    const held = await this.tokenBalance(wquai, from);
    if (held < amount) throw new Refusal("INSUFFICIENT_TOKEN", `You have ${fmt(held, "WQUAI")}, not ${fmt(amount, "WQUAI")}.`);
    const gasPrice = await this.gasPrice();
    const tx = await this.prepare(from, wquai.address, WRAPPER.encodeFunctionData("withdraw", [amount]), 0n, `Unwrap ${fmt(amount, "WQUAI")}`, { kind: "call", to: wquai.address });
    await this.assertNativeCovers(from, 0n, [tx], gasPrice);
    return this.plan({
      kind: "unwrap",
      said,
      summary: `Unwrap ${fmt(amount, "WQUAI")} back into ${fmt(amount, "QUAI")}.`,
      details: [{ label: "Contract", value: `WQUAI ${wquai.address}` }, { label: "Burns", value: fmt(amount, "WQUAI") }, { label: "You receive", value: fmt(amount, "QUAI") }],
      from,
      txs: [tx],
      warnings: []
    }, gasPrice);
  }

  private async send(asset: AssetSymbol, decimal: string, spokenName: string, said: string, from: string): Promise<Plan> {
    const { contact, nearby } = this.book.findContact(spokenName);
    if (!contact) {
      throw new Refusal(
        "CONTACT_UNKNOWN",
        nearby.length ? `No contact called "${spokenName}". Did you mean ${nearby.map((n) => `"${n}"`).join(" or ")}? Say it again with the exact name.` : `No contact called "${spokenName}". Add them under Contacts first: voice never carries an address.`,
        nearby
      );
    }
    let to: string;
    try {
      to = assertQuaiPaymentAddress(contact.address, this.network);
    } catch (err) {
      throw new Refusal("CONTACT_ADDRESS_INVALID", `${contact.name}'s saved address cannot receive on ${this.network.title}: ${(err as Error).message}`);
    }
    if (to.toLowerCase() === from.toLowerCase()) throw new Refusal("SELF_SEND", `${contact.name} is your own connected wallet.`);
    const amount = this.amount(decimal, asset);
    const gasPrice = await this.gasPrice();
    let tx: PlannedTx;
    let trackerKey: string;
    if (asset === "QUAI") {
      trackerKey = NATIVE_KEY;
      this.book.assertWithinLimits(asset, trackerKey, amount);
      tx = await this.prepare(from, to, "0x", amount, `Send ${fmt(amount, "QUAI")} to ${contact.name}`, { kind: "native", to, value: amount.toString() });
      await this.assertNativeCovers(from, amount, [tx], gasPrice);
    } else {
      const token = this.token(asset);
      trackerKey = token.address.toLowerCase();
      this.book.assertWithinLimits(asset, trackerKey, amount);
      const held = await this.tokenBalance(token, from);
      if (held < amount) throw new Refusal("INSUFFICIENT_TOKEN", `You have ${fmt(held, asset)}, not ${fmt(amount, asset)}.`);
      tx = await this.prepare(from, token.address, ERC20.encodeFunctionData("transfer", [to, amount]), 0n, `Send ${fmt(amount, asset)} to ${contact.name}`, { kind: "token-transfer", token: token.address, to, amount: amount.toString() });
      await this.assertNativeCovers(from, 0n, [tx], gasPrice);
    }
    return this.plan({
      kind: "send",
      said,
      summary: `Send ${fmt(amount, asset)} to ${contact.name}.`,
      details: [{ label: "To", value: `${contact.name} · ${to}` }, { label: "Amount", value: fmt(amount, asset) }, { label: "Visibility", value: "Public: an ordinary transfer, visible on the chain" }],
      from,
      txs: [tx],
      spend: { asset, trackerKey, amount: amount.toString() },
      warnings: []
    }, gasPrice);
  }

  /**
   * Asks the service for the resource. Free: returns it. Behind a 402: checks the challenge against the network,
   * the service's saved price ceiling and the user's limits, and plans the payment.
   */
  public async planBuy(spoken: string, said: string, from: string): Promise<{ free: Fetched; service: Service } | { plan: Plan }> {
    const { service, nearby } = this.book.findService(spoken);
    if (!service) {
      throw new Refusal(
        "SERVICE_UNKNOWN",
        nearby.length ? `No service called "${spoken}". Did you mean ${nearby.map((n) => `"${n}"`).join(" or ")}?` : `No service called "${spoken}". Add it under Services with the most you will pay per request.`,
        nearby
      );
    }
    const wallet = assertQuaiPaymentAddress(from, this.network);
    await this.rpc.assertZone();
    const first = await this.fetcher(service.url);
    if (first.status >= 200 && first.status < 300) return { free: first, service };
    if (first.status !== 402) throw new Refusal("SERVICE_ERROR", `${service.name} answered HTTP ${first.status} instead of a price.`);
    let body: unknown;
    try {
      body = JSON.parse(first.body);
    } catch {
      body = undefined;
    }
    let ch: ParsedPaymentChallenge;
    try {
      ch = ChallengeParser.parse(first.headers, body);
    } catch (err) {
      throw new Refusal("CHALLENGE_INVALID", `${service.name}'s payment request could not be read: ${(err as Error).message}`);
    }
    this.checkChallenge(ch, service);
    const token = defaultQuaiTokenRegistry.getByAddress(ch.tokenAddress, this.network)!;
    const recipient = assertQuaiPaymentAddress(ch.recipientAddress, this.network);
    const trackerKey = token.address.toLowerCase();
    this.book.assertWithinLimits(service.asset, trackerKey, ch.amount);
    const held = await this.tokenBalance(token, wallet);
    if (held < ch.amount) throw new Refusal("INSUFFICIENT_TOKEN", `${service.name} costs ${fmt(ch.amount, token.symbol)}; you have ${fmt(held, token.symbol)}.`);
    const gasPrice = await this.gasPrice();
    const tx = await this.prepare(wallet, token.address, ERC20.encodeFunctionData("transfer", [recipient, ch.amount]), 0n, `Pay ${service.name} ${fmt(ch.amount, token.symbol)}`, {
      kind: "token-transfer",
      token: token.address,
      to: recipient,
      amount: ch.amount.toString()
    });
    await this.assertNativeCovers(wallet, 0n, [tx], gasPrice);
    return {
      plan: this.plan({
        kind: "buy",
        said,
        summary: `Pay ${service.name} ${fmt(ch.amount, token.symbol)} for ${new URL(service.url).pathname}.`,
        details: [
          { label: "Service", value: `${service.name} · ${service.url}` },
          { label: "Price", value: `${fmt(ch.amount, token.symbol)} (your ceiling: ${service.maxAmount} ${service.asset})` },
          { label: "Pays to", value: `${short(recipient)} (a one-time address for this invoice)` },
          { label: "Invoice", value: `${ch.invoiceId}, valid until ${new Date(ch.expiresAt * 1000).toLocaleTimeString()}` },
          { label: "Visibility", value: "Public: an ordinary transfer, visible on the chain" }
        ],
        from: wallet,
        txs: [tx],
        spend: { asset: service.asset, trackerKey, amount: ch.amount.toString() },
        buy: { service: service.name, url: service.url, invoiceId: ch.invoiceId, token: token.address, recipient, amount: ch.amount.toString(), expiresAt: ch.expiresAt },
        warnings: []
      }, gasPrice)
    };
  }

  private checkChallenge(ch: ParsedPaymentChallenge, service: Service): void {
    if (!challengeMatchesNetwork(this.network, ch)) {
      throw new Refusal("CHALLENGE_WRONG_NETWORK", `${service.name} wants payment on ${ch.network} (chain ${ch.chainId}), not ${this.network.title}.`);
    }
    const token = defaultQuaiTokenRegistry.getByAddress(ch.tokenAddress, this.network);
    if (!token) throw new Refusal("CHALLENGE_UNKNOWN_TOKEN", `${service.name} wants a token that is not WQUAI or WQI (${ch.tokenAddress}).`);
    if (token.symbol !== service.asset) throw new Refusal("CHALLENGE_WRONG_ASSET", `${service.name} wants ${token.symbol}; you allowed it to charge ${service.asset} only.`);
    const ceiling = parseTokenAmount(service.maxAmount, 18);
    if (ch.amount > ceiling) {
      throw new Refusal("CHALLENGE_TOO_EXPENSIVE", `${service.name} wants ${fmt(ch.amount, token.symbol)}, above the ${service.maxAmount} ${service.asset} you allowed per request.`);
    }
    if (ch.expiresAt - Math.floor(this.now() / 1000) < MIN_INVOICE_TTL_S) {
      throw new Refusal("CHALLENGE_EXPIRING", `${service.name}'s invoice expires in under ${MIN_INVOICE_TTL_S / 60} minutes, too soon to confirm and pay safely. Ask again for a fresh one.`);
    }
    try {
      assertQuaiPaymentAddress(ch.recipientAddress, this.network);
    } catch (err) {
      throw new Refusal("CHALLENGE_BAD_RECIPIENT", `${service.name}'s payment address cannot receive on ${this.network.title}: ${(err as Error).message}`);
    }
  }

  /** After the payment is final: present the proof and fetch what was paid for. */
  public async collect(plan: Plan, txHash: string): Promise<Fetched> {
    if (!plan.buy) throw new Error("ERR_INTERNAL: not a purchase");
    return this.fetcher(plan.buy.url, { headers: ChallengeParser.formatPaymentProofHeaders(plan.buy.invoiceId, txHash) });
  }

  public formatBalances(rows: Array<{ asset: string; amount: bigint }>, only?: AssetSymbol): string {
    const shown = only ? rows.filter((r) => r.asset === only) : rows;
    if (!shown.length) return `${only} is not available on ${this.network.title}.`;
    return `On ${this.network.title} you have ${shown.map((r) => fmt(r.amount, r.asset)).join(", ")}.`;
  }

}
