// Every Quainance pair, in one list.
//
// Quainance's factory is the authority on which pairs exist (allPairsLength / allPairs): on 2026-10-12 it listed 38
// while the explorer's TVL endpoint returned only its top 25 (`poolsTruncated: true`), and that endpoint is not
// reachable from a browser in production at all (no CORS header). So the list is built from the factory, and the
// explorer only adds what the chain cannot say: indexed USD value, volume and transaction counts.
//
// Quainance also runs a launchpad whose markets are NOT AMM pairs: tokens trade on a bonding curve until they graduate
// (HARTII, POOP, QUAINANCE_CURVE). Those markets, QAXE among them, appear in Quainance's trade-zone catalog and nowhere on
// the factory, so the catalog is parsed here too (parseCatalog) and merged in as `markets`. The catalog is untrusted
// external JSON: every field is validated, and a bad entry is dropped and counted, never half-used.
//
// No value imports, so Node can load this file for its tests. Callers pass in what they already loaded.

import type { PairSnapshot, PairAnalysis } from './pairs';
import type { QuainancePool, QuainanceTVL } from './index';

export interface QuainanceAggregatePool {
    pair: string;
    /** "WQI / WQUAI", from the token symbols the chain reported. */
    name: string;
    token0: { address: string; symbol: string; decimals: number };
    token1: { address: string; symbol: string; decimals: number };
    reserve0: bigint;
    reserve1: bigint;
    /** USD value locked: the explorer's figure when it indexed the pool, else derived from reserves; null when neither. */
    tvlUsd: number | null;
    volume24hUsd: number | null;
    totalVolumeUsd: number | null;
    txCount: number | null;
    /** Where the figures came from, so the page can say "estimated" instead of presenting a guess as indexed data. */
    source: { chain: boolean; explorer: boolean; tvl: 'explorer' | 'reserves' | 'none' };
    /** Both tokens are in the app's token list, so the pair can be routed and traded here without importing anything. */
    listed: boolean;
    /** LP tokens held by the dead and zero addresses (0n when unknown). */
    burned: bigint;
    totalSupply: bigint;
    index: number | null;
}

export interface QuainanceAggregate {
    pools: QuainanceAggregatePool[];
    /** Launchpad (bonding-curve) markets from the catalog: Hartii (QAXE, HRT, ART...), POOP, Quainance curves. */
    markets: QuainanceMarket[];
    totals: {
        /** Launchpad markets in `markets`, and how many of each source. */
        markets: number;
        marketsBySource: Record<string, number>;
        /** Pairs the factory reports (or the explorer, if that is larger). */
        pairs: number;
        /** Pairs in `pools`: below `pairs` only when the factory read was cut short. */
        loaded: number;
        listed: number;
        /** Network TVL in USD: the explorer's own total when it answered, else the sum of what could be priced. */
        tvlUsd: number | null;
        /** False when some pairs had no USD value, so `tvlUsd` is a floor. */
        tvlComplete: boolean;
        volume24hUsd: number | null;
    };
    source: { factory: boolean; explorer: boolean; explorerStale: boolean; catalog: boolean };
}

// ------------------------------------------------------------------------------------------------ launchpad catalog

export type LaunchPhase = 'BONDING' | 'GRADUATED' | 'POOLED' | 'UNKNOWN';

/** The validated subset of one trade-zone catalog entry. */
export interface QuainanceLaunch {
    id: string;
    /** HARTII, POOP_V1, POOP_V2, QUAINANCE_CURVE, QUAINANCE_LAUNCHER, ... as the catalog names it. */
    source: string;
    token: string;
    symbol: string;
    name: string;
    decimals: number;
    totalSupply: bigint;
    phase: LaunchPhase;
    curve: string | null;
    /** QUAI per whole token, scaled 1e12 (the catalog's latestPriceQuoteE12), or null. */
    priceE12: bigint | null;
    buyCount: number;
    sellCount: number;
    /** Quote (QUAI) traded through the curve, buys plus sells, in wei. */
    volumeWei: bigint;
    createdAt: number | null;
    launchedAt: number | null;
    creator: string | null;
    /** The AMM pair a pooled launch graduated into, when the catalog carries it. */
    pair: { address: string; token0: string; token1: string; reserve0: bigint; reserve1: bigint } | null;
}

