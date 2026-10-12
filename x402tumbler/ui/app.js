// DarkCircle Console. Vanilla ES module, no dependencies. Data is rendered as text nodes only; no HTML strings are ever built.
import { mountAgent } from "./agent.js";

const token = document.querySelector('meta[name="darkcircle-session"]')?.content ?? "";
// The DarkCircle server swaps this placeholder for a per-run session token. A static host (GitHub Pages) cannot, which
// means there is no ledger, no API and no wallet bridge behind this page. It says so instead of failing action by action.
const STATIC_PREVIEW = !token || /^__[A-Z0-9_]+__$/.test(token);
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}


/** replaceChildren that skips null/undefined/false (the DOM would render them as the text "null"). */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}
/** "5.000000000000000000" -> "5.0", "0.500000000000000000" -> "0.5". */
const trimAmount = (v) => (typeof v === "string" && v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, ".0") : v);

async function api(path, body, headers = {}) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "X-DarkCircle-Session": token, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) {
    const err = new Error(data.error?.message || res.statusText);
    err.code = data.error?.code;
    err.detail = data.error;
    err.checklist = data.checklist;
    throw err;
  }
  return data;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const short = (s, n = 8) => (!s || s.length <= 2 * n + 3 ? s : `${s.slice(0, n + 2)}…${s.slice(-n)}`);
const when = (sec) => new Date(sec * 1000).toLocaleString();

function toast(message, kind = "info") {
  const t = h("div", { class: `toast ${kind}`, text: message });
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 7000 : 3800);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied", "ok"); } catch { toast("Copy is not available in this browser", "bad"); }
}
const copyBtn = (text) => h("button", { class: "copy", type: "button", "aria-label": "Copy to clipboard", onclick: () => copy(text), text: "Copy" });

const state = { status: null, notes: null, invoices: null, journal: null, active: null, route: "overview" };

async function refresh() {
  // Both assets are live. `active` only decides which one the balances, notes and journal below show.
  const q = state.active ? `?asset=${encodeURIComponent(state.active)}` : "";
  const [status, notes, invoices, journal] = await Promise.all([api(`/api/status${q}`), api(`/api/notes${q}`), api("/api/invoices"), api(`/api/journal${q}`)]);
  state.active = status.active;
  Object.assign(state, { status, notes, invoices: invoices.invoices, journal });
  renderAll();
}

async function selectAsset(symbol) {
  if (symbol === state.active) return;
  state.active = symbol;
  try { await refresh(); } catch (e) { toast(e.message, "bad"); }
}

/* ---------------------------------------------------------------- theme */
// Dark is the default (ui/theme.js applies the saved choice before first paint). The choice is remembered in
// localStorage when it is available; when it is not, the toggle still works for this page.
// Declared before applyTheme() below, which reads it on every theme switch to re-derive the accent.
let accentHex = window.DarkCircle.accent;
const currentTheme = () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
function applyTheme(theme, persist = true) {
  document.documentElement.setAttribute("data-theme", theme);
  if (persist) { try { localStorage.setItem("darkcircle-theme", theme); } catch { /* blocked or full: keep it for this page only */ } }
  const light = theme === "light";
  const btn = $("#theme-toggle");
  btn.setAttribute("aria-pressed", String(light));
  btn.title = light ? "Switch to the dark theme" : "Switch to the light theme";
  $("#theme-label").textContent = "Light theme";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? "#f2f5f8" : "#0a0e13";
  // The accent is one hue derived differently per theme (readable against each theme's background), so
  // switching theme must re-derive it; the stored seed colour itself does not change.
  window.DarkCircle.applyAccent(accentHex, theme, false);
}
$("#theme-toggle").addEventListener("click", () => applyTheme(currentTheme() === "light" ? "dark" : "light"));
applyTheme(currentTheme(), false);

/* ---------------------------------------------------------------- site colour (accent) */
// Click the logo to change the site's accent colour. ui/theme.js already applied the saved (or default red)
// colour before first paint; this just adds the picker UI on top and re-derives the four --accent* custom
// properties (readable against both themes) whenever the user changes it. (accentHex itself is declared
// above, before applyTheme(), which needs it on the very first call.)
const ACCENT_PRESETS = [
  { key: "red", hex: "#ef4444", label: "Red (default)" },
  { key: "orange", hex: "#f97316", label: "Orange" },
  { key: "amber", hex: "#eab308", label: "Amber" },
  { key: "green", hex: "#22c55e", label: "Green" },
  { key: "teal", hex: "#14b8a6", label: "Teal" },
  { key: "blue", hex: "#3b82f6", label: "Blue" },
  { key: "purple", hex: "#a855f7", label: "Purple" },
  { key: "pink", hex: "#ec4899", label: "Pink" }
];

function selectAccent(hex) {
  if (!window.DarkCircle.isHex(hex)) return;
  accentHex = window.DarkCircle.applyAccent(hex, currentTheme());
  if (!$("#color-popover").hidden) paintColorPopover();
}

