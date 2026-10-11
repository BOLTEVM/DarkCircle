/**
 * DarkCircle Protocol - Protected Resource Server
 *
 * Exposes protected enterprise endpoints requiring x402 payment settlement in Quai-ledger
 * ERC-20s (WQUAI by default, WQI supported) on Quai Cyprus-1:
 * - /api/v1/protected/analytics (default: 5 WQUAI)
 * - /api/v1/protected/ai-inference (default: 10 WQUAI)
 * - /api/v1/public/health (free public endpoint)
 *
 * Strictly adheres to RFC 7807 (Problem Details for HTTP APIs) and
 * RFC 7235 / x402 Payment Required authentication standards.
 */

import crypto from "node:crypto";
import { BN254_SCALAR_FIELD } from "../crypto/field.ts";
import { deriveEphemeralAddress } from "../gateway/ephemeral.ts";
import { buildQuaiChallenge } from "../gateway/challenge.ts";
import { DEFAULT_QUAI_NETWORK } from "../quai/networks.ts";
import { WQUAI, WQUAI_DECIMALS } from "../quai/tokens.ts";

export interface ServerRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: any;
}

export interface ServerResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export interface RouteDefinition {
  path: string;
  method?: string; // GET, POST, or '*'
  isProtected: boolean;
  requiredAmount?: bigint;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  handler?: (req: ServerRequest) => Promise<any> | any;
}

export interface IMerchantGateway {
  createPaymentChallenge(
    resourceUri: string,
    amount: bigint,
    tokenAddress: string,
    tokenSymbol?: string,
    tokenDecimals?: number,
    ttlSeconds?: number
  ): { invoice: any; challengeHeaders: Record<string, string>; challengeBody: any };

  verifyPayment(
    invoiceId: string,
    txHash: string,
    amountSent?: bigint
  ): { success: boolean; error?: string; receiptId?: string; statusCode: number; payerIsPool?: boolean };

  /** Preferred by the server when present: reads the receipt from a live chain source. */
  verifyPaymentAsync?(
    invoiceId: string,
    txHash: string
  ): Promise<{ success: boolean; error?: string; receiptId?: string; statusCode: number; payerIsPool?: boolean }>;

  sweepAndShield?(invoiceId: string): Promise<any>;
  /** What an invoice was issued for (resource and token), used to bind a payment to its route. */
  getInvoice?(invoiceId: string): { resourceUri: string; tokenAddress: string } | undefined;
  invoiceRegistry?: Map<string, any>;
  usedReceiptRegistry?: Set<string>;
}

export interface ResourceServerOptions {
  gateway?: IMerchantGateway;
  /**
   * Allow running without a real gateway. The built-in StandaloneGateway accepts ANY payment proof and
   * exists only so demos and tests can exercise the protocol; without this flag a gateway is required.
   */
  demo?: boolean;
  /** Called when the post-payment sweep fails, so operators can alert on stranded ephemeral funds. */
  onSweepError?: (invoiceId: string, error: unknown) => void;
  defaultTokenAddress?: string;
  defaultTokenSymbol?: string;
  defaultTokenDecimals?: number;
  autoSweep?: boolean;
}

/**
 * Built-in minimal standalone gateway for 0-config standalone usage.
 */
class StandaloneGateway implements IMerchantGateway {
  public invoiceRegistry: Map<string, any> = new Map();
  public usedReceiptRegistry: Set<string> = new Set();
  private masterMerchantKey: string = "darkcircle_standalone_merchant_key_secret";

