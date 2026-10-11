/**
 * DarkCircle: Outbound Private Payment Proxy - Challenge Parser
 * File: src/proxy/parser.ts
 *
 * Implements RFC 7235, RFC 7807, and x402 challenge parsing specifications.
 * Cascade order: RFC 7807 JSON Problem Details -> RFC 7235 WWW-Authenticate -> X-Payment-* headers.
 */

import { DEFAULT_QUAI_NETWORK, resolveQuaiNetwork } from "../quai/networks.ts";
import { WQUAI_DECIMALS, defaultQuaiTokenRegistry } from "../quai/tokens.ts";

const DEFAULT_CHAIN_ID = DEFAULT_QUAI_NETWORK.chainId;
const DEFAULT_NETWORK = DEFAULT_QUAI_NETWORK.id;
const DEFAULT_SYMBOL = "WQUAI";

/**
 * Resolves the symbol/decimals of a challenge's token. A token in the Quai registry is authoritative:
 * a challenge that states different decimals for a registered address is rejected, because decimals
 * decide how a decimal amount string scales into base units. Unregistered tokens keep what the
 * challenge states (or the 18-decimal Quai default) and are left to the spending policy to refuse.
 */
function resolveTokenMeta(
  tokenAddress: string,
  statedSymbol: string | undefined,
  statedDecimals: unknown
): { symbol: string; decimals: number } {
  const known = tokenAddress ? defaultQuaiTokenRegistry.getByAddress(tokenAddress) : undefined;
  const stated =
    statedDecimals === undefined || statedDecimals === null || statedDecimals === ""
      ? undefined
      : Number(statedDecimals);
  if (stated !== undefined && (!Number.isInteger(stated) || stated < 0 || stated > 36)) {
    throw new Error(`ERR_402_CHALLENGE_INVALID: token decimals '${statedDecimals}' out of range`);
  }
  if (known) {
    if (stated !== undefined && stated !== known.decimals) {
      throw new Error(
        `ERR_402_CHALLENGE_INVALID: ${known.symbol} has ${known.decimals} decimals, challenge states ${stated}`
      );
    }
    return { symbol: known.symbol, decimals: known.decimals };
  }
  return { symbol: statedSymbol || DEFAULT_SYMBOL, decimals: stated ?? WQUAI_DECIMALS };
}

/** Normalizes a challenge's network name and chain id; chain id defaults from the resolved network. */
function resolveChain(
  network: string | undefined,
  chainId: unknown
): { network: string; chainId: number } {
  const resolved = resolveQuaiNetwork(network);
  const explicit = chainId === undefined || chainId === null || chainId === "" ? undefined : Number(chainId);
  return {
    network: network || DEFAULT_NETWORK,
    chainId: explicit ?? resolved?.chainId ?? DEFAULT_CHAIN_ID
  };
}

export interface ParsedPaymentChallenge {
  scheme: string;              // Protocol / scheme (e.g. "x402", "x402-v1", "erc20_transfer")
  invoiceId: string;           // Unique invoice identifier
  chainId: number;             // Quai chain id (9 mainnet, 15000 Orchard); the zone comes from `network`
  network: string;             // Network id (e.g. "quai-cyprus1")
  tokenAddress: string;        // ERC-20 token address (lowercased)
  token: string;               // Alias for tokenAddress
  tokenSymbol: string;         // e.g. "WQUAI"
  tokenDecimals: number;       // e.g. 18
  amount: bigint;              // Atomic token amount
  recipientAddress: string;    // Payment destination address (lowercased)
  recipient: string;           // Alias for recipientAddress
  expiresAt: number;           // Expiration Unix timestamp in seconds
  targetResource: string;      // Protected endpoint URI
  proofType: string;           // Proof type (e.g. "tx_receipt")
  maxFee?: bigint;             // Optional max relayer fee acceptable
  memo?: string;               // Optional invoice description or memo
}

/**
 * Parses integer or decimal token amounts into integer base units without floating-point loss.
 */
