// The Quainance aggregate: the factory is the universe, the explorer only adds indexed stats.
// Run: node --test packages/quai-service/test/quainance.test.ts   (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeQuainance, parseCatalog, type MergeInput } from '../src/quainance.ts';

const E18 = 10n ** 18n;
const WQUAI = '0x0000000000000000000000000000000000000001';
const WQI = '0x0000000000000000000000000000000000000002';
const USDT = '0x0000000000000000000000000000000000000003';
const QOWBOY = '0x0000000000000000000000000000000000000004';
const LISTED = new Set([WQUAI, WQI, USDT]);

const tok = (address: string, symbol: string, decimals = 18) => ({ address, symbol, name: symbol, decimals, registered: LISTED.has(address) });

function snap(pair: string, index: number, t0: ReturnType<typeof tok>, t1: ReturnType<typeof tok>, r0 = 100n * E18, r1 = 50n * E18) {
  return { dex: 'QUAINANCE', pair, index, token0: t0, token1: t1, reserve0: r0, reserve1: r1, totalSupply: 10n * E18, burned: 0n } as any;
}
const explorerPool = (address: string, t0: string, s0: string, t1: string, s1: string, over: Record<string, string> = {}) => ({
  address, name: `${s0}/${s1}`, token0: { address: t0, symbol: s0 }, token1: { address: t1, symbol: s1 },
  reserve0: '100', reserve1: '50', tvlUsd: '1000', totalVolumeUsd: '5000', volume24hUsd: '25', estimatedFees24hUsd: '0.07', txCount: '42', ...over
});
const explorer = (pools: any[], current: Record<string, string> = {}) =>
  ({ days: 1, stale: false, current: { tvlUsd: '118000', totalVolumeUsd: '130000', volume24hUsd: '1187', pairCount: '38', txCount: '22502', ...current }, pools }) as any;

const base: MergeInput = {
  snapshots: [
    snap('0x00a1', 0, tok(WQI, 'WQI'), tok(WQUAI, 'WQUAI')),
    snap('0x00a2', 1, tok(USDT, 'USDT'), tok(WQUAI, 'WQUAI')),
    snap('0x00a3', 2, tok(QOWBOY, 'QOWBOY'), tok(WQI, 'WQI'))
  ],
  explorer: null,
  isListed: a => LISTED.has(a)
};

test('every pair the factory reports is present even with no explorer at all', () => {
  const r = mergeQuainance(base);
  assert.equal(r.pools.length, 3);
  assert.equal(r.totals.pairs, 3);
  assert.deepEqual(r.source, { factory: true, explorer: false, explorerStale: false, catalog: false });
});

test('the explorer cannot shrink the list: a truncated top-25 still leaves the other pairs in', () => {
  const r = mergeQuainance({ ...base, explorer: explorer([explorerPool('0x00a1', WQI, 'WQI', WQUAI, 'WQUAI')]) });
  assert.equal(r.pools.length, 3);
  assert.equal(r.pools.find(p => p.pair === '0x00a1')!.source.explorer, true);
  assert.equal(r.pools.find(p => p.pair === '0x00a3')!.source.explorer, false);
});

test('an explorer-only pool (the factory read missed it) is kept, not dropped', () => {
  const r = mergeQuainance({
    ...base,
    explorer: explorer([explorerPool('0x00ff', USDT, 'USDT', WQI, 'WQI', { tvlUsd: '77.5', reserve0: '12.5' })])
  });
  assert.equal(r.pools.length, 4);
  const extra = r.pools.find(p => p.pair === '0x00ff')!;
  assert.equal(extra.tvlUsd, 77.5);
  assert.equal(extra.reserve0, 12n * E18 + E18 / 2n);
  assert.deepEqual(extra.source, { chain: false, explorer: true, tvl: 'explorer' });
  assert.equal(extra.listed, true);
});

