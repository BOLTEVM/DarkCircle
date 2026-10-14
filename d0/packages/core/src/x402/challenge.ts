/**
 * DarkOrder x402: payment challenges for guild tribute and gated services.
 *
 * This is a browser-safe port of DarkCircle's challenge machinery (src/proxy/parser.ts and
 * src/gateway/challenge.ts), retuned for the Grand Guild Halls:
 *
 *  - Parsing cascades RFC 7807 problem-details body -> RFC 7235 WWW-Authenticate header ->
 *    X-Payment-* headers, exactly like DarkCircle, so any service that already speaks
 *    DarkCircle x402 can charge a DarkOrder user without changes.
 *  - Token metadata is validated against the DarkOrder registry (tokens.ts): a challenge that
 *    states decimals different from a registered token's is rejected, because decimals decide
 *    how an amount string scales into base units.
 *  - DarkOrder adds a native scheme, "quai_native_tribute", for paying a guild treasury in
 *    QUAI itself: the recipient is the guild contract and the body carries the payTribute
 *    calldata, so the invoice id lands in the on-chain TributeReceived event as the receipt.
 *
 * No Node APIs are used; the module runs in the browser and in tests alike.
 */

import type { NetworkConfig, NetworkName } from '../config.js';
import { checkAddress, ZERO_ADDRESS } from '../address.js';
import { tokenByAddress, formatTokenAmount } from '../tokens.js';
import { encodeTribute } from '../guilds.js';

/** Challenges identify native QUAI with the zero address (there is no ERC-20 contract for it). */
export const NATIVE_QUAI = ZERO_ADDRESS;

export class ChallengeError extends Error {
  public readonly code = 'ERR_402_CHALLENGE_INVALID';
  constructor(message: string) {
    super(`ERR_402_CHALLENGE_INVALID: ${message}`);
    this.name = 'ChallengeError';
  }
}

export interface ParsedPaymentChallenge {
  /** Protocol / scheme, e.g. "x402", "x402-v1", "quai_native_tribute". */
  scheme: string;
  invoiceId: string;
  /** Quai chain id (9 mainnet, 15000 Orchard, 31337 local). */
  chainId: number;
  /** x402 network id, e.g. "quai-cyprus1". */
  network: string;
  /** ERC-20 token address, lowercased; NATIVE_QUAI for native QUAI. */
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Atomic amount (base units). */
  amount: bigint;
  recipientAddress: string;
  /** Expiry, Unix seconds; 0 means "no expiry stated". */
  expiresAt: number;
  targetResource: string;
  proofType: string;
  maxFee?: bigint;
  memo?: string;
  /** For native tribute: the exact calldata the payer should send (payTribute with the invoice id). */
  callData?: string;
}

export type TokenLookup = (address: string) => { symbol: string; decimals: number } | null;

/** A lookup bound to the DarkOrder registry on one network. */
export function registryTokenLookup(network: NetworkName): TokenLookup {
  return (address) => {
    const known = tokenByAddress(network, address);
    return known ? { symbol: known.symbol, decimals: known.decimals } : null;
  };
}

/** x402 network id -> chain id, for the ids DarkOrder advertises plus bare numbers. */
const NETWORK_CHAIN_IDS: Record<string, number> = {
  'quai-cyprus1': 9,
  'quai-orchard-cyprus1': 15000,
  'darkorder-local': 31337,
};

function invalid(message: string): never {
  throw new ChallengeError(message);
}

/**
 * Resolves the symbol/decimals a challenge's token really has. A registry hit is authoritative:
 * a challenge that states different decimals for a registered address is rejected, because
 * decimals decide how a decimal amount string scales into base units. Unregistered tokens keep
 * what the challenge states (or the 18-decimal Quai default) and are left for the UI to flag.
 */
function resolveTokenMeta(
  tokenAddress: string,
  statedSymbol: string | undefined,
  statedDecimals: unknown,
  lookup: TokenLookup
): { symbol: string; decimals: number } {
  const stated =
    statedDecimals === undefined || statedDecimals === null || statedDecimals === ''
      ? undefined
      : Number(statedDecimals);
  if (stated !== undefined && (!Number.isInteger(stated) || stated < 0 || stated > 36)) {
    invalid(`token decimals '${String(statedDecimals)}' out of range`);
  }
  if (!tokenAddress || tokenAddress.toLowerCase() === NATIVE_QUAI) {
    if (stated !== undefined && stated !== 18) invalid(`native QUAI has 18 decimals, challenge states ${stated}`);
    return { symbol: 'QUAI', decimals: 18 };
  }
  const known = lookup(tokenAddress);
  if (known) {
    if (stated !== undefined && stated !== known.decimals) {
      invalid(`${known.symbol} has ${known.decimals} decimals, challenge states ${stated}`);
    }
    return { symbol: known.symbol, decimals: known.decimals };
  }
  return { symbol: statedSymbol || 'QUAI', decimals: stated ?? 18 };
}

