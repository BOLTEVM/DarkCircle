/**
 * DarkCircle voice agent: the HTTP surface and local speech-to-text
 * File: test/unit/agent_api.test.ts
 *
 * The agent's routes sit behind the same session token, Origin and CSP rules as the rest of the local API; a
 * recorded command is uploaded as raw audio and transcribed on this machine. The speech worker here is a fake
 * that speaks the real worker's protocol (fakeWhisperWorker.mjs), and the chain is the fake zone, so nothing
 * leaves the test.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startApiServer, type RunningApi } from "../../src/api/server.ts";
import { AgentBook } from "../../src/agent/book.ts";
import { LocalTranscriber } from "../../src/voice/transcriber.ts";
import { WQUAI_ADDRESS } from "../../src/quai/tokens.ts";
import { SIM_VENDOR_ADDRESS } from "../../src/sim/defaults.ts";
import { FakeQuai } from "./agentFakeChain.ts";

const ONE = 10n ** 18n;
const ME = "0x004E3d0a19fA256E0A8903528605dE5acD8Faa72";
const WORKER = path.join(import.meta.dirname, "fakeWhisperWorker.mjs");
const fakeTranscriber = (mode = "ok", extra: Record<string, string> = {}) =>
  new LocalTranscriber({ spawnWorker: () => spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FAKE_WHISPER: mode, ...extra } }) });

const call = (api: RunningApi, method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(api.url.replace(/\/$/, "") + url, {
    method,
    headers: { "X-DarkCircle-Session": api.token, ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, headers: r.headers, json: (await r.json().catch(() => undefined)) as any }));

describe("voice agent API", () => {
  let api: RunningApi;
  let chain: FakeQuai;

  before(async () => {
    chain = new FakeQuai();
    chain.setNative(ME, 100n * ONE);
    chain.setToken(WQUAI_ADDRESS, ME, 50n * ONE);
    const book = new AgentBook();
    api = await startApiServer({ port: 0, agent: { book, rpcFactory: (n) => chain.rpc(n), transcriber: fakeTranscriber() } });
  });
  after(async () => {
    await api.close();
  });

  it("is behind the session token like every other route, and the page may use the microphone (only)", async () => {
    const res = await fetch(api.url + "api/agent/state");
    assert.equal(res.status, 401);
    const page = await fetch(api.url);
    assert.match(page.headers.get("permissions-policy") ?? "", /microphone=\(self\)/);
    assert.match(page.headers.get("permissions-policy") ?? "", /camera=\(\)/);
    const state = await call(api, "GET", "/api/agent/state");
    assert.equal(state.status, 200);
    assert.deepEqual(state.json.networks.map((n: any) => n.chainId), [9, 15000]);
    assert.equal(state.json.persistent, false);
  });

  it("contacts are validated on the server: a wrong-zone address is a 400 with the reason", async () => {
    const bad = await call(api, "POST", "/api/agent/contacts", { action: "add", name: "Far Away", address: "0x1054328ef0070fceeea0a22bb01fa5f6614098ef" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "CONTACT_ADDRESS");
    const ok = await call(api, "POST", "/api/agent/contacts", { action: "add", name: "Acme Corp", address: SIM_VENDOR_ADDRESS });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.contacts[0].name, "Acme Corp");
  });

  it("speak -> plan -> confirm -> the wallet signs -> report: the whole loop over HTTP", async () => {
    const wallet = { address: ME, chainId: 9 };
    const said = await call(api, "POST", "/api/voice/transcribe", new TextEncoder().encode("Send two W-Quai to Acme Corp."), { "Content-Type": "audio/webm" });
    assert.equal(said.status, 200, JSON.stringify(said.json));
    assert.equal(said.json.text, "Send two W-Quai to Acme Corp.");
    const turn = await call(api, "POST", "/api/agent/say", { text: said.json.text, network: "quai-cyprus1", wallet });
    assert.equal(turn.json.type, "plan", turn.json.say);
    const plan = turn.json.plan;
    assert.equal((await call(api, "POST", "/api/agent/confirm", { planId: plan.id, code: "000", wallet })).status, 422, "a wrong code is refused by the server");
    const confirmed = await call(api, "POST", "/api/agent/confirm", { planId: plan.id, code: plan.code, wallet });
    assert.equal(confirmed.status, 200);
    const tx = plan.txs[0];
    const hash = chain.send({ from: plan.from, to: tx.to, data: tx.data, value: tx.value });
    const done = await call(api, "POST", "/api/agent/report", { planId: plan.id, index: 0, txHash: hash });
    assert.equal(done.json.status, "done", done.json.say);
    assert.equal(chain.tokenBalance(WQUAI_ADDRESS, SIM_VENDOR_ADDRESS), 2n * ONE);
    const state = await call(api, "GET", "/api/agent/state");
    assert.equal(state.json.activity[0].status, "done");
    assert.deepEqual(state.json.activity[0].txHashes, [hash]);
  });

  it("refusals are ordinary answers to /say (200 with a reason); malformed input is a 400", async () => {
    const r = await call(api, "POST", "/api/agent/say", { text: "shield 5 wqi", network: "quai-cyprus1" });
    assert.equal(r.status, 200);
    assert.equal(r.json.type, "refusal");
    assert.equal(r.json.code, "SHIELD_NOT_AVAILABLE");
    assert.equal((await call(api, "POST", "/api/agent/say", { text: "x".repeat(400) })).status, 400);
    assert.equal((await call(api, "POST", "/api/agent/say", { text: "balance", network: "ethereum" })).status, 400);
    assert.equal((await call(api, "POST", "/api/agent/say", { text: "balance", wallet: { address: "nope", chainId: 9 } })).status, 400);
  });

  it("audio uploads: only audio/* types, size-capped", async () => {
    assert.equal((await call(api, "POST", "/api/voice/transcribe", new Uint8Array([1, 2]), { "Content-Type": "text/plain" })).status, 415);
    const big = await call(api, "POST", "/api/voice/transcribe", new Uint8Array(4 * 1024 * 1024 + 10), { "Content-Type": "audio/webm" });
    assert.equal(big.status, 413);
  });

  it("a slow transcription does not hold up the rest of the API", async () => {
    const slow = await startApiServer({ port: 0, agent: { rpcFactory: (n) => chain.rpc(n), transcriber: fakeTranscriber("slow") } });
    try {
      const pending = call(slow, "POST", "/api/voice/transcribe", new TextEncoder().encode("what's my balance"), { "Content-Type": "audio/ogg" });
      await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      assert.equal((await call(slow, "GET", "/api/status")).status, 200);
      assert.equal((await call(slow, "GET", "/api/agent/state")).status, 200);
      assert.ok(Date.now() - t0 < 1000, "the dashboard and the agent answered while the clip was still being transcribed");
      assert.equal((await pending).json.text, "what's my balance");
    } finally {
      await slow.close();
    }
  });

  it("without a model: a 503 that says how to install it; with speech turned off: a 503 too", async () => {
    const missing = await startApiServer({ port: 0, agent: { transcriber: fakeTranscriber("missing") } });
    try {
      const r = await call(missing, "POST", "/api/voice/transcribe", new TextEncoder().encode("hello"), { "Content-Type": "audio/webm" });
      assert.equal(r.status, 503);
      assert.match(r.json.error.message, /not installed/);
      const status = await call(missing, "GET", "/api/voice/status");
      assert.equal(status.json.state, "unavailable");
      assert.equal(status.json.setup, "pnpm voice:setup -- --yes");
    } finally {
      await missing.close();
    }
    const off = await startApiServer({ port: 0, agent: { transcriber: null } });
    try {
      assert.equal((await call(off, "POST", "/api/voice/transcribe", new Uint8Array([1]), { "Content-Type": "audio/webm" })).status, 503);
    } finally {
      await off.close();
    }
  });
});

describe("local speech-to-text", () => {
  it("passes contact names as hints, and leaves no recording behind", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("dc-voice-"));
    const t = fakeTranscriber();
    try {
      const r = await t.transcribe(Buffer.from("pay acme corp 3 wqi"), { mime: "audio/webm;codecs=opus", hints: ["Acme Corp", "bad<name>"] });
      assert.equal(r.text, "pay acme corp 3 wqi");
      assert.equal(t.status().state, "ready");
    } finally {
      t.close();
    }
    const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("dc-voice-") && !before.includes(f));
    assert.deepEqual(left, [], "the temporary clip is deleted as soon as it is transcribed");
  });

  it("refuses unsupported or empty audio before starting anything, and reports a crashed worker", async () => {
    const t = fakeTranscriber("crash");
    await assert.rejects(t.transcribe(Buffer.from("x"), { mime: "video/mp4" }), /ERR_AUDIO_TYPE/);
    await assert.rejects(t.transcribe(Buffer.alloc(0), { mime: "audio/wav" }), /ERR_AUDIO_EMPTY/);
    await assert.rejects(t.transcribe(Buffer.from("x"), { mime: "audio/wav" }), /the speech worker stopped/);
    t.close();
  });

  it("the real worker never downloads: it reports a missing model instead (and no model is installed by this test)", () => {
    const t = new LocalTranscriber({ modelDir: path.join(os.tmpdir(), "dc-no-such-model-dir") });
    const s = t.status();
    assert.equal(s.installed, false);
    assert.equal(s.state, "unavailable");
    assert.match(s.reason ?? "", /not installed/);
    const worker = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "scripts", "whisper_worker.py"), "utf8");
    assert.match(worker, /local_files_only=True/);
  });
});
