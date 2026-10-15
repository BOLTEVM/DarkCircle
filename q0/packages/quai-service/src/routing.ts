// Route search: the best way to swap any token for any other across every DEX the app knows.
//
// The graph is the set of live pools: a token is a node and each pool is an edge labelled with the DEX that owns it. A
// route is a simple path (no token twice) of at most `maxHops` pools. Consecutive pools of one DEX go to that DEX's
// router as a single multi-hop call (one transaction); each change of DEX is a separate router transaction, so a route
// that crosses DEXes is not atomic and is only preferred when it is clearly better (see PREFERENCE_BPS).
//
// Network fees are part of "best". A swap on Cyprus-1 costs several QUAI of gas (measured 2026-10-12: about 189,000 gas
// for one pool and 276,000 for two, at a gas price near 4e13 wei), and a route that needs three transactions pays that
// three times plus an approval for each. When the caller supplies the gas price, candidates are ranked by what they
// return MINUS what they cost to execute, both in the token being received, so a longer route is only chosen when it
// earns its fees. Without a gas price the ranking is by output alone.
//
// Everything here is exact BigInt maths over reserves the caller already read: no network, no clock, no randomness, so
// the same inputs always give the same route and the whole thing is tested on fixtures.
//
// One honest limit: a token with no pool anywhere (a launch still on its bonding curve) has no node in this graph, so it
// finds no route here. Curve markets are a different venue with a different call, handled by venues.ts, which adds a
// curve leg at either end of a route found here.

import { TOKEN_REGISTRY } from './registries/tokens';
import {
    DEXES,
    type CrossDexRoute,
    type DexId,
    type NavigationRoute,
    type PoolInfo,
    type RouteSegment,
    type SwapRoute
} from './registries/pools';
import { quoteCrossDexRoute, quoteRoute, type LPReserves, type RouteQuote } from './index';
import { GAS_CURVE_BUY, GAS_CURVE_SELL, type CurveLeg } from './curves';

/**
 * A route that is easier to execute goes first when it is within this many basis points of the best output: fewer wallet
 * transactions (a route that crosses DEXes cannot be left half done only if it is a single transaction), then no
 * unverified token used as a stepping stone.
 */
export const PREFERENCE_BPS = 100;
/** Kept under the old name for callers written against the first version. */
export const ATOMIC_PREFERENCE_BPS = PREFERENCE_BPS;
/** Pools in a route, at most. Four reaches any two tokens that share a hub (token → WQUAI → token) with room to spare. */
export const DEFAULT_MAX_HOPS = 4;
/** Candidate paths examined, at most, so a flood of junk pools cannot make a swap screen hang. */
export const MAX_CANDIDATES = 3000;

/**
 * Gas model, from simulations of the real routers on 2026-10-12 (swapExactETHForTokens, 1 pool 188-189k, 2 pools 276k,
 * approve 69k). Estimates for ranking only: the transaction itself is simulated and sized before it is sent.
 */
export const GAS_PER_SWAP_CALL = 100_000n;
export const GAS_PER_POOL = 88_000n;
export const GAS_PER_APPROVAL = 70_000n;

/** What the caller knows about the cost of a transaction. */
export interface GasModel {
    /** Wei of QUAI per unit of gas. */
    gasPriceWei: bigint;
}

/** One router call: every pool in `path` belongs to `dex`, so the DEX's router settles it in a single transaction. */
export interface AmmLeg {
    kind: 'AMM';
    dex: DexId;
    /** Registry keys, first to last. */
    path: string[];
}

/** One step of a route, executed as one transaction (an approval, where one is needed, comes with it). */
export type Leg = AmmLeg | CurveLeg;

export interface RouteSearch {
    /** Registry keys (symbols) of the token paid and the token wanted. */
    from: string;
    to: string;
    amountIn: bigint;
    pools: PoolInfo[];
    /** Live reserves keyed by lower-cased pair address. */
    reserves: Record<string, LPReserves | undefined>;
    slippagePct: number;
    maxHops?: number;
    /** The token paid is native QUAI (so the first step needs no approval). */
    nativeIn?: boolean;
    /** With a gas price, routes are ranked by output minus network fees instead of by output alone. */
    gas?: GasModel | null;
}