/** Normalizes a challenge's network id and chain id; chain id defaults from the network id. */
function resolveChain(
  network: string | undefined,
  chainId: unknown,
  fallback: { network: string; chainId: number }
): { network: string; chainId: number } {
  const explicit = chainId === undefined || chainId === null || chainId === '' ? undefined : Number(chainId);
  const id = network ?? fallback.network;
  return { network: id, chainId: explicit ?? NETWORK_CHAIN_IDS[id] ?? fallback.chainId };
}

/** Parses integer or decimal token amounts into integer base units without floating-point loss. */
export function parseAmountToBaseUnits(val: unknown, decimals = 18): bigint {
  if (typeof val === 'bigint') {
    if (val <= 0n) invalid('Amount must be positive');
    return val;
  }

  if (typeof val === 'number') {
    if (Number.isNaN(val) || !Number.isFinite(val) || val <= 0) {
      invalid('Amount must be positive and finite');
    }
    if (Number.isInteger(val)) return BigInt(val);
    val = val.toString();
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) invalid('Amount string is empty');

    if (trimmed.includes('.')) {
      const parts = trimmed.split('.');
      if (parts.length !== 2) invalid(`Invalid decimal amount string '${trimmed}'`);
      const intPart = (parts[0] ?? '').trim() || '0';
      const rawFrac = (parts[1] ?? '').trim();
      const fracPart = rawFrac.length > decimals ? rawFrac.slice(0, decimals) : rawFrac.padEnd(decimals, '0');
      const combined = (intPart === '0' ? '' : intPart) + fracPart;
      let result: bigint;
      try {
        result = BigInt(combined || '0');
      } catch {
        invalid(`Cannot parse amount '${trimmed}'`);
      }
      if (result <= 0n) invalid('Decimal amount resolved to non-positive');
      return result;
    }

    try {
      const result = BigInt(trimmed);
      if (result <= 0n) invalid('Amount must be positive');
      return result;
    } catch (err) {
      if (err instanceof ChallengeError) throw err;
      invalid(`Cannot parse amount '${trimmed}' as integer base units`);
    }
  }

  invalid('Unsupported amount type');
}

export interface ParseOptions {
  /** Token metadata source; defaults to the mainnet registry. */
  tokenLookup?: TokenLookup;
  /** Network/chain assumed when the challenge omits them. */
  defaultNetwork?: string;
  defaultChainId?: number;
}

type HeaderInput = Record<string, string | string[] | undefined> | Headers | Array<[string, string]> | undefined | null;

export class ChallengeParser {
  /** Normalizes varied header input representations into a lowercased Record<string, string>. */
  public static normalizeHeaders(headers?: HeaderInput): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;

