// Aggregation: every pool on every factory becomes a route edge, tokens found in pools are registered safely, and the
// best route is picked by exact maths. All offline, on fixtures.

import { describe, test, expect, afterEach } from 'bun:test';
import { keccak256, getAddress } from '../packages/quai-service/node_modules/quais';
import {
    AMM_DEX_IDS,
    DEXES,
    MAX_CANDIDATES,
    MAX_DISCOVERED_TOKENS,
    TOKEN_REGISTRY,
    buildAggregate,
    canQuote,
    canSign,
    checksumAddress,
    cleanTokenSymbol,
    createBatch,
    findBestRoute,
    getTokenByAddress,
    isConnected,
    keccak256Bytes,
    keccak256Hex,
    listRoutes,
    loadPairSnapshots,
    mergePools,
    registerDiscoveredToken,
    requoteCandidate,
    simulateSwap,
    tokenAddress,
    tradablePools,
    verifyDexCode,
    type BatchFn,
    type LPReserves,
    type PairSnapshot,
    type PairToken,
    type PoolInfo
} from '../packages/quai-service/src/index';

const E18 = 10n ** 18n;
const addr = (n: number) => '0x00' + n.toString(16).padStart(38, '0');

/** Remove every token a test registered, so tests do not see each other's registry entries. */
function resetDiscovered() {
    for (const [key, t] of Object.entries(TOKEN_REGISTRY)) if (t.discovered) delete TOKEN_REGISTRY[key];
}
afterEach(resetDiscovered);

// ------------------------------------------------------------------------------------------------------- keccak

