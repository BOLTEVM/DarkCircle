import type { QuaiNetwork } from "../quai/networks.ts";
/**
 * DarkCircle Protocol: Inbound Merchant Privacy Gateway
 * Gateway Subsystem Type Definitions & Interface Contracts
 */

import type { DecryptedNotePayload, EncryptedNotePayload } from "../types/audit.ts";
import type { Point } from "../types/crypto.ts";
import type { ShieldedUTXO } from "../types/sim.ts";
import type { IMerchantGateway } from "../server/resourceServer.ts";

/**
 * Invoice lifecycle statuses.
 */
export type InvoiceStatus = "PENDING" | "SETTLED" | "SWEPT" | "EXPIRED";

/**
 * Inbound payment invoice record tracked in the registry.
 */
export interface InvoiceRecord {
  invoiceId: string;
  resourceUri: string;
  ephemeralAddress: string;
  ephemeralPrivateKey: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  requiredAmount: bigint;
  createdAt: number;
  expiresAt: number;
  status: InvoiceStatus;
  settlementTxHash?: string;
  settledAt?: number;
  /** Address that funded the payment, read from the Transfer log (the PPOI/sanctions origin). */
  payerAddress?: string;
  sweepTxHash?: string;
  sweptAt?: number;
  /** The payment was proven only after the invoice's TTL (it is honoured: the customer paid). */
  settledAfterExpiry?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Ephemeral address derivation algorithm modes.
 *
 * "quai"      - HMAC-seeded secp256k1 key, ground until its address is in the target Quai zone on the
 *               Quai ledger (the only mode that yields addresses a zone node accepts). Default.
 * "secp256k1" - plain HMAC-derived secp256k1 key; the address lands in a random zone.
 * "fast"      - SHA-256 truncation with NO corresponding private key. Simulation only: never usable on a chain.
 */
export type EphemeralDerivationMode = "quai" | "secp256k1" | "fast";

/**
 * Ephemeral key pair produced per invoice.
 */
export interface EphemeralKeyPair {
  address: string;
  privateKey: string;
  invoiceId?: string;
  mode?: EphemeralDerivationMode;
  derivedAt?: number;
}

/**
 * Options for stealth / ephemeral key derivation.
 */
export interface EphemeralDerivationOptions {
  mode?: EphemeralDerivationMode;
  /** Target zone for "quai" mode (default Cyprus-1). */
  zone?: import("../quai/networks.ts").QuaiZone;
  domainSeparator?: string;
  salt?: string | Buffer;
}

/**
 * Result returned upon verifying payment credentials.
 */
export interface PaymentVerificationResult {
  /** True when the funds came from the shielded pool contract (the payer is not the payee's counterparty). */
  payerIsPool?: boolean;
  success: boolean;
  error?: string;
  receiptId?: string;
  statusCode: number;
  invoice?: InvoiceRecord;
}

/**
 * Receipt returned upon sweeping ephemeral balances into the Shielded pool.
 */
export interface SweepResult {
  /**
   * How the pool was authorised to pull the funds: "permit" = the payee key signed an EIP-2612 permit
   * that the relayer submitted (no gas needed at the payee address; WQI only), "allowance" = the payee
   * granted an allowance (needs gas at the payee address), "bookkeeping" = trusted-harness pool.
   */
  sweepMethod?: "permit" | "allowance" | "bookkeeping";
  sweepTxHash: string;
  sweptAmount: bigint;
  shieldedCommitment: bigint;
  invoiceId?: string;
  tokenAddress?: string;
  grossAmount?: bigint;
  feeAmount?: bigint;
  leafIndex?: number;
  treeRoot?: bigint;
  blockNumber?: number;
  ephemeralAddress?: string;
  relayerAddress?: string;
  timestamp?: number;
  status?: "confirmed";
  note?: DecryptedNotePayload;
  encryptedNote?: EncryptedNotePayload;
}

export type SweepReceipt = SweepResult;

/**
 * Summary generated from executing a batch sweep.
 */
export interface BatchSweepSummary {
  totalProcessed: number;
  successfulSweeps: number;
  failedSweeps: number;
  totalSweptAmount: bigint;
  receipts: SweepReceipt[];
  errors: Array<{ invoiceId: string; error: string }>;
  durationMs: number;
}

/**
 * Operating execution mode for the Sweeper.
 */
export type SweeperMode = "REALTIME" | "BATCH" | "MANUAL";

/**
 * Gas sponsorship strategy for sweeping ephemeral balances.
 */
export type GasSponsorshipMode = "DIRECT_SIMULATION" | "RELAYER_BROADCAST" | "PERMIT_SPONSORED";

/**
 * RFC 7807 compliant problem details payment challenge body.
 */
export interface PaymentChallengeBody {
  type: string;
  title: string;
  status: 402;
  detail: string;
  instance: string;
  payment: {
    protocol: string;
    version: string;
    invoiceId: string;
    network: string;
    chainId: number;
    token: {
      address: string;
      symbol: string;
      decimals: number;
    };
    amount: string;
    recipient: string;
    ephemeral: boolean;
    createdAt: number;
    expiresAt: number;
    proofType: string;
  };
}

/**
 * Payload returned when issuing a 402 Payment Required challenge.
 */
export interface PaymentChallengeResult {
  invoice: InvoiceRecord;
  challengeHeaders: Record<string, string>;
  challengeBody: PaymentChallengeBody;
}

export type PaymentChallengePayload = PaymentChallengeResult;

/**
 * Configuration options for the Inbound Merchant Gateway.
 */
export interface InboundGatewayOptions {
  /**
   * "verified" (default): a payment proof is a transaction hash whose receipt is read from the chain and
   * must show Transfer logs of the invoice token to the invoice address for at least the invoiced
   * amount. "trusted-harness": legacy behaviour that accepts an unknown hash if the address holds
   * enough tokens; test scaffolding only, reported as unsafe by status() and the checklist.
   */
  trustMode?: "verified" | "trusted-harness";
  /** Live receipt source (for example a Quai zone RPC) used by verifyPaymentAsync. */
  receiptSource?: import("./paymentEvidence.ts").AsyncReceiptSource;
  /** Confirmations required before a payment is accepted (default 1 in-memory; use 2+ on Quai). */
  minConfirmations?: number;
  /** Quai network the gateway issues invoices for (default Cyprus-1). Its zone bounds ephemeral addresses. */
  network?: QuaiNetwork;
  masterMerchantKey: string;
  corporate0zkAddress: string;
  corporateNpk: bigint;
  blockchain: any;
  pool: any;
  relayer?: any;
  journal?: any;
  corporateVpk?: Point;
  treasuryLedger?: ShieldedUTXO[];
  defaultTtlSeconds?: number;
  defaultTokenSymbol?: string;
  defaultTokenDecimals?: number;
  autoSweep?: boolean;
  sweeperMode?: SweeperMode;
  gasSponsorshipMode?: GasSponsorshipMode;
}

/**
 * Configuration options for SweeperWorker.
 */
export interface SweeperConfig {
  registry: any;
  pool: any;
  corporateNpk: bigint;
  corporate0zkAddress?: string;
  corporateVpk?: Point;
  blockchain?: any;
  relayer?: any;
  journal?: any;
  treasuryLedger?: ShieldedUTXO[];
  sanctionsRegistry?: { isSanctioned(address: string): boolean };
  mode?: SweeperMode;
  gasSponsorshipMode?: GasSponsorshipMode;
  minSweepThreshold?: bigint;
  batchIntervalMs?: number;
  maxBatchSize?: number;
  sweepFeeUnits?: bigint;
}

/**
 * Blockchain ledger abstraction required for settlement verification.
 */
export interface ISettlementBlockchain {
  currentBlockNumber: number;
  getTokenBalance(token: string, account: string): bigint;
  transferToken?(token: string, from: string, to: string, amount: bigint): boolean;
  transactions?: Map<string, any>;
  receipts?: Map<string, any>;
  blocks?: Array<{ number: number; timestamp: number; transactions: any[] }>;
}

/**
 * Railgun smart wallet pool abstraction required for shielding.
 */
export interface ISweepPool {
  contractAddress: string;
  /** True for a verified pool, which pulls funds itself; false for a trusted harness that only books notes. */
  verified?: boolean;
  shield(
    token: string,
    amount: bigint,
    recipientNpk: bigint,
    blinding: bigint,
    memo?: string,
    depositorAddress?: string,
    originAddress?: string
  ): {
    commitment: bigint;
    leafIndex: number;
    root?: bigint;
    treeRoot?: bigint;
    note?: any;
    /** The deposit time the pool recorded for this note (the PPOI lineage the note must carry). */
    depositTimestamp?: number;
  };
}


/**
 * Middleware configuration options for HTTP frameworks.
 */
export interface GatewayMiddlewareOptions {
  protectedPrefixes?: string[];
  defaultAmount?: bigint;
  defaultTokenAddress?: string;
  defaultTokenSymbol?: string;
  defaultTokenDecimals?: number;
  defaultTtlSeconds?: number;
  autoSweep?: boolean;
}
