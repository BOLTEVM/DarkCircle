// Launch curves: tokens that trade against their launch contract instead of an AMM pool (Hartii, POOP, Quainance launches).
//
// A curve market is not a pool the router can reach: it is its own contract with its own buy and sell. This module
//   - pins what each venue is allowed to be (contract code, factory, implementation) and refuses anything else;
//   - quotes a Hartii market exactly, locally, from its reserves (the formulas were checked against the contract's own
//     views, to the wei, on every market they apply to, and are checked again for every market when it is loaded);
//   - quotes POOP and Quainance launch curves through their own view functions, and only for BUYING: the contract
//     semantics of selling back to them (a credit that must be claimed, fees on top) were not established read-only, and a
//     call that moves funds is never guessed;
//   - encodes the calls, so the app only ever sends what is built here, after a simulation.
//
// Verified 2026-10-12 against Cyprus-1 (read-only): Hartii v2 and v3 markets, bonding and graduated; POOP v1/v2 getAmountOut
// and buy; Quainance launch quoteBuy and a simulated buy (its return value equals quoteBuy's token amount).
//
// Nothing here signs or sends: it reads, quotes and encodes.

import { checksumAddress, keccak256Bytes, keccak256Hex } from './keccak';
import { createBatch, type BatchCall, type BatchFn } from './pairs';
import { EIP1967_IMPLEMENTATION_SLOT } from './eip1967';

export type CurveVenue = 'HARTII' | 'POOP_V1' | 'POOP_V2' | 'QUAINANCE_CURVE';

/** Plain-language names, for the people using the swap screen. */
export const CURVE_VENUE_LABEL: Record<CurveVenue, string> = {
    HARTII: 'Hartii launch',
    POOP_V1: 'POOP launch',
    POOP_V2: 'POOP launch',
    QUAINANCE_CURVE: 'Quainance launch'
};

// --------------------------------------------------------------------------------------------------------- pins

/** The factory every Hartii market reports from factory(). */
export const HARTII_FACTORY = '0x001af1bbb40807fcb99c9eeaa49df5e91e7efd42';

/**
 * Hartii markets are EIP-1167 clones; the implementation each one points at must be one of these, with this runtime code
 * (checked 2026-10-12: 7,211 / 15,857 / 18,346 bytes, serving 83 / 10 / 4 of the catalog's markets).
 */
export const HARTII_IMPLEMENTATIONS: Record<string, string> = {
    '0x0062d75a096e67fef48a8c5a9fd9094d2bea9d14': '0x60231d399aa6709360fc6c3b281b6be05b600f7ed04d50bdb69b6c9377a60073',
    '0x002aa390a149259c01ad87cf44fa18bbfd3bdb7a': '0x8e3676af50c83437d1ffe0e071b1fc0d5c7050235ba78c69978225241103f91c',
    '0x0049ba9169f36a18b4a190ae057ad69ef8edf75e': '0xf5afa4f50d05ab0c9302631240e3e17ca1dad11edf709ed79a4ae55096cadb14'
};

/**
 * POOP launchers: one contract for every token of the version. V1 is a plain contract; V2 is an upgradeable proxy, so its
 * implementation is pinned too and a changed implementation switches the venue off.
 */
export const POOP_LAUNCHERS: Record<'POOP_V1' | 'POOP_V2', { address: string; codeHash: string; implementation?: { address: string; codeHash: string } }> = {
    POOP_V1: {
        address: '0x0005a0b0dc1ff95154cd37e2c35b6695422f9f45',
        codeHash: '0xa03110fa11ea1a37df0eb94b8c51dee2173c3c78e7659de4cc2bee112176c8a2'
    },
    POOP_V2: {
        address: '0x005e42edb4ba56a393c90f27f72429ef34ef8c39',
        codeHash: '0x206687a4ccb0516030d2e6ef9cf2cf6f3afbf40b948e34f3e8fa652d972d8ff3',
        implementation: {
            address: '0x000b751441bf0f68b79fcd8e5792e3a85c57dd00',
            codeHash: '0x28ce855423833ec067593cd1ef65e54bdb76fc5d3c8ec4b876f3ab681f4c49d9'
        }
    }
};

