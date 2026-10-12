// LP yield maths: fee APR from real swaps, farm reward APR (actual and projected). Run:
//   node --test packages/quai-service/test/yield.test.ts   (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXAMPLE_STAKE_USD,
  SWAP_TOPIC,
  THIN_LIQUIDITY_USD,
  assumedWeightOf,
  buildSingleStakeYields,
  buildYieldRows,
  decodeSwapLogs,
  nextMarketSnapshot,
  feeApr,
  projectReward,
  tokenMarket,
  tokenMarketView,
  tokenPricesUsd,
  type MarketRound,
  type MarketSnapshot,
  type YieldFarmInput
} from '../src/yield.ts';

const E18 = 10n ** 18n;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const swapLog = (address: string, a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint) => ({
  address,
  topics: [SWAP_TOPIC, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32)],
  data: '0x' + word(a0In) + word(a1In) + word(a0Out) + word(a1Out)
});

const PAIR_A = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
const PAIR_B = '0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const T_BDELTA = '0x002d4a4fbac3df3342ed17fdba5139818a43b508';
const T_Q0 = '0x00325150094e51107a931980fdfc3bb1a4c48379';
const T_WQUAI = '0x0000000000000000000000000000000000000001';

// 1 BDELTA = 0.5 QUAI, QUAI = $1
const analysis = (pair: string, tvlUsd: number | null, over: Record<string, unknown> = {}) =>
  ({
    pair,
    dex: 'CIRCLESWAP',
    token0: { address: T_BDELTA, symbol: 'BDELTA', decimals: 18 },
    token1: { address: T_WQUAI, symbol: 'WQUAI', decimals: 18 },
    price0Quai: 0.5,
    price1Quai: 1,
    tvlUsd,
    totalSupply: 100n * E18,
    ...over
  }) as any;

const farm = (over: Partial<YieldFarmInput> = {}): YieldFarmInput => ({
  rewardAPerSecond: E18 / 100n, // 0.01 BDELTA/s
  rewardBPerSecond: 0n,
  totalAllocPoint: 0n,
  boostBps: 5000n,
  pools: [],
  decimalsA: 18,
  decimalsB: 18,
  priceUsdA: 0.5,
  priceUsdB: 0.1,
  ...over
});

const FEES = { CIRCLESWAP: 30, QUAISWAP: 30, QUAINANCE: 30 };
const WEEK = 7 * 86_400;

test('decodeSwapLogs sums volume per pair, counts swaps and ignores foreign or malformed logs', () => {
  const m = decodeSwapLogs([
    swapLog(PAIR_A, 10n * E18, 0n, 0n, 4n * E18),
    swapLog(PAIR_A, 0n, 6n * E18, 2n * E18, 0n),
    swapLog(PAIR_B.toUpperCase().replace('0X', '0x'), 1n, 0n, 0n, 1n),
    { ...swapLog(PAIR_A, 99n, 99n, 99n, 99n), topics: ['0x1234'] },
    { ...swapLog(PAIR_A, 1n, 1n, 1n, 1n), data: '0x1234' },
    null
  ]);
  const a = m.get(PAIR_A)!;
  assert.equal(a.swaps, 2);
  assert.equal(a.volume0, 12n * E18);
  assert.equal(a.volume1, 10n * E18);
  assert.equal(m.get(PAIR_B)!.swaps, 1);
  assert.equal(m.size, 2);
});

test('feeApr annualises from the window actually measured', () => {
  // $1,000 volume in a week, 0.3% fee, $1,000 liquidity: 3 per week -> 156.4 per year -> 15.64%
  const r = feeApr({ volumeUsd: 1000, windowSeconds: WEEK, liquidityUsd: 1000, lpFeeBps: 30 })!;
  assert.ok(Math.abs(r - 15.6429) < 0.001);
  // a window twice as long with the same volume is half the rate
  assert.ok(Math.abs(feeApr({ volumeUsd: 1000, windowSeconds: 2 * WEEK, liquidityUsd: 1000, lpFeeBps: 30 })! - r / 2) < 1e-9);
});

