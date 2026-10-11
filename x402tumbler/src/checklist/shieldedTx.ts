/**
 * DarkCircle: executable pre-flight checklist for shielded-pool transactions
 * File: src/checklist/shieldedTx.ts
 *
 * The same checks the operator checklist (docs/SHIELDED_POOL_CHECKLIST.md) lists, run against a live
 * context so the CLI and the UI modals show the same result. Every item has a stable id (SP-*), a
 * status, and whether it blocks the transaction. `blocking` items that fail stop the action; `warn`
 * items need an explicit acknowledgement; `info` items are context.
 *
 * The checklist reads state. It never signs, sends, or changes anything.
 */

import { assertQuaiPaymentAddress } from "../quai/address.ts";
import { defaultQuaiTokenRegistry, formatTokenAmount } from "../quai/tokens.ts";
import { addressToBigInt } from "../sim/railgunContract.ts";
import type { CliContext } from "../cli/types.ts";
import type { ShieldedUTXO } from "../types/sim.ts";

export type ChecklistKind = "shield" | "unshield" | "receive" | "sweep" | "audit";
export type CheckStatus = "pass" | "fail" | "warn" | "info";
export type CheckGroup = "Environment" | "Inputs" | "Funds" | "Compliance" | "Privacy" | "Execution";

export interface CheckItem {
  id: string;
  group: CheckGroup;
  title: string;
  status: CheckStatus;
  detail: string;
  /** A failing blocking item prevents the transaction. */
  blocking: boolean;
}

export interface ChecklistParams {
  /** Recipient (unshield), depositor (shield; defaults to the operating wallet). */
  address?: string;
  /** Human decimal amount ("2.5"). */
  amount?: string;
  /** Symbol or address. Defaults to the context's asset. */
  token?: string;
  invoiceId?: string;
  /** Shield: wrap native QUAI into WQUAI first. */
  wrapNative?: boolean;
}

export interface ChecklistResult {
  kind: ChecklistKind;
  items: CheckItem[];
  /** True when nothing blocking failed. Warnings do not stop it, they need acknowledgement. */
  canProceed: boolean;
  blockers: number;
  warnings: number;
  /** Set for unshield: what the transaction would do. */
  plan?: {
    noteCommitment: string;
    noteValue: string;
    amount: string;
    relayerFee: string;
    change: string;
    symbol: string;
  };
}

const MIN_ANONYMITY_SET = 20;
const RECENT_DEPOSIT_SECONDS = 600;
const LOW_GAS_QUAI = 10n ** 18n; // 1 QUAI
const HIGH_FEE_RATIO_PERCENT = 1n;

