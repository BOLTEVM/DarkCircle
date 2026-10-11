/**
 * DarkCircle voice agent: grammar, book, planning and the plan -> confirm -> sign -> verify loop
 * File: test/unit/agent.test.ts
 *
 * The chain is a fake zone (agentFakeChain.ts) and the test plays the user's wallet, so every check that
 * guards real funds is exercised without touching a network: what the grammar refuses, what the planner
 * refuses before anything is offered, what confirmation requires, and that a receipt which does not match
 * the plan is never counted as done.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCommand } from "../../src/agent/grammar.ts";
import { normalizeNumbers } from "../../src/agent/numbers.ts";
import { AgentBook, encryptedBookStore, type BookStore } from "../../src/agent/book.ts";
import { VoiceAgent } from "../../src/agent/agent.ts";
import { ERC20, WRAPPER, type Fetched } from "../../src/agent/planner.ts";
import { EncryptedStore } from "../../src/persistence/store.ts";
import { buildQuaiChallenge } from "../../src/gateway/challenge.ts";
import { QUAI_CYPRUS1, QUAI_ORCHARD_CYPRUS1 } from "../../src/quai/networks.ts";
import { WQUAI_ADDRESS, WQI_ADDRESS } from "../../src/quai/tokens.ts";
import { SIM_VENDOR_ADDRESS, SIM_MERCHANT_ADDRESS, SIM_RELAYER_ADDRESS } from "../../src/sim/defaults.ts";
import { FakeQuai } from "./agentFakeChain.ts";

const ONE = 10n ** 18n;
const ME = "0x004E3d0a19fA256E0A8903528605dE5acD8Faa72";
const ACME = SIM_VENDOR_ADDRESS;
const wallet = { address: ME, chainId: 9 };
const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup(o: { fetcher?: (url: string, init?: { headers?: Record<string, string> }) => Promise<Fetched>; now?: () => number } = {}) {
  const chain = new FakeQuai();
  chain.setNative(ME, 100n * ONE);
  chain.setToken(WQUAI_ADDRESS, ME, 50n * ONE);
  chain.setToken(WQI_ADDRESS, ME, 20n * ONE);
  const book = new AgentBook();
  book.addContact("Acme Corp", ACME);
  const agent = new VoiceAgent({ book, rpcFactory: (n) => chain.rpc(n), fetcher: o.fetcher, now: o.now });
  return { chain, book, agent };
}

/** The user's wallet: sends what the plan says, after confirmation. */
async function signAndReport(chain: FakeQuai, agent: VoiceAgent, plan: any, tweak: Parameters<FakeQuai["send"]>[1] = {}) {
  const tx = plan.txs[0];
  const hash = chain.send({ from: plan.from, to: tx.to, data: tx.data, value: tx.value }, tweak);
  return { hash, r: await agent.report(plan.id, 0, hash) };
}

