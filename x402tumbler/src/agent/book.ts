/**
 * DarkCircle agent: the user's book (contacts, paid services, spending limits, activity)
 * File: src/agent/book.ts
 *
 * Voice cannot carry a 42-character address, so a spoken recipient is always a NAME the user saved here
 * beforehand, with its address typed or pasted and checked (Quai ledger, the configured zone). The same goes for
 * the x402 services the agent may buy from. Limits cap what any single confirmed action and any 24 hours may
 * spend, per asset, on top of the per-action confirmation.
 *
 * Nothing here is secret, but all of it is private (who the user pays, and how much): with a data directory it
 * is kept in the same AES-256-GCM store as the rest of the state, otherwise in memory only.
 */

import { assertQuaiPaymentAddress } from "../quai/address.ts";
import { DEFAULT_QUAI_NETWORK } from "../quai/networks.ts";
import { formatTokenAmount, parseTokenAmount } from "../quai/tokens.ts";
import { SpendTracker, type SpendEntry } from "../proxy/spendTracker.ts";
import { canonicalName, type AssetSymbol } from "./grammar.ts";

export const ASSETS: readonly AssetSymbol[] = ["QUAI", "WQUAI", "WQI"];
/** The spend tracker's key for the native asset (tokens use their address). */
export const NATIVE_KEY = "native:quai";

export interface Contact {
  name: string;
  canonical: string;
  address: string;
  addedAt: number;
}

export interface Service {
  name: string;
  canonical: string;
  url: string;
  /** Most the agent may pay for one request to this service, in `asset`. */
  maxAmount: string;
  asset: AssetSymbol;
  addedAt: number;
}

/** Decimal token amounts per asset. */
export type Limits = Record<AssetSymbol, string>;

export interface Policy {
  perAction: Limits;
  daily: Limits;
}

export type ActivityStatus = "answered" | "planned" | "confirmed" | "sent" | "done" | "failed" | "refused" | "cancelled" | "expired";

export interface ActivityEntry {
  id: string;
  at: number;
  network: string;
  said: string;
  kind: string;
  summary: string;
  status: ActivityStatus;
  txHashes: string[];
  detail?: string;
}

export interface BookData {
  version: 1;
  contacts: Contact[];
  services: Service[];
  policy: Policy;
  spends: Array<{ at: number; token: string; amount: string }>;
  activity: ActivityEntry[];
}

/** Where the book is kept. `null` from load() means nothing was saved yet. */
export interface BookStore {
  load(): string | null;
  save(json: string): void;
}

/** The book in an encrypted snapshot store (src/persistence/store.ts): each change is a new authenticated snapshot. */
export function encryptedBookStore(store: { load(): { plaintext: string } | null; save(plaintext: string): unknown }): BookStore {
  return { load: () => store.load()?.plaintext ?? null, save: (json) => void store.save(json) };
}

/** Conservative until the user raises them: these move real funds. */
export const DEFAULT_POLICY: Policy = {
  perAction: { QUAI: "25", WQUAI: "25", WQI: "25" },
  daily: { QUAI: "100", WQUAI: "100", WQI: "100" }
};
const MAX_LIMIT = parseTokenAmount("1000000", 18);
const RESERVED_NAMES = new Set(["me", "my", "myself", "the", "pool", "quai", "wquai", "wqi", "qi", "it", "that", "this", "all", "everyone"]);
const MAX_CONTACTS = 500;
const MAX_SERVICES = 200;
const MAX_ACTIVITY = 200;

export class AgentBook {
  private contacts = new Map<string, Contact>();
  private services = new Map<string, Service>();
  private policy: Policy = structuredClone(DEFAULT_POLICY);
  private readonly tracker = new SpendTracker();
  private activity: ActivityEntry[] = [];
  private readonly store?: BookStore;

  constructor(store?: BookStore) {
    this.store = store;
    const saved = store?.load();
    if (saved) this.restore(JSON.parse(saved) as BookData);
  }

  public get persistent(): boolean {
    return this.store !== undefined;
  }

  /* ---------------------------------------------------------------- contacts */

