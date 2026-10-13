import { useEffect, useState } from 'react';
import { BDELTA_STAKE_THRESHOLD, createBatch, formatUnits, readQuainanceBdeltaStake, type QuainanceStake } from 'quai-service';

/**
 * Whether the connected wallet has at least 1,000 BDELTA on Quainance, which is the condition for using the single-token
 * pools on this page and for the airdrop. It is a rule of this page: the farm contract accepts deposits from anyone.
 */
export interface StakeGate {
  status: 'no-wallet' | 'checking' | 'eligible' | 'ineligible' | 'unknown';
  /** BDELTA on Quainance, in base units; null until read. */
  bdelta: bigint | null;
  /** One sentence for a disabled button; null when nothing is blocked. */
  reason: string | null;
  /** The same sentence for a person who is blocked or has not connected. */
  requirement: string;
}

const REQUIREMENT = `Needs ${formatUnits(BDELTA_STAKE_THRESHOLD, 18, 0)} BDELTA staked on Quainance`;
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; stake: QuainanceStake }>();

const shown = (n: bigint) => Number(formatUnits(n, 18, 2)).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function useQuainanceStake(wallet: string | null): StakeGate {
  const [state, setState] = useState<{ wallet: string | null; stake: QuainanceStake | null; failed: boolean }>({ wallet: null, stake: null, failed: false });

  useEffect(() => {
    if (!wallet) return;
    const key = wallet.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setState({ wallet: key, stake: hit.stake, failed: false });
      return;
    }
    let live = true;
    setState(s => (s.wallet === key ? s : { wallet: key, stake: null, failed: false }));
    readQuainanceBdeltaStake(createBatch(), wallet)
      .then(stake => {
        cache.set(key, { at: Date.now(), stake });
        if (live) setState({ wallet: key, stake, failed: false });
      })
      .catch(() => {
        if (live) setState({ wallet: key, stake: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [wallet]);

  if (!wallet) return { status: 'no-wallet', bdelta: null, reason: REQUIREMENT, requirement: REQUIREMENT };
  if (state.wallet !== wallet.toLowerCase()) return { status: 'checking', bdelta: null, reason: 'Checking your stake on Quainance…', requirement: REQUIREMENT };
  if (state.failed) {
    return { status: 'unknown', bdelta: null, reason: `${REQUIREMENT}; your stake could not be read just now. Try again in a moment.`, requirement: REQUIREMENT };
  }
  if (!state.stake) return { status: 'checking', bdelta: null, reason: 'Checking your stake on Quainance…', requirement: REQUIREMENT };
  if (state.stake.meetsThreshold) return { status: 'eligible', bdelta: state.stake.bdelta, reason: null, requirement: REQUIREMENT };
  return {
    status: 'ineligible',
    bdelta: state.stake.bdelta,
    reason: `${REQUIREMENT}; you have ${shown(state.stake.bdelta)}`,
    requirement: REQUIREMENT
  };
}
