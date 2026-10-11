/**
 * DarkCircle admin console: wallet-signed on-chain deployment
 * File: test/admin/chain.test.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (this whole directory is removed by scripts/redact-admin.ts).
 *
 * This is the code that decides how much gas the operator's wallet is asked to spend and whether a
 * deployment gets recorded as real. Every adversarial case here is a way a bug could either strand a
 * deployment (under-budgeted gas burns the whole limit on Quai) or record something as verified when it
 * is not (wrong zone, wrong bytecode, a revert). No network call is ever made: QuaiRpcClient's injected
 * transport stands in for the chain, exactly as test/unit/quai.test.ts already does for the client itself.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256, Interface, getAddress, AbiCoder } from "ethers";
import { QuaiRpcClient, type JsonRpcTransport } from "../../src/quai/rpc.ts";
import { QUAI_CYPRUS1, QUAI_ORCHARD_CYPRUS1 } from "../../src/quai/networks.ts";
import {
  ChainDeployer,
  buildSteps,
  contractForKey,
  creationGasLimit,
  expectedCreationGasUsed,
  loadArtifact,
  planCreationGas,
  CREATION_GAS_PER_RUNTIME_BYTE,
  MIN_CREATION_GAS,
  MAX_CREATION_GAS
} from "../../src/admin/deploy/chain.ts";
import { expectedRuntimeCode, immutableWord, type ImmutableRef } from "../../src/admin/deploy/bytecode.ts";
import { readDeployments, recordDeployment, poolKey, type DeploymentKey } from "../../src/admin/deploy/deployments.ts";
import { defaultQuaiTokenRegistry } from "../../src/quai/tokens.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-chain-"));
  dirs.push(d);
  return d;
};
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const DEPLOYER = "0x004e3d0Ea0B77B9E5E8fAA72D0FC8a4a2e1D4A31";
const WRONG_ZONE = "0x1054328ef0070fceeea0a22bb01fa5f6614098ef"; // paxos1, not cyprus1

function transport(handlers: Record<string, (params: unknown[]) => unknown>, calls: Array<{ method: string; params: unknown[] }> = []): JsonRpcTransport {
  return async (method, params) => {
    calls.push({ method, params });
    const h = handlers[method];
    if (!h) throw new Error(`ERR_QUAI_RPC: ${method}: unhandled in test fake`);
    return h(params);
  };
}
const zoneOk = { quai_chainId: () => "0x9", quai_nodeLocation: () => ["0x0", "0x0"] };

/** A minimal but real ABI/bytecode pair whose deployed code equals its own declared bytecode (for the hash to check against itself deterministically), simulating a trivial contract with no constructor args unless given some. */
function writeArtifact(dir: string, name: string, opts: { abi?: unknown[]; runtimeHex?: string; ctorInputs?: Array<{ name: string; type: string }>; hashKind?: "runtime" | "creation"; immutables?: Record<string, ImmutableRef[]> } = {}) {
  const runtime = opts.runtimeHex ?? "0x600160005260206000f3"; // arbitrary valid-looking bytes; only ever hashed, never executed
  const abi = opts.abi ?? [{ type: "constructor", inputs: opts.ctorInputs ?? [], stateMutability: "nonpayable" }];
  const bytecodeHash = keccak256(runtime);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ contractName: name, abi, bytecode: "0x6080604052" /* creation prefix stand-in */, deployedBytecode: runtime, bytecodeHash, hashKind: opts.hashKind ?? "runtime", immutables: opts.immutables ?? {} })
  );
  return { runtime, bytecodeHash };
}

/**
 * Shaped like solc's real output for DarkCirclePool: the runtime code holds zero placeholders (PUSH32 0x00..00)
 * where the constructor writes its four immutables, and `immutables` says where. The token is referenced
 * twice, as a real contract that reads it in two functions would be.
 */
const ZERO_WORD = "0".repeat(64);
const POOL_RUNTIME = "0x60016001600155" + ["7f" + ZERO_WORD, "7f" + ZERO_WORD, "7f" + ZERO_WORD, "7f" + ZERO_WORD, "7f" + ZERO_WORD].join("") + "00";
const POOL_IMMUTABLES: Record<string, ImmutableRef[]> = {
  token: [{ start: 8, length: 32 }, { start: 140, length: 32 }],
  verifier: [{ start: 41, length: 32 }],
  hasher2: [{ start: 74, length: 32 }],
  hasher4: [{ start: 107, length: 32 }]
};
function poolArtifact(dir: string) {
  return writeArtifact(dir, "DarkCirclePool", {
    ctorInputs: [
      { name: "token_", type: "address" },
      { name: "verifier_", type: "address" },
      { name: "hasher2_", type: "address" },
      { name: "hasher4_", type: "address" }
    ],
    runtimeHex: POOL_RUNTIME,
    immutables: POOL_IMMUTABLES
  });
}

describe("gas budgeting", () => {
  it("sizes the limit generously above what Quai has actually charged, and clamps at both ends", () => {
    assert.equal(creationGasLimit(16_903), 16_903n * CREATION_GAS_PER_RUNTIME_BYTE);
    assert.ok(creationGasLimit(16_903) > 16_025_454n, "must exceed the real observed charge for a same-sized deploy (16,025,454 gas)");
    assert.equal(creationGasLimit(1), MIN_CREATION_GAS, "a tiny contract still gets a sane floor");
    assert.equal(creationGasLimit(1_000_000), MAX_CREATION_GAS, "an implausibly large contract is capped, not sent unbounded");
    assert.ok(expectedCreationGasUsed(16_903) < creationGasLimit(16_903), "the cost ESTIMATE must sit below the LIMIT, or a normal deploy would look under-budgeted");
  });
});

