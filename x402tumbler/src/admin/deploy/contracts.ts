/**
 * DarkCircle admin console: contract compilation
 * File: src/admin/deploy/contracts.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * Compiles the pool, the dev token and the generated Groth16 verifier with solc-js, and produces the two
 * Poseidon hasher contracts from circomlibjs. Every artifact carries a hash of its deployed bytecode: the
 * checklist item "bytecode hash matches the audited build" (docs/SHIELDED_POOL_CHECKLIST.md, A1) needs a
 * number to compare, and this is where it comes from.
 *
 * The EVM target is pinned (paris) instead of taking solc's newest default, because Quai's EVM is a fork and
 * a compiler upgrade must not silently change which opcodes the deployed code uses.
 *
 * Every artifact carries a RUNTIME hash, so every deployment can be checked byte for byte:
 *  - circomlibjs ships the hashers as creation code only, so their runtime code is obtained by running that
 *    creation code in a local EVM (it takes no constructor arguments and touches no other contract);
 *  - contracts with `immutable` variables (the pool) record where solc left the placeholders, by name, so the
 *    on-chain check can rebuild the exact code for the constructor values it expects (see bytecode.ts).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keccak256 } from "ethers";
import solc from "solc";
import * as circomlibjs from "circomlibjs";
import type { ImmutableRef } from "./bytecode.ts";

export const EVM_VERSION = "paris";
export const OPTIMIZER_RUNS = 200;
/** EIP-170 limit on deployed code size; Quai may differ, so this is a warning threshold, not a verdict. */
export const CODE_SIZE_WARN = 24576;

export interface CompiledContract {
  name: string;
  source: string;
  abi: unknown[];
  bytecode: string;
  deployedBytecode: string;
  /**
   * keccak256 of the runtime bytecode. For a contract with immutables this is the code with zero
   * placeholders; the code actually deployed differs at `immutables` and is rebuilt per deployment.
   */
  bytecodeHash: string;
  /** Always "runtime" for artifacts this module writes; "creation" only appears in artifacts from older builds. */
  hashKind: "runtime" | "creation";
  /** immutable name -> byte ranges in deployedBytecode, from solc's immutableReferences. Empty when none. */
  immutables: Record<string, ImmutableRef[]>;
  abiSha256: string;
  sizeBytes: number;
}

export interface ContractsResult {
  solcVersion: string;
  evmVersion: string;
  optimizerRuns: number;
  sources: Array<{ path: string; sha256: string }>;
  contracts: Record<string, CompiledContract>;
  warnings: string[];
}

const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const hex = (s: string) => (s.startsWith("0x") ? s : `0x${s}`);

function pack(name: string, source: string, abi: unknown[], bytecode: string, deployed: string, immutables: Record<string, ImmutableRef[]> = {}): CompiledContract {
  const runtime = hex(deployed);
  if (runtime === "0x") throw new Error(`ERR_NO_RUNTIME_CODE: ${name} has no runtime bytecode to hash`);
  return {
    name,
    source,
    abi,
    bytecode: hex(bytecode),
    deployedBytecode: runtime,
    bytecodeHash: keccak256(runtime),
    hashKind: "runtime",
    immutables,
    abiSha256: sha256(JSON.stringify(abi)),
    sizeBytes: (runtime.length - 2) / 2
  };
}

/** Runs creation code (no constructor arguments, no external calls) in a fresh local EVM and returns the code it deploys. */
export async function runtimeOf(creation: string): Promise<string> {
  const { createEVM } = await import("@ethereumjs/evm");
  const { Common, Mainnet, Hardfork } = await import("@ethereumjs/common");
  const { Address, bytesToHex, hexToBytes } = await import("@ethereumjs/util");
  const evm: any = await createEVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai }) });
  const caller = new Address(hexToBytes("0x00000000000000000000000000000000000000d0"));
  const r = await evm.runCall({ caller, data: hexToBytes(hex(creation) as `0x${string}`), gasLimit: 30_000_000n });
  if (r.execResult.exceptionError || !r.createdAddress) throw new Error(`ERR_RUNTIME_DERIVATION: creation code failed in the local EVM (${r.execResult.exceptionError?.error ?? "no address"})`);
  return bytesToHex(await evm.stateManager.getCode(r.createdAddress));
}

/** Poseidon over BN254 as an EVM contract (circomlibjs). `inputs` 2 -> PoseidonT3, 4 -> PoseidonT5. */
export async function poseidonHasher(inputs: 2 | 4): Promise<CompiledContract> {
  const code: string = circomlibjs.poseidonContract.createCode(inputs);
  const abi: unknown[] = circomlibjs.poseidonContract.generateABI(inputs);
  // circomlibjs returns creation code only; the runtime code is what that creation code deploys.
  return pack(inputs === 2 ? "PoseidonT3" : "PoseidonT5", "circomlibjs", abi, code, await runtimeOf(code));
}

