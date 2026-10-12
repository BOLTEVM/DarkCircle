import { describe, it, expect } from 'vitest';
import {
  calculatePortfolioValue,
  assertZeroHardcoding,
  FORBIDDEN_MOCK_BALANCE,
  MultiTierPriceAggregator,
  PythPriceFeedClient,
} from '@darksafe/core';

describe('Dynamic State & Live Valuation Logic', () => {
  it('throws an error if forbidden mockup balance $2,348.43 is present', () => {
    expect(() => assertZeroHardcoding(`Total: ${FORBIDDEN_MOCK_BALANCE}`)).toThrow(
      /CRITICAL INTEGRITY VIOLATION/
    );
  });

  it('calculates portfolio USD dynamically from on-chain holdings and oracle rates', () => {
    const holdings = [
      { symbol: 'QUAI', rawBalance: 1250000000000000000000n, decimals: 18 }, // 1,250 QUAI
      { symbol: 'WQI', rawBalance: 800000000000000000000n, decimals: 18 },    // 800 WQI
      { symbol: 'USDT', rawBalance: 500000000n, decimals: 6 },                  // 500 USDT
    ];

    const oraclePrices = {
      QUAI: 1.20,
      WQI: 0.90,
      USDT: 1.00,
    };

    const valuation = calculatePortfolioValue(holdings, oraclePrices);

    // 1250 * 1.20 = 1500; 800 * 0.90 = 720; 500 * 1.00 = 500; Total = 2720
    expect(valuation.totalUsd).toBe(2720);
    expect(valuation.formattedTotalUsd).toBe('$2,720.00');
    expect(valuation.formattedTotalUsd).not.toBe(FORBIDDEN_MOCK_BALANCE);

    // Verify individual assets
    expect(valuation.assets[0]!.formattedBalance).toBe('1250.0000');
    expect(valuation.assets[0]!.totalUsd).toBe(1500);

    expect(valuation.assets[1]!.formattedBalance).toBe('800.0000');
    expect(valuation.assets[1]!.totalUsd).toBe(720);

    expect(valuation.assets[2]!.formattedBalance).toBe('500.0000');
    expect(valuation.assets[2]!.totalUsd).toBe(500);
  });

  it('dynamically adapts when holdings change without static fallback', () => {
    const emptyHoldings: any[] = [];
    const oraclePrices = { QUAI: 1.25, WQI: 1.25, USDT: 1.00 };

    const valuation = calculatePortfolioValue(emptyHoldings, oraclePrices);
    expect(valuation.totalUsd).toBe(0);
    expect(valuation.formattedTotalUsd).toBe('$0.00');
  });

  it('verifies MultiTierPriceAggregator fallback cascade without throwing', async () => {
    const aggregator = new MultiTierPriceAggregator();
    const quaiPrice = await aggregator.resolvePrice('QUAI');
    expect(quaiPrice).toBeGreaterThan(0);

    const usdtPrice = await aggregator.resolvePrice('USDT');
    expect(usdtPrice).toBe(1.0);
  });
});
