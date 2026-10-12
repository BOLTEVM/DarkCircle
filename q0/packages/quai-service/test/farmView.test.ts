// Unit tests for the Farms page view model: APR and TVL arithmetic, unknown-is-not-zero, units parsing.
// Run: node --test packages/quai-service/test/farmView.test.ts   (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFarmRows,
  earnsLine,
  poolTitle,
  readWalletBalances,
  singleStakeCandidates,
  tryParseUnits,
  ratePerSecondFromDaily,
  runwaySeconds,
  SECONDS_PER_DAY,
  type FarmState,
  type FarmPosition,
  type PairInfo,
  type FarmTokenInfo
} from '../src/farm.ts';
import { formatUnits } from '../src/units.ts';

const A = '0x002d4a4fbac3df3342ed17fdba5139818a43b508'; // reward A
const B = '0x00325150094e51107a931980fdfc3bb1a4c48379'; // reward B
const QRB = '0x0050a7fcb00521b75bb5f3bc8e1d49fed7c08ce5';
const WQUAI = '0x0000000000000000000000000000000000000001';
const LP = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
const SOLO = '0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const E18 = 10n ** 18n;

function farm(over: Partial<FarmState> = {}): FarmState {
  return {
    address: '0x0061bac19852dfa0c4af18d65fcaa9a585e14b86',
    owner: '0x005c0faa361ae7c4a473343ef24bae4d1379e638',
    pendingOwner: null,
    paused: false,
    rewardTokenA: A,
    rewardTokenB: B,
    qrb: QRB,
    rewardAPerSecond: E18 / 1000n, // 0.001 A/s
    rewardBPerSecond: E18 / 100n, // 0.01 B/s
    totalAllocPoint: 300n,
    maxAllocPoint: 10_000n,
    maxEmissionPerSecond: 100n * E18,
    maxBoostBps: 10_000n, // the farm's clamp
    boostBps: 5000n, // what the boost source actually grants
    pools: [
      { pid: 0, lpToken: LP, allocPoint: 200n, lastRewardTime: 0n, accRewardAPerShare: 0n, accRewardBPerShare: 0n, totalStaked: 100n * E18, sharePct: (200 / 300) * 100 },
      { pid: 1, lpToken: SOLO, allocPoint: 100n, lastRewardTime: 0n, accRewardAPerShare: 0n, accRewardBPerShare: 0n, totalStaked: 0n, sharePct: (100 / 300) * 100 }
    ],
    inventoryA: { token: A, balance: 0n, staked: 0n, available: 0n },
    inventoryB: { token: B, balance: 0n, staked: 0n, available: 0n },
    readAt: 0,
    ...over
  };
}

// 1000 WQUAI + 1000 A in a pool of 1000 LP: each LP is worth 2 WQUAI-equivalents
const pair: PairInfo = { lpToken: LP, token0: A, token1: WQUAI, reserve0: 1000n * E18, reserve1: 1000n * E18, totalSupply: 1000n * E18 };
const tokens: Record<string, FarmTokenInfo> = {
  [A]: { symbol: 'BDELTA', decimals: 18, priceUsd: 0.5 },
  [B]: { symbol: 'Q0', decimals: 18, priceUsd: 0.1 },
  [WQUAI]: { symbol: 'WQUAI', decimals: 18, priceUsd: 0.5 },
  [SOLO]: { symbol: 'SOLO', decimals: 6, priceUsd: 2 }
};

test('an LP pool is valued from reserves and prices, and its APR follows from emission and share', () => {
  const { rows, summary } = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens });
  const r = rows[0];
  assert.equal(r.label, 'BDELTA / WQUAI');
  assert.equal(r.kind, 'LP');
  // 100 of 1000 LP * (1000*0.5 + 1000*0.5 = 1000 USD) = 100 USD
  assert.ok(Math.abs(r.tvlUsd! - 100) < 1e-9);
  // pool share 2/3: A = 0.001/s * 31_536_000 * 0.5 USD * 2/3, B = 0.01/s * 31_536_000 * 0.1 USD * 2/3
  const yearlyA = 0.001 * 31_536_000 * 0.5 * (2 / 3);
  const yearlyB = 0.01 * 31_536_000 * 0.1 * (2 / 3);
  assert.ok(Math.abs(r.aprA! - (yearlyA / 100) * 100) < 1e-6);
  assert.ok(Math.abs(r.aprB! - (yearlyB / 100) * 100) < 1e-6);
  assert.ok(Math.abs(r.aprTotal! - (r.aprA! + r.aprB!)) < 1e-9);
  // 50% maximum boost
  assert.ok(Math.abs(r.aprMax! - r.aprTotal! * 1.5) < 1e-9);
  assert.ok(Math.abs(summary.tvlUsd! - 100) < 1e-9);
});