/**
 * Each Quainance launch is its own contract, so every one has different bytes: the token, the creator and a few constants
 * are baked in. Zeroing the byte ranges that differ between launches leaves the same source for all of them; a market is
 * accepted only if, with these ranges zeroed, it hashes to one of these. (Two compiler variants exist: 9,035 and 9,242 bytes,
 * 20 and 29 launches, every one of them hashing identically within its variant.)
 */
export const QUAINANCE_CURVE_TEMPLATES: { size: number; ranges: [number, number][]; hash: string }[] = [
    {
        size: 9035,
        ranges: [[534, 19], [1317, 8], [1401, 8], [1611, 19], [2581, 19], [3326, 8], [3442, 8], [3493, 8], [4749, 19], [5073, 8], [5169, 19], [5408, 19], [5613, 19], [5770, 19], [5993, 19], [6198, 19], [6747, 8], [6823, 8], [6960, 8], [7209, 8], [7256, 8], [7337, 8], [8043, 19]],
        hash: '0xaca7ed1527166445c7fe4c97678fc2542ed66a330a724a3e95ccc31e39680f32'
    },
    {
        size: 9242,
        ranges: [[561, 19], [1344, 8], [1480, 8], [1690, 19], [2660, 19], [3407, 8], [3523, 8], [3574, 8], [4832, 19], [5156, 8], [5252, 19], [5491, 19], [5696, 19], [5853, 19], [6076, 19], [6281, 19], [6830, 8], [6906, 8], [7043, 8], [7292, 8], [7339, 8], [7420, 8], [8127, 19], [8213, 19]],
        hash: '0xcf8bd9ab24d38c765123c2b3fed78eff9fd91557259806b5e6bc0dfb7d08f46a'
    }
];

/** Gas estimates for ranking only (a Hartii buy used 97,383 gas, a Quainance launch buy simulated at 153-160k). */
export const GAS_CURVE_BUY = 200_000n;
export const GAS_CURVE_SELL = 200_000n;

// ---------------------------------------------------------------------------------------------------- selectors

const sel = (signature: string): string => keccak256Bytes(new TextEncoder().encode(signature)).slice(0, 10);
const SEL = {
    token: sel('token()'),
    factory: sel('factory()'),
    feeBps: sel('feeBps()'),
    graduated: sel('graduated()'),
    tokensRemaining: sel('tokensRemaining()'),
    tokensSold: sel('tokensSold()'),
    virtualQuaiReserve: sel('virtualQuaiReserve()'),
    virtualTokenReserve: sel('virtualTokenReserve()'),
    realQuaiReserve: sel('realQuaiReserve()'),
    poolQuaiReserve: sel('poolQuaiReserve()'),
    poolTokenReserve: sel('poolTokenReserve()'),
    creatorPayout: sel('creatorPayout()'),
    quoteBuy: sel('quoteBuy(uint256)'),
    quoteSell: sel('quoteSell(uint256)'),
    hartiiBuyV2: sel('buy(uint256)'),
    hartiiBuyV3: sel('buy(uint256,uint256)'),
    hartiiSellV2: sel('sell(uint256,uint256)'),
    hartiiSellV3: sel('sell(uint256,uint256,uint256)'),
    poopPrice: sel('price(address)'),
    poopAmountOutToken: sel('getAmountOutToken(uint256,address)'),
    poopBuy: sel('buy(address,uint256,uint256)'),
    quainanceBuy: sel('buy(uint256,uint256)')
};
export const CURVE_SELECTORS = SEL;

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.replace('0x', '').toLowerCase().padStart(64, '0');
const isWord = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const asBig = (v: unknown): bigint | undefined => (isWord(v) ? BigInt(v) : undefined);

