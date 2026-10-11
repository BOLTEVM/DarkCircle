/**
 * DarkCircle: API server with durable state
 * File: test/unit/api_persistence.test.ts
 *
 * Restart safety as the operator experiences it: do something through the API, stop the server, start a new
 * one on the same directory, and the state is back; a store that belongs to other keys stops the server
 * instead of being overwritten.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApiServer, type RunningApi } from "../../src/api/server.ts";
import { PersistenceManager } from "../../src/persistence/manager.ts";
import { createMultiAssetEnvironment } from "../../src/cli/context.ts";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const PASS = "correct horse battery staple";
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-api-persist-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const call = async (api: RunningApi, method: "GET" | "POST", url: string, body?: unknown) => {
  const res = await fetch(api.url.replace(/\/$/, "") + url, {
    method,
    headers: { "X-DarkCircle-Session": api.token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: (await res.json()) as any };
};

async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("condition not met in time");
}

describe("API with persistence", () => {
  it("saves after a state-changing action, and a new server on the same directory comes back with it", async () => {
    const dir = tmp();
    const m1 = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 40 });
    const api1 = await startApiServer({ port: 0, persistence: m1 });
    assert.equal(api1.state.recovery, null, "a brand-new store restores nothing");

    const before = (await call(api1, "GET", "/api/status")).json;
    assert.equal(before.persistence.enabled, true);
    assert.equal(before.persistence.snapshots, 0, "reading does not write");

    const shield = await call(api1, "POST", "/api/shield", { amount: "7", token: "WQUAI", wrapNative: true, acknowledged: true });
    assert.equal(shield.status, 200, JSON.stringify(shield.json));
    await until(async () => (await call(api1, "GET", "/api/status")).json.persistence.snapshots === 1);
    const shielded = (await call(api1, "GET", "/api/status?asset=WQUAI")).json.balances.shielded;
    assert.equal(shielded, "107.0");
    await api1.close();

    const m2 = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 40 });
    const api2 = await startApiServer({ port: 0, persistence: m2 });
    try {
      assert.equal(api2.state.recovery?.seq, 1);
      const after = (await call(api2, "GET", "/api/status?asset=WQUAI")).json;
      assert.equal(after.balances.shielded, "107.0", "the shielded balance survived the restart");
      assert.equal(after.persistence.recovery.seq, 1);
      assert.equal(after.pool.solvent, true);
      // and the restored server still transacts
      const pay = await call(api2, "POST", "/api/pay", { address: "0x0054328ef0070fceeea0a22bb01fa5f6614098ef", amount: "1", token: "WQUAI", acknowledged: true });
      assert.equal(pay.status, 200, JSON.stringify(pay.json));
    } finally {
      await api2.close();
    }
  });

  it("refuses to start over a store that belongs to a different key hierarchy", async () => {
    const dir = tmp();
    const other = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 0 });
    await other.save(createMultiAssetEnvironment({ seed: "some-other-treasury-seed-with-plenty-of-entropy-77" }));
    await other.close();

    const m = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 0 });
    await assert.rejects(startApiServer({ port: 0, persistence: m }), /ERR_RESTORE_IDENTITY/);
    assert.equal(m.status().snapshots.length, 1, "the foreign snapshot must still be there, untouched");
  });

  it("reset pins the state it discards, so that history survives retention and can be restored", async () => {
    const dir = tmp();
    const m = PersistenceManager.open({ dir, passphrase: PASS, kdf: KDF, autosaveDebounceMs: 40, keep: 2 });
    const api = await startApiServer({ port: 0, persistence: m });
    try {
      await call(api, "POST", "/api/shield", { amount: "3", token: "WQUAI", wrapNative: true, acknowledged: true });
      await until(() => m.status().snapshots.length === 1);
      assert.equal((await call(api, "POST", "/api/reset", {})).status, 400, "no typed confirmation, no reset");
      const reset = await call(api, "POST", "/api/reset", { confirm: "RESET" });
      assert.equal(reset.status, 200);
      const pinnedSeq = reset.json.preservedSnapshot.seq;
      assert.equal((await call(api, "GET", "/api/status?asset=WQUAI")).json.balances.shielded, "100.0");

      // several saves later, far past keep=2, the pinned pre-reset state is still there and still readable
      for (let i = 0; i < 4; i++) await m.save(api.state.env);
      const snaps = m.status().snapshots;
      const pinned = snaps.find((s) => s.seq === pinnedSeq)!;
      assert.ok(pinned && pinned.pinned, "retention must never delete a pinned snapshot");
      assert.equal(snaps.filter((s) => !s.pinned).length, 2, "the unpinned ones are still pruned to keep=2");
      assert.equal(m.inspect(pinnedSeq)!.summary.lanes.WQUAI.notes, 2, "it holds the discarded state: the treasury note and the 3-token shield");
    } finally {
      await api.close();
    }
  });

  it("a server without persistence reports it as off and touches no disk", async () => {
    const api = await startApiServer({ port: 0 });
    try {
      assert.deepEqual((await call(api, "GET", "/api/status")).json.persistence, { enabled: false });
    } finally {
      await api.close();
    }
  });
});