test('feeApr: no swaps is 0%, unknown inputs are null (never 0)', () => {
  assert.equal(feeApr({ volumeUsd: 0, windowSeconds: WEEK, liquidityUsd: 500, lpFeeBps: 30 }), 0);
  assert.equal(feeApr({ volumeUsd: null, windowSeconds: WEEK, liquidityUsd: 500, lpFeeBps: 30 }), null);
  assert.equal(feeApr({ volumeUsd: 10, windowSeconds: WEEK, liquidityUsd: null, lpFeeBps: 30 }), null);
  assert.equal(feeApr({ volumeUsd: 10, windowSeconds: WEEK, liquidityUsd: 0, lpFeeBps: 30 }), null);
  assert.equal(feeApr({ volumeUsd: 10, windowSeconds: 0, liquidityUsd: 100, lpFeeBps: 30 }), null);
});

test('a pool the farm has not added is projected, with its share assumed, and says so', () => {
  const r = projectReward(farm(), PAIR_A, 1000, null, 1, 100n);
  assert.equal(r.status, 'NOT_FARMING');
  assert.equal(r.pid, null);
  assert.equal(r.sharePct, 100); // the only advertised pool
  assert.equal(r.projected, true);
  assert.equal(r.basis, 'if-fully-staked');
  // 0.01 BDELTA/s * 86400 * $0.5 = $432/day; 365 days over $1,000 liquidity
  assert.ok(Math.abs(r.dailyUsd! - 432) < 1e-6);
  assert.ok(Math.abs(r.apr! - (432 * 365 / 1000) * 100) < 1e-6);
  assert.ok(Math.abs(r.aprBoosted! - r.apr! * 1.5) < 1e-6);
});

test('projected shares add up: unfarmed pools join together at the assumed weight', () => {
  const r = projectReward(farm({ totalAllocPoint: 300n, pools: [{ pid: 0, lpToken: PAIR_B, allocPoint: 300n, totalStaked: 0n }] }), PAIR_A, 1000, null, 2, 100n);
  // total after = 300 + 2*100 = 500; this pool gets 100 of 500
  assert.equal(r.sharePct, 20);
});

test('a farmed pool uses its real share; with nobody staked the APR is measured on its full liquidity and marked projected', () => {
  const f = farm({ totalAllocPoint: 400n, pools: [{ pid: 3, lpToken: PAIR_A, allocPoint: 100n, totalStaked: 0n }] });
  const r = projectReward(f, PAIR_A, 2000, 0, 0, 100n);
  assert.equal(r.status, 'FARMING');
  assert.equal(r.pid, 3);
  assert.equal(r.sharePct, 25);
  assert.equal(r.basis, 'if-fully-staked');
  assert.equal(r.projected, true);
});

test('a farmed pool with stake is measured on the staked value and is not a projection', () => {
  const f = farm({ totalAllocPoint: 100n, pools: [{ pid: 0, lpToken: PAIR_A, allocPoint: 100n, totalStaked: 10n * E18 }] });
  const r = projectReward(f, PAIR_A, 1000, 100, 0, 100n);
  assert.equal(r.basis, 'staked');
  assert.equal(r.projected, false);
  assert.ok(Math.abs(r.apr! - (432 * 365 / 100) * 100) < 1e-6);
});

test('an emitted reward with no price makes the value unknown, not understated', () => {
  const f = farm({ rewardBPerSecond: E18, priceUsdB: undefined });
  const r = projectReward(f, PAIR_A, 1000, null, 1, 100n);
  assert.equal(r.dailyUsd, null);
  assert.equal(r.apr, null);
});

test('no farm means no reward projection', () => {
  const r = projectReward(null, PAIR_A, 1000, null, 1, 100n);
  assert.equal(r.status, 'NO_FARM');
  assert.equal(r.apr, null);
});

test('a farm with zero emission projects 0%, not unknown', () => {
  const r = projectReward(farm({ rewardAPerSecond: 0n, rewardBPerSecond: 0n }), PAIR_A, 1000, null, 1, 100n);
  assert.equal(r.apr, 0);
});

test('assumedWeightOf: the farm average, or 100 for an empty farm', () => {
  assert.equal(assumedWeightOf(null), 100n);
  assert.equal(assumedWeightOf(farm()), 100n);
  assert.equal(assumedWeightOf(farm({ totalAllocPoint: 600n, pools: [1, 2, 3].map(i => ({ pid: i, lpToken: `0x00${i}`, allocPoint: 200n, totalStaked: 0n })) })), 200n);
});

