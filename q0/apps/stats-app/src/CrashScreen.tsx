import { Component, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';

/**
 * What the person sees instead of a blank page when the app cannot render. A phone has no console, so the screen
 * carries its own diagnostics: copy them, or reload, or open the app without any wallet detection (the one thing a
 * misbehaving wallet extension can break).
 */

export interface CrashDetails {
  message: string;
  stack: string;
  where: string;
}

const wrap: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1.25rem',
  color: '#f3f4f6',
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif"
};

const card: React.CSSProperties = {
  width: '100%',
  maxWidth: 560,
  background: 'rgba(18, 22, 41, 0.85)',
  border: '1px solid rgba(255, 51, 68, 0.4)',
  borderRadius: 18,
  padding: '1.25rem 1.25rem 1rem',
  boxShadow: '0 16px 48px rgba(0,0,0,0.5)'
};

const btn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.14)',
  color: '#fff',
  borderRadius: 10,
  padding: '0.55rem 0.9rem',
  fontSize: '0.85rem',
  fontWeight: 700,
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-block'
};

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Facts that explain a startup failure without exposing anything private (no addresses, no balances). */
export function environmentReport(): string {
  const w = window as any;
  const shape = (v: any) =>
    safe(() => (v === undefined ? 'absent' : v === null ? 'null' : `${typeof v}${v.isBraveWallet ? ' brave' : ''}${v.isPelagus ? ' pelagus' : ''}${v.isMetaMask ? ' metamask' : ''}${typeof v.on === 'function' ? ' on()' : ' no-on'}`), 'unreadable');
  const storage = safe(() => {
    const k = '__probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return 'ok';
  }, 'blocked');
  return [
    `url: ${safe(() => location.origin + location.pathname, '?')}`,
    `agent: ${safe(() => navigator.userAgent, '?')}`,
    `storage: ${storage}`,
    `pelagus: ${shape(safe(() => w.pelagus, undefined))}`,
    `quai: ${shape(safe(() => w.quai, undefined))}`,
    `ethereum: ${shape(safe(() => w.ethereum, undefined))}`,
    `time: ${new Date().toISOString()}`
  ].join('\n');
}

export function CrashScreen({ error, title = 'Circleswap hit a problem' }: { error: CrashDetails; title?: string }) {
  const [copied, setCopied] = useState(false);
  const report = useMemo(() => `${error.where}: ${error.message}\n\n${environmentReport()}\n\n${error.stack}`.slice(0, 4000), [error]);
  const noWalletUrl = useMemo(() => {
    try {
      const url = new URL(location.href);
      url.searchParams.set('nowallet', '1');
      return url.toString();
    } catch {
      return '?nowallet=1';
    }
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      /* clipboard blocked: the details are on screen to select */
    }
  };

  return (
    <div style={wrap} role="alert">
      <div style={card}>
        <h1 style={{ fontSize: '1.2rem', fontWeight: 800, margin: '0 0 0.4rem', color: '#fff' }}>{title}</h1>
        <p style={{ margin: '0 0 0.9rem', color: '#9ca3af', fontSize: '0.88rem', lineHeight: 1.5 }}>
          The page could not finish loading, so instead of a blank screen here is what went wrong. Your funds and wallet are not affected: nothing is sent
          without a confirmation in your own wallet.
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '0.7rem', fontSize: '0.78rem', margin: '0 0 0.9rem', color: '#fca5a5' }}>
          {error.where}: {error.message}
        </pre>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
          <button type="button" style={{ ...btn, background: 'linear-gradient(135deg, #ff3344, #00f2fe)', border: 'none', color: '#000' }} onClick={() => location.reload()}>
            Reload
          </button>
          <a style={btn} href={noWalletUrl}>
            Open without wallet detection
          </a>
          <button type="button" style={btn} onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
        <details>
          <summary style={{ cursor: 'pointer', color: '#9ca3af', fontSize: '0.8rem' }}>Technical details</summary>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.7rem', color: '#9ca3af', marginTop: '0.5rem', maxHeight: '18rem', overflow: 'auto' }}>{report}</pre>
        </details>
      </div>
    </div>
  );
}

interface BoundaryState {
  error: Error | null;
}

/**
 * Contains a failure to one section of the page. The navigation, the wallet button and the other tabs keep working, and
 * switching tabs (a new `key`) or pressing Try again re-renders the section from scratch.
 */
export class SectionBoundary extends Component<{ children: ReactNode; label?: string }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[Circleswap] ${this.props.label ?? 'section'} failed:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: 14, padding: '1rem 1.1rem', margin: '1rem 0', color: '#f3f4f6' }}
      >
        <strong>{this.props.label ?? 'This section'} could not be shown.</strong>
        <p style={{ margin: '0.4rem 0 0.7rem', color: '#9ca3af', fontSize: '0.85rem', wordBreak: 'break-word' }}>
          {error.message || String(error)} Nothing was sent from your wallet. The rest of the app is unaffected.
        </p>
        <button type="button" style={btn} onClick={() => this.setState({ error: null })}>
          Try again
        </button>{' '}
        <button type="button" style={btn} onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

/** Catches anything the app throws while rendering or in an effect, which React 19 otherwise answers by unmounting everything. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[Circleswap] render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <CrashScreen error={{ message: error.message || String(error), stack: error.stack ?? '', where: 'Render error' }} />;
  }
}
