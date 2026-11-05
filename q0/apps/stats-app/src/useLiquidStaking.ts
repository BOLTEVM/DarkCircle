import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LIQUID_STAKING_DEPLOY_BLOCK,
  annualizedRateYield,
  createBatch,
  readLiquidStakingRateAt,
  readLiquidStakingSnapshot,
  readLiquidWithdrawalRequests,
  type LiquidStakingRatePoint,
  type LiquidStakingSnapshot,
  type LiquidWithdrawalRequest
} from 'quai-service';

export type LiquidStakingStatus = 'idle' | 'loading' | 'ready' | 'error';
export const LIQUID_STAKING_REFRESH_MS = 30_000;
export const LIQUID_STAKING_HISTORY_LIMIT = 200n;

const batch = createBatch();

const WEEK_SECONDS = 7 * 86_400;

export interface LiquidStakingYield {
  launch: LiquidStakingRatePoint;
  latest: LiquidStakingRatePoint;
  /** The rate about seven days back, once the vault is older than that. */
  weekAgo: LiquidStakingRatePoint | null;
  /** Annualised percent; null while the window is too short to mean anything. */
  sinceLaunchApr: number | null;
  trailing7dApr: number | null;
}

/** Realised yield from the vault's own rate history: no APY is promised, so only what happened is shown. */
async function readYield(vault: string, tip: number): Promise<LiquidStakingYield | null> {
  const deployBlock = LIQUID_STAKING_DEPLOY_BLOCK[vault.toLowerCase()];
  if (deployBlock === undefined || tip <= deployBlock) return null;
  const [launch, latest] = await Promise.all([readLiquidStakingRateAt(batch, vault, deployBlock), readLiquidStakingRateAt(batch, vault, tip)]);
  const age = latest.timestamp - launch.timestamp;
  let weekAgo: LiquidStakingRatePoint | null = null;
  if (age > WEEK_SECONDS) {
    // Estimate the block from the average block time since launch; the point's own timestamp keeps the maths exact.
    const perBlock = age / (tip - deployBlock);
    const back = Math.max(deployBlock, Math.round(tip - WEEK_SECONDS / perBlock));
    weekAgo = await readLiquidStakingRateAt(batch, vault, back);
  }
  return {
    launch,
    latest,
    weekAgo,
    sinceLaunchApr: annualizedRateYield(launch.rateE18, latest.rateE18, age),
    trailing7dApr: weekAgo ? annualizedRateYield(weekAgo.rateE18, latest.rateE18, latest.timestamp - weekAgo.timestamp) : null
  };
}

export interface LiquidStakingData {
  snapshot: LiquidStakingSnapshot | null;
  requests: LiquidWithdrawalRequest[];
  status: LiquidStakingStatus;
  yieldInfo: LiquidStakingYield | null;
  yieldError: string | null;
  error: string | null;
  updatedAt: number | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/** Live vault and wallet state. Request history is explicitly bounded and filtered to this wallet's receivers. */
export function useLiquidStaking(vault: string | null, wallet: string | null): LiquidStakingData {
  const [snapshot, setSnapshot] = useState<LiquidStakingSnapshot | null>(null);
  const [requests, setRequests] = useState<LiquidWithdrawalRequest[]>([]);
  const [status, setStatus] = useState<LiquidStakingStatus>(vault ? 'loading' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [yieldInfo, setYieldInfo] = useState<LiquidStakingYield | null>(null);
  const [yieldError, setYieldError] = useState<string | null>(null);
  const generation = useRef(0);
  const tip = snapshot?.blockNumber ?? null;
  const haveYieldFor = useRef<string | null>(null);

  // Rate history moves slowly: read it once the first snapshot lands, again on an explicit refresh, never on the timer.
  const loadYield = useCallback(async (block: number) => {
    if (!vault) return;
    try {
      const next = await readYield(vault, block);
      setYieldInfo(next);
      setYieldError(null);
    } catch (e: any) {
      setYieldError(e?.message || 'The rate history could not be read.');
    }
  }, [vault]);

  useEffect(() => {
    if (!vault || tip === null || haveYieldFor.current === vault) return;
    haveYieldFor.current = vault;
    void loadYield(tip);
  }, [vault, tip, loadYield]);

  const load = useCallback(async () => {
    if (!vault) {
      setSnapshot(null);
      setRequests([]);
      setStatus('idle');
      setError(null);
      return;
    }
    const mine = ++generation.current;
    setRefreshing(true);
    try {
      const next = await readLiquidStakingSnapshot(batch, vault, wallet ?? undefined);
      const end = next.requestCount;
      const start = end > LIQUID_STAKING_HISTORY_LIMIT ? end - LIQUID_STAKING_HISTORY_LIMIT : 0n;
      const history = wallet && end > start ? await readLiquidWithdrawalRequests(batch, vault, start, end) : [];
      if (mine !== generation.current) return;
      setSnapshot(next);
      setRequests(wallet ? history.filter(r => r.receiver.toLowerCase() === wallet.toLowerCase()).reverse() : []);
      setError(null);
      setStatus('ready');
      setUpdatedAt(Date.now());
    } catch (e: any) {
      if (mine !== generation.current) return;
      setError(e?.message || 'The liquid-staking vault could not be read.');
      setStatus(prev => (prev === 'ready' ? 'ready' : 'error'));
    } finally {
      if (mine === generation.current) setRefreshing(false);
    }
  }, [vault, wallet]);

  useEffect(() => {
    // Never show the previous wallet's balance or claims while the new wallet is being read.
    setSnapshot(null);
    setRequests([]);
    setUpdatedAt(null);
    setStatus(vault ? 'loading' : 'idle');
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, LIQUID_STAKING_REFRESH_MS);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [load, vault]);

  const refresh = useCallback(async () => {
    await load();
    haveYieldFor.current = null; // the next snapshot re-reads the rate history
  }, [load]);

  return { snapshot, requests, status, yieldInfo, yieldError, error, updatedAt, refreshing, refresh };
}