test('the board: fee + projected reward per pool, best first, thin pools flagged', () => {
  const volumes = decodeSwapLogs([swapLog(PAIR_A, 200n * E18, 0n, 0n, 100n * E18)]); // 200 BDELTA = $100 (0.5 QUAI at $1)
  const rows = buildYieldRows({
    analyses: [analysis(PAIR_A, 5000), analysis(PAIR_B, 400)],
    volumes,
    windowSeconds: WEEK,
    quaiUsd: 1,
    farm: farm(),
    lpFeeBps: FEES
  });
  const a = rows.find(r => r.pair === PAIR_A)!;
  const b = rows.find(r => r.pair === PAIR_B)!;
  assert.ok(Math.abs(a.volumeUsd! - 100) < 1e-9);
  assert.equal(a.swaps, 1);
  // 100 USD/week * 0.3% = 0.3/week = 15.64/year over $5,000 = 0.3129%
  assert.ok(Math.abs(a.feeApr! - (0.3 * 52.1428571 / 5000) * 100) < 0.01);
  assert.equal(a.thin, false);
  assert.equal(b.feeApr, 0); // priced liquidity, no swaps in the window: 0, not unknown
  assert.equal(b.thin, true);
  assert.ok(b.liquidityUsd! < THIN_LIQUIDITY_USD);
  assert.equal(a.reward.status, 'NOT_FARMING');
  // two unfarmed pools share 100%: 50% each at the 100 default weight
  assert.equal(a.reward.sharePct, 50);
  // best total first: B has the smaller liquidity, so the same reward share is a bigger rate
  assert.equal(rows[0].pair, PAIR_B);
  assert.ok(a.totalApr! > a.feeApr!);
  assert.ok(a.totalAprBoosted! > a.totalApr!);
});

test('an unpriced pool is unknown and sorts last, never 0%', () => {
  const rows = buildYieldRows({
    analyses: [analysis(PAIR_A, null, { price0Quai: null, price1Quai: null }), analysis(PAIR_B, 400)],
    volumes: new Map(),
    windowSeconds: WEEK,
    quaiUsd: 1,
    farm: farm(),
    lpFeeBps: FEES
  });
  const unpriced = rows.find(r => r.pair === PAIR_A)!;
  assert.equal(unpriced.liquidityUsd, null);
  assert.equal(unpriced.feeApr, null);
  assert.equal(unpriced.totalApr, null);
  assert.equal(rows[rows.length - 1].pair, PAIR_A);
});

test('swap history not read yet is unknown fee yield, not 0%, and rewards still show', () => {
  const rows = buildYieldRows({ analyses: [analysis(PAIR_A, 5000)], volumes: null, windowSeconds: WEEK, quaiUsd: 1, farm: farm(), lpFeeBps: FEES });
  assert.equal(rows[0].volumeUsd, null);
  assert.equal(rows[0].feeApr, null);
  assert.ok(rows[0].reward.apr! > 0);
  assert.equal(rows[0].totalApr, rows[0].reward.apr); // only the known part is summed
});

test('tokenPricesUsd takes each token from its deepest pool', () => {
  const m = tokenPricesUsd(
    [analysis(PAIR_A, 100, { price0Quai: 0.9 }), analysis(PAIR_B, 5000, { price0Quai: 0.5 })],
    2
  );
  assert.equal(m.get(T_BDELTA), 1); // 0.5 QUAI * $2, from the $5,000 pool
  assert.equal(m.get(T_WQUAI), 2);
  assert.equal(tokenPricesUsd([analysis(PAIR_A, 100)], null).size, 0);
});

test('tokenMarket: a token the explorer has not priced is priced from the pools, and its cap is price x supply', () => {
  const m = tokenMarket({ explorerPriceUsd: null, explorerMarketCapUsd: null, poolPriceUsd: 12.5, supply: 1 });
  assert.deepEqual(m, { priceUsd: 12.5, priceSource: 'pools', marketCapUsd: 12.5, marketCapSource: 'supply' });
});

