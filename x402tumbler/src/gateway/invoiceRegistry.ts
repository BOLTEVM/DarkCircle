/**
 * DarkCircle Protocol: Inbound Merchant Privacy Gateway
 * Invoice Registry & On-Chain Settlement Verifier
 *
 * Implements the lifecycle state machine for incoming payment challenges:
 *   PENDING -> SETTLED -> SWEPT
 *          \-> EXPIRED
 *
 * Enforces authentic on-chain settlement validation, idempotency,
 * and replay attack defenses across the invoice registry.
 */

import crypto from "node:crypto";
import type {
  InvoiceRecord,
  InvoiceStatus,
  PaymentVerificationResult,
  ISettlementBlockchain,
  EphemeralDerivationMode
} from "./types.ts";
import {
  EphemeralAddressGenerator,
  zeroizeEphemeralKey
} from "./ephemeral.ts";
import { DEFAULT_QUAI_NETWORK, type QuaiNetwork } from "../quai/networks.ts";
import { evaluateTransferReceipt, type PaymentVerification } from "../quai/paymentVerifier.ts";
import { LedgerReceiptSource, type AsyncReceiptSource } from "./paymentEvidence.ts";
import { WQUAI, WQUAI_DECIMALS } from "../quai/tokens.ts";

export class InvoiceRegistry extends Map<string, InvoiceRecord> {
  public usedReceiptRegistry: Set<string> = new Set();
  public blockchain: ISettlementBlockchain;
  public masterMerchantKey: string;
  public network: QuaiNetwork;
  /** "ledger": receipts and Transfer logs decide. "trusted-harness": legacy balance check (unsafe). */
  public readonly verification: "ledger" | "trusted-harness";
  public readonly minConfirmations: number;
  public maxInvoices: number = 50_000;
  /**
   * Whether `blockchain` reports the real balances of payee addresses. Pruning deletes an invoice's record
   * (and with it the only copy of its invoice id, from which the payee key is derived), so it only ever
   * prunes an invoice whose address is PROVEN empty; when balances come from somewhere else (a live zone
   * verified through a receipt source), nothing can be proven and nothing is pruned.
   */
  public readonly balanceAuthoritative: boolean;
  private addressGenerator: EphemeralAddressGenerator;

  constructor(
    masterMerchantKey: string,
    blockchain: ISettlementBlockchain,
    options?: {
      derivationMode?: EphemeralDerivationMode;
      network?: QuaiNetwork;
      verification?: "ledger" | "trusted-harness";
      minConfirmations?: number;
      balanceAuthoritative?: boolean;
    }
  ) {
    super();
    this.verification = options?.verification ?? "ledger";
    this.minConfirmations = options?.minConfirmations ?? 1;
    this.balanceAuthoritative = options?.balanceAuthoritative ?? true;
    this.masterMerchantKey = masterMerchantKey;
    this.blockchain = blockchain;
    this.network = options?.network ?? DEFAULT_QUAI_NETWORK;
    this.addressGenerator = new EphemeralAddressGenerator(
      masterMerchantKey,
      options?.derivationMode ?? "quai",
      undefined,
      this.network.zone
    );
  }

  /**
   * Creates and registers a new pending payment invoice with a unique ephemeral destination.
   */
  public createInvoice(
    resourceUri: string,
    amount: bigint,
    tokenAddress: string,
    tokenSymbol: string = WQUAI.symbol,
    tokenDecimals: number = WQUAI_DECIMALS,
    ttlSeconds: number = 900,
    metadata?: Record<string, unknown>
  ): InvoiceRecord {
    // Unauthenticated callers can trigger invoice creation (each request without a proof gets a 402),
    // so the registry is bounded; expired invoices are dropped first.
    if (this.size >= this.maxInvoices) {
      this.pruneExpired(0);
      if (this.size >= this.maxInvoices) {
        throw new Error("ERR_INVOICE_CAPACITY: too many open invoices");
      }
    }
    const invoiceId = `inv_${crypto.randomBytes(12).toString("hex")}`;
    const { address, privateKey } = this.addressGenerator.generate(invoiceId);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlSeconds;

    const safeTokenAddress =
      typeof tokenAddress === "string" && tokenAddress.trim() !== "" && tokenAddress !== "true"
        ? tokenAddress.trim()
        : WQUAI.address;

    const invoice: InvoiceRecord = {
      invoiceId,
      resourceUri,
      ephemeralAddress: address,
      ephemeralPrivateKey: privateKey,
      tokenAddress: safeTokenAddress.toLowerCase(),
      tokenSymbol,
      tokenDecimals,
      requiredAmount: amount,
      createdAt: now,
      expiresAt,
      status: "PENDING",
      metadata
    };

    this.set(invoiceId, invoice);
    return invoice;
  }

