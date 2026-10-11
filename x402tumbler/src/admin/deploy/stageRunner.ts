/**
 * DarkCircle admin console: pipeline stage runner (child process)
 * File: src/admin/deploy/stageRunner.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 *   node stageRunner.ts <stage> --build <buildDir>          (self-test reads its input from stdin)
 *
 * One stage per process. The circuit tooling starts worker threads that outlive their work and the ceremony
 * is CPU-heavy, so running it in the API server would leave threads behind and stall requests; a child
 * process is cheap to kill and takes everything with it when it exits.
 *
 * Output protocol: one JSON object per line on stdout.
 *   {"t":"log","m":"..."}                       progress
 *   {"t":"result","ok":true,"summary":"...","details":{...},"artifacts":["circuit/unshield.r1cs",...],"inputs":[...]}
 *   {"t":"error","message":"..."}               failure (exit code 1)
 * `artifacts` and `inputs` are paths relative to the build directory; the parent hashes them.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { compileCircuit, ensurePtau, exportSolidityVerifier, proveAndVerify, requiredPower, trustedSetupDev } from "./circuit.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..", "..");

const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (m: string) => emit({ t: "log", m: String(m).replace(/\x1b\[[0-9;]*m/g, "").trim() });

export interface RunnerResult {
  summary: string;
  details?: unknown;
  artifacts?: string[];
  warnings?: string[];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const at = (build: string, ...p: string[]) => path.join(build, ...p);

async function runStage(stage: string, build: string, ptauCache: string): Promise<RunnerResult> {
  switch (stage) {
    case "circuit.compile": {
      const c = await compileCircuit({ source: path.join(PROJECT_ROOT, "circuits", "unshield.circom"), outDir: at(build, "circuit"), log });
      return {
        summary: `compiled unshield.circom: ${c.constraints} constraints, ${c.publicInputs} public inputs`,
        details: { constraints: c.constraints, publicInputs: c.publicInputs, privateInputs: c.privateInputs, wires: c.wires, requiredPtauPower: requiredPower(c) },
        artifacts: ["circuit/unshield.r1cs", "circuit/unshield_js/unshield.wasm", "circuit/unshield.sym"]
      };
    }

    case "circuit.setup": {
      const info = await snarkjs.r1cs.info(at(build, "circuit", "unshield.r1cs"), { debug() {}, info() {}, warn: log, error: log });
      const power = requiredPower({ constraints: Number(info.nConstraints), publicInputs: Number(info.nPubInputs) });
      const ptau = await ensurePtau({ power, cacheDir: ptauCache, log });
      const s = await trustedSetupDev({ r1cs: at(build, "circuit", "unshield.r1cs"), ptau: ptau.file, outDir: at(build, "keys"), log });
      return {
        summary: `Groth16 keys generated from a 2^${power} powers of tau (${ptau.reused ? "reused" : "new"}); DEVELOPMENT CEREMONY, NOT FOR VALUE`,
        details: { power, ptauSha256: ptau.sha256, ptauReused: ptau.reused, zkeyVerified: s.zkeyVerified, productionSafe: s.productionSafe, ceremony: s.ceremony },
        artifacts: ["keys/unshield_final.zkey", "keys/verification_key.json"],
        warnings: ["The trusted setup has a single local contributor. Anyone who controlled this machine's randomness can forge proofs. Do not deploy these keys to guard value."]
      };
    }

    case "verifier.export": {
      const src = await exportSolidityVerifier({ zkey: at(build, "keys", "unshield_final.zkey"), outFile: at(build, "contracts", "generated", "Groth16Verifier.sol") });
      const inputs = (src.match(/uint(?:256)?\[(\d+)\] calldata _pubSignals/) ?? [])[1];
      return { summary: `exported Groth16Verifier.sol (${src.length} bytes, ${inputs ?? "?"} public signals)`, details: { publicSignals: Number(inputs) }, artifacts: ["contracts/generated/Groth16Verifier.sol"] };
    }

    case "contracts.compile": {
      const { compileContracts } = await import("./contracts.ts"); // loads solc, which is slow to start
      const r = await compileContracts({ contractsDir: path.join(PROJECT_ROOT, "contracts"), verifierSource: at(build, "contracts", "generated", "Groth16Verifier.sol"), outDir: at(build, "contracts"), log });
      return {
        summary: `compiled ${Object.keys(r.contracts).length} contracts with solc ${r.solcVersion} (evm ${r.evmVersion})`,
        details: {
          solcVersion: r.solcVersion,
          evmVersion: r.evmVersion,
          optimizerRuns: r.optimizerRuns,
          sources: r.sources,
          contracts: Object.fromEntries(Object.values(r.contracts).map((c) => [c.name, { bytecodeHash: c.bytecodeHash, hashKind: c.hashKind, sizeBytes: c.sizeBytes, abiSha256: c.abiSha256, immutables: Object.keys(c.immutables) }]))
        },
        artifacts: Object.keys(r.contracts).map((n) => `contracts/${n}.json`),
        warnings: r.warnings
      };
    }

    case "circuit.selftest": {
      const req = JSON.parse(await readStdin()) as { input: Record<string, unknown>; aliasedKeyInput: Record<string, unknown>; expectedPublic: string[]; note: { leafIndex: number; value: string }; pool: string; asset: string };
      if (!req.aliasedKeyInput) throw new Error("ERR_SELFTEST: the request carries no aliased-key witness to test against");
      const vkey = JSON.parse(fs.readFileSync(at(build, "keys", "verification_key.json"), "utf8"));
      const wasm = at(build, "circuit", "unshield_js", "unshield.wasm");
      const zkey = at(build, "keys", "unshield_final.zkey");
      log(`proving an unshield of a real ${req.asset} note (leaf #${req.note.leafIndex}) from the live simulation`);
      const r = await proveAndVerify({ input: req.input, wasm, zkey, vkey });
      const matches = JSON.stringify(r.publicSignals) === JSON.stringify(req.expectedPublic);
      log(`proof ${r.verified ? "verifies" : "DOES NOT verify"} in ${r.proveMs} ms; public signals ${matches ? "equal" : "DIFFER FROM"} the simulation's`);
      let wrongKeyRejected = false;
      try {
        await snarkjs.wtns.calculate({ ...req.input, spendingKey: (BigInt(req.input.spendingKey as string) + 1n).toString() }, wasm, at(build, "circuit", ".rejected.wtns"));
      } catch {
        wrongKeyRejected = true;
      } finally {
        fs.rmSync(at(build, "circuit", ".rejected.wtns"), { force: true });
      }
      log(`a wrong spending key ${wrongKeyRejected ? "is rejected by the circuit" : "WAS ACCEPTED"}`);
      // key + L is the same public key: without C3's range it proves the same note under a second nullifier.
      let aliasedKeyRejected = false;
      try {
        await snarkjs.wtns.calculate(req.aliasedKeyInput, wasm, at(build, "circuit", ".aliased.wtns"));
      } catch {
        aliasedKeyRejected = true;
      } finally {
        fs.rmSync(at(build, "circuit", ".aliased.wtns"), { force: true });
      }
      log(`an aliased spending key (key + L, a second nullifier for the same note) ${aliasedKeyRejected ? "is rejected by the circuit" : "WAS ACCEPTED: the note could be spent twice"}`);
      if (!r.verified || !matches || !r.tamperedRejected || !wrongKeyRejected || !aliasedKeyRejected) {
        throw new Error(`ERR_SELFTEST: verified=${r.verified} publicSignalsMatchSimulation=${matches} tamperedRejected=${r.tamperedRejected} wrongKeyRejected=${wrongKeyRejected} aliasedKeyRejected=${aliasedKeyRejected}`);
      }
      return {
        summary: `real ${req.asset} note proved and verified in ${r.proveMs} ms; every public signal equals the simulation's; tampering, a wrong key and an aliased key are rejected`,
        details: { asset: req.asset, pool: req.pool, leafIndex: req.note.leafIndex, proveMs: r.proveMs, verified: r.verified, publicSignalsMatchSimulation: matches, tamperedRejected: r.tamperedRejected, wrongKeyRejected, aliasedKeyRejected }
      };
    }

    case "evm.local": {
      const { runLocalEvmScenario } = await import("./evm.ts"); // loads the EVM
      const report = await runLocalEvmScenario({ buildDir: build, log });
      if (!report.ok) throw new Error(`ERR_EVM_SCENARIO: ${report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join("; ")}`);
      return {
        summary: `${report.checks.length} on-chain checks passed against the compiled contracts in a local EVM (shield ${report.gas.shield} gas, unshield ${report.gas.unshield} gas)`,
        details: report
      };
    }

    default:
      throw new Error(`unknown stage '${stage}'`);
  }
}

async function main(): Promise<void> {
  const [stage, ...rest] = process.argv.slice(2);
  const buildIdx = rest.indexOf("--build");
  const build = buildIdx >= 0 ? rest[buildIdx + 1] : undefined;
  const ptauIdx = rest.indexOf("--ptau-cache");
  if (!stage || !build) {
    emit({ t: "error", message: "usage: stageRunner.ts <stage> --build <dir>" });
    process.exit(2);
  }
  fs.mkdirSync(build, { recursive: true });
  try {
    const r = await runStage(stage, build, ptauIdx >= 0 ? rest[ptauIdx + 1] : path.join(build, "ptau"));
    emit({ t: "result", ok: true, ...r });
    process.exit(0);
  } catch (err) {
    emit({ t: "error", message: (err as Error).message ?? String(err) });
    process.exit(1);
  }
}

// Only run when started as the child process, so importing this module (for its types) has no effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
