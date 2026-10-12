// What an LP earns, in one place: trading fees measured from real swaps, plus farm rewards (actual for a farmed pool,
// projected for one the farm has not added yet). Pure maths, no value imports, so Node can load it for its tests.
//
// Honesty rules the numbers follow:
//  - Fee yield is read from Swap events over a stated window and annualised from the window's real length. No swaps in
//    the window is 0%, not "n/a" and not a guess.
//  - A projected reward APR says what the pool WOULD earn at the current emission if it were farmed, under stated
//    assumptions (an assumed weight). It never claims the farm is paying today: that needs the farm to hold rewards.
//  - An unknown input (no price, no liquidity) makes the output unknown (null), never 0 and never infinite.

import type { PairAnalysis } from './pairs';

/** keccak256("Swap(address,uint256,uint256,uint256,uint256,address)"): the Uniswap-V2 Swap event all three DEXes emit. */
export const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_YEAR = 31_536_000;
const BPS = 10_000;

/** Below this much liquidity (USD) a pool's APR swings with one trade; the page says so. */
export const THIN_LIQUIDITY_USD = 1_000;

export interface SwapTotals {
    swaps: number;
    /** Sum of amountIn + amountOut for each token over the window, in base units (one side is zero for a plain swap). */
    volume0: bigint;
    volume1: bigint;
}

const word = (data: string, i: number): bigint => BigInt('0x' + data.slice(2 + i * 64, 2 + i * 64 + 64));

/** Total swap volume per pair (lower-case address) from `quai_getLogs` results. Malformed or foreign logs are skipped. */
export function decodeSwapLogs(logs: unknown[]): Map<string, SwapTotals> {
    const out = new Map<string, SwapTotals>();
    for (const raw of logs) {
        const l: any = raw;
        if (!l || typeof l.address !== 'string' || typeof l.data !== 'string' || !Array.isArray(l.topics)) continue;
        if (String(l.topics[0]).toLowerCase() !== SWAP_TOPIC) continue;
        if (!/^0x[0-9a-fA-F]{256}$/.test(l.data)) continue; // four 32-byte words, exactly
        const key = l.address.toLowerCase();
        const t = out.get(key) ?? { swaps: 0, volume0: 0n, volume1: 0n };
        t.swaps += 1;
        t.volume0 += word(l.data, 0) + word(l.data, 2); // amount0In + amount0Out
        t.volume1 += word(l.data, 1) + word(l.data, 3); // amount1In + amount1Out
        out.set(key, t);
    }
    return out;
}

/**
 * Fee APR in percent: the LP share of the fee on the window's volume, annualised from the window's actual length.
 * null when liquidity or the window is unknown (a pool with no liquidity has no yield to quote).
 */
export function feeApr(i: { volumeUsd: number | null; windowSeconds: number; liquidityUsd: number | null; lpFeeBps: number }): number | null {
    if (i.liquidityUsd === null || !(i.liquidityUsd > 0) || !(i.windowSeconds > 0)) return null;
    if (i.volumeUsd === null) return null;
    const perYear = i.volumeUsd * (i.lpFeeBps / BPS) * (SECONDS_PER_YEAR / i.windowSeconds);
    return (perYear / i.liquidityUsd) * 100;
}

// ------------------------------------------------------------------------------------------------ farm rewards

export interface YieldFarmPool {
    pid: number;
    lpToken: string;
    allocPoint: bigint;
    totalStaked: bigint;
}

export interface YieldFarmInput {
    rewardAPerSecond: bigint;
    rewardBPerSecond: bigint;
    totalAllocPoint: bigint;
    /** The largest boost a wallet can receive (the boost source's own figure, clamped by the farm), in bps. */
    boostBps: bigint;
    pools: YieldFarmPool[];
    decimalsA: number;
    decimalsB: number;
    priceUsdA?: number;
    priceUsdB?: number;
}