export function parseAmountToBaseUnits(val: unknown, decimals: number = WQUAI_DECIMALS): bigint {
  if (typeof val === "bigint") {
    if (val <= 0n) {
      throw new Error("ERR_402_CHALLENGE_INVALID: Amount must be positive");
    }
    return val;
  }

  if (typeof val === "number") {
    if (Number.isNaN(val) || !Number.isFinite(val) || val <= 0) {
      throw new Error("ERR_402_CHALLENGE_INVALID: Amount must be positive and finite");
    }
    if (Number.isInteger(val)) {
      return BigInt(val);
    }
    val = val.toString();
  }

  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      throw new Error("ERR_402_CHALLENGE_INVALID: Amount string is empty");
    }

    // Decimal representation (e.g. "5.123456" or "5.0")
    if (trimmed.includes(".")) {
      const parts = trimmed.split(".");
      if (parts.length !== 2) {
        throw new Error(`ERR_402_CHALLENGE_INVALID: Invalid decimal amount string '${trimmed}'`);
      }
      const intPart = parts[0].trim() || "0";
      let fracPart = parts[1].trim();

      if (fracPart.length > decimals) {
        fracPart = fracPart.slice(0, decimals);
      } else {
        fracPart = fracPart.padEnd(decimals, "0");
      }

      const combined = intPart === "0" && fracPart === "".padEnd(decimals, "0")
        ? "0"
        : (intPart === "0" ? "" : intPart) + fracPart;

      const result = BigInt(combined || "0");
      if (result <= 0n) {
        throw new Error("ERR_402_CHALLENGE_INVALID: Decimal amount resolved to non-positive");
      }
      return result;
    }

    // Integer base unit string (e.g. "5000000000000000000")
    try {
      const result = BigInt(trimmed);
      if (result <= 0n) {
        throw new Error("ERR_402_CHALLENGE_INVALID: Amount must be positive");
      }
      return result;
    } catch {
      throw new Error(`ERR_402_CHALLENGE_INVALID: Cannot parse amount '${trimmed}' as integer base units`);
    }
  }

  throw new Error("ERR_402_CHALLENGE_INVALID: Unsupported amount type");
}

export class ChallengeParser {
  /**
   * Normalizes varied header input representations into a lowercased Record<string, string>.
   */
  public static normalizeHeaders(
    headers?: Record<string, string | string[] | undefined> | Headers | [string, string][] | any
  ): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;

