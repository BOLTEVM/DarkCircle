/**
 * DarkCircle: persistence (codec, encrypted store, environment snapshots, manager)
 * File: test/unit/persistence.test.ts
 *
 * The property that matters is not "the file round-trips" but "the restored environment still works":
 * a restored note can be spent, a restored payee key can be swept, and a snapshot that has been altered or
 * that came from a different key hierarchy is refused without touching live state.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { encode, decode, canonicalJson } from "../../src/persistence/codec.ts";
import { EncryptedStore } from "../../src/persistence/store.ts";
import { captureEnvironment, restoreEnvironment, verifyEnvironment } from "../../src/persistence/snapshot.ts";
import { PersistenceManager } from "../../src/persistence/manager.ts";
import { createMultiAssetEnvironment, type MultiAssetEnvironment } from "../../src/cli/context.ts";
import { executeShield } from "../../src/actions/shield.ts";
import { runCli } from "../../src/cli/index.ts";
import { ERC20_ABI } from "../../src/sim/erc20Token.ts";
import { SIM_MERCHANT_ADDRESS, SIM_VENDOR_ADDRESS } from "../../src/sim/defaults.ts";

const KDF = { N: 1 << 12, r: 8, p: 1 }; // cheap on purpose; production uses the default
const PASS = "correct horse battery staple";
const ONE = 10n ** 18n;
const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-persist-"));
  tmpDirs.push(d);
  return d;
};
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Puts a payment on an invoice and verifies it, playing the customer's wallet on the simulated ledger. */
async function settle(ctx: MultiAssetEnvironment["lanes"][string], amount: bigint) {
  const inv = ctx.merchantGateway.createPaymentChallenge("/r", amount, ctx.token!.address).invoice;
  ctx.token!.mint(SIM_MERCHANT_ADDRESS, amount);
  const tx = ctx.blockchain.executeTransaction({
    from: SIM_MERCHANT_ADDRESS,
    to: ctx.token!.address,
    data: new ethers.Interface(ERC20_ABI).encodeFunctionData("transfer", [inv.ephemeralAddress, amount])
  });
  assert.equal(tx.status, 1);
  const verified = await (ctx.merchantGateway as any).verifyPaymentAsync(inv.invoiceId, tx.transactionHash);
  assert.equal(verified.success, true);
  return inv;
}

describe("codec", () => {
  it("round-trips bigint, Map, Set, bytes, undefined and nesting exactly", () => {
    const value = {
      big: 2n ** 200n + 7n,
      neg: -5n,
      map: new Map<string, unknown>([["a", 1n], ["b", new Map([["deep", new Set([1n, 2n])]])]]),
      set: new Set(["x", "y"]),
      bytes: new Uint8Array([0, 1, 254, 255]),
      nothing: undefined,
      list: [1, "two", null, false, { k: 3n }]
    };
    const back = decode(JSON.parse(JSON.stringify(encode(value)))) as typeof value;
    assert.deepEqual(back, value);
    assert.ok(back.map instanceof Map && back.set instanceof Set && back.bytes instanceof Uint8Array);
    assert.equal(typeof back.big, "bigint");
  });

  it("refuses data it cannot represent instead of dropping it", () => {
    class Thing { x = 1; }
    assert.throws(() => encode(new Thing()), /ERR_CODEC_UNSUPPORTED_OBJECT/);
    assert.throws(() => encode({ f: () => 1 }), /ERR_CODEC_UNSUPPORTED_TYPE/);
    assert.throws(() => encode(Number.NaN), /ERR_CODEC_NON_FINITE_NUMBER/);
    assert.throws(() => encode({ $: "b", v: "1" }), /ERR_CODEC_RESERVED_KEY/);
    assert.throws(() => decode({ $: "b", v: "not a number" }), /ERR_CODEC_BAD_BIGINT/);
    assert.throws(() => decode({ $: "zzz" }), /ERR_CODEC_UNKNOWN_TAG/);
  });

  it("canonical JSON is independent of key order", () => {
    assert.equal(canonicalJson(encode({ a: 1n, b: 2n })), canonicalJson(encode({ b: 2n, a: 1n })));
  });
});

