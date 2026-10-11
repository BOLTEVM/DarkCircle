/**
 * DarkCircle: Outbound Private Payment Proxy - Payment Interceptor
 * File: src/proxy/interceptor.ts
 *
 * Coordinates challenge parsing, receipt caching with single-flight locking,
 * policy-governed ZK relayer settlement, and request retry with payment credentials.
 */

import type { ShieldedUTXO } from "../types/sim.ts";
import type { RelayerNetwork } from "../sim/relayerNetwork.ts";
import type { PPOIEngine } from "../ppoi/ppoiEngine.ts";
import type { SanctionsRegistry } from "../ppoi/sanctionsList.ts";
import { ChallengeParser, type ParsedPaymentChallenge } from "./parser.ts";
import { ReceiptCache, type CachedReceipt } from "./receiptCache.ts";
import {
  SettlementCoordinator,
  type SpendingPolicy,
  type SettlementCoordinatorConfig
} from "./settlement.ts";

export type { SpendingPolicy };

export interface CorporateKeys {
  ssk: bigint;
  spk: bigint;
  vsk: bigint;
  vpk: bigint;
  npk: bigint;
  corporate0zkAddress: string;
}

export interface InterceptorOptions {
  ppoiEngine?: PPOIEngine;
  sanctionsRegistry?: SanctionsRegistry;
  preferDirectUnshield?: boolean;
}

export class OutboundPaymentInterceptor {
  public spendingPolicy: SpendingPolicy;
  public relayer: RelayerNetwork;
  public corporateKeys: CorporateKeys;
  public treasuryUTXOs: ShieldedUTXO[];
  public receiptCache: ReceiptCache;
  public settlementCoordinator: SettlementCoordinator;

  /**
   * Exposes inFlightLocks directly for compatibility with test assertions.
   */
  public get inFlightLocks(): Map<string, Promise<CachedReceipt>> {
    return this.receiptCache.inFlightLocks;
  }

  constructor(
    spendingPolicy: SpendingPolicy,
    relayer: RelayerNetwork,
    corporateKeys: CorporateKeys,
    initialUTXOs: ShieldedUTXO[] = [],
    options: InterceptorOptions = {}
  ) {
    this.spendingPolicy = spendingPolicy;
    this.relayer = relayer;
    this.corporateKeys = corporateKeys;
    this.treasuryUTXOs = [...initialUTXOs];
    this.receiptCache = new ReceiptCache();

    const coordinatorConfig: SettlementCoordinatorConfig = {
      spendingPolicy: this.spendingPolicy,
      relayer: this.relayer,
      corporateKeys: this.corporateKeys,
      treasuryUTXOs: this.treasuryUTXOs,
      ppoiEngine: options.ppoiEngine,
      sanctionsRegistry: options.sanctionsRegistry,
      preferDirectUnshield: options.preferDirectUnshield ?? false
    };

    this.settlementCoordinator = new SettlementCoordinator(coordinatorConfig);
  }

  /**
   * Adds a shielded treasury UTXO note.
   */
  public addTreasuryUTXO(utxo: ShieldedUTXO): void {
    this.treasuryUTXOs.push(utxo);
    if (!this.settlementCoordinator.treasuryUTXOs.includes(utxo)) {
      this.settlementCoordinator.addTreasuryUTXO(utxo);
    }
  }

  /**
   * Enforces spending limits and policy against the challenge.
   */
  public validatePolicy(challenge: {
    amount: bigint;
    tokenAddress: string;
    chainId: number;
    network?: string;
    recipientAddress?: string;
  }): void {
    // Keep coordinator policy in sync
    this.settlementCoordinator.spendingPolicy = this.spendingPolicy;
    this.settlementCoordinator.validatePolicy(challenge);
  }

  /**
   * Settles the challenge via SettlementCoordinator, updates the receipt cache, and returns the receipt.
   */
  public async settleChallenge(challenge: ParsedPaymentChallenge): Promise<CachedReceipt> {
    this.settlementCoordinator.spendingPolicy = this.spendingPolicy;
    this.settlementCoordinator.treasuryUTXOs = this.treasuryUTXOs;

    const { receipt } = await this.settlementCoordinator.settleChallenge(challenge);

    // Synchronize local treasury UTXOs with coordinator's updated UTXO set
    this.treasuryUTXOs = this.settlementCoordinator.treasuryUTXOs;

    const cachedReceipt: CachedReceipt = {
      cacheKey: challenge.targetResource || challenge.invoiceId,
      invoiceId: receipt.invoiceId,
      txHash: receipt.txHash,
      relayerAddress: receipt.relayerAddress,
      amount: receipt.amount,
      token: receipt.token,
      expiresAt: receipt.expiresAt,
      settledAt: receipt.settledAt,
      blockNumber: receipt.blockNumber,
      recipient: receipt.recipient,
      targetResource: challenge.targetResource
    };

    this.receiptCache.set(cachedReceipt.cacheKey, cachedReceipt);
    return cachedReceipt;
  }

  /**
   * Formats authorization headers containing the payment proof.
   */
  public createAuthorizationHeaders(receipt: CachedReceipt): Record<string, string> {
    return {
      Authorization: `x402 invoice="${receipt.invoiceId}", proof="${receipt.txHash}", relayer="${receipt.relayerAddress}"`,
      "X-Payment-Invoice-Id": receipt.invoiceId,
      "X-Payment-Proof": receipt.txHash,
      "X-Payment-Relayer": receipt.relayerAddress
    };
  }

  /**
   * Intercepts HTTP 402 responses, settles challenges transparently, and retries the request.
   */
  public async fetchWithPayment(
    targetUrl: string,
    executeRequest: (authHeaders?: Record<string, string>) => Promise<{
      status: number;
      headers: Record<string, string>;
      body: any;
    }>
  ): Promise<{ status: number; headers: Record<string, string>; body: any; fromCache?: boolean }> {
    // 1. Check receipt cache for active unexpired payment receipt
    const cached = this.receiptCache.get(targetUrl);
    if (cached) {
      const authHeaders = this.createAuthorizationHeaders(cached);
      const res = await executeRequest(authHeaders);
      if (res.status === 200) {
        return { ...res, fromCache: true };
      }

      // Stale or revoked receipt (T2.3.4): evict invalid cache entry
      this.receiptCache.delete(targetUrl);

      // If upstream returned 402 with new challenge, settle immediately
      if (res.status === 402) {
        const challenge = ChallengeParser.parse(res.headers, res.body);
        challenge.targetResource = targetUrl;

        const receipt = await this.receiptCache.coalesce(targetUrl, () =>
          this.settleChallenge(challenge)
        );

        const retryHeaders = this.createAuthorizationHeaders(receipt);
        return executeRequest(retryHeaders);
      }
    }

    // 2. Dispatch initial request
    const initialRes = await executeRequest();
    if (initialRes.status !== 402) {
      return initialRes;
    }

    // 3. Extract and parse HTTP 402 challenge
    const challenge = ChallengeParser.parse(initialRes.headers, initialRes.body);
    challenge.targetResource = targetUrl;

    // 4. Coalesce single-flight settlement for concurrent identical requests
    const receipt = await this.receiptCache.coalesce(targetUrl, () =>
      this.settleChallenge(challenge)
    );

    // 5. Re-execute request presenting verified payment credentials
    const retryHeaders = this.createAuthorizationHeaders(receipt);
    return executeRequest(retryHeaders);
  }
}
