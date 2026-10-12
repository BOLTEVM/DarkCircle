import { formatUnits, getAddress } from 'ethers';
import {
  ReadSource,
  VaultDeployment,
  VaultTransaction,
  TxStatusName,
  RiskLevel,
  readBlock,
  readBlockNumber,
  readVaultAcrossSources,
  readVaultTransaction,
  listTransactionHashes,
  decodeVaultCall,
  describeRisk,
  highestRisk,
  summarizeCall,
  formatDuration,
  formatUtc,
} from '@darksafe/core';

/**
 * One poll of the watcher. It reads each vault's views at a confirmed block (head minus
 * confirmations) and compares them with the previous poll, rather than scanning event logs:
 * log queries over Orchard's public RPC take ~16 s per 100 blocks and time out at 500. The
 * vault's transaction list is append-only and every admin change is itself a transaction,
 * so nothing that matters can happen between polls without showing up here.
 */

export type AlertLevel = 'critical' | 'high' | 'info';

export interface Alert {
  level: AlertLevel;
  kind: string;
  vault: string | null;
  block: string | null;
  message: string;
  data?: Record<string, unknown>;
}

export interface TrackedTx {
  hash: string;
  nonce: number;
  status: TxStatusName;
  approvedAt: number;
  approvals: number;
  admin: boolean;
  summary: string;
}

export interface VaultRecord {
  owners: string[];
  threshold: number;
  minExecutionDelay: number;
  txNonce: number;
  balance: string;
  /** Transactions still open (not executed, cancelled or expired). */
  open: Record<string, TrackedTx>;
}

export interface WatcherState {
  version: 1;
  chainId: number;
  /** Last confirmed block processed, and its hash (re-read every poll to detect reorgs). */
  block: string | null;
  blockHash: string | null;
  vaults: Record<string, VaultRecord | null>;
  lastPollAt: number | null;
}

export interface PollDeps {
  sources: readonly ReadSource[];
  deployment: VaultDeployment;
  vaults: readonly string[];
  confirmations: number;
  /** Proposals moving at least this much QUAI are raised as high. */
  largeValueWei?: bigint;
  now?: () => number;
}

export function emptyState(chainId: number): WatcherState {
  return { version: 1, chainId, block: null, blockHash: null, vaults: {}, lastPollAt: null };
}

const TERMINAL = new Set<TxStatusName>(['Executed', 'Failed', 'Cancelled', 'Expired']);
const LEVEL_OF: Record<RiskLevel, AlertLevel> = { critical: 'critical', high: 'high', medium: 'info', info: 'info' };

function track(vault: string, tx: VaultTransaction): TrackedTx {
  const decoded = decodeVaultCall({ vault, to: tx.to, value: tx.value, data: tx.data });
  return {
    hash: tx.hash,
    nonce: tx.nonce,
    status: tx.status,
    approvedAt: tx.approvedAt,
    approvals: tx.approvals.length,
    admin: tx.to.toLowerCase() === vault.toLowerCase(),
    summary: summarizeCall(decoded),
  };
}

