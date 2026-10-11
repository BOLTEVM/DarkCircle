import { VAULT_LIMITS } from './abi.js';
import { RpcLike, readBlock } from './rpc.js';

/**
 * The vault judges timelocks and expiry by block time, not by the user's computer. A
 * wrong local clock would otherwise show the wrong countdown and pick expiries the vault
 * rejects, so every timing decision starts from the latest block's timestamp.
 */
export interface ChainClock {
  /** Timestamp of the latest block (seconds). */
  chainTime: number;
  blockNumber: bigint;
  /** Local time when that block was read (seconds). */
  localTime: number;
  /** localTime - chainTime: positive when this computer is ahead of the chain (or blocks are slow). */
  skew: number;
}

export async function readChainClock(rpc: RpcLike, localNowMs: number = Date.now()): Promise<ChainClock> {
  const head = await readBlock(rpc, 'latest');
  const localTime = Math.floor(localNowMs / 1000);
  return { chainTime: head.timestamp, blockNumber: head.number, localTime, skew: localTime - head.timestamp };
}

/** Best estimate of the chain's time now: the last block's time plus local time elapsed since reading it. */
export function estimatedChainNow(clock: ChainClock, localNowMs: number = Date.now()): number {
  return clock.chainTime + Math.max(0, Math.floor(localNowMs / 1000) - clock.localTime);
}

/**
 * True when the local clock is far enough from the chain's to mislead. Orchard blocks can
 * be many minutes apart, so testnet tolerates more before warning.
 */
export function clockSkewIsSuspicious(clock: ChainClock, network: 'mainnet' | 'testnet'): boolean {
  const tolerance = network === 'mainnet' ? 5 * 60 : 30 * 60;
  return Math.abs(clock.skew) > tolerance;
}

/** Smallest window between the end of the timelock and expiry the app lets a user choose. */
export const MIN_EXECUTION_WINDOW = 60 * 60;
export const DEFAULT_EXECUTION_WINDOW = 7 * 24 * 60 * 60;

/**
 * Picks the expiration for a new proposal. It is anchored on the latest block's time: the
 * block that includes the proposal cannot be older, so the vault's upper bound
 * (inclusion time + delay + 30 days) always holds, and the chosen window only shrinks by
 * however long inclusion takes.
 */
export function chooseExpiration(clock: ChainClock, delaySeconds: number, windowSeconds: number = DEFAULT_EXECUTION_WINDOW): number {
  if (!Number.isInteger(windowSeconds) || windowSeconds < MIN_EXECUTION_WINDOW || windowSeconds > VAULT_LIMITS.MAX_EXECUTION_WINDOW) {
    throw new Error(`The execution window must be between 1 hour and 30 days.`);
  }
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > VAULT_LIMITS.MAX_EXECUTION_DELAY) {
    throw new Error('The delay must be between 0 and 30 days.');
  }
  return clock.chainTime + delaySeconds + windowSeconds;
}
