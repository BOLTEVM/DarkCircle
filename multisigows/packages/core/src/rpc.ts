import { validateCyprus1Address } from './address.js';
import { getNetworkConfig, isSupportedNetwork, NetworkName, TESTNET_CONFIG } from './config.js';

export interface QuaiReceipt {
  blockHash: string;
  blockNumber: string;
  contractAddress: string | null;
  cumulativeGasUsed: string;
  effectiveGasPrice?: string;
  from: string;
  gasUsed: string;
  logs: any[];
  logsBloom?: string;
  status: string; // '0x1' or '0x0'
  to: string | null;
  transactionHash: string;
  transactionIndex: string;
  type: string;
  originatingTxHash?: string;
  etxIndex?: string;
  etxType?: string;
}

export interface QuaiRpcCallOptions {
  to: string;
  data?: string;
  from?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

/**
 * Deliberately narrower than `typeof fetch`: some @types/node versions declare the
 * global fetch signature with extra static members (e.g. `preconnect`) that a plain
 * fetch-shaped function/wrapper can never satisfy structurally. Callers only need the
 * callable shape.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface QuaiRpcOptions extends RetryOptions {
  timeoutMs?: number;
  fetchFn?: FetchLike;
  headers?: Record<string, string>;
}

export class QuaiRpcError extends Error {
  code?: number;
  data?: any;
  status?: number;

  constructor(message: string, code?: number, data?: any, status?: number) {
    super(message);
    this.name = 'QuaiRpcError';
    this.code = code;
    this.data = data;
    this.status = status;
  }
}

/**
 * Resolves the Cyprus-1 zone RPC endpoint URL.
 */
export function resolveCyprus1Endpoint(target: string | number | NetworkName = 'testnet'): string {
  if (typeof target === 'number') {
    return getNetworkConfig(target).rpcUrl;
  }
  const trimmed = (target || '').trim();
  if (isSupportedNetwork(trimmed)) {
    return getNetworkConfig(trimmed).rpcUrl;
  }
  if (trimmed === '9' || trimmed === '0x9') {
    return getNetworkConfig('mainnet').rpcUrl;
  }
  if (trimmed === '15000' || trimmed === '0x3a98') {
    return getNetworkConfig('testnet').rpcUrl;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.includes('quai.network')) {
      if (!url.pathname.endsWith('/cyprus1')) {
        url.pathname = '/cyprus1';
      }
      return url.toString();
    }
    return trimmed;
  } catch {
    return TESTNET_CONFIG.rpcUrl;
  }
}

/**
 * Quai Network RPC Transport Client for Cyprus-1 execution shard.
 * Enforces pre-transmission address validation, exponential backoff, and JSON-RPC methods.
 */
export class QuaiRpcClient {
  readonly rpcUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffFactor: number;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private requestId = 1;

