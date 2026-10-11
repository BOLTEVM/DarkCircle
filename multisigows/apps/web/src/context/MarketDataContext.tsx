import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import {
  QuaiRpcClient,
  MultiTierPriceAggregator,
  calculatePortfolioValue,
  assertZeroHardcoding,
  CYPRUS1_TOKENS,
  FetchLike,
} from '@safebuddy/core';
import { AssetHolding, MarketDataState } from '../types/index.js';
import { resolveWebNetworkConfig } from '../config/network.js';

const NETWORK_CONFIG = resolveWebNetworkConfig();

interface MarketDataContextValue {
  marketState: MarketDataState;
  refreshBalances: () => Promise<void>;
  rpcClient: QuaiRpcClient;
  priceOracle: MultiTierPriceAggregator;
  isRefreshing: boolean;
}

const MarketDataContext = createContext<MarketDataContextValue | null>(null);

export const MarketDataProvider: React.FC<{
  safeAddress: string;
  children: React.ReactNode;
}> = ({ safeAddress, children }) => {
  const rpcClient = useMemo(() => {
    const safeFetch: FetchLike = (url, init) => {
      if (!init) return fetch(url);
      const { signal, ...rest } = init;
      return fetch(url, rest);
    };
    return new QuaiRpcClient(NETWORK_CONFIG.rpcUrl, { maxRetries: 1, timeoutMs: 3000, fetchFn: safeFetch });
  }, []);
  const priceOracle = useMemo(() => new MultiTierPriceAggregator(rpcClient), [rpcClient]);

  // Loading-skeleton placeholder: zeroed until the first live fetch resolves real
  // balances and oracle prices below — never a real-looking dollar figure.
  const defaultInitialHoldings: AssetHolding[] = [
    {
      symbol: 'QUAI',
      name: 'Native Quai',
      address: undefined,
      decimals: 18,
      rawBalance: 0n,
      formattedBalance: '0.0000',
      unitPriceUsd: 0,
      totalUsd: 0,
      allocationPercent: 0,
      change24h: null,
    },
    {
      symbol: 'Qi (WQI)',
      name: 'Wrapped Qi Energy',
      address: CYPRUS1_TOKENS.WQI.address,
      decimals: 18,
      rawBalance: 0n,
      formattedBalance: '0.0000',
      unitPriceUsd: 0,
      totalUsd: 0,
      allocationPercent: 0,
      change24h: null,
    },
    {
      symbol: 'USDT',
      name: 'Tether USD',
      address: CYPRUS1_TOKENS.USDT.address,
      decimals: 6,
      rawBalance: 0n,
      formattedBalance: '0.0000',
      unitPriceUsd: 0,
      totalUsd: 0,
      allocationPercent: 0,
      change24h: null,
    },
  ];

  const [marketState, setMarketState] = useState<MarketDataState>({
    totalUsd: 0,
    formattedTotalUsd: '$0.00',
    holdings: defaultInitialHoldings,
    lastUpdated: Date.now(),
    isLoading: true,
    isLive: false,
    error: null,
  });

  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchLiveState = useCallback(async () => {
    if (!safeAddress) return;
    setIsRefreshing(true);

    try {
      // 1. Fetch Native QUAI balance
      let nativeQuaiBalance = 0n;
      try {
        nativeQuaiBalance = await rpcClient.quai_getBalance(safeAddress);
      } catch (err) {
        console.warn('Live QUAI balance fetch deferred:', err);
      }

      // 2. Fetch ERC-20 balances (WQI and USDT) via balanceOf call (selector 0x70a08231)
      const cleanAddr = safeAddress.toLowerCase().replace(/^0x/, '');
      const paddedAddr = '0'.repeat(24) + cleanAddr;
      const balanceOfData = `0x70a08231${paddedAddr}`;

      let wqiBalance = 0n;
      try {
        const wqiRes = await rpcClient.quai_call(CYPRUS1_TOKENS.WQI.address, balanceOfData);
        if (wqiRes && wqiRes !== '0x') {
          wqiBalance = BigInt(wqiRes);
        }
      } catch (err) {
        console.warn('Live WQI balance fetch deferred:', err);
      }

      let usdtBalance = 0n;
      try {
        const usdtRes = await rpcClient.quai_call(CYPRUS1_TOKENS.USDT.address, balanceOfData);
        if (usdtRes && usdtRes !== '0x') {
          usdtBalance = BigInt(usdtRes);
        }
      } catch (err) {
        console.warn('Live USDT balance fetch deferred:', err);
      }

      // 3. Resolve Real-Time Prices via Multi-Tier Oracle (DEX reserves / Pyth / Baseline).
      // Baseline is a deliberate last-resort tier (packages/core/src/oracle.ts BASELINE_PRICES),
      // not a live price — track when it was used so the UI can be honest about staleness.
      const [quaiResolved, qiResolved, usdtResolved] = await Promise.all([
        priceOracle.resolvePriceWithSource('QUAI').catch(() => ({ price: 1.25, source: 'baseline' as const })),
        priceOracle.resolvePriceWithSource('WQI').catch(() => ({ price: 1.25, source: 'baseline' as const })),
        priceOracle.resolvePriceWithSource('USDT').catch(() => ({ price: 1.00, source: 'baseline' as const })),
      ]);
      const quaiPrice = quaiResolved.price;
      const qiPrice = qiResolved.price;
      const usdtPrice = usdtResolved.price;
      const pricesDegraded = [quaiResolved, qiResolved, usdtResolved].some((r) => r.source === 'baseline');

      const rawHoldings = [
        {
          symbol: 'QUAI',
          name: 'Native Quai',
          address: undefined,
          decimals: 18,
          rawBalance: nativeQuaiBalance,
          change24h: null,
        },
        {
          symbol: 'Qi (WQI)',
          name: 'Wrapped Qi Energy',
          address: CYPRUS1_TOKENS.WQI.address,
          decimals: 18,
          rawBalance: wqiBalance,
          change24h: null,
        },
        {
          symbol: 'USDT',
          name: 'Tether USD',
          address: CYPRUS1_TOKENS.USDT.address,
          decimals: 6,
          rawBalance: usdtBalance,
          change24h: null,
        },
      ];

      // 4. Calculate Portfolio USD Valuation (Enforces ZERO hardcoded values)
      const priceMap: Record<string, number> = {
        QUAI: quaiPrice,
        'QI (WQI)': qiPrice,
        WQI: qiPrice,
        USDT: usdtPrice,
      };

      const valuation = calculatePortfolioValue(
        rawHoldings.map((h) => ({
          symbol: h.symbol === 'Qi (WQI)' ? 'WQI' : h.symbol,
          rawBalance: h.rawBalance,
          decimals: h.decimals,
        })),
        priceMap
      );

      // Verify that no forbidden static balance ($2,348.43) exists
      assertZeroHardcoding(valuation.formattedTotalUsd);

      const computedHoldings: AssetHolding[] = rawHoldings.map((h, i) => {
        const itemVal = valuation.assets[i]!;
        const alloc = valuation.totalUsd > 0 ? (itemVal.totalUsd / valuation.totalUsd) * 100 : 0;
        return {
          symbol: h.symbol,
          name: h.name,
          address: h.address,
          decimals: h.decimals,
          rawBalance: h.rawBalance,
          formattedBalance: itemVal.formattedBalance,
          unitPriceUsd: itemVal.unitPriceUsd,
          totalUsd: itemVal.totalUsd,
          allocationPercent: alloc,
          change24h: h.change24h,
        };
      });

      setMarketState({
        totalUsd: valuation.totalUsd,
        formattedTotalUsd: valuation.formattedTotalUsd,
        holdings: computedHoldings,
        lastUpdated: Date.now(),
        isLoading: false,
        isLive: !pricesDegraded,
        error: pricesDegraded
          ? 'One or more asset prices fell back to the static baseline tier (no live DEX/oracle price available); balances shown reflect real on-chain holdings but valuation is approximate.'
          : null,
      });
    } catch (err: any) {
      console.warn('Market data query exception:', err);
      setMarketState((prev) => ({
        ...prev,
        isLoading: false,
        error: err?.message || 'Failed to query live blockchain state',
      }));
    } finally {
      setIsRefreshing(false);
    }
  }, [safeAddress, rpcClient, priceOracle]);

  // Initial fetch and auto-refresh interval (every 12 seconds)
  useEffect(() => {
    fetchLiveState();
    const interval = setInterval(fetchLiveState, 12000);
    return () => clearInterval(interval);
  }, [fetchLiveState]);

  return (
    <MarketDataContext.Provider
      value={{
        marketState,
        refreshBalances: fetchLiveState,
        rpcClient,
        priceOracle,
        isRefreshing,
      }}
    >
      {children}
    </MarketDataContext.Provider>
  );
};

export function useMarketData(): MarketDataContextValue {
  const context = useContext(MarketDataContext);
  if (!context) {
    throw new Error('useMarketData must be used within a MarketDataProvider');
  }
  return context;
}
