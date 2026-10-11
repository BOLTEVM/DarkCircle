/**
 * Corporate Viewing-Key Audit Engine & Accounting Types
 * DarkCircle Compliance & Regulatory Suite
 */

import type { Point } from "./crypto.js";

export interface CorporateKeyHierarchy {
  masterSpendingKey: bigint;   // ssk: guarded in KMS/HSM
  masterViewingKey: bigint;    // vsk: shared with audit engine
  spendingPublicKey: Point;    // spk = ssk * G
  viewingPublicKey: Point;     // vpk = vsk * G
  corporate0zkAddress: string; // 0zk... public receiving address
  viewingKeyToken: string;     // Exportable viewing-key bundle
}

export type NoteDirection =
  | "INBOUND_SHIELD"
  | "INBOUND_SWEEP"
  | "OUTBOUND_CHANGE"
  | "OUTBOUND_AUDIT";

export interface DecryptedNotePayload {
  version: number;
  token: string;
  value: string;
  blinding: string;
  npk: string;
  direction: NoteDirection;
  counterparty: string;
  relayerAddress?: string;
  relayerFee?: string;
  invoiceId?: string;
  memo?: string;
  timestamp: number;
}

export interface EncryptedNotePayload {
  ephemeralPubKey: [string, string];
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export interface JournalEntry {
  journalId: string;
  timestampIso: string;
  blockNumber: number;
  txHash: string;
  direction: "INBOUND" | "OUTBOUND";
  transactionType: "SHIELD_DEPOSIT" | "INBOUND_SWEEP" | "OUTBOUND_UNSHIELD";
  assetSymbol: string;
  assetAddress: string;
  grossAmount: bigint;
  feeAmount: bigint;
  netAmount: bigint;
  counterpartyAddress: string;
  relayerAddress: string;
  invoiceId: string;
  memo: string;
  nullifier: string;
  ppoiStatus: string;
  complianceStatus: "COMPLIANT" | "FLAGGED";
  debitAccount: string;
  debitAmount: bigint;
  creditAccount: string;
  creditAmount: bigint;
  runningBalance: bigint;
}

export interface UTXOItem {
  commitment: string;
  value: bigint;
  token: string;
  status: "UNSPENT" | "SPENT";
  direction: string;
  timestamp: number;
}

export interface FormattedAmount {
  atomic: string;
  formatted: string;
}

export interface AuditReportMetadata {
  reportId: string;
  schemaVersion: string;
  generatedAt: string;
  generatorSoftware: string;
  complianceStandard: string;
  auditMode: string;
}

export interface AuditedEntity {
  entityName: string;
  corporate0zkAddress: string;
  viewingPublicKey?: {
    x: string;
    y: string;
  };
  spendingKeyPresent: boolean;
}

export interface ReportingPeriod {
  fromBlock: number;
  toBlock: number;
  fromTimestampIso: string;
  toTimestampIso: string;
}

export interface FinancialSummary {
  assetSymbol: string;
  assetAddress?: string;
  grossInflow: FormattedAmount;
  grossOutflow: FormattedAmount;
  totalRelayerFees: FormattedAmount;
  netTreasuryDelta: FormattedAmount;
  endingShieldedBalance: FormattedAmount;
  totalTransactions: number;
  activeUtxoCount: number;
  ppoiComplianceRate: string;
}

export interface AuditReportJSON {
  $schema: string;
  reportMetadata: AuditReportMetadata;
  auditedEntity: AuditedEntity;
  reportingPeriod: ReportingPeriod;
  financialSummary: FinancialSummary;
  journalEntries: Array<{
    journalId: string;
    timestampIso: string;
    blockNumber: number;
    txHash: string;
    direction: string;
    debitAccount: string;
    debitAmountFormatted: string;
    creditAccount: string;
    creditAmountFormatted: string;
    runningBalanceFormatted: string;
  }>;
  transactions: Array<{
    txHash: string;
    blockNumber: number;
    timestampIso: string;
    direction: string;
    type: string;
    assetSymbol: string;
    grossAmountFormatted: string;
    feeAmountFormatted: string;
    netAmountFormatted: string;
    counterpartyAddress: string;
    relayerAddress: string;
    invoiceId: string;
    ppoiStatus: string;
    complianceStatus: string;
  }>;
  utxoInventory: Array<{
    commitment: string;
    valueFormatted: string;
    status: string;
    direction: string;
  }>;
  cryptographicChecksum: {
    algorithm: string;
    sha256Hash: string;
  };
}
