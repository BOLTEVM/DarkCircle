/**
 * DarkCircle admin console: expected on-chain code
 * File: src/admin/deploy/bytecode.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * A contract with `immutable` variables does not deploy the runtime code solc prints: its constructor writes
 * each immutable's value into the code at fixed offsets (solc reports them as immutableReferences), and the
 * compiled `deployedBytecode` holds zeros there. DarkCirclePool has four (token, verifier, hasher2, hasher4),
 * so comparing its on-chain code with the compiled code can never match, and a check that masked those
 * offsets would accept a pool bound to the wrong verifier.
 *
 * This module rebuilds the exact code a deployment with given constructor values must have, so the check is
 * a byte-for-byte hash comparison that also proves every immutable holds the intended address. The local EVM
 * stage compares this reconstruction with what a real EVM actually deployed.
 */

import { keccak256 } from "ethers";

export interface ImmutableRef {
  start: number;
  length: number;
}

export interface RuntimeArtifact {
  contractName?: string;
  deployedBytecode: string;
  /** immutable name -> byte ranges in deployedBytecode (from solc's immutableReferences). */
  immutables?: Record<string, ImmutableRef[]>;
}

/** The 32-byte word solc stores for an address- or uint-typed immutable. */
export function immutableWord(value: string | bigint): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new Error(`ERR_IMMUTABLE_VALUE: ${String(value)} does not fit a 32-byte word`);
  return n.toString(16).padStart(64, "0");
}

/**
 * The runtime code a deployment must have, with every immutable filled in. `values` must name exactly the
 * artifact's immutables: a missing or unexpected name is an error, never a silent partial match.
 */
export function expectedRuntimeCode(artifact: RuntimeArtifact, values: Record<string, string | bigint>): string {
  const refs = artifact.immutables ?? {};
  const names = Object.keys(refs);
  const given = Object.keys(values);
  const missing = names.filter((n) => !(n in values));
  const unexpected = given.filter((n) => !(n in refs));
  if (missing.length || unexpected.length) {
    throw new Error(`ERR_IMMUTABLES_MISMATCH: ${artifact.contractName ?? "contract"} needs [${names.join(", ")}]${missing.length ? `; missing ${missing.join(", ")}` : ""}${unexpected.length ? `; not immutables: ${unexpected.join(", ")}` : ""}`);
  }
  let code = artifact.deployedBytecode.startsWith("0x") ? artifact.deployedBytecode.slice(2) : artifact.deployedBytecode;
  for (const name of names) {
    const word = immutableWord(values[name]);
    for (const r of refs[name]) {
      if (r.length !== 32) throw new Error(`ERR_IMMUTABLE_REF: ${name} has a ${r.length}-byte reference; only 32-byte words are supported`);
      const at = r.start * 2;
      if (at < 0 || at + 64 > code.length) throw new Error(`ERR_IMMUTABLE_REF: ${name} reference at byte ${r.start} lies outside the code`);
      code = code.slice(0, at) + word + code.slice(at + 64);
    }
  }
  return "0x" + code.toLowerCase();
}

export function expectedRuntimeHash(artifact: RuntimeArtifact, values: Record<string, string | bigint>): string {
  return keccak256(expectedRuntimeCode(artifact, values));
}
