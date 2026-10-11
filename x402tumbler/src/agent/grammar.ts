/**
 * DarkCircle agent: the command grammar
 * File: src/agent/grammar.ts
 *
 * Turns what the user said (a speech transcript, or typed text) into ONE typed intent from a closed list, or a
 * refusal that says what was not understood. It is deliberately a grammar, not a language model: it runs
 * offline, needs no key, gives the same answer every time, and cannot be talked into an operation that is not
 * on the list. It never resolves who "Acme" is or what anything costs; the planner does that against the
 * user's own address book and the chain, and nothing here moves funds.
 *
 * Spends always need an explicit asset ("send 5 WQUAI to Acme"): an amount is never assumed to be in some
 * default token.
 */

import { normalizeNumbers, readDigitCode } from "./numbers.ts";

export type AssetSymbol = "QUAI" | "WQUAI" | "WQI";

export type Intent =
  | { kind: "balance"; asset?: AssetSymbol }
  | { kind: "wrap"; amount: string }
  | { kind: "unwrap"; amount: string }
  | { kind: "send"; asset: AssetSymbol; amount: string; to: string }
  | { kind: "buy"; service: string }
  | { kind: "confirm"; code: string }
  | { kind: "cancel" }
  | { kind: "help" }
  | { kind: "contacts" }
  | { kind: "services" };

export type ParseResult =
  | { ok: true; intent: Intent; heard: string }
  | { ok: false; code: string; message: string; heard: string };

/** What the agent understands, phrased the way it is best said. Shown on "help" and after a failed parse. */
export const EXAMPLES = [
  "what's my balance",
  "how much WQI do I have",
  "wrap 5 QUAI",
  "unwrap 2.5 WQUAI",
  "send 10 WQUAI to Acme",
  "pay Acme 3 WQI",
  "buy the analytics report",
  "confirm 4 1 7",
  "cancel"
];

const LEADING_FILLER = [
  ["hey"], ["hi"], ["ok"], ["okay"], ["agent"], ["dark", "circle"], ["darkcircle"], ["please"], ["kindly"], ["just"],
  ["can", "you"], ["could", "you"], ["would", "you"], ["will", "you"], ["i", "want", "to"], ["i", "would", "like", "to"],
  ["i", "wanna"], ["go", "ahead", "and"], ["lets"], ["let", "us"]
];
const TRAILING_FILLER = [["please"], ["thanks"], ["thank", "you"], ["now"], ["for", "me"]];

/** Spoken spellings of each asset, longest first. "@QI" is native Qi: a different ledger, refused. */
const ASSET_ALIASES: Array<[string[], string]> = [
  [["double", "u", "quai"], "@WQUAI"], [["double", "you", "quai"], "@WQUAI"], [["wrapped", "quai"], "@WQUAI"], [["wrapped", "kwai"], "@WQUAI"],
  [["w", "quai"], "@WQUAI"], [["w", "kwai"], "@WQUAI"], [["w", "quais"], "@WQUAI"], [["wquai"], "@WQUAI"], [["wquais"], "@WQUAI"], [["wkwai"], "@WQUAI"],
  [["double", "u", "qi"], "@WQI"], [["double", "you", "qi"], "@WQI"], [["wrapped", "qi"], "@WQI"], [["wrapped", "chi"], "@WQI"], [["wrapped", "chee"], "@WQI"],
  [["w", "qi"], "@WQI"], [["w", "chi"], "@WQI"], [["w", "chee"], "@WQI"], [["wqi"], "@WQI"], [["wchi"], "@WQI"],
  [["quai"], "@QUAI"], [["quais"], "@QUAI"], [["kwai"], "@QUAI"], [["qwai"], "@QUAI"],
  [["qi"], "@QI"]
];

function startsWith(tokens: string[], phrase: string[], at = 0): boolean {
  return phrase.every((w, k) => tokens[at + k] === w);
}

function stripFiller(tokens: string[]): string[] {
  let t = [...tokens];
  for (let changed = true; changed && t.length; ) {
    changed = false;
    for (const f of LEADING_FILLER) {
      if (startsWith(t, f) && t.length > f.length) {
        t = t.slice(f.length);
        changed = true;
      }
    }
  }
  for (let changed = true; changed && t.length; ) {
    changed = false;
    for (const f of TRAILING_FILLER) {
      if (t.length > f.length && startsWith(t, f, t.length - f.length)) {
        t = t.slice(0, t.length - f.length);
        changed = true;
      }
    }
  }
  return t;
}

