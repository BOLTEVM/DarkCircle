// Token metadata for the swap UI: what the chain says, what the explorer adds, and how to show it safely.
//
// Design rules (each one is a bug the first implementation had):
//  * The chain is the source of truth for name / symbol / decimals / totalSupply. The explorer only adds
//    presentation data (icon, website, description, holders, USD price). Decimals are NEVER taken from the
//    explorer and NEVER defaulted to 0: a failed read leaves them undefined and the caller keeps the
//    registry value, because a wrong decimals value silently misprices every amount.
//  * One failed read must not discard the others (the first version used Promise.all over four calls).
//  * All the chain reads for every token go out as ONE JSON-RPC batch, not 4 requests per token.
//  * Anything a token contract or the explorer returns is untrusted text: control characters, bidi
//    overrides, zero-width characters and absurd lengths are removed before it can reach the UI, and icon
//    URLs are resolved against the explorer origin (they arrive as "/token-icons/...") and restricted to https.
//  * A failure is cached briefly, not forever, and a success is cached with a TTL (stale values are shown
//    immediately while a refresh runs).
//
// This module has no imports so it can be loaded and tested in plain Node.

const DEFAULT_RPC_URL = 'https://rpc.quai.network/cyprus1';
const DEFAULT_EXPLORER_URL = 'https://explorer.qu.ai';
const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const DEFAULT_ARWEAVE_GATEWAY = 'https://arweave.net/';

const SEL_NAME = '0x06fdde03';
const SEL_SYMBOL = '0x95d89b41';
const SEL_DECIMALS = '0x313ce567';
const SEL_TOTAL_SUPPLY = '0x18160ddd';

export const TOKEN_PROFILE_STORAGE_KEY = 'circleswap.token-profiles.v1';
/** Name, symbol, decimals, supply, icon: these change essentially never. */
export const PROFILE_TTL_MS = 6 * 60 * 60_000;
/** USD price and holder count move; refresh the explorer data more often. */
export const MARKET_TTL_MS = 5 * 60_000;
/** After a failed read, wait this long before asking again. */
export const NEGATIVE_TTL_MS = 60_000;

const MAX_STORED_PROFILES = 120;
const RPC_BATCH_CALLS = 40;
const RPC_TIMEOUT_MS = 15_000;
const EXPLORER_TIMEOUT_MS = 8_000;

export interface TokenProfile {
  /** Lower-case contract address. */
  address: string;
  name?: string;
  symbol?: string;
  /** From the chain only, 0..36. Undefined when the read failed; never defaulted. */
  decimals?: number;
  /** Base units, decimal string. */
  totalSupply?: string;
  /** Absolute https (or data:image) URL, resolved against the explorer. */
  iconUrl?: string;
  website?: string;
  description?: string;
  holders?: number;
  priceUsd?: number;
  marketCapUsd?: number;
  /** Which sources contributed at least one field. */
  source: { chain: boolean; explorer: boolean };
  fetchedAt: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

// C0/C1 controls, soft hyphen, zero-width and bidi formatting characters, line/paragraph separators,
// word joiners, invisible operators, BOM, interlinear annotation. None belongs in a token name.
const INVISIBLE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{FFF9}-\u{FFFB}]/gu;

/** Make untrusted text safe to render on one line; undefined when nothing printable is left. */
export function sanitizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, Math.max(1, max - 1)).trimEnd() + '\u2026' : cleaned;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Decode the return value of name() / symbol(). Handles the standard ABI dynamic string, the legacy
 * bytes32 form (MKR-style tokens), and UTF-8. Returns undefined for empty or malformed data instead of
 * leaking raw hex into the UI (the previous decoder returned the hex string itself for short data).
 */
