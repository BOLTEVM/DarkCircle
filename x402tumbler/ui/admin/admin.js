// DarkCircle admin console UI. ADMIN-ONLY, REDACTED BEFORE PRODUCTION (deleted with ui/admin by scripts/redact-admin.ts).
//
// Loaded only when the server enables the console. The admin session id lives in this module's memory: never in
// localStorage, a cookie or the URL, so closing the tab ends it. Everything is rendered as text nodes; no HTML
// strings are built. Secrets (the admin token, the store passphrase) are read from a field, sent once, and the
// field is cleared; they are never kept in state that outlives the request.
//
// On-chain deployment (Deploy plan tab) never signs or sends anything from here: this server only builds
// calldata and a gas budget and reads back what the chain actually did. The signature and the broadcast
// happen in the OPERATOR'S OWN wallet (Pelagus/Blip, see ./wallet.js), which shows its own confirmation UI.

import * as wallet from "/wallet.js";

const TABS = [
  ["overview", "Overview"],
  ["environment", "Environment"],
  ["persistence", "Persistence"],
  ["relayer", "Relayer"],
  ["pipeline", "Circuits & contracts"],
  ["deploy", "Deploy plan"],
  ["audit", "Audit log"]
];

const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`);
const fmtDur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

export function mountAdmin(ctx) {
  const { api, h, put, toast, copy, short, slot } = ctx;
  document.head.append(h("link", { rel: "stylesheet", href: "/admin/admin.css" }));

  const S = { session: null, tab: "overview", data: {}, job: null, log: [], next: 0, jobStatus: null, poll: null, queue: [], running: false, chain: {} };
  const dlg = h("dialog", { class: "admin-dialog", "aria-labelledby": "admin-title" });
  document.body.append(dlg);
  dlg.addEventListener("close", () => stopPoll());

  const btn = h("button", { class: "btn admin-btn", type: "button", onclick: open, title: "Admin console (development only)" }, h("span", { class: "dot", "aria-hidden": "true" }), "Admin");
  put(slot, btn);

  /* ---------------------------------------------------------------- plumbing */
  async function call(path, body) {
    try {
      const r = await api(path, body, S.session ? { "X-DarkCircle-Admin": S.session.id } : {});
      if (S.session && r && r.session) S.session.expiresAt = r.session.expiresAt;
      return r;
    } catch (e) {
      if (e.code === "ADMIN_REQUIRED" && S.session) {
        S.session = null;
        stopPoll();
        btn.classList.remove("signed-in");
        render();
        toast("The admin session ended; sign in again", "bad");
      }
      throw e;
    }
  }

  const body = () => document.getElementById("admin-body");
  const paint = (...nodes) => { const b = body(); if (b) put(b, ...nodes); };
  const banner = (kind, ...kids) => h("div", { class: `banner ${kind}` }, ...kids);
  const pill = (state, text) => h("span", { class: `pill ${state}`, text: text ?? state });
  const box = (...kids) => h("div", { class: "box" }, ...kids);
  const dangerBox = (...kids) => h("div", { class: "box danger-zone" }, ...kids);
  const kv = (rows) => h("dl", { class: "kvline" }, rows.filter(Boolean).map(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)]));
  const field = (label, control, help, id) => h("div", { class: "admin-field" }, h("label", { for: id, text: label }), control, help ? h("div", { class: "help", text: help }) : null);
  const input = (id, o = {}) => h("input", { id, type: o.type ?? "text", autocomplete: o.type === "password" ? "new-password" : "off", spellcheck: "false", placeholder: o.placeholder ?? "", value: o.value ?? "", class: o.mono ? "mono" : "" });
  const errBox = (e) => banner("bad", h("strong", { text: "Refused. " }), e.message ?? String(e));
  const checkList = (checks) => h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : c.fatal === false ? "soft" : "no" }, h("span", { class: "m", "aria-hidden": "true", text: c.ok ? "✓" : c.fatal === false ? "!" : "✕" }), h("span", {}, h("span", { class: "sr", text: c.ok ? "Passed: " : "Failed: " }), c.id ? `${c.id}  ` : "", c.detail ?? c.title ?? ""))));

  function open() {
    render();
    if (!dlg.open) dlg.showModal();
  }

  function signOut() {
    call("/api/admin/logout", {}).catch(() => {}).finally(() => {
      S.session = null;
      stopPoll();
      btn.classList.remove("signed-in");
      render();
    });
  }

  /* ---------------------------------------------------------------- shell */
  function render() {
    put(dlg, h("div", { class: "admin-shell" },
      h("header", { class: "admin-head" },
        h("h2", { id: "admin-title", text: "Admin console" }),
        h("span", { class: "dev-flag", text: "development only · redacted before release" }),
        h("span", { class: "spacer" }),
        S.session ? h("span", { class: "hash", text: `session until ${new Date(S.session.expiresAt).toLocaleTimeString()}` }) : null,
        S.session ? h("button", { class: "btn ghost small", type: "button", onclick: signOut, text: "Sign out" }) : null,
        h("button", { class: "icon-btn", type: "button", "aria-label": "Close the admin console", onclick: () => dlg.close(), text: "×" })
      ),
      S.session ? h("nav", { class: "admin-tabs", role: "tablist", "aria-label": "Admin sections" }, TABS.map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(S.tab === id), onclick: () => { S.tab = id; render(); }, text: label }))) : null,
      h("div", { class: "admin-body", id: "admin-body" }, S.session ? h("div", { class: "lead", text: "Loading…" }) : loginView())
    ));
    if (S.session) loadTab(S.tab);
    else setTimeout(() => document.getElementById("admin-token")?.focus(), 30);
  }

  async function loadTab(tab) {
    stopPollUnless(tab);
    try {
      await ({ overview: viewOverview, environment: viewEnvironment, persistence: viewPersistence, relayer: viewRelayer, pipeline: viewPipeline, deploy: viewDeploy, audit: viewAudit })[tab]();
    } catch (e) {
      if (e.code !== "ADMIN_REQUIRED") paint(errBox(e));
    }
  }

  /* ---------------------------------------------------------------- login */
  function loginView() {
    const token = h("input", { id: "admin-token", type: "password", autocomplete: "off", spellcheck: "false", "aria-describedby": "admin-token-help" });
    const err = banner("bad");
    err.hidden = true;
    const submit = h("button", { class: "btn primary", type: "submit", text: "Sign in" });
    return h("form", {
      class: "box login",
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        submit.disabled = true;
        try {
          const r = await api("/api/admin/login", { token: token.value });
          token.value = "";
          S.session = { id: r.session, expiresAt: r.expiresAt };
          btn.classList.add("signed-in");
          render();
        } catch (ex) {
          put(err, ex.message);
          err.hidden = false;
          submit.disabled = false;
        }
      }
    },
      h("h3", { text: "Sign in" }),
      h("p", { class: "lead", text: "The console changes how this server runs: durable state, the relayer, and the build pipeline. It is separate from the page's own session and needs the admin token." }),
      field("Admin token", token, "Printed on the server's terminal when it started with --admin (or the value of DARKCIRCLE_ADMIN_TOKEN). It is never shown here. Too many wrong attempts lock sign-in out for a while.", "admin-token"),
      err,
      h("div", { class: "row" }, submit)
    );
  }

  /* ---------------------------------------------------------------- overview */
  const tile = (title, big, sub, state) => h("div", { class: "box" }, h("div", { class: "row" }, h("h3", { text: title }), h("span", { class: "spacer" }), pill(state, state === "ok" ? "ok" : state === "bad" ? "attention" : "off")), h("div", { class: "big-status", text: big }), h("div", { class: "hash", text: sub }));

  async function viewOverview() {
    const [o, d] = await Promise.all([call("/api/admin/overview"), call("/api/admin/deploy")]);
    const p = o.persistence;
    const allOnline = o.relayers.every((r) => r.online);
    paint(
      h("div", { class: "tiles" },
        tile("Persistence", p.enabled ? "on" : "off", p.enabled ? `${p.snapshots.length} snapshot(s), last ${p.lastSavedAt ? new Date(p.lastSavedAt).toLocaleTimeString() : "never"}` : "state is in memory only", p.enabled ? (p.lastError ? "bad" : "ok") : "off"),
        tile("Relayers", allOnline ? "online" : "OFFLINE", o.relayers.map((r) => `${r.symbol} ${r.online ? "online" : "offline"}, gas ${r.gasBalance}`).join(" · "), allOnline && !o.relayers.some((r) => r.lowGas) ? "ok" : "bad"),
        tile("Audit log", o.audit.ok ? "intact" : `broken at #${o.audit.brokenAt}`, `${o.audit.entries} entries, hash-chained`, o.audit.ok && !o.audit.loadedTampered ? "ok" : "bad"),
        tile("Simulated block", String(o.block), `${o.sessions} admin session(s)`, "ok")
      ),
      box(h("h3", { text: "Build pipeline" }), h("div", { class: "row" }, d.stages.map((s) => h("span", { class: "row" }, pill(s.state), h("span", { class: "hash", text: s.id })))), h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => { S.tab = "pipeline"; render(); }, text: "Open the pipeline" }))),
      banner("info", "Nothing in this console signs or sends a transaction to a real chain. Stages that could only be proven on a network produce a plan for a person to carry out.")
    );
  }

  /* ---------------------------------------------------------------- environment */
  async function viewEnvironment() {
    const r = await call("/api/admin/environment");
    paint(
      h("div", { class: "row" }, h("h3", { text: "Toolchain" }), h("span", { class: "spacer" }), h("button", { class: "btn small", type: "button", onclick: () => loadTab("environment"), text: "Recheck" })),
      h("p", { class: "lead", text: "What is actually installed on this machine, read from disk rather than from package.json. The pipeline stages need the required items." }),
      h("div", { class: "box table-wrap" }, h("table", { class: "mini-table" }, h("thead", {}, h("tr", {}, ["", "Tool", "Version", "Detail"].map((x) => h("th", { scope: "col", text: x })))),
        h("tbody", {}, r.tools.map((t) => h("tr", {}, h("td", {}, pill(t.ok ? "ok" : t.required ? "failed" : "off", t.ok ? "ok" : t.required ? "missing" : "absent")), h("td", { text: t.label }), h("td", { class: "mono", text: t.version ?? "—" }), h("td", { text: t.detail })))))),
      h("div", { class: "grid2" },
        box(h("h3", { text: "Pipeline readiness" }), kv([["Compile the circuit", pill(r.can.compileCircuit ? "ok" : "failed", r.can.compileCircuit ? "can run" : "cannot")], ["Groth16 setup and proofs", pill(r.can.setupProof ? "ok" : "failed", r.can.setupProof ? "can run" : "cannot")], ["Compile the contracts", pill(r.can.compileContracts ? "ok" : "failed", r.can.compileContracts ? "can run" : "cannot")], ["Local EVM scenario", pill(r.can.localEvm ? "ok" : "failed", r.can.localEvm ? "can run" : "cannot")]])),
        box(h("h3", { text: "Machine" }), kv([["Platform", r.machine.platform], ["Architecture", r.machine.arch], ["CPU cores", String(r.machine.cpus)], ["Memory", `${r.machine.memoryGb} GB`]]))
      )
    );
  }

  /* ---------------------------------------------------------------- persistence */
  async function viewPersistence() {
    const r = await call("/api/admin/persistence");
    if (!r.status.enabled) return paint(enableForm(r.status.defaultDir));
    paintPersistence(r.status, r.recovery);
  }

  function enableForm(defaultDir, pending) {
    const dir = input("p-dir", { placeholder: defaultDir, mono: true, value: pending?.dir ?? "" });
    const pass = input("p-pass", { type: "password" });
    const pass2 = input("p-pass2", { type: "password" });
    const out = h("div", {});
    const go = async (mode) => {
      put(out);
      if (pass.value !== pass2.value) return put(out, errBox(new Error("the two passphrases differ")));
      try {
        const r = await call("/api/admin/persistence/enable", { dir: dir.value.trim() || undefined, passphrase: pass.value, mode });
        pass.value = "";
        pass2.value = "";
        toast("Persistence is on", "ok");
        ctx.refresh().catch(() => {});
        paintPersistence(r.status, r.recovery);
      } catch (e) {
        if (e.code === "MODE_REQUIRED") {
          const n = e.detail?.snapshots ?? 0;
          return put(out, banner("warn",
            h("strong", { text: `This directory already holds ${n} snapshot(s). ` }), "Choose what to do with the state that is running now.",
            h("div", { class: "row" },
              h("button", { class: "btn primary small", type: "button", onclick: () => go("restore"), text: "Restore the newest snapshot (replaces the running state)" }),
              h("button", { class: "btn small", type: "button", onclick: () => go("keep-current"), text: "Keep the running state and continue the store" }))));
        }
        put(out, errBox(e));
      }
    };
    return box(
      h("h3", { text: "Enable durable, encrypted state" }),
      h("p", { class: "lead", text: "Notes, blinding factors, single-use payee keys, invoices and the journal are written to disk, encrypted with a key derived from the passphrase (AES-256-GCM, scrypt). Losing the invoice registry would strand funds on payee addresses; leaking it would hand them to whoever reads the disk. If the passphrase is lost the snapshots cannot be read." }),
      h("form", { onsubmit: (e) => { e.preventDefault(); go(undefined); } },
        field("Directory", dir, `Where snapshots are kept. Leave empty for ${defaultDir}.`, "p-dir"),
        h("div", { class: "inline-fields" }, field("Passphrase", pass, "12 or more characters. Sent once, never stored or logged.", "p-pass"), field("Repeat passphrase", pass2, "", "p-pass2")),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Enable persistence" })),
        out
      )
    );
  }

  function paintPersistence(st, recovery) {
    const result = h("div", {});
    const act = (label, fn, cls = "") => h("button", { class: `btn small ${cls}`, type: "button", onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; put(result); try { await fn(); } catch (e) { put(result, errBox(e)); } b.disabled = false; }, text: label });
    const snapshotRows = st.snapshots.slice().reverse().map((s) => h("tr", {}, h("td", { class: "mono", text: `#${s.seq}` }), h("td", { text: new Date(s.createdAt).toLocaleString() }), h("td", { text: fmtBytes(s.bytes) }), h("td", { class: "mono", text: s.file })));

    const restoreSel = h("select", { id: "p-restore-seq" }, st.snapshots.slice().reverse().map((s) => h("option", { value: String(s.seq), text: `#${s.seq} · ${new Date(s.createdAt).toLocaleString()}` })));
    const restoreConfirm = input("p-restore-confirm", { placeholder: "RESTORE" });
    const wipeConfirm = input("p-wipe-confirm", { placeholder: `WIPE ${st.storeId}`, mono: true });

    paint(
      box(
        h("div", { class: "row" }, h("h3", { text: "Persistence" }), pill(st.lastError ? "bad" : "ok", st.lastError ? "save failing" : "on"), h("span", { class: "spacer" }),
          act("Save now", async () => { const r = await call("/api/admin/persistence/save", {}); toast(`Saved snapshot #${r.info.seq}`, "ok"); ctx.refresh().catch(() => {}); loadTab("persistence"); }),
          act("Verify running state", async () => { const r = await call("/api/admin/persistence/verify", {}); put(result, box(h("strong", { text: r.ok ? "The running state is coherent." : "The running state FAILS these checks." }), checkList(r.checks))); }),
          act("Scan the store", async () => { const r = await call("/api/admin/persistence/scan", {}); put(result, box(h("strong", { text: r.corrupt ? `${r.corrupt} snapshot(s) failed authentication.` : `All ${r.entries.length} snapshot(s) authenticate.` }), r.usable ? h("div", { class: "hash", text: `Recovery would use #${r.usable.seq}.` }) : null, h("ul", { class: "checks" }, r.entries.map((e) => h("li", { class: e.status === "ok" ? "ok" : "no" }, h("span", { class: "m", text: e.status === "ok" ? "✓" : "✕" }), h("span", { text: `#${e.seq} ${e.status === "ok" ? "authenticates" : e.reason}` })))))); })),
        kv([
          ["Directory", h("span", { class: "mono", text: st.dir })],
          ["Store id", h("span", { class: "mono", text: st.storeId })],
          ["Autosave", st.autosave ? "after every state-changing action (debounced)" : "off"],
          ["Last saved", st.lastSavedAt ? `#${st.lastSavedSeq} at ${new Date(st.lastSavedAt).toLocaleString()}` : "not yet"],
          st.lastError ? ["Last error", h("span", { text: st.lastError })] : null,
          recovery ? ["Started from", `snapshot #${recovery.seq} saved ${new Date(recovery.savedAt).toLocaleString()}${recovery.skipped ? `, after skipping ${recovery.skipped} unreadable one(s)` : ""}`] : null
        ]),
        result
      ),
      box(h("h3", { text: "Snapshots" }), st.snapshots.length ? h("div", { class: "table-wrap" }, h("table", { class: "mini-table" }, h("thead", {}, h("tr", {}, ["Seq", "Saved", "Size", "File"].map((x) => h("th", { scope: "col", text: x })))), h("tbody", {}, snapshotRows))) : h("div", { class: "hash", text: "None yet." })),
      h("div", { class: "grid2" },
        box(h("h3", { text: "Restore a snapshot" }), h("p", { class: "lead", text: "Replaces the running state (both pools, invoices, journals) with the chosen snapshot after it authenticates and passes the coherence checks. A snapshot that fails them is refused and nothing changes." }),
          field("Snapshot", restoreSel, "", "p-restore-seq"),
          field("Type RESTORE to confirm", restoreConfirm, "", "p-restore-confirm"),
          act("Restore", async () => {
            const r = await call("/api/admin/persistence/restore", { seq: Number(restoreSel.value), confirm: restoreConfirm.value });
            toast(`Restored snapshot #${r.info.seq}`, "ok");
            restoreConfirm.value = "";
            await ctx.refresh().catch(() => {});
            put(result, box(h("strong", { text: `Restored snapshot #${r.info.seq}; the restored state passed:` }), checkList(r.checks)));
          }, "primary")),
        dangerBox(h("h3", { text: "Stop or delete" }), h("p", { class: "lead", text: "Disabling stops autosave and keeps the files. Deleting the store removes every snapshot and cannot be undone." }),
          act("Disable persistence", async () => { await call("/api/admin/persistence/disable", {}); toast("Persistence disabled; files kept", "ok"); ctx.refresh().catch(() => {}); loadTab("persistence"); }),
          field(`Type WIPE ${st.storeId} to delete everything`, wipeConfirm, "", "p-wipe-confirm"),
          act("Delete the store", async () => { await call("/api/admin/persistence/wipe", { confirm: wipeConfirm.value }); toast("Store deleted", "ok"); ctx.refresh().catch(() => {}); loadTab("persistence"); }, "danger"))
      )
    );
  }

  /* ---------------------------------------------------------------- relayer */
  async function viewRelayer() {
    const r = await call("/api/admin/relayer");
    paint(
      banner("info", h("strong", { text: "This is the simulated relayer. " }), "Turning it off makes every payment and sweep refuse (the checklist item SP-EX-04 blocks them before anything is attempted). A production relayer with a real signer, gas funding and nonce handling does not exist yet (AUDIT.md O-2)."),
      h("div", { class: "grid2" }, r.relayers.map(relayerBox))
    );
  }

  function relayerBox(r) {
    const reason = input(`r-reason-${r.symbol}`, { placeholder: "why it is being taken offline" });
    const fee = input(`r-fee-${r.symbol}`, { value: r.minimumFee });
    const gas = input(`r-gas-${r.symbol}`, { value: r.minGasBalance });
    const out = h("div", {});
    const send = async (payload, done) => {
      put(out);
      try {
        await call("/api/admin/relayer", { asset: r.symbol, ...payload });
        toast(done, "ok");
        ctx.refresh().catch(() => {});
        loadTab("relayer");
      } catch (e) {
        put(out, errBox(e));
      }
    };
    return box(
      h("div", { class: "row" }, h("h3", { text: `${r.symbol} relayer` }), pill(r.online ? "ok" : "bad", r.online ? "online" : "offline"), r.lowGas ? pill("warn", "low gas") : null),
      kv([["Address", h("span", { class: "mono", text: short(r.address, 8) })], ["Gas balance", `${r.gasBalance} QUAI (alert below ${r.minGasBalance})`], ["Fee floor", `${r.minimumFee} ${r.symbol}`], r.offlineReason ? ["Offline because", r.offlineReason] : null]),
      r.online
        ? h("div", {}, field("Reason (shown to whoever is refused)", reason, "", `r-reason-${r.symbol}`), h("button", { class: "btn danger small", type: "button", onclick: () => send({ online: false, reason: reason.value }, `${r.symbol} relayer is offline`), text: "Take offline" }))
        : h("button", { class: "btn primary small", type: "button", onclick: () => send({ online: true }, `${r.symbol} relayer is online`), text: "Bring back online" }),
      h("form", { onsubmit: (e) => { e.preventDefault(); send({ minimumFee: fee.value, minGasBalance: gas.value }, "Settings applied"); } },
        h("div", { class: "inline-fields" }, field(`Fee floor (${r.symbol})`, fee, "The least a payment may pay the relayer.", `r-fee-${r.symbol}`), field("Gas alert (QUAI)", gas, "Warn when the relayer holds less.", `r-gas-${r.symbol}`)),
        h("div", { class: "row" }, h("button", { class: "btn small", type: "submit", text: "Apply settings" }))),
      out
    );
  }

  /* ---------------------------------------------------------------- pipeline */
  function stopPoll() { if (S.poll) clearInterval(S.poll); S.poll = null; }
  function stopPollUnless(tab) { if (tab !== "pipeline" && tab !== "deploy") stopPoll(); }

  async function viewPipeline() {
    const d = await call("/api/admin/deploy");
    S.data.deploy = d;
    if (d.job && d.job.status === "running" && S.job?.id !== d.job.id) { S.job = { id: d.job.id, stage: d.job.stage }; S.log = []; S.next = 0; S.jobStatus = "running"; }
    paintPipeline();
    if (S.jobStatus === "running") startPoll();
  }

  function logLine(line) {
    const cls = /FAILED|^stderr:|error:/i.test(line) ? "err" : /^done:|^PASS|ready in|verifies/i.test(line) ? "okl" : "";
    return h("div", { class: cls, text: line });
  }

  function paintPipeline() {
    const d = S.data.deploy;
    const busy = S.jobStatus === "running";
    const stages = d.stages;
    const todo = stages.filter((s) => s.state !== "ok").map((s) => s.id);
    const consoleEl = h("pre", { class: "console", id: "pipe-console", tabindex: "0", "aria-label": "Stage output", "aria-live": "off" }, S.log.length ? S.log.map(logLine) : h("div", { text: "Stage output appears here." }));
    paint(
      banner("bad", h("strong", { text: "Development ceremony. " }), "The proving keys made here come from a powers of tau and a Groth16 setup with a single contributor: this machine. Whoever controls its randomness can forge proofs. These keys must never guard value; a real multi-party ceremony (or a transparent proof system) and an independent audit come first."),
      h("div", { class: "row" },
        h("button", { class: "btn primary small", type: "button", disabled: busy || todo.length === 0, onclick: () => runQueue(todo), text: todo.length ? `Run ${todo.length} stage${todo.length === 1 ? "" : "s"} in order` : "Everything is current" }),
        h("button", { class: "btn small danger", type: "button", disabled: !busy, onclick: cancelJob, text: "Cancel the running stage" }),
        h("span", { class: "spacer" }),
        h("span", { class: "hash", text: `build directory: ${d.buildDir}` })
      ),
      ...stages.map((s, i) => stageBox(s, i + 1, busy)),
      box(h("h3", { text: S.job ? `Output: ${S.job.stage}${S.jobStatus ? ` (${S.jobStatus})` : ""}` : "Output" }), consoleEl)
    );
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function stageBox(s, n, busy) {
    const rec = s.record;
    const details = rec ? stageDetails(s) : null;
    return h("div", { class: `stage${s.state === "running" ? " running" : ""}` },
      h("div", { class: "t" }, h("span", { class: "n", text: String(n).padStart(2, "0") }), s.title, pill(s.state), rec ? h("span", { class: "hash", text: `${new Date(rec.finishedAt).toLocaleString()} · ${fmtDur(rec.durationMs)}` }) : null),
      h("div", { class: "d", text: s.description }),
      h("div", { class: "act" },
        h("button", { class: "btn small", type: "button", disabled: busy || s.state === "blocked", onclick: () => runStage(s.id), text: s.state === "ok" ? "Run again" : "Run" }),
        h("span", { class: "hash", text: s.estimate })),
      s.state === "blocked" ? h("div", { class: "res" }, h("span", { class: "hash", text: `waiting for: ${s.blockedBy.join(", ")}` })) : null,
      s.state === "stale" ? h("div", { class: "res" }, banner("warn", "The inputs changed after this stage ran, so its result no longer describes them: ", h("span", { class: "mono", text: s.changed.join(", ") }))) : null,
      rec ? h("div", { class: "res", text: rec.summary }) : null,
      rec && rec.warnings.length ? h("div", { class: "res" }, rec.warnings.map((w) => banner("warn", w))) : null,
      details
    );
  }

  function stageDetails(s) {
    const rec = s.record;
    const d = rec.details ?? {};
    const extra = [];
    if (s.id === "contracts.compile" && d.contracts) extra.push(h("table", { class: "mini-table" }, h("thead", {}, h("tr", {}, ["Contract", "Size", "Bytecode hash (keccak256)", "Hash of"].map((x) => h("th", { scope: "col", text: x })))), h("tbody", {}, Object.entries(d.contracts).map(([n, c]) => h("tr", {}, h("td", { text: n }), h("td", { text: fmtBytes(c.sizeBytes) }), h("td", { class: "hash", text: c.bytecodeHash }), h("td", { text: c.hashKind }))))));
    if (s.id === "evm.local" && d.checks) extra.push(checkList(d.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail }))), h("div", { class: "hash", text: `gas: ${Object.entries(d.gas).map(([k, v]) => `${k} ${Number(v).toLocaleString()}`).join(" · ")}` }));
    if (s.id === "circuit.selftest") extra.push(kv([["Asset / pool", `${d.asset} ${short(d.pool ?? "", 8)}`], ["Note", `leaf #${d.leafIndex}`], ["Proof verifies", String(d.verified)], ["Public signals equal the simulation's", String(d.publicSignalsMatchSimulation)], ["Tampered signal rejected", String(d.tamperedRejected)], ["Wrong spending key rejected", String(d.wrongKeyRejected)], ["Proving time", `${d.proveMs} ms`]]));
    if (s.id === "circuit.setup") extra.push(kv([["Powers of tau", `2^${d.power}, ${d.ptauReused ? "reused from cache" : "newly generated"}`], ["ptau sha256", h("span", { class: "hash", text: d.ptauSha256 })], ["Proving key checked against circuit", String(d.zkeyVerified)], ["Production safe", String(d.productionSafe)]]));
    if (s.id === "circuit.compile") extra.push(kv([["Constraints", String(d.constraints)], ["Public / private inputs", `${d.publicInputs} / ${d.privateInputs}`], ["Powers of tau needed", `2^${d.requiredPtauPower}`]]));
    return h("details", {}, h("summary", { text: "Artifacts and details" }), ...extra,
      rec.artifacts.length ? h("table", { class: "mini-table" }, h("thead", {}, h("tr", {}, ["Artifact", "Size", "SHA-256"].map((x) => h("th", { scope: "col", text: x })))), h("tbody", {}, rec.artifacts.map((a) => h("tr", {}, h("td", { class: "mono", text: a.path }), h("td", { text: fmtBytes(a.bytes) }), h("td", { class: "hash", text: a.sha256 }))))) : null);
  }

  async function runStage(id) {
    try {
      const r = await call("/api/admin/deploy/run", { stage: id });
      S.job = { id: r.job.id, stage: id };
      S.log = [];
      S.next = 0;
      S.jobStatus = "running";
      const d = await call("/api/admin/deploy");
      S.data.deploy = d;
      paintPipeline();
      startPoll();
    } catch (e) {
      toast(e.message, "bad");
      S.queue = [];
    }
  }

  function runQueue(ids) {
    S.queue = ids.slice();
    const first = S.queue.shift();
    if (first) runStage(first);
  }

  async function cancelJob() {
    S.queue = [];
    try { await call("/api/admin/deploy/cancel", {}); } catch (e) { toast(e.message, "bad"); }
  }

  function startPoll() {
    stopPoll();
    S.poll = setInterval(async () => {
      if (!S.job) return stopPoll();
      try {
        const r = await call(`/api/admin/deploy/job?id=${encodeURIComponent(S.job.id)}&from=${S.next}`);
        for (const l of r.job.lines) S.log.push(l);
        S.next = r.job.next;
        S.jobStatus = r.job.status;
        const el = document.getElementById("pipe-console");
        if (el) { const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30; for (const l of r.job.lines) el.append(logLine(l)); if (stick) el.scrollTop = el.scrollHeight; }
        if (r.job.status !== "running") {
          stopPoll();
          S.data.deploy = await call("/api/admin/deploy");
          if (S.tab === "pipeline") paintPipeline();
          toast(`${r.job.stage}: ${r.job.status}${r.job.error ? " — " + r.job.error.slice(0, 120) : ""}`, r.job.status === "ok" ? "ok" : "bad");
          if (r.job.status === "ok" && S.queue.length) runStage(S.queue.shift());
          else S.queue = [];
        }
      } catch {
        stopPoll();
      }
    }, 900);
  }

  /* ---------------------------------------------------------------- deploy plan */
  async function viewDeploy() {
    const d = await call("/api/admin/deploy");
    S.data.deploy = d;
    const evm = d.stages.find((s) => s.id === "evm.local");
    const planBox = h("div", { id: "plan-slot" });
    if (S.data.plan) put(planBox, planView(S.data.plan));
    const target = (name, title, text, kind) => box(h("div", { class: "row" }, h("h3", { text: title }), h("span", { class: "spacer" }), pill(kind === "run" ? (evm.state === "ok" ? "ok" : evm.state) : kind === "block" ? "blocked" : "warn", kind === "run" ? (evm.state === "ok" ? "verified" : evm.state) : "plan only")), h("p", { class: "lead", text }),
      kind === "run"
        ? h("button", { class: "btn small primary", type: "button", onclick: () => { S.tab = "pipeline"; render(); }, text: evm.state === "ok" ? "See the local EVM result" : "Run it in the pipeline" })
        : h("button", { class: "btn small", type: "button", onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; try { const r = await call("/api/admin/deploy/plan", { target: name }); S.data.plan = r.plan; put(planBox, planView(r.plan)); } catch (e) { put(planBox, errBox(e)); } b.disabled = false; }, text: "Generate the plan" }));
    paint(
      banner("bad", h("strong", { text: "This server never signs or sends a transaction. " }), "For Orchard and mainnet it writes a plan (the ordered steps, the bytecode hashes to expect, every gate that is still failing) and, once you generate one, a wallet-signed deploy flow: it builds the calldata and a gas budget, YOUR OWN wallet (Pelagus/Blip) signs and sends each transaction in its own confirmation screen, and this server only reads back what actually landed on chain before recording it. Nothing is assumed from a signature alone."),
      h("div", { class: "grid2" },
        target("local", "Local EVM", "Deploys the compiled hashers, verifier, dev token and pool into an in-process EVM and runs a shield and a proven unshield with a real proof. This is real execution of the exact bytecode, on a local chain.", "run"),
        target("orchard", "Orchard testnet", "Plan for the test network. Gates that need audits and a real ceremony are warnings here, not blockers; a missing WQUAI/WQI registration still blocks.", "plan"),
        target("mainnet", "Quai mainnet (Cyprus-1)", "Plan for real funds. Blocked outright while the ceremony is a development one, the contracts are unaudited, compliance (PPOI) is not in the circuit and no production relayer exists.", "plan")
      ),
      planBox
    );
  }

  function planView(p) {
    const failing = p.gates.filter((g) => !g.ok && g.blocking);
    return box(
      h("div", { class: "row" }, h("h3", { text: `${p.target === "mainnet" ? "Mainnet" : "Orchard"} plan` }), pill(p.canProceed ? "warn" : "bad", p.canProceed ? "no blocking gate fails" : `blocked by ${failing.length} gate${failing.length === 1 ? "" : "s"}`), h("span", { class: "spacer" }), h("button", { class: "btn small", type: "button", onclick: () => download(`deploy-plan-${p.target}.json`, JSON.stringify(p, null, 2)), text: "Download JSON" })),
      h("div", { class: "hash", text: `${p.network.id} · chain ${p.network.chainId} · zone ${p.network.zone} (${p.network.zonePrefix}) · generated ${new Date(p.generatedAt).toLocaleString()} · digest ${p.digest.slice(0, 16)}… · broadcast: ${p.broadcast}` }),
      h("h3", { text: "Gates" }),
      h("ul", { class: "checks" }, p.gates.map((g) => h("li", { class: g.ok ? "ok" : g.blocking ? "no" : "soft" }, h("span", { class: "m", "aria-hidden": "true", text: g.ok ? "✓" : g.blocking ? "✕" : "!" }), h("span", {}, h("strong", { text: `${g.id} ${g.title}` }), g.ok ? "" : g.blocking ? "  (blocks)" : "  (warning)", h("div", { class: "hash", text: g.detail }))))),
      h("h3", { text: "Steps" }),
      h("div", { class: "table-wrap" }, h("table", { class: "mini-table" }, h("thead", {}, h("tr", {}, ["#", "Contract", "Bytecode hash", "Constructor arguments"].map((x) => h("th", { scope: "col", text: x })))), h("tbody", {}, p.steps.map((s) => h("tr", {}, h("td", { text: String(s.order) }), h("td", {}, s.contract, h("div", { class: "hash", text: s.note })), h("td", { class: "hash", text: s.bytecodeHash ? `${s.bytecodeHash.slice(0, 18)}… (${s.hashKind})` : "not compiled yet" }), h("td", { class: "hash", text: s.constructorArgs.join(", ") || "none" })))))),
      h("h3", { text: "What the operator must do" }),
      h("ol", {}, p.external.map((x) => h("li", { text: x }))),
      p.target === "orchard" || p.target === "mainnet" ? chainSection(p.target) : null
    );
  }

  /* ---------------------------------------------------------------- deploy on chain (wallet-signed) */
  function chainState(target) {
    if (!S.chain[target]) S.chain[target] = { address: null, walletName: null, walletChainId: null, asset: "WQUAI", preflight: null, unmetGates: null, ackMainnet: false, busy: false, deployingKey: null, log: [], status: null };
    return S.chain[target];
  }
  const chainLog = (cs, line) => { cs.log.push(`${new Date().toLocaleTimeString()}  ${line}`); if (cs.log.length > 200) cs.log.shift(); };
  const repaintChain = () => { const slot = document.getElementById("plan-slot"); if (S.tab === "deploy" && S.data.plan && slot) put(slot, planView(S.data.plan)); };

  async function loadChainStatus(target) {
    const cs = chainState(target);
    try {
      cs.status = await call(`/api/admin/deploy/chain/status?target=${target}`);
    } catch (e) {
      toast(e.message, "bad");
    }
  }

  async function connectChainWallet(target) {
    const cs = chainState(target);
    if (!wallet.isWalletAvailable()) { toast("No Quai wallet found. Install Pelagus, or open this page in Blip.", "bad"); return; }
    cs.busy = true;
    repaintChain();
    try {
      cs.address = await wallet.connect();
      cs.walletName = wallet.getWalletName();
      cs.walletChainId = await wallet.chainId();
      await loadChainStatus(target);
    } catch (e) {
      toast(e.message, "bad");
    }
    cs.busy = false;
    repaintChain();
  }

  async function runChainPreflight(target) {
    const cs = chainState(target);
    if (!cs.address) return;
    cs.busy = true;
    cs.unmetGates = null;
    repaintChain();
    try {
      cs.walletChainId = await wallet.chainId();
      const r = await call("/api/admin/deploy/chain/preflight", { target, asset: cs.asset, deployer: cs.address, acknowledged: cs.ackMainnet });
      cs.preflight = r.preflight;
    } catch (e) {
      if (e.code === "MAINNET_RISK_NOT_ACKNOWLEDGED") cs.unmetGates = e.detail?.gates ?? [];
      else toast(e.message, "bad");
      cs.preflight = null;
    }
    cs.busy = false;
    repaintChain();
  }

  async function deployChainStep(target, step) {
    const cs = chainState(target);
    const expectedChainId = cs.preflight?.network.chainId ?? cs.status?.network?.chainId;
    cs.deployingKey = step.key;
    repaintChain();
    try {
      // Read the wallet's network and account NOW, not from when preflight ran: a switch in between would
      // otherwise send this deployment to another network (chain ids differ) or from another zone's account
      // (every Quai zone shares a chain id, so only the account shows it).
      const [chainNow, accountsNow] = await Promise.all([wallet.chainId(), wallet.connectedAccounts()]);
      cs.walletChainId = chainNow;
      if (!expectedChainId || chainNow !== expectedChainId) throw new Error(`Your wallet is on chain ${chainNow}; switch it to chain ${expectedChainId ?? "?"} (${cs.preflight?.network.zone ?? target}) and run preflight again.`);
      if (!accountsNow.length || String(accountsNow[0]).toLowerCase() !== String(cs.address).toLowerCase()) throw new Error(`Your wallet's selected account is ${accountsNow[0] ?? "none"}, not ${cs.address}. Select ${cs.address} in the wallet (or reconnect and run preflight again).`);

      chainLog(cs, `simulating ${step.contract} on ${target} before asking the wallet…`);
      repaintChain();
      const { prepared } = await call("/api/admin/deploy/chain/prepare", { target, asset: cs.asset, key: step.key, deployer: cs.address, acknowledged: cs.ackMainnet });
      chainLog(cs, `simulation ok: estimate ${prepared.estimateGas} gas, limit ${BigInt(prepared.gasLimit)} gas, ${prepared.accessList.length} access-list entries; expected cost ${(Number(prepared.expectedCostWei) / 1e18).toFixed(4)} QUAI (at most ${(Number(prepared.maxCostWei) / 1e18).toFixed(4)})`);
      for (const w of prepared.warnings || []) chainLog(cs, `note: ${w}`);
      chainLog(cs, `${cs.walletName || "wallet"}: confirm deploying ${step.contract}…`);
      repaintChain();
      const txHash = await wallet.sendCreation({ from: cs.address, data: prepared.data, gasLimit: prepared.gasLimit, accessList: prepared.accessList });
      chainLog(cs, `sent ${step.contract}: ${txHash}`);
      repaintChain();
      let outcome = null;
      for (let attempt = 0; attempt < 80 && !outcome; attempt++) {
        const r = await call("/api/admin/deploy/chain/receipt", { target, key: step.key, txHash, deployer: cs.address });
        if (r.pending) { chainLog(cs, "waiting for confirmation…"); repaintChain(); await new Promise((res) => setTimeout(res, 4000)); continue; }
        outcome = r;
      }
      if (!outcome) throw new Error(`Still not confirmed after several minutes. Transaction ${txHash} may still land — check again later rather than resending.`);
      chainLog(cs, `confirmed: ${step.contract} at ${outcome.record.address}`);
      for (const w of outcome.warnings || []) chainLog(cs, `note: ${w}`);
      toast(`${step.contract} deployed at ${short(outcome.record.address, 8)}`, "ok");
      await loadChainStatus(target);
      await runChainPreflight(target);
    } catch (e) {
      chainLog(cs, `FAILED: ${step.contract}: ${e.message}`);
      toast(e.message, "bad");
    }
    cs.deployingKey = null;
    repaintChain();
  }

  async function verifyChainPool(target) {
    const cs = chainState(target);
    cs.busy = true;
    repaintChain();
    try {
      cs.poolVerify = await call("/api/admin/deploy/chain/verify-pool", { target, asset: cs.asset });
    } catch (e) {
      toast(e.message, "bad");
    }
    cs.busy = false;
    repaintChain();
  }

  async function forgetChainRecord(target, key, address) {
    const cs = chainState(target);
    try {
      await call("/api/admin/deploy/chain/forget", { target, key, confirm: `FORGET ${address}` });
      toast(`${key} forgotten from this console's records (nothing on chain changed)`, "ok");
      await loadChainStatus(target);
      cs.preflight = null;
      repaintChain();
    } catch (e) {
      toast(e.message, "bad");
    }
  }

  function stepRow(target, cs, step) {
    const deployed = step.alreadyDeployed;
    const deploying = cs.deployingKey === step.key;
    const blockedOnDeps = !deployed && step.data === "";
    const canDeploy = !deployed && !blockedOnDeps && !deploying && !cs.deployingKey;
    return h("div", { class: `stage${deploying ? " running" : ""}` },
      h("div", { class: "t" }, step.contract, pill(deployed ? "ok" : blockedOnDeps ? "blocked" : deploying ? "running" : "ready", deployed ? "deployed" : blockedOnDeps ? "waiting on dependencies" : deploying ? "deploying…" : "ready")),
      h("div", { class: "d" }, deployed
        ? [h("span", { class: "hash", text: `${deployed.address} · block ${deployed.blockNumber} · tx ${short(deployed.txHash, 8)}` }), h("a", { class: "copy", href: `${cs.status?.network?.explorerUrl ?? ""}/address/${deployed.address}`, target: "_blank", rel: "noopener noreferrer", text: "Explorer" }), h("button", { class: "copy", type: "button", onclick: () => forgetChainRecord(target, step.key, deployed.address), text: "Forget…" })]
        : [`gas limit ${(Number(BigInt(step.gasLimit)) / 1e6).toFixed(1)}M`, cs.preflight?.gasPriceWei ? ` · est. cost ${(Number(step.expectedCostWei) / 1e18).toFixed(4)} QUAI` : "", ...step.constructorArgs.map((a) => h("div", { class: "hash", text: `${a.name}: ${a.value}` }))]),
      !deployed ? h("div", { class: "act" }, h("button", { class: "btn small primary", type: "button", disabled: !canDeploy, onclick: () => deployChainStep(target, step), text: deploying ? "Deploying…" : "Deploy" })) : null
    );
  }

  function chainSection(target) {
    const cs = chainState(target);
    if (!cs.status) loadChainStatus(target);
    const mainnet = target === "mainnet";

    const walletRow = !cs.address
      ? box(h("div", { class: "row" }, h("h3", { text: "1. Connect your wallet" }), pill(wallet.isWalletAvailable() ? "ready" : "blocked", wallet.isWalletAvailable() ? "wallet detected" : "no wallet detected")), h("p", { class: "lead", text: "Pelagus (desktop) or Blip (mobile). This page never sees your key: the wallet's own approval screen is where you actually confirm anything." }), h("button", { class: "btn small primary", type: "button", disabled: cs.busy, onclick: () => connectChainWallet(target), text: "Connect wallet" }))
      : box(h("div", { class: "row" }, h("h3", { text: "1. Wallet connected" }), pill("ok", cs.walletName || "connected")), kv([["Address", h("span", { class: "mono", text: cs.address })], ["Wallet's chain id", String(cs.walletChainId)], cs.preflight ? ["Target chain id", String(cs.preflight.network.chainId)] : null]), cs.walletChainId && cs.preflight && cs.walletChainId !== cs.preflight.network.chainId ? banner("bad", `Your wallet is on chain ${cs.walletChainId}. Switch it to chain ${cs.preflight.network.chainId} (${cs.preflight.network.zone}) before deploying.`) : null);

    if (!cs.address) return h("div", {}, walletRow);

    const assetSelect = h("select", { onchange: (e) => { cs.asset = e.target.value; cs.preflight = null; repaintChain(); } }, ["WQUAI", "WQI"].map((a) => h("option", { value: a, ...(a === cs.asset ? { selected: true } : {}), text: a })));

    let unmetGatesBox = null;
    if (cs.unmetGates) {
      const gateItems = cs.unmetGates.map((g) => h("li", { class: "no" }, h("span", { class: "m", text: "✕" }), h("span", {}, h("strong", { text: `${g.id} ${g.title}` }), h("div", { class: "hash", text: g.detail }))));
      const ackCheckbox = h("input", { type: "checkbox", onchange: (e) => { cs.ackMainnet = e.target.checked; } });
      const ackRow = h("label", { class: "check ackrow" }, ackCheckbox, h("span", { text: "I have read these and want deployable calldata for mainnet anyway." }));
      const continueRow = h("div", { class: "row" }, h("button", { class: "btn small danger", type: "button", onclick: () => runChainPreflight(target), text: "Continue" }));
      unmetGatesBox = banner("bad", h("strong", { text: "Mainnet gates this repository cannot satisfy: " }), h("ul", { class: "checks" }, gateItems), ackRow, continueRow);
    }

    const preflightSummary = cs.preflight
      ? kv([
          ["Ready", pill(cs.preflight.ok ? "ok" : "bad", cs.preflight.ok ? "yes" : "no")],
          cs.preflight.deployerBalanceWei ? ["Balance", `${(Number(cs.preflight.deployerBalanceWei) / 1e18).toFixed(4)} QUAI`] : null,
          cs.preflight.totalEstimatedCostWei ? ["Remaining steps estimated cost", `${(Number(cs.preflight.totalEstimatedCostWei) / 1e18).toFixed(4)} QUAI`] : null,
          cs.preflight.maxSingleStepCostWei ? ["Largest step, whole gas limit", `${(Number(cs.preflight.maxSingleStepCostWei) / 1e18).toFixed(4)} QUAI (the balance must cover this to send it)`] : null
        ])
      : null;
    const preflightErrors = cs.preflight && cs.preflight.errors.length ? banner("bad", cs.preflight.errors.map((e) => h("div", { text: e }))) : null;
    const preflightWarnings = cs.preflight && cs.preflight.warnings?.length ? banner("warn", cs.preflight.warnings.map((w) => h("div", { text: w }))) : null;

    const preflightBox = box(
      h("div", { class: "row" }, h("h3", { text: "2. Preflight" }), h("label", {}, "Asset ", assetSelect), h("span", { class: "spacer" }), h("button", { class: "btn small", type: "button", disabled: cs.busy, onclick: () => runChainPreflight(target), text: "Run preflight" })),
      unmetGatesBox,
      preflightSummary,
      preflightErrors,
      preflightWarnings
    );

    const stepsBox = cs.preflight && cs.preflight.ok ? box(h("h3", { text: "3. Deploy, one contract at a time" }), h("p", { class: "lead", text: "Each Deploy opens your wallet's own confirmation screen. The address shown afterwards is read from the transaction receipt, then re-checked on chain (zone, code, bytecode hash) before it is recorded — never assumed from the transaction alone." }), ...cs.preflight.steps.map((s) => stepRow(target, cs, s))) : null;

    const pool = cs.preflight?.steps.find((s) => s.contract === "DarkCirclePool");
    const verifyBox = pool && pool.alreadyDeployed ? box(h("div", { class: "row" }, h("h3", { text: "4. Verify the deployed pool" }), h("button", { class: "btn small", type: "button", disabled: cs.busy, onclick: () => verifyChainPool(target), text: "Verify bindings" })), h("p", { class: "lead", text: "Reads the pool's own token/verifier/hasher addresses and its empty-tree root back from the chain and compares them with what was actually deployed — the same check the local EVM stage runs, now against the real network." }), cs.poolVerify ? [pill(cs.poolVerify.ok ? "ok" : "bad", cs.poolVerify.ok ? "matches" : "mismatch"), checkList(cs.poolVerify.checks)] : null) : null;

    const logBox = cs.log.length ? box(h("h3", { text: "Log" }), h("pre", { class: "console", text: cs.log.join("\n") })) : null;

    return h("div", {}, walletRow, preflightBox, stepsBox, verifyBox, logBox);
  }

  function download(name, content) {
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------------------------------------------------------------- audit log */
  async function viewAudit() {
    const r = await call("/api/admin/audit");
    paint(
      h("div", { class: "row" }, h("h3", { text: "Admin action log" }), r.verification.ok && !r.loadedTampered ? pill("ok", `chain intact · ${r.verification.entries} entries`) : pill("bad", `chain BROKEN at #${r.verification.brokenAt ?? "?"}`), h("span", { class: "spacer" }), h("button", { class: "btn small", type: "button", onclick: () => loadTab("audit"), text: "Refresh" })),
      h("p", { class: "lead", text: "Every admin action, allowed or refused, newest first. Each entry carries the hash of the one before it, so editing or deleting a line breaks the chain from that point on. The log holds no secrets." }),
      h("div", { class: "box table-wrap" }, h("table", { class: "mini-table" }, h("thead", {}, h("tr", {}, ["#", "Time", "Action", "Result", "Detail"].map((x) => h("th", { scope: "col", text: x })))),
        h("tbody", {}, r.entries.map((e) => h("tr", {}, h("td", { class: "mono", text: String(e.seq) }), h("td", { text: new Date(e.at).toLocaleString() }), h("td", { class: "mono", text: e.action }), h("td", {}, pill(e.outcome === "ok" ? "ok" : e.outcome === "denied" ? "warn" : "bad", e.outcome)), h("td", { text: e.detail })))))
      )
    );
  }
}
