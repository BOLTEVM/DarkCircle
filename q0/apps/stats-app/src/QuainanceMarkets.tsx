import { useMemo, useState } from 'react';
import { ExternalLink, Search, TrendingUp } from 'lucide-react';
import { compactNumber, formatUnits, type QuainanceAggregate, type QuainanceAggregatePool, type QuainanceMarket } from 'quai-service';
import { Badge, Spinner, input, muted, smallBtn } from './ui';
import { formatUsd } from './TokenPicker';
import type { CatalogLoad } from './quainanceCatalog';

const PAGE = 25;

const SOURCE_LABEL: Record<string, string> = {
  HARTII: 'Hartii',
  QUAINANCE_CURVE: 'Quainance curve',
  POOP_V1: 'POOP v1',
  POOP_V2: 'POOP v2',
  QUAINANCE_LAUNCHER: 'Launcher'
};
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

type Row = { kind: 'PAIR'; key: string; pool: QuainanceAggregatePool } | { kind: 'MARKET'; key: string; market: QuainanceMarket };

interface Props {
  agg: QuainanceAggregate | null;
  stale: boolean;
  loading: boolean;
  catalog: CatalogLoad | null;
  quaiUsd: number | null;
  /** The swap route id for a pair when it can be traded in this app, else null. */
  tradeRouteFor: (pool: QuainanceAggregatePool) => string | null;
  onTrade: (routeId: string) => void;
}

const usd = (n: number | null) => (n === null ? '—' : n === 0 ? '$0' : formatUsd(n) || '—');
const when = (s: number | null) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—');
const explorer = (address: string) => `https://explorer.qu.ai/address/${address}`;

/**
 * Every Quainance market in one list, by default: all the factory's AMM pairs plus the launchpad markets (Hartii and
 * QAXE among them). Filter chips narrow it; nothing is hidden until you choose to.
 */
