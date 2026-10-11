import { AbiCoder, getAddress, keccak256 } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

export interface VaultTxFields {
  vault: string;
  chainId: number | bigint;
  to: string;
  value: bigint;
  data: string;
  gasLimit: bigint;
  expiration: number | bigint;
  executionDelay: number;
  /** Position in the vault's transaction list (txNonce at proposal time). */
  nonce: number | bigint;
}

/** Mirrors SafeBuddyVault.getTransactionHash exactly. */
export function computeVaultTxHash(f: VaultTxFields): string {
  return keccak256(
    coder.encode(
      ['address', 'uint256', 'address', 'uint256', 'bytes32', 'uint64', 'uint64', 'uint32', 'uint256'],
      [f.vault, f.chainId, f.to, f.value, keccak256(f.data), f.gasLimit, f.expiration, f.executionDelay, f.nonce]
    )
  );
}

export interface ReviewDigestInput {
  txHash: string;
  owners: readonly string[];
  threshold: number;
  minExecutionDelay: number;
}

/**
 * A short code owners can read to each other (or compare with `safebuddy-verify tx`) to
 * confirm they are approving the same transaction under the same owner set and threshold.
 * The tx hash already commits to vault, chain, destination, value, calldata, gas, expiry,
 * delay and nonce; the digest adds the governance state it is being approved under.
 */
export function reviewDigest(input: ReviewDigestInput): string {
  const owners = input.owners.map((o) => getAddress(o)).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return keccak256(
    coder.encode(['bytes32', 'address[]', 'uint256', 'uint32'], [input.txHash, owners, input.threshold, input.minExecutionDelay])
  );
}

/** First 8 bytes of a digest as four upper-case groups, e.g. "1A2B-3C4D-5E6F-7081". */
export function formatDigest(digest: string): string {
  const hex = digest.replace(/^0x/, '').slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}