test('an empty pool has no TVL and no APR (unknown, not zero and not infinite)', () => {
  const { rows } = buildFarmRows({ farm: farm(), pairs: {}, tokens });
  const empty = rows[1];
  assert.equal(empty.totalStaked, 0n);
  assert.equal(empty.tvlUsd, undefined);
  assert.equal(empty.aprTotal, undefined);
});

test('a single-asset pool uses the token decimals, not 18', () => {
  const f = farm({ pools: [{ pid: 0, lpToken: SOLO, allocPoint: 100n, lastRewardTime: 0n, accRewardAPerShare: 0n, accRewardBPerShare: 0n, totalStaked: 5_000_000n, sharePct: 100 }] });
  const { rows } = buildFarmRows({ farm: f, pairs: {}, tokens });
  assert.equal(rows[0].kind, 'SINGLE');
  assert.equal(rows[0].label, 'SOLO');
  assert.equal(rows[0].stakeDecimals, 6);
  assert.ok(Math.abs(rows[0].tvlUsd! - 10) < 1e-9); // 5 SOLO * $2
});

test('a missing price makes the dependent numbers undefined rather than wrong', () => {
  const noPrice = { ...tokens, [A]: { symbol: 'BDELTA', decimals: 18 }, [WQUAI]: { symbol: 'WQUAI', decimals: 18 } };
  const { rows, summary } = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens: noPrice });
  // neither side of the pair is priced: no TVL, so no APR
  assert.equal(rows[0].tvlUsd, undefined);
  assert.equal(rows[0].aprTotal, undefined);
  assert.equal(summary.tvlUsd, undefined);
  assert.equal(summary.emissionUsdPerDay, undefined);
});

test('one priced side is enough to value a balanced pool; a boost-less farm has no max APR', () => {
  const oneSide = { ...tokens, [WQUAI]: { symbol: 'WQUAI', decimals: 18 } };
  const { rows } = buildFarmRows({ farm: farm({ qrb: null, boostBps: 0n }), pairs: { [LP]: pair }, tokens: oneSide });
  assert.ok(Math.abs(rows[0].tvlUsd! - 100) < 1e-9); // 2 * the priced side
  assert.equal(rows[0].aprMax, undefined);
});

test('daily emission per pool follows its share', () => {
  const { rows } = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens });
  assert.ok(Math.abs(rows[0].dailyA - 0.001 * SECONDS_PER_DAY * (2 / 3)) < 1e-9);
  assert.ok(Math.abs(rows[1].dailyB - 0.01 * SECONDS_PER_DAY * (1 / 3)) < 1e-9);
});

test('positions: staked value, pending value, and "unknown" when a reward is unpriced', () => {
  const pos: FarmPosition = { pid: 0, staked: 10n * E18, pendingA: 2n * E18, pendingB: 5n * E18, unpaidA: 0n, unpaidB: 0n, walletBalance: 0n, allowance: 0n };
  const { rows, summary } = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens, positions: [pos] });
  assert.ok(Math.abs(rows[0].stakedUsd! - 10) < 1e-9);
  assert.ok(Math.abs(rows[0].pendingUsd! - (2 * 0.5 + 5 * 0.1)) < 1e-9);
  assert.equal(summary.poolsWithStake, 1);
  assert.equal(summary.pendingA, 2);
  assert.equal(summary.pendingB, 5);
  assert.ok(Math.abs(summary.yourStakedUsd! - 10) < 1e-9);

  const unpriced = { ...tokens, [B]: { symbol: 'Q0', decimals: 18 } };
  const again = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens: unpriced, positions: [pos] });
  assert.equal(again.rows[0].pendingUsd, undefined);
  assert.equal(again.summary.yourPendingUsd, undefined);
});

