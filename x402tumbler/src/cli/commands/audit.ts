/**
 * DarkCircle Protocol: CLI Audit Command
 * File: src/cli/commands/audit.ts
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AccountingJournalReconstructor } from "../../audit/accounting.ts";
import { exportJsonAuditReport, exportCsvAuditSheet } from "../../audit/exporter.ts";
import { CliExitCode, type AuditCommandOptions, type CliContext, type CliResult } from "../types.ts";
import type { JournalEntry } from "../../types/audit.ts";

function filterEntries(
  entries: JournalEntry[],
  filter: {
    fromDate?: string;
    toDate?: string;
    token?: string;
    counterparty?: string;
    direction?: string;
  }
): JournalEntry[] {
  return entries.filter((e) => {
    if (filter.fromDate && typeof filter.fromDate === "string" && filter.fromDate !== "true") {
      const fromTime = new Date(filter.fromDate).getTime() / 1000;
      const entryTime = new Date(e.timestampIso).getTime() / 1000;
      if (!isNaN(fromTime) && entryTime < fromTime) return false;
    }
    if (filter.toDate && typeof filter.toDate === "string" && filter.toDate !== "true") {
      const toTime = new Date(filter.toDate).getTime() / 1000;
      const entryTime = new Date(e.timestampIso).getTime() / 1000;
      if (!isNaN(toTime) && entryTime > toTime) return false;
    }
    if (
      filter.token &&
      typeof filter.token === "string" &&
      filter.token !== "true" &&
      e.assetAddress.toLowerCase() !== filter.token.toLowerCase()
    ) {
      return false;
    }
    if (
      filter.counterparty &&
      typeof filter.counterparty === "string" &&
      filter.counterparty !== "true" &&
      e.counterpartyAddress.toLowerCase() !== filter.counterparty.toLowerCase()
    ) {
      return false;
    }
    if (
      filter.direction &&
      typeof filter.direction === "string" &&
      filter.direction !== "true" &&
      e.direction.toLowerCase() !== filter.direction.toLowerCase()
    ) {
      return false;
    }
    return true;
  });
}

function getOrReconstructJournal(context: CliContext): AccountingJournalReconstructor {
  const reconstructor: AccountingJournalReconstructor =
    context.journal ||
    new AccountingJournalReconstructor(
      context.corporateKeys?.corporate0zkAddress || "0zk1q_corporate_default"
    );

  // If reconstructor has 0 entries but pool has poolEvents, populate reconstructor
  if (
    reconstructor.entries.length === 0 &&
    context.pool &&
    Array.isArray((context.pool as any).poolEvents)
  ) {
    const events = (context.pool as any).poolEvents;
    for (const ev of events) {
      if (ev.type === "SHIELD") {
        reconstructor.recordInbound(
          ev.txHash || "0x" + crypto.randomBytes(32).toString("hex"),
          ev.blockNumber || 1001,
          "0x" + (ev.commitment ? ev.commitment.toString(16) : "0"),
          {
            version: 1,
            token: ev.token,
            value: ev.amount.toString(),
            blinding: "0x0",
            npk: "0x0",
            direction: ev.depositorAddress ? "INBOUND_SWEEP" : "INBOUND_SHIELD",
            counterparty: ev.depositorAddress || "corporate_treasury",
            memo: ev.memo,
            timestamp: ev.timestamp
          }
        );
      } else if (ev.type === "UNSHIELD") {
        reconstructor.recordOutboundUnshield(
          ev.txHash,
          ev.blockNumber || 1001,
          ev.timestamp,
          ev.nullifier || "0xnull",
          "0xinput",
          ev.recipient,
          ev.amount,
          ev.fee || 0n,
          ev.relayer || "0xRelayer",
          undefined,
          undefined,
          "inv_outbound",
          "Outbound Unshield Payment"
        );
      }
    }
  }

  return reconstructor;
}

export async function executeAuditCommand(
  options: AuditCommandOptions,
  context: CliContext
): Promise<CliResult> {
  // -------------------------------------------------------------------------
  // 1. In-Memory Audit Trail Integrity Verification Mode (--verify without file)
  // -------------------------------------------------------------------------
  const isParameterlessVerification =
    options.verify === true ||
    options.verify === "true" ||
    (typeof options.verify === "string" && options.verify.trim() === "");

  if (isParameterlessVerification) {
    const reconstructor = getOrReconstructJournal(context);
    const reconciled = reconstructor.verifyReconciliation();
    const balance = reconstructor.runningBalance;
    const utxoSum = reconstructor.getActiveUtxoBalance();

    const entityName = options.entity || "DarkCircle Corporate Treasury";
    const reportString = exportJsonAuditReport(reconstructor, entityName);
    const parsedReport = JSON.parse(reportString);
    const checksum = parsedReport.cryptographicChecksum?.sha256Hash || "";

    if (!reconciled) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `INTEGRITY_CHECK_FAILED: Double-entry reconciliation mismatch (running balance: ${balance.toString()}, active UTXO sum: ${utxoSum.toString()})`,
        data: {
          verified: false,
          reconciled: false,
          checksum,
          runningBalance: balance.toString(),
          activeUtxoSum: utxoSum.toString()
        }
      };
    }

    if (options.json) {
      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: JSON.stringify(
          {
            verified: true,
            reconciled: true,
            checksum,
            runningBalance: balance.toString(),
            activeUtxoSum: utxoSum.toString(),
            invariants: "Debits === Credits, Running Balance === Sum(Active UTXOs)"
          },
          null,
          2
        ),
        stderr: "",
        data: {
          verified: true,
          reconciled: true,
          checksum,
          runningBalance: balance.toString(),
          activeUtxoSum: utxoSum.toString()
        }
      };
    }

    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: [
        "═══════════════════════════════════════════════════════════════",
        "DARKCIRCLE AUDIT TRAIL INTEGRITY VERIFICATION",
        "═══════════════════════════════════════════════════════════════",
        "✓ INTEGRITY VERIFIED: Double-entry audit trail balanced",
        `Checksum:        ${checksum}`,
        `Running Balance: ${balance.toString()} atomic units`,
        `Active UTXO Sum: ${utxoSum.toString()} atomic units`,
        "Invariants:      Debits === Credits, Running Balance === Sum(Active UTXOs)",
        "═══════════════════════════════════════════════════════════════"
      ].join("\n"),
      stderr: "",
      data: {
        verified: true,
        reconciled: true,
        checksum,
        runningBalance: balance.toString(),
        activeUtxoSum: utxoSum.toString()
      }
    };
  }

  // -------------------------------------------------------------------------
  // 2. Report Checksum & Reconciliation Verification Mode (--verify <file>)
  // -------------------------------------------------------------------------
  if (typeof options.verify === "string" && options.verify.trim() !== "" && options.verify !== "true") {
    const targetPath = options.verify.trim();
    const filePath = path.resolve(process.cwd(), targetPath);
    if (!fs.existsSync(filePath)) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Verification target file not found: ${options.verify}`
      };
    }

    try {
      const fileContent = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(fileContent);

      const recordedChecksum = parsed.cryptographicChecksum?.sha256Hash;
      if (!recordedChecksum) {
        return {
          exitCode: CliExitCode.EXECUTION_ERROR,
          stdout: "",
          stderr: "ERROR: Report is missing cryptographicChecksum.sha256Hash"
        };
      }

      parsed.cryptographicChecksum.sha256Hash = "";
      const canonical = JSON.stringify(parsed);
      const computedHash = crypto.createHash("sha256").update(canonical).digest("hex");

      if (computedHash !== recordedChecksum) {
        return {
          exitCode: CliExitCode.EXECUTION_ERROR,
          stdout: "",
          stderr: `TAMPER_DETECTED: Checksum mismatch. Recorded: ${recordedChecksum}, Computed: ${computedHash}`
        };
      }

      // Verify reconciliation from report financial summary if available
      let reconciliationValid = true;
      if (
        parsed.financialSummary?.netTreasuryDelta?.atomic !== undefined &&
        parsed.financialSummary?.endingShieldedBalance?.atomic !== undefined
      ) {
        const netDelta = BigInt(parsed.financialSummary.netTreasuryDelta.atomic);
        const endingBalance = BigInt(parsed.financialSummary.endingShieldedBalance.atomic);
        if (netDelta !== endingBalance) {
          return {
            exitCode: CliExitCode.EXECUTION_ERROR,
            stdout: "",
            stderr: `RECONCILIATION_FAILED: Report financial summary is unbalanced. Net delta (${netDelta.toString()}) !== Ending shielded balance (${endingBalance.toString()})`,
            data: { verified: false, checksum: computedHash, reconciled: false }
          };
        }
      }

      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: `✓ INTEGRITY VERIFIED: Audit report checksum valid (${computedHash})`,
        stderr: "",
        data: { verified: true, checksum: computedHash, reconciled: reconciliationValid }
      };
    } catch (err: any) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Failed to verify report: ${err.message}`
      };
    }
  }

  // -------------------------------------------------------------------------
  // 3. Parse viewing key if provided
  // -------------------------------------------------------------------------
  let vsk = context.corporateKeys?.masterViewingKey;
  const rawKey = options.viewingKey || process.env.DARKCIRCLE_VIEWING_KEY;
  if (rawKey && typeof rawKey === "string" && rawKey !== "true") {
    try {
      if (rawKey.startsWith("ey")) {
        const decoded = JSON.parse(Buffer.from(rawKey, "base64url").toString("utf8"));
        vsk = BigInt(decoded.vsk);
      } else if (rawKey.startsWith("0x")) {
        vsk = BigInt(rawKey);
      } else {
        vsk = BigInt("0x" + rawKey);
      }
    } catch {
      return {
        exitCode: CliExitCode.USAGE_ERROR,
        stdout: "",
        stderr: "ERROR: Invalid viewing key format. Expected base64url token or hex scalar."
      };
    }
  }

  // -------------------------------------------------------------------------
  // 4. Obtain & reconstruct double-entry journal
  // -------------------------------------------------------------------------
  const reconstructor = getOrReconstructJournal(context);

  // -------------------------------------------------------------------------
  // 4. Double-Entry Reconciliation Check (--reconcile)
  // -------------------------------------------------------------------------
  if (options.reconcile) {
    const reconciled = reconstructor.verifyReconciliation();
    const balance = reconstructor.runningBalance;
    const utxoSum = reconstructor.getActiveUtxoBalance();

    return {
      exitCode: reconciled ? CliExitCode.SUCCESS : CliExitCode.EXECUTION_ERROR,
      stdout: [
        "═══════════════════════════════════════════════════════════════",
        "DARKCIRCLE DOUBLE-ENTRY RECONCILIATION",
        "═══════════════════════════════════════════════════════════════",
        `Status:          ${reconciled ? "BALANCED (Invariants Satisfied)" : "DISCREPANCY DETECTED"}`,
        `Running Balance: ${balance.toString()} atomic units`,
        `Active UTXO Sum: ${utxoSum.toString()} atomic units`,
        "Invariants:      Debits === Credits, Running Balance === Sum(Active UTXOs)",
        "═══════════════════════════════════════════════════════════════"
      ].join("\n"),
      stderr: reconciled ? "" : "WARNING: Treasury reconciliation mismatch detected",
      data: { reconciled, runningBalance: balance.toString(), activeUtxoSum: utxoSum.toString() }
    };
  }

  // -------------------------------------------------------------------------
  // 5. Apply filters & export report
  // -------------------------------------------------------------------------
  let activeReconstructor = reconstructor;
  if (
    options.fromDate ||
    options.toDate ||
    options.token ||
    options.counterparty ||
    options.direction
  ) {
    const filtered = new AccountingJournalReconstructor(reconstructor.corporate0zkAddress);
    filtered.entries = filterEntries(reconstructor.entries, {
      fromDate: options.fromDate,
      toDate: options.toDate,
      token: options.token,
      counterparty: options.counterparty,
      direction: options.direction
    });
    filtered.assetAddress = reconstructor.assetAddress;
    filtered.assetSymbol = reconstructor.assetSymbol;
    filtered.decimals = reconstructor.decimals;
    filtered.utxoMap = reconstructor.utxoMap;
    filtered.runningBalance = reconstructor.runningBalance;
    activeReconstructor = filtered;
  }

  const format = options.csv || options.format === "csv" ? "csv" : "json";
  const entityName = options.entity || "DarkCircle Corporate Treasury";

  const outputString =
    format === "csv"
      ? exportCsvAuditSheet(activeReconstructor)
      : exportJsonAuditReport(activeReconstructor, entityName);

  // -------------------------------------------------------------------------
  // 6. Output handling (File or Stdout)
  // -------------------------------------------------------------------------
  if (options.output) {
    if (
      typeof options.output !== "string" ||
      options.output.trim() === "" ||
      options.output === "true" ||
      options.output.startsWith("-")
    ) {
      return {
        exitCode: CliExitCode.USAGE_ERROR,
        stdout: "",
        stderr: "ERROR: Missing required argument for --output <file>"
      };
    }
    try {
      const resolved = path.resolve(process.cwd(), options.output.trim());
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, outputString, "utf8");
      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: `✓ Successfully exported audit report (${format.toUpperCase()}) to: ${options.output}`,
        stderr: ""
      };
    } catch (err: any) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Failed to write output file: ${err.message}`
      };
    }
  }

  return {
    exitCode: CliExitCode.SUCCESS,
    stdout: outputString,
    stderr: ""
  };
}