export interface RewardYield {
    /** FARMING: in the farm. NOT_FARMING: has liquidity but the farm has not added it. NO_FARM: no farm to read. */
    status: 'FARMING' | 'NOT_FARMING' | 'NO_FARM';
    pid: number | null;
    /** The pool's share of emissions, in percent: actual for FARMING, assumed for NOT_FARMING. */
    sharePct: number | null;
    /** Value of the rewards this pool receives per day at that share, USD. */
    dailyUsd: number | null;
    /** Base reward APR in percent. */
    apr: number | null;
    /** The most a Qrb holder can reach: apr x (1 + boost). null when there is no boost or no apr. */
    aprBoosted: number | null;
    /**
     * What the APR is measured against. 'staked': value actually staked now. 'if-fully-staked': the pool's whole
     * liquidity, because nobody has staked yet; a projection, not today's payout rate.
     */
    basis: 'staked' | 'if-fully-staked' | 'none';
    /** True when the share is an assumption (NOT_FARMING), so the APR is a projection. */
    projected: boolean;
}

const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

/**
 * Reward yield for one pool.
 * @param stakedUsd value currently staked in the farm for this pool (0 when nobody has), null if unknown
 * @param unfarmedCount how many advertised pools are not in the farm: they are assumed to join together, so shares add up to 100%
 * @param assumedWeight allocation points an unfarmed pool is assumed to get (the farm's average weight, or 100 for an empty farm)
 */
export function projectReward(
    farm: YieldFarmInput | null,
    pair: string,
    liquidityUsd: number | null,
    stakedUsd: number | null,
    unfarmedCount: number,
    assumedWeight: bigint
): RewardYield {
    if (!farm) return { status: 'NO_FARM', pid: null, sharePct: null, dailyUsd: null, apr: null, aprBoosted: null, basis: 'none', projected: false };

    const inFarm = farm.pools.find(p => p.lpToken.toLowerCase() === pair.toLowerCase());
    let sharePct: number;
    if (inFarm) {
        sharePct = farm.totalAllocPoint === 0n ? 0 : Number((inFarm.allocPoint * 1_000_000n) / farm.totalAllocPoint) / 10_000;
    } else {
        const total = farm.totalAllocPoint + assumedWeight * BigInt(Math.max(1, unfarmedCount));
        sharePct = total === 0n ? 0 : Number((assumedWeight * 1_000_000n) / total) / 10_000;
    }

    const perDay = (rate: bigint, decimals: number, price?: number) => (price === undefined ? undefined : toNumber(rate, decimals) * SECONDS_PER_DAY * price);
    const a = perDay(farm.rewardAPerSecond, farm.decimalsA, farm.priceUsdA);
    const b = perDay(farm.rewardBPerSecond, farm.decimalsB, farm.priceUsdB);
    // A reward that is emitted but has no price makes the total value unknown rather than understated.
    const aKnown = farm.rewardAPerSecond === 0n || a !== undefined;
    const bKnown = farm.rewardBPerSecond === 0n || b !== undefined;
    const totalPerDay = aKnown && bKnown ? (a ?? 0) + (b ?? 0) : null;
    const dailyUsd = totalPerDay === null ? null : totalPerDay * (sharePct / 100);

    const staked = inFarm && stakedUsd !== null && stakedUsd > 0 ? stakedUsd : null;
    const denominator = staked ?? (liquidityUsd !== null && liquidityUsd > 0 ? liquidityUsd : null);
    const basis: RewardYield['basis'] = denominator === null ? 'none' : staked !== null ? 'staked' : 'if-fully-staked';
    const apr = dailyUsd === null || denominator === null ? null : ((dailyUsd * 365) / denominator) * 100;
    const aprBoosted = apr === null || farm.boostBps === 0n ? null : apr * (1 + Number(farm.boostBps) / BPS);

    return {
        status: inFarm ? 'FARMING' : 'NOT_FARMING',
        pid: inFarm ? inFarm.pid : null,
        sharePct,
        dailyUsd,
        apr,
        aprBoosted,
        basis,
        projected: !inFarm || basis === 'if-fully-staked'
    };
}

// ------------------------------------------------------------------------------------------------------- the board

export type YieldDex = 'CIRCLESWAP' | 'QUAISWAP' | 'QUAINANCE';