  /**
   * Verifies on-chain settlement against an invoice record.
   *
   * Enforces:
   * - 404 ERR_INVOICE_NOT_FOUND if invoice does not exist
   * - 410 ERR_INVOICE_EXPIRED if past TTL
   * - 200 Idempotent success if re-presenting valid proof for settled/swept invoice
   * - 409 ERR_REPLAY_DETECTED if txHash was already utilized for another invoice
   * - 402 ERR_TRANSACTION_REVERTED if on-chain transaction failed
   * - 402 ERR_RECIPIENT_MISMATCH if transaction paid a different address
   * - 402 ERR_TOKEN_MISMATCH if transaction used a different token
   * - 402 ERR_UNDERPAYMENT if effective balance is less than required amount
   */
  /**
   * Stage 1 of verification: invoice lookup, expiry, idempotency and replay. Returns a final result
   * when the request can be answered without looking at the chain.
   */
  private precheck(
    invoiceId: string,
    txHash: string
  ): { done: PaymentVerificationResult } | { invoice: InvoiceRecord; normTxHash: string; now: number; expired: boolean } {
    const invoice = this.get(invoiceId);
    if (!invoice) {
      return { done: { success: false, error: "ERR_INVOICE_NOT_FOUND", statusCode: 404 } };
    }

    const now = Math.floor(Date.now() / 1000);
    const expired = now > invoice.expiresAt;
    if (typeof txHash !== "string" || txHash.length > 200) {
      return { done: { success: false, error: expired ? "ERR_INVOICE_EXPIRED" : "ERR_TX_NOT_FOUND", statusCode: expired ? 410 : 402, invoice } };
    }
    const normTxHash = txHash.toLowerCase();

    // A settled or swept invoice stays settled or swept. Expiry ends the access its payment bought; it never
    // un-settles the payment: the sweeper only sweeps SETTLED invoices, so flipping one to EXPIRED would
    // strand the customer's funds on the payee address, and pruning would then delete the invoice id that
    // address's key is derived from.
    if (invoice.status === "SETTLED" || invoice.status === "SWEPT") {
      if (invoice.settlementTxHash?.toLowerCase() !== normTxHash) {
        return { done: { success: false, error: "ERR_INVOICE_ALREADY_SETTLED", statusCode: 409, invoice } };
      }
      if (expired) return { done: { success: false, error: "ERR_INVOICE_EXPIRED", statusCode: 410, invoice } };
      // Idempotency: repeated presentation of the proof that settled it (the access pass it bought)
      return { done: { success: true, receiptId: `rct_${invoice.invoiceId}`, statusCode: 200, invoice } };
    }

    // Replay attack defense: transaction hash cannot be bound to multiple distinct invoices
    if (this.usedReceiptRegistry.has(normTxHash)) {
      return { done: { success: false, error: "ERR_REPLAY_DETECTED", statusCode: 409, invoice } };
    }

    // An expired, unpaid invoice: only chain evidence can still settle it (a payment made in time whose
    // proof arrived late, which on Quai's block times is ordinary). The trusted harness has no such evidence.
    if (expired && this.verification === "trusted-harness") {
      invoice.status = "EXPIRED";
      return { done: { success: false, error: "ERR_INVOICE_EXPIRED", statusCode: 410, invoice } };
    }
    return { invoice, normTxHash, now, expired };
  }

  private static readonly VERIFY_ERRORS: Record<string, { error: string; statusCode: number }> = {
    RECEIPT_NOT_FOUND: { error: "ERR_TX_NOT_FOUND", statusCode: 402 },
    TX_REVERTED: { error: "ERR_TRANSACTION_REVERTED", statusCode: 402 },
    NO_MATCHING_TRANSFER: { error: "ERR_RECIPIENT_MISMATCH", statusCode: 402 },
    AMOUNT_TOO_LOW: { error: "ERR_UNDERPAYMENT", statusCode: 402 },
    INSUFFICIENT_CONFIRMATIONS: { error: "ERR_PAYMENT_UNCONFIRMED", statusCode: 402 }
  };