    // Arrays first: an entries array also has forEach, but its callback passes (entry, index).
    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const [k, v] = entry;
          if (typeof k === 'string' && typeof v === 'string') result[k.toLowerCase()] = v;
        }
      }
      return result;
    }

    const maybeForEach = headers as { forEach?: unknown };
    if (typeof maybeForEach.forEach === 'function') {
      (headers as Headers).forEach((value: string, key: string) => {
        if (typeof key === 'string' && typeof value === 'string') result[key.toLowerCase()] = value;
      });
      return result;
    }

    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') result[key.toLowerCase()] = value;
        else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
          result[key.toLowerCase()] = (value as string[]).join(', ');
        }
      }
    }

    return result;
  }

  /**
   * Main entrypoint: parses an HTTP 402 challenge from headers and an optional response body.
   * Cascades: RFC 7807 JSON body -> RFC 7235 WWW-Authenticate -> X-Payment-* headers.
   * Throws ChallengeError when required parameters are missing or inconsistent.
   */
  public static parse(headers?: HeaderInput, body?: unknown, opts: ParseOptions = {}): ParsedPaymentChallenge {
    const lookup = opts.tokenLookup ?? registryTokenLookup('mainnet');
    const fallback = {
      network: opts.defaultNetwork ?? 'quai-cyprus1',
      chainId: opts.defaultChainId ?? NETWORK_CHAIN_IDS[opts.defaultNetwork ?? 'quai-cyprus1'] ?? 9,
    };
    const headerMap = ChallengeParser.normalizeHeaders(headers);

    let parsedBody: unknown = body;
    if (typeof body === 'string') {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = undefined;
      }
    }

    // Tier 1: RFC 7807 problem-details JSON body.
    if (parsedBody && typeof parsedBody === 'object') {
      const b = parsedBody as Record<string, unknown>;

      // 1A: nested payment object (DarkCircle canonical structure, also used by buildTributeChallenge).
      if (b.payment && typeof b.payment === 'object') {
        const p = b.payment as Record<string, unknown>;
        const recipientRaw = p.recipient ?? p.recipientAddress ?? p.destination;
        const invoiceId = p.invoiceId ?? p.id;
        const rawAmount = p.amount;

        if (recipientRaw && invoiceId && rawAmount !== undefined && rawAmount !== null) {
          const tokenField = p.token;
          const tokenAddress = (
            typeof tokenField === 'string'
              ? tokenField
              : ((tokenField as Record<string, unknown> | undefined)?.address as string | undefined) ?? ''
          ).toLowerCase();
          const tokenObj = typeof tokenField === 'object' && tokenField !== null ? (tokenField as Record<string, unknown>) : undefined;
          const { symbol: tokenSymbol, decimals: tokenDecimals } = resolveTokenMeta(
            tokenAddress,
            tokenObj?.symbol as string | undefined,
            tokenObj?.decimals,
            lookup
          );
          const amount = parseAmountToBaseUnits(rawAmount, tokenDecimals);
          const recipientAddress = String(recipientRaw).toLowerCase();
          const chain = resolveChain(p.network as string | undefined, p.chainId, fallback);

          return {
            scheme: String(p.scheme ?? p.protocol ?? 'x402'),
            invoiceId: String(invoiceId),
            chainId: chain.chainId,
            network: chain.network,
            tokenAddress: tokenAddress || NATIVE_QUAI,
            tokenSymbol,
            tokenDecimals,
            amount,
            recipientAddress,
            expiresAt: Number(p.expiresAt ?? 0),
            targetResource: String(b.instance ?? ''),
            proofType: String(p.proofType ?? 'tx_receipt'),
            maxFee: p.maxFee ? BigInt(p.maxFee as string) : undefined,
            memo: p.memo as string | undefined,
            callData: p.callData as string | undefined,
          };
        }
      }

      // 1B: flat RFC 7807 problem details.
      const flatRecipient = b.recipient ?? b.recipientAddress;
      const flatInvoiceId = b.invoiceId;
      const flatAmount = b.amount;

      if (flatRecipient && flatInvoiceId && flatAmount !== undefined && flatAmount !== null) {
        const tokenAddress = String(b.token ?? b.tokenAddress ?? '').toLowerCase();
        const { symbol: tokenSymbol, decimals } = resolveTokenMeta(
          tokenAddress,
          b.tokenSymbol as string | undefined,
          b.tokenDecimals,
          lookup
        );
        const amount = parseAmountToBaseUnits(flatAmount, decimals);
        const recipientAddress = String(flatRecipient).toLowerCase();
        const chain = resolveChain(b.network as string | undefined, b.chainId, fallback);

        return {
          scheme: String(b.scheme ?? 'x402'),
          invoiceId: String(flatInvoiceId),
          chainId: chain.chainId,
          network: chain.network,
          tokenAddress: tokenAddress || NATIVE_QUAI,
          tokenSymbol,
          tokenDecimals: decimals,
          amount,
          recipientAddress,
          expiresAt: Number(b.expiresAt ?? 0),
          targetResource: String(b.instance ?? b.targetResource ?? ''),
          proofType: String(b.proofType ?? 'tx_receipt'),
          maxFee: b.maxFee ? BigInt(b.maxFee as string) : undefined,
          memo: (b.memo ?? b.detail) as string | undefined,
          callData: b.callData as string | undefined,
        };
      }
    }

    // Tier 2: RFC 7235 WWW-Authenticate header fallback.
    const authHeader = headerMap['www-authenticate'];
    if (authHeader && authHeader.toLowerCase().startsWith('x402')) {
      const params: Record<string, string> = {};
      const paramRegex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/g;
      let match: RegExpExecArray | null;

      while ((match = paramRegex.exec(authHeader)) !== null) {
        const key = match[1];
        if (!key) continue;
        params[key.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
      }

      const recipient = params.recipient ?? params.recipientaddress;
      const invoiceId = params.invoiceid;
      const rawAmount = params.amount;

      if (recipient && invoiceId && rawAmount) {
        const tokenAddress = (params.token ?? params.tokenaddress ?? '').toLowerCase();
        const { symbol: tokenSymbol, decimals } = resolveTokenMeta(
          tokenAddress,
          params.tokensymbol,
          params.tokendecimals,
          lookup
        );
        const amount = parseAmountToBaseUnits(rawAmount, decimals);
        const chain = resolveChain(params.network, params.chainid, fallback);

        return {
          scheme: params.scheme ?? 'x402',
          invoiceId,
          chainId: chain.chainId,
          network: chain.network,
          tokenAddress: tokenAddress || NATIVE_QUAI,
          tokenSymbol,
          tokenDecimals: decimals,
          amount,
          recipientAddress: recipient.toLowerCase(),
          expiresAt: Number(params.expiresat ?? 0),
          targetResource: params.resource ?? '',
          proofType: params.prooftype ?? 'tx_receipt',
          maxFee: params.maxfee ? BigInt(params.maxfee) : undefined,
          memo: params.memo,
          callData: params.calldata,
        };
      }
    }

    // Tier 3: X-Payment-* headers fallback.
    const xRecipient = headerMap['x-payment-recipient'];
    const xAmount = headerMap['x-payment-amount'];
    const xInvoiceId = headerMap['x-payment-invoice-id'];

    if (xRecipient && xAmount && xInvoiceId) {
      const tokenAddress = (headerMap['x-payment-token'] ?? '').toLowerCase();
      const { symbol: tokenSymbol, decimals } = resolveTokenMeta(
        tokenAddress,
        headerMap['x-payment-token-symbol'],
        headerMap['x-payment-token-decimals'],
        lookup
      );
      const amount = parseAmountToBaseUnits(xAmount, decimals);
      const rawNetwork = headerMap['x-payment-network'];
      const numericNetwork = rawNetwork !== undefined && /^\d+$/.test(rawNetwork.trim());
      const chain = resolveChain(
        numericNetwork ? undefined : rawNetwork,
        headerMap['x-payment-chain-id'] ?? (numericNetwork ? rawNetwork : undefined),
        fallback
      );

      return {
        scheme: headerMap['x-payment-scheme'] ?? 'x402-v1',
        invoiceId: xInvoiceId,
        chainId: chain.chainId,
        network: chain.network,
        tokenAddress: tokenAddress || NATIVE_QUAI,
        tokenSymbol,
        tokenDecimals: decimals,
        amount,
        recipientAddress: xRecipient.toLowerCase(),
        expiresAt: Number(headerMap['x-payment-expires-at'] ?? 0),
        targetResource: headerMap['x-payment-resource'] ?? '',
        proofType: headerMap['x-payment-proof-type'] ?? 'tx_receipt',
        maxFee: headerMap['x-payment-max-fee'] ? BigInt(headerMap['x-payment-max-fee']) : undefined,
        memo: headerMap['x-payment-memo'],
        callData: headerMap['x-payment-calldata'],
      };
    }

    invalid('Missing required challenge parameters');
  }

  /** Authorization header for the retry: x402 invoice="...", proof="<txHash>"[, relayer="..."]. */
  public static formatAuthorizationHeader(invoiceId: string, proof: string, relayerAddress?: string): string {
    if (relayerAddress) return `x402 invoice="${invoiceId}", proof="${proof}", relayer="${relayerAddress}"`;
    return `x402 invoice="${invoiceId}", proof="${proof}"`;
  }

  /** X-Payment-* and Authorization headers for the retry request after paying. */
  public static formatPaymentProofHeaders(
    invoiceId: string,
    proof: string,
    relayerAddress?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: ChallengeParser.formatAuthorizationHeader(invoiceId, proof, relayerAddress),
      'X-Payment-Invoice-Id': invoiceId,
      'X-Payment-Proof': proof,
    };
    if (relayerAddress) headers['X-Payment-Relayer'] = relayerAddress;
    return headers;
  }

  /** Whether an HTTP status / header set constitutes a payment challenge. */
  public static isPaymentRequired(status: number, headers?: HeaderInput): boolean {
    if (status === 402) return true;
    if (!headers) return false;
    const headerMap = ChallengeParser.normalizeHeaders(headers);
    if (headerMap['x-payment-required'] === 'true') return true;
    const auth = headerMap['www-authenticate'];
    return !!auth && auth.toLowerCase().startsWith('x402');
  }
}