export interface RouteCandidate {
    id: string;
    label: string;
    /** Registry keys of every token the route passes through, first to last. */
    path: string[];
    legs: Leg[];
    quote: RouteQuote;
    /** Pools crossed (a curve step counts as one). */
    hops: number;
    /** Transactions the wallet signs for the swap itself: 1 means a single step. */
    segmentCount: number;
    /** Registry keys, ends included, of tokens in this route that the app has not curated. */
    unverified: string[];
    /** An unverified token is a stepping stone (neither the token paid nor the token received). */
    unverifiedBetween: boolean;
    /** Estimated gas for every transaction of the route, approvals included. */
    gasUnits: bigint;
    /** Those fees in wei of QUAI at the supplied gas price; null when no gas price was given. */
    feeWei: bigint | null;
    /** The same fees in base units of the token received; null when it cannot be valued against QUAI. */
    feeOut: bigint | null;
    /** What the route returns after fees (quote.amountOut when fees are unknown). Routes are ranked by this. */
    netOut: bigint;
    /** The AMM-only route object this was built from; null for a route with a curve step. */
    route: NavigationRoute | null;
}

interface Edge {
    to: string;
    pool: PoolInfo;
}

interface Hop {
    from: string;
    to: string;
    dex: DexId;
}

const reserveOf = (res: LPReserves | undefined): [bigint, bigint] | null => {
    if (!res) return null;
    try {
        const r0 = BigInt(res.reserve0);
        const r1 = BigInt(res.reserve1);
        return r0 > 0n && r1 > 0n ? [r0, r1] : null;
    } catch {
        return null;
    }
};

/** Pools that can be traded against: a known pair address, both tokens registered, both reserves above zero. */
export function tradablePools(pools: PoolInfo[], reserves: Record<string, LPReserves | undefined>): PoolInfo[] {
    return pools.filter(p => {
        const [a, b] = p.tokens;
        if (a === b || !TOKEN_REGISTRY[a] || !TOKEN_REGISTRY[b]) return false;
        return reserveOf(reserves[p.pair.toLowerCase()]) !== null;
    });
}

function adjacency(pools: PoolInfo[], reserves: Record<string, LPReserves | undefined>): Map<string, Edge[]> {
    const graph = new Map<string, Edge[]>();
    const add = (from: string, to: string, pool: PoolInfo) => {
        const list = graph.get(from) ?? [];
        list.push({ to, pool });
        graph.set(from, list);
    };
    for (const pool of pools) {
        add(pool.tokens[0], pool.tokens[1], pool);
        add(pool.tokens[1], pool.tokens[0], pool);
    }
    // Deepest pools first, so when the candidate cap bites it is the dust that is dropped. Depth is the smaller side's
    // whole-token amount (decimals applied), which is order-of-magnitude comparable across tokens.
    const depth = (p: PoolInfo): number => {
        const r = reserveOf(reserves[p.pair.toLowerCase()]);
        if (!r) return 0;
        const d0 = TOKEN_REGISTRY[p.tokens[0]]?.decimals ?? 18;
        const d1 = TOKEN_REGISTRY[p.tokens[1]]?.decimals ?? 18;
        return Math.min(Number(r[0]) / 10 ** d0, Number(r[1]) / 10 ** d1);
    };
    for (const list of graph.values()) {
        list.sort((x, y) => depth(y.pool) - depth(x.pool) || x.to.localeCompare(y.to) || x.pool.pair.localeCompare(y.pool.pair));
    }
    return graph;
}

function groupSegments(hops: Hop[]): RouteSegment[] {
    const segments: RouteSegment[] = [];
    for (const hop of hops) {
        const last = segments[segments.length - 1];
        if (last && last.dex === hop.dex) last.path.push(hop.to);
        else segments.push({ dex: hop.dex, path: [hop.from, hop.to] });
    }
    return segments;
}

const routeLabel = (path: string[], segments: RouteSegment[]) =>
    `${path.join(' → ')} · ${[...new Set(segments.map(s => DEXES[s.dex].label))].join(' → ')}`;