  /** Final stage: mark the invoice settled and burn the transaction hash against replay. */
  private commit(
    invoice: InvoiceRecord,
    normTxHash: string,
    now: number,
    payer?: string,
    late = false
  ): PaymentVerificationResult {
    invoice.status = "SETTLED";
    invoice.settlementTxHash = normTxHash;
    invoice.settledAt = now;
    if (late) invoice.settledAfterExpiry = true;
    if (payer) invoice.payerAddress = payer.toLowerCase();
    this.usedReceiptRegistry.add(normTxHash);

    const receiptId = `rct_${crypto.randomBytes(12).toString("hex")}`;
    return { success: true, receiptId, statusCode: 200, invoice };
  }

  private fromVerification(
    invoice: InvoiceRecord,
    normTxHash: string,
    now: number,
    v: PaymentVerification,
    expired = false
  ): PaymentVerificationResult {
    if (!v.ok) {
      if (expired) {
        // No valid payment and past its TTL: the challenge is gone. The record stays (see pruneExpired).
        invoice.status = "EXPIRED";
        return { success: false, error: "ERR_INVOICE_EXPIRED", statusCode: 410, invoice };
      }
      const mapped = InvoiceRegistry.VERIFY_ERRORS[v.code] ?? { error: "ERR_PAYMENT_NOT_VERIFIED", statusCode: 402 };
      return { success: false, error: mapped.error, statusCode: mapped.statusCode, invoice };
    }
    return this.commit(invoice, normTxHash, now, v.payer, expired);
  }

  /**
   * Verifies on-chain settlement against an invoice record.
   *
   * In "ledger" mode (default) the proof is a transaction hash and the decision comes from that
   * transaction's receipt: it must have succeeded and contain Transfer logs of the invoice token to the
   * invoice's ephemeral address for at least the invoiced amount, with enough confirmations. Whatever
   * the caller says was sent (`amountSent`) is ignored, and so is the address's current balance.
   *
   *   404 ERR_INVOICE_NOT_FOUND | 410 ERR_INVOICE_EXPIRED | 409 ERR_REPLAY_DETECTED
   *   402 ERR_TX_NOT_FOUND | ERR_TRANSACTION_REVERTED | ERR_RECIPIENT_MISMATCH | ERR_UNDERPAYMENT
   *       | ERR_PAYMENT_UNCONFIRMED
   *   200 idempotent success when re-presenting the proof of a settled or swept invoice
   */
  public verifySettlement(
    invoiceId: string,
    txHash: string,
    _amountSent?: bigint
  ): PaymentVerificationResult {
    const pre = this.precheck(invoiceId, txHash);
    if ("done" in pre) return pre.done;
    const { invoice, normTxHash, now, expired } = pre;

    if (this.verification === "trusted-harness") {
      return this.verifyTrustedHarness(invoice, normTxHash, now, _amountSent);
    }

    const source = new LedgerReceiptSource(this.blockchain);
    const receipt = source.getReceipt(normTxHash);
    return this.fromVerification(
      invoice,
      normTxHash,
      now,
      evaluateTransferReceipt({
        receipt,
        headBlock: source.headBlock(),
        token: { address: invoice.tokenAddress },
        recipient: invoice.ephemeralAddress,
        minAmount: invoice.requiredAmount,
        minConfirmations: this.minConfirmations
      }),
      expired
    );
  }

  /** Same decision as verifySettlement, reading the receipt from a live (asynchronous) source. */
  public async verifySettlementAsync(
    invoiceId: string,
    txHash: string,
    source: AsyncReceiptSource
  ): Promise<PaymentVerificationResult> {
    const pre = this.precheck(invoiceId, txHash);
    if ("done" in pre) return pre.done;
    const { invoice, normTxHash, now, expired } = pre;

    let receipt = null;
    try {
      receipt = await source.getReceipt(normTxHash);
    } catch {
      return { success: false, error: "ERR_CHAIN_UNAVAILABLE", statusCode: 503, invoice };
    }
    let head = 0;
    if (receipt) {
      try {
        head = await source.headBlock();
      } catch {
        return { success: false, error: "ERR_CHAIN_UNAVAILABLE", statusCode: 503, invoice };
      }
    }
    return this.fromVerification(
      invoice,
      normTxHash,
      now,
      evaluateTransferReceipt({
        receipt,
        headBlock: head,
        token: { address: invoice.tokenAddress },
        recipient: invoice.ephemeralAddress,
        minAmount: invoice.requiredAmount,
        minConfirmations: this.minConfirmations
      }),
      expired
    );
  }