export interface YieldRow {
    pair: string;
    dex: YieldDex;
    name: string;
    token0: { address: string; symbol: string };
    token1: { address: string; symbol: string };
    liquidityUsd: number | null;
    /** Swap volume over the window, USD (null when no token in the pair could be priced). */
    volumeUsd: number | null;
    swaps: number;
    windowDays: number;
    lpFeeBps: number;
    feeApr: number | null;
    reward: RewardYield;
    /** Fee APR + base reward APR (reward counted only when known); null when neither is known. */
    totalApr: number | null;
    totalAprBoosted: number | null;
    thin: boolean;
}

export interface BoardInput {
    /** Analysed pairs for the pools to advertise (already filtered). */
    analyses: PairAnalysis[];
    /**
     * Per pair (lower-case) swap totals over the window; a pair missing here had no swaps. null means the history has
     * not been read (yet): volume and fee yield are then unknown, which is not the same as zero.
     */
    volumes: Map<string, SwapTotals> | null;
    windowSeconds: number;
    quaiUsd: number | null;
    farm: YieldFarmInput | null;
    /** LP fee share in bps per DEX (0.30% on all three, less the protocol's cut where it is on). */
    lpFeeBps: Record<YieldDex, number>;
    /**
     * Pools that are not pairs on this board but would join the farm alongside the unfarmed pairs (the single-token
     * pools, Q0 and BDELTA). They count in the "everything not in the farm joins together" assumption, so a pair's
     * estimated share on this board and a single-token pool's on its own row add up against the same total.
     */
    extraUnfarmed?: number;
}

/** The weight an unfarmed pool is assumed to get: the farm's average weight, or 100 for a farm with no pools. */
export function assumedWeightOf(farm: YieldFarmInput | null): bigint {
    if (!farm || farm.pools.length === 0) return 100n;
    const avg = farm.totalAllocPoint / BigInt(farm.pools.length);
    return avg > 0n ? avg : 100n;
}

/** One row per advertised pool, best total yield first, unknown last. */
export function buildYieldRows(i: BoardInput): YieldRow[] {
    const farmed = new Set((i.farm?.pools ?? []).map(p => p.lpToken.toLowerCase()));
    const unfarmed = i.analyses.filter(a => !farmed.has(a.pair.toLowerCase())).length + Math.max(0, Math.floor(i.extraUnfarmed ?? 0));
    const weight = assumedWeightOf(i.farm);
    const windowDays = i.windowSeconds / SECONDS_PER_DAY;

    const rows = i.analyses.map<YieldRow>(a => {
        const key = a.pair.toLowerCase();
        const v = i.volumes ? i.volumes.get(key) : undefined;
        const liquidityUsd = a.tvlUsd !== null && a.tvlUsd > 0 ? a.tvlUsd : null;

        // volume in USD from whichever side has a price (both sides of a swap are the same value)
        const q = i.quaiUsd;
        const side0 = v && q !== null && a.price0Quai !== null ? (Number(v.volume0) / 10 ** a.token0.decimals) * a.price0Quai * q : null;
        const side1 = v && q !== null && a.price1Quai !== null ? (Number(v.volume1) / 10 ** a.token1.decimals) * a.price1Quai * q : null;
        // every swap moves one token in and the other out, so each side's total already counts the whole swap once
        const volumeUsd =
            i.volumes === null ? null : !v ? (liquidityUsd !== null ? 0 : null) : side0 !== null && side1 !== null ? Math.max(side0, side1) : side0 ?? side1;

        const feeBps = i.lpFeeBps[a.dex as YieldDex] ?? 30;
        const fee = feeApr({ volumeUsd, windowSeconds: i.windowSeconds, liquidityUsd, lpFeeBps: feeBps });

        const stakedPool = i.farm?.pools.find(p => p.lpToken.toLowerCase() === key);
        const stakedUsd =
            stakedPool && liquidityUsd !== null && a.totalSupply > 0n
                ? (Number(stakedPool.totalStaked) / Number(a.totalSupply)) * liquidityUsd
                : stakedPool
                  ? 0
                  : null;
        const reward = projectReward(i.farm, a.pair, liquidityUsd, stakedUsd, unfarmed, weight);

        const known = [fee, reward.apr].filter((x): x is number => x !== null);
        const total = known.length ? known.reduce((s, x) => s + x, 0) : null;
        const boosted = total === null || reward.aprBoosted === null ? null : (fee ?? 0) + reward.aprBoosted;

        return {
            pair: a.pair,
            dex: a.dex as YieldDex,
            name: `${a.token0.symbol || '?'} / ${a.token1.symbol || '?'}`,
            token0: { address: a.token0.address, symbol: a.token0.symbol || '?' },
            token1: { address: a.token1.address, symbol: a.token1.symbol || '?' },
            liquidityUsd,
            volumeUsd,
            swaps: v?.swaps ?? 0,
            windowDays,
            lpFeeBps: feeBps,
            feeApr: fee,
            reward,
            totalApr: total,
            totalAprBoosted: boosted,
            thin: liquidityUsd === null || liquidityUsd < THIN_LIQUIDITY_USD
        };
    });

    return rows.sort((x, y) => {
        if (x.totalApr === null && y.totalApr === null) return (y.liquidityUsd ?? 0) - (x.liquidityUsd ?? 0);
        if (x.totalApr === null) return 1;
        if (y.totalApr === null) return -1;
        return y.totalApr - x.totalApr;
    });
}