/** The legs of an AMM route: one per router call. */
export function legsOfRoute(route: NavigationRoute): AmmLeg[] {
    if ('crossDex' in route) return route.segments.map(s => ({ kind: 'AMM' as const, dex: s.dex, path: [...s.path] }));
    return [{ kind: 'AMM', dex: route.dex, path: [...route.path] }];
}

/** Registry keys of the tokens of a path that are not curated (found in a pool, or imported by the user). */
export function unverifiedTokens(path: string[]): string[] {
    return path.filter(key => {
        const t = TOKEN_REGISTRY[key];
        return Boolean(t) && t.discovered === true;
    });
}

/** Wallet-effort of a route: transactions first, then whether an unverified token is used as a stepping stone. */
const friction = (c: RouteCandidate): number => c.segmentCount * 2 + (c.unverifiedBetween ? 1 : 0);

/**
 * Put the easiest route among those within PREFERENCE_BPS of the best output first. `sorted` must be ordered best output
 * first. The rest keep their order.
 */
export function preferEasier(sorted: RouteCandidate[], toleranceBps: number = PREFERENCE_BPS): RouteCandidate[] {
    if (sorted.length < 2) return sorted;
    const best = sorted[0];
    // When even the best route nets nothing (the fees are the whole swap) there is no margin to be within.
    if (best.netOut <= 0n) return sorted;
    const floor = best.netOut * BigInt(10_000 - toleranceBps);
    let pick = best;
    for (const c of sorted) {
        if (c.netOut * 10_000n < floor) break;
        if (friction(c) < friction(pick)) pick = c;
    }
    return pick === best ? sorted : [pick, ...sorted.filter(c => c !== pick)];
}

/** Order candidates by what they return after fees, best first; ties fall back to fewer hops, fewer steps, then id (stable). */
export function sortByOutput(list: RouteCandidate[]): RouteCandidate[] {
    return [...list].sort((a, b) =>
        a.netOut === b.netOut ? a.hops - b.hops || a.segmentCount - b.segmentCount || a.id.localeCompare(b.id) : a.netOut > b.netOut ? -1 : 1
    );
}

/**
 * Gas for the legs of a route: a router call per AMM leg (more pools, more gas), a buy or sell per curve leg, and an approval
 * for every leg paid in a token (a leg paid in native QUAI, the first one or the one after a curve sell, needs none).
 */
export function gasForLegs(legs: Leg[], nativeIn: boolean): bigint {
    let gas = 0n;
    legs.forEach((leg, i) => {
        const previous = legs[i - 1];
        const paidNative = (i === 0 && nativeIn) || (previous?.kind === 'CURVE' && previous.side === 'SELL');
        if (leg.kind === 'AMM') {
            gas += GAS_PER_SWAP_CALL + GAS_PER_POOL * BigInt(leg.path.length - 1);
            if (!paidNative) gas += GAS_PER_APPROVAL;
        } else if (leg.side === 'BUY') {
            gas += GAS_CURVE_BUY;
        } else {
            gas += GAS_CURVE_SELL + GAS_PER_APPROVAL;
        }
    });
    return gas;
}

/**
 * Base units of the token `to` that one whole QUAI buys, from the best route WQUAI -> `to`, or null if there is none.
 * Measured on a tenth of a QUAI so the pool's own fee and depth barely move it.
 */
export function outPerQuai(to: string, pools: PoolInfo[], reserves: Record<string, LPReserves | undefined>): bigint | null {
    if (to === 'WQUAI') return 10n ** 18n;
    const probe = 10n ** 17n;
    const best = listRoutes({ from: 'WQUAI', to, amountIn: probe, pools, reserves, slippagePct: 0, maxHops: 3 })[0];
    return best ? best.quote.amountOut * 10n : null;
}

