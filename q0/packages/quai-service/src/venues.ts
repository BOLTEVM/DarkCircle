// Routes that use a launch curve: a token with no AMM pool (or a better price on its curve) bought with, or sold for, native QUAI.
//
// A curve market is a contract that trades one token against NATIVE QUAI. It sits at an end of a route:
//
//   buy  :  [ any AMM route from the token paid into native QUAI ]  ->  BUY on the curve
//   sell :  SELL on the curve  ->  [ any AMM route from native QUAI into the token wanted ]
//
// so the AMM search in routing.ts is reused unchanged on either side, and this file only joins its results to a curve leg and
// ranks the whole by the same rule (output after network fees, easier route preferred within 1%).
//
// Quotes come from exact local maths for Hartii markets (checked against the contract at load) and from the contract's own
// view for POOP and Quainance launches, which are buy-only here. A view-quoted quote is one RPC call, so it is asked for only
// for the few candidates that survive the AMM side.

import { TOKEN_REGISTRY } from './registries/tokens';
import type { PoolInfo } from './registries/pools';
import { quoteRoute, type LPReserves, type RouteQuote } from './index';
import {
    curveCanSell,
    curveVenueLabel,
    hartiiBuyOut,
    hartiiSellOut,
    hartiiSpotBuy,
    hartiiSpotSell,
    type CurveLeg,
    type CurveMarketState,
    type ViewState
} from './curves';
import {
    DEFAULT_MAX_HOPS,
    gasForLegs,
    listRoutes,
    outPerQuai,
    preferEasier,
    sortByOutput,
    unverifiedTokens,
    type GasModel,
    type Leg,
    type RouteCandidate
} from './routing';

const WQUAI = 'WQUAI';
/** AMM routes kept on each side of a curve leg. */
const TOP_SIDE_ROUTES = 3;

/** Ask a view-quoted market what `quaiIn` buys. Supplied by the caller (it is a network call). */
export type ViewQuoter = (state: ViewState, quaiIn: bigint) => Promise<bigint | null>;

export interface CurveRouteSearch {
    from: string;
    to: string;
    amountIn: bigint;
    pools: PoolInfo[];
    reserves: Record<string, LPReserves | undefined>;
    slippagePct: number;
    /** The token paid is native QUAI. */
    nativeIn?: boolean;
    /** The token wanted is native QUAI (so a curve sell may end the route). */
    nativeOut?: boolean;
    gas?: GasModel | null;
    /** Verified curve markets by token registry key. */
    curves: Record<string, CurveMarketState | undefined>;
    viewQuote?: ViewQuoter;
}

interface Stage {
    legs: Leg[];
    path: string[];
    /** Output of this stage in base units of its last token (native QUAI wei when it ends at WQUAI). */
    out: bigint;
    /** Product of the zero-size prices (raw units) of the legs, for the price effect. */
    spot: number;
    hops: number;
}

const ONE_QUAI = 10n ** 18n;

/** Zero-size price of an AMM sub-route, recovered from its own quote: exec = spot x (1 - impact). */
function stageOfRoute(c: RouteCandidate): Stage {
    const keep = 1 - c.quote.priceImpactPct / 100;
    return { legs: c.legs, path: c.path, out: c.quote.amountOut, spot: keep > 1e-9 ? c.quote.executionPrice / keep : c.quote.executionPrice * 1e9, hops: c.hops };
}

async function curveBuyOut(state: CurveMarketState, quaiIn: bigint, viewQuote?: ViewQuoter): Promise<bigint | null> {
    if (state.venue === 'HARTII') return hartiiBuyOut(state, quaiIn);
    return viewQuote ? viewQuote(state, quaiIn) : null;
}

