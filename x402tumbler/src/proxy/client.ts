/**
 * DarkCircle: Outbound Private Payment Proxy - HTTP Client & Wrapped Fetch
 * File: src/proxy/client.ts
 *
 * Provides transparent Web Fetch API interception and OutboundPaymentProxy implementation.
 */

import type { ShieldedUTXO } from "../types/sim.ts";
import type { RelayerNetwork } from "../sim/relayerNetwork.ts";
import {
  OutboundPaymentInterceptor,
  type SpendingPolicy,
  type CorporateKeys,
  type InterceptorOptions
} from "./interceptor.ts";
import { ChallengeParser } from "./parser.ts";
import type { CachedReceipt } from "./receiptCache.ts";

export interface PaymentClientConfig {
  spendingPolicy: SpendingPolicy;
  relayer: RelayerNetwork;
  corporateKeys: CorporateKeys;
  treasuryUTXOs?: ShieldedUTXO[];
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  options?: InterceptorOptions;
}

/**
 * PaymentClient provides transparent HTTP fetch execution with automated
 * 402 Payment Required interception, ZK unshield settlement, and authenticated retry.
 */
export class PaymentClient {
  public interceptor: OutboundPaymentInterceptor;
  public fetchFn: typeof globalThis.fetch;
  public timeoutMs: number;
  public maxRetries: number;

  constructor(config: PaymentClientConfig) {
    this.interceptor = new OutboundPaymentInterceptor(
      config.spendingPolicy,
      config.relayer,
      config.corporateKeys,
      config.treasuryUTXOs || [],
      config.options || {}
    );

    this.fetchFn =
      config.fetchFn ||
      (typeof globalThis.fetch !== "undefined"
        ? globalThis.fetch.bind(globalThis)
        : (undefined as unknown as typeof globalThis.fetch));

    this.timeoutMs = config.timeoutMs ?? 30000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  /**
   * Derives a stable cache key preserving path and query string parameters.
   */
  public extractCacheKey(input: string | URL | Request): string {
    if (typeof input === "string") {
      try {
        const u = new URL(input, "http://localhost");
        return u.pathname + u.search;
      } catch {
        return input;
      }
    }
    if (input instanceof URL) {
      return input.pathname + input.search;
    }
    try {
      const u = new URL(input.url, "http://localhost");
      return u.pathname + u.search;
    } catch {
      return input.url;
    }
  }

  /**
   * Transparent fetch interceptor.
   */
  public async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!this.fetchFn) {
      throw new Error("PaymentClient: No fetch implementation available");
    }

    const cacheKey = this.extractCacheKey(input);

    // 1. Check receipt cache for active valid receipt
    const cached = this.interceptor.receiptCache.get(cacheKey);
    if (cached) {
      const authHeaders = this.interceptor.createAuthorizationHeaders(cached);
      const mergedHeaders = new Headers(init?.headers);
      for (const [k, v] of Object.entries(authHeaders)) {
        mergedHeaders.set(k, v);
      }

      const cachedRes = await this.fetchFn(input, { ...init, headers: mergedHeaders });
      if (cachedRes.status === 200) {
        return cachedRes;
      }

      // If upstream rejects cached receipt, evict stale entry
      this.interceptor.receiptCache.delete(cacheKey);

      if (cachedRes.status === 402) {
        return this.handlePaymentChallenge(input, init, cacheKey, cachedRes);
      }
    }

    // 2. Initial request
    const initialRes = await this.fetchFn(input, init);
    if (initialRes.status !== 402) {
      return initialRes;
    }

    // 3. Handle 402 Payment Required challenge
    return this.handlePaymentChallenge(input, init, cacheKey, initialRes);
  }

  private async handlePaymentChallenge(
    input: string | URL | Request,
    init: RequestInit | undefined,
    cacheKey: string,
    challengeResponse: Response
  ): Promise<Response> {
    const headersMap: Record<string, string> = {};
    if (challengeResponse.headers && typeof challengeResponse.headers.forEach === "function") {
      challengeResponse.headers.forEach((v, k) => {
        headersMap[k.toLowerCase()] = v;
      });
    }

    let bodyData: any;
    try {
      bodyData = await challengeResponse.clone().json();
    } catch {
      try {
        bodyData = await challengeResponse.clone().text();
      } catch {
        bodyData = undefined;
      }
    }

    const challenge = ChallengeParser.parse(headersMap, bodyData);
    challenge.targetResource = cacheKey;

    // Coalesce single-flight settlement for concurrent requests to same key
    const receipt = await this.interceptor.receiptCache.coalesce(cacheKey, () =>
      this.interceptor.settleChallenge(challenge)
    );

    // Retry request with payment credentials
    const retryAuth = this.interceptor.createAuthorizationHeaders(receipt);
    const retryHeaders = new Headers(init?.headers);
    for (const [k, v] of Object.entries(retryAuth)) {
      retryHeaders.set(k, v);
    }

    return this.fetchFn(input, { ...init, headers: retryHeaders });
  }
}

/**
 * Functional factory conforming to the standard Web Fetch signature.
 */
export function createPaymentFetch(config: PaymentClientConfig): typeof globalThis.fetch {
  const client = new PaymentClient(config);
  return client.fetch.bind(client);
}

/**
 * OutboundPaymentProxy subclass providing complete backwards-compatibility with
 * test harness expectations and direct proxy usage.
 */
export class OutboundPaymentProxy extends OutboundPaymentInterceptor {
  constructor(
    spendingPolicy: SpendingPolicy,
    relayer: RelayerNetwork,
    corporateKeys: CorporateKeys,
    initialUTXOs: ShieldedUTXO[] = [],
    options: InterceptorOptions = {}
  ) {
    super(spendingPolicy, relayer, corporateKeys, initialUTXOs, options);
  }
}
