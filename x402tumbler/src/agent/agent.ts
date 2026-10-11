/**
 * DarkCircle agent: the x402 agent the user talks to
 * File: src/agent/agent.ts
 *
 * One conversation turn is: what was said (a transcript or typed text) -> one intent (grammar.ts) -> either an
 * answer (balances, contacts, help), a refusal that says why, or a PLAN (planner.ts) of transactions on Quai.
 *
 * A plan moves funds only through these steps, each enforced here and not just in the page:
 *   1. offered:   shown and read back with a 3-digit code; it expires after a few minutes;
 *   2. confirmed: the user clicks Confirm or says "confirm <code>", from the same wallet on the same chain;
 *   3. signed:    the user's OWN wallet (Pelagus/Blip) signs each transaction in its own approval screen;
 *   4. verified:  the receipt must show exactly the planned effect (sender, contract, recipient, amount)
 *                 before the spend is counted against the limits and reported as done.
 * The server holds no key and sends nothing. For an x402 purchase, step 4 is followed by presenting the proof
 * to the service and returning what it sends back.
 */

import crypto from "node:crypto";
import { QuaiRpcClient } from "../quai/rpc.ts";
import { TRANSFER_TOPIC, receiptSucceeded } from "../quai/paymentVerifier.ts";
import { formatTokenAmount } from "../quai/tokens.ts";
import { DEFAULT_QUAI_NETWORK, QUAI_ORCHARD_CYPRUS1, type QuaiNetwork } from "../quai/networks.ts";
import { AgentBook, type ActivityEntry, type ActivityStatus } from "./book.ts";
import { EXAMPLES, parseCommand, type Intent } from "./grammar.ts";
import { Planner, Refusal, httpFetcher, type Fetched, type Fetcher, type Plan } from "./planner.ts";

export const AGENT_NETWORKS: readonly QuaiNetwork[] = [DEFAULT_QUAI_NETWORK, QUAI_ORCHARD_CYPRUS1];
/** After confirmation, how long the wallet may take to sign and the chain to include the transaction. */
const REPORT_WINDOW_MS = 30 * 60_000;
const MAX_RESOURCE_SHOWN = 64 * 1024;

export interface WalletInfo {
  address: string;
  chainId: number;
}

export interface Purchased {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export type AgentReply =
  | { type: "answer"; say: string; data?: unknown }
  | { type: "plan"; say: string; plan: Plan }
  | { type: "confirmed"; say: string; plan: Plan }
  | { type: "cancelled"; say: string }
  | { type: "refusal"; say: string; code: string; nearby?: string[] };

type PlanState = "offered" | "confirmed" | "sent" | "paid" | "done" | "failed" | "cancelled";

interface Tracked {
  plan: Plan;
  state: PlanState;
  confirmedAt?: number;
  txHashes: string[];
  verified: boolean[];
  result?: Purchased;
  error?: string;
}

const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

export class VoiceAgent {
  public readonly book: AgentBook;
  private readonly rpcFor: (network: QuaiNetwork) => QuaiRpcClient;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly plans = new Map<string, Tracked>();
  private readonly rpcs = new Map<string, QuaiRpcClient>();
  /** The plan "confirm <code>" and "cancel" refer to. */
  private current: string | null = null;

  constructor(o: { book?: AgentBook; rpcFactory?: (network: QuaiNetwork) => QuaiRpcClient; fetcher?: Fetcher; now?: () => number } = {}) {
    this.book = o.book ?? new AgentBook();
    this.rpcFor = (network) => {
      let rpc = this.rpcs.get(network.id);
      if (!rpc) {
        rpc = o.rpcFactory ? o.rpcFactory(network) : new QuaiRpcClient({ network });
        this.rpcs.set(network.id, rpc);
      }
      return rpc;
    };
    this.fetcher = o.fetcher ?? httpFetcher;
    this.now = o.now ?? Date.now;
  }

  private planner(network: QuaiNetwork): Planner {
    return new Planner({ rpc: this.rpcFor(network), book: this.book, fetcher: this.fetcher, now: this.now });
  }

  private activity(e: Omit<ActivityEntry, "at"> & { at?: number }): void {
    this.book.log({ at: this.now(), ...e });
  }

  /** The wallet must be connected, on the network's chain, before anything that reads it or spends from it. */
  private requireWallet(network: QuaiNetwork, wallet?: WalletInfo): WalletInfo {
    if (!wallet?.address) throw new Refusal("WALLET_NOT_CONNECTED", "Connect your wallet first (Pelagus, or open this page in Blip).");
    if (Number(wallet.chainId) !== network.chainId) {
      throw new Refusal("WALLET_WRONG_CHAIN", `Your wallet is on chain ${wallet.chainId}; switch it to ${network.title} (chain ${network.chainId}).`);
    }
    return wallet;
  }