test('tokenMarket: the explorer figures win when it has them', () => {
  const m = tokenMarket({ explorerPriceUsd: 0.5, explorerMarketCapUsd: 1000, poolPriceUsd: 0.6, supply: 5000 });
  assert.deepEqual(m, { priceUsd: 0.5, priceSource: 'explorer', marketCapUsd: 1000, marketCapSource: 'explorer' });
});

test('tokenMarket: an explorer price without a cap gets price x supply, still labelled', () => {
  const m = tokenMarket({ explorerPriceUsd: 2, explorerMarketCapUsd: null, supply: 10 });
  assert.equal(m.priceSource, 'explorer');
  assert.equal(m.marketCapUsd, 20);
  assert.equal(m.marketCapSource, 'supply');
});

test('tokenMarket: no price or no supply means no market cap, never 0', () => {
  assert.deepEqual(tokenMarket({}), { priceUsd: null, priceSource: null, marketCapUsd: null, marketCapSource: null });
  assert.equal(tokenMarket({ poolPriceUsd: 3 }).marketCapUsd, null); // price but unknown supply
  assert.equal(tokenMarket({ supply: 10 }).marketCapUsd, null); // supply but no price
  assert.equal(tokenMarket({ poolPriceUsd: 0, explorerPriceUsd: 0, supply: 10 }).priceUsd, null);
  assert.equal(tokenMarket({ poolPriceUsd: Number.NaN, supply: 10 }).priceUsd, null);
});


// ---- single-token pools --------------------------------------------------------------------------------------------

const TOKEN_Q0 = { token: T_Q0, symbol: 'Q0', priceUsd: 0.1 as number | null, supply: 1_000_000 as number | null, stakedUsd: null as number | null };
const TOKEN_BD = { token: T_BDELTA, symbol: 'BDELTA', priceUsd: 0.5 as number | null, supply: 100_000 as number | null, stakedUsd: null as number | null };

test('single-token pools use projectReward: an unfarmed token gets the assumed share and is a projection', () => {
  // empty farm, two tokens waiting, no LP waiting: each gets 100 of 200
  const rows = buildSingleStakeYields({ farm: farm(), tokens: [TOKEN_Q0, TOKEN_BD], otherUnfarmed: 0 });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.reward.status, 'NOT_FARMING');
    assert.equal(r.reward.sharePct, 50);
    assert.equal(r.reward.projected, true);
    assert.equal(r.reward.basis, 'if-fully-staked');
  }
  // the whole farm: 0.01 BDELTA/s * 86400 * $0.5 = $432/day; half of it is this pool's
  const q0 = rows[0];
  assert.ok(Math.abs(q0.reward.dailyUsd! - 216) < 1e-6);
  assert.ok(Math.abs(q0.yearlyUsd! - 216 * 365) < 1e-6);
  // measured against the token's whole supply (1,000,000 Q0 * $0.1): the floor
  assert.equal(q0.supplyUsd, 100_000);
  assert.ok(Math.abs(q0.reward.apr! - ((216 * 365) / 100_000) * 100) < 1e-6);
  // an example deposit, alone: $216 a day on $1,000
  assert.ok(Math.abs(q0.exampleApr! - ((216 * 365) / EXAMPLE_STAKE_USD) * 100) < 1e-6);
  assert.ok(Math.abs(q0.exampleAprBoosted! - q0.exampleApr! * 1.5) < 1e-6);
  // tokens per day at that share
  assert.ok(Math.abs(q0.dailyA! - 0.01 * 86_400 * 0.5) < 1e-9);
  assert.equal(q0.dailyB, 0); // B is not emitted in this fixture
});

test('single-token shares assume the same thing the pairs do: everything not in the farm joins together', () => {
  // 3 LP pools also waiting + 2 tokens = 5 pools at 100 each
  const rows = buildSingleStakeYields({ farm: farm(), tokens: [TOKEN_Q0, TOKEN_BD], otherUnfarmed: 3 });
  assert.equal(rows[0].reward.sharePct, 20);
  // and the pairs on the board count the tokens too, so their shares come out the same 20%
  const board = buildYieldRows({
    analyses: [analysis(PAIR_A, 1000), analysis(PAIR_B, 1000), analysis('0x00cccccccccccccccccccccccccccccccccccc03', 1000)],
    volumes: null,
    windowSeconds: WEEK,
    quaiUsd: 1,
    farm: farm(),
    lpFeeBps: FEES,
    extraUnfarmed: 2
  });
  for (const row of board) assert.equal(row.reward.sharePct, 20);
});

