import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ Button */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

const BUTTON_VARIANTS = {
  primary: 'bg-gold text-ink hover:bg-gold-light font-semibold shadow-lift',
  secondary: 'bg-panel-raised text-bone border border-line hover:border-line-strong hover:bg-panel-hover',
  ghost: 'text-bone-dim hover:text-bone hover:bg-panel-raised',
  danger: 'bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20',
} as const;

const BUTTON_SIZES = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-sm tracking-wide' } as const;

export const Button: React.FC<ButtonProps> = ({ variant = 'primary', size = 'md', loading = false, className, disabled, children, ...rest }) => (
  <button
    className={cx(
      'inline-flex items-center justify-center gap-2 rounded-lg transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
      BUTTON_VARIANTS[variant],
      BUTTON_SIZES[size],
      className
    )}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    {...rest}
  >
    {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
    {children}
  </button>
);

/* ------------------------------------------------------------------ Card, Badge, Stat */

export const Card: React.FC<React.HTMLAttributes<HTMLDivElement> & { padded?: boolean }> = ({ className, padded = true, ...rest }) => (
  <div className={cx('rounded-xl border border-line bg-panel', padded && 'p-5', className)} {...rest} />
);

const BADGE_TONES = {
  gold: 'border-gold/30 bg-gold/10 text-gold-light',
  emerald: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  rose: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  amber: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  sky: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  slate: 'border-line bg-panel-raised text-bone-dim',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export const Badge: React.FC<{ tone?: BadgeTone; children: React.ReactNode; className?: string; title?: string }> = ({
  tone = 'slate',
  children,
  className,
  title,
}) => (
  <span
    title={title}
    className={cx('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider', BADGE_TONES[tone], className)}
  >
    {children}
  </span>
);

export const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: React.ReactNode; className?: string }> = ({ label, value, hint, className }) => (
  <div className={className}>
    <div className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">{label}</div>
    <div className="mt-1 font-display text-2xl text-bone">{value}</div>
    {hint && <div className="mt-0.5 text-xs text-bone-mute">{hint}</div>}
  </div>
);

/* ------------------------------------------------------------------ Fields */

interface FieldShell {
  label: string;
  help?: React.ReactNode;
  error?: string | null;
  className?: string;
}

const CONTROL =
  'w-full rounded-lg border bg-ink-deep px-3 text-sm text-bone placeholder:text-bone-mute/70 transition-colors focus:outline-none focus:border-gold/70 disabled:opacity-50';

function Shell({ id, label, help, error, className, children }: FieldShell & { id: string; children: React.ReactNode }) {
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-bone-dim">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-xs text-rose-300">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-msg`} className="text-xs text-bone-mute">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export const TextField: React.FC<FieldShell & React.InputHTMLAttributes<HTMLInputElement> & { suffix?: React.ReactNode; inputClassName?: string }> = ({
  label,
  help,
  error,
  className,
  suffix,
  inputClassName,
  ...input
}) => {
  const id = useId();
  return (
    <Shell id={id} label={label} help={help} error={error} className={className}>
      <div className="relative">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? `${id}-msg` : undefined}
          className={cx(CONTROL, 'h-10', suffix ? 'pr-16' : undefined, error ? 'border-rose-400/60' : 'border-line', inputClassName)}
          {...input}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-bone-mute">{suffix}</span>}
      </div>
    </Shell>
  );
};

export const TextArea: React.FC<FieldShell & React.TextareaHTMLAttributes<HTMLTextAreaElement> & { inputClassName?: string }> = ({
  label,
  help,
  error,
  className,
  inputClassName,
  ...area
}) => {
  const id = useId();
  return (
    <Shell id={id} label={label} help={help} error={error} className={className}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || help ? `${id}-msg` : undefined}
        className={cx(CONTROL, 'min-h-[96px] py-2 leading-relaxed', error ? 'border-rose-400/60' : 'border-line', inputClassName)}
        {...area}
      />
    </Shell>
  );
};

export const SelectField: React.FC<FieldShell & React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }> = ({
  label,
  help,
  error,
  className,
  options,
  ...select
}) => {
  const id = useId();
  return (
    <Shell id={id} label={label} help={help} error={error} className={className}>
      <select id={id} className={cx(CONTROL, 'h-10', error ? 'border-rose-400/60' : 'border-line')} {...select}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
};

/* ------------------------------------------------------------------ Modal */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  width?: 'sm' | 'md' | 'lg';
  /** Blocks closing (Escape, backdrop, X) while something irreversible is in flight. */
  locked?: boolean;
}

export const Modal: React.FC<ModalProps> = ({ open, onClose, title, subtitle, children, width = 'md', locked = false }) => {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, locked, onClose]);

  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-4 backdrop-blur-sm sm:items-center" onMouseDown={() => !locked && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx('animate-fade relative max-h-[90vh] w-full overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-lift focus:outline-none', widths[width])}
      >
        {!locked && (
          <button onClick={onClose} className="absolute right-4 top-4 rounded-md p-1 text-bone-mute hover:bg-panel-raised hover:text-bone" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        )}
        <h2 id={titleId} className="pr-8 font-display text-xl text-bone">
          {title}
        </h2>
        {subtitle && <div className="mt-1 text-sm text-bone-mute">{subtitle}</div>}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ Notice */

const NOTICE_TONES = {
  info: 'border-sky-400/25 bg-sky-400/[0.06] text-sky-100',
  warn: 'border-amber-400/30 bg-amber-400/[0.07] text-amber-100',
  danger: 'border-rose-400/30 bg-rose-400/[0.07] text-rose-100',
  gold: 'border-gold/30 bg-gold/[0.07] text-gold-pale',
} as const;

export const Notice: React.FC<{ tone?: keyof typeof NOTICE_TONES; icon?: React.ReactNode; title?: React.ReactNode; children?: React.ReactNode; className?: string }> = ({
  tone = 'info',
  icon,
  title,
  children,
  className,
}) => (
  <div className={cx('flex gap-3 rounded-lg border px-4 py-3 text-sm', NOTICE_TONES[tone], className)} role={tone === 'danger' ? 'alert' : undefined}>
    {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
    <div className="min-w-0 space-y-1">
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className="leading-relaxed opacity-90">{children}</div>}
    </div>
  </div>
);