describe("loadArtifact", () => {
  it("reads what contracts.compile wrote, and fails clearly when a stage has not run yet", () => {
    const dir = tmp();
    writeArtifact(dir, "PoseidonT3");
    const a = loadArtifact(dir, "PoseidonT3");
    assert.equal(a.contractName, "PoseidonT3");
    assert.throws(() => loadArtifact(dir, "DarkCirclePool"), /ERR_ARTIFACT_MISSING.*contracts\.compile/);
  });
});

describe("buildSteps (calldata + dependency ordering, no network)", () => {
  function setup() {
    const contractsDir = tmp();
    const deploymentsDir = tmp();
    writeArtifact(contractsDir, "PoseidonT3");
    writeArtifact(contractsDir, "PoseidonT5");
    writeArtifact(contractsDir, "Groth16Verifier");
    poolArtifact(contractsDir);
    return { contractsDir, deploymentsDir };
  }

  it("orders the three shared contracts before the pool, and the pool step is unbuildable until they are recorded", () => {
    const { contractsDir, deploymentsDir } = setup();
    const steps = buildSteps({ contractsDir, deploymentsDir, network: QUAI_CYPRUS1, asset: "WQUAI", gasPriceWei: 1_000_000_000n });
    assert.deepEqual(steps.map((s) => s.contract), ["PoseidonT3", "PoseidonT5", "Groth16Verifier", "DarkCirclePool"]);
    const pool = steps[3];
    assert.equal(pool.data, "", "no calldata can be built yet: the pool's constructor needs addresses that do not exist yet");
    assert.equal(pool.alreadyDeployed, null);
    assert.ok(pool.constructorArgs.some((a) => /deploy .* first/i.test(a.value)));
  });

  it("once the shared contracts are recorded, builds real, checksummed, correctly-ordered constructor calldata for the pool", () => {
    const { contractsDir, deploymentsDir } = setup();
    const rec = (key: "PoseidonT3" | "PoseidonT5" | "Groth16Verifier", address: string) =>
      recordDeployment(deploymentsDir, QUAI_CYPRUS1.id, QUAI_CYPRUS1.chainId, {
        contract: key, key, address, txHash: "0x" + "1".repeat(64), blockNumber: 100, deployer: DEPLOYER, deployedAt: new Date().toISOString(),
        expectedBytecodeHash: "0x" + "0".repeat(64), expectedHashKind: "runtime", onChainRuntimeHash: "0x" + "0".repeat(64), gasUsed: "0x1"
      });
    rec("PoseidonT3", "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    rec("PoseidonT5", "0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    rec("Groth16Verifier", "0x00cccccccccccccccccccccccccccccccccccccc".slice(0, 42));

    const steps = buildSteps({ contractsDir, deploymentsDir, network: QUAI_CYPRUS1, asset: "WQUAI", gasPriceWei: 1_000_000_000n });
    const pool = steps.find((s) => s.contract === "DarkCirclePool")!;
    assert.ok(pool.data.length > 10);
    const token = defaultQuaiTokenRegistry.require("WQUAI", QUAI_CYPRUS1);
    assert.deepEqual(pool.constructorArgs.map((a) => a.value), [getAddress(token.address), getAddress("0x00cccccccccccccccccccccccccccccccccccccc".slice(0, 42)), getAddress("0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), getAddress("0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]);
    // the ABI-decoded tail of the calldata must round-trip to exactly those addresses, in that order
    const artifact = JSON.parse(fs.readFileSync(path.join(contractsDir, "DarkCirclePool.json"), "utf8"));
    const iface = new Interface(artifact.abi);
    assert.ok(pool.data.startsWith(artifact.bytecode), "calldata must be the exact compiled bytecode with the constructor args appended, not rebuilt from scratch");
    const argsHex = "0x" + pool.data.slice(artifact.bytecode.length);
    const decoded = AbiCoder.defaultAbiCoder().decode(iface.deploy.inputs, argsHex);
    assert.deepEqual([...decoded].map((x: string) => x.toLowerCase()), pool.constructorArgs.map((a) => a.value.toLowerCase()));
  });

  it("each asset gets its own pool key, and WQUAI/WQI never collide", () => {
    assert.notEqual(poolKey("WQUAI"), poolKey("WQI"));
    assert.equal(poolKey("wqi"), poolKey("WQI"), "asset keys are case-insensitive");
  });
});

describe("deployment record store", () => {
  it("round-trips and refuses to silently overwrite a different recorded address", () => {
    const dir = tmp();
    const rec = (address: string) => ({
      contract: "PoseidonT3" as const, key: "PoseidonT3" as const, address, txHash: "0x" + "2".repeat(64), blockNumber: 5,
      deployer: DEPLOYER, deployedAt: new Date().toISOString(), expectedBytecodeHash: "0x" + "3".repeat(64), expectedHashKind: "runtime" as const,
      onChainRuntimeHash: "0x" + "3".repeat(64), gasUsed: "0x100"
    });
    assert.deepEqual(readDeployments(dir, "quai-cyprus1", 9).records, {});
    recordDeployment(dir, "quai-cyprus1", 9, rec("0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    const read = readDeployments(dir, "quai-cyprus1", 9);
    assert.equal(read.records.PoseidonT3!.address, "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.throws(() => recordDeployment(dir, "quai-cyprus1", 9, rec("0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")), /ERR_DEPLOYMENT_ALREADY_RECORDED/);
    assert.equal(readDeployments(dir, "quai-cyprus1", 9).records.PoseidonT3!.address, "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "the refused write changed nothing");
    // explicit replace is allowed (used only for a deliberate redeploy, never automatically)
    recordDeployment(dir, "quai-cyprus1", 9, rec("0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), { allowReplace: true });
    assert.equal(readDeployments(dir, "quai-cyprus1", 9).records.PoseidonT3!.address, "0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("ignores a corrupt or foreign deployments file instead of crashing", () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "quai-cyprus1.json"), "{ not json");
    assert.deepEqual(readDeployments(dir, "quai-cyprus1", 9).records, {});
  });
});

describe("ChainDeployer.preflight", () => {
  function deployer(handlers: Record<string, (params: unknown[]) => unknown>, network = QUAI_CYPRUS1) {
    const contractsDir = tmp();
    writeArtifact(contractsDir, "PoseidonT3");
    writeArtifact(contractsDir, "PoseidonT5");
    writeArtifact(contractsDir, "Groth16Verifier");
    poolArtifact(contractsDir);
    const deploymentsDir = tmp();
    const rpc = new QuaiRpcClient({ network, transport: transport(handlers) });
    return new ChainDeployer(rpc, contractsDir, deploymentsDir);
  }

  it("passes for a funded, in-zone EOA and prices only the steps not yet deployed", async () => {
    const cd = deployer({ ...zoneOk, quai_getCode: () => "0x", quai_getBalance: () => "0x" + (10n ** 21n).toString(16), quai_gasPrice: () => "0x3b9aca00" });
    const r = await cd.preflight(DEPLOYER, "WQUAI");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.deployer, getAddress(DEPLOYER));
    assert.equal(r.steps.length, 4);
    assert.ok(BigInt(r.totalEstimatedCostWei!) > 0n);
  });

  it("prices every buildable step from a live simulation, so the balance it asks for is the one the deployment needs", async () => {
    const estimate = 9_095_088n; // PoseidonT5's real Cyprus-1 estimate
    const cd = deployer({
      ...zoneOk,
      quai_getCode: () => "0x",
      quai_getBalance: () => "0x" + (10n ** 24n).toString(16),
      quai_gasPrice: () => "0x3b9aca00",
      quai_createAccessList: () => ({ accessList: [] }),
      quai_estimateGas: () => "0x" + estimate.toString(16),
      quai_getBlockByNumber: () => ({ header: { gasLimit: "0x2faf080" } })
    });
    const r = await cd.preflight(DEPLOYER, "WQUAI");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    for (const s of r.steps.filter((x) => x.data)) {
      assert.equal(BigInt(s.gasLimit), estimate * 3n, `${s.contract}: 3x the live estimate, not the size budget`);
      assert.equal(BigInt(s.expectedCostWei), ((estimate * 25n) / 10n) * 1_000_000_000n);
    }
    assert.ok(r.warnings.some((w) => /pool cannot be simulated until its dependencies/.test(w)), "the pool (no calldata yet) stays size-based and says so");
    // and the balance check uses those figures: enough for the size-based total is no longer enough
    const sizeBasedTotal = r.steps.filter((x) => x.data).length * Number(expectedCreationGasUsed(10)) * 1e9;
    assert.ok(Number(r.totalEstimatedCostWei) > sizeBasedTotal);
  });

  it("refuses a wrong-zone deployer, a Qi-ledger deployer, and a contract address, each with a distinct reason", async () => {
    const cd = deployer({ ...zoneOk, quai_getCode: () => "0x", quai_getBalance: () => "0x0", quai_gasPrice: () => "0x1" });
    const wrongZone = await cd.preflight(WRONG_ZONE, "WQUAI");
    assert.equal(wrongZone.ok, false);
    assert.ok(wrongZone.errors.some((e) => /ERR_QUAI_ADDRESS_WRONG_ZONE/.test(e)));

    const qiAddr = "0x0084328ef0070fceeea0a22bb01fa5f6614098ef"; // top bit of byte 1 set -> Qi ledger
    const qi = await cd.preflight(qiAddr, "WQUAI");
    assert.equal(qi.ok, false);
    assert.ok(qi.errors.some((e) => /ERR_QUAI_ADDRESS_QI_LEDGER/.test(e)));

    const contractDeployer = deployer({ ...zoneOk, quai_getCode: () => "0x6080604052", quai_getBalance: () => "0x0", quai_gasPrice: () => "0x1" });
    const asContract = await contractDeployer.preflight(DEPLOYER, "WQUAI");
    assert.equal(asContract.ok, false);
    assert.ok(asContract.errors.some((e) => /ERR_DEPLOYER_IS_CONTRACT/.test(e)));
  });

  it("refuses an insufficient balance, quoting the shortfall rather than letting the wallet fail opaquely", async () => {
    const cd = deployer({ ...zoneOk, quai_getCode: () => "0x", quai_getBalance: () => "0x1", quai_gasPrice: () => "0x3b9aca00" });
    const r = await cd.preflight(DEPLOYER, "WQUAI");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /ERR_INSUFFICIENT_BALANCE/.test(e)));
  });

  it("refuses the wrong chain id or shard before anything else is checked", async () => {
    const cd = deployer({ quai_chainId: () => "0x3a98", quai_nodeLocation: () => ["0x0", "0x0"] });
    const r = await cd.preflight(DEPLOYER, "WQUAI");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /ERR_QUAI_CHAIN_ID_MISMATCH/.test(e)));
  });

  it("resolves Orchard as its own network (chain id 15000, independent zone check), not a copy of mainnet's answer", async () => {
    const cd = deployer({ quai_chainId: () => "0x3a98", quai_nodeLocation: () => ["0x0", "0x0"], quai_getCode: () => "0x", quai_getBalance: () => "0x" + (10n ** 21n).toString(16), quai_gasPrice: () => "0x1" }, QUAI_ORCHARD_CYPRUS1);
    const r = await cd.preflight(DEPLOYER, "WQUAI");
    assert.equal(r.network.chainId, 15000);
    assert.equal(r.network.id, "quai-orchard-cyprus1");
    // Orchard has no registered WQUAI/WQI deployment in this build (see README's Known limits); preflight
    // must say so plainly rather than silently falling back to mainnet's token address or crashing.
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /ERR_QUAI_TOKEN_UNKNOWN.*quai-orchard-cyprus1/.test(e)), JSON.stringify(r.errors));
  });
});

describe("ChainDeployer.waitForReceipt", () => {
  it("returns the receipt once it has a block number, and null on timeout without throwing", async () => {
    const contractsDir = tmp();
    writeArtifact(contractsDir, "PoseidonT3");
    let calls = 0;
    const pending = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk, quai_getTransactionReceipt: () => { calls++; return calls < 2 ? null : { status: "0x1", blockNumber: "0x64", contractAddress: "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }; } }) });
    const cdPending = new ChainDeployer(pending, contractsDir, tmp());
    const r = await cdPending.waitForReceipt("0x" + "4".repeat(64), 20_000);
    assert.ok(r);
    assert.equal(r!.blockNumber, "0x64");

    const never = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk, quai_getTransactionReceipt: () => null }) });
    const cdNever = new ChainDeployer(never, contractsDir, tmp());
    const start = Date.now();
    const none = await cdNever.waitForReceipt("0x" + "5".repeat(64), 4_000);
    assert.equal(none, null);
    assert.ok(Date.now() - start >= 3_500, "must actually wait out the timeout, not return instantly");
  });
});

describe("ChainDeployer.verifyAndRecord", () => {
  function setup(receiptHandlers: Record<string, (params: unknown[]) => unknown>, contractName = "PoseidonT3") {
    const contractsDir = tmp();
    const { bytecodeHash, runtime } = writeArtifact(contractsDir, contractName);
    const deploymentsDir = tmp();
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk, ...receiptHandlers }) });
    return { cd: new ChainDeployer(rpc, contractsDir, deploymentsDir), deploymentsDir, bytecodeHash, runtime };
  }
  const GOOD_ADDR = "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("records a deployment whose on-chain bytecode hash matches the compiled build", async () => {
    const { cd, deploymentsDir, runtime } = setup({
      quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: GOOD_ADDR, gasUsed: "0xabc" }),
      quai_getCode: () => runtime
    });
    const result = await cd.verifyAndRecord({ key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "6".repeat(64), deployer: DEPLOYER });
    assert.equal(result.status, "verified");
    assert.ok(result.status === "verified");
    const { record, warnings } = result;
    assert.equal(record.address, getAddress(GOOD_ADDR));
    assert.equal(record.blockNumber, 100);
    assert.deepEqual(warnings, []);
    assert.equal(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records.PoseidonT3!.address, getAddress(GOOD_ADDR));
  });

  it("refuses and does NOT record a reverted transaction", async () => {
    const { cd, deploymentsDir } = setup({ quai_getTransactionReceipt: () => ({ status: "0x0", blockNumber: "0x64" }) });
    await assert.rejects(cd.verifyAndRecord({ key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "7".repeat(64), deployer: DEPLOYER }), /ERR_DEPLOY_REVERTED/);
    assert.deepEqual(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records, {});
  });

  it("refuses and does NOT record a receipt with no contract address", async () => {
    const { cd, deploymentsDir } = setup({ quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64" }) });
    await assert.rejects(cd.verifyAndRecord({ key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "8".repeat(64), deployer: DEPLOYER }), /ERR_NO_CONTRACT_ADDRESS/);
    assert.deepEqual(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records, {});
  });

  it("refuses and does NOT record a deployment that landed outside Cyprus-1 (Quai grinds zones; a wrong-zone address is unusable)", async () => {
    const { cd, deploymentsDir } = setup({ quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: WRONG_ZONE }) });
    await assert.rejects(cd.verifyAndRecord({ key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "9".repeat(64), deployer: DEPLOYER }), /ERR_WRONG_ZONE_DEPLOY/);
    assert.deepEqual(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records, {});
  });

  it("refuses and does NOT record when nothing is at the address after a successful-looking receipt", async () => {
    const { cd, deploymentsDir } = setup({ quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: GOOD_ADDR }), quai_getCode: () => "0x" });
    await assert.rejects(cd.verifyAndRecord({ key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "a".repeat(64), deployer: DEPLOYER }), /ERR_NO_CODE_AFTER_DEPLOY/);
    assert.deepEqual(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records, {});
  });

  it("a still-pending transaction is reported as pending, not thrown as an error, and nothing is recorded", async () => {
    const { cd, deploymentsDir } = setup({ quai_getTransactionReceipt: () => null });
    const result = await cd.verifyAndRecord({ key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "d".repeat(64), deployer: DEPLOYER }, { receiptTimeoutMs: 3_500 });
    assert.deepEqual(result, { status: "pending" });
    assert.deepEqual(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records, {});
  });

  it("THE CRITICAL CASE: refuses and does NOT record when the deployed code's hash differs from the compiled build, even though the receipt says success", async () => {
    const { cd, deploymentsDir } = setup({
      quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: GOOD_ADDR }),
      quai_getCode: () => "0xdeadbeef" // some other bytecode entirely — not what was compiled
    });
    await assert.rejects(cd.verifyAndRecord({ key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "b".repeat(64), deployer: DEPLOYER }), /ERR_BYTECODE_MISMATCH/);
    assert.deepEqual(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records, {}, "a bytecode mismatch must never be recorded as a verified deployment");
  });

  it("DEP-04: an artifact that only knows its CREATION hash (an old build of the hashers) is refused, not recorded unverified", async () => {
    const contractsDir = tmp();
    writeArtifact(contractsDir, "PoseidonT3", { hashKind: "creation" });
    const deploymentsDir = tmp();
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk, quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: GOOD_ADDR }), quai_getCode: () => "0x600160005260206000f3aabbcc" }) });
    const cd = new ChainDeployer(rpc, contractsDir, deploymentsDir);
    await assert.rejects(cd.verifyAndRecord({ key: "PoseidonT3", txHash: "0x" + "c".repeat(64), deployer: DEPLOYER }), /ERR_ARTIFACT_OUTDATED.*contracts\.compile/);
    assert.deepEqual(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records, {}, "any code at all would have been accepted under the old warning-only path");
  });

  it("DEP-05: the key decides which contract is checked; a client-supplied contract that disagrees is refused before anything is read", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const contractsDir = tmp();
    writeArtifact(contractsDir, "PoseidonT3");
    writeArtifact(contractsDir, "DevToken");
    const deploymentsDir = tmp();
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk }, calls) });
    const cd = new ChainDeployer(rpc, contractsDir, deploymentsDir);
    await assert.rejects(cd.verifyAndRecord({ key: "Groth16Verifier", contract: "DevToken", txHash: "0x" + "c".repeat(64), deployer: DEPLOYER }), /ERR_KEY_CONTRACT_MISMATCH/);
    await assert.rejects(cd.verifyAndRecord({ key: "PoseidonT3", contract: "../../package", txHash: "0x" + "c".repeat(64), deployer: DEPLOYER }), /ERR_KEY_CONTRACT_MISMATCH/);
    assert.equal(calls.length, 0, "refused before any chain read");
    assert.equal(contractForKey("DarkCirclePool:WQI"), "DarkCirclePool");
    assert.equal(contractForKey("PoseidonT5"), "PoseidonT5");
    assert.throws(() => loadArtifact(contractsDir, "../PoseidonT3"), /ERR_ARTIFACT_NAME/);
  });

  it("DEP-07: refuses a receipt sent by someone other than the claimed deployer, and one that is not a contract creation", async () => {
    const other = "0x0012345678901234567890123456789012345678";
    const byOther = setup({ quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: GOOD_ADDR, from: other }), quai_getCode: () => "0x600160005260206000f3" });
    await assert.rejects(byOther.cd.verifyAndRecord({ key: "PoseidonT3", txHash: "0x" + "e".repeat(64), deployer: DEPLOYER }), /ERR_DEPLOYER_MISMATCH/);
    assert.deepEqual(readDeployments(byOther.deploymentsDir, QUAI_CYPRUS1.id, 9).records, {});

    const call = setup({ quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: GOOD_ADDR, from: DEPLOYER, to: other }), quai_getCode: () => "0x600160005260206000f3" });
    await assert.rejects(call.cd.verifyAndRecord({ key: "PoseidonT3", txHash: "0x" + "e".repeat(64), deployer: DEPLOYER }), /ERR_NOT_A_CREATION/);

    const mine = setup({ quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: GOOD_ADDR, from: DEPLOYER.toLowerCase(), to: null }), quai_getCode: () => "0x600160005260206000f3" });
    const ok = await mine.cd.verifyAndRecord({ key: "PoseidonT3", txHash: "0x" + "e".repeat(64), deployer: DEPLOYER });
    assert.equal(ok.status, "verified", "the deployer's own creation (any address casing, to = null) is accepted");
  });
});