function paintColorPopover() {
  put($("#color-popover"),
    h("div", { class: "cp-head" }, h("h3", { text: "Site colour" }), h("button", { class: "copy", type: "button", onclick: () => selectAccent(window.DarkCircle.DEFAULT_ACCENT), text: "Reset" })),
    h("div", { class: "cp-swatches", role: "group", "aria-label": "Preset colours" },
      ACCENT_PRESETS.map((p) => {
        const active = p.hex.toLowerCase() === accentHex.toLowerCase();
        return h("button", { class: `cp-swatch c-${p.key}`, type: "button", "aria-pressed": String(active), "aria-label": p.label, title: p.label, onclick: () => selectAccent(p.hex) },
          active ? h("span", { class: "ck", "aria-hidden": "true", text: "✓" }) : null
        );
      })
    ),
    h("div", { class: "cp-custom-row" },
      h("input", { type: "color", id: "cp-custom", value: accentHex, "aria-label": "Custom colour", oninput: (e) => selectAccent(e.target.value) }),
      h("label", { for: "cp-custom", text: "Custom…" })
    )
  );
}

function openColorPopover() {
  const pop = $("#color-popover");
  const btn = $("#brand-btn");
  paintColorPopover();
  pop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  // Picking a colour re-renders the popover's contents from inside the click handler, which detaches the
  // clicked element itself; composedPath() still has it (captured when the event was dispatched, before
  // the re-render), so checking that instead of the now-possibly-detached e.target survives the re-render.
  const wrap = $(".brand-wrap");
  const onDocClick = (e) => { if (!e.composedPath().includes(wrap)) closeColorPopover(); };
  const onKey = (e) => { if (e.key === "Escape") { closeColorPopover(); btn.focus(); } };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  closeColorPopover._cleanup = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
}
function closeColorPopover() {
  closeColorPopover._cleanup?.();
  closeColorPopover._cleanup = null;
  $("#color-popover").hidden = true;
  $("#brand-btn").setAttribute("aria-expanded", "false");
}
$("#brand-btn").addEventListener("click", () => ($("#color-popover").hidden ? openColorPopover() : closeColorPopover()));

/* ---------------------------------------------------------------- routes */
const ROUTES = { overview: "Overview", notes: "Notes & events", invoices: "Invoices", journal: "Journal", agent: "Voice agent" };
function route(moveFocus) {
  const wanted = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
  const name = wanted && ROUTES[wanted] ? wanted : "overview";
  state.route = name;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll("#nav a")) {
    if (a.dataset.route === name) {
      a.setAttribute("aria-current", "page");
      if (typeof a.scrollIntoView === "function") a.scrollIntoView({ inline: "center", block: "nearest" });
    } else a.removeAttribute("aria-current");
  }
  document.title = `${ROUTES[name]} · DarkCircle Console`;
  // the voice agent works on the real network; everything else here is the simulation
  $("#sim-banner").hidden = name === "agent";
  $("#live-banner").hidden = name !== "agent";
  for (const id of ["#asset-seg", "#chips", "#btn-reset"]) $(id).hidden = name === "agent"; // simulation controls
  if (moveFocus) $("#main").focus();
}
window.addEventListener("hashchange", () => route(true));
route(false);

/* ---------------------------------------------------------------- dashboard */
function persistenceChip(p) {
  if (!p || !p.enabled) return h("span", { class: "chip off", title: "State lives in memory only and is lost when the server stops" }, "Persistence ", h("b", { text: "off" }));
  if (p.lastError) return h("span", { class: "chip bad", title: p.lastError }, "Save ", h("b", { text: "FAILED" }));
  if (p.dirty || p.saving) return h("span", { class: "chip warn" }, "Persistence ", h("b", { text: "saving…" }));
  const at = p.lastSavedAt ? new Date(p.lastSavedAt).toLocaleTimeString() : "not yet";
  const from = p.recovery ? ` Restored from snapshot #${p.recovery.seq} at start-up.` : "";
  return h("span", { class: "chip ok", title: `Encrypted snapshots on disk (${p.snapshots} kept).${from}` }, "Saved ", h("b", { text: at }));
}

function renderAll() {
  const s = state.status;
  const symbol = s.asset.symbol;

  put($("#chips"),
    h("span", { class: "chip" }, h("b", { text: s.network.title.replace("Quai Network ", "Quai ") }), ` chain ${s.network.chainId} · zone ${s.network.zonePrefix}`),
    h("span", { class: `chip ${s.pool.mode === "verified" ? "ok" : "bad"}` }, "Pool ", h("b", { text: s.pool.mode === "verified" ? "verified" : "TRUSTED HARNESS" })),
    h("span", { class: `chip ${s.gateway.trustMode === "verified" ? "ok" : "bad"}` }, "Payments ", h("b", { text: s.gateway.trustMode === "verified" ? "verified on-chain" : "TRUSTED HARNESS" })),
    h("span", { class: "chip" }, "Block ", h("b", { text: String(s.block) })),
    persistenceChip(s.persistence)
  );

  put($("#asset-seg"),
    ...s.tokens.map((t) =>
      h("button", { type: "button", "aria-pressed": String(t.symbol === symbol), onclick: () => selectAsset(t.symbol), text: t.symbol })
    )
  );

  put($("#pools"), s.assets.map((a) => poolCard(a, a.symbol === symbol)));

  put($("#stats"),
    card("Shielded balance", s.balances.shielded, symbol, `${plural(s.balances.noteCount, "note", "notes")} · ${plural(s.pool.leafCount, "leaf", "leaves")} in the pool`),
    card("Operating wallet", s.balances.operatingToken, symbol, `${s.balances.operatingNative} QUAI · ${short(s.balances.operatingAddress, 6)}`),
    card("Pool custody", s.pool.balance, symbol, `${s.pool.leafCount}/${s.pool.capacity} leaves · ${s.pool.solvent ? "solvent" : "INSOLVENT"} · ${s.pool.spentNullifiers} spent`),
    card("Relayer", s.relayer.minimumFee, `${symbol} fee`, `${s.relayer.online === false ? "OFFLINE · " : ""}gas ${s.relayer.nativeBalance} QUAI · ${short(s.relayer.address, 6)}`)
  );

  const open = state.invoices.filter((i) => i.status === "PENDING" || i.status === "SETTLED").length;
  setCount("#count-notes", state.notes.notes.length);
  setCount("#count-invoices", open);
  put($("#side-foot"), s.persistence && s.persistence.enabled ? "State is saved to an encrypted store." : "State is in memory only.");

  renderPanes();
}