    if (typeof (headers as any).forEach === "function") {
      (headers as any).forEach((value: string, key: string) => {
        if (typeof key === "string" && typeof value === "string") {
          result[key.toLowerCase()] = value;
        }
      });
      return result;
    }

    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const [k, v] = entry;
          if (typeof k === "string" && typeof v === "string") {
            result[k.toLowerCase()] = v;
          }
        }
      }
      return result;
    }

    if (typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (typeof key === "string") {
          if (typeof value === "string") {
            result[key.toLowerCase()] = value;
          } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
            result[key.toLowerCase()] = value.join(", ");
          }
        }
      }
    }

    return result;
  }

  /**
   * Main entrypoint: Parses HTTP 402 challenge from headers and optional response body.
   * Cascades: RFC 7807 JSON Body -> RFC 7235 WWW-Authenticate -> X-Payment-* headers.
   * Throws Error with 'ERR_402_CHALLENGE_INVALID' if invalid or missing required parameters.
   */
  public static parse(
    headers?: Record<string, string | string[] | undefined> | Headers | [string, string][] | any,
    body?: any
  ): ParsedPaymentChallenge {
    const headerMap = ChallengeParser.normalizeHeaders(headers);

    let parsedBody = body;
    if (typeof body === "string") {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = undefined;
      }
    }

    // -------------------------------------------------------------------------
    // Tier 1: RFC 7807 Problem Details JSON Body
    // -------------------------------------------------------------------------
    if (parsedBody && typeof parsedBody === "object") {
      // Priority 1A: Nested payment object (DarkCircle RFC 7807 canonical structure)
      if (parsedBody.payment && typeof parsedBody.payment === "object") {
        const p = parsedBody.payment;
        const recipientRaw = p.recipient || p.recipientAddress || p.destination;
        const invoiceId = p.invoiceId || p.id;
        const rawAmount = p.amount;

        if (recipientRaw && invoiceId && rawAmount !== undefined && rawAmount !== null) {
          const tokenAddress = (
            typeof p.token === "string" ? p.token : p.token?.address || ""
          ).toLowerCase();
          const { symbol: tokenSymbol, decimals: tokenDecimals } = resolveTokenMeta(
            tokenAddress,
            p.token?.symbol,
            p.token?.decimals
          );
          const amount = parseAmountToBaseUnits(rawAmount, tokenDecimals);
          const recipientAddress = String(recipientRaw).toLowerCase();
          const chain = resolveChain(p.network, p.chainId);

          return {
            scheme: p.protocol || p.scheme || "x402",
            invoiceId: String(invoiceId),
            chainId: chain.chainId,
            network: chain.network,
            tokenAddress,
            token: tokenAddress,
            tokenSymbol,
            tokenDecimals,
            amount,
            recipientAddress,
            recipient: recipientAddress,
            expiresAt: Number(p.expiresAt ?? 0),
            targetResource: parsedBody.instance || "",
            proofType: p.proofType || "tx_receipt",
            maxFee: p.maxFee ? BigInt(p.maxFee) : undefined,
            memo: p.memo
          };
        }
      }

      // Priority 1B: Flat RFC 7807 problem details
      const flatRecipient = parsedBody.recipient || parsedBody.recipientAddress;
      const flatInvoiceId = parsedBody.invoiceId;
      const flatAmount = parsedBody.amount;

      if (flatRecipient && flatInvoiceId && flatAmount !== undefined && flatAmount !== null) {
        const tokenAddress = String(parsedBody.token || parsedBody.tokenAddress || "").toLowerCase();
        const { symbol: tokenSymbol, decimals } = resolveTokenMeta(
          tokenAddress,
          parsedBody.tokenSymbol,
          parsedBody.tokenDecimals
        );
        const amount = parseAmountToBaseUnits(flatAmount, decimals);
        const recipientAddress = String(flatRecipient).toLowerCase();
        const chain = resolveChain(parsedBody.network, parsedBody.chainId);

        return {
          scheme: parsedBody.scheme || "x402",
          invoiceId: String(flatInvoiceId),
          chainId: chain.chainId,
          network: chain.network,
          tokenAddress,
          token: tokenAddress,
          tokenSymbol,
          tokenDecimals: decimals,
          amount,
          recipientAddress,
          recipient: recipientAddress,
          expiresAt: Number(parsedBody.expiresAt ?? 0),
          targetResource: parsedBody.instance || parsedBody.targetResource || "",
          proofType: parsedBody.proofType || "tx_receipt",
          maxFee: parsedBody.maxFee ? BigInt(parsedBody.maxFee) : undefined,
          memo: parsedBody.memo || parsedBody.detail
        };
      }
    }

    // -------------------------------------------------------------------------
    // Tier 2: RFC 7235 WWW-Authenticate Header Fallback
    // -------------------------------------------------------------------------
    const authHeader = headerMap["www-authenticate"];
    if (authHeader && authHeader.toLowerCase().startsWith("x402")) {
      const params: Record<string, string> = {};
      const paramRegex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/g;
      let match: RegExpExecArray | null;

      while ((match = paramRegex.exec(authHeader)) !== null) {
        const key = match[1].toLowerCase();
        const val = match[2] ?? match[3] ?? match[4] ?? "";
        params[key] = val;
      }

      const recipient = params.recipient || params.recipientaddress;
      const invoiceId = params.invoiceid;
      const rawAmount = params.amount;

      if (recipient && invoiceId && rawAmount) {
        const tokenAddress = (params.token || params.tokenaddress || "").toLowerCase();
        const { symbol: tokenSymbol, decimals } = resolveTokenMeta(
          tokenAddress,
          params.tokensymbol,
          params.tokendecimals
        );
        const amount = parseAmountToBaseUnits(rawAmount, decimals);
        const recipientAddress = recipient.toLowerCase();
        const chain = resolveChain(params.network, params.chainid);

        return {
          scheme: params.scheme || "x402",
          invoiceId,
          chainId: chain.chainId,
          network: chain.network,
          tokenAddress,
          token: tokenAddress,
          tokenSymbol,
          tokenDecimals: decimals,
          amount,
          recipientAddress,
          recipient: recipientAddress,
          expiresAt: Number(params.expiresat || 0),
          targetResource: params.resource || "",
          proofType: params.prooftype || "tx_receipt",
          maxFee: params.maxfee ? BigInt(params.maxfee) : undefined,
          memo: params.memo
        };
      }
    }

    // -------------------------------------------------------------------------
    // Tier 3: Custom X-Payment-* Headers Fallback
    // -------------------------------------------------------------------------
    const xRecipient = headerMap["x-payment-recipient"];
    const xAmount = headerMap["x-payment-amount"];
    const xInvoiceId = headerMap["x-payment-invoice-id"];

    if (xRecipient && xAmount && xInvoiceId) {
      const tokenAddress = (headerMap["x-payment-token"] || "").toLowerCase();
      const { symbol: tokenSymbol, decimals } = resolveTokenMeta(
        tokenAddress,
        headerMap["x-payment-token-symbol"],
        headerMap["x-payment-token-decimals"]
      );
      const amount = parseAmountToBaseUnits(xAmount, decimals);
      const recipientAddress = xRecipient.toLowerCase();
      // X-Payment-Network carries the network id; a bare number is accepted as a chain id.
      const rawNetwork = headerMap["x-payment-network"];
      const numericNetwork = rawNetwork !== undefined && /^\d+$/.test(rawNetwork.trim());
      const chain = resolveChain(
        numericNetwork ? undefined : rawNetwork,
        headerMap["x-payment-chain-id"] ?? (numericNetwork ? rawNetwork : undefined)
      );

      return {
        scheme: headerMap["x-payment-scheme"] || "x402-v1",
        invoiceId: xInvoiceId,
        chainId: chain.chainId,
        network: chain.network,
        tokenAddress,
        token: tokenAddress,
        tokenSymbol,
        tokenDecimals: decimals,
        amount,
        recipientAddress,
        recipient: recipientAddress,
        expiresAt: Number(headerMap["x-payment-expires-at"] || 0),
        targetResource: headerMap["x-payment-resource"] || "",
        proofType: headerMap["x-payment-proof-type"] || "tx_receipt",
        maxFee: headerMap["x-payment-max-fee"] ? BigInt(headerMap["x-payment-max-fee"]) : undefined,
        memo: headerMap["x-payment-memo"]
      };
    }

    throw new Error("ERR_402_CHALLENGE_INVALID: Missing required challenge parameters");
  }

  /**
   * Formats authorization header for retry:
   * Authorization: x402 invoice="<invoiceId>", proof="<txHash>"[, relayer="<relayerAddress>"]
   */
  public static formatAuthorizationHeader(
    invoiceId: string,
    proof: string,
    relayerAddress?: string
  ): string {
    if (relayerAddress) {
      return `x402 invoice="${invoiceId}", proof="${proof}", relayer="${relayerAddress}"`;
    }
    return `x402 invoice="${invoiceId}", proof="${proof}"`;
  }

  /**
   * Formats X-Payment-* and Authorization headers for retry request.
   */
  public static formatPaymentProofHeaders(
    invoiceId: string,
    proof: string,
    relayerAddress?: string
  ): Record<string, string> {
    const auth = ChallengeParser.formatAuthorizationHeader(invoiceId, proof, relayerAddress);
    const headers: Record<string, string> = {
      Authorization: auth,
      "X-Payment-Invoice-Id": invoiceId,
      "X-Payment-Proof": proof
    };
    if (relayerAddress) {
      headers["X-Payment-Relayer"] = relayerAddress;
    }
    return headers;
  }

  /**
   * Quick predicate checking if an HTTP status / headers constitute a payment challenge.
   */
  public static isPaymentRequired(
    status: number,
    headers?: Record<string, string | string[] | undefined> | Headers | any
  ): boolean {
    if (status === 402) return true;
    if (!headers) return false;
    const headerMap = ChallengeParser.normalizeHeaders(headers);
    if (headerMap["x-payment-required"] === "true") return true;
    if (headerMap["www-authenticate"] && headerMap["www-authenticate"].toLowerCase().startsWith("x402")) {
      return true;
    }
    return false;
  }
}
