import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Coins, Droplets, ExternalLink, Gift, Layers, RefreshCw, Search, Settings2, Sprout, Zap } from 'lucide-react';
import {
  DEPLOYED,
  SECONDS_PER_DAY,
  TOKEN_REGISTRY,
  buildFarmRows,
  compactNumber,
  farmTx,
  formatUnits,
  runwaySeconds,
  type FarmRow,
  type FarmTokenInfo,
  type TokenInfo
} from 'quai-service';
import { Badge, Notice, Spinner, box, input, muted, select, smallBtn, AddrLink } from './ui';
import { TokenAvatar } from './TokenBubble';
import { useTokenProfiles } from './useTokenProfiles';
import { useFarm } from './useFarm';
import { useYieldBoard } from './useYieldBoard';
import { resolveQuaiUsd } from './quaiUsd';
import YieldBoard from './YieldBoard';
import { formatUsd } from './TokenPicker';
import FarmActionModal from './FarmActionModal';
import { describeTxError, sendContractCall } from './farmSend';

const FarmAdminPanel = lazy(() => import('./FarmAdminPanel'));

interface Props {
  walletAddress: string | null;
  onConnect: () => void | Promise<void>;
  /** Opens the add-liquidity dialog, which is how a wallet gets LP tokens to stake. */
  onOpenLiquidity: () => void;
  /** The existing Qrb boost status line for the connected wallet. */
  boostLabel: string;
}

type SortKey = 'tvl' | 'apr' | 'yours' | 'share';
type Toast = { tone: 'info' | 'warn' | 'danger' | 'ok'; body: ReactNode } | null;

const pct = (n: number | undefined): string => {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '0%';
  if (n < 0.01) return '<0.01%';
  if (n >= 100_000) return `${compactNumber(n, 1)}%`;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 1 })}%`;
};
const usd = (n: number | undefined): string => (n === undefined ? '—' : n === 0 ? '$0' : formatUsd(n) || '—');
const days = (s: number | null): string =>
  s === null ? 'no emission' : s >= 365 * SECONDS_PER_DAY ? 'over a year' : s < 3600 ? 'under an hour' : s < SECONDS_PER_DAY ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / SECONDS_PER_DAY)} days`;

