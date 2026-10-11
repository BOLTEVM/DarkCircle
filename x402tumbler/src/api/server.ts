/**
 * DarkCircle: local API for the operator UI
 * File: src/api/server.ts
 *
 * A small HTTP server that fronts the SIMULATED environment for the modal UI in ui/. It exists so a
 * browser can drive the same code paths as the CLI; it adds no logic of its own to the money flow. Each
 * action re-runs the pre-flight checklist server-side and refuses when a blocking check fails or when
 * warnings were not acknowledged, so the UI cannot be used to skip a gate.
 *
 * Both settlement assets are live at once: WQUAI and WQI each have their own pool, relayer, gateway,
 * treasury and journal on one shared ledger (see createMultiAssetEnvironment). A request is routed to an
 * asset by its `token` field (or `?asset=`), and invoice-scoped requests (sweep, simulated payment) by the
 * invoice's owner, so an action can never reach the wrong pool.
 *
 * Hardening (it is a local tool, but browsers can be tricked into calling localhost):
 *  - binds to the loopback interface only;
 *  - rejects any Host that is not loopback (DNS rebinding) and any cross-site Origin;
 *  - every /api call needs the per-process session token that only the served page receives;
 *  - JSON bodies only, capped at 64 KiB; a strict CSP forbids inline script and third-party origins.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMultiAssetEnvironment, type MultiAssetEnvironment } from "../cli/context.ts";
import { runCli } from "../cli/index.ts";
import { runChecklist, type ChecklistKind, type ChecklistParams, type ChecklistResult } from "../checklist/shieldedTx.ts";
import { executeShield } from "../actions/shield.ts";
import { parseTokenAmount } from "../cli/parser.ts";
import { defaultQuaiTokenRegistry, formatTokenAmount } from "../quai/tokens.ts";
import { ERC20_ABI } from "../sim/erc20Token.ts";
import { SIM_MERCHANT_ADDRESS } from "../sim/defaults.ts";
import { ethers } from "ethers";
import type { CliContext } from "../cli/types.ts";
import type { PersistenceManager } from "../persistence/manager.ts";
import { VoiceAgent } from "../agent/agent.ts";
import type { AgentBook } from "../agent/book.ts";
import type { Fetcher } from "../agent/planner.ts";
import { AgentRouteError, handleAgentRoute, handleTranscribe } from "../agent/routes.ts";
import { LocalTranscriber, MAX_AUDIO_BYTES } from "../voice/transcriber.ts";
import type { QuaiNetwork } from "../quai/networks.ts";
import type { QuaiRpcClient } from "../quai/rpc.ts";
// @admin:begin
import { createAdminModule, type AdminModule, type AdminOptions } from "../admin/index.ts";
// @admin:end

const MAX_BODY = 64 * 1024;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, "..", "..", "ui");
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/theme.js": { file: "theme.js", type: "text/javascript; charset=utf-8" },
  "/agent.js": { file: "agent.js", type: "text/javascript; charset=utf-8" },
  "/wallet.js": { file: "wallet.js", type: "text/javascript; charset=utf-8" }
};

export interface ApiServerOptions {
  /** Asset shown first. Both assets are always live. */
  asset?: string;
  port?: number;
  envFactory?: () => MultiAssetEnvironment;
  /**
   * Durable, encrypted state. When given, the server restores the newest snapshot that verifies (refusing to
   * start on a key mismatch) and saves after every state-changing action.
   */
  persistence?: PersistenceManager;
  /**
   * The voice agent (src/agent): it works on the REAL Quai network through the user's wallet, never on the
   * simulation. `transcriber: null` turns speech-to-text off; the other fields replace the network and HTTP
   * access (tests) or the book's storage (a data directory).
   */
  agent?: {
    book?: AgentBook;
    rpcFactory?: (network: QuaiNetwork) => QuaiRpcClient;
    fetcher?: Fetcher;
    transcriber?: LocalTranscriber | null;
  };
  // @admin:begin
  /** Turns on the admin console (its own credential; see src/admin). Redacted from production builds. */
  admin?: AdminOptions;
  // @admin:end
}

