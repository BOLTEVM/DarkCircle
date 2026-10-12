import { prepareContractCall, waitForReceipt, type PreparedTx } from 'quai-service';
import { getQuaiProvider, sendWalletTransaction } from './providerUtils';

export interface SendResult {
  txHash: string;
  /** What this transaction could cost at most, in wei (gas limit x gas price). Unused gas is refunded. */
  maxFee: bigint;
  gasLimit: bigint;
}

/**
 * Simulate, attach the access list Cyprus-1 needs, send through the user's wallet, and wait for the receipt.
 *
 * The simulation runs first and throws when it reverts, so a doomed call is never sent: on Quai a revert burns the
 * whole gas limit. The wallet itself asks the user to confirm; nothing here signs.
 */
export async function sendContractCall(
  from: string,
  to: string,
  data: string,
  opts: { gasMultiplier?: number; onPrepared?: (p: PreparedTx) => void; onSubmitted?: (txHash: string) => void } = {}
): Promise<SendResult> {
  const provider = getQuaiProvider();
  if (!provider) throw new Error('No Quai wallet found. Install Pelagus and connect it.');
  const prepared = await prepareContractCall(from, to, data, opts.gasMultiplier ?? 1.5);
  opts.onPrepared?.(prepared);
  const txHash = await sendWalletTransaction(provider, prepared.tx);
  opts.onSubmitted?.(txHash);
  await waitForReceipt(txHash);
  return { txHash, maxFee: prepared.maxFee, gasLimit: prepared.gasLimit };
}

/** A wallet rejection or an RPC failure in words a person can act on. */
export function describeTxError(e: any): string {
  const msg = String(e?.message ?? e ?? '');
  if (e?.code === 4001 || /user rejected|user denied|rejected the request/i.test(msg)) return 'You declined the transaction in your wallet. Nothing was sent.';
  if (/insufficient funds/i.test(msg)) return 'Not enough QUAI to pay the network fee.';
  return msg || 'The transaction failed.';
}
