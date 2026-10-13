import { ExternalLink, Sprout } from 'lucide-react';
import { EXAMPLE_STAKE_USD, compactNumber, earnsLine, formatUnits, type SingleStakeYield } from 'quai-service';
import { Badge, smallBtn } from './ui';
import { TokenAvatar } from './TokenBubble';
import { formatUsd } from './TokenPicker';
import { pctText } from './YieldBoard';
import './singleStake.css';

/** Everything the row shows about one single-token pool the farm has not added yet. */
export interface PlannedSingleView {
  /** Lower-case token address. */
  token: string;
  symbol: string;
  iconUrl?: string;
  decimals: number | null;
  /** What the connected wallet holds of the token; undefined when no wallet is connected or the read failed. */
  walletBalance: bigint | undefined;
  yieldInfo: SingleStakeYield;
}

interface Props {
  view: PlannedSingleView;
  rewards: { a: { symbol: string; decimals: number }; b: { symbol: string; decimals: number } };
  wallet: string | null;
  isOwner: boolean;
  /** The board is still reading pools: an estimate that is not there yet is "coming", not "unknown". */
  loading: boolean;
  /** Why this wallet will not be offered a deposit once the pool exists (the BDELTA-on-Quainance rule); null when it will. */
  gateReason?: string | null;
  onConnect: () => void;
  onOpenAdmin: () => void;
}

const usd = (n: number | null): string => (n === null ? '—' : n === 0 ? '$0' : formatUsd(n) || '—');

/**
 * A single-token pool (stake Q0 or BDELTA itself) that the farm contract can hold but its owner has not added yet.
 * It is a real row with real numbers, labelled as an estimate, and it cannot be deposited into until it is added:
 * there is no pool id on the chain to deposit to.
 */
export default function SingleStakeRow({ view, rewards, wallet, isOwner, loading, gateReason, onConnect, onOpenAdmin }: Props) {
  const y = view.yieldInfo;
  const r = y.reward;
  const share = r.sharePct;
  const hasEstimate = r.apr !== null;
  const held =
    view.walletBalance !== undefined && view.decimals !== null
      ? `${compactNumber(Number(formatUnits(view.walletBalance, view.decimals, 6)), 4)} ${view.symbol}`
      : null;

  const aprTitle = hasEstimate
    ? `Estimate for when the farm owner adds this pool. It gets about ${share?.toFixed(1)}% of the farm's rewards, about ${usd(y.yearlyUsd)} a year, ` +
      `shared by everyone who deposits. Measured as if every ${view.symbol} in existence were deposited, so it is the lowest it can be; it rises when fewer are deposited. ` +
      `It is not a promise.`
    : r.status === 'NO_FARM'
      ? 'The farm could not be read.'
      : `A price is missing for ${view.symbol} or for a reward, so a yearly yield cannot be worked out.`;

  return (
    <div className="farm-row farm-row-planned" role="row" data-testid={`single-${view.symbol}`}>
      <div className="farm-cell farm-pool" data-label="Pool">
        <span className="farm-avatars">
          <TokenAvatar symbol={view.symbol} iconUrl={view.iconUrl} size="sm" />
        </span>
        <span style={{ minWidth: 0 }}>
          <strong>Stake {view.symbol}</strong>
          <small className="farm-sub">{earnsLine(rewards.a.symbol, rewards.b.symbol)}</small>
          <small className="farm-sub">
            <Badge severity="neutral">Single token</Badge>{' '}
            <Badge severity="warn" title="The farm owner has not added this pool yet, so there is nothing to deposit into. The numbers are estimates.">Not added to the farm yet</Badge>
          </small>
        </span>
      </div>

      <div className="farm-cell" data-label="Share of rewards" title="What this pool would get if its owner added it with an average weight, alongside every other pool that is waiting to join.">
        <strong>{share === null ? '—' : `${share.toFixed(share % 1 === 0 ? 0 : 1)}%`}</strong>
        <small className="farm-sub">{y.dailyA === null || y.dailyB === null ? 'estimate' : `estimate · ${compactNumber(y.dailyA, 2)} ${rewards.a.symbol}/day`}</small>
      </div>

      <div className="farm-cell" data-label="Deposited">
        <strong>—</strong>
        <small className="farm-sub">Nobody yet</small>
      </div>

      <div className="farm-cell" data-label="Yearly yield" title={aprTitle}>
        <strong style={{ color: hasEstimate ? 'var(--success)' : undefined }}>{loading && !hasEstimate ? '…' : pctText(r.apr)}</strong>
        <small className="farm-sub">
          {hasEstimate ? `estimate, if all ${view.symbol} were deposited` : loading ? 'reading prices' : 'unknown'}
        </small>
        {y.exampleApr !== null && (
          <small className="farm-sub farm-example" title={`The pool's whole reward divided by ${usd(EXAMPLE_STAKE_USD)}: what a deposit this size would earn if no one else deposited. It falls as others deposit.`}>
            {usd(EXAMPLE_STAKE_USD)} alone: {pctText(y.exampleApr)}
            {y.exampleAprBoosted !== null && ` · up to ${pctText(y.exampleAprBoosted)} with QRB`}
          </small>
        )}
      </div>

      <div className="farm-cell" data-label="Your deposit">
        <strong>{wallet ? '0' : '—'}</strong>
        <small className="farm-sub">{!wallet ? 'Connect wallet' : held ? `${held} to deposit` : 'balance unavailable'}</small>
      </div>

      <div className="farm-cell" data-label="Earned">
        <strong>—</strong>
      </div>

      <div className="farm-cell farm-actions-cell">
        {wallet ? (
          isOwner ? (
            <button type="button" className="btn-primary" style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem' }} onClick={onOpenAdmin} title="Open the Admin tab, where this pool can be added">
              <Sprout size={13} /> Add to farm
            </button>
          ) : (
            <button type="button" style={smallBtn} disabled title="Deposits open as soon as the farm owner adds this pool">
              Opens when added
            </button>
          )
        ) : (
          <button type="button" className="btn-primary" style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem' }} onClick={onConnect}>
            Connect
          </button>
        )}
        <a href={`https://quaiscan.io/address/${view.token}`} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: 'none' }} aria-label={`View ${view.symbol} on the explorer`}>
          <ExternalLink size={12} />
        </a>
        {wallet && gateReason && <small className="farm-sub" style={{ color: 'var(--warning)', flexBasis: '100%' }}>{gateReason}</small>}
      </div>
    </div>
  );
}
