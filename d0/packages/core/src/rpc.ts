import type { NetworkConfig } from './config.js';

export interface QuaiReceipt {
  blockHash: string;
  blockNumber: string;
  contractAddress: string | null;
  from: string;
  gasUsed: string;
  logs: { address: string; topics: string[]; data: string }[];
  status: string; // '0x1' success, '0x0' revert
  to: string | null;
  transactionHash: string;
}

/** Only the callable shape of fetch: some @types/node versions add static members a wrapper cannot satisfy. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RpcOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
    readonly status?: number
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * JSON-RPC client for one Cyprus-1 zone endpoint.
 *
 * Methods are written once against the `quai_` namespace; a node that speaks `eth_` (the local
 * Hardhat chain) gets the same calls with the prefix swapped. Expanded blocks are never
 * requested: Quai transactions carry no r/s/v, which breaks ethers' block parsing.
 */
export class RpcClient {
  readonly url: string;
  private readonly namespace: 'quai' | 'eth';
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private nextId = 1;

  constructor(network: Pick<NetworkConfig, 'rpcUrl' | 'rpcNamespace'>, options: RpcOptions = {}) {
    this.url = network.rpcUrl;
    this.namespace = network.rpcNamespace;
    // Wrapped, never stored bare: `this.fetchFn = globalThis.fetch` throws "Illegal invocation" in browsers.
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  private method(name: string): string {
    return this.namespace === 'quai' ? name : name.replace(/^quai_/, 'eth_');
  }

  async request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: this.method(method), params });
    let delay = 250;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw new RpcError(`Could not reach ${this.url}: ${(err as Error)?.message ?? String(err)}`);
      }
      clearTimeout(timer);

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw new RpcError(`RPC ${method}: HTTP ${response.status}`, undefined, undefined, response.status);
      }
      const json = (await response.json()) as { result?: T; error?: { message?: string; code?: number; data?: unknown } };
      if (json.error) {
        throw new RpcError(json.error.message || `RPC ${method} failed`, json.error.code, json.error.data);
      }
      return json.result as T;
    }
  }

  async call(tx: { to: string; data: string; from?: string }, blockTag = 'latest'): Promise<string> {
    return this.request<string>('quai_call', [tx, blockTag]);
  }

  async getBlockNumber(): Promise<bigint> {
    return BigInt(await this.request<string>('quai_blockNumber'));
  }

  async getChainId(): Promise<number> {
    return Number(BigInt(await this.request<string>('quai_chainId')));
  }

  async getBalance(address: string): Promise<bigint> {
    return BigInt(await this.request<string>('quai_getBalance', [address, 'latest']));
  }

  async getCode(address: string): Promise<string> {
    return this.request<string>('quai_getCode', [address, 'latest']);
  }

  async getGasPrice(): Promise<bigint> {
    return BigInt(await this.request<string>('quai_gasPrice'));
  }

  async getTransactionReceipt(hash: string): Promise<QuaiReceipt | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('A transaction hash is 0x followed by 64 hex characters.');
    return this.request<QuaiReceipt | null>('quai_getTransactionReceipt', [hash]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