describe("encrypted store", () => {
  it("creates a store, refuses a wrong or weak passphrase, and never writes the passphrase or plaintext", () => {
    const dir = tmp();
    const secret = "PLAINTEXT-MARKER-0xdeadbeefcafebabe";
    const s = EncryptedStore.open({ dir, passphrase: PASS, kdf: KDF });
    s.save(JSON.stringify({ secret }));
    for (const f of fs.readdirSync(dir)) {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      assert.ok(!raw.includes(secret), `${f} must not contain plaintext`);
      assert.ok(!raw.includes(PASS), `${f} must not contain the passphrase`);
    }
    assert.throws(() => EncryptedStore.open({ dir, passphrase: "a different passphrase!!", kdf: KDF }), /ERR_STORE_WRONG_PASSPHRASE/);
    assert.throws(() => EncryptedStore.open({ dir: tmp(), passphrase: "short", kdf: KDF }), /ERR_STORE_WEAK_PASSPHRASE/);
    const again = EncryptedStore.open({ dir, passphrase: PASS });
    assert.equal(again.load()!.plaintext, JSON.stringify({ secret }));
  });

  it("numbers snapshots, never overwrites one, and keeps only the newest `keep`", () => {
    const s = EncryptedStore.open({ dir: tmp(), passphrase: PASS, kdf: KDF, keep: 3 });
    for (let i = 1; i <= 5; i++) assert.equal(s.save(`v${i}`).seq, i);
    assert.deepEqual(s.list().map((x) => x.seq), [3, 4, 5]);
    assert.equal(s.load()!.plaintext, "v5");
    assert.equal(s.load(4)!.plaintext, "v4");
    assert.equal(s.load(1), null);
  });

  it("recovers from a damaged newest snapshot by using the last good one, and says so", () => {
    const dir = tmp();
    const s = EncryptedStore.open({ dir, passphrase: PASS, kdf: KDF });
    s.save("first");
    s.save("second");
    const newest = s.save("third");
    const file = path.join(dir, newest.file);
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    const ct = Buffer.from(body.ct, "base64");
    ct[0] ^= 0xff;
    body.ct = ct.toString("base64");
    fs.writeFileSync(file, JSON.stringify(body));

    const report = s.scan();
    assert.equal(report.corrupt, 1);
    assert.equal(report.usable!.seq, 2);
    const loaded = s.load()!;
    assert.equal(loaded.plaintext, "second");
    assert.deepEqual(loaded.skipped.map((x) => x.seq), [3]);
    assert.match(loaded.skipped[0].reason!, /authentication failed/);
  });

  it("detects a truncated file, a re-labelled sequence number, and a snapshot moved in from another store", () => {
    const dirA = tmp();
    const dirB = tmp();
    const a = EncryptedStore.open({ dir: dirA, passphrase: PASS, kdf: KDF });
    const b = EncryptedStore.open({ dir: dirB, passphrase: PASS, kdf: KDF });
    const a1 = a.save("A-one");
    const a2 = a.save("A-two");
    b.save("B-one");

    // truncated
    fs.writeFileSync(path.join(dirA, a2.file), fs.readFileSync(path.join(dirA, a2.file), "utf8").slice(0, 40));
    // older ciphertext relabelled as a newer sequence number
    const relabelled = JSON.parse(fs.readFileSync(path.join(dirA, a1.file), "utf8"));
    relabelled.seq = 9;
    fs.writeFileSync(path.join(dirA, "snapshot-000009.dcs"), JSON.stringify(relabelled));
    // a snapshot from store B dropped into store A (same passphrase, different salt and id)
    fs.copyFileSync(path.join(dirB, "snapshot-000001.dcs"), path.join(dirA, "snapshot-000010.dcs"));

    const report = a.scan();
    const bySeq = Object.fromEntries(report.entries.map((e) => [e.seq, e.status]));
    assert.deepEqual(bySeq, { 1: "ok", 2: "corrupt", 9: "corrupt", 10: "corrupt" });
    assert.equal(a.load()!.plaintext, "A-one");
  });

  it("refuses to create a store over snapshots whose store.json is gone", () => {
    const dir = tmp();
    const s = EncryptedStore.open({ dir, passphrase: PASS, kdf: KDF });
    s.save("x");
    fs.rmSync(path.join(dir, "store.json"));
    assert.throws(() => EncryptedStore.open({ dir, passphrase: PASS, kdf: KDF }), /ERR_STORE_META_MISSING/);
  });

  it("destroy() removes every file it wrote", () => {
    const dir = tmp();
    const s = EncryptedStore.open({ dir, passphrase: PASS, kdf: KDF });
    s.save("x");
    s.destroy();
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe("environment snapshots", () => {
  /** Builds an environment with real history: a shield, a payment, a pending invoice and a settled-unswept one. */
  async function busyEnvironment() {
    const env = createMultiAssetEnvironment();
    const quai = env.lanes.WQUAI;
    const qi = env.lanes.WQI;
    executeShield(quai, { amount: 12n * ONE, depositor: quai.corporateOperatingAddress!, wrapNative: true });
    const pay = await runCli(["pay", "--recipient", SIM_VENDOR_ADDRESS, "--amount", "3", "--json"], quai);
    assert.equal(pay.exitCode, 0, pay.stderr);
    const pending = qi.merchantGateway.createPaymentChallenge("/pending", 2n * ONE, qi.token!.address).invoice;
    qi.relayer.setOnline(false, "held for the test");
    const settledUnswept = await settle(qi, 4n * ONE);
    quai.relayer.setMinGasBalance(3n * ONE);
    return { env, pending, settledUnswept };
  }

  it("captures and restores every lane exactly, keys and notes included", async () => {
    const { env, pending, settledUnswept } = await busyEnvironment();
    const before = captureEnvironment(env);
    const { env: restored, summary, verification } = restoreEnvironment(before, () => createMultiAssetEnvironment());

    assert.ok(verification.ok, JSON.stringify(verification.checks.filter((c) => !c.ok)));
    assert.deepEqual(summary.assets, ["WQUAI", "WQI"]);
    for (const symbol of env.assets) {
      const a = env.lanes[symbol];
      const b = restored.lanes[symbol];
      assert.equal((b.pool as any).merkleTree.root, (a.pool as any).merkleTree.root, `${symbol} root`);
      assert.deepEqual(b.treasuryUTXOs, a.treasuryUTXOs, `${symbol} notes`);
      assert.deepEqual([...(b.merchantGateway as any).invoiceRegistry.entries()], [...(a.merchantGateway as any).invoiceRegistry.entries()], `${symbol} invoices with their payee keys`);
      assert.deepEqual(b.journal!.entries, a.journal!.entries, `${symbol} journal`);
      assert.deepEqual(b.spendTracker!.entries(), a.spendTracker!.entries(), `${symbol} spend log`);
      assert.equal(b.token!.totalSupply(), a.token!.totalSupply(), `${symbol} supply`);
      assert.equal(b.relayer.online, a.relayer.online);
      assert.equal(b.relayer.minGasBalance, a.relayer.minGasBalance);
    }
    assert.equal(restored.lanes.WQI.relayer.online, false);
    assert.equal(restored.lanes.WQI.relayer.offlineReason, "held for the test");
    assert.equal(restored.lanes.WQUAI.relayer.minGasBalance, 3n * ONE);
    // the same state must serialize to the same bytes: nothing was lost or invented on the way through
    assert.equal(JSON.parse(captureEnvironment(restored, new Date(0))).digest, JSON.parse(captureEnvironment(env, new Date(0))).digest);
    assert.ok((restored.lanes.WQI.merchantGateway as any).invoiceRegistry.get(pending.invoiceId));
    assert.equal((restored.lanes.WQI.merchantGateway as any).invoiceRegistry.get(settledUnswept.invoiceId).status, "SETTLED");
  });

  it("the restored environment WORKS: spend a restored note, sweep a restored payee key, keep the cap and solvency", async () => {
    const { env, settledUnswept } = await busyEnvironment();
    const { env: restored } = restoreEnvironment(captureEnvironment(env), () => createMultiAssetEnvironment());
    const quai = restored.lanes.WQUAI;
    const qi = restored.lanes.WQI;

    // a note that came out of the snapshot can be spent, and the daily budget carried over
    const spentBefore = quai.spendTracker!.spent(quai.token!.address);
    assert.equal(spentBefore, 3n * ONE);
    const vendorBefore = quai.token!.balanceOf(SIM_VENDOR_ADDRESS);
    const pay = await runCli(["pay", "--recipient", SIM_VENDOR_ADDRESS, "--amount", "2", "--json"], quai);
    assert.equal(pay.exitCode, 0, pay.stderr);
    assert.equal(quai.token!.balanceOf(SIM_VENDOR_ADDRESS) - vendorBefore, 2n * ONE);
    assert.equal(quai.spendTracker!.spent(quai.token!.address), 5n * ONE);

    // the payee key that came out of the snapshot can move the customer's funds into the pool
    assert.equal(qi.token!.balanceOf(settledUnswept.ephemeralAddress), 4n * ONE);
    qi.relayer.setOnline(true);
    const swept = await qi.merchantGateway.sweeper.sweepAndShield(settledUnswept.invoiceId);
    assert.ok(swept);
    assert.equal(qi.token!.balanceOf(settledUnswept.ephemeralAddress), 0n);
    assert.equal((qi.merchantGateway as any).invoiceRegistry.get(settledUnswept.invoiceId).status, "SWEPT");

    const after = verifyEnvironment(restored);
    assert.ok(after.ok, JSON.stringify(after.checks.filter((c) => !c.ok)));
  });

  it("refuses a snapshot from a different key hierarchy or merchant key", async () => {
    const env = createMultiAssetEnvironment();
    const snap = captureEnvironment(env);
    assert.throws(() => restoreEnvironment(snap, () => createMultiAssetEnvironment({ seed: "another-unrelated-seed-of-sufficient-length-9f3a" })), /ERR_RESTORE_IDENTITY: the corporate key hierarchy differs/);
    assert.throws(() => restoreEnvironment(snap, () => createMultiAssetEnvironment({ merchantKey: "some-other-merchant-master-key-value" })), /ERR_RESTORE_IDENTITY: the merchant master key differs/);
    assert.throws(() => restoreEnvironment(snap, () => createMultiAssetEnvironment({ assets: ["WQUAI"] })), /ERR_RESTORE_ASSETS/);
  });

  it("refuses altered content: a bad digest, and a self-consistent forgery that breaks an invariant", async () => {
    const env = createMultiAssetEnvironment();
    const wrapper = JSON.parse(captureEnvironment(env));

    const flipped = JSON.parse(JSON.stringify(wrapper));
    flipped.body.chain.currentBlockNumber = 1;
    assert.throws(() => restoreEnvironment(JSON.stringify(flipped), () => createMultiAssetEnvironment()), /ERR_RESTORE_DIGEST/);

    // An attacker who also fixes the digest still cannot mint: the balance no longer matches the token supply.
    const body = decode(wrapper.body) as any;
    const acct = [...body.chain.accounts.values()].find((a: any) => (a.tokens.get(env.lanes.WQUAI.token!.address.toLowerCase()) ?? 0n) > 0n);
    acct.tokens.set(env.lanes.WQUAI.token!.address.toLowerCase(), acct.tokens.get(env.lanes.WQUAI.token!.address.toLowerCase()) + 1_000n * ONE);
    const enc = encode(body);
    const forged = JSON.stringify({ digest: JSON.parse(captureEnvironment(env)).digest.replace(/./, "0"), body: enc });
    assert.throws(() => restoreEnvironment(forged, () => createMultiAssetEnvironment()), /ERR_RESTORE_DIGEST/);
    const digest = (await import("node:crypto")).createHash("sha256").update(canonicalJson(enc)).digest("hex");
    assert.throws(() => restoreEnvironment(JSON.stringify({ digest, body: enc }), () => createMultiAssetEnvironment()), /ERR_RESTORE_VERIFICATION.*R-06\/WQUAI|ERR_RESTORE_VERIFICATION.*R-03\/WQUAI/);
  });

  it("verifyEnvironment() flags a corrupted tree and an unreconciled journal on live state", async () => {
    const env = createMultiAssetEnvironment();
    assert.ok(verifyEnvironment(env).ok);
    (env.lanes.WQUAI.pool as any).merkleTree.leaves[0] = 12345n;
    const report = verifyEnvironment(env);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.id === "R-01/WQUAI" && !c.ok));
  });
});

describe("persistence manager", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("autosaves once after a burst of changes, and recovery brings back the latest state", async () => {
    const dir = tmp();
    const env = createMultiAssetEnvironment();
    const m = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 60 });
    m.attach(() => env);
    executeShield(env.lanes.WQUAI, { amount: 5n * ONE, depositor: env.lanes.WQUAI.corporateOperatingAddress!, wrapNative: true });
    m.notifyChange();
    m.notifyChange();
    m.notifyChange();
    assert.equal(m.status().dirty, true);
    assert.equal(m.status().snapshots.length, 0, "nothing is written until the debounce window passes");
    await sleep(400);
    assert.equal(m.status().snapshots.length, 1, "a burst of changes is one snapshot");
    assert.equal(m.status().dirty, false);

    const m2 = PersistenceManager.open({ dir, passphrase: PASS });
    const rec = m2.recover(() => createMultiAssetEnvironment())!;
    assert.equal(rec.info.seq, 1);
    assert.equal(rec.env.lanes.WQUAI.treasuryUTXOs.length, env.lanes.WQUAI.treasuryUTXOs.length);
    assert.equal((rec.env.lanes.WQUAI.pool as any).merkleTree.root, (env.lanes.WQUAI.pool as any).merkleTree.root);
    await m.close();
    await m2.close();
  });

  it("recover() walks back past a corrupt newest snapshot and reports it; a fresh store recovers nothing", async () => {
    const dir = tmp();
    const env = createMultiAssetEnvironment();
    const m = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 0 });
    assert.equal(m.recover(() => createMultiAssetEnvironment()), null);
    await m.save(env);
    executeShield(env.lanes.WQUAI, { amount: 1n * ONE, depositor: env.lanes.WQUAI.corporateOperatingAddress!, wrapNative: true });
    const newest = await m.save(env);
    fs.writeFileSync(path.join(dir, newest.file), "{ not json");
    const rec = m.recover(() => createMultiAssetEnvironment())!;
    assert.equal(rec.info.seq, 1);
    assert.deepEqual(rec.skipped.map((s) => s.seq), [2]);
    await m.close();
  });

  it("a failed save is remembered in status and never throws out of notifyChange/flush", async () => {
    const dir = tmp();
    const env = createMultiAssetEnvironment();
    const m = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 30 });
    m.attach(() => env);
    let error: Error | null = null;
    m.onSaved = (_info, err) => { error = err; };
    fs.rmSync(dir, { recursive: true, force: true }); // the disk goes away underneath it
    m.notifyChange();
    await sleep(300);
    assert.ok(error, "the failure is reported through onSaved");
    assert.ok(m.status().lastError);
  });
});