describe("DEP-01: the pool's immutables", () => {
  const addrs = {
    verifier: "0x00cccccccccccccccccccccccccccccccccccccc".slice(0, 42),
    hasher2: "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    hasher4: "0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  };
  const POOL_ADDR = "0x00dddddddddddddddddddddddddddddddddddddd".slice(0, 42);
  const token = defaultQuaiTokenRegistry.require("WQUAI", QUAI_CYPRUS1);

  function setup(onChainCode: () => string, record = true) {
    const contractsDir = tmp();
    poolArtifact(contractsDir);
    const deploymentsDir = tmp();
    const rec = (key: DeploymentKey, address: string) =>
      recordDeployment(deploymentsDir, QUAI_CYPRUS1.id, 9, { contract: key, key, address, txHash: "0x" + "1".repeat(64), blockNumber: 1, deployer: DEPLOYER, deployedAt: new Date().toISOString(), expectedBytecodeHash: "0x0", expectedHashKind: "runtime", onChainRuntimeHash: "0x0", gasUsed: "0x1" });
    if (record) {
      rec("Groth16Verifier", addrs.verifier);
      rec("PoseidonT3", addrs.hasher2);
      rec("PoseidonT5", addrs.hasher4);
    }
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk, quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x70", contractAddress: POOL_ADDR, from: DEPLOYER }), quai_getCode: () => onChainCode() }) });
    return { cd: new ChainDeployer(rpc, contractsDir, deploymentsDir), deploymentsDir };
  }
  const realPoolCode = (over: Partial<Record<"token" | "verifier" | "hasher2" | "hasher4", string>> = {}) =>
    expectedRuntimeCode({ deployedBytecode: POOL_RUNTIME, immutables: POOL_IMMUTABLES }, { token: token.address, verifier: addrs.verifier, hasher2: addrs.hasher2, hasher4: addrs.hasher4, ...over });

  it("rebuilds the exact deployed code: every reference of every immutable is filled, nothing else changes", () => {
    const code = realPoolCode();
    assert.equal(code.length, POOL_RUNTIME.length);
    const word = (i: number) => code.slice(2 + i * 2, 2 + i * 2 + 64);
    assert.equal(word(8), immutableWord(token.address));
    assert.equal(word(140), immutableWord(token.address), "the second reference to token is filled too");
    assert.equal(word(41), immutableWord(addrs.verifier));
    assert.equal(code.slice(0, 16), POOL_RUNTIME.slice(0, 16), "the code around the immutables is untouched");
    assert.throws(() => expectedRuntimeCode({ deployedBytecode: POOL_RUNTIME, immutables: POOL_IMMUTABLES }, { token: token.address }), /ERR_IMMUTABLES_MISMATCH.*missing verifier/);
    assert.throws(() => expectedRuntimeCode({ deployedBytecode: POOL_RUNTIME, immutables: {} }, { token: token.address }), /ERR_IMMUTABLES_MISMATCH.*not immutables: token/);
  });

  it("THE BUG: a real pool (immutables filled in by its constructor) is recorded; the old check compared it with the zero-placeholder code and could never match", async () => {
    const { cd, deploymentsDir } = setup(() => realPoolCode());
    assert.notEqual(keccak256(realPoolCode()), keccak256(POOL_RUNTIME), "what the old check compared against");
    const r = await cd.verifyAndRecord({ key: poolKey("WQUAI"), txHash: "0x" + "f".repeat(64), deployer: DEPLOYER });
    assert.equal(r.status, "verified");
    assert.ok(r.status === "verified");
    assert.equal(r.record.expectedBytecodeHash, keccak256(realPoolCode()));
    assert.equal(r.record.contract, "DarkCirclePool");
    assert.equal(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records[poolKey("WQUAI")]!.address, getAddress(POOL_ADDR));
  });

  it("refuses a pool bound to a different verifier, even though its code is otherwise identical (a masked comparison would accept it)", async () => {
    const { cd, deploymentsDir } = setup(() => realPoolCode({ verifier: "0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".slice(0, 42) }));
    await assert.rejects(cd.verifyAndRecord({ key: poolKey("WQUAI"), txHash: "0x" + "f".repeat(64), deployer: DEPLOYER }), /ERR_BYTECODE_MISMATCH.*immutables/);
    assert.equal(readDeployments(deploymentsDir, QUAI_CYPRUS1.id, 9).records[poolKey("WQUAI")], undefined);
  });

  it("refuses the zero-placeholder code itself (what a pool with no constructor run would look like)", async () => {
    const { cd } = setup(() => POOL_RUNTIME);
    await assert.rejects(cd.verifyAndRecord({ key: poolKey("WQUAI"), txHash: "0x" + "f".repeat(64), deployer: DEPLOYER }), /ERR_BYTECODE_MISMATCH/);
  });

  it("cannot record a pool before its dependencies are recorded: its expected code embeds their addresses", async () => {
    const { cd } = setup(() => realPoolCode(), false);
    await assert.rejects(cd.verifyAndRecord({ key: poolKey("WQUAI"), txHash: "0x" + "f".repeat(64), deployer: DEPLOYER }), /ERR_DEPENDENCY_NOT_DEPLOYED/);
  });
});