export interface QuainanceMarket {
    token: { address: string; symbol: string; name: string; decimals: number };
    source: string;
    phase: LaunchPhase;
    curve: string | null;
    /** QUAI per token. */
    priceQuai: number | null;
    /** Price times supply, in QUAI. */
    marketCapQuai: number | null;
    trades: number;
    volumeQuai: number;
    createdAt: number | null;
    launchedAt: number | null;
    /** The token is in the app's token list. */
    listed: boolean;
    /** Set when the launch already has an AMM pool; that pool is in `pools`, so this is the same market seen from the curve. */
    pair: string | null;
}

const ADDR = /^0x00[0-9a-fA-F]{38}$/;
// Real launches use "$NOW" and "IMRAN KHAN": allow a leading $ and inner spaces, but no markup or control characters.
const SYMBOL = /^[A-Za-z0-9$][A-Za-z0-9 ._$-]{0,15}$/;

const bigOrNull = (v: unknown): bigint | null => {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
    if (typeof v === 'string' && /^\d{1,78}$/.test(v)) return BigInt(v);
    return null;
};
const intOrNull = (v: unknown): number | null => {
    const b = bigOrNull(v);
    return b !== null && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
};
/** Printable text only, bounded: a catalog name is shown in the page, so it must not carry markup or control characters. */
function cleanText(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    const t = v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    return t ? t.slice(0, max) : null;
}

/**
 * Parse the body of https://www.quainance.com/api/trade-zone/catalog. Accepts `{data:{tradeLaunches:[...]}}` or the bare
 * array. An entry without a valid token address, symbol and decimals is skipped and counted.
 */
export function parseCatalog(json: unknown): { launches: QuainanceLaunch[]; skipped: number; block: number | null } {
    const root: any = (json as any)?.data ?? json;
    const list: unknown[] = Array.isArray(root) ? root : Array.isArray(root?.tradeLaunches) ? root.tradeLaunches : [];
    const launches: QuainanceLaunch[] = [];
    let skipped = 0;
    for (const raw of list) {
        const e: any = raw;
        const token = typeof e?.token === 'string' && ADDR.test(e.token) ? e.token.toLowerCase() : null;
        // A symbol is checked as given, not cleaned into validity: "<script>" is rejected, not turned into "script".
        const rawSymbol = typeof e?.tokenSymbol === 'string' ? e.tokenSymbol.trim() : '';
        const symbol = SYMBOL.test(rawSymbol) ? rawSymbol : null;
        const decimals = intOrNull(e?.tokenDecimals);
        const source = cleanText(e?.source, 40);
        if (!token || !symbol || decimals === null || decimals > 36 || !source) {
            skipped++;
            continue;
        }
        const phaseRaw = typeof e.phase === 'string' ? e.phase.toUpperCase() : '';
        const phase: LaunchPhase = phaseRaw === 'BONDING' || phaseRaw === 'GRADUATED' || phaseRaw === 'POOLED' ? phaseRaw : 'UNKNOWN';
        const pr = e.pair && typeof e.pair === 'object' ? e.pair : null;
        const pair =
            pr && typeof pr.address === 'string' && ADDR.test(pr.address) && ADDR.test(String(pr.token0)) && ADDR.test(String(pr.token1))
                ? {
                      address: pr.address.toLowerCase(),
                      token0: String(pr.token0).toLowerCase(),
                      token1: String(pr.token1).toLowerCase(),
                      reserve0: bigOrNull(pr.reserve0) ?? 0n,
                      reserve1: bigOrNull(pr.reserve1) ?? 0n
                  }
                : null;
        launches.push({
            id: cleanText(e.id, 160) ?? `${source}:${token}`,
            source,
            token,
            symbol,
            name: cleanText(e.tokenName, 64) ?? symbol,
            decimals,
            totalSupply: bigOrNull(e.totalSupply) ?? 0n,
            phase,
            curve: typeof e.curveAddress === 'string' && ADDR.test(e.curveAddress) ? e.curveAddress.toLowerCase() : null,
            priceE12: bigOrNull(e.latestPriceQuoteE12),
            buyCount: intOrNull(e.buyCount) ?? 0,
            sellCount: intOrNull(e.sellCount) ?? 0,
            volumeWei: (bigOrNull(e.buyQuoteAmount) ?? 0n) + (bigOrNull(e.sellQuoteAmount) ?? 0n),
            createdAt: intOrNull(e.createdAtTimestamp),
            launchedAt: intOrNull(e.launchedAtTimestamp),
            creator: typeof e.creator === 'string' && ADDR.test(e.creator) ? e.creator.toLowerCase() : null,
            pair
        });
    }
    const block = intOrNull((json as any)?.data?._meta?.block?.number ?? (json as any)?._meta?.block?.number);
    return { launches, skipped, block };
}