function setCount(sel, n) {
  const el = $(sel);
  el.hidden = n === 0;
  el.textContent = String(n);
}

function poolCard(a, active) {
  return h("button", { class: `pool${active ? " active" : ""}`, type: "button", "aria-pressed": String(active), onclick: () => selectAsset(a.symbol) },
    h("div", { class: "pool-head" }, h("strong", { text: `${a.symbol} pool` }), h("span", { class: `badge ${a.solvent ? "pass" : "fail"}`, text: a.solvent ? "solvent" : "INSOLVENT" })),
    h("div", { class: "pool-big" }, a.shielded, h("small", { text: `${a.symbol} shielded` })),
    h("div", { class: "sub", text: `${plural(a.noteCount, "note", "notes")} · ${plural(a.leafCount, "leaf", "leaves")} · custody ${a.poolBalance} · ${plural(a.openInvoices, "invoice", "invoices")}` }),
    h("div", { class: "sub mono", text: `${a.name} · pool ${short(a.poolAddress, 6)}` }),
    h("div", { class: "tags" },
      h("span", { class: `tag${a.permit ? " hl" : ""}`, text: a.permit ? "Gasless sweep (EIP-2612 permit)" : "Sweep gas funded by relayer" }),
      h("span", { class: "tag", text: a.wrapsNative ? "Wraps native QUAI" : "Not wrappable from QUAI" }),
      h("span", { class: "tag", text: `relayer fee ${a.relayerFee}` }),
      h("span", { class: "tag", text: `pool ${a.poolMode}` }),
      a.relayerOnline === false ? h("span", { class: "tag bad", text: "relayer OFFLINE" }) : null
    )
  );
}

const card = (title, big, unit, sub) =>
  h("div", { class: "card" }, h("h3", { text: title }), h("div", { class: "big" }, big, h("small", { text: unit })), h("div", { class: "sub", text: sub }));

const table = (heads, rows, empty) =>
  rows.length === 0
    ? h("div", { class: "empty", text: empty })
    : h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map((x) => h("th", { scope: "col", text: x })))), h("tbody", {}, rows)));

function eventRows(events) {
  return events.map((e) => h("tr", {}, h("td", {}, h("span", { class: `badge ${e.type === "SHIELD" ? "info" : "muted"}`, text: e.type })), h("td", { class: "num", text: `${e.amount} ${e.symbol}` }), h("td", { class: "num", text: String(e.block) }), h("td", { class: "mono", text: e.type === "UNSHIELD" ? `to ${short(e.recipient || "", 6)} · fee ${e.fee}` : `leaf #${e.leafIndex}` })));
}

function renderPanes() {
  const n = state.notes;
  put($("#recent"), table(["Type", "Amount", "Block", "Counterparty / tx"], eventRows(n.events.slice(0, 6)), "No pool events yet. Use Shield to make a deposit."));

  put($("#pane-notes"),
    h("div", { class: "section-title", text: `Unspent shielded notes · ${n.asset} pool` }),
    table(
      ["Leaf", "Commitment", "Value", "Origin (PPOI)", "Deposited"],
      n.notes.map((x) => h("tr", {}, h("td", { class: "num", text: `#${x.leafIndex}` }), h("td", { class: "mono", text: x.commitment }), h("td", { class: "num", text: `${x.value} ${x.symbol}` }), h("td", { class: "mono", text: short(x.origin || "", 6) }), h("td", { text: when(x.depositedAt) }))),
      "No shielded notes yet. Use Shield to deposit."
    ),
    h("div", { class: "section-title", text: `Recent pool events · ${n.asset} pool` }),
    table(["Type", "Amount", "Block", "Counterparty / tx"], eventRows(n.events), "No pool events yet.")
  );

  put($("#pane-invoices"),
    table(
      ["Invoice", "Status", "Amount", "Pay to (ephemeral)", "Payer", "Expires", ""],
      state.invoices.map((i) =>
        h("tr", {},
          h("td", { class: "mono", text: short(i.invoiceId, 8) }),
          h("td", {}, h("span", { class: `badge ${i.status === "SWEPT" ? "pass" : i.status === "SETTLED" ? "info" : i.status === "PENDING" ? "warn" : "muted"}`, text: i.status })),
          h("td", { class: "num", text: `${i.amount} ${i.symbol}` }),
          h("td", { class: "mono", text: short(i.ephemeralAddress, 6) }),
          h("td", { class: "mono", text: i.payer ? short(i.payer, 6) : "—" }),
          h("td", { text: when(i.expiresAt) }),
          h("td", {},
            i.status === "PENDING" ? h("button", { class: "btn ghost small", type: "button", onclick: () => simulatePayment(i.invoiceId), text: "Simulate payment" }) : null,
            i.status === "SETTLED" ? h("button", { class: "btn ghost small", type: "button", onclick: () => openFlow("sweep", { invoiceId: i.invoiceId }), text: "Sweep…" }) : null
          )
        )
      ),
      "No invoices yet. Use Receive to create one."
    )
  );

  const j = state.journal;
  put($("#pane-journal"),
    h("div", { class: "section-title" }, j.asset ? `Double-entry journal (${j.asset}) · ` : "Journal · ", j.asset ? h("span", { class: `badge ${j.reconciled ? "pass" : "fail"}`, text: j.reconciled ? "reconciled" : "NOT reconciled" }) : ""),
    table(
      ["ID", "Time", "Type", "Gross", "Fee", "Net", "Counterparty", "Balance"],
      j.entries.map((e) => h("tr", {}, h("td", { class: "mono", text: e.journalId }), h("td", { text: new Date(e.timestamp).toLocaleTimeString() }), h("td", { text: e.type }), h("td", { class: "num", text: e.gross }), h("td", { class: "num", text: e.fee }), h("td", { class: "num", text: e.net }), h("td", { class: "mono", text: short(e.counterparty, 6) }), h("td", { class: "num", text: e.runningBalance }))),
      "No journal entries."
    )
  );
}