  /** Legacy behaviour: unknown hashes are accepted when the address holds enough tokens. Unsafe. */
  private verifyTrustedHarness(
    invoice: InvoiceRecord,
    normTxHash: string,
    now: number,
    amountSent?: bigint
  ): PaymentVerificationResult {
    if (this.blockchain.transactions && this.blockchain.transactions.has(normTxHash)) {
      const tx = this.blockchain.transactions.get(normTxHash);
      if (tx.status === "reverted") {
        return { success: false, error: "ERR_TRANSACTION_REVERTED", statusCode: 402, invoice };
      }
      if (tx.recipient && tx.recipient.toLowerCase() !== invoice.ephemeralAddress.toLowerCase()) {
        return { success: false, error: "ERR_RECIPIENT_MISMATCH", statusCode: 402, invoice };
      }
      if (tx.token && tx.token.toLowerCase() !== invoice.tokenAddress.toLowerCase()) {
        return { success: false, error: "ERR_TOKEN_MISMATCH", statusCode: 402, invoice };
      }
    }

    const onChainBalance = this.blockchain.getTokenBalance(invoice.tokenAddress, invoice.ephemeralAddress);
    const effectiveAmount = amountSent !== undefined ? amountSent : onChainBalance;
    if (effectiveAmount < invoice.requiredAmount) {
      return { success: false, error: "ERR_UNDERPAYMENT", statusCode: 402, invoice };
    }
    return this.commit(invoice, normTxHash, now);
  }

  /**
   * Transitions invoice to SWEPT status and securely zeroizes the ephemeral private key.
   */
  public markSwept(invoiceId: string, sweepTxHash: string): InvoiceRecord {
    const invoice = this.get(invoiceId);
    if (!invoice) {
      throw new Error("INVOICE_NOT_FOUND");
    }

    invoice.status = "SWEPT";
    invoice.sweepTxHash = sweepTxHash;
    invoice.sweptAt = Math.floor(Date.now() / 1000);
    zeroizeEphemeralKey(invoice);

    return invoice;
  }

  /**
   * Retrieves all currently pending invoices.
   */
  public getPendingInvoices(): InvoiceRecord[] {
    const list: InvoiceRecord[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const invoice of this.values()) {
      if (invoice.status === "PENDING" && now <= invoice.expiresAt) {
        list.push(invoice);
      }
    }
    return list;
  }

  /**
   * Retrieves all settled invoices awaiting sweep.
   */
  public getSettledInvoices(): InvoiceRecord[] {
    const list: InvoiceRecord[] = [];
    for (const invoice of this.values()) {
      if (invoice.status === "SETTLED") {
        list.push(invoice);
      }
    }
    return list;
  }

  /**
   * Retrieves all expired invoices.
   */
  public getExpiredInvoices(): InvoiceRecord[] {
    const list: InvoiceRecord[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const invoice of this.values()) {
      if (invoice.status === "EXPIRED" || (invoice.status === "PENDING" && now > invoice.expiresAt)) {
        list.push(invoice);
      }
    }
    return list;
  }

  /**
   * Retrieves all swept invoices.
   */
  public getSweptInvoices(): InvoiceRecord[] {
    const list: InvoiceRecord[] = [];
    for (const invoice of this.values()) {
      if (invoice.status === "SWEPT") {
        list.push(invoice);
      }
    }
    return list;
  }

  /** True only when the ledger this registry reads says the invoice's payee address holds none of its token. */
  private provenEmpty(invoice: InvoiceRecord): boolean {
    if (!this.balanceAuthoritative || typeof this.blockchain?.getTokenBalance !== "function") return false;
    try {
      return this.blockchain.getTokenBalance(invoice.tokenAddress, invoice.ephemeralAddress) === 0n;
    } catch {
      return false;
    }
  }

  /**
   * Prunes unpaid invoices that expired more than `gracePeriodSeconds` ago. Settled and swept invoices are
   * never pruned here, and neither is any invoice whose payee address might hold funds: a payment that
   * arrived late (or without its proof) is only recoverable through the invoice id its key derives from.
   */
  public pruneExpired(gracePeriodSeconds: number = 3600): number {
    const now = Math.floor(Date.now() / 1000);
    let pruned = 0;
    for (const [id, invoice] of this.entries()) {
      const unpaid = invoice.status === "EXPIRED" || invoice.status === "PENDING";
      if (unpaid && now > invoice.expiresAt + gracePeriodSeconds && this.provenEmpty(invoice)) {
        this.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