describe("DEP-03: gas planning from the live estimate", () => {
  it("PoseidonT5's real numbers: the size budget alone (2.2x the estimate) is raised to 3x the estimate", () => {
    // 16,288 bytes; Cyprus-1 estimated 9,095,088 gas for its creation on 2026-09-23 (read-only probe)
    const bySize = creationGasLimit(16_288);
    assert.ok(bySize < (9_095_088n * 25n) / 10n, "the old budget sat below the ~2.5x Quai has actually charged");
    const plan = planCreationGas({ runtimeBytes: 16_288, estimate: 9_095_088n, blockGasLimit: 50_000_000n });
    assert.equal(plan.gasLimit, 9_095_088n * 3n);
    assert.equal(plan.blocking, null);
    assert.ok(plan.expectedGasUsed >= (9_095_088n * 25n) / 10n);
  });

  it("keeps the size budget when it is larger, and the floor for tiny contracts", () => {
    assert.equal(planCreationGas({ runtimeBytes: 9_755, estimate: 3_859_854n }).gasLimit, 9_755n * CREATION_GAS_PER_RUNTIME_BYTE);
    assert.equal(planCreationGas({ runtimeBytes: 10, estimate: 50_000n }).gasLimit, MIN_CREATION_GAS);
  });

  it("caps below the block gas limit, and refuses when the cap leaves less than 2.5x the estimate", () => {
    const capped = planCreationGas({ runtimeBytes: 16_288, estimate: 9_095_088n, blockGasLimit: 26_000_000n });
    assert.equal(capped.gasLimit, (26_000_000n * 95n) / 100n);
    assert.ok(capped.warnings.some((w) => /capped/.test(w)));
    assert.equal(capped.blocking, null, "24.7M still covers 2.5x of 9.1M");
    const tooSmall = planCreationGas({ runtimeBytes: 16_288, estimate: 9_095_088n, blockGasLimit: 20_000_000n });
    assert.match(tooSmall.blocking ?? "", /run out of gas/);
  });
});