// ------------------------------------------------------------------------------------------------------- state

/** A Hartii market as read from the chain: enough to quote buys and sells exactly without another call. */
export interface HartiiState {
    venue: 'HARTII';
    /** Lower-case token address. */
    token: string;
    /** The market contract that is called. */
    market: string;
    /** Buy and sell take a deadline. */
    isV3: boolean;
    graduated: boolean;
    feeBps: bigint;
    /** Bonding phase: the curve is (virtualQuai + realQuai) x (virtualToken - tokensSold). */
    virtualQuai: bigint;
    virtualToken: bigint;
    realQuai: bigint;
    tokensSold: bigint;
    tokensRemaining: bigint;
    /** Graduated: an internal constant-product pool. */
    poolQuai: bigint;
    poolToken: bigint;
    /** The local sell quote equalled the contract's own at load (buys were already required to). */
    canSell: boolean;
}

/** POOP and Quainance launches: bought through the contract's own quote, sold back is not offered. */
export interface ViewState {
    venue: 'POOP_V1' | 'POOP_V2' | 'QUAINANCE_CURVE';
    token: string;
    /** POOP: the launcher (takes the token as an argument). Quainance launch: the token's own market. */
    market: string;
}

export type CurveMarketState = HartiiState | ViewState;

/** One step of a route that trades against a launch curve with native QUAI. */
export interface CurveLeg {
    kind: 'CURVE';
    /** BUY: native QUAI in, the token out. SELL: the token in, native QUAI out. */
    side: 'BUY' | 'SELL';
    /** Registry key of the token. */
    token: string;
    market: CurveMarketState;
}

/** Kept for callers written against the type-only first version. */
export type CurveMarketRef = CurveMarketState;

export const curveVenueLabel = (state: CurveMarketState): string => CURVE_VENUE_LABEL[state.venue];

/** Selling back to the curve is possible only on a Hartii market whose sell quote was verified. */
export const curveCanSell = (state: CurveMarketState): boolean => state.venue === 'HARTII' && state.canSell;

// ------------------------------------------------------------------------------------------------------- maths

const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);

/** Tokens a Hartii market pays for `net` QUAI after the fee is taken: the contract's quoteBuy(net). Null when it cannot. */
export function hartiiBuyRaw(s: HartiiState, net: bigint): bigint | null {
    if (net <= 0n) return null;
    if (s.graduated) {
        if (s.poolQuai <= 0n || s.poolToken <= 0n) return null;
        const product = s.poolQuai * s.poolToken;
        const out = s.poolToken - (s.isV3 ? ceilDiv(product, s.poolQuai + net) : product / (s.poolQuai + net));
        return out > 0n ? out : null;
    }
    const t = s.virtualQuai + s.realQuai;
    const d = s.virtualToken - s.tokensSold;
    if (t <= 0n || d <= 0n) return null;
    const out = d - (t * d) / (t + net);
    return out > 0n ? out : null;
}

/** QUAI a Hartii market pays for `tokensIn` before the fee: the contract's quoteSell(tokensIn). */
export function hartiiSellRaw(s: HartiiState, tokensIn: bigint): bigint | null {
    if (tokensIn <= 0n) return null;
    if (s.graduated) {
        if (s.poolQuai <= 0n || s.poolToken <= 0n) return null;
        const product = s.poolQuai * s.poolToken;
        const out = s.poolQuai - (s.isV3 ? ceilDiv(product, s.poolToken + tokensIn) : product / (s.poolToken + tokensIn));
        return out > 0n ? out : null;
    }
    // Before graduation only what was sold can be sold back.
    if (tokensIn > s.tokensSold) return null;
    const t = s.virtualQuai + s.realQuai;
    const d = s.virtualToken - s.tokensSold;
    if (t <= 0n || d <= 0n) return null;
    const out = t - (t * d) / (d + tokensIn);
    return out > 0n ? out : null;
}

