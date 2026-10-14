import { explainRevert } from './abi.js';
import { requireAddress } from './address.js';
import type { NetworkConfig } from './config.js';
import { RpcClient, RpcError, type QuaiReceipt } from './rpc.js';

/**
 * Wallet transactions on Quai: simulate -> access list -> explicit gas limit -> the user's
 * wallet signs and sends -> wait for N confirmations. Adapted from DarkSafe's pipeline via
 * the suite's earlier apps; each rule was learned from a real loss on Cyprus-1:
 *  - A reverted transaction is charged its WHOLE gas limit, so nothing is sent unless the
 *    simulation succeeds.
 *  - A contract call sent without an access list can revert and burn the limit, so calls carry
 *    the list from quai_createAccessList. That RPC reports a revert inside a successful result
 *    (`result.error`), so it is checked explicitly.
 *  - Receipts are polled over raw JSON-RPC and confirmations counted against the block number;
 *    a receipt that moves to another block (a reorg) restarts the count.
 */

export interface InjectedProviderLike {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

export interface AccessListEntry {
  address: string;
  storageKeys: string[];
}

export interface TxDraft {
  from: string;
  to: string;
  data: string;
  value?: bigint;
}

export interface PreparedTx extends TxDraft {
  gasLimit: bigint;
  accessList: AccessListEntry[];
  estimatedGas: bigint;
}

export const MAX_GAS_LIMIT = 45_000_000n;
/** Headroom over quai_estimateGas for calls: 30%. */
export const CALL_GAS_MULTIPLIER_BPS = 13_000n;

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

/** Thrown once a hash exists, so the UI can always show what was broadcast. */
export class BroadcastError extends Error {
  constructor(
    message: string,
    readonly txHash: string
  ) {
    super(message);
    this.name = 'BroadcastError';
  }
}

export class ChainMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number | null
  ) {
    super(
      actual === null
        ? `Could not read your wallet's network. Expected chain ${expected}; nothing was sent.`
        : `Your wallet is on chain ${actual}, but this page is set to chain ${expected}. Switch networks in your wallet.`
    );
    this.name = 'ChainMismatchError';
  }
}

const toHex = (v: bigint) => '0x' + v.toString(16);

export function callGasLimit(estimate: bigint): bigint {
  const padded = (estimate * CALL_GAS_MULTIPLIER_BPS + 9_999n) / 10_000n;
  return padded < MAX_GAS_LIMIT ? padded : MAX_GAS_LIMIT;
}

function rpcTx(tx: TxDraft): Record<string, string> {
  const obj: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data };
  if (tx.value && tx.value > 0n) obj.value = toHex(tx.value);
  return obj;
}

/** Turns a node's revert into words, decoding DarkOrder's custom errors. */
export function revertReason(err: unknown): string {
  if (err instanceof RpcError) return explainRevert(err.message, typeof err.data === 'string' ? err.data : undefined);
  return explainRevert((err as Error)?.message ?? String(err));
}

/** Simulates the call and builds everything the wallet needs. Sends nothing; throws SimulationError on revert. */
export async function prepareTransaction(rpc: RpcClient, network: NetworkConfig, draft: TxDraft): Promise<PreparedTx> {
  const tx: TxDraft = {
    ...draft,
    from: requireAddress(draft.from, network.addressRule, 'Sender'),
    to: requireAddress(draft.to, network.addressRule, 'Contract'),
  };
  const obj = rpcTx(tx);

  try {
    await rpc.request('quai_call', [obj, 'latest']);
  } catch (err) {
    throw new SimulationError(`The chain says this would fail, so nothing was sent: ${revertReason(err)}`);
  }

  let estimatedGas: bigint;
  try {
    estimatedGas = BigInt(await rpc.request<string>('quai_estimateGas', [obj, 'latest']));
  } catch (err) {
    throw new SimulationError(`Gas estimation failed, so nothing was sent: ${revertReason(err)}`);
  }

  let accessList: AccessListEntry[] = [];
  if (network.rpcNamespace === 'quai') {
    const acl = await rpc.request<{ accessList?: AccessListEntry[]; error?: string }>('quai_createAccessList', [obj, 'latest']);
    if (!acl || acl.error) {
      throw new SimulationError(
        `The access-list simulation reported "${acl?.error ?? 'no result'}". Nothing was sent: on Quai a revert costs the whole gas limit.`
      );
    }
    accessList = acl.accessList ?? [];
  }

  return { ...tx, estimatedGas, gasLimit: callGasLimit(estimatedGas), accessList };
}

export async function readWalletChainId(provider: InjectedProviderLike): Promise<number | null> {
  for (const method of ['quai_chainId', 'eth_chainId']) {
    try {
      const v = await provider.request({ method });
      if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
      if (typeof v === 'number') return v;
    } catch {
      // try the other namespace
    }
  }
  return null;
}

export async function assertWalletOnChain(provider: InjectedProviderLike, expected: number): Promise<void> {
  const actual = await readWalletChainId(provider);
  if (actual !== expected) throw new ChainMismatchError(expected, actual);
}

/** Hands a prepared transaction to the wallet, with the field names Pelagus/quais expect. */
export async function sendPrepared(provider: InjectedProviderLike, prepared: PreparedTx, namespace: 'quai' | 'eth'): Promise<string> {
  const params: Record<string, unknown> = { from: prepared.from, to: prepared.to, data: prepared.data };
  if (namespace === 'quai') params.gasLimit = toHex(prepared.gasLimit);
  else params.gas = toHex(prepared.gasLimit);
  if (prepared.value && prepared.value > 0n) params.value = toHex(prepared.value);
  if (prepared.accessList.length > 0) params.accessList = prepared.accessList;

  const hash = await provider.request({ method: `${namespace}_sendTransaction`, params: [params] });
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`The wallet returned something that is not a transaction hash: ${String(hash)}`);
  }
  return hash;
}

export interface WaitOptions {
  confirmations: number;
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: { stage: 'pending' | 'mined'; confirmations: number }) => void;
}

export async function waitForConfirmations(rpc: RpcClient, hash: string, opts: WaitOptions): Promise<QuaiReceipt> {
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + opts.timeoutMs;
  let seenBlock: string | null = null;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new BroadcastError(`Stopped waiting for ${hash}; it may still confirm.`, hash);
    const receipt = await rpc.getTransactionReceipt(hash).catch(() => null);
    if (receipt?.blockNumber) {
      if (seenBlock !== null && receipt.blockHash !== seenBlock) opts.onProgress?.({ stage: 'pending', confirmations: 0 });
      seenBlock = receipt.blockHash;
      const head = await rpc.getBlockNumber().catch(() => BigInt(receipt.blockNumber));
      const depth = Number(head - BigInt(receipt.blockNumber)) + 1;
      opts.onProgress?.({ stage: 'mined', confirmations: Math.max(depth, 1) });
      if (depth >= opts.confirmations) {
        const final = await rpc.getTransactionReceipt(hash).catch(() => null);
        if (final && final.blockHash === receipt.blockHash) return final;
        seenBlock = final?.blockHash ?? null;
      }
    } else {
      seenBlock = null;
      opts.onProgress?.({ stage: 'pending', confirmations: 0 });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new BroadcastError(`No confirmed receipt for ${hash} yet. It may still confirm; check the explorer before retrying.`, hash);
}

export function receiptSucceeded(receipt: QuaiReceipt): boolean {
  return receipt.status === '0x1';
}