test('a wallet with nothing staked and nothing pending is worth exactly 0, not unknown', () => {
  const pos: FarmPosition = { pid: 0, staked: 0n, pendingA: 0n, pendingB: 0n, unpaidA: 0n, unpaidB: 0n, walletBalance: 7n, allowance: 0n };
  const { rows, summary } = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens, positions: [pos] });
  assert.equal(rows[0].stakedUsd, 0);
  assert.equal(rows[0].pendingUsd, 0);
  assert.equal(summary.yourStakedUsd, 0);
  assert.equal(summary.yourPendingUsd, 0);
});

test('without positions (wallet not connected) nothing user-specific is claimed', () => {
  const { rows, summary } = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens });
  assert.equal(rows[0].position, undefined);
  assert.equal(summary.yourStakedUsd, undefined);
  assert.equal(summary.yourPendingUsd, undefined);
});

test('tryParseUnits: exact, refuses what it cannot represent', () => {
  assert.equal(tryParseUnits('1', 18), E18);
  assert.equal(tryParseUnits('0.5', 18), E18 / 2n);
  assert.equal(tryParseUnits('.5', 6), 500_000n);
  assert.equal(tryParseUnits('12.345678', 6), 12_345_678n);
  assert.equal(tryParseUnits('12.3456789', 6), null); // more places than the token has
  assert.equal(tryParseUnits('', 18), null);
  assert.equal(tryParseUnits('.', 18), null);
  assert.equal(tryParseUnits('-1', 18), null);
  assert.equal(tryParseUnits('1e18', 18), null);
  assert.equal(tryParseUnits('1,5', 18), null);
  assert.equal(tryParseUnits('0x10', 18), null);
});

test('units.formatUnits truncates, never rounds up (so MAX never exceeds the balance)', () => {
  assert.equal(formatUnits(E18, 18), '1');
  assert.equal(formatUnits(1_999_999_999_999_999_999n, 18, 6), '1.999999');
  assert.equal(formatUnits(1n, 18, 6), '0');
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
});

test('ratePerSecondFromDaily converts a daily amount to wei per second', () => {
  assert.equal(ratePerSecondFromDaily('86400', 18), E18);
  assert.equal(ratePerSecondFromDaily('43.2', 18), 500_000_000_000_000n);
  assert.equal(ratePerSecondFromDaily('nope', 18), null);
});

test('runway counts the largest boost and is "never" with no emission', () => {
  assert.equal(runwaySeconds(1000n, 0n), null);
  assert.equal(runwaySeconds(1000n, 10n), 100);
  assert.equal(runwaySeconds(1500n, 10n, 5000n), 100); // burns 15/s at +50%
});

// ---- single-token pools (stake Q0 or BDELTA itself) ------------------------------------------------------------------

const PLAN = [
  { stakeToken: A.toUpperCase().replace('0X', '0x'), symbol: 'BDELTA', allocPoint: 100n },
  { stakeToken: B, symbol: 'Q0', allocPoint: 100n },
  { stakeToken: B.toUpperCase().replace('0X', '0x'), symbol: 'Q0 again', allocPoint: 7n }
];

test('single-token candidates: a planned token the farm has not added is NOT_IN_FARM, one it has is IN_FARM with its real pid', () => {
  const empty = farm({ pools: [], totalAllocPoint: 0n });
  const none = singleStakeCandidates(empty, PLAN);
  assert.deepEqual(none.map(c => [c.symbol, c.state, c.pid]), [['BDELTA', 'NOT_IN_FARM', null], ['Q0', 'NOT_IN_FARM', null]]);
  // added in any position and in any case: found by address, never by the plan's own pid
  const live = farm({
    pools: [
      { pid: 0, lpToken: LP, allocPoint: 200n, lastRewardTime: 0n, accRewardAPerShare: 0n, accRewardBPerShare: 0n, totalStaked: 0n, sharePct: 50 },
      { pid: 1, lpToken: B, allocPoint: 200n, lastRewardTime: 0n, accRewardAPerShare: 0n, accRewardBPerShare: 0n, totalStaked: 0n, sharePct: 50 }
    ]
  });
  const some = singleStakeCandidates(live, PLAN);
  assert.deepEqual(some.map(c => [c.symbol, c.state, c.pid]), [['BDELTA', 'NOT_IN_FARM', null], ['Q0', 'IN_FARM', 1]]);
});

