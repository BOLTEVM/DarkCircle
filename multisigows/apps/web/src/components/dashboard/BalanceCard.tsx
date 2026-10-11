import React from 'react';
import { RefreshCw, Send, ArrowDownLeft, ArrowLeftRight, CheckCircle2 } from 'lucide-react';
import { useMarketData } from '../../context/MarketDataContext.js';
import { Card, SkeletonLoader, Button } from '@safebuddy/ui';

interface BalanceCardProps {
  onSend: () => void;
  onReceive: () => void;
  onSwap: () => void;
}

export const BalanceCard: React.FC<BalanceCardProps> = ({ onSend, onReceive, onSwap }) => {
  const { marketState, refreshBalances, isRefreshing } = useMarketData();

  return (
    <div className="bg-gradient-to-br from-slate-900 via-[#121a29] to-[#0f1725] border border-slate-800/80 rounded-2xl p-5 lg:p-6 shadow-xl relative overflow-hidden">
      {/* Background glow accent */}
      <div className="absolute top-0 right-0 -mt-8 -mr-8 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center space-x-2 text-xs font-semibold text-slate-400 mb-1">
            <span>Dynamic Total Balance</span>
            {/* Only claim live prices when the oracle actually supplied them. */}
            <span
              data-testid="price-source"
              className={`inline-flex items-center space-x-1 text-[10px] border px-1.5 py-0.5 rounded font-mono ${
                marketState.isLive ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40' : 'bg-amber-950/60 text-amber-300 border-amber-800/40'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${marketState.isLive ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <span>{marketState.isLive ? 'LIVE ORACLE' : 'BASELINE PRICES'}</span>
            </span>
          </div>

          {/* Dynamic Balance Display */}
          {marketState.isLoading ? (
            <div className="h-10 w-48 bg-slate-800 animate-pulse rounded-lg mt-1" />
          ) : (
            <div className="flex items-baseline space-x-3">
              <span className="text-3xl lg:text-4xl font-extrabold font-mono text-white tracking-tight">
                {marketState.formattedTotalUsd}
              </span>

            </div>
          )}
        </div>

        {/* Quick Action Buttons */}
        <div className="flex items-center space-x-2">
          <button
            onClick={onSend}
            className="flex items-center space-x-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold px-3.5 py-2 rounded-xl text-xs transition-all shadow-md shadow-emerald-500/10 active:scale-95"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Send</span>
          </button>

          <button
            onClick={onReceive}
            className="flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold px-3.5 py-2 rounded-xl text-xs border border-slate-700/80 transition-all active:scale-95"
          >
            <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-400" />
            <span>Receive</span>
          </button>

          <button
            onClick={onSwap}
            className="flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold px-3.5 py-2 rounded-xl text-xs border border-slate-700/80 transition-all active:scale-95"
          >
            <ArrowLeftRight className="w-3.5 h-3.5 text-blue-400" />
            <span>Swap</span>
          </button>
        </div>
      </div>

      {/* Asset Breakdown Pills */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-slate-800/80">
        {marketState.holdings.map((asset) => (
          <div
            key={asset.symbol}
            className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-2.5 flex items-center justify-between"
          >
            <div>
              <div className="text-[11px] font-medium text-slate-400">{asset.name}</div>
              <div className="text-xs font-bold font-mono text-slate-200 mt-0.5">
                {asset.formattedBalance} {asset.symbol}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs font-semibold font-mono text-emerald-400">
                ${asset.totalUsd.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-500 font-mono">
                ${asset.unitPriceUsd.toFixed(2)} / unit
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
