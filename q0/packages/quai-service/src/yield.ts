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
    const unfarmed = i.analyses.filter(a => !farmed.has(a.pair.toLowerCase())).length;
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
