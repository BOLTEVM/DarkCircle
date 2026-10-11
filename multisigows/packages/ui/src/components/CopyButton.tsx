import React, { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '../theme/tokens';

export type CopyButtonVariant = 'ghost' | 'outline' | 'secondary';
export type CopyButtonSize = 'sm' | 'md';

export interface CopyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  text: string;
  label?: React.ReactNode;
  copiedLabel?: React.ReactNode;
  variant?: CopyButtonVariant;
  size?: CopyButtonSize;
  onCopy?: () => void;
  ariaLabel?: string;
}

const variantStyles: Record<CopyButtonVariant, string> = {
  ghost: 'bg-transparent hover:bg-slate-800/80 text-slate-400 hover:text-slate-200 border border-transparent',
  outline: 'bg-transparent border border-slate-700/80 hover:border-slate-600 text-slate-300 hover:text-slate-100',
  secondary: 'bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300',
};

const sizeStyles: Record<CopyButtonSize, string> = {
  sm: 'text-xs p-1.5 rounded-md gap-1.5 h-7',
  md: 'text-sm px-2.5 py-1.5 rounded-lg gap-2 h-9',
};

export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label,
  copiedLabel = 'Copied!',
  variant = 'ghost',
  size = 'sm',
  onCopy,
  className,
  title = 'Copy to clipboard',
  ariaLabel,
  disabled,
  ...props
}) => {
  const [copied, setCopied] = useState(false);

  const defaultLabel = typeof label === 'string' ? label : title;
  const accessibleLabel = ariaLabel || defaultLabel;

  const handleCopy = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();

      if (disabled || !text) return;

      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else if (typeof document !== 'undefined') {
          // Fallback using textarea execCommand
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }

        setCopied(true);
        onCopy?.();
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy text:', err);
      }
    },
    [text, disabled, onCopy]
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      title={copied ? (typeof copiedLabel === 'string' ? copiedLabel : 'Copied!') : title}
      aria-label={copied ? (typeof copiedLabel === 'string' ? copiedLabel : 'Copied!') : accessibleLabel}
      className={cn(
        'inline-flex items-center justify-center select-none font-medium transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/80',
        variantStyles[variant],
        sizeStyles[size],
        copied && 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
        disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
        className
      )}
      {...props}
    >
      {copied ? (
        <Check className={cn('shrink-0 text-emerald-400', size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
      ) : (
        <Copy className={cn('shrink-0', size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
      )}

      {copied ? (
        copiedLabel && <span className="text-emerald-400 font-medium">{copiedLabel}</span>
      ) : (
        label && <span>{label}</span>
      )}
    </button>
  );
};
