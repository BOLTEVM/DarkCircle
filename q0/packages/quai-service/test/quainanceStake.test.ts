// Unit tests for the BDELTA-on-Quainance gate arithmetic: liquidity tokens in the wallet, in Quainance's gauge, and deposited in this app's farm.
// Run: node --test packages/quai-service/test/quainanceStake.test.ts   (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BDELTA_STAKE_THRESHOLD, bdeltaOfLiquidity, withFarmLiquidity, type QuainanceStake } from '../src/quainanceStakeMath.ts';

const E18 = 10n ** 18n;

// A pool with 10,000 BDELTA in its reserves and 100 liquidity tokens in supply: one liquidity token = 100 BDELTA.
const POOL = { bdeltaReserve: 10_000n * E18, lpTotalSupply: 100n * E18 };

function stake(over: Partial<QuainanceStake> = {}): QuainanceStake {
  const lpHeld = over.lpHeld ?? 0n;
  const lpStaked = over.lpStaked ?? 0n;
  const bdelta = bdeltaOfLiquidity(lpHeld + lpStaked, POOL.bdeltaReserve, POOL.lpTotalSupply);
  return { bdelta, lpHeld, lpStaked, lpFarm: 0n, ...POOL, meetsThreshold: bdelta >= BDELTA_STAKE_THRESHOLD, ...over };
}

test('liquidity tokens convert to the BDELTA they represent, rounding down', () => {
  assert.equal(bdeltaOfLiquidity(1n * E18, POOL.bdeltaReserve, POOL.lpTotalSupply), 100n * E18);
  assert.equal(bdeltaOfLiquidity(1n, 10n, 3n), 3n);
  assert.equal(bdeltaOfLiquidity(5n * E18, 1n, 0n), 0n, 'an empty pool represents nothing, not a division by zero');
});

test('a wallet whose liquidity is all deposited in the farm is counted, not told it has nothing', () => {
  const wallet = stake(); // nothing left in the wallet or the gauge
  assert.equal(wallet.meetsThreshold, false);
  const counted = withFarmLiquidity(wallet, 20n * E18); // 20 liquidity tokens = 2,000 BDELTA
  assert.equal(counted.bdelta, 2_000n * E18);
  assert.equal(counted.lpFarm, 20n * E18);
  assert.equal(counted.meetsThreshold, true);
});

test('wallet, gauge and farm add up, and a total just below the threshold stays below it', () => {
  const part = stake({ lpHeld: 3n * E18, lpStaked: 3n * E18 }); // 600 BDELTA
  assert.equal(withFarmLiquidity(part, 3n * E18).bdelta, 900n * E18);
  assert.equal(withFarmLiquidity(part, 3n * E18).meetsThreshold, false);
  assert.equal(withFarmLiquidity(part, 4n * E18).bdelta, 1_000n * E18);
  assert.equal(withFarmLiquidity(part, 4n * E18).meetsThreshold, true, 'exactly 1,000 qualifies');
});

test('counting the farm never changes the wallet-side figures and leaves the input untouched', () => {
  const base = stake({ lpHeld: 2n * E18 });
  const counted = withFarmLiquidity(base, 1n * E18);
  assert.equal(counted.lpHeld, base.lpHeld);
  assert.equal(counted.lpStaked, base.lpStaked);
  assert.equal(base.lpFarm, 0n);
  assert.equal(base.bdelta, 200n * E18);
});
