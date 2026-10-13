/**
 * DarkCircle admin console: deployment pipeline orchestration
 * File: src/admin/deploy/pipeline.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * Runs the stages that turn the circuit and contract sources into deployable artifacts, one at a time, each
 * in its own child process (stageRunner.ts), and keeps the manifest that says what exists and whether it is
 * still current:
 *
 *   circuit.compile   circom -> r1cs, wasm witness generator
 *   circuit.setup     powers of tau + Groth16 keys (DEVELOPMENT ceremony, one contributor)
 *   verifier.export   Solidity verifier from the proving key
 *   contracts.compile solc + Poseidon hashers, with deployed-bytecode hashes
 *   circuit.selftest  prove a real note from the live simulation; compare every public signal; try to cheat
 *   evm.local         run the compiled contracts in a local EVM with a real proof
 *
 * plan(target) then turns the manifest into a deployment PLAN for Orchard or mainnet: ordered steps, the
 * bytecode hashes to expect, and the gates that are still failing. THIS TOOL NEVER BROADCASTS. A plan is a
 * document for the person who deploys with their own key and process; the gates that cannot be satisfied
 * inside this repository (an audited circuit, a real ceremony, PPOI in the circuit, a production relayer)
 * are listed as failing, and on mainnet they block the plan outright.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_QUAI_NETWORK, QUAI_ORCHARD_CYPRUS1, type QuaiNetwork } from "../../quai/networks.ts";
import { defaultQuaiTokenRegistry } from "../../quai/tokens.ts";
import { changedInputs, readManifest, refFor, writeManifest, type FileRef, type StageRecord } from "./manifest.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "stageRunner.ts");
export const PROJECT_ROOT = path.resolve(HERE, "..", "..", "..");
const MAX_LOG_LINES = 1200;
const STAGE_TIMEOUT_MS = 45 * 60 * 1000;

/** Ends a stage process and everything it started (circom runs as a grandchild, which child.kill() alone would leave behind on Windows). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}

export type StageId = "circuit.compile" | "circuit.setup" | "verifier.export" | "contracts.compile" | "circuit.selftest" | "evm.local";

interface InputSpec {
  base: "project" | "build";
  path: string;
}

export interface StageDef {
  id: StageId;
  title: string;
  description: string;
  requires: StageId[];
  /** Files whose content decides whether a finished stage is still current. */
  inputs: InputSpec[];
  estimate: string;
}

const CONTRACT_JSONS = ["DarkCirclePool", "Groth16Verifier", "DevToken", "PoseidonT3", "PoseidonT5"].map((n): InputSpec => ({ base: "build", path: `contracts/${n}.json` }));

export const STAGES: StageDef[] = [
  { id: "circuit.compile", title: "Compile the circuit", description: "circom compiles circuits/unshield.circom (constraints C1 to C7 of the unshield statement) into an r1cs and a WASM witness generator.", requires: [], inputs: [{ base: "project", path: "circuits/unshield.circom" }], estimate: "about 10 seconds" },
  { id: "circuit.setup", title: "Ceremony and proving keys", description: "Runs a powers of tau and a Groth16 setup for the compiled circuit. DEVELOPMENT ONLY: one contributor, this machine. The powers of tau is cached by size, so only the first run is slow.", requires: ["circuit.compile"], inputs: [{ base: "build", path: "circuit/unshield.r1cs" }], estimate: "6 to 10 minutes the first time, about 1 minute after" },
  { id: "verifier.export", title: "Export the verifier contract", description: "Renders Groth16Verifier.sol from the proving key with snarkjs's own template.", requires: ["circuit.setup"], inputs: [{ base: "build", path: "keys/unshield_final.zkey" }], estimate: "a few seconds" },
  { id: "contracts.compile", title: "Compile the contracts", description: "solc compiles the pool, the dev token and the verifier (evm paris, optimizer 200); circomlibjs supplies the Poseidon hashers. Records a bytecode hash for each.", requires: ["verifier.export"], inputs: [{ base: "project", path: "contracts/DarkCirclePool.sol" }, { base: "project", path: "contracts/DevToken.sol" }, { base: "build", path: "contracts/generated/Groth16Verifier.sol" }], estimate: "about 10 seconds" },
  { id: "circuit.selftest", title: "Prove a real note (self-test)", description: "Takes a real note from the live simulated pool, proves an unshield of it with the new keys, verifies the proof, and checks that every public signal equals what the simulation computes. Then checks that tampering, a wrong spending key, and an aliased key (key + L: same note, second nullifier) are rejected.", requires: ["circuit.setup"], inputs: [{ base: "build", path: "circuit/unshield_js/unshield.wasm" }, { base: "build", path: "keys/unshield_final.zkey" }, { base: "build", path: "keys/verification_key.json" }], estimate: "about 20 seconds" },
  { id: "evm.local", title: "Deploy and exercise on a local EVM", description: "Deploys the hashers, verifier, dev token and pool into an in-process EVM and runs a shield and a proven unshield end to end, then tries to break it with tampered calls.", requires: ["contracts.compile", "circuit.setup"], inputs: [...CONTRACT_JSONS, { base: "build", path: "keys/unshield_final.zkey" }, { base: "build", path: "circuit/unshield_js/unshield.wasm" }], estimate: "about 1 minute" }
];

