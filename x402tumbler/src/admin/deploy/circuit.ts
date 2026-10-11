/**
 * DarkCircle admin console: circuit tooling (compile, ceremony, keys, proofs)
 * File: src/admin/deploy/circuit.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * Every function here is real: circom compiles the circuit, snarkjs runs a powers-of-tau and a Groth16
 * setup, produces and verifies proofs, and exports the Solidity verifier. What is NOT real is the trust:
 * the ceremony below has ONE contributor, this machine, so whoever controls this machine's randomness can
 * forge proofs. It exists so the rest of the pipeline can be exercised; keys made here must never guard
 * value. trustedSetupDev() says so in its result and the manifest records it.
 *
 * Run inside a stage child process (stageRunner.ts), not in the API server: snarkjs keeps worker threads
 * alive after use and the ceremony is CPU-heavy.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as snarkjs from "snarkjs";
import { getCurveFromName } from "ffjavascript";

const require = createRequire(import.meta.url);

export type Log = (message: string) => void;

const sha256File = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const entropy = () => crypto.randomBytes(32).toString("hex");

/** snarkjs logger that forwards info/warn/error and drops its very chatty debug output. */
function logger(log: Log) {
  return { debug: () => {}, info: (m: string) => log(String(m)), warn: (m: string) => log(`warning: ${m}`), error: (m: string) => log(`error: ${m}`) };
}

export function circomLibDir(): string {
  return path.join(path.dirname(require.resolve("circomlib/package.json")), "circuits");
}

export interface CompileResult {
  r1cs: string;
  wasm: string;
  sym: string;
  constraints: number;
  publicInputs: number;
  privateInputs: number;
  wires: number;
  compilerOutput: string;
}

