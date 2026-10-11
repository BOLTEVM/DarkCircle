import React from 'react';
import { ShieldCheck, ShieldAlert, Shield } from 'lucide-react';
import { assessVaultConfig, clockSkewIsSuspicious, formatDuration, shortAddress } from '@safebuddy/core';
import { useSafe } from '../../context/SafeContext.js';
import { resolveWebNetworkConfig } from '../../config/network.js';

const NETWORK_CONFIG = resolveWebNetworkConfig();

const VERIFY_TEXT: Record<string, { label: string; style: string }> = {
  agreed: { label: 'Verified by independent sources', style: 'text-emerald-300' },
  'single-source': { label: 'Verified by one source only', style: 'text-amber-300' },
  disagreement: { label: 'Sources disagree: actions blocked', style: 'text-red-300' },
  error: { label: 'Could not verify: actions blocked', style: 'text-red-300' },
  verifying: { label: 'Verifying...', style: 'text-slate-400' },
  none: { label: 'Not verified', style: 'text-slate-400' },
};

/** What an owner should glance at before trusting the dashboard. Never green unless verified. */
export const SecurityPanel: React.FC = () => {
  const { safeState, transactions, clock, deployment } = useSafe();
  if (!safeState.address) return null;

  const grade = safeState.owners.length ? assessVaultConfig(safeState.owners.length, safeState.threshold, safeState.minExecutionDelay) : null;
  const pendingAdmin = transactions.filter(
    (t) => t.to.toLowerCase() === safeState.address.toLowerCase() && ['Pending', 'Timelocked', 'Executable'].includes(t.status)
  ).length;
  const v = VERIFY_TEXT[safeState.verification] ?? VERIFY_TEXT.none!;
  const Icon = safeState.verification === 'agreed' ? ShieldCheck : safeState.verification === 'disagreement' || safeState.verification === 'error' ? ShieldAlert : Shield;
  const skewed = clock ? clockSkewIsSuspicious(clock, NETWORK_CONFIG.name) : false;

  const row = (label: string, value: React.ReactNode, testId?: string) => (
    <div className="flex justify-between items-start gap-2 py-1 border-b border-slate-800/60 last:border-0" data-testid={testId}>
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-200 text-right">{value}</span>
    </div>
  );

  return (
    <div className="bg-slate-900/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg text-xs" data-testid="security-panel">
      <div className="flex items-center space-x-2 pb-3 border-b border-slate-800/80 mb-3">
        <Icon className={`w-4 h-4 ${v.style}`} />
        <h3 className="text-sm font-bold text-slate-200">Security status</h3>
      </div>
      {row('On-chain state', <span className={v.style}>{v.label}</span>, 'verification-status')}
      {safeState.sourceReports.length > 0 &&
        row(
          'Sources',
          <span>
            {safeState.sourceReports.map((r) => (
              <span key={r.source} className="block">
                {r.source}: {r.outcome === 'ok' ? 'matches' : r.outcome}
              </span>
            ))}
          </span>
        )}
      {row('Approvals needed', `${safeState.threshold} of ${safeState.owners.length}`)}
      {row('Timelock', safeState.minExecutionDelay ? formatDuration(safeState.minExecutionDelay) : 'none')}
      {grade && row('Configuration grade', <span title={grade.notes.join(' ')}>{grade.grade}</span>)}
      {row('Open admin changes', <span className={pendingAdmin ? 'text-red-300 font-bold' : ''}>{pendingAdmin}</span>, 'pending-admin')}
      {safeState.block !== null && row('Read at block', safeState.block.toString())}
      {clock &&
        row(
          'Chain clock',
          <span className={skewed ? 'text-amber-300' : ''}>
            {skewed ? `Your clock differs from the chain by ${formatDuration(Math.abs(clock.skew))}; times shown use chain time` : 'in step'}
          </span>
        )}
      {deployment && row('Factory', <span className="font-mono">{shortAddress(deployment.factory)}</span>)}
      {safeState.problems.length > 0 && (
        <div className="mt-2 space-y-1">
          {safeState.problems.map((p) => (
            <div key={p} className="text-amber-300">
              {p}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
