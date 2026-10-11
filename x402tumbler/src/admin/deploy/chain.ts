/**
 * DarkCircle admin console: real on-chain deployment (wallet-signed)
 * File: src/admin/deploy/chain.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * This module never signs or broadcasts a transaction. It builds creation calldata and a gas budget for
 * the operator's OWN wallet to sign and send (in the browser, via quai_sendTransaction against
 * window.pelagus/blip/quai — see ui/wallet.js), reads back what actually landed on chain through the
 * read-only QuaiRpcClient (src/quai/rpc.ts, already used by pnpm verify:quai and payment verification), and
 * only then writes a deployment record. Every claim here is checked, never assumed:
 *
 *  - Right before the wallet is asked to sign, `prepare()` rebuilds the step and SIMULATES it on the target
 *    zone: quai_createAccessList (attached to the transaction; the pool's constructor calls its hasher, and a
 *    multi-contract transaction without an access list reverts on Quai and burns its whole gas limit) and
 *    quai_estimateGas. A step that would revert is refused before anything is signed.
 *  - The gas limit is never the raw estimate: on Quai contract creation has been charged about 2.5x
 *    quai_estimateGas (a 16,903-byte deploy that estimated ~6.5M gas used 16,025,454). The limit is the larger
 *    of 1,250 gas per runtime byte and 3x the live estimate, capped below the block gas limit, and a step whose
 *    cap leaves less than 2.5x headroom is refused rather than sent to run out of gas.
 *  - An address is never predicted. It is read off the transaction receipt after the wallet confirms it.
 *  - After reading it, this module checks the receipt is a contract creation sent by the claimed deployer,
 *    re-derives the zone from the address (Quai grinds contract addresses into the deployer's zone; a
 *    wrong-zone result would be unusable), and compares the deployed code's hash with the EXACT code the
 *    build predicts: for the pool, the compiled code with its four immutables (token, verifier, hashers)
 *    filled in from the recorded dependencies, so the check also proves what the pool is bound to.
 *  - Which contract a step deploys follows from its key alone; the client does not get to say.
 */

import fs from "node:fs";
import path from "node:path";
import { Interface, keccak256 } from "ethers";
import { QuaiRpcClient, type QuaiAccessListEntry, type QuaiReceipt } from "../../quai/rpc.ts";
import { assertQuaiPaymentAddress, isAddressInZone, getAddressZone, toQuaiChecksum } from "../../quai/address.ts";
import { defaultQuaiTokenRegistry } from "../../quai/tokens.ts";
import type { QuaiNetwork } from "../../quai/networks.ts";
import { expectedRuntimeHash, type ImmutableRef } from "./bytecode.ts";
import { poolKey, readDeployments, recordDeployment, type DeploymentFile, type DeploymentKey, type DeploymentRecord } from "./deployments.ts";

/** Size-based gas limit: generous headroom over what a same-sized deploy has actually cost. */
export const CREATION_GAS_PER_RUNTIME_BYTE = 1_250n;
/** What a same-sized deploy has actually been CHARGED, for the cost estimate shown to the operator. */
export const CREATION_GAS_USED_PER_RUNTIME_BYTE = 948n;
/** Creation has been charged about 2.5x quai_estimateGas on Cyprus-1 (in tenths). */
export const OBSERVED_ESTIMATE_RATIO_TENTHS = 25n;
/** The gas limit keeps this multiple of the live estimate. */
export const ESTIMATE_HEADROOM = 3n;
export const MIN_CREATION_GAS = 600_000n;
export const MAX_CREATION_GAS = 45_000_000n;
const RECEIPT_POLL_MS = 3_000;
const RECEIPT_TIMEOUT_MS = 180_000;

function clampGas(v: bigint): bigint {
  return v < MIN_CREATION_GAS ? MIN_CREATION_GAS : v > MAX_CREATION_GAS ? MAX_CREATION_GAS : v;
}
export const creationGasLimit = (runtimeBytes: number): bigint => clampGas(BigInt(runtimeBytes) * CREATION_GAS_PER_RUNTIME_BYTE);
export const expectedCreationGasUsed = (runtimeBytes: number): bigint => BigInt(runtimeBytes) * CREATION_GAS_USED_PER_RUNTIME_BYTE;

const max = (...v: bigint[]) => v.reduce((a, b) => (b > a ? b : a));
const min = (...v: bigint[]) => v.reduce((a, b) => (b < a ? b : a));

