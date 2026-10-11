import React from 'react';
import {
  Plus,
  Coins,
  History,
  BookOpen,
  Settings,
  ExternalLink,
  ShieldCheck,
  Zap,
  Globe,
  ArrowUpDown,
} from 'lucide-react';
import { useSafe } from '../../context/SafeContext.js';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenNewTxModal: () => void;
  onOpenVaultSwitcher: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  onOpenNewTxModal,
  onOpenVaultSwitcher,
}) => {
  const { safeState } = useSafe();
  const hasVault = Boolean(safeState.address);
  const vaultInitial = (safeState.name || 'Vault').charAt(0).toUpperCase();

  return (
    <aside className="w-64 border-r border-slate-800/80 bg-[#0c121d] flex flex-col h-[calc(100vh-4rem)] p-4 select-none">
      {/* Workspace Selector */}
      <div className="mb-4">
        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block mb-1">
          Vault
        </label>
        <button
          onClick={onOpenVaultSwitcher}
          className="w-full flex items-center justify-between bg-slate-900 border border-slate-800 rounded-lg p-2.5 hover:border-slate-700 transition-colors cursor-pointer text-left"
        >
          <div className="flex items-center space-x-2 min-w-0">
            <div className="w-6 h-6 rounded bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center font-bold text-xs text-slate-950 flex-shrink-0">
              {vaultInitial}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-200 truncate">
                {hasVault ? safeState.name || 'Unnamed Vault' : 'No Vault Selected'}
              </div>
              <div className="text-[10px] text-emerald-400 font-mono">Cyprus-1 (15000)</div>
            </div>
          </div>
          <span
            className={`w-2 h-2 rounded-full ring-2 flex-shrink-0 ${
              hasVault ? 'bg-emerald-400 ring-emerald-500/20' : 'bg-slate-600 ring-slate-700/40'
            }`}
          />
        </button>
      </div>

      {/* New Transaction Button */}
      <div className="mb-5">
        <button
          onClick={onOpenNewTxModal}
          className="w-full bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 font-bold py-2.5 px-4 rounded-xl flex items-center justify-center space-x-2 transition-all shadow-lg shadow-emerald-500/20 group"
        >
          <Plus className="w-4 h-4 transition-transform group-hover:rotate-90" />
          <span className="text-xs tracking-wide">New transaction</span>
        </button>
      </div>

      {/* Navigation Links */}
      <nav className="space-y-1 text-xs">
        <button
          onClick={() => setActiveTab('assets')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'assets'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
          }`}
        >
          <Coins className="w-4 h-4" />
          <span>Assets & Holdings</span>
        </button>

        <button
          onClick={() => setActiveTab('transactions')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'transactions'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
          }`}
        >
          <History className="w-4 h-4" />
          <span>Transactions Queue</span>
        </button>

        <button
          onClick={() => setActiveTab('address-book')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'address-book'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          <span>Address Book</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'settings'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>Safe Settings</span>
        </button>
      </nav>

      {/* DeFi Ecosystem Links */}
      <div className="mt-6 pt-4 border-t border-slate-800/80">
        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">
          DeFi Integrations
        </label>
        <div className="space-y-1 text-xs">
          <a
            href="https://quaiswap.io"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 rounded-lg transition-colors group"
          >
            <div className="flex items-center space-x-2">
              <ArrowUpDown className="w-3.5 h-3.5 text-emerald-400" />
              <span>Quaiswap DEX</span>
            </div>
            <ExternalLink className="w-3 h-3 text-slate-600 group-hover:text-slate-400" />
          </a>

          <a
            href="https://bdelta.boltevm.com"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 rounded-lg transition-colors group"
          >
            <div className="flex items-center space-x-2">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>BDelta CLOB</span>
            </div>
            <ExternalLink className="w-3 h-3 text-slate-600 group-hover:text-slate-400" />
          </a>

          <div className="flex items-center justify-between px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 rounded-lg transition-colors cursor-pointer">
            <div className="flex items-center space-x-2">
              <Globe className="w-3.5 h-3.5 text-blue-400" />
              <span>Liquid Staking</span>
            </div>
            <span className="text-[9px] bg-slate-800 text-slate-400 px-1 py-0.5 rounded">Soon</span>
          </div>
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Vault Consensus Summary */}
      {hasVault && (
        <div className="mt-auto bg-gradient-to-b from-slate-900 to-slate-950 border border-emerald-500/20 rounded-xl p-3 shadow-sm">
          <div className="flex items-center space-x-1.5 mb-2">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-bold text-slate-200">Multi-signature protection</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed mb-2">
            Quai Cyprus-1 execution shard.
          </p>
          <div className="flex items-center justify-between text-[10px] text-slate-500 border-t border-slate-800/80 pt-2 font-mono">
            <span>Shard 0-0</span>
            <span>{safeState.threshold}-of-{safeState.owners.length} Consensus</span>
          </div>
        </div>
      )}
    </aside>
  );
};
