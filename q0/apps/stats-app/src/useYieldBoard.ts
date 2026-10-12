import { useEffect, useMemo, useState } from 'react';
import { resolveQuaiUsd } from './quaiUsd';
import {
  DEXES,
  DEX_IDS,
  MAX_LOG_RANGE,
  POOL_REGISTRY,
  SINGLE_STAKE_POOLS,
  SWAP_TOPIC,
  analyzePairs,
  batchQuaiCall,
  buildYieldRows,
  decodeSwapLogs,
  loadPairSnapshots,
  quaiRpcCall,
  singleStakeCandidates,
  tokenPricesUsd,
  type FarmState,
  type PairAnalysis,
  type PairSnapshot,
  type SwapTotals,
  type YieldFarmInput,
  type YieldRow
} from 'quai-service';

/** About 7 days of Cyprus-1 blocks (5 s each); the real elapsed time is measured from block headers. */
const WINDOW_BLOCKS = 125_000;
const REFRESH_MS = 5 * 60_000;
const FEE_TO_SELECTOR = '0x017e7e58';
const CACHE_KEY = 'circleswap.yield-swaps.v1';
/** Blocks behind the head after which a window can no longer change (finality margin). */
const FINAL_AFTER = 120;

// -------------------------------------------------------------------------------------------------- pools and prices

interface BoardBase {
  /** Every pair read, as the factories reported it (before analysis): lets one token's price be re-derived from fresh reserves. */
  snapshots: PairSnapshot[];
  /** The pools to advertise: every Circleswap pair plus the registry pools on the other DEXes. */
  advertised: PairAnalysis[];
  quaiUsd: number | null;
  /** USD per token address (lower-case), from the deepest pool that prices it. */
  prices: Map<string, number>;
  decimals: Map<string, number>;
  /** Circleswap's protocol fee is on: LPs keep 0.25% instead of 0.30%. */
  protocolFeeOn: boolean;
  loadedAt: number;
}

let baseCache: { at: number; promise: Promise<BoardBase> } | null = null;

async function loadBase(): Promise<BoardBase> {
  const [{ pairs, errors }, quaiUsd] = await Promise.all([loadPairSnapshots(DEX_IDS, { maxPerDex: 1000 }), resolveQuaiUsd()]);
  // Every DEX unreadable is a failed read, not "there are no pools": throwing keeps it out of the shared cache, so the
  // next caller (or poll) tries again instead of reading an empty board for the whole cache lifetime.
  if (pairs.length === 0 && errors.length > 0) throw new Error(`Pools could not be read (${errors[0]}).`);
  const analyses = analyzePairs(pairs, { quaiUsd });
  const registry = new Set(POOL_REGISTRY.map(p => p.pair.toLowerCase()));
  const advertised = analyses.filter(a => a.dex === 'CIRCLESWAP' || registry.has(a.pair.toLowerCase()));

  const decimals = new Map<string, number>();
  for (const a of analyses) {
    decimals.set(a.token0.address.toLowerCase(), a.token0.decimals);
    decimals.set(a.token1.address.toLowerCase(), a.token1.decimals);
  }

  let protocolFeeOn = false;
  try {
    const factory = DEXES.CIRCLESWAP.factory;
    if (factory) {
      const [word] = await batchQuaiCall([{ to: factory, data: FEE_TO_SELECTOR }]);
      protocolFeeOn = typeof word === 'string' && /[1-9a-f]/i.test(word.replace(/^0x/, ''));
    }
  } catch {
    /* unknown: 0.30% is the published fee and the page states the figure it used */
  }
  return { snapshots: pairs, advertised, quaiUsd, prices: tokenPricesUsd(analyses, quaiUsd), decimals, protocolFeeOn, loadedAt: Date.now() };
}

function getBase(force = false, maxAgeMs = REFRESH_MS): Promise<BoardBase> {
  if (!force && baseCache && Date.now() - baseCache.at < maxAgeMs) return baseCache.promise;
  const promise = loadBase();
  baseCache = { at: Date.now(), promise };
  promise.catch(() => {
    if (baseCache && baseCache.promise === promise) baseCache = null;
  });
  return promise;
}

// ------------------------------------------------------------------------------------- one token's price, kept fresh

/** Which pairs exist and what their tokens are changes rarely: a price poll re-reads reserves, not the whole structure. */
const STRUCTURE_MAX_AGE_MS = 30 * 60_000;
const GET_RESERVES = '0x0902f1ac';

export interface PoolPriceReading {
  /** USD per whole token from the deepest pool route, or null when no pool prices it. */
  priceUsd: number | null;
  /** When the reserves behind it were read (ms since epoch). */
  at: number;
  /** How many pools hold the token. */
  pools: number;
}

