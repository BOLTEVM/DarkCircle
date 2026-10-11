/**
 * DarkCircle Protocol: Inbound Merchant Privacy Gateway
 * Inbound Merchant Gateway & HTTP Middleware
 *
 * Provides the central gateway coordinator implementing IMerchantGateway.
 * Coordinates 402 Payment Required challenge generation, stealth payee address
 * derivation, payment proof verification, and automated sweep-and-shield pipeline.
 */

import crypto from "node:crypto";
import type {
  InvoiceRecord,
  PaymentChallengeResult,
  PaymentVerificationResult,
  SweepResult,
  InboundGatewayOptions,
  GatewayMiddlewareOptions
} from "./types.ts";
import type { IMerchantGateway } from "../server/resourceServer.ts";
import { InvoiceRegistry } from "./invoiceRegistry.ts";
import { buildQuaiChallenge } from "./challenge.ts";
import type { AsyncReceiptSource } from "./paymentEvidence.ts";
import { DEFAULT_QUAI_NETWORK, type QuaiNetwork } from "../quai/networks.ts";
import { WQUAI, WQUAI_DECIMALS } from "../quai/tokens.ts";
import { SweeperWorker } from "./sweeper.ts";

/** Default confirmations when payments are verified against a live zone (receiptSource). */
export const LIVE_MIN_CONFIRMATIONS = 2;

export class InboundMerchantGateway implements IMerchantGateway {
  public network: QuaiNetwork;
  public trustMode: "verified" | "trusted-harness" = "verified";
  public receiptSource?: AsyncReceiptSource;
  public masterMerchantKey: string;
  public corporate0zkAddress: string;
  public corporateNpk: bigint;
  public blockchain: any;
  public pool: any;
  public invoiceRegistry: InvoiceRegistry;
  public usedReceiptRegistry: Set<string>;
  public sweeper: SweeperWorker;
  public autoSweep: boolean;
  public defaultTtlSeconds: number;
  public defaultTokenSymbol: string;
  public defaultTokenDecimals: number;