/** Launchpad markets: every launch, except pooled ones whose AMM pair is already in the pair list (shown once, there). */
export function buildMarkets(launches: QuainanceLaunch[], poolAddresses: ReadonlySet<string>, isListed: (address: string) => boolean): QuainanceMarket[] {
    const out: QuainanceMarket[] = [];
    for (const l of launches) {
        if (l.pair && poolAddresses.has(l.pair.address)) continue;
        const priceQuai = l.priceE12 === null ? null : Number(l.priceE12) / 1e12;
        const supply = Number(l.totalSupply) / 10 ** l.decimals;
        out.push({
            token: { address: l.token, symbol: l.symbol, name: l.name, decimals: l.decimals },
            source: l.source,
            phase: l.phase,
            curve: l.curve,
            priceQuai,
            marketCapQuai: priceQuai === null || !Number.isFinite(supply) || supply <= 0 ? null : priceQuai * supply,
            trades: l.buyCount + l.sellCount,
            volumeQuai: Number(l.volumeWei) / 1e18,
            createdAt: l.createdAt,
            launchedAt: l.launchedAt,
            listed: isListed(l.token),
            pair: l.pair ? l.pair.address : null
        });
    }
    // busiest first; ties by newest
    return out.sort((a, b) => b.volumeQuai - a.volumeQuai || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export interface MergeInput {
    /** From loadPairSnapshots(['QUAINANCE']): the pairs the factory reports, with reserves. May be empty if that read failed. */
    snapshots: PairSnapshot[];
    /** From analyzePairs(snapshots): reserve-derived USD value. Optional. */
    analysis?: PairAnalysis[];
    /** The explorer's TVL answer, or null when it could not be fetched. */
    explorer: QuainanceTVL | null;
    /** `totals.QUAINANCE` from the snapshot load: how many pairs the factory has, which can exceed snapshots.length. */
    factoryTotal?: number;
    /** Is this token address one the app lists? */
    isListed: (address: string) => boolean;
    /** Launchpad catalog entries from parseCatalog(); omit when the catalog could not be read. */
    launches?: QuainanceLaunch[];
}

const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** A decimal string from the explorer ("12.5") into base units; null if it is not a plain decimal. */
function toBase(value: string, decimals: number): bigint | null {
    const t = String(value).trim();
    if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
    const [whole, frac = ''] = t.split('.');
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals).padEnd(decimals, '0') || '0');
}

const symOf = (s: string, a: string) => (s && s.trim() ? s.trim() : `${a.slice(0, 6)}…${a.slice(-4)}`);

/**
 * Merge the factory's pair list with the explorer's indexed stats. The factory is the universe; an explorer-only pool
 * (one the factory read missed) is kept rather than dropped. Sorted by USD value, unpriced pairs last.
 */