test('USD value: the explorer figure wins, else the reserve-derived one, else unknown (never 0)', () => {
  const r = mergeQuainance({
    ...base,
    analysis: [{ pair: '0x00a2', tvlUsd: 321.5 } as any],
    explorer: explorer([explorerPool('0x00a1', WQI, 'WQI', WQUAI, 'WQUAI', { tvlUsd: '900' })])
  });
  const by = (p: string) => r.pools.find(x => x.pair === p)!;
  assert.deepEqual([by('0x00a1').tvlUsd, by('0x00a1').source.tvl], [900, 'explorer']);
  assert.deepEqual([by('0x00a2').tvlUsd, by('0x00a2').source.tvl], [321.5, 'reserves']);
  assert.deepEqual([by('0x00a3').tvlUsd, by('0x00a3').source.tvl], [null, 'none']);
});

test('sorted by USD value, unpriced pairs last, newest first among them', () => {
  const r = mergeQuainance({
    ...base,
    snapshots: [...base.snapshots, snap('0x00a4', 3, tok(USDT, 'USDT'), tok(WQI, 'WQI'))],
    analysis: [{ pair: '0x00a1', tvlUsd: 10 } as any, { pair: '0x00a2', tvlUsd: 500 } as any]
  });
  assert.deepEqual(r.pools.map(p => p.pair), ['0x00a2', '0x00a1', '0x00a4', '0x00a3']);
});

test('listed means both tokens are in the token list', () => {
  const r = mergeQuainance(base);
  assert.deepEqual(r.pools.map(p => [p.pair, p.listed]).sort(), [['0x00a1', true], ['0x00a2', true], ['0x00a3', false]]);
  assert.equal(r.totals.listed, 2);
});

test('network totals: the explorer total and pair count when it answered', () => {
  const r = mergeQuainance({ ...base, factoryTotal: 38, explorer: explorer([]) });
  assert.equal(r.totals.pairs, 38);
  assert.equal(r.totals.loaded, 3);
  assert.equal(r.totals.tvlUsd, 118000);
  assert.equal(r.totals.volume24hUsd, 1187);
});

test('without the explorer, the total is only what could be priced and says it may be partial', () => {
  const r = mergeQuainance({ ...base, factoryTotal: 3, analysis: [{ pair: '0x00a1', tvlUsd: 10 } as any, { pair: '0x00a2', tvlUsd: 5 } as any] });
  assert.equal(r.totals.tvlUsd, 15);
  assert.equal(r.totals.tvlComplete, false); // 0x00a3 has no price
  assert.equal(r.totals.volume24hUsd, null); // nothing indexed, so unknown rather than 0
});

test('a fully priced factory list without the explorer is complete', () => {
  const r = mergeQuainance({
    ...base,
    factoryTotal: 3,
    analysis: ['0x00a1', '0x00a2', '0x00a3'].map(pair => ({ pair, tvlUsd: 1 }) as any)
  });
  assert.equal(r.totals.tvlUsd, 3);
  assert.equal(r.totals.tvlComplete, true);
});

test('a pair the factory has but the read missed makes the total incomplete', () => {
  const r = mergeQuainance({ ...base, factoryTotal: 5, analysis: ['0x00a1', '0x00a2', '0x00a3'].map(pair => ({ pair, tvlUsd: 1 }) as any) });
  assert.equal(r.totals.pairs, 5);
  assert.equal(r.totals.loaded, 3);
  assert.equal(r.totals.tvlComplete, false);
});

test('a token with no symbol is shown by a short address, never as an empty name', () => {
  const r = mergeQuainance({ ...base, snapshots: [snap('0x00b1', 0, tok(QOWBOY, ''), tok(WQUAI, 'WQUAI'))] });
  assert.match(r.pools[0].name, /^0x0000…0004 \/ WQUAI$/);
});

test('stale explorer data is flagged', () => {
  const r = mergeQuainance({ ...base, explorer: { ...explorer([]), stale: true } });
  assert.equal(r.source.explorerStale, true);
});

// ---------------------------------------------------------------------------------------------- launchpad catalog

const QAXE = '0x0035187a7660f595d93cd53a4d16c635d6cffc8f';
const NUU = '0x00000a887260f89ae2a5a2d10054d5555f1bc547';
const POOLED = '0x00033a4d7dcb5559e96245a90dbe6f858e10e8bc';

