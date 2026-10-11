/**
 * DarkCircle: Outbound Private Payment Proxy - Receipt Cache & Single-Flight Coalescer
 * File: src/proxy/receiptCache.ts
 *
 * Provides thread-safe in-memory receipt caching with TTL enforcement, dual indexing,
 * and single-flight Promise coalescing preventing duplicate settlements under concurrent load.
 */

export interface CachedReceipt {
  cacheKey: string;           // Primary lookup key (e.g. endpoint URI or invoiceId)
  invoiceId: string;          // Unique invoice identifier
  txHash: string;             // On-chain settlement transaction hash
  relayerAddress: string;     // Relayer broadcaster address
  amount: bigint;             // Settled amount in base units
  token: string;              // ERC-20 token address
  expiresAt: number;          // Expiration Unix timestamp in seconds
  settledAt?: number;         // Settlement Unix timestamp in seconds
  blockNumber?: number;       // Block number of confirmation
  recipient?: string;         // Payee destination address
  targetResource?: string;    // Protected endpoint URI
  status?: "pending" | "confirmed" | "failed";
  relayerFee?: bigint;        // Relayer fee paid
}

export interface ReceiptCacheOptions {
  defaultTtlSeconds?: number; // Default TTL if expiresAt omitted (default: 900s / 15m)
  maxEntries?: number;        // Maximum cache capacity before LRU eviction (default: 1000)
}

/**
 * Single-flight coalescing engine preventing duplicate settlements for identical flight keys.
 */
export class SingleFlightCoalescer<T = CachedReceipt> {
  public inFlightLocks: Map<string, Promise<T>> = new Map();

  /**
   * Executes settlementFn only once for concurrent requests sharing flightKey.
   * Concurrent callers await the shared Promise.
   * Lock is guaranteed to be deleted in `.finally()` regardless of success or failure.
   */
  public async execute(
    flightKey: string,
    settlementFn: () => Promise<T>
  ): Promise<{ result: T; shared: boolean }> {
    const key = flightKey.trim();
    const existing = this.inFlightLocks.get(key);
    if (existing) {
      const result = await existing;
      return { result, shared: true };
    }

    const promise = settlementFn().finally(() => {
      this.inFlightLocks.delete(key);
    });

    this.inFlightLocks.set(key, promise);

    try {
      const result = await promise;
      return { result, shared: false };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Convenience coalesce method returning the shared or newly-created Promise.
   */
  public coalesce(
    flightKey: string,
    settlementFn: () => Promise<T>
  ): Promise<T> {
    const key = flightKey.trim();
    const existing = this.inFlightLocks.get(key);
    if (existing) {
      return existing;
    }

    const promise = settlementFn().finally(() => {
      this.inFlightLocks.delete(key);
    });

    this.inFlightLocks.set(key, promise);
    return promise;
  }

  public get size(): number {
    return this.inFlightLocks.size;
  }

  public clear(): void {
    this.inFlightLocks.clear();
  }
}

/**
 * In-memory Receipt Cache extending standard Map<string, CachedReceipt>
 * for drop-in compatibility across client proxies and test suites.
 */
export class ReceiptCache extends Map<string, CachedReceipt> {
  private readonly invoiceIndex: Map<string, string> = new Map(); // invoiceId -> cacheKey
  private readonly txHashIndex: Map<string, string> = new Map();  // txHash -> cacheKey
  public readonly coalescer: SingleFlightCoalescer<CachedReceipt> = new SingleFlightCoalescer();

  public readonly defaultTtlSeconds: number;
  public readonly maxEntries: number;

  constructor(options: ReceiptCacheOptions = {}) {
    super();
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 900;
    this.maxEntries = options.maxEntries ?? 1000;
  }

  /**
   * Directly exposes inFlightLocks for compatibility with clientProxy.inFlightLocks assertions.
   */
  public get inFlightLocks(): Map<string, Promise<CachedReceipt>> {
    return this.coalescer.inFlightLocks;
  }

  public normalizeKey(key: string): string {
    return key.trim();
  }

  public override get(key: string): CachedReceipt | undefined {
    const normKey = this.normalizeKey(key);
    const receipt = super.get(normKey);
    if (!receipt) return undefined;

    const nowSec = Math.floor(Date.now() / 1000);
    if (receipt.expiresAt > 0 && receipt.expiresAt <= nowSec) {
      this.delete(normKey);
      return undefined;
    }

    return receipt;
  }

  public override set(key: string, value: CachedReceipt): this {
    const normKey = this.normalizeKey(key);

    // LRU eviction if capacity reached
    if (super.size >= this.maxEntries && !super.has(normKey)) {
      const oldestKey = super.keys().next().value;
      if (oldestKey !== undefined) {
        this.delete(oldestKey);
      }
    }

    // Default expiration if omitted
    if (!value.expiresAt || value.expiresAt <= 0) {
      value.expiresAt = Math.floor(Date.now() / 1000) + this.defaultTtlSeconds;
    }

    super.set(normKey, value);

    if (value.invoiceId) {
      this.invoiceIndex.set(value.invoiceId, normKey);
    }
    if (value.txHash) {
      this.txHashIndex.set(value.txHash.toLowerCase(), normKey);
    }

    return this;
  }

  public override has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public override delete(key: string): boolean {
    const normKey = this.normalizeKey(key);
    const existing = super.get(normKey);
    if (!existing) return false;

    if (existing.invoiceId) {
      this.invoiceIndex.delete(existing.invoiceId);
    }
    if (existing.txHash) {
      this.txHashIndex.delete(existing.txHash.toLowerCase());
    }

    return super.delete(normKey);
  }

  public override clear(): void {
    super.clear();
    this.invoiceIndex.clear();
    this.txHashIndex.clear();
    this.coalescer.clear();
  }

  // ---------------------------------------------------------------------------
  // Domain-Specific Operations
  // ---------------------------------------------------------------------------

  public getValid(key: string): CachedReceipt | undefined {
    return this.get(key);
  }

  public isExpired(receipt: CachedReceipt): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    return receipt.expiresAt > 0 && receipt.expiresAt <= nowSec;
  }

  public evict(key: string): boolean {
    return this.delete(key);
  }

  public evictByInvoice(invoiceId: string): boolean {
    const cacheKey = this.invoiceIndex.get(invoiceId);
    if (!cacheKey) return false;
    return this.delete(cacheKey);
  }

  public evictByResource(resourceUrl: string): boolean {
    return this.delete(resourceUrl);
  }

  public getByInvoiceId(invoiceId: string): CachedReceipt | undefined {
    const cacheKey = this.invoiceIndex.get(invoiceId);
    if (!cacheKey) return undefined;
    return this.get(cacheKey);
  }

  public getByTxHash(txHash: string): CachedReceipt | undefined {
    const cacheKey = this.txHashIndex.get(txHash.toLowerCase());
    if (!cacheKey) return undefined;
    return this.get(cacheKey);
  }

  public pruneExpired(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    let pruned = 0;
    for (const [key, receipt] of super.entries()) {
      if (receipt.expiresAt > 0 && receipt.expiresAt <= nowSec) {
        this.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  public async coalesce(
    key: string,
    settlementFn: () => Promise<CachedReceipt>
  ): Promise<CachedReceipt> {
    return this.coalescer.coalesce(key, settlementFn);
  }
}