/** Candidates that end or begin on a curve, quoted. Empty when neither token has a verified curve market. */
export async function listCurveRoutes(search: CurveRouteSearch): Promise<RouteCandidate[]> {
    const { from, to, amountIn, pools, reserves, slippagePct, curves, viewQuote } = search;
    if (amountIn <= 0n || from === to || !TOKEN_REGISTRY[from] || !TOKEN_REGISTRY[to]) return [];
    const nativeIn = search.nativeIn === true;
    const nativeOut = search.nativeOut === true;
    const fromCurve = from === WQUAI ? undefined : curves[from];
    const toCurve = to === WQUAI ? undefined : curves[to];
    if (!fromCurve && !toCurve) return [];

    const ammOpts = { pools, reserves, slippagePct, gas: null, maxHops: DEFAULT_MAX_HOPS - 1 };

    // ---- before the curve: get native QUAI ----
    const pre: Stage[] = [];
    if (from === WQUAI) {
        if (nativeIn) pre.push({ legs: [], path: [WQUAI], out: amountIn, spot: 1, hops: 0 });
    } else {
        for (const c of listRoutes({ ...ammOpts, from, to: WQUAI, amountIn, nativeIn }).slice(0, TOP_SIDE_ROUTES)) pre.push(stageOfRoute(c));
        if (fromCurve && curveCanSell(fromCurve) && fromCurve.venue === 'HARTII') {
            const out = hartiiSellOut(fromCurve, amountIn);
            const spot = hartiiSpotSell(fromCurve);
            if (out !== null && spot > 0) {
                pre.push({ legs: [{ kind: 'CURVE', side: 'SELL', token: from, market: fromCurve }], path: [from, WQUAI], out, spot, hops: 1 });
            }
        }
    }
    if (!pre.length) return [];

    // ---- after the curve: from native QUAI to the token wanted ----
    const candidates: RouteCandidate[] = [];
    const seen = new Set<string>();
    const perQuaiCache: { value: bigint | null | undefined } = { value: undefined };

    const outPerQuaiForTo = async (): Promise<bigint | null> => {
        if (perQuaiCache.value !== undefined) return perQuaiCache.value;
        let v: bigint | null;
        if (to === WQUAI) v = ONE_QUAI;
        else if (toCurve) {
            const probe = ONE_QUAI / 10n;
            const out = await curveBuyOut(toCurve, probe, viewQuote);
            v = out !== null ? out * 10n : outPerQuai(to, pools, reserves);
        } else v = outPerQuai(to, pools, reserves);
        perQuaiCache.value = v;
        return v;
    };
    const gasPrice = search.gas?.gasPriceWei ?? null;

    for (const p of pre) {
        const x = p.out;
        if (x <= 0n) continue;
        const posts: Stage[] = [];
        if (to === WQUAI) {
            if (nativeOut) posts.push({ legs: [], path: [WQUAI], out: x, spot: 1, hops: 0 });
        } else {
            for (const c of listRoutes({ ...ammOpts, from: WQUAI, to, amountIn: x, nativeIn: true }).slice(0, TOP_SIDE_ROUTES)) posts.push(stageOfRoute(c));
            if (toCurve) {
                const out = await curveBuyOut(toCurve, x, viewQuote);
                if (out !== null) {
                    const spot = toCurve.venue === 'HARTII' ? hartiiSpotBuy(toCurve) : await viewSpot(toCurve, viewQuote);
                    if (spot > 0) {
                        posts.push({ legs: [{ kind: 'CURVE', side: 'BUY', token: to, market: toCurve }], path: [WQUAI, to], out, spot, hops: 1 });
                    }
                }
            }
        }

        for (const q of posts) {
            const legs: Leg[] = [...p.legs, ...q.legs];
            if (!legs.some(l => l.kind === 'CURVE')) continue; // plain AMM routes are listRoutes' business
            const path = [...p.path, ...q.path.slice(1)];
            const id = `CURVE|${path.join('>')}|${legs.map(l => (l.kind === 'AMM' ? `AMM:${l.dex}:${l.path.join('-')}` : `${l.side}:${l.market.venue}`)).join(',')}`;
            if (seen.has(id)) continue;
            seen.add(id);

            const amountOut = q.out;
            if (amountOut <= 0n) continue;
            const exec = Number(amountOut) / Number(amountIn);
            const spot = p.spot * q.spot;
            const impact = spot > 0 ? Math.max(0, (1 - exec / spot) * 100) : 0;
            const quote: RouteQuote = {
                amountOut,
                minimumReceived: (amountOut * BigInt(10000 - Math.max(0, Math.min(5000, Math.round(slippagePct * 100))))) / 10000n,
                priceImpactPct: impact,
                executionPrice: exec
            };
            const gasUnits = gasForLegs(legs, nativeIn);
            const feeWei = gasPrice !== null ? gasUnits * gasPrice : null;
            const perQuai = feeWei !== null ? await outPerQuaiForTo() : null;
            const feeOut = feeWei !== null && perQuai !== null ? (feeWei * perQuai) / ONE_QUAI : null;
            const venueLabels = [...new Set(legs.filter((l): l is CurveLeg => l.kind === 'CURVE').map(l => curveVenueLabel(l.market)))];
            candidates.push({
                id,
                label: `${path.join(' → ')} · ${venueLabels.join(', ')}`,
                path,
                legs,
                quote,
                hops: p.hops + q.hops,
                segmentCount: legs.length,
                unverified: unverifiedTokens(path),
                unverifiedBetween: unverifiedTokens(path.slice(1, -1).filter(k => k !== WQUAI)).length > 0,
                gasUnits,
                feeWei,
                feeOut,
                netOut: amountOut - (feeOut ?? 0n),
                route: null
            });
        }
    }
    return preferEasier(sortByOutput(candidates));
}

/** Zero-size price of a view-quoted market, from a small probe (the contract's own quote scaled up). */
async function viewSpot(state: CurveMarketState, viewQuote?: ViewQuoter): Promise<number> {
    if (state.venue === 'HARTII' || !viewQuote) return 0;
    const probe = 10n ** 12n;
    const out = await viewQuote(state, probe);
    return out !== null && out > 0n ? Number(out) / Number(probe) : 0;
}

export interface LegQuoteContext {
    reserves: Record<string, LPReserves | undefined>;
    pools: PoolInfo[];
    slippagePct: number;
    /** Fresh curve markets by token registry key, replacing the snapshot a leg carries. */
    curves?: Record<string, CurveMarketState | undefined>;
    viewQuote?: ViewQuoter;
}

/** What one leg returns for `amountIn`, or null when it cannot be filled. */
export async function quoteLeg(leg: Leg, amountIn: bigint, ctx: LegQuoteContext): Promise<bigint | null> {
    if (leg.kind === 'AMM') {
        const q = quoteRoute({ id: 'leg', label: 'leg', dex: leg.dex, path: leg.path }, false, amountIn, ctx.reserves, ctx.slippagePct, ctx.pools);
        return q ? q.amountOut : null;
    }
    const state = ctx.curves?.[leg.token] ?? leg.market;
    if (leg.side === 'BUY') return curveBuyOut(state, amountIn, ctx.viewQuote);
    return state.venue === 'HARTII' ? hartiiSellOut(state, amountIn) : null;
}

/** Chain the legs of a route: the output after each, and the total. Null when any leg cannot be filled. */
export async function quoteLegs(legs: Leg[], amountIn: bigint, ctx: LegQuoteContext): Promise<{ amountOut: bigint; perLeg: bigint[] } | null> {
    let amount = amountIn;
    const perLeg: bigint[] = [];
    for (const leg of legs) {
        const out = await quoteLeg(leg, amount, ctx);
        if (out === null || out <= 0n) return null;
        perLeg.push(out);
        amount = out;
    }
    return { amountOut: amount, perLeg };
}