export type StageState = "ok" | "stale" | "failed" | "ready" | "blocked" | "running";

export interface StageStatus {
  id: StageId;
  title: string;
  description: string;
  estimate: string;
  requires: StageId[];
  state: StageState;
  /** Upstream stages that must succeed first (state "blocked"). */
  blockedBy: StageId[];
  /** Files that changed since the stage last ran (state "stale"). */
  changed: string[];
  record: StageRecord | null;
}

export interface Job {
  id: string;
  stage: StageId;
  status: "running" | "ok" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  /** Index of lines[0] in the job's full log, so a poller can ask for "everything after n". */
  firstLine: number;
  lines: string[];
  summary?: string;
  error?: string;
}

export interface PlanGate {
  id: string;
  title: string;
  ok: boolean;
  /** A failing blocking gate means the plan cannot be carried out on this target. */
  blocking: boolean;
  detail: string;
}

export interface DeployPlan {
  target: "orchard" | "mainnet";
  generatedAt: string;
  /** Always false: this tool produces a plan, it never sends a transaction. */
  broadcast: false;
  network: { id: string; chainId: number; zone: string; zonePrefix: string };
  canProceed: boolean;
  gates: PlanGate[];
  steps: Array<{ order: number; contract: string; bytecodeHash: string | null; hashKind: string | null; constructorArgs: string[]; note: string }>;
  external: string[];
  digest: string;
}

export interface SelftestRequest {
  input: Record<string, unknown>;
  /** The same spend under key + L with its own nullifier (a second spend of the note); must be refused. */
  aliasedKeyInput: Record<string, unknown>;
  expectedPublic: string[];
  note: { leafIndex: number; value: string };
  pool: string;
  asset: string;
}

export interface PipelineOptions {
  buildDir: string;
  /** Where the powers-of-tau cache lives (default: <buildDir>/ptau). Sharing one across builds skips the slow first run. */
  ptauCacheDir?: string;
  /** Supplies the self-test's witness from the live simulation; called when that stage starts. */
  selftestInput: () => SelftestRequest;
  onFinish?: (job: Job, record: StageRecord | null) => void;
}

export class Pipeline {
  public readonly buildDir: string;
  private readonly ptauCacheDir: string;
  private readonly selftestInput: () => SelftestRequest;
  private readonly onFinish?: (job: Job, record: StageRecord | null) => void;
  private jobs = new Map<string, Job>();
  private current: { job: Job; child: ChildProcess; cancelled: boolean } | null = null;

  constructor(opts: PipelineOptions) {
    this.buildDir = opts.buildDir;
    this.ptauCacheDir = opts.ptauCacheDir ?? path.join(opts.buildDir, "ptau");
    this.selftestInput = opts.selftestInput;
    this.onFinish = opts.onFinish;
  }