describe("DEP-02: prepare simulates, attaches the access list, and refuses what would fail", () => {
  const HASHER_ENTRY = { address: "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", storageKeys: [] as string[] };
  function setup(over: Record<string, (params: unknown[]) => unknown> = {}, opts: { recordShared?: boolean } = {}) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const contractsDir = tmp();
    writeArtifact(contractsDir, "PoseidonT3");
    writeArtifact(contractsDir, "PoseidonT5");
    writeArtifact(contractsDir, "Groth16Verifier");
    poolArtifact(contractsDir);
    const deploymentsDir = tmp();
    if (opts.recordShared) {
      for (const [key, address] of [["PoseidonT3", "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], ["PoseidonT5", "0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], ["Groth16Verifier", "0x00cccccccccccccccccccccccccccccccccccccc"]] as const) {
        recordDeployment(deploymentsDir, QUAI_CYPRUS1.id, 9, { contract: key, key, address, txHash: "0x" + "1".repeat(64), blockNumber: 1, deployer: DEPLOYER, deployedAt: new Date().toISOString(), expectedBytecodeHash: "0x0", expectedHashKind: "runtime", onChainRuntimeHash: "0x0", gasUsed: "0x1" });
      }
    }
    const handlers = {
      ...zoneOk,
      quai_getCode: () => "0x",
      quai_gasPrice: () => "0x3b9aca00",
      quai_getBalance: () => "0x" + (10n ** 24n).toString(16),
      quai_createAccessList: () => ({ accessList: [HASHER_ENTRY], gasUsed: "0x2c358b" }),
      quai_estimateGas: () => "0x3ae58e",
      quai_getBlockByNumber: () => ({ header: { gasLimit: "0x2faf080" } }),
      ...over
    };
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport(handlers, calls) });
    return { cd: new ChainDeployer(rpc, contractsDir, deploymentsDir), calls, deploymentsDir };
  }

  it("simulates the exact creation (no `to`), returns its access list, and sizes gas from the estimate", async () => {
    const { cd, calls } = setup({}, { recordShared: true });
    const p = await cd.prepare({ deployer: DEPLOYER, key: poolKey("WQUAI"), asset: "WQUAI" });
    assert.equal(p.contract, "DarkCirclePool");
    assert.deepEqual(p.accessList.map((e) => e.address.toLowerCase()), [HASHER_ENTRY.address]);
    const sim = calls.find((c) => c.method === "quai_createAccessList")!;
    const tx = sim.params[0] as Record<string, unknown>;
    assert.equal(tx.to, undefined, "a creation carries no recipient");
    assert.equal(tx.data, p.data);
    const est = calls.find((c) => c.method === "quai_estimateGas")!;
    assert.deepEqual((est.params[0] as { accessList: unknown[] }).accessList.length, 1, "the estimate is taken WITH the access list attached");
    assert.equal(BigInt(p.gasLimit), 0x3ae58en * 3n > creationGasLimit((POOL_RUNTIME.length - 2) / 2) ? 0x3ae58en * 3n : creationGasLimit((POOL_RUNTIME.length - 2) / 2));
    assert.equal(p.estimateGas, String(0x3ae58e));
    assert.ok(BigInt(p.maxCostWei) === BigInt(p.gasLimit) * 1_000_000_000n);
  });

  it("refuses a creation the node says would fail: nothing is handed to the wallet", async () => {
    const reverting = setup({ quai_createAccessList: () => ({ error: "execution reverted: dependency has no code" }) });
    await assert.rejects(reverting.cd.prepare({ deployer: DEPLOYER, key: "PoseidonT3", asset: "WQUAI" }), /ERR_QUAI_SIMULATION_FAILED.*dependency has no code/);
    const estimateFails = setup({ quai_estimateGas: () => { throw new Error("ERR_QUAI_RPC: quai_estimateGas: out of gas"); } });
    await assert.rejects(estimateFails.cd.prepare({ deployer: DEPLOYER, key: "PoseidonT3", asset: "WQUAI" }), /ERR_QUAI_SIMULATION_FAILED.*estimateGas/);
  });

  it("refuses a step whose permitted gas limit cannot cover Quai's creation cost, one already recorded, one with unrecorded dependencies, and one the deployer cannot afford", async () => {
    const tightBlock = setup({ quai_estimateGas: () => "0x" + (9_095_088n).toString(16), quai_getBlockByNumber: () => ({ header: { gasLimit: "0x" + (20_000_000n).toString(16) } }) });
    await assert.rejects(tightBlock.cd.prepare({ deployer: DEPLOYER, key: "PoseidonT3", asset: "WQUAI" }), /ERR_GAS_HEADROOM/);

    const recorded = setup({}, { recordShared: true });
    await assert.rejects(recorded.cd.prepare({ deployer: DEPLOYER, key: "PoseidonT3", asset: "WQUAI" }), /ERR_ALREADY_DEPLOYED/);

    const noDeps = setup();
    await assert.rejects(noDeps.cd.prepare({ deployer: DEPLOYER, key: poolKey("WQUAI"), asset: "WQUAI" }), /ERR_DEPENDENCY_NOT_DEPLOYED.*Groth16Verifier/);

    const poor = setup({ quai_getBalance: () => "0x1" });
    await assert.rejects(poor.cd.prepare({ deployer: DEPLOYER, key: "PoseidonT3", asset: "WQUAI" }), /ERR_INSUFFICIENT_BALANCE/);

    const wrongZone = setup();
    await assert.rejects(wrongZone.cd.prepare({ deployer: WRONG_ZONE, key: "PoseidonT3", asset: "WQUAI" }), /ERR_QUAI_ADDRESS_WRONG_ZONE/);
  });
});