const launch = (over: Record<string, unknown> = {}) => ({
  id: `HARTII:0x001af1bbb40807fcb99c9eeaa49df5e91e7efd42:${NUU}`,
  source: 'HARTII',
  sourceContract: '0x001af1bbb40807fcb99c9eeaa49df5e91e7efd42',
  token: NUU,
  curveAddress: '0x006363b4f09318b2bcc50f9ff169060ef0f0f6bf',
  creator: '0x002e9cc322834beb0608d47e03d8d0b3ab3144eb',
  tokenName: 'nuu',
  tokenSymbol: 'NUU',
  tokenDecimals: '18',
  totalSupply: '1000000000000000000000000000',
  phase: 'BONDING',
  latestPriceQuoteE12: '15766428',
  buyCount: '9',
  sellCount: '5',
  buyQuoteAmount: '4381265303648779259537',
  sellQuoteAmount: '4294034941179091359856',
  createdAtTimestamp: '1790459575',
  launchedAtTimestamp: null,
  pair: null,
  ...over
});
const qaxe = () =>
  launch({
    id: `HARTII:0x001af1bbb40807fcb99c9eeaa49df5e91e7efd42:${QAXE}`,
    token: QAXE,
    tokenName: 'QuaiAxe',
    tokenSymbol: 'QAXE',
    phase: 'GRADUATED',
    latestPriceQuoteE12: '2388766463',
    buyCount: '458',
    sellCount: '126',
    buyQuoteAmount: '748385943288558076267567',
    sellQuoteAmount: '588503605779020175656835',
    curveAddress: '0x004bc407903a51506bcf0b1ab423958c5991c237'
  });

test('parseCatalog reads a Hartii launch: QAXE, graduated, no AMM pair', () => {
  const { launches, skipped } = parseCatalog({ data: { tradeLaunches: [qaxe()] } });
  assert.equal(skipped, 0);
  const q = launches[0];
  assert.equal(q.symbol, 'QAXE');
  assert.equal(q.name, 'QuaiAxe');
  assert.equal(q.source, 'HARTII');
  assert.equal(q.phase, 'GRADUATED');
  assert.equal(q.priceE12, 2388766463n);
  assert.equal(q.buyCount + q.sellCount, 584);
  assert.equal(q.pair, null);
  assert.equal(q.curve, '0x004bc407903a51506bcf0b1ab423958c5991c237');
});

test('parseCatalog accepts the bare array and reports the indexed block', () => {
  assert.equal(parseCatalog([launch()]).launches.length, 1);
  const withMeta = parseCatalog({ data: { tradeLaunches: [launch()], _meta: { block: { number: 10580702 } } } });
  assert.equal(withMeta.block, 10580702);
});

test('parseCatalog drops what it cannot trust and counts it', () => {
  const r = parseCatalog({
    data: {
      tradeLaunches: [
        launch(),
        launch({ token: '0x1234' }), // not an address
        launch({ token: '0x11' + 'a'.repeat(38) }), // another shard
        launch({ tokenSymbol: null }),
        launch({ tokenSymbol: '<script>' }), // markup is not a symbol
        launch({ tokenDecimals: '99' }),
        launch({ source: '' }),
        null
      ]
    }
  });
  assert.equal(r.launches.length, 1);
  assert.equal(r.skipped, 7);
});

test('parseCatalog strips markup and control characters from names, and survives garbage numbers', () => {
  const r = parseCatalog([launch({ tokenName: '<b>Evil</b> Coin', latestPriceQuoteE12: 'not a number', buyCount: -3, totalSupply: '1e30' })]);
  const l = r.launches[0];
  assert.equal(l.name, 'bEvil/b Coin');
  assert.equal(l.priceE12, null);
  assert.equal(l.buyCount, 0);
  assert.equal(l.totalSupply, 0n);
});