  constructor(
    masterMerchantKeyOrOptions: string | InboundGatewayOptions,
    corporate0zkAddress?: string,
    corporateNpk?: bigint,
    blockchain?: any,
    pool?: any,
    extraOptions?: Partial<InboundGatewayOptions>
  ) {
    if (typeof masterMerchantKeyOrOptions === "object") {
      const opts = masterMerchantKeyOrOptions;
      this.masterMerchantKey = opts.masterMerchantKey;
      this.corporate0zkAddress = opts.corporate0zkAddress;
      this.corporateNpk = opts.corporateNpk;
      this.blockchain = opts.blockchain;
      this.pool = opts.pool;
      this.autoSweep = opts.autoSweep ?? true;
      this.defaultTtlSeconds = opts.defaultTtlSeconds ?? 900;
      this.defaultTokenSymbol = opts.defaultTokenSymbol ?? WQUAI.symbol;
      this.defaultTokenDecimals = opts.defaultTokenDecimals ?? WQUAI_DECIMALS;
      this.network = opts.network ?? DEFAULT_QUAI_NETWORK;
      this.trustMode = opts.trustMode ?? "verified";
      this.receiptSource = opts.receiptSource;

      this.invoiceRegistry = new InvoiceRegistry(this.masterMerchantKey, this.blockchain, {
        network: this.network,
        verification: this.trustMode === "verified" ? "ledger" : "trusted-harness",
        // A live zone reorgs (~25 blocks were seen on Orchard): one confirmation is not final there.
        minConfirmations: opts.minConfirmations ?? (this.receiptSource ? LIVE_MIN_CONFIRMATIONS : undefined),
        // With a live receipt source the in-memory ledger does not know what payee addresses hold on chain.
        balanceAuthoritative: !this.receiptSource
      });
      this.usedReceiptRegistry = this.invoiceRegistry.usedReceiptRegistry;
      this.sweeper = new SweeperWorker({
        registry: this.invoiceRegistry,
        pool: this.pool,
        corporateNpk: this.corporateNpk,
        corporate0zkAddress: this.corporate0zkAddress,
        corporateVpk: opts.corporateVpk,
        blockchain: this.blockchain,
        relayer: opts.relayer,
        journal: opts.journal,
        treasuryLedger: opts.treasuryLedger,
        mode: opts.sweeperMode ?? "REALTIME",
        gasSponsorshipMode: opts.gasSponsorshipMode ?? "DIRECT_SIMULATION"
      });
    } else {
      this.masterMerchantKey = masterMerchantKeyOrOptions;
      this.corporate0zkAddress = corporate0zkAddress!;
      this.corporateNpk = corporateNpk!;
      this.blockchain = blockchain!;
      this.pool = pool!;
      this.autoSweep = extraOptions?.autoSweep ?? true;
      this.defaultTtlSeconds = extraOptions?.defaultTtlSeconds ?? 900;
      this.defaultTokenSymbol = extraOptions?.defaultTokenSymbol ?? WQUAI.symbol;
      this.defaultTokenDecimals = extraOptions?.defaultTokenDecimals ?? WQUAI_DECIMALS;
      this.network = extraOptions?.network ?? DEFAULT_QUAI_NETWORK;
      this.trustMode = extraOptions?.trustMode ?? "verified";
      this.receiptSource = extraOptions?.receiptSource;

      this.invoiceRegistry = new InvoiceRegistry(this.masterMerchantKey, this.blockchain, {
        network: this.network,
        verification: this.trustMode === "verified" ? "ledger" : "trusted-harness",
        minConfirmations: extraOptions?.minConfirmations ?? (this.receiptSource ? LIVE_MIN_CONFIRMATIONS : undefined),
        balanceAuthoritative: !this.receiptSource
      });
      this.usedReceiptRegistry = this.invoiceRegistry.usedReceiptRegistry;
      this.sweeper = new SweeperWorker({
        registry: this.invoiceRegistry,
        pool: this.pool,
        corporateNpk: this.corporateNpk,
        corporate0zkAddress: this.corporate0zkAddress,
        corporateVpk: extraOptions?.corporateVpk,
        blockchain: this.blockchain,
        relayer: extraOptions?.relayer,
        journal: extraOptions?.journal,
        treasuryLedger: extraOptions?.treasuryLedger,
        mode: extraOptions?.sweeperMode ?? "REALTIME",
        gasSponsorshipMode: extraOptions?.gasSponsorshipMode ?? "DIRECT_SIMULATION"
      });
    }
  }

  /**
   * Generates a 402 Payment Required challenge with a unique ephemeral destination.
   */
  public createPaymentChallenge(
    resourceUri: string,
    amount: bigint,
    tokenAddress: string,
    tokenSymbol: string = this.defaultTokenSymbol,
    tokenDecimals: number = this.defaultTokenDecimals,
    ttlSeconds: number = this.defaultTtlSeconds
  ): PaymentChallengeResult {
    const invoice = this.invoiceRegistry.createInvoice(
      resourceUri,
      amount,
      tokenAddress,
      tokenSymbol,
      tokenDecimals,
      ttlSeconds
    );

    const { headers: challengeHeaders, body: challengeBody } = buildQuaiChallenge({
      network: this.network,
      invoiceId: invoice.invoiceId,
      resourceUri,
      recipient: invoice.ephemeralAddress,
      tokenAddress,
      tokenSymbol,
      tokenDecimals,
      amount,
      createdAt: invoice.createdAt,
      expiresAt: invoice.expiresAt
    });

    return { invoice, challengeHeaders, challengeBody };
  }