export interface GasPlan {
  gasLimit: bigint;
  expectedGasUsed: bigint;
  /** Set when no permitted limit leaves the headroom creation needs on Quai: the step must not be sent. */
  blocking: string | null;
  warnings: string[];
}

/** The gas limit and expected charge for a creation of `runtimeBytes`, given the live estimate when known. */
export function planCreationGas(o: { runtimeBytes: number; estimate?: bigint; blockGasLimit?: bigint }): GasPlan {
  const warnings: string[] = [];
  const bySize = BigInt(o.runtimeBytes) * CREATION_GAS_PER_RUNTIME_BYTE;
  const byEstimate = o.estimate !== undefined ? o.estimate * ESTIMATE_HEADROOM : 0n;
  const cap = o.blockGasLimit !== undefined ? min(MAX_CREATION_GAS, (o.blockGasLimit * 95n) / 100n) : MAX_CREATION_GAS;
  let gasLimit = max(MIN_CREATION_GAS, bySize, byEstimate);
  if (gasLimit > cap) {
    warnings.push(`the preferred gas limit ${gasLimit} is above what this network accepts; capped at ${cap}`);
    gasLimit = cap;
  }
  const needed = o.estimate !== undefined ? (o.estimate * OBSERVED_ESTIMATE_RATIO_TENTHS) / 10n : 0n;
  const blocking =
    o.estimate !== undefined && gasLimit < needed
      ? `the largest gas limit this network accepts (${gasLimit}) is below 2.5x the estimate (${needed}); creation has been charged about that much on Quai, so this deployment would likely run out of gas and burn the whole limit`
      : null;
  return { gasLimit, expectedGasUsed: max(BigInt(o.runtimeBytes) * CREATION_GAS_USED_PER_RUNTIME_BYTE, needed), blocking, warnings };
}

export interface ContractArtifact {
  contractName: string;
  abi: unknown[];
  bytecode: string;
  deployedBytecode: string;
  bytecodeHash: string;
  hashKind: "runtime" | "creation";
  immutables?: Record<string, ImmutableRef[]>;
}