/* ---------------------------------------------------------------- checklist view */
const GLYPH = { pass: "✓", fail: "✕", warn: "!", info: "i" };
const LABEL = { pass: "Passed", fail: "Failed", warn: "Warning", info: "Info" };

function renderChecklist(result, pending) {
  if (pending && !result) return h("div", { class: "cl" }, h("div", { class: "cl-pending", text: "Running pre-flight checks…" }));
  const verdict = !result.canProceed ? { cls: "fail", text: `Blocked by ${result.blockers} check(s)` } : result.warnings > 0 ? { cls: "warn", text: `Ready · ${result.warnings} warning(s) to acknowledge` } : { cls: "pass", text: "Ready" };
  const groups = [];
  for (const item of result.items) {
    let g = groups.find((x) => x.name === item.group);
    if (!g) groups.push((g = { name: item.group, items: [] }));
    g.items.push(item);
  }
  return h("div", { class: "cl", "aria-live": "polite" },
    h("div", { class: "cl-head" }, h("span", { text: "Pre-flight checklist" }), h("span", { class: `badge ${verdict.cls}`, text: verdict.text })),
    groups.map((g) => [
      h("div", { class: "cl-group", text: g.name }),
      h("ul", {}, g.items.map((it) =>
        h("li", { class: it.status },
          h("span", { class: "mark", "aria-hidden": "true", text: GLYPH[it.status] }),
          h("div", {},
            h("div", { class: "t" }, h("span", { class: "sr", text: `${LABEL[it.status]}: ` }), it.title, h("span", { class: "id", text: it.id })),
            h("div", { class: "d", text: it.detail })
          )
        )
      ))
    ])
  );
}

/* ---------------------------------------------------------------- modal engine */
const dlg = $("#modal");
let flow = null;

$("#modal-close").addEventListener("click", closeModal);
dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeModal(); });
dlg.addEventListener("click", (e) => { if (e.target === dlg) closeModal(); });
$("#modal-shell").addEventListener("submit", (e) => e.preventDefault());

function closeModal() {
  if (flow?.busy) return;
  clearTimeout(flow?.timer);
  flow = null;
  dlg.close();
  put($("#modal-body"));
}

function steps(current, labels) {
  put($("#modal-steps"), 
    ...labels.map((l, i) => h("li", { class: i < current ? "done" : "", ...(i === current ? { "aria-current": "step" } : {}), text: l }))
  );
}

const tokenOptions = () => state.status.tokens.map((t) => ({ value: t.symbol, label: `${t.symbol} — ${t.name}` }));

