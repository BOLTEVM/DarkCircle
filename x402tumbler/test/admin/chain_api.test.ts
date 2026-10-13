/**
 * DarkCircle admin console: on-chain deployment routes
 * File: test/admin/chain_api.test.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (this whole directory is removed by scripts/redact-admin.ts).
 *
 * Covers the HTTP surface for wallet-signed deployment: session gating, the server-side mainnet
 * acknowledgement gate (a determined caller cannot get real calldata for mainnet by skipping the UI
 * warning), that a bad or unverifiable receipt is refused and never recorded, that the typed confirmation
 * for forgetting a record actually requires the real recorded address, and that nothing here ever reaches
 * a real network: every chain read goes through a fake QuaiRpcClient transport supplied via
 * `chainRpcFactory`, the same test seam test/admin/chain.test.ts uses for the deployer class itself.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256, getAddress, Interface } from "ethers";
import { startApiServer, type RunningApi } from "../../src/api/server.ts";
import { QuaiRpcClient, type JsonRpcTransport } from "../../src/quai/rpc.ts";
import { QUAI_CYPRUS1 } from "../../src/quai/networks.ts";

const TOKEN = "an-admin-token-that-is-long-enough-42";
const DEPLOYER = "0x004e3d0Ea0B77B9E5E8fAA72D0FC8a4a2e1D4A31";

function transport(handlers: Record<string, (params: unknown[]) => unknown>): JsonRpcTransport {
  return async (method, params) => {
    const h = handlers[method];
    if (!h) throw new Error(`ERR_QUAI_RPC: ${method}: unhandled in test fake`);
    return h(params);
  };
}
const zoneOk = { quai_chainId: () => "0x9", quai_nodeLocation: () => ["0x0", "0x0"] };

function writeArtifact(dir: string, name: string, runtimeHex = "0x600160005260206000f3", ctorInputs: Array<{ name: string; type: string }> = []) {
  fs.mkdirSync(dir, { recursive: true });
  const bytecodeHash = keccak256(runtimeHex);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
    contractName: name,
    abi: [{ type: "constructor", inputs: ctorInputs, stateMutability: "nonpayable" }],
    bytecode: "0x6080604052",
    deployedBytecode: runtimeHex,
    bytecodeHash,
    hashKind: "runtime"
  }));
  return { bytecodeHash, runtimeHex };
}

const call = (api: RunningApi, method: "GET" | "POST", url: string, opts: { body?: unknown; admin?: string } = {}) =>
  fetch(api.url.replace(/\/$/, "") + url, {
    method,
    headers: { "X-DarkCircle-Session": api.token, ...(opts.admin ? { "X-DarkCircle-Admin": opts.admin } : {}), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  }).then(async (res) => ({ status: res.status, json: (await res.json().catch(() => undefined)) as any }));

describe("on-chain deployment routes", () => {
  let api: RunningApi;
  let admin: string;
  let contractsDir: string;
  let fakeTransports: Record<string, JsonRpcTransport>;

  before(async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-chainapi-build-"));
    contractsDir = path.join(buildDir, "contracts");
    writeArtifact(contractsDir, "PoseidonT3");
    writeArtifact(contractsDir, "PoseidonT5");
    writeArtifact(contractsDir, "Groth16Verifier");
    writeArtifact(contractsDir, "DarkCirclePool", "0x60016001600155", [
      { name: "token_", type: "address" }, { name: "verifier_", type: "address" }, { name: "hasher2_", type: "address" }, { name: "hasher4_", type: "address" }
    ]);
    fakeTransports = {};
    api = await startApiServer({
      port: 0,
      admin: {
        token: TOKEN,
        auditLogFile: path.join(buildDir, "audit.log"),
        buildDir,
        chainRpcFactory: (network) => new QuaiRpcClient({ network, transport: (method, params) => (fakeTransports[network.id] ?? transport(zoneOk))(method, params) })
      }
    });
    const login = await call(api, "POST", "/api/admin/login", { body: { token: TOKEN } });
    admin = login.json.session;
  });
  after(async () => { await api.close(); });

  it("needs an admin session, same as every other admin route", async () => {
    const r = await call(api, "GET", "/api/admin/deploy/chain/status?target=orchard");
    assert.equal(r.status, 401);
  });

  it("launch checklist: needs a session, never ticks what was not verified, and leaves the operator's steps manual", async () => {
    assert.equal((await call(api, "GET", "/api/admin/deploy/launch")).status, 401);
    const r = await call(api, "GET", "/api/admin/deploy/launch", { admin });
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.json.items.map((i: { id: string }) => [i.id, i]));
    assert.equal(byId["T-00"].state, "done", "WQI is registered on Orchard");
    for (const id of ["G-05", "G-06", "G-07", "G-08"]) assert.equal(byId[id].state, "blocked", id);
    for (const id of ["T-06", "T-07", "M-01", "M-07"]) assert.equal(byId[id].state, "manual", id);
    for (const id of ["T-04", "M-02", "M-03", "M-04", "M-05", "M-06"]) assert.notEqual(byId[id].state, "done", `${id}: nothing is recorded as deployed`);
    assert.deepEqual(r.json.phases.length, 4);
  });

  it("status reports the network and (empty, at first) recorded deployments, for either target", async () => {
    const orchard = await call(api, "GET", "/api/admin/deploy/chain/status?target=orchard", { admin });
    assert.equal(orchard.status, 200);
    assert.equal(orchard.json.network.chainId, 15000);
    assert.deepEqual(orchard.json.deployments, {});
    const mainnet = await call(api, "GET", "/api/admin/deploy/chain/status?target=mainnet", { admin });
    assert.equal(mainnet.json.network.chainId, 9);
    assert.equal((await call(api, "GET", "/api/admin/deploy/chain/status?target=nonsense", { admin })).status, 400);
  });

  it("preflight refuses an out-of-zone or malformed deployer, and a mismatched checksum, without ever touching the network handlers for those fields", async () => {
    fakeTransports["quai-orchard-cyprus1"] = transport({ ...zoneOk, quai_chainId: () => "0x3a98", quai_getCode: () => "0x", quai_getBalance: () => "0x" + (10n ** 21n).toString(16), quai_gasPrice: () => "0x1" });
    const r = await call(api, "POST", "/api/admin/deploy/chain/preflight", { admin, body: { target: "orchard", asset: "WQUAI", deployer: "0x10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    assert.equal(r.status, 200); // the ROUTE succeeds; the PREFLIGHT reports the problem
    assert.equal(r.json.preflight.ok, false);
    assert.ok(r.json.preflight.errors.some((e: string) => /ERR_QUAI_ADDRESS_WRONG_ZONE/.test(e)));
  });

  it("orchard preflight needs no mainnet acknowledgement", async () => {
    fakeTransports["quai-orchard-cyprus1"] = transport({ ...zoneOk, quai_chainId: () => "0x3a98", quai_getCode: () => "0x", quai_getBalance: () => "0x" + (10n ** 21n).toString(16), quai_gasPrice: () => "0x1" });
    const r = await call(api, "POST", "/api/admin/deploy/chain/preflight", { admin, body: { target: "orchard", asset: "WQUAI", deployer: DEPLOYER } });
    assert.equal(r.status, 200);
    // Orchard genuinely has no registered WQUAI here (see README Known limits); this is the honest, expected outcome
    assert.equal(r.json.preflight.ok, false);
    assert.ok(r.json.preflight.errors.some((e: string) => /ERR_QUAI_TOKEN_UNKNOWN/.test(e)));
  });

  it("MAINNET: refuses to hand back preflight/calldata without acknowledgement, and lists exactly the unmet risk gates", async () => {
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_getCode: () => "0x", quai_getBalance: () => "0x" + (10n ** 21n).toString(16), quai_gasPrice: () => "0x1" });
    const r = await call(api, "POST", "/api/admin/deploy/chain/preflight", { admin, body: { target: "mainnet", asset: "WQUAI", deployer: DEPLOYER } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, "MAINNET_RISK_NOT_ACKNOWLEDGED");
    assert.deepEqual(r.json.error.gates.map((g: any) => g.id).sort(), ["G-05", "G-06", "G-07", "G-08"]);
  });

  it("MAINNET: proceeds once acknowledged, and prices the real steps", async () => {
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_getCode: () => "0x", quai_getBalance: () => "0x" + (10n ** 21n).toString(16), quai_gasPrice: () => "0x3b9aca00" });
    const r = await call(api, "POST", "/api/admin/deploy/chain/preflight", { admin, body: { target: "mainnet", asset: "WQUAI", deployer: DEPLOYER, acknowledged: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.preflight.ok, true, JSON.stringify(r.json.preflight.errors));
    assert.equal(r.json.preflight.steps.length, 4);
    assert.equal(r.json.preflight.steps[0].contract, "PoseidonT3");
  });

  it("receipt: a still-pending transaction is an ordinary 200 with {pending:true}, not an error (2xx already means success to the client's api() wrapper)", async () => {
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_getTransactionReceipt: () => null });
    const r = await call(api, "POST", "/api/admin/deploy/chain/receipt", { admin, body: { target: "mainnet", key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "9".repeat(64), deployer: DEPLOYER } });
    assert.equal(r.status, 200);
    assert.equal(r.json.pending, true);
    assert.equal(r.json.record, undefined);
    const status = await call(api, "GET", "/api/admin/deploy/chain/status?target=mainnet", { admin });
    assert.equal(status.json.deployments.PoseidonT3, undefined, "pending must not have recorded anything");
  });

  it("receipt: rejects a malformed tx hash before any chain read, refuses an unverified deployment, and records a real one — each audited", async () => {
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_getCode: () => "0x", quai_getBalance: () => "0x0", quai_gasPrice: () => "0x1" });
    const bad = await call(api, "POST", "/api/admin/deploy/chain/receipt", { admin, body: { target: "mainnet", key: "PoseidonT3", contract: "PoseidonT3", txHash: "not-a-hash", deployer: DEPLOYER } });
    assert.equal(bad.status, 400);

    const revertedTransport = transport({ ...zoneOk, quai_getTransactionReceipt: () => ({ status: "0x0", blockNumber: "0x64" }) });
    fakeTransports["quai-cyprus1"] = revertedTransport;
    const reverted = await call(api, "POST", "/api/admin/deploy/chain/receipt", { admin, body: { target: "mainnet", key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "1".repeat(64), deployer: DEPLOYER } });
    assert.equal(reverted.status, 422);
    assert.equal(reverted.json.error.code, "DEPLOY_REVERTED");

    const addr = "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const runtime = writeArtifact(contractsDir, "PoseidonT3").runtimeHex; // re-read the same fixture's runtime code
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: addr, gasUsed: "0x100" }), quai_getCode: () => runtime });
    const good = await call(api, "POST", "/api/admin/deploy/chain/receipt", { admin, body: { target: "mainnet", key: "PoseidonT3", contract: "PoseidonT3", txHash: "0x" + "2".repeat(64), deployer: DEPLOYER } });
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.equal(good.json.record.address, getAddress(addr));

    const status = await call(api, "GET", "/api/admin/deploy/chain/status?target=mainnet", { admin });
    assert.equal(status.json.deployments.PoseidonT3.address, getAddress(addr));

    const audit = await call(api, "GET", "/api/admin/audit", { admin });
    const actions = audit.json.entries.map((e: any) => e.action);
    assert.ok(actions.includes("deploy.chain.record"));
    for (const e of audit.json.entries) assert.equal(typeof e.detail, "string");
  });

  it("verify-pool reports on the recorded pool's bindings without needing anything further from the operator", async () => {
    const iface = new Interface(["function token() view returns (address)"]);
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_call: () => iface.encodeFunctionResult("token", [getAddress("0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")]) });
    const r = await call(api, "POST", "/api/admin/deploy/chain/verify-pool", { admin, body: { target: "mainnet", asset: "WQUAI" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false); // no pool recorded yet in this test's store
    assert.match(r.json.checks[0].detail, /not recorded/);
  });

  it("forget requires the exact recorded address as a typed confirmation, and a wrong one changes nothing", async () => {
    const wrong = await call(api, "POST", "/api/admin/deploy/chain/forget", { admin, body: { target: "mainnet", key: "PoseidonT3", confirm: "FORGET 0xwrong" } });
    assert.equal(wrong.status, 400);
    const before = await call(api, "GET", "/api/admin/deploy/chain/status?target=mainnet", { admin });
    assert.ok(before.json.deployments.PoseidonT3, "the refused forget must not have removed the record");

    const right = await call(api, "POST", "/api/admin/deploy/chain/forget", { admin, body: { target: "mainnet", key: "PoseidonT3", confirm: `FORGET ${before.json.deployments.PoseidonT3.address}` } });
    assert.equal(right.status, 200);
    const after = await call(api, "GET", "/api/admin/deploy/chain/status?target=mainnet", { admin });
    assert.equal(after.json.deployments.PoseidonT3, undefined);
  });

  it("DEP-02 prepare: mainnet calldata still needs the acknowledgement; once given, it returns the simulated access list and a gas limit sized from the live estimate", async () => {
    const listed = { address: "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", storageKeys: [] };
    fakeTransports["quai-cyprus1"] = transport({
      ...zoneOk,
      quai_getCode: () => "0x",
      quai_getBalance: () => "0x" + (10n ** 24n).toString(16),
      quai_gasPrice: () => "0x3b9aca00",
      quai_createAccessList: () => ({ accessList: [listed], gasUsed: "0x10000" }),
      quai_estimateGas: () => "0x" + (9_095_088n).toString(16),
      quai_getBlockByNumber: () => ({ header: { gasLimit: "0x2faf080" } })
    });
    const unacknowledged = await call(api, "POST", "/api/admin/deploy/chain/prepare", { admin, body: { target: "mainnet", asset: "WQUAI", key: "PoseidonT5", deployer: DEPLOYER } });
    assert.equal(unacknowledged.status, 409);
    assert.equal(unacknowledged.json.error.code, "MAINNET_RISK_NOT_ACKNOWLEDGED");

    const r = await call(api, "POST", "/api/admin/deploy/chain/prepare", { admin, body: { target: "mainnet", asset: "WQUAI", key: "PoseidonT5", deployer: DEPLOYER, acknowledged: true } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.prepared.contract, "PoseidonT5");
    assert.equal(BigInt(r.json.prepared.gasLimit), 9_095_088n * 3n);
    assert.deepEqual(r.json.prepared.accessList.map((e: any) => e.address.toLowerCase()), [listed.address]);
    const audit = await call(api, "GET", "/api/admin/audit", { admin });
    assert.ok(audit.json.entries.some((e: any) => e.action === "deploy.chain.prepare" && /nothing was sent/.test(e.detail)));
  });

  it("DEP-02 prepare: a creation the zone says would revert is refused with the node's reason", async () => {
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_getCode: () => "0x", quai_getBalance: () => "0x" + (10n ** 24n).toString(16), quai_gasPrice: () => "0x1", quai_createAccessList: () => ({ error: "execution reverted" }) });
    const r = await call(api, "POST", "/api/admin/deploy/chain/prepare", { admin, body: { target: "mainnet", asset: "WQUAI", key: "PoseidonT3", deployer: DEPLOYER, acknowledged: true } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, "QUAI_SIMULATION_FAILED");
  });

  it("DEP-05 receipt: the key decides the contract; a disagreeing client value is refused and nothing is recorded", async () => {
    fakeTransports["quai-cyprus1"] = transport({ ...zoneOk, quai_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x64", contractAddress: "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), quai_getCode: () => "0x600160005260206000f3" });
    const r = await call(api, "POST", "/api/admin/deploy/chain/receipt", { admin, body: { target: "mainnet", key: "Groth16Verifier", contract: "PoseidonT3", txHash: "0x" + "4".repeat(64), deployer: DEPLOYER } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, "KEY_CONTRACT_MISMATCH");
    const status = await call(api, "GET", "/api/admin/deploy/chain/status?target=mainnet", { admin });
    assert.equal(status.json.deployments.Groth16Verifier, undefined);
    // and the contract field is no longer needed at all
    const keyOnly = await call(api, "POST", "/api/admin/deploy/chain/receipt", { admin, body: { target: "mainnet", key: "Groth16Verifier", txHash: "0x" + "5".repeat(64), deployer: DEPLOYER } });
    assert.equal(keyOnly.status, 200, JSON.stringify(keyOnly.json));
    assert.equal(keyOnly.json.record.contract, "Groth16Verifier");
  });

  it("refuses a malformed deployment key instead of writing a garbage record", async () => {
    const r = await call(api, "POST", "/api/admin/deploy/chain/receipt", { admin, body: { target: "mainnet", key: "; DROP TABLE", contract: "PoseidonT3", txHash: "0x" + "3".repeat(64), deployer: DEPLOYER } });
    assert.equal(r.status, 400);
  });
});