export default function FarmsPage({ walletAddress, onConnect, onOpenLiquidity, boostLabel }: Props) {
  const farmAddress = DEPLOYED.MASTERCHEF;
  const { farm, pairs, positions, status, error, updatedAt, refreshing, refresh } = useFarm(farmAddress, walletAddress);
  const board = useYieldBoard(farm);
  const [quaiUsd, setQuaiUsd] = useState<number | null>(null);
  const [tab, setTab] = useState<'POOLS' | 'ADMIN'>('POOLS');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('tvl');
  const [mineOnly, setMineOnly] = useState(false);
  const [action, setAction] = useState<{ mode: 'stake' | 'unstake'; pid: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => {
    let live = true;
    void resolveQuaiUsd().then(v => live && setQuaiUsd(v));
    return () => {
      live = false;
    };
  }, []);

  // ---- token facts: symbols, decimals and prices come from the contracts and the explorer, not a static list ---------
  const registryByAddress = useMemo(() => {
    const map = new Map<string, TokenInfo>();
    for (const t of Object.values(TOKEN_REGISTRY)) if (t.deployed !== false && !t.isNative) map.set(t.address.toLowerCase(), t);
    return map;
  }, []);
  const tokenList = useMemo<TokenInfo[]>(() => {
    const wanted = new Set<string>();
    if (farm) {
      wanted.add(farm.rewardTokenA.toLowerCase());
      wanted.add(farm.rewardTokenB.toLowerCase());
      for (const pool of farm.pools) {
        const pair = pairs[pool.lpToken.toLowerCase()];
        if (pair?.token0 && pair?.token1) {
          wanted.add(pair.token0);
          wanted.add(pair.token1);
        } else wanted.add(pool.lpToken.toLowerCase());
      }
    }
    // every token in the yield board, so each pool shows its logos
    for (const r of board.rows) {
      wanted.add(r.token0.address.toLowerCase());
      wanted.add(r.token1.address.toLowerCase());
    }
    return [...wanted].map(
      address => registryByAddress.get(address) ?? { symbol: `${address.slice(0, 6)}…${address.slice(-4)}`, name: 'Token', decimals: 18, address, deployed: true }
    );
  }, [farm, pairs, registryByAddress, board.rows]);
  const { profiles } = useTokenProfiles(tokenList);

  const tokens = useMemo(() => {
    const out: Record<string, FarmTokenInfo | undefined> = {};
    const wquai = TOKEN_REGISTRY.WQUAI?.address.toLowerCase();
    for (const t of tokenList) {
      const address = t.address.toLowerCase();
      const profile = profiles[address];
      // Decimals come from the contract. The registry value is used only for a token this app itself lists; a stranger
      // whose decimals could not be read stays unknown, so no amount of it is ever scaled by a guess.
      const decimals = profile?.decimals ?? (registryByAddress.has(address) ? t.decimals : undefined);
      if (decimals === undefined) continue;
      out[address] = {
        symbol: profile?.symbol ?? t.symbol,
        decimals,
        priceUsd: profile?.priceUsd ?? (address === wquai && quaiUsd ? quaiUsd : undefined),
        iconUrl: profile?.iconUrl ?? t.iconUrl
      };
    }
    return out;
  }, [tokenList, profiles, registryByAddress, quaiUsd]);

  const built = useMemo(() => (farm ? buildFarmRows({ farm, pairs, tokens, positions }) : null), [farm, pairs, tokens, positions]);
  const rows = built?.rows ?? [];
  const summary = built?.summary;

  const rewardA = farm ? tokens[farm.rewardTokenA.toLowerCase()] : undefined;
  const rewardB = farm ? tokens[farm.rewardTokenB.toLowerCase()] : undefined;
  const rewards = {
    a: { symbol: rewardA?.symbol ?? 'Reward A', decimals: rewardA?.decimals ?? 18 },
    b: { symbol: rewardB?.symbol ?? 'Reward B', decimals: rewardB?.decimals ?? 18 }
  };

  const isOwner = Boolean(farm && walletAddress && farm.owner.toLowerCase() === walletAddress.toLowerCase());
  const isPendingOwner = Boolean(farm?.pendingOwner && walletAddress && farm.pendingOwner.toLowerCase() === walletAddress.toLowerCase());
  // The admin tab is shown to everyone and is read-only unless the connected wallet is the owner: the contract, not the
  // page, decides who may change the farm, and a multisig signer needs the same view and the raw transactions.
  const showAdmin = true;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(r => {
      if (mineOnly && !(r.position && (r.position.staked > 0n || r.position.pendingA > 0n || r.position.pendingB > 0n))) return false;
      return !q || r.label.toLowerCase().includes(q) || r.lpToken.includes(q) || (r.token0 ?? '').includes(q) || (r.token1 ?? '').includes(q);
    });
    // unknown values sort last, never as zero
    const key = (r: FarmRow): number | undefined =>
      sort === 'tvl' ? r.tvlUsd : sort === 'apr' ? r.aprTotal : sort === 'yours' ? r.stakedUsd : r.sharePct;
    return [...list].sort((x, y) => {
      const a = key(x);
      const b = key(y);
      if (a === undefined && b === undefined) return x.pid - y.pid;
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return b - a || x.pid - y.pid;
    });
  }, [rows, query, mineOnly, sort]);

  const actionRow = action ? rows.find(r => r.pid === action.pid) : undefined;

  const requireWallet = useCallback(async () => {
    if (!walletAddress) await onConnect();
  }, [walletAddress, onConnect]);

  const harvest = async (row: FarmRow) => {
    if (!walletAddress || !farm) return;
    setBusy(`harvest:${row.pid}`);
    setToast(null);
    try {
      const res = await sendContractCall(walletAddress, farm.address, farmTx.harvest(row.pid));
      setToast({ tone: 'ok', body: <>Harvested from {row.label}. <AddrLink address={res.txHash} tx /></> });
      await refresh();
    } catch (e: any) {
      setToast({ tone: 'danger', body: describeTxError(e) });
    } finally {
      setBusy(null);
    }
  };

  const harvestAll = async () => {
    if (!walletAddress || !farm) return;
    const todo = rows.filter(r => r.position && (r.position.pendingA > 0n || r.position.pendingB > 0n));
    setBusy('harvest:all');
    setToast(null);
    let done = 0;
    try {
      for (const row of todo) {
        await sendContractCall(walletAddress, farm.address, farmTx.harvest(row.pid));
        done++;
      }
      setToast({ tone: 'ok', body: `Harvested from ${done} pool${done === 1 ? '' : 's'}.` });
    } catch (e: any) {
      setToast({ tone: 'danger', body: `${done} of ${todo.length} harvests completed. ${describeTxError(e)}` });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  // ---- not deployed ---------------------------------------------------------------------------------------------
  if (!farmAddress) {
    return (
      <div className="glass-card">
        <h2 className="farm-title"><Sprout size={20} /> Farms &amp; Pools</h2>
        <Notice tone="warn">The farm contract is not deployed on this network yet, so there is nothing to stake into.</Notice>
      </div>
    );
  }

  const runA = farm ? runwaySeconds(farm.inventoryA.available, farm.rewardAPerSecond, farm.boostBps) : null;
  const runB = farm ? runwaySeconds(farm.inventoryB.available, farm.rewardBPerSecond, farm.boostBps) : null;
  const emitting = farm ? farm.rewardAPerSecond > 0n || farm.rewardBPerSecond > 0n : false;
  const unfunded = farm ? emitting && (farm.inventoryA.available === 0n || farm.inventoryB.available === 0n) : false;
  const lowRunway = farm && emitting && !unfunded && ((runA ?? Infinity) < 7 * SECONDS_PER_DAY || (runB ?? Infinity) < 7 * SECONDS_PER_DAY);
  const anyPending = rows.some(r => r.position && (r.position.pendingA > 0n || r.position.pendingB > 0n));

  return (
    <div className="farms-page">
      {/* header */}
      <div className="glass-card farm-hero">
        <div>
          <h2 className="farm-title"><Sprout size={22} /> Farms &amp; Pools</h2>
          <p style={{ ...muted, fontSize: '0.85rem', margin: 0 }}>
            Stake LP tokens to earn <strong style={{ color: 'var(--accent-plasma)' }}>{rewards.a.symbol}</strong> and{' '}
            <strong style={{ color: 'var(--accent-neon)' }}>{rewards.b.symbol}</strong> every second. Staked tokens are never used to pay rewards and can be withdrawn at any time.
          </p>
        </div>
        <div className="farm-hero-actions">
          <button type="button" className="btn-primary" onClick={onOpenLiquidity} style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}>
            <Droplets size={14} /> Get LP tokens
          </button>
          <span className="farm-boost" title="Holding Qrb raises the rewards you earn.">
            <Zap size={14} /> {boostLabel}
          </span>
        </div>
      </div>

      {/* yield by pool: always first, for every pool with liquidity, whether or not the farm has added it */}
      {tab === 'POOLS' && (
        <YieldBoard
          board={board}
          farm={farm}
          iconFor={address => tokens[address]?.iconUrl}
          isOwner={isOwner}
          onAddLiquidity={onOpenLiquidity}
          onOpenAdmin={() => setTab('ADMIN')}
        />
      )}

      {/* status banners: each says what is wrong and what it means for the person staking */}
      {status === 'error' && !farm && (
        <Notice tone="danger">
          <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
          The farm could not be read: {error} Nothing is shown rather than numbers that might be wrong.{' '}
          <button type="button" style={smallBtn} onClick={() => void refresh()}>Try again</button>
        </Notice>
      )}
      {error && farm && (
        <Notice tone="warn">
          The latest refresh failed ({error}). Showing the farm as of {updatedAt ? new Date(updatedAt).toLocaleTimeString() : 'the last successful read'}.
        </Notice>
      )}
      {farm?.paused && (
        <Notice tone="warn">
          <strong>Deposits and harvests are paused</strong> by the farm owner. You can still unstake, and unstaking pays your earned rewards.
        </Notice>
      )}
      {unfunded && (
        <Notice tone="warn">
          <strong>The farm's reward balance is {farm!.inventoryA.available === 0n && farm!.inventoryB.available === 0n ? 'empty' : 'empty for one of the two rewards'}.</strong> Rewards still accrue and stay owed to you, but they can only be paid once the owner funds the farm. Your stake is not affected.
        </Notice>
      )}
      {lowRunway && (
        <Notice tone="info">
          The reward balance covers about {days(runA)} of {rewards.a.symbol} and {days(runB)} of {rewards.b.symbol} at the current rate.
        </Notice>
      )}
      {farm && farm.pools.length === 0 && status === 'ready' && (
        <Notice tone="info">
          <Layers size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
          There are no farming pools yet. {isOwner ? 'Open the Admin tab to add the first one.' : 'The owner adds pools as pairs launch; check back soon.'}
        </Notice>
      )}
      {toast && <Notice tone={toast.tone}>{toast.body}</Notice>}

      {/* summary */}
      <div className="farm-stats">
        <Stat label="Total staked" value={status === 'ready' ? usd(summary?.tvlUsd) : '…'} hint={summary?.tvlUsd === undefined && status === 'ready' && rows.some(r => r.totalStaked > 0n) ? 'A token price is missing' : undefined} />
        <Stat
          label="Emission / day"
          value={farm ? (summary?.emissionUsdPerDay !== undefined ? usd(summary.emissionUsdPerDay) : `${compactNumber(Number(farm.rewardAPerSecond) / 10 ** rewards.a.decimals * SECONDS_PER_DAY, 2)} ${rewards.a.symbol}`) : '…'}
          hint={farm ? `${compactNumber(Number(farm.rewardAPerSecond) / 10 ** rewards.a.decimals * SECONDS_PER_DAY, 2)} ${rewards.a.symbol} + ${compactNumber(Number(farm.rewardBPerSecond) / 10 ** rewards.b.decimals * SECONDS_PER_DAY, 2)} ${rewards.b.symbol}` : undefined}
        />
        <Stat label="Pools" value={farm ? String(farm.pools.length) : '…'} />
        <Stat
          label="Your stake"
          value={!walletAddress ? 'Connect' : summary ? usd(summary.yourStakedUsd) : '…'}
          hint={walletAddress && summary ? `${summary.poolsWithStake} pool${summary.poolsWithStake === 1 ? '' : 's'}` : undefined}
        />
        <Stat
          label="Your rewards"
          value={!walletAddress ? 'Connect' : summary ? (summary.pendingA === 0 && summary.pendingB === 0 ? '0' : usd(summary.yourPendingUsd)) : '…'}
          hint={walletAddress && summary && (summary.pendingA > 0 || summary.pendingB > 0) ? `${compactNumber(summary.pendingA, 4)} ${rewards.a.symbol} + ${compactNumber(summary.pendingB, 4)} ${rewards.b.symbol}` : undefined}
        />
      </div>

      {/* tabs, search, sort */}
      <div className="farm-toolbar">
        <div className="farm-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'POOLS'} className={`pool-tab-btn ${tab === 'POOLS' ? 'active' : ''}`} onClick={() => setTab('POOLS')}>
            Pools
          </button>
          {showAdmin && (
            <button type="button" role="tab" aria-selected={tab === 'ADMIN'} className={`pool-tab-btn ${tab === 'ADMIN' ? 'active' : ''}`} onClick={() => setTab('ADMIN')}>
              <Settings2 size={13} /> Admin
            </button>
          )}
        </div>
        {tab === 'POOLS' && (
          <div className="farm-filters">
            <label className="farm-search">
              <Search size={14} />
              <input style={{ ...input, paddingLeft: '1.9rem' }} placeholder="Search pool or address" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search pools" />
            </label>
            <select style={select} value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="Sort pools">
              <option value="tvl">Sort: Total staked</option>
              <option value="apr">Sort: APR</option>
              <option value="share">Sort: Reward share</option>
              <option value="yours">Sort: Your stake</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem' }}>
              <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} /> Mine
            </label>
            <button type="button" style={smallBtn} onClick={() => void refresh()} disabled={refreshing} title="Re-read the farm from the chain">
              <RefreshCw size={12} className={refreshing ? 'spin' : ''} /> Refresh
            </button>
            {anyPending && !farm?.paused && (
              <button type="button" className="btn-primary" style={{ fontSize: '0.75rem', padding: '0.35rem 0.8rem' }} disabled={busy !== null} onClick={() => void harvestAll()}>
                {busy === 'harvest:all' ? <><Spinner /> Harvesting…</> : <><Gift size={13} /> Harvest all</>}
              </button>
            )}
          </div>
        )}
      </div>

      {tab === 'ADMIN' && showAdmin && farm && (
        <Suspense fallback={<div style={{ ...box, textAlign: 'center' }}><Spinner /> Loading admin tools…</div>}>
          <FarmAdminPanel
            farm={farm}
            rows={rows}
            tokens={tokens}
            rewards={rewards}
            wallet={walletAddress}
            isOwner={isOwner}
            isPendingOwner={isPendingOwner}
            quaiUsd={quaiUsd}
            onChanged={refresh}
          />
        </Suspense>
      )}

      {tab === 'POOLS' && (
        <>
          {status === 'loading' && !farm && (
            <div style={{ ...box, textAlign: 'center', padding: '2rem' }}><Spinner /> Reading the farm from Cyprus-1…</div>
          )}

          {farm && visible.length > 0 && (
            <div className="farm-table" role="table" aria-label="Farming pools">
              <div className="farm-head" role="row">
                <span>Pool</span>
                <span>Reward share</span>
                <span>Total staked</span>
                <span>APR</span>
                <span>Your stake</span>
                <span>Earned</span>
                <span />
              </div>
              {visible.map(row => (
                <PoolRow
                  key={row.pid}
                  row={row}
                  tokens={tokens}
                  rewards={rewards}
                  wallet={walletAddress}
                  paused={farm.paused}
                  busy={busy}
                  maxBoostPct={Number(farm.boostBps) / 100}
                  onStake={async () => {
                    await requireWallet();
                    setAction({ mode: 'stake', pid: row.pid });
                  }}
                  onUnstake={() => setAction({ mode: 'unstake', pid: row.pid })}
                  onHarvest={() => void harvest(row)}
                />
              ))}
            </div>
          )}

          {farm && rows.length > 0 && visible.length === 0 && (
            <div style={{ ...box, textAlign: 'center' }}>
              No pool matches. {mineOnly ? 'You have no stake or rewards in any pool.' : 'Clear the search to see all pools.'}
            </div>
          )}

          {farm && <FarmDetails farm={farm} rewards={rewards} runA={runA} runB={runB} updatedAt={updatedAt} />}
        </>
      )}

      {action && actionRow && farm && walletAddress && (
        <FarmActionModal
          mode={action.mode}
          row={actionRow}
          farm={farm}
          wallet={walletAddress}
          rewards={rewards}
          onClose={() => setAction(null)}
          onDone={() => void refresh()}
          onGetLp={() => {
            setAction(null);
            onOpenLiquidity();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="farm-stat">
      <div className="farm-stat-label">{label}</div>
      <div className="farm-stat-value">{value}</div>
      {hint && <div className="farm-stat-hint">{hint}</div>}
    </div>
  );
}

function PoolRow({
  row,
  tokens,
  rewards,
  wallet,
  paused,
  busy,
  maxBoostPct,
  onStake,
  onUnstake,
  onHarvest
}: {
  row: FarmRow;
  tokens: Record<string, FarmTokenInfo | undefined>;
  rewards: { a: { symbol: string; decimals: number }; b: { symbol: string; decimals: number } };
  wallet: string | null;
  paused: boolean;
  busy: string | null;
  maxBoostPct: number;
  onStake: () => void;
  onUnstake: () => void;
  onHarvest: () => void;
}) {
  const t0 = row.token0 ? tokens[row.token0] : undefined;
  const t1 = row.token1 ? tokens[row.token1] : undefined;
  const single = row.kind === 'SINGLE' ? tokens[row.lpToken.toLowerCase()] : undefined;
  const pos = row.position;
  const staked = pos?.staked ?? 0n;
  const pendA = pos?.pendingA ?? 0n;
  const pendB = pos?.pendingB ?? 0n;
  const hasPending = pendA > 0n || pendB > 0n;
  const apr = row.aprTotal;
  const aprTitle =
    apr === undefined
      ? row.totalStaked === 0n
        ? 'Nobody has staked here yet, so there is no rate to quote. The first stakers share this pool’s whole reward.'
        : 'APR needs a price for the staked token and both rewards; one is missing.'
      : `${rewards.a.symbol} ${pct(row.aprA)} + ${rewards.b.symbol} ${pct(row.aprB)}, from the current emission and total staked. It changes as people stake and unstake.`;

  return (
    <div className="farm-row" role="row">
      <div className="farm-cell farm-pool" data-label="Pool">
        <span className="farm-avatars">
          {row.kind === 'LP' ? (
            <>
              <TokenAvatar symbol={t0?.symbol ?? '?'} iconUrl={t0?.iconUrl} size="sm" />
              <TokenAvatar symbol={t1?.symbol ?? '?'} iconUrl={t1?.iconUrl} size="sm" />
            </>
          ) : (
            <TokenAvatar symbol={single?.symbol ?? '?'} iconUrl={single?.iconUrl} size="sm" />
          )}
        </span>
        <span style={{ minWidth: 0 }}>
          <strong>{row.label}</strong>
          <small className="farm-sub">
            <Badge severity={row.kind === 'LP' ? 'info' : 'neutral'}>{row.kind === 'LP' ? 'LP' : 'Single asset'}</Badge>{' '}
            <a className="link-hash" href={`https://quaiscan.io/address/${row.lpToken}`} target="_blank" rel="noreferrer" title={row.lpToken}>
              #{row.pid} <ExternalLink size={9} style={{ verticalAlign: 'baseline' }} />
            </a>
          </small>
        </span>
      </div>

      <div className="farm-cell" data-label="Reward share" title={`${row.allocPoint.toString()} allocation points`}>
        <strong>{row.sharePct.toFixed(row.sharePct % 1 === 0 ? 0 : 1)}%</strong>
        <small className="farm-sub">{compactNumber(row.dailyA, 2)} {rewards.a.symbol}/day</small>
      </div>

      <div className="farm-cell" data-label="Total staked">
        <strong>{row.totalStaked === 0n ? '—' : usd(row.tvlUsd)}</strong>
        <small className="farm-sub">{row.totalStaked === 0n ? 'Be the first' : `${compactNumber(Number(formatUnits(row.totalStaked, row.stakeDecimals, 4)), 2)} staked`}</small>
      </div>

      <div className="farm-cell" data-label="APR" title={aprTitle}>
        <strong style={{ color: apr !== undefined ? 'var(--success)' : undefined }}>{pct(apr)}</strong>
        {row.aprMax !== undefined && maxBoostPct > 0 && <small className="farm-sub">up to {pct(row.aprMax)} with Qrb</small>}
      </div>

      <div className="farm-cell" data-label="Your stake">
        <strong>{!wallet ? '—' : staked === 0n ? '0' : usd(row.stakedUsd) === '—' ? formatUnits(staked, row.stakeDecimals, 4) : usd(row.stakedUsd)}</strong>
        <small className="farm-sub">
          {!wallet ? 'Connect wallet' : `${formatUnits(pos?.walletBalance ?? 0n, row.stakeDecimals, 4)} in wallet`}
        </small>
      </div>

      <div className="farm-cell" data-label="Earned">
        {!wallet || !hasPending ? (
          <strong>—</strong>
        ) : (
          <>
            <strong>{compactNumber(Number(formatUnits(pendA, rewards.a.decimals, 6)), 4)} {rewards.a.symbol}</strong>
            <small className="farm-sub">{compactNumber(Number(formatUnits(pendB, rewards.b.decimals, 6)), 4)} {rewards.b.symbol}</small>
          </>
        )}
      </div>

      <div className="farm-cell farm-actions-cell">
        <button type="button" className="btn-primary" style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem' }} onClick={onStake} disabled={paused && !!wallet} title={paused ? 'Deposits are paused' : undefined}>
          {wallet ? 'Stake' : 'Connect'}
        </button>
        {wallet && staked > 0n && (
          <button type="button" style={smallBtn} onClick={onUnstake}>Unstake</button>
        )}
        {wallet && hasPending && (
          <button type="button" style={smallBtn} onClick={onHarvest} disabled={paused || busy !== null} title={paused ? 'Harvest is paused; unstaking pays your rewards' : 'Claim the rewards you have earned'}>
            {busy === `harvest:${row.pid}` ? <Spinner /> : <Coins size={12} />} Harvest
          </button>
        )}
      </div>
    </div>
  );
}

/** What the farm is and who controls it: stated on the page so nobody has to trust a screenshot. */
function FarmDetails({ farm, rewards, runA, runB, updatedAt }: { farm: NonNullable<ReturnType<typeof useFarm>['farm']>; rewards: { a: { symbol: string; decimals: number }; b: { symbol: string; decimals: number } }; runA: number | null; runB: number | null; updatedAt: number | null }) {
  return (
    <details className="farm-details">
      <summary>Farm details &amp; safety</summary>
      <div className="farm-details-grid">
        <div><span className="farm-stat-label">Farm contract</span><AddrLink address={farm.address} /></div>
        <div><span className="farm-stat-label">Owner</span><AddrLink address={farm.owner} /></div>
        <div><span className="farm-stat-label">Reward {rewards.a.symbol}</span><AddrLink address={farm.rewardTokenA} /></div>
        <div><span className="farm-stat-label">Reward {rewards.b.symbol}</span><AddrLink address={farm.rewardTokenB} /></div>
        {farm.qrb && <div><span className="farm-stat-label">Boost source (Qrb)</span><AddrLink address={farm.qrb} /></div>}
        <div><span className="farm-stat-label">Reward balance</span>
          {compactNumber(Number(formatUnits(farm.inventoryA.available, rewards.a.decimals, 4)), 2)} {rewards.a.symbol} (~{days(runA)}) &middot; {compactNumber(Number(formatUnits(farm.inventoryB.available, rewards.b.decimals, 4)), 2)} {rewards.b.symbol} (~{days(runB)})
        </div>
        <div><span className="farm-stat-label">Max boost</span>{farm.boostBps > 0n ? `+${Number(farm.boostBps) / 100}%` : 'none'}</div>
        <div><span className="farm-stat-label">Last read</span>{updatedAt ? new Date(updatedAt).toLocaleTimeString() : '—'}</div>
      </div>
      <ul className="farm-safety">
        <li>The farm contract cannot be upgraded: its code and reward tokens are fixed.</li>
        <li>The owner can add pools, change reward shares and emission (up to a hard cap in the contract) and pause deposits. The owner cannot take staked tokens.</li>
        <li>Withdrawing is never paused. Rewards are paid only from the farm's reward balance, never from staked tokens.</li>
      </ul>
    </details>
  );
}
