import React, { useState } from 'react';
import { Clock, Shield, AlertTriangle, Eye } from 'lucide-react';
import {
  CYPRUS1_TOKENS,
  TokenInfo,
  VaultTransaction,
  decodeVaultCall,
  describeRisk,
  highestRisk,
  summarizeCall,
  estimatedChainNow,
  formatDuration,
} from '@safebuddy/core';
import { useSafe } from '../../context/SafeContext.js';
import type { ReviewTarget } from '../modals/TransactionReviewModal.js';

interface PendingQueueProps {
  onOpenNewTxModal: () => void;
  onReview: (target: ReviewTarget) => void;
}

const OPEN = new Set(['Pending', 'Timelocked', 'Executable']);

const STATUS_STYLE: Record<string, string> = {
  Pending: 'bg-amber-950 text-amber-300 border border-amber-800',
  Timelocked: 'bg-sky-950 text-sky-300 border border-sky-800',
  Executable: 'bg-emerald-950 text-emerald-300 border border-emerald-800',
  Executed: 'bg-slate-800 text-slate-400',
  Failed: 'bg-red-950 text-red-300 border border-red-800',
  Cancelled: 'bg-slate-800 text-slate-500',
  Expired: 'bg-slate-800 text-slate-500',
};

function tokenFor(address: string): TokenInfo | undefined {
  const hit = Object.values(CYPRUS1_TOKENS).find((t: any) => t.address && t.address.toLowerCase() === address.toLowerCase()) as
    | { symbol: string; decimals: number }
    | undefined;
  return hit ? { symbol: hit.symbol, decimals: hit.decimals } : undefined;
}

export const PendingQueue: React.FC<PendingQueueProps> = ({ onOpenNewTxModal, onReview }) => {
  const { safeState, transactions, clock, knownRecipients, labelFor } = useSafe();
  const [showClosed, setShowClosed] = useState(false);

  const now = clock ? estimatedChainNow(clock) : Math.floor(Date.now() / 1000);
  const open = transactions.filter((t) => OPEN.has(t.status));
  const shown = showClosed ? transactions : open;

  const timing = (t: VaultTransaction): string => {
    if (t.status === 'Timelocked' && t.approvedAt > 0) {
      const at = t.approvedAt + t.executionDelay;
      return at > now ? `executable in ~${formatDuration(at - now)}` : 'executable now';
    }
    if (t.status === 'Timelocked') return 'quorum reached; the timelock has not started yet';
    if (OPEN.has(t.status)) return t.expiration > now ? `expires in ~${formatDuration(t.expiration - now)}` : 'expired';
    return '';
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg flex flex-col h-full">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800/80 mb-4">
        <div className="flex items-center space-x-2">
          <Clock className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-slate-200">Transactions</h3>
        </div>
        <div className="flex items-center space-x-2">
          <label className="text-[10px] text-slate-400 flex items-center space-x-1 cursor-pointer">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-emerald-500" />
            <span>History</span>
          </label>
          <span className="text-[10px] font-bold bg-emerald-950/70 text-emerald-400 border border-emerald-800/40 px-2 py-0.5 rounded-full font-mono">
            {open.length} open
          </span>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border-2 border-dashed border-slate-800/80 rounded-xl my-4">
          <Shield className="w-8 h-8 text-slate-600 mb-2" />
          <div className="text-xs font-semibold text-slate-400">No open transactions</div>
          <p className="text-[11px] text-slate-500 max-w-xs mt-1">Propose a transfer or a settings change; other owners approve it on chain.</p>
          <button onClick={onOpenNewTxModal} className="mt-3 text-xs font-bold text-emerald-400 hover:text-emerald-300 hover:underline">
            + Propose New Transaction
          </button>
        </div>
      ) : (
        <div className="space-y-3 overflow-y-auto pr-1" data-testid="tx-queue">
          {shown.map((t) => {
            const decoded = decodeVaultCall({ vault: safeState.address, to: t.to, value: t.value, data: t.data });
            const level = highestRisk(
              describeRisk(decoded, {
                vault: safeState.address,
                owners: safeState.owners,
                threshold: safeState.threshold,
                minExecutionDelay: safeState.minExecutionDelay,
                knownRecipients,
              })
            );
            const token = decoded.kind === 'erc20-transfer' || decoded.kind === 'erc20-approve' ? tokenFor(decoded.token) : undefined;
            const pct = safeState.threshold ? Math.min(100, (t.approvals.length / safeState.threshold) * 100) : 0;
            return (
              <div key={t.hash} className={`border rounded-xl p-3 ${OPEN.has(t.status) ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-950/40 border-slate-800/40 opacity-75'}`}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center space-x-2 min-w-0">
                    <span className="font-mono text-xs font-bold bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded">#{t.nonce}</span>
                    {level === 'critical' && <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" aria-label="critical" />}
                    <span className="text-xs font-semibold text-slate-200 truncate" title={summarizeCall(decoded, token)}>
                      {summarizeCall(decoded, token)}
                    </span>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase font-mono ${STATUS_STYLE[t.status]}`}>{t.status}</span>
                </div>
                {labelFor(t.to) && <div className="text-[10px] text-emerald-300 mb-1">to {labelFor(t.to)}</div>}
                <div className="flex justify-between items-center text-[11px] mb-1">
                  <span className="text-slate-400">{timing(t)}</span>
                  <span className="font-mono font-bold text-emerald-400">
                    {t.approvals.length}/{safeState.threshold}
                  </span>
                </div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mb-2">
                  <div className={`h-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
                </div>
                <button
                  onClick={() => onReview({ mode: 'existing', hash: t.hash, nonce: t.nonce })}
                  className="w-full py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center space-x-1.5"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Review</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
