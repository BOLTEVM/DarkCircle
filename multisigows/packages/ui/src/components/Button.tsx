import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../theme/tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-emerald-500 text-slate-950 font-semibold hover:bg-emerald-400 active:bg-emerald-600 shadow-sm hover:shadow-[0_0_15px_rgba(16,185,129,0.35)] border border-emerald-400/30',
  secondary:
    'bg-slate-800/80 text-slate-100 font-medium hover:bg-slate-700 active:bg-slate-800 border border-slate-700/80 hover:border-slate-600',
  outline:
    'bg-transparent text-slate-200 hover:text-emerald-400 font-medium border border-slate-700 hover:border-emerald-500/60 hover:bg-emerald-500/10 active:bg-emerald-500/20',
  ghost:
    'bg-transparent text-slate-300 hover:text-slate-100 font-medium hover:bg-slate-800/60 active:bg-slate-800 border border-transparent',
  danger:
    'bg-rose-500/20 text-rose-300 font-medium hover:bg-rose-500/30 active:bg-rose-500/40 border border-rose-500/40 hover:border-rose-400/60',
  success:
    'bg-emerald-500/20 text-emerald-300 font-medium hover:bg-emerald-500/30 active:bg-emerald-500/40 border border-emerald-500/40',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'text-xs px-2.5 py-1.5 rounded-md gap-1.5 h-8',
  md: 'text-sm px-4 py-2 rounded-lg gap-2 h-10',
  lg: 'text-base px-6 py-2.5 rounded-lg gap-2.5 h-12',
  icon: 'p-2 rounded-lg h-9 w-9 justify-center',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      disabled = false,
      leftIcon,
      rightIcon,
      fullWidth = false,
      children,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || isLoading;

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={isLoading}
        className={cn(
          'inline-flex items-center justify-center select-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
          variantStyles[variant],
          sizeStyles[size],
          fullWidth && 'w-full',
          isDisabled && 'opacity-50 cursor-not-allowed pointer-events-none shadow-none',
          className
        )}
        {...props}
      >
        {isLoading && (
          <Loader2
            className={cn(
              'animate-spin shrink-0',
              size === 'sm' ? 'h-3.5 w-3.5' : size === 'lg' ? 'h-5 w-5' : 'h-4 w-4'
            )}
            aria-hidden="true"
          />
        )}
        {!isLoading && leftIcon && <span className="inline-flex shrink-0">{leftIcon}</span>}
        {children && <span className="truncate">{children}</span>}
        {!isLoading && rightIcon && <span className="inline-flex shrink-0">{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';