  private inputRefs(def: StageDef): FileRef[] {
    return def.inputs.map((i) => {
      const dir = i.base === "project" ? PROJECT_ROOT : this.buildDir;
      if (!fs.existsSync(path.join(dir, i.path))) throw new Error(`ERR_STAGE_INPUT_MISSING: ${i.path} does not exist; run the stage that produces it first`);
      return refFor(i.base, dir, i.path);
    });
  }

  public status(): StageStatus[] {
    const manifest = readManifest(this.buildDir);
    const ok = new Set<StageId>();
    const out: StageStatus[] = [];
    for (const def of STAGES) {
      const record = manifest.stages[def.id] ?? null;
      let state: StageState;
      let changed: string[] = [];
      let blockedBy: StageId[] = [];
      if (this.current?.job.stage === def.id) state = "running";
      else if (record?.status === "failed") state = "failed";
      else if (record?.status === "ok") {
        changed = changedInputs(record, PROJECT_ROOT, this.buildDir);
        state = changed.length ? "stale" : "ok";
      } else {
        blockedBy = def.requires.filter((r) => !ok.has(r));
        state = blockedBy.length ? "blocked" : "ready";
      }
      if (state === "ok") ok.add(def.id);
      out.push({ id: def.id, title: def.title, description: def.description, estimate: def.estimate, requires: def.requires, state, blockedBy, changed, record });
    }
    return out;
  }

  public currentJob(): Job | null {
    return this.current?.job ?? null;
  }

