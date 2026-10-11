import { getAddress } from 'ethers';
import { vaultInterface, TX_STATUSES, TxStatusName, VAULT_LIMITS } from './abi.js';
import { BlockTag, RpcLike, balanceAt, callAt, mapLimit } from './rpc.js';

export class VaultStateMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultStateMismatchError';
  }
}

async function read<T = any>(rpc: RpcLike, vault: string, fn: string, args: unknown[], tag: BlockTag): Promise<T> {
  const raw = await callAt(rpc, vault, vaultInterface.encodeFunctionData(fn, args), tag);
  return vaultInterface.decodeFunctionResult(fn, raw)[0] as T;
}

export interface VaultSnapshot {
  vault: string;
  owners: string[];
  threshold: number;
  minExecutionDelay: number;
  /** Number of transactions ever proposed; also the nonce the next proposal gets. */
  txNonce: number;
  balance: bigint;
}

/** Reads the vault's governance state. Pass a block number so every read sees the same state. */
export async function readVaultSnapshot(rpc: RpcLike, vault: string, tag: BlockTag = 'latest'): Promise<VaultSnapshot> {
  const [owners, threshold, delay, nonce, count, balance] = await Promise.all([
    read<string[]>(rpc, vault, 'getOwners', [], tag),
    read<bigint>(rpc, vault, 'getThreshold', [], tag),
    read<bigint>(rpc, vault, 'minExecutionDelay', [], tag),
    read<bigint>(rpc, vault, 'txNonce', [], tag),
    read<bigint>(rpc, vault, 'getTransactionCount', [], tag),
    balanceAt(rpc, vault, tag),
  ]);
  const snapshot: VaultSnapshot = {
    vault: getAddress(vault),
    owners: Array.from(owners, (o) => getAddress(o)),
    threshold: Number(threshold),
    minExecutionDelay: Number(delay),
    txNonce: Number(nonce),
    balance,
  };
  const n = snapshot.owners.length;
  if (n === 0 || n > VAULT_LIMITS.MAX_OWNERS || snapshot.threshold < 1 || snapshot.threshold > n) {
    throw new VaultStateMismatchError(`${vault} reports ${snapshot.threshold}-of-${n}, which no valid vault can have.`);
  }
  if (snapshot.minExecutionDelay > VAULT_LIMITS.MAX_EXECUTION_DELAY || count !== nonce) {
    throw new VaultStateMismatchError(`${vault} reports state a genuine vault cannot have.`);
  }
  return snapshot;
}

export interface VaultTransaction {
  hash: string;
  /** Index in the vault's list, which is the nonce it was hashed with. */
  nonce: number;
  to: string;
  value: bigint;
  data: string;
  gasLimit: bigint;
  executionDelay: number;
  proposer: string;
  proposedAt: number;
  expiration: number;
  /** 0 until quorum was first reached. */
  approvedAt: number;
  executed: boolean;
  failed: boolean;
  cancelled: boolean;
  expired: boolean;
  /** As computed by the vault at the block read. */
  status: TxStatusName;
  /** Owners whose approval currently counts. */
  approvals: string[];
}

export async function listTransactionHashes(rpc: RpcLike, vault: string, offset: number, limit: number, tag: BlockTag = 'latest'): Promise<string[]> {
  const page = await read<string[]>(rpc, vault, 'getTransactionHashes', [offset, limit], tag);
  return Array.from(page, (h) => String(h).toLowerCase());
}

export async function readVaultTransaction(rpc: RpcLike, vault: string, hash: string, nonce: number, tag: BlockTag = 'latest'): Promise<VaultTransaction> {
  const [t, status, approvals, atIndex] = await Promise.all([
    read<any>(rpc, vault, 'getTransaction', [hash], tag),
    read<bigint>(rpc, vault, 'status', [hash], tag),
    read<string[]>(rpc, vault, 'getApprovals', [hash], tag),
    listTransactionHashes(rpc, vault, nonce, 1, tag),
  ]);
  if (Number(t.proposedAt) === 0) throw new VaultStateMismatchError(`Transaction ${hash} does not exist in ${vault}.`);
  if (atIndex[0] !== hash.toLowerCase()) {
    throw new VaultStateMismatchError(`Transaction ${hash} is not at position ${nonce} of ${vault}.`);
  }
  const statusName = TX_STATUSES[Number(status)];
  if (!statusName) throw new VaultStateMismatchError(`Unknown status ${status} for ${hash}.`);
  return {
    hash: hash.toLowerCase(),
    nonce,
    to: getAddress(t.to),
    value: BigInt(t.value),
    data: String(t.data),
    gasLimit: BigInt(t.gasLimit),
    executionDelay: Number(t.executionDelay),
    proposer: getAddress(t.proposer),
    proposedAt: Number(t.proposedAt),
    expiration: Number(t.expiration),
    approvedAt: Number(t.approvedAt),
    executed: Boolean(t.executed),
    failed: Boolean(t.failed),
    cancelled: Boolean(t.cancelled),
    expired: Boolean(t.expired),
    status: statusName,
    approvals: Array.from(approvals, (a) => getAddress(a)),
  };
}