describe("voice agent: the grammar", () => {
  it("turns spoken numbers into exact decimals, and refuses to add up a digit string", () => {
    const n = (s: string) => normalizeNumbers(s.split(" ")).join(" ");
    assert.equal(n("two and a half"), "2.5");
    assert.equal(n("one hundred and twenty three"), "123");
    assert.equal(n("zero point zero five"), "0.05");
    assert.equal(n("a thousand"), "1000");
    assert.equal(n("four one seven"), "4 1 7", "a code, not 12");
  });

  it("understands the closed list, the way people say it", () => {
    const k = (s: string) => {
      const r = parseCommand(s);
      return r.ok ? r.intent : { code: r.code };
    };
    assert.deepEqual(k("What's my balance?"), { kind: "balance" });
    assert.deepEqual(k("how much wrapped qi do I have"), { kind: "balance", asset: "WQI" });
    assert.deepEqual(k("Hey agent, wrap five QUAI please"), { kind: "wrap", amount: "5" });
    assert.deepEqual(k("unwrap 2.5 W Quai"), { kind: "unwrap", amount: "2.5" });
    assert.deepEqual(k("Send 10 W-Quai to Acme Corp."), { kind: "send", asset: "WQUAI", amount: "10", to: "acme corp" });
    assert.deepEqual(k("pay acme corp three WQI"), { kind: "send", asset: "WQI", amount: "3", to: "acme corp" });
    assert.deepEqual(k("buy the analytics report"), { kind: "buy", service: "analytics report" });
    assert.deepEqual(k("confirm four one seven"), { kind: "confirm", code: "417" });
    assert.deepEqual(k("never mind"), { kind: "cancel" });
  });

  it("reads what the local Whisper model actually wrote for spoken commands", () => {
    // Transcripts of synthesized speech by faster-whisper base.en with the worker's prompt (2026-10-04)
    const k = (s: string) => {
      const r = parseCommand(s);
      return r.ok ? r.intent : { code: r.code };
    };
    assert.deepEqual(k("Hey Agent, what's my balance?"), { kind: "balance" });
    assert.deepEqual(k("How much Quai do I have?"), { kind: "balance", asset: "QUAI" });
    assert.deepEqual(k("Send 2WQUAI to Acme Corp."), { kind: "send", asset: "WQUAI", amount: "2", to: "acme corp" });
    assert.deepEqual(k("Pay Acme Corp 3WQI."), { kind: "send", asset: "WQI", amount: "3", to: "acme corp" });
    assert.deepEqual(k("Wrap 12.5 QUAI"), { kind: "wrap", amount: "12.5" });
    assert.deepEqual(k("Unwrap 2 ½ WQUAI."), { kind: "unwrap", amount: "2.5" });
    assert.deepEqual(k("unwrap 2½ WQUAI"), { kind: "unwrap", amount: "2.5" });
    assert.deepEqual(k("send ¾ WQI to Acme Corp"), { kind: "send", asset: "WQI", amount: "0.75", to: "acme corp" });
    assert.deepEqual(k("Confirm 929."), { kind: "confirm", code: "929" });
    // a mishearing is refused, never stretched into something plausible ("5K" is neither 5 QUAI nor 5,000)
    assert.equal((parseCommand("Wrap 5K") as { code?: string }).code, "WRAP_NOT_UNDERSTOOD");
    assert.equal((parseCommand("Send 2 WQAI to Acme Corp.") as { code?: string }).code, "NOT_UNDERSTOOD");
    assert.equal((parseCommand("send 2.5½ wqi to acme") as { ok: boolean }).ok, false);
  });

  it("refuses what it must not guess: a spend without an asset or recipient, zero, Qi, shielded or private operations", () => {
    const code = (s: string) => (parseCommand(s) as { code?: string }).code;
    assert.equal(code("send five to acme"), "NEED_ASSET");
    assert.equal(code("send 5 wquai"), "NEED_RECIPIENT");
    assert.equal(code("send 0 quai to acme"), "AMOUNT_ZERO");
    assert.equal(code("send 5 qi to acme"), "QI_LEDGER_UNSUPPORTED");
    assert.equal(code("shield 10 WQI"), "SHIELD_NOT_AVAILABLE");
    assert.equal(code("privately pay acme 5 wquai"), "PRIVATE_NOT_AVAILABLE");
    assert.equal(code("yes"), "CONFIRM_NEEDS_CODE", "a bare yes never confirms anything");
    assert.equal(code("drain the pool"), "NOT_UNDERSTOOD");
    assert.equal(code("send 5 @WQUAI to @QUAI"), "NEED_RECIPIENT", "typed asset markers are stripped, not trusted");
  });
});