/** AST id -> name of every `immutable` state variable, so solc's id-keyed immutableReferences can be named. */
function immutableNames(ast: unknown): Map<number, string> {
  const names = new Map<number, string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable" && typeof n.id === "number" && typeof n.name === "string") names.set(n.id, n.name);
    for (const v of Object.values(n)) if (v && typeof v === "object") Array.isArray(v) ? v.forEach(walk) : walk(v);
  };
  walk(ast);
  return names;
}

export async function compileContracts(o: { contractsDir: string; verifierSource: string; outDir: string; log: (m: string) => void }): Promise<ContractsResult> {
  const inputs: Record<string, { content: string }> = {};
  const sources: ContractsResult["sources"] = [];
  const add = (name: string, content: string) => {
    inputs[name] = { content };
    sources.push({ path: name, sha256: sha256(content) });
  };
  for (const f of ["DarkCirclePool.sol", "DevToken.sol"]) add(f, fs.readFileSync(path.join(o.contractsDir, f), "utf8"));
  add("Groth16Verifier.sol", fs.readFileSync(o.verifierSource, "utf8"));

  o.log(`solc ${solc.version()}: compiling ${Object.keys(inputs).join(", ")} (evm ${EVM_VERSION}, optimizer ${OPTIMIZER_RUNS} runs)`);
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: inputs,
        settings: {
          evmVersion: EVM_VERSION,
          optimizer: { enabled: true, runs: OPTIMIZER_RUNS },
          outputSelection: { "*": { "": ["ast"], "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } }
        }
      })
    )
  ) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, any>>; sources?: Record<string, { ast?: unknown }> };

  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(`ERR_SOLC_COMPILE: ${errors.map((e) => e.formattedMessage).join("\n").slice(0, 2000)}`);
  const warnings = (output.errors ?? []).filter((e) => e.severity === "warning").map((e) => e.formattedMessage.split("\n")[0]);

  const idToName = new Map<number, string>();
  for (const src of Object.values(output.sources ?? {})) for (const [id, name] of immutableNames(src.ast)) idToName.set(id, name);

  const contracts: Record<string, CompiledContract> = {};
  for (const [file, byName] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(byName)) {
      if (!c.evm?.bytecode?.object) continue; // interfaces
      const refs = (c.evm.deployedBytecode.immutableReferences ?? {}) as Record<string, ImmutableRef[]>;
      const immutables: Record<string, ImmutableRef[]> = {};
      for (const [id, ranges] of Object.entries(refs)) {
        const varName = idToName.get(Number(id));
        if (!varName) throw new Error(`ERR_SOLC_COMPILE: ${name} has an immutable (AST id ${id}) the compiler output does not name`);
        immutables[varName] = ranges.map((r) => ({ start: r.start, length: r.length }));
      }
      contracts[name] = pack(name, file, c.abi, c.evm.bytecode.object, c.evm.deployedBytecode.object, immutables);
    }
  }
  for (const need of ["DarkCirclePool", "DevToken", "Groth16Verifier"]) {
    if (!contracts[need]) throw new Error(`ERR_SOLC_COMPILE: ${need} was not produced`);
  }
  const poolImmutables = Object.keys(contracts.DarkCirclePool.immutables).sort().join(",");
  if (poolImmutables !== "hasher2,hasher4,token,verifier") {
    throw new Error(`ERR_SOLC_COMPILE: DarkCirclePool's immutables are [${poolImmutables}], expected [hasher2,hasher4,token,verifier]; the deployment check would not know how to rebuild its code`);
  }
  for (const n of [2, 4] as const) {
    const h = await poseidonHasher(n);
    contracts[h.name] = h;
  }

  fs.mkdirSync(o.outDir, { recursive: true });
  for (const c of Object.values(contracts)) fs.writeFileSync(path.join(o.outDir, `${c.name}.json`), JSON.stringify({ contractName: c.name, source: c.source, abi: c.abi, bytecode: c.bytecode, deployedBytecode: c.deployedBytecode, bytecodeHash: c.bytecodeHash, hashKind: c.hashKind, immutables: c.immutables }, null, 2));

  for (const c of Object.values(contracts)) {
    if (c.sizeBytes > CODE_SIZE_WARN) warnings.push(`${c.name}: deployed code is ${c.sizeBytes} bytes, above the ${CODE_SIZE_WARN}-byte EIP-170 limit`);
  }
  o.log(`compiled ${Object.keys(contracts).length} contracts; pool ${contracts.DarkCirclePool.sizeBytes} bytes, verifier ${contracts.Groth16Verifier.sizeBytes} bytes`);
  return { solcVersion: solc.version(), evmVersion: EVM_VERSION, optimizerRuns: OPTIMIZER_RUNS, sources, contracts, warnings };
}
