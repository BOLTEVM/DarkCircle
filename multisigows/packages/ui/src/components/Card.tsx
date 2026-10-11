import React, { forwardRef } from 'react';
import { cn } from '../theme/tokens';

export type CardVariant = 'default' | 'elevated' | 'outlined' | 'interactive';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  headerAction?: React.ReactNode;
  footer?: React.ReactNode;
  variant?: CardVariant;
  padding?: CardPadding;
}

const variantStyles: Record<CardVariant, string> = {
  default: 'bg-slate-900/90 border border-slate-800 shadow-lg',
  elevated: 'bg-slate-900 border border-slate-700/80 shadow-2xl',
  outlined: 'bg-transparent border border-slate-800',
  interactive:
    'bg-slate-900/90 border border-slate-800 shadow-md hover:border-slate-700 hover:shadow-xl hover:bg-slate-850 cursor-pointer transition-all duration-150',
};

const paddingStyles: Record<CardPadding, string> = {
  none: 'p-0',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      className,
      title,
      subtitle,
      headerAction,
      footer,
      variant = 'default',
      padding = 'md',
      children,
      onClick,
      ...props
    },
    ref
  ) => {
    const hasHeader = title || subtitle || headerAction;

    return (
      <div
        ref={ref}
        onClick={onClick}
        className={cn(
          'rounded-xl text-slate-100 overflow-hidden relative',
          variantStyles[variant],
          className
        )}
        {...props}
      >
        {hasHeader && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/80 bg-slate-950/20">
            <div className="space-y-0.5">
              {title && (
                <div className="font-semibold text-slate-100 text-base leading-tight tracking-tight">
                  {title}
                </div>
              )}
              {subtitle && (
                <div className="text-xs text-slate-400 font-normal leading-normal">
                  {subtitle}
                </div>
              )}
            </div>
            {headerAction && <div className="shrink-0 ml-4">{headerAction}</div>}
          </div>
        )}

        <div className={cn(paddingStyles[padding])}>{children}</div>

        {footer && (
          <div className="px-6 py-3.5 border-t border-slate-800/80 bg-slate-950/30 flex items-center justify-between text-xs text-slate-400">
            {footer}
          </div>
        )}
      </div>
    );
  }
);

Card.displayName = 'Card';