export function decodeAbiString(hex: unknown): string | undefined {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return undefined;
  const data = hex.slice(2);
  if (data.length === 0 || data.length % 2 !== 0) return undefined;
  let bytes: Uint8Array;
  if (data.length === 64) {
    // bytes32: right-padded with zero bytes
    bytes = hexToBytes(data);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    bytes = bytes.subarray(0, end);
  } else {
    if (data.length < 128) return undefined;
    const offsetWord = BigInt('0x' + data.slice(0, 64));
    if (offsetWord > 0xffffn || offsetWord % 32n !== 0n) return undefined;
    const lenAt = Number(offsetWord) * 2;
    if (lenAt + 64 > data.length) return undefined;
    const length = BigInt('0x' + data.slice(lenAt, lenAt + 64));
    if (length > 1024n) return undefined;
    const start = lenAt + 64;
    const end = start + Number(length) * 2;
    if (end > data.length) return undefined;
    bytes = hexToBytes(data.slice(start, end));
  }
  if (bytes.length === 0) return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** A 256-bit unsigned integer return value, or undefined. */
export function decodeAbiUint(hex: unknown): bigint | undefined {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) return undefined;
  return BigInt(hex);
}

/** decimals() must be a small integer; anything else is "unknown", not 0. */
export function decodeDecimals(hex: unknown): number | undefined {
  const value = decodeAbiUint(hex);
  if (value === undefined || value > 36n) return undefined;
  return Number(value);
}

/**
 * Some names carry a bracketed tag, e.g. "BOLTDELTA [delta.boltevm.com]". Split it so the list can show the
 * name cleanly and the tag as secondary text instead of truncating mid-bracket.
 */
export function splitDisplayName(name: string): { title: string; tag?: string } {
  const match = /^(.*?)\s*\[([^\[\]]{1,64})\]\s*$/.exec(name);
  if (match && match[1].trim()) return { title: match[1].trim(), tag: match[2].trim() };
  return { title: name };
}

