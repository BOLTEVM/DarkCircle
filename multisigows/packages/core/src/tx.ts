import { QuaiRpcClient, QuaiReceipt, QuaiRpcError } from './rpc.js';
import { validateCyprus1Address } from './address.js';

/**
 * Quai transaction pipeline: simulate -> access list -> explicit gas limit ->
 * send through the user's wallet -> wait for N confirmations.
 *
 * Quai-specific rules this encodes (each learned from a real loss or failure):
 *  - A transaction that reverts on Quai is charged its WHOLE gas limit, so every
 *    send is simulated first and refused if the simulation reverts.
 *  - A contract call without an access list can revert and burn the limit, so calls
 *    carry the list from quai_createAccessList. That RPC reports a revert inside a
 *    successful result (`result.error`), not as an RPC error, so it is checked explicitly.
 *  - quai_estimateGas badly understates contract creation (sender-dependent, and a
 *    16.9 KB deploy was charged 2.5x its estimate), so creation is sized from runtime
 *    bytes instead. Creation also sends no access list: the wallet grinds the init code
 *    into the deployer's zone, which would invalidate a precomputed list.
 *  - Blocks cannot be expanded by ethers/viem (no r/s/v), so receipts are polled over
 *    raw JSON-RPC and confirmations are counted against quai_blockNumber.
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
  /** Omit to deploy a contract. */
  to?: string;
  data: string;
  value?: bigint;
}

export interface PreparedTx extends TxDraft {
  gasLimit: bigint;
  accessList?: AccessListEntry[];
  /** quai_estimateGas's answer, for display only. Creation limits never come from it. */
  estimatedGas: bigint;
  /** What quai_call returned, so callers can check a non-reverting "failure" (e.g. `returns (bool)` = false). */
  simulationResult: string;
}

/** Gas per runtime byte for a direct contract creation (948/byte was actually charged on Cyprus-1). */
export const CREATION_GAS_PER_RUNTIME_BYTE = 1_250n;
export const MAX_GAS_LIMIT = 45_000_000n;
/** Headroom over quai_estimateGas for ordinary calls. */
export const CALL_GAS_MULTIPLIER_BPS = 13_000n;

export class SimulationError extends Error {
  constructor(message: string, readonly revertData?: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

/** Thrown after a hash exists, so callers can always show the user what was broadcast. */
export class BroadcastError extends Error {
  constructor(message: string, readonly txHash: string) {
    super(message);
    this.name = 'BroadcastError';
  }
}

export class ChainMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number | null) {
    super(
      actual === null
        ? `Could not read the wallet's network. Expected chain ${expected}; refusing to send.`
        : `Wallet is on chain ${actual}, but this app is configured for chain ${expected}. Switch networks in your wallet.`
    );
    this.name = 'ChainMismatchError';
  }
}

function toHex(value: bigint): string {
  return '0x' + value.toString(16);
}

function rpcTxObject(tx: TxDraft): Record<string, string> {
  const obj: Record<string, string> = { from: tx.from, data: tx.data };
  if (tx.to) obj.to = tx.to;
  if (tx.value && tx.value > 0n) obj.value = toHex(tx.value);
  return obj;
}

function revertMessage(err: unknown): { message: string; data?: string } {
  if (err instanceof QuaiRpcError) {
    return { message: err.message, data: typeof err.data === 'string' ? err.data : undefined };
  }
  return { message: (err as Error)?.message ?? String(err) };
}

export function creationGasLimit(runtimeBytes: number): bigint {
  const wanted = BigInt(runtimeBytes) * CREATION_GAS_PER_RUNTIME_BYTE;
  return wanted < MAX_GAS_LIMIT ? wanted : MAX_GAS_LIMIT;
}

export function callGasLimit(estimate: bigint): bigint {
  const padded = (estimate * CALL_GAS_MULTIPLIER_BPS + 9_999n) / 10_000n;
  return padded < MAX_GAS_LIMIT ? padded : MAX_GAS_LIMIT;
}

/**
 * Simulates the transaction and builds everything the wallet needs to send it safely.
 * Throws SimulationError (and sends nothing) if the chain says it would revert.
 */