/**
 * One token's USD price from its pools, with fresh reserves. The pool list and token metadata come from the same shared
 * snapshot the yield board uses (so a page that already loaded them costs nothing more); only the reserves of the pools
 * that hold this token are read again, in one batch, and the route to WQUAI is re-derived from them. All-or-nothing:
 * a missing reserve or QUAI price throws, so a caller keeps its last good price instead of mixing old and new reserves.
 */
export async function readTokenPoolPriceUsd(token: string, opts: { signal?: AbortSignal } = {}): Promise<PoolPriceReading> {
  const base = await getBase(false, STRUCTURE_MAX_AGE_MS);
  if (opts.signal?.aborted) throw new Error('Cancelled.');
  const key = token.toLowerCase();
  const touching = base.snapshots.filter(p => p.token0.address.toLowerCase() === key || p.token1.address.toLowerCase() === key);
  if (touching.length === 0) return { priceUsd: null, at: Date.now(), pools: 0 };

  const replies = await batchQuaiCall(touching.map(p => ({ to: p.pair, data: GET_RESERVES })));
  if (opts.signal?.aborted) throw new Error('Cancelled.');
  const fresh = new Map<string, { reserve0: bigint; reserve1: bigint }>();
  touching.forEach((p, i) => {
    const hex = replies[i];
    if (typeof hex === 'string' && /^0x[0-9a-fA-F]{128,}$/.test(hex)) {
      fresh.set(p.pair.toLowerCase(), { reserve0: BigInt('0x' + hex.slice(2, 66)), reserve1: BigInt('0x' + hex.slice(66, 130)) });
    }
  });
  if (fresh.size !== touching.length) throw new Error('The pools’ reserves could not be read.');

  const quaiUsd = await resolveQuaiUsd();
  if (quaiUsd === null) throw new Error('The QUAI price is unavailable.');
  const snapshots = base.snapshots.map(p => {
    const f = fresh.get(p.pair.toLowerCase());
    return f ? { ...p, reserve0: f.reserve0, reserve1: f.reserve1 } : p;
  });
  const prices = tokenPricesUsd(analyzePairs(snapshots, { quaiUsd }), quaiUsd);
  return { priceUsd: prices.get(key) ?? null, at: Date.now(), pools: touching.length };
}

// ------------------------------------------------------------------------------------------------ swap history scan

/**
 * The node serves one log query at a time ("too many concurrent log queries") and each takes seconds, so the history is
 * read newest window first, one at a time, and shown as it arrives. Finished windows never change, so they are cached
 * (per set of pool addresses) and later visits only read the newest one or two.
 */
interface ScanState {
  key: string;
  volumes: Map<string, SwapTotals> | null;
  /** Seconds covered, counting back from the newest block read. */
  windowSeconds: number | null;
  windowsDone: number;
  windowsTotal: number;
  state: 'idle' | 'scanning' | 'done' | 'partial' | 'failed';
  error: string | null;
}

const idleScan = (): ScanState => ({ key: '', volumes: null, windowSeconds: null, windowsDone: 0, windowsTotal: 0, state: 'idle', error: null });
let scan: ScanState = idleScan();
let scanStartedAt = 0;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(l => l());

interface CachedWindow {
  /** Timestamp of the window's first block. */
  t: number;
  totals: Record<string, [number, string, string]>;
}

