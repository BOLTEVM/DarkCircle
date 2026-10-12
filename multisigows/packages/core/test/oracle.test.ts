import { describe, it, expect } from 'vitest';
import {
  PythPriceFeedClient,
  MockPythPriceClient,
  MultiTierPriceAggregator,
  calculatePortfolioValue,
  assertZeroHardcoding,
  FORBIDDEN_MOCK_BALANCE,
  BASELINE_PRICES
} from '../src/oracle.js';

describe('@darksafe/core: oracle module', () => {
  it('enforces Guard OG-10: accepts valid fresh price with low confidence interval', () => {
    const pyth = new PythPriceFeedClient();
    const price = pyth.getPriceWithGuardOG10('QUAI', 60, 2.0);
    expect(price).toBe(1.25);
  });

  it('enforces Guard OG-10: rejects price older than 60 seconds (stale)', () => {
    const pyth = new PythPriceFeedClient();
    const staleTime = Math.floor(Date.now() / 1000) - 75; // 75s old
    pyth.setPrice('QUAI', {
      price: 1.25,
      conf: 0.01,
      expo: -2,
      publishTime: staleTime
    });

    expect(() => {
      pyth.getPriceWithGuardOG10('QUAI', 60, 2.0);
    }).toThrow('Oracle Guard OG-10: Stale price feed for QUAI');
  });

  it('enforces Guard OG-10: rejects confidence variance exceeding 2.0%', () => {
    const pyth = new PythPriceFeedClient();
    const nowSec = Math.floor(Date.now() / 1000);
    // price 1.00, conf 0.05 -> 5.0%
    pyth.setPrice('QUAI', {
      price: 1.00,
      conf: 0.05,
      expo: -2,
      publishTime: nowSec
    });

    expect(() => {
      pyth.getPriceWithGuardOG10('QUAI', 60, 2.0);
    }).toThrow('Oracle Guard OG-10: Confidence variance 5.00% exceeds 2% threshold');
  });

  it('enforces Guard OG-10: rejects zero or negative price', () => {
    const pyth = new PythPriceFeedClient();
    const nowSec = Math.floor(Date.now() / 1000);

    pyth.setPrice('QUAI', { price: 0, conf: 0.01, expo: -2, publishTime: nowSec });
    expect(() => pyth.getPriceWithGuardOG10('QUAI')).toThrow('Oracle Guard OG-10: Non-positive price');

    pyth.setPrice('QUAI', { price: -1.25, conf: 0.01, expo: -2, publishTime: nowSec });
    expect(() => pyth.getPriceWithGuardOG10('QUAI')).toThrow('Oracle Guard OG-10: Non-positive price');
  });

  it('enforces Guard OG-10: accepts exact boundary conditions (60s age, 2.0% variance)', () => {
    const pyth = new PythPriceFeedClient();
    const boundaryTime = Math.floor(Date.now() / 1000) - 60; // exactly 60s
    pyth.setPrice('QUAI', {
      price: 100.0,
      conf: 2.0, // exactly 2.0%
      expo: -2,
      publishTime: boundaryTime
    });

    const price = pyth.getPriceWithGuardOG10('QUAI', 60, 2.0);
    expect(price).toBe(100.0);
  });

  it('dynamically calculates portfolio valuation from holdings and live oracle rates', () => {
    const pyth = new MockPythPriceClient();
    // 2.0 QUAI ($1.25 = $2.50) + 10 USDT ($1.00 = $10.00) = $12.50
    const holdings = [
      { symbol: 'QUAI', rawBalance: 2000000000000000000n, decimals: 18 },
      { symbol: 'USDT', rawBalance: 10000000n, decimals: 6 }
    ];

    const result = calculatePortfolioValue(holdings, pyth);
    expect(result.totalUsd).toBe(12.50);
    expect(result.formattedTotalUsd).toBe('$12.50');
    expect(result.assets.length).toBe(2);
    expect(result.assets[0]!.formattedBalance).toBe('2.0000');
    expect(result.assets[1]!.formattedBalance).toBe('10.0000');
  });

  it('returns dynamic $0.00 for empty or zero balances', () => {
    const pyth = new MockPythPriceClient();
    const holdings = [
      { symbol: 'QUAI', rawBalance: 0n, decimals: 18 },
      { symbol: 'USDT', rawBalance: 0n, decimals: 6 }
    ];

    const result = calculatePortfolioValue(holdings, pyth);
    expect(result.totalUsd).toBe(0.00);
    expect(result.formattedTotalUsd).toBe('$0.00');
  });

  it('enforces zero hardcoding mandate: rejects presence of mockup balance ($2,348.43)', () => {
    expect(FORBIDDEN_MOCK_BALANCE).toBe('$2,348.43');
    expect(() => assertZeroHardcoding('Total Balance: $2,348.43')).toThrow(
      'CRITICAL INTEGRITY VIOLATION: Hardcoded mockup balance'
    );
    expect(() => assertZeroHardcoding('$12.50')).not.toThrow();
  });

  it('resolves price via MultiTierPriceAggregator fallback cascade', async () => {
    const aggregator = new MultiTierPriceAggregator();

    // Resolves QUAI via Tier 2 (Pyth)
    const quaiPrice = await aggregator.resolvePrice('QUAI');
    expect(quaiPrice).toBe(1.25);

    // Resolves USDT via Tier 2 / Tier 3
    const usdtPrice = await aggregator.resolvePrice('USDT');
    expect(usdtPrice).toBe(1.00);

    // Baseline fallback constant
    expect(BASELINE_PRICES.QUAI).toBe(1.25);
  });
});
