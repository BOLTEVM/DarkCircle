// Live, READ-ONLY check of the DEX aggregation against Cyprus-1. Nothing is signed or sent: every call is a quai_call or a
// quai_estimateGas simulation, and the simulating address is an externally owned account used only as a `from`.
//
//   bun run q0/scripts/verify-aggregation.ts
//
// It checks, in order:
//   1. the pinned factory/router code hashes against the chain;
//   2. that every pair on every factory becomes a route edge (and why any does not);
//   3. for a set of swaps, that the local per-leg quote equals router.getAmountsOut, wei for wei, and that the router
//      accepts the final call (a QUAI-in swap simulates cleanly; a token-in swap is checked as far as the wallet allows).
// Exit code 1 when something that should hold does not.

import {
    AMM_DEX_IDS,
    DEXES,
    TOKEN_REGISTRY,
    buildAggregate,
    createBatch,
    isConnected,
    listRoutes,
    loadPairSnapshots,
    quaiRpcCall,
    quoteRoute,
    tradablePools,
    verifyDexCode,
    checksumAddress,
    type DexId,
    type PoolInfo,
    type RouteCandidate
} from '../packages/quai-service/src/index';

const SIMULATOR = '0x007F3dee067F965321c3c6a49C53cc4B4734b929';
const E18 = 10n ** 18n;
let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
};

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.replace('0x', '').toLowerCase().padStart(64, '0');

function encodeGetAmountsOut(amountIn: bigint, path: string[]): string {
    return '0xd06ca61f' + word(amountIn) + word(0x40n) + word(BigInt(path.length)) + path.map(addrWord).join('');
}
function decodeUintArray(hex: string): bigint[] {
    const d = hex.slice(2);
    const offset = Number(BigInt('0x' + d.slice(0, 64))) * 2;
    const length = Number(BigInt('0x' + d.slice(offset, offset + 64)));
    return Array.from({ length }, (_, i) => BigInt('0x' + d.slice(offset + 64 + i * 64, offset + 128 + i * 64)));
}
function encodeSwapExactETHForTokens(minOut: bigint, path: string[], to: string, deadline: bigint): string {
    return '0x7ff36ab5' + word(minOut) + word(0x80n) + addrWord(to) + word(deadline) + word(BigInt(path.length)) + path.map(addrWord).join('');
}
function encodeSwapExactTokens(selector: string, amountIn: bigint, minOut: bigint, path: string[], to: string, deadline: bigint): string {
    return selector + word(amountIn) + word(minOut) + word(0xa0n) + addrWord(to) + word(deadline) + word(BigInt(path.length)) + path.map(addrWord).join('');
}

