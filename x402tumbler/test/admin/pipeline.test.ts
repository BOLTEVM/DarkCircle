/**
 * DarkCircle admin console: the build-and-deploy pipeline
 * File: test/admin/pipeline.test.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (this whole directory is removed by scripts/redact-admin.ts).
 *
 * Two groups. The logic group is fast and always runs: stage ordering, staleness, failure recording, plan
 * gating, witness building. The end-to-end group runs the real toolchain (circom, snarkjs, solc, a local EVM)
 * in child processes. It needs the powers-of-tau cache (a 2^15 ceremony takes about six minutes the first time
 * and is cached in build/ptau); when the cache is absent it is skipped unless DARKCIRCLE_PIPELINE_TESTS=1,
 * so a fresh checkout's `pnpm test` does not silently spend six minutes.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { Pipeline, STAGES, type SelftestRequest } from "../../src/admin/deploy/pipeline.ts";
import { changedInputs, readManifest, refFor, writeManifest, type Manifest, type StageRecord } from "../../src/admin/deploy/manifest.ts";
import { requiredPower } from "../../src/admin/deploy/circuit.ts";
import { PUBLIC_SIGNALS, buildUnshieldWitness } from "../../src/admin/deploy/witness.ts";
import { createMultiAssetEnvironment } from "../../src/cli/context.ts";
import { poseidon3, poseidon4 } from "../../src/crypto/poseidon.ts";
import { computePublicInputsHash } from "../../src/crypto/unshield.ts";
import { Fp } from "../../src/crypto/field.ts";
import { SIM_VENDOR_ADDRESS } from "../../src/sim/defaults.ts";

const PROJECT = path.resolve(import.meta.dirname, "..", "..");
const PTAU_CACHE = path.join(PROJECT, "build", "ptau");
const HAVE_PTAU = fs.existsSync(path.join(PTAU_CACHE, "pot15_final.ptau")) && fs.existsSync(path.join(PTAU_CACHE, "pot15_final.ptau.sha256"));
const FORCE = process.env.DARKCIRCLE_PIPELINE_TESTS === "1";
const RUN_SLOW = HAVE_PTAU || FORCE;
const ONE = 10n ** 18n;
const SLOW = 25 * 60_000;

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-pipeline-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = createMultiAssetEnvironment();

function selftestRequest(): SelftestRequest {
  const lane = env.lanes.WQUAI;
  const w = buildUnshieldWitness(lane, { recipient: SIM_VENDOR_ADDRESS, amount: 5n * ONE });
  return { input: w.input, aliasedKeyInput: w.aliasedKeyInput, expectedPublic: w.expectedPublic, note: { leafIndex: w.note.leafIndex, value: w.note.value.toString() }, pool: lane.pool.contractAddress, asset: "WQUAI" };
}

async function finish(p: Pipeline, jobId: string) {
  const t0 = Date.now();
  while (p.currentJob()) {
    if (Date.now() - t0 > SLOW) throw new Error("stage did not finish in time");
    await sleep(200);
  }
  return p.job(jobId)!;
}
const run = async (p: Pipeline, stage: string) => finish(p, p.start(stage).id);

function record(id: string, over: Partial<StageRecord> = {}): StageRecord {
  return { id, status: "ok", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, summary: "seeded for the test", inputs: [], artifacts: [], warnings: [], ...over };
}

function seed(buildDir: string, ids: string[], details: Record<string, unknown> = {}) {
  const m: Manifest = { version: 1, updatedAt: new Date().toISOString(), stages: {} };
  for (const id of ids) m.stages[id] = record(id, { details: details[id] });
  writeManifest(buildDir, m);
}

const stateOf = (p: Pipeline) => Object.fromEntries(p.status().map((s) => [s.id, s.state]));

describe("pipeline logic", () => {
  it("sizes the powers of tau the way snarkjs requires", () => {
    assert.equal(requiredPower({ constraints: 17568, publicInputs: 9 }), 15, "the unshield circuit needs 2^15");
    assert.equal(requiredPower({ constraints: 517, publicInputs: 0 }), 10);
    assert.equal(requiredPower({ constraints: 1023, publicInputs: 0 }), 10);
    assert.equal(requiredPower({ constraints: 1024, publicInputs: 0 }), 11);
    assert.equal(requiredPower({ constraints: 8190, publicInputs: 1, outputs: 0 }), 13);
  });

  it("the witness carries the simulation's own values in the circuit's public-signal order", () => {
    const lane = env.lanes.WQUAI;
    const w = buildUnshieldWitness(lane, { recipient: SIM_VENDOR_ADDRESS, amount: 5n * ONE });
    assert.deepEqual([...PUBLIC_SIGNALS], ["merkleRoot", "nullifier", "changeCommitment", "recipient", "token", "amount", "relayer", "relayerFee", "publicInputsHash"]);
    const byName = Object.fromEntries(PUBLIC_SIGNALS.map((k, i) => [k, w.expectedPublic[i]]));
    const pool = lane.pool as any;
    const note = lane.treasuryUTXOs[0];
    assert.equal(byName.merkleRoot, pool.merkleTree.root.toString());
    assert.equal(byName.nullifier, poseidon3(Fp.mod(lane.corporateKeys.ssk), note.commitment, BigInt(note.leafIndex)).toString());
    assert.equal(byName.amount, (5n * ONE).toString());
    assert.equal(byName.relayerFee, lane.relayer.minimumFee.toString());
    assert.equal(w.change, note.value - 5n * ONE - lane.relayer.minimumFee);
    assert.equal(byName.changeCommitment, poseidon4(lane.corporateKeys.npk, BigInt(w.token), w.change, BigInt(w.input.changeRho as string)).toString());
    assert.equal(byName.publicInputsHash, BigInt(computePublicInputsHash({ recipient: w.recipient, token: w.token, amount: 5n * ONE, relayerAddress: w.relayer, relayerFee: lane.relayer.minimumFee, merkleRoot: Fp.toHex(pool.merkleTree.root) })).toString());
    assert.equal((w.input.siblings as string[]).length, 16);
    assert.throws(() => buildUnshieldWitness(lane, { recipient: SIM_VENDOR_ADDRESS, amount: 1_000_000n * ONE }), /ERR_NO_NOTE/);
    assert.throws(() => buildUnshieldWitness(lane, { recipient: SIM_VENDOR_ADDRESS, amount: 100n * ONE, noteIndex: 0 }), /ERR_NOTE_TOO_SMALL/); // 100 + the 0.5 fee exceeds the 100-token note
  });

  it("a fresh build directory: only the first stage is ready; the rest wait, and cannot be started", () => {
    const p = new Pipeline({ buildDir: tmp(), selftestInput: selftestRequest });
    const states = stateOf(p);
    assert.equal(states["circuit.compile"], "ready");
    for (const id of ["circuit.setup", "verifier.export", "contracts.compile", "circuit.selftest", "evm.local"]) assert.equal(states[id], "blocked", id);
    assert.deepEqual(p.status().find((s) => s.id === "contracts.compile")!.blockedBy, ["verifier.export"]);
    assert.throws(() => p.start("circuit.setup"), /ERR_STAGE_BLOCKED: run circuit.compile first/);
    assert.throws(() => p.start("no.such.stage"), /ERR_UNKNOWN_STAGE/);
    assert.equal(p.currentJob(), null);
    assert.equal(p.cancel(), false);
  });

  it("a stage whose input file is missing is refused with a clear message, not a crash", () => {
    const dir = tmp();
    seed(dir, ["circuit.compile", "circuit.setup", "verifier.export"]);
    const p = new Pipeline({ buildDir: dir, selftestInput: selftestRequest });
    assert.equal(stateOf(p)["contracts.compile"], "ready");
    assert.throws(() => p.start("contracts.compile"), /ERR_STAGE_INPUT_MISSING: contracts\/generated\/Groth16Verifier\.sol does not exist/);
    assert.equal(p.currentJob(), null);
  });

  it("detects that a recorded input or artifact changed or vanished", () => {
    const dir = tmp();
    const proj = tmp();
    fs.writeFileSync(path.join(dir, "a.bin"), "one");
    fs.writeFileSync(path.join(proj, "src.txt"), "source");
    const rec = record("x", { artifacts: [refFor("build", dir, "a.bin")], inputs: [refFor("project", proj, "src.txt")] });
    assert.deepEqual(changedInputs(rec, proj, dir), []);
    fs.writeFileSync(path.join(dir, "a.bin"), "two");
    assert.deepEqual(changedInputs(rec, proj, dir), ["a.bin"]);
    fs.writeFileSync(path.join(dir, "a.bin"), "one");
    fs.rmSync(path.join(proj, "src.txt"));
    assert.deepEqual(changedInputs(rec, proj, dir), ["src.txt"]);
  });

  it("the manifest survives a round trip and ignores a corrupt or foreign file", () => {
    const dir = tmp();
    assert.deepEqual(readManifest(dir).stages, {});
    seed(dir, ["circuit.compile"]);
    assert.equal(readManifest(dir).stages["circuit.compile"].status, "ok");
    fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json");
    assert.deepEqual(readManifest(dir).stages, {});
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 99, stages: { x: {} } }));
    assert.deepEqual(readManifest(dir).stages, {});
  });

  it("mainnet plan: blocked by the four gates this repository cannot satisfy, and it never broadcasts", () => {
    const dir = tmp();
    const hash = (n: string) => "0x" + n.repeat(64).slice(0, 64);
    seed(dir, STAGES.map((s) => s.id), { "contracts.compile": { contracts: { PoseidonT3: { bytecodeHash: hash("a"), hashKind: "creation" }, PoseidonT5: { bytecodeHash: hash("b"), hashKind: "creation" }, Groth16Verifier: { bytecodeHash: hash("c"), hashKind: "runtime" }, DarkCirclePool: { bytecodeHash: hash("d"), hashKind: "runtime" } } } });
    const p = new Pipeline({ buildDir: dir, selftestInput: selftestRequest });
    const plan = p.plan("mainnet");
    assert.equal(plan.broadcast, false);
    assert.equal(plan.canProceed, false);
    const failing = plan.gates.filter((g) => !g.ok && g.blocking).map((g) => g.id);
    assert.deepEqual(failing, ["G-05", "G-06", "G-07", "G-08"]);
    for (const id of ["G-01", "G-02", "G-03", "G-04", "G-09"]) assert.ok(plan.gates.find((g) => g.id === id)!.ok, id);
    assert.equal(plan.network.chainId, 9);
    assert.equal(plan.network.zonePrefix, "0x00");
    assert.deepEqual(plan.steps.map((s) => s.contract), ["PoseidonT3", "PoseidonT5", "Groth16Verifier", "DarkCirclePool", "DarkCirclePool"]);
    assert.equal(plan.steps[3].bytecodeHash, hash("d"));
    assert.match(plan.steps[3].constructorArgs[0], /^0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB$/, "the WQUAI pool is bound to the registered WQUAI address");
    assert.match(plan.steps[4].constructorArgs[0], /^0x002b2596EcF05C93a31ff916E8b456DF6C77c750$/);
    assert.ok(plan.external.some((x) => /sends nothing/.test(x)));
    assert.ok(fs.existsSync(path.join(dir, "deploy-plan-mainnet.json")));
    assert.equal(p.plan("mainnet").digest, plan.digest, "the same inputs give the same digest");
  });

  it("orchard plan: the ceremony, audit, PPOI and relayer gates warn instead of blocking; the verified WQI is the one pool Orchard can host", () => {
    const dir = tmp();
    seed(dir, STAGES.map((s) => s.id));
    const plan = new Pipeline({ buildDir: dir, selftestInput: selftestRequest }).plan("orchard");
    const blocking = plan.gates.filter((g) => !g.ok && g.blocking).map((g) => g.id);
    const warnings = plan.gates.filter((g) => !g.ok && !g.blocking).map((g) => g.id);
    assert.deepEqual(warnings, ["G-05", "G-06", "G-07", "G-08"]);
    assert.deepEqual(blocking, [], "WQI is registered on Orchard, so nothing blocks the testnet plan");
    assert.equal(plan.canProceed, true);
    assert.equal(plan.broadcast, false);
    const g09 = plan.gates.find((g) => g.id === "G-09")!;
    assert.ok(g09.ok && /WQI 0x002b2596EcF05C93a31ff916E8b456DF6C77c750/.test(g09.detail) && /no WQUAI contract exists here/.test(g09.detail), g09.detail);
    assert.deepEqual(plan.steps.map((s) => s.contract), ["PoseidonT3", "PoseidonT5", "Groth16Verifier", "DarkCirclePool"], "one pool: there is no WQUAI to bind a second one to");
    assert.equal(plan.network.chainId, 15000);
  });

  it("a plan made before anything was built fails the build gates too", () => {
    const plan = new Pipeline({ buildDir: tmp(), selftestInput: selftestRequest }).plan("mainnet");
    assert.deepEqual(plan.gates.filter((g) => !g.ok && g.blocking).map((g) => g.id).slice(0, 4), ["G-01", "G-02", "G-03", "G-04"]);
    assert.ok(plan.steps.every((s) => s.bytecodeHash === null), "no hashes are invented for contracts that were never compiled");
  });

  it("cancelling a running stage kills it, records nothing, and frees the pipeline", async () => {
    const dir = tmp();
    const p = new Pipeline({ buildDir: dir, selftestInput: selftestRequest });
    const job = p.start("circuit.compile");
    assert.equal(stateOf(p)["circuit.compile"], "running");
    assert.throws(() => p.start("circuit.compile"), /ERR_STAGE_BUSY/);
    assert.equal(p.cancel(), true);
    const done = await finish(p, job.id);
    assert.equal(done.status, "cancelled");
    assert.equal(readManifest(dir).stages["circuit.compile"], undefined, "a cancelled stage must not leave a record");
    assert.equal(p.currentJob(), null);
  });
});

describe("pipeline end to end (real circom, snarkjs, solc and a local EVM)", { skip: RUN_SLOW ? false : "powers-of-tau cache missing: run the pipeline once from the admin console, or set DARKCIRCLE_PIPELINE_TESTS=1 (about 6 extra minutes)" }, () => {
  const build = tmp();
  let corrupt = false;
  let pipeline: Pipeline;
  before(() => {
    pipeline = new Pipeline({
      buildDir: build,
      ptauCacheDir: PTAU_CACHE,
      selftestInput: () => {
        const r = selftestRequest();
        if (corrupt) r.expectedPublic[1] = "12345"; // claim a nullifier the simulation does not derive
        return r;
      }
    });
  });

  it("runs every stage to a recorded, hashed result", { timeout: SLOW }, async () => {
    for (const s of STAGES) {
      const job = await run(pipeline, s.id);
      assert.equal(job.status, "ok", `${s.id}: ${job.error ?? ""}\n${job.lines.slice(-8).join("\n")}`);
    }
    const st = stateOf(pipeline);
    for (const s of STAGES) assert.equal(st[s.id], "ok", s.id);

    const m = readManifest(build);
    const compile = m.stages["circuit.compile"].details as any;
    assert.equal(compile.constraints, 17568, "the reference circuit's size; a deliberate circuit change updates this number (17,624 before the key-range fix)");
    assert.equal(compile.publicInputs, 9);
    const setup = m.stages["circuit.setup"];
    assert.equal((setup.details as any).productionSafe, false, "the ceremony must never claim to be production safe");
    assert.equal((setup.details as any).zkeyVerified, true);
    assert.ok(setup.warnings.some((w) => /single local contributor/.test(w)));

    const contracts = (m.stages["contracts.compile"].details as any).contracts;
    assert.deepEqual(Object.keys(contracts).sort(), ["DarkCirclePool", "DevToken", "Groth16Verifier", "PoseidonT3", "PoseidonT5"]);
    assert.match(contracts.DarkCirclePool.bytecodeHash, /^0x[0-9a-f]{64}$/);
    assert.equal(contracts.DarkCirclePool.hashKind, "runtime");
    assert.equal(contracts.PoseidonT3.hashKind, "runtime", "the hashers' runtime code is derived at compile time, so their deployment can be checked byte for byte");
    assert.equal(contracts.PoseidonT5.hashKind, "runtime");
    assert.deepEqual([...contracts.DarkCirclePool.immutables].sort(), ["hasher2", "hasher4", "token", "verifier"], "the pool's immutables are recorded by name");
    assert.ok(contracts.DarkCirclePool.sizeBytes < 24576, "the pool must fit the EIP-170 code size limit");

    // every recorded artifact hashes to what is on disk
    for (const rec of Object.values(m.stages)) for (const a of rec.artifacts) assert.equal(refFor("build", build, a.path).sha256, a.sha256, a.path);
  });

  it("the self-test proved a real simulation note and every public signal matched", () => {
    const d = readManifest(build).stages["circuit.selftest"].details as any;
    assert.equal(d.verified, true);
    assert.equal(d.publicSignalsMatchSimulation, true);
    assert.equal(d.tamperedRejected, true);
    assert.equal(d.wrongKeyRejected, true);
    assert.equal(d.aliasedKeyRejected, true, "key + L (same note, second nullifier) must not be provable");
    assert.ok(d.proveMs < 60_000);
  });

  it("the local EVM run checked the compiled contracts against the simulation and against tampering", () => {
    const d = readManifest(build).stages["evm.local"].details as any;
    assert.ok(d.ok);
    const ids = d.checks.map((c: any) => c.id);
    for (const id of ["E-01", "E-02", "E-03", "E-04", "E-05", "E-06", "E-07", "E-08", "E-09", "E-10", "E-11", "E-12", "E-13", "E-15", "E-16", "E-17"]) assert.ok(ids.includes(id), `missing ${id}`);
    assert.ok(d.checks.every((c: any) => c.ok), JSON.stringify(d.checks.filter((c: any) => !c.ok)));
    assert.ok(d.gas.shield > 0 && d.gas.unshield > 0);
    assert.match(d.deployedCodeHashes.DarkCirclePool, /^0x[0-9a-f]{64}$/);
  });

  it("the plans now pass the build gates and still fail exactly the gates a repository cannot satisfy", () => {
    const mainnet = pipeline.plan("mainnet");
    assert.deepEqual(mainnet.gates.filter((g) => !g.ok && g.blocking).map((g) => g.id), ["G-05", "G-06", "G-07", "G-08"]);
    assert.ok(mainnet.steps.every((s) => s.bytecodeHash !== null));
  });

  it("the circuit accepts the real witness and rejects every way of cheating", { timeout: 120_000 }, async () => {
    const wasm = path.join(build, "circuit", "unshield_js", "unshield.wasm");
    const wtns = path.join(build, "circuit", ".test.wtns");
    const lane = env.lanes.WQUAI;
    const w = buildUnshieldWitness(lane, { recipient: SIM_VENDOR_ADDRESS, amount: 5n * ONE });
    const logs = [console.log, console.error];
    const quiet = () => { console.log = () => {}; console.error = () => {}; };
    const loud = () => { [console.log, console.error] = logs; };
    const attempt = async (input: Record<string, unknown>) => {
      quiet();
      try {
        await snarkjs.wtns.calculate(input, wasm, wtns);
        return true;
      } catch {
        return false;
      } finally {
        loud();
        fs.rmSync(wtns, { force: true });
      }
    };
    const bump = (v: unknown, by = 1n) => (BigInt(v as string) + by).toString();
    assert.equal(await attempt(w.input), true, "control: the honest witness is accepted");

    const cheats: Array<[string, (i: any) => void]> = [
      ["a spending key that does not own the note", (i) => { i.spendingKey = bump(i.spendingKey); }],
      // the 2026-09-23 audit's critical finding: key + L owns the same note and derives a second nullifier
      ["an aliased spending key (key + L) with its own, consistent nullifier", (i) => { i.spendingKey = w.aliasedKeyInput.spendingKey; i.nullifier = w.aliasedKeyInput.nullifier; }],
      ["a tampered Merkle sibling", (i) => { i.siblings[3] = bump(i.siblings[3]); }],
      ["a nullifier that is not the note's", (i) => { i.nullifier = bump(i.nullifier); }],
      ["a root the note is not under", (i) => { i.merkleRoot = bump(i.merkleRoot); }],
      ["an amount that breaks value conservation", (i) => { i.amount = bump(i.amount); }],
      ["a zero amount", (i) => { i.amount = "0"; i.changeValue = bump(i.changeValue, 5n * ONE); }],
      ["a recipient the binding hash does not cover", (i) => { i.recipient = bump(i.recipient); }],
      ["a relayer the binding hash does not cover", (i) => { i.relayer = bump(i.relayer); }],
      ["a fee the binding hash does not cover", (i) => { i.relayerFee = bump(i.relayerFee); i.changeValue = bump(i.changeValue, -1n); }],
      ["a change commitment that is not the change note", (i) => { i.changeCommitment = bump(i.changeCommitment); }],
      ["the wrong leaf index", (i) => { i.leafIndex = "1"; }],
      ["a value that overflows 128 bits", (i) => { i.inValue = (2n ** 128n).toString(); }],
      ["a note of a different token", (i) => { i.token = bump(i.token); }],
      ["change routed nowhere: a commitment with no change value", (i) => { i.changeValue = "0"; i.amount = bump(i.amount, BigInt(w.change)); }]
    ];
    for (const [name, mutate] of cheats) {
      const input = JSON.parse(JSON.stringify(w.input));
      mutate(input);
      assert.equal(await attempt(input), false, `the circuit accepted ${name}`);
    }
  });

  it("a self-test whose claimed public signals differ from the simulation fails and is recorded as failed", { timeout: SLOW }, async () => {
    corrupt = true;
    try {
      const job = await run(pipeline, "circuit.selftest");
      assert.equal(job.status, "failed");
      assert.match(job.error!, /ERR_SELFTEST.*publicSignalsMatchSimulation=false/);
      assert.equal(readManifest(build).stages["circuit.selftest"].status, "failed");
      assert.equal(stateOf(pipeline)["circuit.selftest"], "failed");
      assert.equal(pipeline.plan("mainnet").gates.find((g) => g.id === "G-03")!.ok, false, "a failed self-test must fail the plan's gate");
    } finally {
      corrupt = false;
    }
    const again = await run(pipeline, "circuit.selftest");
    assert.equal(again.status, "ok", "and it recovers when the mismatch is gone");
  });

  it("changing an upstream artifact makes everything downstream stale and blocks it", () => {
    const r1cs = path.join(build, "circuit", "unshield.r1cs");
    fs.appendFileSync(r1cs, Buffer.from([0]));
    const st = pipeline.status();
    const by = Object.fromEntries(st.map((s) => [s.id, s]));
    assert.equal(by["circuit.compile"].state, "stale", "its own artifact changed");
    assert.equal(by["circuit.setup"].state, "stale", "its input changed");
    assert.ok(by["circuit.setup"].changed.includes("circuit/unshield.r1cs"));
    assert.throws(() => pipeline.start("verifier.export"), /ERR_STAGE_BLOCKED: run circuit.setup first/);
    assert.equal(pipeline.plan("mainnet").gates.find((g) => g.id === "G-01")!.ok, false);
  });
});
