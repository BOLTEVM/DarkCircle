import { useState, type CSSProperties, type ReactNode } from 'react';
import { Copy, Check, ExternalLink } from 'lucide-react';
import { ModalBody, ModalFooter, ModalHeader, ModalShell } from './ModalShell';

// Small shared pieces for the pair explorer and the deploy modals, in the same visual language as PoolModal.

export const box: CSSProperties = {
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid var(--panel-border)',
  borderRadius: '12px',
  padding: '0.75rem 1rem'
};
export const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid var(--panel-border)',
  borderRadius: '8px',
  outline: 'none',
  color: '#fff',
  fontSize: '0.9rem',
  padding: '0.5rem 0.6rem',
  fontFamily: 'inherit'
};
export const select: CSSProperties = {
  maxWidth: '100%',
  minWidth: 0,
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid var(--panel-border)',
  borderRadius: '8px',
  color: '#fff',
  padding: '0.35rem 0.5rem',
  fontWeight: 700
};
export const row: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.5rem' };
export const muted: CSSProperties = { color: 'var(--text-muted)' };
export const smallBtn: CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid var(--panel-border)',
  color: 'var(--text-main)',
  borderRadius: '8px',
  fontSize: '0.75rem',
  fontWeight: 700,
  cursor: 'pointer',
  padding: '0.35rem 0.7rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem'
};

export const EXPLORER_ADDRESS = 'https://quaiscan.io/address/';
export const EXPLORER_TX = 'https://explorer.qu.ai/tx/';

export const shortAddr = (a: string | null | undefined) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—');

/**
 * A dialog. Drawn by ModalShell (portalled into <body>, sized without viewport units, page scroll locked, header fixed and
 * the body scrolling inside it); see ModalShell.tsx for why. footer is an optional strip that stays visible under the
 * scrolling body, for a primary action that must always be reachable.
 */
export function Modal({
  title,
  icon,
  onClose,
  children,
  maxWidth = 560,
  locked = false,
  footer
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
  /** While true (a transaction is in flight) the modal cannot be dismissed by accident. */
  locked?: boolean;
  footer?: ReactNode;
}) {
  return (
    <ModalShell label={title} onClose={onClose} locked={locked} maxWidth={maxWidth}>
      <ModalHeader title={title} icon={icon} onClose={onClose} locked={locked} />
      <ModalBody>{children}</ModalBody>
      {footer && <ModalFooter>{footer}</ModalFooter>}
    </ModalShell>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: '0.85rem' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>{hint}</div>}
    </label>
  );
}

export function Notice({ tone, children }: { tone: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const c = { info: '0, 242, 254', warn: '245, 158, 11', danger: '239, 68, 68', ok: '16, 185, 129' }[tone];
  return (
    <div style={{ background: `rgba(${c}, 0.08)`, border: `1px solid rgba(${c}, 0.35)`, borderRadius: '10px', padding: '0.6rem 0.8rem', fontSize: '0.8rem', lineHeight: 1.45, marginBottom: '0.85rem' }}>
      {children}
    </div>
  );
}

const SEVERITY_COLOR = { info: 'var(--accent-neon)', ok: 'var(--success)', warn: 'var(--warning)', danger: 'var(--error)' } as const;

export function Badge({ severity = 'info', children, title }: { severity?: 'info' | 'ok' | 'warn' | 'danger' | 'neutral'; children: ReactNode; title?: string }) {
  const color = severity === 'neutral' ? 'var(--text-muted)' : SEVERITY_COLOR[severity];
  return (
    <span
      title={title}
      style={{ display: 'inline-block', fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.3px', textTransform: 'uppercase', color, border: `1px solid ${color}`, borderRadius: '999px', padding: '0.05rem 0.45rem', whiteSpace: 'nowrap' }}
    >
      {children}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      style={smallBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is on screen to select */
        }
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />} {done ? 'Copied' : label}
    </button>
  );
}

export function AddrLink({ address, tx }: { address: string; tx?: boolean }) {
  return (
    <a href={(tx ? EXPLORER_TX : EXPLORER_ADDRESS) + address} target="_blank" rel="noreferrer" className="link-hash" title={address}>
      {shortAddr(address)} <ExternalLink size={10} style={{ verticalAlign: 'baseline' }} />
    </a>
  );
}

export function Spinner() {
  return <span className="loader" style={{ display: 'inline-block', width: 14, height: 14, verticalAlign: 'middle' }} />;
}