/** Which snapshot the running state was restored from, if any. */
export interface RecoveryNotice {
  seq: number;
  savedAt: string;
  skipped: number;
}

export interface ApiState {
  env: MultiAssetEnvironment;
  /** Symbol of the asset the dashboard is showing. */
  active: string;
  /** The active asset's full context (its pool, relayer, gateway, treasury and journal). */
  readonly ctx: CliContext;
  /** Durable store, when persistence is on. Replaceable at runtime. */
  persistence?: PersistenceManager;
  /** Set when the state was restored from a snapshot at start-up (or later, by a restore). */
  recovery: RecoveryNotice | null;
}

export interface RunningApi {
  server: http.Server;
  port: number;
  token: string;
  url: string;
  state: ApiState;
  agent: VoiceAgent;
  // @admin:begin
  admin: AdminModule | null;
  // @admin:end
  close(): Promise<void>;
}

class ApiError extends Error {
  status: number;
  code: string;
  extra?: unknown;
  constructor(status: number, code: string, message: string, extra?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** JSON with bigint support (bigint -> decimal string). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function short(hex: string, n = 10): string {
  return hex.length > 2 * n + 3 ? `${hex.slice(0, n + 2)}…${hex.slice(-n)}` : hex;
}

function fmt(v: bigint, decimals = 18): string {
  return formatTokenAmount(v, decimals);
}

function shieldedTotal(ctx: CliContext): bigint {
  return ctx.treasuryUTXOs.filter((u) => u.token.toLowerCase() === ctx.token!.address.toLowerCase()).reduce((s, u) => s + u.value, 0n);
}

/** One row per asset: what the pools overview shows. */
function overview(env: MultiAssetEnvironment) {
  return env.assets.map((symbol) => {
    const l = env.lanes[symbol];
    const reg = defaultQuaiTokenRegistry.getBySymbol(symbol, l.blockchain.network)!;
    const decimals = reg.decimals;
    const ps = (l.pool as any).status();
    return {
      symbol,
      name: reg.name,
      address: reg.address,
      decimals,
      permit: reg.permit,
      wrapsNative: reg.wrapsNative,
      poolAddress: ps.contractAddress,
      poolMode: ps.mode,
      poolBalance: fmt(l.token!.balanceOf(l.pool.contractAddress), decimals),
      shielded: fmt(shieldedTotal(l), decimals),
      noteCount: l.treasuryUTXOs.length,
      leafCount: ps.leafCount,
      solvent: (l.pool as any).solvency().every((r: any) => r.ok),
      gatewayMode: (l.merchantGateway as any).trustMode,
      sweepMode: (l.merchantGateway.sweeper as any).gasSponsorshipMode,
      relayerFee: fmt(l.relayer.minimumFee, decimals),
      relayerOnline: l.relayer.online,
      openInvoices: (l.merchantGateway as any).invoiceRegistry.size
    };
  });
}

function persistenceBrief(state: ApiState) {
  if (!state.persistence) return { enabled: false };
  const s = state.persistence.status();
  return {
    enabled: true,
    autosave: s.autosave,
    snapshots: s.snapshots.length,
    lastSavedAt: s.lastSavedAt,
    lastSavedSeq: s.lastSavedSeq,
    dirty: s.dirty,
    saving: s.saving,
    lastError: s.lastError,
    recovery: state.recovery
  };
}

function status(state: ApiState, ctx: CliContext) {
  const pool = ctx.pool as any;
  const decimals = ctx.token?.decimals ?? 18;
  const tokenAddr = ctx.token!.address;
  const ps = pool.status();
  return {
    simulation: true,
    active: ctx.token!.symbol,
    persistence: persistenceBrief(state),
    assets: overview(state.env),
    network: { id: ctx.blockchain.network.id, title: ctx.blockchain.network.title, chainId: ctx.blockchain.chainId, zone: ctx.blockchain.network.zone.name, zonePrefix: "0x" + ctx.blockchain.network.zone.byte },
    asset: { symbol: ctx.token!.symbol, address: tokenAddr, decimals },
    tokens: defaultQuaiTokenRegistry.list(ctx.blockchain.network).map((t) => ({ symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, wrapsNative: t.wrapsNative, permit: t.permit })),
    pool: {
      mode: ps.mode,
      address: ps.contractAddress,
      root: "0x" + ps.root.toString(16),
      leafCount: ps.leafCount,
      capacity: ps.capacity,
      spentNullifiers: ps.spentNullifiers,
      standbyWindowSeconds: ps.standbyWindowSeconds,
      ppoiValidatorAttached: ps.ppoiValidatorAttached,
      solvent: pool.solvency().every((r: any) => r.ok),
      balance: fmt(ctx.token!.balanceOf(pool.contractAddress), decimals)
    },
    gateway: {
      trustMode: (ctx.merchantGateway as any).trustMode,
      sweepMode: (ctx.merchantGateway.sweeper as any).gasSponsorshipMode,
      minConfirmations: (ctx.merchantGateway as any).invoiceRegistry.minConfirmations,
      openInvoices: (ctx.merchantGateway as any).invoiceRegistry.size
    },
    relayer: { address: ctx.relayer.relayerAddress, online: ctx.relayer.online, offlineReason: ctx.relayer.offlineReason ?? null, minimumFee: fmt(ctx.relayer.minimumFee, decimals), nativeBalance: fmt(ctx.blockchain.getBalance(ctx.relayer.relayerAddress)) },
    balances: {
      shielded: fmt(shieldedTotal(ctx), decimals),
      noteCount: ctx.treasuryUTXOs.length,
      operatingToken: fmt(ctx.token!.balanceOf(ctx.corporateOperatingAddress!), decimals),
      operatingNative: fmt(ctx.blockchain.getBalance(ctx.corporateOperatingAddress!)),
      operatingAddress: ctx.corporateOperatingAddress
    },
    policy: {
      maxPaymentCap: fmt(ctx.spendingPolicy.maxPaymentCap, decimals),
      dailyBudgetCap: ctx.spendingPolicy.dailyBudgetCap !== undefined ? fmt(ctx.spendingPolicy.dailyBudgetCap, decimals) : null,
      minInvoiceTtlSeconds: ctx.spendingPolicy.minInvoiceTtlSeconds ?? null,
      allowDirectUnshield: !!ctx.spendingPolicy.allowDirectUnshield
    },
    block: ctx.blockchain.currentBlockNumber
  };
}

function notes(ctx: CliContext) {
  const pool = ctx.pool as any;
  const decimals = ctx.token?.decimals ?? 18;
  const symbolOf = (a: string) => defaultQuaiTokenRegistry.getByAddress(a, ctx.blockchain.network)?.symbol ?? "?";
  return {
    asset: ctx.token!.symbol,
    notes: ctx.treasuryUTXOs.map((u) => ({
      leafIndex: u.leafIndex,
      commitment: short("0x" + u.commitment.toString(16)),
      value: fmt(u.value, decimals),
      symbol: symbolOf(u.token),
      origin: u.depositorAddress ?? null,
      memo: u.memo,
      depositedAt: u.depositTimestamp
    })),
    events: (pool.poolEvents as any[]).slice(-25).reverse().map((e) => ({
      type: e.type,
      amount: fmt(e.amount, decimals),
      symbol: symbolOf(e.token),
      block: e.blockNumber,
      txHash: e.txHash ?? null,
      recipient: e.recipient ?? null,
      fee: e.fee !== undefined ? fmt(e.fee, decimals) : null,
      leafIndex: e.leafIndex ?? null
    }))
  };
}

/** Invoices of every asset, newest first. */
function invoices(env: MultiAssetEnvironment) {
  const rows: any[] = [];
  for (const symbol of env.assets) {
    const reg = (env.lanes[symbol].merchantGateway as any).invoiceRegistry as Map<string, any>;
    for (const i of reg.values()) rows.push(i);
  }
  return rows
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map((i) => ({
      invoiceId: i.invoiceId,
      status: i.status,
      amount: fmt(i.requiredAmount, i.tokenDecimals),
      symbol: i.tokenSymbol,
      resource: i.resourceUri,
      ephemeralAddress: i.ephemeralAddress,
      payer: i.payerAddress ?? null,
      expiresAt: i.expiresAt,
      settlementTxHash: i.settlementTxHash ?? null
    }));
}

function journal(ctx: CliContext) {
  const j = ctx.journal;
  if (!j) return { asset: null, entries: [] };
  return {
    asset: j.assetSymbol,
    reconciled: j.verifyReconciliation(),
    entries: j.entries.slice(-50).reverse().map((e) => ({
      journalId: e.journalId,
      timestamp: e.timestampIso,
      direction: e.direction,
      type: e.transactionType,
      gross: fmt(e.grossAmount, j.decimals),
      fee: fmt(e.feeAmount, j.decimals),
      net: fmt(e.netAmount, j.decimals),
      counterparty: e.counterpartyAddress,
      txHash: e.txHash,
      runningBalance: fmt(e.runningBalance, j.decimals),
      ppoi: e.ppoiStatus
    }))
  };
}

const KINDS: ChecklistKind[] = ["shield", "unshield", "receive", "sweep", "audit"];

function asString(v: unknown, max = 200): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) throw new ApiError(400, "BAD_REQUEST", "invalid field");
  return v;
}