/**
 * Tokens received for `quaiIn` of native QUAI (fee on the input, as the contract charges it). Null when the amount cannot be
 * filled, including a buy that would finish the launch (the curve cannot pay out more than it has left).
 */
export function hartiiBuyOut(s: HartiiState, quaiIn: bigint): bigint | null {
    if (quaiIn <= 0n || s.feeBps >= 10000n) return null;
    const net = quaiIn - (quaiIn * s.feeBps) / 10000n;
    const out = hartiiBuyRaw(s, net);
    if (out === null) return null;
    if (!s.graduated && out > s.tokensRemaining) return null;
    return out;
}

/** Native QUAI received for `tokensIn` (fee on the output, as the contract charges it). */
export function hartiiSellOut(s: HartiiState, tokensIn: bigint): bigint | null {
    if (s.feeBps >= 10000n) return null;
    const raw = hartiiSellRaw(s, tokensIn);
    if (raw === null) return null;
    const out = raw - (raw * s.feeBps) / 10000n;
    return out > 0n ? out : null;
}

/** Zero-size price (tokens per QUAI, raw units, fee not included), for measuring how far a fill is from it. */
export function hartiiSpotBuy(s: HartiiState): number {
    const [quai, token] = s.graduated ? [s.poolQuai, s.poolToken] : [s.virtualQuai + s.realQuai, s.virtualToken - s.tokensSold];
    return quai > 0n && token > 0n ? Number(token) / Number(quai) : 0;
}
export function hartiiSpotSell(s: HartiiState): number {
    const spot = hartiiSpotBuy(s);
    return spot > 0 ? 1 / spot : 0;
}

/** A minimum to ask the contract for: the quote less the slippage, and a wei of slack for rounding either way. */
export function minOutFor(quote: bigint, slippagePct: number): bigint {
    const bps = BigInt(Math.max(0, Math.min(5000, Math.round(slippagePct * 100))));
    const v = (quote * (10000n - bps)) / 10000n - 1n;
    return v > 0n ? v : 0n;
}

// ---------------------------------------------------------------------------------------------------- encoders

/** The contract a buy or sell is sent to. */
export const curveTarget = (state: CurveMarketState): string => state.market;

export function encodeCurveBuy(state: CurveMarketState, minTokensOut: bigint, deadline: bigint): string {
    switch (state.venue) {
        case 'HARTII':
            return state.isV3 ? SEL.hartiiBuyV3 + word(minTokensOut) + word(deadline) : SEL.hartiiBuyV2 + word(minTokensOut);
        case 'POOP_V1':
        case 'POOP_V2':
            return SEL.poopBuy + addrWord(state.token) + word(minTokensOut) + word(deadline);
        case 'QUAINANCE_CURVE':
            return SEL.quainanceBuy + word(minTokensOut) + word(deadline);
    }
}

/** Only Hartii markets can be sold back to through this app; anything else throws rather than guess a call. */
export function encodeCurveSell(state: CurveMarketState, tokensIn: bigint, minQuaiOut: bigint, deadline: bigint): string {
    if (state.venue !== 'HARTII') throw new Error('Selling back to this launch curve is not supported.');
    return state.isV3 ? SEL.hartiiSellV3 + word(tokensIn) + word(minQuaiOut) + word(deadline) : SEL.hartiiSellV2 + word(tokensIn) + word(minQuaiOut);
}

// ------------------------------------------------------------------------------------------------------ loading

/** What the catalog says about one launch (untrusted: every field is re-checked against the chain). */
export interface CurveEntry {
    venue: CurveVenue;
    /** Lower-case token address. */
    token: string;
    /** HARTII / QUAINANCE_CURVE: the token's market. POOP: the launcher. */
    market: string;
    decimals: number;
}

export type CurveLoad = { ok: true; state: CurveMarketState } | { ok: false; reason: string };

const EIP1167_PREFIX = '0x363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