  constructor(endpointOrNetwork: string | number = 'testnet', options: QuaiRpcOptions = {}) {
    this.rpcUrl = resolveCyprus1Endpoint(endpointOrNetwork);
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 200;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.backoffFactor = options.backoffFactor ?? 2.0;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    };
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableError(error: any, status?: number): boolean {
    if (status) {
      if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true;
      }
    }
    const message = (error?.message || '').toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('econnreset') ||
      message.includes('fetch failed') ||
      message.includes('temporarily unavailable') ||
      message.includes('server busy')
    );
  }

  /**
   * Executes a raw JSON-RPC call with exponential backoff and jitter.
   */
  async rawRequest<T = any>(method: string, params: any[] = []): Promise<T> {
    const id = this.requestId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    let attempt = 0;
    let currentDelay = this.initialDelayMs;

    while (attempt <= this.maxRetries) {
      try {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

        const response = await this.fetchFn(this.rpcUrl, {
          method: 'POST',
          headers: this.headers,
          body: payload,
          signal: controller?.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (!response.ok) {
          if (attempt < this.maxRetries && this.isRetryableError(null, response.status)) {
            attempt++;
            const jitter = Math.random() * 50;
            await this.delay(Math.min(this.maxDelayMs, currentDelay + jitter));
            currentDelay *= this.backoffFactor;
            continue;
          }
          const text = await response.text().catch(() => '');
          throw new QuaiRpcError(
            `Quai RPC HTTP Error ${response.status} (${response.statusText}): ${text}`,
            response.status,
            undefined,
            response.status
          );
        }

        const data: any = await response.json();

        if (data.error) {
          if (attempt < this.maxRetries && this.isRetryableError(data.error)) {
            attempt++;
            const jitter = Math.random() * 50;
            await this.delay(Math.min(this.maxDelayMs, currentDelay + jitter));
            currentDelay *= this.backoffFactor;
            continue;
          }
          throw new QuaiRpcError(data.error.message || 'Unknown RPC error', data.error.code, data.error.data);
        }

        return data.result as T;
      } catch (err: any) {
        if (err instanceof QuaiRpcError && err.code !== undefined && !this.isRetryableError(err, err.status)) {
          throw err;
        }
        if (attempt < this.maxRetries && this.isRetryableError(err)) {
          attempt++;
          const jitter = Math.random() * 50;
          await this.delay(Math.min(this.maxDelayMs, currentDelay + jitter));
          currentDelay *= this.backoffFactor;
          continue;
        }
        throw err instanceof QuaiRpcError ? err : new QuaiRpcError(err?.message || 'Network request failed');
      }
    }

    throw new QuaiRpcError(`Quai RPC call to ${method} failed after ${this.maxRetries} retries.`);
  }

  /**
   * Queries native QUAI balance of an address (quai_getBalance).
   * Enforces pre-validation rejecting non-0x00 addresses.
   */
  async quai_getBalance(address: string, blockTag: string = 'latest'): Promise<bigint> {
    const val = validateCyprus1Address(address);
    if (!val.isValid || !val.checksumAddress) {
      throw new Error(`Quai RPC pre-validation failed for getBalance: ${val.error}`);
    }
    const hexResult = await this.rawRequest<string>('quai_getBalance', [val.checksumAddress, blockTag]);
    if (!hexResult || hexResult === '0x') return 0n;
    return BigInt(hexResult);
  }

  /**
   * Alias for quai_getBalance.
   */
  async getBalance(address: string, blockTag: string = 'latest'): Promise<bigint> {
    return this.quai_getBalance(address, blockTag);
  }

  /**
   * Executes a read-only message call (quai_call).
   * Enforces pre-validation rejecting non-0x00 addresses.
   */
  async quai_call(
    callObjOrTo: string | QuaiRpcCallOptions,
    dataOrBlockTag?: string,
    blockTag: string = 'latest'
  ): Promise<string> {
    let to: string;
    let data: string = '0x';
    let tag: string = blockTag;

    if (typeof callObjOrTo === 'string') {
      to = callObjOrTo;
      data = dataOrBlockTag || '0x';
    } else {
      to = callObjOrTo.to;
      data = callObjOrTo.data || '0x';
      if (typeof dataOrBlockTag === 'string') {
        tag = dataOrBlockTag;
      }
    }

    const val = validateCyprus1Address(to);
    if (!val.isValid || !val.checksumAddress) {
      throw new Error(`Quai RPC pre-validation failed for call destination: ${val.error}`);
    }

    const txObj: Record<string, string> = {
      to: val.checksumAddress,
      data,
    };
    if (typeof callObjOrTo === 'object' && callObjOrTo.from) {
      const fromVal = validateCyprus1Address(callObjOrTo.from);
      if (fromVal.isValid && fromVal.checksumAddress) {
        txObj.from = fromVal.checksumAddress;
      }
    }

    return this.rawRequest<string>('quai_call', [txObj, tag]);
  }

  /**
   * Alias for quai_call.
   */
  async call(
    callObjOrTo: string | QuaiRpcCallOptions,
    dataOrBlockTag?: string,
    blockTag: string = 'latest'
  ): Promise<string> {
    return this.quai_call(callObjOrTo, dataOrBlockTag, blockTag);
  }

  /**
   * Submits a raw signed transaction (quai_sendRawTransaction).
   */
  async quai_sendRawTransaction(signedTxHex: string): Promise<string> {
    if (!signedTxHex || typeof signedTxHex !== 'string' || !signedTxHex.startsWith('0x')) {
      throw new Error('Raw transaction payload must be a non-empty hex string starting with "0x".');
    }
    return this.rawRequest<string>('quai_sendRawTransaction', [signedTxHex]);
  }

  /**
   * Alias for quai_sendRawTransaction.
   */
  async sendRawTransaction(signedTxHex: string): Promise<string> {
    return this.quai_sendRawTransaction(signedTxHex);
  }

  /**
   * Returns receipt of a transaction (quai_getTransactionReceipt).
   */
  async quai_getTransactionReceipt(txHash: string): Promise<QuaiReceipt | null> {
    if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error('Transaction hash must be a 66-character hex string starting with "0x".');
    }
    return this.rawRequest<QuaiReceipt | null>('quai_getTransactionReceipt', [txHash]);
  }

  /**
   * Alias for quai_getTransactionReceipt.
   */
  async getTransactionReceipt(txHash: string): Promise<QuaiReceipt | null> {
    return this.quai_getTransactionReceipt(txHash);
  }

  /**
   * Returns account nonce / transaction count (quai_getTransactionCount).
   * Enforces pre-validation rejecting non-0x00 addresses.
   */
  async quai_getTransactionCount(address: string, blockTag: string = 'latest'): Promise<bigint> {
    const val = validateCyprus1Address(address);
    if (!val.isValid || !val.checksumAddress) {
      throw new Error(`Quai RPC pre-validation failed for getTransactionCount: ${val.error}`);
    }
    const hexCount = await this.rawRequest<string>('quai_getTransactionCount', [val.checksumAddress, blockTag]);
    if (!hexCount || hexCount === '0x') return 0n;
    return BigInt(hexCount);
  }

  /**
   * Alias for quai_getTransactionCount.
   */
  async getTransactionCount(address: string, blockTag: string = 'latest'): Promise<bigint> {
    return this.quai_getTransactionCount(address, blockTag);
  }

  /**
   * Estimates gas for a call (quai_estimateGas).
   */
  async quai_estimateGas(
    callObj: { to?: string; from?: string; data?: string; value?: string },
    blockTag: string = 'latest'
  ): Promise<bigint> {
    const tx = { ...callObj };
    if (tx.to) {
      const val = validateCyprus1Address(tx.to);
      if (val.isValid && val.checksumAddress) {
        tx.to = val.checksumAddress;
      }
    }
    if (tx.from) {
      const val = validateCyprus1Address(tx.from);
      if (val.isValid && val.checksumAddress) {
        tx.from = val.checksumAddress;
      }
    }
    const hexGas = await this.rawRequest<string>('quai_estimateGas', [tx, blockTag]);
    return BigInt(hexGas);
  }

  /**
   * Alias for quai_estimateGas.
   */
  async estimateGas(
    callObj: { to?: string; from?: string; data?: string; value?: string },
    blockTag: string = 'latest'
  ): Promise<bigint> {
    return this.quai_estimateGas(callObj, blockTag);
  }

  /**
   * Requests an access list for a transaction (quai_createAccessList).
   *
   * On Quai Cyprus-1, a transaction carrying calldata (any contract call, not just
   * plain native transfers) that is signed and broadcast WITHOUT an access list can
   * revert and burn its ENTIRE gas limit rather than just the gas used. Any code path
   * outside the `quais` SDK (whose signer populates this automatically) that constructs
   * and signs a Quai transaction with calldata MUST fetch and attach this access list
   * first, and must refuse to broadcast if this call itself reports a VM error.
   */
  async quai_createAccessList(
    callObj: { to?: string; from?: string; data?: string; value?: string; gas?: string; gasPrice?: string },
    blockTag: string = 'latest'
  ): Promise<{ accessList: Array<{ address: string; storageKeys: string[] }>; error?: string }> {
    const tx = { ...callObj };
    if (tx.to) {
      const val = validateCyprus1Address(tx.to);
      if (val.isValid && val.checksumAddress) tx.to = val.checksumAddress;
    }
    if (tx.from) {
      const val = validateCyprus1Address(tx.from);
      if (val.isValid && val.checksumAddress) tx.from = val.checksumAddress;
    }
    return this.rawRequest<{ accessList: Array<{ address: string; storageKeys: string[] }>; error?: string }>(
      'quai_createAccessList',
      [tx, blockTag]
    );
  }

  /**
   * Returns current gas price in wei (quai_gasPrice).
   */
  async quai_gasPrice(): Promise<bigint> {
    const hexPrice = await this.rawRequest<string>('quai_gasPrice', []);
    return BigInt(hexPrice);
  }

  /**
   * Alias for quai_gasPrice.
   */
  async getGasPrice(): Promise<bigint> {
    return this.quai_gasPrice();
  }

  /**
   * Returns current block number (quai_blockNumber).
   */
  async getBlockNumber(): Promise<bigint> {
    const hexNumber = await this.rawRequest<string>('quai_blockNumber', []);
    if (!hexNumber || hexNumber === '0x') return 0n;
    return BigInt(hexNumber);
  }

  /**
   * Returns chain ID (quai_chainId).
   */
  async getChainId(): Promise<number> {
    const hexChainId = await this.rawRequest<string>('quai_chainId', []);
    return parseInt(hexChainId, 16);
  }
}

export function createQuaiRpcClient(
  endpointOrNetwork: string | number = 'testnet',
  options?: QuaiRpcOptions
): QuaiRpcClient {
  return new QuaiRpcClient(endpointOrNetwork, options);
}
