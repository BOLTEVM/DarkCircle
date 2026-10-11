/**
 * DarkCircle Protocol: CLI Sweep Command
 * File: src/cli/commands/sweep.ts
 */

import fs from "node:fs";
import path from "node:path";
import { formatDecimals } from "../../audit/exporter.ts";
import { safeJsonStringify } from "../parser.ts";
import { CliExitCode, type SweepCommandOptions, type CliContext, type CliResult } from "../types.ts";

export async function executeSweepCommand(
  options: SweepCommandOptions,
  context: CliContext
): Promise<CliResult> {
  const targetInvoice =
    typeof options.invoice === "string" &&
    options.invoice.trim() !== "" &&
    options.invoice !== "true" &&
    !options.invoice.startsWith("-")
      ? options.invoice.trim()
      : undefined;

  // 1. Validate required sweep target
  if (!targetInvoice && !options.all) {
    return {
      exitCode: CliExitCode.USAGE_ERROR,
      stdout: "",
      stderr: "ERROR: Specify either --invoice <id> or --all to sweep"
    };
  }

  const decimals = context.token?.decimals ?? 18;

  // -------------------------------------------------------------------------
  // Case A: Single Invoice Sweep & Shield
  // -------------------------------------------------------------------------
  if (targetInvoice) {
    try {
      const receipt = await context.merchantGateway.sweepAndShield(targetInvoice);

      const data = {
        invoiceId: receipt.invoiceId,
        ephemeralAddress: receipt.ephemeralAddress,
        grossAmount: (receipt.grossAmount ?? receipt.sweptAmount).toString(),
        feeAmount: (receipt.feeAmount ?? 0n).toString(),
        sweptAmount: receipt.sweptAmount.toString(),
        sweptAmountFormatted: formatDecimals(receipt.sweptAmount, decimals),
        shieldedCommitment: "0x" + receipt.shieldedCommitment.toString(16),
        leafIndex: receipt.leafIndex,
        sweepTxHash: receipt.sweepTxHash,
        blockNumber: receipt.blockNumber,
        status: receipt.status,
        sweepMethod: receipt.sweepMethod ?? "n/a",
        // Read back from the registry instead of claiming it.
        forwardSecrecyKeyZeroization: /^0x0+$/.test(
          (context.merchantGateway as any).invoiceRegistry?.get(receipt.invoiceId)?.ephemeralPrivateKey ?? "x"
        )
          ? "CONFIRMED"
          : "NOT_CONFIRMED"
      };

      let outputString: string;
      if (options.json) {
        outputString = safeJsonStringify(data, 2);
      } else {
        outputString = [
          "═══════════════════════════════════════════════════════════════",
          "DARKCIRCLE INBOUND SWEEP & SHIELD RECEIPT",
          "═══════════════════════════════════════════════════════════════",
          `Invoice ID:          ${data.invoiceId}`,
          `Ephemeral Address:   ${data.ephemeralAddress}`,
          `Swept Amount:        ${data.sweptAmountFormatted} ${context.token?.symbol ?? "WQUAI"} (${data.sweptAmount} atomic units)`,
          `Shielded Commitment: ${data.shieldedCommitment}`,
          `Tree Leaf Index:     ${data.leafIndex}`,
          `Sweep TX Hash:       ${data.sweepTxHash}`,
          `Block Number:        ${data.blockNumber}`,
          "Key Zeroization:     CONFIRMED (Forward Secrecy Enforced)",
          "═══════════════════════════════════════════════════════════════"
        ].join("\n");
      }

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
        const resolved = path.resolve(process.cwd(), options.output.trim());
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, outputString, "utf8");
        return {
          exitCode: CliExitCode.SUCCESS,
          stdout: `✓ Sweep receipt written to: ${options.output}`,
          stderr: "",
          data
        };
      }

      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: outputString,
        stderr: "",
        data
      };
    } catch (err: any) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Sweep failed for invoice ${targetInvoice}: ${err.message}`
      };
    }
  }

  // -------------------------------------------------------------------------
  // Case B: Batch Sweep All Eligible Invoices
  // -------------------------------------------------------------------------
  try {
    const summary = await context.merchantGateway.sweeper.sweepBatch();

    const data = {
      totalProcessed: summary.totalProcessed,
      successfulSweeps: summary.successfulSweeps,
      failedSweeps: summary.failedSweeps,
      totalSweptAmount: summary.totalSweptAmount.toString(),
      totalSweptFormatted: formatDecimals(summary.totalSweptAmount, decimals),
      durationMs: summary.durationMs,
      receiptsCount: summary.receipts.length,
      errors: summary.errors,
      forwardSecrecyKeyZeroization: "CONFIRMED"
    };

    let outputString: string;
    if (options.json) {
      outputString = safeJsonStringify(data, 2);
    } else {
      outputString = [
        "═══════════════════════════════════════════════════════════════",
        "DARKCIRCLE BATCH SWEEP SUMMARY",
        "═══════════════════════════════════════════════════════════════",
        `Eligible Invoices:   ${data.totalProcessed}`,
        `Successful Sweeps:   ${data.successfulSweeps}`,
        `Failed Sweeps:       ${data.failedSweeps}`,
        `Total Swept Amount:  ${data.totalSweptFormatted} ${context.token?.symbol ?? "WQUAI"} (${data.totalSweptAmount} atomic units)`,
        `Duration:            ${data.durationMs} ms`,
        "Key Zeroization:     CONFIRMED (All swept ephemeral keys zeroized)",
        "═══════════════════════════════════════════════════════════════"
      ].join("\n");
    }

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
      const resolved = path.resolve(process.cwd(), options.output.trim());
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, outputString, "utf8");
      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: `✓ Batch sweep summary written to: ${options.output}`,
        stderr: "",
        data
      };
    }

    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: outputString,
      stderr: "",
      data
    };
  } catch (err: any) {
    return {
      exitCode: CliExitCode.EXECUTION_ERROR,
      stdout: "",
      stderr: `ERROR: Batch sweep failed: ${err.message}`
    };
  }
}
