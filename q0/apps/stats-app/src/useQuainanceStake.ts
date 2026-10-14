import { useEffect, useState } from 'react';
import { BDELTA_STAKE_THRESHOLD, createBatch, formatUnits, readQuainanceBdeltaStake, withFarmLiquidity, type QuainanceStake } from 'quai-service';

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
/** A node that did not answer a moment ago usually does a few seconds later. Without a retry the buttons stay locked until a reload. */
const RETRY_MS = [4_000, 12_000, 30_000];
const cache = new Map<string, { at: number; stake: QuainanceStake }>();

const shown = (n: bigint) => Number(formatUnits(n, 18, 2)).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * @param farmLp Quainance's BDELTA/WQUAI liquidity tokens the wallet has deposited in this app's own farm, or null while the
 *   farm has not been read yet. They are no longer in the wallet, so they have to be counted separately: a wallet that put its
 *   liquidity to work here must not be told it has none. 0n when the farm has no such pool or the wallet has nothing in it.
 */
export function useQuainanceStake(wallet: string | null, farmLp: bigint | null = 0n): StakeGate {
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(s => (s.wallet === key ? s : { wallet: key, stake: null, failed: false }));
    const read = (attempt: number) => {
      readQuainanceBdeltaStake(createBatch(), wallet)
        .then(stake => {
          cache.set(key, { at: Date.now(), stake });
          if (live) setState({ wallet: key, stake, failed: false });
        })
        .catch(() => {
          if (!live) return;
          setState({ wallet: key, stake: null, failed: true });
          if (attempt < RETRY_MS.length) timer = setTimeout(() => read(attempt + 1), RETRY_MS[attempt]);
        });
    };
    read(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [wallet]);

  if (!wallet) return { status: 'no-wallet', bdelta: null, reason: REQUIREMENT, requirement: REQUIREMENT };
  if (state.wallet !== wallet.toLowerCase()) return { status: 'checking', bdelta: null, reason: 'Checking your stake on Quainance…', requirement: REQUIREMENT };
  if (state.failed) {
    return { status: 'unknown', bdelta: null, reason: `${REQUIREMENT}; your stake could not be read just now. Retrying…`, requirement: REQUIREMENT };
  }
  if (!state.stake) return { status: 'checking', bdelta: null, reason: 'Checking your stake on Quainance…', requirement: REQUIREMENT };

  // The wallet's own liquidity already qualifies: nothing the farm holds can change that.
  if (state.stake.meetsThreshold) return { status: 'eligible', bdelta: state.stake.bdelta, reason: null, requirement: REQUIREMENT };
  // It does not yet, and the farm deposit has not been read: say "checking", never "you do not qualify", on half the facts.
  if (farmLp === null) {
    return { status: 'checking', bdelta: null, reason: 'Checking your deposits in this farm…', requirement: REQUIREMENT };
  }

  const stake = withFarmLiquidity(state.stake, farmLp);
  if (stake.meetsThreshold) return { status: 'eligible', bdelta: stake.bdelta, reason: null, requirement: REQUIREMENT };
  return {
    status: 'ineligible',
    bdelta: stake.bdelta,
    reason: `${REQUIREMENT}; you have ${shown(stake.bdelta)}`,
    requirement: REQUIREMENT
  };
}