/** Compiles `source` (a .circom file) into `outDir`: r1cs, wasm witness generator and symbol table. */
export async function compileCircuit(o: { source: string; outDir: string; log: Log }): Promise<CompileResult> {
  const name = path.basename(o.source, ".circom");
  fs.rmSync(o.outDir, { recursive: true, force: true });
  fs.mkdirSync(o.outDir, { recursive: true });
  fs.copyFileSync(o.source, path.join(o.outDir, `${name}.circom`));
  const cli = require.resolve("circom2/cli.js");
  o.log(`circom2: compiling ${name}.circom against circomlib ${circomLibDir()}`);
  let out: string;
  try {
    // cwd must be the output directory: the WASM build only sees paths reachable from it.
    out = execFileSync(process.execPath, [cli, `${name}.circom`, "--r1cs", "--wasm", "--sym", "-l", circomLibDir(), "-o", "."], { cwd: o.outDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`ERR_CIRCOM_COMPILE: ${(e.stderr || e.stdout || e.message).toString().slice(0, 1500)}`);
  }
  const r1cs = path.join(o.outDir, `${name}.r1cs`);
  const wasm = path.join(o.outDir, `${name}_js`, `${name}.wasm`);
  const sym = path.join(o.outDir, `${name}.sym`);
  for (const f of [r1cs, wasm, sym]) if (!fs.existsSync(f)) throw new Error(`ERR_CIRCOM_COMPILE: expected output ${f} was not produced`);
  const info = await snarkjs.r1cs.info(r1cs, logger(() => {}));
  const result: CompileResult = {
    r1cs,
    wasm,
    sym,
    constraints: Number(info.nConstraints),
    publicInputs: Number(info.nPubInputs),
    privateInputs: Number(info.nPrvInputs),
    wires: Number(info.nVars),
    compilerOutput: out.replace(/\x1b\[[0-9;]*m/g, "").trim()
  };
  o.log(`compiled: ${result.constraints} constraints, ${result.publicInputs} public and ${result.privateInputs} private inputs`);
  return result;
}

/**
 * The powers-of-tau size a circuit needs. Mirrors snarkjs: it requires floor(log2(constraints + public
 * inputs + outputs)) + 1 <= power. A ceremony that is too small does not fail cleanly, it writes a broken
 * proving key, which is why this is computed instead of guessed.
 */
export function requiredPower(c: { constraints: number; publicInputs: number; outputs?: number }): number {
  const n = c.constraints + c.publicInputs + (c.outputs ?? 0);
  return 31 - Math.clz32(n) + 1;
}

export interface PtauResult {
  file: string;
  power: number;
  sha256: string;
  reused: boolean;
}

/**
 * A single-contributor powers-of-tau, cached by size. Reuse is only allowed when the file still hashes to
 * the digest recorded when it was made, so a truncated or edited cache entry is rebuilt, not trusted.
 */
export async function ensurePtau(o: { power: number; cacheDir: string; log: Log }): Promise<PtauResult> {
  fs.mkdirSync(o.cacheDir, { recursive: true });
  const file = path.join(o.cacheDir, `pot${o.power}_final.ptau`);
  const sidecar = `${file}.sha256`;
  if (fs.existsSync(file) && fs.existsSync(sidecar)) {
    const recorded = fs.readFileSync(sidecar, "utf8").trim();
    const actual = sha256File(file);
    if (recorded === actual) {
      o.log(`reusing cached powers of tau 2^${o.power} (${actual.slice(0, 12)}…)`);
      return { file, power: o.power, sha256: actual, reused: true };
    }
    o.log("cached powers of tau failed its integrity check; rebuilding");
  }
  const stamp = `${process.pid}-${Date.now()}`;
  const p0 = path.join(o.cacheDir, `pot${o.power}_0000.${stamp}.ptau`);
  const p1 = path.join(o.cacheDir, `pot${o.power}_0001.${stamp}.ptau`);
  const tmpFinal = path.join(o.cacheDir, `pot${o.power}_final.${stamp}.ptau`);
  const log = logger(o.log);
  const curve = await getCurveFromName("bn128");
  const t0 = Date.now();
  try {
    o.log(`powers of tau 2^${o.power}: new accumulator (this is the slow step; it is cached afterwards)`);
    await snarkjs.powersOfTau.newAccumulator(curve, o.power, p0, log);
    o.log("powers of tau: contributing local entropy (one contributor: DEVELOPMENT ONLY)");
    await snarkjs.powersOfTau.contribute(p0, p1, "darkcircle development contribution", entropy(), log);
    o.log("powers of tau: preparing phase 2");
    await snarkjs.powersOfTau.preparePhase2(p1, tmpFinal, log);
    fs.renameSync(tmpFinal, file);
    const digest = sha256File(file);
    fs.writeFileSync(sidecar, digest);
    o.log(`powers of tau ready in ${Math.round((Date.now() - t0) / 1000)} s (${digest.slice(0, 12)}…)`);
    return { file, power: o.power, sha256: digest, reused: false };
  } finally {
    for (const f of [p0, p1, tmpFinal]) fs.rmSync(f, { force: true });
  }
}

export interface SetupResult {
  zkey: string;
  vkeyFile: string;
  vkey: unknown;
  zkeySha256: string;
  /** Always false here: one contributor is not a trusted setup. */
  productionSafe: false;
  ceremony: string;
  zkeyVerified: boolean;
}

/** Groth16 phase 2 with one local contribution, then a check of the proving key against the circuit and the ptau. */
export async function trustedSetupDev(o: { r1cs: string; ptau: string; outDir: string; log: Log; verifyKey?: boolean }): Promise<SetupResult> {
  fs.mkdirSync(o.outDir, { recursive: true });
  const name = path.basename(o.r1cs, ".r1cs");
  const z0 = path.join(o.outDir, `${name}_0000.zkey`);
  const zf = path.join(o.outDir, `${name}_final.zkey`);
  const vkeyFile = path.join(o.outDir, "verification_key.json");
  const log = logger(o.log);
  const t0 = Date.now();
  try {
    o.log("groth16 setup: deriving the proving key from the circuit and the powers of tau");
    await snarkjs.zKey.newZKey(o.r1cs, o.ptau, z0, log);
    o.log("groth16 setup: contributing local entropy (one contributor: DEVELOPMENT ONLY)");
    await snarkjs.zKey.contribute(z0, zf, "darkcircle development contribution", entropy(), log);
  } finally {
    fs.rmSync(z0, { force: true });
  }
  let zkeyVerified = false;
  if (o.verifyKey !== false) {
    o.log("groth16 setup: verifying the proving key against the circuit and the ceremony");
    zkeyVerified = (await snarkjs.zKey.verifyFromR1cs(o.r1cs, o.ptau, zf, log)) === true;
    if (!zkeyVerified) throw new Error("ERR_ZKEY_INVALID: the proving key does not verify against the circuit and the powers of tau");
  }
  const vkey = await snarkjs.zKey.exportVerificationKey(zf, log);
  fs.writeFileSync(vkeyFile, JSON.stringify(vkey, null, 2));
  o.log(`setup finished in ${Math.round((Date.now() - t0) / 1000)} s`);
  return {
    zkey: zf,
    vkeyFile,
    vkey,
    zkeySha256: sha256File(zf),
    productionSafe: false,
    ceremony: "DEV-LOCAL-SINGLE-CONTRIBUTOR: anyone controlling this machine's entropy can forge proofs. Never use these keys to guard value.",
    zkeyVerified
  };
}

/** Renders the Solidity verifier for a proving key using snarkjs's own Groth16 template. */
export async function exportSolidityVerifier(o: { zkey: string; outFile: string }): Promise<string> {
  const template = path.resolve(path.dirname(require.resolve("snarkjs")), "..", "templates", "verifier_groth16.sol.ejs");
  const source: string = await snarkjs.zKey.exportSolidityVerifier(o.zkey, { groth16: fs.readFileSync(template, "utf8") });
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  fs.writeFileSync(o.outFile, source);
  return source;
}

export interface ProofResult {
  proof: unknown;
  publicSignals: string[];
  verified: boolean;
  /** A proof checked against a public signal that was changed by one must fail. */
  tamperedRejected: boolean;
  calldata: string;
  proveMs: number;
}

export async function proveAndVerify(o: { input: Record<string, unknown>; wasm: string; zkey: string; vkey: unknown }): Promise<ProofResult> {
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(o.input, o.wasm, o.zkey);
  const proveMs = Date.now() - t0;
  const verified = (await snarkjs.groth16.verify(o.vkey, publicSignals, proof)) === true;
  const tampered = [...publicSignals];
  tampered[5] = (BigInt(tampered[5]) + 1n).toString();
  const tamperedRejected = (await snarkjs.groth16.verify(o.vkey, tampered, proof)) === false;
  const calldata: string = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  return { proof, publicSignals: publicSignals.map(String), verified, tamperedRejected, calldata, proveMs };
}