export async function prepareQuaiTransaction(
  rpc: QuaiRpcClient,
  tx: TxDraft,
  opts: { creationRuntimeBytes?: number } = {}
): Promise<PreparedTx> {
  const from = validateCyprus1Address(tx.from);
  if (!from.isValid) throw new SimulationError(`Sender is not a Cyprus-1 address: ${from.error}`);
  if (tx.to) {
    const to = validateCyprus1Address(tx.to);
    if (!to.isValid) throw new SimulationError(`Destination is not a Cyprus-1 address: ${to.error}`);
  }
  const isCreation = !tx.to;
  if (isCreation && !opts.creationRuntimeBytes) {
    throw new SimulationError('Contract creation needs the runtime size to size its gas limit.');
  }

  const obj = rpcTxObject(tx);

  let simulationResult: string;
  try {
    simulationResult = await rpc.rawRequest<string>('quai_call', [obj, 'latest']);
  } catch (err) {
    const { message, data } = revertMessage(err);
    throw new SimulationError(`Simulation failed, nothing was sent: ${message}`, data);
  }

  let estimatedGas: bigint;
  try {
    estimatedGas = BigInt(await rpc.rawRequest<string>('quai_estimateGas', [obj, 'latest']));
  } catch (err) {
    throw new SimulationError(`Gas estimation failed, nothing was sent: ${revertMessage(err).message}`);
  }

  if (isCreation) {
    return { ...tx, estimatedGas, simulationResult, gasLimit: creationGasLimit(opts.creationRuntimeBytes!) };
  }

  const acl = await rpc.rawRequest<{ accessList?: AccessListEntry[]; error?: string }>(
    'quai_createAccessList',
    [obj, 'latest']
  );
  if (!acl || acl.error) {
    throw new SimulationError(
      `The access-list simulation reported "${acl?.error ?? 'no result'}". Refusing to send: on Quai a revert is charged the whole gas limit.`
    );
  }
  return {
    ...tx,
    estimatedGas,
    simulationResult,
    gasLimit: callGasLimit(estimatedGas),
    accessList: acl.accessList ?? [],
  };
}

export async function readWalletChainId(provider: InjectedProviderLike): Promise<number | null> {
  for (const method of ['quai_chainId', 'eth_chainId']) {
    try {
      const hex = await provider.request({ method });
      if (typeof hex === 'string' && /^0x[0-9a-f]+$/i.test(hex)) return parseInt(hex, 16);
      if (typeof hex === 'number') return hex;
    } catch {
      // try the next namespace
    }
  }
  return null;
}

export async function assertWalletOnChain(provider: InjectedProviderLike, expectedChainId: number): Promise<void> {
  const actual = await readWalletChainId(provider);
  if (actual !== expectedChainId) throw new ChainMismatchError(expectedChainId, actual);
}

/**
 * Hands the prepared transaction to the wallet. Uses the field names Pelagus/quais
 * expect (`gasLimit`, and `accessList` which quais keeps when supplied).
 */
export async function sendPreparedTransaction(
  provider: InjectedProviderLike,
  prepared: PreparedTx,
  method: 'quai_sendTransaction' | 'eth_sendTransaction' = 'quai_sendTransaction'
): Promise<string> {
  const params: Record<string, unknown> = { from: prepared.from, data: prepared.data, gasLimit: toHex(prepared.gasLimit) };
  if (method === 'eth_sendTransaction') {
    delete params.gasLimit;
    params.gas = toHex(prepared.gasLimit);
  }
  if (prepared.to) params.to = prepared.to;
  if (prepared.value && prepared.value > 0n) params.value = toHex(prepared.value);
  if (prepared.accessList) params.accessList = prepared.accessList;

  const hash = await provider.request({ method, params: [params] });
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`Wallet returned an unexpected transaction hash: ${String(hash)}`);
  }
  return hash;
}

export interface ConfirmationOptions {
  confirmations: number;
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: { stage: 'pending' | 'mined'; confirmations: number; blockNumber?: bigint }) => void;
}

/**
 * Waits until the receipt is `confirmations` blocks deep. If the receipt's block hash
 * changes between polls (a reorg), the count restarts. Every failure keeps the tx hash.
 */
export async function waitForConfirmations(
  rpc: QuaiRpcClient,
  txHash: string,
  opts: ConfirmationOptions
): Promise<QuaiReceipt> {
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + opts.timeoutMs;
  let seenBlockHash: string | null = null;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new BroadcastError(`Stopped waiting for ${txHash}; it may still confirm.`, txHash);
    }

    let receipt: QuaiReceipt | null = null;
    try {
      receipt = await rpc.getTransactionReceipt(txHash);
    } catch {
      // transient RPC failure: keep polling until the deadline
    }

    if (receipt && receipt.blockNumber) {
      if (seenBlockHash !== null && receipt.blockHash !== seenBlockHash) {
        opts.onProgress?.({ stage: 'pending', confirmations: 0 });
      }
      seenBlockHash = receipt.blockHash;

      const mined = BigInt(receipt.blockNumber);
      let head = mined;
      try {
        head = await rpc.getBlockNumber();
      } catch {
        // fall through with head == mined (1 confirmation) and retry next poll
      }
      const depth = Number(head - mined) + 1;
      opts.onProgress?.({ stage: 'mined', confirmations: Math.max(depth, 1), blockNumber: mined });

      if (depth >= opts.confirmations) {
        const final = await rpc.getTransactionReceipt(txHash).catch(() => null);
        if (final && final.blockHash === receipt.blockHash) return final;
        seenBlockHash = final?.blockHash ?? null;
      }
    } else {
      if (seenBlockHash !== null) {
        seenBlockHash = null;
      }
      opts.onProgress?.({ stage: 'pending', confirmations: 0 });
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new BroadcastError(
    `No confirmed receipt for ${txHash} within ${Math.round(opts.timeoutMs / 1000)}s. It may still confirm; check the explorer before retrying.`,
    txHash
  );
}

export function receiptSucceeded(receipt: QuaiReceipt): boolean {
  return receipt.status === '0x1';
}