/** 0x0032\u20268379 */
export function shortAddress(address: string, head = 6, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}\u2026${address.slice(-tail)}`;
}

/**
 * Turn whatever the explorer or a token returns for an icon into one safe absolute URL.
 * The explorer returns root-relative paths ("/token-icons/\u2026", "/api/nft-media/\u2026"); resolving those against
 * the app's own origin is what made every logo 404 and fall back to a letter.
 */
export function resolveIconUrl(
  raw: unknown,
  explorerUrl: string = DEFAULT_EXPLORER_URL,
  gateways: { ipfs?: string; arweave?: string } = {}
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value || value.length > 2048) return undefined;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value.length <= 200_000 ? value : undefined;
  if (/^data:/i.test(value)) return undefined;
  const ipfs = (gateways.ipfs ?? DEFAULT_IPFS_GATEWAY).replace(/\/?$/, '/');
  const arweave = (gateways.arweave ?? DEFAULT_ARWEAVE_GATEWAY).replace(/\/?$/, '/');
  let candidate = value;
  if (candidate.startsWith('ipfs://')) candidate = ipfs + candidate.slice('ipfs://'.length).replace(/^ipfs\//, '');
  else if (candidate.startsWith('ar://')) candidate = arweave + candidate.slice('ar://'.length);
  try {
    const url = new URL(candidate, explorerUrl.replace(/\/?$/, '/'));
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 512) return undefined;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function positiveNumber(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------------------------
// Chain reads (one batch)
// ---------------------------------------------------------------------------------------------

export interface ChainFields {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
}

interface Net {
  fetch: FetchLike;
  rpcUrl: string;
  explorerUrl: string;
}

/**
 * Run many read-only `quai_call`s as JSON-RPC batch requests (40 per request), falling back to single calls when a
 * node rejects batches. Every call is isolated: a failure yields `undefined` for that call only. Shared by the farm
 * reader so the browser, the CLI and the tests all go through one implementation.
 */
export async function batchQuaiCall(
  calls: { to: string; data: string }[],
  net: { fetch?: FetchLike; rpcUrl?: string } = {}
): Promise<(string | undefined)[]> {
  const fetchImpl: FetchLike = net.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return rpcCalls(calls, { fetch: fetchImpl, rpcUrl: net.rpcUrl ?? DEFAULT_RPC_URL, explorerUrl: DEFAULT_EXPLORER_URL });
}

async function rpcCalls(calls: { to: string; data: string }[], net: Net): Promise<(string | undefined)[]> {
  const results: (string | undefined)[] = new Array(calls.length).fill(undefined);
  const request = (id: number, c: { to: string; data: string }) => ({
    jsonrpc: '2.0', id, method: 'quai_call', params: [{ to: c.to, data: c.data }, 'latest']
  });
  const post = async (body: unknown) => {
    const res = await net.fetch(net.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    return res.json() as Promise<unknown>;
  };

  for (let from = 0; from < calls.length; from += RPC_BATCH_CALLS) {
    const slice = calls.slice(from, from + RPC_BATCH_CALLS);
    let answered = false;
    try {
      const reply = await post(slice.map((c, i) => request(i, c)));
      if (Array.isArray(reply)) {
        answered = true;
        for (const item of reply as { id?: number; result?: unknown; error?: unknown }[]) {
          if (item && typeof item.id === 'number' && typeof item.result === 'string' && !item.error) {
            results[from + item.id] = item.result;
          }
        }
      }
    } catch {
      // fall through to single calls
    }
    if (answered) continue;
    // A node that rejects batches: ask one at a time, a few in flight, each isolated.
    let next = 0;
    const worker = async () => {
      while (next < slice.length) {
        const i = next++;
        try {
          const reply = (await post(request(i, slice[i]))) as { result?: unknown; error?: unknown };
          if (typeof reply?.result === 'string' && !reply.error) results[from + i] = reply.result;
        } catch {
          // leave undefined
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  return results;
}

/** Read name, symbol, decimals and totalSupply for every address in a single batch. */
export async function readChainFields(
  addresses: string[],
  net: { fetch?: FetchLike; rpcUrl?: string } = {}
): Promise<Record<string, ChainFields>> {
  const fetchImpl: FetchLike = net.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const ctx: Net = { fetch: fetchImpl, rpcUrl: net.rpcUrl ?? DEFAULT_RPC_URL, explorerUrl: DEFAULT_EXPLORER_URL };
  const selectors = [SEL_NAME, SEL_SYMBOL, SEL_DECIMALS, SEL_TOTAL_SUPPLY];
  const calls = addresses.flatMap(to => selectors.map(data => ({ to, data })));
  const raw = await rpcCalls(calls, ctx);
  const out: Record<string, ChainFields> = {};
  addresses.forEach((address, i) => {
    const [n, s, d, t] = raw.slice(i * 4, i * 4 + 4);
    const supply = decodeAbiUint(t);
    out[address.toLowerCase()] = {
      name: sanitizeText(decodeAbiString(n), 64),
      symbol: sanitizeText(decodeAbiString(s), 16),
      decimals: decodeDecimals(d),
      totalSupply: supply === undefined ? undefined : supply.toString()
    };
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Explorer read
// ---------------------------------------------------------------------------------------------

export interface ExplorerFields {
  name?: string;
  symbol?: string;
  iconUrl?: string;
  website?: string;
  description?: string;
  holders?: number;
  priceUsd?: number;
  marketCapUsd?: number;
}

/** Parse the explorer's /api/token/<address> body. Null-safe: marketStats is null for some tokens. */
export function parseExplorerToken(body: unknown, explorerUrl: string = DEFAULT_EXPLORER_URL): ExplorerFields | null {
  const root = body as { token?: Record<string, unknown> | null; marketStats?: Record<string, unknown> | null } | null;
  const token = root && typeof root === 'object' ? root.token : null;
  if (!token || typeof token !== 'object') return null;
  const stats = root?.marketStats && typeof root.marketStats === 'object' ? root.marketStats : {};
  const holders = Number(token.holder_count);
  return {
    name: sanitizeText(token.name, 64),
    symbol: sanitizeText(token.symbol, 16),
    iconUrl: resolveIconUrl(token.icon_url, explorerUrl),
    website: httpsUrl(token.website),
    description: sanitizeText(token.description, 280),
    holders: Number.isFinite(holders) && holders >= 0 ? Math.floor(holders) : undefined,
    priceUsd: positiveNumber((stats as Record<string, unknown>).priceUsd),
    marketCapUsd: positiveNumber((stats as Record<string, unknown>).marketCapUsd)
  };
}

export async function readExplorerFields(
  address: string,
  net: { fetch?: FetchLike; explorerUrl?: string } = {}
): Promise<ExplorerFields | null> {
  const fetchImpl: FetchLike = net.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const explorerUrl = (net.explorerUrl ?? DEFAULT_EXPLORER_URL).replace(/\/$/, '');
  const res = await fetchImpl(`${explorerUrl}/api/token/${address}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS)
  });
  if (res.status === 404) return null; // the explorer does not know this token: not an error
  if (!res.ok) throw new Error(`Explorer ${res.status}`);
  return parseExplorerToken(await res.json(), explorerUrl);
}