  /** One turn: `text` is what was heard or typed. */
  public async say(text: string, o: { network: QuaiNetwork; wallet?: WalletInfo }): Promise<AgentReply> {
    const parsed = parseCommand(text);
    const said = String(text ?? "").slice(0, 300);
    const id = crypto.randomBytes(6).toString("hex");
    if (!parsed.ok) {
      this.activity({ id, network: o.network.id, said, kind: "unparsed", summary: parsed.message, status: "refused", txHashes: [] });
      return { type: "refusal", say: parsed.message, code: parsed.code };
    }
    try {
      return await this.dispatch(parsed.intent, said, id, o);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const refusal = err instanceof Refusal ? err : new Refusal(/^ERR_([A-Z0-9_]+)/.exec(message)?.[1] ?? "ERROR", humanize(message));
      this.activity({ id, network: o.network.id, said, kind: parsed.intent.kind, summary: refusal.message, status: "refused", txHashes: [] });
      return { type: "refusal", say: refusal.message, code: refusal.code, nearby: refusal.nearby };
    }
  }

  private async dispatch(intent: Intent, said: string, id: string, o: { network: QuaiNetwork; wallet?: WalletInfo }): Promise<AgentReply> {
    const answer = (say: string, data?: unknown): AgentReply => {
      this.activity({ id, network: o.network.id, said, kind: intent.kind, summary: say, status: "answered", txHashes: [] });
      return { type: "answer", say, data };
    };
    switch (intent.kind) {
      case "help":
        return answer(`You can say: ${EXAMPLES.join("; ")}. Anything that moves funds is read back first and needs your confirmation, then your wallet's.`, { examples: EXAMPLES });
      case "contacts": {
        const list = this.book.listContacts();
        return answer(list.length ? `Your contacts: ${list.map((c) => c.name).join(", ")}.` : "You have no contacts yet. Add one under Contacts.", { contacts: list });
      }
      case "services": {
        const list = this.book.listServices();
        return answer(list.length ? `You can buy from: ${list.map((s) => s.name).join(", ")}.` : "You have no services yet. Add one under Services.", { services: list });
      }
      case "cancel": {
        const t = this.current ? this.plans.get(this.current) : undefined;
        if (!t || !(t.state === "offered" || t.state === "confirmed")) return answer("There is nothing waiting to cancel.");
        return this.cancel(t.plan.id);
      }
      case "confirm": {
        if (!this.current) throw new Refusal("NOTHING_TO_CONFIRM", "There is no plan waiting for confirmation.");
        const plan = this.confirm(this.current, intent.code, o.wallet);
        return { type: "confirmed", say: `Confirmed. Check your wallet to approve ${plan.txs.length === 1 ? "the transaction" : `${plan.txs.length} transactions`}.`, plan };
      }
      case "balance": {
        const wallet = this.requireWallet(o.network, o.wallet);
        const planner = this.planner(o.network);
        const rows = await planner.balances(wallet.address);
        return answer(planner.formatBalances(rows, intent.asset), { balances: rows.map((r) => ({ asset: r.asset, amount: formatTokenAmount(r.amount) })) });
      }
      case "buy": {
        const wallet = this.requireWallet(o.network, o.wallet);
        const r = await this.planner(o.network).planBuy(intent.service, said, wallet.address);
        if ("free" in r) return answer(`${r.service.name} answered without asking for payment.`, { resource: shown(r.free) });
        return this.offer(r.plan);
      }
      default: {
        const wallet = this.requireWallet(o.network, o.wallet);
        const plan = await this.planner(o.network).build(intent, said, wallet.address);
        return this.offer(plan);
      }
    }
  }

  private offer(plan: Plan): AgentReply {
    // a new plan replaces one still waiting: "confirm" must always mean the plan just read back
    if (this.current) {
      const prev = this.plans.get(this.current);
      if (prev && prev.state === "offered") this.setState(prev, "cancelled", "replaced by a newer request");
    }
    this.plans.set(plan.id, { plan, state: "offered", txHashes: [], verified: plan.txs.map(() => false) });
    this.current = plan.id;
    this.prune();
    this.activity({ id: plan.id, network: plan.network.id, said: plan.said, kind: plan.kind, summary: plan.summary, status: "planned", txHashes: [] });
    const fee = formatTokenAmount(BigInt(plan.maxFeeWei)).replace(/\.0$/, "");
    return { type: "plan", say: `${plan.summary} Network fee at most ${fee} QUAI. To go ahead, say confirm ${plan.code.split("").join(" ")}, or press Confirm.`, plan };
  }

