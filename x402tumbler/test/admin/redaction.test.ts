/**
 * DarkCircle admin console: redaction before a production release
 * File: test/admin/redaction.test.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (this whole directory is removed by scripts/redact-admin.ts).
 *
 * "Will be redacted before production release" is only a promise until it is exercised. This test copies the
 * tree, redacts the copy, and holds the result to the standard the release has to meet: nothing of the console
 * left anywhere (code, UI, scripts, package.json, docs), the project still type-checks, and the suites that
 * cover what production keeps still pass.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyRedaction, findResidue, planRedaction } from "../../scripts/redact-admin.ts";

const PROJECT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(PROJECT, "scripts", "redact-admin.ts");
const SKIP = new Set(["node_modules", "build", ".git", ".darkcircle-data", ".darkcircle-admin", ".darkcircle-voice", "dist"]);

let root = "";
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-redact-"));
  fs.cpSync(PROJECT, root, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  // the copy shares the installed dependencies instead of duplicating them
  fs.symlinkSync(path.join(PROJECT, "node_modules"), path.join(root, "node_modules"), "junction");
});
after(() => {
  // Detach the node_modules junction first, and never recurse if that failed: following it would delete the real dependencies.
  const link = path.join(root, "node_modules");
  try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* fall through to the check below */ } }
  if (fs.existsSync(link)) return;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

describe("redacting the admin console", () => {
  it("the unredacted tree has plenty to remove, and --check says so", () => {
    const residue = findResidue(root);
    assert.ok(residue.length > 10, `expected many traces, found ${residue.length}`);
    const plan = planRedaction(root);
    assert.deepEqual(plan.removePaths.sort(), ["docs/ADMIN_CONSOLE.md", "src/admin", "test/admin", "ui/admin"]);
    const edited = plan.editedFiles.map((f) => f.file).sort();
    for (const f of ["src/api/server.ts", "ui/app.js", "ui/index.html", "scripts/serve-ui.ts", "README.md", "AUDIT.md"]) assert.ok(edited.includes(f), `${f} should have fenced blocks`);
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, "--check", "--root", root], { stdio: "pipe" });
    } catch (e: any) {
      status = e.status;
      assert.match(String(e.stderr), /still present/);
    }
    assert.equal(status, 1, "--check must fail on an unredacted tree");
  });

  it("refuses to run destructively without --yes, and changes nothing", () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, "--root", root], { stdio: "pipe" });
    } catch (e: any) {
      status = e.status;
      assert.match(String(e.stderr), /--yes/);
    }
    assert.equal(status, 1);
    assert.ok(exists("src/admin/index.ts"), "nothing may be deleted without --yes");
  });

  it("redacts the copy and leaves no trace anywhere", () => {
    applyRedaction(root);
    assert.deepEqual(findResidue(root), []);
    for (const gone of ["src/admin", "ui/admin", "test/admin", "docs/ADMIN_CONSOLE.md", "scripts/redact-admin.ts"]) assert.equal(exists(gone), false, `${gone} should be gone`);

    // the project's own checker agrees (run from the real tree, pointed at the copy)
    const out = execFileSync(process.execPath, [SCRIPT, "--check", "--root", root], { encoding: "utf8" });
    assert.match(out, /clean/);

    const everything = walk(root).filter((f) => /\.(ts|js|mjs|html|css|md|json)$/.test(f));
    for (const f of everything) {
      const text = fs.readFileSync(f, "utf8");
      for (const needle of ["@admin:", "/api/admin", "x-darkcircle-admin", "DARKCIRCLE_ADMIN", "darkcircle-admin"]) assert.ok(!text.includes(needle), `${path.relative(root, f)} still contains ${needle}`);
    }
    // prose too: the documentation must not describe a console that no longer exists
    for (const doc of ["README.md", "AUDIT.md", "docs/SHIELDED_POOL_CHECKLIST.md"]) assert.doesNotMatch(read(doc), /admin console/i, `${doc} still talks about the admin console`);
  });

  it("the redacted tree serves no console: the page, the script and the server have no hook", () => {
    assert.ok(!read("ui/index.html").includes("admin"), "the page must not mention it");
    assert.ok(!read("ui/app.js").includes("/admin/"), "the UI must not try to load it");
    const server = read("src/api/server.ts");
    assert.doesNotMatch(server, /admin/i);
    assert.doesNotMatch(read("scripts/serve-ui.ts"), /admin/i);
    const pkg = JSON.parse(read("package.json"));
    assert.deepEqual(Object.keys(pkg.scripts).filter((k) => /admin/i.test(k) || /admin/i.test(pkg.scripts[k])), []);
    assert.doesNotMatch(pkg.scripts.test, /test\/admin/);
  });

  it("keeps what production needs", () => {
    for (const kept of ["src/persistence/store.ts", "src/persistence/snapshot.ts", "src/persistence/manager.ts", "src/proxy/spendTracker.ts", "circuits/unshield.circom", "contracts/DarkCirclePool.sol", "ui/theme.js", "ui/app.js", "docs/SHIELDED_POOL_CHECKLIST.md", "ui/wallet.js", "ui/agent.js", "src/agent/agent.ts", "src/voice/transcriber.ts", "scripts/whisper_worker.py"]) assert.ok(exists(kept), `${kept} must survive redaction`);
    assert.match(read("src/sim/relayerNetwork.ts"), /ERR_RELAYER_OFFLINE/);
    assert.match(read("src/checklist/shieldedTx.ts"), /SP-EX-04/);
    // the voice agent ships: its page, its wallet bridge and its routes outlive the console that used to own the wallet code
    assert.match(read("ui/index.html"), /data-route="agent"/);
    assert.match(read("ui/app.js"), /mountAgent/);
    assert.match(read("src/api/server.ts"), /\/api\/voice\/transcribe/);
  });

  it("is idempotent: redacting again changes nothing", () => {
    const before = walk(root).map((f) => [f, fs.readFileSync(f, "utf8")]);
    const plan = planRedaction(root);
    assert.deepEqual(plan.removePaths, []);
    assert.deepEqual(plan.editedFiles, []);
    applyRedaction(root, { keepTool: true });
    assert.deepEqual(walk(root).map((f) => [f, fs.readFileSync(f, "utf8")]), before);
  });

  it("the redacted project still type-checks", { timeout: 300_000 }, () => {
    const tsc = path.join(PROJECT, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "--noEmit", "-p", path.join(root, "tsconfig.json")], { cwd: root, stdio: "pipe" });
  });

  it("and the suites for what production keeps still pass against it", { timeout: 600_000 }, () => {
    const files = ["test/unit/api_checklist.test.ts", "test/unit/api_persistence.test.ts", "test/unit/relayer_control.test.ts", "test/unit/agent.test.ts", "test/unit/agent_api.test.ts"];
    // A nested `node --test` that inherits NODE_TEST_CONTEXT believes it is a test file of the parent runner and prints nothing.
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;
    const out = execFileSync(process.execPath, ["--test", ...files], { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024, env: cleanEnv });
    assert.match(out, /(?:ℹ|#) fail 0\b/);
    assert.match(out, /(?:ℹ|#) tests [1-9]\d*\b/);
  });
});
