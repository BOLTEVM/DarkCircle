import React, { useState } from 'react';
import { Shield, Plus } from 'lucide-react';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import { PoweredByBolt } from '../PoweredByBolt.js';
import { BalanceCard } from '../dashboard/BalanceCard.js';
import { TopAssets } from '../dashboard/TopAssets.js';
import { ExploreCarousel } from '../dashboard/ExploreCarousel.js';
import { PendingQueue } from '../dashboard/PendingQueue.js';
import { SecurityPanel } from '../dashboard/SecurityPanel.js';
import { TransactionReviewModal, ReviewTarget } from '../modals/TransactionReviewModal.js';
import { NewTransactionModal } from '../modals/NewTransactionModal.js';
import { ReceiveModal } from '../modals/ReceiveModal.js';
import { SendModal } from '../modals/SendModal.js';
import { SwapModal } from '../modals/SwapModal.js';
import { SignerModal } from '../modals/SignerModal.js';
import { CreateVaultModal } from '../modals/CreateVaultModal.js';
import { VaultSwitcherModal } from '../modals/VaultSwitcherModal.js';
import { useSafe } from '../../context/SafeContext.js';

export const AppShell: React.FC = () => {
  const { safeState, deploymentError } = useSafe();
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [activeTab, setActiveTab] = useState('assets');
  const [isNewTxOpen, setIsNewTxOpen] = useState(false);
  const [isReceiveOpen, setIsReceiveOpen] = useState(false);
  const [isSendOpen, setIsSendOpen] = useState(false);
  const [isSwapOpen, setIsSwapOpen] = useState(false);
  const [isSignerOpen, setIsSignerOpen] = useState(false);
  const [isCreateVaultOpen, setIsCreateVaultOpen] = useState(false);
  const [isVaultSwitcherOpen, setIsVaultSwitcherOpen] = useState(false);
  const [sendAsset, setSendAsset] = useState('QUAI');

  const hasVault = Boolean(safeState.address);

  const handleOpenSend = (symbol: string = 'QUAI') => {
    setSendAsset(symbol);
    setIsSendOpen(true);
  };

  return (
    <div className="h-screen bg-[#0b0f17] text-slate-100 flex flex-col selection:bg-emerald-500/30 selection:text-emerald-300">
      <div
        className="bg-amber-950/60 border-b border-amber-800/50 text-amber-200 text-[11px] text-center px-4 py-1.5"
        data-testid="beta-banner"
      >
        Beta: the DarkSafe vault contract has not had an independent security audit. Do not store funds you cannot
        afford to lose.
      </div>

      {/* Header */}
      <Header
        onOpenQrModal={() => setIsReceiveOpen(true)}
        onOpenSignerModal={() => setIsSignerOpen(true)}
        onOpenNewTxModal={() => setIsNewTxOpen(true)}
      />

      {/* Body: Sidebar + Main Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onOpenNewTxModal={() => setIsNewTxOpen(true)}
          onOpenVaultSwitcher={() => setIsVaultSwitcherOpen(true)}
        />

        {/* Two-Column Main Content View */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6 bg-[#0b0f17]">
          {hasVault && safeState.error && (
            <div
              className="max-w-7xl mx-auto mb-4 bg-red-950/40 border border-red-800/60 rounded-xl p-3 text-xs text-red-300"
              data-testid="vault-state-error"
            >
              {safeState.error}
            </div>
          )}
          {!hasVault && deploymentError && (
            <div className="max-w-md mx-auto mt-8 bg-amber-950/40 border border-amber-700/50 rounded-xl p-3 text-xs text-amber-200 text-center" data-testid="deployment-missing-banner">
              {deploymentError}
            </div>
          )}
          {!hasVault ? (
            <div className="max-w-md mx-auto mt-24 text-center">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto mb-4">
                <Shield className="w-7 h-7" />
              </div>
              <h2 className="text-lg font-bold text-white mb-2">No Vault Selected</h2>
              <p className="text-sm text-slate-400 mb-6">
                Create a new DarkSafe multi-sig vault on Cyprus-1, or add the address of one you
                already own, to get started.
              </p>
              <button
                onClick={() => setIsCreateVaultOpen(true)}
                className="inline-flex items-center space-x-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-2.5 px-5 rounded-xl transition-all shadow-lg shadow-emerald-500/20"
              >
                <Plus className="w-4 h-4" />
                <span className="text-sm">Create or Add a Vault</span>
              </button>
            </div>
          ) : (
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Primary Main Column (65% width = ~8 cols) */}
              <div className="lg:col-span-8 space-y-6">
                {/* Dynamic Total Balance Card */}
                <BalanceCard
                  onSend={() => handleOpenSend('QUAI')}
                  onReceive={() => setIsReceiveOpen(true)}
                  onSwap={() => setIsSwapOpen(true)}
                />

                {/* Top Assets Card */}
                <TopAssets
                  onSendAsset={handleOpenSend}
                  onReceiveAsset={() => setIsReceiveOpen(true)}
                />

                {/* Explore Safe Apps Carousel */}
                <ExploreCarousel />
              </div>

              {/* Secondary Column (35% width = ~4 cols) */}
              <div className="lg:col-span-4 space-y-4">
                {/* Pending Transactions Approval Queue */}
                <SecurityPanel />
                <PendingQueue onOpenNewTxModal={() => setIsNewTxOpen(true)} onReview={setReviewTarget} />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Page credit: present on every screen of the dashboard */}
      <footer className="border-t border-slate-800/80 bg-[#0b0f17] px-4 lg:px-6 py-2" data-testid="app-footer">
        <PoweredByBolt />
      </footer>

      {/* Modals */}
      <NewTransactionModal isOpen={isNewTxOpen} onClose={() => setIsNewTxOpen(false)} onReview={setReviewTarget} />
      <ReceiveModal isOpen={isReceiveOpen} onClose={() => setIsReceiveOpen(false)} />
      <SendModal isOpen={isSendOpen} onClose={() => setIsSendOpen(false)} initialAsset={sendAsset} onReview={setReviewTarget} />
      <TransactionReviewModal target={reviewTarget} onClose={() => setReviewTarget(null)} />
      <SwapModal isOpen={isSwapOpen} onClose={() => setIsSwapOpen(false)} />
      <SignerModal isOpen={isSignerOpen} onClose={() => setIsSignerOpen(false)} />
      <CreateVaultModal isOpen={isCreateVaultOpen} onClose={() => setIsCreateVaultOpen(false)} />
      <VaultSwitcherModal
        isOpen={isVaultSwitcherOpen}
        onClose={() => setIsVaultSwitcherOpen(false)}
        onOpenCreateVault={() => setIsCreateVaultOpen(true)}
      />
    </div>
  );
};
