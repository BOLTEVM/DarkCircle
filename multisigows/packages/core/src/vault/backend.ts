import { vaultInterface } from './abi.js';
import { computeVaultTxHash } from './hash.js';
import { quaiVaultInterface } from './quaivault.js';
import { RpcLike, callAt } from './rpc.js';

/**
 * Lets a proposal (e.g. AgentPermitBatcher.batchPermitTransfer â€” see permit.ts) be built,
 * approved and executed through either multisig product this workspace's users hold funds in:
 * SafeBuddyVault (this repo) or QuaiVault (a separate product â€” see quaivault.ts for how that
 * ABI was sourced). AgentPermitBatcher.sol itself already works with either unmodified: its
 * `vault` is just whichever address calls it.
 *
 * The two backends are NOT forced into a false lowest-common-denominator shape â€” they genuinely
 * differ (SafeBuddyVault commits an exact gasLimit per call and computes its hash purely
 * off-chain from the proposal's fields; QuaiVault has no per-call gas commitment and its hash is
 * read from the vault itself). `encodePropose` throws if a field its own backend actually
 * requires is missing, rather than silently defaulting something the contract would reject.
 */

export interface ProposalCall {
  to: string;
  value: bigint;
  data: string;
}

export interface ProposeOpts {
  /** Required by SafeBuddyVault; not part of QuaiVault's interface at all. */
  gasLimit?: bigint;
  /** Required by SafeBuddyVault. Optional for QuaiVault: omitted uses its no-expiry overload. */
  expiration?: number;
  /** Required by SafeBuddyVault (0 is valid). Only used by QuaiVault together with `expiration`. */
  requestedDelay?: number;
}

export type MultisigBackendKind = 'safebuddy-v2' | 'quaivault';

export interface MultisigBackend {
  readonly kind: MultisigBackendKind;
  encodePropose(call: ProposalCall, opts: ProposeOpts): string;
  encodeApprove(txHash: string): string;
  encodeExecute(txHash: string): string;
  readOwners(rpc: RpcLike, vault: string): Promise<string[]>;
  readThreshold(rpc: RpcLike, vault: string): Promise<bigint>;
  /**
   * Resolves the hash the proposed call will be identified by, reading whatever on-chain
   * state that requires (at least a nonce). Call this with the exact same `call`/`opts` used
   * for `encodePropose`, and before submitting it, since both backends' hash commits to the
   * nonce at proposal time.
   */
  resolveTxHash(rpc: RpcLike, vault: string, chainId: number, call: ProposalCall, opts: ProposeOpts): Promise<string>;
}

function requireField<K extends keyof ProposeOpts>(opts: ProposeOpts, key: K, backend: string): NonNullable<ProposeOpts[K]> {
  const v = opts[key];
  if (v === undefined) throw new Error(`${backend} requires ${key} on every proposal.`);
  return v as NonNullable<ProposeOpts[K]>;
}

export const safeBuddyBackend: MultisigBackend = {
  kind: 'safebuddy-v2',

  encodePropose(call, opts) {
    const gasLimit = requireField(opts, 'gasLimit', 'SafeBuddyVault');
    const expiration = requireField(opts, 'expiration', 'SafeBuddyVault');
    const requestedDelay = requireField(opts, 'requestedDelay', 'SafeBuddyVault');
    return vaultInterface.encodeFunctionData('proposeTransaction', [call.to, call.value, call.data, gasLimit, expiration, requestedDelay]);
  },

  encodeApprove: (txHash) => vaultInterface.encodeFunctionData('approveTransaction', [txHash]),
  encodeExecute: (txHash) => vaultInterface.encodeFunctionData('executeTransaction', [txHash]),

  async readOwners(rpc, vault) {
    const raw = await callAt(rpc, vault, vaultInterface.encodeFunctionData('getOwners'));
    return vaultInterface.decodeFunctionResult('getOwners', raw)[0] as string[];
  },

  async readThreshold(rpc, vault) {
    const raw = await callAt(rpc, vault, vaultInterface.encodeFunctionData('threshold'));
    return vaultInterface.decodeFunctionResult('threshold', raw)[0] as bigint;
  },

  async resolveTxHash(rpc, vault, chainId, call, opts) {
    const gasLimit = requireField(opts, 'gasLimit', 'SafeBuddyVault');
    const expiration = requireField(opts, 'expiration', 'SafeBuddyVault');
    const requestedDelay = requireField(opts, 'requestedDelay', 'SafeBuddyVault');
    const raw = await callAt(rpc, vault, vaultInterface.encodeFunctionData('txNonce'));
    const nonce = vaultInterface.decodeFunctionResult('txNonce', raw)[0] as bigint;
    return computeVaultTxHash({
      vault,
      chainId,
      to: call.to,
      value: call.value,
      data: call.data,
      gasLimit,
      expiration,
      executionDelay: requestedDelay,
      nonce,
    });
  },
};

export const quaiVaultBackend: MultisigBackend = {
  kind: 'quaivault',

  encodePropose(call, opts) {
    if (opts.expiration === undefined) {
      return quaiVaultInterface.encodeFunctionData('proposeTransaction(address,uint256,bytes)', [call.to, call.value, call.data]);
    }
    const requestedDelay = opts.requestedDelay ?? 0;
    return quaiVaultInterface.encodeFunctionData('proposeTransaction(address,uint256,bytes,uint48,uint32)', [
      call.to,
      call.value,
      call.data,
      opts.expiration,
      requestedDelay,
    ]);
  },

  encodeApprove: (txHash) => quaiVaultInterface.encodeFunctionData('approveTransaction', [txHash]),
  encodeExecute: (txHash) => quaiVaultInterface.encodeFunctionData('executeTransaction', [txHash]),

  async readOwners(rpc, vault) {
    const raw = await callAt(rpc, vault, quaiVaultInterface.encodeFunctionData('getOwners'));
    return quaiVaultInterface.decodeFunctionResult('getOwners', raw)[0] as string[];
  },

  async readThreshold(rpc, vault) {
    const raw = await callAt(rpc, vault, quaiVaultInterface.encodeFunctionData('threshold'));
    return quaiVaultInterface.decodeFunctionResult('threshold', raw)[0] as bigint;
  },

  async resolveTxHash(rpc, vault, _chainId, call) {
    const nonceRaw = await callAt(rpc, vault, quaiVaultInterface.encodeFunctionData('nonce'));
    const nonce = quaiVaultInterface.decodeFunctionResult('nonce', nonceRaw)[0] as bigint;
    const hashRaw = await callAt(
      rpc,
      vault,
      quaiVaultInterface.encodeFunctionData('getTransactionHash', [call.to, call.value, call.data, nonce])
    );
    return quaiVaultInterface.decodeFunctionResult('getTransactionHash', hashRaw)[0] as string;
  },
};

export const multisigBackends: Record<MultisigBackendKind, MultisigBackend> = {
  'safebuddy-v2': safeBuddyBackend,
  quaivault: quaiVaultBackend,
};