  private setState(t: Tracked, state: PlanState, detail?: string): void {
    t.state = state;
    if (detail) t.error = detail;
    const status: ActivityStatus = state === "offered" ? "planned" : state === "paid" ? "sent" : state;
    this.activity({ id: t.plan.id, network: t.plan.network.id, said: t.plan.said, kind: t.plan.kind, summary: t.plan.summary, status, txHashes: [...t.txHashes], detail });
  }

  private tracked(planId: string): Tracked {
    const t = this.plans.get(String(planId ?? ""));
    if (!t) throw new Refusal("PLAN_UNKNOWN", "That plan is not known (it may have expired). Say the request again.");
    return t;
  }

  /** Step 2. The code must match, the plan must still be fresh, and the wallet must be the one it was built for. */
  public confirm(planId: string, code: unknown, wallet?: WalletInfo): Plan {
    const t = this.tracked(planId);
    if (t.state !== "offered") throw new Refusal("PLAN_NOT_OPEN", `That plan is ${t.state}, not waiting for confirmation.`);
    if (this.now() > t.plan.expiresAt) {
      this.setState(t, "cancelled", "expired before confirmation");
      throw new Refusal("PLAN_EXPIRED", "That plan expired before it was confirmed; balances and fees may have changed. Say the request again.");
    }
    if (String(code ?? "") !== t.plan.code) throw new Refusal("CODE_MISMATCH", `That is not this plan's code. Say confirm ${t.plan.code.split("").join(" ")}.`);
    if (!wallet || wallet.address.toLowerCase() !== t.plan.from.toLowerCase() || Number(wallet.chainId) !== t.plan.network.chainId) {
      throw new Refusal("WALLET_CHANGED", "Your wallet's account or network changed since this plan was made. Say the request again.");
    }
    t.confirmedAt = this.now();
    this.setState(t, "confirmed");
    return t.plan;
  }

  public cancel(planId: string): AgentReply {
    const t = this.tracked(planId);
    if (!(t.state === "offered" || t.state === "confirmed")) throw new Refusal("PLAN_NOT_OPEN", `That plan is ${t.state}; it can no longer be cancelled here.`);
    this.setState(t, "cancelled", "cancelled by the user");
    if (this.current === planId) this.current = null;
    return { type: "cancelled", say: "Cancelled. Nothing was sent." };
  }

  /**
   * Step 4. The page reports the hash the wallet returned for transaction `index`. Pending until mined; then the
   * receipt must show the planned effect exactly, or the plan fails and nothing is counted.
   */
  public async report(planId: string, index: number, txHash: string): Promise<{ status: "pending" | "verified" | "done" | "paid" | "failed"; say: string; result?: Purchased }> {
    const t = this.tracked(planId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) throw new Refusal("BAD_TX_HASH", "That does not look like a transaction hash.");
    if (!Number.isInteger(index) || index < 0 || index >= t.plan.txs.length) throw new Refusal("BAD_TX_INDEX", "No such transaction in this plan.");
    if (!(t.state === "confirmed" || t.state === "sent")) {
      if (t.state === "done" || t.state === "paid") return { status: t.state, say: "Already done.", result: t.result };
      throw new Refusal("PLAN_NOT_CONFIRMED", `That plan is ${t.state}; only a confirmed plan's transactions are accepted.`);
    }
    if (this.now() > (t.confirmedAt ?? 0) + REPORT_WINDOW_MS) throw new Refusal("PLAN_STALE", "This plan was confirmed too long ago to be reported now.");
    const known = t.txHashes[index];
    if (known && known.toLowerCase() !== txHash.toLowerCase()) throw new Refusal("TX_ALREADY_REPORTED", "A different transaction was already reported for this step.");
    t.txHashes[index] = txHash;
    if (t.state === "confirmed") this.setState(t, "sent");

    const rpc = this.rpcFor(networkOf(t.plan));
    const receipt = await rpc.getTransactionReceipt(txHash).catch(() => null);
    if (!receipt || !receipt.blockNumber) return { status: "pending", say: "Waiting for the network to include the transaction…" };

    const problem = await this.mismatch(t.plan, index, receipt, rpc, txHash);
    if (problem) {
      this.setState(t, "failed", problem);
      return { status: "failed", say: `The transaction did not do what was planned: ${problem}` };
    }
    t.verified[index] = true;
    if (!t.verified.every(Boolean)) return { status: "verified", say: `Step ${index + 1} of ${t.plan.txs.length} confirmed on chain.` };

    if (t.plan.spend) this.book.recordSpend(t.plan.spend.trackerKey, BigInt(t.plan.spend.amount));
    if (t.plan.kind === "buy") {
      this.setState(t, "paid");
      return this.collect(planId);
    }
    this.setState(t, "done");
    if (this.current === planId) this.current = null;
    return { status: "done", say: `Done: ${t.plan.summary.replace(/\.$/, "")}. Transaction ${short(txHash)}.` };
  }