describe('keccak256 without dependencies', () => {
    test('known vectors', () => {
        expect(keccak256Bytes(new Uint8Array())).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
        expect(keccak256Bytes(new TextEncoder().encode('abc'))).toBe('0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    });

    test('agrees with quais on every length around the 136-byte block boundary and on random content', () => {
        let seed = 12345;
        const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
        for (const length of [...Array(300).keys(), 1000, 4097]) {
            const bytes = Uint8Array.from({ length }, next);
            const hex = '0x' + Buffer.from(bytes).toString('hex');
            expect(keccak256Bytes(bytes)).toBe(keccak256(hex));
            expect(keccak256Hex(hex)).toBe(keccak256(hex));
        }
    });

    test('rejects text that is not whole-byte hex', () => {
        expect(() => keccak256Hex('0x123')).toThrow();
        expect(() => keccak256Hex('hello')).toThrow();
    });

    test('checksum addresses are the ones quais computes', () => {
        for (const d of Object.values(DEXES)) {
            for (const a of [d.factory, d.router]) if (a) expect(checksumAddress(a.toLowerCase())).toBe(getAddress(a));
        }
        expect(() => checksumAddress('0x1234')).toThrow();
    });
});

// ------------------------------------------------------------------------------------- registering discovered tokens

describe('registerDiscoveredToken', () => {
    test('a new token gets its own symbol and is marked discovered', () => {
        const t = registerDiscoveredToken({ address: addr(0xa1), symbol: 'MOON', name: 'Moon Token', decimals: 9 })!;
        expect(t).toMatchObject({ symbol: 'MOON', name: 'Moon Token', decimals: 9, discovered: true, address: addr(0xa1) });
        expect(TOKEN_REGISTRY.MOON).toBe(t);
    });

    test('a symbol taken by a different address gets a suffix, and the curated token is untouched', () => {
        const curated = TOKEN_REGISTRY.Q0;
        const imitation = registerDiscoveredToken({ address: addr(0xb2), symbol: 'Q0', decimals: 18 })!;
        expect(imitation.symbol).toBe('Q0#00b2');
        expect(TOKEN_REGISTRY.Q0).toBe(curated);
        expect(TOKEN_REGISTRY.Q0.address).toBe('0x00325150094E51107a931980Fdfc3bB1a4C48379');
        // case does not help an imitation either
        const lower = registerDiscoveredToken({ address: addr(0xb3), symbol: 'q0', decimals: 18 })!;
        expect(lower.symbol).toBe('q0#00b3');
    });

    test('QUAI (the native key) is never available to a contract token, in any case', () => {
        for (const [i, s] of ['QUAI', 'quai', 'Quai'].entries()) {
            const t = registerDiscoveredToken({ address: addr(0xc0 + i), symbol: s, decimals: 18 })!;
            expect(t.symbol.toUpperCase().startsWith('QUAI#')).toBe(true);
        }
        expect(TOKEN_REGISTRY.QUAI.isNative).toBe(true);
    });

    test('the same address returns the existing entry, curated or discovered, and renames nothing', () => {
        expect(registerDiscoveredToken({ address: TOKEN_REGISTRY.CHEEZ.address, symbol: 'EVIL', decimals: 6 })).toBe(TOKEN_REGISTRY.CHEEZ);
        expect(TOKEN_REGISTRY.CHEEZ.decimals).toBe(18);
        const first = registerDiscoveredToken({ address: addr(0xd1), symbol: 'ONCE', decimals: 18 })!;
        const again = registerDiscoveredToken({ address: addr(0xd1).toUpperCase().replace('0X', '0x'), symbol: 'TWICE', decimals: 18 });
        expect(again).toBe(first);
        expect(again!.symbol).toBe('ONCE');
    });

    test('bad decimals or a bad address are refused', () => {
        expect(registerDiscoveredToken({ address: addr(0xe1), symbol: 'X', decimals: NaN })).toBeNull();
        expect(registerDiscoveredToken({ address: addr(0xe2), symbol: 'X', decimals: -1 })).toBeNull();
        expect(registerDiscoveredToken({ address: addr(0xe3), symbol: 'X', decimals: 77 })).toBeNull();
        expect(registerDiscoveredToken({ address: addr(0xe4), symbol: 'X', decimals: 1.5 })).toBeNull();
        expect(registerDiscoveredToken({ address: '0x1234', symbol: 'X', decimals: 18 })).toBeNull();
        expect(registerDiscoveredToken({ address: 'nope', symbol: 'X', decimals: 18 })).toBeNull();
    });

    test('symbols and names from a contract are made printable and short', () => {
        expect(cleanTokenSymbol('<script>alert(1)</script>')).not.toMatch(/[<>]/);
        expect(cleanTokenSymbol('A'.repeat(100)).length).toBe(12);
        expect(cleanTokenSymbol('\u0000\u0007EVIL\n')).toBe('EVIL');
        const t = registerDiscoveredToken({ address: addr(0xf1), symbol: '‮ABC', name: '<img src=x onerror=1>'.repeat(10), decimals: 18 })!;
        expect(t.symbol).toMatch(/^[\x20-\x7e]+$/);
        expect(t.name.length).toBeLessThanOrEqual(48);
        expect(t.name).not.toMatch(/[<>]/);
    });

    test('an empty symbol still gets a unique, readable key', () => {
        const t = registerDiscoveredToken({ address: addr(0xf2), symbol: '', decimals: 18 })!;
        expect(t.symbol).toBe('TOKEN00F2');
    });
});

// -------------------------------------------------------------------------------------------------- the aggregate

const ptok = (address: string, symbol: string, decimals = 18, decimalsRead = true): PairToken => ({
    address,
    symbol,
    name: symbol,
    decimals,
    registered: Boolean(getTokenByAddress(address) && !getTokenByAddress(address)!.discovered),
    decimalsRead
});
const T = {
    WQUAI: ptok(TOKEN_REGISTRY.WQUAI.address, 'WQUAI'),
    Q0: ptok(TOKEN_REGISTRY.Q0.address, 'Q0'),
    CHEEZ: ptok(TOKEN_REGISTRY.CHEEZ.address, 'CHEEZ'),
    LAPTOP: ptok(TOKEN_REGISTRY.LAPTOP.address, 'LAPTOP'),
    QGIRL: ptok(TOKEN_REGISTRY.QGIRL.address, 'QGIRL')
};

let pairCounter = 0x1000;
function snap(dex: PairSnapshot['dex'], a: PairToken, b: PairToken, ra: bigint, rb: bigint, extra: Partial<PairSnapshot> = {}): PairSnapshot {
    pairCounter++;
    return { dex, pair: addr(pairCounter), index: pairCounter, token0: a, token1: b, reserve0: ra, reserve1: rb, totalSupply: E18, burned: 0n, ...extra };
}

describe('buildAggregate', () => {
    test('every pair on every factory becomes a pool with its reserves', () => {
        const pairs = [
            snap('QUAISWAP', T.Q0, T.WQUAI, 1000n * E18, 10n * E18),
            snap('QUAINANCE', T.LAPTOP, T.WQUAI, 500n * E18, 5n * E18),
            snap('QUAINANCE_CURVE', T.CHEEZ, T.WQUAI, 2000n * E18, 20n * E18),
            snap('QUAINANCE_CURVE_V2', ptok(addr(0x77), 'COPPER'), T.WQUAI, 900n * E18, 9n * E18)
        ];
        const a = buildAggregate(pairs);
        expect(a.pools).toHaveLength(4);
        expect(a.pools.map(p => p.dex)).toEqual(['QUAISWAP', 'QUAINANCE', 'QUAINANCE_CURVE', 'QUAINANCE_CURVE_V2']);
        expect(a.pools[2].tokens).toEqual(['CHEEZ', 'WQUAI']);
        expect(a.tokens.map(t => t.symbol)).toEqual(['COPPER']);
        const key = pairs[2].pair.toLowerCase();
        expect(a.reserves[key]).toMatchObject({ reserve0: (2000n * E18).toString(), token0: T.CHEEZ.address });
        expect(Object.keys(a.reserves)).toHaveLength(4);
    });

    test('drops empty pairs, a pair twice, a token paired with itself, the zero address, and unreadable decimals', () => {
        const dup = snap('QUAISWAP', T.Q0, T.WQUAI, E18, E18);
        const zero = ptok('0x0000000000000000000000000000000000000000', 'QUAI');
        const unreadable = ptok(addr(0x31), 'GHOST', 18, false);
        const a = buildAggregate([
            dup,
            { ...dup }, // the factory listed it twice
            snap('QUAISWAP', T.Q0, T.WQUAI, 0n, E18),
            snap('QUAISWAP', T.Q0, T.Q0, E18, E18),
            snap('QUAISWAP', zero, T.Q0, E18, E18),
            snap('QUAISWAP', unreadable, T.WQUAI, E18, E18)
        ]);
        expect(a.pools).toHaveLength(1);
        expect(a.skipped).toEqual({ decimals: 1, empty: 1, invalid: 3, overCap: 0 });
        expect(TOKEN_REGISTRY.GHOST).toBeUndefined();
    });

    test('a token with a known address does not need a fresh decimals read', () => {
        const a = buildAggregate([snap('QUAISWAP', ptok(T.Q0.address, 'Q0', 18, false), T.WQUAI, E18, E18)]);
        expect(a.pools).toHaveLength(1);
    });

    test('the deepest token keeps the plain symbol; an imitation of it gets the suffix', () => {
        const real = ptok(addr(0x41), 'MEME');
        const fake = ptok(addr(0x42), 'MEME');
        // the fake is listed first and is shallow: order of arrival must not decide
        const a = buildAggregate([snap('QUAINANCE', fake, T.WQUAI, 10n * E18, 1n * E18), snap('QUAISWAP', real, T.WQUAI, 5000n * E18, 800n * E18)]);
        expect(getTokenByAddress(real.address)!.symbol).toBe('MEME');
        expect(getTokenByAddress(fake.address)!.symbol).toBe('MEME#0042');
        expect(a.tokens.map(t => t.symbol)).toEqual(['MEME', 'MEME#0042']);
        expect(a.pools.map(p => p.tokens[0])).toEqual(['MEME#0042', 'MEME']);
    });

    test('a curated token is never displaced by a pool', () => {
        const spoof = ptok(addr(0x51), 'CHEEZ');
        buildAggregate([snap('QUAINANCE_CURVE', T.CHEEZ, T.WQUAI, E18, E18), snap('QUAISWAP', spoof, T.WQUAI, 1_000_000n * E18, 1_000_000n * E18)]);
        expect(TOKEN_REGISTRY.CHEEZ.address).toBe('0x0016c3221B6a1707427d660945CD284a9Be58Cec');
        expect(getTokenByAddress(spoof.address)!.symbol).toBe('CHEEZ#0051');
    });

    test('depth ordering and the cap: the shallowest tokens are the ones left out', () => {
        const pairs = Array.from({ length: 6 }, (_, i) => snap('QUAISWAP', ptok(addr(0x60 + i), `T${i}`), T.WQUAI, E18, BigInt(i + 1) * E18));
        const a = buildAggregate(pairs, { maxTokens: 4 });
        expect(a.tokens.map(t => t.symbol)).toEqual(['T5', 'T4', 'T3', 'T2']);
        expect(a.pools).toHaveLength(4);
        expect(a.skipped.overCap).toBe(2);
        // a second pass counts what the registry already holds, so refreshing cannot raise the cap
        const again = buildAggregate(
            Array.from({ length: 3 }, (_, i) => snap('QUAISWAP', ptok(addr(0x70 + i), `U${i}`), T.WQUAI, E18, 1000n * E18)),
            { maxTokens: 4 }
        );
        expect(again.tokens).toHaveLength(0);
        expect(MAX_DISCOVERED_TOKENS).toBeGreaterThan(100);
    });

    test('mergePools keeps the first listing of a pair address', () => {
        const a: PoolInfo = { pair: '0x00AB', dex: 'QUAISWAP', tokens: ['Q0', 'WQUAI'] };
        const b: PoolInfo = { pair: '0x00ab', dex: 'QUAINANCE', tokens: ['X', 'Y'] };
        expect(mergePools([a], [b])).toEqual([a]);
    });
});

// ---------------------------------------------------------------------------------------------------------- routing

function world(defs: [PoolInfo['dex'], string, string, bigint, bigint][]): { pools: PoolInfo[]; reserves: Record<string, LPReserves> } {
    const pools: PoolInfo[] = [];
    const reserves: Record<string, LPReserves> = {};
    defs.forEach(([dex, a, b, ra, rb], i) => {
        const pair = addr(0x9000 + i);
        pools.push({ pair, dex, tokens: [a, b] });
        reserves[pair.toLowerCase()] = { reserve0: ra.toString(), reserve1: rb.toString(), blockTime: 0, token0: tokenAddress(a), token1: tokenAddress(b) };
    });
    return { pools, reserves };
}
const search = (w: ReturnType<typeof world>, from: string, to: string, whole = 1n, slippagePct = 1) => ({
    from,
    to,
    amountIn: whole * E18,
    pools: w.pools,
    reserves: w.reserves,
    slippagePct
});

describe('routing', () => {
    test('CHEEZ / WQUAI exists on the launch AMM only and is now a route (the reported bug)', () => {
        const w = world([['QUAINANCE_CURVE', 'CHEEZ', 'WQUAI', 5000n * E18, 50n * E18]]);
        for (const [from, to] of [['CHEEZ', 'WQUAI'], ['WQUAI', 'CHEEZ']]) {
            const r = findBestRoute(search(w, from, to, 10n))!;
            expect(r).not.toBeNull();
            expect(r.legs).toEqual([{ kind: 'AMM', dex: 'QUAINANCE_CURVE', path: [from, to] }]);
            expect(r.segmentCount).toBe(1);
        }
    });

    test('the quote is the router formula to the wei', () => {
        const w = world([['QUAINANCE_CURVE', 'CHEEZ', 'WQUAI', 5000n * E18, 50n * E18]]);
        const r = findBestRoute(search(w, 'CHEEZ', 'WQUAI', 123n, 0.5))!;
        const want = simulateSwap((123n * E18).toString(), (5000n * E18).toString(), (50n * E18).toString(), 0.5);
        expect(r.quote.amountOut.toString()).toBe(want.amountOut);
        expect(r.quote.minimumReceived.toString()).toBe(want.minimumReceived);
    });

    test('two tokens that only share WQUAI route through it in one router call', () => {
        const w = world([
            ['QUAINANCE_CURVE', 'CHEEZ', 'WQUAI', 5000n * E18, 50n * E18],
            ['QUAINANCE_CURVE', 'QCON', 'WQUAI', 8000n * E18, 40n * E18]
        ]);
        const r = findBestRoute(search(w, 'CHEEZ', 'QCON', 10n))!;
        expect(r.path).toEqual(['CHEEZ', 'WQUAI', 'QCON']);
        expect(r.legs).toEqual([{ kind: 'AMM', dex: 'QUAINANCE_CURVE', path: ['CHEEZ', 'WQUAI', 'QCON'] }]);
        expect(r.hops).toBe(2);
    });

    test('a pair on two different DEXes crosses them as two steps', () => {
        const w = world([
            ['QUAINANCE_CURVE_V2', 'LAPTOP', 'WQUAI', 1_000_000n * E18, 1000n * E18],
            ['QUAISWAP', 'WQUAI', 'Q0', 1000n * E18, 100_000n * E18]
        ]);
        const r = findBestRoute(search(w, 'LAPTOP', 'Q0', 10n))!;
        expect(r.segmentCount).toBe(2);
        expect(r.legs.map(l => (l.kind === 'AMM' ? l.dex : l.kind))).toEqual(['QUAINANCE_CURVE_V2', 'QUAISWAP']);
        expect(r.route && 'crossDex' in r.route).toBe(true);
    });

    // LAPTOP -> Q0 two ways: LAPTOP/WQUAI (Quainance) + WQUAI/Q0 (Quaiswap) is two transactions at 0.1 Q0 per LAPTOP;
    // LAPTOP/QGIRL + QGIRL/Q0 are both on Quainance, one transaction, at `atomicQ0` Q0 per 1,000,000 QGIRL.
    const twoWays = (atomicQ0: bigint) =>
        world([
            ['QUAINANCE', 'LAPTOP', 'WQUAI', 1_000_000n * E18, 1000n * E18],
            ['QUAISWAP', 'WQUAI', 'Q0', 1000n * E18, 100_000n * E18],
            ['QUAINANCE', 'LAPTOP', 'QGIRL', 1_000_000n * E18, 1_000_000n * E18],
            ['QUAINANCE', 'QGIRL', 'Q0', 1_000_000n * E18, atomicQ0 * E18]
        ]);

    test('a single-transaction route within 1% of the best goes first', () => {
        const w = twoWays(99_500n); // about 0.5% worse than the two-transaction route
        const all = listRoutes({ ...search(w, 'LAPTOP', 'Q0'), amountIn: E18 });
        const best = all.reduce((a, b) => (b.quote.amountOut > a.quote.amountOut ? b : a));
        expect(best.segmentCount).toBe(2);
        expect(all[0].segmentCount).toBe(1);
        expect(all[0].path).toEqual(['LAPTOP', 'QGIRL', 'Q0']);
        expect(all[0].quote.amountOut * 10_000n).toBeGreaterThanOrEqual(best.quote.amountOut * 9900n);
    });

    test('a route that crosses DEXes wins only when it is more than 1% better', () => {
        const w = twoWays(97_000n); // about 3% worse
        const all = listRoutes({ ...search(w, 'LAPTOP', 'Q0'), amountIn: E18 });
        expect(all[0].segmentCount).toBe(2);
        expect(all.some(c => c.segmentCount === 1)).toBe(true);
    });

    test('no route when nothing connects the tokens, and isConnected says the same', () => {
        const w = world([
            ['QUAISWAP', 'Q0', 'WQUAI', 1000n * E18, 10n * E18],
            ['QUAINANCE', 'LAPTOP', 'QGIRL', 1000n * E18, 1000n * E18]
        ]);
        expect(listRoutes(search(w, 'Q0', 'LAPTOP'))).toEqual([]);
        expect(findBestRoute(search(w, 'Q0', 'LAPTOP'))).toBeNull();
        expect(isConnected('Q0', 'LAPTOP', w.pools, w.reserves)).toBe(false);
        expect(isConnected('Q0', 'WQUAI', w.pools, w.reserves)).toBe(true);
        expect(isConnected('Q0', 'Q0', w.pools, w.reserves)).toBe(false);
    });

    test('a token with no pool at all, an unknown token, a zero amount, or from == to give nothing', () => {
        const w = world([['QUAISWAP', 'Q0', 'WQUAI', 1000n * E18, 10n * E18]]);
        expect(listRoutes(search(w, 'Q0', 'CHEEZ'))).toEqual([]);
        expect(listRoutes(search(w, 'Q0', 'NOT_A_TOKEN'))).toEqual([]);
        expect(listRoutes({ ...search(w, 'Q0', 'WQUAI'), amountIn: 0n })).toEqual([]);
        expect(listRoutes(search(w, 'Q0', 'Q0'))).toEqual([]);
    });

    test('an empty pool is not an edge', () => {
        const w = world([
            ['QUAISWAP', 'Q0', 'WQUAI', 0n, 10n * E18],
            ['QUAINANCE', 'Q0', 'WQUAI', 1000n * E18, 10n * E18]
        ]);
        expect(tradablePools(w.pools, w.reserves)).toHaveLength(1);
        expect(findBestRoute(search(w, 'Q0', 'WQUAI'))!.legs[0]).toMatchObject({ dex: 'QUAINANCE' });
    });

    test('a dust pool cannot pay out more than it holds, and the deep pool wins a real-sized trade', () => {
        const w = world([
            ['QUAISWAP', 'Q0', 'WQUAI', 100_000n * E18, 1000n * E18], // 0.01 WQUAI per Q0, deep
            ['QUAINANCE', 'Q0', 'WQUAI', 10n * E18, 10n * E18] // claims 1 WQUAI per Q0 but holds 10
        ]);
        // Selling 50,000 Q0: the dust pool can pay out less than its 10 WQUAI, the deep pool about 333 WQUAI.
        const big = listRoutes(search(w, 'Q0', 'WQUAI', 50_000n));
        expect(big[0].legs[0]).toMatchObject({ dex: 'QUAISWAP' });
        const dust = big.find(c => c.legs[0].kind === 'AMM' && c.legs[0].dex === 'QUAINANCE')!;
        expect(dust.quote.amountOut).toBeLessThan(10n * E18);
        expect(big[0].quote.amountOut).toBeGreaterThan(300n * E18);
        // For one Q0 the dust pool's claimed price is a real, better fill: the quote follows the reserves, not the label.
        const small = listRoutes(search(w, 'Q0', 'WQUAI', 1n));
        expect(small[0].legs[0]).toMatchObject({ dex: 'QUAINANCE' });
        expect(small[0].quote.amountOut).toBeLessThan(10n * E18);
    });

    test('the same token under the same symbol but another address is a different node', () => {
        const fake = registerDiscoveredToken({ address: addr(0x8a), symbol: 'CHEEZ', decimals: 18 })!;
        expect(fake.symbol).toBe('CHEEZ#008a');
        const w = world([
            ['QUAINANCE_CURVE', 'CHEEZ', 'WQUAI', 5000n * E18, 50n * E18],
            ['QUAISWAP', fake.symbol, 'WQUAI', 5000n * E18, 5000n * E18]
        ]);
        const real = findBestRoute(search(w, 'CHEEZ', 'WQUAI'))!;
        expect(real.legs).toEqual([{ kind: 'AMM', dex: 'QUAINANCE_CURVE', path: ['CHEEZ', 'WQUAI'] }]);
        expect(real.unverified).toEqual([]);
        const other = findBestRoute(search(w, fake.symbol, 'WQUAI'))!;
        expect(other.unverified).toEqual([fake.symbol]);
        // the two are not connected to each other except through WQUAI, and then as two different tokens
        const between = findBestRoute(search(w, 'CHEEZ', fake.symbol))!;
        expect(between.path).toEqual(['CHEEZ', 'WQUAI', fake.symbol]);
    });

    test('an unverified token used as a stepping stone loses to a verified route within 1%', () => {
        const mid = registerDiscoveredToken({ address: addr(0x8b), symbol: 'STEP', decimals: 18 })!;
        // Q0 -> BOSS directly through STEP (slightly better) or through WQUAI (slightly worse), both on Quaiswap
        const w = world([
            ['QUAISWAP', 'Q0', mid.symbol, 1_000_000n * E18, 1_000_000n * E18],
            ['QUAISWAP', mid.symbol, 'BOSS', 1_000_000n * E18, 1_000_000n * E18],
            ['QUAISWAP', 'Q0', 'WQUAI', 1_000_000n * E18, 1_000_000n * E18],
            ['QUAISWAP', 'WQUAI', 'BOSS', 1_000_000n * E18, 998_000n * E18]
        ]);
        const all = listRoutes(search(w, 'Q0', 'BOSS', 10n));
        const viaStep = all.find(c => c.path.includes(mid.symbol))!;
        const viaWquai = all.find(c => c.path.includes('WQUAI'))!;
        expect(viaStep.unverifiedBetween).toBe(true);
        expect(viaStep.quote.amountOut).toBeGreaterThan(viaWquai.quote.amountOut);
        expect(all[0]).toBe(viaWquai);
    });

    describe('network fees', () => {
        const GAS_PRICE = 40_000_000_000_000n; // about what Cyprus-1 charges: 4e13 wei
        // CHEEZ -> Q0 two ways: one pool on Quaiswap at 0.1 Q0 each, or two pools via WQUAI at about 5% more (two transactions).
        const feeWorld = () =>
            world([
                ['QUAISWAP', 'CHEEZ', 'Q0', 10_000_000n * E18, 1_000_000n * E18],
                ['QUAINANCE_CURVE', 'CHEEZ', 'WQUAI', 10_000_000n * E18, 10_500n * E18],
                ['QUAISWAP', 'WQUAI', 'Q0', 100_000n * E18, 10_000_000n * E18]
            ]);
        const run = (w: ReturnType<typeof world>, whole: bigint, gas: boolean) =>
            listRoutes({ ...search(w, 'CHEEZ', 'Q0', whole), gas: gas ? { gasPriceWei: GAS_PRICE } : null });

        test('without a gas price the better-paying route wins at any size', () => {
            const r = run(feeWorld(), 1000n, false);
            expect(r[0].segmentCount).toBe(2);
            expect(r[0].feeWei).toBeNull();
            expect(r[0].netOut).toBe(r[0].quote.amountOut);
        });

        test('a small swap takes the one-transaction route because the second transaction costs more than it earns', () => {
            const r = run(feeWorld(), 1000n, true);
            expect(r[0].segmentCount).toBe(1);
            expect(r[0].legs[0]).toMatchObject({ dex: 'QUAISWAP', path: ['CHEEZ', 'Q0'] });
            const two = r.find(c => c.segmentCount === 2)!;
            expect(two.quote.amountOut).toBeGreaterThan(r[0].quote.amountOut);
            expect(two.feeWei!).toBeGreaterThan(r[0].feeWei!);
        });

        test('a large swap earns the second transaction back and takes the better price', () => {
            const r = run(feeWorld(), 1_000_000n, true);
            expect(r[0].segmentCount).toBe(2);
        });

        test('fees are the gas model times the gas price, in QUAI and in the token received', () => {
            const r = run(feeWorld(), 1000n, true)[0];
            // one pool, paid in a token: a router call for one pool plus an approval
            expect(r.gasUnits).toBe(100_000n + 88_000n + 70_000n);
            expect(r.feeWei).toBe(r.gasUnits * GAS_PRICE);
            // 100 Q0 per QUAI in the WQUAI/Q0 pool, less its 0.3% fee and a sliver of impact on a tenth of a QUAI
            const feeQ0 = Number(r.feeOut!) / 1e18;
            const feeQuai = Number(r.feeWei!) / 1e18;
            expect(feeQ0 / feeQuai).toBeGreaterThan(99);
            expect(feeQ0 / feeQuai).toBeLessThan(100);
            expect(r.netOut).toBe(r.quote.amountOut - r.feeOut!);
        });

        test('paying in native QUAI spares the first approval', () => {
            const w = world([['QUAINANCE_CURVE', 'CHEEZ', 'WQUAI', 10_000_000n * E18, 10_500n * E18]]);
            const paid = listRoutes({ ...search(w, 'WQUAI', 'CHEEZ', 10n), nativeIn: true, gas: { gasPriceWei: GAS_PRICE } })[0];
            const token = listRoutes({ ...search(w, 'WQUAI', 'CHEEZ', 10n), nativeIn: false, gas: { gasPriceWei: GAS_PRICE } })[0];
            expect(token.gasUnits - paid.gasUnits).toBe(70_000n);
        });

        test('a token that cannot be valued in QUAI keeps the plain output ranking', () => {
            const w = world([['QUAINANCE', 'LAPTOP', 'QGIRL', 1000n * E18, 1000n * E18]]);
            const r = listRoutes({ ...search(w, 'LAPTOP', 'QGIRL', 1n), gas: { gasPriceWei: GAS_PRICE } })[0];
            expect(r.feeWei).not.toBeNull();
            expect(r.feeOut).toBeNull();
            expect(r.netOut).toBe(r.quote.amountOut);
        });

        test('when fees swallow the whole swap the best route is the cheapest one', () => {
            const r = run(feeWorld(), 1n, true);
            expect(r[0].netOut).toBeLessThan(0n);
            expect(r[0].segmentCount).toBe(1);
        });
    });

    test('the output is deterministic whatever order the pools arrive in', () => {
        const w = twoWays(99_000n);
        const a = listRoutes({ ...search(w, 'LAPTOP', 'Q0'), amountIn: E18 });
        const shuffled = { ...w, pools: [...w.pools].reverse() };
        const b = listRoutes({ ...search(shuffled, 'LAPTOP', 'Q0'), amountIn: E18 });
        expect(b.map(c => c.id)).toEqual(a.map(c => c.id));
        expect(b.map(c => c.quote.amountOut)).toEqual(a.map(c => c.quote.amountOut));
    });

    test('the candidate count is capped, and a heavily connected graph still answers quickly', () => {
        // 14 tokens, every pair listed on three DEXes: an enormous number of simple paths
        const keys: string[] = ['Q0', 'WQUAI', 'BOSS', 'LAPTOP', 'QGIRL', 'FEW', 'TRAVEL', 'QWHALE', 'AXEQCAT', 'QCON', 'CHEEZ', 'QAXE', 'BDELTA'];
        const defs: [PoolInfo['dex'], string, string, bigint, bigint][] = [];
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) {
                for (const dex of ['QUAISWAP', 'QUAINANCE', 'QUAINANCE_CURVE'] as const) defs.push([dex, keys[i], keys[j], BigInt(1000 + i * 7 + j) * E18, BigInt(900 + j * 5 + i) * E18]);
            }
        }
        const w = world(defs);
        const started = Date.now();
        const all = listRoutes({ ...search(w, 'Q0', 'CHEEZ'), maxHops: 4 });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(all.length).toBeGreaterThan(0);
        expect(all.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    });

    test('requoteCandidate follows new reserves and refuses when a hop has none', () => {
        const w = world([['QUAINANCE_CURVE', 'CHEEZ', 'WQUAI', 5000n * E18, 50n * E18]]);
        const r = findBestRoute(search(w, 'CHEEZ', 'WQUAI', 10n))!;
        const moved = { ...w.reserves };
        const key = w.pools[0].pair.toLowerCase();
        moved[key] = { ...moved[key]!, reserve1: (25n * E18).toString() };
        const q = requoteCandidate(r, 10n * E18, moved, 1, w.pools)!;
        expect(q.amountOut).toBeLessThan(r.quote.amountOut);
        expect(requoteCandidate(r, 10n * E18, {}, 1, w.pools)).toBeNull();
    });

    test('odd decimals: a 6-decimal token quotes in its own units', () => {
        const usd = registerDiscoveredToken({ address: addr(0x8c), symbol: 'USDX', decimals: 6 })!;
        const pair = addr(0x9f00);
        const reserves: Record<string, LPReserves> = {
            [pair.toLowerCase()]: { reserve0: (1_000_000n * 10n ** 6n).toString(), reserve1: (500n * E18).toString(), blockTime: 0, token0: usd.address, token1: tokenAddress('WQUAI') }
        };
        const pools: PoolInfo[] = [{ pair, dex: 'QUAISWAP', tokens: [usd.symbol, 'WQUAI'] }];
        const r = findBestRoute({ from: usd.symbol, to: 'WQUAI', amountIn: 1000n * 10n ** 6n, pools, reserves, slippagePct: 1 })!;
        // 1000 of 1,000,000 USDX is 0.1% of the pool: about 0.499 WQUAI out
        expect(Number(r.quote.amountOut) / 1e18).toBeGreaterThan(0.49);
        expect(Number(r.quote.amountOut) / 1e18).toBeLessThan(0.5);
    });
});

// ------------------------------------------------------------------------------------------- loading and integrity

describe('loading every factory', () => {
    test('createBatch keeps at most four requests in flight and returns results in call order', async () => {
        let inFlight = 0;
        let peak = 0;
        const fetcher = async (_u: string, init?: RequestInit) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            const body = JSON.parse(String(init!.body)) as { id: number; params: number[] }[];
            return new Response(JSON.stringify(body.map(b => ({ jsonrpc: '2.0', id: b.id, result: '0x' + b.params[0].toString(16) }))));
        };
        const calls = Array.from({ length: 40 * 12 + 7 }, (_, i) => ({ method: 'm', params: [i] }));
        const out = await createBatch('http://x', fetcher as any)(calls);
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBeGreaterThan(1);
        expect(out).toHaveLength(calls.length);
        expect(out.every((r, i) => r.ok && r.value === '0x' + i.toString(16))).toBe(true);
    });

    test('all live factories are read in one call and one failing factory does not hide the others', async () => {
        const w = (n: bigint) => n.toString(16).padStart(64, '0');
        const word = (a: string) => '0x' + a.replace('0x', '').toLowerCase().padStart(64, '0');
        const str = (s: string) => '0x' + w(32n) + w(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
        const factories: Record<string, { pair: string; t0: string; t1: string; r0: bigint; r1: bigint }[]> = {
            [DEXES.QUAISWAP.factory!.toLowerCase()]: [{ pair: addr(0xa001), t0: T.Q0.address, t1: T.WQUAI.address, r0: 1000n * E18, r1: 10n * E18 }],
            [DEXES.QUAINANCE_CURVE.factory!.toLowerCase()]: [{ pair: addr(0xa002), t0: T.CHEEZ.address, t1: T.WQUAI.address, r0: 5000n * E18, r1: 50n * E18 }],
            [DEXES.QUAINANCE_CURVE_V2.factory!.toLowerCase()]: [{ pair: addr(0xa003), t0: addr(0xc0b), t1: T.WQUAI.address, r0: 900n * E18, r1: 9n * E18 }]
        };
        const failing = DEXES.QUAINANCE.factory!.toLowerCase();
        const batch: BatchFn = async calls =>
            calls.map(c => {
                if (c.method === 'quai_blockNumber') return { ok: true as const, value: '0x2a' };
                const { to, data } = (c.params as any[])[0] as { to: string; data: string };
                const t = to.toLowerCase();
                if (t === failing) return { ok: false as const, error: 'node unavailable' };
                const list = factories[t];
                if (list) {
                    if (data === '0x574f2ba3') return { ok: true as const, value: '0x' + w(BigInt(list.length)) };
                    if (data.startsWith('0x1e3dd18b')) return { ok: true as const, value: word(list[Number(BigInt('0x' + data.slice(10)))].pair) };
                }
                const pool = Object.values(factories).flat().find(p => p.pair === t);
                if (pool) {
                    if (data === '0x0dfe1681') return { ok: true as const, value: word(pool.t0) };
                    if (data === '0xd21220a7') return { ok: true as const, value: word(pool.t1) };
                    if (data === '0x0902f1ac') return { ok: true as const, value: '0x' + w(pool.r0) + w(pool.r1) + w(1n) };
                    if (data === '0x18160ddd') return { ok: true as const, value: '0x' + w(100n * E18) };
                    if (data.startsWith('0x70a08231')) return { ok: true as const, value: '0x' + w(0n) };
                }
                if (t === addr(0xc0b)) {
                    if (data === '0x95d89b41') return { ok: true as const, value: str('COPPER') };
                    if (data === '0x06fdde03') return { ok: true as const, value: str('Copper') };
                    if (data === '0x313ce567') return { ok: true as const, value: '0x' + w(18n) };
                }
                return { ok: false as const, error: 'execution reverted' };
            });
        const r = await loadPairSnapshots(AMM_DEX_IDS, { batch, maxPerDex: 1000 });
        expect(r.pairs.map(p => p.dex)).toEqual(['QUAISWAP', 'QUAINANCE_CURVE', 'QUAINANCE_CURVE_V2']);
        expect(r.totals).toEqual({ QUAISWAP: 1, QUAINANCE_CURVE: 1, QUAINANCE_CURVE_V2: 1 });
        expect(r.errors.join(' ')).toContain('Quainance');
        const a = buildAggregate(r.pairs);
        expect(a.pools).toHaveLength(3);
        expect(a.tokens.map(t => t.symbol)).toEqual(['COPPER']);
        expect(findBestRoute({ from: 'COPPER', to: 'Q0', amountIn: E18, pools: a.pools, reserves: a.reserves, slippagePct: 1 })!.segmentCount).toBe(2);
        expect(findBestRoute({ from: 'CHEEZ', to: 'WQUAI', amountIn: E18, pools: a.pools, reserves: a.reserves, slippagePct: 1 })).not.toBeNull();
    });
});

describe('DEX code integrity', () => {
    const fakeCode = (seed: string) => '0x6080' + Buffer.from(seed).toString('hex');

    function withPins<T>(id: 'QUAISWAP', factoryCode: string, routerCode: string, run: () => Promise<T>): Promise<T> {
        const dex = DEXES[id];
        const saved = dex.codeHash;
        dex.codeHash = { factory: keccak256(factoryCode), router: keccak256(routerCode) };
        return run().finally(() => {
            dex.codeHash = saved;
        });
    }
    const batchOf = (codes: Record<string, string | null>): BatchFn => async calls =>
        calls.map(c => {
            const a = (c.params as string[])[0];
            const v = codes[a];
            return v === null || v === undefined ? { ok: false as const, error: 'unavailable' } : { ok: true as const, value: v };
        });
    const checks = (dex: 'QUAISWAP') => [checksumAddress(DEXES[dex].factory!), checksumAddress(DEXES[dex].router!)] as const;

    test('the pinned hashes are present for every live external DEX and look like hashes', () => {
        for (const id of ['QUAISWAP', 'QUAINANCE', 'QUAINANCE_CURVE', 'QUAINANCE_CURVE_V2', 'HARTIISWAP'] as const) {
            expect(DEXES[id].codeHash!.factory).toMatch(/^0x[0-9a-f]{64}$/);
            expect(DEXES[id].codeHash!.router).toMatch(/^0x[0-9a-f]{64}$/);
        }
        // the four hashes Quainance's own frontend publishes for its launch AMMs
        expect(DEXES.QUAINANCE_CURVE.codeHash).toEqual({
            factory: '0xfe85a9faa97c8eb2335e93ea4ef517886c9cc7c4c51f1631a2964e3e2b317ea6',
            router: '0x7cd5576ca6e81fab8a5a926be4c8ba18c2f22369e72e3fc71e0be98f3d4f96ea'
        });
        expect(DEXES.QUAINANCE_CURVE_V2.codeHash).toEqual({
            factory: '0x5921f7e274335dc1d0a6076079acf41461927b341702efa8271f0e58bc8c78f1',
            router: '0x6150c2a53eeccb818146583059319fa94b77c2399705374359eaeeee86ea38c1'
        });
        // HartiiSwap factory and router on Cyprus-1
        expect(DEXES.HARTIISWAP.codeHash).toEqual({
            factory: '0x1ee44e3fa21f4dcb2359f590dc3572b7888a1daef24a140d2d63fa9e02c44359',
            router: '0x1f8c8af809c0e1bee7afe8ac51260160d16837940ad218331c4cfbfc3772c057'
        });
    });

    test('matching code is VERIFIED; different code is a MISMATCH and the DEX is switched off', async () => {
        const [f, r] = checks('QUAISWAP');
        await withPins('QUAISWAP', fakeCode('factory'), fakeCode('router'), async () => {
            const ok = await verifyDexCode(['QUAISWAP'], { batch: batchOf({ [f]: fakeCode('factory'), [r]: fakeCode('router') }) });
            expect(ok.QUAISWAP.state).toBe('VERIFIED');
            expect(canSign(ok.QUAISWAP.state)).toBe(true);

            const swapped = await verifyDexCode(['QUAISWAP'], { batch: batchOf({ [f]: fakeCode('factory'), [r]: fakeCode('malicious router') }) });
            expect(swapped.QUAISWAP.state).toBe('MISMATCH');
            expect(swapped.QUAISWAP.detail).toContain('swap router');
            expect(canQuote(swapped.QUAISWAP.state)).toBe(false);
            expect(canSign(swapped.QUAISWAP.state)).toBe(false);

            const gone = await verifyDexCode(['QUAISWAP'], { batch: batchOf({ [f]: '0x', [r]: fakeCode('router') }) });
            expect(gone.QUAISWAP.state).toBe('MISMATCH');
            expect(gone.QUAISWAP.detail).toContain('pool factory');
        });
    });

    test('an unanswered or malformed read is UNREADABLE: quotable, not signable, and it never throws', async () => {
        const [f, r] = checks('QUAISWAP');
        await withPins('QUAISWAP', fakeCode('factory'), fakeCode('router'), async () => {
            const down = await verifyDexCode(['QUAISWAP'], { batch: batchOf({ [f]: null, [r]: fakeCode('router') }) });
            expect(down.QUAISWAP.state).toBe('UNREADABLE');
            expect(canQuote(down.QUAISWAP.state)).toBe(true);
            expect(canSign(down.QUAISWAP.state)).toBe(false);

            const garbage = await verifyDexCode(['QUAISWAP'], { batch: batchOf({ [f]: '0xzz', [r]: fakeCode('router') }) });
            expect(garbage.QUAISWAP.state).toBe('UNREADABLE');

            const throwing: BatchFn = async () => {
                throw new Error('boom');
            };
            const t = await verifyDexCode(['QUAISWAP'], { batch: throwing });
            expect(t.QUAISWAP.state).toBe('UNREADABLE');
        });
    });

    test('a DEX that is not deployed is reported, and one with no pin is usable', async () => {
        const out = await verifyDexCode(['CIRCLESWAP'], { batch: batchOf({}) });
        // Circleswap has no factory in this build: not deployed, not an error
        expect(['NOT_DEPLOYED', 'UNPINNED']).toContain(out.CIRCLESWAP.state);
        expect(canSign('UNPINNED')).toBe(true);
        expect(canSign('NOT_DEPLOYED')).toBe(false);
    });

    test('code reads use checksummed addresses (the node rejects anything else)', async () => {
        const seen: string[] = [];
        const batch: BatchFn = async calls => {
            for (const c of calls) seen.push((c.params as string[])[0]);
            return calls.map(() => ({ ok: false as const, error: 'unavailable' }));
        };
        await verifyDexCode(['QUAISWAP', 'QUAINANCE'], { batch });
        expect(seen).toHaveLength(4);
        for (const a of seen) expect(a).toBe(getAddress(a));
    });
});
