import { VaultDeployment, VerifiedVault, assertVaultAuthentic } from './authenticity.js';
import { DecodedCall, decodeVaultCall } from './decode.js';
import { computeVaultTxHash, formatDigest, reviewDigest } from './hash.js';
import { AgreementStatus, ReadSource, SourceReport, readAcrossSources } from './multisource.js';
import { VaultTransaction, findTransactionNonce, readVaultTransaction } from './reader.js';

export class TransactionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionIntegrityError';
  }
}

/**
 * Recomputes the transaction hash from the stored fields. Owners approve a hash; this
 * proves that hash commits to exactly the destination, value, calldata, gas, expiry and
 * delay the review shows, on this chain and this vault.
 */
export function assertTransactionIntegrity(tx: VaultTransaction, vault: string, chainId: number): void {
  const recomputed = computeVaultTxHash({
    vault,
    chainId,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
    expiration: tx.expiration,
    executionDelay: tx.executionDelay,
    nonce: tx.nonce,
  });
  if (recomputed.toLowerCase() !== tx.hash.toLowerCase()) {
    throw new TransactionIntegrityError(
      `Transaction ${tx.hash} does not match its own contents (recomputed ${recomputed}). Do not approve or execute it.`
    );
  }
}

export interface TransactionReview {
  vault: VerifiedVault;
  tx: VaultTransaction;
  decoded: DecodedCall;
  /** reviewDigest(): compare with other owners or with `darksafe-verify tx`. */
  digest: string;
  digestDisplay: string;
  agreement: AgreementStatus;
  block: bigint;
  reports: SourceReport[];
  problems: string[];
}

/**
 * Everything the review screen and the CLI verifier show, read at one block from every
 * source and cross-checked. Throws on an integrity failure; a source disagreement is
 * returned (agreement === 'disagreement') so the UI can show it and refuse to write.
 */
export async function verifyVaultTransaction(args: {
  sources: readonly ReadSource[];
  address: string;
  deployment: VaultDeployment;
  chainId: number;
  hash: string;
  /** Position in the vault's list, if already known; otherwise it is looked up. */
  nonce?: number;
  maxLagBlocks?: number;
}): Promise<TransactionReview> {
  const read = await readAcrossSources(
    args.sources,
    async (rpc, block) => {
      const vault = await assertVaultAuthentic(rpc, args.address, args.deployment, block);
      const nonce = args.nonce ?? (await findTransactionNonce(rpc, vault.address, args.hash, vault.snapshot.txNonce, block));
      const tx = await readVaultTransaction(rpc, vault.address, args.hash, nonce, block);
      return { vault, tx };
    },
    { maxLagBlocks: args.maxLagBlocks, describe: 'vault and transaction state' }
  );
  const { vault, tx } = read.value;
  assertTransactionIntegrity(tx, vault.address, args.chainId);
  const digest = reviewDigest({
    txHash: tx.hash,
    owners: vault.snapshot.owners,
    threshold: vault.snapshot.threshold,
    minExecutionDelay: vault.snapshot.minExecutionDelay,
  });
  return {
    vault,
    tx,
    decoded: decodeVaultCall({ vault: vault.address, to: tx.to, value: tx.value, data: tx.data }),
    digest,
    digestDisplay: formatDigest(digest),
    agreement: read.status,
    block: read.block,
    reports: read.reports,
    problems: read.problems,
  };
}

/** True when a write based on this review may go ahead. */
export function reviewAllowsWrite(review: Pick<TransactionReview, 'agreement'>): boolean {
  return review.agreement !== 'disagreement';
}