const FLOWS = {
  shield: {
    title: "Shield funds",
    lead: "Move tokens from a public Quai address into the shielded pool as a new note. The pool pulls the funds in the same call, so a note can never exist without tokens behind it.",
    kind: "shield",
    endpoint: "/api/shield",
    confirm: "Shield funds",
    fields: (v) => [
      { name: "amount", label: "Amount", help: "Token amount, e.g. 10 or 2.5", placeholder: "10.0", inputmode: "decimal" },
      { name: "token", label: "Asset", type: "select", options: tokenOptions(), value: state.status.asset.symbol },
      { name: "address", label: "Funding address", mono: true, value: state.status.balances.operatingAddress, help: "Becomes the note's PPOI origin. Must be a Cyprus-1 Quai-ledger address." },
      (v.token ?? state.status.asset.symbol) === "WQUAI" ? { name: "wrapNative", label: "Wrap native QUAI into WQUAI first", type: "checkbox", help: "WQUAI is a 1:1 wrapper of QUAI." } : null,
      (v.token ?? state.status.asset.symbol) === "WQI" ? { type: "note", text: "WQI is issued by its own contract, which has no deposit function, so it cannot be wrapped from QUAI. The funding address must already hold WQI. It goes into the WQI pool, which is separate from the WQUAI pool." } : null
    ],
    review: (p) => [["Amount", `${p.amount} ${p.token}`], ["From", p.address], ["Wrap native QUAI first", p.wrapNative ? "Yes" : "No"], ["Result", "one new shielded note"]],
    result: (r) => ({
      title: "Funds shielded",
      rows: [["Amount", `${r.amount} ${r.symbol}${r.wrapped ? " (wrapped from QUAI)" : ""}`], ["From", r.depositor], ["Commitment", r.commitment, true], ["Leaf index", `#${r.leafIndex}`], ["Transaction", r.txHash, true], ["Block", String(r.blockNumber)]]
    })
  },
  unshield: {
    title: "Send payment",
    lead: "Pay an external Quai address from the shielded pool. A relayer broadcasts it, so the on-chain sender is the relayer and never the treasury.",
    kind: "unshield",
    endpoint: "/api/pay",
    confirm: "Send payment",
    fields: () => [
      { name: "address", label: "Recipient", mono: true, placeholder: "0x00…", help: "Checksummed, in zone 0x00 (Cyprus-1), Quai ledger." },
      { name: "amount", label: "Amount", placeholder: "5.0", inputmode: "decimal" },
      { name: "token", label: "Asset", type: "select", options: tokenOptions(), value: state.status.asset.symbol }
    ],
    review: (p, cl) => [
      ["Pay to", p.address],
      ["Amount", `${p.amount} ${p.token}`],
      ...(cl.plan ? [["Relayer fee", `${cl.plan.relayerFee} ${cl.plan.symbol}`], ["Note spent", `${cl.plan.noteValue} ${cl.plan.symbol} (${short(cl.plan.noteCommitment, 6)})`], ["Change note", `${cl.plan.change} ${cl.plan.symbol}`]] : []),
      ["Broadcast by", "relayer (treasury is not the sender)"]
    ],
    result: (r) => ({
      title: r.status === "CONFIRMED" ? "Payment confirmed" : `Payment ${r.status}`,
      rows: [["Paid to", r.recipient], ["Amount", `${trimAmount(r.amountFormatted)} ${state.status.asset.symbol}`], ["On-chain sender (relayer)", r.relayerAddress], ["Transaction", r.txHash, true], ["Block", String(r.blockNumber)]],
      note: "The recipient sees the relayer as the sender. Nothing on-chain links this payment to the treasury address."
    })
  },
  receive: {
    title: "Receive payment",
    lead: "Create an x402 invoice. Each one gets its own single-use payee address, generated in Cyprus-1 with a real key, so revenue and customer activity cannot be tallied on-chain.",
    kind: "receive",
    endpoint: "/api/invoice",
    confirm: "Create invoice",
    fields: (v) => [
      { name: "amount", label: "Amount due", placeholder: "5.0", inputmode: "decimal" },
      { name: "token", label: "Asset", type: "select", options: tokenOptions(), value: state.status.asset.symbol },
      (v.token ?? state.status.asset.symbol) === "WQI"
        ? { type: "note", text: "WQI supports EIP-2612 permit, so the sweep is gasless: the single-use payee address signs a permit and the relayer submits it. The payee address never needs QUAI." }
        : { type: "note", text: "WQUAI has no permit, so sweeping needs the relayer to fund gas in QUAI for the single-use payee address." }
    ],
    review: (p) => [["Amount due", `${p.amount} ${p.token}`], ["Payee", "fresh single-use Cyprus-1 address"], ["Accepted when", "a confirmed receipt shows the transfer"]],
    result: (r, v) => ({
      title: "Invoice created",
      rows: [["Invoice", r.invoice.invoiceId, true], ["Pay to", r.invoice.ephemeralAddress, true], ["Amount due", `${v.amount} ${v.token}`], ["Expires", when(r.invoice.expiresAt)]],
      code: r.challengeHeaders["WWW-Authenticate"],
      after: [{ label: "Simulate customer payment", run: (m) => simulatePayment(r.invoice.invoiceId, m) }]
    })
  },
  sweep: {
    title: "Sweep to pool",
    lead: "Move a settled invoice's funds from its single-use address into the shielded pool, then destroy the address key. Screening is done on the payer read from the transfer, not on the fresh address.",
    kind: "sweep",
    endpoint: "/api/sweep",
    confirm: "Sweep and shield",
    fields: () => {
      const settled = state.invoices.filter((i) => i.status === "SETTLED");
      return [{ name: "invoiceId", label: "Settled invoice", type: "select", options: settled.length ? settled.map((i) => ({ value: i.invoiceId, label: `${short(i.invoiceId, 8)} — ${i.amount} ${i.symbol}` })) : [{ value: "", label: "No settled invoices" }] }];
    },
    review: (p) => [["Invoice", p.invoiceId], ["Effect", "funds move to the pool as a new note; the payee key is zeroized"]],
    result: (r) => ({
      title: "Swept and shielded",
      rows: [["Invoice", r.invoiceId], ["Pool", `${r.asset} pool`], ["Shielded", `${trimAmount(r.sweptAmountFormatted ?? r.sweptAmount)} ${r.asset}`], ["Sweep method", r.sweepMethod === "permit" ? "EIP-2612 permit signed by the payee key, submitted by the relayer (no gas at the payee address)" : r.sweepMethod === "allowance" ? "allowance from the payee address (relayer-funded gas)" : String(r.sweepMethod ?? "n/a")], ["Commitment", r.shieldedCommitment ?? r.commitment ?? "", true], ["Payee key", r.forwardSecrecyKeyZeroization === "CONFIRMED" ? "zeroized" : String(r.forwardSecrecyKeyZeroization ?? "n/a")]].filter((x) => x[1] !== "")
    })
  },
  audit: {
    title: "Audit export",
    lead: "Export the double-entry journal with the read-only viewing key. The spending key is never used and never included.",
    kind: "audit",
    endpoint: "/api/audit/export",
    confirm: "Generate export",
    fields: () => [
      { name: "token", label: "Asset", type: "select", options: tokenOptions(), value: state.status.asset.symbol, help: "One report per asset: WQUAI and WQI have separate journals and are never summed together." },
      { name: "format", label: "Format", type: "select", options: [{ value: "json", label: "JSON with SHA-256 checksum" }, { value: "csv", label: "CSV (RFC 4180)" }] }
    ],
    review: (p) => [["Asset", p.token], ["Format", p.format.toUpperCase()], ["Key used", "viewing key (read-only)"]],
    result: (r) => {
      let summary = null;
      if (r.format === "json") {
        try { const rep = JSON.parse(r.content); summary = [["Ending shielded balance", `${trimAmount(rep.financialSummary.endingShieldedBalance.formatted)} ${rep.financialSummary.assetSymbol}`], ["Transactions", String(rep.financialSummary.totalTransactions)], ["SHA-256", rep.cryptographicChecksum.sha256Hash, true]]; } catch { /* preview only */ }
      }
      return { title: "Export ready", rows: summary || [["Rows", String(r.content.split("\n").length - 1)]], code: r.content.split("\n").slice(0, 30).join("\n"), download: { name: `darkcircle-audit.${r.format}`, type: r.format === "csv" ? "text/csv" : "application/json", content: r.content } };
    }
  },
  checklist: {
    title: "Pre-flight checklist",
    lead: "Run the shielded-transaction checks without sending anything. The same checks gate every action.",
    kind: null,
    fields: (v) => [
      { name: "kind", label: "Transaction", type: "select", options: [{ value: "unshield", label: "Send payment" }, { value: "shield", label: "Shield funds" }, { value: "receive", label: "Receive payment" }, { value: "sweep", label: "Sweep to pool" }, { value: "audit", label: "Audit export" }], value: v.kind || "unshield" },
      ["unshield", "shield"].includes(v.kind || "unshield") ? { name: "address", label: v.kind === "shield" ? "Funding address" : "Recipient", mono: true } : null,
      ["unshield", "shield", "receive"].includes(v.kind || "unshield") ? { name: "amount", label: "Amount", placeholder: "5.0", inputmode: "decimal" } : null,
      ["unshield", "shield", "receive"].includes(v.kind || "unshield") ? { name: "token", label: "Asset", type: "select", options: tokenOptions(), value: state.status.asset.symbol } : null,
      v.kind === "sweep" ? { name: "invoiceId", label: "Invoice id", mono: true } : null
    ]
  }
};