/** USD price per token address (lower-case) from analysed pairs: the first pair that prices it, deepest liquidity first. */
export function tokenPricesUsd(analyses: PairAnalysis[], quaiUsd: number | null): Map<string, number> {
    const out = new Map<string, number>();
    if (quaiUsd === null) return out;
    const byDepth = [...analyses].sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
    for (const a of byDepth) {
        for (const [tok, price] of [[a.token0.address, a.price0Quai], [a.token1.address, a.price1Quai]] as const) {
            const k = tok.toLowerCase();
            if (price !== null && !out.has(k)) out.set(k, price * quaiUsd);
        }
    }
    return out;
}

// ------------------------------------------------------------------------------------------ single-token pools

/** The example deposit the single-token rows quote ("$1,000 deposited alone would earn about..."). A stated input, not data. */
export const EXAMPLE_STAKE_USD = 1_000;

export interface SingleStakeToken {
    /** Lower-case address of the token that is deposited. */
    token: string;
    symbol: string;
    /** USD per whole token, null when no source prices it. */
    priceUsd: number | null;
    /** Whole tokens in existence (total supply / 10^decimals), null when unreadable. */
    supply: number | null;
    /** Value of what is staked in the farm for this token now, USD (0 when nobody has), null when unknown. */
    stakedUsd: number | null;
}

export interface SingleStakeYield {
    token: string;
    symbol: string;
    reward: RewardYield;
    /** USD value of the entire supply: what "every token deposited" is measured against. null when unpriced. */
    supplyUsd: number | null;
    /** Tokens of each reward this pool receives per day at `reward.sharePct`; null when the rate is unknown. */
    dailyA: number | null;
    dailyB: number | null;
    /** What the whole pool earns in rewards per year at that share, USD; null when a reward cannot be priced. */
    yearlyUsd: number | null;
    /** Reward APR in percent for `EXAMPLE_STAKE_USD` deposited when nobody else has; null when unknown. */
    exampleApr: number | null;
    /** The same, with the largest Qrb boost. */
    exampleAprBoosted: number | null;
}

/**
 * Reward yield for each single-token pool, using the same maths as every LP pool (projectReward): a pool already in the
 * farm gets its real share, one that is not gets the assumed average share, and the APR is measured against what is
 * staked, or, when nobody has deposited, against the token's whole supply ("if every token were deposited": the floor,
 * which only rises as fewer tokens are deposited). `otherUnfarmed` is how many LP pools are also waiting to join, so the
 * shares across the page assume the same thing.
 */