describe("voice agent: the book", () => {
  it("accepts only Cyprus-1 Quai-ledger addresses, and names that cannot be confused with commands", () => {
    const book = new AgentBook();
    assert.throws(() => book.addContact("Remote", "0x1054328ef0070fceeea0a22bb01fa5f6614098ef"), /ERR_CONTACT_ADDRESS.*WRONG_ZONE/);
    assert.throws(() => book.addContact("Utxo", "0x0084328ef0070fceeea0a22bb01fa5f6614098ef"), /ERR_CONTACT_ADDRESS.*QI_LEDGER/);
    assert.throws(() => book.addContact("WQUAI", ACME), /ERR_NAME/);
    assert.throws(() => book.addContact("me", ACME), /ERR_NAME/);
    book.addContact("Acme Corp", ACME);
    assert.throws(() => book.addContact("ACME corp.", SIM_MERCHANT_ADDRESS), /ERR_CONTACT_EXISTS/, "same name in another spelling");
    assert.equal(book.findContact("acme corp").contact?.address, ACME);
    assert.deepEqual(book.findContact("acme corb").nearby, ["Acme Corp"], "a near miss is suggested, never picked");
    assert.equal(book.findContact("acme corb").contact, null);
  });

  it("services need an http(s) URL without credentials, an ERC-20 asset and a price ceiling", () => {
    const book = new AgentBook();
    assert.throws(() => book.addService("x", "ftp://a/b", "1", "WQUAI"), /ERR_SERVICE_URL/);
    assert.throws(() => book.addService("x", "https://user:pw@a/b", "1", "WQUAI"), /ERR_SERVICE_URL/);
    assert.throws(() => book.addService("x", "https://a/b", "1", "QUAI"), /ERR_SERVICE_ASSET/);
    assert.throws(() => book.addService("x", "https://a/b", "0", "WQUAI"), /ERR_LIMIT_VALUE/);
    assert.equal(book.addService("analytics report", "https://api.example/x", "2.5", "wquai").maxAmount, "2.5");
  });

  it("limits: per action, and a 24 h total that accumulates across confirmed spends", () => {
    const book = new AgentBook();
    book.setPolicy({ perAction: { WQUAI: "10" }, daily: { WQUAI: "15" } });
    assert.throws(() => book.assertWithinLimits("WQUAI", "t", 11n * ONE), /ERR_LIMIT_PER_ACTION/);
    book.assertWithinLimits("WQUAI", "t", 10n * ONE);
    book.recordSpend("t", 10n * ONE);
    assert.throws(() => book.assertWithinLimits("WQUAI", "t", 6n * ONE), /ERR_LIMIT_DAILY/);
    assert.throws(() => book.setPolicy({ perAction: { QUAI: "500" } }), /ERR_POLICY.*above its daily/);
  });

  it("survives a restart through its store, and the store can be the encrypted snapshot store", () => {
    let saved: string | null = null;
    const mem: BookStore = { load: () => saved, save: (j) => void (saved = j) };
    const a = new AgentBook(mem);
    a.addContact("Acme Corp", ACME);
    a.recordSpend("t", 3n * ONE);
    const b = new AgentBook(mem);
    assert.equal(b.listContacts()[0].address, ACME);
    assert.equal(b.spentToday("t"), 3n * ONE);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-agent-book-"));
    dirs.push(dir);
    const open = () => EncryptedStore.open({ dir, passphrase: "correct horse battery staple", kdf: { N: 1 << 12, r: 8, p: 1 }, keep: 3 });
    new AgentBook(encryptedBookStore(open())).addContact("Acme Corp", ACME);
    assert.equal(new AgentBook(encryptedBookStore(open())).findContact("acme corp").contact?.address, ACME);
    const onDisk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
    assert.ok(!onDisk.toLowerCase().includes(ACME.slice(2).toLowerCase()), "the address book is encrypted at rest");
  });
});