function openFlow(name, preset = {}) {
  const def = FLOWS[name];
  // Clear the previous flow's fields first: renderStep() reads values back from the DOM, and stale
  // fields would leak one dialog's address and amount into the next.
  put($("#modal-body"));
  put($("#modal-foot"));
  flow = { name, def, step: 0, values: { ...preset }, checklist: null, seq: 0, ack: false, busy: false, result: null, timer: null };
  $("#modal-title").textContent = def.title;
  $("#modal-lead").textContent = def.lead;
  renderStep();
  if (!dlg.open) dlg.showModal();
  const first = $("#modal-body input:not([type=checkbox]), #modal-body select");
  if (first) first.focus();
}

function readValues() {
  const v = { ...flow.values };
  for (const el of document.querySelectorAll("#modal-body [data-field]")) {
    v[el.dataset.field] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  return v;
}

function schedule() {
  flow.values = readValues();
  clearTimeout(flow.timer);
  flow.checklist = null;
  paintChecklist(true);
  flow.timer = setTimeout(runChecklist, 250);
}

async function runChecklist() {
  if (!flow) return;
  const mySeq = ++flow.seq;
  const kind = flow.def.kind || flow.values.kind || "unshield";
  const p = flow.values;
  try {
    const res = await api("/api/checklist", { kind, address: p.address, amount: p.amount, token: p.token, invoiceId: p.invoiceId, wrapNative: !!p.wrapNative });
    if (!flow || mySeq !== flow.seq) return;
    flow.checklist = res;
  } catch (e) {
    if (!flow || mySeq !== flow.seq) return;
    flow.checklist = null;
    toast(e.message, "bad");
  }
  paintChecklist(false);
  paintFooter();
}

function paintChecklist(pending) {
  const slot = $("#checklist-slot");
  if (!slot) return;
  put(slot, renderChecklist(flow.checklist, pending));
}

function fieldEl(f) {
  if (f.type === "note") return h("div", { class: "callout info field", text: f.text });
  const id = `f-${f.name}`;
  if (f.type === "checkbox") {
    return h("div", { class: "field" }, h("label", { class: "check" }, h("input", { type: "checkbox", id, "data-field": f.name, ...(flow.values[f.name] ? { checked: true } : {}), onchange: () => { flow.values = readValues(); schedule(); } }), h("span", {}, f.label, f.help ? h("div", { class: "help", text: f.help }) : null)));
  }
  const value = flow.values[f.name] ?? f.value ?? "";
  const control =
    f.type === "select"
      ? h("select", { id, "data-field": f.name, onchange: () => { flow.values = readValues(); if (flow.name === "checklist" || f.name === "token") { renderStep(); } schedule(); } }, f.options.map((o) => h("option", { value: o.value, ...(o.value === value ? { selected: true } : {}), text: o.label })))
      : h("input", { type: "text", id, "data-field": f.name, class: f.mono ? "mono" : "", value, placeholder: f.placeholder || "", autocomplete: "off", spellcheck: "false", inputmode: f.inputmode, oninput: schedule });
  return h("div", { class: "field" }, h("label", { for: id, text: f.label }), control, f.help ? h("div", { class: "help", id: `${id}-help`, text: f.help }) : null);
}

function renderStep() {
  const def = flow.def;
  const labels = def.kind ? ["Details", "Review", "Result"] : ["Details"];
  steps(flow.step, labels);
  const body = $("#modal-body");

  if (flow.step === 0) {
    flow.values = { ...flow.values, ...readValuesSafe() };
    const fields = def.fields(flow.values).filter(Boolean);
    put(body, h("div", { class: "split" }, h("div", {}, fields.map(fieldEl)), h("div", { id: "checklist-slot" })));
    // seed defaults into values so the checklist sees them
    for (const f of fields) if (flow.values[f.name] === undefined && f.value !== undefined) flow.values[f.name] = f.value;
    if (flow.checklist) paintChecklist(false); else { paintChecklist(true); clearTimeout(flow.timer); flow.timer = setTimeout(runChecklist, 60); }
  } else if (flow.step === 1) {
    const cl = flow.checklist;
    const rows = def.review(flow.values, cl);
    put(body, 
      h("dl", { class: "kv" }, rows.map(([k, v]) => [h("dt", { text: k }), h("dd", { class: /^0x|address|Pay to|From/i.test(k + v) ? "mono" : "", text: v })])),
      cl.warnings > 0
        ? h("div", { class: "callout warn" }, h("strong", { text: `${cl.warnings} warning(s) apply. ` }), cl.items.filter((i) => i.status === "warn").map((i) => h("div", { text: `• ${i.title}: ${i.detail}` })), h("label", { class: "check ackrow" }, h("input", { type: "checkbox", id: "ack", onchange: (e) => { flow.ack = e.target.checked; paintFooter(); } }), h("span", { text: "I have read the warnings and want to proceed." })))
        : h("div", { class: "callout ok", text: "All checks passed." }),
      h("div", { id: "action-error" })
    );
  } else {
    const r = def.result(flow.result, flow.values);
    put(body, 
      h("div", { class: "callout ok" }, h("strong", { text: r.title })),
      h("dl", { class: "kv" }, r.rows.map(([k, v, cp]) => [h("dt", { text: k }), h("dd", { class: cp || /0x/.test(v) ? "mono" : "" }, v, cp ? copyBtn(v) : null)])),
      r.note ? h("p", { class: "lead", text: r.note }) : null,
      r.code ? h("pre", { class: "code", text: r.code }) : null
    );
  }
  paintFooter();
}

function readValuesSafe() {
  return document.querySelector("#modal-body [data-field]") ? readValues() : {};
}

function paintFooter() {
  const foot = $("#modal-foot");
  const def = flow.def;
  const cl = flow.checklist;
  if (flow.step === 0) {
    put(foot, 
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: closeModal, text: def.kind ? "Cancel" : "Close" }),
      def.kind ? h("button", { class: "btn primary", type: "button", id: "next", ...(!cl || !cl.canProceed ? { disabled: true } : {}), onclick: () => { flow.values = readValues(); flow.step = 1; flow.ack = false; renderStep(); }, text: "Review" }) : null
    );
  } else if (flow.step === 1) {
    const needAck = cl.warnings > 0 && !flow.ack;
    put(foot, 
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", disabled: flow.busy, onclick: () => { flow.step = 0; renderStep(); }, text: "Back" }),
      h("button", { class: "btn primary", type: "button", id: "confirm", disabled: flow.busy || needAck, onclick: submit, text: flow.busy ? "Working…" : def.confirm })
    );
  } else {
    const r = def.result(flow.result, flow.values);
    put(foot, 
      r.download ? h("button", { class: "btn", type: "button", onclick: () => download(r.download), text: "Download" }) : null,
      r.code ? h("button", { class: "btn", type: "button", onclick: () => copy(r.code), text: "Copy" }) : null,
      ...(r.after || []).map((a) => h("button", { class: "btn", type: "button", onclick: () => a.run(true), text: a.label })),
      h("span", { class: "spacer" }),
      h("button", { class: "btn primary", type: "button", onclick: closeModal, text: "Done" })
    );
  }
}