test('extraUnfarmed defaults to nothing and changes no existing share', () => {
  const base = { analyses: [analysis(PAIR_A, 1000)], volumes: null, windowSeconds: WEEK, quaiUsd: 1, farm: farm(), lpFeeBps: FEES };
  assert.equal(buildYieldRows(base)[0].reward.sharePct, 100);
  assert.equal(buildYieldRows({ ...base, extraUnfarmed: 0 })[0].reward.sharePct, 100);
  assert.equal(buildYieldRows({ ...base, extraUnfarmed: 1 })[0].reward.sharePct, 50);
});

test('a single-token pool already in the farm uses its real share and what is staked', () => {
  const f = farm({
    totalAllocPoint: 300n,
    pools: [
      { pid: 0, lpToken: PAIR_A, allocPoint: 200n, totalStaked: 0n },
      { pid: 1, lpToken: T_Q0, allocPoint: 100n, totalStaked: 500n * E18 }
    ]
  });
  const [r] = buildSingleStakeYields({ farm: f, tokens: [{ ...TOKEN_Q0, stakedUsd: 50 }], otherUnfarmed: 0 });
  assert.equal(r.reward.status, 'FARMING');
  assert.equal(r.reward.pid, 1);
  assert.ok(Math.abs(r.reward.sharePct! - 100 / 3) < 1e-3);
  assert.equal(r.reward.basis, 'staked');
  assert.equal(r.reward.projected, false);
});

test('single-token pool: an unpriced token or an unreadable supply leaves the APR unknown, never 0 or infinite', () => {
  const noPrice = buildSingleStakeYields({ farm: farm(), tokens: [{ ...TOKEN_Q0, priceUsd: null }], otherUnfarmed: 0 })[0];
  assert.equal(noPrice.supplyUsd, null);
  assert.equal(noPrice.reward.apr, null);
  // the pool's own reward value does not depend on the staked token's price
  assert.ok(noPrice.yearlyUsd! > 0);
  const noSupply = buildSingleStakeYields({ farm: farm(), tokens: [{ ...TOKEN_Q0, supply: null }], otherUnfarmed: 0 })[0];
  assert.equal(noSupply.supplyUsd, null);
  assert.equal(noSupply.reward.apr, null);
  assert.equal(buildSingleStakeYields({ farm: farm(), tokens: [{ ...TOKEN_Q0, supply: 0 }], otherUnfarmed: 0 })[0].supplyUsd, null);
});

test('single-token pool: no farm means no projection at all', () => {
  const [r] = buildSingleStakeYields({ farm: null, tokens: [TOKEN_Q0], otherUnfarmed: 0 });
  assert.equal(r.reward.status, 'NO_FARM');
  assert.equal(r.yearlyUsd, null);
  assert.equal(r.exampleApr, null);
  assert.equal(r.dailyA, null);
});

test('single-token pool: an emitted reward with no price makes the pool value unknown', () => {
  const [r] = buildSingleStakeYields({ farm: farm({ rewardBPerSecond: E18, priceUsdB: undefined }), tokens: [TOKEN_Q0], otherUnfarmed: 0 });
  assert.equal(r.yearlyUsd, null);
  assert.equal(r.exampleApr, null);
});

// ---- a token's market over time (the QRB page polls this) ---------------------------------------------------------------

const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  explorerPriceUsd: null,
  explorerMarketCapUsd: null,
  supply: 1,
  poolPriceUsd: null,
  explorerAt: null,
  poolsAt: null,
  failed: [],
  ...over
});

test('tokenMarket: NaN, Infinity, zero and negative figures are not prices, so nothing is invented from them', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1];
  for (const v of bad) {
    const m = tokenMarket({ explorerPriceUsd: v, explorerMarketCapUsd: v, poolPriceUsd: v, supply: 1 });
    assert.deepEqual(m, { priceUsd: null, priceSource: null, marketCapUsd: null, marketCapSource: null });
  }
});

