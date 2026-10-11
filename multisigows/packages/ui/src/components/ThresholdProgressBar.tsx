import React from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import { cn } from '../theme/tokens';

export type ProgressBarSize = 'sm' | 'md' | 'lg';

export interface ThresholdProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  current: number;
  threshold: number;
  total?: number;
  showLabel?: boolean;
  showRatio?: boolean;
  size?: ProgressBarSize;
}

const heightStyles: Record<ProgressBarSize, string> = {
  sm: 'h-1.5',
  md: 'h-2.5',
  lg: 'h-3.5',
};

export const ThresholdProgressBar: React.FC<ThresholdProgressBarProps> = ({
  current,
  threshold,
  total,
  showLabel = true,
  showRatio = true,
  size = 'md',
  className,
  ...props
}) => {
  const safeThreshold = Math.max(1, threshold);
  const safeCurrent = Math.max(0, current);
  const percentage = Math.min(100, Math.round((safeCurrent / safeThreshold) * 100));
  const isSatisfied = safeCurrent >= safeThreshold;

  return (
    <div className={cn('w-full space-y-1.5', className)} {...props}>
      {(showLabel || showRatio) && (
        <div className="flex items-center justify-between text-xs">
          {showLabel && (
            <div className="flex items-center gap-1.5 font-medium">
              {isSatisfied ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Ready to Execute
                </span>
              ) : (
                <span className="text-amber-400 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> Needs {safeThreshold - safeCurrent} more signature
                  {safeThreshold - safeCurrent > 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}

          {showRatio && (
            <div className="font-mono text-slate-400">
              <span className={cn('font-semibold', isSatisfied ? 'text-emerald-400' : 'text-slate-200')}>
                {safeCurrent}
              </span>
              <span className="text-slate-500">/</span>
              <span>{safeThreshold}</span>
              {total !== undefined && (
                <span className="text-slate-500 text-[11px] ml-1">({total} owners)</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Progress Track */}
      <div
        className={cn(
          'w-full bg-slate-800/80 rounded-full overflow-hidden relative border border-slate-700/50',
          heightStyles[size]
        )}
        role="progressbar"
        aria-valuenow={safeCurrent}
        aria-valuemin={0}
        aria-valuemax={safeThreshold}
        aria-label={`Signature threshold progress: ${safeCurrent} of ${safeThreshold}`}
      >
        {/* Fill Bar */}
        <div
          className={cn(
            'h-full transition-all duration-300 ease-out rounded-full',
            isSatisfied
              ? 'bg-gradient-to-r from-emerald-500 to-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.5)]'
              : 'bg-gradient-to-r from-amber-500 to-amber-400'
          )}
          style={{ width: `${percentage}%` }}
        />

        {/* Segment Checkpoint Ticks */}
        {safeThreshold > 1 && safeThreshold <= 10 && (
          <div className="absolute inset-0 flex justify-between pointer-events-none px-0.5">
            {Array.from({ length: safeThreshold - 1 }).map((_, idx) => (
              <div
                key={idx}
                className="w-0.5 h-full bg-slate-900/60 z-10"
                style={{ left: `${((idx + 1) / safeThreshold) * 100}%` }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
