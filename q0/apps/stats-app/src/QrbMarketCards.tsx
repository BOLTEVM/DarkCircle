import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { describeAge } from './pollScheduler';
import { formatUsd } from './TokenPicker';
import type { QrbMarket } from './useQrbMarket';
import './qrbMarket.css';

/** A figure older than this reads "stale", whatever the last poll said (a hidden tab does not poll). */
const STALE_AFTER_MS = 95_000;

const money = (n: number | null): string => (n === null ? '—' : formatUsd(n) || '—');

/** Re-render each second so "12 s ago" counts up without anything being refetched. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The Price and Market Cap cards of the QRB page, fed by a background poll. They sit in the page's own trait grid, so
 * this renders two cards (a fragment). The height of each card is fixed whether or not a number is there, so a refresh
 * never moves the page; an unknown number is an em dash, never 0.
 */
export default function QrbMarketCards({ market }: { market: QrbMarket }) {
  const now = useNow();
  const { view, status, refreshing, error, snapshot } = market;
  const hasPrice = view.priceUsd !== null;
  const age = view.asOf === null ? null : Math.max(0, now - view.asOf);
  const held = view.degraded || status === 'stale' || status === 'error' || (age !== null && age > STALE_AFTER_MS);

  // one short line under each figure: where it comes from and how old it is
  let tone: 'live' | 'stale' | 'idle' = 'idle';
  let line: string;
  if (!market.deployed) {
    line = 'Qrb is not deployed yet';
  } else if (!hasPrice) {
    if (status === 'error') {
      tone = 'stale';
      line = 'Could not read the pools; retrying';
    } else if (status === 'loading' || refreshing) {
      line = 'Reading the pools…';
    } else {
      line = 'No pool prices it yet';
    }
  } else if (held) {
    tone = 'stale';
    line = `Stale · ${age === null ? 'last read time unknown' : describeAge(age)}`;
  } else {
    tone = 'live';
    line = `Updated ${age === null ? 'now' : describeAge(age)}`;
  }

  const failedNames = snapshot?.failed.map(f => (f === 'pools' ? 'pools' : 'explorer')).join(' and ');
  const hint = !held
    ? undefined
    : error
      ? `Showing the last good figure. ${error}`
      : failedNames
        ? `Showing the last good figure: the ${failedNames} could not be read just now.`
        : 'Showing the last good figure.';
  const priceFrom = view.priceSource === 'pools' ? 'from pools' : view.priceSource === 'explorer' ? 'explorer' : '';
  const capFrom = view.marketCapSource === 'explorer' ? 'explorer' : view.marketCapSource === 'supply' ? 'price × supply' : '';

  return (
    <>
      <div className="qrb-trait-card qrb-market-card" data-testid="qrb-price" data-state={tone}>
        <div className="qrb-trait-name">
          Price
          <button type="button" className="qrb-market-refresh" onClick={() => void market.refresh()} disabled={refreshing || !market.deployed} aria-label="Refresh the QRB price and market cap" title="Read the pools again now">
            <RefreshCw size={11} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
        <div className="qrb-trait-val qrb-market-val" style={{ color: 'var(--accent-neon)' }} title={view.priceSource === 'pools' ? 'Derived from the Circleswap pool reserves' : undefined}>
          {money(view.priceUsd)}
          {priceFrom && <small className="qrb-market-from"> · {priceFrom}</small>}
        </div>
        <div className={`qrb-market-age ${tone}`} role="status" aria-live="off" title={hint}>
          <span className="qrb-market-dot" aria-hidden="true" />
          {line}
        </div>
      </div>
      <div className="qrb-trait-card qrb-market-card" data-testid="qrb-marketcap" data-state={tone}>
        <div className="qrb-trait-name">Market Cap</div>
        <div className="qrb-trait-val qrb-market-val" style={{ color: 'var(--accent-neon)' }} title="Price × total supply">
          {money(view.marketCapUsd)}
        </div>
        <div className={`qrb-market-age ${tone}`} title={hint}>
          <span className="qrb-market-dot" aria-hidden="true" />
          {capFrom ? capFrom : ' '}
        </div>
      </div>
    </>
  );
}