test('tokenMarket: a bad explorer price falls through to the pools; an explorer cap still wins', () => {
  const m = tokenMarket({ explorerPriceUsd: Number.NaN, explorerMarketCapUsd: 500, poolPriceUsd: 2, supply: 1 });
  assert.equal(m.priceUsd, 2);
  assert.equal(m.priceSource, 'pools');
  assert.equal(m.marketCapUsd, 500);
  assert.equal(m.marketCapSource, 'explorer');
});

test('tokenMarket: an unknown or empty supply gives no market cap rather than 0', () => {
  assert.equal(tokenMarket({ poolPriceUsd: 5, supply: 0 }).marketCapUsd, null);
  assert.equal(tokenMarket({ poolPriceUsd: 5, supply: null }).marketCapUsd, null);
  assert.equal(tokenMarket({ poolPriceUsd: 5 }).marketCapUsd, null);
});

test('market view: nothing read yet is all unknown and nothing is degraded', () => {
  const v = tokenMarketView(null);
  assert.equal(v.priceUsd, null);
  assert.equal(v.marketCapUsd, null);
  assert.equal(v.asOf, null);
  assert.equal(v.degraded, false);
  assert.deepEqual(v.usedSources, []);
});

test('market view: a token only the pools price (QRB) is dated by the pools read', () => {
  const v = tokenMarketView(snap({ poolPriceUsd: 4, supply: 1, poolsAt: 5_000, explorerAt: 1_000 }));
  assert.equal(v.priceUsd, 4);
  assert.equal(v.priceSource, 'pools');
  assert.equal(v.marketCapUsd, 4);
  assert.equal(v.marketCapSource, 'supply');
  assert.deepEqual(v.usedSources, ['pools']);
  assert.equal(v.asOf, 5_000, 'the explorer read, which supplied no figure, does not make it look fresher or older');
});

test('market view: explorer figures are dated by the explorer read', () => {
  const v = tokenMarketView(snap({ explorerPriceUsd: 3, explorerMarketCapUsd: 90, poolPriceUsd: 4, poolsAt: 9_000, explorerAt: 2_000 }));
  assert.equal(v.priceSource, 'explorer');
  assert.equal(v.marketCapSource, 'explorer');
  assert.deepEqual(v.usedSources, ['explorer']);
  assert.equal(v.asOf, 2_000);
});

test('market view: a pool price with an explorer cap is as old as the older of the two reads', () => {
  const v = tokenMarketView(snap({ explorerMarketCapUsd: 90, poolPriceUsd: 4, poolsAt: 9_000, explorerAt: 2_000 }));
  assert.equal(v.priceSource, 'pools');
  assert.equal(v.marketCapSource, 'explorer');
  assert.equal(v.usedSources.length, 2);
  assert.equal(v.asOf, 2_000);
});

test('market view: it is degraded only when a source behind a shown number failed in the latest round', () => {
  const pools = snap({ poolPriceUsd: 4, poolsAt: 9_000, failed: ['pools'] });
  assert.equal(tokenMarketView(pools).degraded, true, 'the pool price is a held value');
  assert.equal(tokenMarketView({ ...pools, failed: ['explorer'] }).degraded, false, 'the explorer failing does not touch a pool price');
  const explorer = snap({ explorerPriceUsd: 3, explorerAt: 1_000, failed: ['pools'] });
  assert.equal(tokenMarketView(explorer).degraded, false);
});

test('market view: a used source that was never read has no date, and no price means nothing is dated', () => {
  assert.equal(tokenMarketView(snap({ poolPriceUsd: 4, poolsAt: null })).asOf, null);
  const none = tokenMarketView(snap({ poolsAt: 5_000, explorerAt: 5_000 }));
  assert.equal(none.priceUsd, null);
  assert.equal(none.asOf, null);
  assert.equal(none.degraded, false);
});

// ---- folding one polling round into the held snapshot ----------------------------------------------------------------