/** The implementation an EIP-1167 minimal proxy delegates to, or null if the code is not exactly a minimal proxy. */
export function cloneImplementation(code: string): string | null {
    if (typeof code !== 'string') return null;
    const c = code.toLowerCase();
    if (c.length !== 2 + 45 * 2 || !c.startsWith(EIP1167_PREFIX) || !c.endsWith(EIP1167_SUFFIX)) return null;
    return '0x' + c.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40);
}

/** keccak256 of a launch's code with the ranges that differ between launches zeroed, or null if its size is unknown. */
export function quainanceTemplateHash(code: string): string | null {
    const hex = typeof code === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(code) ? code.slice(2).toLowerCase() : null;
    if (hex === null) return null;
    const template = QUAINANCE_CURVE_TEMPLATES.find(t => t.size * 2 === hex.length);
    if (!template) return null;
    let out = hex;
    for (const [start, length] of template.ranges) out = out.slice(0, start * 2) + '00'.repeat(length) + out.slice((start + length) * 2);
    return keccak256Hex('0x' + out) === template.hash ? template.hash : null;
}

// Code that is pinned by address and never changes within a session is checked once.
const verifiedCode = new Map<string, boolean>();

const callAt = (to: string, data: string, block: string): BatchCall => ({ method: 'quai_call', params: [{ to, data }, block] });
const codeAt = (address: string): BatchCall => ({ method: 'quai_getCode', params: [checksumAddress(address), 'latest'] });

/** Reads the code hash of each address (cached once verified against its pin). Returns, per address, whether it matched. */
async function checkPinnedCode(pins: { address: string; codeHash: string }[], batch: BatchFn, fresh: boolean): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const todo = pins.filter(p => {
        const cached = fresh ? undefined : verifiedCode.get(p.address.toLowerCase());
        if (cached !== undefined) out.set(p.address.toLowerCase(), cached);
        return cached === undefined;
    });
    if (!todo.length) return out;
    const res = await batch(todo.map(p => codeAt(p.address)));
    todo.forEach((p, i) => {
        const r = res[i];
        let ok = false;
        if (r.ok && typeof r.value === 'string' && r.value !== '0x') {
            try {
                ok = keccak256Hex(r.value).toLowerCase() === p.codeHash.toLowerCase();
            } catch {
                ok = false;
            }
        }
        // A failed read is not cached: it is "unknown", reported as not matching for now.
        if (r.ok) verifiedCode.set(p.address.toLowerCase(), ok);
        out.set(p.address.toLowerCase(), ok);
    });
    return out;
}

const PROBE_QUAI_IN = 10n ** 16n;

/**
 * Load and verify curve markets. Every entry gets an answer: a state it is safe to quote and call, or a plain reason it is
 * not offered. Nothing is ever thrown for a bad market. All reads are pinned to one block, so a trade landing between the
 * reserve reads and the probe quotes cannot make a good market look wrong.
 */
