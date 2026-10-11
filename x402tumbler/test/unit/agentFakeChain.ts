/**
 * A fake Quai zone for the voice agent's tests: answers the JSON-RPC calls the planner makes (zone checks,
 * balances, gas price, access lists, estimates, receipts) and, when the test plays the user's wallet, applies a
 * transaction's effect and writes the receipt a real node would (status, sender, recipient, Transfer logs).
 * Nothing here touches a network.
 */

import crypto from "node:crypto";
import { QuaiRpcClient, type JsonRpcTransport } from "../../src/quai/rpc.ts";
import { QUAI_CYPRUS1, type QuaiNetwork } from "../../src/quai/networks.ts";
import { TRANSFER_TOPIC } from "../../src/quai/paymentVerifier.ts";
import { ERC20, WRAPPER } from "../../src/agent/planner.ts";
import { WQUAI_ADDRESS } from "../../src/quai/tokens.ts";

const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

export interface SentTx {
  from: string;
  to: string;
  data: string;
  value?: string;
}

export class FakeQuai {
  public native = new Map<string, bigint>();
  public tokens = new Map<string, Map<string, bigint>>();
  public receipts = new Map<string, any>();
  public txs = new Map<string, any>();
  public gasPrice = 1_000_000_000n;
  public estimate = 60_000n;
  /** When set, quai_createAccessList reports this error (the node says the call would fail). */
  public failSimulation: string | null = null;
  public chainId = "0x9";
  public calls: Array<{ method: string; params: unknown[] }> = [];
  public block = 100;

  public setNative(addr: string, v: bigint) {
    this.native.set(addr.toLowerCase(), v);
  }

  public setToken(token: string, holder: string, v: bigint) {
    const t = token.toLowerCase();
    if (!this.tokens.has(t)) this.tokens.set(t, new Map());
    this.tokens.get(t)!.set(holder.toLowerCase(), v);
  }

  public tokenBalance(token: string, holder: string): bigint {
    return this.tokens.get(token.toLowerCase())?.get(holder.toLowerCase()) ?? 0n;
  }

  public transport(): JsonRpcTransport {
    return async (method, params) => {
      this.calls.push({ method, params });
      switch (method) {
        case "quai_chainId":
          return this.chainId;
        case "quai_nodeLocation":
          return ["0x0", "0x0"];
        case "quai_gasPrice":
          return "0x" + this.gasPrice.toString(16);
        case "quai_blockNumber":
          return "0x" + this.block.toString(16);
        case "quai_getBalance":
          return "0x" + (this.native.get(String(params[0]).toLowerCase()) ?? 0n).toString(16);
        case "quai_call": {
          const tx = params[0] as { to: string; data: string };
          const parsed = ERC20.parseTransaction({ data: tx.data });
          if (parsed?.name !== "balanceOf") throw new Error(`fake chain: unsupported call ${tx.data.slice(0, 10)}`);
          return word(this.tokenBalance(tx.to, String(parsed.args[0])));
        }
        case "quai_createAccessList":
          if (this.failSimulation) return { error: this.failSimulation };
          return { accessList: [{ address: (params[0] as { to: string }).to, storageKeys: [] }], gasUsed: "0x" + this.estimate.toString(16) };
        case "quai_estimateGas":
          return "0x" + this.estimate.toString(16);
        case "quai_getTransactionReceipt":
          return this.receipts.get(String(params[0]).toLowerCase()) ?? null;
        case "quai_getTransactionByHash":
          return this.txs.get(String(params[0]).toLowerCase()) ?? null;
        default:
          throw new Error(`ERR_QUAI_RPC: ${method}: unhandled in the fake chain`);
      }
    };
  }

  public rpc(network: QuaiNetwork = QUAI_CYPRUS1): QuaiRpcClient {
    return new QuaiRpcClient({ network, transport: this.transport() });
  }

  /**
   * Plays the user's wallet and the chain: applies `tx` and records its receipt. `pending` leaves the receipt
   * unwritten (not mined yet). The tweaks let a test make the chain disagree with the plan.
   */
  public send(tx: SentTx, o: { pending?: boolean; revert?: boolean; sender?: string; transferTo?: string; transferAmount?: bigint; hash?: string } = {}): string {
    const hash = (o.hash ?? "0x" + crypto.randomBytes(32).toString("hex")).toLowerCase();
    const from = (o.sender ?? tx.from).toLowerCase();
    const to = tx.to.toLowerCase();
    const value = BigInt(tx.value ?? "0x0");
    const logs: Array<{ address: string; topics: string[]; data: string }> = [];
    if (!o.revert) {
      const erc = tx.data && tx.data !== "0x" ? ERC20.parseTransaction({ data: tx.data }) : null;
      const wrap = tx.data && tx.data !== "0x" ? WRAPPER.parseTransaction({ data: tx.data, value }) : null;
      if (erc?.name === "transfer") {
        const dest = (o.transferTo ?? String(erc.args[0])).toLowerCase();
        const amount = o.transferAmount ?? (erc.args[1] as bigint);
        this.setToken(to, from, this.tokenBalance(to, from) - amount);
        this.setToken(to, dest, this.tokenBalance(to, dest) + amount);
        logs.push({ address: to, topics: [TRANSFER_TOPIC, pad(from), pad(dest)], data: word(amount) });
      } else if (wrap?.name === "deposit" && to === WQUAI_ADDRESS.toLowerCase()) {
        this.setNative(from, (this.native.get(from) ?? 0n) - value);
        this.setToken(to, from, this.tokenBalance(to, from) + value);
        logs.push({ address: to, topics: [TRANSFER_TOPIC, pad("0x" + "0".repeat(40)), pad(from)], data: word(value) });
      } else if (wrap?.name === "withdraw" && to === WQUAI_ADDRESS.toLowerCase()) {
        const wad = wrap.args[0] as bigint;
        this.setToken(to, from, this.tokenBalance(to, from) - wad);
        this.setNative(from, (this.native.get(from) ?? 0n) + wad);
      } else if (!tx.data || tx.data === "0x") {
        this.setNative(from, (this.native.get(from) ?? 0n) - value);
        this.setNative(to, (this.native.get(to) ?? 0n) + value);
      }
    }
    this.txs.set(hash, { hash, from, to: tx.to, value: "0x" + value.toString(16), input: tx.data });
    if (!o.pending) this.mine(hash, { from, to: tx.to, logs, status: o.revert ? "0x0" : "0x1" });
    return hash;
  }

  public mine(hash: string, r: { from: string; to: string; logs: any[]; status: string }) {
    this.block += 1;
    this.receipts.set(hash.toLowerCase(), { transactionHash: hash, blockNumber: "0x" + this.block.toString(16), status: r.status, from: r.from, to: r.to, logs: r.logs, gasUsed: "0x5208" });
  }
}