/** What a challenge must satisfy before the Tribute page offers to pay it. */
export function validateChallenge(
  challenge: ParsedPaymentChallenge,
  network: NetworkConfig,
  now: number = Math.floor(Date.now() / 1000)
): string[] {
  const problems: string[] = [];
  if (challenge.chainId !== network.chainId) {
    problems.push(`This invoice is for chain ${challenge.chainId}; the wallet is on ${network.label} (chain ${network.chainId}).`);
  }
  if (challenge.expiresAt !== 0 && challenge.expiresAt <= now) {
    problems.push('This invoice has expired.');
  }
  const recipient = checkAddress(challenge.recipientAddress, network.addressRule);
  if (!recipient.ok) problems.push(`Recipient: ${recipient.error ?? 'invalid address'}`);
  if (challenge.tokenAddress !== NATIVE_QUAI) {
    const token = checkAddress(challenge.tokenAddress, network.addressRule);
    if (!token.ok) problems.push(`Token: ${token.error ?? 'invalid address'}`);
  }
  if (challenge.amount <= 0n) problems.push('The amount must be more than zero.');
  return problems;
}

export interface TributeChallengeInput {
  network: NetworkConfig;
  /** Guild name, for the human-readable detail line. */
  guildName: string;
  /** The guild contract, which receives native QUAI via payTribute. */
  treasury: string;
  amount: bigint;
  invoiceId: string;
  resourceUri: string;
  createdAt: number;
  expiresAt: number;
  memo?: string;
}

