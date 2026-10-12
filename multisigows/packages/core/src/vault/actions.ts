import { getAddress } from 'ethers';
import { VAULT_LIMITS, erc20Interface, factoryInterface, vaultInterface } from './abi.js';
import { isCyprus1QuaiAddress } from './create2.js';
import { MIN_EXECUTION_WINDOW } from './clock.js';
import { RpcLike } from './rpc.js';

export interface ProposalDraft {
  to: string;
  value: bigint;
  data: string;
  /** Gas committed to the external call; must be 0 for calls to the vault itself. */
  gasLimit: bigint;
  expiration: number;
  requestedDelay: number;
}

/** Calldata for the vault's lifecycle functions. */
export const vaultCalls = {
  propose: (d: ProposalDraft) =>
    vaultInterface.encodeFunctionData('proposeTransaction', [d.to, d.value, d.data, d.gasLimit, d.expiration, d.requestedDelay]),
  approve: (hash: string) => vaultInterface.encodeFunctionData('approveTransaction', [hash]),
  revoke: (hash: string) => vaultInterface.encodeFunctionData('revokeApproval', [hash]),
  execute: (hash: string) => vaultInterface.encodeFunctionData('executeTransaction', [hash]),
  cancel: (hash: string) => vaultInterface.encodeFunctionData('cancelTransaction', [hash]),
  expire: (hash: string) => vaultInterface.encodeFunctionData('expireTransaction', [hash]),
};

/** Calldata for admin self-calls; propose them with `to` = the vault, value 0 and gasLimit 0. */
export const adminCalls = {
  addOwner: (owner: string, newThreshold: number) => vaultInterface.encodeFunctionData('addOwner', [owner, newThreshold]),
  removeOwner: (owner: string, newThreshold: number) => vaultInterface.encodeFunctionData('removeOwner', [owner, newThreshold]),
  changeThreshold: (newThreshold: number) => vaultInterface.encodeFunctionData('changeThreshold', [newThreshold]),
  setMinExecutionDelay: (seconds: number) => vaultInterface.encodeFunctionData('setMinExecutionDelay', [seconds]),
  cancelByConsensus: (hash: string) => vaultInterface.encodeFunctionData('cancelByConsensus', [hash]),
};

export function createWalletCall(owners: readonly string[], threshold: number, minExecutionDelay: number, salt: string): string {
  return factoryInterface.encodeFunctionData('createWallet', [owners, threshold, minExecutionDelay, salt]);
}

export function erc20TransferCall(recipient: string, amount: bigint): string {
  return erc20Interface.encodeFunctionData('transfer', [recipient, amount]);
}

/**
 * Mirrors the vault's proposeTransaction checks so a bad draft is caught before any
 * simulation. `chainTime` is the latest block's timestamp.
 */
export function validateDraft(draft: ProposalDraft, vault: string, minExecutionDelay: number, chainTime: number): string[] {
  const errors: string[] = [];
  if (!isCyprus1QuaiAddress(draft.to)) errors.push('The destination must be a Cyprus-1 Quai address.');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(draft.data)) errors.push('Calldata must be 0x followed by whole bytes of hex.');
  if (draft.value < 0n) errors.push('Value cannot be negative.');
  if (!Number.isInteger(draft.requestedDelay) || draft.requestedDelay < 0 || draft.requestedDelay > VAULT_LIMITS.MAX_EXECUTION_DELAY) {
    errors.push('The delay must be between 0 and 30 days.');
  }
  const self = draft.to.toLowerCase() === vault.toLowerCase();
  let delay: number;
  if (self) {
    if (draft.value !== 0n) errors.push('Admin changes cannot carry value.');
    if (draft.gasLimit !== 0n) errors.push('Admin changes must have a gas limit of 0.');
    delay = 0;
  } else {
    if (draft.gasLimit <= 0n || draft.gasLimit > VAULT_LIMITS.MAX_TX_GAS) errors.push('The gas limit must be between 1 and 30,000,000.');
    delay = Math.max(minExecutionDelay, draft.requestedDelay);
  }
  const executableFrom = chainTime + delay;
  if (draft.expiration <= executableFrom + MIN_EXECUTION_WINDOW - 1) errors.push('The expiry must be at least 1 hour after the timelock ends.');
  if (draft.expiration > executableFrom + VAULT_LIMITS.MAX_EXECUTION_WINDOW) errors.push('The expiry must be within 30 days after the timelock ends.');
  return errors;
}

export interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface ParsedVaultLog {
  name: string;
  args: Record<string, unknown>;
}

/** Decodes the vault's events from a receipt, ignoring logs emitted by any other address. */
export function parseVaultLogs(logs: readonly LogLike[], vault: string): ParsedVaultLog[] {
  const out: ParsedVaultLog[] = [];
  for (const log of logs) {
    if (typeof log?.address !== 'string' || log.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const parsed = vaultInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) out.push({ name: parsed.name, args: parsed.args.toObject() });
    } catch {
      // not one of the vault's events
    }
  }
  return out;
}

export function proposedHashFromLogs(logs: readonly LogLike[], vault: string): string {
  const ev = parseVaultLogs(logs, vault).find((l) => l.name === 'TransactionProposed');
  if (!ev) throw new Error('The receipt has no TransactionProposed event from this vault.');
  return String(ev.args.txHash).toLowerCase();
}

export interface WalletCreatedEvent {
  wallet: string;
  creator: string;
  owners: string[];
  threshold: number;
  minExecutionDelay: number;
  salt: string;
}

export function walletCreatedFromLogs(logs: readonly LogLike[], factory: string): WalletCreatedEvent {
  for (const log of logs) {
    if (typeof log?.address !== 'string' || log.address.toLowerCase() !== factory.toLowerCase()) continue;
    try {
      const parsed = factoryInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'WalletCreated') {
        return {
          wallet: getAddress(parsed.args.wallet),
          creator: getAddress(parsed.args.creator),
          owners: Array.from(parsed.args.owners as string[], (o) => getAddress(o)),
          threshold: Number(parsed.args.threshold),
          minExecutionDelay: Number(parsed.args.minExecutionDelay),
          salt: String(parsed.args.salt).toLowerCase(),
        };
      }
    } catch {
      // not a factory event
    }
  }
  throw new Error('The receipt has no WalletCreated event from the DarkSafe factory.');
}

/** Human-readable name for a vault revert, e.g. "TimelockNotElapsed(1790000000)". */
export function describeVaultRevert(data: string | undefined | null): string | null {
  if (!data || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  try {
    const err = vaultInterface.parseError(data);
    return err ? `${err.name}(${Array.from(err.args).map(String).join(', ')})` : null;
  } catch {
    return null;
  }
}

export type CallSimulation = { ok: true } | { ok: false; reason: string };

/**
 * Runs the call the vault would make, from the vault's own address, against the latest
 * state. A failing inner call does not revert executeTransaction; it marks the
 * transaction failed for good, so this is checked before proposing and before executing.
 */
export async function simulateVaultCall(
  rpc: RpcLike,
  call: { vault: string; to: string; value: bigint; data: string; gasLimit?: bigint }
): Promise<CallSimulation> {
  const obj: Record<string, string> = { from: call.vault, to: call.to, data: call.data };
  if (call.value > 0n) obj.value = '0x' + call.value.toString(16);
  if (call.gasLimit && call.gasLimit > 0n) obj.gas = '0x' + call.gasLimit.toString(16);
  try {
    await rpc.rawRequest('quai_call', [obj, 'latest']);
    return { ok: true };
  } catch (err: any) {
    const reason = describeVaultRevert(typeof err?.data === 'string' ? err.data : undefined) ?? err?.message ?? String(err);
    return { ok: false, reason };
  }
}

/**
 * Gas to commit for an external call: the node's estimate for the same call made by the
 * vault, with 50% headroom plus a fixed margin. The vault refuses to run the call with
 * less than this, so a starved execute can never burn the transaction.
 */
export async function recommendGasLimit(rpc: RpcLike, call: { vault: string; to: string; value: bigint; data: string }): Promise<bigint> {
  const obj: Record<string, string> = { from: call.vault, to: call.to, data: call.data };
  if (call.value > 0n) obj.value = '0x' + call.value.toString(16);
  const estimate = BigInt(await rpc.rawRequest<string>('quai_estimateGas', [obj, 'latest']));
  const padded = (estimate * 3n) / 2n + 25_000n;
  const floored = padded < 50_000n ? 50_000n : padded;
  return floored > VAULT_LIMITS.MAX_TX_GAS ? VAULT_LIMITS.MAX_TX_GAS : floored;
}
