/**
 * DarkCircle Protocol: local API, UI serving and checklist tests
 * File: test/unit/api_checklist.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { startApiServer, type RunningApi } from "../../src/api/server.ts";
import { createDefaultCliContext } from "../../src/cli/context.ts";
import { runChecklist } from "../../src/checklist/shieldedTx.ts";
import { runCli } from "../../src/cli/index.ts";
import { CliExitCode } from "../../src/cli/types.ts";
import { parseTokenAmount } from "../../src/cli/parser.ts";
import { RailgunPool } from "../../src/sim/railgunContract.ts";
import { SIM_VENDOR_ADDRESS } from "../../src/sim/defaults.ts";

const VENDOR = SIM_VENDOR_ADDRESS;

/** Raw request so tests can set Host/Origin headers that fetch() forbids. */
function raw(
  api: RunningApi,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; host?: string; session?: boolean } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: api.port,
        method,
        path,
        headers: {
          Host: opts.host ?? `127.0.0.1:${api.port}`,
          ...(opts.session === false ? {} : { "X-DarkCircle-Session": api.token }),
          ...(body !== undefined ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}),
          ...(opts.headers ?? {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: res.statusCode!, headers: res.headers, json, text });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("shielded-transaction checklist", () => {
  it("passes a well-formed payment and reports the plan (note, fee, change)", () => {
    const ctx = createDefaultCliContext();
    const r = runChecklist("unshield", { address: VENDOR, amount: "5", token: "WQUAI" }, ctx);
    assert.equal(r.canProceed, true);
    assert.equal(r.blockers, 0);
    assert.ok(r.warnings >= 1); // simulation notice at minimum
    assert.equal(r.plan?.amount, "5.0");
    assert.equal(r.plan?.relayerFee, "0.5");
    assert.equal(r.plan?.change, "94.5");
    const ids = r.items.map((i) => i.id);
    for (const id of ["SP-ENV-01", "SP-ENV-02", "SP-IN-01", "SP-IN-02", "SP-IN-03", "SP-FN-01", "SP-FN-03", "SP-CP-01", "SP-CP-02", "SP-PV-01", "SP-EX-01"]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    // groups are contiguous and in display order
    const order = ["Environment", "Inputs", "Funds", "Compliance", "Privacy", "Execution"];
    const seen = r.items.map((i) => i.group);
    assert.deepEqual(seen, [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });

  it("blocks on a wrong-zone, Qi-ledger, unchecksummed or missing recipient", () => {
    const ctx = createDefaultCliContext();
    for (const address of ["0x1111111254eeb25477b68fb85ed929f73a960582", "0x0080000000000000000000000000000000000001", "0x1234", ""]) {
      const r = runChecklist("unshield", { address, amount: "1" }, ctx);
      assert.equal(r.canProceed, false, address);
      assert.equal(r.items.find((i) => i.id === "SP-IN-03")!.status, "fail");
    }
  });

  it("blocks unknown assets, bad amounts, amounts over the cap and a shortfall of shielded funds", () => {
    const ctx = createDefaultCliContext();
    assert.equal(runChecklist("unshield", { address: VENDOR, amount: "1", token: "USDT" }, ctx).items.find((i) => i.id === "SP-IN-01")!.status, "fail");
    for (const amount of ["", "abc", "-1", "0", "1.0000000000000000001", "1e3"]) {
      assert.equal(runChecklist("unshield", { address: VENDOR, amount }, ctx).items.find((i) => i.id === "SP-IN-02")!.status, "fail", amount);
    }
    assert.equal(runChecklist("unshield", { address: VENDOR, amount: "51" }, ctx).items.find((i) => i.id === "SP-CP-04")!.status, "fail");
    assert.equal(runChecklist("unshield", { address: VENDOR, amount: "99.9" }, ctx).items.find((i) => i.id === "SP-FN-01")!.status, "fail");
  });

  it("blocks a sanctioned recipient and a sanctioned note origin", () => {
    const ctx = createDefaultCliContext();
    const sanctioned = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";
    assert.equal(runChecklist("unshield", { address: sanctioned, amount: "1" }, ctx).items.find((i) => i.id === "SP-IN-03")!.status, "fail"); // off-zone first
    ctx.treasuryUTXOs[0].depositorAddress = sanctioned.toLowerCase();
    const r = runChecklist("unshield", { address: VENDOR, amount: "1" }, ctx);
    assert.equal(r.items.find((i) => i.id === "SP-CP-02")!.status, "fail");
    assert.equal(r.canProceed, false);
  });

  it("refuses to certify a trusted-harness pool, and reports insolvency", () => {
    const ctx = createDefaultCliContext();
    const harness = new RailgunPool(ctx.blockchain, { mode: "trusted-harness" });
    const r = runChecklist("audit", {}, { ...ctx, pool: harness } as any);
    const env = r.items.find((i) => i.id === "SP-ENV-02")!;
    assert.equal(env.status, "fail");
    assert.match(env.detail, /trusted-harness/);
    assert.equal(r.canProceed, false);

    const ctx2 = createDefaultCliContext();
    ctx2.token!.burn(ctx2.pool.contractAddress, 10n ** 18n); // custody disappears
    const r2 = runChecklist("unshield", { address: VENDOR, amount: "1" }, ctx2);
    assert.equal(r2.items.find((i) => i.id === "SP-FN-03")!.status, "fail");
    assert.equal(r2.canProceed, false);
  });

  it("shield: checks balance, wrap-native rules and screens the depositor", () => {
    const ctx = createDefaultCliContext();
    assert.equal(runChecklist("shield", { amount: "10" }, ctx).canProceed, true);
    assert.equal(runChecklist("shield", { amount: "1000" }, ctx).items.find((i) => i.id === "SP-FN-02")!.status, "fail");
    assert.equal(runChecklist("shield", { amount: "10", wrapNative: true }, ctx).items.find((i) => i.id === "SP-FN-06")!.status, "pass");
    assert.equal(runChecklist("shield", { amount: "1000", wrapNative: true }, ctx).items.find((i) => i.id === "SP-FN-06")!.status, "fail");
    assert.equal(runChecklist("shield", { amount: "1", token: "WQI", wrapNative: true }, ctx).items.find((i) => i.id === "SP-FN-06")!.status, "fail");
    assert.equal(runChecklist("shield", { amount: "1", address: "0x1111111254eeb25477b68fb85ed929f73a960582" }, ctx).canProceed, false);
  });

  it("privacy: warns on a tiny anonymity set, a recent deposit, and an amount equal to a recent shield", () => {
    const ctx = createDefaultCliContext();
    // 99 is covered by the seeded 100 note (99 + 0.5 fee), which was deposited moments ago
    const r = runChecklist("unshield", { address: VENDOR, amount: "99" }, ctx);
    assert.equal(r.items.find((i) => i.id === "SP-PV-01")!.status, "warn");
    assert.equal(r.items.find((i) => i.id === "SP-PV-04")!.status, "warn");
    assert.equal(r.items.find((i) => i.id === "SP-PV-03")!.status, "pass");
    // 100 equals the seeded deposit exactly: flagged as an amount fingerprint (and no note covers it plus the fee)
    const same = runChecklist("unshield", { address: VENDOR, amount: "100" }, ctx);
    assert.equal(same.items.find((i) => i.id === "SP-PV-03")!.status, "warn");
    assert.equal(same.items.find((i) => i.id === "SP-FN-01")!.status, "fail");
  });

  it("receive and sweep: WQUAI needs relayer gas, WQI can be gasless; sweep needs a settled invoice", () => {
    const ctx = createDefaultCliContext();
    assert.equal(runChecklist("receive", { amount: "5", token: "WQUAI" }, ctx).items.find((i) => i.id === "SP-RC-03")!.status, "warn");
    assert.equal(runChecklist("receive", { amount: "5", token: "WQI" }, ctx).items.find((i) => i.id === "SP-RC-03")!.status, "pass");
    assert.equal(runChecklist("sweep", { invoiceId: "inv_nope" }, ctx).canProceed, false);
    const pending = ctx.merchantGateway.createPaymentChallenge("/r", 10n ** 18n, ctx.token!.address).invoice;
    assert.match(runChecklist("sweep", { invoiceId: pending.invoiceId }, ctx).items.find((i) => i.id === "SP-SW-01")!.detail, /PENDING/);
  });

  it("audit: reconciles, and blocks when the journal does not", () => {
    const ctx = createDefaultCliContext();
    assert.equal(runChecklist("audit", {}, ctx).canProceed, true);
    ctx.journal!.runningBalance += 1n;
    const r = runChecklist("audit", {}, ctx);
    assert.equal(r.items.find((i) => i.id === "SP-AU-01")!.status, "fail");
    assert.equal(r.canProceed, false);
  });

  it("CLI: checklist and shield commands", async () => {
    const ctx = createDefaultCliContext();
    const ok = await runCli(["checklist", "unshield", "--address", VENDOR, "--amount", "5", "--json"], ctx);
    assert.equal(ok.exitCode, CliExitCode.SUCCESS);
    assert.equal(JSON.parse(ok.stdout).canProceed, true);
    const bad = await runCli(["checklist", "unshield", "--address", "0x1234", "--amount", "5"], ctx);
    assert.equal(bad.exitCode, CliExitCode.EXECUTION_ERROR);
    assert.match(bad.stdout, /BLOCKED/);
    assert.equal((await runCli(["checklist", "bogus"], ctx)).exitCode, CliExitCode.USAGE_ERROR);

    const sh = await runCli(["shield", "--amount", "10", "--json"], ctx);
    assert.equal(sh.exitCode, CliExitCode.SUCCESS, sh.stderr);
    assert.equal(JSON.parse(sh.stdout).amount, "10.0");
    assert.equal(ctx.treasuryUTXOs.length, 2);
    assert.ok(ctx.pool.solvency().every((r) => r.ok));
    assert.ok(ctx.journal!.verifyReconciliation());
    assert.notEqual((await runCli(["shield", "--amount", "10000"], ctx)).exitCode, CliExitCode.SUCCESS);
    assert.equal((await runCli(["shield"], ctx)).exitCode, CliExitCode.USAGE_ERROR);
  });

  it("A-19: CLI amounts are token amounts; base units need a 'u' suffix; excess precision is refused", () => {
    assert.equal(parseTokenAmount("5"), 5n * 10n ** 18n);
    assert.equal(parseTokenAmount("5.0"), 5n * 10n ** 18n);
    assert.equal(parseTokenAmount("5u"), 5n);
    assert.equal(parseTokenAmount("0.5", 6), 500_000n);
    assert.throws(() => parseTokenAmount("0.1234567", 6), /ERR_AMOUNT_INVALID/);
    assert.throws(() => parseTokenAmount("-1"), /ERR_AMOUNT_INVALID/);
    assert.throws(() => parseTokenAmount("1e3"), /ERR_AMOUNT_INVALID/);
    assert.throws(() => parseTokenAmount(""), /ERR_AMOUNT_INVALID/);
  });

  it("A-20: the invoice command never prints the ephemeral private key", async () => {
    const ctx = createDefaultCliContext();
    const res = await runCli(["invoice", "--amount", "2", "--json"], ctx);
    const inv = ctx.merchantGateway.invoiceRegistry.values().next().value!;
    assert.ok(inv.ephemeralPrivateKey.startsWith("0x"));
    assert.equal(res.stdout.includes(inv.ephemeralPrivateKey), false);
    assert.equal(JSON.parse(res.stdout).invoice.ephemeralPrivateKey, "[REDACTED]");
  });
});

describe("local API server", () => {
  let api: RunningApi;
  before(async () => { api = await startApiServer({ port: 0 }); });
  after(async () => { await api.close(); });

  it("serves the UI with the session token and a strict CSP", async () => {
    const res = await raw(api, "GET", "/", { session: false });
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`content="${api.token}"`));
    assert.doesNotMatch(res.text, /__SESSION_TOKEN__/);
    const csp = String(res.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:\/\//);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal((await raw(api, "GET", "/app.js", { session: false })).status, 200);
    assert.equal((await raw(api, "GET", "/app.css", { session: false })).status, 200);
    assert.equal((await raw(api, "GET", "/../package.json", { session: false })).status, 404);
    assert.equal((await raw(api, "GET", "/ui/app.js", { session: false })).status, 404);
  });

  it("the UI script contains no inline handlers, innerHTML or third-party URLs", async () => {
    const js = (await raw(api, "GET", "/app.js", { session: false })).text;
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    assert.doesNotMatch(js, /https?:\/\//);
    const html = (await raw(api, "GET", "/", { session: false })).text;
    assert.doesNotMatch(html, /\son[a-z]+=|<script(?![^>]*src=)/i);
    assert.doesNotMatch(html, /https?:\/\//);
  });

  it("rejects requests without the session token, with a wrong one, or from another site", async () => {
    assert.equal((await raw(api, "GET", "/api/status", { session: false })).status, 401);
    assert.equal((await raw(api, "GET", "/api/status", { session: false, headers: { "X-DarkCircle-Session": "0".repeat(48) } })).status, 401);
    assert.equal((await raw(api, "GET", "/api/status", { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await raw(api, "GET", "/api/status", { headers: { Origin: `http://127.0.0.1:${api.port}` } })).status, 200);
  });

  it("refuses a rebinding Host header", async () => {
    assert.equal((await raw(api, "GET", "/api/status", { host: "attacker.example" })).status, 403);
    assert.equal((await raw(api, "GET", "/", { host: `evil.example:${api.port}`, session: false })).status, 403);
    assert.equal((await raw(api, "GET", "/api/status", { host: `localhost:${api.port}` })).status, 200);
  });

  it("enforces content type, method, JSON validity and the body size cap", async () => {
    assert.equal((await raw(api, "POST", "/api/checklist", { body: "x=1", headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await raw(api, "DELETE", "/api/status")).status, 405);
    assert.equal((await raw(api, "POST", "/api/checklist", { body: "{not json" })).status, 400);
    assert.equal((await raw(api, "POST", "/api/checklist", { body: { kind: "nope" } })).status, 400);
    const big = await raw(api, "POST", "/api/checklist", { body: JSON.stringify({ kind: "audit", pad: "x".repeat(70_000) }) }).catch((e) => ({ status: 0, err: e }));
    assert.ok([413, 0].includes((big as any).status));
    assert.equal((await raw(api, "GET", "/api/nope")).status, 404);
  });

  it("status exposes trust modes and no secrets", async () => {
    const res = await raw(api, "GET", "/api/status");
    assert.equal(res.json.simulation, true);
    assert.equal(res.json.pool.mode, "verified");
    assert.equal(res.json.gateway.trustMode, "verified");
    assert.equal(res.json.network.chainId, 9);
    assert.equal(res.json.pool.solvent, true);
    const text = res.text;
    const ctx = api.state.ctx as any;
    assert.equal(text.includes(ctx.corporateKeys.ssk.toString()), false);
    assert.equal(text.includes(ctx.corporateKeys.vsk.toString()), false);
    assert.equal(/privateKey|spendingKey|viewingKeyToken/i.test(text), false);
  });

  it("actions re-run the checklist server-side: a blocked request is refused with the checklist", async () => {
    const before = api.state.ctx.token!.balanceOf(VENDOR);
    const res = await raw(api, "POST", "/api/pay", { body: { address: "0x1111111254eeb25477b68fb85ed929f73a960582", amount: "1", acknowledged: true } });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "CHECKLIST_BLOCKED");
    assert.equal(res.json.checklist.canProceed, false);
    assert.equal(api.state.ctx.token!.balanceOf(VENDOR), before);
  });

  it("warnings must be acknowledged; with acknowledgement the payment goes through", async () => {
    const noAck = await raw(api, "POST", "/api/pay", { body: { address: VENDOR, amount: "5" } });
    assert.equal(noAck.status, 409);
    assert.equal(noAck.json.error.code, "ACKNOWLEDGEMENT_REQUIRED");
    assert.equal(api.state.ctx.token!.balanceOf(VENDOR), 0n);

    const ok = await raw(api, "POST", "/api/pay", { body: { address: VENDOR, amount: "5", acknowledged: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, "CONFIRMED");
    assert.equal(ok.json.plan.change, "94.5");
    assert.equal(api.state.ctx.token!.balanceOf(VENDOR), 5n * 10n ** 18n);
    // the on-chain sender was the relayer
    const tx = api.state.ctx.blockchain.latestBlock.transactions.at(-1) as any;
    assert.equal(tx.from, api.state.ctx.relayer.relayerAddress.toLowerCase());
  });

  it("receive -> simulated customer payment -> sweep, end to end over HTTP, without leaking the payee key", async () => {
    const inv = await raw(api, "POST", "/api/invoice", { body: { amount: "3", acknowledged: true } });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(inv.json.invoice.ephemeralPrivateKey, "[REDACTED]");
    const id = inv.json.invoice.invoiceId;
    const stored = (api.state.ctx.merchantGateway as any).invoiceRegistry.get(id);
    assert.equal(inv.text.includes(stored.ephemeralPrivateKey), false);

    const early = await raw(api, "POST", "/api/sweep", { body: { invoiceId: id, acknowledged: true } });
    assert.equal(early.status, 422); // still PENDING

    const paid = await raw(api, "POST", "/api/invoice/simulate-payment", { body: { invoiceId: id } });
    assert.equal(paid.json.verified, true, paid.text);
    assert.equal(paid.json.simulated, true);

    const sweep = await raw(api, "POST", "/api/sweep", { body: { invoiceId: id, acknowledged: true } });
    assert.equal(sweep.status, 200, sweep.text);
    assert.equal(sweep.text.includes(stored.ephemeralPrivateKey), false);
    assert.equal(stored.status, "SWEPT");
    const notes = await raw(api, "GET", "/api/notes");
    assert.equal(notes.json.notes.length, 2);
    assert.equal((await raw(api, "GET", "/api/status")).json.pool.solvent, true);
  });

  it("shield and audit export over HTTP; export is gated by reconciliation", async () => {
    const sh = await raw(api, "POST", "/api/shield", { body: { amount: "10", acknowledged: true } });
    assert.equal(sh.status, 200, sh.text);
    assert.equal(sh.json.status, "CONFIRMED");
    const exp = await raw(api, "POST", "/api/audit/export", { body: { format: "json", acknowledged: true } });
    assert.equal(exp.status, 200, exp.text);
    const report = JSON.parse(exp.json.content);
    assert.equal(report.cryptographicChecksum.algorithm, "SHA-256");
    assert.equal(report.auditedEntity.spendingKeyPresent, false);
    const csv = await raw(api, "POST", "/api/audit/export", { body: { format: "csv", acknowledged: true } });
    assert.match(csv.json.content, /^journal_id,/);

    (api.state.ctx.journal as any).runningBalance += 1n; // break reconciliation
    const blocked = await raw(api, "POST", "/api/audit/export", { body: { format: "json", acknowledged: true } });
    assert.equal(blocked.status, 422);
    (api.state.ctx.journal as any).runningBalance -= 1n;
  });

  it("reset returns a fresh simulation and can switch the asset", async () => {
    assert.equal((await raw(api, "POST", "/api/reset", { body: { asset: "WQI" } })).status, 400, "the server asks for the typed confirmation itself");
    const res = await raw(api, "POST", "/api/reset", { body: { asset: "WQI", confirm: "RESET" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.asset.symbol, "WQI");
    assert.equal(res.json.balances.shielded, "100.0");
    assert.equal(res.json.preservedSnapshot, null, "nothing to preserve without persistence");
    assert.equal((await raw(api, "POST", "/api/reset", { body: { asset: "USDT", confirm: "RESET" } })).status, 400);
  });
});

describe("checklist documentation", () => {
  const ID = /SP-([A-Z]+)-(\d+)(?:\.\.(\d+))?/g;
  const expand = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const m of text.matchAll(ID)) {
      const from = Number(m[2]);
      const to = m[3] ? Number(m[3]) : from;
      for (let n = from; n <= to; n++) out.add(`SP-${m[1]}-${String(n).padStart(2, "0")}`);
    }
    return out;
  };

  it("docs/SHIELDED_POOL_CHECKLIST.md lists exactly the ids the code can emit", () => {
    const doc = fs.readFileSync(new URL("../../docs/SHIELDED_POOL_CHECKLIST.md", import.meta.url), "utf8");
    const src = fs.readFileSync(new URL("../../src/checklist/shieldedTx.ts", import.meta.url), "utf8");
    // only ids used as check ids (first string argument), not the ones mentioned in comments
    const emitted = new Set<string>();
    for (const m of src.matchAll(/\b(?:pass|fail|warn|info)\(\s*"(SP-[A-Z]+-\d+)"/g)) emitted.add(m[1]);
    const documented = expand(doc);
    assert.ok(emitted.size >= 30, `expected many ids, found ${emitted.size}`);
    const undocumented = [...emitted].filter((id) => !documented.has(id));
    const phantom = [...documented].filter((id) => !emitted.has(id));
    assert.deepEqual(undocumented, [], "ids the code emits but the document does not list");
    assert.deepEqual(phantom, [], "ids the document lists but the code never emits");
  });

  it("every id the code emits is actually reachable", () => {
    const ctx = createDefaultCliContext();
    const seen = new Set<string>();
    const run = (kind: any, params: any, c = ctx) => runChecklist(kind, params, c).items.forEach((i) => seen.add(i.id));
    run("unshield", { address: VENDOR, amount: "5" });
    run("unshield", { address: ctx.corporateOperatingAddress, amount: "5" });
    run("unshield", { address: VENDOR, amount: "99" });
    run("shield", { amount: "10" });
    run("shield", { amount: "10", wrapNative: true });
    run("receive", { amount: "5", token: "WQUAI" });
    run("receive", { amount: "5", token: "WQI" });
    const inv = ctx.merchantGateway.createPaymentChallenge("/r", 10n ** 18n, ctx.token!.address).invoice;
    run("sweep", { invoiceId: inv.invoiceId });
    inv.status = "SETTLED";
    inv.payerAddress = "0x0054328ef0070fceeea0a22bb01fa5f6614098ef";
    run("sweep", { invoiceId: inv.invoiceId });
    run("audit", {});
    const noCap = createDefaultCliContext();
    noCap.spendingPolicy.dailyBudgetCap = undefined; // SP-CP-05 only fires without a daily budget
    run("unshield", { address: VENDOR, amount: "5" }, noCap);
    const src = fs.readFileSync(new URL("../../src/checklist/shieldedTx.ts", import.meta.url), "utf8");
    const emitted = new Set<string>();
    for (const m of src.matchAll(/\b(?:pass|fail|warn|info)\(\s*"(SP-[A-Z]+-\d+)"/g)) emitted.add(m[1]);
    // Ids that only fire on a failure path are exercised in the tests above; here require that every id
    // was produced by at least one scenario, allowing the pure failure-path ids below.
    const failureOnly = new Set(["SP-SW-04"]); // needs a zeroized key, covered by the sweep flow tests
    const unreachable = [...emitted].filter((id) => !seen.has(id) && !failureOnly.has(id));
    assert.deepEqual(unreachable, []);
  });
});

describe("local API: WQUAI and WQI pools live at once", () => {
  let api: RunningApi;
  before(async () => { api = await startApiServer({ port: 0 }); });
  after(async () => { await api.close(); });

  const get = (path: string) => raw(api, "GET", path);
  const post = (path: string, body: unknown) => raw(api, "POST", path, { body });

  it("status lists both pools, each verified, each with its own address and sweep mode", async () => {
    const res = await get("/api/status");
    const bySymbol = Object.fromEntries(res.json.assets.map((a: any) => [a.symbol, a]));
    assert.deepEqual(Object.keys(bySymbol), ["WQUAI", "WQI"]);
    assert.notEqual(bySymbol.WQUAI.poolAddress, bySymbol.WQI.poolAddress);
    for (const a of Object.values(bySymbol) as any[]) {
      assert.equal(a.poolMode, "verified");
      assert.equal(a.gatewayMode, "verified");
      assert.equal(a.solvent, true);
      assert.equal(a.shielded, "100.0");
    }
    assert.equal(bySymbol.WQI.permit, true);
    assert.equal(bySymbol.WQI.sweepMode, "PERMIT_SPONSORED");
    assert.equal(bySymbol.WQUAI.permit, false);
    assert.equal(bySymbol.WQUAI.sweepMode, "RELAYER_BROADCAST");
    assert.equal(res.json.active, "WQUAI");
  });

  it("?asset= selects which pool the status, notes and journal describe, without changing server state", async () => {
    const w = await get("/api/status?asset=WQI");
    assert.equal(w.json.asset.symbol, "WQI");
    assert.equal(w.json.pool.address, "0x005e97845b74D0D4b6a2680F1bccC4CD00276c2d");
    assert.equal(w.json.gateway.sweepMode, "PERMIT_SPONSORED");
    assert.equal((await get("/api/notes?asset=WQI")).json.asset, "WQI");
    assert.equal((await get("/api/journal?asset=WQI")).json.asset, "WQI");
    assert.equal((await get("/api/status")).json.active, "WQUAI"); // a GET did not switch the default
    assert.equal((await get("/api/status?asset=USDT")).status, 400);
  });

  it("a payment in WQI is routed to the WQI pool and leaves the WQUAI pool untouched", async () => {
    const ok = await post("/api/pay", { address: VENDOR, amount: "5", token: "WQI", acknowledged: true });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.plan.symbol, "WQI");
    const s = (await get("/api/status")).json.assets;
    assert.equal(s.find((a: any) => a.symbol === "WQI").shielded, "94.5");
    assert.equal(s.find((a: any) => a.symbol === "WQUAI").shielded, "100.0");
    assert.equal(api.state.env.lanes.WQI.token!.balanceOf(VENDOR), 5n * 10n ** 18n);
    assert.equal(api.state.env.lanes.WQUAI.token!.balanceOf(VENDOR), 0n);
  });

  it("the checklist for an asset runs against that asset's pool", async () => {
    const res = await post("/api/checklist", { kind: "receive", amount: "5", token: "WQI" });
    assert.equal(res.json.items.find((i: any) => i.id === "SP-RC-03").status, "pass"); // gasless
    const q = await post("/api/checklist", { kind: "receive", amount: "5", token: "WQUAI" });
    assert.equal(q.json.items.find((i: any) => i.id === "SP-RC-03").status, "warn"); // relayer-funded gas
    const wrap = await post("/api/checklist", { kind: "shield", amount: "1", token: "WQI", wrapNative: true });
    assert.equal(wrap.json.canProceed, false);
  });

  it("a WQI invoice is swept from the WQI pool by permit, routed by the invoice and not by a client-chosen asset", async () => {
    const inv = await post("/api/invoice", { amount: "3", token: "WQI", acknowledged: true });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(inv.json.invoice.tokenSymbol, "WQI");
    const id = inv.json.invoice.invoiceId;
    const paid = await post("/api/invoice/simulate-payment", { invoiceId: id });
    assert.equal(paid.json.verified, true, paid.text);
    assert.equal(paid.json.asset, "WQI");

    // Naming the other asset for this invoice is refused outright (the invoice belongs to the WQI pool),
    // and nothing moves.
    const wrong = await post("/api/sweep", { invoiceId: id, token: "WQUAI", acknowledged: true });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.json.error.code, "CHECKLIST_BLOCKED");
    assert.equal((await get("/api/notes?asset=WQI")).json.notes.length, 1);
    assert.equal(api.state.env.lanes.WQI.merchantGateway.invoiceRegistry.get(id)!.status, "SETTLED");

    // the invoice alone decides the pool
    const sweep = await post("/api/sweep", { invoiceId: id, acknowledged: true });
    assert.equal(sweep.status, 200, sweep.text);
    assert.equal(sweep.json.asset, "WQI");
    assert.equal(sweep.json.sweepMethod, "permit");
    assert.equal(sweep.json.forwardSecrecyKeyZeroization, "CONFIRMED");
    assert.equal((await get("/api/notes?asset=WQI")).json.notes.length, 2); // change note + swept note
    assert.equal((await get("/api/notes?asset=WQUAI")).json.notes.length, 1);
    assert.ok((await get("/api/status")).json.assets.every((a: any) => a.solvent));
  });

  it("invoices from both pools are listed together, each with its own asset", async () => {
    await post("/api/invoice", { amount: "1", token: "WQUAI", acknowledged: true });
    const list = (await get("/api/invoices")).json.invoices;
    const symbols = new Set(list.map((i: any) => i.symbol));
    assert.ok(symbols.has("WQI") && symbols.has("WQUAI"));
  });

  it("audit export is per asset and reports that asset", async () => {
    const w = await post("/api/audit/export", { format: "json", token: "WQI", acknowledged: true });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.asset, "WQI");
    assert.equal(JSON.parse(w.json.content).financialSummary.assetSymbol, "WQI");
    const q = await post("/api/audit/export", { format: "json", token: "WQUAI", acknowledged: true });
    assert.equal(JSON.parse(q.json.content).financialSummary.assetSymbol, "WQUAI");
  });

  it("shield in WQI goes to the WQI pool; the WQI wrap option is refused server-side", async () => {
    const wrap = await post("/api/shield", { amount: "1", token: "WQI", wrapNative: true, acknowledged: true });
    assert.equal(wrap.status, 422);
    assert.equal(wrap.json.error.code, "CHECKLIST_BLOCKED");
    const ok = await post("/api/shield", { amount: "10", token: "WQI", acknowledged: true });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.symbol, "WQI");
  });

  it("reset rebuilds both pools and can choose which one is shown first", async () => {
    const res = await post("/api/reset", { asset: "WQI", confirm: "RESET" });
    assert.equal(res.status, 200);
    assert.equal(res.json.active, "WQI");
    assert.deepEqual(res.json.assets.map((a: any) => a.shielded), ["100.0", "100.0"]);
    assert.equal((await get("/api/invoices")).json.invoices.length, 0);
  });
});
