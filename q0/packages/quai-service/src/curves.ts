// Bonding-curve venues: tokens that trade against a launch contract instead of an AMM pool. (Phase 2; types first.)

export type CurveVenue = 'HARTII' | 'POOP_V1' | 'POOP_V2' | 'QUAINANCE_CURVE';

/** A curve market the app can offer, identified by contracts it has verified on-chain. */
export interface CurveMarketRef {
    venue: CurveVenue;
    /** The token traded (lower-case address). */
    token: string;
    /** The contract that is called to buy and sell. */
    market: string;
}

/** One step of a route that trades against a launch curve with native QUAI. */
export interface CurveLeg {
    kind: 'CURVE';
    /** BUY: native QUAI in, the token out. SELL: the token in, native QUAI out. */
    side: 'BUY' | 'SELL';
    /** Registry key of the token. */
    token: string;
    market: CurveMarketRef;
}