export function loadArtifact(contractsDir: string, name: string): ContractArtifact {
  if (!/^[A-Za-z0-9]+$/.test(name)) throw new Error(`ERR_ARTIFACT_NAME: '${name}' is not a contract name`);
  const file = path.join(contractsDir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`ERR_ARTIFACT_MISSING: ${name} (run the contracts.compile stage first)`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as ContractArtifact;
}

/** Runtime byte count (older artifacts that only carry creation code fall back to its length). */
function sizeOf(artifact: ContractArtifact): number {
  const hex = artifact.deployedBytecode && artifact.deployedBytecode !== "0x" ? artifact.deployedBytecode : artifact.bytecode;
  return (hex.length - 2) / 2;
}

/** The contract a deployment key deploys. The key decides; nothing else is trusted to. */
export function contractForKey(key: DeploymentKey): string {
  return key.startsWith("DarkCirclePool:") ? "DarkCirclePool" : key;
}

export interface DeployStep {
  key: DeploymentKey;
  contract: string;
  data: string;
  gasLimit: string;
  expectedCostWei: string;
  constructorArgs: Array<{ name: string; value: string }>;
  alreadyDeployed: DeploymentRecord | null;
}

const SHARED_KEYS: DeploymentKey[] = ["PoseidonT3", "PoseidonT5", "Groth16Verifier"];

/** Builds creation calldata and a size-based gas budget for every contract `asset`'s pool needs, in deploy order. Pure: no network call. */
export function buildSteps(o: { contractsDir: string; deploymentsDir: string; network: QuaiNetwork; asset: string; gasPriceWei: bigint }): DeployStep[] {
  const token = defaultQuaiTokenRegistry.require(o.asset, o.network);
  const deployed = readDeployments(o.deploymentsDir, o.network.id, o.network.chainId);
  const artifacts: Record<string, ContractArtifact> = Object.fromEntries(
    [...SHARED_KEYS, "DarkCirclePool"].map((n) => [n, loadArtifact(o.contractsDir, n)])
  );

  const addressOf = (key: DeploymentKey): string => {
    const rec = deployed.records[key];
    if (!rec) throw new Error(`ERR_DEPENDENCY_NOT_DEPLOYED: ${key} must be deployed (and verified) before this step`);
    return rec.address;
  };

  const step = (key: DeploymentKey, contract: string, args: Array<{ name: string; value: string }>, encoded: string): DeployStep => {
    const artifact = artifacts[contract];
    const gasLimit = creationGasLimit(sizeOf(artifact));
    return {
      key,
      contract,
      data: encoded,
      gasLimit: "0x" + gasLimit.toString(16),
      expectedCostWei: (expectedCreationGasUsed(sizeOf(artifact)) * o.gasPriceWei).toString(),
      constructorArgs: args,
      alreadyDeployed: deployed.records[key] ?? null
    };
  };

  const encodeDeploy = (artifact: ContractArtifact, args: unknown[]): { data: string; labelled: Array<{ name: string; value: string }> } => {
    const iface = new Interface(artifact.abi as never);
    const data = artifact.bytecode + (args.length ? iface.encodeDeploy(args).slice(2) : "");
    const inputs = iface.deploy.inputs;
    const labelled = inputs.map((inp, i) => ({ name: inp.name || `arg${i}`, value: String(args[i]) }));
    return { data, labelled };
  };

  const steps: DeployStep[] = [];
  for (const key of SHARED_KEYS) {
    const { data, labelled } = encodeDeploy(artifacts[key], []);
    steps.push(step(key, key, labelled, data));
  }

  // The pool's constructor needs the OTHER shared contracts' real addresses. Once the shared ones above are
  // recorded (verified on chain), those addresses are known; otherwise this step cannot be built yet, which
  // is intentional — the UI only offers it once its dependencies show as deployed.
  try {
    const poolArgs = [toQuaiChecksum(token.address), toQuaiChecksum(addressOf("Groth16Verifier")), toQuaiChecksum(addressOf("PoseidonT3")), toQuaiChecksum(addressOf("PoseidonT5"))];
    const { data, labelled } = encodeDeploy(artifacts.DarkCirclePool, poolArgs);
    steps.push(step(poolKey(token.symbol), "DarkCirclePool", labelled, data));
  } catch {
    // dependencies not deployed yet: report a step with no calldata so the UI can show it as blocked, not silently omit it
    const artifact = artifacts.DarkCirclePool;
    const gasLimit = creationGasLimit(sizeOf(artifact));
    steps.push({
      key: poolKey(token.symbol),
      contract: "DarkCirclePool",
      data: "",
      gasLimit: "0x" + gasLimit.toString(16),
      expectedCostWei: (expectedCreationGasUsed(sizeOf(artifact)) * o.gasPriceWei).toString(),
      constructorArgs: [
        { name: "token", value: token.address },
        { name: "verifier", value: "(deploy Groth16Verifier first)" },
        { name: "hasher2", value: "(deploy PoseidonT3 first)" },
        { name: "hasher4", value: "(deploy PoseidonT5 first)" }
      ],
      alreadyDeployed: deployed.records[poolKey(token.symbol)] ?? null
    });
  }
  return steps;
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  network: { id: string; chainId: number; zone: string; zonePrefix: string };
  deployer: string | null;
  deployerBalanceWei: string | null;
  gasPriceWei: string | null;
  totalEstimatedCostWei: string | null;
  /** The most any single remaining transaction can be charged (its gas limit at this gas price). */
  maxSingleStepCostWei: string | null;
  steps: DeployStep[];
}

/** Everything the wallet needs to sign one step, simulated on the target zone moments before. */
export interface PreparedDeployment {
  key: DeploymentKey;
  contract: string;
  from: string;
  data: string;
  gasLimit: string;
  accessList: QuaiAccessListEntry[];
  estimateGas: string;
  gasPriceWei: string;
  expectedCostWei: string;
  maxCostWei: string;
  warnings: string[];
}

export class ChainDeployer {
  private readonly rpc: QuaiRpcClient;
  public readonly network: QuaiNetwork;
  private readonly contractsDir: string;
  private readonly deploymentsDir: string;

  constructor(rpc: QuaiRpcClient, contractsDir: string, deploymentsDir: string) {
    this.rpc = rpc;
    this.network = rpc.network;
    this.contractsDir = contractsDir;
    this.deploymentsDir = deploymentsDir;
  }

  public deployments(): DeploymentFile {
    return readDeployments(this.deploymentsDir, this.network.id, this.network.chainId);
  }

  private async gasPrice(): Promise<bigint> {
    return BigInt(await this.rpc.request<string>("quai_gasPrice"));
  }

  /**
   * The values a deployment's immutables must hold. Only the pool has any: its token (from the registry) and
   * the three dependencies actually recorded on this network. A pool can therefore only be recorded once
   * its dependencies are, and only if it is bound to exactly them.
   */
  private immutableValuesFor(key: DeploymentKey, deployed: DeploymentFile): Record<string, string> {
    if (contractForKey(key) !== "DarkCirclePool") return {};
    const asset = key.slice("DarkCirclePool:".length);
    const token = defaultQuaiTokenRegistry.require(asset, this.network);
    const need = (k: DeploymentKey) => {
      const rec = deployed.records[k];
      if (!rec) throw new Error(`ERR_DEPENDENCY_NOT_DEPLOYED: ${k} is not recorded on ${this.network.id}, so the pool's expected code (which embeds its address) cannot be known`);
      return rec.address;
    };
    return { token: token.address, verifier: need("Groth16Verifier"), hasher2: need("PoseidonT3"), hasher4: need("PoseidonT5") };
  }

  /** keccak256 of the exact runtime code a correct deployment of `key` has on this network. */
  public expectedRuntimeHashFor(key: DeploymentKey, artifact: ContractArtifact, deployed = this.deployments()): string {
    if (artifact.hashKind !== "runtime") {
      throw new Error(`ERR_ARTIFACT_OUTDATED: ${artifact.contractName} was built before runtime hashes were recorded; re-run the contracts.compile stage`);
    }
    const values = this.immutableValuesFor(key, deployed);
    if (Object.keys(values).length === 0 && Object.keys(artifact.immutables ?? {}).length === 0) return artifact.bytecodeHash.toLowerCase();
    return expectedRuntimeHash(artifact, values);
  }

  /** Everything checkable before the operator is asked to sign anything. */
  public async preflight(deployerAddress: string, asset: string): Promise<PreflightResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const netInfo = { id: this.network.id, chainId: this.network.chainId, zone: this.network.zone.name, zonePrefix: "0x" + this.network.zone.byte };
    let deployer: string | null = null;
    let balance: bigint | null = null;
    let gasPriceWei: bigint | null = null;
    let steps: DeployStep[] = [];

    try {
      await this.rpc.assertZone();
    } catch (err) {
      errors.push((err as Error).message);
    }

    try {
      deployer = assertQuaiPaymentAddress(deployerAddress, this.network);
    } catch (err) {
      errors.push((err as Error).message);
    }

    if (deployer && errors.length === 0) {
      try {
        const code = await this.rpc.getCode(deployer);
        if (code && code !== "0x") errors.push(`ERR_DEPLOYER_IS_CONTRACT: ${deployer} has code; a contract cannot originate a deployment transaction`);
      } catch (err) {
        warnings.push(`could not confirm the deployer is an externally owned account: ${(err as Error).message}`);
      }
      try {
        [balance, gasPriceWei] = await Promise.all([this.rpc.getBalance(deployer), this.gasPrice()]);
      } catch (err) {
        errors.push(`ERR_CHAIN_READ_FAILED: ${(err as Error).message}`);
      }
    }

    let totalCost: bigint | null = null;
    let maxSingle: bigint | null = null;
    if (gasPriceWei !== null) {
      try {
        steps = buildSteps({ contractsDir: this.contractsDir, deploymentsDir: this.deploymentsDir, network: this.network, asset, gasPriceWei });
        const remaining = steps.filter((s) => !s.alreadyDeployed);
        // Price every step that can already be built from a live simulation, as prepare() will, so the balance
        // asked for here is the one the deployment will actually need (a size-based figure understates the
        // hashers). A step that cannot be simulated yet (the pool, before its dependencies) stays size-based.
        let blockGasLimit: bigint | undefined;
        try {
          blockGasLimit = await this.rpc.blockGasLimit();
        } catch {
          /* planCreationGas falls back to its own cap */
        }
        for (const s of remaining) {
          if (!s.data || !deployer) continue;
          try {
            const sim = await this.rpc.simulateCreation({ from: deployer, data: s.data });
            const plan = planCreationGas({ runtimeBytes: sizeOf(loadArtifact(this.contractsDir, s.contract)), estimate: sim.estimate, blockGasLimit });
            if (plan.blocking) errors.push(`ERR_GAS_HEADROOM: ${s.contract}: ${plan.blocking}`);
            s.gasLimit = "0x" + plan.gasLimit.toString(16);
            s.expectedCostWei = (plan.expectedGasUsed * gasPriceWei).toString();
          } catch (err) {
            warnings.push(`${s.contract} could not be simulated yet (${(err as Error).message}); its cost here is size-based, and it is simulated again before signing`);
          }
        }
        totalCost = remaining.reduce((sum, s) => sum + BigInt(s.expectedCostWei), 0n);
        maxSingle = remaining.reduce((m, s) => max(m, BigInt(s.gasLimit) * gasPriceWei!), 0n);
        if (balance !== null && totalCost > balance) {
          errors.push(`ERR_INSUFFICIENT_BALANCE: the remaining deployment steps are expected to cost about ${totalCost} wei; the deployer holds ${balance}`);
        } else if (balance !== null && maxSingle > balance) {
          errors.push(`ERR_INSUFFICIENT_BALANCE: a node only accepts a transaction whose sender can cover its whole gas limit; the largest remaining step can be charged up to ${maxSingle} wei and the deployer holds ${balance}`);
        }
        if (remaining.some((s) => !s.data)) {
          warnings.push("the pool cannot be simulated until its dependencies are recorded, so its cost here is size-based; every step is simulated on the zone again right before your wallet is asked to sign, and its final gas limit and access list come from that simulation");
        }
      } catch (err) {
        errors.push((err as Error).message);
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      network: netInfo,
      deployer,
      deployerBalanceWei: balance === null ? null : balance.toString(),
      gasPriceWei: gasPriceWei === null ? null : gasPriceWei.toString(),
      totalEstimatedCostWei: totalCost === null ? null : totalCost.toString(),
      maxSingleStepCostWei: maxSingle === null ? null : maxSingle.toString(),
      steps
    };
  }

  /**
   * Rebuilds one step and simulates it on the zone, immediately before the wallet signs: the access list
   * the node computes (the pool's constructor calls its hasher, so without one the deployment would revert
   * and burn its whole gas limit), the live gas estimate, and a gas limit with the headroom Quai creation
   * needs. Throws instead of returning anything that would revert, run out of gas, or not be affordable.
   */
  public async prepare(o: { deployer: string; key: DeploymentKey; asset: string }): Promise<PreparedDeployment> {
    const warnings: string[] = [];
    const deployer = assertQuaiPaymentAddress(o.deployer, this.network);
    await this.rpc.assertZone();
    const code = await this.rpc.getCode(deployer);
    if (code && code !== "0x") throw new Error(`ERR_DEPLOYER_IS_CONTRACT: ${deployer} has code; a contract cannot originate a deployment transaction`);

    const [gasPriceWei, balance] = await Promise.all([this.gasPrice(), this.rpc.getBalance(deployer)]);
    const steps = buildSteps({ contractsDir: this.contractsDir, deploymentsDir: this.deploymentsDir, network: this.network, asset: o.asset, gasPriceWei });
    const step = steps.find((s) => s.key === o.key);
    if (!step) throw new Error(`ERR_UNKNOWN_STEP: ${o.key} is not a step of the ${o.asset} deployment`);
    if (step.alreadyDeployed) throw new Error(`ERR_ALREADY_DEPLOYED: ${o.key} is already recorded at ${step.alreadyDeployed.address}`);
    if (!step.data) throw new Error(`ERR_DEPENDENCY_NOT_DEPLOYED: deploy and record ${step.constructorArgs.filter((a) => a.value.startsWith("(")).map((a) => a.value.replace(/^\(deploy | first\)$/g, "")).join(", ")} first`);

    const sim = await this.rpc.simulateCreation({ from: deployer, data: step.data });
    let blockGasLimit: bigint | undefined;
    try {
      blockGasLimit = await this.rpc.blockGasLimit();
    } catch (err) {
      warnings.push(`could not read the block gas limit (${(err as Error).message}); using the ${MAX_CREATION_GAS} cap`);
    }
    const artifact = loadArtifact(this.contractsDir, step.contract);
    const gas = planCreationGas({ runtimeBytes: sizeOf(artifact), estimate: sim.estimate, blockGasLimit });
    warnings.push(...gas.warnings);
    if (gas.blocking) throw new Error(`ERR_GAS_HEADROOM: ${gas.blocking}`);
    const maxCost = gas.gasLimit * gasPriceWei;
    if (maxCost > balance) {
      throw new Error(`ERR_INSUFFICIENT_BALANCE: this step's gas limit (${gas.gasLimit}) at the current gas price can be charged up to ${maxCost} wei; the deployer holds ${balance}`);
    }
    return {
      key: step.key,
      contract: step.contract,
      from: deployer,
      data: step.data,
      gasLimit: "0x" + gas.gasLimit.toString(16),
      accessList: sim.accessList,
      estimateGas: sim.estimate.toString(),
      gasPriceWei: gasPriceWei.toString(),
      expectedCostWei: (gas.expectedGasUsed * gasPriceWei).toString(),
      maxCostWei: maxCost.toString(),
      warnings
    };
  }

  /** Polls quai_getTransactionReceipt. Returns null on timeout (the caller can call again later; nothing is lost). */
  public async waitForReceipt(txHash: string, timeoutMs = RECEIPT_TIMEOUT_MS): Promise<QuaiReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.rpc.getTransactionReceipt(txHash).catch(() => null);
      if (r && r.blockNumber) return r;
      await new Promise((res) => setTimeout(res, RECEIPT_POLL_MS));
    }
    return null;
  }

  /**
   * Confirms a deployment actually landed the intended contract and records it. Never trusts the receipt's
   * success status alone: checks it is a contract creation from the claimed deployer, re-derives the zone
   * from the address, re-reads the deployed code, and requires its hash to equal the exact code the build
   * predicts (for the pool: with its immutables filled in from the recorded dependencies).
   *
   * A still-pending transaction is NOT an error (blocks take minutes on Quai): it returns
   * `{ status: "pending" }` so the caller polls again, exactly like the pipeline's own job polling. Only a
   * genuine problem (reverted, wrong sender, wrong zone, no code, wrong bytecode) throws. `receiptTimeoutMs`
   * bounds how long THIS call waits before reporting pending; callers behind an HTTP request should keep it
   * short (a few seconds) and do their own outer retry, rather than holding one request open for minutes.
   */
  public async verifyAndRecord(
    o: { key: DeploymentKey; txHash: string; deployer: string; contract?: string },
    opts: { receiptTimeoutMs?: number } = {}
  ): Promise<{ status: "pending" } | { status: "verified"; record: DeploymentRecord; warnings: string[] }> {
    const contract = contractForKey(o.key);
    if (o.contract !== undefined && o.contract !== contract) {
      throw new Error(`ERR_KEY_CONTRACT_MISMATCH: the step ${o.key} deploys ${contract}, not ${o.contract}; nothing was recorded`);
    }
    const warnings: string[] = [];
    const receipt = await this.waitForReceipt(o.txHash, opts.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS);
    if (!receipt) return { status: "pending" };
    const status = receipt.status;
    if (!(status === "0x1" || status === 1 || status === "1")) throw new Error(`ERR_DEPLOY_REVERTED: ${o.txHash} was mined but reverted`);
    if (receipt.to !== undefined && receipt.to !== null && receipt.to !== "" && !/^0x0{40}$/i.test(receipt.to)) {
      throw new Error(`ERR_NOT_A_CREATION: ${o.txHash} was sent to ${receipt.to}; a deployment has no recipient`);
    }
    const claimedDeployer = toQuaiChecksum(o.deployer);
    if (receipt.from && toQuaiChecksum(receipt.from).toLowerCase() !== claimedDeployer.toLowerCase()) {
      throw new Error(`ERR_DEPLOYER_MISMATCH: ${o.txHash} was sent by ${toQuaiChecksum(receipt.from)}, not ${claimedDeployer}; it was NOT recorded`);
    }
    const address = receipt.contractAddress as string | undefined;
    if (!address || /^0x0{40}$/i.test(address)) throw new Error(`ERR_NO_CONTRACT_ADDRESS: receipt for ${o.txHash} carries no contract address`);

    const checksummed = toQuaiChecksum(address);
    if (!isAddressInZone(checksummed, this.network.zone)) {
      const actual = getAddressZone(checksummed);
      throw new Error(`ERR_WRONG_ZONE_DEPLOY: ${checksummed} landed in ${actual?.name ?? "an unknown zone"}, not ${this.network.zone.name}; the deployment is unusable from this network and was NOT recorded`);
    }

    const code = await this.rpc.getCode(checksummed);
    if (!code || code === "0x") throw new Error(`ERR_NO_CODE_AFTER_DEPLOY: no code at ${checksummed} after a successful-looking receipt`);
    const onChainRuntimeHash = keccak256(code);

    const artifact = loadArtifact(this.contractsDir, contract);
    const expected = this.expectedRuntimeHashFor(o.key, artifact);
    if (onChainRuntimeHash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `ERR_BYTECODE_MISMATCH: the code deployed at ${checksummed} hashes to ${onChainRuntimeHash}, not ${expected}, the code this build predicts${Object.keys(artifact.immutables ?? {}).length ? " with its immutables set to the recorded dependencies" : ""}. This is NOT the audited build (or not bound to the recorded contracts); it was NOT recorded. Do not use this address.`
      );
    }

    const record: DeploymentRecord = {
      contract,
      key: o.key,
      address: checksummed,
      txHash: o.txHash,
      blockNumber: Number(BigInt(receipt.blockNumber ?? "0x0")),
      deployer: claimedDeployer,
      deployedAt: new Date().toISOString(),
      expectedBytecodeHash: expected,
      expectedHashKind: "runtime",
      onChainRuntimeHash,
      gasUsed: receipt.gasUsed ?? "0x0"
    };
    recordDeployment(this.deploymentsDir, this.network.id, this.network.chainId, record);
    return { status: "verified", record, warnings };
  }

  /**
   * After a pool and its three dependencies are all recorded, reads the pool's own constructor-bound
   * addresses back and confirms each equals what was actually deployed (not what the plan intended), and
   * that its empty-tree root equals the simulation's — the same invariant the local EVM stage checks,
   * now against the real chain.
   */
  public async verifyPoolBindings(asset: string): Promise<{ ok: boolean; checks: Array<{ id: string; ok: boolean; detail: string }> }> {
    const deployed = this.deployments();
    const token = defaultQuaiTokenRegistry.require(asset, this.network);
    const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
    const pool = deployed.records[poolKey(token.symbol)];
    if (!pool) return { ok: false, checks: [{ id: "P-00", ok: false, detail: "the pool is not recorded as deployed yet" }] };

    const iface = new Interface(["function token() view returns (address)", "function verifier() view returns (address)", "function hasher2() view returns (address)", "function hasher4() view returns (address)", "function currentRoot() view returns (uint256)"]);
    const read = async (fn: string) => {
      const raw = await this.rpc.call({ to: pool.address, data: iface.encodeFunctionData(fn) });
      return iface.decodeFunctionResult(fn, raw)[0];
    };
    const expect = async (fn: string, id: string, label: string, expected: string) => {
      try {
        const got = toQuaiChecksum(String(await read(fn)));
        const ok = got.toLowerCase() === expected.toLowerCase();
        checks.push({ id, ok, detail: ok ? `${label} = ${got}` : `${label} on chain is ${got}, expected ${expected}` });
      } catch (err) {
        checks.push({ id, ok: false, detail: `could not read ${fn}(): ${(err as Error).message}` });
      }
    };

    await expect("token", "P-01", "token()", token.address);
    const verifier = deployed.records.Groth16Verifier;
    if (verifier) await expect("verifier", "P-02", "verifier()", verifier.address);
    const t3 = deployed.records.PoseidonT3;
    if (t3) await expect("hasher2", "P-03", "hasher2()", t3.address);
    const t5 = deployed.records.PoseidonT5;
    if (t5) await expect("hasher4", "P-04", "hasher4()", t5.address);

    try {
      const root = BigInt(await read("currentRoot"));
      const { IncrementalMerkleTree } = await import("../../crypto/merkleTree.ts");
      const empty = new IncrementalMerkleTree(16, 64).root;
      const ok = root === empty;
      checks.push({ id: "P-05", ok, detail: ok ? "empty-tree root matches the simulation's" : `on-chain root ${root} does not match the simulation's empty-tree root ${empty}` });
    } catch (err) {
      checks.push({ id: "P-05", ok: false, detail: `could not read currentRoot(): ${(err as Error).message}` });
    }

    return { ok: checks.every((c) => c.ok), checks };
  }
}
