// QUAI liquid staking: share maths, realised yield, and the vault snapshot decoder. Run: bun test tests/liquidStaking.test.ts
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { annualizedRateYield, liquidStakingRateE18, previewLiquidStakingDeposit, previewLiquidStakingRedeem } from '../packages/quai-service/src/liquidStakingMath';
import { readLiquidStakingRateAt, readLiquidStakingSnapshot } from '../packages/quai-service/src/liquidStaking';
import { keccak256Bytes } from '../packages/quai-service/src/keccak';
import type { BatchCall, BatchResult } from '../packages/quai-service/src/pairs';

const E18 = 10n ** 18n;
const VAULT = '0x004eF4600F538eAef5Ba834E05c497A8f30c1941';
const ST = '0x002A93ad9369f660Ec8130795C041A83065114Dd';
const STRATEGY = '0x0045ECe049e708b28409bc0f3EcA72642F99Bc3f';
const WQUAI = '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB';
const FACILITATOR = '0x002e596a173EE491E415b0844155CeE0dC5A6743';
const WALLET = '0x0026a4b3f0E8b1E97a1a67C08CdF7259d995419f';

const word = (v: bigint | string) => '0x' + (typeof v === 'bigint' ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, '0');
const ok = (value: unknown): BatchResult => ({ ok: true, value });
const sig = (signature: string) => keccak256Bytes(new TextEncoder().encode(signature)).slice(0, 10);

test('a seeded vault mints and redeems 1:1, and the rate starts at exactly 1 QUAI', () => {
  const seed = 10n ** 12n;
  assert.equal(previewLiquidStakingDeposit(5n * E18, seed, seed), 5n * E18);
  assert.equal(previewLiquidStakingRedeem(5n * E18, seed, seed), 5n * E18);
  assert.equal(liquidStakingRateE18(seed, seed), E18);
});

test('revenue raises the redemption rate, so later depositors get fewer shares', () => {
  const managed = 110n * E18, supply = 100n * E18;
  assert.equal(liquidStakingRateE18(managed, supply), 1_099_999_999_999_999_999n);
  assert.ok(previewLiquidStakingDeposit(E18, managed, supply) < E18);
});

test('annualised yield: 1% over 36.5 days is 10% APR; no growth is 0; short or invalid windows say nothing', () => {
  const apr = annualizedRateYield(E18, E18 + E18 / 100n, 36.5 * 86_400);
  assert.ok(apr !== null && Math.abs(apr - 10) < 1e-9);
  assert.equal(annualizedRateYield(E18, E18, 30 * 86_400), 0);
  assert.equal(annualizedRateYield(E18, 2n * E18, 600), null);
  assert.equal(annualizedRateYield(0n, E18, 86_400), null);
  const loss = annualizedRateYield(E18, E18 - E18 / 100n, 36.5 * 86_400);
  assert.ok(loss !== null && loss < 0);
});

test('the snapshot reads vault, buffer, strategy, pause state and the wallet position', async () => {
  const sel = (data: string) => data.slice(0, 10);
  const batches: BatchCall[][] = [];
  const batch = async (calls: BatchCall[]): Promise<BatchResult[]> => {
    batches.push(calls);
    return calls.map(c => {
      if (c.method === 'quai_blockNumber') return ok('0xa77a6e');
      if (c.method === 'quai_getBalance') return ok('0x' + (7n * E18).toString(16));
      const { to, data } = c.params[0] as { to: string; data: string };
      const key = `${to.toLowerCase()}:${sel(data)}`;
      const table: Record<string, string> = {
        [`${VAULT.toLowerCase()}:${sig('stQUAI()')}`]: word(ST),
        [`${VAULT.toLowerCase()}:${sig('strategy()')}`]: word(STRATEGY),
        [`${VAULT.toLowerCase()}:${sig('WQUAI()')}`]: word(WQUAI),
        [`${VAULT.toLowerCase()}:${sig('withdrawalDelay()')}`]: word(86_400n),
        [`${VAULT.toLowerCase()}:${sig('totalManagedAssets()')}`]: word(500n * E18),
        [`${VAULT.toLowerCase()}:${sig('paused()')}`]: word(0n),
        [`${ST.toLowerCase()}:${sig('totalSupply()')}`]: word(500n * E18),
        [`${ST.toLowerCase()}:${sig('balanceOf(address)')}`]: word(2n * E18),
        [`${WQUAI.toLowerCase()}:${sig('balanceOf(address)')}`]: word(data.toLowerCase().includes(VAULT.slice(2).toLowerCase()) ? 400n * E18 : 3n * E18),
        [`${WQUAI.toLowerCase()}:${sig('allowance(address,address)')}`]: word(0n),
        [`${STRATEGY.toLowerCase()}:${sig('totalAssets()')}`]: word(100n * E18),
        [`${STRATEGY.toLowerCase()}:${sig('paused()')}`]: word(1n),
        [`${STRATEGY.toLowerCase()}:${sig('facilitator()')}`]: word(FACILITATOR)
      };
      return table[key] ? ok(table[key]) : ok(word(0n));
    });
  };
  const s = await readLiquidStakingSnapshot(batch, VAULT, WALLET);
  assert.equal(s.blockNumber, 0xa77a6e);
  assert.equal(s.stQUAI.toLowerCase(), ST.toLowerCase());
  assert.equal(s.strategy.toLowerCase(), STRATEGY.toLowerCase());
  assert.equal(s.withdrawalDelaySeconds, 86_400n);
  assert.equal(s.managedAssets, 500n * E18);
  assert.equal(s.idleAssets, 400n * E18);
  assert.equal(s.strategyAssets, 100n * E18);
  assert.equal(s.vaultPaused, false);
  assert.equal(s.strategyPaused, true);
  assert.equal(s.facilitator?.toLowerCase(), FACILITATOR.toLowerCase());
  assert.deepEqual(s.wallet && { n: s.wallet.nativeBalance, st: s.wallet.shareBalance, w: s.wallet.wquaiBalance }, { n: 7n * E18, st: 2n * E18, w: 3n * E18 });
});

test('a historical rate point carries the block timestamp and refuses a malformed block', async () => {
  const batch = async (calls: BatchCall[]): Promise<BatchResult[]> => {
    assert.deepEqual(calls.map(c => c.params[c.params.length - (c.method === 'quai_call' ? 1 : 2)]), ['0xa772d1', '0xa772d1']);
    return [ok(word(E18)), ok({ woHeader: { timestamp: '0x6aebace9' } })];
  };
  const p = await readLiquidStakingRateAt(batch, VAULT, 10973905);
  assert.deepEqual(p, { blockNumber: 10973905, timestamp: 0x6aebace9, rateE18: E18 });
  const broken = async (): Promise<BatchResult[]> => [ok(word(E18)), ok({})];
  await assert.rejects(readLiquidStakingRateAt(broken, VAULT, 10973905), /Could not read block/);
});