/** Whisper writes "two and a half" as "2 ½" or "2½" often enough to matter. */
const VULGAR_FRACTIONS: Record<string, string> = { "½": "5", "¼": "25", "¾": "75" };

/** Lowercase words, punctuation removed (decimal points kept), digit/letter runs split ("5wquai" -> "5 wquai"). */
export function tokenize(text: string): string[] {
  const s = String(text)
    .toLowerCase()
    .replace(/(?<![\d.])(\d+) ?([½¼¾])/g, (_, n: string, f: string) => `${n}.${VULGAR_FRACTIONS[f]}`)
    .replace(/(?<![\d.])([½¼¾])/g, (_, f: string) => `0.${VULGAR_FRACTIONS[f]}`)
    .replace(/[‘’]/g, "'")
    .replace(/\bwhat's\b/g, "what is")
    .replace(/\bi'd\b/g, "i would")
    .replace(/'/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d)\.(?=\d)/g, "$1\u0000")
    .replace(/[$€£]/g, " ")
    .replace(/[.!?,;:"()\[\]{}<>@#*]/g, " ")
    .replace(/\u0000/g, ".")
    .replace(/[-_/]/g, " ")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2");
  return s.split(/\s+/).filter(Boolean);
}

function replaceAssets(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const hit = ASSET_ALIASES.find(([phrase]) => startsWith(tokens, phrase, i));
    if (hit) {
      out.push(hit[1]);
      i += hit[0].length;
    } else out.push(tokens[i++]);
  }
  return out;
}

/** The canonical form of a name, so "ACME Corp." and "acme corp" are the same contact. */
export function canonicalName(name: string): string {
  return normalizeNumbers(tokenize(name)).join(" ");
}

/** What the grammar matches against: filler removed, numbers as decimals, assets as @SYMBOL. */
export function canonicalize(text: string): string {
  return replaceAssets(normalizeNumbers(stripFiller(tokenize(text)))).join(" ");
}

const NUM = "(\\d+(?:\\.\\d+)?)";
const ASSET = "@(QUAI|WQUAI|WQI)";
const fail = (code: string, message: string, heard: string): ParseResult => ({ ok: false, code, message, heard });

export function parseCommand(text: string): ParseResult {
  if (typeof text !== "string" || text.trim() === "") return fail("EMPTY", "Nothing was heard.", "");
  if (text.length > 300) return fail("TOO_LONG", "That is too long for one command; say one thing at a time.", text.slice(0, 80));
  const heard = canonicalize(text);
  const ok = (intent: Intent): ParseResult => ({ ok: true, intent, heard });
  const m = (re: string) => new RegExp(`^${re}$`).exec(heard);
  let r: RegExpExecArray | null;

  // ---- conversation control
  const words = heard.split(" ");
  if (["confirm", "approve", "yes"].includes(words[0])) {
    const rest = words.slice(words[1] === "confirm" ? 2 : 1);
    const code = readDigitCode(rest);
    if (code) return ok({ kind: "confirm", code });
    return fail("CONFIRM_NEEDS_CODE", "Say the confirmation code shown with the plan, for example 'confirm 4 1 7'.", heard);
  }
  if (m("(cancel|stop|abort|never ?mind|no|forget (it|that))( (it|that|this))?")) return ok({ kind: "cancel" });
  if (m("(help|commands|what can (you|i) (do|say)|what (are|is) (the|your) commands)")) return ok({ kind: "help" });
  if (m("((list|show)( me)?( my)? )?(contacts|address book)|who can i (pay|send to)")) return ok({ kind: "contacts" });
  if (m("((list|show)( me)?( my)? )?services|what can i buy")) return ok({ kind: "services" });

  // ---- things that sound like operations but are not available here
  if (heard.includes("@QI")) {
    return fail("QI_LEDGER_UNSUPPORTED", "Qi lives on Quai's UTXO ledger, which this agent does not operate. Did you mean WQI (wrapped Qi)?", heard);
  }
  if (m(`(shield|deposit|hide|protect) .*`) || m(`.* into (the )?(shielded )?pool`)) {
    return fail(
      "SHIELD_NOT_AVAILABLE",
      "Shielding on Quai is not available yet: private withdrawals from the pool are not built, so shielded funds could not be taken out again. Public operations (send, wrap, buy) are available.",
      heard
    );
  }
  if (m(`(privately|anonymously|secretly|private(ly)?) .*`) || m(`.* (privately|anonymously|secretly|in private)`)) {
    return fail("PRIVATE_NOT_AVAILABLE", "Private payments on Quai need the shielded pool and are not available yet. Say 'send' for a public payment.", heard);
  }

  // ---- queries
  if ((r = m(`(what is |show( me)? |check |tell me |get )?(my )?(${ASSET} )?balances?( (of|in|for) ${ASSET})?`))) {
    const asset = (r[5] ?? r[8]) as AssetSymbol | undefined;
    return ok(asset ? { kind: "balance", asset } : { kind: "balance" });
  }
  if ((r = m(`how much( ${ASSET})? (do i have|have i got|is (in )?my wallet|is left|do i have left)`))) {
    const asset = r[2] as AssetSymbol | undefined;
    return ok(asset ? { kind: "balance", asset } : { kind: "balance" });
  }

  // ---- wrapping
  if ((r = m(`(wrap|convert) ${NUM}( @QUAI)?( (in)?to @WQUAI)?`))) {
    if (r[1] === "convert" && !r[3] && !r[4]) return fail("CONVERT_AMBIGUOUS", "Say what to convert to, for example 'convert 5 QUAI to WQUAI' or 'unwrap 5 WQUAI'.", heard);
    return positive(r[2], heard) ?? ok({ kind: "wrap", amount: r[2] });
  }
  if ((r = m(`unwrap ${NUM}( @WQUAI)?( (in)?to @QUAI)?`)) || (r = m(`convert ${NUM} @WQUAI (in)?to @QUAI`))) {
    return positive(r[1], heard) ?? ok({ kind: "unwrap", amount: r[1] });
  }
  if (m(`(wrap|unwrap|convert) .*`)) return fail("WRAP_NOT_UNDERSTOOD", "Say for example 'wrap 5 QUAI' or 'unwrap 2 WQUAI'.", heard);

  // ---- sending (an explicit asset is required)
  const verbs = "(send|pay|transfer|give)";
  if ((r = m(`${verbs} ${NUM} ${ASSET} to (.+)`))) return send(r[2], r[3] as AssetSymbol, r[4], heard);
  if ((r = m(`${verbs} (.+?) ${NUM} ${ASSET}`))) return send(r[3], r[4] as AssetSymbol, r[2], heard);
  if (m(`${verbs} ${NUM} ${ASSET}`)) return fail("NEED_RECIPIENT", "Say who to send to: one of your saved contacts, for example 'send 5 WQUAI to Acme'.", heard);
  if (m(`${verbs} ${NUM} to .+`) || m(`${verbs} .+ ${NUM}`)) {
    return fail("NEED_ASSET", "Say which asset to send, for example 'send 5 WQUAI to Acme'. Amounts are never assumed to be in a default token.", heard);
  }

  // ---- buying a paid (x402) resource through the agent
  if ((r = m(`(buy|purchase|get|fetch|access|unlock|download|pay for|order)( me)?( the| a| an| some| my)? (.+)`))) {
    const service = r[4].trim();
    if (/\d/.test(service) && /@/.test(service)) return fail("NOT_UNDERSTOOD", "That sounds like a payment; say 'send <amount> <asset> to <contact>'.", heard);
    return ok({ kind: "buy", service });
  }

  return fail("NOT_UNDERSTOOD", `Not understood. Try: ${EXAMPLES.slice(0, 5).join("; ")}.`, heard);
}

function positive(amount: string, heard: string): ParseResult | null {
  return /^0+(\.0+)?$/.test(amount) ? fail("AMOUNT_ZERO", "The amount must be more than zero.", heard) : null;
}

function send(amount: string, asset: AssetSymbol, to: string, heard: string): ParseResult {
  const zero = positive(amount, heard);
  if (zero) return zero;
  const name = to.replace(/^(the|my) /, "").trim();
  if (!name || /@/.test(name)) return fail("NEED_RECIPIENT", "Say who to send to: one of your saved contacts, for example 'send 5 WQUAI to Acme'.", heard);
  return { ok: true, intent: { kind: "send", asset, amount, to: name }, heard };
}