  public job(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Starts a stage in the background. Throws with an explanatory message when it cannot run now. */
  public start(stageId: string): Job {
    const def = STAGES.find((s) => s.id === stageId);
    if (!def) throw new Error(`ERR_UNKNOWN_STAGE: '${stageId}'`);
    if (this.current) throw new Error(`ERR_STAGE_BUSY: '${this.current.job.stage}' is still running`);
    const states = new Map(this.status().map((s) => [s.id, s.state]));
    const missing = def.requires.filter((r) => states.get(r) !== "ok");
    if (missing.length) throw new Error(`ERR_STAGE_BLOCKED: run ${missing.join(", ")} first (and make sure ${missing.length > 1 ? "they are" : "it is"} current)`);

    let stdin: string | undefined;
    if (def.id === "circuit.selftest") stdin = JSON.stringify(this.selftestInput());
    const inputs = this.inputRefs(def);

    const job: Job = { id: crypto.randomBytes(6).toString("hex"), stage: def.id, status: "running", startedAt: new Date().toISOString(), firstLine: 0, lines: [] };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 40) this.jobs.delete(this.jobs.keys().next().value as string);

    const push = (line: string) => {
      job.lines.push(line);
      if (job.lines.length > MAX_LOG_LINES) {
        const drop = job.lines.length - MAX_LOG_LINES;
        job.lines.splice(0, drop);
        job.firstLine += drop;
      }
    };
    push(`starting ${def.id}`);

    const child = spawn(process.execPath, [RUNNER, def.id, "--build", this.buildDir, "--ptau-cache", this.ptauCacheDir], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const state = { job, child, cancelled: false };
    this.current = state;

    let result: { summary: string; details?: unknown; artifacts?: string[]; warnings?: string[] } | null = null;
    let failure: string | null = null;
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.t === "log") for (const l of String(msg.m).split("\n")) push(l);
          else if (msg.t === "result") result = msg;
          else if (msg.t === "error") failure = String(msg.message);
        } catch {
          push(line);
        }
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const l of chunk.split("\n")) if (l.trim() && !/ExperimentalWarning|Use `node --trace|DEP0137|Closing file descriptor|Error in template|^ERROR:\s+\d/.test(l)) push(`stderr: ${l.trim()}`);
    });
    if (stdin !== undefined) child.stdin!.write(stdin);
    child.stdin!.end();

    const timer = setTimeout(() => {
      failure = `timed out after ${STAGE_TIMEOUT_MS / 60000} minutes`;
      killTree(child);
    }, STAGE_TIMEOUT_MS);
    timer.unref?.();

    child.on("error", (err) => {
      failure = `could not start the stage process: ${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      job.endedAt = new Date().toISOString();
      let record: StageRecord | null = null;
      if (state.cancelled) {
        job.status = "cancelled";
        push("cancelled");
      } else if (code === 0 && result) {
        try {
          const artifacts = (result.artifacts ?? []).map((p) => refFor("build", this.buildDir, p));
          record = { id: def.id, status: "ok", startedAt: job.startedAt, finishedAt: job.endedAt, durationMs: Date.parse(job.endedAt) - Date.parse(job.startedAt), summary: result.summary, details: result.details, inputs, artifacts, warnings: result.warnings ?? [] };
          job.status = "ok";
          job.summary = result.summary;
          push(`done: ${result.summary}`);
        } catch (err) {
          failure = `stage finished but its artifacts could not be recorded: ${(err as Error).message}`;
        }
      }
      if (job.status === "running") {
        job.status = "failed";
        job.error = failure ?? `the stage process exited with code ${code} without a result`;
        push(`FAILED: ${job.error}`);
        record = { id: def.id, status: "failed", startedAt: job.startedAt, finishedAt: job.endedAt, durationMs: Date.parse(job.endedAt) - Date.parse(job.startedAt), summary: job.error, inputs: [], artifacts: [], warnings: [] };
      }
      if (record) {
        const m = readManifest(this.buildDir);
        m.stages[def.id] = record;
        // A rebuilt stage invalidates nothing by itself: downstream stages notice through their input hashes.
        writeManifest(this.buildDir, m);
      }
      this.current = null;
      this.onFinish?.(job, record);
    });
    return job;
  }

  /** Kills the running stage. Its previous manifest record is left as it was. */
  public cancel(): boolean {
    if (!this.current) return false;
    this.current.cancelled = true;
    killTree(this.current.child);
    return true;
  }

  /* ---------------------------------------------------------------- deployment plans */

  public plan(target: "orchard" | "mainnet"): DeployPlan {
    const network: QuaiNetwork = target === "mainnet" ? DEFAULT_QUAI_NETWORK : QUAI_ORCHARD_CYPRUS1;
    const mainnet = target === "mainnet";
    const statuses = new Map(this.status().map((s) => [s.id, s]));
    const stateOf = (id: StageId) => statuses.get(id)!.state;
    const gates: PlanGate[] = [];
    const gate = (id: string, title: string, ok: boolean, blocking: boolean, detail: string) => gates.push({ id, title, ok, blocking, detail });

    const built = (ids: StageId[]) => ids.every((i) => stateOf(i) === "ok");
    gate("G-01", "Circuit compiled and keys generated", built(["circuit.compile", "circuit.setup"]), true, built(["circuit.compile", "circuit.setup"]) ? "current" : "run the circuit stages first");
    gate("G-02", "Verifier exported and contracts compiled", built(["verifier.export", "contracts.compile"]), true, built(["verifier.export", "contracts.compile"]) ? "bytecode hashes recorded below" : "run the verifier and contract stages first");
    gate("G-03", "A real note proves and verifies (self-test)", stateOf("circuit.selftest") === "ok", true, stateOf("circuit.selftest") === "ok" ? "public signals equal the simulation's" : "run the self-test against the live simulation");
    gate("G-04", "Compiled contracts pass the local EVM scenario", stateOf("evm.local") === "ok", true, stateOf("evm.local") === "ok" ? "shield, proven unshield and every refusal behave as specified" : "run the local EVM stage");
    gate("G-05", "Trusted setup is production-grade", false, mainnet, "the keys come from a single-contributor development ceremony; replace it with a real multi-party ceremony (or a transparent proof system) and publish the transcript");
    gate("G-06", "Independent audit of circuit, verifier and pool", false, mainnet, "none exists; the contract and circuit in this repository are unaudited reference implementations");
    gate("G-07", "C8 (PPOI compliance) is enforced on chain", false, mainnet, "the circuit covers C1 to C7 only; the pool cannot refuse a note from a sanctioned origin (AUDIT.md O-14)");
    gate("G-08", "A production relayer exists", false, mainnet, "the relayer is an in-process simulation with no signer, gas funding or nonce handling (AUDIT.md O-2)");
    const tokens = defaultQuaiTokenRegistry.list(network);
    // Mainnet needs both pools. Orchard has WQI only (there is no WQUAI contract on the testnet), so one verified
    // token is enough to deploy that pool there; the missing asset is named, not hidden.
    const need = mainnet ? 2 : 1;
    const missing = ["WQUAI", "WQI"].filter((s) => !tokens.some((t) => t.symbol === s));
    gate("G-09", mainnet ? `WQUAI and WQI are registered on ${network.title}` : `A verified settlement token is registered on ${network.title}`, tokens.length >= need,
      true, tokens.length >= need ? `${tokens.map((t) => `${t.symbol} ${t.address}`).join(", ")}${missing.length ? `; no ${missing.join(" or ")} contract exists here, so that pool cannot be deployed on this network` : ""}` : "no verified WQUAI/WQI deployment is registered for this network, so there is no token address to bind a pool to");

    const compiled = readManifest(this.buildDir).stages["contracts.compile"];
    const hashes = ((compiled?.details as { contracts?: Record<string, { bytecodeHash: string; hashKind: string }> } | undefined)?.contracts) ?? {};
    const h = (n: string) => hashes[n]?.bytecodeHash ?? null;
    const k = (n: string) => hashes[n]?.hashKind ?? null;
    const steps: DeployPlan["steps"] = [
      { order: 1, contract: "PoseidonT3", bytecodeHash: h("PoseidonT3"), hashKind: k("PoseidonT3"), constructorArgs: [], note: "2-input Poseidon hasher (circomlibjs creation code)" },
      { order: 2, contract: "PoseidonT5", bytecodeHash: h("PoseidonT5"), hashKind: k("PoseidonT5"), constructorArgs: [], note: "4-input Poseidon hasher" },
      { order: 3, contract: "Groth16Verifier", bytecodeHash: h("Groth16Verifier"), hashKind: k("Groth16Verifier"), constructorArgs: [], note: "verifier for the exact keys in build/keys; a different ceremony means a different verifier" },
      ...tokens.map((t, i) => ({ order: 4 + i, contract: "DarkCirclePool", bytecodeHash: h("DarkCirclePool"), hashKind: k("DarkCirclePool"), constructorArgs: [t.address, "<address of step 3>", "<address of step 1>", "<address of step 2>"], note: `the ${t.symbol} pool; one pool per asset, never shared` }))
    ];

    const external = [
      "Deploy with your own key through your own reviewed procedure. This tool holds no key and sends nothing.",
      `On Quai the deployment transaction must carry an access list from quai_createAccessList and a gas limit from quai_estimateGas with generous headroom (creation cost has been seen at roughly 2.5 times the estimate); read each contract address off its receipt, never predict it.`,
      `Contract addresses must land in the ${network.zone.name} zone (prefix 0x${network.zone.byte}) on the Quai ledger; a deployer that cannot grind an in-zone address cannot deploy here.`,
      "After deployment, compare each deployed code hash with the hashes above, then run pnpm verify:quai against the target and record the addresses.",
      "Do not point any value at a pool until every gate above is green and an independent audit has signed off."
    ];

    const core = { target, network: { id: network.id, chainId: network.chainId, zone: network.zone.name, zonePrefix: `0x${network.zone.byte}` }, gates, steps, external };
    const plan: DeployPlan = {
      target,
      generatedAt: new Date().toISOString(),
      broadcast: false,
      network: core.network,
      canProceed: gates.every((g) => g.ok || !g.blocking),
      gates,
      steps,
      external,
      digest: crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex")
    };
    fs.mkdirSync(this.buildDir, { recursive: true });
    fs.writeFileSync(path.join(this.buildDir, `deploy-plan-${target}.json`), JSON.stringify(plan, null, 2));
    return plan;
  }
}
