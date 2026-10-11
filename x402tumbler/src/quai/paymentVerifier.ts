/**
 * DarkCircle: On-chain x402 payment verification for Quai
 * File: src/quai/paymentVerifier.ts
 *
 * Verifies that a transaction hash presented as x402 proof-of-payment really moved `amount`
 * of a registered WQUAI/WQI contract to the invoice's ephemeral address on the configured zone.
 * It reads the receipt's ERC-20 Transfer log rather than trusting the transaction's own fields,
 * because the payer of a shielded settlement is the relayer, not the treasury.
 *
 * Confirmations default to 2: the public Orchard RPC is load-balanced over nodes that were ~30
 * blocks apart and reorged ~25 blocks, so a single read of a fresh receipt is not final.
 */

import { id as keccakId } from "ethers";
import { toQuaiChecksum } from "./address.ts";
import type { QuaiRpcClient } from "./rpc.ts";
import type { QuaiToken } from "./tokens.ts";

export const TRANSFER_TOPIC = keccakId("Transfer(address,address,uint256)");

export type PaymentVerificationCode =
  | "OK"
  | "RECEIPT_NOT_FOUND"
  | "TX_REVERTED"
  | "NO_MATCHING_TRANSFER"
  | "AMOUNT_TOO_LOW"
  | "INSUFFICIENT_CONFIRMATIONS";

export interface PaymentVerification {
  ok: boolean;
  code: PaymentVerificationCode;
  transferred?: bigint;
  payer?: string;
  blockNumber?: number;
  confirmations?: number;
}

export interface VerifyPaymentRequest {
  txHash: string;
  token: QuaiToken;
  recipient: string;
  minAmount: bigint;
  minConfirmations?: number;
}

function topicToAddress(topic: string): string {
  return toQuaiChecksum("0x" + topic.slice(-40));
}

/** A receipt's status as nodes report it: "0x1" (JSON-RPC), or 1 / "1" from some clients. Anything else failed. */
export function receiptSucceeded(status: unknown): boolean {
  return status === "0x1" || status === 1 || status === "1";
}

/** Chain-agnostic receipt shape: what a Quai zone RPC and the simulated ledger both provide. */
export interface ReceiptLike {
  ok: boolean;
  blockNumber: number;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export interface EvaluateReceiptParams {
  receipt: ReceiptLike | null;
  headBlock: number;
  token: QuaiToken | { address: string };
  recipient: string;
  minAmount: bigint;
  minConfirmations?: number;
}

/**
 * Judges a receipt against an invoice: the transaction must have succeeded, must contain ERC-20
 * Transfer logs of the invoice token to the invoice payee summing to at least the required amount, and
 * must be confirmed. Amounts come from the logs, never from the caller or from a balance.
 */
export function evaluateTransferReceipt(p: EvaluateReceiptParams): PaymentVerification {
  if (!p.receipt) return { ok: false, code: "RECEIPT_NOT_FOUND" };
  if (!p.receipt.ok) return { ok: false, code: "TX_REVERTED" };

  const tokenAddr = p.token.address.toLowerCase();
  const recipientAddr = toQuaiChecksum(p.recipient).toLowerCase();
  let transferred = 0n;
  let payer: string | undefined;
  for (const log of p.receipt.logs) {
    if (typeof log?.address !== "string" || log.address.toLowerCase() !== tokenAddr) continue;
    if (!Array.isArray(log.topics) || log.topics.length !== 3 || String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    // A Transfer's value is one 32-byte word; anything else is not a transfer we can count (and must not
    // crash the verification of an otherwise valid receipt).
    if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[1])) || !/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[2]))) continue;
    if (topicToAddress(log.topics[2]).toLowerCase() !== recipientAddr) continue;
    transferred += BigInt(log.data);
    payer ??= topicToAddress(log.topics[1]);
  }
  if (transferred === 0n) return { ok: false, code: "NO_MATCHING_TRANSFER" };

  const blockNumber = p.receipt.blockNumber;
  const confirmations = p.headBlock - blockNumber + 1;
  const base = { transferred, payer, blockNumber, confirmations };
  if (transferred < p.minAmount) return { ok: false, code: "AMOUNT_TOO_LOW", ...base };
  if (confirmations < (p.minConfirmations ?? 2)) return { ok: false, code: "INSUFFICIENT_CONFIRMATIONS", ...base };
  return { ok: true, code: "OK", ...base };
}

export class QuaiPaymentVerifier {
  private readonly client: QuaiRpcClient;

  constructor(client: QuaiRpcClient) {
    this.client = client;
  }

  public async verify(req: VerifyPaymentRequest): Promise<PaymentVerification> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(req.txHash)) {
      return { ok: false, code: "RECEIPT_NOT_FOUND" };
    }
    await this.client.assertZone();
    const raw = await this.client.getTransactionReceipt(req.txHash);
    const receipt: ReceiptLike | null = raw ? { ok: receiptSucceeded(raw.status), blockNumber: Number(raw.blockNumber), logs: raw.logs ?? [] } : null;
    return evaluateTransferReceipt({
      receipt,
      headBlock: receipt ? await this.client.blockNumber() : 0,
      token: req.token,
      recipient: req.recipient,
      minAmount: req.minAmount,
      minConfirmations: req.minConfirmations
    });
  }
}