export function buildSingleStakeYields(i: { farm: YieldFarmInput | null; tokens: SingleStakeToken[]; otherUnfarmed: number }): SingleStakeYield[] {
    const farmed = new Set((i.farm?.pools ?? []).map(p => p.lpToken.toLowerCase()));
    const waiting = i.tokens.filter(t => !farmed.has(t.token.toLowerCase())).length;
    const unfarmed = Math.max(0, Math.floor(i.otherUnfarmed)) + waiting;
    const weight = assumedWeightOf(i.farm);

    return i.tokens.map<SingleStakeYield>(t => {
        const supplyUsd = t.priceUsd !== null && t.supply !== null && t.supply > 0 ? t.supply * t.priceUsd : null;
        const reward = projectReward(i.farm, t.token, supplyUsd, t.stakedUsd, unfarmed, weight);
        const share = (reward.sharePct ?? 0) / 100;
        const perDay = (rate: bigint | undefined, decimals: number | undefined) =>
            rate === undefined || decimals === undefined ? null : toNumber(rate, decimals) * SECONDS_PER_DAY * share;
        const dailyA = i.farm ? perDay(i.farm.rewardAPerSecond, i.farm.decimalsA) : null;
        const dailyB = i.farm ? perDay(i.farm.rewardBPerSecond, i.farm.decimalsB) : null;
        const yearlyUsd = reward.dailyUsd === null ? null : reward.dailyUsd * 365;
        const exampleApr = reward.dailyUsd === null ? null : ((reward.dailyUsd * 365) / EXAMPLE_STAKE_USD) * 100;
        const boost = i.farm?.boostBps ?? 0n;
        return {
            token: t.token.toLowerCase(),
            symbol: t.symbol,
            reward,
            supplyUsd,
            dailyA,
            dailyB,
            yearlyUsd,
            exampleApr,
            exampleAprBoosted: exampleApr === null || boost === 0n ? null : exampleApr * (1 + Number(boost) / BPS)
        };
    });
}

// ------------------------------------------------------------------------------------------------ token price and cap

export interface TokenMarket {
    priceUsd: number | null;
    /** 'explorer': the explorer's indexed price. 'pools': derived from AMM reserves (the deepest route to WQUAI). */
    priceSource: 'explorer' | 'pools' | null;
    marketCapUsd: number | null;
    /** 'explorer': indexed by the explorer. 'supply': circulating supply x price (total supply when that is all there is). */
    marketCapSource: 'explorer' | 'supply' | null;
}

const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Price and market cap for one token. The explorer's figure wins when it has one; a token the explorer has not priced
 * (QRB, until it is indexed) falls back to the pools, and its market cap is price x supply. Missing inputs stay null:
 * a price of 0 is never invented, and a market cap is never shown without both a price and a supply.
 */
export function tokenMarket(i: {
    explorerPriceUsd?: number | null;
    explorerMarketCapUsd?: number | null;
    poolPriceUsd?: number | null;
    /** Total supply in whole tokens. */
    supply?: number | null;
}): TokenMarket {
    const priceUsd = positive(i.explorerPriceUsd) ? i.explorerPriceUsd : positive(i.poolPriceUsd) ? i.poolPriceUsd : null;
    const priceSource = positive(i.explorerPriceUsd) ? 'explorer' : positive(i.poolPriceUsd) ? 'pools' : null;
    if (positive(i.explorerMarketCapUsd)) return { priceUsd, priceSource, marketCapUsd: i.explorerMarketCapUsd, marketCapSource: 'explorer' };
    if (priceUsd !== null && positive(i.supply)) return { priceUsd, priceSource, marketCapUsd: priceUsd * i.supply, marketCapSource: 'supply' };
    return { priceUsd, priceSource, marketCapUsd: null, marketCapSource: null };
}

// -------------------------------------------------------------------------------- token market over time

export type MarketSource = 'explorer' | 'pools';

/** What the page last learned about one token, and when it learned each part. Everything is "unknown" until read. */
export interface MarketSnapshot {
    explorerPriceUsd: number | null;
    explorerMarketCapUsd: number | null;
    /** Total supply in whole tokens, from the contract. */
    supply: number | null;
    /** Price derived from the pools' reserves at `poolsAt`. */
    poolPriceUsd: number | null;
    /** When the explorer / the pools were last read successfully (ms since epoch); null = never. */
    explorerAt: number | null;
    poolsAt: number | null;
    /** Sources whose read failed in the latest round: their figures are the last good ones, not new ones. */
    failed: MarketSource[];
}