  /**
   * Verifies incoming payment credentials and updates the invoice state machine.
   */
  public verifyPayment(
    invoiceId: string,
    txHash: string,
    amountSent?: bigint
  ): PaymentVerificationResult {
    return this.annotate(this.invoiceRegistry.verifySettlement(invoiceId, txHash, amountSent));
  }

  /**
   * Same as verifyPayment but reads the receipt from the configured live source when there is one
   * (a Quai zone), which is how a production merchant should verify. Falls back to the in-memory
   * ledger otherwise.
   */
  public async verifyPaymentAsync(invoiceId: string, txHash: string): Promise<PaymentVerificationResult> {
    if (this.receiptSource && this.trustMode === "verified") {
      return this.annotate(await this.invoiceRegistry.verifySettlementAsync(invoiceId, txHash, this.receiptSource));
    }
    return this.verifyPayment(invoiceId, txHash);
  }

  private annotate(res: PaymentVerificationResult): PaymentVerificationResult {
    const payer = res.invoice?.payerAddress;
    if (res.success && payer && this.pool?.contractAddress) {
      res.payerIsPool = payer.toLowerCase() === String(this.pool.contractAddress).toLowerCase();
    }
    return res;
  }

  /**
   * Sweeps balance from ephemeral address and shields into Railgun pool.
   */
  public async sweepAndShield(
    invoiceId: string,
    customBlinding?: bigint
  ): Promise<SweepResult> {
    return this.sweeper.sweepAndShield(invoiceId, customBlinding);
  }

  /** What an invoice was issued for, so a server can bind a payment to its resource before verifying it. */
  public getInvoice(invoiceId: string): { resourceUri: string; tokenAddress: string; requiredAmount: bigint } | undefined {
    const inv = this.invoiceRegistry.get(invoiceId);
    return inv ? { resourceUri: inv.resourceUri, tokenAddress: inv.tokenAddress, requiredAmount: inv.requiredAmount } : undefined;
  }

  /**
   * Extracts payment credentials from request headers across supported schemes.
   */
  public extractCredentials(
    headers: Record<string, string | string[] | undefined>
  ): { invoiceId?: string; proof?: string } {
    const getHeader = (k: string): string | undefined => {
      const lower = k.toLowerCase();
      for (const [key, val] of Object.entries(headers)) {
        if (key.toLowerCase() === lower) {
          if (Array.isArray(val)) return val[0];
          return val;
        }
      }
      return undefined;
    };

    const proofHeader = getHeader("x-payment-proof");
    const invoiceIdHeader = getHeader("x-payment-invoice-id");
    if (proofHeader && invoiceIdHeader) {
      return { invoiceId: invoiceIdHeader.trim(), proof: proofHeader.trim() };
    }

    const auth = getHeader("authorization");
    if (auth) {
      const trimmed = auth.trim();

      // Scheme 1: Authorization: x402 invoice="...", proof="..."
      if (trimmed.toLowerCase().startsWith("x402")) {
        const invMatch = trimmed.match(/invoice="([^"]+)"/i);
        const prfMatch = trimmed.match(/proof="([^"]+)"/i);
        if (invMatch && prfMatch) {
          return { invoiceId: invMatch[1], proof: prfMatch[1] };
        }
      }