function download({ name, type, content }) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function submit() {
  flow.busy = true;
  paintFooter();
  const p = flow.values;
  try {
    const body = flow.name === "audit" ? { format: p.format, token: p.token, acknowledged: flow.ack } : { address: p.address, amount: p.amount, token: p.token, invoiceId: p.invoiceId, wrapNative: !!p.wrapNative, acknowledged: flow.ack };
    flow.result = await api(flow.def.endpoint, body);
    flow.busy = false;
    flow.step = 2;
    renderStep();
    toast(`${flow.def.title}: done`, "ok");
    await refresh();
  } catch (e) {
    flow.busy = false;
    if (e.checklist) { flow.checklist = e.checklist; }
    const slot = $("#action-error");
    if (slot) put(slot, h("div", { class: "callout bad" }, h("strong", { text: "Not sent. " }), e.message));
    toast(e.message, "bad");
    paintFooter();
  }
}

/* ---------------------------------------------------------------- side actions */
async function simulatePayment(invoiceId, fromModal) {
  try {
    const r = await api("/api/invoice/simulate-payment", { invoiceId });
    toast(r.verified ? "Simulated customer paid; invoice is SETTLED" : `Payment not accepted: ${r.error}`, r.verified ? "ok" : "bad");
    await refresh();
    if (fromModal && r.verified) { closeModal(); openFlow("sweep", { invoiceId }); }
  } catch (e) {
    toast(e.message, "bad");
  }
}

