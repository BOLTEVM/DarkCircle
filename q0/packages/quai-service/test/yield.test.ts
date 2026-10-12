// LP yield maths: fee APR from real swaps, farm reward APR (actual and projected). Run:
//   node --test packages/quai-service/test/yield.test.ts   (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWAP_TOPIC,
  THIN_LIQUIDITY_USD,
  assumedWeightOf,
  buildYieldRows,
  decodeSwapLogs,
  feeApr,
  projectReward,
  tokenPricesUsd,
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