  public createPaymentChallenge(
    resourceUri: string,
    amount: bigint,
    tokenAddress: string,
    tokenSymbol: string = WQUAI.symbol,
    tokenDecimals: number = WQUAI_DECIMALS,
    ttlSeconds: number = 900
  ) {
    const invoiceId = `inv_${crypto.randomBytes(12).toString("hex")}`;
    // Zone-valid Quai-ledger recipient with a real private key, so the payee can actually sweep it.
    const { address: ephemeralAddress, privateKey } = deriveEphemeralAddress(
      this.masterMerchantKey,
      invoiceId,
      { zone: DEFAULT_QUAI_NETWORK.zone }
    );

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlSeconds;

    const invoice = {
      invoiceId,
      resourceUri,
      ephemeralAddress,
      ephemeralPrivateKey: privateKey,
      tokenAddress: tokenAddress.toLowerCase(),
      tokenSymbol,
      tokenDecimals,
      requiredAmount: amount,
      createdAt: now,
      expiresAt,
      status: "PENDING" as const,
      settlementTxHash: undefined as string | undefined,
      settledAt: undefined as number | undefined
    };
    this.invoiceRegistry.set(invoiceId, invoice);

    const { headers: challengeHeaders, body: challengeBody } = buildQuaiChallenge({
      network: DEFAULT_QUAI_NETWORK,
      invoiceId,
      resourceUri,
      recipient: ephemeralAddress,
      tokenAddress,
      tokenSymbol,
      tokenDecimals,
      amount,
      createdAt: now,
      expiresAt
    });

    return { invoice, challengeHeaders, challengeBody };
  }

  public verifyPayment(
    invoiceId: string,
    txHash: string,
    amountSent?: bigint
  ): { success: boolean; error?: string; receiptId?: string; statusCode: number } {
    const invoice = this.invoiceRegistry.get(invoiceId);
    if (!invoice) {
      return { success: false, error: "ERR_INVOICE_NOT_FOUND", statusCode: 404 };
    }

    const now = Math.floor(Date.now() / 1000);
    const normTxHash = txHash.toLowerCase();

    // A settled invoice stays settled: expiry ends its access, it never un-settles the payment.
    if (invoice.status === "SETTLED" || invoice.status === "SWEPT") {
      if (invoice.settlementTxHash?.toLowerCase() !== normTxHash) {
        return { success: false, error: "ERR_INVOICE_ALREADY_SETTLED", statusCode: 409 };
      }
      if (now > invoice.expiresAt) return { success: false, error: "ERR_INVOICE_EXPIRED", statusCode: 410 };
      // Idempotency: same invoice previously settled with the same txHash
      return { success: true, receiptId: `rct_${invoice.invoiceId}`, statusCode: 200 };
    }

    if (now > invoice.expiresAt) {
      invoice.status = "EXPIRED";
      return { success: false, error: "ERR_INVOICE_EXPIRED", statusCode: 410 };
    }

    // Replay attack defense
    if (this.usedReceiptRegistry.has(normTxHash)) {
      return { success: false, error: "ERR_REPLAY_DETECTED", statusCode: 409 };
    }

    if (amountSent !== undefined && amountSent < invoice.requiredAmount) {
      return { success: false, error: "ERR_UNDERPAYMENT", statusCode: 402 };
    }

    invoice.status = "SETTLED";
    invoice.settlementTxHash = normTxHash;
    invoice.settledAt = now;
    this.usedReceiptRegistry.add(normTxHash);

    const receiptId = `rct_${crypto.randomBytes(12).toString("hex")}`;
    return { success: true, receiptId, statusCode: 200 };
  }

  public async sweepAndShield(invoiceId: string): Promise<any> {
    const invoice = this.invoiceRegistry.get(invoiceId);
    if (invoice && invoice.status === "SETTLED") {
      invoice.status = "SWEPT";
      invoice.ephemeralPrivateKey = "0x0000000000000000000000000000000000000000000000000000000000000000";
    }
    return { status: "swept", invoiceId };
  }
}

/**
 * Standalone Simulated Resource Server with x402 Payment Interception
 */
export class ResourceServer {
  public gateway: IMerchantGateway;
  public routes: Map<string, RouteDefinition> = new Map();
  public defaultTokenAddress: string;
  public defaultTokenSymbol: string;
  public defaultTokenDecimals: number;
  public autoSweep: boolean;
  public onSweepError?: (invoiceId: string, error: unknown) => void;
  private startTime: number = Date.now();