test('real-world symbols with a leading $ or an inner space are kept (they exist in the live catalog)', () => {
  const r = parseCatalog([launch({ tokenSymbol: '$NOW' }), launch({ tokenSymbol: 'IMRAN KHAN ' }), launch({ tokenSymbol: 'a'.repeat(17) })]);
  assert.deepEqual(r.launches.map(l => l.symbol), ['$NOW', 'IMRAN KHAN']);
  assert.equal(r.skipped, 1);
});

test('an unknown phase is kept as UNKNOWN rather than guessed', () => {
  assert.equal(parseCatalog([launch({ phase: 'WHATEVER' })]).launches[0].phase, 'UNKNOWN');
});

test('launchpad markets are aggregated next to the pairs: Hartii and QAXE included, priced in QUAI', () => {
  const { launches } = parseCatalog([launch(), qaxe()]);
  const r = mergeQuainance({ ...base, launches });
  assert.equal(r.totals.markets, 2);
  assert.deepEqual(r.totals.marketsBySource, { HARTII: 2 });
  const q = r.markets.find(m => m.token.symbol === 'QAXE')!;
  assert.equal(q.source, 'HARTII');
  assert.equal(q.phase, 'GRADUATED');
  assert.ok(Math.abs(q.priceQuai! - 0.002388766463) < 1e-12);
  assert.ok(Math.abs(q.marketCapQuai! - 0.002388766463 * 1e9) < 1e-3);
  assert.equal(q.trades, 584);
  assert.ok(Math.abs(q.volumeQuai - (748385.943288558 + 588503.605779020)) < 1e-3);
  assert.equal(q.pair, null);
  assert.equal(r.source.catalog, true);
});

test('markets are busiest first', () => {
  const r = mergeQuainance({ ...base, launches: parseCatalog([launch(), qaxe()]).launches });
  assert.deepEqual(r.markets.map(m => m.token.symbol), ['QAXE', 'NUU']);
});

test('a launch that graduated into a pair the factory list already has is shown once, as the pair', () => {
  const pooled = launch({
    token: POOLED,
    tokenSymbol: 'SMOL',
    source: 'QUAINANCE_LAUNCHER',
    phase: 'POOLED',
    pair: { address: '0x00a1', token0: POOLED, token1: WQUAI, reserve0: '5', reserve1: '6' }
  });
  // 0x00a1 is not a valid Cyprus-1 pair address for the parser (too short), so use a full one that matches a snapshot
  const full = '0x00' + 'a1'.repeat(19);
  const withPair = { ...pooled, pair: { ...(pooled as any).pair, address: full } };
  const snapshots = [snap(full, 0, tok(WQI, 'WQI'), tok(WQUAI, 'WQUAI'))];
  const r = mergeQuainance({ ...base, snapshots, launches: parseCatalog([withPair, launch()]).launches });
  assert.equal(r.pools.length, 1);
  assert.deepEqual(r.markets.map(m => m.token.symbol), ['NUU']);
});

test('a pooled launch whose pair the factory read missed stays in the markets, with its pair noted', () => {
  const full = '0x00' + 'b2'.repeat(19);
  const pooled = launch({ token: POOLED, tokenSymbol: 'SMOL', source: 'QUAINANCE_LAUNCHER', phase: 'POOLED', pair: { address: full, token0: POOLED, token1: WQUAI, reserve0: '5', reserve1: '6' } });
  const r = mergeQuainance({ ...base, launches: parseCatalog([pooled]).launches });
  assert.equal(r.markets.length, 1);
  assert.equal(r.markets[0].pair, full);
});

test('without a catalog there are no markets and the source says so, never an invented list', () => {
  const r = mergeQuainance(base);
  assert.deepEqual(r.markets, []);
  assert.equal(r.source.catalog, false);
});

test('a market is listed when its token is in the token list', () => {
  const r = mergeQuainance({ ...base, launches: parseCatalog([launch({ token: WQI.replace('0x00000000', '0x00000000'), tokenSymbol: 'WQI2' })]).launches, isListed: a => a === '0x0000000000000000000000000000000000000002' });
  // the address above is not a Cyprus-1 (0x00...) 20-byte pattern with 38 hex chars after 0x00? it is: 0x00 + 38 chars
  assert.equal(r.markets.length, 1);
});
