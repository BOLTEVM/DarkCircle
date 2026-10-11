/**
 * DarkCircle admin console: the HTTP surface
 * File: test/admin/console_api.test.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (this whole directory is removed by scripts/redact-admin.ts).
 *
 * Covers: no trace when the console is off, session gating, the persistence flow end to end (including the
 * typed confirmations), relayer control as seen through the ordinary API, and that no secret ever appears in
 * a response body or the audit log.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApiServer, type RunningApi } from "../../src/api/server.ts";

const TOKEN = "an-admin-token-that-is-long-enough-42";
const PASS = "correct horse battery staple";
const KDF = { N: 1 << 12, r: 8, p: 1 };
const RECIPIENT = "0x0054328ef0070fceeea0a22bb01fa5f6614098ef";
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-console-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

interface Reply { status: number; json: any; text: string; type: string | null }
async function call(api: RunningApi, method: "GET" | "POST", url: string, opts: { body?: unknown; admin?: string; session?: boolean } = {}): Promise<Reply> {
  const res = await fetch(api.url.replace(/\/$/, "") + url, {
    method,
    headers: {
      ...(opts.session === false ? {} : { "X-DarkCircle-Session": api.token }),
      ...(opts.admin ? { "X-DarkCircle-Admin": opts.admin } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, type: res.headers.get("content-type") };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("condition not met in time");
}

describe("console switched off", () => {
  let api: RunningApi;
  before(async () => { api = await startApiServer({ port: 0 }); });
  after(async () => { await api.close(); });

  it("leaves no trace: the admin routes and assets do not exist", async () => {
    assert.equal(api.admin, null);
    for (const [method, url] of [["GET", "/api/admin/ping"], ["POST", "/api/admin/login"], ["GET", "/api/admin/overview"]] as const) {
      const r = await call(api, method, url, { body: method === "POST" ? { token: TOKEN } : undefined });
      assert.equal(r.status, 404, `${method} ${url}`);
      assert.equal(r.json.error.code, "NOT_FOUND");
    }
    assert.equal((await call(api, "GET", "/admin/admin.js", { session: false })).status, 404);
    assert.equal((await call(api, "GET", "/admin/admin.css", { session: false })).status, 404);
  });
});

describe("console switched on", () => {
  let api: RunningApi;
  let auditFile: string;
  let dataDir: string;
  let admin: string;
  const seenBodies: string[] = [];

  const A = async (method: "GET" | "POST", url: string, body?: unknown, sessionId: string | undefined = admin) => {
    const r = await call(api, method, url, { body, admin: sessionId });
    seenBodies.push(r.text);
    return r;
  };

  before(async () => {
    auditFile = path.join(tmp(), "audit.log");
    dataDir = path.join(tmp(), "store");
    api = await startApiServer({ port: 0, admin: { token: TOKEN, auditLogFile: auditFile, defaultDataDir: dataDir, buildDir: path.join(tmp(), "build"), kdf: KDF, auth: { lockoutMs: 250, maxFailures: 5 } } });
    const login = await call(api, "POST", "/api/admin/login", { body: { token: TOKEN } });
    assert.equal(login.status, 200, login.text);
    admin = login.json.session;
  });
  after(async () => { await api.close(); });

  it("ping is open, login needs the right token, and everything else needs an admin session", async () => {
    const ping = await call(api, "GET", "/api/admin/ping");
    assert.equal(ping.status, 200);
    assert.deepEqual(Object.keys(ping.json).sort(), ["enabled", "tokenSource"]);
    assert.ok(!ping.text.includes(TOKEN));

    assert.equal((await call(api, "GET", "/api/admin/overview")).status, 401, "no admin session");
    assert.equal((await call(api, "GET", "/api/admin/overview", { admin: "0".repeat(64) })).status, 401, "made-up admin session");
    assert.equal((await call(api, "GET", "/api/admin/overview", { admin: api.token })).status, 401, "the UI session token is not an admin session");
    const overview = await A("GET", "/api/admin/overview");
    assert.equal(overview.status, 200);
    assert.equal(overview.json.persistence.enabled, false);
    assert.equal(overview.json.relayers.length, 2);
  });

  it("the admin API is still behind the ordinary UI session and same-origin rules", async () => {
    const noSession = await call(api, "GET", "/api/admin/ping", { session: false });
    assert.equal(noSession.status, 401);
    const res = await fetch(api.url + "api/admin/login", {
      method: "POST",
      headers: { "X-DarkCircle-Session": api.token, "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ token: TOKEN })
    });
    assert.equal(res.status, 403, "a cross-site page cannot even attempt a login");
  });

  it("serves its own script and stylesheet without leaking the token or a session", async () => {
    // the assets are written later in the build; the route must at least never echo secrets
    for (const url of ["/admin/admin.js", "/admin/admin.css"]) {
      const r = await call(api, "GET", url, { session: false });
      assert.ok(r.status === 200 || r.status === 404);
      assert.ok(!r.text.includes(TOKEN));
      assert.ok(!r.text.includes(admin));
    }
    const index = await call(api, "GET", "/", { session: false });
    assert.ok(!index.text.includes(TOKEN));
  });

  it("persistence: a weak passphrase is refused, a good one creates the store and saves the current state", async () => {
    assert.equal((await A("GET", "/api/admin/persistence")).json.status.enabled, false);
    const weak = await A("POST", "/api/admin/persistence/enable", { passphrase: "short" });
    assert.equal(weak.status, 422);
    assert.match(weak.json.error.message, /ERR_STORE_WEAK_PASSPHRASE/);

    const enabled = await A("POST", "/api/admin/persistence/enable", { passphrase: PASS });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.status.enabled, true);
    assert.equal(enabled.json.status.snapshots.length, 1, "a new store starts with the current state saved");
    assert.equal(path.resolve(enabled.json.status.dir), path.resolve(dataDir));
    assert.equal((await A("POST", "/api/admin/persistence/enable", { passphrase: PASS })).status, 409, "cannot enable twice");

    const status = await call(api, "GET", "/api/status");
    assert.equal(status.json.persistence.enabled, true);
  });

  it("persistence: autosave follows a payment, scan and verify are clean, save adds a snapshot", async () => {
    const shield = await call(api, "POST", "/api/shield", { body: { amount: "6", token: "WQUAI", wrapNative: true, acknowledged: true } });
    assert.equal(shield.status, 200, shield.text);
    await until(async () => (await A("GET", "/api/admin/persistence")).json.status.snapshots.length === 2);

    const scan = await A("POST", "/api/admin/persistence/scan", {});
    assert.equal(scan.json.corrupt, 0);
    assert.equal(scan.json.entries.length, 2);
    const verify = await A("POST", "/api/admin/persistence/verify", {});
    assert.equal(verify.json.ok, true);
    assert.ok(verify.json.checks.length >= 10);
    const saved = await A("POST", "/api/admin/persistence/save", {});
    assert.equal(saved.json.info.seq, 3);
    const inspect = await A("POST", "/api/admin/persistence/inspect", {});
    assert.equal(inspect.json.summary.lanes.WQUAI.leaves, 2);
  });

  it("persistence: restore replaces the running state only with the typed confirmation", async () => {
    const before = (await call(api, "GET", "/api/status?asset=WQUAI")).json.balances.shielded;
    assert.equal(before, "106.0");
    const reset = await call(api, "POST", "/api/reset", { body: { confirm: "RESET" } });
    assert.equal(reset.json.preservedSnapshot.seq, 4, "the state being discarded was saved and pinned first");
    assert.equal((await call(api, "GET", "/api/status?asset=WQUAI")).json.balances.shielded, "100.0");

    assert.equal((await A("POST", "/api/admin/persistence/restore", {})).status, 400);
    assert.equal((await A("POST", "/api/admin/persistence/restore", { confirm: "yes" })).status, 400);
    assert.equal((await call(api, "GET", "/api/status?asset=WQUAI")).json.balances.shielded, "100.0", "refused restores change nothing");

    // the reset pinned the pre-reset state as snapshot 4 and was autosaved after (5); ask for snapshot 3, the one with the 6 tokens
    const restored = await A("POST", "/api/admin/persistence/restore", { confirm: "RESTORE", seq: 3 });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.info.seq, 3);
    assert.ok(restored.json.checks.every((c: any) => c.ok || !c.fatal));
    assert.equal((await call(api, "GET", "/api/status?asset=WQUAI")).json.balances.shielded, "106.0");
    assert.equal((await call(api, "GET", "/api/status")).json.persistence.recovery.seq, 3);
  });

  it("persistence: wiping needs the exact store id, and afterwards nothing is on disk or running", async () => {
    const before = await A("GET", "/api/admin/persistence");
    const id = before.json.status.storeId;
    const wrong = await A("POST", "/api/admin/persistence/wipe", { confirm: "WIPE" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error.message, new RegExp(`WIPE ${id}`));
    assert.ok(fs.existsSync(path.join(dataDir, "store.json")), "a refused wipe deletes nothing");

    const disabled = await A("POST", "/api/admin/persistence/disable", {});
    assert.equal(disabled.json.status.enabled, false);
    assert.ok(fs.existsSync(path.join(dataDir, "store.json")), "disable keeps the files");

    // re-enabling over existing snapshots must ask what to do
    const ask = await A("POST", "/api/admin/persistence/enable", { passphrase: PASS });
    assert.equal(ask.status, 409);
    assert.equal(ask.json.error.code, "MODE_REQUIRED");
    assert.ok(ask.json.error.snapshots >= 3);
    const wrongPass = await A("POST", "/api/admin/persistence/enable", { passphrase: "a completely different one", mode: "restore" });
    assert.equal(wrongPass.status, 422);
    assert.match(wrongPass.json.error.message, /ERR_STORE_WRONG_PASSPHRASE/);

    const again = await A("POST", "/api/admin/persistence/enable", { passphrase: PASS, mode: "restore" });
    assert.equal(again.status, 200, again.text);
    const wiped = await A("POST", "/api/admin/persistence/wipe", { confirm: `WIPE ${id}` });
    assert.equal(wiped.status, 200, wiped.text);
    assert.deepEqual(fs.readdirSync(dataDir), []);
    assert.equal((await call(api, "GET", "/api/status")).json.persistence.enabled, false);
  });

  it("relayer: offline stops payments everywhere with a clear reason, online restores them, settings apply", async () => {
    const off = await A("POST", "/api/admin/relayer", { asset: "WQUAI", online: false, reason: "rotating the key" });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.relayers.find((r: any) => r.symbol === "WQUAI").online, false);
    assert.equal(off.json.relayers.find((r: any) => r.symbol === "WQI").online, true, "only the named pool's relayer changes");

    const cl = await call(api, "POST", "/api/checklist", { body: { kind: "unshield", address: RECIPIENT, amount: "1", token: "WQUAI" } });
    assert.equal(cl.json.canProceed, false);
    assert.equal(cl.json.items.find((i: any) => i.id === "SP-EX-04").status, "fail");
    const pay = await call(api, "POST", "/api/pay", { body: { address: RECIPIENT, amount: "1", token: "WQUAI", acknowledged: true } });
    assert.equal(pay.status, 422);
    assert.equal(pay.json.error.code, "CHECKLIST_BLOCKED", "the server-side gate stops it before anything is attempted");
    const wqi = await call(api, "POST", "/api/pay", { body: { address: RECIPIENT, amount: "1", token: "WQI", acknowledged: true } });
    assert.equal(wqi.status, 200, "the other pool is unaffected");

    await A("POST", "/api/admin/relayer", { asset: "WQUAI", online: true });
    assert.equal((await call(api, "POST", "/api/pay", { body: { address: RECIPIENT, amount: "1", token: "WQUAI", acknowledged: true } })).status, 200);

    const fee = await A("POST", "/api/admin/relayer", { asset: "WQUAI", minimumFee: "0.75", minGasBalance: "2.5" });
    assert.equal(fee.status, 200, fee.text);
    const row = fee.json.relayers.find((r: any) => r.symbol === "WQUAI");
    assert.equal(row.minimumFee, "0.75");
    assert.equal(row.minGasBalance, "2.5");
    assert.equal((await call(api, "GET", "/api/status?asset=WQUAI")).json.relayer.minimumFee, "0.75");
  });

  it("relayer: bad input is refused and changes nothing", async () => {
    for (const body of [{ asset: "WQUAI", minimumFee: "-1" }, { asset: "WQUAI", minimumFee: "abc" }, { asset: "WQUAI", minimumFee: "9999" }, { asset: "NOPE", online: false }, { asset: "WQUAI" }, { asset: "WQUAI", minGasBalance: "1.0.0" }]) {
      const r = await A("POST", "/api/admin/relayer", body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await A("GET", "/api/admin/relayer")).json.relayers.find((r: any) => r.symbol === "WQUAI").minimumFee, "0.75");
  });

  it("environment report lists the toolchain and what the pipeline can do", async () => {
    const r = await A("GET", "/api/admin/environment");
    assert.equal(r.status, 200);
    assert.ok(r.json.tools.some((t: any) => t.id === "node" && t.ok));
    assert.equal(typeof r.json.can.compileCircuit, "boolean");
    assert.ok(r.json.machine.cpus >= 1);
  });

  it("failed logins are throttled and locked, then the lock clears", async () => {
    const attempts = [];
    for (let i = 0; i < 5; i++) attempts.push((await call(api, "POST", "/api/admin/login", { body: { token: "wrong-token-wrong-token-wrong" } })).status);
    assert.deepEqual(attempts, [401, 401, 401, 401, 429]);
    const locked = await call(api, "POST", "/api/admin/login", { body: { token: TOKEN } });
    assert.equal(locked.status, 429, "even the right token is refused during a lockout");
    assert.ok(locked.json.error.retryAfterMs > 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await call(api, "POST", "/api/admin/login", { body: { token: TOKEN } })).status, 200);
  });

  it("logout kills the session", async () => {
    const s = (await call(api, "POST", "/api/admin/login", { body: { token: TOKEN } })).json.session;
    assert.equal((await call(api, "GET", "/api/admin/overview", { admin: s })).status, 200);
    assert.equal((await call(api, "POST", "/api/admin/logout", { body: {}, admin: s })).status, 200);
    assert.equal((await call(api, "GET", "/api/admin/overview", { admin: s })).status, 401);
  });

  it("the audit log recorded every action in order, verifies, and holds no secret", async () => {
    const r = await A("GET", "/api/admin/audit");
    assert.equal(r.json.verification.ok, true);
    const actions = r.json.entries.map((e: any) => e.action).reverse();
    for (const expected of ["admin.start", "admin.login", "persistence.enable", "persistence.save", "persistence.restore", "persistence.wipe", "relayer.update", "environment.check"]) {
      assert.ok(actions.includes(expected), `missing ${expected} in ${actions.join(",")}`);
    }
    assert.ok(r.json.entries.some((e: any) => e.action === "admin.login" && e.outcome === "denied"), "failed logins are logged");
    assert.ok(r.json.entries.some((e: any) => e.action === "persistence.wipe" && e.outcome === "denied"), "a refused wipe is logged");

    const disk = fs.readFileSync(auditFile, "utf8");
    for (const secret of [PASS, TOKEN, admin]) {
      assert.ok(!disk.includes(secret), "the audit file must not hold a secret");
      for (const body of seenBodies) assert.ok(!body.includes(secret), "no admin response may echo a secret");
    }
  });
});