export async function loadCurveStates(entries: CurveEntry[], opts: { batch?: BatchFn; fresh?: boolean } = {}): Promise<Record<string, CurveLoad>> {
    const batch = opts.batch ?? createBatch();
    const fresh = opts.fresh === true;
    const result: Record<string, CurveLoad> = {};
    const refuse = (e: CurveEntry, reason: string) => {
        result[e.token.toLowerCase()] = { ok: false, reason };
    };
    if (!entries.length) return result;

    let block = 'latest';
    try {
        const head = (await batch([{ method: 'quai_blockNumber', params: [] }]))[0];
        if (head.ok && typeof head.value === 'string' && /^0x[0-9a-fA-F]+$/.test(head.value)) block = head.value;
    } catch {
        block = 'latest';
    }

    // ---- code identity ----
    const hartii = entries.filter(e => e.venue === 'HARTII');
    const poop = entries.filter(e => e.venue === 'POOP_V1' || e.venue === 'POOP_V2');
    const quainance = entries.filter(e => e.venue === 'QUAINANCE_CURVE');

    const marketCodes = new Map<string, string | null>();
    {
        const wanted = [...new Set([...hartii, ...quainance].map(e => e.market.toLowerCase()))];
        const res = await batch(wanted.map(codeAt));
        wanted.forEach((m, i) => marketCodes.set(m, res[i].ok && typeof res[i].value === 'string' ? (res[i].value as string) : null));
    }

    const hartiiImpl = new Map<string, string | null>();
    for (const e of hartii) {
        const code = marketCodes.get(e.market.toLowerCase());
        hartiiImpl.set(e.market.toLowerCase(), code ? cloneImplementation(code) : null);
    }
    const implPins = [...new Set([...hartiiImpl.values()].filter((v): v is string => Boolean(v)))]
        .filter(a => HARTII_IMPLEMENTATIONS[a])
        .map(a => ({ address: a, codeHash: HARTII_IMPLEMENTATIONS[a] }));
    const poopVersions = [...new Set(poop.map(e => e.venue as 'POOP_V1' | 'POOP_V2'))];
    const launcherPins = poopVersions.flatMap(v => [
        { address: POOP_LAUNCHERS[v].address, codeHash: POOP_LAUNCHERS[v].codeHash },
        ...(POOP_LAUNCHERS[v].implementation ? [POOP_LAUNCHERS[v].implementation!] : [])
    ]);
    const pinned = await checkPinnedCode([...implPins, ...launcherPins], batch, fresh);

    // A proxied launcher must still point at its pinned implementation.
    const proxyOk = new Map<string, boolean>();
    for (const v of poopVersions) {
        const impl = POOP_LAUNCHERS[v].implementation;
        if (!impl) {
            proxyOk.set(v, true);
            continue;
        }
        const r = (await batch([{ method: 'quai_getStorageAt', params: [checksumAddress(POOP_LAUNCHERS[v].address), EIP1967_IMPLEMENTATION_SLOT, 'latest'] }]))[0];
        proxyOk.set(v, r.ok && typeof r.value === 'string' && r.value.toLowerCase().endsWith(impl.address.slice(2).toLowerCase()));
    }

    // ---- Hartii: state reads ----
    const hartiiGood: CurveEntry[] = [];
    for (const e of hartii) {
        const impl = hartiiImpl.get(e.market.toLowerCase());
        if (!marketCodes.get(e.market.toLowerCase())) refuse(e, 'The launch contract could not be read.');
        else if (!impl) refuse(e, 'This market is not a standard Hartii launch contract.');
        else if (!HARTII_IMPLEMENTATIONS[impl]) refuse(e, 'This market uses a Hartii contract version this app has not checked.');
        else if (!pinned.get(impl)) refuse(e, 'The Hartii contract behind this market is not the version this app checked.');
        else hartiiGood.push(e);
    }
    const FIELDS = ['token', 'factory', 'feeBps', 'graduated', 'tokensRemaining', 'tokensSold', 'virtualQuaiReserve', 'virtualTokenReserve', 'realQuaiReserve', 'poolQuaiReserve', 'poolTokenReserve', 'creatorPayout'] as const;
    if (hartiiGood.length) {
        const res = await batch(hartiiGood.flatMap(e => FIELDS.map(f => callAt(e.market, SEL[f], block))));
        const drafts: { e: CurveEntry; s: HartiiState }[] = [];
        hartiiGood.forEach((e, i) => {
            const r = FIELDS.map((_, k) => res[i * FIELDS.length + k]);
            const v = (k: (typeof FIELDS)[number]) => {
                const x = r[FIELDS.indexOf(k)];
                return x.ok ? asBig(x.value) : undefined;
            };
            const tokenWord = v('token');
            const factoryWord = v('factory');
            if (tokenWord === undefined || '0x' + tokenWord.toString(16).padStart(40, '0') !== e.token.toLowerCase()) return refuse(e, 'This market does not belong to this token.');
            if (factoryWord === undefined || '0x' + factoryWord.toString(16).padStart(40, '0') !== HARTII_FACTORY) return refuse(e, 'This market was not made by the Hartii launcher.');
            const feeBps = v('feeBps');
            const graduated = v('graduated');
            if (feeBps === undefined || feeBps > 1000n || graduated === undefined) return refuse(e, 'The fee or phase of this launch could not be read.');
            const isV3 = r[FIELDS.indexOf('creatorPayout')].ok;
            const s: HartiiState = {
                venue: 'HARTII',
                token: e.token.toLowerCase(),
                market: e.market.toLowerCase(),
                isV3,
                graduated: graduated === 1n,
                feeBps,
                virtualQuai: v('virtualQuaiReserve') ?? 0n,
                virtualToken: v('virtualTokenReserve') ?? 0n,
                realQuai: v('realQuaiReserve') ?? 0n,
                tokensSold: v('tokensSold') ?? 0n,
                tokensRemaining: v('tokensRemaining') ?? 0n,
                poolQuai: v('poolQuaiReserve') ?? 0n,
                poolToken: v('poolTokenReserve') ?? 0n,
                canSell: false
            };
            if (s.graduated ? s.poolQuai <= 0n || s.poolToken <= 0n : s.virtualQuai <= 0n || s.virtualToken <= 0n) {
                return refuse(e, 'The reserves of this launch could not be read.');
            }
            drafts.push({ e, s });
        });

        // ---- probes: the local maths must equal the contract's own quote before this market is offered ----
        if (drafts.length) {
            const probes: BatchCall[] = [];
            const plan = drafts.map(({ e, s }) => {
                const net = PROBE_QUAI_IN - (PROBE_QUAI_IN * s.feeBps) / 10000n;
                const sellIn = s.graduated ? s.poolToken / 1000n : s.tokensSold / 100n;
                const buyAt = probes.length;
                probes.push(callAt(e.market, SEL.quoteBuy + word(net), block));
                const sellAt = sellIn > 0n ? probes.length : -1;
                if (sellIn > 0n) probes.push(callAt(e.market, SEL.quoteSell + word(sellIn), block));
                return { e, s, net, sellIn, buyAt, sellAt };
            });
            const pr = await batch(probes);
            for (const p of plan) {
                const buyReply = pr[p.buyAt];
                const viewBuy = buyReply.ok ? asBig(buyReply.value) : undefined;
                const localBuy = hartiiBuyRaw(p.s, p.net);
                if (viewBuy === undefined || localBuy === null || viewBuy !== localBuy) {
                    refuse(p.e, 'Its price formula is not one this app has verified, so it is not offered.');
                    continue;
                }
                let canSell = false;
                if (p.sellAt >= 0) {
                    const sellReply = pr[p.sellAt];
                    const viewSell = sellReply.ok ? asBig(sellReply.value) : undefined;
                    const localSell = hartiiSellRaw(p.s, p.sellIn);
                    canSell = viewSell !== undefined && localSell !== null && viewSell === localSell;
                } else {
                    // Nothing has been sold on this curve yet, so there is nothing to sell back and nothing to compare.
                    canSell = !p.s.graduated;
                }
                result[p.e.token.toLowerCase()] = { ok: true, state: { ...p.s, canSell } };
            }
        }
    }

    // ---- POOP ----
    for (const e of poop) {
        const version = e.venue as 'POOP_V1' | 'POOP_V2';
        const launcher = POOP_LAUNCHERS[version];
        if (e.market.toLowerCase() !== launcher.address) {
            refuse(e, 'This launch is not on the POOP contract this app has checked.');
        } else if (!pinned.get(launcher.address) || (launcher.implementation && !pinned.get(launcher.implementation.address))) {
            refuse(e, 'The POOP contract is not the version this app checked.');
        } else if (!proxyOk.get(version)) {
            refuse(e, 'The POOP contract has been upgraded since this app checked it.');
        } else {
            result[e.token.toLowerCase()] = { ok: true, state: { venue: version, token: e.token.toLowerCase(), market: launcher.address } };
        }
    }
    const poopLive = poop.filter(e => result[e.token.toLowerCase()]?.ok);
    if (poopLive.length) {
        const res = await batch(poopLive.map(e => callAt(e.market, SEL.poopAmountOutToken + word(PROBE_QUAI_IN) + addrWord(e.token), block)));
        poopLive.forEach((e, i) => {
            const out = res[i].ok ? asBig(res[i].value) : undefined;
            if (out === undefined || out <= 0n) refuse(e, 'The POOP contract does not quote this token (it may have finished its launch).');
        });
    }

    // ---- Quainance launches ----
    const qnGood: CurveEntry[] = [];
    for (const e of quainance) {
        const code = marketCodes.get(e.market.toLowerCase());
        if (!code) refuse(e, 'The launch contract could not be read.');
        else if (!quainanceTemplateHash(code)) refuse(e, 'This launch contract is not one this app has checked.');
        else qnGood.push(e);
    }
    if (qnGood.length) {
        const res = await batch(qnGood.flatMap(e => [callAt(e.market, SEL.token, block), callAt(e.market, SEL.graduated, block), callAt(e.market, SEL.quoteBuy + word(PROBE_QUAI_IN), block)]));
        qnGood.forEach((e, i) => {
            const [t, g, q] = res.slice(i * 3, i * 3 + 3);
            const tokenWord = t.ok ? asBig(t.value) : undefined;
            if (tokenWord === undefined || '0x' + tokenWord.toString(16).padStart(40, '0') !== e.token.toLowerCase()) return refuse(e, 'This launch does not belong to this token.');
            if (!g.ok || asBig(g.value) !== 0n) return refuse(e, 'This launch has finished: the token trades in a pool now.');
            const words = q.ok && typeof q.value === 'string' ? parseWords(q.value) : null;
            if (!words || words.length < 6 || words[3] <= 0n || words[4] !== 0n || words[5] !== 0n) return refuse(e, 'This launch could not be quoted.');
            result[e.token.toLowerCase()] = { ok: true, state: { venue: 'QUAINANCE_CURVE', token: e.token.toLowerCase(), market: e.market.toLowerCase() } };
        });
    }

    return result;
}