export async function pollOnce(prev: WatcherState, deps: PollDeps): Promise<{ state: WatcherState; alerts: Alert[] }> {
  const primary = deps.sources[0]!.rpc;
  const alerts: Alert[] = [];
  const head = await readBlockNumber(primary);
  const target = head - BigInt(Math.max(deps.confirmations, 1) - 1);
  if (prev.block !== null && target <= BigInt(prev.block)) return { state: prev, alerts };

  const state: WatcherState = { ...prev, vaults: { ...prev.vaults } };
  if (prev.block !== null && prev.blockHash !== null) {
    const again = await readBlock(primary, BigInt(prev.block));
    if (again.hash !== prev.blockHash) {
      alerts.push({
        level: 'high',
        kind: 'reorg',
        vault: null,
        block: prev.block,
        message: `Block ${prev.block} changed hash after ${deps.confirmations} confirmations (a deep reorg). Vault state is being re-read.`,
        data: { was: prev.blockHash, now: again.hash },
      });
    }
  }
  const confirmed = await readBlock(primary, target);
  const at = target.toString();

  for (const raw of deps.vaults) {
    const vault = getAddress(raw);
    const before = prev.vaults[vault] ?? null;
    const push = (level: AlertLevel, kind: string, message: string, data?: Record<string, unknown>) =>
      alerts.push({ level, kind, vault, block: at, message, data });

    let read;
    try {
      read = await readVaultAcrossSources(deps.sources, vault, deps.deployment, { atBlock: target });
    } catch (err: any) {
      push('critical', 'vault-unverifiable', `Could not verify ${vault} at block ${at}: ${err?.message ?? err}`);
      continue;
    }
    if (read.status === 'disagreement') {
      push('critical', 'sources-disagree', `Sources disagree about ${vault} at block ${at}.`, { problems: read.problems });
    }
    const snap = read.value.snapshot;

    if (before === null) {
      push('info', 'watching', `Watching ${vault}: ${snap.threshold} of ${snap.owners.length}, timelock ${formatDuration(snap.minExecutionDelay)}, ${snap.txNonce} transactions.`);
    } else {
      const was = new Set(before.owners.map((o) => o.toLowerCase()));
      const now = new Set(snap.owners.map((o) => o.toLowerCase()));
      for (const o of snap.owners) if (!was.has(o.toLowerCase())) push('critical', 'owner-added', `Owner added: ${o}`, { owner: o });
      for (const o of before.owners) if (!now.has(o.toLowerCase())) push('critical', 'owner-removed', `Owner removed: ${o}`, { owner: o });
      if (snap.threshold !== before.threshold) {
        push(snap.threshold < before.threshold ? 'critical' : 'high', 'threshold-changed', `Threshold changed from ${before.threshold} to ${snap.threshold} (of ${snap.owners.length}).`);
      }
      if (snap.minExecutionDelay !== before.minExecutionDelay) {
        push(
          snap.minExecutionDelay < before.minExecutionDelay ? 'critical' : 'high',
          'delay-changed',
          `Minimum timelock changed from ${formatDuration(before.minExecutionDelay)} to ${formatDuration(snap.minExecutionDelay)}.`
        );
      }
    }

    // New proposals since the last poll; on the first poll, the most recent 100 are baselined.
    const open: Record<string, TrackedTx> = { ...(before?.open ?? {}) };
    const from = before ? before.txNonce : Math.max(0, snap.txNonce - 100);
    if (snap.txNonce > from) {
      const hashes = await listTransactionHashes(primary, vault, from, Math.min(100, snap.txNonce - from), target);
      for (let i = 0; i < hashes.length; i++) {
        const tx = await readVaultTransaction(primary, vault, hashes[i]!, from + i, target);
        const t = track(vault, tx);
        if (before) {
          const decoded = decodeVaultCall({ vault, to: tx.to, value: tx.value, data: tx.data });
          const risks = describeRisk(decoded, { vault, owners: snap.owners, threshold: snap.threshold, minExecutionDelay: snap.minExecutionDelay, balance: snap.balance });
          let level: AlertLevel = LEVEL_OF[highestRisk(risks) ?? 'info'];
          if (deps.largeValueWei !== undefined && tx.value >= deps.largeValueWei && level === 'info') level = 'high';
          push(level, 'proposed', `#${tx.nonce} proposed by ${tx.proposer}: ${t.summary}${tx.value > 0n ? ` (${formatUnits(tx.value, 18)} QUAI)` : ''}.`, {
            txHash: tx.hash,
            risks: risks.map((r) => r.code),
          });
        }
        if (!TERMINAL.has(tx.status)) {
          open[tx.hash] = t;
          if (before && tx.approvedAt !== 0) {
            push(t.admin ? 'critical' : 'high', 'threshold-reached', `#${tx.nonce} already reached quorum: ${t.summary}.`, {
              txHash: tx.hash,
              executableAfter: tx.approvedAt + tx.executionDelay,
            });
          }
        } else if (before) {
          push(tx.status === 'Failed' ? 'high' : 'info', 'closed', `#${tx.nonce} is already ${tx.status}: ${t.summary}.`, { txHash: tx.hash });
        }
      }
    }

    // Progress on transactions that were open.
    for (const [hash, old] of Object.entries(before?.open ?? {})) {
      const tx = await readVaultTransaction(primary, vault, hash, old.nonce, target);
      const t = track(vault, tx);
      if (old.approvedAt === 0 && tx.approvedAt !== 0) {
        const executableAfter = tx.approvedAt + tx.executionDelay;
        push(
          t.admin ? 'critical' : 'high',
          'threshold-reached',
          t.admin
            ? `#${tx.nonce} reached quorum and can be executed now (admin changes have no timelock): ${t.summary}.`
            : `#${tx.nonce} reached quorum; executable from ${formatUtc(executableAfter)}: ${t.summary}.`,
          { txHash: hash, executableAfter }
        );
      }
      if (TERMINAL.has(tx.status)) {
        push(tx.status === 'Failed' ? 'high' : 'info', tx.status.toLowerCase(), `#${tx.nonce} ${tx.status.toLowerCase()}: ${t.summary}.`, { txHash: hash });
        delete open[hash];
      } else {
        open[hash] = t;
      }
    }

    state.vaults[vault] = {
      owners: snap.owners,
      threshold: snap.threshold,
      minExecutionDelay: snap.minExecutionDelay,
      txNonce: snap.txNonce,
      balance: snap.balance.toString(),
      open,
    };
  }

  state.block = at;
  state.blockHash = confirmed.hash;
  state.lastPollAt = (deps.now ?? Date.now)();
  return { state, alerts };
}
