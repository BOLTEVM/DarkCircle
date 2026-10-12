import React, { useState } from 'react';
import { Shield, Copy, Check, QrCode, RefreshCw, Wallet, ChevronDown } from 'lucide-react';
import { useSafe } from '../../context/SafeContext.js';
import { useWallet } from '../../context/WalletContext.js';
import { useMarketData } from '../../context/MarketDataContext.js';
import { shortAddress } from '@darksafe/core';

interface HeaderProps {
  onOpenQrModal: () => void;
  onOpenSignerModal: () => void;
  onOpenNewTxModal: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenQrModal,
  onOpenSignerModal,
  onOpenNewTxModal,
}) => {
  const { safeState, refreshSafeState } = useSafe();
  const { signer, walletChainId, expectedChainId, isOnExpectedChain } = useWallet();
  const networkLabel = expectedChainId === 9 ? 'Quai Mainnet' : 'Orchard Testnet';
  const { marketState, refreshBalances, isRefreshing } = useMarketData();
  const [copied, setCopied] = useState(false);
  const [showBalanceDropdown, setShowBalanceDropdown] = useState(false);

  const hasVault = Boolean(safeState.address);
  const truncatedAddress = hasVault ? shortAddress(safeState.address) : 'No vault';

  const handleCopy = () => {
    if (!hasVault) return;
    navigator.clipboard.writeText(safeState.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRefreshAll = () => {
    refreshSafeState();
    refreshBalances();
  };

  return (
    <header className="h-16 border-b border-slate-800/80 bg-[#0b0f17]/90 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between sticky top-0 z-30">
      {/* Left: Brand logo & Active Safe Chip */}
      <div className="flex items-center space-x-3 lg:space-x-4">
        <div className="flex items-center space-x-2">
          <img
            src={`${import.meta.env.BASE_URL}0.png`}
            alt="DarkSafe Logo"
            className="w-8 h-8 rounded-lg shadow-sm border border-emerald-500/20 object-contain bg-slate-900"
          />
          <span className="font-bold text-lg tracking-tight text-white hidden sm:inline-block">
            Dark<span className="text-emerald-400">Safe</span>
          </span>
        </div>

        <div className="h-5 w-px bg-slate-800 hidden sm:block" />

        {/* Active Safe Chip */}
        <div className="flex items-center bg-slate-900/90 border border-slate-800 rounded-lg p-1 px-2 space-x-2 text-xs">
          <div className="flex items-center space-x-1.5">
            <span
              data-testid="verification-dot"
              className={`relative inline-flex rounded-full h-2 w-2 ${
                !hasVault
                  ? 'bg-slate-600'
                  : safeState.verification === 'agreed'
                    ? 'bg-emerald-500'
                    : safeState.verification === 'single-source'
                      ? 'bg-amber-400'
                      : safeState.verification === 'disagreement' || safeState.verification === 'error'
                        ? 'bg-red-500'
                        : 'bg-slate-500'
              }`}
              title={
                !hasVault
                  ? 'No vault selected'
                  : safeState.verification === 'agreed'
                    ? 'Code and state verified by independent sources'
                    : safeState.verification === 'single-source'
                      ? 'Verified by one source only'
                      : safeState.verification === 'disagreement'
                        ? 'Sources disagree about this vault'
                        : safeState.verification === 'error'
                          ? 'Vault state could not be verified on chain'
                          : 'Verifying on chain...'
              }
            />
            <span className="font-mono text-slate-200 font-medium" title={safeState.address}>
              {truncatedAddress}
            </span>
          </div>

          <div className="flex items-center space-x-1 pl-1 border-l border-slate-800">
            <button
              onClick={handleCopy}
              disabled={!hasVault}
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Copy Safe Address"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={onOpenQrModal}
              disabled={!hasVault}
              className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="View QR Code"
            >
              <QrCode className="w-3.5 h-3.5" />
            </button>
          </div>

          <span className="bg-emerald-950/80 text-emerald-400 border border-emerald-800/40 text-[10px] font-semibold px-1.5 py-0.5 rounded">
            Cyprus-1
          </span>
        </div>

        {/* Network badge: driven by what the wallet reports, not by the build config */}
        {signer && (
          <span
            data-testid="network-badge"
            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
              isOnExpectedChain
                ? 'bg-slate-900 text-slate-300 border-slate-700'
                : 'bg-red-950 text-red-300 border-red-700'
            }`}
            title={`App expects chain ${expectedChainId}; wallet reports ${walletChainId ?? 'unknown'}`}
          >
            {isOnExpectedChain ? networkLabel : `Wrong network (wallet: ${walletChainId ?? '?'})`}
          </span>
        )}

        {/* Dynamic Threshold Badge (m/n) */}
        <div className="hidden md:flex items-center bg-slate-900/80 border border-slate-800 px-2.5 py-1 rounded-lg text-xs space-x-1.5">
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-slate-400">Threshold:</span>
          <span className="font-semibold text-emerald-300">
            {safeState.threshold}/{safeState.owners.length}
          </span>
        </div>
      </div>

      {/* Right: Balance Dropdown, Refresh, Signer Pill */}
      <div className="flex items-center space-x-2 lg:space-x-3">
        {/* Dynamic Balance Indicator Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowBalanceDropdown(!showBalanceDropdown)}
            className="flex items-center space-x-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 transition-colors"
          >
            <span className="text-slate-400 hidden sm:inline">Portfolio:</span>
            <span className="font-semibold font-mono text-emerald-400">
              {marketState.isLoading ? 'Calculating...' : marketState.formattedTotalUsd}
            </span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </button>

          {showBalanceDropdown && (
            <div className="absolute right-0 mt-2 w-56 bg-slate-900 border border-slate-800 rounded-lg shadow-xl p-3 z-50 text-xs">
              <div className="font-semibold text-slate-300 pb-2 border-b border-slate-800 flex justify-between items-center">
                <span>Holdings Valuation</span>
                <span className={`text-[10px] px-1 rounded ${marketState.isLive ? 'text-emerald-400 bg-emerald-950/50' : 'text-amber-300 bg-amber-950/50'}`}>
                  {marketState.isLive ? 'Live Oracle' : 'Baseline prices'}
                </span>
              </div>
              <div className="py-2 space-y-1.5 font-mono">
                {marketState.holdings.map((h) => (
                  <div key={h.symbol} className="flex justify-between items-center text-slate-300">
                    <span className="text-slate-400">{h.symbol}:</span>
                    <span>${h.totalUsd.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="pt-2 border-t border-slate-800 flex justify-between font-semibold text-emerald-400">
                <span>Total USD:</span>
                <span>{marketState.formattedTotalUsd}</span>
              </div>
            </div>
          )}
        </div>

        {/* Sync / Refresh Button */}
        <button
          onClick={handleRefreshAll}
          disabled={isRefreshing}
          className="p-1.5 bg-slate-900/90 border border-slate-800 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          title="Refresh On-Chain State & Oracle Rates"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`} />
        </button>

        {/* Connected Signer Pill */}
        <button
          onClick={onOpenSignerModal}
          className="flex items-center space-x-2 bg-slate-900/90 hover:bg-slate-800/90 border border-slate-800 rounded-lg px-2.5 py-1 text-xs transition-all group"
        >
          <div className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[10px]">
            <Wallet className="w-3 h-3" />
          </div>

          <div className="text-left hidden sm:block">
            <div className="font-medium text-slate-200 leading-tight">
              {signer ? signer.label : 'Connect Signer'}
            </div>
            <div className="text-[10px] text-slate-400 leading-tight font-mono">
              {signer ? shortAddress(signer.address) : 'Disconnected'}
            </div>
          </div>

          {signer && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase bg-indigo-950/60 text-indigo-300 border-indigo-800/50">
              [{signer.providerName.slice(0, 3).toUpperCase()}]
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