  /** For a paid purchase: present the proof and fetch the resource. The service may first want more confirmations. */
  public async collect(planId: string): Promise<{ status: "paid" | "done" | "failed"; say: string; result?: Purchased }> {
    const t = this.tracked(planId);
    if (t.state === "done") return { status: "done", say: "Already collected.", result: t.result };
    if (t.state !== "paid" || !t.plan.buy) throw new Refusal("PLAN_NOT_PAID", "That purchase has not been paid yet.");
    const got = await this.planner(networkOf(t.plan)).collect(t.plan, t.txHashes[0]);
    if (got.status >= 200 && got.status < 300) {
      t.result = shown(got);
      this.setState(t, "done");
      if (this.current === planId) this.current = null;
      return { status: "done", say: `Paid ${t.plan.buy.service}, and it delivered.`, result: t.result };
    }
    if (got.status === 402) return { status: "paid", say: `Paid. ${t.plan.buy.service} is waiting for more confirmations before it delivers; trying again shortly.` };
    this.setState(t, "failed", `the service answered HTTP ${got.status} after payment`);
    return { status: "failed", say: `Paid, but ${t.plan.buy.service} answered HTTP ${got.status} instead of delivering. The payment's transaction is ${short(t.txHashes[0])}; keep it as proof.` };
  }

  /** What the receipt shows that differs from the plan, or null when it matches exactly. */
  private async mismatch(plan: Plan, index: number, receipt: NonNullable<Awaited<ReturnType<QuaiRpcClient["getTransactionReceipt"]>>>, rpc: QuaiRpcClient, txHash: string): Promise<string | null> {
    const tx = plan.txs[index];
    const lower = (s?: string | null) => String(s ?? "").toLowerCase();
    if (!receiptSucceeded(receipt.status)) return "it reverted.";
    if (receipt.from && lower(receipt.from) !== lower(plan.from)) return `it was sent by ${receipt.from}, not your wallet ${plan.from}.`;
    if (lower(receipt.to) !== lower(tx.to)) return `it went to ${receipt.to ?? "nowhere"}, not ${tx.to}.`;
    const e = tx.expect;
    if (e.kind === "token-transfer") {
      const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
      const paid = (receipt.logs ?? [])
        .filter((l) => lower(l.address) === lower(e.token) && l.topics?.length === 3 && lower(l.topics[0]) === TRANSFER_TOPIC && lower(l.topics[1]) === pad(plan.from) && lower(l.topics[2]) === pad(e.to))
        .reduce((s, l) => s + (/^0x[0-9a-fA-F]{64}$/.test(l.data) ? BigInt(l.data) : 0n), 0n);
      if (paid < BigInt(e.amount)) return `it moved ${formatTokenAmount(paid)} to ${e.to}, not ${formatTokenAmount(BigInt(e.amount))}.`;
    } else if (e.kind === "native") {
      const sent = await rpc.request<{ to?: string; value?: string } | null>("quai_getTransactionByHash", [txHash]).catch(() => null);
      if (!sent || lower(sent.to) !== lower(e.to) || BigInt(sent.value ?? "0x0") !== BigInt(e.value)) {
        return `its recipient or amount differs from the plan (${sent ? `${sent.to}, ${formatTokenAmount(BigInt(sent.value ?? "0x0"))} QUAI` : "the transaction could not be read"}).`;
      }
    }
    return null;
  }

  /** The plan as the page shows it, by id. */
  public plan(planId: string): { plan: Plan; state: PlanState; txHashes: string[]; result?: Purchased; error?: string } {
    const t = this.tracked(planId);
    return { plan: t.plan, state: t.state, txHashes: [...t.txHashes], result: t.result, error: t.error };
  }

  private prune(): void {
    const cutoff = this.now() - REPORT_WINDOW_MS * 2;
    for (const [id, t] of this.plans) if (t.plan.createdAt < cutoff && id !== this.current) this.plans.delete(id);
  }
}

function networkOf(plan: Plan): QuaiNetwork {
  return AGENT_NETWORKS.find((n) => n.id === plan.network.id) ?? DEFAULT_QUAI_NETWORK;
}

function shown(f: Fetched): Purchased {
  return { status: f.status, contentType: f.contentType, body: f.body.slice(0, MAX_RESOURCE_SHOWN), truncated: f.truncated || f.body.length > MAX_RESOURCE_SHOWN };
}

/** A node or library message, without the code prefix, for reading aloud. */
function humanize(message: string): string {
  return message.replace(/^ERR_[A-Z0-9_]+:\s*/, "").slice(0, 240) || "Something went wrong.";
}

