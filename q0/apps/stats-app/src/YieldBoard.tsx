import { useMemo, useState } from 'react';
import { AlertTriangle, Droplets, ExternalLink, Percent, Sprout } from 'lucide-react';
import { compactNumber, type FarmState, type YieldRow } from 'quai-service';
import { Badge, Notice, Spinner, muted, smallBtn } from './ui';
import { TokenAvatar } from './TokenBubble';
import { formatUsd } from './TokenPicker';
import type { YieldBoardState } from './useYieldBoard';

const DEX_LABEL = { CIRCLESWAP: 'Circleswap', QUAISWAP: 'Quaiswap', QUAINANCE: 'Quainance' } as const;

export const pctText = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '0%';
  if (n < 0.01) return '<0.01%';
  if (n >= 100_000) return `${compactNumber(n, 1)}%`;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 1 })}%`;
};
const usd = (n: number | null) => (n === null ? '—' : n === 0 ? '$0' : formatUsd(n) || '—');

interface Props {
  board: YieldBoardState;
  farm: FarmState | null;
  /** Logo for a token address (lower-case), when known. */
  iconFor: (address: string) => string | undefined;
  isOwner: boolean;
  onAddLiquidity: () => void;
  /** Opens the admin tab; `pair` is the pool to have ticked and in view. */
  onOpenAdmin: (pair?: string) => void;
}

/**
 * Yield for every pool with liquidity: shown by default, whether or not the farm has added the pool yet.
 * Fees are measured from real swaps; reward APR is actual for a farmed pool and a labelled projection for the rest.
 */
export default function YieldBoard({ board, farm, iconFor, isOwner, onAddLiquidity, onOpenAdmin }: Props) {
  const [token, setToken] = useState('ALL');

  const tokens = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of board.rows) for (const s of [r.token0.symbol, r.token1.symbol]) count.set(s, (count.get(s) ?? 0) + 1);
    // the farm's own tokens first (QRB, BDELTA, Q0...), then by how many pools carry the token
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s, n]) => ({ symbol: s, n }));
  }, [board.rows]);

  const rows = useMemo(
    () => (token === 'ALL' ? board.rows : board.rows.filter(r => r.token0.symbol === token || r.token1.symbol === token)),
    [board.rows, token]
  );

  const unfunded = farm !== null && (farm.rewardAPerSecond > 0n || farm.rewardBPerSecond > 0n) && (farm.inventoryA.available === 0n || farm.inventoryB.available === 0n);
  const projectedAny = rows.some(r => r.reward.projected && r.reward.apr !== null);
  const windowDays = board.windowDays === null ? null : Math.max(1, Math.round(board.windowDays));
  const windowText = windowDays === null ? 'recent' : `${windowDays}-day`;
  const windowPhrase = windowDays === null ? 'recent history' : `${windowDays} days`;

  return (
    <section className="glass-card yield-board" aria-label="Yield by pool">
      <h2 className="farm-title"><Percent size={20} /> What pools earn</h2>
      <p className="yield-intro" style={{ ...muted, fontSize: '0.85rem', margin: '0 0 0.75rem' }}>
        What you would earn each year by adding to a pool: trading fees from real swaps, plus farm rewards.
        {board.emissionUsdPerDay !== null && farm && (
          <> The farm gives out about <strong style={{ color: '#fff' }}>{usd(board.emissionUsdPerDay)}</strong> a day, split between pools.</>
        )}
      </p>

      {unfunded && (
        <Notice tone="warn">
          <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
          <strong>The farm has no rewards to give out yet.</strong> The farm figures below are estimates for once it is topped up; until then, adding to a pool earns
          trading fees only.
        </Notice>
      )}

      {board.status === 'loading' && <div style={{ ...muted, fontSize: '0.85rem', padding: '0.5rem 0' }}><Spinner /> Loading pools…</div>}
      {board.status === 'error' && (
        <Notice tone="danger">Could not load pool yields ({board.error}). We show nothing rather than numbers that might be wrong.</Notice>
      )}
      {board.status === 'ready' && board.scanning && (
        <div style={{ ...muted, fontSize: '0.8rem', padding: '0.25rem 0 0.6rem' }}>
          <Spinner /> Working out trading fees{board.scanProgress ? ` (${board.scanProgress.done} of ${board.scanProgress.total})` : ''}
          {windowDays !== null && <>, covering the last {windowPhrase} so far</>}…
        </div>
      )}
      {board.status === 'ready' && board.partialHistory && (
        <Notice tone="info">Older swaps could not be loaded, so trading fees cover the last {windowPhrase} rather than a full week.</Notice>
      )}
      {board.status === 'ready' && !board.scanning && board.error && board.windowDays === null && (
        <Notice tone="warn">Trading fees could not be loaded ({board.error}). They are unknown, not zero; the rest below is unaffected.</Notice>
      )}

      {board.status === 'ready' && (
        <>
          <div className="qn-chips" role="tablist" aria-label="Filter by token" style={{ marginBottom: '0.75rem' }}>
            <button type="button" role="tab" aria-selected={token === 'ALL'} className={`qn-chip${token === 'ALL' ? ' active' : ''}`} onClick={() => setToken('ALL')}>
              All <span>{board.rows.length}</span>
            </button>
            {tokens.map(t => (
              <button key={t.symbol} type="button" role="tab" aria-selected={token === t.symbol} className={`qn-chip${token === t.symbol ? ' active' : ''}`} onClick={() => setToken(t.symbol)}>
                {t.symbol} <span>{t.n}</span>
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <div className="qn-empty">No pool has that token yet.</div>
          ) : (
            <div className="farm-table" role="table" aria-label="Pool yield">
              <div className="farm-head" role="row">
                <span>Pool</span>
                <span>Pool size</span>
                <span>Traded ({windowText})</span>
                <span>Trading fees</span>
                <span>Farm rewards</span>
                <span>Total per year</span>
                <span />
              </div>
              {rows.map(r => (
                <YieldRowView key={r.pair} row={r} iconFor={iconFor} isOwner={isOwner} measuring={board.scanning} onAddLiquidity={onAddLiquidity} onOpenAdmin={onOpenAdmin} />
              ))}
            </div>
          )}

          <details className="farm-details" style={{ marginTop: '0.75rem' }}>
            <summary>How these numbers work</summary>
            <ul className="farm-safety" style={{ marginTop: '0.5rem' }}>
              <li>
                <strong>Trading fees</strong> are your share of the fee on swaps over the last {windowPhrase}, scaled to a year. No swaps means 0%.
              </li>
              <li>
                <strong>Farm rewards</strong> are real for pools already in the farm{projectedAny ? ', and an estimate for the others (marked), assuming they join with an average share' : ''}.
                They change with every deposit and every price.
              </li>
              <li>These are not promises. Small pools swing a lot on a single trade, and prices come from the pools themselves.</li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

function YieldRowView({
  row,
  iconFor,
  isOwner,
  measuring,
  onAddLiquidity,
  onOpenAdmin
}: {
  row: YieldRow;
  iconFor: (a: string) => string | undefined;
  isOwner: boolean;
  /** Swap history is still arriving: an empty fee figure means "not yet", not "none". */
  measuring: boolean;
  onAddLiquidity: () => void;
  onOpenAdmin: (pair?: string) => void;
}) {
  const r = row.reward;
  const farming = r.status === 'FARMING';
  const rewardTitle =
    r.apr === null
      ? 'Needs a price for the pool and for both reward tokens.'
      : `${r.sharePct?.toFixed(1)}% of the farm's rewards${farming ? '' : ' (assumed: the pool joins with an average share)'}, about ${usd(r.dailyUsd)} a day, ${
          r.basis === 'staked' ? 'measured on what is deposited' : "measured on the whole pool (nobody has deposited yet)"
        }.`;

  return (
    <div className="farm-row" role="row">
      <div className="farm-cell farm-pool" data-label="Pool">
        <span className="farm-avatars">
          <TokenAvatar symbol={row.token0.symbol} iconUrl={iconFor(row.token0.address.toLowerCase())} size="sm" />
          <TokenAvatar symbol={row.token1.symbol} iconUrl={iconFor(row.token1.address.toLowerCase())} size="sm" />
        </span>
        <span style={{ minWidth: 0 }}>
          <strong>{row.name}</strong>
          <small className="farm-sub">
            <Badge severity={row.dex === 'CIRCLESWAP' ? 'info' : 'neutral'}>{DEX_LABEL[row.dex]}</Badge>{' '}
            {farming ? <Badge severity="ok">Farming #{r.pid}</Badge> : r.status === 'NOT_FARMING' ? <Badge severity="warn" title="Has liquidity; the farm owner has not added it yet">Not in farm yet</Badge> : null}
            {row.thin && <> <Badge severity="warn" title="Under $1,000 in the pool: one trade moves these numbers a lot">Small pool</Badge></>}
          </small>
        </span>
      </div>

      <div className="farm-cell" data-label="Pool size">
        <strong>{usd(row.liquidityUsd)}</strong>
        <small className="farm-sub">{row.liquidityUsd === null ? 'no price' : 'in the pool'}</small>
      </div>

      <div className="farm-cell" data-label="Traded">
        <strong>{row.volumeUsd === null && measuring ? '…' : usd(row.volumeUsd)}</strong>
        <small className="farm-sub">{row.volumeUsd === null ? (measuring ? 'reading swaps' : 'unavailable') : `${row.swaps.toLocaleString('en-US')} swap${row.swaps === 1 ? '' : 's'}`}</small>
      </div>

      <div className="farm-cell" data-label="Trading fees" title={`${(row.lpFeeBps / 100).toFixed(2)}% of each swap goes to liquidity providers`}>
        <strong style={{ color: row.feeApr ? 'var(--success)' : undefined }}>{row.feeApr === null && measuring ? '…' : pctText(row.feeApr)}</strong>
        <small className="farm-sub">{(row.lpFeeBps / 100).toFixed(2)}% per swap</small>
      </div>

      <div className="farm-cell" data-label="Farm rewards" title={rewardTitle}>
        <strong style={{ color: r.apr ? 'var(--success)' : undefined }}>{pctText(r.apr)}</strong>
        <small className="farm-sub">
          {r.apr === null ? 'unknown' : r.projected ? 'estimate' : 'current'}
          {r.aprBoosted !== null && ` · up to ${pctText(r.aprBoosted)} with QRB`}
        </small>
      </div>

      <div className="farm-cell" data-label="Total per year">
        <strong style={{ color: row.totalApr ? 'var(--success)' : undefined }}>{pctText(row.totalApr)}</strong>
        <small className="farm-sub">{row.totalAprBoosted !== null && `up to ${pctText(row.totalAprBoosted)} with QRB`}</small>
      </div>

      <div className="farm-cell farm-actions-cell">
        <button type="button" className="btn-primary" style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem' }} onClick={onAddLiquidity}>
          <Droplets size={13} /> Add to pool
        </button>
        {r.status === 'NOT_FARMING' && isOwner && (
          <button type="button" style={smallBtn} onClick={() => onOpenAdmin(row.pair)} title="Open the Admin tab with this pool ticked, ready to add to the farm">
            <Sprout size={12} /> Add to farm
          </button>
        )}
        <a href={`https://explorer.qu.ai/address/${row.pair}`} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: 'none' }} aria-label={`View ${row.name} on the explorer`}>
          <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}