describe("ChainDeployer.verifyPoolBindings", () => {
  it("passes when every constructor-bound address and the empty-tree root match", async () => {
    const contractsDir = tmp();
    poolArtifact(contractsDir);
    const deploymentsDir = tmp();
    const addrs = {
      Groth16Verifier: "0x00cccccccccccccccccccccccccccccccccccccc".slice(0, 42),
      PoseidonT3: "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      PoseidonT5: "0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      pool: "0x00dddddddddddddddddddddddddddddddddddddd".slice(0, 42)
    };
    const rec = (key: "PoseidonT3" | "PoseidonT5" | "Groth16Verifier" | `DarkCirclePool:${string}`, address: string) =>
      recordDeployment(deploymentsDir, QUAI_CYPRUS1.id, 9, { contract: key, key, address, txHash: "0x" + "1".repeat(64), blockNumber: 1, deployer: DEPLOYER, deployedAt: new Date().toISOString(), expectedBytecodeHash: "0x0", expectedHashKind: "runtime", onChainRuntimeHash: "0x0", gasUsed: "0x1" });
    rec("Groth16Verifier", addrs.Groth16Verifier);
    rec("PoseidonT3", addrs.PoseidonT3);
    rec("PoseidonT5", addrs.PoseidonT5);
    const token = defaultQuaiTokenRegistry.require("WQUAI", QUAI_CYPRUS1);
    rec(poolKey("WQUAI"), addrs.pool);

    const { IncrementalMerkleTree } = await import("../../src/crypto/merkleTree.ts");
    const emptyRoot = new IncrementalMerkleTree(16, 64).root;
    const iface = new Interface(["function token() view returns (address)", "function verifier() view returns (address)", "function hasher2() view returns (address)", "function hasher4() view returns (address)", "function currentRoot() view returns (uint256)"]);
    const answers: Record<string, string> = {
      token: iface.encodeFunctionResult("token", [getAddress(token.address)]),
      verifier: iface.encodeFunctionResult("verifier", [getAddress(addrs.Groth16Verifier)]),
      hasher2: iface.encodeFunctionResult("hasher2", [getAddress(addrs.PoseidonT3)]),
      hasher4: iface.encodeFunctionResult("hasher4", [getAddress(addrs.PoseidonT5)]),
      currentRoot: iface.encodeFunctionResult("currentRoot", [emptyRoot])
    };
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk, quai_call: (params) => { const data = (params[0] as { data: string }).data; const fn = iface.parseTransaction({ data })!.name; return answers[fn]; } }) });
    const cd = new ChainDeployer(rpc, contractsDir, deploymentsDir);
    const r = await cd.verifyPoolBindings("WQUAI");
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.equal(r.checks.length, 5);
  });

  it("catches a pool that is bound to the wrong token (or any other mismatched dependency)", async () => {
    const contractsDir = tmp();
    poolArtifact(contractsDir);
    const deploymentsDir = tmp();
    recordDeployment(deploymentsDir, QUAI_CYPRUS1.id, 9, { contract: "DarkCirclePool", key: poolKey("WQUAI"), address: "0x00dddddddddddddddddddddddddddddddddddddd".slice(0, 42), txHash: "0x" + "1".repeat(64), blockNumber: 1, deployer: DEPLOYER, deployedAt: new Date().toISOString(), expectedBytecodeHash: "0x0", expectedHashKind: "runtime", onChainRuntimeHash: "0x0", gasUsed: "0x1" });
    const iface = new Interface(["function token() view returns (address)"]);
    const wrongToken = "0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".slice(0, 42);
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport({ ...zoneOk, quai_call: () => iface.encodeFunctionResult("token", [getAddress(wrongToken)]) }) });
    const cd = new ChainDeployer(rpc, contractsDir, deploymentsDir);
    const r = await cd.verifyPoolBindings("WQUAI");
    assert.equal(r.ok, false);
    assert.equal(r.checks[0].id, "P-01");
    assert.equal(r.checks[0].ok, false);
  });

  it("reports plainly when the pool has not been recorded yet, instead of throwing", async () => {
    const contractsDir = tmp();
    poolArtifact(contractsDir);
    const rpc = new QuaiRpcClient({ network: QUAI_CYPRUS1, transport: transport(zoneOk) });
    const cd = new ChainDeployer(rpc, contractsDir, tmp());
    const r = await cd.verifyPoolBindings("WQUAI");
    assert.equal(r.ok, false);
    assert.match(r.checks[0].detail, /not recorded/);
  });
});