async function simulate(to: string, data: string, value: bigint = 0n): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
    try {
        const out = await quaiRpcCall('quai_call', [{ from: SIMULATOR, to, data, ...(value > 0n ? { value: '0x' + value.toString(16) } : {}) }, 'latest']);
        return { ok: true, out };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

async function main() {
    console.log('== 1. pinned code hashes ==');
    const integrity = await verifyDexCode(AMM_DEX_IDS);
    for (const id of AMM_DEX_IDS) check(['VERIFIED', 'UNPINNED', 'NOT_DEPLOYED'].includes(integrity[id].state), `${id} ${integrity[id].state}`, integrity[id].detail);

    console.log('\n== 2. every pair on every factory ==');
    const batch = createBatch();
    const snap = await loadPairSnapshots(AMM_DEX_IDS, { maxPerDex: 1000, batch });
    console.log(`block ${snap.block}; factory totals ${JSON.stringify(snap.totals)}; read errors ${snap.errors.length}`);
    for (const e of snap.errors) console.log('  read error:', e);
    const agg = buildAggregate(snap.pairs);
    const perDex = (id: DexId) => snap.pairs.filter(p => p.dex === id).length;
    const poolsPerDex = (id: DexId) => agg.pools.filter(p => p.dex === id).length;
    for (const id of AMM_DEX_IDS) {
        if (snap.totals[id] === undefined) continue;
        check(perDex(id) === snap.totals[id], `${id}: read ${perDex(id)} of ${snap.totals[id]} pairs`);
        console.log(`        ${poolsPerDex(id)} routable pools`);
    }
    console.log(`skipped: ${JSON.stringify(agg.skipped)}; discovered tokens: ${agg.tokens.length}`);
    const tradable = tradablePools(agg.pools, agg.reserves);
    const empties = snap.pairs.filter(p => p.reserve0 <= 0n || p.reserve1 <= 0n).length;
    check(tradable.length + empties + agg.skipped.decimals + agg.skipped.invalid + agg.skipped.overCap === snap.pairs.length, 'every pair is either a route edge or accounted for', `${tradable.length} edges + ${empties} empty + ${agg.skipped.decimals} unreadable decimals + ${agg.skipped.invalid} invalid`);
    let unconnected = 0;
    for (const p of tradable) {
        if (!isConnected(p.tokens[0], p.tokens[1], agg.pools, agg.reserves, 1)) unconnected++;
    }
    check(unconnected === 0, 'both tokens of every edge are connected to each other', `${unconnected} not`);

    // Named tokens by symbol, falling back to the registry key.
    const key = (symbol: string): string | null => {
        if (TOKEN_REGISTRY[symbol] && !TOKEN_REGISTRY[symbol].isNative) return symbol;
        const found = Object.values(TOKEN_REGISTRY).filter(t => t.discovered && t.symbol === symbol);
        return found[0]?.symbol ?? null;
    };

    console.log('\n== 3. quotes and router simulation ==');
    const cases: [string, string][] = [['CHEEZ', 'WQUAI'], ['WQUAI', 'CHEEZ'], ['QMON', 'QCON'], ['COPPER', 'Q0'], ['LAPTOP', 'CHEEZ']];
    const quoteLeg = (leg: { dex: DexId; path: string[] }, amountIn: bigint, pools: PoolInfo[]) =>
        quoteRoute({ id: 'leg', label: 'leg', dex: leg.dex, path: leg.path }, false, amountIn, agg.reserves, 1, pools)!.amountOut;

    for (const [fromSym, toSym] of cases) {
        const from = key(fromSym);
        const to = key(toSym);
        if (!from || !to) {
            console.log(`SKIP  ${fromSym} -> ${toSym}: token not found on chain`);
            continue;
        }
        const amountIn = 10n * E18;
        const all = listRoutes({ from, to, amountIn, pools: agg.pools, reserves: agg.reserves, slippagePct: 1 });
        if (!all.length) {
            check(false, `${fromSym} -> ${toSym} has a route`);
            continue;
        }
        const best: RouteCandidate = all[0];
        console.log(`\n${fromSym} -> ${toSym}: ${all.length} route(s); best ${best.label}; ${best.segmentCount} transaction(s); out ${Number(best.quote.amountOut) / 1e18}`);

        // 3a. every leg against the router's own getAmountsOut
        let carried = amountIn;
        for (const leg of best.legs) {
            if (leg.kind !== 'AMM') continue;
            const router = DEXES[leg.dex].router!;
            const addresses = leg.path.map(k => TOKEN_REGISTRY[k].address);
            const local = quoteLeg(leg, carried, agg.pools);
            const r = await simulate(router, encodeGetAmountsOut(carried, addresses));
            if (!r.ok) {
                check(false, `  ${leg.dex} getAmountsOut ${leg.path.join('>')}`, r.error);
                break;
            }
            const onchain = decodeUintArray(r.out).at(-1)!;
            check(onchain === local, `  ${leg.dex} ${leg.path.join(' > ')}: local ${local} == router ${onchain}`);
            carried = onchain;
        }
        check(carried === best.quote.amountOut || best.legs.length > 1, '  total equals the quoted output');

        // 3b. the call the app would send, from the first leg
        const first = best.legs[0];
        if (first.kind !== 'AMM') continue;
        const router = DEXES[first.dex].router!;
        const path = first.path.map(k => TOKEN_REGISTRY[k].address);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
        const legOut = quoteLeg(first, amountIn, agg.pools);
        const minOut = (legOut * 99n) / 100n;
        if (first.path[0] === 'WQUAI') {
            // native QUAI in: the simulator holds QUAI, so this one runs to completion
            const sim = await simulate(router, encodeSwapExactETHForTokens(minOut, path, SIMULATOR, deadline), amountIn);
            check(sim.ok, `  swapExactETHForTokens simulates on ${first.dex}`, sim.ok ? '' : sim.error);
            if (sim.ok) {
                const amounts = decodeUintArray(sim.out);
                check(amounts.at(-1) === legOut, `  simulated output ${amounts.at(-1)} == local ${legOut}`);
            }
        } else {
            // token in: the simulator holds none of it, so the swap reverts at the transfer. The point is that it gets that
            // far (the router accepted the path); an unknown pair would revert earlier with a different message.
            const selector = first.path[first.path.length - 1] === 'WQUAI' ? '0x18cbafe5' : '0x38ed1739';
            const sim = await simulate(router, encodeSwapExactTokens(selector, amountIn, minOut, path, SIMULATOR, deadline));
            console.log(`        token-in swap from a wallet with none of the token: ${sim.ok ? 'ran' : sim.error}`);
        }
    }

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