// ---------------------------------------------------------------------------------------------
// Service: merge, cache, persist
// ---------------------------------------------------------------------------------------------

interface Entry {
  profile?: TokenProfile;
  chainAt?: number;
  explorerAt?: number;
  chainFailedAt?: number;
  explorerFailedAt?: number;
}

export interface TokenMetadataServiceOptions {
  fetch?: FetchLike;
  storage?: StorageLike | null;
  now?: () => number;
  rpcUrl?: string;
  explorerUrl?: string;
  /** How many explorer requests may be in flight at once. */
  explorerConcurrency?: number;
}

export interface TokenProfileLoadOptions {
  signal?: AbortSignal;
  /** Ignore TTLs and negative caching (the user pressed refresh). */
  force?: boolean;
  /** Called each time a token's profile changes, so the UI can fill in progressively. */
  onProfile?: (profile: TokenProfile) => void;
}

export interface TokenProfileLoadResult {
  profiles: Record<string, TokenProfile>;
  /** Addresses where neither source returned anything and nothing was cached. */
  failed: string[];
}

export function createTokenMetadataService(options: TokenMetadataServiceOptions = {}) {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
  const explorerUrl = (options.explorerUrl ?? DEFAULT_EXPLORER_URL).replace(/\/$/, '');
  const concurrency = Math.max(1, options.explorerConcurrency ?? 4);
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  const entries = new Map<string, Entry>();

  // hydrate
  try {
    const raw = storage?.getItem(TOKEN_PROFILE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { v?: number; entries?: Record<string, Entry> };
      if (parsed?.v === 1 && parsed.entries && typeof parsed.entries === 'object') {
        for (const [address, entry] of Object.entries(parsed.entries)) {
          if (/^0x[0-9a-f]{40}$/.test(address) && entry?.profile?.address === address) entries.set(address, entry);
        }
      }
    }
  } catch {
    // a corrupt cache is just an empty cache
  }

  const persist = () => {
    if (!storage) return;
    try {
      const sorted = [...entries.entries()]
        .filter(([, e]) => e.profile)
        .sort((a, b) => (b[1].profile!.fetchedAt - a[1].profile!.fetchedAt))
        .slice(0, MAX_STORED_PROFILES);
      storage.setItem(TOKEN_PROFILE_STORAGE_KEY, JSON.stringify({ v: 1, entries: Object.fromEntries(sorted) }));
    } catch {
      // quota or private mode: caching is an optimisation only
    }
  };

  const touch = (address: string): Entry => {
    let entry = entries.get(address);
    if (!entry) { entry = {}; entries.set(address, entry); }
    return entry;
  };
  const ensureProfile = (entry: Entry, address: string): TokenProfile => {
    if (!entry.profile) entry.profile = { address, source: { chain: false, explorer: false }, fetchedAt: now() };
    return entry.profile;
  };

  return {
    /** Whatever is cached right now, stale or not. Synchronous, for the first paint. */
    peek(address: string): TokenProfile | undefined {
      return entries.get(address.toLowerCase())?.profile;
    },

    peekAll(addresses: string[]): Record<string, TokenProfile> {
      const out: Record<string, TokenProfile> = {};
      for (const a of addresses) {
        const p = entries.get(a.toLowerCase())?.profile;
        if (p) out[a.toLowerCase()] = p;
      }
      return out;
    },

    async load(addresses: string[], opts: TokenProfileLoadOptions = {}): Promise<TokenProfileLoadResult> {
      const unique = [...new Set(addresses.map(a => a.toLowerCase()))];
      const t0 = now();
      const stale = (at: number | undefined, ttl: number) => opts.force || at === undefined || t0 - at > ttl;
      const cooling = (failedAt: number | undefined) => !opts.force && failedAt !== undefined && t0 - failedAt < NEGATIVE_TTL_MS;

      const needChain = unique.filter(a => {
        const e = entries.get(a);
        return stale(e?.chainAt, PROFILE_TTL_MS) && !cooling(e?.chainFailedAt);
      });
      const needExplorer = unique.filter(a => {
        const e = entries.get(a);
        return stale(e?.explorerAt, MARKET_TTL_MS) && !cooling(e?.explorerFailedAt);
      });

      const emit = (address: string) => {
        const p = entries.get(address)?.profile;
        if (p) opts.onProfile?.(p);
      };

      // 1. chain: one batch for every token that needs it
      if (needChain.length && !opts.signal?.aborted) {
        try {
          const fields = await readChainFields(needChain, { fetch: fetchImpl, rpcUrl });
          for (const address of needChain) {
            const entry = touch(address);
            const f = fields[address] ?? {};
            const any = f.name !== undefined || f.symbol !== undefined || f.decimals !== undefined || f.totalSupply !== undefined;
            if (!any) { entry.chainFailedAt = t0; continue; }
            const p = ensureProfile(entry, address);
            // a failed single field keeps the previous value rather than erasing it
            if (f.name !== undefined) p.name = f.name;
            if (f.symbol !== undefined) p.symbol = f.symbol;
            if (f.decimals !== undefined) p.decimals = f.decimals;
            if (f.totalSupply !== undefined) p.totalSupply = f.totalSupply;
            p.source.chain = true;
            p.fetchedAt = t0;
            entry.chainAt = t0;
            entry.chainFailedAt = undefined;
            emit(address);
          }
        } catch {
          for (const address of needChain) touch(address).chainFailedAt = t0;
        }
        persist();
      }

      // 2. explorer: bounded concurrency, each request isolated
      if (needExplorer.length && !opts.signal?.aborted) {
        let next = 0;
        const worker = async () => {
          while (next < needExplorer.length && !opts.signal?.aborted) {
            const address = needExplorer[next++];
            const entry = touch(address);
            try {
              const f = await readExplorerFields(address, { fetch: fetchImpl, explorerUrl });
              entry.explorerAt = t0;
              entry.explorerFailedAt = undefined;
              if (!f) continue; // unknown to the explorer
              const p = ensureProfile(entry, address);
              // chain wins for the standard fields; the explorer only fills a gap
              if (p.name === undefined && f.name !== undefined) p.name = f.name;
              if (p.symbol === undefined && f.symbol !== undefined) p.symbol = f.symbol;
              p.iconUrl = f.iconUrl ?? p.iconUrl;
              p.website = f.website ?? p.website;
              p.description = f.description ?? p.description;
              p.holders = f.holders ?? p.holders;
              p.priceUsd = f.priceUsd;          // a price that disappeared should disappear
              p.marketCapUsd = f.marketCapUsd;
              p.source.explorer = true;
              p.fetchedAt = t0;
              emit(address);
            } catch {
              entry.explorerFailedAt = t0;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, needExplorer.length) }, worker));
        persist();
      }

      const profiles: Record<string, TokenProfile> = {};
      const failed: string[] = [];
      for (const a of unique) {
        const p = entries.get(a)?.profile;
        if (p) profiles[a] = p; else failed.push(a);
      }
      return { profiles, failed };
    }
  };
}

export type TokenMetadataService = ReturnType<typeof createTokenMetadataService>;

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // access can throw (blocked storage)
  }
}
