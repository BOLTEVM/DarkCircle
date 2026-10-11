import React from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { cn } from '../theme/tokens';

export type BadgeVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'emerald';

export type BadgeSize = 'sm' | 'md' | 'lg';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  showDot?: boolean;
  dotColor?: string;
  icon?: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-slate-800 text-slate-300 border-slate-700',
  emerald:
    'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20',
  success:
    'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  warning:
    'bg-amber-500/15 text-amber-300 border-amber-500/30',
  danger:
    'bg-rose-500/15 text-rose-300 border-rose-500/30',
  info:
    'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  neutral:
    'bg-slate-800/80 text-slate-400 border-slate-700/60',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-slate-400',
  emerald: 'bg-emerald-400',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  danger: 'bg-rose-400',
  info: 'bg-cyan-400',
  neutral: 'bg-slate-400',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'text-[11px] px-2 py-0.5 rounded gap-1',
  md: 'text-xs px-2.5 py-1 rounded-md gap-1.5',
  lg: 'text-sm px-3 py-1.5 rounded-lg gap-2',
};

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant = 'default',
  size = 'md',
  showDot = false,
  dotColor,
  icon,
  children,
  ...props
}) => {
  return (
    <span
      className={cn(
        'inline-flex items-center font-medium border transition-colors select-none tracking-tight',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
      {...props}
    >
      {showDot && (
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full shrink-0',
            dotColor || dotColors[variant]
          )}
          aria-hidden="true"
        />
      )}
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </span>
  );
};

export interface ThresholdBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  threshold: number;
  totalOwners: number;
  currentSigners?: number;
  className?: string;
}

export const ThresholdBadge: React.FC<ThresholdBadgeProps> = ({
  threshold,
  totalOwners,
  currentSigners,
  className,
  ...props
}) => {
  const isSatisfied =
    currentSigners !== undefined ? currentSigners >= threshold : threshold > 0 && totalOwners > 0;

  return (
    <Badge
      variant={isSatisfied ? 'emerald' : 'warning'}
      size="md"
      className={cn('font-mono font-medium tracking-normal shadow-sm', className)}
      icon={
        isSatisfied ? (
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
        )
      }
      {...props}
    >
      <span>
        {threshold}/{totalOwners} Threshold
      </span>
    </Badge>
  );
};
