import React from 'react';
import { AlertTriangle, CheckCircle2, Gavel, PiggyBank } from 'lucide-react';
import { describeLien, type DebtView } from '@darkquestate/core';
import { cx } from '../components/primitives.js';

const STYLE = {
  clear: { icon: CheckCircle2, box: 'border-emerald-400/25 bg-emerald-400/[0.05]', text: 'text-emerald-300' },
  credit: { icon: PiggyBank, box: 'border-sky-400/25 bg-sky-400/[0.05]', text: 'text-sky-300' },
  lien: { icon: AlertTriangle, box: 'border-amber-400/30 bg-amber-400/[0.06]', text: 'text-amber-300' },
  foreclosed: { icon: Gavel, box: 'border-rose-400/30 bg-rose-400/[0.06]', text: 'text-rose-300' },
} as const;

/** The EIP-6065 debt record in words, shown before anyone commits coin. */
export const LienDisclosure: React.FC<{ debt: DebtView; className?: string; compact?: boolean }> = ({ debt, className, compact = false }) => {
  const d = describeLien(debt);
  const s = STYLE[d.state];
  const Icon = s.icon;
  return (
    <div className={cx('flex gap-3 rounded-lg border px-4 py-3', s.box, className)}>
      <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', s.text)} aria-hidden />
      <div className="min-w-0">
        <div className={cx('text-sm font-semibold', s.text)}>{d.headline}</div>
        {!compact && <p className="mt-0.5 text-xs leading-relaxed text-bone-dim">{d.detail}</p>}
      </div>
    </div>
  );
};
