// DarkCircle: the voice agent page. Vanilla ES module; renders text nodes only, never HTML strings.
//
// Talk (or type) -> the server turns it into one intent -> an answer, a refusal, or a PLAN of real Quai
// transactions. A plan is read back with a 3-digit code and runs only after you confirm it here (click, or say
// "confirm 4 1 7") AND approve each transaction in your own wallet. The server never holds a key.
//
// Speech-to-text runs on this machine by default (Whisper). The browser's own recognition is an opt-in: in
// Chrome it sends the audio to Google, which is why it is off unless you turn it on.

import * as wallet from "./wallet.js";

const MAX_RECORD_MS = 15_000;
const POLL_MS = 4_000;
const ENGINE_KEY = "darkcircle-voice-engine";
const SPEAK_KEY = "darkcircle-voice-speak";
const NET_KEY = "darkcircle-agent-network";

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: per-session only */ } }
};

export function mountAgent({ api, h, put, toast, short, root }) {
  const token = document.querySelector('meta[name="darkcircle-session"]')?.content ?? "";
  const S = {
    loaded: false,
    info: null,
    network: store.get(NET_KEY, "quai-cyprus1"),
    wallet: null,
    engine: store.get(ENGINE_KEY, "local"),
    speak: store.get(SPEAK_KEY, "1") === "1",
    recording: null,
    busy: false,
    heard: "",
    reply: null,
    plan: null,
    steps: [],
    result: null
  };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  if (S.engine === "browser" && !SR) S.engine = "local";

  /* ------------------------------------------------------------ data */
  async function load() {
    try {
      S.info = await api("/api/agent/state");
      if (!S.info.networks.some((n) => n.id === S.network)) S.network = S.info.networks[0].id;
      S.loaded = true;
    } catch (e) {
      toast(`Voice agent: ${e.message}`, "bad");
    }
    render();
  }
  const net = () => S.info?.networks.find((n) => n.id === S.network);

  /* ------------------------------------------------------------ wallet */
  async function connectWallet() {
    if (!wallet.isWalletAvailable()) return toast("No Quai wallet found. Install Pelagus, or open this page in Blip.", "bad");
    try {
      const address = await wallet.connect();
      const chainId = await wallet.chainId();
      S.wallet = { address, chainId, name: wallet.getWalletName() };
    } catch (e) {
      toast(e.message, "bad");
    }
    render();
  }
  async function freshWallet() {
    if (!S.wallet) return null;
    try {
      const now = await wallet.current();
      S.wallet = now.address ? { ...S.wallet, address: now.address, chainId: now.chainId } : null;
    } catch {
      /* keep the last known */
    }
    return S.wallet ? { address: S.wallet.address, chainId: S.wallet.chainId } : null;
  }

  /* ------------------------------------------------------------ speech out (local voices only) */
  function speak(text) {
    if (!S.speak || !window.speechSynthesis || !text) return;
    const local = speechSynthesis.getVoices().filter((v) => v.localService && /^en/i.test(v.lang));
    if (!local.length) return; // a network voice would send the reply to a third party
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = local[0];
    speechSynthesis.speak(u);
  }

  /* ------------------------------------------------------------ one turn */
  async function sayText(text) {
    const t = String(text || "").trim();
    if (!t || S.busy) return;
    S.busy = true;
    S.heard = t;
    render();
    try {
      const reply = await api("/api/agent/say", { text: t, network: S.network, wallet: await freshWallet() });
      S.reply = reply;
      if (reply.type === "plan") {
        S.plan = reply.plan;
        S.steps = [];
        S.result = null;
      } else if (reply.type === "confirmed") {
        S.plan = reply.plan;
        speak(reply.say);
        S.busy = false;
        render();
        return execute(reply.plan, true);
      } else if (reply.type === "cancelled") {
        S.plan = null;
        S.steps = [];
      }
      speak(reply.say);
    } catch (e) {
      S.reply = { type: "refusal", say: e.message, code: e.code };
    }
    S.busy = false;
    await refreshActivity();
    render();
  }

  /* ------------------------------------------------------------ microphone */
  async function startRecording() {
    if (S.recording || S.busy) return;
    if (S.engine === "browser") return startBrowserRecognition();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      return toast(`Microphone: ${e.message}`, "bad");
    }
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(S.recording?.tick);
      clearTimeout(S.recording?.limit);
      S.recording = null;
      const blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
      render();
      await transcribe(blob);
    };
    S.recording = { rec, started: Date.now(), tick: setInterval(updateTicks, 500), limit: setTimeout(() => rec.state !== "inactive" && rec.stop(), MAX_RECORD_MS) };
    rec.start();
    render();
  }
  function stopRecording() {
    const r = S.recording;
    if (!r) return;
    if (r.rec) r.rec.state !== "inactive" && r.rec.stop();
    else if (r.recognition) r.recognition.stop();
  }
  async function transcribe(blob) {
    if (!blob.size) return toast("Nothing was recorded.", "bad");
    S.busy = true;
    S.heard = "…";
    render();
    try {
      const res = await fetch("/api/voice/transcribe", { method: "POST", headers: { "X-DarkCircle-Session": token, "Content-Type": blob.type.split(";")[0] || "audio/webm" }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || res.statusText);
      S.busy = false;
      if (!data.text) {
        S.heard = "";
        toast("Nothing intelligible was heard. Try again a little closer to the microphone.", "bad");
        render();
        return;
      }
      await sayText(data.text);
    } catch (e) {
      S.busy = false;
      S.heard = "";
      toast(`Speech: ${e.message}`, "bad");
      await refreshInfo();
      render();
    }
  }
  function startBrowserRecognition() {
    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e) => sayText(e.results[0][0].transcript);
    recognition.onerror = (e) => toast(`Browser speech: ${e.error}`, "bad");
    recognition.onend = () => {
      clearInterval(S.recording?.tick);
      S.recording = null;
      render();
    };
    S.recording = { recognition, started: Date.now(), tick: setInterval(updateTicks, 500) };
    recognition.start();
    render();
  }

  /* ------------------------------------------------------------ executing a plan */
  const step = (text, kind = "info", link) => {
    S.steps.push({ text, kind, link });
    render();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function confirmClick() {
    if (!S.plan) return;
    await execute(S.plan, false);
  }

  /** Steps 2 to 4. `alreadyConfirmed`: the server took a spoken "confirm <code>". */
  async function execute(plan, alreadyConfirmed) {
    S.busy = true;
    S.steps = [];
    render();
    try {
      const w = await freshWallet();
      if (!w || w.address.toLowerCase() !== plan.from.toLowerCase() || w.chainId !== plan.network.chainId) {
        throw new Error("Your wallet's account or network changed since this plan was made. Say the request again.");
      }
      if (!alreadyConfirmed) await api("/api/agent/confirm", { planId: plan.id, code: plan.code, wallet: w });
      step("Confirmed. Approve in your wallet.");
      for (let i = 0; i < plan.txs.length; i++) {
        const tx = plan.txs[i];
        step(`${S.wallet?.name || "Wallet"}: approve "${tx.label}"`);
        const hash = await wallet.sendTransaction({ from: plan.from, ...tx });
        step(`Sent ${short(hash, 10)}`, "info", `${plan.network.explorerUrl}/tx/${hash}`);
        let r = null;
        for (let n = 0; n < 90; n++) {
          r = await api("/api/agent/report", { planId: plan.id, index: i, txHash: hash });
          if (r.status !== "pending") break;
          await sleep(POLL_MS);
        }
        if (!r || r.status === "pending") throw new Error(`Not included after several minutes. ${short(hash, 10)} may still land; check the explorer before trying again.`);
        if (r.status === "failed") throw new Error(r.say);
        if (r.status === "paid") {
          step(r.say, "info");
          for (let n = 0; n < 30 && r.status === "paid"; n++) {
            await sleep(5_000);
            r = await api("/api/agent/collect", { planId: plan.id });
          }
        }
        if (r.status === "done") {
          step(r.say, "ok");
          speak(r.say);
          if (r.result) S.result = r.result;
        } else if (r.status === "paid") step("Paid; the service has not delivered yet. Its invoice and your payment stay valid: ask again later.", "warn");
        else if (r.status === "verified") step(r.say, "ok");
      }
    } catch (e) {
      step(e.message || String(e), "bad");
      speak(e.message);
    }
    S.busy = false;
    // the reply line ends on the outcome, not on "check your wallet"
    const last = S.steps[S.steps.length - 1];
    if (last) S.reply = { type: last.kind === "bad" ? "refusal" : "answer", say: last.text };
    await refreshActivity();
    render();
  }

  async function cancelPlan() {
    if (!S.plan) return;
    try {
      const r = await api("/api/agent/cancel", { planId: S.plan.id });
      S.reply = r;
      speak(r.say);
    } catch (e) {
      toast(e.message, "bad");
    }
    S.plan = null;
    S.steps = [];
    await refreshActivity();
    render();
  }

  async function refreshActivity() {
    try {
      S.info = await api("/api/agent/state");
    } catch {
      /* the next render shows what we have */
    }
  }
  const refreshInfo = refreshActivity;

  /* ------------------------------------------------------------ book editing */
  async function bookCall(path, body, okText) {
    try {
      await api(path, body);
      toast(okText, "ok");
      await refreshInfo();
      render();
      return true;
    } catch (e) {
      toast(e.message, "bad");
      return false;
    }
  }

  /* ------------------------------------------------------------ rendering */
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString();
  const kv = (rows) => h("dl", { class: "kv" }, rows.filter(Boolean).map(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)]));
  const statusBadge = (s) => h("span", { class: `badge ${s === "done" || s === "answered" ? "pass" : s === "failed" || s === "refused" ? "fail" : s === "cancelled" || s === "expired" ? "muted" : "warn"}`, text: s });

  function talkPanel() {
    const n = net();
    const voice = S.info?.voice;
    const rec = S.recording;
    const secs = rec ? Math.floor((Date.now() - rec.started) / 1000) : 0;
    const mic = h("button", {
      class: `mic${rec ? " on" : ""}`, type: "button", "aria-pressed": rec ? "true" : "false", disabled: S.busy && !rec,
      onclick: () => (rec ? stopRecording() : startRecording()),
      "aria-label": rec ? "Stop and send" : "Start talking"
    }, micIcon());
    const typed = h("input", { type: "text", id: "agent-typed", placeholder: "or type: send 5 WQUAI to Acme", autocomplete: "off", spellcheck: "false", "aria-label": "Type a command", disabled: S.busy });
    const sendTyped = () => {
      const v = typed.value;
      typed.value = "";
      sayText(v);
    };
    typed.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendTyped();
      }
    });
    const engineSeg = h("div", { class: "seg", role: "group", "aria-label": "Speech recognition" },
      h("button", { type: "button", "aria-pressed": S.engine === "local" ? "true" : "false", onclick: () => { S.engine = "local"; store.set(ENGINE_KEY, "local"); render(); }, text: "This machine" }),
      h("button", { type: "button", "aria-pressed": S.engine === "browser" ? "true" : "false", disabled: !SR, title: SR ? "" : "This browser has no speech recognition", onclick: () => {
        if (S.engine !== "browser" && !window.confirm("The browser's speech recognition sends your recording to its maker (Google, in Chrome). Use it anyway?")) return;
        S.engine = "browser"; store.set(ENGINE_KEY, "browser"); render();
      }, text: "Browser" })
    );
    const voiceNote = S.engine === "browser"
      ? h("div", { class: "callout warn", text: "Browser recognition is on: your recordings go to the browser's speech service (Google, in Chrome). Switch to 'This machine' to keep them local." })
      : voice && voice.state === "unavailable"
        ? h("div", { class: "callout warn" }, h("div", { text: `Speech on this machine: ${voice.reason || "not available"}.` }), voice.setup ? h("div", {}, "Install it once (about 145 MB, from Hugging Face) with ", h("code", { text: voice.setup }), ", then try again. Typing works meanwhile.") : null)
        : null;

    return h("section", { class: "panel agent-talk", "aria-label": "Talk to your agent" },
      h("div", { class: "agent-talk-head" },
        h("div", { class: "agent-live" }, h("span", { class: "badge fail", text: "LIVE" }), h("span", { text: n ? `${n.title}${n.testnet ? "" : " · real funds"}` : "" })),
        engineSeg
      ),
      voiceNote,
      h("div", { class: "agent-mic-row" },
        mic,
        h("div", { class: "agent-mic-text" },
          (ticks.status = h("strong", { text: rec ? `Listening… ${secs}s (click to send)` : S.busy ? "Working…" : "Click the microphone and speak" })),
          h("span", { class: "muted", text: "Say: what's my balance · send 5 WQUAI to Acme · wrap 2 QUAI · buy the analytics report · confirm 4 1 7 · cancel" })
        )
      ),
      h("div", { class: "agent-typed-row" }, typed, h("button", { class: "btn", type: "button", disabled: S.busy, onclick: sendTyped, text: "Send" })),
      S.heard ? h("p", { class: "agent-heard" }, h("span", { class: "muted", text: "You said " }), h("q", { text: S.heard })) : null,
      S.reply ? h("div", { class: `callout ${S.reply.type === "refusal" ? "bad" : S.reply.type === "plan" ? "warn" : "ok"}`, role: "status" },
        h("div", { text: S.reply.say })
      ) : null,
      S.plan ? planCard(S.plan) : null,
      S.result ? h("div", { class: "agent-result" }, h("div", { class: "panel-title", text: `Delivered (${S.result.contentType || "content"}${S.result.truncated ? ", truncated" : ""})` }), h("pre", { class: "resource", text: pretty(S.result.body) })) : null,
      h("label", { class: "check agent-speak" }, h("input", { type: "checkbox", checked: S.speak, onchange: (e) => { S.speak = e.target.checked; store.set(SPEAK_KEY, S.speak ? "1" : "0"); } }), h("span", { text: "Read replies aloud (on-device voices only)" }))
    );
  }

  function planBadge(running) {
    const last = S.steps[S.steps.length - 1];
    if (!running) return h("span", { class: "badge warn", text: "Needs your confirmation" });
    if (S.busy || !last) return h("span", { class: "badge warn", text: "In progress" });
    if (last.kind === "bad") return h("span", { class: "badge fail", text: "Failed" });
    if (last.kind === "ok") return h("span", { class: "badge pass", text: "Done" });
    return h("span", { class: "badge warn", text: "Waiting" });
  }

  function planCard(p) {
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    const running = S.busy || S.steps.length > 0;
    ticks.countdown = running ? null : h("span", { class: "muted", text: countdownText(p) });
    ticks.confirm = running ? null : h("button", { class: "btn primary", type: "button", disabled: left <= 0, onclick: confirmClick, text: "Confirm and open wallet" });
    const fee = (Number(BigInt(p.maxFeeWei)) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 });
    return h("div", { class: "plan-card", "aria-label": "Plan waiting for confirmation" },
      h("div", { class: "plan-head" }, planBadge(running), ticks.countdown),
      h("p", { class: "plan-summary", text: p.summary }),
      kv([...p.details.map((d) => [d.label, d.value]), ["Network", p.network.title], ["From", h("span", { class: "mono", text: p.from })], ["Network fee", `at most ${fee} QUAI`]]),
      running ? null : h("div", { class: "plan-code" }, h("span", { class: "muted", text: "Confirmation code" }), h("b", { text: p.code.split("").join(" ") })),
      running ? null : h("div", { class: "plan-actions" },
        ticks.confirm,
        h("button", { class: "btn", type: "button", onclick: cancelPlan, text: "Cancel" })
      ),
      S.steps.length ? h("ol", { class: "plan-steps" }, S.steps.map((s) => h("li", { class: s.kind }, s.link ? h("a", { href: s.link, target: "_blank", rel: "noopener noreferrer", text: s.text }) : s.text))) : null
    );
  }

  function walletPanel() {
    const n = net();
    const mismatch = S.wallet && n && S.wallet.chainId !== n.chainId;
    const netSelect = h("select", { "aria-label": "Network", onchange: (e) => { S.network = e.target.value; store.set(NET_KEY, S.network); S.plan = null; render(); } },
      (S.info?.networks ?? []).map((x) => h("option", { value: x.id, selected: x.id === S.network, text: `${x.title}${x.testnet ? " (testnet)" : ""}` })));
    return h("section", { class: "panel agent-box" },
      h("div", { class: "panel-title", text: "Wallet & network" }),
      h("div", { class: "agent-box-body" },
        h("div", { class: "field" }, h("label", { text: "Network" }), netSelect),
        S.wallet
          ? kv([["Wallet", S.wallet.name || "Quai wallet"], ["Account", h("span", { class: "mono", text: short(S.wallet.address, 10) })], ["Chain", String(S.wallet.chainId)]])
          : h("button", { class: "btn primary", type: "button", onclick: connectWallet, text: wallet.isWalletAvailable() ? "Connect wallet" : "No Quai wallet found" }),
        mismatch ? h("div", { class: "callout bad", text: `Your wallet is on chain ${S.wallet.chainId}; switch it to ${n.title} (chain ${n.chainId}).` }) : null
      )
    );
  }

  function contactsPanel() {
    const name = h("input", { type: "text", placeholder: "Name you will say, e.g. Acme", "aria-label": "Contact name", maxlength: "40" });
    const addr = h("input", { type: "text", class: "mono", placeholder: "0x00… (Cyprus-1 Quai address)", "aria-label": "Contact address", maxlength: "42" });
    const list = S.info?.contacts ?? [];
    return h("section", { class: "panel agent-box" },
      h("div", { class: "panel-title", text: "Contacts" }),
      h("div", { class: "agent-box-body" },
        list.length ? h("ul", { class: "agent-list" }, list.map((c) => h("li", {}, h("b", { text: c.name }), h("span", { class: "mono muted", text: short(c.address, 8) }),
          h("button", { class: "btn small ghost", type: "button", "aria-label": `Remove ${c.name}`, onclick: () => bookCall("/api/agent/contacts", { action: "remove", name: c.name }, `${c.name} removed`), text: "Remove" })))) : h("p", { class: "muted", text: "Voice never carries an address: save who you pay here, then say their name." }),
        h("div", { class: "agent-form" }, name, addr, h("button", { class: "btn small", type: "button", onclick: async () => { if (await bookCall("/api/agent/contacts", { action: "add", name: name.value, address: addr.value }, "Contact saved")) { name.value = ""; addr.value = ""; } }, text: "Add contact" }))
      )
    );
  }

  function servicesPanel() {
    const name = h("input", { type: "text", placeholder: "What you will say, e.g. analytics report", "aria-label": "Service name", maxlength: "40" });
    const url = h("input", { type: "text", class: "mono", placeholder: "https://… (an x402 endpoint)", "aria-label": "Service URL", maxlength: "400" });
    const max = h("input", { type: "text", placeholder: "Most per request, e.g. 2", "aria-label": "Maximum price per request", maxlength: "20" });
    const asset = h("select", { "aria-label": "Asset" }, ["WQUAI", "WQI"].map((a) => h("option", { value: a, text: a })));
    const list = S.info?.services ?? [];
    return h("section", { class: "panel agent-box" },
      h("div", { class: "panel-title", text: "Paid services (x402)" }),
      h("div", { class: "agent-box-body" },
        list.length ? h("ul", { class: "agent-list" }, list.map((s) => h("li", {}, h("b", { text: s.name }), h("span", { class: "muted", text: `≤ ${s.maxAmount} ${s.asset}` }),
          h("button", { class: "btn small ghost", type: "button", "aria-label": `Remove ${s.name}`, onclick: () => bookCall("/api/agent/services", { action: "remove", name: s.name }, `${s.name} removed`), text: "Remove" })))) : h("p", { class: "muted", text: "Add an endpoint that answers HTTP 402, and the most you will pay per request. Say 'buy the <name>'." }),
        h("div", { class: "agent-form" }, name, url, h("div", { class: "agent-form-row" }, max, asset), h("button", { class: "btn small", type: "button", onclick: async () => { if (await bookCall("/api/agent/services", { action: "add", name: name.value, url: url.value, maxAmount: max.value, asset: asset.value }, "Service saved")) { name.value = ""; url.value = ""; max.value = ""; } }, text: "Add service" }))
      )
    );
  }

  function limitsPanel() {
    const p = S.info?.policy;
    if (!p) return null;
    const inputs = {};
    const rows = ["QUAI", "WQUAI", "WQI"].map((a) => {
      inputs[a] = { per: h("input", { type: "text", value: p.perAction[a], "aria-label": `${a} per action`, maxlength: "20" }), day: h("input", { type: "text", value: p.daily[a], "aria-label": `${a} per day`, maxlength: "20" }) };
      return h("tr", {}, h("th", { scope: "row", text: a }), h("td", {}, inputs[a].per), h("td", {}, inputs[a].day));
    });
    return h("section", { class: "panel agent-box" },
      h("div", { class: "panel-title", text: "Spending limits" }),
      h("div", { class: "agent-box-body" },
        h("table", { class: "agent-limits" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Asset" }), h("th", { scope: "col", text: "Per action" }), h("th", { scope: "col", text: "Per 24 h" }))), h("tbody", {}, rows)),
        h("button", { class: "btn small", type: "button", onclick: () => bookCall("/api/agent/policy", { perAction: Object.fromEntries(Object.entries(inputs).map(([a, i]) => [a, i.per.value])), daily: Object.fromEntries(Object.entries(inputs).map(([a, i]) => [a, i.day.value])) }, "Limits saved"), text: "Save limits" }),
        h("p", { class: "muted", text: "Every spend is also confirmed by you and by your wallet; these limits stop anything larger before it is even offered." })
      )
    );
  }

  function activityPanel() {
    const list = S.info?.activity ?? [];
    const n = net();
    return h("section", { class: "panel agent-box" },
      h("div", { class: "panel-title", text: "Activity" }),
      h("div", { class: "agent-box-body" },
        list.length ? h("ul", { class: "agent-activity" }, list.slice(0, 15).map((e) => h("li", {},
          h("div", { class: "agent-activity-top" }, statusBadge(e.status), h("span", { class: "muted", text: fmtTime(e.at) })),
          h("div", { text: e.summary }),
          e.said ? h("div", { class: "muted" }, "“", e.said, "”") : null,
          ...(e.txHashes || []).filter(Boolean).map((tx) => h("a", { href: `${n?.explorerUrl ?? ""}/tx/${tx}`, target: "_blank", rel: "noopener noreferrer", class: "mono", text: short(tx, 10) }))
        ))) : h("p", { class: "muted", text: "Nothing yet." }),
        S.info && !S.info.persistent ? h("p", { class: "muted", text: "Contacts, services, limits and activity are kept in memory only. Start with --data-dir to keep them encrypted on disk." }) : null
      )
    );
  }

  const talkSlot = h("div", { class: "agent-talk-slot" });
  const sideSlot = h("div", { class: "agent-side" });

  /** Only the talk panel: what timers (recording, the plan's countdown) redraw, so side forms keep their input. */
  function renderTalk() {
    if (!S.loaded) return;
    const typed = document.getElementById("agent-typed");
    const value = typed?.value ?? "";
    const focused = document.activeElement === typed;
    put(talkSlot, talkPanel());
    const again = document.getElementById("agent-typed");
    if (again) {
      again.value = value;
      if (focused) again.focus();
    }
  }

  function render() {
    if (!root) return;
    if (!S.loaded) return put(root, h("p", { class: "muted", text: "Loading the voice agent…" }));
    if (!root.contains(talkSlot)) put(root, h("div", { class: "agent-grid" }, talkSlot, sideSlot));
    renderTalk();
    put(sideSlot, walletPanel(), contactsPanel(), servicesPanel(), limitsPanel(), activityPanel());
  }

  /** Timers only change text, never replace a button: a click spans mousedown to mouseup on the same element. */
  const ticks = { status: null, countdown: null, confirm: null };
  const countdownText = (p) => {
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    return left > 0 ? `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired";
  };
  function updateTicks() {
    if (S.recording && ticks.status) ticks.status.textContent = `Listening… ${Math.floor((Date.now() - S.recording.started) / 1000)}s (click to send)`;
    if (S.plan && ticks.countdown) {
      ticks.countdown.textContent = countdownText(S.plan);
      if (ticks.confirm && Date.now() > S.plan.expiresAt) ticks.confirm.disabled = true;
    }
  }
  setInterval(updateTicks, 1000);

  load();
  return { refresh: load };
}

function micIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "34", height: "34", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const [tag, attrs] of [["rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }], ["path", { d: "M5 11a7 7 0 0014 0M12 18v3" }]]) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries({ ...attrs, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" })) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

function pretty(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return String(body);
  }
}
