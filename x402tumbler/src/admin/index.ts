/**
 * DarkCircle admin console: server side
 * File: src/admin/index.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (scripts/redact-admin.ts deletes src/admin, ui/admin and every
 * block the API server fences with @admin markers; `pnpm redact:admin --check` proves nothing is left).
 *
 * The console is where an operator turns things on that the ordinary UI never touches: durable state, the
 * relayer, and the build-and-deploy pipeline for the circuit, verifier and pool contract. It is off unless
 * the server is started with it, it sits behind its own credential (auth.ts), and every action lands in a
 * hash-chained log (auditLog.ts), refusals included.
 *
 * Nothing here signs or broadcasts to a real chain. Stages that could only be proven on a real network are
 * plans, and say so.
 */

import fs from "node:fs";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { fileURLToPath } from "node:url";
import type { ApiState } from "../api/server.ts";
import type { MultiAssetEnvironment } from "../cli/context.ts";
import { parseTokenAmount } from "../cli/parser.ts";
import { formatTokenAmount } from "../quai/tokens.ts";
import { PersistenceManager } from "../persistence/manager.ts";
import { verifyEnvironment } from "../persistence/snapshot.ts";
import type { KdfParams } from "../persistence/store.ts";
import { AdminAuth, type AdminAuthOptions } from "./auth.ts";
import { AdminAuditLog } from "./auditLog.ts";
import { PROJECT_ROOT, checkToolchain } from "./toolchain.ts";
import { Pipeline, type SelftestRequest } from "./deploy/pipeline.ts";
import { readManifest } from "./deploy/manifest.ts";
import { buildUnshieldWitness } from "../sim/witness.ts";
import { SIM_VENDOR_ADDRESS } from "../sim/defaults.ts";
import { QuaiRpcClient } from "../quai/rpc.ts";
import { DEFAULT_QUAI_NETWORK, QUAI_ORCHARD_CYPRUS1, type QuaiNetwork } from "../quai/networks.ts";
import { ChainDeployer } from "./deploy/chain.ts";
import { removeDeployment, type DeploymentKey } from "./deploy/deployments.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_UI_DIR = path.resolve(HERE, "..", "..", "ui", "admin");
export const ADMIN_HEADER = "x-darkcircle-admin";

export interface AdminOptions {
  /** Overrides DARKCIRCLE_ADMIN_TOKEN; when neither is set a token is generated and printed once. */
  token?: string;
  auditLogFile?: string;
  /** Directory offered by the Persistence modal when the operator does not type one. */
  defaultDataDir?: string;
  /** Where the pipeline writes compiled circuits, keys, contracts and the manifest. */
  buildDir?: string;
  /** Powers-of-tau cache; defaults to <buildDir>/ptau. */
  ptauCacheDir?: string;
  /** Test knob: cheaper scrypt when the console creates a store. Leave unset in real use. */
  kdf?: KdfParams;
  auth?: Omit<AdminAuthOptions, "token">;
  /** Test knob: replaces the real Quai RPC client (defaults to the network's live endpoint) with a fake one. */
  chainRpcFactory?: (network: QuaiNetwork) => QuaiRpcClient;
}

export class AdminError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface AdminRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface AdminResponse {
  status: number;
  body: unknown;
}

export interface AdminModule {
  readonly token: string;
  readonly generatedToken: boolean;
  readonly audit: AdminAuditLog;
  readonly auth: AdminAuth;
  readonly buildDir: string;
  readonly pipeline: Pipeline;
  handle(req: AdminRequest): Promise<AdminResponse>;
  /** Stops anything still running (a pipeline stage) when the server shuts down. */
  close(): void;
  /** Served without a session: the console's own script and stylesheet (they contain no secrets). */
  staticAsset(urlPath: string): { content: string; type: string } | null;
}

const ASSETS: Record<string, { file: string; type: string }> = {
  "/admin/admin.js": { file: "admin.js", type: "text/javascript; charset=utf-8" },
  "/admin/admin.css": { file: "admin.css", type: "text/css; charset=utf-8" }
};

const str = (v: unknown, max = 300): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) throw new AdminError(400, "BAD_REQUEST", "invalid field");
  return v;
};