  public listContacts(): Contact[] {
    return [...this.contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  public addContact(name: unknown, address: unknown): Contact {
    const n = cleanName(name);
    const canonical = canonicalName(n);
    if (this.contacts.has(canonical)) throw new Error(`ERR_CONTACT_EXISTS: '${n}' is already saved; remove it first to change its address`);
    if (this.contacts.size >= MAX_CONTACTS) throw new Error("ERR_CONTACTS_FULL");
    let checked: string;
    try {
      checked = assertQuaiPaymentAddress(String(address ?? ""), DEFAULT_QUAI_NETWORK);
    } catch (err) {
      throw new Error(`ERR_CONTACT_ADDRESS: ${(err as Error).message}`);
    }
    const c: Contact = { name: n, canonical, address: checked, addedAt: Date.now() };
    this.contacts.set(canonical, c);
    this.persist();
    return c;
  }

  public removeContact(name: unknown): boolean {
    const ok = this.contacts.delete(canonicalName(String(name ?? "")));
    if (ok) this.persist();
    return ok;
  }

  /** Exact match on the canonical name, or the near misses to offer (never picked automatically: this is money). */
  public findContact(spoken: string): { contact: Contact | null; nearby: string[] } {
    const want = canonicalName(spoken);
    const hit = this.contacts.get(want);
    if (hit) return { contact: hit, nearby: [] };
    return { contact: null, nearby: nearest(want, [...this.contacts.values()]).map((c) => c.name) };
  }

  /* ---------------------------------------------------------------- services */

  public listServices(): Service[] {
    return [...this.services.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  public addService(name: unknown, url: unknown, maxAmount: unknown, asset: unknown): Service {
    const n = cleanName(name);
    const canonical = canonicalName(n);
    if (this.services.has(canonical)) throw new Error(`ERR_SERVICE_EXISTS: '${n}' is already saved`);
    if (this.services.size >= MAX_SERVICES) throw new Error("ERR_SERVICES_FULL");
    const u = String(url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new Error("ERR_SERVICE_URL: not a URL");
    }
    if (!/^https?:$/.test(parsed.protocol) || u.length > 400 || parsed.username || parsed.password) {
      throw new Error("ERR_SERVICE_URL: use an http(s) URL without credentials in it");
    }
    const a = cleanAsset(asset);
    if (a === "QUAI") throw new Error("ERR_SERVICE_ASSET: x402 payments are ERC-20 transfers; choose WQUAI or WQI");
    const max = cleanLimit(maxAmount, "maxAmount");
    const s: Service = { name: n, canonical, url: parsed.toString(), maxAmount: max, asset: a, addedAt: Date.now() };
    this.services.set(canonical, s);
    this.persist();
    return s;
  }

  public removeService(name: unknown): boolean {
    const ok = this.services.delete(canonicalName(String(name ?? "")));
    if (ok) this.persist();
    return ok;
  }

  public findService(spoken: string): { service: Service | null; nearby: string[] } {
    const want = canonicalName(spoken);
    const hit = this.services.get(want);
    if (hit) return { service: hit, nearby: [] };
    return { service: null, nearby: nearest(want, [...this.services.values()]).map((s) => s.name) };
  }

  /* ---------------------------------------------------------------- limits */

  public getPolicy(): Policy {
    return structuredClone(this.policy);
  }

  public setPolicy(p: { perAction?: Partial<Record<string, unknown>>; daily?: Partial<Record<string, unknown>> }): Policy {
    const next = structuredClone(this.policy);
    for (const a of ASSETS) {
      if (p.perAction?.[a] !== undefined) next.perAction[a] = cleanLimit(p.perAction[a], `perAction.${a}`);
      if (p.daily?.[a] !== undefined) next.daily[a] = cleanLimit(p.daily[a], `daily.${a}`);
      if (parseTokenAmount(next.perAction[a], 18) > parseTokenAmount(next.daily[a], 18)) {
        throw new Error(`ERR_POLICY: the per-action limit for ${a} is above its daily limit`);
      }
    }
    this.policy = next;
    this.persist();
    return this.getPolicy();
  }

  /** Throws when `amount` (base units of `asset`, keyed by `trackerKey`) breaks a limit. */
  public assertWithinLimits(asset: AssetSymbol, trackerKey: string, amount: bigint): void {
    const per = parseTokenAmount(this.policy.perAction[asset], 18);
    if (amount > per) {
      throw new Error(`ERR_LIMIT_PER_ACTION: ${formatTokenAmount(amount)} ${asset} is above your per-action limit of ${this.policy.perAction[asset]} ${asset}`);
    }
    try {
      this.tracker.assertWithin(parseTokenAmount(this.policy.daily[asset], 18), trackerKey, amount);
    } catch {
      const spent = this.tracker.spent(trackerKey);
      throw new Error(`ERR_LIMIT_DAILY: ${formatTokenAmount(spent)} ${asset} already spent in the last 24 hours; ${formatTokenAmount(amount)} more would pass your daily limit of ${this.policy.daily[asset]} ${asset}`);
    }
  }

  public recordSpend(trackerKey: string, amount: bigint): void {
    this.tracker.record(trackerKey, amount);
    this.persist();
  }

  public spentToday(trackerKey: string): bigint {
    return this.tracker.spent(trackerKey);
  }

  /* ---------------------------------------------------------------- activity */

  public log(entry: ActivityEntry): ActivityEntry {
    // an update (a plan that moved on) becomes the newest entry, so the log reads in the order things happened
    this.activity = this.activity.filter((e) => e.id !== entry.id);
    this.activity.push(entry);
    if (this.activity.length > MAX_ACTIVITY) this.activity = this.activity.slice(-MAX_ACTIVITY);
    this.persist();
    return entry;
  }

  public recentActivity(n = 50): ActivityEntry[] {
    return this.activity.slice(-n).reverse();
  }

  /* ---------------------------------------------------------------- persistence */

  public toData(): BookData {
    return {
      version: 1,
      contacts: this.listContacts(),
      services: this.listServices(),
      policy: this.getPolicy(),
      spends: this.tracker.entries().map((e) => ({ at: e.at, token: e.token, amount: e.amount.toString() })),
      activity: this.activity
    };
  }

  private restore(d: BookData): void {
    if (d?.version !== 1) throw new Error("ERR_AGENT_BOOK_VERSION: unknown agent book format");
    for (const c of d.contacts ?? []) this.contacts.set(c.canonical, c);
    for (const s of d.services ?? []) this.services.set(s.canonical, s);
    if (d.policy) this.policy = d.policy;
    this.tracker.load((d.spends ?? []).map((e): SpendEntry => ({ at: e.at, token: e.token, amount: BigInt(e.amount) })));
    this.activity = d.activity ?? [];
  }

  private persist(): void {
    this.store?.save(JSON.stringify(this.toData()));
  }
}

function cleanName(v: unknown): string {
  const n = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!/^[\p{L}\p{N} .&'-]{1,40}$/u.test(n)) throw new Error("ERR_NAME: use 1 to 40 letters, digits, spaces, . & ' or -");
  const canonical = canonicalName(n);
  if (!canonical || RESERVED_NAMES.has(canonical)) throw new Error(`ERR_NAME: '${n}' would be confused with a word the agent listens for`);
  if (/@/.test(canonical)) throw new Error("ERR_NAME: a name cannot be an asset name");
  return n;
}

function cleanAsset(v: unknown): AssetSymbol {
  const a = String(v ?? "").trim().toUpperCase();
  if (!(ASSETS as readonly string[]).includes(a)) throw new Error(`ERR_ASSET: one of ${ASSETS.join(", ")}`);
  return a as AssetSymbol;
}

function cleanLimit(v: unknown, field: string): string {
  const s = String(v ?? "").trim();
  let units: bigint;
  try {
    units = parseTokenAmount(s, 18);
  } catch {
    throw new Error(`ERR_LIMIT_VALUE: ${field} must be a token amount such as 25 or 2.5`);
  }
  if (units <= 0n || units > MAX_LIMIT) throw new Error(`ERR_LIMIT_VALUE: ${field} must be above 0 and at most 1,000,000`);
  return formatTokenAmount(units).replace(/\.0$/, "");
}

/** Saved names within edit distance 2 of what was heard (suggestions only). */
function nearest<T extends { canonical: string }>(want: string, items: T[]): T[] {
  return items.filter((i) => distance(i.canonical, want) <= Math.max(1, Math.min(2, Math.floor(want.length / 4)))).slice(0, 3);
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