  constructor(gatewayOrOptions?: IMerchantGateway | ResourceServerOptions) {
    if (gatewayOrOptions && "createPaymentChallenge" in gatewayOrOptions) {
      // InboundMerchantGateway instance passed directly
      this.gateway = gatewayOrOptions;
      this.defaultTokenAddress = WQUAI.address.toLowerCase();
      this.defaultTokenSymbol = WQUAI.symbol;
      this.defaultTokenDecimals = WQUAI_DECIMALS;
      this.autoSweep = true;
    } else {
      const opts = (gatewayOrOptions as ResourceServerOptions) || {};
      if (!opts.gateway && opts.demo !== true) {
        throw new Error(
          "ERR_RESOURCE_SERVER_GATEWAY_REQUIRED: pass a gateway, or { demo: true } to use the built-in gateway that accepts any proof of payment"
        );
      }
      this.onSweepError = opts.onSweepError;
      this.gateway = opts.gateway || new StandaloneGateway();
      this.defaultTokenAddress = (opts.defaultTokenAddress || WQUAI.address).toLowerCase();
      this.defaultTokenSymbol = opts.defaultTokenSymbol || WQUAI.symbol;
      this.defaultTokenDecimals = opts.defaultTokenDecimals !== undefined ? opts.defaultTokenDecimals : WQUAI_DECIMALS;
      this.autoSweep = opts.autoSweep !== undefined ? opts.autoSweep : true;
    }

    this.registerDefaultRoutes();
  }