function relayerRows(env: MultiAssetEnvironment) {
  return env.assets.map((symbol) => {
    const lane = env.lanes[symbol];
    const decimals = lane.token!.decimals;
    const r = lane.relayer;
    return {
      symbol,
      address: r.relayerAddress,
      online: r.online,
      offlineReason: r.offlineReason ?? null,
      minimumFee: formatTokenAmount(r.minimumFee, decimals),
      minGasBalance: formatTokenAmount(r.minGasBalance),
      gasBalance: formatTokenAmount(lane.blockchain.getBalance(r.relayerAddress)),
      lowGas: lane.blockchain.getBalance(r.relayerAddress) < r.minGasBalance,
      decimals
    };
  });
}

export function createAdminModule(options: AdminOptions, state: ApiState, factory: () => MultiAssetEnvironment): AdminModule {
  const auth = new AdminAuth({ ...options.auth, token: options.token });
  const audit = new AdminAuditLog(options.auditLogFile ?? path.join(PROJECT_ROOT, ".darkcircle-admin", "audit.log"));
  const buildDir = options.buildDir ?? path.join(PROJECT_ROOT, "build");
  const defaultDataDir = options.defaultDataDir ?? path.join(PROJECT_ROOT, ".darkcircle-data");
  const pipeline = new Pipeline({
    buildDir,
    ptauCacheDir: options.ptauCacheDir,
    selftestInput: (): SelftestRequest => {
      // The proof is of a real note in the live simulated pool; nothing is spent or changed.
      const lane = state.ctx;
      const w = buildUnshieldWitness(lane, { recipient: SIM_VENDOR_ADDRESS, amount: 5n * 10n ** BigInt(lane.token!.decimals) });
      return { input: w.input, aliasedKeyInput: w.aliasedKeyInput, expectedPublic: w.expectedPublic, note: { leafIndex: w.note.leafIndex, value: w.note.value.toString() }, pool: lane.pool.contractAddress, asset: lane.token!.symbol };
    },
    onFinish: (job, record) => audit.append(`deploy.${job.stage}`, job.status === "ok" ? "ok" : "error", `${job.status}: ${record?.summary ?? job.error ?? ""}`)
  });
  audit.append("admin.start", "ok", `console enabled${audit.loadedTampered ? "; WARNING: the existing log failed verification" : ""}`);

  const requireLane = (symbol: unknown) => {
    const s = str(symbol, 16)?.toUpperCase();
    const lane = s ? state.env.lanes[s] : undefined;
    if (!s || !lane) throw new AdminError(400, "BAD_REQUEST", `unknown asset '${String(symbol)}'`);
    return { symbol: s, lane };
  };

  const persistenceOrThrow = (): PersistenceManager => {
    if (!state.persistence) throw new AdminError(409, "PERSISTENCE_OFF", "persistence is not enabled");
    return state.persistence;
  };

  /* ---------------------------------------------------------------- on-chain deployment (wallet-signed) */
  const deploymentsDir = path.join(buildDir, "deployments");
  const contractsDir = path.join(buildDir, "contracts");
  const targetNetwork = (target: unknown): QuaiNetwork => {
    const t = str(target, 12);
    if (t !== "orchard" && t !== "mainnet") throw new AdminError(400, "BAD_REQUEST", "target must be 'orchard' or 'mainnet'");
    return t === "mainnet" ? DEFAULT_QUAI_NETWORK : QUAI_ORCHARD_CYPRUS1;
  };
  const DEPLOYMENT_KEY_RE = /^(PoseidonT3|PoseidonT5|Groth16Verifier|DarkCirclePool:[A-Z0-9]{1,16})$/;
  const deploymentKey = (v: unknown): DeploymentKey => {
    const s = str(v, 40);
    if (!s || !DEPLOYMENT_KEY_RE.test(s)) throw new AdminError(400, "BAD_REQUEST", `key must be one of PoseidonT3, PoseidonT5, Groth16Verifier or DarkCirclePool:<ASSET>`);
    return s as DeploymentKey;
  };
  const chainDeployers = new Map<string, ChainDeployer>();
  const deployerFor = (network: QuaiNetwork): ChainDeployer => {
    const cached = chainDeployers.get(network.id);
    if (cached) return cached;
    const rpc = options.chainRpcFactory ? options.chainRpcFactory(network) : new QuaiRpcClient({ network });
    const cd = new ChainDeployer(rpc, contractsDir, deploymentsDir);
    chainDeployers.set(network.id, cd);
    return cd;
  };
  /** The four gates this repository can never satisfy on its own (dev ceremony, no audit, no PPOI in the
   *  circuit, no production relayer — see pipeline.ts's plan()). Deploying to mainnet with a value-bearing
   *  pool while any of these is unmet is a real financial decision, so the request must say it has shown
   *  them to the operator before this route hands back real, signable calldata. Mirrors the typed-
   *  confirmation pattern used for persistence restore/wipe: checked here, not only in the UI. */
  const MAINNET_RISK_GATES = new Set(["G-05", "G-06", "G-07", "G-08"]);
  const requireMainnetAcknowledgement = (target: QuaiNetwork, acknowledged: unknown) => {
    if (target.id !== DEFAULT_QUAI_NETWORK.id) return;
    if (acknowledged === true) return;
    const unmet = pipeline.plan("mainnet").gates.filter((g) => MAINNET_RISK_GATES.has(g.id) && !g.ok);
    throw new AdminError(409, "MAINNET_RISK_NOT_ACKNOWLEDGED", "this repository cannot satisfy every mainnet gate; acknowledge them by name before requesting deployable calldata", { gates: unmet });
  };

  /* ---------------------------------------------------------------- routes (session required) */
  const routes: Record<string, (req: AdminRequest) => Promise<unknown> | unknown> = {
    "GET /api/admin/overview": () => ({
      persistence: state.persistence ? state.persistence.status() : { enabled: false },
      recovery: state.recovery,
      relayers: relayerRows(state.env),
      audit: { ...audit.verify(), loadedTampered: audit.loadedTampered },
      block: state.env.shared.blockchain.currentBlockNumber,
      sessions: auth.activeSessions
    }),

    "GET /api/admin/environment": () => {
      const report = checkToolchain({ buildDir, dataDir: state.persistence?.store.dir ?? defaultDataDir });
      audit.append("environment.check", "ok", `${report.tools.filter((t) => t.ok).length}/${report.tools.length} tools ready`);
      return report;
    },

    "GET /api/admin/audit": () => ({ entries: audit.entries(200), verification: audit.verify(), loadedTampered: audit.loadedTampered }),

    /* ---- deployment pipeline ---- */
    "GET /api/admin/deploy": () => ({
      stages: pipeline.status(),
      job: pipeline.currentJob(),
      buildDir,
      ptauCacheDir: options.ptauCacheDir ?? path.join(buildDir, "ptau")
    }),

    "GET /api/admin/deploy/manifest": () => ({ manifest: readManifest(buildDir) }),

    /* The launch checklist: build, rehearse on Orchard, then mainnet. Derived from the same gates the plans use and
     * from the deployments recorded on disk, so it cannot say "done" about anything that was not verified. Reads no
     * chain and holds no key. Items marked `manual` are the operator's: nothing here can tick them. */
    "GET /api/admin/deploy/launch": () => {
      type Item = { id: string; phase: string; title: string; state: "done" | "todo" | "blocked" | "manual"; detail: string };
      const items: Item[] = [];
      const add = (phase: string, id: string, title: string, state: Item["state"], detail: string) => items.push({ id, phase, title, state, detail });
      const orchard = pipeline.plan("orchard");
      const mainnet = pipeline.plan("mainnet");
      const gateOf = (plan: typeof orchard, id: string) => plan.gates.find((g) => g.id === id)!;
      for (const id of ["G-01", "G-02", "G-03", "G-04"]) {
        const g = gateOf(orchard, id);
        add("1. Build and local proof", id, g.title, g.ok ? "done" : "todo", g.detail);
      }
      const recorded = (network: QuaiNetwork) => deployerFor(network).deployments().records as Record<string, { address: string } | undefined>;
      const rehearsal = recorded(QUAI_ORCHARD_CYPRUS1);
      const orchardOpen = ["G-01", "G-02", "G-03", "G-04"].every((id) => gateOf(orchard, id).ok);
      const g09 = gateOf(orchard, "G-09");
      add("2. Orchard testnet rehearsal", "T-00", g09.title, g09.ok ? "done" : "blocked", g09.detail);
      const shared: Array<[string, string]> = [["PoseidonT3", "PoseidonT3 hasher"], ["PoseidonT5", "PoseidonT5 hasher"], ["Groth16Verifier", "Groth16 verifier"], ["DarkCirclePool:WQI", "WQI pool"]];
      shared.forEach(([key, title], i) => {
        const r = rehearsal[key];
        add("2. Orchard testnet rehearsal", `T-0${i + 1}`, `Deploy the ${title}`, r ? "done" : orchardOpen && g09.ok ? "todo" : "blocked", r ? `${r.address} (receipt-verified)` : "Deploy tab > Orchard > connect your wallet > Deploy; the address is read off the receipt");
      });
      add("2. Orchard testnet rehearsal", "T-05", "Verify the pool's bindings on chain", rehearsal["DarkCirclePool:WQI"] ? "todo" : "blocked", "Deploy tab > Verify bindings: reads token, verifier, hashers and the empty-tree root back from Orchard");
      add("2. Orchard testnet rehearsal", "T-06", "Shield and unshield once against the deployed pool", "manual", "The UI still drives the simulation; nothing in this console shields into a deployed pool (AUDIT.md O-5). Use your own wallet and a funded test account, then confirm the nullifier was recorded");
      add("2. Orchard testnet rehearsal", "T-07", "Run pnpm verify:quai --network quai-orchard-cyprus1", "manual", "Re-checks the registry token against the live testnet endpoint on the day of the rehearsal");
      for (const id of ["G-05", "G-06", "G-07", "G-08"]) {
        const g = gateOf(mainnet, id);
        add("3. Mainnet release gates", id, g.title, g.ok ? "done" : "blocked", g.detail + ". Deploying anyway requires acknowledging this gate by name in the Deploy tab");
      }
      const g09m = gateOf(mainnet, "G-09");
      add("3. Mainnet release gates", "G-09", g09m.title, g09m.ok ? "done" : "blocked", g09m.detail);
      const live = recorded(DEFAULT_QUAI_NETWORK);
      add("4. Mainnet deployment", "M-01", "Rehearsal complete: every Orchard step above done and T-06 signed off by you", "manual", "Do not start mainnet until you have done the whole sequence once on the testnet");
      const mainSteps: Array<[string, string]> = [["PoseidonT3", "PoseidonT3 hasher"], ["PoseidonT5", "PoseidonT5 hasher"], ["Groth16Verifier", "Groth16 verifier"], ["DarkCirclePool:WQUAI", "WQUAI pool"], ["DarkCirclePool:WQI", "WQI pool"]];
      mainSteps.forEach(([key, title], i) => {
        const r = live[key];
        add("4. Mainnet deployment", `M-0${i + 2}`, `Deploy the ${title}`, r ? "done" : "todo", r ? `${r.address} (receipt-verified)` : "Deploy tab > Mainnet; each risk gate must be acknowledged on the server first");
      });
      add("4. Mainnet deployment", "M-07", "Verify both pools' bindings, then record addresses and run pnpm verify:quai", "manual", "Do not point value at a pool until this passes");
      const phases = Array.from(new Set(items.map((i) => i.phase)));
      audit.append("deploy.launch", "ok", `${items.filter((i) => i.state === "done").length}/${items.length} items done; nothing was sent`);
      return { items, phases, summary: { done: items.filter((i) => i.state === "done").length, total: items.length, blocked: items.filter((i) => i.state === "blocked").length } };
    },

    "POST /api/admin/deploy/run": (req) => {
      const stage = str(req.body?.stage, 40);
      if (!stage) throw new AdminError(400, "BAD_REQUEST", "stage is required");
      try {
        const job = pipeline.start(stage);
        audit.append("deploy.start", "ok", stage);
        return { job };
      } catch (err) {
        const m = (err as Error).message;
        audit.append("deploy.start", "denied", `${stage}: ${m.slice(0, 160)}`);
        throw new AdminError(/ERR_UNKNOWN_STAGE/.test(m) ? 400 : /ERR_STAGE_(BUSY|BLOCKED|INPUT_MISSING)/.test(m) ? 409 : 422, m.split(":")[0].replace(/^ERR_/, ""), m);
      }
    },

    "GET /api/admin/deploy/job": (req) => {
      const id = req.query.get("id") ?? "";
      const job = pipeline.job(id);
      if (!job) throw new AdminError(404, "NOT_FOUND", "no such job");
      const from = Math.max(0, Number(req.query.get("from") ?? 0) || 0);
      const start = Math.max(0, from - job.firstLine);
      return { job: { ...job, lines: job.lines.slice(start), firstLine: job.firstLine + start, next: job.firstLine + job.lines.length } };
    },

    "POST /api/admin/deploy/cancel": () => {
      const cancelled = pipeline.cancel();
      audit.append("deploy.cancel", cancelled ? "ok" : "denied", cancelled ? "running stage killed" : "nothing was running");
      return { cancelled };
    },

    "POST /api/admin/deploy/plan": (req) => {
      const target = str(req.body?.target, 12);
      if (target !== "orchard" && target !== "mainnet") throw new AdminError(400, "BAD_REQUEST", "target must be 'orchard' or 'mainnet'");
      const plan = pipeline.plan(target);
      const failing = plan.gates.filter((g) => !g.ok && g.blocking).map((g) => g.id);
      audit.append("deploy.plan", plan.canProceed ? "ok" : "denied", `${target}: ${plan.canProceed ? "no blocking gate fails" : `blocked by ${failing.join(", ")}`}; nothing was broadcast`);
      return { plan };
    },

    /* ---- on-chain deployment: THIS SERVER NEVER SIGNS OR SENDS. It builds calldata and a gas budget for
     * the operator's own wallet (ui/wallet.js, quai_sendTransaction), and reads back what actually
     * landed through the read-only QuaiRpcClient. */
    "GET /api/admin/deploy/chain/status": (req) => {
      const network = targetNetwork(req.query.get("target"));
      const cd = deployerFor(network);
      return { network: { id: network.id, title: network.title, chainId: network.chainId, zone: network.zone.name, zonePrefix: "0x" + network.zone.byte, explorerUrl: network.explorerUrl, testnet: network.testnet }, deployments: cd.deployments().records };
    },

    "POST /api/admin/deploy/chain/preflight": async (req) => {
      const network = targetNetwork(req.body?.target);
      const asset = str(req.body?.asset, 16);
      const deployer = str(req.body?.deployer, 100);
      if (!asset || !deployer) throw new AdminError(400, "BAD_REQUEST", "asset and deployer are required");
      requireMainnetAcknowledgement(network, req.body?.acknowledged);
      const r = await deployerFor(network).preflight(deployer, asset);
      audit.append("deploy.chain.preflight", r.ok ? "ok" : "denied", `${network.id}/${asset} deployer=${deployer.slice(0, 10)}… ${r.ok ? "ready" : r.errors.join("; ").slice(0, 160)}`);
      return { preflight: r };
    },

    /* Rebuilds one step and simulates it on the zone right before the wallet signs: access list, live gas
     * estimate, a gas limit with Quai's creation headroom. Refuses anything that would revert or run out of
     * gas. Like preflight, it hands back signable mainnet calldata only after the risks were acknowledged. */
    "POST /api/admin/deploy/chain/prepare": async (req) => {
      const network = targetNetwork(req.body?.target);
      const key = deploymentKey(req.body?.key);
      const asset = str(req.body?.asset, 16);
      const deployer = str(req.body?.deployer, 100);
      if (!asset || !deployer) throw new AdminError(400, "BAD_REQUEST", "asset and deployer are required");
      requireMainnetAcknowledgement(network, req.body?.acknowledged);
      try {
        const prepared = await deployerFor(network).prepare({ deployer, key, asset });
        audit.append("deploy.chain.prepare", "ok", `${network.id}: ${key} simulated; gas limit ${BigInt(prepared.gasLimit)} (estimate ${prepared.estimateGas}), ${prepared.accessList.length} access-list entr${prepared.accessList.length === 1 ? "y" : "ies"}; nothing was sent`);
        return { prepared };
      } catch (err) {
        const m = (err as Error).message;
        audit.append("deploy.chain.prepare", "denied", `${network.id}: ${key}: ${m.slice(0, 200)}`);
        throw new AdminError(422, m.split(":")[0].replace(/^ERR_/, ""), m);
      }
    },

    "POST /api/admin/deploy/chain/receipt": async (req) => {
      const network = targetNetwork(req.body?.target);
      const key = deploymentKey(req.body?.key);
      // Which contract a key deploys is decided server-side; a client value is only accepted if it agrees.
      const contract = str(req.body?.contract, 40);
      const txHash = str(req.body?.txHash, 80);
      const deployer = str(req.body?.deployer, 100);
      if (!txHash || !deployer) throw new AdminError(400, "BAD_REQUEST", "txHash and deployer are required");
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new AdminError(400, "BAD_REQUEST", "txHash does not look like a transaction hash");
      try {
        // A short per-request wait: the browser is the one doing the outer retry loop (matching the
        // pipeline job's own polling pattern), so one HTTP round trip here never blocks for minutes.
        const r = await deployerFor(network).verifyAndRecord({ key, contract, txHash, deployer }, { receiptTimeoutMs: 8_000 });
        if (r.status === "pending") return { pending: true };
        audit.append("deploy.chain.record", "ok", `${network.id}: ${r.record.contract} at ${r.record.address} (tx ${txHash})${r.warnings.length ? "; " + r.warnings.join("; ") : ""}`);
        state.persistence?.notifyChange();
        return { record: r.record, warnings: r.warnings };
      } catch (err) {
        const m = (err as Error).message;
        audit.append("deploy.chain.record", "error", `${network.id}: ${key} tx ${txHash}: ${m.slice(0, 200)}`);
        throw new AdminError(422, m.split(":")[0].replace(/^ERR_/, ""), m);
      }
    },

    "POST /api/admin/deploy/chain/verify-pool": async (req) => {
      const network = targetNetwork(req.body?.target);
      const asset = str(req.body?.asset, 16);
      if (!asset) throw new AdminError(400, "BAD_REQUEST", "asset is required");
      const r = await deployerFor(network).verifyPoolBindings(asset);
      audit.append("deploy.chain.verify-pool", r.ok ? "ok" : "error", `${network.id}/${asset}: ${r.checks.filter((c) => !c.ok).length} failing of ${r.checks.length}`);
      return r;
    },

    "POST /api/admin/deploy/chain/forget": (req) => {
      const network = targetNetwork(req.body?.target);
      const key = deploymentKey(req.body?.key);
      const existing = deployerFor(network).deployments().records[key];
      const expected = existing ? `FORGET ${existing.address}` : null;
      if (!existing) throw new AdminError(404, "NOT_FOUND", "nothing recorded for that key");
      if (req.body?.confirm !== expected) throw new AdminError(400, "CONFIRMATION_REQUIRED", `type exactly: ${expected}`);
      const updated = removeDeployment(deploymentsDir, network.id, network.chainId, key);
      audit.append("deploy.chain.forget", "ok", `${network.id}: ${key} (was ${existing.address}) removed from this console's records; nothing on chain changed`);
      return { records: updated.records };
    },

    /* ---- relayer ---- */
    "GET /api/admin/relayer": () => ({ relayers: relayerRows(state.env) }),

    "POST /api/admin/relayer": (req) => {
      const { symbol, lane } = requireLane(req.body?.asset);
      const changes: string[] = [];
      if (typeof req.body?.online === "boolean") {
        lane.relayer.setOnline(req.body.online, str(req.body.reason, 200));
        changes.push(req.body.online ? "online" : `offline (${lane.relayer.offlineReason ?? "no reason given"})`);
      }
      const fee = str(req.body?.minimumFee, 40);
      if (fee !== undefined) {
        let units: bigint;
        try {
          units = parseTokenAmount(fee, lane.token!.decimals);
        } catch (err) {
          throw new AdminError(400, "BAD_REQUEST", `minimumFee: ${(err as Error).message}`);
        }
        if (units > lane.spendingPolicy.maxPaymentCap) throw new AdminError(400, "BAD_REQUEST", "minimumFee is above the per-payment cap");
        lane.relayer.setMinimumFee(units);
        changes.push(`fee floor ${formatTokenAmount(units, lane.token!.decimals)}`);
      }
      const gas = str(req.body?.minGasBalance, 40);
      if (gas !== undefined) {
        let units: bigint;
        try {
          units = parseTokenAmount(gas, 18);
        } catch (err) {
          throw new AdminError(400, "BAD_REQUEST", `minGasBalance: ${(err as Error).message}`);
        }
        lane.relayer.setMinGasBalance(units);
        changes.push(`gas alert ${formatTokenAmount(units)} QUAI`);
      }
      if (changes.length === 0) throw new AdminError(400, "BAD_REQUEST", "nothing to change");
      audit.append("relayer.update", "ok", `${symbol}: ${changes.join(", ")}`);
      state.persistence?.notifyChange();
      return { relayers: relayerRows(state.env) };
    },

    /* ---- persistence ---- */
    "GET /api/admin/persistence": () => ({
      status: state.persistence ? state.persistence.status() : { enabled: false, defaultDir: defaultDataDir },
      recovery: state.recovery
    }),

    "POST /api/admin/persistence/enable": async (req) => {
      if (state.persistence) throw new AdminError(409, "PERSISTENCE_ON", "persistence is already enabled; disable it first to change the directory");
      const dir = path.resolve(str(req.body?.dir, 400) ?? defaultDataDir);
      const passphrase = typeof req.body?.passphrase === "string" ? req.body.passphrase : "";
      const mode = str(req.body?.mode, 20);
      let manager: PersistenceManager;
      try {
        manager = PersistenceManager.open({ dir, passphrase, kdf: options.kdf });
      } catch (err) {
        audit.append("persistence.enable", "denied", `${(err as Error).message.split(":")[0]} dir=${dir}`);
        throw new AdminError(422, "PERSISTENCE_OPEN_FAILED", (err as Error).message);
      }
      const existing = manager.status().snapshots;
      if (existing.length > 0 && mode !== "restore" && mode !== "keep-current") {
        await manager.close();
        throw new AdminError(409, "MODE_REQUIRED", `the store already holds ${existing.length} snapshot(s): choose to restore the newest one, or keep the current state and continue after it`, {
          snapshots: existing.length,
          latest: existing[existing.length - 1]
        });
      }
      try {
        if (existing.length > 0 && mode === "restore") {
          const rec = manager.recover(factory);
          if (rec) {
            state.env = rec.env;
            state.recovery = { seq: rec.info.seq, savedAt: rec.summary.savedAt, skipped: rec.skipped.length };
          }
        }
      } catch (err) {
        await manager.close();
        audit.append("persistence.enable", "error", `restore refused: ${(err as Error).message.slice(0, 160)}`);
        throw new AdminError(422, "RESTORE_REFUSED", (err as Error).message);
      }
      manager.attach(() => state.env);
      state.persistence = manager;
      if (existing.length === 0 || mode === "keep-current") await manager.save(state.env);
      audit.append("persistence.enable", "ok", `dir=${dir} snapshots=${existing.length} mode=${existing.length ? mode : "new"}`);
      return { status: manager.status(), recovery: state.recovery };
    },

    "POST /api/admin/persistence/save": async () => {
      const info = await persistenceOrThrow().save(state.env);
      audit.append("persistence.save", "ok", `snapshot #${info.seq}`);
      return { info, status: state.persistence!.status() };
    },

    "POST /api/admin/persistence/scan": () => {
      const report = persistenceOrThrow().scan();
      audit.append("persistence.scan", report.corrupt ? "error" : "ok", `${report.entries.length} snapshot(s), ${report.corrupt} corrupt`);
      return report;
    },

    "POST /api/admin/persistence/verify": () => {
      const report = verifyEnvironment(state.env);
      audit.append("persistence.verify", report.ok ? "ok" : "error", `${report.checks.filter((c) => !c.ok).length} failing of ${report.checks.length}`);
      return report;
    },

    "POST /api/admin/persistence/inspect": (req) => {
      const seq = typeof req.body?.seq === "number" ? req.body.seq : undefined;
      const r = persistenceOrThrow().inspect(seq);
      if (!r) throw new AdminError(404, "NOT_FOUND", "no readable snapshot");
      return r;
    },

    "POST /api/admin/persistence/restore": (req) => {
      const manager = persistenceOrThrow();
      if (req.body?.confirm !== "RESTORE") throw new AdminError(400, "CONFIRMATION_REQUIRED", 'type RESTORE to replace the running state with the snapshot');
      const seq = typeof req.body?.seq === "number" ? req.body.seq : undefined;
      let rec;
      try {
        rec = manager.recover(factory, seq);
      } catch (err) {
        audit.append("persistence.restore", "denied", (err as Error).message.slice(0, 200));
        throw new AdminError(422, "RESTORE_REFUSED", (err as Error).message);
      }
      if (!rec) throw new AdminError(404, "NOT_FOUND", "no snapshot to restore");
      state.env = rec.env;
      if (!state.env.lanes[state.active]) state.active = state.env.assets[0];
      state.recovery = { seq: rec.info.seq, savedAt: rec.summary.savedAt, skipped: rec.skipped.length };
      audit.append("persistence.restore", "ok", `snapshot #${rec.info.seq} saved ${rec.summary.savedAt}; ${rec.skipped.length} skipped`);
      return { info: rec.info, summary: rec.summary, checks: rec.verification.checks, skipped: rec.skipped };
    },

    "POST /api/admin/persistence/disable": async () => {
      const manager = persistenceOrThrow();
      await manager.close({ flush: true });
      state.persistence = undefined;
      audit.append("persistence.disable", "ok", "autosave stopped; files kept on disk");
      return { status: { enabled: false, defaultDir: defaultDataDir } };
    },

    "POST /api/admin/persistence/wipe": async (req) => {
      const manager = persistenceOrThrow();
      const expected = `WIPE ${manager.store.storeId}`;
      if (req.body?.confirm !== expected) {
        audit.append("persistence.wipe", "denied", "confirmation text did not match");
        throw new AdminError(400, "CONFIRMATION_REQUIRED", `type exactly: ${expected}`);
      }
      const dir = manager.store.dir;
      await manager.destroy();
      state.persistence = undefined;
      state.recovery = null;
      audit.append("persistence.wipe", "ok", `store ${manager.store.storeId} deleted from ${dir}`);
      return { status: { enabled: false, defaultDir: defaultDataDir } };
    }
  };

  /* ---------------------------------------------------------------- dispatcher */
  async function handle(req: AdminRequest): Promise<AdminResponse> {
    const route = `${req.method} ${req.pathname}`;
    const respondError = (e: unknown): AdminResponse => {
      if (e instanceof AdminError) return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } } };
      console.error(e);
      return { status: 500, body: { error: { code: "INTERNAL", message: "internal error" } } };
    };
    try {
      if (route === "GET /api/admin/ping") return { status: 200, body: { enabled: true, tokenSource: auth.generated ? "generated" : "environment" } };

      if (route === "POST /api/admin/login") {
        const r = auth.login(req.body?.token);
        if (r.ok) {
          audit.append("admin.login", "ok", "");
          return { status: 200, body: { session: r.session, expiresAt: r.expiresAt, idleMs: r.idleMs } };
        }
        audit.append("admin.login", "denied", r.reason === "LOCKED" ? `locked for ${Math.ceil((r.retryAfterMs ?? 0) / 1000)}s` : "wrong token");
        if (r.reason === "LOCKED") throw new AdminError(429, "ADMIN_LOCKED", `too many failed attempts; try again in ${Math.ceil((r.retryAfterMs ?? 0) / 1000)} s`, { retryAfterMs: r.retryAfterMs });
        throw new AdminError(401, "ADMIN_BAD_TOKEN", "that is not the admin token");
      }

      const sessionId = req.headers[ADMIN_HEADER];
      const session = auth.verify(Array.isArray(sessionId) ? sessionId[0] : sessionId);
      if (!session) {
        audit.append("admin.denied", "denied", route);
        throw new AdminError(401, "ADMIN_REQUIRED", "sign in to the admin console first");
      }

      if (route === "POST /api/admin/logout") {
        auth.logout(session.id);
        audit.append("admin.logout", "ok", "");
        return { status: 200, body: { ok: true } };
      }

      const fn = routes[route];
      if (!fn) throw new AdminError(404, "NOT_FOUND", "no such admin route");
      const out = await fn(req);
      return { status: 200, body: { ...(out as object), session: { expiresAt: session.expiresAt } } };
    } catch (e) {
      if (e instanceof AdminError && e.status >= 400 && e.status !== 401 && e.status !== 429 && e.status !== 404) {
        audit.append("admin.error", "error", `${req.method} ${req.pathname}: ${e.code}`);
      }
      return respondError(e);
    }
  }

  return {
    token: auth.token,
    generatedToken: auth.generated,
    audit,
    auth,
    buildDir,
    pipeline,
    handle,
    close() {
      pipeline.cancel();
    },
    staticAsset(urlPath) {
      const entry = ASSETS[urlPath];
      if (!entry) return null;
      try {
        return { content: fs.readFileSync(path.join(ADMIN_UI_DIR, entry.file), "utf8"), type: entry.type };
      } catch {
        return null;
      }
    }
  };
}
