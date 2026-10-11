import React, { forwardRef } from 'react';
import { cn } from '../theme/tokens';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
  helperText?: React.ReactNode;
  error?: React.ReactNode;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  rightAction?: React.ReactNode;
  isAddress?: boolean;
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      label,
      helperText,
      error,
      leftIcon,
      rightIcon,
      rightAction,
      isAddress = false,
      fullWidth = true,
      disabled,
      id,
      value,
      ...props
    },
    ref
  ) => {
    const inputId = id || (label ? `input-${String(label).replace(/\s+/g, '-').toLowerCase()}` : undefined);
    const hasError = Boolean(error);

    // If marked as Cyprus-1 address input, check prefix validity if value provided
    const strVal = typeof value === 'string' ? value : '';
    const isCyprus1Valid =
      isAddress && strVal.length > 2 ? strVal.toLowerCase().startsWith('0x00') : true;

    return (
      <div className={cn('flex flex-col space-y-1.5', fullWidth && 'w-full')}>
        {label && (
          <div className="flex items-center justify-between">
            <label
              htmlFor={inputId}
              className="text-xs font-medium text-slate-300 tracking-wide select-none"
            >
              {label}
            </label>
            {isAddress && (
              <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700/60">
                Cyprus-1 (0x00)
              </span>
            )}
          </div>
        )}

        <div className="relative flex items-center">
          {leftIcon && (
            <div className="absolute left-3 flex items-center pointer-events-none text-slate-400">
              {leftIcon}
            </div>
          )}

          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            value={value}
            aria-invalid={hasError}
            className={cn(
              'h-10 w-full rounded-lg bg-slate-950 border border-slate-800 text-slate-100 placeholder-slate-500 text-sm transition-all duration-150',
              'focus:outline-none focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500/50',
              leftIcon ? 'pl-9' : 'pl-3.5',
              rightIcon || rightAction ? 'pr-12' : 'pr-3.5',
              isAddress && 'font-mono text-xs',
              hasError && 'border-rose-500/80 focus:border-rose-500 focus:ring-rose-500/40 text-rose-200',
              !isCyprus1Valid && strVal.length >= 4 && 'border-amber-500/80 focus:border-amber-500',
              disabled && 'opacity-50 cursor-not-allowed bg-slate-900',
              className
            )}
            {...props}
          />

          {(rightIcon || rightAction) && (
            <div className="absolute right-2 flex items-center gap-1 text-slate-400">
              {rightAction}
              {rightIcon && <span className="p-1">{rightIcon}</span>}
            </div>
          )}
        </div>

        {/* Feedback message */}
        {hasError && (
          <p className="text-xs text-rose-400 flex items-center gap-1 font-medium">{error}</p>
        )}
        {!hasError && !isCyprus1Valid && strVal.length >= 4 && (
          <p className="text-xs text-amber-400 flex items-center gap-1 font-mono">
            Notice: Cyprus-1 zone addresses must begin with 0x00
          </p>
        )}
        {!hasError && helperText && !(!isCyprus1Valid && strVal.length >= 4) && (
          <p className="text-xs text-slate-400 leading-normal">{helperText}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