function checkParams(body: any): ChecklistParams {
  return {
    address: asString(body?.address),
    amount: asString(body?.amount, 64),
    token: asString(body?.token, 64),
    invoiceId: asString(body?.invoiceId, 80),
    wrapNative: body?.wrapNative === true
  };
}

/** The lane that owns an invoice, so a sweep can never be routed to the wrong pool. */
function laneOfInvoice(state: ApiState, invoiceId: string | undefined): CliContext | undefined {
  if (!invoiceId) return undefined;
  for (const symbol of state.env.assets) {
    const lane = state.env.lanes[symbol];
    if ((lane.merchantGateway as any).invoiceRegistry.get(invoiceId)) return lane;
  }
  return undefined;
}

/** Picks the asset lane for a request: an invoice's owner, else the named token, else the active asset. */
function laneFor(state: ApiState, p: { token?: string; invoiceId?: string }): CliContext {
  const byInvoice = laneOfInvoice(state, p.invoiceId);
  if (byInvoice) return byInvoice;
  if (p.token) {
    const reg = defaultQuaiTokenRegistry.resolve(p.token);
    if (!reg || !state.env.lanes[reg.symbol]) throw new ApiError(400, "BAD_REQUEST", `unknown asset '${p.token}'`);
    return state.env.lanes[reg.symbol];
  }
  return state.ctx;
}

