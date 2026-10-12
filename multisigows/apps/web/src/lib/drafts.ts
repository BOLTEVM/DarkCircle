import {
  ChainClock,
  ProposalDraft,
  RpcLike,
  chooseExpiration,
  readChainClock,
  recommendGasLimit,
  validateDraft,
} from '@darksafe/core';

export interface DraftRequest {
  vault: string;
  minExecutionDelay: number;
  to: string;
  value: bigint;
  data: string;
  /** Seconds between the end of the timelock and expiry. */
  windowSeconds: number;
  /** Extra delay on top of the vault floor (ignored for admin changes). */
  requestedDelay: number;
  /** Manual gas for the call; when omitted it is estimated from the vault's own call. */
  gasLimit?: bigint;
}

export type DraftResult = { ok: true; draft: ProposalDraft } | { ok: false; errors: string[] };

/**
 * Turns form input into a proposal the vault will accept: expiry anchored on chain time,
 * gas sized from the node's estimate for the vault's call, and the vault's own rules
 * checked before anything is simulated or signed.
 */
export async function buildDraft(rpc: RpcLike, clock: ChainClock | null, req: DraftRequest): Promise<DraftResult> {
  const self = req.to.toLowerCase() === req.vault.toLowerCase();
  const chainClock = clock ?? (await readChainClock(rpc));
  const delay = self ? 0 : Math.max(req.minExecutionDelay, req.requestedDelay);
  let expiration: number;
  try {
    expiration = chooseExpiration(chainClock, delay, req.windowSeconds);
  } catch (err: any) {
    return { ok: false, errors: [err?.message ?? String(err)] };
  }
  let gasLimit = 0n;
  if (!self) {
    if (req.gasLimit !== undefined) {
      gasLimit = req.gasLimit;
    } else {
      try {
        gasLimit = await recommendGasLimit(rpc, { vault: req.vault, to: req.to, value: req.value, data: req.data });
      } catch (err: any) {
        return {
          ok: false,
          errors: [
            `Could not estimate gas for this call from the vault (${err?.message ?? err}). It may fail as things stand; enter a gas limit under Advanced to propose it anyway.`,
          ],
        };
      }
    }
  }
  const draft: ProposalDraft = { to: req.to, value: req.value, data: req.data, gasLimit, expiration, requestedDelay: self ? 0 : req.requestedDelay };
  const errors = validateDraft(draft, req.vault, req.minExecutionDelay, chainClock.chainTime);
  return errors.length ? { ok: false, errors } : { ok: true, draft };
}