  /**
   * Helper to retrieve headers case-insensitively.
   */
  private getHeader(headers: Record<string, string>, key: string): string | undefined {
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lowerKey) return v;
    }
    return undefined;
  }

  /**
   * Registers default endpoints.
   */
  private registerDefaultRoutes(): void {
    // 1. Free Public Health Endpoint
    this.registerRoute({
      path: "/api/v1/public/health",
      method: "*",
      isProtected: false,
      handler: () => ({
        status: "healthy",
        service: "DarkCircle Resource Server",
        version: "1.0.0",
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        timestamp: new Date().toISOString(),
        network: DEFAULT_QUAI_NETWORK.id,
        chainId: DEFAULT_QUAI_NETWORK.chainId
      })
    });

    // 2. Protected Analytics Endpoint (Default: 5 WQUAI)
    this.registerRoute({
      path: "/api/v1/protected/analytics",
      method: "GET",
      isProtected: true,
      requiredAmount: 5n * 10n ** 18n, // 5 WQUAI
      tokenAddress: this.defaultTokenAddress,
      tokenSymbol: this.defaultTokenSymbol,
      tokenDecimals: this.defaultTokenDecimals,
      handler: () => ({
        activeUsers: 48291,
        totalVolumeUsd: 12948201.5,
        shieldedPoolDepthUsd: 8492019.0,
        anonymousSettlements24h: 1420,
        retentionRate: 0.942
      })
    });

    // 3. Protected AI Inference Endpoint (Default: 10 WQUAI)
    this.registerRoute({
      path: "/api/v1/protected/ai-inference",
      method: "*",
      isProtected: true,
      requiredAmount: 10n * 10n ** 18n, // 10 WQUAI
      tokenAddress: this.defaultTokenAddress,
      tokenSymbol: this.defaultTokenSymbol,
      tokenDecimals: this.defaultTokenDecimals,
      handler: (req) => ({
        model: req.body?.model || "llama-3-8b",
        inference: "Corporate earnings analysis completed with zero leakage.",
        promptTokens: 42,
        completionTokens: 18,
        privacyPreserved: true
      })
    });
  }

  /**
   * Registers or overrides a route on the resource server.
   */
  public registerRoute(route: RouteDefinition): void {
    this.routes.set(route.path, {
      method: "*",
      tokenAddress: this.defaultTokenAddress,
      tokenSymbol: this.defaultTokenSymbol,
      tokenDecimals: this.defaultTokenDecimals,
      ...route
    });
  }

  /**
   * Extracts payment credentials from various supported authorization header schemes.
   */
  private extractCredentials(headers: Record<string, string>): { invoiceId?: string; proof?: string; malformed?: boolean } {
    const found = this.extractCredentialsRaw(headers);
    // Credentials are attacker-controlled: bound their size and shape before they reach any lookup.
    if (found.invoiceId && found.proof) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(found.invoiceId) || !/^0x[0-9a-fA-F]{64}$/.test(found.proof)) {
        return { malformed: true };
      }
    }
    return found;
  }

  private extractCredentialsRaw(headers: Record<string, string>): { invoiceId?: string; proof?: string } {
    const proofHeader = this.getHeader(headers, "x-payment-proof");
    const invoiceIdHeader = this.getHeader(headers, "x-payment-invoice-id");

    if (proofHeader && invoiceIdHeader) {
      return { invoiceId: invoiceIdHeader.trim(), proof: proofHeader.trim() };
    }

    const authHeader = this.getHeader(headers, "authorization");
    if (authHeader) {
      const trimmedAuth = authHeader.trim();

      // Scheme 1: Authorization: x402 invoice="...", proof="..."
      if (trimmedAuth.toLowerCase().startsWith("x402")) {
        const invoiceMatch = trimmedAuth.match(/invoice="([^"]+)"/i);
        const proofMatch = trimmedAuth.match(/proof="([^"]+)"/i);
        if (invoiceMatch && proofMatch) {
          return { invoiceId: invoiceMatch[1], proof: proofMatch[1] };
        }
      }

      // Scheme 2: Authorization: Bearer <token>
      if (trimmedAuth.toLowerCase().startsWith("bearer ")) {
        const token = trimmedAuth.slice(7).trim();

        // Format A: JSON encoded
        if (token.startsWith("{") && token.endsWith("}")) {
          try {
            const parsed = JSON.parse(token);
            if (parsed.invoiceId && parsed.proof) {
              return { invoiceId: parsed.invoiceId, proof: parsed.proof };
            }
          } catch {}
        }

        // Format B: Base64 JSON encoded
        if (/^[A-Za-z0-9+/=]+$/.test(token)) {
          try {
            const decoded = Buffer.from(token, "base64").toString("utf-8");
            if (decoded.startsWith("{") && decoded.endsWith("}")) {
              const parsed = JSON.parse(decoded);
              if (parsed.invoiceId && parsed.proof) {
                return { invoiceId: parsed.invoiceId, proof: parsed.proof };
              }
            }
          } catch {}
        }

        // Format C: invoiceId:txHash
        if (token.includes(":")) {
          const [inv, prf] = token.split(":");
          if (inv && prf) {
            return { invoiceId: inv.trim(), proof: prf.trim() };
          }
        }
      }
    }

    return {};
  }

  /**
   * Main request handler for simulated HTTP requests.
   */
  public async handleRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<ServerResponse> {
    const normMethod = method.toUpperCase();
    const route = this.routes.get(path);

    if (!route) {
      return {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: { error: "NOT_FOUND", message: `Route ${path} not found` }
      };
    }

    if (route.method !== "*" && route.method?.toUpperCase() !== normMethod && normMethod !== "HEAD") {
      return {
        status: 405,
        headers: { "Content-Type": "application/json" },
        body: { error: "METHOD_NOT_ALLOWED", message: `Method ${normMethod} not allowed on ${path}` }
      };
    }

    // Free Public Route
    if (!route.isProtected) {
      const payload = route.handler ? await route.handler({ method: normMethod, path, headers, body }) : {};
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60"
        },
        body: payload
      };
    }

    // Protected Route - Check Payment Credentials
    const { invoiceId, proof, malformed } = this.extractCredentials(headers);

    if (malformed) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "ERR_PAYMENT_CREDENTIALS_MALFORMED" }
      };
    }

    if (invoiceId && proof) {
      // A payment buys the route it was invoiced for, in the token it was invoiced in: an invoice paid for a
      // cheaper route must not unlock this one. Checked before verification, so presenting an invoice on
      // the wrong route changes nothing.
      const issued = this.gateway.getInvoice?.(invoiceId) ?? this.gateway.invoiceRegistry?.get(invoiceId);
      if (issued) {
        const routeToken = (route.tokenAddress || this.defaultTokenAddress).toLowerCase();
        if (issued.resourceUri !== path || String(issued.tokenAddress).toLowerCase() !== routeToken) {
          return {
            status: 403,
            headers: { "Content-Type": "application/json" },
            body: { error: "ERR_INVOICE_RESOURCE_MISMATCH", message: "this invoice was issued for a different resource or token" }
          };
        }
      }

      const verifyRes = this.gateway.verifyPaymentAsync
        ? await this.gateway.verifyPaymentAsync(invoiceId, proof)
        : this.gateway.verifyPayment(invoiceId, proof);

      if (!verifyRes.success) {
        return {
          status: verifyRes.statusCode,
          headers: { "Content-Type": "application/json" },
          body: { error: verifyRes.error }
        };
      }

      // Automatically trigger background sweep if enabled. A failed sweep leaves funds sitting on the
      // ephemeral address, so it is reported (header + hook) instead of swallowed.
      let sweepDeferred: string | undefined;
      if (this.autoSweep && this.gateway.sweepAndShield) {
        await this.gateway.sweepAndShield(invoiceId).catch((err: unknown) => {
          sweepDeferred = err instanceof Error ? err.message.split(":")[0] : "SWEEP_FAILED";
          this.onSweepError?.(invoiceId, err);
        });
      }

      const payload = route.handler ? await route.handler({ method: normMethod, path, headers, body }) : {};

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Status": "SETTLED",
          "X-Payment-Receipt-Id": verifyRes.receiptId || `rct_${invoiceId}`,
          "X-Payment-Invoice-Id": invoiceId,
          // Only claim decoupling when the payer on chain was the shielded pool itself.
          ...(verifyRes.payerIsPool !== undefined
            ? { "X-Payment-Relayer-Decoupled": verifyRes.payerIsPool ? "true" : "false" }
            : {}),
          ...(sweepDeferred ? { "X-Payment-Sweep": `deferred; reason=${sweepDeferred}` } : {})
        },
        body: {
          status: "success",
          path,
          timestamp: new Date().toISOString(),
          data: payload
        }
      };
    }

    // Issue HTTP 402 Challenge
    const amount = route.requiredAmount || 5000000n;
    const token = route.tokenAddress || this.defaultTokenAddress;
    const symbol = route.tokenSymbol || this.defaultTokenSymbol;
    const decimals = route.tokenDecimals !== undefined ? route.tokenDecimals : this.defaultTokenDecimals;

    const challenge = this.gateway.createPaymentChallenge(path, amount, token, symbol, decimals);

    return {
      status: 402,
      headers: {
        "Content-Type": "application/problem+json",
        ...challenge.challengeHeaders
      },
      body: challenge.challengeBody
    };
  }

  /**
   * Standard Web Fetch API compatible dispatcher.
   */
  public async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let urlStr: string;
    let method: string = init?.method || "GET";
    const headers: Record<string, string> = {};
    let body: any = init?.body;

    if (typeof input === "string") {
      urlStr = input;
    } else if (input instanceof URL) {
      urlStr = input.toString();
    } else if (typeof Request !== "undefined" && input instanceof Request) {
      urlStr = input.url;
      method = input.method;
      input.headers.forEach((val, key) => {
        headers[key] = val;
      });
      if (input.body) {
        try {
          body = await input.clone().json();
        } catch {
          body = await input.clone().text();
        }
      }
    } else {
      urlStr = String(input);
    }

    const parsed = new URL(urlStr, "http://localhost");
    const path = parsed.pathname;

    if (init?.headers) {
      if (typeof Headers !== "undefined" && init.headers instanceof Headers) {
        init.headers.forEach((val, key) => {
          headers[key] = val;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k] = v;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    }

    const res = await this.handleRequest(method, path, headers, body);

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      responseHeaders.set(k, v);
    }

    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: responseHeaders
    });
  }
}