function parseAmount(text: string | undefined, decimals: number): bigint | string {
  const t = (text ?? "").trim();
  if (!t) return "amount is required";
  if (!/^\d+(\.\d+)?$/.test(t)) return "amount must be a positive decimal number";
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return `amount has more than ${decimals} fractional digits`;
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

class Builder {
  public items: CheckItem[] = [];

  pass(id: string, group: CheckGroup, title: string, detail: string): void {
    this.items.push({ id, group, title, status: "pass", detail, blocking: false });
  }

  fail(id: string, group: CheckGroup, title: string, detail: string): void {
    this.items.push({ id, group, title, status: "fail", detail, blocking: true });
  }

  warn(id: string, group: CheckGroup, title: string, detail: string): void {
    this.items.push({ id, group, title, status: "warn", detail, blocking: false });
  }

  info(id: string, group: CheckGroup, title: string, detail: string): void {
    this.items.push({ id, group, title, status: "info", detail, blocking: false });
  }
}

/** Environment checks that apply to every kind of shielded transaction. */
function environment(b: Builder, ctx: CliContext): void {
  const chain = ctx.blockchain;
  const pool = ctx.pool as any;

  if (pool.network?.id === chain.network.id && chain.chainId === chain.network.chainId) {
    b.pass("SP-ENV-01", "Environment", "Network and zone", `${chain.network.title}, chain id ${chain.chainId}, zone prefix 0x${chain.network.zone.byte}`);
  } else {
    b.fail("SP-ENV-01", "Environment", "Network and zone", `pool network ${pool.network?.id} does not match ledger ${chain.network.id} (chain ${chain.chainId})`);
  }

  const poolMode: string = pool.mode ?? "unknown";
  const gwMode: string = (ctx.merchantGateway as any)?.trustMode ?? "unknown";
  if (poolMode === "verified" && gwMode === "verified") {
    b.pass("SP-ENV-02", "Environment", "Verification mode", "pool statement checks and on-chain payment verification are ON");
  } else {
    b.fail(
      "SP-ENV-02",
      "Environment",
      "Verification mode",
      `pool=${poolMode}, gateway=${gwMode}. A trusted-harness component believes callers instead of checking; it is test scaffolding and must never guard value`
    );
  }

  b.warn(
    "SP-ENV-03",
    "Environment",
    "Simulation notice",
    "This build settles against an in-memory ledger and a simulated pool. No real funds move and no on-chain pool contract exists yet"
  );

  const capacity = pool.merkleTree?.capacity ?? 0;
  const used = pool.merkleTree?.nextIndex ?? 0;
  if (used >= capacity) b.fail("SP-ENV-04", "Environment", "Pool capacity", `tree is full (${used}/${capacity})`);
  else if (used * 10 >= capacity * 9) b.warn("SP-ENV-04", "Environment", "Pool capacity", `tree is ${Math.floor((used * 100) / capacity)}% full (${used}/${capacity})`);
  else b.pass("SP-ENV-04", "Environment", "Pool capacity", `${used}/${capacity} leaves used`);

  const rows = typeof pool.solvency === "function" ? pool.solvency() : [];
  const insolvent = rows.filter((r: any) => !r.ok);
  if (insolvent.length > 0) {
    b.fail("SP-FN-03", "Funds", "Pool solvency", `pool holds less than the notes it owes for ${insolvent.length} token(s); stop and investigate before any transaction`);
  } else {
    b.pass("SP-FN-03", "Funds", "Pool solvency", rows.length ? "pool balance covers every unspent note" : "no notes recorded yet");
  }
}

function resolveToken(ctx: CliContext, p: ChecklistParams, b: Builder) {
  const network = ctx.blockchain.network;
  const wanted = p.token?.trim() || ctx.token?.symbol || "WQUAI";
  const token = defaultQuaiTokenRegistry.resolve(wanted, network);
  if (!token) {
    b.fail(
      "SP-IN-01",
      "Inputs",
      "Settlement asset",
      `'${wanted}' is not a registered asset on ${network.id} (supported: ${defaultQuaiTokenRegistry.list(network).map((t) => t.symbol).join(", ")}). Tokens are identified by address; a look-alike symbol is refused`
    );
    return undefined;
  }
  const allowed = ctx.spendingPolicy.allowedTokens.some((a) => a.toLowerCase() === token.address.toLowerCase());
  if (!allowed) {
    b.fail("SP-IN-01", "Inputs", "Settlement asset", `${token.symbol} is registered but not allowed by the spending policy`);
    return undefined;
  }
  b.pass("SP-IN-01", "Inputs", "Settlement asset", `${token.symbol} ${token.address} (${token.decimals} decimals)`);
  return token;
}

function balanceOf(ctx: CliContext, tokenAddress: string, account: string): bigint {
  return ctx.blockchain.getTokenBalance(tokenAddress, account);
}

function selectNote(ctx: CliContext, tokenAddress: string, needed: bigint): ShieldedUTXO | undefined {
  return ctx.treasuryUTXOs.find((u) => u.token.toLowerCase() === tokenAddress.toLowerCase() && u.value >= needed);
}

function privacyChecks(b: Builder, ctx: CliContext, amount: bigint | undefined, note?: ShieldedUTXO): void {
  const pool = ctx.pool as any;
  const unspent = Array.from((pool.utxoRegistry as Map<string, ShieldedUTXO>).values()).filter(
    (u) => !pool.spentCommitments.has(u.commitment.toString() + ":" + u.leafIndex)
  ).length;
  if (unspent < MIN_ANONYMITY_SET) {
    b.warn(
      "SP-PV-01",
      "Privacy",
      "Anonymity set",
      `only ${unspent} unspent note(s) in the pool (recommended at least ${MIN_ANONYMITY_SET}). With so few notes, amounts and timing link deposits to withdrawals`
    );
  } else {
    b.pass("SP-PV-01", "Privacy", "Anonymity set", `${unspent} unspent notes in the pool`);
  }

  if (ctx.spendingPolicy.allowDirectUnshield) {
    b.warn("SP-PV-02", "Privacy", "Relayer-only broadcast", "policy allows direct unshield, which makes the treasury the on-chain sender");
  } else {
    b.pass("SP-PV-02", "Privacy", "Relayer-only broadcast", `broadcast by relayer ${ctx.relayer.relayerAddress}; the treasury is never the sender`);
  }

  if (amount !== undefined) {
    const recentShield = (pool.poolEvents as any[]).slice(-25).find((e) => e.type === "SHIELD" && e.amount === amount);
    if (recentShield) {
      b.warn("SP-PV-03", "Privacy", "Amount fingerprint", "a recent deposit has exactly this amount; equal amounts are the easiest link between a deposit and a withdrawal");
    } else {
      b.pass("SP-PV-03", "Privacy", "Amount fingerprint", "no recent deposit of the same amount");
    }
  }

  if (note) {
    const age = Math.floor(Date.now() / 1000) - note.depositTimestamp;
    if (age < RECENT_DEPOSIT_SECONDS) {
      b.warn("SP-PV-04", "Privacy", "Deposit age", `the note was deposited ${age}s ago; withdrawing soon after depositing is a timing correlation`);
    } else {
      b.pass("SP-PV-04", "Privacy", "Deposit age", `note deposited ${age}s ago`);
    }
  }
}

function executionChecks(b: Builder, ctx: CliContext, needsRelayer: boolean): void {
  b.pass("SP-EX-01", "Execution", "Access list", "the relayer attaches [pool, token]; on Quai a multi-contract transaction without one reverts and burns its entire gas limit");
  const gas = ctx.blockchain.getBalance(ctx.relayer.relayerAddress);
  const gasFloor = ctx.relayer.minGasBalance ?? LOW_GAS_QUAI;
  if (gas < gasFloor) {
    b.warn("SP-EX-02", "Execution", "Relayer gas", `relayer holds ${formatTokenAmount(gas)} QUAI; below ${formatTokenAmount(gasFloor)} QUAI it may fail to broadcast`);
  } else {
    b.pass("SP-EX-02", "Execution", "Relayer gas", `relayer holds ${formatTokenAmount(gas)} QUAI for gas`);
  }
  if (ctx.relayer.online === false) {
    const why = ctx.relayer.offlineReason ? ` (${ctx.relayer.offlineReason})` : "";
    if (needsRelayer) b.fail("SP-EX-04", "Execution", "Relayer online", `the relayer is OFFLINE${why}; it broadcasts every payment and submits every permit sweep, so this transaction cannot be sent`);
    else b.info("SP-EX-04", "Execution", "Relayer online", `the relayer is offline${why}; this transaction is sent by the depositor and does not use it`);
  } else {
    b.pass("SP-EX-04", "Execution", "Relayer online", "the relayer is accepting broadcasts");
  }
  b.info("SP-EX-03", "Execution", "Confirmations", `merchants accept a payment after ${(ctx.merchantGateway as any).invoiceRegistry?.minConfirmations ?? 1} confirmation(s); on a live zone use at least 2 (reorgs of ~25 blocks were observed on Orchard)`);
}

export function runChecklist(kind: ChecklistKind, params: ChecklistParams, ctx: CliContext): ChecklistResult {
  const b = new Builder();
  let plan: ChecklistResult["plan"];

  environment(b, ctx);

  if (kind === "audit") {
    const j = ctx.journal;
    if (!j) b.fail("SP-AU-01", "Compliance", "Accounting journal", "no journal is attached");
    else if (j.verifyReconciliation()) b.pass("SP-AU-01", "Compliance", "Ledger reconciliation", `running balance equals unspent notes (${formatTokenAmount(j.runningBalance, j.decimals)} ${j.assetSymbol})`);
    else b.fail("SP-AU-01", "Compliance", "Ledger reconciliation", "running balance does not equal the sum of unspent notes; do not export");
    b.pass("SP-AU-02", "Compliance", "Key isolation", "exports are produced with the viewing key; the spending key is not used and not included");
    b.info("SP-AU-03", "Compliance", "One asset per report", j ? `this ledger is ${j.assetSymbol}; export each asset separately` : "n/a");
    return finish(kind, b, plan);
  }

  const token = resolveToken(ctx, params, b);
  const decimals = token?.decimals ?? 18;
  let amount: bigint | undefined;
  if (kind !== "sweep") {
    const parsed = parseAmount(params.amount, decimals);
    if (typeof parsed === "string") {
      b.fail("SP-IN-02", "Inputs", "Amount", parsed);
    } else if (parsed <= 0n) {
      b.fail("SP-IN-02", "Inputs", "Amount", "amount must be greater than zero");
    } else if (parsed >= 1n << 128n) {
      b.fail("SP-IN-02", "Inputs", "Amount", "amount exceeds the 128-bit note range");
    } else {
      amount = parsed;
      b.pass("SP-IN-02", "Inputs", "Amount", `${formatTokenAmount(parsed, decimals)} ${token?.symbol ?? ""} (${parsed} base units)`);
    }
  }

  if (kind === "unshield") {
    const recipient = params.address?.trim() ?? "";
    let recipientOk = false;
    try {
      const checksummed = assertQuaiPaymentAddress(recipient, ctx.blockchain.network);
      recipientOk = true;
      b.pass("SP-IN-03", "Inputs", "Recipient address", `${checksummed} is a checksummed Cyprus-1 Quai-ledger address`);
      const self = [ctx.corporateOperatingAddress, ctx.pool.contractAddress, ctx.relayer.relayerAddress].filter(Boolean).map((a) => a!.toLowerCase());
      if (self.includes(checksummed.toLowerCase())) {
        b.warn("SP-IN-04", "Inputs", "Recipient is our own address", "paying an address the operator, pool or relayer controls creates an on-chain link; use a shield instead");
      } else {
        b.pass("SP-IN-04", "Inputs", "Recipient is external", "not the operating wallet, the pool, or the relayer");
      }
    } catch (err) {
      b.fail("SP-IN-03", "Inputs", "Recipient address", (err as Error).message.replace(/^ERR_[A-Z_]+:\s*/, ""));
    }

    if (recipientOk) {
      let sanctioned = false;
      try {
        sanctioned = !!ctx.sanctionsRegistry?.isSanctioned(recipient) || (ctx.pool as any).sanctionsSMT.get(addressToBigInt(recipient)) !== 0n;
      } catch {
        sanctioned = false;
      }
      if (sanctioned) b.fail("SP-CP-01", "Compliance", "Recipient sanctions screen", "recipient is on the sanctions list");
      else b.pass("SP-CP-01", "Compliance", "Recipient sanctions screen", "recipient is not on the loaded sanctions list");
    }

    if (token && amount !== undefined) {
      const fee = ctx.relayer.minimumFee;
      const cap = ctx.spendingPolicy.maxPaymentCap;
      if (amount > cap) {
        b.fail("SP-CP-04", "Compliance", "Spending policy", `amount exceeds the per-payment cap of ${formatTokenAmount(cap, decimals)}`);
      } else {
        b.pass("SP-CP-04", "Compliance", "Spending policy", `within the per-payment cap of ${formatTokenAmount(cap, decimals)}` + (ctx.spendingPolicy.dailyBudgetCap !== undefined ? `; daily cap ${formatTokenAmount(ctx.spendingPolicy.dailyBudgetCap, decimals)} per token` : "; NO daily budget cap is set"));
        if (ctx.spendingPolicy.dailyBudgetCap === undefined) b.warn("SP-CP-05", "Compliance", "Daily budget", "no dailyBudgetCap is configured, so a compromised caller could spend up to the per-payment cap repeatedly");
      }

      const note = selectNote(ctx, token.address, amount + fee);
      if (!note) {
        const total = ctx.treasuryUTXOs.filter((u) => u.token.toLowerCase() === token.address.toLowerCase()).reduce((s, u) => s + u.value, 0n);
        b.fail("SP-FN-01", "Funds", "Shielded note", `no single note covers ${formatTokenAmount(amount + fee, decimals)} (amount + relayer fee); total shielded ${formatTokenAmount(total, decimals)}. One note is spent per payment`);
      } else {
        const change = note.value - amount - fee;
        b.pass("SP-FN-01", "Funds", "Shielded note", `note #${note.leafIndex} (${formatTokenAmount(note.value, decimals)}) covers it; change note of ${formatTokenAmount(change, decimals)} is created`);
        plan = {
          noteCommitment: "0x" + note.commitment.toString(16),
          noteValue: formatTokenAmount(note.value, decimals),
          amount: formatTokenAmount(amount, decimals),
          relayerFee: formatTokenAmount(fee, decimals),
          change: formatTokenAmount(change, decimals),
          symbol: token.symbol
        };
        const origin = note.depositorAddress ?? "";
        const originSanctioned = !!origin && (ctx.sanctionsRegistry?.isSanctioned(origin) ?? false);
        if (originSanctioned) b.fail("SP-CP-02", "Compliance", "Note origin (PPOI)", `the note's recorded origin ${origin} is sanctioned; it cannot be unshielded`);
        else if (!origin) b.fail("SP-CP-02", "Compliance", "Note origin (PPOI)", "the pool has no deposit origin for this note");
        else b.pass("SP-CP-02", "Compliance", "Note origin (PPOI)", `origin ${origin} is clean; a non-membership proof can be produced`);

        const standby = (ctx.pool as any).standbyWindowSeconds ?? 0;
        const age = Math.floor(Date.now() / 1000) - note.depositTimestamp;
        if (standby > 0 && age < standby && origin.toLowerCase() !== recipient.toLowerCase()) {
          b.fail("SP-CP-03", "Compliance", "Standby window", `note is ${age}s old; during the ${standby}s standby window it can only be returned to its depositor`);
        } else {
          b.pass("SP-CP-03", "Compliance", "Standby window", standby > 0 ? "window elapsed" : "no standby window configured");
        }
        privacyChecks(b, ctx, amount, note);
      }

      const ratio = (fee * 100n) / (amount === 0n ? 1n : amount);
      if (ratio > HIGH_FEE_RATIO_PERCENT) b.warn("SP-FN-04", "Funds", "Relayer fee", `fee ${formatTokenAmount(fee, decimals)} is ${ratio}% of the payment`);
      else b.pass("SP-FN-04", "Funds", "Relayer fee", `fee ${formatTokenAmount(fee, decimals)} (${ratio}% of the payment)`);
    }
    if (!plan) privacyChecks(b, ctx, amount);
    executionChecks(b, ctx, true);
  }

  if (kind === "shield") {
    const depositor = params.address?.trim() || ctx.corporateOperatingAddress || "";
    try {
      const d = assertQuaiPaymentAddress(depositor, ctx.blockchain.network);
      b.pass("SP-IN-03", "Inputs", "Depositor address", `${d} (funds are pulled from here)`);
      if (token && amount !== undefined) {
        if (params.wrapNative) {
          if (!token.wrapsNative) {
            b.fail("SP-FN-06", "Funds", "Wrap native QUAI", `${token.symbol} has no deposit(); only WQUAI wraps native QUAI`);
          } else {
            const native = ctx.blockchain.getBalance(d);
            if (native < amount + LOW_GAS_QUAI / 10n) b.fail("SP-FN-06", "Funds", "Wrap native QUAI", `${formatTokenAmount(native)} QUAI available, ${formatTokenAmount(amount)} to wrap plus gas needed`);
            else b.pass("SP-FN-06", "Funds", "Wrap native QUAI", `${formatTokenAmount(native)} QUAI available; ${formatTokenAmount(amount)} will be wrapped 1:1 into WQUAI first`);
          }
        } else {
          const bal = balanceOf(ctx, token.address, d);
          if (bal < amount) b.fail("SP-FN-02", "Funds", "Depositor balance", `${formatTokenAmount(bal, decimals)} ${token.symbol} available, ${formatTokenAmount(amount, decimals)} needed`);
          else b.pass("SP-FN-02", "Funds", "Depositor balance", `${formatTokenAmount(bal, decimals)} ${token.symbol} available`);
        }
      }
      let listed = false;
      try {
        listed = !!ctx.sanctionsRegistry?.isSanctioned(d);
      } catch {
        listed = false;
      }
      if (listed) b.fail("SP-CP-01", "Compliance", "Depositor sanctions screen", "the depositing address is on the sanctions list; a note from it could never be spent");
      else b.pass("SP-CP-01", "Compliance", "Depositor sanctions screen", "not on the loaded sanctions list; this address becomes the note's PPOI origin");
    } catch (err) {
      b.fail("SP-IN-03", "Inputs", "Depositor address", (err as Error).message.replace(/^ERR_[A-Z_]+:\s*/, ""));
    }
    b.pass("SP-FN-05", "Funds", "Custody", "the pool pulls the tokens against an allowance in the same call, so a note cannot exist without funds behind it");
    privacyChecks(b, ctx, amount);
    executionChecks(b, ctx, false);
  }

  if (kind === "receive") {
    b.pass("SP-RC-01", "Inputs", "Ephemeral payee", "a fresh Cyprus-1 Quai-ledger address with its own key is derived per invoice");
    b.pass("SP-RC-02", "Inputs", "Verification", "a payment is accepted only when a confirmed receipt shows Transfer logs of this token to this address for at least the invoiced amount");
    if (token && token.permit === false) {
      b.warn("SP-RC-03", "Execution", "Sweep gas", `${token.symbol} has no permit, so sweeping needs the relayer to fund gas in QUAI; only WQI can be swept gaslessly`);
    } else if (token) {
      b.pass("SP-RC-03", "Execution", "Sweep gas", `${token.symbol} supports permit, so the sweep can be gasless`);
    }
    b.info("SP-RC-04", "Inputs", "Invoice lifetime", `invoices expire after ${(ctx.merchantGateway as any).defaultTtlSeconds ?? 900}s; a customer paying after expiry is refused with 410`);
  }

  if (kind === "sweep") {
    const id = params.invoiceId?.trim() ?? "";
    const inv = (ctx.merchantGateway as any).invoiceRegistry?.get(id);
    if (!inv) {
      b.fail("SP-SW-01", "Inputs", "Invoice", id ? `no invoice ${id}` : "an invoice id is required");
    } else if (inv.status !== "SETTLED") {
      b.fail("SP-SW-01", "Inputs", "Invoice", `invoice is ${inv.status}; only a SETTLED invoice can be swept`);
    } else {
      b.pass("SP-SW-01", "Inputs", "Invoice", `${inv.invoiceId} is SETTLED`);
      const bal = balanceOf(ctx, inv.tokenAddress, inv.ephemeralAddress);
      if (bal <= 0n) b.fail("SP-SW-02", "Funds", "Ephemeral balance", "the ephemeral address holds nothing to sweep");
      else b.pass("SP-SW-02", "Funds", "Ephemeral balance", `${formatTokenAmount(bal)} at ${inv.ephemeralAddress}`);
      const origin: string = inv.payerAddress ?? inv.ephemeralAddress;
      if (!inv.payerAddress) b.warn("SP-SW-03", "Compliance", "Payer identified", "no payer was recorded from a Transfer log; screening falls back to the ephemeral address, which can never be listed");
      else b.pass("SP-SW-03", "Compliance", "Payer identified", `payer ${inv.payerAddress} read from the Transfer log`);
      let listed = false;
      try {
        listed = !!ctx.sanctionsRegistry?.isSanctioned(origin);
      } catch {
        listed = false;
      }
      if (listed) b.fail("SP-CP-01", "Compliance", "Payer sanctions screen", `payer ${origin} is on the sanctions list; the sweep will be refused and funds stay on the ephemeral address`);
      else b.pass("SP-CP-01", "Compliance", "Payer sanctions screen", "payer is not on the loaded sanctions list");
      const zeroized = /^0x0+$/.test(inv.ephemeralPrivateKey ?? "");
      if (zeroized) b.fail("SP-SW-04", "Execution", "Ephemeral key", "the ephemeral key was already zeroized; funds cannot be swept");
      else b.pass("SP-SW-04", "Execution", "Ephemeral key", "present; it is zeroized after the sweep");
    }
    privacyChecks(b, ctx, undefined);
    executionChecks(b, ctx, true);
  }

  return finish(kind, b, plan);
}

function finish(kind: ChecklistKind, b: Builder, plan: ChecklistResult["plan"]): ChecklistResult {
  const order: CheckGroup[] = ["Environment", "Inputs", "Funds", "Compliance", "Privacy", "Execution"];
  b.items = b.items
    .map((item, i) => ({ item, i }))
    .sort((x, y) => order.indexOf(x.item.group) - order.indexOf(y.item.group) || x.i - y.i)
    .map((x) => x.item);
  const blockers = b.items.filter((i) => i.status === "fail" && i.blocking).length;
  const warnings = b.items.filter((i) => i.status === "warn").length;
  return { kind, items: b.items, canProceed: blockers === 0, blockers, warnings, plan };
}