const ok = (over: Partial<Extract<MarketRound['explorer'], { ok: true }>> = {}): MarketRound['explorer'] => ({
  ok: true,
  priceUsd: null,
  marketCapUsd: null,
  supply: 1,
  at: 100,
  failedLatest: false,
  ...over
});

test('round: both sources answer, so everything is replaced and dated', () => {
  const s1 = nextMarketSnapshot(null, { explorer: ok({ priceUsd: 3, marketCapUsd: 3, at: 100 }), pools: { ok: true, priceUsd: 4, at: 200 } })!;
  assert.equal(s1.explorerPriceUsd, 3);
  assert.equal(s1.explorerMarketCapUsd, 3);
  assert.equal(s1.supply, 1);
  assert.equal(s1.poolPriceUsd, 4);
  assert.equal(s1.explorerAt, 100);
  assert.equal(s1.poolsAt, 200);
  assert.deepEqual(s1.failed, []);
});

test('round: a failing pool read keeps the last pool price and the time it was read, and is listed', () => {
  const held = nextMarketSnapshot(null, { explorer: ok(), pools: { ok: true, priceUsd: 4, at: 200 } })!;
  const next = nextMarketSnapshot(held, { explorer: ok({ at: 300 }), pools: { ok: false } })!;
  assert.equal(next.poolPriceUsd, 4, 'not blanked');
  assert.equal(next.poolsAt, 200, 'and not re-dated');
  assert.equal(next.explorerAt, 300);
  assert.deepEqual(next.failed, ['pools']);
});

test('round: a failing explorer keeps its figures and time; a failed latest attempt is flagged even when the cache answered', () => {
  const held = nextMarketSnapshot(null, { explorer: ok({ priceUsd: 3, at: 100 }), pools: { ok: true, priceUsd: 4, at: 200 } })!;
  const down = nextMarketSnapshot(held, { explorer: { ok: false }, pools: { ok: true, priceUsd: 5, at: 400 } })!;
  assert.equal(down.explorerPriceUsd, 3);
  assert.equal(down.explorerAt, 100);
  assert.equal(down.poolPriceUsd, 5);
  assert.deepEqual(down.failed, ['explorer']);

  const cooled = nextMarketSnapshot(held, { explorer: ok({ priceUsd: 3, at: 100, failedLatest: true }), pools: { ok: true, priceUsd: 5, at: 400 } })!;
  assert.deepEqual(cooled.failed, ['explorer']);
  assert.equal(cooled.explorerAt, 100);
});

test('round: when no source answered nothing was learned, so it is a failed poll (null), never a blank snapshot', () => {
  const held = nextMarketSnapshot(null, { explorer: ok({ priceUsd: 3 }), pools: { ok: true, priceUsd: 4, at: 200 } })!;
  assert.equal(nextMarketSnapshot(held, { explorer: { ok: false }, pools: { ok: false } }), null);
  assert.equal(nextMarketSnapshot(null, { explorer: { ok: false }, pools: { ok: false } }), null);
});

test('round: an unreadable supply keeps the last known one; a price that disappeared from the explorer disappears', () => {
  const held = nextMarketSnapshot(null, { explorer: ok({ priceUsd: 3, supply: 7 }), pools: { ok: true, priceUsd: 4, at: 200 } })!;
  const next = nextMarketSnapshot(held, { explorer: ok({ priceUsd: null, supply: null, at: 500 }), pools: { ok: true, priceUsd: 4, at: 500 } })!;
  assert.equal(next.supply, 7);
  assert.equal(next.explorerPriceUsd, null, 'an explorer that stopped quoting a price is believed');
  // and the view then falls back to the pools, dated by the pools
  const v = tokenMarketView(next);
  assert.equal(v.priceSource, 'pools');
  assert.equal(v.asOf, 500);
});

test('round: a pool that no longer prices the token (price null) replaces the old price: it is a fresh answer, not a failure', () => {
  const held = nextMarketSnapshot(null, { explorer: ok(), pools: { ok: true, priceUsd: 4, at: 200 } })!;
  const next = nextMarketSnapshot(held, { explorer: ok(), pools: { ok: true, priceUsd: null, at: 600 } })!;
  assert.equal(next.poolPriceUsd, null);
  assert.equal(next.poolsAt, 600);
  assert.deepEqual(next.failed, []);
});