test('single-token candidates: a token listed twice in the plan is one candidate (the first wins)', () => {
  const out = singleStakeCandidates(farm({ pools: [] }), PLAN);
  assert.equal(out.filter(c => c.stakeToken === B).length, 1);
  assert.equal(out.find(c => c.stakeToken === B)!.allocPoint, 100n);
});

test('a single-token pool is titled "Stake Q0" with a plain "Earn BDELTA + Q0" line; a pair keeps its name', () => {
  assert.equal(poolTitle({ kind: 'SINGLE', label: 'Q0' }), 'Stake Q0');
  assert.equal(poolTitle({ kind: 'LP', label: 'BDELTA / WQUAI' }), 'BDELTA / WQUAI');
  assert.equal(earnsLine('BDELTA', 'Q0'), 'Earn BDELTA + Q0');
});

test('a single token whose decimals could not be read is flagged, so no amount of it is scaled by a guess', () => {
  const f2 = farm({ pools: [{ pid: 0, lpToken: SOLO, allocPoint: 100n, lastRewardTime: 0n, accRewardAPerShare: 0n, accRewardBPerShare: 0n, totalStaked: 5n, sharePct: 100 }] });
  const unknown = buildFarmRows({ farm: f2, pairs: {}, tokens: {} }).rows[0];
  assert.equal(unknown.kind, 'SINGLE');
  assert.equal(unknown.stakeDecimalsKnown, false);
  const known = buildFarmRows({ farm: f2, pairs: {}, tokens }).rows[0];
  assert.equal(known.stakeDecimalsKnown, true);
  assert.equal(known.stakeDecimals, 6);
  // an LP's decimals are the AMM's own 18
  const lp = buildFarmRows({ farm: farm(), pairs: { [LP]: pair }, tokens }).rows[0];
  assert.equal(lp.stakeDecimalsKnown, true);
});

test('single-token pool APR: the staked token is valued at its own price, and the yield follows its share', () => {
  const f2 = farm({
    pools: [{ pid: 0, lpToken: A, allocPoint: 100n, lastRewardTime: 0n, accRewardAPerShare: 0n, accRewardBPerShare: 0n, totalStaked: 1000n * E18, sharePct: 100 }],
    totalAllocPoint: 100n
  });
  const { rows } = buildFarmRows({ farm: f2, pairs: {}, tokens });
  const r = rows[0];
  assert.equal(r.kind, 'SINGLE');
  assert.equal(r.label, 'BDELTA');
  assert.ok(Math.abs(r.tvlUsd! - 500) < 1e-9); // 1000 BDELTA * $0.5
  const yearlyA = 0.001 * 31_536_000 * 0.5;
  const yearlyB = 0.01 * 31_536_000 * 0.1;
  assert.ok(Math.abs(r.aprTotal! - ((yearlyA + yearlyB) / 500) * 100) < 1e-6);
});

test('readWalletBalances: one balance per token, an unreadable one is omitted rather than zeroed', async () => {
  const calls: { to: string; data: string }[][] = [];
  const out = await readWalletBalances(
    async c => {
      calls.push(c);
      return ['0x' + (5n * E18).toString(16).padStart(64, '0'), undefined];
    },
    [A, B, A.toUpperCase().replace('0X', '0x')],
    '0x005c0faa361ae7c4a473343ef24bae4d1379e638'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2); // de-duplicated
  assert.equal(out[A], 5n * E18);
  assert.equal(B in out, false);
  assert.deepEqual(await readWalletBalances(async () => [], [], '0x005c0faa361ae7c4a473343ef24bae4d1379e638'), {});
});
