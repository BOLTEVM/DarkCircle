import React, { useState } from 'react';
import { X, ArrowUpDown, AlertCircle } from 'lucide-react';
import { useMarketData } from '../../context/MarketDataContext.js';

interface SwapModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SwapModal: React.FC<SwapModalProps> = ({ isOpen, onClose }) => {
  const { marketState } = useMarketData();

  const [fromAsset, setFromAsset] = useState('QUAI');
  const [toAsset, setToAsset] = useState('USDT');
  const [fromAmount, setFromAmount] = useState('');

  if (!isOpen) return null;

  const quaiHolding = marketState.holdings.find((h) => h.symbol === 'QUAI');
  const usdtHolding = marketState.holdings.find((h) => h.symbol === 'USDT');
  const qiHolding = marketState.holdings.find((h) => h.symbol.includes('Qi'));

  const rateFrom = fromAsset === 'QUAI' ? quaiHolding?.unitPriceUsd : usdtHolding?.unitPriceUsd;
  const rateTo = toAsset === 'USDT' ? usdtHolding?.unitPriceUsd : qiHolding?.unitPriceUsd;
  const ratesAvailable = Boolean(rateFrom && rateTo);

  const parsedFrom = parseFloat(fromAmount) || 0;
  const estimatedTo = ratesAvailable ? (parsedFrom * rateFrom!) / rateTo! : 0;

  const handleSwapAssets = () => {
    const prev = fromAsset;
    setFromAsset(toAsset);
    setToAsset(prev);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold">
            <ArrowUpDown className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Quaiswap AMM Swap</h3>
            <p className="text-xs text-slate-400">Execute on-chain swaps via Safe threshold consensus</p>
          </div>
        </div>

        <div className="mb-4 bg-amber-950/30 border border-amber-800/40 rounded-xl p-3 text-xs text-amber-300 flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            On-chain swap execution is not yet wired up (no router quote/calldata encoding). This preview
            is for rate estimation only — the propose action is disabled.
          </span>
        </div>

        <form className="space-y-4 text-xs">
          {/* From Box */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
            <div className="flex justify-between items-center text-slate-400 mb-1">
              <span>You Pay</span>
              <span className="font-mono text-[10px]">
                Rate: {rateFrom ? `$${rateFrom.toFixed(2)}` : 'Unavailable'}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                step="any"
                min="0"
                placeholder="0.0"
                value={fromAmount}
                onChange={(e) => setFromAmount(e.target.value)}
                className="bg-transparent text-xl font-mono text-white focus:outline-none w-full"
                required
              />
              <span className="font-bold text-sm bg-slate-800 px-2.5 py-1 rounded-lg text-slate-200">
                {fromAsset}
              </span>
            </div>
          </div>

          {/* Swap Direction Toggle */}
          <div className="flex justify-center -my-2 relative z-10">
            <button
              type="button"
              onClick={handleSwapAssets}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-full border border-slate-700 shadow-md transition-transform active:rotate-180"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* To Box */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
            <div className="flex justify-between items-center text-slate-400 mb-1">
              <span>You Receive (Estimated)</span>
              <span className="font-mono text-[10px]">
                Rate: {rateTo ? `$${rateTo.toFixed(2)}` : 'Unavailable'}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="text-xl font-mono text-emerald-400 w-full">
                {estimatedTo > 0 ? estimatedTo.toFixed(4) : '0.0000'}
              </div>
              <span className="font-bold text-sm bg-slate-800 px-2.5 py-1 rounded-lg text-slate-200">
                {toAsset}
              </span>
            </div>
          </div>

          {/* Routing Details */}
          <div className="bg-slate-950/60 rounded-xl p-2.5 border border-slate-800/60 text-[11px] text-slate-400 space-y-1">
            <div className="flex justify-between">
              <span>Execution Shard:</span>
              <span className="text-slate-200 font-mono">Cyprus-1 (Shard 0-0)</span>
            </div>
            <div className="flex justify-between">
              <span>Pricing source:</span>
              <span className={`font-mono ${marketState.isLive ? 'text-emerald-400' : 'text-amber-400'}`}>
                {marketState.isLive ? 'Live DEX/oracle' : 'Baseline (degraded)'}
              </span>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end space-x-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold"
            >
              Close
            </button>
            <button
              type="button"
              disabled
              title="On-chain swap execution is not yet implemented"
              className="px-5 py-2 rounded-xl text-xs font-bold bg-slate-700 text-slate-500 cursor-not-allowed"
            >
              Propose Multi-Sig Swap
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
