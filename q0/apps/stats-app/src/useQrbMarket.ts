import { useEffect } from 'react';
import { DEPLOYED, TOKEN_REGISTRY, nextMarketSnapshot, tokenMarketView, type MarketRound, type MarketSnapshot, type MarketView, type TokenProfile } from 'quai-service';
import { tokenMetadataService } from './useTokenProfiles';
import { readTokenPoolPriceUsd } from './useYieldBoard';
import { usePolledResource, type PollContext, type PollStatus } from './usePolledResource';

/** How often the QRB price and market cap are re-read while the tab is visible. */
export const QRB_POLL_MS = 30_000;
/**
 * The explorer figures are re-read when older than this. Shorter than the poll interval, so every poll that is not
 * answered by another page's fresh read goes out; longer than a few seconds, so a page that read it a moment ago
 * (the token list, the analytics page) is reused instead of asking again.
 */
const EXPLORER_MAX_AGE_MS = 20_000;
const STORAGE_KEY = 'circleswap.qrb-market.v1';

export interface QrbMarket {
  /** Price and market cap as they should be shown, with their source and the age of the figures behind them. */
  view: MarketView;
  snapshot: MarketSnapshot | null;
  /** loading: nothing yet. live: fresh. stale: held (old, or the last read failed). error: nothing yet and it failed. */
  status: PollStatus;
  /** When the last poll succeeded. */
  updatedAt: number | null;
  /** Why the last poll failed, until the next one succeeds. */
  error: string | null;
  /** A read is running right now. */
  refreshing: boolean;
  /** Read now. */
  refresh: () => Promise<void>;
  /** False when the Qrb contract is not deployed on this network: there is nothing to poll. */
  deployed: boolean;
}

const EMPTY: MarketSnapshot = {
  explorerPriceUsd: null,
  explorerMarketCapUsd: null,
  supply: null,
  poolPriceUsd: null,
  explorerAt: null,
  poolsAt: null,
  failed: []
};

/** Total supply in whole tokens from the contract's own answer; null (never a guess) when it cannot be read. */
function supplyOf(profile: TokenProfile | undefined): number | null {
  if (!profile?.totalSupply) return null;
  // QRB is this app's own 18-decimal token: the registry value stands in only when the contract did not answer decimals().
  const decimals = profile.decimals ?? TOKEN_REGISTRY.QRB?.decimals;
  if (decimals === undefined) return null;
  try {
    const n = Number(BigInt(profile.totalSupply)) / 10 ** decimals;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * One poll: the explorer's figures and the pools' price, read side by side, then folded into the snapshot by
 * nextMarketSnapshot (which keeps each source's last good figure and its time when that source fails, and says so).
 * Only when every source failed does the whole poll count as failed, which is what makes the poller back off and keep
 * its last value.
 */
export async function fetchQrbMarket(ctx: PollContext<MarketSnapshot>): Promise<MarketSnapshot> {
  const address = DEPLOYED.QRB;
  if (!address) return EMPTY;
  const key = address.toLowerCase();
  const manual = ctx.reason === 'manual';

  const [meta, pools] = await Promise.allSettled([
    tokenMetadataService().load([address], { signal: ctx.signal, force: manual, marketMaxAgeMs: EXPLORER_MAX_AGE_MS }),
    readTokenPoolPriceUsd(address, { signal: ctx.signal })
  ]);

  const round: MarketRound = {
    explorer:
      meta.status === 'fulfilled'
        ? {
            ok: true,
            // the service keeps the last good figures when a read fails, so the profile is right either way; what
            // matters is whether the latest attempt failed (cleared only by the next success)
            priceUsd: meta.value.profiles[key]?.priceUsd ?? null,
            marketCapUsd: meta.value.profiles[key]?.marketCapUsd ?? null,
            supply: supplyOf(meta.value.profiles[key]),
            at: meta.value.freshness[key]?.explorerAt ?? null,
            failedLatest: meta.value.freshness[key]?.explorerFailedAt !== undefined
          }
        : { ok: false },
    pools: pools.status === 'fulfilled' ? { ok: true, priceUsd: pools.value.priceUsd, at: pools.value.at } : { ok: false }
  };
  const next = nextMarketSnapshot(ctx.previous, round);
  if (next === null) {
    throw new Error(pools.status === 'rejected' && pools.reason instanceof Error ? pools.reason.message : 'The explorer and the pools could not be read.');
  }
  return next;
}

function readStored(): { data: MarketSnapshot; updatedAt: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { v?: number; at?: number; data?: MarketSnapshot } | null;
    if (raw?.v !== 1 || typeof raw.at !== 'number' || !raw.data) return null;
    const d = raw.data;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return {
      updatedAt: raw.at,
      data: {
        explorerPriceUsd: num(d.explorerPriceUsd),
        explorerMarketCapUsd: num(d.explorerMarketCapUsd),
        supply: num(d.supply),
        poolPriceUsd: num(d.poolPriceUsd),
        explorerAt: num(d.explorerAt),
        poolsAt: num(d.poolsAt),
        // it is a remembered value, not a new read: nothing is flagged as failing, the age says how old it is
        failed: []
      }
    };
  } catch {
    return null;
  }
}

function writeStored(data: MarketSnapshot, at: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, at, data }));
  } catch {
    /* storage unavailable or full: the next visit just starts empty */
  }
}

/**
 * The QRB price and market cap, kept fresh in the background. Called from the top of the app so the first read starts
 * while the rest of the app is still loading; `active` (the QRB tab is open) is what keeps it polling on a timer.
 * A remembered value is shown at once, labelled with its true age, until the first read replaces it.
 */
export function useQrbMarket(active: boolean): QrbMarket {
  const deployed = DEPLOYED.QRB !== null;
  const polled = usePolledResource<MarketSnapshot>(fetchQrbMarket, {
    intervalMs: QRB_POLL_MS,
    active: active && deployed,
    initial: deployed ? readStored : undefined
  });

  const { data, updatedAt } = polled;
  useEffect(() => {
    if (data && updatedAt !== null) writeStored(data, updatedAt);
  }, [data, updatedAt]);

  return {
    view: tokenMarketView(data),
    snapshot: data,
    status: polled.status,
    updatedAt,
    error: polled.error,
    refreshing: polled.refreshing,
    refresh: polled.refresh,
    deployed
  };
}
