// Turn every pool the factories report into what the router needs: registry keys for both tokens, the pool, and its reserves.
//
// The factories are permissionless: anyone can create a pair of any two contracts, so what comes out of them is an
// untrusted list. This module is where it is made safe to route over:
//   - a token joins the registry only under a key that cannot be mistaken for a listed one (see registerDiscoveredToken);
//   - a pair whose token decimals could not be read is dropped (an amount in the wrong units is off by 10^n);
//   - an empty pair, a pair of one token with itself, and a pair involving the zero address are dropped;
//   - the same pair address is counted once;
//   - the deepest tokens are registered first, so when two tokens share a symbol the real one keeps the plain name and the
//     imitation gets the suffixed one;
//   - the number of discovered tokens is capped, so a flood of junk pairs cannot grow the token list without bound.
//
// Pure apart from writing TOKEN_REGISTRY (which registerDiscoveredToken does): no network, no clock.

import type { LPReserves } from './index';
import type { PairSnapshot } from './pairs';
import type { PoolInfo } from './registries/pools';
import { TOKEN_REGISTRY, getTokenByAddress, registerDiscoveredToken, type TokenInfo } from './registries/tokens';

/** Discovered tokens kept, at most. Deepest first, so the cap only ever drops dust. */
export const MAX_DISCOVERED_TOKENS = 600;

const ZERO = '0x0000000000000000000000000000000000000000';

export interface Aggregate {
    /** Every usable pool, in factory order, with registry keys for its tokens (on-chain token0/token1 order). */
    pools: PoolInfo[];
    /** Live reserves for each pool in `pools`, keyed by lower-cased pair address. */
    reserves: Record<string, LPReserves>;
    /** Tokens found in pools and not curated, deepest first. These are registered in TOKEN_REGISTRY. */
    tokens: TokenInfo[];
    /** Whole WQUAI held against each discovered token's address (lower-case), the order the picker uses. */
    depthQuai: Record<string, number>;
    skipped: {
        /** A token's decimals() did not answer. */
        decimals: number;
        /** No reserves on one side or both. */
        empty: number;
        /** The same pair twice, or a pair of a token with itself, or the zero address. */
        invalid: number;
        /** A token beyond MAX_DISCOVERED_TOKENS. */
        overCap: number;
    };
}

const toWhole = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

export function buildAggregate(snapshots: PairSnapshot[], opts: { maxTokens?: number } = {}): Aggregate {
    const maxTokens = opts.maxTokens ?? MAX_DISCOVERED_TOKENS;
    const wquai = TOKEN_REGISTRY.WQUAI.address.toLowerCase();
    const skipped = { decimals: 0, empty: 0, invalid: 0, overCap: 0 };

    const seen = new Set<string>();
    const usable: PairSnapshot[] = [];
    for (const s of snapshots) {
        const key = s.pair.toLowerCase();
        const a0 = s.token0.address.toLowerCase();
        const a1 = s.token1.address.toLowerCase();
        if (seen.has(key) || a0 === a1 || a0 === ZERO || a1 === ZERO) {
            skipped.invalid++;
            continue;
        }
        seen.add(key);
        if (s.reserve0 <= 0n || s.reserve1 <= 0n) {
            skipped.empty++;
            continue;
        }
        // A token we already know carries its own decimals; an unknown one must have answered decimals().
        const unreadable = [s.token0, s.token1].some(t => !getTokenByAddress(t.address) && t.decimalsRead === false);
        if (unreadable) {
            skipped.decimals++;
            continue;
        }
        usable.push(s);
    }

    // How much WQUAI stands against each token: a rough but comparable depth, in whole WQUAI.
    const depth = new Map<string, number>();
    const bump = (address: string, quai: number) => depth.set(address, Math.max(depth.get(address) ?? 0, quai));
    for (const s of usable) {
        const a0 = s.token0.address.toLowerCase();
        const a1 = s.token1.address.toLowerCase();
        if (a1 === wquai) bump(a0, toWhole(s.reserve1, s.token1.decimals));
        if (a0 === wquai) bump(a1, toWhole(s.reserve0, s.token0.decimals));
    }

    // Register unknown tokens, deepest first (ties by address, so the outcome never depends on iteration order).
    const unknown = new Map<string, PairSnapshot['token0']>();
    for (const s of usable) {
        for (const t of [s.token0, s.token1]) {
            if (!getTokenByAddress(t.address)) unknown.set(t.address.toLowerCase(), t);
        }
    }
    const ordered = [...unknown.values()].sort((a, b) => {
        const da = depth.get(a.address.toLowerCase()) ?? 0;
        const db = depth.get(b.address.toLowerCase()) ?? 0;
        return db - da || a.address.toLowerCase().localeCompare(b.address.toLowerCase());
    });
    const dropped = new Set<string>();
    // The cap counts every discovered token already in the registry too, so repeated refreshes cannot grow it past the cap.
    const room = Math.max(0, maxTokens - Object.values(TOKEN_REGISTRY).filter(t => t.discovered).length);
    ordered.forEach((t, i) => {
        if (i >= room) {
            dropped.add(t.address.toLowerCase());
            return;
        }
        const info = registerDiscoveredToken({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals });
        if (!info) dropped.add(t.address.toLowerCase());
    });

    const pools: PoolInfo[] = [];
    const reserves: Record<string, LPReserves> = {};
    const used = new Map<string, TokenInfo>();
    for (const s of usable) {
        const t0 = getTokenByAddress(s.token0.address);
        const t1 = getTokenByAddress(s.token1.address);
        if (!t0 || !t1 || dropped.has(s.token0.address.toLowerCase()) || dropped.has(s.token1.address.toLowerCase())) {
            skipped.overCap++;
            continue;
        }
        const key = s.pair.toLowerCase();
        pools.push({ pair: s.pair, dex: s.dex, tokens: [t0.symbol, t1.symbol] });
        reserves[key] = { reserve0: s.reserve0.toString(), reserve1: s.reserve1.toString(), blockTime: 0, token0: s.token0.address, token1: s.token1.address };
        for (const t of [t0, t1]) if (t.discovered) used.set(t.address.toLowerCase(), t);
    }

    const tokens = [...used.values()].sort((a, b) => {
        const da = depth.get(a.address.toLowerCase()) ?? 0;
        const db = depth.get(b.address.toLowerCase()) ?? 0;
        return db - da || a.symbol.localeCompare(b.symbol);
    });
    const depthQuai: Record<string, number> = {};
    for (const t of tokens) depthQuai[t.address.toLowerCase()] = depth.get(t.address.toLowerCase()) ?? 0;

    return { pools, reserves, tokens, depthQuai, skipped };
}

/** Pools with a given pair address appearing once: the first list wins, so curated pools are never replaced by discovered ones. */
export function mergePools(...lists: PoolInfo[][]): PoolInfo[] {
    const seen = new Set<string>();
    const out: PoolInfo[] = [];
    for (const list of lists) {
        for (const p of list) {
            const key = p.pair.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(p);
        }
    }
    return out;
}