/** Every candidate route, quoted, best first. Empty when nothing connects the two tokens with liquidity. */
export function listRoutes(search: RouteSearch): RouteCandidate[] {
    const { from, to, amountIn, reserves, slippagePct } = search;
    const maxHops = search.maxHops ?? DEFAULT_MAX_HOPS;
    if (amountIn <= 0n || from === to || !TOKEN_REGISTRY[from] || !TOKEN_REGISTRY[to]) return [];

    const pools = tradablePools(search.pools, reserves);
    const graph = adjacency(pools, reserves);
    if (!graph.has(from) || !graph.has(to)) return [];

    const found: Hop[][] = [];
    const visited = new Set<string>([from]);
    const walk = (current: string, hops: Hop[]) => {
        if (found.length >= MAX_CANDIDATES) return;
        for (const edge of graph.get(current) ?? []) {
            if (visited.has(edge.to)) continue;
            const next = [...hops, { from: current, to: edge.to, dex: edge.pool.dex }];
            if (edge.to === to) {
                found.push(next);
                if (found.length >= MAX_CANDIDATES) return;
                continue;
            }
            if (next.length >= maxHops) continue;
            visited.add(edge.to);
            walk(edge.to, next);
            visited.delete(edge.to);
        }
    };
    walk(from, []);

    const nativeIn = search.nativeIn === true;
    const gasPrice = search.gas?.gasPriceWei ?? null;
    const perQuai = gasPrice !== null ? outPerQuai(to, pools, reserves) : null;

    const candidates: RouteCandidate[] = [];
    const seen = new Set<string>();
    for (const hops of found) {
        const path = [from, ...hops.map(h => h.to)];
        const segments = groupSegments(hops);
        const key = `${path.join('>')}|${segments.map(s => s.dex).join('>')}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let route: NavigationRoute;
        let quote: RouteQuote | null;
        if (segments.length === 1) {
            const single: SwapRoute = { id: `AUTO_${segments[0].dex}_${path.join('_')}`, label: routeLabel(path, segments), dex: segments[0].dex, path };
            route = single;
            quote = quoteRoute(single, false, amountIn, reserves, slippagePct, pools);
        } else {
            const cross: CrossDexRoute = {
                id: `AUTO_CROSS_${path.join('_')}_${segments.map(s => s.dex).join('_')}`,
                label: routeLabel(path, segments),
                path,
                segments,
                crossDex: true
            };
            route = cross;
            quote = quoteCrossDexRoute(cross, false, amountIn, reserves, slippagePct, pools);
        }
        if (!quote || quote.amountOut <= 0n) continue;
        const unverified = unverifiedTokens(path);
        const legs = legsOfRoute(route);
        const gasUnits = gasForLegs(legs, nativeIn);
        const feeWei = gasPrice !== null ? gasUnits * gasPrice : null;
        const feeOut = feeWei !== null && perQuai !== null ? (feeWei * perQuai + 10n ** 18n - 1n) / 10n ** 18n : null;
        candidates.push({
            id: route.id,
            label: route.label,
            path,
            legs,
            quote,
            hops: hops.length,
            segmentCount: segments.length,
            unverified,
            unverifiedBetween: unverifiedTokens(path.slice(1, -1)).length > 0,
            gasUnits,
            feeWei,
            feeOut,
            netOut: quote.amountOut - (feeOut ?? 0n),
            route
        });
    }
    return preferEasier(sortByOutput(candidates));
}

/** The route to use, or null when no chain of pools with liquidity connects the two tokens. */
export function findBestRoute(search: RouteSearch): RouteCandidate | null {
    return listRoutes(search)[0] ?? null;
}

/**
 * Whether any chain of pools with liquidity connects two tokens, independent of the amount. Used to tell "no pool
 * connects these" (add liquidity) from "this amount cannot be quoted" (try less).
 */
export function isConnected(from: string, to: string, pools: PoolInfo[], reserves: Record<string, LPReserves | undefined>, maxHops: number = DEFAULT_MAX_HOPS): boolean {
    if (from === to) return false;
    const graph = adjacency(tradablePools(pools, reserves), reserves);
    if (!graph.has(from) || !graph.has(to)) return false;
    let frontier = new Set<string>([from]);
    const seen = new Set<string>([from]);
    for (let depth = 0; depth < maxHops && frontier.size; depth++) {
        const next = new Set<string>();
        for (const node of frontier) {
            for (const edge of graph.get(node) ?? []) {
                if (edge.to === to) return true;
                if (!seen.has(edge.to)) {
                    seen.add(edge.to);
                    next.add(edge.to);
                }
            }
        }
        frontier = next;
    }
    return false;
}

/**
 * Re-quote an AMM-only candidate against new reserves (the swap screen does this right before signing). Null when a hop
 * has no reserves any more or the candidate has a curve step, which venues.ts re-quotes from the contract itself.
 */
export function requoteCandidate(
    candidate: RouteCandidate,
    amountIn: bigint,
    reserves: Record<string, LPReserves | undefined>,
    slippagePct: number,
    pools: PoolInfo[]
): RouteQuote | null {
    const route = candidate.route;
    if (!route) return null;
    return 'crossDex' in route
        ? quoteCrossDexRoute(route, false, amountIn, reserves, slippagePct, pools)
        : quoteRoute(route, false, amountIn, reserves, slippagePct, pools);
}

// --------------------------------------------------------------------------------------------------- split routing

export interface SplitEvaluation {
    amountA: bigint;
    amountB: bigint;
    outA: bigint;
    outB: bigint;
    total: bigint;
    bestSingle: bigint;
    bestSingleVenue: 'A' | 'B';
    gain: bigint;
}

export type QuoteFn = (amountIn: bigint) => bigint | { amountOut: bigint };

/**
 * Grid-search a two-venue split of amountIn across parallel pools.
 * quoteFnA / quoteFnB: (amountIn: bigint) => bigint | { amountOut: bigint }.
 * extraGas: extra cost of using two venues instead of one, ALREADY in output-token units.
 * Bounds steps to [2, 50] to guard against unbounded iteration and denial of service.
 * Returns null unless splitting beats the best single venue by strictly more than extraGas.
 */
export function evaluateSplit(
    quoteFnA: QuoteFn,
    quoteFnB: QuoteFn,
    amountIn: bigint,
    steps: number = 10,
    extraGas: bigint = 0n
): SplitEvaluation | null {
    const total = amountIn > 0n ? amountIn : 0n;
    if (total <= 0n) return null;
    const n = BigInt(Math.max(2, Math.min(50, Math.floor(steps))));
    const extra = extraGas > 0n ? extraGas : 0n;

    const outOf = (q: bigint | { amountOut: bigint } | null | undefined): bigint => {
        if (q === null || q === undefined) return 0n;
        const v = typeof q === 'bigint' ? q : q.amountOut;
        return typeof v === 'bigint' && v > 0n ? v : 0n;
    };

    const allA = outOf(quoteFnA(total));
    const allB = outOf(quoteFnB(total));
    if (allA <= 0n && allB <= 0n) return null;

    const bestSingle = allA >= allB ? allA : allB;
    const bestSingleVenue: 'A' | 'B' = allA >= allB ? 'A' : 'B';

    let best: { amountA: bigint; amountB: bigint; outA: bigint; outB: bigint; total: bigint } | null = null;
    for (let i = 1n; i < n; i++) {
        const amountA = (total * i) / n;
        const amountB = total - amountA;
        if (amountA <= 0n || amountB <= 0n) continue;
        const outA = outOf(quoteFnA(amountA));
        const outB = outOf(quoteFnB(amountB));
        const sum = outA + outB;
        if (!best || sum > best.total) {
            best = { amountA, amountB, outA, outB, total: sum };
        }
    }

    if (!best) return null;
    const gain = best.total - bestSingle - extra;
    if (gain <= 0n) return null;

    return {
        ...best,
        bestSingle,
        bestSingleVenue,
        gain
    };
}

export interface SplitRouteCandidate {
    kind: 'SPLIT';
    id: string;
    label: string;
    from: string;
    to: string;
    venueA: DexId;
    venueB: DexId;
    poolA: PoolInfo;
    poolB: PoolInfo;
    amountA: bigint;
    amountB: bigint;
    outA: bigint;
    outB: bigint;
    totalOut: bigint;
    bestSingleOut: bigint;
    bestSingleVenue: DexId;
    gain: bigint;
    gainPct: number;
    extraGasUnits: bigint;
}

/**
 * Searches for parallel direct pools connecting two tokens across different DEXes (e.g. QAXE <-> WQUAI on HartiiSwap and Quainance Launch 2)
 * and determines if splitting amountIn between both pools yields a higher net return than any single venue.
 */
export function findSplitRoute(
    search: RouteSearch,
    steps: number = 20
): SplitRouteCandidate | null {
    const { from, to, amountIn, reserves, slippagePct } = search;
    if (amountIn <= 0n || from === to || !TOKEN_REGISTRY[from] || !TOKEN_REGISTRY[to]) return null;

    const availablePools = tradablePools(search.pools, reserves).filter(p => {
        const [a, b] = p.tokens;
        return (a === from && b === to) || (a === to && b === from);
    });

    if (availablePools.length < 2) return null;

    // Pick top two pools by reserve depth
    const poolDepth = (p: PoolInfo): bigint => {
        const r = reserveOf(reserves[p.pair.toLowerCase()]);
        return r ? r[0] : 0n;
    };
    const sorted = [...availablePools].sort((x, y) => (poolDepth(y) > poolDepth(x) ? 1 : -1));
    const poolA = sorted[0];
    const poolB = sorted[1];
    if (poolA.dex === poolB.dex) return null;

    const quoteA = (amt: bigint): bigint => {
        const single: SwapRoute = { id: `SPLIT_A`, label: '', dex: poolA.dex, path: [from, to] };
        const q = quoteRoute(single, false, amt, reserves, slippagePct, [poolA]);
        return q ? q.amountOut : 0n;
    };
    const quoteB = (amt: bigint): bigint => {
        const single: SwapRoute = { id: `SPLIT_B`, label: '', dex: poolB.dex, path: [from, to] };
        const q = quoteRoute(single, false, amt, reserves, slippagePct, [poolB]);
        return q ? q.amountOut : 0n;
    };

    // Extra gas for second transaction (swap call + pool hop)
    const extraGasUnits = GAS_PER_SWAP_CALL + GAS_PER_POOL;
    const gasPrice = search.gas?.gasPriceWei ?? null;
    let extraFeeOut = 0n;
    if (gasPrice !== null && gasPrice > 0n) {
        const perQuai = outPerQuai(to, search.pools, reserves);
        if (perQuai !== null) {
            const extraFeeWei = extraGasUnits * gasPrice;
            extraFeeOut = (extraFeeWei * perQuai + 10n ** 18n - 1n) / (10n ** 18n);
        }
    }

    const split = evaluateSplit(quoteA, quoteB, amountIn, steps, extraFeeOut);
    if (!split) return null;

    const bestVenue = split.bestSingleVenue === 'A' ? poolA.dex : poolB.dex;
    const gainPct = split.bestSingle > 0n ? (Number(split.gain) / Number(split.bestSingle)) * 100 : 0;

    return {
        kind: 'SPLIT',
        id: `SPLIT_${from}_${to}_${poolA.dex}_${poolB.dex}`,
        label: `Split: ${TOKEN_REGISTRY[from]?.symbol ?? from} → ${TOKEN_REGISTRY[to]?.symbol ?? to} (${DEXES[poolA.dex].label} + ${DEXES[poolB.dex].label})`,
        from,
        to,
        venueA: poolA.dex,
        venueB: poolB.dex,
        poolA,
        poolB,
        amountA: split.amountA,
        amountB: split.amountB,
        outA: split.outA,
        outB: split.outB,
        totalOut: split.total,
        bestSingleOut: split.bestSingle,
        bestSingleVenue: bestVenue,
        gain: split.gain,
        gainPct,
        extraGasUnits
    };
}

/** Minimum acceptable output: floor(amountOut * (10000 - slippageBps) / 10000). */
export function minOut(amountOut: bigint, slippageBps: number | bigint): bigint {
    const out = amountOut > 0n ? amountOut : 0n;
    const b = BigInt(slippageBps);
    if (b < 0n || b > 10000n) throw new RangeError('slippageBps must be an integer between 0 and 10000');
    return (out * (10000n - b)) / 10000n;
}

