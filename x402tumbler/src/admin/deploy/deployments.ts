/**
 * DarkCircle admin console: on-chain deployment record store
 * File: src/admin/deploy/deployments.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * One JSON file per network (`build/deployments/<network-id>.json`) recording every contract this
 * console has confirmed deployed there: address, transaction hash, block, deployer, when, the bytecode
 * hash it was BUILT for (from the compile manifest) and the bytecode hash actually read back from chain
 * after deployment. A record is written only after `chain.ts` has verified the deployment on chain — this
 * file is a cache of "verified true" facts, never of intent, so `plan()` and the UI can tell a real,
 * checked deployment apart from one that only exists on paper.
 *
 * The three shared contracts (the two Poseidon hashers and the verifier) are keyed by name alone: they do
 * not depend on the settlement asset and are deployed once per network, then reused by every pool. The
 * pool is keyed by `DarkCirclePool:<ASSET>` because each asset gets its own instance.
 */

import fs from "node:fs";
import path from "node:path";

export type DeploymentKey = "PoseidonT3" | "PoseidonT5" | "Groth16Verifier" | `DarkCirclePool:${string}`;

export interface DeploymentRecord {
  contract: string;
  key: DeploymentKey;
  address: string;
  txHash: string;
  blockNumber: number;
  deployer: string;
  deployedAt: string;
  /** The build's expected bytecode hash (from the compile stage) this deployment was checked against. */
  expectedBytecodeHash: string;
  expectedHashKind: "runtime" | "creation";
  /** What was actually read back from chain (quai_getCode, keccak256'd) right after deployment. */
  onChainRuntimeHash: string;
  gasUsed: string;
}

export interface DeploymentFile {
  version: 1;
  network: string;
  chainId: number;
  updatedAt: string;
  records: Partial<Record<DeploymentKey, DeploymentRecord>>;
}

export const poolKey = (asset: string): DeploymentKey => `DarkCirclePool:${asset.toUpperCase()}`;

function file(deploymentsDir: string, networkId: string): string {
  return path.join(deploymentsDir, `${networkId}.json`);
}

export function readDeployments(deploymentsDir: string, networkId: string, chainId: number): DeploymentFile {
  const f = file(deploymentsDir, networkId);
  if (fs.existsSync(f)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as DeploymentFile;
      if (parsed.version === 1 && parsed.network === networkId) return parsed;
    } catch {
      /* fall through to a fresh file; the caller's chain-verified writes are the source of truth */
    }
  }
  return { version: 1, network: networkId, chainId, updatedAt: new Date(0).toISOString(), records: {} };
}

/** Atomically records one verified deployment. Refuses to silently overwrite a different address. */
export function recordDeployment(
  deploymentsDir: string,
  networkId: string,
  chainId: number,
  entry: DeploymentRecord,
  opts: { allowReplace?: boolean } = {}
): DeploymentFile {
  const current = readDeployments(deploymentsDir, networkId, chainId);
  const existing = current.records[entry.key];
  if (existing && existing.address.toLowerCase() !== entry.address.toLowerCase() && !opts.allowReplace) {
    throw new Error(
      `ERR_DEPLOYMENT_ALREADY_RECORDED: ${entry.key} on ${networkId} is already recorded at ${existing.address} (tx ${existing.txHash}); refusing to silently replace it with ${entry.address}`
    );
  }
  current.records[entry.key] = entry;
  current.updatedAt = new Date().toISOString();
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const f = file(deploymentsDir, networkId);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, f);
  return current;
}

export function removeDeployment(deploymentsDir: string, networkId: string, chainId: number, key: DeploymentKey): DeploymentFile {
  const current = readDeployments(deploymentsDir, networkId, chainId);
  delete current.records[key];
  current.updatedAt = new Date().toISOString();
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const f = file(deploymentsDir, networkId);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, f);
  return current;
}
