/**
 * DarkCircle admin console: authentication and the tamper-evident action log
 * File: test/admin/auth_audit.test.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (this whole directory is removed by scripts/redact-admin.ts).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminAuth, MIN_ADMIN_TOKEN_LENGTH } from "../../src/admin/auth.ts";
import { AdminAuditLog, scrub } from "../../src/admin/auditLog.ts";

const TOKEN = "a-sufficiently-long-admin-token-1234";
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dc-admin-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("AdminAuth", () => {
  it("refuses a weak configured token and generates a strong one when none is given", () => {
    assert.throws(() => new AdminAuth({ token: "short" }), /ERR_ADMIN_TOKEN_WEAK/);
    const saved = process.env.DARKCIRCLE_ADMIN_TOKEN;
    delete process.env.DARKCIRCLE_ADMIN_TOKEN;
    try {
      const a = new AdminAuth();
      assert.equal(a.generated, true);
      assert.ok(a.token.length >= MIN_ADMIN_TOKEN_LENGTH);
      assert.notEqual(new AdminAuth().token, a.token, "each run gets its own token");
    } finally {
      if (saved !== undefined) process.env.DARKCIRCLE_ADMIN_TOKEN = saved;
    }
    assert.equal(new AdminAuth({ token: TOKEN }).generated, false);
  });

  it("exchanges the right token for a session and rejects anything else", () => {
    const a = new AdminAuth({ token: TOKEN, maxFailures: 1000 }); // the lockout has its own test below
    for (const bad of ["", "nope", TOKEN + "x", TOKEN.slice(1), undefined, null, 7, {}, [TOKEN]]) {
      const r = a.login(bad);
      assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    }
    const ok = a.login(TOKEN);
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.session.length, 64);
      assert.ok(a.verify(ok.session));
      assert.equal(a.verify(ok.session.replace(/./, "0")), null);
      assert.equal(a.verify("short"), null);
      assert.equal(a.verify(undefined), null);
      assert.equal(a.logout(ok.session), true);
      assert.equal(a.verify(ok.session), null, "a logged-out session is dead");
    }
  });

  it("locks logins out after repeated failures, doubles the lockout, and refuses even the right token while locked", () => {
    const c = clock();
    const a = new AdminAuth({ token: TOKEN, now: c.now, maxFailures: 3, lockoutMs: 1000, maxLockoutMs: 10_000 });
    for (let i = 0; i < 2; i++) assert.deepEqual(a.login("x"), { ok: false, reason: "BAD_TOKEN" });
    const third = a.login("x");
    assert.deepEqual(third, { ok: false, reason: "LOCKED", retryAfterMs: 1000 });
    assert.equal(a.login(TOKEN).ok, false, "the correct token must not get through during a lockout");
    c.advance(1001);
    for (let i = 0; i < 2; i++) a.login("x");
    const second = a.login("x");
    assert.deepEqual(second, { ok: false, reason: "LOCKED", retryAfterMs: 2000 }, "the lockout doubles");
    c.advance(2001);
    assert.ok(a.login(TOKEN).ok, "the right token works once the lockout has passed");
    // success resets the counters
    for (let i = 0; i < 2; i++) a.login("x");
    assert.deepEqual(a.login("x"), { ok: false, reason: "LOCKED", retryAfterMs: 1000 });
  });

  it("expires a session after the idle window and the absolute window, and slides on use", () => {
    const c = clock();
    const a = new AdminAuth({ token: TOKEN, now: c.now, idleMs: 1000, absoluteMs: 2500 });
    const s = a.login(TOKEN);
    assert.ok(s.ok);
    const id = (s as { session: string }).session;
    c.advance(900);
    assert.ok(a.verify(id), "still inside the idle window");
    c.advance(900);
    assert.ok(a.verify(id), "use slid the idle window");
    c.advance(900);
    assert.equal(a.verify(id), null, "past the absolute window (2500 ms since login) even though it was used");
    const s2 = a.login(TOKEN) as { ok: true; session: string };
    c.advance(1001);
    assert.equal(a.verify(s2.session), null, "idle expiry");
  });

  it("keeps at most eight sessions, dropping the least recently used", () => {
    const c = clock();
    const a = new AdminAuth({ token: TOKEN, now: c.now });
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      c.advance(10);
      ids.push((a.login(TOKEN) as { ok: true; session: string }).session);
    }
    assert.equal(a.activeSessions, 8);
    assert.equal(a.verify(ids[0]), null, "the oldest was dropped");
    assert.ok(a.verify(ids[8]));
  });
});

describe("AdminAuditLog", () => {
  it("chains entries and verifies", () => {
    const log = new AdminAuditLog();
    log.append("a", "ok", "one");
    log.append("b", "denied", "two");
    log.append("c", "error", "three");
    assert.equal(log.size, 3);
    assert.deepEqual(log.verify(), { ok: true, entries: 3 });
    const [c, b, a] = log.entries();
    assert.equal(a.prevHash, "0".repeat(64));
    assert.equal(b.prevHash, a.hash);
    assert.equal(c.prevHash, b.hash);
    assert.deepEqual(log.entries(2).map((e) => e.action), ["c", "b"], "newest first");
  });

  it("detects an edited line, a deleted line and a reordered pair in the file, and names where it broke", () => {
    const file = path.join(tmp(), "audit.log");
    const log = new AdminAuditLog(file);
    for (let i = 1; i <= 5; i++) log.append(`act${i}`, "ok", `detail ${i}`);
    assert.equal(new AdminAuditLog(file).loadedTampered, false);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");

    const edited = [...lines];
    edited[2] = edited[2].replace("act3", "act9");
    fs.writeFileSync(file, edited.join("\n") + "\n");
    let reloaded = new AdminAuditLog(file);
    assert.equal(reloaded.loadedTampered, true);
    assert.equal(reloaded.verify().brokenAt, 3);

    fs.writeFileSync(file, [...lines.slice(0, 1), ...lines.slice(2)].join("\n") + "\n");
    reloaded = new AdminAuditLog(file);
    assert.equal(reloaded.loadedTampered, true);
    assert.equal(reloaded.verify().ok, false);

    fs.writeFileSync(file, [lines[0], lines[2], lines[1], ...lines.slice(3)].join("\n") + "\n");
    assert.equal(new AdminAuditLog(file).verify().ok, false);

    fs.writeFileSync(file, lines.join("\n") + "\n");
    assert.equal(new AdminAuditLog(file).verify().ok, true, "the untouched file is fine");
  });

  it("continues the chain across a restart", () => {
    const file = path.join(tmp(), "audit.log");
    new AdminAuditLog(file).append("first", "ok");
    const again = new AdminAuditLog(file);
    again.append("second", "ok");
    assert.equal(again.verify().ok, true);
    assert.equal(new AdminAuditLog(file).size, 2);
  });

  it("scrubs secrets before they are written, so the plain-text log cannot leak them", () => {
    const key = "0x" + "ab".repeat(32);
    const bare = "cd".repeat(32);
    const file = path.join(tmp(), "audit.log");
    const log = new AdminAuditLog(file);
    log.append("x", "ok", `key ${key} and ${bare}; passphrase=hunter2hunter2 token: sekrit`);
    const text = fs.readFileSync(file, "utf8");
    for (const secret of [key, bare, "hunter2hunter2", "sekrit", "ab".repeat(32)]) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.ok(scrub("line one\nline two").indexOf("\n") < 0, "newlines cannot forge extra log lines");
    assert.ok(scrub("x".repeat(5000)).length <= 400);
  });
});