function confirmReset() {
  flow = { name: "reset", def: { title: "Reset simulation", lead: "", kind: null }, step: 0, values: {}, busy: false };
  $("#modal-title").textContent = "Reset both pools?";
  $("#modal-lead").textContent = "This discards the in-memory ledger and both pools (WQUAI and WQI) with their notes, invoices and journals, and starts a fresh simulation. To look at the other asset, use the asset switch instead.";
  put($("#modal-steps"), );
  const persisted = !!state.status?.persistence?.enabled;
  const go = h("button", { class: "btn primary", type: "button", disabled: true, onclick: async () => {
    try {
      const r = await api("/api/reset", { asset: state.active, confirm: "RESET" });
      flow = null;
      dlg.close();
      await refresh();
      toast(r.preservedSnapshot ? `Simulation reset. The previous state is kept as snapshot #${r.preservedSnapshot.seq} (pinned).` : "Simulation reset", "ok");
    } catch (e) { toast(e.message, "bad"); }
  }, text: "Reset both pools" });
  const typed = h("input", { id: "reset-confirm", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "RESET", oninput: (e) => { go.disabled = e.target.value !== "RESET"; } });
  put($("#modal-body"),
    h("div", { class: "callout warn", text: persisted
      ? "Persistence is on: the current state is saved and pinned as a snapshot first, so it is never pruned and can be restored later. Then every note, invoice and payee key in memory is discarded."
      : "Nothing here is on a real chain, so nothing real is lost. Every note, invoice and payee key in this session is discarded." }),
    h("div", { class: "field" }, h("label", { for: "reset-confirm", text: "Type RESET to confirm" }), typed)
  );
  put($("#modal-foot"),
    h("span", { class: "spacer" }),
    h("button", { class: "btn", type: "button", onclick: closeModal, text: "Cancel" }),
    go
  );
  dlg.showModal();
}

document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openFlow(b.dataset.open)));
$("#btn-reset").addEventListener("click", () => confirmReset());

function enterStaticPreview() {
  document.documentElement.setAttribute("data-static-preview", "1");
  const banner = $("#sim-banner");
  if (banner) {
    put(banner,
      h("strong", { text: "Static preview" }),
      h("span", { text: "This copy is hosted without the DarkCircle server, so no ledger, pool or wallet bridge sits behind it and its actions are switched off. Run the console locally to use it." })
    );
  }
  for (const control of document.querySelectorAll("[data-open], #btn-reset")) {
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    control.title = "Needs the DarkCircle server; this is the static preview";
  }
  put($("#main"),
    h("section", { class: "callout info" },
      h("h2", { text: "DarkCircle Console, static preview" }),
      h("p", { text: "The console is a local tool: it runs a server on your machine that keeps the shielded-pool simulation, the invoices and the journal, and bridges to your own Quai wallet. This hosted page is only its interface, with nothing behind it." }),
      h("p", { text: "To run it, start the console from the x402tumbler folder with the ui script, then open the address it prints. Nothing on this hosted page can move funds, and it never holds a key." })
    )
  );
  const agent = $("#agent-root");
  if (agent) put(agent);
}

if (STATIC_PREVIEW) {
  enterStaticPreview();
} else {
  refresh().catch((e) => toast(`Could not load: ${e.message}`, "bad"));
  mountAgent({ api, h, put, toast, short, root: $("#agent-root") });

  // @admin:begin
  // The admin console is fetched only when the server says it is enabled; otherwise nothing is requested.
  if (document.querySelector('meta[name="darkcircle-admin"]')?.content === "1") {
    import("/admin/admin.js")
      .then((m) => m.mountAdmin({ api, h, put, toast, copy, copyBtn, short, plural, when, refresh, state, slot: $("#admin-slot") }))
      .catch((e) => toast(`The admin console could not be loaded: ${e.message}`, "bad"));
  }
  // @admin:end
}
