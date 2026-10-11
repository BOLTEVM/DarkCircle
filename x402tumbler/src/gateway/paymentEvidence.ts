/**
 * DarkCircle Protocol: payment evidence sources
 *
 * Where a payment proof (a transaction hash) is checked. Both the in-memory ledger and a live Quai zone
 * expose the same thing: a receipt with success status, block number and logs, plus the chain head for
 * counting confirmations. The decision itself lives in evaluateTransferReceipt (quai/paymentVerifier.ts).
 */

import { QuaiRpcClient } from "../quai/rpc.ts";
import { receiptSucceeded, type ReceiptLike } from "../quai/paymentVerifier.ts";

export interface AsyncReceiptSource {
  getReceipt(txHash: string): Promise<ReceiptLike | null>;
  headBlock(): Promise<number>;
}

export interface SyncReceiptSource {
  getReceipt(txHash: string): ReceiptLike | null;
  headBlock(): number;
}

/** Reads receipts from the in-memory ledger (SimulatedBlockchain). */
export class LedgerReceiptSource implements SyncReceiptSource {
  private readonly chain: any;

  constructor(chain: any) {
    this.chain = chain;
  }

  public getReceipt(txHash: string): ReceiptLike | null {
    const r = this.chain?.receipts?.get?.(txHash.toLowerCase()) ?? this.chain?.receipts?.get?.(txHash);
    if (!r) return null;
    return {
      ok: r.status === 1,
      blockNumber: r.blockNumber,
      logs: (r.logs ?? []).map((l: any) => ({ address: l.address, topics: l.topics, data: l.data }))
    };
  }

  public headBlock(): number {
    return this.chain.currentBlockNumber;
  }
}

/** Reads receipts from a Quai zone through QuaiRpcClient (asserting zone and chain first). */
export class QuaiReceiptSource implements AsyncReceiptSource {
  private readonly client: QuaiRpcClient;

  constructor(client: QuaiRpcClient) {
    this.client = client;
  }

  public async getReceipt(txHash: string): Promise<ReceiptLike | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
    await this.client.assertZone();
    const raw = await this.client.getTransactionReceipt(txHash);
    if (!raw) return null;
    return { ok: receiptSucceeded(raw.status), blockNumber: Number(raw.blockNumber), logs: raw.logs ?? [] };
  }

  public async headBlock(): Promise<number> {
    return this.client.blockNumber();
  }
}