export function mergeQuainance(i: MergeInput): QuainanceAggregate {
    const byPair = new Map<string, QuainanceAggregatePool>();
    const analysis = new Map((i.analysis ?? []).map(a => [a.pair.toLowerCase(), a]));
    const explorerPools = new Map<string, QuainancePool>((i.explorer?.pools ?? []).map(p => [p.address.toLowerCase(), p]));

    for (const s of i.snapshots) {
        const key = s.pair.toLowerCase();
        const ex = explorerPools.get(key);
        const an = analysis.get(key);
        const exTvl = num(ex?.tvlUsd);
        const derived = an?.tvlUsd ?? null;
        byPair.set(key, {
            pair: s.pair,
            name: `${symOf(s.token0.symbol, s.token0.address)} / ${symOf(s.token1.symbol, s.token1.address)}`,
            token0: { address: s.token0.address, symbol: symOf(s.token0.symbol, s.token0.address), decimals: s.token0.decimals },
            token1: { address: s.token1.address, symbol: symOf(s.token1.symbol, s.token1.address), decimals: s.token1.decimals },
            reserve0: s.reserve0,
            reserve1: s.reserve1,
            tvlUsd: exTvl ?? derived,
            volume24hUsd: num(ex?.volume24hUsd),
            totalVolumeUsd: num(ex?.totalVolumeUsd),
            txCount: num(ex?.txCount),
            source: { chain: true, explorer: Boolean(ex), tvl: exTvl !== null ? 'explorer' : derived !== null ? 'reserves' : 'none' },
            listed: i.isListed(s.token0.address) && i.isListed(s.token1.address),
            burned: s.burned,
            totalSupply: s.totalSupply,
            index: s.index
        });
    }

    // anything the explorer indexed that the factory read did not return
    for (const [key, ex] of explorerPools) {
        if (byPair.has(key)) continue;
        const d0 = 18;
        const d1 = 18;
        byPair.set(key, {
            pair: ex.address,
            name: ex.name || `${symOf(ex.token0.symbol, ex.token0.address)} / ${symOf(ex.token1.symbol, ex.token1.address)}`,
            token0: { address: ex.token0.address, symbol: symOf(ex.token0.symbol, ex.token0.address), decimals: d0 },
            token1: { address: ex.token1.address, symbol: symOf(ex.token1.symbol, ex.token1.address), decimals: d1 },
            reserve0: toBase(ex.reserve0, d0) ?? 0n,
            reserve1: toBase(ex.reserve1, d1) ?? 0n,
            tvlUsd: num(ex.tvlUsd),
            volume24hUsd: num(ex.volume24hUsd),
            totalVolumeUsd: num(ex.totalVolumeUsd),
            txCount: num(ex.txCount),
            source: { chain: false, explorer: true, tvl: num(ex.tvlUsd) !== null ? 'explorer' : 'none' },
            listed: i.isListed(ex.token0.address) && i.isListed(ex.token1.address),
            burned: 0n,
            totalSupply: 0n,
            index: null
        });
    }

    const pools = [...byPair.values()].sort((a, b) => {
        if (a.tvlUsd === null && b.tvlUsd === null) return (b.index ?? -1) - (a.index ?? -1);
        if (a.tvlUsd === null) return 1;
        if (b.tvlUsd === null) return -1;
        return b.tvlUsd - a.tvlUsd || (b.index ?? -1) - (a.index ?? -1);
    });

    const priced = pools.filter(p => p.tvlUsd !== null);
    const summed = priced.reduce((s, p) => s + (p.tvlUsd as number), 0);
    const explorerTotal = num(i.explorer?.current?.tvlUsd);
    const explorerPairs = num(i.explorer?.current?.pairCount);
    const pairs = Math.max(i.factoryTotal ?? 0, explorerPairs ?? 0, pools.length);
    const explorerVol = num(i.explorer?.current?.volume24hUsd);

    const markets = buildMarkets(i.launches ?? [], new Set(pools.map(p => p.pair.toLowerCase())), i.isListed);
    const marketsBySource: Record<string, number> = {};
    for (const m of markets) marketsBySource[m.source] = (marketsBySource[m.source] ?? 0) + 1;

    return {
        pools,
        markets,
        totals: {
            markets: markets.length,
            marketsBySource,
            pairs,
            loaded: pools.length,
            listed: pools.filter(p => p.listed).length,
            // The explorer's total covers all of its indexed pairs; the sum only covers what we could price.
            tvlUsd: explorerTotal ?? (priced.length ? summed : null),
            tvlComplete: explorerTotal !== null || (priced.length === pools.length && pools.length >= pairs),
            volume24hUsd: explorerVol ?? (pools.some(p => p.volume24hUsd !== null) ? pools.reduce((s, p) => s + (p.volume24hUsd ?? 0), 0) : null)
        },
        source: {
            factory: i.snapshots.length > 0,
            explorer: i.explorer !== null,
            explorerStale: Boolean(i.explorer?.stale),
            catalog: i.launches !== undefined
        }
    };
}