/** Finds a transaction's position by scanning the list from the newest end. */
export async function findTransactionNonce(rpc: RpcLike, vault: string, hash: string, txCount: number, tag: BlockTag = 'latest'): Promise<number> {
  const wanted = hash.toLowerCase();
  for (let end = txCount; end > 0; end -= 100) {
    const start = Math.max(0, end - 100);
    const page = await listTransactionHashes(rpc, vault, start, end - start, tag);
    const i = page.indexOf(wanted);
    if (i >= 0) return start + i;
  }
  throw new VaultStateMismatchError(`Transaction ${hash} is not in ${vault}.`);
}

/** The newest `count` transactions, newest first, all read at one block. */
export async function readRecentTransactions(
  rpc: RpcLike,
  vault: string,
  txCount: number,
  opts: { count?: number; tag?: BlockTag; concurrency?: number } = {}
): Promise<VaultTransaction[]> {
  const count = Math.min(opts.count ?? 25, 100);
  const tag = opts.tag ?? 'latest';
  if (txCount === 0) return [];
  const offset = Math.max(0, txCount - count);
  const hashes = await listTransactionHashes(rpc, vault, offset, txCount - offset, tag);
  const txs = await mapLimit(hashes, opts.concurrency ?? 4, (h, i) => readVaultTransaction(rpc, vault, h, offset + i, tag));
  return txs.reverse();
}

export interface TransactionActions {
  canApprove: boolean;
  canRevoke: boolean;
  canExecute: boolean;
  /** Quorum exists but the clock never started (threshold was lowered later): execute only starts it. */
  needsClockStart: boolean;
  canCancel: boolean;
  canExpire: boolean;
  /** When the timelock ends, or null if quorum has not started it. */
  executableAfter: number | null;
}

/** What `account` may do with `tx`, judged at chain time `now` (seconds). */
export function transactionActions(tx: VaultTransaction, snapshot: VaultSnapshot, account: string | null, now: number): TransactionActions {
  const open = !tx.executed && !tx.cancelled && !tx.expired;
  const live = open && now <= tx.expiration;
  const me = account?.toLowerCase() ?? null;
  const isOwner = me !== null && snapshot.owners.some((o) => o.toLowerCase() === me);
  const approved = me !== null && tx.approvals.some((a) => a.toLowerCase() === me);
  const quorum = tx.approvals.length >= snapshot.threshold;
  const executableAfter = tx.approvedAt > 0 ? tx.approvedAt + tx.executionDelay : null;
  const needsClockStart = live && quorum && tx.approvedAt === 0 && tx.executionDelay > 0;
  const clockDone = tx.approvedAt > 0 ? now >= tx.approvedAt + tx.executionDelay : tx.executionDelay === 0;
  return {
    canApprove: live && isOwner && !approved,
    canRevoke: open && isOwner && approved,
    canExecute: live && isOwner && quorum && clockDone,
    needsClockStart: needsClockStart && isOwner,
    canCancel: open && isOwner && tx.approvedAt === 0 && tx.proposer.toLowerCase() === me,
    canExpire: open && now > tx.expiration,
    executableAfter,
  };
}

/** The vault's computed status for one transaction, without needing its list position. */
export async function readTransactionStatus(rpc: RpcLike, vault: string, hash: string, tag: BlockTag = 'latest'): Promise<TxStatusName> {
  const status = await read<bigint>(rpc, vault, 'status', [hash], tag);
  const name = TX_STATUSES[Number(status)];
  if (!name) throw new VaultStateMismatchError(`Unknown status ${status} for ${hash}.`);
  return name;
}
