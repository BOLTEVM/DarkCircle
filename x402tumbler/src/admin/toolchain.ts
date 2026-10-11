/**
 * DarkCircle admin console: toolchain and environment report
 * File: src/admin/toolchain.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * Answers "can this machine run the deployment pipeline?" by looking at what is actually installed, not at
 * what package.json says should be. Read-only: it never writes outside a probe file it removes again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..", "..");

export interface ToolStatus {
  id: string;
  label: string;
  ok: boolean;
  /** A missing required tool blocks the pipeline stages that need it. */
  required: boolean;
  version?: string;
  detail: string;
}

/** Version of an installed package, found by walking up from its entry point (package `exports` may hide package.json). */
export function installedVersion(name: string): string | null {
  try {
    let dir = path.dirname(require.resolve(name));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (pkg.name === name) return String(pkg.version);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not installed */
  }
  return null;
}

/** Runs a fixed command line (never built from input) through the shell so .cmd shims such as pnpm resolve on Windows. */
function tryExec(commandLine: string, timeout = 8000): string | null {
  try {
    return execSync(commandLine, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function writable(dir: string): { ok: boolean; detail: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    return { ok: true, detail: `${dir} is writable` };
  } catch (err) {
    return { ok: false, detail: `${dir} is not writable: ${(err as Error).message}` };
  }
}

let circomVersionCache: string | null | undefined;
function circomCompilerVersion(): string | null {
  if (circomVersionCache !== undefined) return circomVersionCache;
  try {
    const cli = require.resolve("circom2/cli.js");
    const out = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    circomVersionCache = out.replace(/\s+/g, " ").trim() || null;
  } catch {
    circomVersionCache = null;
  }
  return circomVersionCache;
}

const semverAtLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

export interface ToolchainReport {
  tools: ToolStatus[];
  machine: { platform: string; arch: string; cpus: number; memoryGb: number };
  /** What the pipeline can do right now. */
  can: { compileCircuit: boolean; setupProof: boolean; compileContracts: boolean; localEvm: boolean };
}

export function checkToolchain(opts: { buildDir: string; dataDir?: string }): ToolchainReport {
  const tools: ToolStatus[] = [];
  const add = (t: ToolStatus) => tools.push(t);

  const node = process.versions.node;
  add({ id: "node", label: "Node.js", ok: semverAtLeast(node, "22.18.0"), required: true, version: node, detail: semverAtLeast(node, "22.18.0") ? "runs TypeScript natively" : "needs 22.18 or newer to run the sources" });

  const pnpm = tryExec("pnpm --version");
  add({ id: "pnpm", label: "pnpm", ok: !!pnpm, required: false, version: pnpm ?? undefined, detail: pnpm ? "package manager for this repository" : "not on PATH (only needed to install dependencies)" });

  const circom2 = installedVersion("circom2");
  const compiler = circom2 ? circomCompilerVersion() : null;
  add({ id: "circom2", label: "circom compiler (circom2, WASM)", ok: !!compiler, required: true, version: compiler ?? circom2 ?? undefined, detail: compiler ? `circom2 ${circom2}: ${compiler}` : circom2 ? "installed but did not run" : "not installed: pnpm add -D circom2" });

  let poseidonCircuit = false;
  try {
    poseidonCircuit = fs.existsSync(path.join(path.dirname(require.resolve("circomlib/package.json")), "circuits", "poseidon.circom"));
  } catch {
    /* absent */
  }
  add({ id: "circomlib", label: "circomlib circuits", ok: poseidonCircuit, required: true, version: installedVersion("circomlib") ?? undefined, detail: poseidonCircuit ? "Poseidon, BabyJubjub and bit components available" : "not installed: pnpm add -D circomlib" });

  const snarkjs = installedVersion("snarkjs");
  add({ id: "snarkjs", label: "snarkjs (Groth16)", ok: !!snarkjs, required: true, version: snarkjs ?? undefined, detail: snarkjs ? "setup, proving, verification and Solidity export" : "not installed: pnpm add -D snarkjs" });

  const circomlibjs = installedVersion("circomlibjs");
  add({ id: "circomlibjs", label: "circomlibjs (Poseidon contracts)", ok: !!circomlibjs, required: true, version: circomlibjs ?? undefined, detail: circomlibjs ? "generates the on-chain Poseidon hasher bytecode" : "not installed: pnpm add -D circomlibjs" });

  const solc = installedVersion("solc");
  add({ id: "solc", label: "Solidity compiler (solc-js)", ok: !!solc, required: true, version: solc ?? undefined, detail: solc ? "compiles the pool, token and verifier contracts" : "not installed: pnpm add -D solc" });

  const evm = installedVersion("@ethereumjs/evm");
  add({ id: "evm", label: "Local EVM (@ethereumjs/evm)", ok: !!evm, required: false, version: evm ?? undefined, detail: evm ? "runs the compiled contracts end to end, including the pairing precompile" : "not installed: the local deployment test cannot run" });

  const circuitSrc = fs.existsSync(path.join(PROJECT_ROOT, "circuits", "unshield.circom"));
  add({ id: "src.circuits", label: "Circuit source", ok: circuitSrc, required: true, detail: circuitSrc ? "circuits/unshield.circom" : "circuits/unshield.circom is missing" });
  const contractSrc = fs.existsSync(path.join(PROJECT_ROOT, "contracts", "DarkCirclePool.sol"));
  add({ id: "src.contracts", label: "Contract source", ok: contractSrc, required: true, detail: contractSrc ? "contracts/DarkCirclePool.sol" : "contracts/DarkCirclePool.sol is missing" });

  const build = writable(opts.buildDir);
  add({ id: "dir.build", label: "Build directory", ok: build.ok, required: true, detail: build.detail });
  if (opts.dataDir) {
    const data = writable(opts.dataDir);
    add({ id: "dir.data", label: "Persistence directory", ok: data.ok, required: false, detail: data.detail });
  }

  const ok = (id: string) => tools.find((t) => t.id === id)?.ok === true;
  return {
    tools,
    machine: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, memoryGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10 },
    can: {
      compileCircuit: ok("circom2") && ok("circomlib") && ok("src.circuits") && ok("dir.build"),
      setupProof: ok("snarkjs") && ok("dir.build"),
      compileContracts: ok("solc") && ok("circomlibjs") && ok("src.contracts") && ok("dir.build"),
      localEvm: ok("evm")
    }
  };
}