export default function QuainanceMarkets({ agg, stale, loading, catalog, quaiUsd, tradeRouteFor, onTrade }: Props) {
  const [chip, setChip] = useState<string>('ALL');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);

  const chips = useMemo(() => {
    if (!agg) return [] as { id: string; label: string; count: number }[];
    const list = [{ id: 'ALL', label: 'All', count: agg.pools.length + agg.markets.length }, { id: 'PAIRS', label: 'AMM pairs', count: agg.pools.length }];
    // Hartii first: it is the launchpad with QAXE, HRT and ART
    const sources = Object.entries(agg.totals.marketsBySource).sort(([a], [b]) => (a === 'HARTII' ? -1 : b === 'HARTII' ? 1 : a.localeCompare(b)));
    for (const [source, count] of sources) list.push({ id: `SRC:${source}`, label: sourceLabel(source), count });
    return list;
  }, [agg]);

  const rows = useMemo<Row[]>(() => {
    if (!agg) return [];
    const q = query.trim().toLowerCase();
    const all: Row[] = [
      ...agg.pools.map(pool => ({ kind: 'PAIR' as const, key: pool.pair, pool })),
      ...agg.markets.map(market => ({ kind: 'MARKET' as const, key: `${market.source}:${market.token.address}`, market }))
    ];
    return all.filter(r => {
      if (chip === 'PAIRS' && r.kind !== 'PAIR') return false;
      if (chip.startsWith('SRC:') && !(r.kind === 'MARKET' && r.market.source === chip.slice(4))) return false;
      if (!q) return true;
      const hay =
        r.kind === 'PAIR'
          ? `${r.pool.name} ${r.pool.pair} ${r.pool.token0.address} ${r.pool.token1.address}`
          : `${r.market.token.symbol} ${r.market.token.name} ${r.market.token.address} ${r.market.curve ?? ''} ${sourceLabel(r.market.source)}`;
      return hay.toLowerCase().includes(q);
    });
  }, [agg, chip, query]);

  const totals = agg?.totals;

  return (
    <div className="glass-card">
      <h2 className="section-title">
        <TrendingUp size={20} style={{ color: 'var(--accent-gold)' }} />
        Quainance DEX &mdash; all pairs &amp; markets
        {stale && (
          <span className="lp-badge" style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', border: '1px solid rgba(245, 158, 11, 0.2)', fontSize: '0.6rem', marginLeft: '0.5rem' }}>STALE</span>
        )}
      </h2>

      {loading && !agg && (
        <div style={{ ...muted, fontSize: '0.85rem' }}><Spinner /> Reading every Quainance pair from its factory…</div>
      )}

      {agg && totals && (
        <>
          <div className="lp-price-metric" style={{ marginBottom: '0.75rem' }}>
            <span className="lp-price-label">Quainance TVL{totals.tvlComplete ? '' : ' (priced pairs only)'}</span>
            <span className="lp-price-value">{usd(totals.tvlUsd)}</span>
          </div>
          <p style={{ ...muted, fontSize: '0.8rem', margin: '0 0 0.75rem' }}>
            {totals.pairs} AMM pair{totals.pairs === 1 ? '' : 's'} ({totals.listed} tradable here) &middot; {totals.markets} launchpad market{totals.markets === 1 ? '' : 's'}
            {totals.volume24hUsd !== null && <> &middot; 24h volume {usd(totals.volume24hUsd)}</>}
            {totals.loaded < totals.pairs && <> &middot; {totals.pairs - totals.loaded} pair(s) could not be read</>}
          </p>
          {!agg.source.explorer && (
            <p style={{ ...muted, fontSize: '0.75rem', margin: '0 0 0.75rem' }}>
              Quainance&apos;s indexed stats are not readable from this page, so USD values are estimated from each pair&apos;s reserves and volumes are not shown.
            </p>
          )}
          {catalog === null ? (
            <p style={{ ...muted, fontSize: '0.75rem', margin: '0 0 0.75rem' }}>
              The launchpad catalog (Hartii, QAXE, POOP, curves) could not be read, so only AMM pairs are listed.
            </p>
          ) : (
            catalog.source === 'snapshot' && (
              <p style={{ ...muted, fontSize: '0.75rem', margin: '0 0 0.75rem' }}>
                Launchpad markets are a snapshot from {when(catalog.asOf)}: Quainance&apos;s live feed cannot be read from this site. Prices and trade counts may be out of date.
              </p>
            )
          )}

          <div className="qn-toolbar">
            <div className="qn-chips" role="tablist" aria-label="Quainance market filter">
              {chips.map(c => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={chip === c.id}
                  className={`qn-chip${chip === c.id ? ' active' : ''}`}
                  onClick={() => {
                    setChip(c.id);
                    setShown(PAGE);
                  }}
                >
                  {c.label} <span>{c.count}</span>
                </button>
              ))}
            </div>
            <label className="farm-search" style={{ minWidth: 220 }}>
              <Search size={14} />
              <input
                style={{ ...input, paddingLeft: '1.9rem' }}
                placeholder="Search token, pair or address"
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setShown(PAGE);
                }}
                aria-label="Search Quainance markets"
              />
            </label>
          </div>

          <div className="qn-list">
            {rows.slice(0, shown).map(r =>
              r.kind === 'PAIR' ? (
                <PairRow key={r.key} pool={r.pool} routeId={tradeRouteFor(r.pool)} onTrade={onTrade} />
              ) : (
                <MarketRow key={r.key} market={r.market} quaiUsd={quaiUsd} />
              )
            )}
            {rows.length === 0 && <div className="qn-empty">Nothing matches.</div>}
          </div>

          {rows.length > shown && (
            <div style={{ textAlign: 'center', marginTop: '0.75rem' }}>
              <button type="button" style={smallBtn} onClick={() => setShown(n => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more ({rows.length - shown} left)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PairRow({ pool, routeId, onTrade }: { pool: QuainanceAggregatePool; routeId: string | null; onTrade: (id: string) => void }) {
  const r0 = Number(formatUnits(pool.reserve0, pool.token0.decimals, 6));
  const r1 = Number(formatUnits(pool.reserve1, pool.token1.decimals, 6));
  const rate = r0 > 0 ? r1 / r0 : null;
  return (
    <div className="qn-row">
      <div className="qn-main">
        <strong>{pool.name}</strong>
        <span className="qn-badges">
          <Badge severity="info">AMM pair</Badge>
          {pool.listed ? <Badge severity="ok">Tradable here</Badge> : <Badge severity="neutral" title="One or both tokens are not in this app's token list. Import them to trade here.">Unlisted token</Badge>}
        </span>
      </div>
      <div className="qn-cell" data-label="TVL">
        <strong>{usd(pool.tvlUsd)}</strong>
        <small>{pool.source.tvl === 'reserves' ? 'estimated from reserves' : pool.source.tvl === 'explorer' ? 'indexed' : 'no price'}</small>
      </div>
      <div className="qn-cell" data-label="24h volume">
        <strong>{usd(pool.volume24hUsd)}</strong>
        <small>{pool.txCount !== null ? `${pool.txCount.toLocaleString('en-US')} txs` : ''}</small>
      </div>
      <div className="qn-cell" data-label="Reserves">
        <strong>
          {compactNumber(r0, 2)} {pool.token0.symbol}
        </strong>
        <small>
          {compactNumber(r1, 2)} {pool.token1.symbol}
          {rate !== null && ` · 1 ${pool.token0.symbol} = ${rate < 1e-4 ? rate.toExponential(2) : rate.toFixed(6)} ${pool.token1.symbol}`}
        </small>
      </div>
      <div className="qn-actions">
        {routeId && (
          <button type="button" className="btn-primary" style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', minHeight: 'auto', borderRadius: 8 }} onClick={() => onTrade(routeId)}>
            Trade
          </button>
        )}
        <a href={explorer(pool.pair)} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: 'none' }}>
          <ExternalLink size={12} /> View
        </a>
      </div>
    </div>
  );
}

function MarketRow({ market, quaiUsd }: { market: QuainanceMarket; quaiUsd: number | null }) {
  const priceUsd = market.priceQuai !== null && quaiUsd ? market.priceQuai * quaiUsd : null;
  const capUsd = market.marketCapQuai !== null && quaiUsd ? market.marketCapQuai * quaiUsd : null;
  const phaseSeverity = market.phase === 'BONDING' ? 'info' : market.phase === 'GRADUATED' ? 'ok' : 'neutral';
  return (
    <div className="qn-row">
      <div className="qn-main">
        <strong>{market.token.symbol}</strong> <small style={muted}>{market.token.name}</small>
        <span className="qn-badges">
          <Badge severity="warn" title="A bonding-curve launch, not an AMM pair">{sourceLabel(market.source)}</Badge>
          <Badge severity={phaseSeverity}>{market.phase === 'GRADUATED' ? 'Graduated' : market.phase === 'BONDING' ? 'Bonding' : market.phase === 'POOLED' ? 'Pooled' : 'Unknown'}</Badge>
          {market.listed && <Badge severity="ok">Listed</Badge>}
        </span>
      </div>
      <div className="qn-cell" data-label="Price">
        <strong>{market.priceQuai === null ? '—' : `${compactNumber(market.priceQuai, 6)} QUAI`}</strong>
        <small>{priceUsd !== null ? usd(priceUsd) : ''}</small>
      </div>
      <div className="qn-cell" data-label="Market cap">
        <strong>{market.marketCapQuai === null ? '—' : `${compactNumber(market.marketCapQuai, 2)} QUAI`}</strong>
        <small>{capUsd !== null ? usd(capUsd) : ''}</small>
      </div>
      <div className="qn-cell" data-label="Traded">
        <strong>{compactNumber(market.volumeQuai, 2)} QUAI</strong>
        <small>{market.trades.toLocaleString('en-US')} trades &middot; since {when(market.createdAt)}</small>
      </div>
      <div className="qn-actions">
        <a href={explorer(market.curve ?? market.token.address)} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: 'none' }} title={market.curve ? 'The bonding-curve contract' : 'The token'}>
          <ExternalLink size={12} /> View
        </a>
      </div>
    </div>
  );
}
