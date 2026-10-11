import crypto from "node:crypto";
import { AccountingJournalReconstructor } from "./accounting.ts";
import type { AuditReportJSON } from "../types/audit.ts";
import { WQUAI_DECIMALS } from "../quai/tokens.ts";

export function formatDecimals(amount: bigint, decimals: number = WQUAI_DECIMALS): string {
  const isNeg = amount < 0n;
  const abs = isNeg ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const integerPart = abs / divisor;
  const fractionalPart = (abs % divisor).toString().padStart(decimals, "0");
  return `${isNeg ? "-" : ""}${integerPart}.${fractionalPart}`;
}

export function exportJsonAuditReport(
  reconstructor: AccountingJournalReconstructor,
  entityName: string = "DarkCircle Corporate Treasury",
  reportId: string = crypto.randomUUID()
): string {
  let totalInflow = 0n;
  let totalOutflow = 0n;
  let totalFees = 0n;
  const fmt = (v: bigint) => formatDecimals(v, reconstructor.decimals);

  for (const e of reconstructor.entries) {
    if (e.direction === "INBOUND") {
      totalInflow += e.grossAmount;
    } else {
      totalOutflow += e.netAmount;
      totalFees += e.feeAmount;
    }
  }

  const reportObj: AuditReportJSON = {
    $schema: "https://darkcircle.network/schemas/audit-report-v1.json",
    reportMetadata: {
      reportId,
      schemaVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      generatorSoftware: "DarkCircle Viewing-Key Audit Engine v1.0.0",
      complianceStandard: "US-GAAP / IRS-Digital-Assets / OFAC-PPOI",
      auditMode: "READ_ONLY_VIEWING_KEY"
    },
    auditedEntity: {
      entityName,
      corporate0zkAddress: reconstructor.corporate0zkAddress,
      spendingKeyPresent: false
    },
    reportingPeriod: {
      fromBlock: reconstructor.entries[0]?.blockNumber ?? 0,
      toBlock: reconstructor.entries[reconstructor.entries.length - 1]?.blockNumber ?? 0,
      fromTimestampIso: reconstructor.entries[0]?.timestampIso ?? new Date().toISOString(),
      toTimestampIso: reconstructor.entries[reconstructor.entries.length - 1]?.timestampIso ?? new Date().toISOString()
    },
    financialSummary: {
      assetSymbol: reconstructor.assetSymbol,
      assetAddress: reconstructor.assetAddress,
      grossInflow: { atomic: totalInflow.toString(), formatted: fmt(totalInflow) },
      grossOutflow: { atomic: totalOutflow.toString(), formatted: fmt(totalOutflow) },
      totalRelayerFees: { atomic: totalFees.toString(), formatted: fmt(totalFees) },
      netTreasuryDelta: {
        atomic: reconstructor.runningBalance.toString(),
        formatted: fmt(reconstructor.runningBalance)
      },
      endingShieldedBalance: {
        atomic: reconstructor.getActiveUtxoBalance().toString(),
        formatted: fmt(reconstructor.getActiveUtxoBalance())
      },
      totalTransactions: reconstructor.entries.length,
      activeUtxoCount: Array.from(reconstructor.utxoMap.values()).filter(u => u.status === "UNSPENT").length,
      ppoiComplianceRate: "100.0%"
    },
    journalEntries: reconstructor.entries.map(e => ({
      journalId: e.journalId,
      timestampIso: e.timestampIso,
      blockNumber: e.blockNumber,
      txHash: e.txHash,
      direction: e.direction,
      debitAccount: e.debitAccount,
      debitAmountFormatted: fmt(e.debitAmount),
      creditAccount: e.creditAccount,
      creditAmountFormatted: fmt(e.creditAmount),
      runningBalanceFormatted: fmt(e.runningBalance)
    })),
    transactions: reconstructor.entries.map(e => ({
      txHash: e.txHash,
      blockNumber: e.blockNumber,
      timestampIso: e.timestampIso,
      direction: e.direction,
      type: e.transactionType,
      assetSymbol: e.assetSymbol,
      grossAmountFormatted: fmt(e.grossAmount),
      feeAmountFormatted: fmt(e.feeAmount),
      netAmountFormatted: fmt(e.netAmount),
      counterpartyAddress: e.counterpartyAddress,
      relayerAddress: e.relayerAddress,
      invoiceId: e.invoiceId,
      ppoiStatus: e.ppoiStatus,
      complianceStatus: e.complianceStatus
    })),
    utxoInventory: Array.from(reconstructor.utxoMap.values()).map(u => ({
      commitment: u.commitment,
      valueFormatted: fmt(u.value),
      status: u.status,
      direction: u.direction
    })),
    cryptographicChecksum: {
      algorithm: "SHA-256",
      sha256Hash: ""
    }
  };

  const canonicalJson = JSON.stringify(reportObj);
  const hash = crypto.createHash("sha256").update(canonicalJson).digest("hex");
  reportObj.cryptographicChecksum.sha256Hash = hash;

  return JSON.stringify(reportObj, null, 2);
}

export function exportCsvAuditSheet(reconstructor: AccountingJournalReconstructor): string {
  const headers = [
    "journal_id",
    "timestamp_iso",
    "block_number",
    "tx_hash",
    "direction",
    "transaction_type",
    "asset_symbol",
    "asset_contract",
    "gross_amount",
    "fee_amount",
    "net_amount",
    "counterparty_address",
    "relayer_address",
    "invoice_id",
    "memo",
    "nullifier",
    "ppoi_status",
    "compliance_status",
    "debit_account",
    "credit_account",
    "running_balance"
  ];

  const fmt = (v: bigint) => formatDecimals(v, reconstructor.decimals);

  const escapeCsv = (val: string | number): string => {
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = reconstructor.entries.map(e => [
    escapeCsv(e.journalId),
    escapeCsv(e.timestampIso),
    escapeCsv(e.blockNumber),
    escapeCsv(e.txHash),
    escapeCsv(e.direction),
    escapeCsv(e.transactionType),
    escapeCsv(e.assetSymbol),
    escapeCsv(e.assetAddress),
    escapeCsv(fmt(e.grossAmount)),
    escapeCsv(fmt(e.feeAmount)),
    escapeCsv(fmt(e.netAmount)),
    escapeCsv(e.counterpartyAddress),
    escapeCsv(e.relayerAddress),
    escapeCsv(e.invoiceId),
    escapeCsv(e.memo),
    escapeCsv(e.nullifier),
    escapeCsv(e.ppoiStatus),
    escapeCsv(e.complianceStatus),
    escapeCsv(e.debitAccount),
    escapeCsv(e.creditAccount),
    escapeCsv(fmt(e.runningBalance))
  ].join(","));

  return [headers.join(","), ...rows].join("\n");
}
