import React from 'react';
import { Send, ArrowDownLeft, ExternalLink, ArrowUpDown } from 'lucide-react';
import { useMarketData } from '../../context/MarketDataContext.js';

interface TopAssetsProps {
  onSendAsset: (symbol: string) => void;
  onReceiveAsset: (symbol: string) => void;
}

export const TopAssets: React.FC<TopAssetsProps> = ({ onSendAsset, onReceiveAsset }) => {
  const { marketState } = useMarketData();

  return (
    <div className="bg-slate-900/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-slate-200">Top Assets</h3>
          <p className="text-[11px] text-slate-400">Live token balances held in active Cyprus-1 Safe</p>
        </div>
        <span className="text-[10px] text-slate-500 font-mono">
          Updated: {new Date(marketState.lastUpdated).toLocaleTimeString()}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-slate-500 border-b border-slate-800/80 pb-2">
              <th className="pb-2 font-medium">Asset</th>
              <th className="pb-2 font-medium text-right">Balance</th>
              <th className="pb-2 font-medium text-right">Price</th>
              <th className="pb-2 font-medium text-right">Value (USD)</th>
              <th className="pb-2 font-medium text-center">Allocation</th>
              <th className="pb-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {marketState.holdings.map((asset) => (
              <tr key={asset.symbol} className="hover:bg-slate-800/30 transition-colors group">
                <td className="py-3 pr-3">
                  <div className="flex items-center space-x-2.5">
                    <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-emerald-400">
                      {asset.symbol.slice(0, 1)}
                    </div>
                    <div>
                      <div className="font-semibold text-slate-200">{asset.symbol}</div>
                      <div className="text-[10px] text-slate-400">{asset.name}</div>
                    </div>
                  </div>
                </td>

                <td className="py-3 px-2 text-right font-mono font-medium text-slate-200">
                  {asset.formattedBalance}
                </td>

                <td className="py-3 px-2 text-right font-mono text-slate-400">
                  ${asset.unitPriceUsd.toFixed(2)}
                </td>

                <td className="py-3 px-2 text-right font-mono font-semibold text-emerald-400">
                  ${asset.totalUsd.toFixed(2)}
                </td>

                <td className="py-3 px-3 text-center">
                  <div className="w-20 mx-auto">
                    <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-1">
                      <span>{asset.allocationPercent.toFixed(1)}%</span>
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-emerald-500 h-full rounded-full"
                        style={{ width: `${Math.min(100, Math.max(2, asset.allocationPercent))}%` }}
                      />
                    </div>
                  </div>
                </td>

                <td className="py-3 pl-2 text-right">
                  <div className="flex items-center justify-end space-x-1">
                    <button
                      onClick={() => onSendAsset(asset.symbol)}
                      className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
                      title={`Send ${asset.symbol}`}
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onReceiveAsset(asset.symbol)}
                      className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
                      title={`Receive ${asset.symbol}`}
                    >
                      <ArrowDownLeft className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