describe("voice agent: answers and plans", () => {
  it("needs a connected wallet on the right chain before reading or spending", async () => {
    const { agent } = setup();
    assert.equal((await agent.say("what's my balance", { network: QUAI_CYPRUS1 }) as any).code, "WALLET_NOT_CONNECTED");
    assert.equal((await agent.say("what's my balance", { network: QUAI_CYPRUS1, wallet: { address: ME, chainId: 15000 } }) as any).code, "WALLET_WRONG_CHAIN");
    const r = await agent.say("what's my balance", { network: QUAI_CYPRUS1, wallet });
    assert.equal(r.type, "answer");
    assert.match(r.say, /100 QUAI, 50 WQUAI, 20 WQI/);
  });

  it("plans a token payment to a saved contact: the exact transfer, simulated, with a 3-digit code", async () => {
    const { agent, chain } = setup();
    const r = await agent.say("send 10 wquai to acme corp", { network: QUAI_CYPRUS1, wallet });
    assert.equal(r.type, "plan");
    const plan = (r as any).plan;
    assert.match(plan.code, /^[1-9]{3}$/);
    assert.equal(plan.txs.length, 1);
    assert.equal(plan.txs[0].to.toLowerCase(), WQUAI_ADDRESS.toLowerCase());
    const decoded = ERC20.decodeFunctionData("transfer", plan.txs[0].data);
    assert.equal(String(decoded[0]).toLowerCase(), ACME.toLowerCase());
    assert.equal(decoded[1], 10n * ONE);
    assert.ok(chain.calls.some((c) => c.method === "quai_createAccessList"), "simulated before it was offered");
    assert.ok(plan.txs[0].accessList.length >= 1, "the access list goes to the wallet");
    assert.match(r.say, /confirm \d \d \d/);
  });

  it("refuses before offering: an unknown contact (with suggestions), too little balance, a limit, a self-payment, a failing simulation", async () => {
    const { agent, chain, book } = setup();
    const say = (t: string) => agent.say(t, { network: QUAI_CYPRUS1, wallet }) as Promise<any>;
    const unknown = await say("send 1 wquai to acme corb");
    assert.equal(unknown.code, "CONTACT_UNKNOWN");
    assert.deepEqual(unknown.nearby, ["Acme Corp"]);
    assert.equal((await say("send 21 wqi to acme corp")).code, "INSUFFICIENT_TOKEN");
    assert.equal((await say("send 99.99 quai to acme corp")).code, "LIMIT_PER_ACTION");
    book.addContact("Treasury", ME);
    assert.equal((await say("send 1 quai to treasury")).code, "SELF_SEND");
    assert.match((await say("send 26 wquai to acme corp")).say, /per-action limit of 25 WQUAI/);
    chain.failSimulation = "execution reverted";
    assert.equal((await say("send 1 wquai to acme corp")).code, "SIMULATION_FAILED");
  });

  it("native QUAI: the balance must cover the value plus the largest possible fee", async () => {
    const { agent, chain, book } = setup();
    book.setPolicy({ perAction: { QUAI: "1000" }, daily: { QUAI: "1000" } });
    chain.setNative(ME, 10n * ONE);
    const r = (await agent.say("send 10 quai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(r.code, "INSUFFICIENT_QUAI");
    const ok = (await agent.say("send 9 quai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(ok.type, "plan");
    assert.equal(BigInt(ok.plan.txs[0].value), 9n * ONE);
  });

  it("wrap and unwrap call WQUAI's deposit and withdraw", async () => {
    const { agent } = setup();
    const w = (await agent.say("wrap 3 quai", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(WRAPPER.parseTransaction({ data: w.plan.txs[0].data, value: w.plan.txs[0].value })?.name, "deposit");
    assert.equal(BigInt(w.plan.txs[0].value), 3n * ONE);
    const u = (await agent.say("unwrap 2 wquai", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(WRAPPER.decodeFunctionData("withdraw", u.plan.txs[0].data)[0], 2n * ONE);
    assert.equal(((await agent.say("unwrap 60 wquai", { network: QUAI_CYPRUS1, wallet })) as any).code, "INSUFFICIENT_TOKEN");
  });

  it("on Orchard there is no WQUAI/WQI to plan with, and it says so", async () => {
    const { agent, chain } = setup();
    chain.chainId = "0x3a98";
    const r = (await agent.say("send 1 wquai to acme corp", { network: QUAI_ORCHARD_CYPRUS1, wallet: { address: ME, chainId: 15000 } })) as any;
    assert.equal(r.code, "ASSET_NOT_ON_NETWORK");
  });
});

describe("voice agent: confirm, sign, verify", () => {
  it("the whole loop: spoken confirmation, the wallet sends, the receipt matches, the spend counts", async () => {
    const { agent, chain, book } = setup();
    const offered = (await agent.say("send 10 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    const wrongCode = (await agent.say(`confirm ${offered.plan.code === "111" ? "222" : "111"}`, { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(wrongCode.code, "CODE_MISMATCH");
    const confirmed = (await agent.say(`confirm ${offered.plan.code.split("").join(" ")}`, { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(confirmed.type, "confirmed");
    const { r } = await signAndReport(chain, agent, offered.plan);
    assert.equal(r.status, "done");
    assert.equal(chain.tokenBalance(WQUAI_ADDRESS, ACME), 10n * ONE);
    assert.equal(book.spentToday(WQUAI_ADDRESS.toLowerCase()), 10n * ONE);
    assert.equal(book.recentActivity(1)[0].status, "done");
  });

  it("nothing is accepted for signing before confirmation, and a confirmed plan cannot be confirmed again", async () => {
    const { agent, chain } = setup();
    const offered = (await agent.say("send 1 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    const hash = chain.send({ from: ME, to: offered.plan.txs[0].to, data: offered.plan.txs[0].data });
    await assert.rejects(agent.report(offered.plan.id, 0, hash), /only a confirmed plan/);
    agent.confirm(offered.plan.id, offered.plan.code, wallet);
    assert.throws(() => agent.confirm(offered.plan.id, offered.plan.code, wallet), /not waiting for confirmation/);
  });

  it("a plan expires; a changed wallet cannot confirm it; a newer request replaces it", async () => {
    let now = Date.now();
    const { agent } = setup({ now: () => now });
    const a = (await agent.say("send 1 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.throws(() => agent.confirm(a.plan.id, a.plan.code, { address: SIM_MERCHANT_ADDRESS, chainId: 9 }), /account or network changed/);
    now += 181_000;
    assert.throws(() => agent.confirm(a.plan.id, a.plan.code, wallet), /expired/);
    const b = (await agent.say("send 2 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    const c = (await agent.say("send 3 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(agent.plan(b.plan.id).state, "cancelled", "'confirm' must always mean the plan just read back");
    const voice = (await agent.say(`confirm ${c.plan.code}`, { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(voice.plan.id, c.plan.id);
  });

  it("a receipt that differs from the plan fails it and counts nothing: wrong sender, wrong recipient, too little, reverted", async () => {
    for (const [tweak, why] of [
      [{ sender: SIM_RELAYER_ADDRESS }, /sent by/],
      [{ transferTo: SIM_MERCHANT_ADDRESS }, /moved 0\.0/],
      [{ transferAmount: 1n }, /moved 0\.000000000000000001/],
      [{ revert: true }, /reverted/]
    ] as const) {
      const { agent, chain, book } = setup();
      const offered = (await agent.say("send 5 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
      agent.confirm(offered.plan.id, offered.plan.code, wallet);
      const { r } = await signAndReport(chain, agent, offered.plan, tweak as any);
      assert.equal(r.status, "failed", String(why));
      assert.match(r.say, why);
      assert.equal(book.spentToday(WQUAI_ADDRESS.toLowerCase()), 0n, "a failed plan is not counted");
    }
  });

  it("pending until mined; one hash per step; native sends are checked against the transaction itself", async () => {
    const { agent, chain } = setup();
    const offered = (await agent.say("send 1 quai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    agent.confirm(offered.plan.id, offered.plan.code, wallet);
    const tx = offered.plan.txs[0];
    const hash = chain.send({ from: ME, to: tx.to, data: tx.data, value: tx.value }, { pending: true });
    assert.equal((await agent.report(offered.plan.id, 0, hash)).status, "pending");
    await assert.rejects(agent.report(offered.plan.id, 0, "0x" + "ab".repeat(32)), /different transaction was already reported/);
    chain.mine(hash, { from: ME, to: tx.to, logs: [], status: "0x1" });
    assert.equal((await agent.report(offered.plan.id, 0, hash)).status, "done");

    const second = (await agent.say("send 1 quai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    agent.confirm(second.plan.id, second.plan.code, wallet);
    const h2 = chain.send({ from: ME, to: second.plan.txs[0].to, data: "0x", value: "0x" + (2n * ONE).toString(16) });
    const r2 = await agent.report(second.plan.id, 0, h2);
    assert.equal(r2.status, "failed", "the wallet sent 2 QUAI where the plan said 1");
  });

  it("cancel: by voice or by id, only while nothing has been sent", async () => {
    const { agent, chain } = setup();
    const a = (await agent.say("send 1 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal((await agent.say("cancel", { network: QUAI_CYPRUS1, wallet })).type, "cancelled");
    assert.throws(() => agent.confirm(a.plan.id, a.plan.code, wallet), /cancelled/);
    const b = (await agent.say("send 1 wquai to acme corp", { network: QUAI_CYPRUS1, wallet })) as any;
    agent.confirm(b.plan.id, b.plan.code, wallet);
    await signAndReport(chain, agent, b.plan);
    assert.throws(() => agent.cancel(b.plan.id), /no longer be cancelled/);
  });
});

describe("voice agent: buying an x402 resource", () => {
  const SERVICE_URL = "https://data.example/api/v1/protected/analytics";
  function merchant(o: { amount?: bigint; token?: string; ttl?: number; network?: typeof QUAI_CYPRUS1; confirmationsNeeded?: number } = {}) {
    const recipient = SIM_MERCHANT_ADDRESS;
    let presented = 0;
    const seen: Array<Record<string, string> | undefined> = [];
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }): Promise<Fetched> => {
      seen.push(init?.headers);
      if (init?.headers?.["X-Payment-Proof"]) {
        presented++;
        if (presented <= (o.confirmationsNeeded ?? 0)) return { status: 402, headers: {}, contentType: "application/json", body: '{"error":"ERR_PAYMENT_UNCONFIRMED"}', truncated: false };
        return { status: 200, headers: { "content-type": "application/json" }, contentType: "application/json", body: '{"activeUsers":48291}', truncated: false };
      }
      const now = Math.floor(Date.now() / 1000);
      const c = buildQuaiChallenge({ network: o.network ?? QUAI_CYPRUS1, invoiceId: "inv_test_1", resourceUri: new URL(url).pathname, recipient, tokenAddress: o.token ?? WQUAI_ADDRESS, tokenSymbol: "WQUAI", tokenDecimals: 18, amount: o.amount ?? 2n * ONE, createdAt: now, expiresAt: now + (o.ttl ?? 900) });
      return { status: 402, headers: Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v])), contentType: "application/problem+json", body: JSON.stringify(c.body), truncated: false };
    };
    return { fetcher, seen, recipient };
  }

  it("asks the price, checks it against the saved ceiling, pays it, presents the proof and returns the resource", async () => {
    const m = merchant({ confirmationsNeeded: 1 });
    const { agent, chain, book } = setup({ fetcher: m.fetcher });
    book.addService("analytics report", SERVICE_URL, "2.5", "WQUAI");
    const offered = (await agent.say("buy the analytics report", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(offered.type, "plan", offered.say);
    assert.equal(offered.plan.buy.invoiceId, "inv_test_1");
    assert.equal(String(ERC20.decodeFunctionData("transfer", offered.plan.txs[0].data)[0]).toLowerCase(), m.recipient.toLowerCase());
    agent.confirm(offered.plan.id, offered.plan.code, wallet);
    const { hash, r } = await signAndReport(chain, agent, offered.plan);
    assert.equal(r.status, "paid", "the merchant still wanted a confirmation");
    const done = await agent.collect(offered.plan.id);
    assert.equal(done.status, "done");
    assert.equal(done.result?.body, '{"activeUsers":48291}');
    assert.equal(m.seen.at(-1)?.["X-Payment-Proof"], hash, "the proof is the payment's own transaction hash");
    assert.equal(m.seen.at(-1)?.["X-Payment-Invoice-Id"], "inv_test_1");
  });

  it("refuses a price above the ceiling, another token, another network, an invoice about to expire, and an unknown service", async () => {
    const cases: Array<[Parameters<typeof merchant>[0], RegExp]> = [
      [{ amount: 3n * ONE }, /above the 2\.5 WQUAI you allowed/],
      [{ token: WQI_ADDRESS }, /wants WQI; you allowed it to charge WQUAI only/],
      [{ network: QUAI_ORCHARD_CYPRUS1 }, /wants payment on quai-orchard-cyprus1/],
      [{ ttl: 60 }, /expires in under 3 minutes/]
    ];
    for (const [o, why] of cases) {
      const m = merchant(o);
      const { agent, book } = setup({ fetcher: m.fetcher });
      book.addService("analytics report", SERVICE_URL, "2.5", "WQUAI");
      const r = (await agent.say("buy the analytics report", { network: QUAI_CYPRUS1, wallet })) as any;
      assert.equal(r.type, "refusal", String(why));
      assert.match(r.say, why);
    }
    const { agent } = setup({ fetcher: merchant().fetcher });
    assert.equal(((await agent.say("buy the weather", { network: QUAI_CYPRUS1, wallet })) as any).code, "SERVICE_UNKNOWN");
  });

  it("a free resource is returned without a plan", async () => {
    const fetcher = async (): Promise<Fetched> => ({ status: 200, headers: {}, contentType: "text/plain", body: "hello", truncated: false });
    const { agent, book } = setup({ fetcher });
    book.addService("greeting", "https://data.example/hi", "1", "WQUAI");
    const r = (await agent.say("get the greeting", { network: QUAI_CYPRUS1, wallet })) as any;
    assert.equal(r.type, "answer");
    assert.equal(r.data.resource.body, "hello");
  });
});
