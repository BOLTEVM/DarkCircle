import type { DecryptedNotePayload, JournalEntry, UTXOItem } from "../types/audit.ts";
import { WQUAI, WQUAI_DECIMALS, defaultQuaiTokenRegistry } from "../quai/tokens.ts";

export type { JournalEntry, UTXOItem };

/**
 * Double-Entry Accounting Journal Reconstructor for DarkCircle Shielded Operations
 * Enforces Fundamental Accounting Invariant: Debits === Credits,
 * and Treasury Reconciliation Invariant: Running Balance === Sum(Active UTXOs).
 *
 * One reconstructor accounts for exactly ONE asset (WQUAI or WQI): both have 18 decimals, so a
 * combined running balance would silently add two different currencies. The first token recorded
 * fixes the asset and any other token is refused (ERR_AUDIT_MIXED_ASSETS); keep one reconstructor
 * per asset and export each separately.
 */
export class AccountingJournalReconstructor {
  public entries: JournalEntry[] = [];
  public utxoMap: Map<string, UTXOItem> = new Map();
  public runningBalance: bigint = 0n;
  public corporate0zkAddress: string;
  public assetAddress: string = WQUAI.address;
  public assetSymbol: string = WQUAI.symbol;
  public decimals: number = WQUAI_DECIMALS;
  private assetFixed = false;

  constructor(corporate0zkAddress: string) {
    this.corporate0zkAddress = corporate0zkAddress;
  }

  /** Fixes the ledger's asset on first use and refuses a different token afterwards. */
  private bindAsset(tokenAddress: string | undefined): void {
    if (!tokenAddress) return;
    if (this.assetFixed) {
      if (tokenAddress.toLowerCase() !== this.assetAddress.toLowerCase()) {
        throw new Error(
          `ERR_AUDIT_MIXED_ASSETS: ledger is ${this.assetSymbol} (${this.assetAddress}); refusing ${tokenAddress}`
        );
      }
      return;
    }
    const known = defaultQuaiTokenRegistry.getByAddress(tokenAddress);
    this.assetAddress = known ? known.address : tokenAddress;
    this.assetSymbol = known ? known.symbol : `ERC20:${tokenAddress.slice(0, 10)}`;
    this.decimals = known ? known.decimals : WQUAI_DECIMALS;
    this.assetFixed = true;
  }

  private get treasuryAccount(): string {
    return `1110 - Shielded Treasury (${this.assetSymbol})`;
  }

  public recordInbound(
    txHash: string,
    blockNumber: number,
    commitment: string,
    note: DecryptedNotePayload,
    ppoiStatus: string = "EXEMPT_DEPOSIT"
  ): JournalEntry {
    this.bindAsset(note.token);
    const amount = BigInt(note.value);
    this.runningBalance += amount;
    this.utxoMap.set(commitment.toLowerCase(), {
      commitment: commitment.toLowerCase(),
      value: amount,
      token: note.token,
      status: "UNSPENT",
      direction: note.direction,
      timestamp: note.timestamp
    });

    const isSweep = note.direction === "INBOUND_SWEEP";
    const journalId = `JRN-${String(this.entries.length + 1).padStart(5, "0")}`;
    const entry: JournalEntry = {
      journalId,
      timestampIso: new Date(note.timestamp * 1000).toISOString(),
      blockNumber,
      txHash,
      direction: "INBOUND",
      transactionType: isSweep ? "INBOUND_SWEEP" : "SHIELD_DEPOSIT",
      assetSymbol: this.assetSymbol,
      assetAddress: this.assetAddress,
      grossAmount: amount,
      feeAmount: 0n,
      netAmount: amount,
      counterpartyAddress: note.counterparty,
      relayerAddress: "N/A",
      invoiceId: note.invoiceId || "N/A",
      memo: note.memo || (isSweep ? "Inbound x402 Payment" : "Treasury Shield Deposit"),
      nullifier: "N/A",
      ppoiStatus,
      complianceStatus: "COMPLIANT",
      debitAccount: this.treasuryAccount,
      debitAmount: amount,
      creditAccount: isSweep ? "4100 - API Services Revenue" : "1010 - Operating Corporate Wallet",
      creditAmount: amount,
      runningBalance: this.runningBalance
    };

    this.entries.push(entry);
    return entry;
  }

  public recordOutboundUnshield(
    txHash: string,
    blockNumber: number,
    timestamp: number,
    spentNullifier: string,
    inputCommitment: string,
    recipient: string,
    paymentAmount: bigint,
    relayerFee: bigint,
    relayerAddress: string,
    changeCommitment: string | undefined,
    changeNote: DecryptedNotePayload | undefined,
    invoiceId: string,
    memo: string,
    ppoiStatus: string = "VERIFIED_INNOCENT"
  ): JournalEntry {
    this.bindAsset(changeNote?.token);
    const totalDeduction = paymentAmount + relayerFee;
    this.runningBalance -= totalDeduction;

    // Mark input UTXO as spent
    const inputKey = inputCommitment.toLowerCase();
    if (this.utxoMap.has(inputKey)) {
      this.utxoMap.get(inputKey)!.status = "SPENT";
    }

    // Register change note UTXO if any
    if (changeCommitment && changeNote) {
      const changeKey = changeCommitment.toLowerCase();
      this.utxoMap.set(changeKey, {
        commitment: changeKey,
        value: BigInt(changeNote.value),
        token: changeNote.token,
        status: "UNSPENT",
        direction: "OUTBOUND_CHANGE",
        timestamp
      });
    }

    const journalId = `JRN-${String(this.entries.length + 1).padStart(5, "0")}`;
    const entry: JournalEntry = {
      journalId,
      timestampIso: new Date(timestamp * 1000).toISOString(),
      blockNumber,
      txHash,
      direction: "OUTBOUND",
      transactionType: "OUTBOUND_UNSHIELD",
      assetSymbol: this.assetSymbol,
      assetAddress: this.assetAddress,
      grossAmount: totalDeduction,
      feeAmount: relayerFee,
      netAmount: paymentAmount,
      counterpartyAddress: recipient,
      relayerAddress,
      invoiceId,
      memo,
      nullifier: spentNullifier,
      ppoiStatus,
      complianceStatus: "COMPLIANT",
      debitAccount: "5100 - Vendor API Expense & 5200 - Relayer Fee",
      debitAmount: totalDeduction,
      creditAccount: this.treasuryAccount,
      creditAmount: totalDeduction,
      runningBalance: this.runningBalance
    };

    this.entries.push(entry);
    return entry;
  }

  public getActiveUtxoBalance(): bigint {
    let sum = 0n;
    for (const item of this.utxoMap.values()) {
      if (item.status === "UNSPENT") {
        sum += item.value;
      }
    }
    return sum;
  }

  public verifyReconciliation(): boolean {
    return this.runningBalance === this.getActiveUtxoBalance();
  }
}