/** Runs the checklist and enforces it: blockers stop the action, warnings need acknowledgement. */
function gate(ctx: CliContext, kind: ChecklistKind, params: ChecklistParams, acknowledged: boolean): ChecklistResult {
  const result = runChecklist(kind, params, ctx);
  if (!result.canProceed) {
    throw new ApiError(422, "CHECKLIST_BLOCKED", `${result.blockers} blocking check(s) failed`, result);
  }
  if (result.warnings > 0 && !acknowledged) {
    throw new ApiError(409, "ACKNOWLEDGEMENT_REQUIRED", `${result.warnings} warning(s) must be acknowledged`, result);
  }
  return result;
}

function parseCli(res: { exitCode: number; stdout: string; stderr: string }) {
  if (res.exitCode !== 0) {
    throw new ApiError(422, "ACTION_FAILED", (res.stderr || res.stdout || "action failed").replace(/^ERROR:\s*/, ""));
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { output: res.stdout };
  }
}

async function handle(state: ApiState, opts: ApiServerOptions, method: string, url: string, body: any): Promise<unknown> {
  const [pathname, query = ""] = url.split("?");
  const route = `${method} ${pathname}`;
  const ack = body?.acknowledged === true;
  const asset = new URLSearchParams(query).get("asset") ?? undefined;
  if (asset && !defaultQuaiTokenRegistry.resolve(asset)) throw new ApiError(400, "BAD_REQUEST", `unknown asset '${asset}'`);
  const view = laneFor(state, { token: asset });

  switch (route) {
    case "GET /api/status":
      return status(state, view);
    case "GET /api/notes":
      return notes(view);
    case "GET /api/invoices":
      return { invoices: invoices(state.env) };
    case "GET /api/journal":
      return journal(view);

    case "POST /api/checklist": {
      const kind = body?.kind as ChecklistKind;
      if (!KINDS.includes(kind)) throw new ApiError(400, "BAD_REQUEST", `kind must be one of ${KINDS.join(", ")}`);
      const params = checkParams(body);
      return runChecklist(kind, params, laneFor(state, params));
    }

    case "POST /api/shield": {
      const params = checkParams(body);
      const ctx = laneFor(state, params);
      gate(ctx, "shield", params, ack);
      try {
        const r = executeShield(ctx, {
          amount: parseTokenAmount(params.amount ?? "", ctx.token!.decimals),
          token: params.token,
          depositor: params.address,
          wrapNative: params.wrapNative
        });
        return { status: "CONFIRMED", ...r };
      } catch (err) {
        throw new ApiError(422, "ACTION_FAILED", (err as Error).message);
      }
    }

    case "POST /api/pay": {
      const params = checkParams(body);
      const ctx = laneFor(state, params);
      const plan = gate(ctx, "unshield", params, ack);
      const args = ["pay", "--recipient", params.address!, "--amount", params.amount!, "--json"];
      if (params.token) args.push("--token", params.token);
      return { ...parseCli(await runCli(args, ctx)), plan: plan.plan };
    }

    case "POST /api/invoice": {
      const params = checkParams(body);
      const ctx = laneFor(state, params);
      gate(ctx, "receive", params, ack);
      const args = ["invoice", "--amount", params.amount!, "--json"];
      if (params.token) args.push("--token", params.token);
      return parseCli(await runCli(args, ctx));
    }

    case "POST /api/invoice/simulate-payment": {
      // SIMULATION ONLY: plays the customer's wallet on the in-memory ledger.
      const id = asString(body?.invoiceId, 80);
      const ctx = laneOfInvoice(state, id);
      if (!ctx) throw new ApiError(404, "NOT_FOUND", "no such invoice");
      const inv = (ctx.merchantGateway as any).invoiceRegistry.get(id);
      const token = ctx.blockchain.getToken(inv.tokenAddress);
      if (!token) throw new ApiError(422, "ACTION_FAILED", "token not deployed");
      token.mint(SIM_MERCHANT_ADDRESS, inv.requiredAmount);
      const r = ctx.blockchain.executeTransaction({
        from: SIM_MERCHANT_ADDRESS,
        to: token.address,
        data: new ethers.Interface(ERC20_ABI).encodeFunctionData("transfer", [inv.ephemeralAddress, inv.requiredAmount])
      });
      if (r.status !== 1) throw new ApiError(422, "ACTION_FAILED", r.error ?? "transfer reverted");
      const verified = await (ctx.merchantGateway as any).verifyPaymentAsync(inv.invoiceId, r.transactionHash);
      return { simulated: true, asset: token.symbol, txHash: r.transactionHash, verified: verified.success, error: verified.error ?? null, statusCode: verified.statusCode };
    }

    case "POST /api/sweep": {
      const params = checkParams(body);
      const ctx = laneOfInvoice(state, params.invoiceId) ?? laneFor(state, params);
      gate(ctx, "sweep", params, ack);
      return { asset: ctx.token!.symbol, ...parseCli(await runCli(["sweep", "--invoice", params.invoiceId!, "--json"], ctx)) };
    }

    case "POST /api/audit/export": {
      const params = checkParams(body);
      const ctx = laneFor(state, params);
      gate(ctx, "audit", {}, ack);
      const format = body?.format === "csv" ? "csv" : "json";
      const res = await runCli(["audit", "--format", format], ctx);
      if (res.exitCode !== 0) throw new ApiError(422, "ACTION_FAILED", res.stderr || "export failed");
      return { format, asset: ctx.token!.symbol, content: res.stdout };
    }

    case "POST /api/reset": {
      const requested = asString(body?.asset, 16);
      if (requested && !defaultQuaiTokenRegistry.resolve(requested)) throw new ApiError(400, "BAD_REQUEST", "unknown asset");
      // Discards every note, invoice and payee key in memory, so the server (not only the page) asks for it by
      // name. With persistence on, the state being discarded is saved and PINNED first: otherwise the autosaves
      // that follow would push it out of the retention window, and with it the only copy of the keys that hold
      // open invoices' funds. It can be restored later by its snapshot number.
      if (body?.confirm !== "RESET") throw new ApiError(400, "CONFIRMATION_REQUIRED", "type RESET to discard every note, invoice and payee key");
      let preserved: { seq: number; savedAt: string } | null = null;
      if (state.persistence) {
        try {
          const info = await state.persistence.preserve(state.env, "state before a reset");
          preserved = { seq: info.seq, savedAt: info.createdAt };
        } catch (err) {
          throw new ApiError(503, "PRESERVE_FAILED", `the current state could not be saved before the reset, so nothing was reset: ${(err as Error).message}`);
        }
      }
      state.env = (opts.envFactory ?? (() => createMultiAssetEnvironment()))();
      state.recovery = null;
      state.active = requested ? defaultQuaiTokenRegistry.resolve(requested)!.symbol : opts.asset ?? state.env.assets[0];
      return { ...status(state, state.ctx), preservedSnapshot: preserved };
    }

    default:
      throw new ApiError(404, "NOT_FOUND", "no such route");
  }
}