function readCache(): Record<string, CachedWindow> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}
function writeCache(entries: Record<string, CachedWindow>) {
  try {
    // keep it small: the newest 40 windows are far more than a week needs
    const keys = Object.keys(entries);
    if (keys.length > 40) for (const k of keys.sort().slice(0, keys.length - 40)) delete entries[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch {
    /* storage unavailable or full: the scan just runs uncached */
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function queryWindow(addresses: string[], from: number, to: number): Promise<unknown[]> {
  const params = [{ address: addresses, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [SWAP_TOPIC] }];
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await quaiRpcCall('quai_getLogs', params);
      if (!Array.isArray(out)) throw new Error('unexpected reply');
      return out;
    } catch (e: any) {
      const busy = /too many concurrent|retry later|429/i.test(String(e?.message));
      if (attempt >= (busy ? 10 : 2)) throw e;
      await sleep((busy ? 900 : 600) * (attempt + 1));
    }
  }
}

async function blockTime(block: number): Promise<number | null> {
  try {
    const h = await quaiRpcCall('quai_getBlockByNumber', ['0x' + block.toString(16), false]);
    const t = h?.woHeader?.timestamp;
    return typeof t === 'string' ? Number(BigInt(t)) : null;
  } catch {
    return null;
  }
}

async function runScan(addresses: string[]) {
  const key = [...addresses].map(a => a.toLowerCase()).sort().join(',');
  if (scan.key === key && (scan.state === 'scanning' || scan.state === 'done' || scan.state === 'partial')) return;
  scan = { ...idleScan(), key, state: 'scanning' };
  scanStartedAt = Date.now();
  publish();

  try {
    const head = Number(BigInt(await quaiRpcCall('quai_blockNumber', [])));
    const headTime = await blockTime(head);
    const firstIdx = Math.floor((head - WINDOW_BLOCKS) / MAX_LOG_RANGE);
    const lastIdx = Math.floor(head / MAX_LOG_RANGE);
    const indices: number[] = [];
    for (let i = lastIdx; i >= firstIdx; i--) indices.push(i);
    scan.windowsTotal = indices.length;

    const cache = readCache();
    const volumes = new Map<string, SwapTotals>();
    // short key for the cache: addresses are long, windows are many
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const setKey = h.toString(36);

    for (const idx of indices) {
      const start = idx * MAX_LOG_RANGE;
      const end = Math.min(start + MAX_LOG_RANGE - 1, head);
      const ck = `${setKey}:${idx}`;
      const final = end < head - FINAL_AFTER && end === start + MAX_LOG_RANGE - 1;
      let entry: CachedWindow | undefined = final ? cache[ck] : undefined;

      if (!entry) {
        let logs: unknown[];
        try {
          logs = await queryWindow(addresses, start, end);
        } catch (e: any) {
          // Older windows missing is a shorter window, not a wrong one: keep what is contiguous from the head.
          if (scan.windowsDone === 0) throw e;
          scan = { ...scan, state: 'partial', error: e?.message ?? 'older swap history could not be read' };
          publish();
          return;
        }
        const t = (await blockTime(start)) ?? headTime ?? 0;
        const totals: CachedWindow['totals'] = {};
        for (const [pair, v] of decodeSwapLogs(logs)) totals[pair] = [v.swaps, v.volume0.toString(), v.volume1.toString()];
        entry = { t, totals };
        if (final) {
          cache[ck] = entry;
          writeCache(cache);
        }
      }

      for (const [pair, [swaps, v0, v1]] of Object.entries(entry.totals)) {
        const cur = volumes.get(pair) ?? { swaps: 0, volume0: 0n, volume1: 0n };
        cur.swaps += swaps;
        cur.volume0 += BigInt(v0);
        cur.volume1 += BigInt(v1);
        volumes.set(pair, cur);
      }
      const covered = headTime !== null && entry.t > 0 ? headTime - entry.t : (head - start) * 5;
      scan = { ...scan, volumes: new Map(volumes), windowSeconds: Math.max(1, covered), windowsDone: scan.windowsDone + 1 };
      publish();
    }
    scan = { ...scan, state: 'done' };
    publish();
  } catch (e: any) {
    scan = { ...scan, state: 'failed', error: e?.message || 'Swap history could not be read from the node.' };
    publish();
  }
}

// ------------------------------------------------------------------------------------------------------------ hook

/**
 * Token USD prices derived from the pools (the deepest route to WQUAI), without reading any swap history. For the pages
 * that only need a price or a market cap, such as the analytics cards and the Genesis page.
 */
export function useTokenPricesUsd(): { prices: Map<string, number>; quaiUsd: number | null; ready: boolean } {
  const [base, setBase] = useState<BoardBase | null>(null);
  useEffect(() => {
    let live = true;
    getBase()
      .then(b => live && setBase(b))
      .catch(() => {
        /* no pool prices: callers fall back to the explorer's figures, or show nothing */
      });
    return () => {
      live = false;
    };
  }, []);
  return useMemo(() => ({ prices: base?.prices ?? new Map<string, number>(), quaiUsd: base?.quaiUsd ?? null, ready: base !== null }), [base]);
}

export interface YieldBoardState {
  rows: YieldRow[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** Days of swap history behind the fee APR (grows while it is still being read), or null before any. */
  windowDays: number | null;
  /** Swap history is still being read, newest first. */
  scanning: boolean;
  scanProgress: { done: number; total: number } | null;
  /** Older swap history could not be read, so the window is shorter than a week. */
  partialHistory: boolean;
  quaiUsd: number | null;
  updatedAt: number | null;
  /** USD per token address (lower-case). */
  prices: Map<string, number>;
  /** Value of the farm's whole emission per day at today's prices, or null when a reward cannot be priced. */
  emissionUsdPerDay: number | null;
  /**
   * The farm as the board prices it (pool-derived reward prices), or null without a farm. The single-token rows project
   * their rewards from this same input, so they and the pair rows above them always agree.
   */
  farmInput: YieldFarmInput | null;
}

/**
 * Yield for every pool with liquidity, by default. Pools, prices and reward projections appear as soon as the pools are
 * read; fee APR fills in as swap history arrives. `farm` is optional: without it fees still show, and rewards read unknown.
 */
export function useYieldBoard(farm: FarmState | null): YieldBoardState {
  const [base, setBase] = useState<BoardBase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, bump] = useState(0);

  useEffect(() => {
    let live = true;
    const run = (force: boolean) =>
      getBase(force)
        .then(b => {
          if (!live) return;
          setBase(b);
          setError(null);
          void runScan(b.advertised.map(a => a.pair));
        })
        .catch(e => live && setError(e?.message || 'Pool data could not be read.'));
    void run(false);
    const onScan = () => live && bump(n => n + 1);
    listeners.add(onScan);
    const timer = setInterval(() => {
      if (document.hidden) return;
      void run(false);
      // a finished scan is refreshed at the same pace: only the newest windows are uncached, so this is cheap
      if ((scan.state === 'done' || scan.state === 'partial' || scan.state === 'failed') && Date.now() - scanStartedAt > REFRESH_MS) {
        scan = { ...scan, key: '' };
        if (baseCache) void baseCache.promise.then(b => runScan(b.advertised.map(a => a.pair))).catch(() => {});
      }
    }, REFRESH_MS);
    return () => {
      live = false;
      listeners.delete(onScan);
      clearInterval(timer);
    };
  }, []);

  return useMemo<YieldBoardState>(() => {
    const empty: YieldBoardState = {
      rows: [],
      status: error ? 'error' : 'loading',
      error,
      windowDays: null,
      scanning: false,
      scanProgress: null,
      partialHistory: false,
      quaiUsd: null,
      updatedAt: null,
      prices: new Map(),
      emissionUsdPerDay: null,
      farmInput: null
    };
    if (!base) return empty;

    let farmInput: YieldFarmInput | null = null;
    let emission: number | null = null;
    if (farm) {
      const a = farm.rewardTokenA.toLowerCase();
      const b = farm.rewardTokenB.toLowerCase();
      const decimalsA = base.decimals.get(a) ?? 18;
      const decimalsB = base.decimals.get(b) ?? 18;
      const priceUsdA = base.prices.get(a);
      const priceUsdB = base.prices.get(b);
      farmInput = {
        rewardAPerSecond: farm.rewardAPerSecond,
        rewardBPerSecond: farm.rewardBPerSecond,
        totalAllocPoint: farm.totalAllocPoint,
        boostBps: farm.boostBps,
        pools: farm.pools.map(p => ({ pid: p.pid, lpToken: p.lpToken, allocPoint: p.allocPoint, totalStaked: p.totalStaked })),
        decimalsA,
        decimalsB,
        priceUsdA,
        priceUsdB
      };
      if (priceUsdA !== undefined && priceUsdB !== undefined) {
        emission =
          (Number(farm.rewardAPerSecond) / 10 ** decimalsA) * 86_400 * priceUsdA + (Number(farm.rewardBPerSecond) / 10 ** decimalsB) * 86_400 * priceUsdB;
      }
    }

    // The single-token pools (Q0, BDELTA) that are not in the farm yet wait to join together with the unfarmed pairs, so a
    // pair's assumed share counts them: this page and the Farms page's single-token rows assume the same total.
    const waitingSingles = farm ? singleStakeCandidates(farm, SINGLE_STAKE_POOLS).filter(c => c.state === 'NOT_IN_FARM').length : 0;
    const windowSeconds = scan.windowSeconds ?? WINDOW_BLOCKS * 5;
    const rows = buildYieldRows({
      analyses: base.advertised,
      volumes: scan.volumes,
      windowSeconds,
      quaiUsd: base.quaiUsd,
      farm: farmInput,
      lpFeeBps: { CIRCLESWAP: base.protocolFeeOn ? 25 : 30, QUAISWAP: 30, QUAINANCE: 30 },
      extraUnfarmed: waitingSingles
    });
    return {
      rows,
      status: 'ready',
      error: error ?? (scan.state === 'failed' ? scan.error : null),
      windowDays: scan.windowSeconds === null ? null : scan.windowSeconds / 86_400,
      scanning: scan.state === 'scanning',
      scanProgress: scan.state === 'scanning' ? { done: scan.windowsDone, total: scan.windowsTotal } : null,
      partialHistory: scan.state === 'partial',
      quaiUsd: base.quaiUsd,
      updatedAt: base.loadedAt,
      prices: base.prices,
      emissionUsdPerDay: emission,
      farmInput
    };
    // `tick` changes on every scan update: the module-level scan state is read fresh each time it does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, farm, error, tick]);
}
