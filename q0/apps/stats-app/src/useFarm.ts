import { useCallback, useEffect, useRef, useState } from 'react';
import {
  batchQuaiCall,
  readFarmState,
  readPairs,
  readUserPositions,
  type FarmBatch,
  type FarmPosition,
  type FarmState,
  type PairInfo
} from 'quai-service';

export type FarmStatus = 'idle' | 'loading' | 'ready' | 'error';

export const FARM_REFRESH_MS = 30_000;

const batch: FarmBatch = calls => batchQuaiCall(calls);

export interface FarmData {
  farm: FarmState | null;
  /** Two-token LP details for every staked token, keyed by lower-case address. */
  pairs: Record<string, PairInfo>;
  /** The wallet's position in every readable pool; undefined while no wallet is connected. */
  positions: FarmPosition[] | undefined;
  status: FarmStatus;
  /** Set when the last read failed. The previous good data stays on screen, labelled with `updatedAt`. */
  error: string | null;
  updatedAt: number | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * The farm, read from the chain (never from a static list): pools, emission, inventory, and the wallet's own position.
 * Re-reads every 30 s while the tab is visible and on demand after a transaction. A failed re-read keeps the last good
 * numbers and says so; a first read that fails shows an error, not zeros.
 */
export function useFarm(farmAddress: string | null, wallet: string | null): FarmData {
  const [farm, setFarm] = useState<FarmState | null>(null);
  const [pairs, setPairs] = useState<Record<string, PairInfo>>({});
  const [positions, setPositions] = useState<FarmPosition[] | undefined>(undefined);
  const [status, setStatus] = useState<FarmStatus>(farmAddress ? 'loading' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!farmAddress) {
      setStatus('idle');
      return;
    }
    const mine = ++generation.current;
    setRefreshing(true);
    try {
      const state = await readFarmState(batch, farmAddress);
      const [pairInfo, userPositions] = await Promise.all([
        readPairs(batch, state.pools.map(p => p.lpToken)),
        wallet ? readUserPositions(batch, state, wallet) : Promise.resolve(undefined)
      ]);
      // a newer read (wallet switched, manual refresh) already superseded this one
      if (mine !== generation.current) return;
      setFarm(state);
      setPairs(pairInfo);
      setPositions(userPositions);
      setError(null);
      setStatus('ready');
      setUpdatedAt(Date.now());
    } catch (e: any) {
      if (mine !== generation.current) return;
      setError(e?.message || 'The farm could not be read.');
      setStatus(prev => (prev === 'ready' ? 'ready' : 'error'));
    } finally {
      if (mine === generation.current) setRefreshing(false);
    }
  }, [farmAddress, wallet]);

  useEffect(() => {
    // a different wallet must never show the previous wallet's position
    setPositions(undefined);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, FARM_REFRESH_MS);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [load]);

  return { farm, pairs, positions, status, error, updatedAt, refreshing, refresh: load };
}