function parseWords(hex: string): bigint[] | null {
    if (!/^0x([0-9a-fA-F]{64})+$/.test(hex)) return null;
    const out: bigint[] = [];
    for (let i = 2; i < hex.length; i += 64) out.push(BigInt('0x' + hex.slice(i, i + 64)));
    return out;
}

/**
 * Tokens a POOP or Quainance launch pays for `quaiIn`, from the contract's own quote. Null when it would not fill the whole
 * amount (a Quainance launch credits the part it cannot use instead of returning it, so any excess refuses the quote).
 */
export async function viewBuyQuote(state: ViewState, quaiIn: bigint, batch: BatchFn = createBatch()): Promise<bigint | null> {
    if (quaiIn <= 0n) return null;
    const data =
        state.venue === 'QUAINANCE_CURVE'
            ? SEL.quoteBuy + word(quaiIn)
            : SEL.poopAmountOutToken + word(quaiIn) + addrWord(state.token);
    let r: Awaited<ReturnType<BatchFn>>[number];
    try {
        r = (await batch([{ method: 'quai_call', params: [{ to: state.market, data }, 'latest'] }]))[0];
    } catch {
        return null;
    }
    if (!r.ok || typeof r.value !== 'string') return null;
    if (state.venue === 'QUAINANCE_CURVE') {
        const words = parseWords(r.value);
        if (!words || words.length < 6) return null;
        return words[3] > 0n && words[4] === 0n && words[5] === 0n ? words[3] : null;
    }
    const out = asBig(r.value);
    return out !== undefined && out > 0n ? out : null;
}