export interface MarketView extends TokenMarket {
    /** The sources the displayed price and market cap actually came from. */
    usedSources: MarketSource[];
    /** The oldest time among the used sources: how old the displayed numbers can be. null when nothing is displayed. */
    asOf: number | null;
    /** A source behind a displayed number failed on the latest round, so that number is being held, not refreshed. */
    degraded: boolean;
}

/**
 * The price and market cap to show, and how fresh they are. Same rules as `tokenMarket` (explorer first, then pools,
 * cap = price x supply when the explorer has none; an unknown stays null, never 0), plus the timestamps of the sources
 * that were used, so the page can say "updated 12 s ago" about exactly the numbers it shows.
 */
export function tokenMarketView(s: MarketSnapshot | null): MarketView {
    if (!s) return { priceUsd: null, priceSource: null, marketCapUsd: null, marketCapSource: null, usedSources: [], asOf: null, degraded: false };
    const m = tokenMarket({
        explorerPriceUsd: s.explorerPriceUsd,
        explorerMarketCapUsd: s.explorerMarketCapUsd,
        poolPriceUsd: s.poolPriceUsd,
        supply: s.supply
    });
    const used = new Set<MarketSource>();
    if (m.priceSource === 'explorer') used.add('explorer');
    if (m.priceSource === 'pools') used.add('pools');
    // an explorer cap is the explorer's; a computed cap rests on the price (the supply is the contract's, which does not move)
    if (m.marketCapSource === 'explorer') used.add('explorer');
    const stamps = [...used].map(u => (u === 'explorer' ? s.explorerAt : s.poolsAt));
    const known = stamps.filter((t): t is number => t !== null);
    // a used source that has never been read cannot be dated: say so (null) instead of borrowing another's time
    const asOf = used.size === 0 || known.length !== stamps.length ? null : Math.min(...known);
    return { ...m, usedSources: [...used], asOf, degraded: [...used].some(u => s.failed.includes(u)) };
}

/** What one polling round learned from each source. A source that was not reached is { ok: false }. */
export interface MarketRound {
    explorer:
        | { ok: true; priceUsd: number | null; marketCapUsd: number | null; supply: number | null; at: number | null; failedLatest: boolean }
        | { ok: false };
    pools: { ok: true; priceUsd: number | null; at: number } | { ok: false };
}

/**
 * Fold one polling round into the snapshot the page holds. A source that answered replaces its figures and its
 * timestamp; one that did not keeps the last good figures and the time they were read, and is listed in `failed`, so
 * a failing source can neither blank a number nor make an old one look new. Returns null when no source answered:
 * that round learned nothing, and the caller should treat it as a failed poll (keep what it has, back off).
 */
export function nextMarketSnapshot(previous: MarketSnapshot | null, round: MarketRound): MarketSnapshot | null {
    const prev: MarketSnapshot = previous ?? {
        explorerPriceUsd: null,
        explorerMarketCapUsd: null,
        supply: null,
        poolPriceUsd: null,
        explorerAt: null,
        poolsAt: null,
        failed: []
    };
    const failed: MarketSource[] = [];
    const next: MarketSnapshot = { ...prev, failed };

    if (round.explorer.ok) {
        next.explorerPriceUsd = round.explorer.priceUsd;
        next.explorerMarketCapUsd = round.explorer.marketCapUsd;
        next.supply = round.explorer.supply ?? prev.supply;
        next.explorerAt = round.explorer.at ?? prev.explorerAt;
        if (round.explorer.failedLatest) failed.push('explorer');
    } else {
        failed.push('explorer');
    }

    if (round.pools.ok) {
        next.poolPriceUsd = round.pools.priceUsd;
        next.poolsAt = round.pools.at;
    } else {
        failed.push('pools');
    }

    return failed.length === 2 ? null : next;
}
