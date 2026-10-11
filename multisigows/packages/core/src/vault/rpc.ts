import type { InjectedProviderLike } from '../tx.js';

/**
 * The smallest RPC surface the vault module needs. QuaiRpcClient satisfies it, and so
 * does an injected wallet provider through injectedProviderSource().
 */
export interface RpcLike {
  rawRequest<T = any>(method: string, params?: unknown[]): Promise<T>;
}

/** 'latest', or a block number. Reads that must agree with each other use one fixed number. */
export type BlockTag = 'latest' | bigint | number;

export function toBlockTag(tag: BlockTag): string {
  return tag === 'latest' ? 'latest' : '0x' + BigInt(tag).toString(16);
}

export interface BlockHead {
  number: bigint;
  hash: string;
  /** Seconds, from the block's work-object header. */
  timestamp: number;
}

/**
 * Reads a block header. Quai blocks carry number and timestamp in `woHeader` (the EVM
 * `header.number` is a per-context array), and the hash at the top level.
 */
export async function readBlock(rpc: RpcLike, tag: BlockTag = 'latest'): Promise<BlockHead> {
  const block = await rpc.rawRequest<any>('quai_getBlockByNumber', [toBlockTag(tag), false]);
  const wo = block?.woHeader;
  if (!block || typeof block.hash !== 'string' || !wo || typeof wo.number !== 'string' || typeof wo.timestamp !== 'string') {
    throw new Error(`Block ${toBlockTag(tag)} is missing or not in Quai format.`);
  }
  return { number: BigInt(wo.number), hash: block.hash, timestamp: Number(BigInt(wo.timestamp)) };
}

export async function readBlockNumber(rpc: RpcLike): Promise<bigint> {
  const hex = await rpc.rawRequest<string>('quai_blockNumber', []);
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`Unexpected block number ${String(hex)}`);
  return BigInt(hex);
}

export async function callAt(rpc: RpcLike, to: string, data: string, tag: BlockTag = 'latest', from?: string): Promise<string> {
  const obj: Record<string, string> = { to, data };
  if (from) obj.from = from;
  const result = await rpc.rawRequest<string>('quai_call', [obj, toBlockTag(tag)]);
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error(`Unexpected quai_call result from ${to}`);
  return result;
}

export async function codeAt(rpc: RpcLike, address: string, tag: BlockTag = 'latest'): Promise<string> {
  const code = await rpc.rawRequest<string>('quai_getCode', [address, toBlockTag(tag)]);
  if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) throw new Error(`Unexpected quai_getCode result for ${address}`);
  return code;
}

export async function storageAt(rpc: RpcLike, address: string, slot: string, tag: BlockTag = 'latest'): Promise<string> {
  const word = await rpc.rawRequest<string>('quai_getStorageAt', [address, slot, toBlockTag(tag)]);
  if (typeof word !== 'string' || !/^0x[0-9a-fA-F]*$/.test(word)) throw new Error(`Unexpected quai_getStorageAt result for ${address}`);
  return word;
}

export async function balanceAt(rpc: RpcLike, address: string, tag: BlockTag = 'latest'): Promise<bigint> {
  const hex = await rpc.rawRequest<string>('quai_getBalance', [address, toBlockTag(tag)]);
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error(`Unexpected quai_getBalance result for ${address}`);
  return hex === '0x' ? 0n : BigInt(hex);
}

/**
 * Reads through the user's wallet extension, which talks to its own node. Used as an
 * independent second source: the app's RPC and the wallet's node must agree.
 */
export function injectedProviderSource(provider: InjectedProviderLike): RpcLike {
  return {
    rawRequest: <T = any>(method: string, params: unknown[] = []) => provider.request({ method, params }) as Promise<T>,
  };
}

/** Maps over items with at most `limit` promises in flight (public RPCs rate-limit bursts). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