/** The raw request body, refused past `max` bytes (recorded audio). */
function readRaw(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return; // discard the rest so the 413 reaches the client instead of a reset socket
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "recording too large: keep a command under 30 seconds"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => !over && resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError(400, "BAD_REQUEST", "body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Requests that change state; a successful one schedules a save when persistence is on. */
const MUTATING = new Set(["/api/shield", "/api/pay", "/api/invoice", "/api/invoice/simulate-payment", "/api/sweep", "/api/reset"]);

export async function startApiServer(options: ApiServerOptions = {}): Promise<RunningApi> {
  const token = crypto.randomBytes(24).toString("hex");
  const factory = options.envFactory ?? (() => createMultiAssetEnvironment());
  let recovery: RecoveryNotice | null = null;
  let env: MultiAssetEnvironment;
  if (options.persistence) {
    // A key or network mismatch throws here on purpose: starting fresh over a store that belongs to other
    // keys would let the first autosave bury the real snapshots under an empty one.
    const rec = options.persistence.recover(factory);
    env = rec ? rec.env : factory();
    if (rec) recovery = { seq: rec.info.seq, savedAt: rec.summary.savedAt, skipped: rec.skipped.length };
  } else {
    env = factory();
  }
  const requested = options.asset ? defaultQuaiTokenRegistry.resolve(options.asset)?.symbol : undefined;
  const state: ApiState = {
    env,
    active: requested && env.lanes[requested] ? requested : env.assets[0],
    persistence: options.persistence,
    recovery,
    get ctx() {
      return this.env.lanes[this.active];
    }
  };
  options.persistence?.attach(() => state.env);
  // @admin:begin
  const admin = options.admin ? createAdminModule(options.admin, state, factory) : null;
  // @admin:end
  let boundPort = 0;
  // One request at a time: the simulation is single-threaded state and actions must not interleave.
  let chain: Promise<unknown> = Promise.resolve();
  // The agent never touches the simulation, so it has its own queue: a chain read or a transcription does not
  // hold up the dashboard, and two agent turns still never interleave.
  const agent = new VoiceAgent({ book: options.agent?.book, rpcFactory: options.agent?.rpcFactory, fetcher: options.agent?.fetcher });
  const transcriber = options.agent?.transcriber === undefined ? new LocalTranscriber() : options.agent.transcriber;
  let agentChain: Promise<unknown> = Promise.resolve();

  const server = http.createServer((req, res) => {
    const send = (code: number, type: string, payload: string, extra: Record<string, string> = {}) => {
      res.writeHead(code, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        // the voice agent records from the microphone on this page only; nothing else is needed
        "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=(), usb=()",
        ...extra
      });
      res.end(payload);
    };
    const fail = (e: unknown) => {
      const err = e instanceof ApiError ? e : new ApiError(500, "INTERNAL", "internal error");
      if (!(e instanceof ApiError)) console.error(e);
      send(err.status, "application/json", toJson({ error: { code: err.code, message: err.message }, checklist: err.extra }));
    };

    // DNS-rebinding defence: only loopback hosts are served.
    const host = String(req.headers.host ?? "");
    if (!new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]).has(host)) {
      return send(403, "application/json", toJson({ error: { code: "FORBIDDEN_HOST", message: "unexpected Host header" } }));
    }

    const urlPath = (req.url ?? "/").split("?")[0];

    // @admin:begin
    if (admin && req.method === "GET") {
      const asset = admin.staticAsset(urlPath);
      if (asset) return send(200, asset.type, asset.content);
    }
    // @admin:end

    if (req.method === "GET" && STATIC[urlPath]) {
      const entry = STATIC[urlPath];
      try {
        let content = fs.readFileSync(path.join(UI_DIR, entry.file), "utf8");
        if (entry.file === "index.html") content = content.replace("__SESSION_TOKEN__", token);
        // @admin:begin
        if (entry.file === "index.html") content = content.replace("__ADMIN_ENABLED__", admin ? "1" : "0");
        // @admin:end
        return send(200, entry.type, content);
      } catch {
        return send(404, "text/plain", "ui asset missing");
      }
    }

    if (!urlPath.startsWith("/api/")) return send(404, "text/plain", "not found");

    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`) {
      return send(403, "application/json", toJson({ error: { code: "FORBIDDEN_ORIGIN", message: "cross-site request refused" } }));
    }
    const supplied = String(req.headers["x-darkcircle-session"] ?? "");
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return send(401, "application/json", toJson({ error: { code: "UNAUTHORIZED", message: "missing or wrong session token" } }));
    }
    // A recorded voice command: raw audio, not JSON, transcribed on this machine.
    if (req.method === "POST" && urlPath === "/api/voice/transcribe") {
      const type = String(req.headers["content-type"] ?? "");
      if (!/^audio\//.test(type)) {
        return send(415, "application/json", toJson({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "send the recording as audio/*" } }));
      }
      readRaw(req, MAX_AUDIO_BYTES)
        .then((audio) => handleTranscribe(audio, type, agent, transcriber))
        .then((r) => send(r.status, "application/json", toJson(r.body)))
        .catch((e) => (e instanceof AgentRouteError ? send(e.status, "application/json", toJson({ error: { code: e.code, message: e.message } })) : fail(e)));
      return;
    }
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return send(415, "application/json", toJson({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "send application/json" } }));
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return send(405, "application/json", toJson({ error: { code: "METHOD_NOT_ALLOWED", message: "GET or POST only" } }));
    }

    if (urlPath.startsWith("/api/agent/") || urlPath === "/api/voice/status") {
      agentChain = agentChain.then(async () => {
        try {
          const body = req.method === "POST" ? await readBody(req) : {};
          const [pathname, query = ""] = req.url!.split("?");
          const r = await handleAgentRoute(`${req.method} ${pathname}`, body, new URLSearchParams(query), agent, transcriber);
          send(r.status, "application/json", toJson(r.body));
        } catch (e) {
          if (e instanceof AgentRouteError) send(e.status, "application/json", toJson({ error: { code: e.code, message: e.message } }));
          else fail(e);
        }
      });
      return;
    }

    chain = chain.then(async () => {
      try {
        const body = req.method === "POST" ? await readBody(req) : {};
        // @admin:begin
        if (admin && urlPath.startsWith("/api/admin/")) {
          const [pathname, query = ""] = req.url!.split("?");
          const r = await admin.handle({ method: req.method!, pathname, query: new URLSearchParams(query), headers: req.headers, body });
          return send(r.status, "application/json", toJson(r.body));
        }
        // @admin:end
        const out = await handle(state, options, req.method!, req.url!, body);
        if (req.method === "POST" && MUTATING.has(urlPath)) state.persistence?.notifyChange();
        send(200, "application/json", toJson(out));
      } catch (e) {
        fail(e);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  boundPort = (server.address() as { port: number }).port;

  return {
    server,
    port: boundPort,
    token,
    url: `http://127.0.0.1:${boundPort}/`,
    state,
    agent,
    // @admin:begin
    admin,
    // @admin:end
    close: async () => {
      transcriber?.close();
      // @admin:begin
      admin?.close();
      // @admin:end
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await state.persistence?.close({ flush: true });
    }
  };
}