export interface TributeChallengeBody {
  type: string;
  title: string;
  status: 402;
  detail: string;
  instance: string;
  payment: {
    protocol: 'x402';
    version: '1.0.0';
    scheme: 'quai_native_tribute';
    invoiceId: string;
    network: string;
    chainId: number;
    token: { address: string; symbol: string; decimals: number };
    amount: string;
    recipient: string;
    callData: string;
    createdAt: number;
    expiresAt: number;
    proofType: 'tx_receipt';
    memo?: string;
  };
}

/**
 * Renders a tribute invoice as an x402 challenge (headers + RFC 7807 body), the mirror image of
 * ChallengeParser.parse: a guild-facing service (a gate, a bot, a shop) serves this from a 402
 * response and the Tribute page pays it without any further agreement.
 *
 * The payment is native QUAI to the guild contract, and callData is payTribute(invoiceId), so
 * paying the invoice writes the invoice id into the guild's TributeReceived event log: the event
 * is the receipt, and the proof headers reference the same transaction hash.
 */
export function buildTributeChallenge(input: TributeChallengeInput): {
  headers: Record<string, string>;
  body: TributeChallengeBody;
} {
  const network = input.network;
  const pretty = formatTokenAmount(input.amount, network.currency.decimals);
  const callData = encodeTribute(input.invoiceId);

  const headers: Record<string, string> = {
    'WWW-Authenticate':
      `x402 scheme="quai_native_tribute", network="${network.x402NetworkId}", chainId="${network.chainId}", ` +
      `token="${NATIVE_QUAI}", recipient="${input.treasury}", amount="${input.amount.toString()}", ` +
      `invoiceId="${input.invoiceId}", expiresAt="${input.expiresAt}", proofType="tx_receipt", callData="${callData}"`,
    'X-Payment-Required': 'true',
    'X-Payment-Scheme': 'quai_native_tribute',
    'X-Payment-Network': network.x402NetworkId,
    'X-Payment-Chain-Id': String(network.chainId),
    'X-Payment-Token': NATIVE_QUAI,
    'X-Payment-Token-Symbol': network.currency.symbol,
    'X-Payment-Token-Decimals': String(network.currency.decimals),
    'X-Payment-Recipient': input.treasury,
    'X-Payment-Amount': input.amount.toString(),
    'X-Payment-Invoice-Id': input.invoiceId,
    'X-Payment-Expires-At': String(input.expiresAt),
    'X-Payment-Resource': input.resourceUri,
    'X-Payment-CallData': callData,
  };

  const body: TributeChallengeBody = {
    type: 'https://darkorder.guild/errors/payment-required',
    title: 'Payment Required',
    status: 402,
    detail: `Tribute of ${pretty} ${network.currency.symbol} to the "${input.guildName}" treasury on ${network.label}.`,
    instance: input.resourceUri,
    payment: {
      protocol: 'x402',
      version: '1.0.0',
      scheme: 'quai_native_tribute',
      invoiceId: input.invoiceId,
      network: network.x402NetworkId,
      chainId: network.chainId,
      token: { address: NATIVE_QUAI, symbol: network.currency.symbol, decimals: network.currency.decimals },
      amount: input.amount.toString(),
      recipient: input.treasury,
      callData,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      proofType: 'tx_receipt',
      ...(input.memo ? { memo: input.memo } : {}),
    },
  };

  return { headers, body };
}