      // Scheme 2: Authorization: Bearer <token>
      if (trimmed.toLowerCase().startsWith("bearer ")) {
        const token = trimmed.slice(7).trim();

        // Direct JSON string
        if (token.startsWith("{") && token.endsWith("}")) {
          try {
            const parsed = JSON.parse(token);
            if (parsed.invoiceId && parsed.proof) {
              return { invoiceId: parsed.invoiceId, proof: parsed.proof };
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Base64-encoded JSON
        if (/^[A-Za-z0-9+/=]+$/.test(token)) {
          try {
            const decoded = Buffer.from(token, "base64").toString("utf-8");
            if (decoded.startsWith("{") && decoded.endsWith("}")) {
              const parsed = JSON.parse(decoded);
              if (parsed.invoiceId && parsed.proof) {
                return { invoiceId: parsed.invoiceId, proof: parsed.proof };
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Shorthand invoiceId:proof
        if (token.includes(":")) {
          const colonIdx = token.indexOf(":");
          const inv = token.slice(0, colonIdx).trim();
          const prf = token.slice(colonIdx + 1).trim();
          if (inv && prf) {
            return { invoiceId: inv, proof: prf };
          }
        }
      }
    }

    return {};
  }

  /**
   * Express/Connect/Node compatible HTTP middleware helper.
   */
  public createMiddleware(options?: GatewayMiddlewareOptions) {
    const prefixes = options?.protectedPrefixes ?? ["/api/v1/protected"];
    const amount = options?.defaultAmount ?? 5n * 10n ** 18n; // 5 WQUAI
    const tokenAddress = options?.defaultTokenAddress ?? WQUAI.address.toLowerCase();
    const tokenSymbol = options?.defaultTokenSymbol ?? this.defaultTokenSymbol;
    const tokenDecimals = options?.defaultTokenDecimals ?? this.defaultTokenDecimals;
    const ttlSeconds = options?.defaultTtlSeconds ?? this.defaultTtlSeconds;
    const autoSweep = options?.autoSweep ?? this.autoSweep;

    return async (req: any, res: any, next: Function) => {
      // The resource is the path alone: a query string must neither change what is protected nor let one
      // invoice be minted per spelling of the same resource.
      const path = String(req.url || req.path || "").split("?")[0].split("#")[0];
      const isProtected = prefixes.some((p) => path.startsWith(p));

      if (!isProtected) {
        return next();
      }

      const headers = req.headers || {};
      const { invoiceId, proof } = this.extractCredentials(headers);
      const reply = (status: number, body: unknown) => {
        res.statusCode = status;
        if (res.json) return res.json(body);
        return res.end(JSON.stringify(body));
      };

      // A payment buys the resource it was invoiced for. Checked before verification so presenting it
      // elsewhere has no side effect at all.
      if (invoiceId && proof) {
        const invoice = this.invoiceRegistry.get(invoiceId);
        if (invoice && invoice.resourceUri !== path) {
          return reply(403, { error: "ERR_INVOICE_RESOURCE_MISMATCH", statusCode: 403 });
        }
      }

      if (!invoiceId || !proof) {
        const challenge = this.createPaymentChallenge(
          path,
          amount,
          tokenAddress,
          tokenSymbol,
          tokenDecimals,
          ttlSeconds
        );

        if (res.setHeader) {
          for (const [k, v] of Object.entries(challenge.challengeHeaders)) {
            res.setHeader(k, v);
          }
          res.setHeader("Content-Type", "application/problem+json");
        }
        res.statusCode = 402;
        if (res.json) {
          return res.json(challenge.challengeBody);
        }
        return res.end(JSON.stringify(challenge.challengeBody));
      }

      const verifyResult = await this.verifyPaymentAsync(invoiceId, proof);
      if (!verifyResult.success) {
        res.statusCode = verifyResult.statusCode;
        const errBody = {
          error: verifyResult.error,
          statusCode: verifyResult.statusCode
        };
        if (res.json) {
          return res.json(errBody);
        }
        return res.end(JSON.stringify(errBody));
      }

      if (autoSweep) {
        try {
          await this.sweepAndShield(invoiceId);
        } catch {
          // Keep response successful even if sweep is queued
        }
      }

      req.paymentReceipt = verifyResult.receiptId;
      req.paymentInvoice = verifyResult.invoice;

      if (res.setHeader) {
        res.setHeader("X-Payment-Status", "SETTLED");
        if (verifyResult.receiptId) {
          res.setHeader("X-Payment-Receipt-Id", verifyResult.receiptId);
        }
        res.setHeader("X-Payment-Invoice-Id", invoiceId);
      }

      return next();
    };
  }
}
